/**
 * Three.js scene renderer.
 *
 * The world model is strictly 2D top-down (x east, y south) and this module is
 * the ONLY place that knows about perspective or height. It maps world (x, y)
 * to three (x, elevation, z = y) at draw time and never writes anything back
 * into game state except `RacerState.elevation`, which is documented as
 * render-only. It reads nothing but `RacerState` and `TrackGeometry`.
 *
 * Renders into a transparent WebGL canvas over the live webcam. The scene fades
 * out toward the bottom of the viewport (a CSS mask on the canvas) so the
 * player's real hands stay visible - the same job the old destination-out
 * gradient did, now done by the compositor for free.
 */
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { RacerState } from '../../../shared/types';
import { TrackGeometry } from '../game/track';
import { TUNING } from '../game/physics';
import { CAR_COLOR_HEX } from './carSprites';
import { FLAT, type ElevationFn } from './elevation';

/** Re-exported so every HUD surface uses the same identity colours as the cars. */
export const RACER_COLORS = [...CAR_COLOR_HEX];

/**
 * Camera constants. Distances are in car lengths so the feel survives the
 * planned switch from pixels to metres: 6.3 car lengths behind is 290px today.
 */
export const CAMERA = {
  BEHIND: TUNING.CAR_LENGTH * 6.3,
  HEIGHT: TUNING.CAR_LENGTH * 3.37,
  /** Focal length in screen px, independent of world units. */
  FOCAL: 760,
  /** How far up the viewport the horizon sits, as a fraction of height. */
  HORIZON: 0.15,
  DRAW_DISTANCE: TUNING.CAR_LENGTH * 52,
  NEAR: TUNING.CAR_LENGTH * 0.5,
  /** WebGL now shares a frame with MediaPipe; cap the pixel work first. */
  MAX_PIXEL_RATIO: 1.5,
} as const;

const ROAD = 0x1a202f;
const ROAD_OFF = 0x4e1e14;
const EDGE_BRIGHT = 0xffffff;
const EDGE_OFF = 0xff6b4a;
/** Fog blends toward the scrim colour so distant road dissolves into the darkened video. */
const FOG = 0x05070d;
/** Lines float this far above the surface so they never z-fight the road. */
const LIFT = TUNING.CAR_LENGTH * 0.02;

export interface SceneInput {
  geom: TrackGeometry;
  racers: RacerState[];
  localTrackDistance: number;
  offTrack: boolean;
  oiled: boolean;
  /** Screen-shake magnitude from the race, applied as camera jitter. */
  shake: number;
}

interface CarMesh {
  group: THREE.Group;
  /** Identity the mesh was built for; a change means rebuild. */
  key: string;
  seen: number;
}

/** Body proportions per car shape, as fractions of car length (L) and width (W). */
const SHAPES: Record<number, { bodyH: number; cabinL: number; cabinH: number; cabinX: number; wing: boolean }> = {
  1: { bodyH: 0.40, cabinL: 0.46, cabinH: 0.30, cabinX: -0.04, wing: false }, // Saloon
  2: { bodyH: 0.34, cabinL: 0.36, cabinH: 0.26, cabinX: -0.10, wing: false }, // Coupe
  3: { bodyH: 0.40, cabinL: 0.50, cabinH: 0.32, cabinX: -0.14, wing: false }, // Hatch
  4: { bodyH: 0.48, cabinL: 0.78, cabinH: 0.42, cabinX: -0.06, wing: false }, // Van
  5: { bodyH: 0.28, cabinL: 0.28, cabinH: 0.22, cabinX: -0.08, wing: true },  // Racer
};

