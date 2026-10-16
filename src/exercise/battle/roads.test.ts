import { describe, expect, it } from 'vitest';
import { NO_FEATURES, type Vec2 } from '#sim';
import { labTerrain } from '../behavior-lab/run';
import { createBattle, type BattleSpec } from './battle';

// A move order's Prefer roads: to the nearest road, along the roads (a squad
// in column), and off them to its destination; a vehicle alike. A road runs
// east along y = 0 from x = −600, then north at x = 400. The destination is
// 25 m off the road's northern leg; the squad starts 150 m south of the road.

const TERRAIN = labTerrain({
  ...NO_FEATURES,
  roads: [
    {
      id: 'road',
      roadClass: 'paved',
      widthMeters: 6,
      centerline: [
        { x: -600, y: 0 },
        { x: 400, y: 0 },
        { x: 400, y: 600 },
      ],
    },
  ],
});
const START = { x: -300, y: -150 };
const TO = { x: 375, y: 400 };
const CORNER = { x: 400, y: 0 };

const spec = (followRoads: boolean): BattleSpec => ({
  seed: 1,
  tickRateHz: 30,
  substepHz: 30,
  squads: [
    {
      id: 'B1',
      name: 'Blue',
      side: 'BLUEFOR',
      organization: 'squad',
      position: START,
      facingDeg: 90,
      plan: [{ kind: 'move', destination: TO, ...(followRoads ? { followRoads: true } : {}) }],
    },
    // Far away, so nobody meets anybody.
    {
      id: 'O1',
      name: 'Red',
      side: 'OPFOR',
      organization: 'fireTeam',
      position: { x: -1000, y: 1000 },
      facingDeg: 0,
      plan: [],
    },
  ],
  vehicles: [
    {
      id: 'V1',
      name: 'M113',
      side: 'BLUEFOR',
      kind: 'm113',
      position: { x: -300, y: -300 },
      headingDeg: 90,
      destinations: [{ ...TO, ...(followRoads ? { followRoads: true } : {}) }],
    },
  ],
});

const near = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);

function drive(followRoads: boolean) {
  const battle = createBattle(spec(followRoads), TERRAIN);
  let squadByCorner = Infinity;
  let vehicleByCorner = Infinity;
  /** Across the road, how far apart the squad's soldiers were, at most, while all on its eastward stretch. */
  let widestOnRoad = 0;
  let topSpeed = 0;
  for (let k = 0; k < 30 * 1500; k += 1) {
    battle.step();
    if (k % 15 !== 0) continue;
    const soldiers = battle.sim.state.soldiers.filter((s) => s.unitId.startsWith('B1-'));
    const xs = soldiers.map((s) => s.position.x);
    const ys = soldiers.map((s) => s.position.y);
    const centre = {
      x: xs.reduce((a, b) => a + b, 0) / xs.length,
      y: ys.reduce((a, b) => a + b, 0) / ys.length,
    };
    squadByCorner = Math.min(squadByCorner, near(centre, CORNER));
    if (
      soldiers.every(
        (s) => Math.abs(s.position.y) < 30 && s.position.x > -250 && s.position.x < 350,
      )
    )
      widestOnRoad = Math.max(widestOnRoad, Math.max(...ys) - Math.min(...ys));
    const v = battle.sim.state.vehicles?.[0];
    if (v) {
      vehicleByCorner = Math.min(vehicleByCorner, near(v.position, CORNER));
      topSpeed = Math.max(topSpeed, v.speed);
    }
  }
  const force = battle.sim.state.fof?.forces.find((f) => f.unitId.startsWith('B1-'));
  const vehicle = battle.sim.state.vehicles?.[0];
  return { battle, force, vehicle, squadByCorner, vehicleByCorner, widestOnRoad, topSpeed };
}

describe('Prefer roads', { timeout: 300_000 }, () => {
  const byRoad = drive(true);
  const straight = drive(false);

  it('takes a squad to the road, along it in column, and off it to its destination', () => {
    // By the corner of the road, not across the fields.
    expect(byRoad.squadByCorner).toBeLessThan(30);
    expect(straight.squadByCorner).toBeGreaterThan(150);
    // On the road it marches in column: a few metres across, not its wedge.
    expect(byRoad.widestOnRoad).toBeGreaterThan(0);
    expect(byRoad.widestOnRoad).toBeLessThan(10);
    // It arrives, its order done, and the road move is over.
    expect(byRoad.force?.orders[0]?.status).toBe('completed');
    expect(byRoad.force?.roadMove).toBeUndefined();
  });

  it('drives a vehicle along the road, at road speed', () => {
    expect(byRoad.vehicleByCorner).toBeLessThan(10);
    expect(straight.vehicleByCorner).toBeGreaterThan(150);
    expect(byRoad.topSpeed).toBeGreaterThan(12);
    expect(byRoad.vehicle?.orders[0]?.status).toBe('completed');
    expect(near(byRoad.vehicle?.position ?? { x: 0, y: 0 }, TO)).toBeLessThan(2);
  });
});
