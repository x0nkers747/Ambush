import {
  NO_FEATURES,
  rectangle,
  smoothNoise,
  type Building,
  type EnvironmentFeatures,
  type Vec2,
} from '#sim';

// A seeded urban district for the Behavior Lab (synthetic; represents no
// real place): a street grid of blocks, built up with houses and larger
// buildings of varied sizes and heights, walled yards with sheds, a few
// open squares, and street clutter (parked cars, shipping containers, low
// walls). Every object is a building to the simulation: navigation goes
// round it (with its 0.75 m clearance) and soldiers cannot stand in it.
// The same seed always gives the same district.

/** What the district is made of (its kind, by id prefix), for drawing. */
export type UrbanKind = 'building' | 'house' | 'shed' | 'wall' | 'car' | 'container';

export interface UrbanOptions {
  readonly seed: number;
  /** Half the district's size (m); it is centred on the origin. */
  readonly half?: number;
  /** Points kept clear (the start, the waypoints), and how far round them (m). */
  readonly keepClear?: readonly Vec2[];
  readonly clearRadius?: number;
}

const STREET_M = 14;
const BLOCK_X = 72;
const BLOCK_Y = 60;

/** The kind of an urban object from its id. */
export function urbanKind(id: string): UrbanKind {
  const kind = id.split(':')[0] ?? '';
  return (
    (['building', 'house', 'shed', 'wall', 'car', 'container'] as const).find((k) => k === kind) ??
    'building'
  );
}

