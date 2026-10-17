import { describe, expect, it } from 'vitest';
import { labTerrain } from '#exercise/behavior-lab';
import { NO_FEATURES, rectangle } from '#sim';
import {
  addOrder,
  addSquad,
  newBattleScenario,
  orderSpecOf,
  parseBattleScenario,
  setOrderFollowRoads,
  setOrderKind,
  withoutOrders,
  type BattleEdit,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import { battleNextBlocker, createPlanner, type BattleStage } from './planner';

// The battle planner (docs/constructive-simulation/03): the rules of Scenario
// Setup and Planning that the map editor and the side panel use, in
// both the 2D and the 3D view.

const terrain = labTerrain();
const done = (edit: BattleEdit): BattleScenarioDefinition => {
  if (!edit.ok) throw new Error(edit.problem);
  return edit.definition;
};

function twoSides(): BattleScenarioDefinition {
  let d = newBattleScenario(terrain, 'bf');
  d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: 0, y: -400 }));
  d = done(addSquad(terrain, d, 'OPFOR', 'fireTeam', { x: 0, y: 400 }));
  return d;
}

function planner(stage: BattleStage, definition = twoSides()) {
  const saved: BattleScenarioDefinition[] = [];
  const notices: string[] = [];
  const p = createPlanner({
    terrain,
    definition,
    stage,
    save: (d) => {
      saved.push(d);
      return Promise.resolve();
    },
    notify: (m) => notices.push(m),
  });
  return { p, saved, notices };
}

describe('Scenario Setup', () => {
  it('places squads with the place tool, one per click, selecting each', () => {
    const { p, saved } = planner('scenario', newBattleScenario(terrain, 'bf'));
    p.setTool({ kind: 'place', side: 'OPFOR', organization: 'element3' });
    p.click({ x: 100, y: 300 });
    p.click({ x: -100, y: 300 });
    expect(p.definition.squads.map((s) => s.id)).toEqual(['O1', 'O2']);
    expect(p.selection).toEqual({ squadId: 'O2', orderIndex: null });
    expect(saved).toHaveLength(2);
  });

  it('gives no orders: they are given in Planning', () => {
    const { p, notices } = planner('scenario');
    for (const id of ['B1', 'O1']) {
      p.select(id);
      p.setTool({ kind: 'order', order: 'move' });
      p.click({ x: 0, y: 0 });
      expect(p.squad(id)?.plan).toEqual([]);
      expect(p.canPlan(p.squad(id))).toBe(false);
    }
    expect(notices).toEqual(['Orders are given in Planning.', 'Orders are given in Planning.']);
  });

  it('gives either side its orders in Planning, each click after the selected order', () => {
    const { p } = planner('bluefor');
    p.select('O1');
    p.setTool({ kind: 'order', order: 'move' });
    p.click({ x: 0, y: 200 });
    p.click({ x: 0, y: 0 });
    // Insert after order 1.
    p.select('O1', 0);
    p.setTool({ kind: 'order', order: 'attack' });
    p.click({ x: 100, y: 100 });
    expect(p.squad('O1')?.plan.map((o) => o.kind)).toEqual(['move', 'attack', 'move']);
    expect(p.selection).toEqual({ squadId: 'O1', orderIndex: 1 });
  });

  it('moves, turns and deletes squads; drags are saved when they end', () => {
    const { p, saved } = planner('scenario');
    expect(p.moveSquadTo('B1', { x: 10, y: -400 }, false)).toBe(true);
    expect(p.moveSquadTo('B1', { x: 20, y: -400 }, false)).toBe(true);
    expect(saved).toHaveLength(0);
    p.commit();
    expect(saved.at(-1)?.squads[0]?.position).toEqual({ east: 20, north: -400 });
    p.turnSquadToward('B1', { x: 120, y: -400 }, true);
    expect(p.squad('B1')?.facingDeg).toBe(90);
    p.select('B1');
    p.removeSquad('B1');
    expect(p.definition.squads.map((s) => s.id)).toEqual(['O1']);
    expect(p.selection.squadId).toBeNull();
  });

  it('moves the soldiers of a squad dragged against a building out of it, saying so when the drag ends', () => {
    const built = labTerrain({
      ...NO_FEATURES,
      buildings: [{ id: 'house', footprint: rectangle(200, 200, 40, 40), heightMeters: 8 }],
    });
    let d = newBattleScenario(built, 'bf');
    d = done(addSquad(built, d, 'BLUEFOR', 'squad', { x: 0, y: 0 }));
    const notices: string[] = [];
    const p = createPlanner({
      terrain: built,
      definition: d,
      stage: 'scenario',
      save: () => Promise.resolve(),
      notify: (m) => notices.push(m),
    });
    expect(p.moveSquadTo('B1', { x: 200, y: 165 }, false)).toBe(true);
    expect(notices).toEqual([]);
    p.commit();
    expect(notices).toEqual([
      expect.stringMatching(
        /^\d+ of 1st Squad's soldiers? (was|were) moved clear of the buildings\.$/,
      ),
    ]);
    // One side alone may be played.
    expect(p.issues()).toEqual([]);
  });

  it('refuses an edit with its reason and changes nothing', () => {
    const { p, notices, saved } = planner('scenario');
    const before = p.definition;
    expect(p.moveSquadTo('B1', { x: 9000, y: 0 }, true)).toBe(false);
    expect(p.definition).toBe(before);
    expect(saved).toHaveLength(0);
    expect(notices).toEqual(['A squad must be on the map.']);
  });
});

