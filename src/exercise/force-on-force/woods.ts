import {
  NO_FEATURES,
  smoothNoise,
  type EnvironmentFeatures,
  type VegetationArea,
  type Vec2,
} from '#sim';

// A seeded wooded landscape for the Force-on-Force Lab (synthetic; represents
// no real place): woods of irregular outline, scrub and tree lines on open
// ground. Vegetation does not obstruct movement; it obscures sight lines
// gradually (`lineOfSight`: depth over see-through depth) and lowers what an
// observer gets of a target in it (`vegetationTransmission`). The same seed
// always gives the same landscape.

export interface WoodsOptions {
  readonly seed: number;
  /** Half the area's size (m), centred on the origin. */
  readonly half?: number;
  /** Points kept out of the woods (starts, destinations), and how far round them (m). */
  readonly keepClear?: readonly Vec2[];
  readonly clearRadius?: number;
}

/** Spacing of the grid woods are placed on (m). */
const CELL_M = 150;

export function woodsFeatures(options: WoodsOptions): EnvironmentFeatures {
  const { seed } = options;
  const half = options.half ?? 900;
  const keep = options.keepClear ?? [];
  const clearRadius = options.clearRadius ?? 25;
  let n = 0;
  const rand = () => (smoothNoise(seed, 6271, 7, (n += 1), 1) + 1) / 2;
  const vegetation: VegetationArea[] = [];
  /** A star-shaped (so simple) outline round (cx, cy). */
  const blob = (cx: number, cy: number, radius: number, corners: number): Vec2[] => {
    const points: Vec2[] = [];
    const turn = rand() * 2 * Math.PI;
    for (let k = 0; k < corners; k += 1) {
      const a = turn + (2 * Math.PI * k) / corners;
      const r = radius * (0.7 + 0.5 * rand());
      points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    // Counter-clockwise order (increasing angle).
    return points;
  };
  const clear = (cx: number, cy: number, r: number) =>
    keep.every((p) => Math.hypot(p.x - cx, p.y - cy) > clearRadius + r * 1.2) &&
    Math.abs(cx) + r * 1.2 < half &&
    Math.abs(cy) + r * 1.2 < half;
  const cells = Math.floor((2 * half) / CELL_M);
  for (let i = 0; i < cells; i += 1) {
    for (let j = 0; j < cells; j += 1) {
      const cx = -half + (i + 0.5) * CELL_M + (rand() - 0.5) * CELL_M * 0.6;
      const cy = -half + (j + 0.5) * CELL_M + (rand() - 0.5) * CELL_M * 0.6;
      const use = rand();
      if (use < 0.45) {
        const r = 40 + rand() * 45;
        if (!clear(cx, cy, r)) continue;
        vegetation.push({
          id: `woodland:${String(vegetation.length)}`,
          kind: 'woodland',
          boundary: blob(cx, cy, r, 12),
          canopyHeightMeters: 14 + rand() * 8,
          seeThroughMeters: 35 + rand() * 30,
        });
      } else if (use < 0.75) {
        const r = 12 + rand() * 18;
        if (!clear(cx, cy, r)) continue;
        vegetation.push({
          id: `scrub:${String(vegetation.length)}`,
          kind: 'scrub',
          boundary: blob(cx, cy, r, 9),
          canopyHeightMeters: 2.5,
          seeThroughMeters: 12 + rand() * 10,
        });
      } else if (use < 0.9) {
        // A tree line: a long thin strip, east-west or north-south.
        const length = 60 + rand() * 80;
        const width = 6 + rand() * 4;
        const along = rand() < 0.5;
        const [w, d] = along ? [length, width] : [width, length];
        if (!clear(cx, cy, length / 2)) continue;
        vegetation.push({
          id: `treeLine:${String(vegetation.length)}`,
          kind: 'treeLine',
          boundary: [
            { x: cx - w / 2, y: cy - d / 2 },
            { x: cx + w / 2, y: cy - d / 2 },
            { x: cx + w / 2, y: cy + d / 2 },
            { x: cx - w / 2, y: cy + d / 2 },
          ],
          canopyHeightMeters: 12,
          seeThroughMeters: 18,
        });
      }
    }
  }
  return { ...NO_FEATURES, vegetation };
}
