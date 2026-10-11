import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIO } from '#exercise';
import {
  createSyntheticTerrain,
  heightAt,
  terrainTriangleIndices,
  type TerrainDataset,
} from '#sim';
import { fromThree, toThree, yawOf } from './axes';
import { apronElevation, skirtMesh, terrainMesh, type TerrainMeshData } from './terrain-mesh';

// The 3D terrain is exactly the simulated ground (docs/adr/0029): the mesh,
// as the GPU interpolates it (linearly on its triangles, from float32
// positions), agrees with `heightAt` to 1 cm everywhere.

const TOLERANCE_M = 0.01;

/** Rough, high terrain: 5 km at 10 m, 1,500–4,300 m elevation, steep and uneven. */
function roughTerrain(): TerrainDataset {
  return createSyntheticTerrain(
    { originX: -2500, originY: -2500, cellSize: 10, columns: 501, rows: 501 },
    (x, y) =>
      2800 +
      900 * Math.sin(x / 700) * Math.cos(y / 900) +
      300 * Math.sin((x + 2 * y) / 130) +
      37.3 * Math.sin(x * 0.61 + y * 0.29) +
      // A cliff: about 120 m over two cells.
      (x > 400 ? 120 : 0),
  );
}

/**
 * The mesh's own height at (x, y): find the triangle of the index buffer that
 * contains the point and interpolate linearly from its float32 vertices, as
 * the GPU does. Independent of `heightAt`'s code.
 */
function meshHeight(mesh: TerrainMeshData, terrain: TerrainDataset, x: number, y: number): number {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const c = Math.min(Math.floor((x - originX) / cellSize), columns - 2);
  const r = Math.min(Math.floor((y - originY) / cellSize), rows - 2);
  const cell = r * (columns - 1) + c;
  const p = mesh.positions;
  let best: { h: number; inside: number } | null = null;
  for (const t of [cell * 2, cell * 2 + 1]) {
    const v = [0, 1, 2].map((k) => mesh.indices[t * 3 + k] ?? 0);
    // Three.js (X, Y, Z) back to battlefield (x, y, z).
    const pts = v.map((i) =>
      fromThree({ x: p[i * 3] ?? 0, y: p[i * 3 + 1] ?? 0, z: p[i * 3 + 2] ?? 0 }),
    );
    const [a, b, d] = pts as [(typeof pts)[0], (typeof pts)[0], (typeof pts)[0]];
    const det = (b.y - d.y) * (a.x - d.x) + (d.x - b.x) * (a.y - d.y);
    const l1 = ((b.y - d.y) * (x - d.x) + (d.x - b.x) * (y - d.y)) / det;
    const l2 = ((d.y - a.y) * (x - d.x) + (a.x - d.x) * (y - d.y)) / det;
    const l3 = 1 - l1 - l2;
    const inside = Math.min(l1, l2, l3);
    const h = l1 * a.z + l2 * b.z + l3 * d.z;
    if (!best || inside > best.inside) best = { h, inside };
  }
  if (!best || best.inside < -1e-6)
    throw new Error(`no triangle contains (${String(x)}, ${String(y)})`);
  return best.h;
}

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function worstError(
  mesh: TerrainMeshData,
  terrain: TerrainDataset,
  points: Iterable<readonly [number, number]>,
): number {
  let worst = 0;
  for (const [x, y] of points) {
    worst = Math.max(worst, Math.abs(meshHeight(mesh, terrain, x, y) - heightAt(terrain, x, y)));
  }
  return worst;
}

