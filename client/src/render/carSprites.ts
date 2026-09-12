/**
 * Top-down car sprites (Kenney Racing Pack, CC0 - see public/cars/LICENSE.txt).
 *
 * These are 2D sprites laid onto the ground plane, not 3D models: the spec rules
 * out a 3D engine, and a faked perspective on flat geometry is sufficient. Every
 * sprite is self-hosted, and rendering degrades to the procedural car shape if an
 * image is missing, so a failed load can never blank the grid mid-demo.
 */

export const CAR_COLOR_NAMES = ['red', 'blue', 'green', 'yellow', 'black'] as const;
export type CarColorName = (typeof CAR_COLOR_NAMES)[number];

/** HUD swatches, matched to the sprite artwork so dots and cars agree. */
export const CAR_COLOR_HEX = ['#e8624a', '#4aa3e0', '#5cbf4a', '#f0c419', '#8b93a3'] as const;

export const CAR_SHAPES = [1, 2, 3, 4, 5] as const;
export const SHAPE_LABELS = ['Saloon', 'Coupe', 'Hatch', 'Van', 'Racer'] as const;

export interface LoadedSprite {
  img: HTMLImageElement;
  width: number;
  height: number;
}

const cache = new Map<string, LoadedSprite | null>();
let loadedCount = 0;

const keyFor = (colorIndex: number, shape: number) =>
  `${CAR_COLOR_NAMES[((colorIndex % CAR_COLOR_NAMES.length) + CAR_COLOR_NAMES.length) % CAR_COLOR_NAMES.length]}_${((shape - 1) % 5 + 5) % 5 + 1}`;

export function spriteUrl(colorIndex: number, shape: number): string {
  return `/cars/car_${keyFor(colorIndex, shape)}.png`;
}

/** Preloads every sprite. Failures are cached as null and fall back to vectors. */
export async function preloadCarSprites(): Promise<number> {
  const jobs: Promise<void>[] = [];
  for (let c = 0; c < CAR_COLOR_NAMES.length; c++) {
    for (const shape of CAR_SHAPES) {
      const key = keyFor(c, shape);
      if (cache.has(key)) continue;
      jobs.push(
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            cache.set(key, { img, width: img.naturalWidth, height: img.naturalHeight });
            loadedCount++;
            resolve();
          };
          img.onerror = () => {
            cache.set(key, null);
            resolve();
          };
          img.src = spriteUrl(c, shape);
        }),
      );
    }
  }
  await Promise.all(jobs);
  return loadedCount;
}

export function getSprite(colorIndex: number, shape: number): LoadedSprite | null {
  return cache.get(keyFor(colorIndex, shape)) ?? null;
}

export const spriteCount = () => loadedCount;