/** The district's features: every object as a building (rectangle footprint), in a fixed order. */
export function urbanFeatures(options: UrbanOptions): EnvironmentFeatures {
  const { seed } = options;
  const half = options.half ?? 480;
  const keep = options.keepClear ?? [];
  const clearRadius = options.clearRadius ?? 32;
  let n = 0;
  /** A seeded number in [0, 1) for draw `k` (deterministic, no state). */
  const rand = () => (smoothNoise(seed, 7919, 5, (n += 1), 1) + 1) / 2;
  const buildings: Building[] = [];
  const add = (
    kind: UrbanKind,
    cx: number,
    cy: number,
    w: number,
    d: number,
    height: number,
    azimuth = 0,
  ) => {
    // Nothing within the clear zones (by the object's bounding circle).
    const r = Math.hypot(w, d) / 2;
    if (keep.some((p) => Math.hypot(p.x - cx, p.y - cy) < clearRadius + r)) return;
    if (Math.abs(cx) + r > half || Math.abs(cy) + r > half) return;
    buildings.push({
      id: `${kind}:${String(buildings.length)}`,
      footprint: rectangle(cx, cy, w, d, azimuth),
      heightMeters: height,
    });
  };

  const pitchX = BLOCK_X + STREET_M;
  const pitchY = BLOCK_Y + STREET_M;
  const blocks = Math.floor((2 * half) / pitchX);
  const rows = Math.floor((2 * half) / pitchY);
  const x0 = -(blocks * pitchX) / 2 + STREET_M / 2;
  const y0 = -(rows * pitchY) / 2 + STREET_M / 2;
  for (let bx = 0; bx < blocks; bx += 1) {
    for (let by = 0; by < rows; by += 1) {
      const left = x0 + bx * pitchX;
      const bottom = y0 + by * pitchY;
      const cx = left + BLOCK_X / 2;
      const cy = bottom + BLOCK_Y / 2;
      const use = rand();
      if (use < 0.12) {
        // An open square: a few containers and low walls.
        for (let k = 0; k < 3; k += 1) {
          add(
            'container',
            cx + (rand() - 0.5) * 50,
            cy + (rand() - 0.5) * 40,
            6.1,
            2.4,
            2.6,
            Math.floor(rand() * 4) * 45,
          );
        }
        add(
          'wall',
          cx + (rand() - 0.5) * 30,
          cy + (rand() - 0.5) * 30,
          12 + rand() * 10,
          0.5,
          1.2,
          rand() < 0.5 ? 0 : 90,
        );
        continue;
      }
      if (use < 0.32) {
        // A few large buildings.
        const count = 1 + Math.floor(rand() * 3);
        for (let k = 0; k < count; k += 1) {
          const w = 18 + rand() * 22;
          const d = 14 + rand() * 18;
          add(
            'building',
            left + w / 2 + 3 + rand() * (BLOCK_X - w - 6),
            bottom + d / 2 + 3 + rand() * (BLOCK_Y - d - 6),
            w,
            d,
            8 + rand() * 14,
          );
        }
        continue;
      }
      // Houses along the block's two long sides, with yards behind them.
      for (const side of [-1, 1] as const) {
        let x = left + 2;
        while (x < left + BLOCK_X - 8) {
          const w = 8 + rand() * 9;
          const d = 8 + rand() * 6;
          const gap = 2.5 + rand() * 5;
          if (x + w > left + BLOCK_X - 2) break;
          const setback = 1 + rand() * 3;
          const y = side < 0 ? bottom + setback + d / 2 : bottom + BLOCK_Y - setback - d / 2;
          if (rand() < 0.88) add('house', x + w / 2, y, w, d, 4 + rand() * 6);
          // A garden wall and sometimes a shed in the yard behind.
          if (rand() < 0.45) {
            const wy =
              side < 0
                ? bottom + setback + d + 6 + rand() * 4
                : bottom + BLOCK_Y - setback - d - 6 - rand() * 4;
            add('wall', x + w / 2, wy, w + gap * 0.6, 0.4, 1.8);
          }
          if (rand() < 0.3) {
            const sy =
              side < 0
                ? bottom + setback + d + 3 + rand() * 2
                : bottom + BLOCK_Y - setback - d - 3 - rand() * 2;
            add(
              'shed',
              x + w / 2 + (rand() - 0.5) * w * 0.5,
              sy,
              3 + rand() * 2,
              2.5 + rand() * 1.5,
              2.4,
            );
          }
          x += w + gap;
        }
      }
    }
  }
  // Street clutter: cars parked along the streets, the odd container.
  for (let bx = 0; bx <= blocks; bx += 1) {
    const sx = x0 + bx * pitchX - STREET_M / 2;
    for (let k = 0; k < 8; k += 1) {
      if (rand() < 0.5) continue;
      const y = -half + rand() * 2 * half;
      add(
        rand() < 0.85 ? 'car' : 'container',
        sx + (rand() < 0.5 ? -4.5 : 4.5),
        y,
        1.9,
        rand() < 0.85 ? 4.6 : 6.1,
        1.5,
      );
    }
  }
  for (let by = 0; by <= rows; by += 1) {
    const sy = y0 + by * pitchY - STREET_M / 2;
    for (let k = 0; k < 8; k += 1) {
      if (rand() < 0.5) continue;
      const x = -half + rand() * 2 * half;
      add(
        rand() < 0.85 ? 'car' : 'container',
        x,
        sy + (rand() < 0.5 ? -4.5 : 4.5),
        rand() < 0.85 ? 4.6 : 6.1,
        1.9,
        1.5,
      );
    }
  }
  return { ...NO_FEATURES, buildings };
}

/** The district's streets as rectangles (centre, width east-west, depth north-south), for drawing. */
export function urbanStreets(half = 480): { x: number; y: number; w: number; d: number }[] {
  const pitchX = BLOCK_X + STREET_M;
  const pitchY = BLOCK_Y + STREET_M;
  const blocks = Math.floor((2 * half) / pitchX);
  const rows = Math.floor((2 * half) / pitchY);
  const x0 = -(blocks * pitchX) / 2 + STREET_M / 2;
  const y0 = -(rows * pitchY) / 2 + STREET_M / 2;
  const out: { x: number; y: number; w: number; d: number }[] = [];
  for (let bx = 0; bx <= blocks; bx += 1) {
    out.push({ x: x0 + bx * pitchX - STREET_M / 2, y: 0, w: STREET_M, d: 2 * half });
  }
  for (let by = 0; by <= rows; by += 1) {
    out.push({ x: 0, y: y0 + by * pitchY - STREET_M / 2, w: 2 * half, d: STREET_M });
  }
  return out;
}