describe('the 3D terrain mesh', () => {
  const terrain = roughTerrain();
  const mesh = terrainMesh(terrain);
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  const maxX = originX + (columns - 1) * cellSize;
  const maxY = originY + (rows - 1) * cellSize;

  it('has one vertex per elevation sample and exactly the simulation triangles', () => {
    expect(mesh.vertexCount).toBe(501 * 501);
    expect(mesh.triangleCount).toBe(500 * 500 * 2);
    expect(Array.from(mesh.indices)).toEqual(terrainTriangleIndices(terrain));
  });

  it('puts every vertex on its sample, unchanged (no smoothing, no exaggeration)', () => {
    let worst = 0;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < columns; c += 1) {
        const i = r * columns + c;
        const p = fromThree({
          x: mesh.positions[i * 3] ?? NaN,
          y: mesh.positions[i * 3 + 1] ?? NaN,
          z: mesh.positions[i * 3 + 2] ?? NaN,
        });
        worst = Math.max(
          worst,
          Math.abs(p.x - (originX + c * cellSize)),
          Math.abs(p.y - (originY + r * cellSize)),
          Math.abs(p.z - (terrain.heightfield.elevations[i] ?? NaN)),
        );
      }
    }
    expect(worst).toBeLessThan(TOLERANCE_M);
  });

  it('agrees with heightAt at grid vertices, cell centres and triangle boundaries', () => {
    const points: [number, number][] = [];
    for (let r = 0; r < rows - 1; r += 7) {
      for (let c = 0; c < columns - 1; c += 7) {
        const x = originX + c * cellSize;
        const y = originY + r * cellSize;
        points.push([x, y]); // vertex
        points.push([x + cellSize / 2, y + cellSize / 2]); // cell centre, on the diagonal
        points.push([x + cellSize * 0.3, y + cellSize * 0.3]); // on the SW–NE diagonal
        points.push([x + cellSize * 0.4, y]); // on the south edge
        points.push([x, y + cellSize * 0.7]); // on the west edge
        points.push([x + cellSize * 0.7, y + cellSize * 0.2]); // south-east triangle
        points.push([x + cellSize * 0.2, y + cellSize * 0.7]); // north-west triangle
      }
    }
    expect(worstError(mesh, terrain, points)).toBeLessThan(TOLERANCE_M);
  });

  it('agrees with heightAt at 20,000 random points', () => {
    const next = random(29);
    const points = Array.from(
      { length: 20_000 },
      () => [originX + next() * (maxX - originX), originY + next() * (maxY - originY)] as const,
    );
    expect(worstError(mesh, terrain, points)).toBeLessThan(TOLERANCE_M);
  });

  it('agrees with heightAt along the battlefield edges and at its corners', () => {
    const points: [number, number][] = [
      [originX, originY],
      [maxX, originY],
      [originX, maxY],
      [maxX, maxY],
    ];
    for (let k = 0; k <= 1000; k += 1) {
      const t = k / 1000;
      points.push([originX + t * (maxX - originX), originY]);
      points.push([originX + t * (maxX - originX), maxY]);
      points.push([originX, originY + t * (maxY - originY)]);
      points.push([maxX, originY + t * (maxY - originY)]);
    }
    expect(worstError(mesh, terrain, points)).toBeLessThan(TOLERANCE_M);
  });

  it('agrees with heightAt on the steepest ground (the cliff)', () => {
    const next = random(7);
    const points = Array.from(
      { length: 2000 },
      () => [395 + next() * 20, originY + next() * (maxY - originY)] as const,
    );
    expect(worstError(mesh, terrain, points)).toBeLessThan(TOLERANCE_M);
  });

  it('matches the demo battlefield too', () => {
    const demo = DEMO_SCENARIO.terrain;
    const demoMesh = terrainMesh(demo);
    const h = demo.heightfield;
    const next = random(3);
    const points = Array.from(
      { length: 5000 },
      () =>
        [
          h.originX + next() * (h.columns - 1) * h.cellSize,
          h.originY + next() * (h.rows - 1) * h.cellSize,
        ] as const,
    );
    expect(worstError(demoMesh, demo, points)).toBeLessThan(TOLERANCE_M);
  });

  it('keeps north up and east right: no mirroring or rotation', () => {
    // A slope rising to the north-east: the highest vertex is the NE corner.
    const slope = createSyntheticTerrain(
      { originX: 0, originY: 0, cellSize: 10, columns: 3, rows: 3 },
      (x, y) => x + 2 * y,
    );
    const m = terrainMesh(slope);
    const ne = 2 * 3 + 2;
    // East is +X; north is −Z; up is +Y.
    expect([m.positions[ne * 3], m.positions[ne * 3 + 1], m.positions[ne * 3 + 2]]).toEqual([
      20, 60, -20,
    ]);
    // Triangles face up: counter-clockwise seen from +Y (above).
    const [a, b, c] = [0, 1, 2].map((k) => m.indices[k] ?? 0) as [number, number, number];
    const ax = m.positions[a * 3] ?? 0;
    const az = m.positions[a * 3 + 2] ?? 0;
    const ux = (m.positions[b * 3] ?? 0) - ax;
    const uz = (m.positions[b * 3 + 2] ?? 0) - az;
    const vx = (m.positions[c * 3] ?? 0) - ax;
    const vz = (m.positions[c * 3 + 2] ?? 0) - az;
    // Y component of (u × v) for (x, y, z) vectors with y = 0: uz·vx − ux·vz.
    expect(uz * vx - ux * vz).toBeGreaterThan(0);
    // Normals point up and lean away from the slope (west and south).
    expect(m.normals[4 * 3 + 1]).toBeGreaterThan(0);
    expect(m.normals[4 * 3]).toBeLessThan(0); // −X: west
    expect(m.normals[4 * 3 + 2]).toBeGreaterThan(0); // +Z: south
  });

  it('converts tints to linear colours and ignores alpha', () => {
    const flat = createSyntheticTerrain(
      { originX: 0, originY: 0, cellSize: 10, columns: 2, rows: 2 },
      () => 5,
    );
    const m = terrainMesh(flat, {
      data: [255, 0, 128, 99, 0, 0, 0, 0, 255, 255, 255, 1, 1, 1, 1, 1],
      channels: 4,
    });
    expect(m.colors?.[0]).toBeCloseTo(1, 6);
    expect(m.colors?.[1]).toBe(0);
    expect(m.colors?.[2]).toBeCloseTo(0.2158605, 5);
    expect(m.colors?.[6]).toBeCloseTo(1, 6);
    expect(terrainMesh(flat).colors).toBeNull();
  });
});

