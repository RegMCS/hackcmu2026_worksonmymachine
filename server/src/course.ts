/**
 * Turns a pasted Google Maps directions link into a playable course.
 *
 * Google is used only as an address bar: the link carries the endpoints, never
 * the road geometry, so the path itself comes from OSRM over OpenStreetMap data.
 * That keeps the result redistributable (ODbL, attributed) instead of subject to
 * the Maps terms, which forbid storing derived geometry.
 *
 * The course is the route as driven: point to point, start and finish in
 * different places, exactly the shape Maps showed. It is NOT closed into a
 * circuit. Closing an A->B route means either mirroring it back - which doubles
 * the road and buries the real shape in a hairpin - or joining the ends through
 * whatever lies between them. Both produce a map the user did not ask for.
 * `TrackGeometry` supports open courses, and an open course races one leg
 * rather than laps.
 */
import { pathLength, resample, centreOn, shapeReport, selfClearance, densify, projectLatLon, type Control } from '../../shared/course.js';

/** A pasted link is attacker-controlled, so only these hosts are ever fetched. */
const ALLOWED_HOSTS = new Set([
  'maps.app.goo.gl',
  'goo.gl',
  'maps.google.com',
  'www.google.com',
  'google.com',
]);

const OSRM = 'https://router.project-osrm.org';
const SAMPLES_PER_SEGMENT = 14;
/** Control points are spaced this far apart, in final course metres. Dense
 *  enough that the spline tracks the real corners instead of rounding them off.
 */
const CONTROL_SPACING = 4;

export interface CourseOptions {
  /** Metres per second the car travels; from TUNING.BASE_SPEED. */
  speed: number;
  /** Desired seconds per lap. Length follows exactly - see shared/course.ts. */
  targetLapSeconds: number;
  trackWidth: number;
}

export interface GeneratedCourse {
  id: string;
  name: string;
  trackWidth: number;
  /** Always false: a pasted route is point to point, not a circuit. */
  closed: false;
  laps: number;
  sectorCount: number;
  samplesPerSegment: number;
  centerline: Control[];
  sections: { name: string; at: number }[];
  obstacles: never[];
  obstacleSeed: number;
  attribution: string;
  /** Diagnostics for the preview screen, not used by the physics. */
  meta: {
    sourceMetres: number;
    lapSeconds: number;
    minRadius: number;
    pr: number;
    /** Metres between the closest two parts of the course. Below trackWidth the
     *  position along it is ambiguous - the route crosses or doubles back. */
    clearance: number;
    origin: [number, number];
    destination: [number, number];
  };
}

interface Leg {
  coords: [number, number][];
  steps: { name: string; distance: number }[];
  distance: number;
}

/** Follows a short link to the full directions URL. */
async function resolve(url: string): Promise<string> {
  const parsed = new URL(url);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`unsupported host: ${parsed.hostname}`);
  }
  if (parsed.hostname !== 'maps.app.goo.gl' && parsed.hostname !== 'goo.gl') return url;

  const res = await fetch(url, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error('short link did not redirect');
  const target = new URL(location);
  if (!ALLOWED_HOSTS.has(target.hostname)) {
    throw new Error(`short link left the allowlist: ${target.hostname}`);
  }
  return location;
}

const asCoord = (s: string): [number, number] | null => {
  const m = /^(-?\d+\.\d+),(-?\d+\.\d+)$/.exec(s.trim());
  return m ? [Number(m[2]), Number(m[1])] : null; // URL is lat,lng - we want lon,lat
};

/**
 * Pulls the two endpoints out of a directions URL. The origin is usually a raw
 * `lat,lng` in the path; the destination is normally a place name there, with
 * its real coordinates in the `data=` blob as `!1d<lon>!2d<lat>`.
 */
export function parseDirections(url: string): { origin: [number, number]; destination: [number, number]; label: string } {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const dirAt = segments.indexOf('dir');
  if (dirAt < 0) throw new Error('not a directions link - open Directions in Maps, then share');

  const after = segments.slice(dirAt + 1).filter((s) => !s.startsWith('@') && !s.startsWith('data='));
  const origin = after.length ? asCoord(decodeURIComponent(after[0])) : null;

  const blob = parsed.pathname + parsed.search;
  const dm = /!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)/.exec(blob);
  const destination: [number, number] | null = dm ? [Number(dm[1]), Number(dm[2])] : null;

  const centre = /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(blob);
  const fallback: [number, number] | null = centre ? [Number(centre[2]), Number(centre[1])] : null;

  const from = origin ?? fallback;
  const to = destination ?? fallback;
  if (!from || !to || (from[0] === to[0] && from[1] === to[1])) {
    throw new Error('could not read both endpoints from that link');
  }

  const label = after.length > 1
    ? decodeURIComponent(after[1]).replace(/\+/g, ' ').split(',')[0]
    : 'Pasted route';
  return { origin: from, destination: to, label };
}

