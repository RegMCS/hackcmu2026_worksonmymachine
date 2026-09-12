import type { GameEventType } from '../game/events';

export interface PhraseEntry {
  file: string;
  /** The spoken line, so it can be captioned on screen. */
  text: string;
}

export type PhraseManifest = Partial<Record<GameEventType, PhraseEntry[]>>;

export interface PickedPhrase {
  buffer: AudioBuffer;
  text: string;
}

/**
 * Pre-generated commentary audio, decoded once at startup.
 *
 * This is the PRIMARY commentary path, not a fallback. The ElevenLabs free tier
 * is ~20,000 characters a month, which is roughly a dozen races of live
 * generation - so the frequent lines are synthesised once, ahead of time, and
 * played from memory. That also makes them faster than live generation, because
 * there is no network round trip at all.
 */
export class PhraseBank {
  private buffers = new Map<GameEventType, PickedPhrase[]>();
  private lastPicked = new Map<GameEventType, number>();
  loaded = false;
  phraseCount = 0;

  constructor(private ctx: AudioContext) {}

  async load(manifestUrl = '/phrases/manifest.json'): Promise<void> {
    let manifest: PhraseManifest;
    try {
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(String(res.status));
      manifest = await res.json();
    } catch {
      // No bank generated yet. Commentary falls back to live generation, or to
      // silence. Never an error the player can see.
      this.loaded = true;
      return;
    }

    const jobs: Promise<void>[] = [];
    for (const [event, entries] of Object.entries(manifest) as [GameEventType, PhraseEntry[]][]) {
      for (const entry of entries ?? []) {
        jobs.push(
          (async () => {
            try {
              const res = await fetch(`/phrases/${entry.file}`);
              if (!res.ok) return;
              const buffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
              if (!this.buffers.has(event)) this.buffers.set(event, []);
              this.buffers.get(event)!.push({ buffer, text: entry.text });
              this.phraseCount++;
            } catch {
              /* one missing phrase must not break the bank */
            }
          })(),
        );
      }
    }
    await Promise.all(jobs);
    this.loaded = true;
  }

  has(event: GameEventType): boolean {
    return (this.buffers.get(event)?.length ?? 0) > 0;
  }

  /** Picks a variant, avoiding an immediate repeat so it does not sound canned. */
  pick(event: GameEventType): PickedPhrase | null {
    const list = this.buffers.get(event);
    if (!list?.length) return null;
    if (list.length === 1) return list[0];
    const last = this.lastPicked.get(event) ?? -1;
    let i = Math.floor(Math.random() * list.length);
    if (i === last) i = (i + 1) % list.length;
    this.lastPicked.set(event, i);
    return list[i];
  }
}
