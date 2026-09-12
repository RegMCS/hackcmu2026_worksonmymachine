import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TrackGeometry } from '../../client/src/game/track';
import { GhostPlayer } from '../../client/src/game/ghost';
import { Race, DistanceTimeCurve } from '../../client/src/game/race';
import { RacerManager } from '../../client/src/game/racers';
import { TUNING } from '../../client/src/game/physics';
import type { Run } from '../../shared/types';

const def = JSON.parse(readFileSync('client/public/tracks/circuit-01.json', 'utf8'));
const geom = new TrackGeometry(def);
assert.deepEqual(geom.obstacles, new TrackGeometry(def).obstacles);
assert.notDeepEqual(geom.obstacles, new TrackGeometry(def, 42).obstacles);
assert.equal(new Set(def.sections.map((s: { name: string }) => s.name)).size, 9);
assert.equal(geom.sectionNameAt(0), 'FINISH STRAIGHT');
assert.equal(geom.elevationAt(0), geom.elevationAt(geom.length));
const path = Array.from({ length: 1001 }, (_, i) => {
  const p = geom.pointAt(i / 1000 * geom.length);
  return { t: i / 10, x: p.x, y: p.y, heading: p.heading };
});
const run: Run = { trackId: def.id, playerName: 'Test', createdAt: '', totalTime: 100,
  sectorTimes: [], collisionCount: 0, offTrackDuration: 0, avgSteeringMagnitude: 0, path };
const ghost = new GhostPlayer(run, geom, 0, 1);
for (const t of [83.3, 33.3, 50.1, 99, 10]) {
  const state = ghost.sample(t)!;
  assert.ok(Math.abs(state.trackDistance - t / 100 * geom.length) < 0.1, `seek ${t}`);
  assert.ok(state.lapProgress >= 0 && state.lapProgress < 1);
}
assert.equal(ghost.sample(100)!.trackDistance, geom.length * TUNING.LAPS);
assert.ok(Math.abs(new DistanceTimeCurve(path, geom).timeAt(geom.length * 0.5)! - 50) < 0.01);
const manager = new RacerManager();
const first = { ...ghost.sample(100)!, id: 'first', finishTime: 90 };
const second = { ...first, id: 'second', finishTime: 100 };
const standings = manager.update([second, first], 110);
assert.equal(standings[0].racer.id, 'first');
assert.equal(standings[1].gapLeader, 10);
const crossing = manager.update([{ ...first, finished: false, trackDistance: geom.length + 1 },
  { ...second, finished: false, trackDistance: geom.length - 1 }], 120);
assert.equal(crossing[0].racer.id, 'first');

// Fail-soft networking keeps this race diagnostic independent of the API.
globalThis.fetch = (async () => { throw new Error('offline diagnostic'); }) as typeof fetch;
const race = new Race({ geom, trackId: def.id, playerName: 'Test', colorIndex: 0, carShape: 1 });
race.start();
race.update(TUNING.COUNTDOWN_SEC, 0);
for (let i = 0; i < geom.sectorBoundaries.length * TUNING.LAPS; i++) {
  const distance = geom.sectorEndAt(i) + 0.01;
  const p = geom.pointAt(distance);
  Object.assign(race.car, { x: p.x, y: p.y, heading: p.heading, trackDistance: distance,
    lastSegmentIndex: geom.project(p.x, p.y).segmentIndex });
  race.update(0, 0);
  if (i < geom.sectorBoundaries.length * TUNING.LAPS - 1) assert.equal(race.phase, 'racing');
}
assert.equal(race.phase, 'finished');
assert.equal(race.car.lapCount, TUNING.LAPS);
assert.equal(race.sectorTimes.length, geom.sectorBoundaries.length * TUNING.LAPS);
// One lap, so the only lap call is the run home: the last sector, once.
assert.equal(race.bus.log.filter(e => e.type === 'final_lap').length, 1);
console.log(`PASS: seeded geometry, sections, elevation, ${TUNING.LAPS}-lap sequencing, late/backward ghost seeks, PB curve, standings and events`);
