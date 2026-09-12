import type { TrackDef, TrackObstacleDef } from '../../../shared/types';
import { TUNING } from './physics';

/** Additive course metadata lives here; the shared wire contract stays frozen. */
export interface CourseDef extends TrackDef {
  /**
   * False for a point-to-point course that starts and finishes in different
   * places. Defaults to true: every surveyed course is a circuit, and a lap
   * only means anything on a closed one.
   */
  closed?: boolean;
  /** Laps to race. Defaults to TUNING.LAPS closed, and to 1 open. */
  laps?: number;
  elevation?: number[];
  sections?: { name: string; at: number }[];
  obstacleSeed?: number;
  attribution?: string;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Obstacle {
  index: number;
  type: 'cone' | 'oil' | 'gate';
  x: number;
  y: number;
  r: number;
  s: number; // track distance, for bucketing
  /** Gate posts share a groupId so the renderer can draw the gap between them. */
  groupId?: number;
}

export interface TrackPoint {
  x: number;
  y: number;
  heading: number;
}

export interface Projection {
  s: number; // distance along centerline, wrapped into [0, length)
  d: number; // signed lateral offset, + is right of travel direction
  segmentIndex: number;
}

const BUCKET_SIZE = 400;

/**
 * Catmull-Rom through the hand-authored control points. This densifies an
 * editable handful of points into a drivable polyline - it does not invent the
 * shape, which stays exactly where the author put it.
 *
 * A closed course wraps the ends into a loop; an open one clamps them, so a
 * pasted route keeps its real start and finish instead of being bent into a
 * circuit it never was.
 */
function densify(control: [number, number][], samples: number, closed: boolean): { x: number; y: number }[] {
  const n = control.length;
  if (n < 3) return control.map(([x, y]) => ({ x, y }));
  const at = closed
    ? (i: number) => control[((i % n) + n) % n]
    : (i: number) => control[i < 0 ? 0 : i > n - 1 ? n - 1 : i];
  const out: { x: number; y: number }[] = [];
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let k = 0; k < samples; k++) {
      const t = k / samples;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        y: 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      });
    }
  }
  if (!closed) out.push({ x: control[n - 1][0], y: control[n - 1][1] });
  return out;
}

export class TrackGeometry {
  readonly def: CourseDef;
  /** False for point-to-point courses; see CourseDef.closed. */
  readonly closed: boolean;
  readonly laps: number;
  readonly trackWidth: number;
  readonly length: number;
  readonly sectorBoundaries: number[]; // cumulative s at each sector end
  readonly obstacles: Obstacle[];
  readonly bounds: { minX: number; minY: number; maxX: number; maxY: number };

  private pts: { x: number; y: number }[];
  private cum: number[]; // cumulative distance at point i
  private tan: { x: number; y: number }[]; // unit tangent of segment i
  private segLen: number[];
  private buckets: Map<number, Obstacle[]> = new Map();

