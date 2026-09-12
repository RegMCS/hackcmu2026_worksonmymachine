import type { HandAnchor } from '../tracking/hands';

/**
 * Maps normalized video coordinates to viewport pixels through the same
 * `object-fit: cover` crop the browser applies to the <video> element. Without
 * this the wheel drifts away from the player's actual hands on any aspect ratio
 * that is not an exact match.
 */
export function coverMap(
  nx: number,
  ny: number,
  videoW: number,
  videoH: number,
  screenW: number,
  screenH: number,
): { x: number; y: number } {
  if (!videoW || !videoH) return { x: nx * screenW, y: ny * screenH };
  const videoAspect = videoW / videoH;
  const screenAspect = screenW / screenH;
  let dw: number, dh: number, ox: number, oy: number;
  if (videoAspect > screenAspect) {
    dh = screenH;
    dw = screenH * videoAspect;
    ox = (screenW - dw) / 2;
    oy = 0;
  } else {
    dw = screenW;
    dh = screenW / videoAspect;
    ox = 0;
    oy = (screenH - dh) / 2;
  }
  return { x: ox + nx * dw, y: oy + ny * dh };
}

export interface WheelInput {
  left: HandAnchor | null;
  right: HandAnchor | null;
  /** 0..1 opacity; fades rather than snaps when tracking drops out. */
  opacity: number;
  videoW: number;
  videoH: number;
  oiled: boolean;
}

export interface EffectsInput {
  offTrack: boolean;
  oiled: boolean;
  /** 0..1, decays after a collision. */
  flash: number;
}

export class OverlayRenderer {
  constructor(private ctx: CanvasRenderingContext2D) {}

  clear(w: number, h: number): void {
    this.ctx.clearRect(0, 0, w, h);
  }

  /**
   * The virtual wheel, anchored to the detected hand positions rather than to a
   * fixed screen coordinate. A wheel that materialises in the player's real hands
   * and turns with them is the strongest visual moment in the project, and it
   * doubles as proof to the player that tracking is live.
   */
  drawWheel(input: WheelInput, w: number, h: number): void {
    const { ctx } = this;
    if (!input.left || !input.right || input.opacity <= 0.01) return;

    const a = coverMap(input.left.nx, input.left.ny, input.videoW, input.videoH, w, h);
    const b = coverMap(input.right.nx, input.right.ny, input.videoW, input.videoH, w, h);
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    // Anchored to the hands, but capped so an unusually wide grip cannot let the
    // wheel swallow the track.
    const radius = Math.min(Math.max(60, span * 0.52), Math.min(w, h) * 0.22);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);

    ctx.save();
    ctx.globalAlpha = input.opacity;
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    const rim = Math.max(7, radius * 0.13);
    const accent = input.oiled ? '#c084fc' : '#38bdf8';

    // Rim: dark backing under a bright stroke, so it reads against any background.
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = rim + 7;
    ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.lineWidth = rim;
    ctx.stroke();

    // Spokes.
    ctx.strokeStyle = 'rgba(255,255,255,0.82)';
    ctx.lineWidth = Math.max(3, rim * 0.5);
    for (const sa of [0, Math.PI, -Math.PI / 2]) {
      ctx.beginPath();
      ctx.moveTo(Math.cos(sa) * radius * 0.22, Math.sin(sa) * radius * 0.22);
      ctx.lineTo(Math.cos(sa) * radius * 0.92, Math.sin(sa) * radius * 0.92);
      ctx.stroke();
    }

    // Hub, with a marker so the rotation is legible to spectators.
    ctx.beginPath();
    ctx.arc(0, 0, radius * 0.2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,14,24,0.86)';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, -radius * 0.2);
    ctx.lineTo(0, -radius * 0.62);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(4, rim * 0.6);
    ctx.stroke();
    ctx.restore();

    // Grip markers sitting on the player's actual hands.
    ctx.save();
    ctx.globalAlpha = input.opacity * 0.9;
    for (const p of [a, b]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, rim * 1.25, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawEffects(input: EffectsInput, w: number, h: number): void {
    const { ctx } = this;

    if (input.offTrack) {
      ctx.save();
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.28, w / 2, h / 2, Math.max(w, h) * 0.72);
      g.addColorStop(0, 'rgba(255, 90, 40, 0)');
      g.addColorStop(1, 'rgba(255, 70, 30, 0.30)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    if (input.oiled) {
      ctx.save();
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, 'rgba(160, 90, 240, 0)');
      g.addColorStop(1, 'rgba(150, 70, 240, 0.45)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    if (input.flash > 0.01) {
      ctx.save();
      ctx.fillStyle = `rgba(255, 255, 255, ${input.flash * 0.42})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }
}
