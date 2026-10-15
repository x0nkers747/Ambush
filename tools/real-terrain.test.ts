import { describe, expect, it } from 'vitest';
import {
  addOrder,
  addSquad,
  battleSpecOf,
  createBattle,
  newBattleScenario,
} from '#exercise/battle';
import {
  battlefieldRequest,
  buildBattlefield,
  parseBattlefieldPackage,
  planBattlefield,
  TILE_SIZE,
  type ElevationTile,
} from '#geo';
import { heightAt, lineOfSight, planPath, pointProblem } from '#sim';
import { GRAFENWOEHR_OSM as grafenwoehr, QUANTICO_OSM as quantico } from '#geo/fixtures';

// End to end without the network (docs/adr/0014): recorded OpenStreetMap data
// for two real places, synthetic elevation tiles, a battlefield package and a
// battle that is fought on it.

/** Gently rolling synthetic elevation: real tiles are checked in the browser. */
function tilesFor(
  request: ReturnType<typeof battlefieldRequest>,
): (ElevationTile & { sources: string })[] {
  return planBattlefield(request).tiles.map((t) => {
    const e = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let j = 0; j < TILE_SIZE; j += 1) {
      for (let i = 0; i < TILE_SIZE; i += 1) {
        const gx = t.x * TILE_SIZE + i;
        const gy = t.y * TILE_SIZE + j;
        e[j * TILE_SIZE + i] = 100 + 8 * Math.sin(gx / 40) + 6 * Math.cos(gy / 55);
      }
    }
    return { ...t, elevations: e, sources: 'srtm/test.tif' };
  });
}

describe.each([
  ['Quantico, Virginia (US)', { lat: 38.5223, lon: -77.2934 }, quantico],
  ['Grafenwöhr, Bavaria (DE)', { lat: 49.717, lon: 11.906 }, grafenwoehr],
])('a real-world battlefield: %s', (name, centre, osm) => {
  // The recorded OSM covers 1 km.
  const request = battlefieldRequest(centre, { name, widthM: 1000 });
  const pkg = buildBattlefield({
    request,
    tiles: tilesFor(request),
    elevationUrlTemplate: 'https://example.test/{z}/{x}/{y}.png',
    osm,
    osmEndpoint: 'https://example.test/interpreter',
    createdAt: '2026-10-08T00:00:00Z',
  });

  it('round-trips through JSON as a saved package would', () => {
    expect(parseBattlefieldPackage(JSON.parse(JSON.stringify(pkg)))).toEqual(pkg);
  });

  it('takes a battle: squads placed clear of buildings and water, ordered and fought', () => {
    let d = newBattleScenario(pkg.terrain, pkg.id);
    const place = (side: 'BLUEFOR' | 'OPFOR', at: { x: number; y: number }) => {
      // Near `at`, the first spot the squad can be placed (its soldiers moved clear).
      for (let r = 0; r < 300; r += 10) {
        for (let k = 0; k < 12; k += 1) {
          const a = (k * Math.PI) / 6;
          const p = { x: at.x + r * Math.sin(a), y: at.y + r * Math.cos(a) };
          const edit = addSquad(pkg.terrain, d, side, 'squad', p);
          if (edit.ok) {
            d = edit.definition;
            return p;
          }
        }
      }
      throw new Error(`no ground for a ${side} squad near (${String(at.x)}, ${String(at.y)})`);
    };
    place('BLUEFOR', { x: 0, y: -250 });
    const enemy = place('OPFOR', { x: 0, y: 250 });
    const order = addOrder(pkg.terrain, d, 'B1', 'attack', enemy);
    if (!order.ok) throw new Error(order.problem);
    d = order.definition;
    const battle = createBattle(battleSpecOf(d, 30), pkg.terrain);
    for (const s of battle.sim.state.soldiers)
      expect(pointProblem(pkg.terrain, s.position)).toBeNull();
    while (battle.sim.timeSeconds < 120) battle.step();
    // Moving, on the ground, as the simulation has them.
    const b1 = battle.sim.state.soldiers.filter((s) => s.id.startsWith('B1-'));
    expect(b1).toHaveLength(13);
    for (const s of b1)
      expect(Number.isFinite(s.position.x + s.position.y + s.position.z)).toBe(true);
    // Terrain analysis works on it as on synthetic ground.
    const a = b1[0]?.position;
    if (!a) throw new Error('no soldier');
    expect(Number.isFinite(heightAt(pkg.terrain, a.x, a.y))).toBe(true);
    expect(typeof lineOfSight(pkg.terrain, a, { x: 0, y: 400 }).clear).toBe('boolean');
  });

  it('plans exactly the paths the original cell-by-cell navigation grid planned', () => {
    // Recorded before the 5 km navigation optimization (row-by-row rasterization,
    // obstacle index, connected areas): the optimized planner must not change a path.
    const key = name.startsWith('Quantico') ? 'quantico' : 'grafenwoehr';
    const points = (n: readonly number[]) =>
      Array.from({ length: n.length / 2 }, (_, i) => ({ x: n[2 * i] ?? 0, y: n[2 * i + 1] ?? 0 }));
    for (const path of RECORDED_PATHS[key]) {
      const [from, to, ...turns] = points(path);
      if (!from || !to) throw new Error('bad recorded path');
      expect(planPath(pkg.terrain, from, to)).toEqual({ ok: true, turns });
    }
  });
});

/**
 * From (x, y), to (x, y), then the turns planned between them, on the battlefields above,
 * as flat lists of map metres.
 */
const RECORDED_PATHS: Record<'quantico' | 'grafenwoehr', readonly (readonly number[])[]> = {
  quantico: [
    [-311, 181, -224, -300, -247, -113, -243, -235, -225, -265],
    [349, 93, 305, 321, 359, 119, 305, 267],
    [-231, -358, -339, -183, -289, -301, -305, -297, -363, -219],
    [479, -218, 216, 202, 423, -159, 385, -63, 281, 1, 259, 31, 243, 91, 217, 121, 221, 149],
    [-312, -212, 385, 140, 113, 63, 201, 147, 361, 153],
    [
      269, 395, 327, -274, 217, 117, 225, 87, 223, 67, 231, 45, 227, 21, 231, -39, 215, -69, 233,
      -103, 239, -149, 249, -165, 253, -189, 321, -261,
    ],
  ],
  grafenwoehr: [
    [
      -61, -387, -151, 371, -117, -221, -149, -183, -165, -177, -167, -157, -183, -149, -197, 45,
      -209, 63, -179, 343,
    ],
    [
      -311, 181, -224, -300, -323, 131, -313, 35, -301, -23, -293, -57, -279, -89, -269, -151, -265,
      -253,
    ],
    [349, 93, 305, 321, 305, 141, 309, 169, 295, 243],
    [-231, -358, -339, -183, -229, -319],
    [479, -218, 216, 202, 397, -127, 395, -43, 369, -27, 277, 81, 235, 145, 241, 185],
    [
      -312, -212, 385, 140, -243, -161, -225, -157, -177, -111, -85, -113, 17, -105, 39, -89, 173,
      -53, 237, 11, 247, 15, 251, 31, 281, 63, 311, 75, 325, 99, 357, 87, 385, 111,
    ],
  ],
};
