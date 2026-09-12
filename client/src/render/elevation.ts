/** Height of the road above the ground plane at distance s along the centerline. */
export type ElevationFn = (s: number) => number;

export const FLAT: ElevationFn = () => 0;

/**
 * Dev-only rolling hills so the elevation path can be eyeballed on any track.
 * Real data comes from `TrackGeometry.elevationAt`, which is render-only by
 * contract: physics, collision and ghosts never see height.
 */
export function demoHills(length: number, amplitude: number): ElevationFn {
  return (s) => {
    const u = (((s % length) + length) % length) / length;
    return amplitude * (0.5 - 0.5 * Math.cos(u * Math.PI * 2 * 3)) + amplitude * 0.3 * Math.sin(u * Math.PI * 2 * 7);
  };
}
