import type { RacerState } from '../../../shared/types';
import { TrackGeometry, type Obstacle } from '../game/track';
import { TUNING } from '../game/physics';
import { CAMERA, WindshieldCamera, type ProjectedPoint } from './projection';
import { CAR_COLOR_HEX, getSprite } from './carSprites';

/** Re-exported so every HUD surface uses the same identity colours as the cars. */
export const RACER_COLORS = [...CAR_COLOR_HEX];

const ROAD_FILL = 'rgba(26, 32, 47, 0.72)';
const ROAD_FILL_OFF = 'rgba(78, 30, 20, 0.72)';
const EDGE_DARK = 'rgba(0, 0, 0, 0.95)';
const EDGE_BRIGHT = '#ffffff';
const CENTER_DASH = 'rgba(255, 255, 255, 0.32)';

export interface SceneInput {
  geom: TrackGeometry;
  camera: WindshieldCamera;
  racers: RacerState[];
  localTrackDistance: number;
  offTrack: boolean;
  oiled: boolean;
}

export class SceneRenderer {
  constructor(private ctx: CanvasRenderingContext2D) {}

  render(input: SceneInput): void {
    const { ctx } = this;
    const { camera } = input;
    ctx.clearRect(0, 0, camera.width, camera.height);

    this.drawRoad(input);
    this.drawStartLine(input);
    this.drawObstaclesAndRacers(input);
    this.fadeBottom(camera);
  }

  /** Ground-plane circle: foreshortened vertically by height/depth. */
  private groundEllipse(p: ProjectedPoint, rWorld: number): [number, number] {
    const rx = rWorld * p.scale;
    const ry = rx * (CAMERA.HEIGHT / p.z);
    return [rx, ry];
  }

  private drawRoad(input: SceneInput): void {
    const { ctx } = this;
    const { geom, camera, localTrackDistance } = input;
    const half = geom.trackWidth / 2;

    const STEP = 26;
    const start = localTrackDistance - 90;
    const left: ProjectedPoint[] = [];
    const right: ProjectedPoint[] = [];
    const center: ProjectedPoint[] = [];
    let started = false;

    for (let d = 0; d <= CAMERA.DRAW_DISTANCE; d += STEP) {
      const s = start + d;
      const pt = geom.pointAt(s);
      const nx = -Math.sin(pt.heading);
      const ny = Math.cos(pt.heading);

      if (camera.depthOf(pt.x, pt.y) < CAMERA.Z_NEAR) {
        // The road has curved behind us - a hairpin. Stop; you cannot see
        // through a corner, and continuing produces garbage geometry.
        if (started) break;
        continue;
      }
      started = true;
      const lp = camera.project(pt.x - nx * half, pt.y - ny * half);
      const rp = camera.project(pt.x + nx * half, pt.y + ny * half);
      const cp = camera.project(pt.x, pt.y);
      if (!lp.visible || !rp.visible || !cp.visible) break;
      left.push(lp);
      right.push(rp);
      center.push(cp);
    }
    if (left.length < 2) return;

    // --- Surface -----------------------------------------------------------
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y);
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
    ctx.closePath();
    ctx.fillStyle = input.offTrack ? ROAD_FILL_OFF : ROAD_FILL;
    ctx.fill();

