/**
 * Windshield projection.
 *
 * The world model is strictly 2D top-down - physics, collision, trackDistance,
 * ghosts and the minimap all operate in world coordinates. This module is the ONLY
 * place that knows about the windshield, and it is applied at draw time. Keeping
 * that boundary clean is what stops view maths from contaminating game state.
 *
 * It is a plain pinhole projection of the ground plane: no 3D engine, just a
 * divide by depth.
 */

export const CAMERA = {
  /**
   * How far behind the car the virtual eye sits, in world px.
   *
   * Far enough back that the player's own car is drawn on screen ahead of the
   * camera. A true windshield view (eye at the car) reads as first-person and
   * leaves the player with nothing to identify as "me".
   */
  BEHIND: 290,
  /** Eye height above the road surface, in world px. */
  HEIGHT: 155,
  /** Focal length. Larger = narrower field of view = flatter, longer road. */
  FOCAL: 760,
  /** Anything closer than this in depth is behind the windshield. */
  Z_NEAR: 62,
  /** How far up the viewport the horizon sits, as a fraction of height. */
  HORIZON: 0.15,
  /** Where the player's car lands vertically, as a fraction of height. Derived
   *  from BEHIND/HEIGHT/FOCAL - kept here so it can be asserted in a test. */
  PLAYER_Y_HINT: 0.52,
  /** How far ahead along the track we bother drawing, in world px. */
  DRAW_DISTANCE: 2400,
} as const;

export interface ProjectedPoint {
  x: number;
  y: number;
  z: number; // depth; useful for painter's-algorithm sorting and scaling
  scale: number; // px per world px at this depth
  visible: boolean;
}

export class WindshieldCamera {
  private originX = 0;
  private originY = 0;
  private cosH = 1;
  private sinH = 0;
  width = 0;
  height = 0;
  horizonY = 0;
  shakeX = 0;
  shakeY = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.horizonY = height * CAMERA.HORIZON;
  }

  /** Places the eye behind `heading`-facing car at (x, y). */
  setView(x: number, y: number, heading: number): void {
    this.cosH = Math.cos(heading);
    this.sinH = Math.sin(heading);
    this.originX = x - this.cosH * CAMERA.BEHIND;
    this.originY = y - this.sinH * CAMERA.BEHIND;
  }

  project(wx: number, wy: number): ProjectedPoint {
    const relX = wx - this.originX;
    const relY = wy - this.originY;
    // Rotate into camera space: +z forward, +x right of travel.
    const z = relX * this.cosH + relY * this.sinH;
    const x = -relX * this.sinH + relY * this.cosH;

    if (z < CAMERA.Z_NEAR) {
      return { x: 0, y: 0, z, scale: 0, visible: false };
    }
    const scale = CAMERA.FOCAL / z;
    return {
      x: this.width / 2 + x * scale + this.shakeX,
      y: this.horizonY + CAMERA.HEIGHT * scale + this.shakeY,
      z,
      scale,
      visible: true,
    };
  }

  /** Depth of a world point without doing the full projection. */
  depthOf(wx: number, wy: number): number {
    return (wx - this.originX) * this.cosH + (wy - this.originY) * this.sinH;
  }
}
