import { OPENING_CELLS, type BuildingStyle, type DoorKind } from './building-style';

// Windows and doors on a building's walls (docs/adr/0035). Pure layout: each
// wall gets a row of window positions per storey, evenly spread between
// clearances at its corners; the entrance wall's middle ground-floor window
// gives way to the door, and on houses with a garage one end to the garage
// door. Nothing is placed where the ground along the wall would cover it, or
// where the eaves would cut it. The openings are textured quads drawn just in
// front of the wall (an atlas of original drawings, `textures/openings.png`);
// they are decoration, with no effect on line of sight or movement.

/** Openings keep at least this far from a wall's corners, metres. */
export const CORNER_CLEARANCE_M = 0.7;
/** Windows keep at least this far above the ground outside, metres. */
export const GROUND_CLEARANCE_M = 0.3;
/** Windows and doors keep at least this far below the wall's top, metres. */
export const EAVES_CLEARANCE_M = 0.3;

/** Pixel box of each atlas cell's drawing within its 256 px cell: [x0, y0, x1, y1] from the top left. */
export const CELL_BOX: readonly (readonly [number, number, number, number])[] = [
  [32, 16, 224, 240],
  [2, 14, 254, 240],
  [2, 14, 254, 240],
  [32, 16, 224, 240],
  [2, 14, 254, 240],
  [32, 16, 224, 230],
  [0, 14, 256, 242],
  [62, 16, 194, 230],
  [28, 10, 228, 256],
  [28, 10, 228, 256],
  [16, 10, 240, 256],
  [0, 0, 256, 256],
  [6, 20, 250, 256],
  [4, 8, 252, 256],
  [8, 10, 248, 256],
  [32, 16, 224, 240],
];

/** Cells drawn with shutters either side: their quads are this much wider than the window. */
export const SHUTTER_WIDTH = 1.33;
const SHUTTERED = new Set<number>([
  OPENING_CELLS.casementShuttersGreen,
  OPENING_CELLS.casementShuttersBrown,
  OPENING_CELLS.doubleHungShutters,
]);

export type OpeningKind = 'window' | 'door' | 'garage';

/** An opening on a wall: along the wall from its start corner, between two heights. */
export interface Opening {
  readonly kind: OpeningKind;
  readonly cell: number;
  readonly s0: number;
  readonly s1: number;
  readonly z0: number;
  readonly z1: number;
  /** sRGB tint. */
  readonly tint: number;
}

/** A wall to lay out: its length, top along it, and the ground in front of it. */
export interface FacadeWall {
  readonly length: number;
  /** Height of the wall's top at distance s along it. */
  top(s: number): number;
  /** Ground height in front of the wall at distance s along it. */
  ground(s: number): number;
  /** Whether this is the entrance wall. */
  readonly entrance: boolean;
}

export interface FacadeContext {
  readonly style: BuildingStyle;
  /** Floor of the ground storey, absolute metres. */
  readonly floor: number;
  /** Storeys, and the height of each. */
  readonly storeys: number;
  readonly storeyM: number;
  /** A deterministic number in [0, 1) for this wall. */
  readonly chance: number;
}

const DOOR_SIZE: Readonly<Record<DoorKind, readonly [number, number, number]>> = {
  // width, height, atlas cell
  wood: [1.0, 2.1, OPENING_CELLS.doorWood],
  painted: [1.0, 2.1, OPENING_CELLS.doorPainted],
  glass: [1.8, 2.3, OPENING_CELLS.doorGlass],
  shop: [3.0, 2.6, OPENING_CELLS.shopfront],
  roller: [3.6, 3.6, OPENING_CELLS.roller],
  barn: [3.0, 3.0, OPENING_CELLS.barn],
};
const GARAGE_SIZE = [2.5, 2.2] as const;

/** The storeys a building has: from its tagged levels, else its wall height. */
export function storeysOf(wallHeight: number, storeyM: number, levels: number | undefined): number {
  if (levels !== undefined && levels >= 1) return Math.min(60, Math.floor(levels));
  return Math.max(1, Math.floor(wallHeight / storeyM + 0.2));
}

/** Window centres along a wall: as many modules as fit between the corner clearances. */
export function windowCentres(length: number, moduleM: number, windowWidth: number): number[] {
  const usable = length - 2 * CORNER_CLEARANCE_M;
  if (usable < windowWidth) return [];
  const n = Math.max(1, Math.floor(usable / moduleM));
  return Array.from({ length: n }, (_, i) => CORNER_CLEARANCE_M + (usable * (i + 0.5)) / n);
}

