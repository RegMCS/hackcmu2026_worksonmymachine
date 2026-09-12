/**
 * The car colour palette.
 *
 * This is contract, not decoration: `shared/net.ts` defines `colorIndex` as an
 * index into this list, so two clients in the same room agree on what "colour 3"
 * looks like only because they agree on this array. That makes `shared/` its
 * home rather than `client/src/render/`, where the HUD, the minimap and the
 * renderer were all reaching into a module that also loads 2D sprite PNGs - and
 * which a 3D renderer is free to replace with meshes.
 *
 * `client/src/render/carSprites.ts` re-exports this, so existing importers are
 * unaffected. Appending is safe; reordering is not - it silently repaints every
 * ghost already recorded and every player already in a room.
 *
 * A new file: shared/types.ts and shared/net.ts are frozen and untouched.
 */
export const CAR_COLOR_HEX = ['#e8624a', '#4aa3e0', '#5cbf4a', '#f0c419', '#8b93a3'] as const;

/** Bounded by the palette - see MAX_PLAYERS in shared/net.ts. */
export const CAR_COLOR_COUNT = CAR_COLOR_HEX.length;

/** Wraps, so an out-of-range or hostile index can never produce `undefined`. */
export function carColor(colorIndex: number): string {
  const i = Math.abs(Math.trunc(colorIndex || 0)) % CAR_COLOR_HEX.length;
  return CAR_COLOR_HEX[i];
}
