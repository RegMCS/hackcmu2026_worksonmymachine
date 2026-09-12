import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Keep the survey reproducible even if the reference branch later changes.
const ref = process.argv[2] ?? 'origin/aden';
const source = JSON.parse(execFileSync('git', ['show', `${ref}:client/src/tracks/buggy.json`], { encoding: 'utf8' }));
const points = source.points;
const cumulative = [0];
for (let i = 0; i < points.length; i++) {
  const a = points[i], b = points[(i + 1) % points.length];
  cumulative.push(cumulative[i] + Math.hypot(b[0] - a[0], b[2] - a[2]));
}
const length = cumulative.at(-1);
const start = source.finishAt * length;
// Uniform spacing avoids a tiny inserted finish segment making Catmull-Rom
// double back on itself. Interpolation stays on the surveyed ground polyline.
const rotated = Array.from({ length: Math.ceil(length / 3) }, (_, k) => {
  const d = (start + k * length / Math.ceil(length / 3)) % length;
  const i = cumulative.findIndex((v, j) => v <= d && cumulative[j + 1] > d);
  const f = (d - cumulative[i]) / (cumulative[i + 1] - cumulative[i]);
  return points[i].map((v, axis) => v + (points[(i + 1) % points.length][axis] - v) * f);
});
const sections = source.sections.map(s => ({ name: s.name, at: (s.at - source.finishAt + 1) % 1 })).sort((a, b) => a.at - b.at);
// The line cuts FINISH STRAIGHT in two; both pieces retain the same name.
sections.unshift({ name: source.sections.filter(s => s.at <= source.finishAt).at(-1).name, at: 0 });
const def = {
  id: 'buggy-3lap-v1', name: source.name, units: 'metres', source: source.source,
  attribution: '© OpenStreetMap contributors — https://www.openstreetmap.org/copyright (ODbL). Elevation: Open-Meteo.',
  sourceRevision: execFileSync('git', ['rev-parse', ref], { encoding: 'utf8' }).trim(),
  sourceFinishAt: source.finishAt, trackWidth: source.roadWidth,
  sectorCount: sections.length, sections, samplesPerSegment: 16,
  centerline: rotated.map(p => [p[0], p[2]]), elevation: rotated.map(p => p[1]),
  obstacleSeed: 2026, obstacles: [],
};
writeFileSync('client/public/tracks/circuit-01.json', JSON.stringify(def, null, 2) + '\n');
console.log(`Converted ${points.length} survey points; start at ${start.toFixed(2)}m of ${length.toFixed(2)}m`);
