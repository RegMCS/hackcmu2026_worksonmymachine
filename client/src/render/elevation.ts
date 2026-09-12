import type { TrackDef } from '../../../shared/types';

/** Height of the road above the ground plane at distance s along the centerline. */
export type ElevationFn = (s: number) => number;

export const FLAT: ElevationFn = () => 0;

/**
 * Proposed additive extension to TrackDef for the world/track workstream:
 * `elevation` is N heights in world units, sampled at equal distance steps
 * along the centerline starting at s = 0 and wrapping (sample N is sample 0).
 * It is read here and nowhere else - physics and ghosts never see it.
 */
export interface TrackDefWithElevation extends TrackDef {
  elevation?: number[];
}

export function elevationFromDef(def: TrackDef, length: number): ElevationFn {
  const e = (def as TrackDefWithElevation).elevation;
  if (!e || e.length < 2 || !(length > 0)) return FLAT;
  const n = e.length;
  return (s) => {
    const u = ((((s % length) + length) % length) / length) * n;
    const i = Math.floor(u);
    const t = u - i;
    return e[i % n] * (1 - t) + e[(i + 1) % n] * t;
  };
}

/** Dev-only rolling hills, so the elevation path can be demoed before real data lands. */
export function demoHills(length: number, amplitude: number): ElevationFn {
  return (s) => {
    const u = (((s % length) + length) % length) / length;
    return amplitude * (0.5 - 0.5 * Math.cos(u * Math.PI * 2 * 3)) + amplitude * 0.3 * Math.sin(u * Math.PI * 2 * 7);
  };
}
