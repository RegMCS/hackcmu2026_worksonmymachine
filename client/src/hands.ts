import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';

const MP_VERSION = '0.10.35';
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** Full lock at 60 degrees of wheel rotation. */
const FULL_LOCK = Math.PI / 3;
/** Ignore tiny rotations so a steady wheel means a straight car. */
const DEADZONE = 0.06;
/** Exponential smoothing factor per frame (higher = snappier, more jitter). */
const SMOOTHING = 0.35;

export interface Point { x: number; y: number }

export interface HandState {
  /** Smoothed steering, -1 (full left) .. 1 (full right). */
  steer: number;
  rawSteer: number;
  /** Number of hands currently tracked. */
  hands: number;
  /** True when both hands are closed fists. */
  brake: boolean;
  /** Wrist positions in mirrored normalized coords (0..1), when two hands are visible. */
  wheel: { l: Point; r: Point } | null;
  /** Wrist of the single visible hand. */
  single: Point | null;
}

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private lastTs = -1;
  private ema = 0;
  ready = false;

  state: HandState = { steer: 0, rawSteer: 0, hands: 0, brake: false, wheel: null, single: null };

  constructor(readonly video: HTMLVideoElement) {}

  async init(): Promise<void> {
    if (this.ready) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = stream;
    await new Promise<void>((res) => { this.video.onloadedmetadata = () => res(); });
    await this.video.play();

    const vision = await FilesetResolver.forVisionTasks(WASM_URL);
    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    this.ready = true;
  }

  /** Run one detection on the current video frame and update `state`. Call once per render frame. */
  update(): HandState {
    if (!this.landmarker || this.video.readyState < 2) return this.state;
    const ts = performance.now();
    if (ts <= this.lastTs) return this.state;
    this.lastTs = ts;

    const result = this.landmarker.detectForVideo(this.video, ts);
    const hands = result.landmarks ?? [];

    let raw = 0;
    let wheel: HandState['wheel'] = null;
    let single: Point | null = null;
    let brake = false;

    if (hands.length >= 2) {
      const a = wrist(hands[0]);
      const b = wrist(hands[1]);
      const [l, r] = a.x < b.x ? [a, b] : [b, a];
      wheel = { l, r };
      // Clockwise wheel rotation lifts the left hand and drops the right hand: positive angle = steer right.
      const angle = Math.atan2(r.y - l.y, r.x - l.x);
      raw = applyDeadzone(angle) / FULL_LOCK;
      brake = isOpenPalm(hands[0]) && isOpenPalm(hands[1]);
    } else if (hands.length === 1) {
      single = wrist(hands[0]);
      // One-hand fallback: slide your hand left/right across the frame.
      raw = (single.x - 0.5) * 3;
      brake = isOpenPalm(hands[0]);
    } else {
      raw = 0;
    }

    raw = clamp(raw, -1, 1);
    this.ema += (raw - this.ema) * SMOOTHING;
    if (Math.abs(this.ema) < 0.01) this.ema = 0;

    this.state = { steer: this.ema, rawSteer: raw, hands: hands.length, brake, wheel, single };
    return this.state;
  }

  /** Small JPEG of the current webcam frame (for the commentator's vision input). */
  snapshot(width = 192): string | null {
    if (this.video.readyState < 2) return null;
    const c = document.createElement('canvas');
    c.width = width;
    c.height = Math.round((width * this.video.videoHeight) / this.video.videoWidth) || 144;
    const ctx = c.getContext('2d')!;
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(this.video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.6).split(',')[1];
  }
}

/** Wrist landmark, mirrored so it matches what the user sees. */
function wrist(lm: NormalizedLandmark[]): Point {
  return { x: 1 - lm[0].x, y: lm[0].y };
}

/**
 * Open palm = brake. Gripping a wheel curls the fingers, so a fist can't be the brake gesture;
 * a flat hand with fingers extended is the natural "stop" and looks nothing like a grip.
 */
function isOpenPalm(lm: NormalizedLandmark[]): boolean {
  const w = lm[0];
  const d = (p: NormalizedLandmark) => Math.hypot(p.x - w.x, p.y - w.y);
  // Fingertips (8, 12, 16, 20) clearly farther from the wrist than their PIP joints (6, 10, 14, 18) means extended.
  let extended = 0;
  for (const [tip, pip] of [[8, 6], [12, 10], [16, 14], [20, 18]]) {
    if (d(lm[tip]) > d(lm[pip]) * 1.25) extended++;
  }
  return extended >= 4;
}

function applyDeadzone(v: number): number {
  if (Math.abs(v) < DEADZONE) return 0;
  return v - Math.sign(v) * DEADZONE;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Draw the tracked hands and virtual wheel onto the small overlay canvas. */
export function drawOverlay(canvas: HTMLCanvasElement, s: HandState): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.lineWidth = 3;
  const color = s.hands >= 2 ? '#3dff8a' : s.hands === 1 ? '#ffd23d' : '#ff3b3b';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  if (s.wheel) {
    const l = { x: s.wheel.l.x * W, y: s.wheel.l.y * H };
    const r = { x: s.wheel.r.x * W, y: s.wheel.r.y * H };
    const cx = (l.x + r.x) / 2;
    const cy = (l.y + r.y) / 2;
    const rad = Math.hypot(r.x - l.x, r.y - l.y) / 2;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(l.x, l.y);
    ctx.lineTo(r.x, r.y);
    ctx.stroke();
    for (const p of [l, r]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (s.single) {
    ctx.beginPath();
    ctx.arc(s.single.x * W, s.single.y * H, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  if (s.brake) {
    ctx.fillStyle = '#ff3b3b';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('BRAKE', 8, 24);
  }
}
