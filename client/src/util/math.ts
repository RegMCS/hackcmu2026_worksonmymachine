export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Wraps an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed difference from b to a, in (-PI, PI]. */
export const angleDelta = (a: number, b: number) => wrapAngle(a - b);

export function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + angleDelta(b, a) * t);
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds)) return '--:--.--';
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${sign}${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

export function formatDelta(seconds: number): string {
  if (!isFinite(seconds)) return '--';
  const sign = seconds >= 0 ? '+' : '-';
  return `${sign}${Math.abs(seconds).toFixed(2)}s`;
}