export class SceneRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private track: TrackGeometry | null = null;
  private trackGroup: THREE.Group | null = null;
  private elevationAt: ElevationFn = FLAT;
  private roadMat: THREE.MeshLambertMaterial | null = null;
  private edgeBrightMats: LineMaterial[] = [];
  private lineMaterials: LineMaterial[] = [];
  private cars = new Map<string, CarMesh>();
  private labelCache = new Map<string, THREE.Texture>();
  private frame = 0;
  private width = 1;
  private height = 1;
  /** Last frame's cost, surfaced in the debug overlay (`D`). */
  stats = { renderMs: 0, calls: 0, triangles: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 0);
    // Shadow maps are the first thing to cut for latency, so they never went in.
    this.renderer.shadowMap.enabled = false;

    // Fade toward the bottom of the viewport so the player's hands stay visible.
    const mask = 'linear-gradient(to bottom, #000 62%, transparent 90%)';
    canvas.style.setProperty('mask-image', mask);
    canvas.style.setProperty('-webkit-mask-image', mask);

    this.camera = new THREE.PerspectiveCamera(60, 1, CAMERA.NEAR, CAMERA.DRAW_DISTANCE * 1.2);
    this.scene.fog = new THREE.Fog(FOG, CAMERA.DRAW_DISTANCE * 0.45, CAMERA.DRAW_DISTANCE * 1.05);

    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a1c24, 1.1);
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(400, 1000, 300);
    this.scene.add(hemi, sun);
  }

  resize(w: number, h: number, dpr: number): void {
    this.width = w;
    this.height = h;
    this.renderer.setPixelRatio(Math.min(dpr, CAMERA.MAX_PIXEL_RATIO));
    this.renderer.setSize(w, h, false);

    // The horizon sits HORIZON of the way down the viewport, not in the middle.
    // Tilting the camera would change the perspective (verticals converge), so
    // instead render a window of a taller virtual frame whose centre is the
    // horizon. This reproduces the old pinhole projection exactly.
    const fullH = 2 * (1 - CAMERA.HORIZON) * h;
    this.camera.fov = (2 * Math.atan(fullH / 2 / CAMERA.FOCAL) * 180) / Math.PI;
    this.camera.aspect = w / fullH;
    this.camera.setViewOffset(w, fullH, 0, (1 - 2 * CAMERA.HORIZON) * h, w, h);
    this.camera.updateProjectionMatrix();

    const size = this.bufferSize();
    for (const m of this.lineMaterials) m.resolution.copy(size);
  }

  /** Builds static geometry for a track. Cheap enough to call again when the elevation source changes. */
  setTrack(geom: TrackGeometry, elevationAt: ElevationFn = FLAT): void {
    if (this.trackGroup) {
      this.scene.remove(this.trackGroup);
      disposeTree(this.trackGroup);
    }
    this.track = geom;
    this.elevationAt = elevationAt;
    this.lineMaterials = [];
    this.edgeBrightMats = [];
    this.trackGroup = new THREE.Group();
    this.trackGroup.add(this.buildRoad(geom), this.buildObstacles(geom));
    this.scene.add(this.trackGroup);
  }

  render(input: SceneInput): void {
    const t0 = performance.now();
    if (input.geom !== this.track) this.setTrack(input.geom, this.elevationAt);
    this.frame++;

    this.roadMat?.color.setHex(input.offTrack ? ROAD_OFF : ROAD);
    for (const m of this.edgeBrightMats) m.color.setHex(input.offTrack ? EDGE_OFF : EDGE_BRIGHT);

    let local: RacerState | null = null;
    for (const r of input.racers) {
      const car = this.carFor(r);
      car.seen = this.frame;
      const e = this.elevationAt(r.trackDistance);
      // Render-only, by contract - see the comment on RacerState.elevation.
      r.elevation = e;
      const ds = TUNING.CAR_LENGTH;
      const pitch = Math.atan2(this.elevationAt(r.trackDistance + ds) - this.elevationAt(r.trackDistance - ds), 2 * ds);
      car.group.position.set(r.x, e, r.y);
      // Yaw about world up, then pitch about the car's own lateral axis.
      car.group.rotation.set(0, -r.heading, pitch, 'YZX');
      if (r.isLocalPlayer) local = r;
    }
    for (const [id, car] of this.cars) {
      if (car.seen !== this.frame) {
        this.scene.remove(car.group);
        disposeTree(car.group);
        this.cars.delete(id);
      }
    }

    if (local) this.placeCamera(local, input.shake);
    this.renderer.render(this.scene, this.camera);

    const info = this.renderer.info.render;
    this.stats = { renderMs: performance.now() - t0, calls: info.calls, triangles: info.triangles };
  }

  // --- Camera ----------------------------------------------------------------

  private placeCamera(local: RacerState, shake: number): void {
    const fx = Math.cos(local.heading);
    const fz = Math.sin(local.heading);
    const eye = new THREE.Vector3(
      local.x - fx * CAMERA.BEHIND,
      (local.elevation ?? 0) + CAMERA.HEIGHT,
      local.y - fz * CAMERA.BEHIND,
    );
    // The old renderer jittered the projection by up to +-shake/2 screen px. At
    // the car's depth one screen px is BEHIND/FOCAL world units.
    const k = CAMERA.BEHIND / CAMERA.FOCAL;
    const jx = (Math.random() - 0.5) * shake * k;
    const jy = (Math.random() - 0.5) * shake * k;
    eye.x += -fz * jx;
    eye.z += fx * jx;
    eye.y += jy;
    this.camera.position.copy(eye);
    this.camera.lookAt(eye.x + fx, eye.y, eye.z + fz);
  }

  // --- Track -----------------------------------------------------------------

  private buildRoad(geom: TrackGeometry): THREE.Group {
    const g = new THREE.Group();
    const half = geom.trackWidth / 2;
    const step = Math.max(TUNING.CAR_LENGTH * 0.1, geom.trackWidth / 12);
    const n = Math.max(8, Math.ceil(geom.length / step));

    const surf: number[] = [];
    const idx: number[] = [];
    const left: number[] = [];
    const right: number[] = [];
    const center: number[] = [];
    for (let i = 0; i < n; i++) {
      const s = (i / n) * geom.length;
      const p = geom.pointAt(s);
      const rt = geom.rightAt(s);
      const e = this.elevationAt(s);
      const lx = p.x - rt.x * half;
      const ly = p.y - rt.y * half;
      const rx = p.x + rt.x * half;
      const ry = p.y + rt.y * half;
      surf.push(lx, e, ly, rx, e, ry);
      left.push(lx, e + LIFT, ly);
      right.push(rx, e + LIFT, ry);
      center.push(p.x, e + LIFT, p.y);
      const j = (i + 1) % n;
      idx.push(2 * i, 2 * i + 1, 2 * j, 2 * i + 1, 2 * j + 1, 2 * j);
    }
    for (const arr of [left, right, center]) arr.push(arr[0], arr[1], arr[2]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(surf, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    this.roadMat = new THREE.MeshLambertMaterial({
      color: ROAD,
      transparent: true,
      opacity: 0.78,
      side: THREE.DoubleSide,
      // Push the surface back a hair so the edge lines always win the depth test.
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    const road = new THREE.Mesh(geo, this.roadMat);
    road.renderOrder = 0;
    g.add(road);

    // Edges: a dark stroke underneath a bright one, in constant screen px, so the
    // boundary survives a bright window behind the player and stays legible far
    // down the road. If it comes down to "looks cool" or "player can see the
    // edge", the edge wins.
    for (const pts of [left, right]) {
      g.add(this.line(pts, { color: 0x000000, linewidth: 14, opacity: 0.95, order: 1 }));
      const bright = this.line(pts, { color: EDGE_BRIGHT, linewidth: 5, order: 2 });
      this.edgeBrightMats.push(bright.material as LineMaterial);
      g.add(bright);
    }
    g.add(this.line(center, { color: 0xffffff, linewidth: 3, opacity: 0.32, order: 1, dash: [step, step * 3] }));

    // Start/finish line across s = 0.
    const p0 = geom.pointAt(0);
    const r0 = geom.rightAt(0);
    const e0 = this.elevationAt(0) + LIFT * 1.5;
    const dash = TUNING.CAR_LENGTH * 0.3;
    g.add(this.line(
      [p0.x - r0.x * half, e0, p0.y - r0.y * half, p0.x + r0.x * half, e0, p0.y + r0.y * half],
      { color: 0xffffff, linewidth: 6, opacity: 0.9, order: 2, dash: [dash, dash * 0.7] },
    ));
    return g;
  }

  private line(
    positions: number[],
    o: { color: number; linewidth: number; opacity?: number; order: number; dash?: [number, number] },
  ): Line2 {
    const geo = new LineGeometry();
    geo.setPositions(positions);
    const mat = new LineMaterial({
      color: o.color,
      linewidth: o.linewidth,
      worldUnits: false,
      transparent: true,
      opacity: o.opacity ?? 1,
      depthWrite: false,
      dashed: !!o.dash,
      dashSize: o.dash?.[0] ?? 1,
      gapSize: o.dash?.[1] ?? 1,
    });
    mat.resolution.copy(this.bufferSize());
    this.lineMaterials.push(mat);
    const line = new Line2(geo, mat);
    if (o.dash) line.computeLineDistances();
    line.renderOrder = o.order;
    line.frustumCulled = false;
    return line;
  }

  private buildObstacles(geom: TrackGeometry): THREE.Group {
    const g = new THREE.Group();
    const coneMat = new THREE.MeshLambertMaterial({ color: 0xff7a1a });
    const bandMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const oilMat = new THREE.MeshBasicMaterial({ color: 0x5a32b0, transparent: true, opacity: 0.62, depthWrite: false });
    const oilRingMat = new THREE.MeshBasicMaterial({ color: 0xc8a0ff, transparent: true, opacity: 0.6, depthWrite: false });
    const gateMat = new THREE.MeshLambertMaterial({ map: hazardTexture() });
    const geos = new Map<string, THREE.BufferGeometry>();
    const shared = (key: string, make: () => THREE.BufferGeometry) => {
      let x = geos.get(key);
      if (!x) { x = make(); geos.set(key, x); }
      return x;
    };

    for (const ob of geom.obstacles) {
      const e = this.elevationAt(ob.s);
      if (ob.type === 'cone') {
        const h = ob.r * 1.9;
        const cone = new THREE.Mesh(shared(`cone${ob.r}`, () => new THREE.ConeGeometry(ob.r, h, 12)), coneMat);
        cone.position.set(ob.x, e + h / 2, ob.y);
        const band = new THREE.Mesh(
          shared(`band${ob.r}`, () => new THREE.CylinderGeometry(ob.r * 0.46, ob.r * 0.6, h * 0.14, 12)),
          bandMat,
        );
        band.position.set(ob.x, e + h * 0.5, ob.y);
        g.add(cone, band);
      } else if (ob.type === 'oil') {
        const disc = new THREE.Mesh(shared(`oil${ob.r}`, () => new THREE.CircleGeometry(ob.r, 24)), oilMat);
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(ob.x, e + LIFT * 0.5, ob.y);
        disc.renderOrder = 1;
        const ring = new THREE.Mesh(shared(`oilring${ob.r}`, () => new THREE.RingGeometry(ob.r * 0.9, ob.r, 24)), oilRingMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(ob.x, e + LIFT * 0.6, ob.y);
        ring.renderOrder = 1;
        g.add(disc, ring);
      } else {
        const h = ob.r * 3.6;
        const post = new THREE.Mesh(shared(`gate${ob.r}`, () => new THREE.BoxGeometry(ob.r * 2, h, ob.r * 2)), gateMat);
        post.position.set(ob.x, e + h / 2, ob.y);
        g.add(post);
      }
    }
    return g;
  }

  // --- Cars ------------------------------------------------------------------

  private carFor(r: RacerState): CarMesh {
    const key = `${r.colorIndex}:${r.carShape}:${r.source}:${r.isLocalPlayer}:${r.displayName}`;
    let car = this.cars.get(r.id);
    if (car && car.key !== key) {
      this.scene.remove(car.group);
      disposeTree(car.group);
      car = undefined;
    }
    if (!car) {
      car = { group: this.buildCar(r), key, seen: 0 };
      this.scene.add(car.group);
      this.cars.set(r.id, car);
    }
    return car;
  }

  /** One code path for local, ghost and remote cars; only opacity and adornments differ. */
  private buildCar(r: RacerState): THREE.Group {
    const L = TUNING.CAR_LENGTH;
    const W = TUNING.CAR_WIDTH;
    const shape = SHAPES[r.carShape] ?? SHAPES[1];
    const color = RACER_COLORS[((r.colorIndex % RACER_COLORS.length) + RACER_COLORS.length) % RACER_COLORS.length];
    const opacity = r.isLocalPlayer ? 1 : r.source === 'ghost' ? 0.55 : 0.9;
    const mat = (c: THREE.ColorRepresentation) =>
      new THREE.MeshLambertMaterial({ color: c, transparent: opacity < 1, opacity });

    const group = new THREE.Group();
    const wheelR = W * 0.17;
    const bodyH = shape.bodyH * W;
    const bodyY = wheelR * 0.7 + bodyH / 2;

    // Local +x is the nose; heading rotates the group about world up.
    const bodyGeo = new THREE.BoxGeometry(L * 0.96, bodyH, W * 0.86);
    const body = new THREE.Mesh(bodyGeo, mat(color));
    body.position.y = bodyY;
    group.add(body);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(shape.cabinL * L, shape.cabinH * W, W * 0.7), mat(0x14161c));
    cabin.position.set(shape.cabinX * L, bodyY + bodyH / 2 + (shape.cabinH * W) / 2, 0);
    group.add(cabin);

    if (shape.wing) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(L * 0.12, W * 0.04, W * 0.95), mat(0x14161c));
      wing.position.set(-L * 0.46, bodyY + bodyH / 2 + W * 0.3, 0);
      group.add(wing);
    }

    const wheelGeo = new THREE.CylinderGeometry(wheelR, wheelR, W * 0.14, 12);
    wheelGeo.rotateX(Math.PI / 2);
    const wheelMat = mat(0x0c0c10);
    for (const [x, z] of [[L * 0.32, W * 0.46], [L * 0.32, -W * 0.46], [-L * 0.32, W * 0.46], [-L * 0.32, -W * 0.46]]) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.position.set(x, wheelR, z);
      group.add(wheel);
    }

    if (r.isLocalPlayer) {
      // The player's own car has to be findable at a glance while they are
      // concentrating on their hands: a white outline and a ring on the road.
      body.add(new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeo), new THREE.LineBasicMaterial({ color: 0xffffff })));
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(L * 0.9, L * 0.9 + W * 0.12, 32),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = LIFT * 0.6;
      group.add(ring);
    } else {
      const label = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.labelTexture(r.displayName, color),
        transparent: true,
        depthTest: false,
      }));
      label.scale.set(W * 3.6, W * 0.9, 1);
      label.position.y = W * 1.5;
      label.renderOrder = 5;
      group.add(label);
    }
    return group;
  }

  private labelTexture(name: string, color: string): THREE.Texture {
    const key = `${name}|${color}`;
    let tex = this.labelCache.get(key);
    if (tex) return tex;
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    ctx.font = '600 30px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(name, 128, 32, 248);
    ctx.fillStyle = color;
    ctx.fillText(name, 128, 32, 248);
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.labelCache.set(key, tex);
    return tex;
  }

  private bufferSize(): THREE.Vector2 {
    return this.renderer.getDrawingBufferSize(new THREE.Vector2());
  }
}

/** Yellow post with three black hazard bands, matching the old 2D gate posts. */
function hazardTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 96;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fde047';
  ctx.fillRect(0, 0, 16, 96);
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  for (let i = 0; i < 3; i++) ctx.fillRect(0, 6 + i * 32, 16, 12);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}
