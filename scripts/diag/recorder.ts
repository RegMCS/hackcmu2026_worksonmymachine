/** Checks the ghost recorder actually samples at the rate it claims. */
import { GhostRecorder } from '../../client/src/game/ghost';
import { TUNING } from '../../client/src/game/physics';

for (const fps of [60, 50, 24]) {
  const rec = new GhostRecorder(TUNING.GHOST_RECORD_HZ, TUNING.GHOST_STORE_HZ);
  const dt = 1 / fps;
  let t = 0;
  while (t < 45) {
    t += dt;
    rec.capture(t, 0, 0, 0);
  }
  const stored = rec.finish();
  const recordHz = rec.sampleCount / 45;
  const storeHz = stored.length / 45;
  console.log(
    `render ${fps}fps -> record ${recordHz.toFixed(2)}Hz (want ${TUNING.GHOST_RECORD_HZ})` +
    `  store ${storeHz.toFixed(2)}Hz (want ${TUNING.GHOST_STORE_HZ})  samples ${stored.length}`,
  );
}
