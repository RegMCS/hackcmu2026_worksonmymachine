/**
 * One-euro filter. Adaptive low-pass: heavy smoothing when the signal is slow
 * (kills jitter), light smoothing when it moves fast (kills lag).
 *
 * This is the right filter here precisely because over-smoothing costs latency,
 * and latency is the metric we care about most.
 */
export class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;

  constructor(
    private minCutoff: number,
    private beta: number,
    private dCutoff: number,
  ) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(x: number, timestampSec: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = timestampSec;
      return x;
    }
    const dt = Math.max(1e-4, timestampSec - this.tPrev);
    this.tPrev = timestampSec;

    const dx = (x - this.xPrev) / dt;
    const aD = OneEuroFilter.alpha(this.dCutoff, dt);
    this.dxPrev = aD * dx + (1 - aD) * this.dxPrev;

    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev);
    const a = OneEuroFilter.alpha(cutoff, dt);
    const xFiltered = a * x + (1 - a) * this.xPrev;
    this.xPrev = xFiltered;
    return xFiltered;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }
}
