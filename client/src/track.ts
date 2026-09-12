import * as THREE from 'three';
import type { TrackDef } from './tracks';

const SAMPLES = 800;

export interface Obstacle {
  pos: THREE.Vector3;
  mesh: THREE.Object3D;
  radius: number;
  baseY: number;
  /** Timestamp of the last hit, used for a knock-down animation and hit cooldown. */
  hitAt: number;
}

export interface TrackQuery {
  /** Index into the sample array of the closest centerline point. */
  idx: number;
  /** Signed lateral distance from the centerline (positive = right of travel direction). */
  lateral: number;
  /** 0..1 progress around the lap. */
  progress: number;
}

/** Deterministic PRNG so every client in a room places obstacles identically. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Track {
  readonly width: number;
  readonly curve: THREE.CatmullRomCurve3;
  readonly points: THREE.Vector3[] = [];
  readonly tangents: THREE.Vector3[] = [];
  readonly normals: THREE.Vector3[] = [];
  readonly pitches: number[] = [];
  readonly bounds = new THREE.Box3();
  readonly group = new THREE.Group();
  readonly obstacles: Obstacle[] = [];

  constructor(readonly def: TrackDef, seed = 1337) {
    this.width = def.roadWidth;
    this.curve = new THREE.CatmullRomCurve3(
      def.points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
      true,
      'centripetal',
    );
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / SAMPLES;
      const p = this.curve.getPointAt(t);
      const tan = this.curve.getTangentAt(t).normalize();
      const flat = Math.hypot(tan.x, tan.z) || 1;
      this.points.push(p);
      this.tangents.push(tan);
      // Right-hand horizontal normal for a y-up world when travelling along `tan`.
      this.normals.push(new THREE.Vector3(-tan.z / flat, 0, tan.x / flat));
      this.pitches.push(Math.atan2(tan.y, flat));
    }
    this.bounds.setFromPoints(this.points);

    const w = this.width;
    this.group.add(this.strip(0, w, 0x2b2b31, 0.0));
    this.group.add(this.strip(w / 2 - 0.5, 1, 0xffffff, 0.02));
    this.group.add(this.strip(-w / 2 + 0.5, 1, 0xffffff, 0.02));
    this.group.add(this.strip(0, 0.35, 0xffd23d, 0.02, 12, 6));
    // Checkered start line straddling sample 0.
    for (let c = 0; c < 8; c++) {
      const off = -w / 2 + (c + 0.5) * (w / 8);
      this.group.add(this.strip(off, w / 8, c % 2 ? 0x111111 : 0xffffff, 0.03, 0, 0, [SAMPLES - 1, 1]));
    }
    this.placeObstacles(seed);
  }

  /** Nearest centerline point (in the ground plane), searching near `hint` for speed. */
  query(pos: THREE.Vector3, hint = -1): TrackQuery {
    let best = -1;
    let bestD = Infinity;
    const check = (i: number) => {
      const idx = ((i % SAMPLES) + SAMPLES) % SAMPLES;
      const p = this.points[idx];
      const d = (pos.x - p.x) ** 2 + (pos.z - p.z) ** 2;
      if (d < bestD) { bestD = d; best = idx; }
    };
    if (hint < 0) {
      for (let i = 0; i < SAMPLES; i += 2) check(i);
    } else {
      for (let i = hint - 40; i <= hint + 40; i++) check(i);
    }
    const p = this.points[best];
    const n = this.normals[best];
    const lateral = (pos.x - p.x) * n.x + (pos.z - p.z) * n.z;
    return { idx: best, lateral, progress: best / SAMPLES };
  }

  heightAt(idx: number): number {
    return this.points[((idx % SAMPLES) + SAMPLES) % SAMPLES].y;
  }

  /** Slope of the road in radians, positive when climbing in the direction of travel. */
  pitchAt(idx: number): number {
    return this.pitches[((idx % SAMPLES) + SAMPLES) % SAMPLES];
  }

  headingAt(idx: number): number {
    const t = this.tangents[((idx % SAMPLES) + SAMPLES) % SAMPLES];
    return Math.atan2(t.x, t.z);
  }

  sectionAt(progress: number): string {
    let name = '';
    for (const s of this.def.sections) if (progress >= s.at) name = s.name;
    return name;
  }

  /** Grid position behind the start line: two cars per row, rows ~10 m apart. */
  startPosition(slot: number): THREE.Vector3 {
    const row = Math.floor(slot / 2);
    const idx = SAMPLES - 6 - row * 5;
    return this.points[idx].clone().addScaledVector(this.normals[idx], slot % 2 === 0 ? -3.2 : 3.2);
  }

  private strip(
    offset: number, width: number, color: number, y: number,
    dashOn = 0, dashOff = 0, range?: [number, number],
  ): THREE.Mesh {
    const verts: number[] = [];
    const idx: number[] = [];
    let v = 0;
    const [from, to] = range ?? [0, SAMPLES - 1];
    const count = ((to - from + SAMPLES) % SAMPLES) + 1;
    for (let k = 0; k < count; k++) {
      const i = (from + k) % SAMPLES;
      if (dashOn && (i % (dashOn + dashOff)) >= dashOn) continue;
      const j = (i + 1) % SAMPLES;
      for (const s of [i, j]) {
        const p = this.points[s];
        const n = this.normals[s];
        verts.push(
          p.x + n.x * (offset - width / 2), p.y + y, p.z + n.z * (offset - width / 2),
          p.x + n.x * (offset + width / 2), p.y + y, p.z + n.z * (offset + width / 2),
        );
      }
      idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      v += 4;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color }));
    m.receiveShadow = true;
    return m;
  }

  private placeObstacles(seed: number): void {
    const rand = mulberry32(seed);
    const coneGeo = new THREE.ConeGeometry(0.9, 2.2, 12);
    const coneMat = new THREE.MeshLambertMaterial({ color: 0xff7a1a });
    const barrelGeo = new THREE.CylinderGeometry(1.1, 1.1, 2.2, 14);
    const barrelMat = new THREE.MeshLambertMaterial({ color: 0x3d7bff });
    for (let i = 60; i < SAMPLES - 40; i += 32 + Math.floor(rand() * 20)) {
      const lateral = (rand() * 2 - 1) * (this.width / 2 - 2.5);
      const p = this.points[i].clone().addScaledVector(this.normals[i], lateral);
      const barrel = rand() < 0.3;
      const mesh = new THREE.Mesh(barrel ? barrelGeo : coneGeo, barrel ? barrelMat : coneMat);
      const baseY = p.y + 1.1;
      mesh.position.set(p.x, baseY, p.z);
      mesh.castShadow = true;
      this.group.add(mesh);
      this.obstacles.push({ pos: p, mesh, radius: barrel ? 1.3 : 1.0, baseY, hitAt: -Infinity });
    }
  }
}

/** Rolling terrain that follows the road's elevation (inverse-distance weighting of track samples). */
export function buildTerrain(track: Track): THREE.Mesh {
  const margin = 260;
  const min = track.bounds.min;
  const max = track.bounds.max;
  const sizeX = max.x - min.x + margin * 2;
  const sizeZ = max.z - min.z + margin * 2;
  const segs = 140;
  const geo = new THREE.PlaneGeometry(sizeX, sizeZ, segs, segs);
  geo.rotateX(-Math.PI / 2);
  geo.translate((min.x + max.x) / 2, 0, (min.z + max.z) / 2);

  const ref = track.points.filter((_, i) => i % 4 === 0);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    let sw = 0;
    let sh = 0;
    for (const r of ref) {
      const w = 1 / ((x - r.x) ** 2 + (z - r.z) ** 2 + 40);
      sw += w;
      sh += w * r.y;
    }
    pos.setY(i, sh / sw - 0.35);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x4d8f3a }));
  m.receiveShadow = true;
  return m;
}
