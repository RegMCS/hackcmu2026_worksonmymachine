export interface CommentaryContext {
  driver: string;
  lap: number;
  laps: number;
  place: number;
  total: number;
  elapsedSec: number;
  speedKmh: number;
  standings: { name: string; lap: number; progress: number; finished?: number }[];
  events: string[];
  phase: string;
}

const INTERVAL_MS = 7000;
const IDLE_INTERVAL_MS = 16000;

export interface CommentatorSettings {
  /** ElevenLabs voice id, or '' for the server default. */
  voiceId: string;
  /** Persona key, or 'custom'. */
  tone: string;
  customTone: string;
  /** Browser speechSynthesis voice name, used only when ElevenLabs is unavailable. */
  browserVoice: string;
}

/**
 * Periodically sends a compact race summary (plus a webcam snapshot) to the server, which asks
 * Gemini for a one-liner and ElevenLabs for audio. Falls back to browser speech when audio is absent.
 */
export class Commentator {
  private timer = 0;
  private playing = false;
  private lastSpoke = 0;
  private history: string[] = [];
  muted = false;
  settings: CommentatorSettings = { voiceId: '', tone: 'hype', customTone: '', browserVoice: '' };

  constructor(
    private getContext: () => CommentaryContext,
    private snapshot: () => string | null,
    private onLine: (text: string) => void,
  ) {}

  start(): void {
    this.stop();
    this.lastSpoke = performance.now();
    this.timer = window.setInterval(() => void this.tick(), 1500);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = 0;
    speechSynthesis?.cancel();
  }

  /** Request a line right now (used by the settings panel's test button). */
  sayNow(): Promise<void> {
    return this.tick(true);
  }

  private async tick(force = false): Promise<void> {
    if (this.playing || (this.muted && !force)) return;
    const ctx = this.getContext();
    const since = performance.now() - this.lastSpoke;
    const hasNews = ctx.events.length > 0;
    if (!force) {
      if (since < INTERVAL_MS) return;
      if (!hasNews && since < IDLE_INTERVAL_MS) return;
    }

    const persona = this.settings.tone === 'custom' ? this.settings.customTone.trim() || 'hype' : this.settings.tone;
    this.playing = true;
    this.lastSpoke = performance.now();
    try {
      const res = await fetch('/api/commentate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...ctx, image: this.snapshot(), history: this.history.slice(-4),
          persona, voiceId: this.settings.voiceId,
        }),
      });
      if (!res.ok) throw new Error(`commentate ${res.status}`);
      const text = decodeURIComponent(res.headers.get('x-commentary-text') ?? '');
      if (text) {
        this.history.push(text);
        this.onLine(text);
      }
      if (res.headers.get('content-type')?.startsWith('audio/')) {
        await this.playAudio(await res.blob());
      } else {
        const body = (await res.json()) as { text?: string };
        if (body.text && !text) { this.history.push(body.text); this.onLine(body.text); }
        await this.speakLocal(body.text ?? text);
      }
    } catch (err) {
      console.warn('commentator:', err);
    } finally {
      this.playing = false;
    }
  }

  private playAudio(blob: Blob): Promise<void> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      audio.play().catch(() => resolve());
    });
  }

  private speakLocal(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window) || !text) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const voice = speechSynthesis.getVoices().find((v) => v.name === this.settings.browserVoice);
      if (voice) u.voice = voice;
      u.rate = 1.15;
      u.pitch = 1.1;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
}
