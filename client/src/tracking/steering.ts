import { OneEuroFilter } from './oneEuro';
import { TUNING } from '../game/physics';
import { clamp, wrapAngle } from '../util/math';
import type { TrackingFrame } from './hands';

export type SteeringMode = 'hands' | 'keyboard';

export class SteeringController {
  mode: SteeringMode = 'hands';
  neutralAngle = 0;
  calibrated = false;
  /**
   * Hand rotation that counts as full lock, from the sensitivity slider. The
   * slider widens this as well as softening the curve - see steerFeelFor().
   */
  fullLockDeg: number = TUNING.FULL_LOCK_DEG;

  /** Unsmoothed steering, for the debug overlay. */
  raw = 0;
  /** What the car actually uses. */
  value = 0;
  handsVisible = false;
  /** Seconds since we last saw two hands; drives the wheel fade. */
  secondsSinceHands = 0;

  private filter = new OneEuroFilter(
    TUNING.ONE_EURO_MIN_CUTOFF,
    TUNING.ONE_EURO_BETA,
    TUNING.ONE_EURO_D_CUTOFF,
  );
  private keyLeft = false;
  private keyRight = false;
  private keyValue = 0;

  attachKeyboard(target: Window = window): () => void {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') this.keyLeft = true;
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') this.keyRight = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') this.keyLeft = false;
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') this.keyRight = false;
    };
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
    };
  }

  calibrate(angle: number): void {
    this.neutralAngle = angle;
    this.calibrated = true;
    this.filter.reset();
  }

  reset(): void {
    this.raw = 0;
    this.value = 0;
    this.keyValue = 0;
    this.filter.reset();
  }

  /** Returns the steering value the car should use this frame, in [-1, 1]. */
  update(frame: TrackingFrame | null, timeSec: number, dt: number): number {
    if (this.mode === 'keyboard') {
      const target = (this.keyRight ? 1 : 0) - (this.keyLeft ? 1 : 0);
      // Ramp so keyboard input is comparably coarse to hand input.
      const rate = target === 0 ? 6 : 4;
      this.keyValue += clamp(target - this.keyValue, -rate * dt, rate * dt);
      this.raw = this.keyValue;
      this.value = this.keyValue;
      this.handsVisible = false;
      return this.value;
    }

    const twoHands = !!frame && frame.handCount >= 2 && frame.rawAngle !== null;
    this.handsVisible = twoHands;

    if (!twoHands) {
      // Hold the last known steering value. Snapping to centre here would cause
      // sudden crashes at exactly the moment tracking is already struggling.
      this.secondsSinceHands += dt;
      return this.value;
    }

    this.secondsSinceHands = 0;
    const rel = wrapAngle(frame!.rawAngle! - this.neutralAngle);
    const full = (this.fullLockDeg * Math.PI) / 180;
    this.raw = clamp(rel / full, -1, 1);
    this.value = clamp(this.filter.filter(this.raw, timeSec), -1, 1);
    return this.value;
  }
}

/**
 * Calibration gate. Requires two hands held stably for HOLD_SEC before it will
 * accept a neutral angle - this catches tracking failures before the race rather
 * than during it.
 */
export class Calibrator {
  static readonly HOLD_SEC = 2;
  private accum = 0;
  private angles: number[] = [];

  progress = 0;
  message = 'Hold your hands up like a steering wheel';
  ready = false;

  reset(): void {
    this.accum = 0;
    this.angles = [];
    this.progress = 0;
    this.ready = false;
    this.message = 'Hold your hands up like a steering wheel';
  }

  /** Returns the captured neutral angle once calibration completes. */
  update(frame: TrackingFrame | null, dt: number): number | null {
    const ok = !!frame && frame.handCount >= 2 && frame.rawAngle !== null;
    if (!ok) {
      // Reject and re-prompt rather than calibrating off a bad detection.
      this.accum = 0;
      this.angles = [];
      this.progress = 0;
      this.message = frame && frame.handCount === 1
        ? 'Show both hands'
        : 'Hold your hands up like a steering wheel';
      return null;
    }

    this.angles.push(frame!.rawAngle!);
    if (this.angles.length > 120) this.angles.shift();

    // Reject if the hands are not actually being held still.
    const spread = this.angleSpread();
    if (spread > 0.35) {
      this.accum = 0;
      this.progress = 0;
      this.message = 'Hold steady...';
      return null;
    }

    this.accum += dt;
    this.progress = Math.min(1, this.accum / Calibrator.HOLD_SEC);
    this.message = 'Hold it...';

    if (this.accum >= Calibrator.HOLD_SEC) {
      this.ready = true;
      const sorted = [...this.angles].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]; // median is robust to spikes
    }
    return null;
  }

  private angleSpread(): number {
    if (this.angles.length < 4) return 0;
    const recent = this.angles.slice(-30);
    return Math.max(...recent) - Math.min(...recent);
  }
}
