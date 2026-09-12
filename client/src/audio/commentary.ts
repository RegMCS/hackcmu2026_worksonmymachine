import { EVENT_PRIORITY, type GameEvent, type GameEventType } from '../game/events';
import { api } from '../net/api';
import { PhraseBank, type PickedPhrase } from './phraseBank';
import { getAudioContext, unlockAudio } from './context';
import { PERSONA_DEFAULT } from '../../../shared/personas';

/**
 * Live race commentary.
 *
 * Design follows the quota reality: the pre-generated phrase bank handles the
 * common events instantly, and Gemini + ElevenLabs are reserved for the handful
 * of genuinely contextual moments per race. If either API is slow or fails, the
 * game continues silently - commentary is an enhancement, never a dependency.
 */

const DEBOUNCE_SEC = 4;
/** An event older than this is no longer worth narrating. Without this, a queued
 *  event surfaces seconds later and the commentator describes something the
 *  player has already forgotten - the main cause of out-of-context lines. */
const STALE_SEC = 2.5;
/** The same event type will not be narrated twice inside this window. */
const REPEAT_COOLDOWN_SEC = 9;

/** Events worth spending live generation on. Everything else uses the bank. */
const LIVE_WORTHY = new Set<GameEventType>([
  'race_finish',
  'personal_best',
  'took_lead',
  'overtake_ghost',
  'close_battle',
  'rival_matched',
]);

export interface CommentaryContext {
  playerName: string;
  position: number;
  fieldSize: number;
  lapProgress: number;
  rivalName?: string;
  gap?: number;
  collisions: number;
}

export class Commentator {
  enabled = true;
  lastLine = '';
  /** Called with every line the commentator delivers, for the on-screen caption.
   *  Fires even when audio is unavailable, so the commentary is still readable
   *  if the TTS quota runs out mid-event. */
  onLine: ((text: string, source: 'cached' | 'live') => void) | null = null;
  bankOnly = false;
  /**
   * Persona and voice apply to LIVE lines only. The committed phrase bank was
   * generated once in the `hype` register and is not re-synthesised per persona
   * - that would cost roughly a thousand ElevenLabs credits per persona and the
   * bank is deliberately the cheap, instant, primary path. So picking a persona
   * colours the handful of contextual moments per race, and the common events
   * keep the house voice. See shared/personas.ts.
   */
  persona = PERSONA_DEFAULT;
  /** ElevenLabs voice id, or null for the server's configured default. */
  voiceId: string | null = null;
  private ctx: AudioContext | null = null;
  private bank: PhraseBank | null = null;
  private current: AudioBufferSourceNode | HTMLAudioElement | null = null;
  private lastSpokeAt = -Infinity;
  private pending: GameEvent | null = null;
  private saidAt = new Map<GameEventType, number>();
  private finished = false;
  private unlocked = false;
  private liveCalls = 0;

  /** Max live generations per race, so one race cannot eat the monthly quota. */
  liveBudgetPerRace = 4;

  async init(): Promise<void> {
    this.ctx = getAudioContext();
    if (!this.ctx) return;
    this.bank = new PhraseBank(this.ctx);
    await this.bank.load();
  }

  get phraseCount(): number {
    return this.bank?.phraseCount ?? 0;
  }

  /** Browsers require a gesture before audio can play. */
  unlock(): void {
    if (this.unlocked) return;
    unlockAudio();
    this.unlocked = true;
  }

  resetForRace(): void {
    this.liveCalls = 0;
    this.lastSpokeAt = -Infinity;
    this.pending = null;
    this.saidAt.clear();
    this.finished = false;
    this.stopCurrent();
  }