/** The openings of one wall. */
export function wallOpenings(wall: FacadeWall, ctx: FacadeContext): Opening[] {
  const { style } = ctx;
  const out: Opening[] = [];
  const L = wall.length;
  const minTop = (s0: number, s1: number) => Math.min(wall.top(s0), wall.top(s1));
  const maxGround = (s0: number, s1: number) =>
    Math.max(wall.ground(s0), wall.ground((s0 + s1) / 2), wall.ground(s1));
  const win = style.window;
  const centres = win && !win.strip ? windowCentres(L, win.moduleM, win.widthM) : [];
  /** Ground-floor spans taken by doors. */
  const taken: (readonly [number, number])[] = [];

  const placeDoor = (
    kind: OpeningKind,
    centre: number,
    w: number,
    h: number,
    cell: number,
    tint: number,
  ) => {
    const s0 = centre - w / 2;
    const s1 = centre + w / 2;
    if (s0 < CORNER_CLEARANCE_M - 0.3 || s1 > L - CORNER_CLEARANCE_M + 0.3) return false;
    const z0 = Math.max(maxGround(s0, s1), ctx.floor - 0.15) + 0.02;
    let z1 = z0 + h;
    const limit = minTop(s0, s1) - 0.15;
    if (z1 > limit) z1 = limit;
    if (z1 - z0 < Math.min(h, 1.9)) return false;
    out.push({ kind, cell, s0, s1, z0, z1, tint });
    taken.push([s0 - 0.25, s1 + 0.25]);
    return true;
  };

  if (wall.entrance) {
    const [dw, dh, cell] = DOOR_SIZE[style.door];
    const outbuildingGarage = style.category === 'outbuilding' && style.garage;
    if (outbuildingGarage) {
      // One garage door, or two side by side on a long enough wall.
      const [gw, gh] = GARAGE_SIZE;
      const pair = L >= 2 * gw + 2 * CORNER_CLEARANCE_M + 0.6;
      if (pair) {
        placeDoor('garage', L / 2 - gw / 2 - 0.3, gw, gh, OPENING_CELLS.garage, style.trimTint);
        placeDoor('garage', L / 2 + gw / 2 + 0.3, gw, gh, OPENING_CELLS.garage, style.trimTint);
      } else {
        const w = Math.min(gw, L - 2 * CORNER_CLEARANCE_M + 0.4);
        placeDoor('garage', L / 2, w, gh, OPENING_CELLS.garage, style.trimTint);
      }
    } else {
      // The garage at one end, the door at the window nearest the middle of the rest.
      let lo = 0;
      let hi = L;
      if (style.garage) {
        const [gw, gh] = GARAGE_SIZE;
        if (L >= gw + dw + 2 * CORNER_CLEARANCE_M + 2.0) {
          const atStart = ctx.chance < 0.5;
          const c = atStart ? CORNER_CLEARANCE_M + gw / 2 : L - CORNER_CLEARANCE_M - gw / 2;
          if (placeDoor('garage', c, gw, gh, OPENING_CELLS.garage, style.trimTint)) {
            if (atStart) lo = c + gw / 2;
            else hi = c - gw / 2;
          }
        }
      }
      const mid = (lo + hi) / 2;
      const candidates = centres.filter((c) => c - dw / 2 > lo + 0.3 && c + dw / 2 < hi - 0.3);
      const nearest = candidates.reduce<number | null>(
        (best, c) => (best === null || Math.abs(c - mid) < Math.abs(best - mid) ? c : best),
        null,
      );
      const centre = nearest ?? mid;
      const tint = style.door === 'painted' ? style.doorTint : 0xffffff;
      placeDoor('door', centre, dw, dh, cell, tint);
    }
  }

  if (!win) return out;
  for (let storey = 0; storey < ctx.storeys; storey += 1) {
    const level = ctx.floor + storey * ctx.storeyM;
    const sill = level + win.sillM * Math.min(1, ctx.storeyM / 2.8);
    const height = Math.min(win.heightM, ctx.storeyM - (sill - level) - 0.25);
    if (height < 0.6) continue;
    if (win.strip) {
      // Industrial: a band of glazing per storey, in panels of the cell's proportions.
      const margin = Math.max(1.5, CORNER_CLEARANCE_M);
      const panel = height * (256 / 228);
      const n = Math.floor((L - 2 * margin) / panel);
      if (n < 2) continue;
      const start = (L - n * panel) / 2;
      for (let i = 0; i < n; i += 1) {
        const s0 = start + i * panel;
        const s1 = s0 + panel;
        if (storey === 0 && taken.some(([a, b]) => s1 > a && s0 < b)) continue;
        if (sill < maxGround(s0, s1) + GROUND_CLEARANCE_M) continue;
        if (sill + height > minTop(s0, s1) - EAVES_CLEARANCE_M) continue;
        out.push({
          kind: 'window',
          cell: win.cell,
          s0,
          s1,
          z0: sill,
          z1: sill + height,
          tint: 0xffffff,
        });
      }
      continue;
    }
    const w = SHUTTERED.has(win.cell) ? win.widthM * SHUTTER_WIDTH : win.widthM;
    for (const c of centres) {
      const s0 = Math.max(0.15, c - w / 2);
      const s1 = Math.min(L - 0.15, c + w / 2);
      if (storey === 0 && taken.some(([a, b]) => s1 > a && s0 < b)) continue;
      if (sill < maxGround(s0, s1) + GROUND_CLEARANCE_M) continue;
      if (sill + height > minTop(s0, s1) - EAVES_CLEARANCE_M) continue;
      out.push({
        kind: 'window',
        cell: win.cell,
        s0,
        s1,
        z0: sill,
        z1: sill + height,
        tint: 0xffffff,
      });
    }
  }
  return out;
}

/** Texture coordinates of an atlas cell's drawing: [u0, v0, u1, v1], v up (the texture flipped as usual). */
export function cellUv(cell: number): readonly [number, number, number, number] {
  const box = CELL_BOX[cell] ?? [0, 0, 256, 256];
  const cx = (cell % 4) * 256;
  const cy = Math.floor(cell / 4) * 256;
  // Half a texel in, so neighbouring cells never bleed in.
  const inset = 1.5;
  const u0 = (cx + box[0] + inset) / 1024;
  const u1 = (cx + box[2] - inset) / 1024;
  const v1 = 1 - (cy + box[1] + inset) / 1024;
  const v0 = 1 - (cy + box[3] - inset) / 1024;
  return [u0, v0, u1, v1];
}
