// Prints geometry facts about a track so obstacles can be placed by hand.
import { readFileSync } from 'node:fs';
import { TrackGeometry } from '../client/src/game/track';
import type { TrackDef } from '../shared/types';

const file = process.argv[2] ?? 'client/public/tracks/circuit-01.json';
const def = JSON.parse(readFileSync(file, 'utf8')) as TrackDef;
const g = new TrackGeometry(def);

console.log(`track      : ${def.name} (${def.id})`);
console.log(`width      : ${g.trackWidth}px  (car is 26px wide -> ${(g.trackWidth / 26).toFixed(1)}x car width)`);
console.log(`length     : ${g.length.toFixed(0)}px`);
console.log(`lap @210px/s: ${(g.length / 210).toFixed(1)}s clean`);
console.log(`points     : ${def.centerline.length} control -> ${(def.samplesPerSegment ?? 14) * def.centerline.length} polyline`);
console.log(`sectors    : ${g.sectorBoundaries.map((b) => b.toFixed(0)).join(', ')}`);
console.log(`obstacles  : ${g.obstacles.length} colliders from ${def.obstacles.length} definitions`);
console.log(`bounds     : x ${g.bounds.minX.toFixed(0)}..${g.bounds.maxX.toFixed(0)}  y ${g.bounds.minY.toFixed(0)}..${g.bounds.maxY.toFixed(0)}`);

// Curvature scan: find the tightest corners, which is where obstacles matter most.
const step = 50;
const rows: { s: number; curv: number }[] = [];
for (let s = 0; s < g.length; s += step) {
  const a = g.pointAt(s);
  const b = g.pointAt(s + step);
  let dh = b.heading - a.heading;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  rows.push({ s, curv: Math.abs(dh) / step });
}
rows.sort((p, q) => q.curv - p.curv);
console.log('tightest   :', rows.slice(0, 6).map((r) => `s=${r.s.toFixed(0)}`).join(' '));
