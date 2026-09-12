import type { PathSample, RacerState, Run } from '../../../shared/types';
import { TrackGeometry } from './track';
import { TUNING, createCar, stepCar, avgSteeringMagnitude, type CarState, type StepEvent } from './physics';
import { GhostPlayer, GhostRecorder } from './ghost';
import { RacerManager, type Standing } from './racers';
import { EventBus } from './events';
import { api } from '../net/api';

export type RacePhase = 'idle' | 'calibrating' | 'countdown' | 'racing' | 'finished';

/** Maps distance along the track to the time a recorded run reached it. */
export class DistanceTimeCurve {
  private ds: number[] = [];
  private ts: number[] = [];

  constructor(path: PathSample[], geom: TrackGeometry) {
    let dist = 0;
    let seg = 0;
    let prev = 0;
    for (const p of path) {
      const proj = geom.project(p.x, p.y, seg);
      seg = proj.segmentIndex;
      let delta = proj.s - prev;
      if (delta > geom.length / 2) delta -= geom.length;
      if (delta < -geom.length / 2) delta += geom.length;
      dist += delta;
      prev = proj.s;
      if (this.ds.length && dist <= this.ds[this.ds.length - 1]) continue;
      this.ds.push(dist);
      this.ts.push(p.t);
    }
  }

  timeAt(distance: number): number | null {
    const n = this.ds.length;
    if (!n || distance < this.ds[0] || distance > this.ds[n - 1]) return null;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ds[mid] < distance) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return this.ts[0];
    const f = (distance - this.ds[lo - 1]) / (this.ds[lo] - this.ds[lo - 1] || 1);
    return this.ts[lo - 1] + (this.ts[lo] - this.ts[lo - 1]) * f;
  }
}

export interface RaceOptions {
  trackId: string;
  playerName: string;
  geom: TrackGeometry;
  /** The player's chosen car. Ghosts are given the other colours. */
  colorIndex: number;
  carShape: number;
}

const CAR_COLOR_COUNT = 5;
const CAR_SHAPE_COUNT = 5;

/**
 * Gives each ghost a car that is visually distinct from the player's, and stable
 * across restarts so the same rival always looks the same.
 */
function ghostLivery(playerColor: number, index: number): { colorIndex: number; carShape: number } {
  return {
    colorIndex: (playerColor + 1 + index) % CAR_COLOR_COUNT,
    carShape: ((index * 2 + 1) % CAR_SHAPE_COUNT) + 1,
  };
}

export class Race {
  readonly bus = new EventBus();
  readonly geom: TrackGeometry;
  readonly manager = new RacerManager();
  phase: RacePhase = 'idle';
  time = 0;
  countdown: number = TUNING.COUNTDOWN_SEC;
  car: CarState;
  ghosts: GhostPlayer[] = [];
  standings: Standing[] = [];
  sectorTimes: number[] = [];
  rivalName: string | null = null;
  /** The runs matchmaking selected, kept for the results comparison. */
  matchedRuns: Run[] = [];
  personalBest: Run | null = null;
  pbCurve: DistanceTimeCurve | null = null;
  pbDelta: number | null = null;
  shake = 0;
  flash = 0;
  /**
   * The local player's steering curve, from the sensitivity slider. Mutable so
   * a change on the results screen applies to the next race without rebuilding
   * anything. Only ever shapes local input - ghosts and remotes replay recorded
   * world positions, so nobody else's line moves when this changes.
   */
  steerGamma: number = TUNING.STEER_GAMMA;
  savedRunId: string | null = null;
  savedRank: number | null = null;
  /** Resolves once the run has been persisted (or failed to be). */
  savePromise: Promise<void> = Promise.resolve();
  /**
   * Live opponents, supplied by the multiplayer session each frame. Empty when
   * solo. Remotes are visual only — they never collide, same as ghosts.
   */
  remoteStates: RacerState[] = [];

  private recorder = new GhostRecorder(TUNING.GHOST_RECORD_HZ, TUNING.GHOST_STORE_HZ);
  private nextSector = 0;
  private matchmakeDone = false;
  private defaultGhosts: GhostPlayer[] = [];
  private overtaken = new Set<string>();
  private stepEvents: StepEvent[] = [];

  constructor(private opts: RaceOptions) {
    this.geom = opts.geom;
    this.car = createCar(this.geom);
  }

  get playerName(): string {
    return this.opts.playerName;
  }

