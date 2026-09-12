/**
 * Asserts the hard constraint: a collision must never stop or reverse the player.
 * Drives the car head-on into obstacles and checks forward progress every frame.
 */
import { readFileSync } from 'node:fs';
import { TrackGeometry } from '../../client/src/game/track';
import { TUNING, createCar, stepCar, type StepEvent } from '../../client/src/game/physics';
import type { TrackDef } from '../../shared/types';

const def = JSON.parse(readFileSync('client/public/tracks/circuit-01.json', 'utf8')) as TrackDef;
const geom = new TrackGeometry(def);
const dt = 1 / 60;

let worstForward = Infinity;
let worstDistStep = Infinity;
let collisions = 0;
let maxHeadingJump = 0;

// Aim directly at every solid obstacle in turn and drive into it.
for (const ob of geom.obstacles) {
  if (ob.type === 'oil') continue;
  const car = createCar(geom);
  // Start 10m before the obstacle, pointed straight at it.
  const approach = Math.atan2(ob.y - 0, ob.x - 0);
  car.x = ob.x - Math.cos(approach) * 10;
  car.y = ob.y - Math.sin(approach) * 10;
  car.heading = approach;
  const proj = geom.project(car.x, car.y);
  car.trackDistance = proj.s;
  car.lastSegmentIndex = proj.segmentIndex;

  let t = 0;
  let prevX = car.x;
  let prevY = car.y;
  let prevHeading = car.heading;
  const events: StepEvent[] = [];

  while (t < 3) {
    events.length = 0;
    const fx = Math.cos(car.heading);
    const fy = Math.sin(car.heading);
    stepCar(car, geom, { steer: 0, dt, now: t }, events);
    t += dt;

    // Forward progress measured along the heading the car had entering the frame.
    const moved = (car.x - prevX) * fx + (car.y - prevY) * fy;
    worstForward = Math.min(worstForward, moved / dt);
    worstDistStep = Math.min(worstDistStep, Math.hypot(car.x - prevX, car.y - prevY) / dt);

    let dh = Math.abs(car.heading - prevHeading);
    while (dh > Math.PI) dh = Math.abs(dh - Math.PI * 2);
    maxHeadingJump = Math.max(maxHeadingJump, dh);

    prevX = car.x;
    prevY = car.y;
    prevHeading = car.heading;
    if (t > car.collisionGraceUntil + TUNING.COLLISION_RECOVERY_SEC) {
      if (car.collisionPenalty < 0.99) throw new Error('Collision penalty did not recover');
    }
    collisions += events.filter((e) => e.type === 'collision').length;
  }
}

console.log(`head-on impacts tested : ${collisions}`);
console.log(`min forward speed      : ${worstForward.toFixed(1)} m/s  (must be > 0)`);
console.log(`min total speed        : ${worstDistStep.toFixed(1)} m/s  (must be > 0)`);
console.log(`max heading jump/frame : ${(maxHeadingJump * 180 / Math.PI).toFixed(1)} deg`);
console.log(`base speed             : ${TUNING.BASE_SPEED} m/s`);

const ok = collisions > 0 && worstForward > 0 && worstDistStep > 0;
console.log(ok ? '\nPASS - the player always keeps moving through a collision' : '\nFAIL - a collision stalled or reversed the car');
process.exit(ok ? 0 : 1);