describe('the Three.js axes', () => {
  it('map east to +X, north to −Z and up to +Y, and back', () => {
    expect(toThree(10, 20, 30)).toEqual({ x: 10, y: 30, z: -20 });
    expect(fromThree(toThree(-7.5, 1234.25, 88))).toEqual({ x: -7.5, y: 1234.25, z: 88 });
  });

  it('turn an azimuth into a yaw that faces −Z north, +X east', () => {
    // Forward −Z rotated by yaw θ about +Y: (−sin θ, 0, −cos θ).
    const forward = (azimuth: number) => {
      const t = yawOf(azimuth);
      return [-Math.sin(t), -Math.cos(t)].map((v) => Math.round(v * 1e9) / 1e9 + 0);
    };
    expect(forward(0)).toEqual([0, -1]); // north
    expect(forward(Math.PI / 2)).toEqual([1, 0]); // east
    expect(forward(Math.PI)).toEqual([0, 1]); // south
    expect(forward((3 * Math.PI) / 2)).toEqual([-1, 0]); // west
  });
});

describe('the surroundings', () => {
  const terrain = createSyntheticTerrain(
    { originX: -50, originY: -30, cellSize: 10, columns: 11, rows: 7 },
    (x, y) => 100 + x / 10 + y / 5,
  );

  it('sit a little below most of the ground, whatever a few outliers do', () => {
    const z = apronElevation(terrain);
    const sorted = [...terrain.heightfield.elevations].sort((a, b) => a - b);
    expect(z).toBeLessThan(sorted[0] ?? 0);
    // A few samples hundreds of metres deep do not drag the apron down.
    const big = createSyntheticTerrain(
      { originX: 0, originY: 0, cellSize: 10, columns: 101, rows: 101 },
      () => 50,
    );
    const pit = {
      ...big,
      heightfield: {
        ...big.heightfield,
        elevations: big.heightfield.elevations.map((e, i) => (i % 2000 === 7 ? -782 : e)),
      },
    };
    expect(apronElevation(pit)).toBeGreaterThan(40);
    expect(apronElevation(pit)).toBeLessThan(50);
  });

  it('close the edge exactly: wall tops are the terrain edge vertices', () => {
    const base = apronElevation(terrain);
    const skirt = skirtMesh(terrain, base);
    const mesh = terrainMesh(terrain);
    const vertices = new Set<string>();
    for (let i = 0; i < mesh.vertexCount; i += 1)
      vertices.add([0, 1, 2].map((k) => mesh.positions[i * 3 + k]).join(','));
    const count = skirt.positions.length / 3;
    // Two vertices per boundary sample, on four sides (corners on two).
    expect(count).toBe(2 * (2 * 11 + 2 * 7));
    for (let i = 0; i < count; i += 2) {
      const top = [0, 1, 2].map((k) => skirt.positions[i * 3 + k]).join(',');
      expect(vertices.has(top)).toBe(true);
      expect(skirt.positions[(i + 1) * 3 + 1]).toBeCloseTo(base, 4);
    }
    expect(skirt.indices.length).toBe(6 * (2 * 10 + 2 * 6));
  });
});
