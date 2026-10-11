import { createSyntheticTerrain, type EnvironmentFeatures, type TerrainDataset } from '#sim';
import type { MeshData } from './drape';

// Shared fixtures and measurements for the 3D geometry tests.

/** Rough ground, 600 m square at 10 m: steep, uneven, with a 40 m cliff at x = 120. */
export function roughGround(features?: EnvironmentFeatures): TerrainDataset {
  return createSyntheticTerrain(
    { originX: -300, originY: -300, cellSize: 10, columns: 61, rows: 61 },
    (x, y) =>
      1200 +
      60 * Math.sin(x / 90) * Math.cos(y / 110) +
      7.7 * Math.sin(x * 0.61 + y * 0.29) +
      (x > 120 ? 40 : 0),
    features,
  );
}

/** Deterministic pseudo-random numbers in [0, 1). */
export function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A triangle in battlefield axes (x east, y north, z up). */
export interface Tri {
  readonly a: { x: number; y: number; z: number };
  readonly b: { x: number; y: number; z: number };
  readonly c: { x: number; y: number; z: number };
}

/** The triangles of a mesh, back in battlefield axes. */
export function triangles(mesh: MeshData): Tri[] {
  const p = mesh.positions;
  const v = (i: number) => ({ x: p[i * 3] ?? 0, y: -(p[i * 3 + 2] ?? 0), z: p[i * 3 + 1] ?? 0 });
  const out: Tri[] = [];
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    out.push({ a: v(t * 3), b: v(t * 3 + 1), c: v(t * 3 + 2) });
  }
  return out;
}

/** Signed area seen from above (positive: counter-clockwise). */
export function triArea(t: Tri): number {
  return ((t.b.x - t.a.x) * (t.c.y - t.a.y) - (t.c.x - t.a.x) * (t.b.y - t.a.y)) / 2;
}

/** Barycentric weights of (x, y) in a triangle. */
function weights(t: Tri, x: number, y: number): [number, number, number] {
  const det = (t.b.y - t.c.y) * (t.a.x - t.c.x) + (t.c.x - t.b.x) * (t.a.y - t.c.y);
  const l1 = ((t.b.y - t.c.y) * (x - t.c.x) + (t.c.x - t.b.x) * (y - t.c.y)) / det;
  const l2 = ((t.c.y - t.a.y) * (x - t.c.x) + (t.a.x - t.c.x) * (y - t.c.y)) / det;
  return [l1, l2, 1 - l1 - l2];
}

/** Answers "which triangles cover this point?" quickly, through a 5 m grid. */
export function coverage(mesh: MeshData) {
  const tris = triangles(mesh).filter((t) => Math.abs(triArea(t)) > 1e-9);
  const CELL = 5;
  const grid = new Map<string, Tri[]>();
  for (const t of tris) {
    const xs = [t.a.x, t.b.x, t.c.x];
    const ys = [t.a.y, t.b.y, t.c.y];
    for (let i = Math.floor(Math.min(...xs) / CELL); i <= Math.floor(Math.max(...xs) / CELL); i++) {
      for (
        let j = Math.floor(Math.min(...ys) / CELL);
        j <= Math.floor(Math.max(...ys) / CELL);
        j++
      ) {
        const k = `${String(i)},${String(j)}`;
        const list = grid.get(k) ?? [];
        list.push(t);
        grid.set(k, list);
      }
    }
  }
  return {
    /** The surface heights of the triangles covering (x, y) (empty: not covered). */
    at(x: number, y: number): number[] {
      const k = `${String(Math.floor(x / CELL))},${String(Math.floor(y / CELL))}`;
      const out: number[] = [];
      for (const t of grid.get(k) ?? []) {
        const [l1, l2, l3] = weights(t, x, y);
        if (Math.min(l1, l2, l3) >= -1e-9) out.push(l1 * t.a.z + l2 * t.b.z + l3 * t.c.z);
      }
      return out;
    },
    covered(x: number, y: number): boolean {
      return this.at(x, y).length > 0;
    },
  };
}

/** Distance from a point to a polyline. */
export function distanceToLine(
  x: number,
  y: number,
  line: readonly { x: number; y: number }[],
): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i += 1) {
    const a = line[i];
    const b = line[i + 1];
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
    best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
  }
  return best;
}
