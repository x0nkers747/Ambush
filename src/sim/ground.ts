import type { Heightfield, TerrainDataset, TerrainDeck } from './terrain';
import { deckHalfWidth } from './terrain-field/decks';
import {
  compileField,
  DEFAULT_FIELD_SPEC,
  TERRAIN_FIELD_VERSION,
  type FieldInput,
  type TerrainField,
} from './terrain-field/field';
import { levelAt } from './terrain-field/roads';
import { waterLevels, type WaterSurfaces } from './water-grading';

// The authoritative ground (docs/adr/0049): the terrain field (terrain-field/,
// roads, bridges' decks, building pads, channels and water beds built into the
// cleaned elevation model as constraints) sampled for the simulation. The 10 m
// grid takes the field's heights at its nodes; cells where the field departs
// from the grid's triangles by more than `REFINE_TOLERANCE_M` are refined to a
// 1 m lattice (`TerrainRefinement`). The 3D view compiles the same field from
// the cleaned elevations the grading keeps, so what units see, cross and hide
// behind is what is drawn, to within that tolerance. Deterministic: the field
// is the same in every engine, and the lattice's values do not depend on how
// its rows are shared out between workers.

/** Spacing of the refined lattice, metres. */
export const FINE_SPACING_M = 1;
/** A cell is refined where the field departs from its two triangles by more than this, metres. */
export const REFINE_TOLERANCE_M = 0.1;

/**
 * Which model of the ground a terrain is: the DEM cleaning version
 * (docs/adr/0033) and the terrain field version it was sampled from, e.g.
 * `dem-clean-v1+field-v5`; `source` for an untouched terrain. Scenarios
 * record it, so plans made on another model are noticed (docs/adr/0032).
 */
export function terrainModelId(terrain: TerrainDataset): string {
  const steps = [
    ...(terrain.cleaning ? [terrain.cleaning.version] : []),
    ...(terrain.grading ? [`field-v${String(terrain.grading.version)}`] : []),
  ];
  return steps.length > 0 ? steps.join('+') : 'source';
}

/** The field input of a cleaned terrain, or of a graded one (from the elevations it keeps). */
export function groundFieldInput(terrain: TerrainDataset): FieldInput {
  const grading = terrain.grading;
  return {
    heightfield: grading?.baseElevations
      ? { ...terrain.heightfield, elevations: grading.baseElevations }
      : terrain.heightfield,
    features: terrain.features,
    water: grading ? (grading.water ?? null) : waterLevels(terrain),
  };
}

/** The field of a cleaned (not graded) terrain, with its water levels. */
export function groundField(source: TerrainDataset): TerrainField {
  return compileField(groundFieldInput(source), DEFAULT_FIELD_SPEC);
}

/** The decks of the field's mapped bridges, sampled every metre along their roads. */
export function groundDecks(field: TerrainField): TerrainDeck[] {
  return field.roads
    .filter((r) => r.bridge)
    .map((road) => {
      const total = road.cum[road.cum.length - 1] ?? 0;
      const n = Math.max(1, Math.ceil(total));
      const xy: number[] = [];
      const top: number[] = [];
      let seg = 0;
      for (let k = 0; k <= n; k += 1) {
        const s = (total * k) / n;
        while (seg + 2 < road.cum.length && (road.cum[seg + 1] ?? 0) < s) seg += 1;
        const c0 = road.cum[seg] ?? 0;
        const c1 = road.cum[seg + 1] ?? c0;
        const t = c1 > c0 ? (s - c0) / (c1 - c0) : 0;
        const ax = road.xy[2 * seg] ?? 0;
        const ay = road.xy[2 * seg + 1] ?? 0;
        xy.push(
          ax + t * ((road.xy[2 * seg + 2] ?? ax) - ax),
          ay + t * ((road.xy[2 * seg + 3] ?? ay) - ay),
        );
        top.push(levelAt(road, s));
      }
      return { roadId: road.id, halfWidth: deckHalfWidth(road), xy, top };
    });
}

/** The lattice of cell rows `r0` to `r1 − 1`: the part of the ground one worker makes. */
export interface GroundBand {
  readonly r0: number;
  readonly r1: number;
  /** Field heights at the grid nodes of rows r0 to r1 (inclusive), row-major. */
  readonly nodes: Float32Array;
  /** Refined cells, ascending, as `r * (columns − 1) + c`. */
  readonly cells: Int32Array;
  /** `(factor + 1)²` samples per refined cell, before edges are straightened. */
  readonly samples: Float32Array;
}

/** Fine cells per grid cell side for a grid of `cellSize`. */
export function groundFactor(cellSize: number): number {
  return Math.max(2, Math.round(cellSize / FINE_SPACING_M));
}