  /**
   * Offers an event to the commentator. At most one line every DEBOUNCE_SEC; if
   * several fire inside a window the highest-priority one wins.
   */
  offer(event: GameEvent, now: number, ctx: CommentaryContext): void {
    if (!this.enabled) return;

    // Once the race is over, only the finishing lines are still relevant.
    if (this.finished && event.type !== 'race_finish' && event.type !== 'personal_best') return;
    if (event.type === 'race_finish') this.finished = true;

    if (!this.pending || EVENT_PRIORITY[event.type] > EVENT_PRIORITY[this.pending.type]) {
      this.pending = event;
    }
    this.tick(now, ctx);
  }

  /**
   * Called every frame so a queued event is delivered as soon as the debounce
   * window opens, rather than waiting for some later event to push it out.
   */
  tick(now: number, ctx: CommentaryContext): void {
    if (!this.enabled || !this.pending) return;
    if (now - this.lastSpokeAt < DEBOUNCE_SEC) return;

    const chosen = this.pending;
    this.pending = null;

    // Drop anything that has gone stale while it waited its turn.
    if (now - chosen.at > STALE_SEC) return;
    const said = this.saidAt.get(chosen.type);
    if (said !== undefined && now - said < REPEAT_COOLDOWN_SEC) return;

    this.lastSpokeAt = now;
    this.saidAt.set(chosen.type, now);
    void this.speak(chosen, ctx);
  }

  private async speak(event: GameEvent, ctx: CommentaryContext): Promise<void> {
    // Fast path: a cached line plays with no network round trip at all.
    const cached = this.bank?.pick(event.type);
    const canGoLive =
      !this.bankOnly && LIVE_WORTHY.has(event.type) && this.liveCalls < this.liveBudgetPerRace;

    if (cached && !canGoLive) {
      this.deliver(cached);
      return;
    }

    if (canGoLive) {
      this.liveCalls++;
      try {
        const res = await api.commentary({
          event: event.type,
          playerName: ctx.playerName,
          position: ctx.position,
          fieldSize: ctx.fieldSize,
          lapProgress: ctx.lapProgress,
          // The rival actually involved in THIS event beats the matchmade one.
          rivalName: (event.data?.rival as string) ?? ctx.rivalName,
          gap: ctx.gap,
          collisions: ctx.collisions,
          details: event.data,
          persona: this.persona,
        });
        if (res?.text) {
          this.lastLine = res.text;
          this.onLine?.(res.text, 'live');
          await this.speakText(res.text);
          return;
        }
      } catch {
        /* fall through to the bank */
      }
    }

    if (cached) this.deliver(cached);
  }

  private deliver(phrase: PickedPhrase): void {
    this.lastLine = phrase.text;
    this.onLine?.(phrase.text, 'cached');
    this.playBuffer(phrase.buffer);
  }

  private async speakText(text: string): Promise<boolean> {
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, persona: this.persona, voiceId: this.voiceId ?? undefined }),
      });
      if (!res.ok) return false;
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      audio.volume = 0.95;
      this.stopCurrent();
      this.current = audio;
      await audio.play();
      return true;
    } catch {
      return false;
    }
  }

  private playBuffer(buffer: AudioBuffer): void {
    if (!this.ctx) return;
    try {
      this.stopCurrent();
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.ctx.destination);
      src.start();
      this.current = src;
    } catch {
      /* audio is never worth throwing over */
    }
  }

  /** Stale commentary is worse than no commentary - always cut the old line. */
  private stopCurrent(): void {
    if (!this.current) return;
    try {
      if (this.current instanceof HTMLAudioElement) {
        this.current.pause();
        this.current.src = '';
      } else {
        this.current.stop();
      }
    } catch {
      /* already ended */
    }
    this.current = null;
  }
}

export interface VoiceOption {
  id: string;
  name: string;
  description: string;
}

/**
 * Voices the ElevenLabs account can actually synthesise with.
 *
 * Fails soft to an empty list, which the picker renders as "Default voice" only
 * - no key, no network, no ElevenLabs, and the screen still works.
 */
export async function fetchVoices(): Promise<VoiceOption[]> {
  try {
    const res = await fetch('/api/voices');
    if (!res.ok) return [];
    const data = (await res.json()) as VoiceOption[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
