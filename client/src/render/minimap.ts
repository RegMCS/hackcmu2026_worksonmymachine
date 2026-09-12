import type { RacerState } from '../../../shared/types';
import type { TrackGeometry } from '../game/track';
import { RACER_COLORS } from './scene';

/**
 * Top-down track outline with a dot per racer. Reads only from RacerState, so it
 * cannot tell - and must not care - whether a car is a ghost or a live opponent.
 * Positions only: obstacles are deliberately omitted so it stays glanceable.
 */
export class Minimap {
  private outline: { x: number; y: number }[] = [];
  private scale = 1;
  private ox = 0;
  private oy = 0;

  constructor(
    private ctx: CanvasRenderingContext2D,
    private geom: TrackGeometry,
    private width: number,
    private height: number,
  ) {
    this.computeOutline();
  }

  private computeOutline(): void {
    const b = this.geom.bounds;
    const pad = 10;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    this.scale = Math.min((this.width - pad * 2) / w, (this.height - pad * 2) / h);
    this.ox = pad + (this.width - pad * 2 - w * this.scale) / 2 - b.minX * this.scale;
    this.oy = pad + (this.height - pad * 2 - h * this.scale) / 2 - b.minY * this.scale;

    // Include the end point on an open course; its finish is a real vertex.
    const STEP = this.geom.length / 160;
    const end = this.geom.closed ? this.geom.length : this.geom.length + STEP / 2;
    for (let s = 0; s < end; s += STEP) {
      const p = this.geom.pointAt(s);
      this.outline.push(this.toMap(p.x, p.y));
    }
  }

  private toMap(x: number, y: number): { x: number; y: number } {
    return { x: x * this.scale + this.ox, y: y * this.scale + this.oy };
  }

  render(racers: RacerState[]): void {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);

    // Track ribbon.
    ctx.beginPath();
    ctx.moveTo(this.outline[0].x, this.outline[0].y);
    for (let i = 1; i < this.outline.length; i++) ctx.lineTo(this.outline[i].x, this.outline[i].y);
    if (this.geom.closed) ctx.closePath();
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = Math.max(6, this.geom.trackWidth * this.scale);
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Start/finish.
    const sf = this.geom.pointAt(0);
    const sfp = this.toMap(sf.x, sf.y);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(sfp.x - 3, sfp.y - 3, 6, 6);

    // Racers: local player last and larger, so it is never hidden behind a ghost.
    const sorted = [...racers].sort((a, b) => Number(a.isLocalPlayer) - Number(b.isLocalPlayer));
    for (const r of sorted) {
      const p = this.toMap(r.x, r.y);
      const color = RACER_COLORS[r.colorIndex % RACER_COLORS.length];
      ctx.beginPath();
      ctx.arc(p.x, p.y, r.isLocalPlayer ? 6 : 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (r.isLocalPlayer) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }
  }
}
