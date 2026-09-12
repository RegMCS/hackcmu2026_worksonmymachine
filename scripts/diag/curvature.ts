import { readFileSync } from 'node:fs';
import { TrackGeometry } from '../../client/src/game/track';
import { TUNING } from '../../client/src/game/physics';
import type { TrackDef } from '../../shared/types';

const def = JSON.parse(readFileSync('client/public/tracks/circuit-01.json','utf8')) as TrackDef;
const g = new TrackGeometry(def);
const minRadiusCar = TUNING.BASE_SPEED / TUNING.MAX_TURN_RATE;
console.log(`car min turn radius @full speed: ${minRadiusCar.toFixed(0)}px`);
console.log(`car min turn radius @off-track (60%): ${(TUNING.BASE_SPEED*0.6/TUNING.MAX_TURN_RATE).toFixed(0)}px`);

const STEP = 30;
let worst = {s:0, r:Infinity};
const tight: {s:number,r:number}[] = [];
for (let s=0; s<g.length; s+=STEP) {
  const a=g.pointAt(s), b=g.pointAt(s+STEP);
  let dh=b.heading-a.heading;
  while(dh>Math.PI)dh-=Math.PI*2; while(dh<-Math.PI)dh+=Math.PI*2;
  const r = Math.abs(dh)>1e-6 ? STEP/Math.abs(dh) : Infinity;
  if (r<worst.r) worst={s,r};
  if (r < 400) tight.push({s,r});
}
console.log(`tightest corner radius: ${worst.r.toFixed(0)}px at s=${worst.s}`);
console.log(`corners under 400px radius: ${tight.length} samples`);
console.log(`ratio tightest/car-min: ${(worst.r/minRadiusCar).toFixed(2)}x  (want >2x for comfort)`);
// how much of the lap is tight?
console.log(`tight fraction of lap: ${(tight.length*STEP/g.length*100).toFixed(1)}%`);