describe('Planning', () => {
  it('starts on a BLUEFOR squad and plans both sides', () => {
    const { p, notices } = planner('scenario');
    p.select('O1');
    p.setStage('bluefor');
    expect(p.selection.squadId).toBe('B1');
    p.setTool({ kind: 'order', order: 'move' });
    p.click({ x: 0, y: -200 });
    p.setTool({ kind: 'order', order: 'withdraw' });
    p.click({ x: 0, y: -600 });
    expect(p.squad('B1')?.plan.map((o) => o.kind)).toEqual(['move', 'withdraw']);
    p.select('O1');
    p.click({ x: 0, y: 0 });
    expect(p.squad('O1')?.plan.map((o) => o.kind)).toEqual(['withdraw']);
    expect(notices).toEqual([]);
  });

  it('cannot place, move or delete squads', () => {
    const { p } = planner('bluefor');
    p.setTool({ kind: 'place', side: 'BLUEFOR', organization: 'squad' });
    expect(p.tool.kind).toBe('select');
    expect(p.moveSquadTo('B1', { x: 50, y: -400 }, true)).toBe(false);
    p.removeSquad('B1');
    expect(p.definition.squads).toHaveLength(2);
    // Turning squads (either side's) is part of the plan.
    expect(p.turnSquadToward('B1', { x: 0, y: 0 }, true)).toBe(true);
    expect(p.turnSquadToward('O1', { x: 0, y: 0 }, true)).toBe(true);
  });

  it('removes an order and selects the one before it', () => {
    let d = twoSides();
    d = done(addOrder(terrain, d, 'B1', 'move', { x: 0, y: -300 }));
    d = done(addOrder(terrain, d, 'B1', 'attack', { x: 0, y: 300 }));
    const { p } = planner('bluefor', d);
    p.removeOrder('B1', 1);
    expect(p.squad('B1')?.plan.map((o) => o.kind)).toEqual(['move']);
    expect(p.selection).toEqual({ squadId: 'B1', orderIndex: 0 });
  });
});

describe('Setup selection', () => {
  it('lets go of the selection when a Place tool is chosen', () => {
    const { p } = planner('scenario');
    p.select('B1');
    expect(p.selection.squadId).toBe('B1');
    p.setTool({ kind: 'place', side: 'OPFOR', organization: 'squad' });
    expect(p.selection).toEqual({ squadId: null, orderIndex: null });
    p.select('B1');
    p.setTool({ kind: 'placeVehicle', side: 'BLUEFOR', vehicle: 'm1a1' });
    expect(p.selectedSquad).toBeUndefined();
  });

  it('back in Setup without orders: withoutOrders clears plans and routes, starts kept', () => {
    const given = addOrder(terrain, twoSides(), 'B1', 'move', { x: 0, y: 0 });
    if (!given.ok) throw new Error(given.problem);
    const d = given.definition;
    const cleared = withoutOrders(d);
    expect(d.squads.some((s) => s.plan.length > 0)).toBe(true);
    expect(cleared.squads.every((s) => s.plan.length === 0)).toBe(true);
    expect(cleared.squads.map((s) => s.position)).toEqual(d.squads.map((s) => s.position));
  });
});

