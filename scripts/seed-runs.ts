/**
 * Seeds the database with varied synthetic runs so matchmaking has something to
 * work with from the very first player of the day.
 *
 * These are not hand-faked paths: each run is produced by driving the REAL
 * physics with a simple lookahead controller at a randomised skill level, so
 * every ghost path is guaranteed to be on-track, collide correctly, and replay
 * exactly like a human run.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { TrackGeometry, mulberry32 } from '../client/src/game/track';
import { TUNING, createCar, stepCar, avgSteeringMagnitude, type StepEvent } from '../client/src/game/physics';
import { GhostRecorder } from '../client/src/game/ghost';
import { angleDelta, clamp } from '../client/src/util/math';
import type { Run, TrackDef } from '../shared/types';

const NAMES = [
  'Alex', 'Priya', 'Jonas', 'Mei', 'Tariq', 'Sofia', 'Ade', 'Yuki', 'Luca', 'Nina',
  'Omar', 'Freya', 'Diego', 'Ines', 'Kwame', 'Lena', 'Ravi', 'Clara', 'Milo', 'Zara',
  'Theo', 'Anya', 'Sam', 'Noor', 'Bruno', 'Elif', 'Kai', 'Rosa',
];

interface Skill {
  lookahead: number; // metres ahead the driver aims
  noise: number;     // hand tremor
  bias: number;      // preferred lateral offset (racing line)
  lag: number;       // reaction smoothing, 0..1
  avoid: number;     // 0..1, how well they spot and dodge obstacles
}

/** Obstacles in track-relative coordinates, for the avoidance controller. */
function obstacleTable(geom: TrackGeometry) {
  return geom.obstacles.map((ob) => {
    const proj = geom.project(ob.x, ob.y);
    return { s: proj.s, d: proj.d, r: ob.r, oil: ob.type === 'oil' };
  });
}

function simulate(geom: TrackGeometry, skill: Skill, seed: number): Omit<Run, '_id' | 'createdAt'> | null {
  const car = createCar(geom);
  const recorder = new GhostRecorder(TUNING.GHOST_RECORD_HZ, TUNING.GHOST_STORE_HZ);
  const events: StepEvent[] = [];
  const dt = 1 / 60;
  let t = 0;
  let steer = 0;
  let rng = seed;
  const rand = () => {
    rng = (rng * 1664525 + 1013904223) % 4294967296;
    return rng / 4294967296 - 0.5;
  };

  const sectorTimes: number[] = [];
  let nextSector = 0;
  const obstacles = obstacleTable(geom);
  const halfTrack = geom.trackWidth / 2;

  while (car.trackDistance < geom.length * TUNING.LAPS && t < 900) {
    // Choose a lateral line by scoring candidates across the track width, rather
    // than nudging away from one obstacle at a time - sequential nudging walks
    // straight from one cone of a cluster into the next.
    const carS = ((car.trackDistance % geom.length) + geom.length) % geom.length;
    const margin = halfTrack - TUNING.CAR_WIDTH / 2 - 0.6;
    const window = skill.lookahead + 14;

    const relevant = obstacles.filter((ob) => {
      if (ob.oil) return false; // oil costs no time, so nobody bothers dodging it
      let ahead = ob.s - carS;
      if (ahead < -geom.length / 2) ahead += geom.length;
      if (ahead > geom.length / 2) ahead -= geom.length;
      return ahead > -1.5 && ahead < window;
    });

    let bestD = skill.bias;
    let bestScore = -Infinity;
    for (let cand = -margin; cand <= margin; cand += 0.5) {
      let clearance = Infinity;
      for (const ob of relevant) {
        const need = ob.r + TUNING.CAR_WIDTH / 2;
        clearance = Math.min(clearance, Math.abs(cand - ob.d) - need);
      }
      // Reward clearance, but prefer staying near the habitual line and not
      // swerving hard from where the car already is.
      const score =
        Math.min(clearance, 5) * 3 -
        Math.abs(cand - skill.bias) * 0.25 -
        Math.abs(cand - car.lateralOffset) * 0.55;
      if (score > bestScore) {
        bestScore = score;
        bestD = cand;
      }
    }
    const lateral = skill.bias + (bestD - skill.bias) * skill.avoid;

    // Aim at a point ahead on the centerline, offset onto the chosen line.
    const target = geom.pointAt(car.trackDistance + skill.lookahead);
    const right = geom.rightAt(car.trackDistance + skill.lookahead);
    const tx = target.x + right.x * lateral;
    const ty = target.y + right.y * lateral;
    const desired = Math.atan2(ty - car.y, tx - car.x);
    const yaw = 2 * TUNING.BASE_SPEED * car.collisionPenalty * Math.sin(angleDelta(desired, car.heading)) / skill.lookahead;
    const shaped = clamp(yaw / TUNING.MAX_TURN_RATE, -1, 1);
    const cmd = clamp(Math.sign(shaped) * Math.pow(Math.abs(shaped), 1 / TUNING.STEER_GAMMA) + rand() * skill.noise, -1, 1);
    steer += (cmd - steer) * skill.lag;

    events.length = 0;
    stepCar(car, geom, { steer, dt, now: t }, events);
    t += dt;
    recorder.capture(t, car.x, car.y, car.heading);

    while (nextSector < geom.sectorBoundaries.length * TUNING.LAPS && car.trackDistance >= geom.sectorEndAt(nextSector)) {
      sectorTimes.push(t - sectorTimes.reduce((a, b) => a + b, 0));
      nextSector++;
    }
  }

  if (car.trackDistance < geom.length * TUNING.LAPS) return null; // driver never finished
  if (sectorTimes.length < geom.sectorBoundaries.length * TUNING.LAPS) {
    sectorTimes.push(t - sectorTimes.reduce((a, b) => a + b, 0));
  }

  return {
    trackId: geom.def.id,
    playerName: '',
    totalTime: +t.toFixed(3),
    sectorTimes: sectorTimes.map((s) => +s.toFixed(3)),
    collisionCount: car.collisionCount,
    offTrackDuration: +car.offTrackDuration.toFixed(2),
    avgSteeringMagnitude: +avgSteeringMagnitude(car).toFixed(3),
    path: recorder.finish(),
    synthetic: true,
  };
}

