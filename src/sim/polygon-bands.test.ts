import { describe, expect, it } from 'vitest';
import type { Vec2 } from './geometry';
import { isSegmentWalkable, pointProblem, withoutClearRadius } from './navigation';
import { rectangle } from './environment';
import { createSyntheticTerrain, flatElevation } from './synthetic-terrain';
import {
  isOnPolygonBoundary,
  pointInPolygon,
  polygonBands,
  segmentIntersectionParams,
} from './polygon';

// Large polygons (a river, a lake shore: thousands of vertices) are tested on
// their edge bands (`polygonBands`) instead of edge by edge. The bands only
// skip edges that cannot change the answer, so every answer must be the
// whole scan's: these tests compare the two on points and segments chosen to
// hit vertices, edges, horizontal edges and band boundaries.

/** The whole-scan test, as before the bands (the reference). */
function pointInPolygonScan(p: Vec2, vertices: readonly Vec2[]): boolean {
  if (isOnPolygonBoundary(p, vertices)) return true;
  let inside = false;
  const n = vertices.length;
  for (let i = 0; i < n; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    if (!a || !b) continue;
    if (a.y > p.y !== b.y > p.y) {
      const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x > p.x) inside = !inside;
    }
  }
  return inside;
}

/** A seeded generator in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * A long, winding river-like polygon: two banks of `n` vertices each,
 * jittered, with stretches of horizontal edges and vertices on whole and
 * eighth metres (the band height is 8 m).
 */
function river(n: number, seed: number): Vec2[] {
  const r = random(seed);
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < n; i += 1) {
    const y = i * 6 + (i % 7 === 0 ? 0 : Math.round(r() * 40) / 8);
    const centre = 60 * Math.sin(i / 25) + Math.round(r() * 16) / 2;
    const width = 20 + 15 * Math.sin(i / 11) ** 2;
    const flat = i % 13 === 5; // the same height as the next vertex: a horizontal edge
    const yy = flat ? Math.floor(y) : y;
    left.push({ x: centre - width, y: yy });
    right.push({ x: centre + width, y: flat ? Math.floor(y) : y + Math.round(r() * 8) / 8 });
  }
  return [...left, ...right.reverse()];
}

describe('banded point-in-polygon', () => {
  it('builds bands for large polygons only', () => {
    expect(polygonBands(river(10, 1))).toBeNull();
    const bands = polygonBands(river(400, 1));
    expect(bands?.count).toBeGreaterThan(100);
    expect(polygonBands(river(400, 1))).not.toBe(bands); // per vertex array
  });

  it('answers as the whole scan does, on random points, vertices, edge points and band boundaries', () => {
    for (const seed of [1, 2, 3]) {
      const poly = river(500, seed);
      const r = random(seed + 100);
      const points: Vec2[] = [];
      for (let k = 0; k < 4000; k += 1) points.push({ x: -120 + r() * 240, y: -20 + r() * 3080 });
      // Vertices, edge midpoints and points on band boundaries (multiples of 8 m from the lowest vertex).
      const minY = Math.min(...poly.map((v) => v.y));
      poly.forEach((v, i) => {
        const w = poly[(i + 1) % poly.length] ?? v;
        points.push(v, { x: (v.x + w.x) / 2, y: (v.y + w.y) / 2 });
        points.push({ x: v.x + 0.5, y: minY + 8 * Math.round((v.y - minY) / 8) });
        points.push({ x: v.x - 3, y: v.y }, { x: v.x + 3, y: v.y });
      });
      let mismatches = 0;
      let inside = 0;
      for (const p of points) {
        const banded = pointInPolygon(p, poly);
        if (banded !== pointInPolygonScan(p, poly)) mismatches += 1;
        if (banded) inside += 1;
      }
      expect(mismatches).toBe(0);
      expect(inside).toBeGreaterThan(1000);
    }
  });
});

describe('banded segment tests', () => {
  it('a segment is walkable across a large water polygon exactly as the whole scan says', () => {
    const poly = river(500, 7).map((v) => ({ x: v.x, y: v.y - 1500 }));
    const terrain = createSyntheticTerrain(
      { originX: -400, originY: -1600, cellSize: 20, columns: 41, rows: 161 },
      flatElevation(10),
      {
        roads: [],
        buildings: [],
        vegetation: [],
        water: [{ id: 'river', kind: 'water', boundary: poly }],
      },
    );
    const r = random(9);
    let mismatches = 0;
    let blocked = 0;
    for (let k = 0; k < 3000; k += 1) {
      const a = { x: -300 + r() * 600, y: -1500 + r() * 3000 };
      const len = r() < 0.5 ? r() * 10 : r() * 200;
      const t = r() * 2 * Math.PI;
      const b = { x: a.x + len * Math.sin(t), y: a.y + len * Math.cos(t) };
      if (Math.abs(b.x) > 390 || b.y < -1590 || b.y > 1590) continue;
      const scan =
        !pointInPolygonScan(a, poly) &&
        !pointInPolygonScan(b, poly) &&
        poly.every((p, i) => {
          const q = poly[(i + 1) % poly.length] ?? p;
          return segmentIntersectionParams(a, b, p, q).length === 0;
        });
      const walkable = isSegmentWalkable(terrain, a, b);
      if (walkable !== scan) mismatches += 1;
      if (!walkable) blocked += 1;
    }
    expect(mismatches).toBe(0);
    expect(blocked).toBeGreaterThan(300);
  });
});

describe('the clear radius', () => {
  it('changes no answer of pointProblem or isSegmentWalkable, round buildings, water and open ground', () => {
    const r = random(21);
    const buildings = Array.from({ length: 60 }, (_, i) => ({
      id: `b${String(i)}`,
      footprint: rectangle(
        -300 + r() * 600,
        -300 + r() * 600,
        6 + r() * 30,
        6 + r() * 30,
        r() * 90,
      ),
      heightMeters: 6,
    }));
    const terrain = createSyntheticTerrain(
      { originX: -400, originY: -400, cellSize: 20, columns: 41, rows: 41 },
      flatElevation(10),
      {
        roads: [],
        vegetation: [],
        buildings,
        water: [
          {
            id: 'river',
            kind: 'water',
            boundary: river(120, 4).map((v) => ({ x: v.x + 250, y: v.y - 350 })),
          },
        ],
      },
    );
    let mismatches = 0;
    let clear = 0;
    for (let k = 0; k < 20000; k += 1) {
      const a = { x: -395 + r() * 790, y: -395 + r() * 790 };
      const len = r() < 0.7 ? r() * 3 : r() * 40;
      const t = r() * 2 * Math.PI;
      const b = { x: a.x + len * Math.sin(t), y: a.y + len * Math.cos(t) };
      const fast = [JSON.stringify(pointProblem(terrain, a)), isSegmentWalkable(terrain, a, b)];
      const exact = withoutClearRadius(() => [
        JSON.stringify(pointProblem(terrain, a)),
        isSegmentWalkable(terrain, a, b),
      ]);
      if (fast[0] !== exact[0] || fast[1] !== exact[1]) mismatches += 1;
      if (exact[1]) clear += 1;
    }
    expect(mismatches).toBe(0);
    expect(clear).toBeGreaterThan(5000);
    expect(clear).toBeLessThan(19000);
  });
});