describe('the stage gates', () => {
  it('Setup needs one unit, and every squad placed validly', () => {
    const empty = planner('scenario', newBattleScenario(terrain, 'bf')).p;
    expect(empty.rules.next('scenario')).toBe('Place at least one unit.');
    const { p } = planner('scenario');
    expect(p.rules.next('scenario')).toBeNull();
    expect(p.rules.next('bluefor')).toBeNull();
    expect(p.rules.back('scenario')).toBeNull();
  });

  it('an order problem blocks planning, not setup', () => {
    const d = twoSides();
    const bad: BattleScenarioDefinition = {
      ...d,
      squads: d.squads.map((s) =>
        s.id === 'B1'
          ? { ...s, plan: [{ kind: 'move', destination: { east: 9000, north: 0 } }] }
          : s,
      ),
    };
    const { p } = planner('scenario', bad);
    expect(battleNextBlocker('scenario', p.issues())).toBeNull();
    expect(battleNextBlocker('bluefor', p.issues())).toMatch(/destination must be on the map/);
    expect(battleNextBlocker('combat', p.issues())).toMatch(/End the combat first/);
  });
});

describe('what the views show', () => {
  it('every soldier where it starts, and the battle’s starting state for the 3D figures', () => {
    const { p } = planner('scenario');
    const soldiers = p.soldiers();
    expect(soldiers.filter((s) => s.squadId === 'B1')).toHaveLength(13);
    expect(soldiers.filter((s) => s.squadId === 'O1')).toHaveLength(4);
    const figures = p.figures();
    expect(figures.soldiers.map((s) => s.id)).toEqual(soldiers.map((s) => s.id));
    expect(figures.log.indexOf(soldiers[0]?.id ?? '')).toBeGreaterThanOrEqual(0);
    expect(Object.values(figures.weapons).filter((w) => w === 'ak-assault-rifle')).toHaveLength(4);
    // Memoized per scenario.
    expect(p.figures()).toBe(figures);
    p.moveSquadTo('B1', { x: 30, y: -400 }, true);
    expect(p.figures()).not.toBe(figures);
  });
});

describe('moves and Prefer roads', () => {
  // A road west to east at y = 250, turning south at x = 300.
  const roads = labTerrain({
    ...NO_FEATURES,
    roads: [
      {
        id: 'r1',
        roadClass: 'unpaved',
        widthMeters: 6,
        centerline: [
          { x: -400, y: 250 },
          { x: 300, y: 250 },
          { x: 300, y: -100 },
        ],
      },
    ],
  });
  const make = (stage: BattleStage) => {
    let d = newBattleScenario(roads, 'bf');
    d = done(addSquad(roads, d, 'BLUEFOR', 'squad', { x: 0, y: -400 }));
    d = done(addSquad(roads, d, 'OPFOR', 'fireTeam', { x: 0, y: 400 }));
    const notices: string[] = [];
    const p = createPlanner({
      terrain: roads,
      definition: d,
      stage,
      save: () => Promise.resolve(),
      notify: (m) => notices.push(m),
    });
    return { p, notices };
  };
  const plan = (p: ReturnType<typeof createPlanner>, id: string) =>
    p.definition.squads
      .find((s) => s.id === id)
      ?.plan.map((o) => [o.kind, Math.round(o.destination.east), Math.round(o.destination.north)]);

  it('a move is one order, to the point clicked, whatever the side or the road', () => {
    const { p, notices } = make('bluefor');
    p.select('O1');
    p.setTool({ kind: 'order', order: 'move' });
    p.click({ x: 300, y: -50 });
    expect(plan(p, 'O1')).toEqual([['move', 300, -50]]);
    expect(notices).toEqual([]);
    expect(p.selection.orderIndex).toBe(0);
  });

  it('Prefer roads: switched on for a move order (and its vehicle waypoints), saved, given to the battle', () => {
    const { p } = make('bluefor');
    p.select('O1');
    p.setTool({ kind: 'order', order: 'move' });
    p.click({ x: 300, y: -50 });
    expect(p.edit((d) => setOrderFollowRoads(d, 'O1', 0, true))).toBe(true);
    const order = p.squad('O1')?.plan[0];
    expect(order?.followRoads).toBe(true);
    expect(
      orderSpecOf(order ?? { kind: 'move', destination: { east: 0, north: 0 } }),
    ).toMatchObject({ kind: 'move', followRoads: true });
    // Only a move order prefers roads; another kind drops it.
    expect(p.edit((d) => setOrderKind(d, 'O1', 0, 'attack'))).toBe(true);
    expect(p.squad('O1')?.plan[0]?.followRoads).toBeUndefined();
    expect(p.edit((d) => setOrderFollowRoads(d, 'O1', 0, true))).toBe(false);
    // Read back from the file as it was saved.
    p.edit((d) => setOrderKind(d, 'O1', 0, 'move'));
    p.edit((d) => setOrderFollowRoads(d, 'O1', 0, true));
    expect(parseBattleScenario(JSON.parse(JSON.stringify(p.definition)))).toEqual(p.definition);
  });
});

