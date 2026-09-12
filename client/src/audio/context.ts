/** One AudioContext shared by commentary and effects. Browsers cap how many a
 *  page may create, and two contexts cannot duck against each other. */
let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
    return ctx;
  } catch {
    return null;
  }
}

/** Browsers require a user gesture before audio may start. */
export function unlockAudio(): void {
  getAudioContext()?.resume().catch(() => {});
}