async function main(): Promise<void> {
  const trackFile = process.env.TRACK ?? 'client/public/tracks/circuit-01.json';
  const base = process.env.API_BASE ?? 'http://localhost:8787';
  const count = Number(process.env.COUNT ?? 24);

  const def = JSON.parse(readFileSync(trackFile, 'utf8')) as TrackDef;
  const geom = new TrackGeometry(def);

  const runs: Omit<Run, '_id' | 'createdAt'>[] = [];
  let attempts = 0;
  const rand = mulberry32(2026);
  while (runs.length < count && attempts < count * 8) {
    attempts++;
    const i = runs.length;
    // Spread skill across a realistic range so matchmaking has near neighbours
    // at every pace, not a cluster of aliens and a cluster of crashers.
    // q = 0 is a first-timer flailing at an invisible wheel; q = 1 has clearly
    // done this all afternoon. Everything in between is what matchmaking needs.
    const q = i / Math.max(1, count - 1);
    const skill: Skill = {
      lookahead: 3 + q * 2 + rand(),
      noise: 0.08 - q * 0.06 + rand() * 0.01,
      bias: (rand() - 0.5) * 9 * (1 - q * 0.6),
      lag: 0.3 + q * 0.3,
      avoid: Math.min(1, 0.2 + q * 0.8 + rand() * 0.1),
    };
    const run = simulate(geom, skill, 1000 + attempts * 7919);
    if (!run || run.collisionCount > 5 || run.totalTime > geom.length * TUNING.LAPS / TUNING.BASE_SPEED * 1.35) continue;
    run.playerName = NAMES[runs.length % NAMES.length];
    runs.push(run);
  }

  if (runs.length !== count) throw new Error(`Only ${runs.length}/${count} drivers finished`);
  runs.sort((a, b) => a.totalTime - b.totalTime);
  console.log(`simulated ${runs.length} runs`);
  console.log(`  fastest ${runs[0].totalTime.toFixed(2)}s  slowest ${runs[runs.length - 1].totalTime.toFixed(2)}s`);
  console.log(`  median  ${runs[Math.floor(runs.length / 2)].totalTime.toFixed(2)}s`);
  console.log(`  avg path samples ${Math.round(runs.reduce((a, r) => a + r.path.length, 0) / runs.length)}`);

  console.log(`  collisions ${runs.map(r => r.collisionCount).join(', ')}`);
  console.log(`  off-track seconds ${runs.map(r => r.offTrackDuration).join(', ')}`);
  if (process.env.SEED_OUTPUT) writeFileSync(process.env.SEED_OUTPUT, JSON.stringify(runs));
  if (process.env.SEED_DRY_RUN === '1') return;

  let ok = 0;
  for (const run of runs) {
    const res = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run),
    });
    if (res.ok) ok++;
    else console.warn(`  ! failed to post ${run.playerName}: ${res.status}`);
  }
  console.log(`seeded ${ok}/${runs.length} runs to ${base}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