/** Samples the field over cell rows `r0` to `r1 − 1` of `hf`. */
export function groundBand(
  field: TerrainField,
  hf: Pick<Heightfield, 'originX' | 'originY' | 'cellSize' | 'columns' | 'rows'>,
  r0: number,
  r1: number,
): GroundBand {
  const { originX, originY, cellSize, columns } = hf;
  const k = groundFactor(cellSize);
  const n1 = k + 1;
  const fine = cellSize / k;
  // The whole band's lattice: each fine point is computed once.
  const lw = (columns - 1) * k + 1;
  const lh = (r1 - r0) * k + 1;
  const lattice = new Float32Array(lw * lh);
  for (let j = 0; j < lh; j += 1) {
    const y = originY + (r0 * k + j) * fine;
    for (let i = 0; i < lw; i += 1) lattice[j * lw + i] = field.height(originX + i * fine, y);
  }
  const nodes = new Float32Array(columns * (r1 - r0 + 1));
  for (let r = 0; r <= r1 - r0; r += 1)
    for (let c = 0; c < columns; c += 1) nodes[r * columns + c] = lattice[r * k * lw + c * k] ?? 0;
  const cells: number[] = [];
  const kept: Float32Array[] = [];
  for (let r = r0; r < r1; r += 1) {
    const base = (r - r0) * k * lw;
    for (let c = 0; c < columns - 1; c += 1) {
      const o = base + c * k;
      const sw = lattice[o] ?? 0;
      const se = lattice[o + k] ?? 0;
      const nw = lattice[o + k * lw] ?? 0;
      const ne = lattice[o + k * lw + k] ?? 0;
      let worst = 0;
      for (let j = 0; j <= k && worst <= REFINE_TOLERANCE_M; j += 1) {
        const v = j / k;
        for (let i = 0; i <= k; i += 1) {
          const u = i / k;
          const flat =
            u >= v ? sw + u * (se - sw) + v * (ne - se) : sw + v * (nw - sw) + u * (ne - nw);
          const d = Math.abs((lattice[o + j * lw + i] ?? 0) - flat);
          if (d > worst) worst = d;
        }
      }
      if (worst <= REFINE_TOLERANCE_M) continue;
      const s = new Float32Array(n1 * n1);
      for (let j = 0; j <= k; j += 1) s.set(lattice.subarray(o + j * lw, o + j * lw + n1), j * n1);
      cells.push(r * (columns - 1) + c);
      kept.push(s);
    }
  }
  const samples = new Float32Array(kept.length * n1 * n1);
  kept.forEach((s, i) => {
    samples.set(s, i * n1 * n1);
  });
  return { r0, r1, nodes, cells: Int32Array.from(cells), samples };
}

/** Splits `rows − 1` cell rows into `count` bands of about equal size. */
export function groundBands(rows: number, count: number): [number, number][] {
  const cellRows = rows - 1;
  const n = Math.max(1, Math.min(count, cellRows));
  return Array.from({ length: n }, (_, i) => [
    Math.floor((i * cellRows) / n),
    Math.floor(((i + 1) * cellRows) / n),
  ]);
}

/**
 * The graded terrain from a cleaned `source`, its water levels and the bands
 * covering all its cell rows: refined cells' edges next to unrefined cells
 * are straightened, so the surface is continuous.
 */
export function assembleGround(
  source: TerrainDataset,
  water: WaterSurfaces | null,
  bands: readonly GroundBand[],
  decks: readonly TerrainDeck[],
): TerrainDataset {
  const hf = source.heightfield;
  const { columns, rows } = hf;
  const k = groundFactor(hf.cellSize);
  const n1 = k + 1;
  const sorted = [...bands].sort((a, b) => a.r0 - b.r0);
  const elevations = new Array<number>(columns * rows);
  for (const b of sorted)
    for (let i = 0; i < b.nodes.length; i += 1) elevations[b.r0 * columns + i] = b.nodes[i] ?? 0;
  const count = sorted.reduce((n, b) => n + b.cells.length, 0);
  const cells = new Array<number>(count);
  const samples = new Float32Array(count * n1 * n1);
  let at = 0;
  for (const b of sorted) {
    for (let i = 0; i < b.cells.length; i += 1) cells[at + i] = b.cells[i] ?? 0;
    samples.set(b.samples, at * n1 * n1);
    at += b.cells.length;
  }
  const slot = new Int32Array((columns - 1) * (rows - 1)).fill(-1);
  cells.forEach((cell, i) => {
    slot[cell] = i;
  });
  // Off the grid counts as refined: the border needs no straightening.
  const refined = (c: number, r: number) =>
    c < 0 || r < 0 || c >= columns - 1 || r >= rows - 1 || (slot[r * (columns - 1) + c] ?? -1) >= 0;
  cells.forEach((cell, i) => {
    const c = cell % (columns - 1);
    const r = (cell - c) / (columns - 1);
    const o = i * n1 * n1;
    const straighten = (at: (m: number) => number) => {
      const a = samples[at(0)] ?? 0;
      const b = samples[at(k)] ?? 0;
      for (let m = 1; m < k; m += 1) samples[at(m)] = a + (m / k) * (b - a);
    };
    if (!refined(c, r - 1)) straighten((m) => o + m);
    if (!refined(c, r + 1)) straighten((m) => o + k * n1 + m);
    if (!refined(c - 1, r)) straighten((m) => o + m * n1);
    if (!refined(c + 1, r)) straighten((m) => o + m * n1 + k);
  });
  return {
    ...source,
    heightfield: { ...hf, elevations },
    ...(count > 0 ? { refinement: { factor: k, cells, samples } } : {}),
    grading: {
      version: TERRAIN_FIELD_VERSION,
      fineSpacingM: hf.cellSize / k,
      baseElevations: hf.elevations,
      ...(water ? { water } : {}),
      ...(decks.length > 0 ? { decks } : {}),
    },
  };
}

/**
 * The graded terrain for a cleaned terrain: the authoritative ground, on one
 * thread. A terrain that is already graded is returned as it is.
 */
export function gradeTerrain(source: TerrainDataset): TerrainDataset {
  if (source.grading) return source;
  const input = groundFieldInput(source);
  const field = compileField(input, DEFAULT_FIELD_SPEC);
  const band = groundBand(field, source.heightfield, 0, source.heightfield.rows - 1);
  return assembleGround(source, input.water, [band], groundDecks(field));
}
