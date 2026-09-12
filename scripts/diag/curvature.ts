/**
 * Every corner must be takeable. With no brake, a corner tighter than the car's
 * minimum turn radius is impossible rather than merely hard, so this keeps a 2x
 * margin between the tightest corner and what the car can turn.
 *
 * See trackCurvature.ts for why the tightest corner is measured over a car
 * length and not per sample.
 */
import { TUNING } from '../../client/src/game/physics';
import { courseFiles, loadCourse, tightestCorner, PROBE_WINDOW } from './trackCurvature';

const minRadiusCar = TUNING.BASE_SPEED / TUNING.MAX_TURN_RATE;
console.log(`corner radii measured over ${PROBE_WINDOW}m (one car length)`);
console.log(`car min turn radius @full speed: ${minRadiusCar.toFixed(2)}m`);
console.log(`car min turn radius @off-track (60%): ${(TUNING.BASE_SPEED * 0.6 / TUNING.MAX_TURN_RATE).toFixed(2)}m\n`);

let failed = false;
for (const file of courseFiles()) {
  const g = loadCourse(file);
  const worst = tightestCorner(g);
  const ratio = worst.radius / minRadiusCar;
  if (ratio <= 2) failed = true;
  console.log(
    `  ${file.padEnd(18)} tightest ${worst.radius.toFixed(2).padStart(6)}m at s=${worst.at.toFixed(0).padStart(4)}` +
      `  ratio ${ratio.toFixed(2)}x ${ratio > 2 ? '' : '  <-- UNDER 2x'}`,
  );
}

if (failed) {
  console.log('\nFAIL - a corner is too tight for the car to take with margin');
  process.exit(1);
}
console.log('\nPASS - every corner on every course clears the 2x radius margin');
