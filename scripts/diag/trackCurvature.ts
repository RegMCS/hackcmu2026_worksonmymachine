/**
 * Shared corner-tightness probe.
 *
 * Both curvature.ts and steering.ts turn "how tight is the tightest corner" into
 * a steering constant, so they have to measure it the same way - two copies of
 * this drifting apart is how a track becomes undrivable on one check and fine on
 * the other.
 *
 * The window matters more than it looks. Sampling heading change over 0.5m
 * measures a feature far smaller than the 3.5m car on an 11m-wide road, so it
 * reports the sharp vertices of the surveyed OSM polyline rather than the
 * corners a driver meets. On leventhal that reads 1.91m over 0.5m but 3.82m over
 * 1m - a real arc's radius does not double when you widen the ruler, and a 1.91m
 * centreline radius on an 11m track is not geometry, it is noise: the inner edge
 * would fold through itself. Measuring over a car length asks the question the
 * car actually poses.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { TrackGeometry } from '../../client/src/game/track';
import { TUNING } from '../../client/src/game/physics';
import type { TrackDef } from '../../shared/types';

/** Heading is sampled this far apart: the length of the thing being steered. */
export const PROBE_WINDOW = TUNING.CAR_LENGTH;
const STEP = 0.5;

export interface Corner {
  /** Radius of the tightest corner, metres. */
  radius: number;
  /** Distance along the lap where it is, metres. */
  at: number;
}

export function tightestCorner(g: TrackGeometry): Corner {
  let best: Corner = { radius: Infinity, at: 0 };
  for (let s = 0; s < g.length; s += STEP) {
    const a = g.pointAt(s);
    const b = g.pointAt(s + PROBE_WINDOW);
    let dh = b.heading - a.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    const r = Math.abs(dh) > 1e-6 ? PROBE_WINDOW / Math.abs(dh) : Infinity;
    if (r < best.radius) best = { radius: r, at: s };
  }
  return best;
}

/** Turn rate the tightest corner demands at full speed, rad/sec. */
export function peakDemand(g: TrackGeometry): number {
  return TUNING.BASE_SPEED / tightestCorner(g).radius;
}

export function loadCourse(file: string): TrackGeometry {
  const def = JSON.parse(readFileSync(`client/public/tracks/${file}`, 'utf8')) as TrackDef;
  return new TrackGeometry(def);
}

/** Every bundled course, by filename. */
export function courseFiles(): string[] {
  return readdirSync('client/public/tracks').filter((f) => f.endsWith('.json') && f !== 'manifest.json');
}