  /** Loads the default grid: the top ghosts plus the player's own best. */
  async loadGrid(): Promise<void> {
    const [top, best, recent] = await Promise.all([
      api.topGhosts(this.opts.trackId, 3),
      api.personalBest(this.opts.trackId, this.opts.playerName),
      api.mostRecent(this.opts.trackId),
    ]);

    // Top three plus the most recent run - so the person who just handed over
    // the chair is on the grid, which is most of the fun of a queue of judges.
    const grid = [...top];
    if (recent?.path?.length && !grid.some((r) => String(r._id) === String(recent._id))) {
      grid.push(recent);
    }
    this.defaultGhosts = grid.map((r, i) => {
      const livery = ghostLivery(this.opts.colorIndex, i);
      return new GhostPlayer(r, this.geom, livery.colorIndex, livery.carShape);
    });
    this.ghosts = [...this.defaultGhosts];

    if (best?._id) {
      const full = await fetch(`/api/runs/${best._id}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (full?.path?.length) {
        this.personalBest = full;
        this.pbCurve = new DistanceTimeCurve(full.path, this.geom);
      }
    }
  }

  start(): void {
    this.phase = 'countdown';
    this.countdown = TUNING.COUNTDOWN_SEC;
    this.time = 0;
    this.car = createCar(this.geom);
    this.recorder.reset();
    this.manager.reset();
    this.bus.clear();
    this.sectorTimes = [];
    this.nextSector = 0;
    this.matchmakeDone = false;
    this.overtaken.clear();
    this.rivalName = null;
    this.matchedRuns = [];
    this.savedRunId = null;
    this.savedRank = null;
    this.pbDelta = null;
    this.ghosts = [...this.defaultGhosts];
    for (const g of this.ghosts) g.reset();
  }

  /** Advances the race one frame. `steer` is the smoothed steering value. */
  update(dt: number, steer: number): void {
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'racing';
        this.time = 0;
        this.bus.emit('race_start', 0, { driver: this.opts.playerName });
      }
      return;
    }
    if (this.phase !== 'racing') return;

    this.time += dt;
    this.shake = Math.max(0, this.shake - TUNING.SHAKE_DECAY * dt * this.shake);
    this.flash = Math.max(0, this.flash - dt * 3);

    // --- Physics ----------------------------------------------------------
    this.stepEvents.length = 0;
    stepCar(this.car, this.geom, { steer, dt, now: this.time, gamma: this.steerGamma }, this.stepEvents);
    for (const e of this.stepEvents) this.handleStepEvent(e);

    this.recorder.capture(this.time, this.car.x, this.car.y, this.car.heading);

    // --- Sectors ----------------------------------------------------------
    while (
      this.nextSector < this.geom.sectorBoundaries.length * this.geom.laps &&
      this.car.trackDistance >= this.geom.sectorEndAt(this.nextSector)
    ) {
      const idx = this.nextSector;
      const prev = this.sectorTimes.reduce((a, b) => a + b, 0);
      const split = this.time - prev;
      this.sectorTimes.push(split);
      this.nextSector++;
      this.bus.emit('sector_time', this.time, { sector: idx % this.geom.sectorBoundaries.length + 1, lap: Math.floor(idx / this.geom.sectorBoundaries.length) + 1, section: this.geom.sectionNameAt(this.geom.sectorEndAt(idx) - 0.001), split: +split.toFixed(2) });

      if (idx === 0 && !this.matchmakeDone) void this.matchmake(split);
      // A race is one lap, so there is no lap boundary to call. The last
      // sector is still the run home, which is what the phrase bank's
      // final_lap lines were written for.
      const lastSector = this.geom.sectorBoundaries.length * this.geom.laps - 1;
      if (idx === lastSector - 1) this.bus.emit('final_lap', this.time);
    }

    // --- Personal-best delta ---------------------------------------------
    if (this.pbCurve) {
      const pbTime = this.pbCurve.timeAt(this.car.trackDistance);
      this.pbDelta = pbTime === null ? null : this.time - pbTime;
    }

    // --- Standings --------------------------------------------------------
    const racers = this.buildRacerStates();
    this.standings = this.manager.update(racers, this.time);
    this.detectRaceEvents();

    // --- Finish -----------------------------------------------------------
    if (this.car.trackDistance >= this.geom.length * this.geom.laps) {
      this.finish();
    }
  }

  private handleStepEvent(e: StepEvent): void {
    switch (e.type) {
      case 'collision':
        this.shake = TUNING.SHAKE_ON_COLLISION;
        this.flash = 1;
        this.bus.emit('collision', this.time, {
          obstacle: e.obstacleType ?? 'cone',
          total: this.car.collisionCount,
        });
        break;
      case 'oil':
        this.bus.emit('oil', this.time);
        break;
      case 'near_miss':
        this.bus.emit('near_miss', this.time);
        break;
      case 'off_track_enter':
        this.bus.emit('off_track_enter', this.time);
        break;
      case 'off_track_exit':
        this.bus.emit('off_track_exit', this.time);
        break;
    }
  }

  /** Every car on track, as RacerState. This is the only shape the HUD ever sees. */
  buildRacerStates(): RacerState[] {
    const out: RacerState[] = [
      {
        id: 'local',
        displayName: this.opts.playerName,
        x: this.car.x,
        y: this.car.y,
        heading: this.car.heading,
        trackDistance: this.phase === 'finished' ? this.geom.length * this.geom.laps : this.car.trackDistance,
        lapProgress: this.phase === 'finished' ? 1 : ((this.car.trackDistance % this.geom.length) + this.geom.length) % this.geom.length / this.geom.length,
        isLocalPlayer: true,
        source: 'local',
        finished: this.phase === 'finished',
        finishTime: this.phase === 'finished' ? this.time : undefined,
        colorIndex: this.opts.colorIndex,
        carShape: this.opts.carShape,
      },
    ];
    for (const g of this.ghosts) {
      const s = g.sample(this.time);
      if (s) out.push(s);
    }
    // Mixed grid: live players sit in the same array as ghosts. The HUD
    // cannot tell them apart; if it ever needs to, invariant #3 is broken.
    for (const r of this.remoteStates) out.push(r);
    return out;
  }

  private detectRaceEvents(): void {
    const diff = this.manager.diffPositions(this.standings);
    const me = this.standings.find((s) => s.racer.isLocalPlayer);
    if (!me) return;

    if (diff.newLeader === 'local') {
      this.bus.emit('took_lead', this.time, { driver: this.opts.playerName });
    } else if (diff.gained.includes('local')) {
      this.bus.emit('position_gained', this.time, { position: me.position });
    } else if (diff.lost.includes('local')) {
      this.bus.emit('position_lost', this.time, { position: me.position });
    }

    // Overtaking a ghost: we are now ahead of a car we were behind, once only.
    for (const s of this.standings) {
      if (s.racer.isLocalPlayer || s.racer.finished) continue;
      if (this.car.trackDistance > s.racer.trackDistance && !this.overtaken.has(s.racer.id)) {
        this.overtaken.add(s.racer.id);
        this.bus.emit('overtake_ghost', this.time, { passed: s.racer.displayName });
      }
    }

    const battle = this.manager.detectCloseBattle(this.standings, this.time);
    if (battle && (battle.a.isLocalPlayer || battle.b.isLocalPlayer)) {
      const other = battle.a.isLocalPlayer ? battle.b : battle.a;
      this.bus.emit('close_battle', this.time, { rival: other.displayName });
    }
  }

  /**
   * Swaps in pace-matched ghosts at the first sector boundary. The player has no
   * history on their first run, so their finishing time is projected from sector
   * one - that is what makes the race close instead of a 40-second blowout.
   */
  private async matchmake(sectorOneSplit: number): Promise<void> {
    this.matchmakeDone = true;
    const projected = this.personalBest
      ? this.personalBest.totalTime
      : sectorOneSplit * (this.geom.length * this.geom.laps / this.geom.sectorBoundaries[0]);

    const runs = await api.matchmake(this.opts.trackId, projected, this.opts.playerName, 4);
    if (!runs.length) return;
    this.matchedRuns = runs;

    this.ghosts = runs
      .filter((r) => r.path?.length)
      .map((r, i) => {
        const livery = ghostLivery(this.opts.colorIndex, i);
        return new GhostPlayer(r, this.geom, livery.colorIndex, livery.carShape);
      });

    // Fast-forward each matched ghost to where it would be right now.
    for (const g of this.ghosts) g.sample(this.time);

    const closest = runs.reduce((a, b) =>
      Math.abs(a.totalTime - projected) <= Math.abs(b.totalTime - projected) ? a : b,
    );
    this.rivalName = closest.playerName;
    // Name only: a raw delta here reads out as "zero point four gap", which is
    // clumsy spoken aloud. The closeness is the point, not the number.
    this.bus.emit('rival_matched', this.time, { rival: closest.playerName });
  }

  private finish(): void {
    this.phase = 'finished';
    const total = this.time;
    if (this.sectorTimes.length < this.geom.sectorBoundaries.length * this.geom.laps) {
      const prev = this.sectorTimes.reduce((a, b) => a + b, 0);
      this.sectorTimes.push(total - prev);
    }

    const isPB = !this.personalBest || total < this.personalBest.totalTime;
    this.bus.emit('race_finish', total, {
      time: +total.toFixed(2),
      collisions: this.car.collisionCount,
    });
    if (isPB) this.bus.emit('personal_best', total, { time: +total.toFixed(2) });

    this.savePromise = this.save(total);
  }

  private async save(total: number): Promise<void> {
    const res = await api.saveRun({
      trackId: this.opts.trackId,
      playerName: this.opts.playerName,
      totalTime: +total.toFixed(3),
      sectorTimes: this.sectorTimes.map((s) => +s.toFixed(3)),
      collisionCount: this.car.collisionCount,
      offTrackDuration: +this.car.offTrackDuration.toFixed(2),
      avgSteeringMagnitude: +avgSteeringMagnitude(this.car).toFixed(3),
      path: this.recorder.finish(),
    });
    if (res) {
      this.savedRunId = res.id;
      this.savedRank = res.rank;
    }
  }

  get lap(): number {
    return Math.min(this.geom.laps, this.car.lapCount + 1);
  }

  get laps(): number { return this.geom.laps; }

  get sectionName(): string { return this.geom.sectionNameAt(this.car.trackDistance); }

  get oiled(): boolean {
    return this.time < this.car.oilUntil;
  }
}
