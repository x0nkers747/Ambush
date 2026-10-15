import {
  addOrder,
  addSquad,
  newBattleScenario,
  setSeed,
  setSquadFormation,
  type BattleEdit,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import {
  battlefieldRequest,
  buildBattlefield,
  planBattlefield,
  TILE_SIZE,
  type BattlefieldPackage,
  type BattlefieldRequest,
} from '#geo';

// Small battlefields for the scenario tests: 1 km, terrain only, on a
// plane whose slope (`rise`, metres per pixel eastward) stands for the
// source data. The same request and rise give the same battlefield (the
// same id); another rise is the same place with changed source data.

export function testRequest(
  lat = 38.5223,
  lon = -77.2934,
  name = 'Test ground',
): BattlefieldRequest {
  return battlefieldRequest({ lat, lon }, { name, widthM: 1000 });
}

export function testBattlefield(
  request: BattlefieldRequest = testRequest(),
  rise = 0.05,
  createdAt = '2026-10-08T12:00:00Z',
): BattlefieldPackage {
  const tiles = planBattlefield(request).tiles.map((t) => {
    const e = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let j = 0; j < TILE_SIZE; j += 1) {
      for (let k = 0; k < TILE_SIZE; k += 1)
        e[j * TILE_SIZE + k] = 20 + ((t.x * TILE_SIZE + k) % 1000) * rise;
    }
    return { ...t, elevations: e, sources: 'srtm/N38W078.tif' };
  });
  return buildBattlefield({
    request,
    tiles,
    elevationUrlTemplate: 'https://example.test/terrarium/{z}/{x}/{y}.png',
    osm: null,
    osmEndpoint: 'https://overpass.example.test/api/interpreter',
    createdAt,
  });
}

const apply = (d: BattleScenarioDefinition, edit: (d: BattleScenarioDefinition) => BattleEdit) => {
  const r = edit(d);
  if (!r.ok) throw new Error(r.problem);
  return r.definition;
};

/** Two squads a side, with formations and plans of every kind, and a seed. */
export function plannedScenario(
  pkg: BattlefieldPackage = testBattlefield(),
): BattleScenarioDefinition {
  let d = newBattleScenario(pkg.terrain, pkg.id, 'Woodland encounter');
  d = apply(d, (x) => addSquad(pkg.terrain, x, 'BLUEFOR', 'squad', { x: -200, y: -300 }));
  d = apply(d, (x) => addSquad(pkg.terrain, x, 'BLUEFOR', 'fireTeam', { x: 100, y: -300 }, 15));
  d = apply(d, (x) => addSquad(pkg.terrain, x, 'OPFOR', 'element3', { x: 0, y: 300 }));
  d = apply(d, (x) => addSquad(pkg.terrain, x, 'OPFOR', 'squad', { x: 250, y: 250 }, 200));
  d = apply(d, (x) => setSquadFormation(pkg.terrain, x, 'B1', 'usmc.squad.line'));
  d = apply(d, (x) => addOrder(pkg.terrain, x, 'B1', 'move', { x: -150, y: -100 }));
  d = apply(d, (x) => addOrder(pkg.terrain, x, 'B1', 'attack', { x: 0, y: 280 }));
  d = apply(d, (x) => addOrder(pkg.terrain, x, 'O1', 'withdraw', { x: 0, y: 450 }));
  d = apply(d, (x) => addOrder(pkg.terrain, x, 'O2', 'attack', { x: 100, y: -300 }));
  return apply(d, (x) => setSeed(x, 4242));
}
