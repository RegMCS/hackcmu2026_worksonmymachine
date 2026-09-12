/**
 * Turns a pasted Google Maps directions link into a playable course.
 *
 * Google is used only as an address bar: the link carries the endpoints, never
 * the road geometry, so the path itself comes from OSRM over OpenStreetMap data.
 * That keeps the result redistributable (ODbL, attributed) instead of subject to
 * the Maps terms, which forbid storing derived geometry.
 *
 * Because the race runs three laps, the course must close. A single A->B route
 * is an open path, so the lap is built as a dogbone: out along one side of the
 * road, a hairpin, and back along the other side.
 *
 * Routing the return separately was tried first and does not work. The two
 * directions are different roads (one-way systems), so they cross each other,
 * and a course that crosses itself has no well-defined position along the lap -
 * `project` snaps between the branches and the lap counter jumps. Mirroring a
 * single path cannot cross itself, so the lap is always well defined.
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
/** Control points are spaced this far apart, in final course metres. The
 *  dogbone is only two lanes wide, so coarse spacing lets the spline cut across
 *  the ribbon and the two carriageways touch. */
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
    /** Metres between the two carriageways at their closest. Below trackWidth
     *  the lap position is ambiguous - the route doubles back on itself. */
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

/**
 * Shifts a leg sideways along its own left-hand normal.
 *
 * The out and back legs follow the same road, so without this they coincide and
 * the car's position along the lap becomes undefined - `project` snaps between
 * them and the lap counter jumps. Offsetting each leg to its own left puts them
 * on opposite sides, exactly like the two carriageways of a real road, leaving
 * `2 * distance` of clearance and turning each end into a hairpin.
 */
function offsetLeft(pts: { x: number; y: number }[], distance: number): { x: number; y: number }[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    // Left normal of the direction of travel.
    return { x: p.x + (dy / len) * distance, y: p.y - (dx / len) * distance };
  });
}

/** Scales the road to final size, then wraps a lane either side of it. */
function dogbone(centre: { x: number; y: number }[], scale: number, lane: number): { x: number; y: number }[] {
  const road = centre.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  return [...offsetLeft(road, lane), ...offsetLeft([...road].reverse(), lane)];
}

/**
 * Named streets become section labels. The lap runs out and back along one
 * road, so each street is passed twice: once in the first half, once mirrored
 * into the second.
 */
function sectionsFrom(leg: Leg): { name: string; at: number }[] {
  const total = leg.distance || 1;
  const outbound: { name: string; at: number }[] = [];
  let travelled = 0;
  for (const step of leg.steps) {
    const named = step.name.trim().toUpperCase();
    if (named && step.distance > total * 0.06 && outbound[outbound.length - 1]?.name !== named) {
      outbound.push({ name: named, at: (travelled / total) * 0.5 });
    }
    travelled += step.distance;
  }
  if (!outbound.length || outbound[0].at > 0.001) outbound.unshift({ name: 'START', at: 0 });

  const back = outbound
    .filter((sec) => sec.at > 0.001)
    .map((sec) => ({ name: sec.name, at: 1 - sec.at }))
    .sort((a, b) => a.at - b.at);
  return [...outbound, { name: 'HAIRPIN', at: 0.5 }, ...back];
}

export async function courseFromMapsUrl(rawUrl: string, opts: CourseOptions): Promise<GeneratedCourse> {
  const full = await resolve(rawUrl);
  const { origin, destination, label } = parseDirections(full);

  const leg = await route(origin, destination);

  const lat0 = (origin[1] + destination[1]) / 2;
  const lon0 = (origin[0] + destination[0]) / 2;
  const centre = projectLatLon(leg.coords, lat0, lon0);
  const sourceMetres = pathLength(centre, false);

  // One lane of clearance each side leaves 2 * LANE between the carriageways,
  // comfortably wider than the track, so lap position stays unambiguous.
  //
  // The lane offset must be applied at FINAL scale. Offsetting first and then
  // scaling the whole loop to hit the target lap shrinks the gap by the same
  // factor, which is how the carriageways end up on top of each other again.
  const LANE = opts.trackWidth;
  const targetLength = opts.speed * opts.targetLapSeconds;

  // A lap is the road twice plus the two hairpins, so solve for the scale that
  // lands on the target, then confirm it and correct once for the bends.
  //
  // Converge on the length of the SPLINE, not of the offset polyline. The game
  // drives the densified Catmull-Rom, which cuts corners and so runs shorter
  // than the polyline it was fitted through; matching the polyline to the target
  // leaves the actual lap several percent short.
  //
  // Loop length is close to affine in the scale (two carriageways plus
  // fixed-size hairpins), so the correction converges in a few passes.
  // Fixed for the whole search: the final lap length is known up front, and
  // letting the count drift with the scale makes the spline length jump between
  // iterations so the correction never settles.
  const count = Math.max(48, Math.round(targetLength / CONTROL_SPACING));
  const build = (scale: number) => {
    const control = resample(dogbone(centre, scale, LANE), count, true).map((p) => [p.x, p.y] as Control);
    return { control, length: pathLength(densify(control, SAMPLES_PER_SEGMENT, true), true) };
  };

  let scale = (targetLength - 2 * Math.PI * LANE) / (2 * Math.max(sourceMetres, 1e-6));
  let built = build(scale);
  for (let i = 0; i < 12; i++) {
    if (Math.abs(built.length - targetLength) < targetLength * 0.0005) break;
    scale *= targetLength / Math.max(built.length, 1e-6);
    built = build(scale);
  }

  const scaled = centreOn(built.control, { x: 0, y: 0 });
  const report = shapeReport(scaled, SAMPLES_PER_SEGMENT, true, opts.speed, 1);

  const sections = sectionsFrom(leg);
  return {
    id: `url-${hash(full)}`,
    name: label,
    trackWidth: opts.trackWidth,
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
      clearance: +selfClearance(densify(scaled, SAMPLES_PER_SEGMENT, true), true).toFixed(1),
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