describe('the 3D view’s figures', () => {
  it('are none on a new battlefield with no squads (no battle can be built yet)', () => {
    const { p } = planner('scenario', newBattleScenario(terrain, 'bf'));
    expect(p.figures().soldiers).toEqual([]);
    expect(planner('scenario').p.figures().soldiers).toHaveLength(17);
  });

  it('are built again only when the soldiers’ starts change, not for a plan’s edits', () => {
    const { p } = planner('scenario');
    const first = p.figures();
    p.select('O1');
    p.setTool({ kind: 'order', order: 'move' });
    p.click({ x: 0, y: 200 });
    p.moveOrderTo('O1', 0, { x: 50, y: 150 }, false);
    expect(p.figures()).toBe(first);
    p.moveSquadTo('O1', { x: 20, y: 420 }, false);
    expect(p.figures()).not.toBe(first);
  });
});

describe('viewsheds turned on', () => {
  it('any number, either side; they follow their orders as orders are added, moved and deleted', () => {
    const { p } = planner('bluefor');
    p.select('O1');
    p.setTool({ kind: 'order', order: 'move' });
    for (const y of [300, 200, 100]) p.click({ x: 0, y });
    const pins = () => p.viewsheds().map((v) => `${v.unitId}:${String(v.orderIndex)}`);
    expect(p.toggleViewshed('O1', 1)).toBe(true);
    expect(p.toggleViewshed('B1', null)).toBe(true);
    expect(p.toggleViewshed('O1', 2)).toBe(true);
    expect(pins()).toEqual(['O1:1', 'B1:null', 'O1:2']);
    // Off again.
    expect(p.toggleViewshed('O1', 2)).toBe(false);
    expect(p.hasViewshed('O1', 2)).toBe(false);
    // An order put in before it: it moves down with its order.
    p.select('O1', 0);
    p.click({ x: 50, y: 250 });
    expect(pins()).toEqual(['O1:2', 'B1:null']);
    // Moved earlier: it goes with it.
    expect(p.moveOrder('O1', 2, -1)).toBe(true);
    expect(pins()).toEqual(['O1:1', 'B1:null']);
    // An earlier order deleted: it moves up; its own deleted: it goes.
    p.removeOrder('O1', 0);
    expect(pins()).toEqual(['O1:0', 'B1:null']);
    p.removeOrder('O1', 0);
    expect(pins()).toEqual(['B1:null']);
    // No such order or squad: nothing turned on.
    expect(p.toggleViewshed('O1', 9)).toBe(false);
    expect(p.toggleViewshed('X1', null)).toBe(false);
    // The squad deleted (in Setup): its viewsheds go with it.
    p.setStage('scenario');
    p.removeSquad('B1');
    expect(pins()).toEqual([]);
  });

  it('a vehicle’s too, from its start or a waypoint, following its route; waypoint rings likewise', () => {
    const setup = planner('scenario');
    setup.p.setTool({ kind: 'placeVehicle', side: 'BLUEFOR' });
    setup.p.click({ x: -100, y: -300 });
    const { p } = planner('bluefor', setup.p.definition);
    p.selectVehicle('V1');
    p.setTool({ kind: 'order', order: 'move' });
    p.click({ x: -100, y: -100 });
    p.click({ x: 100, y: -100 });
    const pins = () => p.viewsheds().map((v) => `${v.unitId}:${String(v.orderIndex)}`);
    const rings = () => p.waypointRings().map((v) => `${v.unitId}:${String(v.orderIndex)}`);
    expect(p.toggleViewshed('V1', null)).toBe(true);
    expect(p.toggleViewshed('V1', 1)).toBe(true);
    expect(p.toggleWaypointRings('V1', 1)).toBe(true);
    expect(p.hasWaypointRings('V1', 1)).toBe(true);
    // Rings and viewsheds are kept apart.
    expect(pins()).toEqual(['V1:null', 'V1:1']);
    expect(rings()).toEqual(['V1:1']);
    // A waypoint put in before: they move down with theirs.
    p.selectVehicle('V1', 0);
    p.click({ x: 0, y: -200 });
    expect(pins()).toEqual(['V1:null', 'V1:2']);
    expect(rings()).toEqual(['V1:2']);
    // It deleted: they move up; their own deleted: they go.
    p.removeVehicleWaypoint('V1', 1);
    expect(pins()).toEqual(['V1:null', 'V1:1']);
    p.removeVehicleWaypoint('V1', 1);
    expect(pins()).toEqual(['V1:null']);
    expect(rings()).toEqual([]);
    // No such waypoint: nothing turned on.
    expect(p.toggleWaypointRings('V1', 5)).toBe(false);
  });
});

