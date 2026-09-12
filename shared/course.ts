/**
 * Course geometry shared by the client (which drives on it) and the server
 * (which generates it from a pasted route). Pure maths - no DOM, no node, no
 * imports - so both tsconfigs can pull it in unchanged.
 *
 * The headline guarantee is `scaleToLength`: a Catmull-Rom spline is affine
 * equivariant, so scaling the control points by f scales the densified arc
 * length by exactly f. That makes "normalise any shape to a 35-second lap"
 * a single multiplication rather than a search, and it cannot distort the
 * shape, because a uniform scale is the one transform that preserves it.
 */

export interface Pt {
  x: number;
  y: number;
}

export type Control = [number, number];

/**
 * Catmull-Rom through the control points. `closed` wraps the ends into a loop;
 * open paths clamp instead, so a route keeps its real start and finish rather
 * than being bent into a circuit.
 */
export function densify(control: Control[], samples: number, closed: boolean): Pt[] {
  const n = control.length;
  if (n < 3) return control.map(([x, y]) => ({ x, y }));
  const at = closed
    ? (i: number) => control[((i % n) + n) % n]
    : (i: number) => control[i < 0 ? 0 : i > n - 1 ? n - 1 : i];

  const out: Pt[] = [];
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
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

export function pathLength(pts: Pt[], closed: boolean): number {
  let acc = 0;
  const last = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < last; i++) {
    const b = pts[(i + 1) % pts.length];
    acc += Math.hypot(b.x - pts[i].x, b.y - pts[i].y);
  }
  return acc;
}

/** Arc-length-even resample. Open paths keep their exact first and last point. */
export function resample(pts: Pt[], n: number, closed: boolean): Pt[] {
  const total = pathLength(pts, closed);
  const step = closed ? total / n : total / (n - 1);
  const out: Pt[] = [];
  let i = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (i < pts.length - (closed ? 1 : 2)) {
      const seg = Math.hypot(pts[(i + 1) % pts.length].x - pts[i].x, pts[(i + 1) % pts.length].y - pts[i].y);
      if (acc + seg >= target) break;
      acc += seg;
      i++;
    }
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const seg = Math.hypot(b.x - a.x, b.y - a.y) || 1e-9;
    const f = Math.min(1, (target - acc) / seg);
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  }
  return out;
}

/** Signed-area-free curvature probe: radius of the circle through three points. */
function radiusAt(a: Pt, b: Pt, c: Pt): number {
  const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
  if (area < 1e-9) return Infinity;
  const ab = Math.hypot(b.x - a.x, b.y - a.y);
  const bc = Math.hypot(c.x - b.x, c.y - b.y);
  const ac = Math.hypot(c.x - a.x, c.y - a.y);
  return (ab * bc * ac) / (4 * area);
}

/** Tightest corner on the densified path, in world units. */
export function minRadius(pts: Pt[], closed: boolean, window = 3): number {
  const n = pts.length;
  let best = Infinity;
  const lo = closed ? 0 : window;
  const hi = closed ? n : n - window;
  for (let i = lo; i < hi; i++) {
    const a = pts[((i - window) % n + n) % n];
    const c = pts[(i + window) % n];
    const r = radiusAt(a, pts[i], c);
    if (r < best) best = r;
  }
  return best;
}

/**
 * Uniformly scales the control points so the densified path is exactly
 * `targetLength`, keeping the centre where it was. Exact in one step - see the
 * module header. Returns the control points, not the dense path.
 */
export function scaleToLength(
  control: Control[],
  targetLength: number,
  samples: number,
  closed: boolean,
): Control[] {
  const current = pathLength(densify(control, samples, closed), closed);
  if (!(current > 1e-6)) return control;
  const f = targetLength / current;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of control) {
    cx += x;
    cy += y;
  }
  cx /= control.length;
  cy /= control.length;
  return control.map(([x, y]) => [cx + (x - cx) * f, cy + (y - cy) * f] as Control);
}

/** Recentres the control points so their bounding box sits on `centre`. */
export function centreOn(control: Control[], centre: Pt): Control[] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of control) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const dx = centre.x - (minX + maxX) / 2;
  const dy = centre.y - (minY + maxY) / 2;
  return control.map(([x, y]) => [x + dx, y + dy] as Control);
}

/**
 * How raceable a shape is, independent of scale. `pr` is path length over
 * tightest radius: it is dimensionless, so scaling the course cannot change it.
 * That makes it the honest gate - a shape with a bad `pr` cannot be rescued by
 * normalising the lap time, only by smoothing.
 */
export interface ShapeReport {
  length: number;
  minRadius: number;
  pr: number;
  /** Shortest lap, in seconds, that keeps the tightest corner at `radiusFloor`. */
  minLapSeconds: number;
}

export function shapeReport(
  control: Control[],
  samples: number,
  closed: boolean,
  speed: number,
  radiusFloor: number,
): ShapeReport {
  const dense = densify(control, samples, closed);
  const length = pathLength(dense, closed);
  const r = minRadius(dense, closed);
  const pr = r === Infinity ? 0 : length / r;
  return { length, minRadius: r, pr, minLapSeconds: (pr * radiusFloor) / speed };
}

/** Laplacian smoothing, used to lift a shape's tightest corners off the floor. */
export function smooth(pts: Pt[], iterations: number, closed: boolean): Pt[] {
  let p = pts;
  const n = p.length;
  for (let it = 0; it < iterations; it++) {
    const q: Pt[] = new Array(n);
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) {
        q[i] = p[i];
        continue;
      }
      const a = p[((i - 1) % n + n) % n];
      const b = p[(i + 1) % n];
      q[i] = { x: (a.x + 2 * p[i].x + b.x) / 4, y: (a.y + 2 * p[i].y + b.y) / 4 };
    }
    p = q;
  }
  return p;
}

/** Equirectangular projection - accurate well past the size of any course. */
export function projectLatLon(
  coords: [number, number][],
  lat0: number,
  lon0: number,
): Pt[] {
  const mPerDegLon = Math.cos((lat0 * Math.PI) / 180) * 111320;
  return coords.map(([lon, lat]) => ({
    x: (lon - lon0) * mPerDegLon,
    y: -(lat - lat0) * 110540,
  }));
}

/**
 * Closest approach between two parts of the loop that are far apart along it.
 *
 * A course narrower than its own track width has no well-defined position along
 * the lap: `project` snaps between the two branches and the lap counter jumps.
 * Roads that double back on themselves produce exactly this, so it is measured
 * and reported rather than silently shipped.
 */
export function selfClearance(pts: Pt[], closed: boolean): number {
  const n = pts.length;
  const apart = Math.max(8, Math.floor(n * 0.04));
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const along = closed ? Math.min(j - i, n - (j - i)) : j - i;
      if (along < apart) continue;
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d < best) best = d;
    }
  }
  return best === Infinity ? Infinity : best;
}