async function route(a: [number, number], b: [number, number]): Promise<Leg> {
  const url = `${OSRM}/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`routing failed: ${res.status}`);
  const body = (await res.json()) as {
    code: string;
    routes?: { distance: number; geometry: { coordinates: [number, number][] }; legs: { steps: { name?: string; distance: number }[] }[] }[];
  };
  const first = body.routes?.[0];
  if (body.code !== 'Ok' || !first) throw new Error('no drivable route between those points');
  return {
    coords: first.geometry.coordinates,
    distance: first.distance,
    steps: first.legs.flatMap((l) => l.steps.map((s) => ({ name: s.name ?? '', distance: s.distance }))),
  };
}

/** Named streets become section labels, spread across the single leg. */
function sectionsFrom(leg: Leg): { name: string; at: number }[] {
  const total = leg.distance || 1;
  const out: { name: string; at: number }[] = [];
  let travelled = 0;
  for (const step of leg.steps) {
    const named = step.name.trim().toUpperCase();
    if (named && step.distance > total * 0.04 && out[out.length - 1]?.name !== named) {
      out.push({ name: named, at: travelled / total });
    }
    travelled += step.distance;
  }
  if (!out.length || out[0].at > 0.001) out.unshift({ name: 'START', at: 0 });
  return out;
}

export async function courseFromMapsUrl(rawUrl: string, opts: CourseOptions): Promise<GeneratedCourse> {
  const full = await resolve(rawUrl);
  const { origin, destination, label } = parseDirections(full);

  const leg = await route(origin, destination);

  const lat0 = (origin[1] + destination[1]) / 2;
  const lon0 = (origin[0] + destination[0]) / 2;
  const path = projectLatLon(leg.coords, lat0, lon0);
  const sourceMetres = pathLength(path, false);

  // Normalising is a single uniform scale, which is the one transform that
  // cannot distort the shape: a Catmull-Rom spline is affine equivariant, so
  // scaling the control points scales arc length by the same factor.
  //
  // Converge on the length of the SPLINE, not of the polyline it is fitted
  // through - the spline cuts corners and runs shorter, so matching the
  // polyline leaves the course short. The control count is fixed up front, or
  // the spline length jumps between iterations and the correction never settles.
  const targetLength = opts.speed * opts.targetLapSeconds;
  const count = Math.max(24, Math.round(targetLength / CONTROL_SPACING));
  const build = (scale: number) => {
    const scaled = path.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    const control = resample(scaled, count, false).map((p) => [p.x, p.y] as Control);
    return { control, length: pathLength(densify(control, SAMPLES_PER_SEGMENT, false), false) };
  };

  let scale = targetLength / Math.max(sourceMetres, 1e-6);
  let built = build(scale);
  for (let i = 0; i < 12; i++) {
    if (Math.abs(built.length - targetLength) < targetLength * 0.0005) break;
    scale *= targetLength / Math.max(built.length, 1e-6);
    built = build(scale);
  }

  const scaled = centreOn(built.control, { x: 0, y: 0 });
  const report = shapeReport(scaled, SAMPLES_PER_SEGMENT, false, opts.speed, 1);

  const sections = sectionsFrom(leg);
  return {
    id: `url-${hash(full)}`,
    name: label,
    trackWidth: opts.trackWidth,
    closed: false,
    laps: 1,
    sectorCount: sections.length,
    samplesPerSegment: SAMPLES_PER_SEGMENT,
    centerline: scaled.map(([x, y]) => [round(x), round(y)] as Control),
    sections,
    obstacles: [],
    obstacleSeed: hashInt(full),
    attribution: '© OpenStreetMap contributors (ODbL). Routing by OSRM.',
    meta: {
      sourceMetres: Math.round(sourceMetres),
      lapSeconds: +(report.length / opts.speed).toFixed(1),
      minRadius: +report.minRadius.toFixed(2),
      pr: Math.round(report.pr),
      clearance: +selfClearance(densify(scaled, SAMPLES_PER_SEGMENT, false), false).toFixed(1),
      origin,
      destination,
    },
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

function hashInt(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const hash = (s: string) => hashInt(s).toString(36);
