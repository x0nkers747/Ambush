import { describe, expect, it } from 'vitest';
import { rectangle, type EnvironmentFeatures } from '../environment';
import type { Vec2 } from '../geometry';
import { navArea } from '../navigation';
import { createSyntheticTerrain, flatElevation } from '../synthetic-terrain';
import { nearestInArea } from './slots';

// `nearestInArea` skips the rings nearer than its area's nearest cell, which
// cannot reach it (docs/constructive-simulation/04: a hot spot of movement on
// real ground). The point it finds must be the full search's, exactly.

/** The full search, as before (the reference). */
function nearestInAreaFull(terrain: Parameters<typeof navArea>[0], p: Vec2, area: number) {
  for (let r = 0.5; r <= 30; r += 0.5) {
    const steps = Math.max(8, Math.ceil((2 * Math.PI * r) / 0.75));
    for (let k = 0; k < steps; k += 1) {
      const a = (2 * Math.PI * k) / steps;
      const q = { x: p.x + r * Math.sin(a), y: p.y + r * Math.cos(a) };
      if (navArea(terrain, q) === area) return q;
    }
  }
  return null;
}

function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('nearestInArea', () => {
  it('finds the point the full ring search finds, near buildings, water and enclosed yards', () => {
    const r = random(5);
    const buildings = Array.from({ length: 40 }, (_, i) => ({
      id: `b${String(i)}`,
      footprint: rectangle(
        -150 + r() * 300,
        -150 + r() * 300,
        8 + r() * 30,
        8 + r() * 30,
        r() * 90,
      ),
      heightMeters: 6,
    }));
    // A walled yard: four long buildings round an empty square (its own navigation area).
    const yard = [
      rectangle(120, 160, 60, 4),
      rectangle(120, 100, 60, 4),
      rectangle(92, 130, 4, 60),
      rectangle(148, 130, 4, 60),
    ].map((footprint, i) => ({ id: `wall${String(i)}`, footprint, heightMeters: 3 }));
    const features: EnvironmentFeatures = {
      roads: [],
      vegetation: [],
      buildings: [...buildings, ...yard],
      water: [{ id: 'pond', kind: 'water', boundary: rectangle(-120, 150, 70, 50, 20) }],
    };
    const terrain = createSyntheticTerrain(
      { originX: -200, originY: -200, cellSize: 20, columns: 21, rows: 21 },
      flatElevation(10),
      features,
    );
    const main = navArea(terrain, { x: -190, y: -190 });
    expect(main).toBeGreaterThan(0);
    const inYard = navArea(terrain, { x: 120, y: 130 });
    expect(inYard).toBeGreaterThan(0);
    expect(inYard).not.toBe(main);
    let found = 0;
    let none = 0;
    for (let k = 0; k < 1500; k += 1) {
      const p = { x: -190 + r() * 380, y: -190 + r() * 380 };
      for (const area of [main, inYard]) {
        const fast = nearestInArea(terrain, p, area);
        expect(fast).toEqual(nearestInAreaFull(terrain, p, area));
        if (fast) found += 1;
        else none += 1;
      }
    }
    expect(found).toBeGreaterThan(1000);
    expect(none).toBeGreaterThan(500);
  });
});
