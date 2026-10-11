import { describe, expect, it } from 'vitest';
import {
  buildingRoofElevations,
  createSimulation,
  gradeTerrain,
  hashSimState,
  lineOfSight,
  soldierId,
  waypointId,
  type Scenario,
  type SimEvent,
  type TerrainDataset,
} from '#sim';
import { DEMO_SCENARIO } from './demo-scenario';

// Building and road attributes kept for display (docs/adr/0035), and mapped
// roadside details (docs/adr/0036), must never reach the simulation: the same
// battlefield with and without them grades identically, has the same roofs
// for line of sight, gives the same sight lines, and runs to the same state,
// events and hash.

/** The demo battlefield with every display attribute set, some contradicting the simulated values. */
function decorated(terrain: TerrainDataset): TerrainDataset {
  return {
    ...terrain,
    metadata: { ...terrain.metadata, architecture: 'central-european' },
    // Roadside details (docs/adr/0036), some placed across roads and buildings.
    decor: {
      points: terrain.features.buildings.slice(0, 5).flatMap((b, i) => {
        const p = b.footprint[0] ?? { x: 0, y: 0 };
        return [
          { id: `lamp${String(i)}`, kind: 'streetLamp' as const, position: p },
          { id: `tree${String(i)}`, kind: 'tree' as const, position: { x: p.x + 3, y: p.y + 3 } },
        ];
      }),
      lines: terrain.features.roads.slice(0, 3).map((r, i) => ({
        id: `fence${String(i)}`,
        kind: 'fence' as const,
        points: r.centerline,
      })),
    },
    features: {
      ...terrain.features,
      buildings: terrain.features.buildings.map((b, i) => ({
        ...b,
        appearance: {
          kind: i % 2 ? 'house' : 'barn',
          levels: 3,
          heightMeters: b.heightMeters + 9,
          minHeightMeters: 1,
          roofShape: i % 3 ? 'gabled' : 'hipped',
          roofHeightMeters: 4,
          roofMaterial: 'roof_tiles',
          wallMaterial: 'brick',
          roofColour: '#aa3322',
          wallColour: '#eeeeee',
          country: 'DE',
        },
      })),
      roads: terrain.features.roads.map((r) => ({ ...r, highway: 'service', service: 'driveway' })),
    },
  } as TerrainDataset;
}

function run(scenario: Scenario) {
  const sim = createSimulation({ tickRateHz: 30, seed: 7 }, scenario);
  const soldier = scenario.soldiers[0];
  const target = scenario.terrain.features.buildings[0]?.footprint[0];
  if (!soldier || !target) throw new Error('the demo has soldiers and buildings');
  // Through the village, round and against buildings.
  sim.submit({
    type: 'setOrders',
    tick: 0,
    soldierId: soldierId(soldier.id),
    orders: {
      waypoints: [{ id: waypointId('W0'), x: target.x + 1, y: target.y + 1 }],
      finalFacing: 0,
    },
  });
  const events: SimEvent[] = [];
  for (let i = 0; i < 30 * 20; i += 1) events.push(...sim.step());
  return { hash: hashSimState(sim.state), events };
}

describe('display-only attributes', () => {
  const plain = DEMO_SCENARIO.terrain;
  const fancy = decorated(plain);

  it('leave grading and line-of-sight roofs exactly as they were', () => {
    expect(fancy.features.buildings.length).toBeGreaterThan(5);
    const a = gradeTerrain(plain);
    const b = gradeTerrain(fancy);
    expect(Array.from(b.heightfield.elevations)).toEqual(Array.from(a.heightfield.elevations));
    expect(b.grading).toEqual(a.grading);
    expect([...buildingRoofElevations(fancy)]).toEqual([...buildingRoofElevations(plain)]);
  });

  it('give the same sight lines', () => {
    const { originX, originY, cellSize, columns, rows } = plain.heightfield;
    let s = 99;
    const r = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
    const p = () => ({
      x: originX + r() * (columns - 1) * cellSize,
      y: originY + r() * (rows - 1) * cellSize,
    });
    for (let i = 0; i < 500; i += 1) {
      const from = p();
      const to = p();
      expect(lineOfSight(fancy, from, to)).toEqual(lineOfSight(plain, from, to));
    }
  });

  it('run to the same state, events and hash', () => {
    const a = run(DEMO_SCENARIO);
    const b = run({ ...DEMO_SCENARIO, terrain: fancy });
    expect(b.events).toEqual(a.events);
    expect(b.hash).toBe(a.hash);
  });
});
