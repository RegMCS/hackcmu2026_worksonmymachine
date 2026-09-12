/**
 * End-to-end input-to-render latency.
 *
 * The honest measurement is photon-to-photon: when the camera sensor captured the
 * frame, to when our rendered reaction to it reaches the screen.
 *
 *   latency = presentTime(our rendered frame) - captureTime(the frame we inferred on)
 *
 * `captureTime` comes from requestVideoFrameCallback metadata and, per the spec, is
 * the camera capture time for local sources. It is not populated everywhere, so we
 * fall back to `presentationTime` (when the browser submitted the video frame) and
 * flag the number as degraded rather than quietly reporting a different quantity.
 */
export type LatencyQuality = 'capture' | 'presentation' | 'unavailable';

export interface PendingSample {
  captureTime: number;
  quality: LatencyQuality;
  inferenceMs: number;
}

export class LatencyMonitor {
  quality: LatencyQuality = 'unavailable';
  lastMs = 0;
  inferenceMs = 0;
  private samples: number[] = [];
  private pending: PendingSample | null = null;

  /** Called from requestVideoFrameCallback with that frame's metadata. */
  frameCaptured(now: number, metadata: VideoFrameCallbackMetadata | undefined): PendingSample {
    let captureTime = now;
    let quality: LatencyQuality = 'unavailable';
    const m = metadata as (VideoFrameCallbackMetadata & { captureTime?: number }) | undefined;
    if (m && typeof m.captureTime === 'number' && m.captureTime > 0) {
      captureTime = m.captureTime;
      quality = 'capture';
    } else if (m && typeof m.presentationTime === 'number' && m.presentationTime > 0) {
      captureTime = m.presentationTime;
      quality = 'presentation';
    }
    this.quality = quality;
    return { captureTime, quality, inferenceMs: 0 };
  }

  /** The render loop drew using this sample; we are waiting for it to be presented. */
  renderSubmitted(sample: PendingSample): void {
    this.pending = sample;
  }

  /**
   * Called at the top of the next animation frame. The rAF timestamp approximates
   * when the frame we just drew was presented.
   */
  framePresented(rafTimestamp: number): void {
    if (!this.pending) return;
    const ms = rafTimestamp - this.pending.captureTime;
    this.inferenceMs = this.pending.inferenceMs;
    this.pending = null;
    if (ms < 0 || ms > 1000) return; // clock mismatch; do not pollute the average
    this.lastMs = ms;
    this.samples.push(ms);
    if (this.samples.length > 90) this.samples.shift();
  }

  get p50(): number {
    if (!this.samples.length) return 0;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  }

  get p95(): number {
    if (!this.samples.length) return 0;
    const s = [...this.samples].sort((a, b) => a - b);
    return s[Math.floor(s.length * 0.95)];
  }

  get label(): string {
    if (this.quality === 'capture') return 'photon-to-photon';
    if (this.quality === 'presentation') return 'pipeline (no captureTime)';
    return 'unavailable';
  }
}