  constructor(def: CourseDef, seed = def.obstacleSeed) {
    this.def = def;
    this.closed = def.closed !== false;
    // A point-to-point course cannot be lapped: it finishes somewhere else.
    this.laps = def.laps ?? (this.closed ? TUNING.LAPS : 1);
    this.trackWidth = TUNING.TRACK_WIDTH_OVERRIDE ?? def.trackWidth;
    this.pts = densify(def.centerline, def.samplesPerSegment ?? 14, this.closed);

    const n = this.pts.length;
    this.cum = new Array(n + 1);
    this.tan = new Array(n);
    this.segLen = new Array(n);

    // Segment i runs from point i to point i+1; on a closed course the last
    // segment wraps back to the first, on an open one there is no such segment.
    const spans = this.closed ? n : n - 1;
    let acc = 0;
    for (let i = 0; i < spans; i++) {
      this.cum[i] = acc;
      const a = this.pts[i];
      const b = this.pts[(i + 1) % n];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1e-6;
      this.segLen[i] = len;
      this.tan[i] = { x: dx / len, y: dy / len };
      acc += len;
    }
    if (!this.closed) {
      // The final point terminates the last segment rather than starting a new
      // one, so give it a zero-length entry the binary search can land on.
      this.segLen[n - 1] = 1e-6;
      this.tan[n - 1] = this.tan[n - 2] ?? { x: 1, y: 0 };
      this.cum[n - 1] = acc;
    }
    this.cum[n] = acc;
    this.length = acc;

    this.sectorBoundaries = def.sections?.length
      ? [...def.sections.slice(1).map(s => s.at * this.length), this.length]
      : Array.from({ length: def.sectorCount }, (_, i) => this.length * (i + 1) / def.sectorCount);

    const obstacles: TrackObstacleDef[] = seed === undefined ? def.obstacles : [];
    if (seed !== undefined) {
      const rand = mulberry32(seed);
      for (let s = TUNING.OBSTACLE_START_CLEARANCE; s < this.length - TUNING.OBSTACLE_START_CLEARANCE;
        s += TUNING.OBSTACLE_SPACING + rand() * TUNING.OBSTACLE_JITTER) {
        obstacles.push({ type: 'cone', s, d: (rand() * 2 - 1) * (this.trackWidth / 2 - TUNING.OBSTACLE_EDGE_MARGIN) });
      }
    }
    this.obstacles = this.expandObstacles({ ...def, obstacles });
    for (const ob of this.obstacles) {
      const b = Math.floor(ob.s / BUCKET_SIZE);
      if (!this.buckets.has(b)) this.buckets.set(b, []);
      this.buckets.get(b)!.push(ob);
    }

    const half = this.trackWidth / 2 + 60;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.pts) {
      minX = Math.min(minX, p.x - half);
      minY = Math.min(minY, p.y - half);
      maxX = Math.max(maxX, p.x + half);
      maxY = Math.max(maxY, p.y + half);
    }
    this.bounds = { minX, minY, maxX, maxY };
  }

  /** Expands (s, d) authored obstacles into world-space circular colliders. */
  private expandObstacles(def: TrackDef): Obstacle[] {
    const out: Obstacle[] = [];
    let index = 0;
    let groupId = 0;
    for (const o of def.obstacles) {
      const s = this.along(o.s);
      const place = (d: number, r: number, type: Obstacle['type'], gid?: number) => {
        const p = this.pointAt(s);
        const right = { x: -Math.sin(p.heading), y: Math.cos(p.heading) };
        out.push({
          index: index++,
          type,
          x: p.x + right.x * d,
          y: p.y + right.y * d,
          r,
          s,
          groupId: gid,
        });
      };

      if (o.type === 'gate') {
        const gap = o.gap ?? TUNING.GATE_DEFAULT_GAP;
        const r = o.r ?? TUNING.GATE_POST_RADIUS;
        const gid = groupId++;
        place(o.d - gap / 2 - r, r, 'gate', gid);
        place(o.d + gap / 2 + r, r, 'gate', gid);
      } else if (o.type === 'oil') {
        place(o.d, o.r ?? TUNING.OIL_RADIUS, 'oil');
      } else {
        place(o.d, o.r ?? TUNING.CONE_RADIUS, 'cone');
      }
    }
    return out;
  }

  /**
   * Distance s mapped into the course. A closed course wraps, so lap two is lap
   * one again; an open one clamps, because past the finish there is no more
   * course to be on.
   */
  private along(s: number): number {
    if (!this.closed) return s < 0 ? 0 : s > this.length ? this.length : s;
    return ((s % this.length) + this.length) % this.length;
  }

  /** World point and heading at distance s along the centerline. */
  pointAt(s: number): TrackPoint {
    const n = this.pts.length;
    const d = this.along(s);

    // Binary search for the segment containing d.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    const i = lo;
    const t = (d - this.cum[i]) / this.segLen[i];
    const a = this.pts[i];
    const b = this.pts[(i + 1) % n];
    const tg = this.tan[i];
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      heading: Math.atan2(tg.y, tg.x),
    };
  }

  /** Unit vector pointing right of the travel direction at distance s. */
  rightAt(s: number): { x: number; y: number } {
    const p = this.pointAt(s);
    return { x: -Math.sin(p.heading), y: Math.cos(p.heading) };
  }

  /**
   * Closest point on the centerline. Searches a window around `hint` first so a
   * hairpin that folds back on itself cannot snap the car to the wrong lap
   * position; falls back to a full scan when the window misses.
   */
  project(x: number, y: number, hint = -1): Projection {
    const n = this.pts.length;
    const WINDOW = 24;

    let best: Projection | null = null;
    let bestDistSq = Infinity;

    const consider = (i: number) => {
      const a = this.pts[i];
      const b = this.pts[(i + 1) % n];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const lenSq = abx * abx + aby * aby || 1e-6;
      let t = ((x - a.x) * abx + (y - a.y) * aby) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + abx * t;
      const py = a.y + aby * t;
      const dx = x - px;
      const dy = y - py;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        const tg = this.tan[i];
        const right = { x: -tg.y, y: tg.x };
        best = {
          s: this.cum[i] + this.segLen[i] * t,
          d: dx * right.x + dy * right.y,
          segmentIndex: i,
        };
      }
    };

    if (hint >= 0) {
      for (let k = -WINDOW; k <= WINDOW; k++) {
        const i = hint + k;
        if (this.closed) consider(((i % n) + n) % n);
        else if (i >= 0 && i < n - 1) consider(i);
      }
      // Accept the windowed result only if it is plausibly on the track.
      if (best && bestDistSq < Math.pow(this.trackWidth * 1.6, 2)) return best;
    }

    best = null;
    bestDistSq = Infinity;
    const spans = this.closed ? n : n - 1;
    for (let i = 0; i < spans; i++) consider(i);
    return best!;
  }

  obstaclesNear(trackDistance: number): Obstacle[] {
    const s = this.along(trackDistance);
    const b = Math.floor(s / BUCKET_SIZE);
    const maxBucket = Math.floor(this.length / BUCKET_SIZE);
    const out: Obstacle[] = [];
    for (let k = -1; k <= 1; k++) {
      const key = ((b + k) % (maxBucket + 1) + maxBucket + 1) % (maxBucket + 1);
      const list = this.buckets.get(key);
      if (list) out.push(...list);
    }
    return out;
  }

  /** All obstacles whose s falls within [from, from + span], wrapping. */
  obstaclesInRange(from: number, span: number): Obstacle[] {
    const out: Obstacle[] = [];
    for (const ob of this.obstacles) {
      let ds = ob.s - this.along(from);
      if (this.closed) {
        if (ds < -this.length / 2) ds += this.length;
        if (ds > this.length / 2) ds -= this.length;
      }
      if (ds >= -120 && ds <= span) out.push(ob);
    }
    return out;
  }

  /** Height is queried only by renderers, never by physics or projection. */
  elevationAt(s: number): number {
    const heights = this.def.elevation;
    if (!heights?.length) return 0;
    const d = this.along(s);
    let lo = 0, hi = this.pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= d) lo = mid; else hi = mid - 1;
    }
    const samples = this.def.samplesPerSegment ?? 14;
    const u = (lo + (d - this.cum[lo]) / this.segLen[lo]) / samples;
    const i = Math.floor(u), f = u - i;
    if (!this.closed) {
      const a = Math.min(i, heights.length - 1);
      const b = Math.min(i + 1, heights.length - 1);
      return heights[a] * (1 - f) + heights[b] * f;
    }
    return heights[i % heights.length] * (1 - f) + heights[(i + 1) % heights.length] * f;
  }

  sectionNameAt(s: number): string {
    const i = this.sectorIndexFor(s);
    return this.def.sections?.[i]?.name ?? `Sector ${i + 1}`;
  }

  sectorEndAt(index: number): number {
    const n = this.sectorBoundaries.length;
    return Math.floor(index / n) * this.length + this.sectorBoundaries[index % n];
  }

  sectorIndexFor(trackDistance: number): number {
    const s = this.along(trackDistance);
    for (let i = 0; i < this.sectorBoundaries.length; i++) {
      if (s < this.sectorBoundaries[i]) return i;
    }
    return this.sectorBoundaries.length - 1;
  }
}

export async function loadTrack(url: string): Promise<TrackGeometry> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`track load failed: ${res.status}`);
  const def = (await res.json()) as TrackDef;
  return new TrackGeometry(def);
}
