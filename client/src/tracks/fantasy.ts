import type { TrackDef } from './index';

const XZ: [number, number][] = [
  [0, 0], [70, -25], [130, -10], [175, -60], [165, -130], [110, -170], [60, -140],
  [10, -175], [-60, -160], [-110, -100], [-95, -40], [-50, -10],
];

export const FANTASY: TrackDef = {
  name: 'Fantasy Loop',
  roadWidth: 14,
  points: XZ.map(([x, z]) => [x, 0, z]),
  sections: [],
};
