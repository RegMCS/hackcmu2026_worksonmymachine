import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { LatencyMonitor, type PendingSample } from './latency';

/** A hand reduced to what this game actually needs: one stable anchor point. */
export interface HandAnchor {
  /** Normalized, already mirrored to match the displayed video. 0..1. */
  nx: number;
  ny: number;
}

export interface TrackingFrame {
  handCount: number;
  left: HandAnchor | null;
  right: HandAnchor | null;
  /** Geometric angle of the line between the hands, radians, 0 = level. */
  rawAngle: number | null;
  sample: PendingSample;
}

export type TrackingListener = (frame: TrackingFrame) => void;

const WASM_PATH = '/mediapipe/wasm';
const MODEL_PATH = '/models/hand_landmarker.task';

// Landmark indices in MediaPipe's 21-point hand topology.
const WRIST = 0;
const MIDDLE_MCP = 9;

export class HandTracker {
  readonly latency = new LatencyMonitor();
  handCount = 0;
  lastFrame: TrackingFrame | null = null;
  inferenceMs = 0;
  fps = 0;

  private landmarker: HandLandmarker | null = null;
  private video: HTMLVideoElement;
  private listener: TrackingListener;
  private running = false;
  private lastTs = -1;
  private frameTimes: number[] = [];
  private rvfcHandle = 0;
  private usingFallbackLoop = false;

  constructor(video: HTMLVideoElement, listener: TrackingListener) {
    this.video = video;
    this.listener = listener;
  }

  async init(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleFrame();
  }

  stop(): void {
    this.running = false;
    if (this.rvfcHandle && 'cancelVideoFrameCallback' in this.video) {
      (this.video as any).cancelVideoFrameCallback(this.rvfcHandle);
    }
  }

  private scheduleFrame(): void {
    if (!this.running) return;
    if ('requestVideoFrameCallback' in this.video) {
      this.rvfcHandle = (this.video as any).requestVideoFrameCallback(
        (now: number, metadata: VideoFrameCallbackMetadata) => this.onFrame(now, metadata),
      );
    } else {
      // Firefox has no requestVideoFrameCallback. Fall back to rAF; latency
      // becomes an estimate rather than a measurement, and we say so.
      this.usingFallbackLoop = true;
      requestAnimationFrame((now) => this.onFrame(now, undefined));
    }
  }

  get hasFrameCallback(): boolean {
    return !this.usingFallbackLoop;
  }

  private onFrame(now: number, metadata: VideoFrameCallbackMetadata | undefined): void {
    if (!this.running || !this.landmarker) {
      this.scheduleFrame();
      return;
    }
    const sample = this.latency.frameCaptured(now, metadata);

    // MediaPipe requires strictly increasing timestamps.
    let ts = Math.round(now);
    if (ts <= this.lastTs) ts = this.lastTs + 1;
    this.lastTs = ts;

    let frame: TrackingFrame = { handCount: 0, left: null, right: null, rawAngle: null, sample };

    if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
      const t0 = performance.now();
      try {
        const result = this.landmarker.detectForVideo(this.video, ts);
        this.inferenceMs = performance.now() - t0;
        sample.inferenceMs = this.inferenceMs;
        frame = this.interpret(result, sample);
      } catch {
        // A dropped inference must never take the game down; hold the last value.
        this.inferenceMs = performance.now() - t0;
      }
    }

    this.handCount = frame.handCount;
    this.lastFrame = frame;

    this.frameTimes.push(now);
    while (this.frameTimes.length > 1 && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    this.fps = this.frameTimes.length;

    this.listener(frame);
    this.scheduleFrame();
  }

  private interpret(result: any, sample: PendingSample): TrackingFrame {
    const lms: Array<Array<{ x: number; y: number }>> = result?.landmarks ?? [];
    const anchors: HandAnchor[] = [];

    for (const hand of lms) {
      if (!hand || hand.length <= MIDDLE_MCP) continue;
      const w = hand[WRIST];
      const m = hand[MIDDLE_MCP];
      // Palm centre, not the wrist: far more stable when the hand rotates about
      // the gripping axis, which is exactly the motion this game is built on.
      const cx = (w.x + m.x) / 2;
      const cy = (w.y + m.y) / 2;
      // Mirror X to match the mirrored video. Without this, steering feels inverted.
      anchors.push({ nx: 1 - cx, ny: cy });
    }

    if (anchors.length < 2) {
      return { handCount: anchors.length, left: null, right: null, rawAngle: null, sample };
    }

    // Assign left/right by screen position, never by MediaPipe's handedness -
    // handedness is computed on the unmirrored image and inverts once we mirror.
    anchors.sort((a, b) => a.nx - b.nx);
    const left = anchors[0];
    const right = anchors[anchors.length - 1];

    // Normalized coords are fractions of width and height respectively, so they
    // must be scaled back to pixels before the angle means anything geometric.
    const vw = this.video.videoWidth || 1280;
    const vh = this.video.videoHeight || 720;
    const dx = (right.nx - left.nx) * vw;
    const dy = (right.ny - left.ny) * vh;
    const rawAngle = Math.atan2(dy, dx);

    return { handCount: anchors.length, left, right, rawAngle, sample };
  }
}

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  // getUserMedia is undefined on insecure origins (plain http:// on a LAN IP),
  // which used to throw a raw TypeError. Keyboard play still works.
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'The browser blocks the camera on http:// addresses. Play with arrow keys, or open this page over https://.',
    );
  }

  const attempts: MediaStreamConstraints[] = [
    {
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        // 60fps halves the frame-cadence contribution to end-to-end latency.
        frameRate: { ideal: 60, min: 24 },
        facingMode: 'user',
      },
      audio: false,
    },
    // Phones and some laptops reject the tight frameRate constraint.
    { video: { facingMode: 'user' }, audio: false },
    { video: true, audio: false },
  ];

  let last: unknown;
  for (const opts of attempts) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(opts);
      video.srcObject = stream;
      await video.play();
      return stream;
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error('Camera unavailable');
}