describe('a defend order', () => {
  it('its position, then a second click for its direction; K arms that click again', () => {
    const { p } = planner('bluefor');
    p.select('B1');
    p.setTool({ kind: 'order', order: 'defend' });
    p.click({ x: 0, y: -300 });
    expect(p.tool).toEqual({ kind: 'sector' });
    p.click({ x: 0, y: -200 });
    const order = p.definition.squads.find((s) => s.id === 'B1')?.plan[0];
    expect(order?.kind).toBe('defend');
    expect(order?.sector?.facingDeg).toBeCloseTo(0, 6);
    expect(p.tool).toEqual({ kind: 'select' });
    expect(p.armKillZone()).toBe(true);
    expect(p.tool).toEqual({ kind: 'sector' });
    // Its handle widens the arc.
    p.resizeDefendArcTo('B1', 0, { x: 100, y: -300 }, true);
    expect(p.definition.squads.find((s) => s.id === 'B1')?.plan[0]?.sector?.arcDeg).toBeCloseTo(
      180,
      6,
    );
    // Its facing handle turns it round the position, keeping the arc.
    expect(p.turnDefendTo('B1', 0, { x: -100, y: -300 }, true)).toBe(true);
    const turned = p.definition.squads.find((s) => s.id === 'B1')?.plan[0]?.sector;
    expect(turned?.facingDeg).toBeCloseTo(270, 6);
    expect(turned?.arcDeg).toBeCloseTo(180, 6);
  });
});

describe('vehicles (docs/vehicles.md)', () => {
  it('places a vehicle in Scenario Setup; its route is given in Planning, one waypoint per click', () => {
    const setup = planner('scenario');
    setup.p.setTool({ kind: 'placeVehicle', side: 'BLUEFOR' });
    setup.p.click({ x: -100, y: -300 });
    expect(setup.p.selection).toEqual({ squadId: null, orderIndex: null, vehicleId: 'V1' });
    // Placed, the Select tool: it can be dragged and turned, but not routed in Setup.
    expect(setup.p.tool).toEqual({ kind: 'select' });
    expect(setup.p.canRoute(setup.p.selectedVehicle)).toBe(false);
    setup.p.setTool({ kind: 'order', order: 'move' });
    setup.p.click({ x: -100, y: -100 });
    expect(setup.p.selectedVehicle?.route).toEqual([]);
    expect(setup.notices.at(-1)).toBe('Orders are given in Planning.');
    const { p, saved } = planner('bluefor', setup.p.definition);
    p.selectVehicle('V1');
    p.setTool({ kind: 'order', order: 'move' });
    p.click({ x: -100, y: -100 });
    p.click({ x: 100, y: -100 });
    p.selectVehicle('V1', 0);
    p.click({ x: 0, y: -200 });
    expect(p.selectedVehicle?.route).toEqual([
      { east: -100, north: -100 },
      { east: 0, north: -200 },
      { east: 100, north: -100 },
    ]);
    expect(p.selection.orderIndex).toBe(1);
    expect(saved).toHaveLength(3);
  });

  it('refuses other orders for a vehicle, and edits its route in Planning, not its place', () => {
    const setup = planner('scenario');
    setup.p.setTool({ kind: 'placeVehicle', side: 'OPFOR' });
    setup.p.click({ x: -100, y: 300 });
    const { p, notices } = planner('bluefor', setup.p.definition);
    p.selectVehicle('V1');
    p.setTool({ kind: 'order', order: 'attack' });
    p.click({ x: 0, y: 0 });
    expect(notices.at(-1)).toMatch(/only takes Move orders/);
    // Either side's vehicle is routed in Planning.
    expect(p.canRoute(p.selectedVehicle)).toBe(true);
    expect(p.moveVehicleTo('V1', { x: 0, y: 0 }, true)).toBe(false);
    p.setTool({ kind: 'order', order: 'move' });
    p.click({ x: -100, y: 100 });
    expect(p.selectedVehicle?.route).toHaveLength(1);
    expect(p.moveVehicleWaypointTo('V1', 0, { x: -50, y: 100 }, true)).toBe(true);
    p.removeVehicleWaypoint('V1', 0);
    expect(p.selectedVehicle?.route).toEqual([]);
    // The vehicle stands in the 3D view's start figures.
    expect(p.figures().vehicles.map((v) => v.id)).toEqual(['V1']);
    // Selecting a squad leaves the vehicle.
    p.select('B1');
    expect(p.selectedVehicle).toBeUndefined();
  });
});