    // --- Centre dashes -----------------------------------------------------
    ctx.save();
    ctx.strokeStyle = CENTER_DASH;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < center.length - 1; i += 4) {
      ctx.moveTo(center[i].x, center[i].y);
      ctx.lineTo(center[i + 1].x, center[i + 1].y);
    }
    ctx.stroke();
    ctx.restore();

    // --- Edges -------------------------------------------------------------
    // Dark stroke underneath a bright one, so the boundary survives a bright
    // window behind the player as well as a dark room. If it comes down to
    // "looks cool" or "player can see the edge", the edge wins.
    for (const side of [left, right]) {
      ctx.beginPath();
      ctx.moveTo(side[0].x, side[0].y);
      for (let i = 1; i < side.length; i++) ctx.lineTo(side[i].x, side[i].y);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = EDGE_DARK;
      ctx.lineWidth = 14;
      ctx.stroke();
      ctx.strokeStyle = input.offTrack ? '#ff6b4a' : EDGE_BRIGHT;
      ctx.lineWidth = 5;
      ctx.stroke();
    }
  }

  private drawStartLine(input: SceneInput): void {
    const { ctx } = this;
    const { geom, camera, localTrackDistance } = input;
    const lap = Math.floor(localTrackDistance / geom.length);
    const half = geom.trackWidth / 2;

    for (const lineS of [(lap + 1) * geom.length, lap * geom.length]) {
      const ahead = lineS - localTrackDistance;
      if (ahead < -60 || ahead > CAMERA.DRAW_DISTANCE) continue;
      const pt = geom.pointAt(lineS);
      const nx = -Math.sin(pt.heading);
      const ny = Math.cos(pt.heading);
      const a = camera.project(pt.x - nx * half, pt.y - ny * half);
      const b = camera.project(pt.x + nx * half, pt.y + ny * half);
      if (!a.visible || !b.visible) continue;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.setLineDash([14, 10]);
      ctx.lineWidth = Math.max(3, 10 * a.scale);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Obstacles and racers share one depth-sorted pass so they occlude correctly. */
  private drawObstaclesAndRacers(input: SceneInput): void {
    const { camera, geom } = input;
    type Item = { z: number; draw: () => void };
    const items: Item[] = [];

    for (const ob of geom.obstaclesInRange(input.localTrackDistance, CAMERA.DRAW_DISTANCE)) {
      const z = camera.depthOf(ob.x, ob.y);
      if (z < CAMERA.Z_NEAR) continue;
      items.push({ z, draw: () => this.drawObstacle(ob, camera) });
    }

    for (const r of input.racers) {
      const z = camera.depthOf(r.x, r.y);
      if (z < CAMERA.Z_NEAR || z > CAMERA.DRAW_DISTANCE) continue;
      items.push({ z, draw: () => this.drawRacer(r, camera) });
    }

    items.sort((a, b) => b.z - a.z); // painter's algorithm: far to near
    for (const it of items) it.draw();
  }

  private drawObstacle(ob: Obstacle, camera: WindshieldCamera): void {
    const { ctx } = this;
    const base = camera.project(ob.x, ob.y);
    if (!base.visible) return;
    const [rx, ry] = this.groundEllipse(base, ob.r);
    if (rx < 0.6) return;

    if (ob.type === 'oil') {
      ctx.save();
      const g = ctx.createRadialGradient(base.x, base.y, 0, base.x, base.y, Math.max(rx, 1));
      g.addColorStop(0, 'rgba(150, 90, 220, 0.72)');
      g.addColorStop(0.6, 'rgba(60, 30, 110, 0.66)');
      g.addColorStop(1, 'rgba(20, 10, 40, 0.30)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(base.x, base.y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(200, 160, 255, 0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      return;
    }

    // Cones and gate posts are solid objects: shadow on the ground, body above it.
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(base.x, base.y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    if (ob.type === 'cone') {
      const h = 46 * base.scale;
      ctx.beginPath();
      ctx.moveTo(base.x - rx, base.y);
      ctx.lineTo(base.x, base.y - h);
      ctx.lineTo(base.x + rx, base.y);
      ctx.closePath();
      ctx.fillStyle = '#ff7a1a';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 2;
      ctx.stroke();
      if (h > 14) {
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.fillRect(base.x - rx * 0.55, base.y - h * 0.56, rx * 1.1, h * 0.16);
      }
    } else {
      const h = 80 * base.scale;
      ctx.fillStyle = '#fde047';
      ctx.fillRect(base.x - rx, base.y - h, rx * 2, h);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(base.x - rx, base.y - h, rx * 2, h);
      // Hazard banding, only while it is big enough to read.
      if (h > 20) {
        ctx.fillStyle = 'rgba(0,0,0,0.78)';
        for (let i = 0; i < 3; i++) {
          ctx.fillRect(base.x - rx, base.y - h + (h / 3) * i + h * 0.06, rx * 2, h * 0.12);
        }
      }
    }
    ctx.restore();
  }

  private drawRacer(r: RacerState, camera: WindshieldCamera): void {
    const { ctx } = this;
    const color = RACER_COLORS[r.colorIndex % RACER_COLORS.length];
    const hw = TUNING.CAR_WIDTH / 2;
    const hl = TUNING.CAR_LENGTH / 2;
    const cos = Math.cos(r.heading);
    const sin = Math.sin(r.heading);

    // Project the car's four ground corners so it sits correctly in perspective.
    // Order: front-left, front-right, rear-right, rear-left.
    const corners: ProjectedPoint[] = [];
    for (const [f, s] of [[hl, -hw], [hl, hw], [-hl, hw], [-hl, -hw]] as [number, number][]) {
      const wx = r.x + cos * f - sin * s;
      const wy = r.y + sin * f + cos * s;
      const p = camera.project(wx, wy);
      if (!p.visible) return;
      corners.push(p);
    }

    const bodyH = 26 * corners[0].scale;
    ctx.save();

    // Ground shadow, drawn flat on the road under the car.
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();

    const sprite = getSprite(r.colorIndex, r.carShape);
    if (sprite) {
      this.drawSpriteInQuad(sprite, corners, bodyH, r);
    } else {
      this.drawVectorCar(corners, bodyH, color, r);
    }

    if (r.isLocalPlayer) {
      // The player's own car has to be findable at a glance while they are
      // concentrating on their hands: a ring on the road beneath it.
      const gx = (corners[0].x + corners[2].x) / 2;
      const gy = (corners[0].y + corners[2].y) / 2;
      ctx.beginPath();
      ctx.ellipse(
        gx, gy,
        TUNING.CAR_LENGTH * corners[0].scale * 0.95,
        TUNING.CAR_LENGTH * corners[0].scale * 0.95 * (CAMERA.HEIGHT / corners[0].z),
        0, 0, Math.PI * 2,
      );
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Name tag, only when the car is close enough for it to be legible.
    if (corners[0].scale > 0.5 && !r.isLocalPlayer) {
      const cx = (corners[0].x + corners[2].x) / 2;
      const cy = Math.min(...corners.map((c) => c.y)) - bodyH - 10;
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(r.displayName, cx, cy);
      ctx.fillStyle = color;
      ctx.fillText(r.displayName, cx, cy);
    }
    ctx.restore();
  }

  /**
   * Maps a top-down sprite onto the car's projected ground quad.
   *
   * Canvas 2D only does affine transforms, so this uses three corners and accepts
   * the small error versus a true perspective divide - at the size a car occupies
   * on screen the difference is invisible.
   */
  private drawSpriteInQuad(
    sprite: { img: HTMLImageElement; width: number; height: number },
    corners: ProjectedPoint[],
    lift: number,
    r: RacerState,
  ): void {
    const { ctx } = this;
    // Lift the body off the road so it does not read as a flat decal.
    const fl = { x: corners[0].x, y: corners[0].y - lift };
    const fr = { x: corners[1].x, y: corners[1].y - lift };
    const rl = { x: corners[3].x, y: corners[3].y - lift };

    // Sprite v=0 is the nose, so image-top maps to the car's front edge.
    const a = (fr.x - fl.x) / sprite.width;
    const b = (fr.y - fl.y) / sprite.width;
    const c = (rl.x - fl.x) / sprite.height;
    const d = (rl.y - fl.y) / sprite.height;

    if (!isFinite(a + b + c + d) || Math.abs(a * d - b * c) < 1e-9) return;

    ctx.save();
    ctx.globalAlpha = r.isLocalPlayer ? 1 : r.source === 'ghost' ? 0.62 : 0.9;
    ctx.transform(a, b, c, d, fl.x, fl.y);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sprite.img, 0, 0, sprite.width, sprite.height);
    ctx.restore();
  }

  /** Fallback body, used when a sprite failed to load. */
  private drawVectorCar(
    corners: ProjectedPoint[],
    bodyH: number,
    color: string,
    r: RacerState,
  ): void {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y - bodyH);
    for (let i = 1; i < 4; i++) ctx.lineTo(corners[i].x, corners[i].y - bodyH);
    ctx.closePath();
    ctx.globalAlpha = r.isLocalPlayer ? 1 : r.source === 'ghost' ? 0.52 : 0.85;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = r.isLocalPlayer ? '#ffffff' : 'rgba(0,0,0,0.8)';
    ctx.lineWidth = r.isLocalPlayer ? 3 : 2;
    ctx.stroke();
  }

  /**
   * Fades the scene out toward the bottom of the viewport so the player's real
   * hands stay visible through it. This is what resolves the layout conflict
   * between the track and the hands competing for the same pixels.
   */
  private fadeBottom(camera: WindshieldCamera): void {
    const { ctx } = this;
    const top = camera.height * 0.62;
    const bottom = camera.height * 0.9;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, top, camera.width, camera.height - top);
    ctx.restore();
  }
}
