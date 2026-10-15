import { describe, expect, it } from 'vitest';
import { NO_FEATURES, pointProblem, rectangle, type SimWorld } from '#sim';
import { createLabRun, labTerrain, labTerrainFor } from './run';
import { runScenario, scenarioSpec } from './scenarios';
import { urbanFeatures, urbanKind } from './urban';

// The urban district: obstacles the Marines go round to reach their slots,
// and slots they cannot reach (in or against an obstacle) taken as close as
// they can get.

/** How many soldiers stand inside a building or water now. */
function inside(world: SimWorld, soldiers: readonly { position: { x: number; y: number } }[]) {
  return soldiers.filter((s) => {
    const p = pointProblem(world.terrain, s.position);
    return p?.kind === 'insideBuilding' || p?.kind === 'inWater';
  }).length;
}

describe('the urban district', () => {
  it('is the same for a seed, different for another, dense, and clear round the kept points', () => {
    const keepClear = [{ x: 0, y: 0 }];
    const a = urbanFeatures({ seed: 1, keepClear });
    expect(urbanFeatures({ seed: 1, keepClear })).toEqual(a);
    expect(urbanFeatures({ seed: 2, keepClear })).not.toEqual(a);
    expect(a.buildings.length).toBeGreaterThan(800);
    const kinds = new Set(a.buildings.map((b) => urbanKind(b.id)));
    expect([...kinds].sort()).toEqual(['building', 'car', 'container', 'house', 'shed', 'wall']);
    for (const b of a.buildings) {
      for (const p of b.footprint) expect(Math.hypot(p.x, p.y)).toBeGreaterThan(32 - 1e-9);
    }
  });
});

describe('moving through the district', () => {
  for (const [organization, id] of [
    ['squad', 's4-turn'],
    ['squad', 's5-waypoints'],
    ['element3', 's5-waypoints'],
  ] as const) {
    it(`${organization} ${id}: arrives, and nobody ever stands in a building`, () => {
      const run = createLabRun({
        ...scenarioSpec(id, { organization, seed: 3 }),
        terrain: 'urban',
      });
      expect(run.sim.world.terrain.features.buildings.length).toBeGreaterThan(800);
      let worst = 0;
      for (let i = 0; i < 900 * 30 && !run.done; i += 1) {
        run.step();
        worst = Math.max(worst, inside(run.sim.world, run.sim.state.soldiers));
      }
      expect(run.done).toBe(true);
      expect(run.sim.state.behavior?.tasks.at(-1)?.phase).toBe('complete');
      expect(worst).toBe(0);
    }, 120_000);
  }

  it('the scenario metrics: arrived, and the element without collisions', () => {
    const r = runScenario({
      ...scenarioSpec('s1-straight', { organization: 'element3', seed: 2 }),
      terrain: 'urban',
    });
    expect(r.metrics.outcome).toBe('arrived');
    expect(r.metrics.collisions).toBe(0);
  }, 60_000);

  it('a slot in a building: its Marine stands as close to it as he can, outside', () => {
    // Where one Marine ends on open ground; then a house on that spot.
    const spec = scenarioSpec('s1-straight', { organization: 'squad', seed: 1 });
    const open = runScenario(spec);
    const k = 6;
    const spot = open.run.sim.state.soldiers[k]?.position ?? { x: NaN, y: NaN };
    const house = {
      id: 'house:0',
      footprint: rectangle(spot.x, spot.y, 10, 10, 0),
      heightMeters: 6,
    };
    const run = createLabRun(spec, labTerrain({ ...NO_FEATURES, buildings: [house] }));
    for (let i = 0; i < 900 * 30 && !run.done; i += 1) run.step();
    expect(run.done).toBe(true);
    const p = run.sim.state.soldiers[k]?.position ?? { x: NaN, y: NaN };
    expect(inside(run.sim.world, run.sim.state.soldiers)).toBe(0);
    // Half the house, its clearance and a little: at its wall, not far off.
    expect(Math.max(Math.abs(p.x - spot.x), Math.abs(p.y - spot.y))).toBeLessThan(5 + 0.75 + 1.5);
    expect(Math.max(Math.abs(p.x - spot.x), Math.abs(p.y - spot.y))).toBeGreaterThan(5);
  }, 60_000);

  it('is bit-identical at 30 and 120 Hz', () => {
    const exact = (rate: number) => {
      const spec = {
        ...scenarioSpec('s4-turn', { organization: 'squad', tickRateHz: rate }),
        terrain: 'urban' as const,
      };
      const run = createLabRun(spec, labTerrainFor(spec));
      for (let i = 0; i < 90 * rate; i += 1) run.step();
      return JSON.stringify({ s: run.sim.state.soldiers, b: run.sim.state.behavior });
    };
    expect(exact(30)).toBe(exact(120));
  }, 60_000);
});
