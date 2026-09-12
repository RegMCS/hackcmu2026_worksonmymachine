import type { PathSample, RacerState, Run } from '../../../shared/types';
import type { TrackGeometry } from './track';
import { TUNING } from './physics';
import { lerp, lerpAngle } from '../util/math';

/**
 * Replays a recorded run. Ghosts are purely visual - they never collide with
 * anything, including each other.
 */
export class GhostPlayer {
  readonly id: string;
  readonly displayName: string;
  readonly run: Run;
  private path: PathSample[];
  private cursor = 0;
  private distances: number[] = [];

  constructor(
    run: Run,
    private geom: TrackGeometry,
    readonly colorIndex: number,
    readonly carShape: number,
  ) {
    this.run = run;
    this.id = run._id ?? `ghost-${Math.random().toString(36).slice(2)}`;
    this.displayName = run.playerName;
    this.path = run.path ?? [];
    // Precompute from every sample: matchmaking can seek directly into lap 3.
    let distance = 0, previous = 0, segment = 0;
    for (const p of this.path) {
      const proj = geom.project(p.x, p.y, segment);
      segment = proj.segmentIndex;
      let delta = proj.s - previous;
      // Unwrap a lap rollover into forward progress. An open course never rolls
      // over, and unwrapping there would turn ordinary backtracking into a
      // phantom lap.
      if (geom.closed) {
        if (delta > geom.length / 2) delta -= geom.length;
        if (delta < -geom.length / 2) delta += geom.length;
      }
      distance += delta;
      previous = proj.s;
      this.distances.push(distance);
    }
  }

  get totalTime(): number {
    return this.run.totalTime;
  }

  reset(): void {
    this.cursor = 0;

  }

  /** Interpolated state at race time `t`. Returns null if the path is unusable. */
  sample(t: number): RacerState | null {
    if (this.path.length === 0) return null;

    if (t < this.path[this.cursor].t) this.cursor = 0;
    // Normal playback stays O(1) per frame; backward seeks restart the cursor.
    while (this.cursor < this.path.length - 2 && this.path[this.cursor + 1].t <= t) this.cursor++;

    const a = this.path[this.cursor];
    const b = this.path[Math.min(this.cursor + 1, this.path.length - 1)];
    const span = b.t - a.t;
    const f = span > 1e-6 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;

    const x = lerp(a.x, b.x, f);
    const y = lerp(a.y, b.y, f);
    const heading = lerpAngle(a.heading, b.heading, f);

    const trackDistance = lerp(this.distances[this.cursor], this.distances[Math.min(this.cursor + 1, this.path.length - 1)], f);

    const finished = t >= this.run.totalTime;

    return {
      id: this.id,
      displayName: this.displayName,
      x,
      y,
      heading,
      trackDistance: finished ? this.geom.length * this.geom.laps : trackDistance,
      lapProgress: finished ? 1 : Math.min(1, Math.max(0, (this.geom.closed ? ((trackDistance % this.geom.length) + this.geom.length) % this.geom.length : trackDistance) / this.geom.length)),
      isLocalPlayer: false,
      source: 'ghost',
      finished,
      finishTime: finished ? this.run.totalTime : undefined,
      colorIndex: this.colorIndex,
      carShape: this.carShape,
    };
  }
}

/** Records the local run at a fixed rate, then downsamples for storage. */
export class GhostRecorder {
  private samples: PathSample[] = [];
  private nextAt = 0;

  constructor(private recordHz: number, private storeHz: number) {}

  reset(): void {
    this.samples = [];
    this.nextAt = 0;
  }

  capture(t: number, x: number, y: number, heading: number): void {
    if (t < this.nextAt) return;
    // Snap to an absolute time grid. Advancing by `t + 1/hz` looks equivalent but
    // compounds the float error in an accumulating clock, which silently drops
    // roughly one sample in eight.
    this.nextAt = (Math.floor(t * this.recordHz) + 1) / this.recordHz;
    this.samples.push({ t: +t.toFixed(3), x: +x.toFixed(3), y: +y.toFixed(3), heading: +heading.toFixed(3) });
  }

  /**
   * Downsampled path for persistence. Recording at 30Hz and storing at 15Hz keeps
   * documents small - which matters for both the 512MB free tier and for how fast
   * the leaderboard and matchmaking queries come back.
   */
  finish(): PathSample[] {
    if (this.storeHz >= this.recordHz) return this.samples;
    const stride = Math.round(this.recordHz / this.storeHz);
    const out: PathSample[] = [];
    for (let i = 0; i < this.samples.length; i += stride) out.push(this.samples[i]);
    const last = this.samples[this.samples.length - 1];
    if (last && out[out.length - 1] !== last) out.push(last);
    return out;
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}
