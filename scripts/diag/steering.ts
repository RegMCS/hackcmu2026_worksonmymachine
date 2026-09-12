/**
 * Asserts the sensitivity slider stays drivable end to end.
 *
 * curvature.ts only checks that full lock can take the tightest corner. It says
 * nothing about how far the hands must travel to get there, so a slider setting
 * that is calm but effectively undrivable passes it. This covers that gap: at
 * every position on the slider, the tightest corner on every course must be
 * reachable inside a hand rotation a player can actually produce.
 */
import { TUNING, steerFeelFor } from '../../client/src/game/physics';
import { courseFiles, loadCourse, peakDemand, PROBE_WINDOW } from './trackCurvature';

const courses = courseFiles().map((f) => ({ file: f, demand: peakDemand(loadCourse(f)) }));

const hardest = courses.reduce((a, b) => (b.demand > a.demand ? b : a));
console.log(`peak turn-rate demand by course (measured over ${PROBE_WINDOW}m):`);
for (const c of courses) {
  console.log(`  ${c.file.padEnd(18)} ${c.demand.toFixed(1)} rad/s = ${((c.demand / TUNING.MAX_TURN_RATE) * 100).toFixed(0)}% of full lock`);
}
console.log(`\nhand rotation to take ${hardest.file} at each slider position`);
console.log(`(budget ${TUNING.HAND_ROTATION_BUDGET_DEG} deg)\n`);

const frac = hardest.demand / TUNING.MAX_TURN_RATE;
let worstNeeded = 0;
const failures: string[] = [];

for (let i = 0; i <= 20; i++) {
  const sens = i / 20;
  const { gamma, fullLockDeg } = steerFeelFor(sens);
  const needed = Math.pow(frac, 1 / gamma) * fullLockDeg;
  if (needed > worstNeeded) worstNeeded = needed;
  // Heading change for a 20-degree hand rotation - the twitchiness readout.
  const gain20 = ((Math.pow(Math.min(20 / fullLockDeg, 1), gamma) * TUNING.MAX_TURN_RATE * 180) / Math.PI);
  if (needed > TUNING.HAND_ROTATION_BUDGET_DEG) {
    failures.push(`sensitivity ${sens.toFixed(2)} needs ${needed.toFixed(1)} deg`);
  }
  if (i % 4 === 0) {
    console.log(
      `  sens ${sens.toFixed(2)}  gamma ${gamma.toFixed(2)}  lock ${fullLockDeg.toFixed(0).padStart(3)}deg` +
        `  -> corner needs ${needed.toFixed(1).padStart(5)} deg   20deg of hand = ${gain20.toFixed(0).padStart(4)} deg/sec`,
    );
  }
}

if (frac > 1) {
  console.log(`\nFAIL - ${hardest.file} demands more than full lock`);
  process.exit(1);
}
if (failures.length) {
  console.log(`\nFAIL - the tightest corner is out of reach at:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(
  `\nPASS - every slider position takes the tightest corner within ` +
    `${worstNeeded.toFixed(1)} deg of hand rotation`,
);
