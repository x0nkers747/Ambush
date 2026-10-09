import { describe, expect, it } from 'vitest';
import type { SimCommand } from './commands';
import { rectangle, type Building, type EnvironmentFeatures } from './environment';
import type { SimEvent } from './events';
import { azimuthOf } from './geometry';
import { fingerprintWorld, hashSimState } from './hash';
import { pointInPolygon } from './polygon';
import { createWorld, type Scenario } from './scenario';
import { createSimulation, type Simulation } from './simulation';
import { soldierId, waypointId, type SimState } from './state';
import {
  combatScenario,
  TEST_COMBAT_CONFIG,
  TEST_RIFLE,
  testCombatConfig,
  type TestCombatant,
} from './test-combat';
import { TEST_SCENARIO } from './test-scenario';

// Combat v1 (docs/adr/0019): engagements, OPFOR reactions, two-sided fire,
// timing, termination and determinism, on small flat test battlefields.

type EventOf<T extends SimEvent['type']> = Extract<SimEvent, { type: T }>;
const ofType = <T extends SimEvent['type']>(events: readonly SimEvent[], type: T): EventOf<T>[] =>
  events.filter((e): e is EventOf<T> => e.type === type);

/** A rifle that never incapacitates: hits leave everyone in place. */
const RIFLE_NO_INCAP = {
  ...TEST_RIFLE,
  weaponProfileRef: 'rifle0',
  incapacitationProbabilityOnHit: 0,
};
/** Always hits and incapacitates, firing every 1.5 s. */
const SURE = TEST_COMBAT_CONFIG.weapons.find((w) => w.weaponProfileRef === 'sure');
if (!SURE) throw new Error('fixture');

const B = (id: string, x: number, y: number, weapon: string | null, azimuthDeg?: number) =>
  ({ id, x, y, weapon, ...(azimuthDeg === undefined ? {} : { azimuthDeg }) }) as TestCombatant;
const O = B;

function simOf(scenario: Scenario, seed = 1, tickRateHz = 10): Simulation {
  return createSimulation({ tickRateHz, seed }, scenario);
}

function begin(sim: Simulation, tick = sim.tick): void {
  sim.submit({ type: 'beginEngagement', tick });
}

/** Steps until the engagement ends (or `maxSeconds` pass); returns every event. */
function runToEnd(sim: Simulation, maxSeconds = 300): SimEvent[] {
  const events: SimEvent[] = [];
  const limit = sim.tick + Math.round(maxSeconds / sim.dtSeconds);
  while (!sim.state.engagement?.end && sim.tick < limit) events.push(...sim.step());
  return events;
}

/** Steps until simulation time `seconds`. */
function runTo(sim: Simulation, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  while (sim.timeSeconds < seconds - 1e-9) events.push(...sim.step());
  return events;
}

const soldierOf = (sim: Simulation, id: string) => {
  const s = sim.state.soldiers.find((x) => x.id === id);
  if (!s) throw new Error(`no soldier ${id}`);
  return s;
};
const combatantOf = (sim: Simulation, id: string) => {
  const c = sim.state.engagement?.combatants.find((x) => x.soldierId === id);
  if (!c) throw new Error(`no combatant ${id}`);
  return c;
};

const proneOnly = (delay = { minSeconds: 0.5, maxSeconds: 2 }) => ({
  reactionProbabilities: { prone: 1, flee: 0 },
  reactionDelay: delay,
});
const fleeOnly = (delay = { minSeconds: 0.5, maxSeconds: 0.5 }) => ({
  reactionProbabilities: { prone: 0, flee: 1 },
  reactionDelay: delay,
});
const building = (id: string, footprint: Building['footprint'], heightMeters = 5): Building => ({
  id,
  footprint,
  heightMeters,
});
const withBuildings = (...buildings: Building[]): EnvironmentFeatures => ({
  roads: [],
  buildings,
  vegetation: [],
});

describe('beginning an engagement', () => {
  it('is refused in a world without a combat model', () => {
    const sim = simOf(TEST_SCENARIO);
    begin(sim);
    const events = sim.step();
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'commandRejected', reason: 'noCombatModel' }),
    );
    expect(sim.state.engagement).toBeUndefined();
  });

  it('happens once', () => {
    const sim = simOf(
      combatScenario({ blufor: [B('B1', 0, 0, 'rifle')], opfor: [O('O1', 0, 200, null)] }),
    );
    begin(sim);
    begin(sim, 1);
    expect(ofType(sim.step(), 'engagementStarted')).toHaveLength(1);
    expect(ofType(sim.step(), 'commandRejected')[0]?.reason).toBe('engagementAlreadyBegun');
  });

  it('gives every soldier a part, in soldier order, starting at the command’s tick', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'rifle'), B('B2', 10, 0, null)],
        opfor: [O('O1', 0, 200, 'rifle')],
      }),
    );
    runTo(sim, 0.5);
    begin(sim);
    const events = sim.step();
    expect(ofType(events, 'engagementStarted')).toEqual([
      { type: 'engagementStarted', tick: 5, atSeconds: 0.5 },
    ]);
    const engagement = sim.state.engagement;
    expect(engagement?.startSeconds).toBe(0.5);
    expect(engagement?.endsBySeconds).toBe(60.5);
    expect(engagement?.combatants.map((c) => [c.soldierId, c.side, c.weaponProfileRef])).toEqual([
      ['B1', 'BLUEFOR', 'rifle'],
      ['B2', 'BLUEFOR', null],
      ['O1', 'OPFOR', 'rifle'],
    ]);
    const [b1, b2, o1] = engagement?.combatants ?? [];
    expect(b1?.behavior).toBe('engaging');
    expect(b2?.nextShotSeconds).toBeNull();
    expect(o1?.behavior).toBe('awaitingReaction');
    expect(['prone', 'flee']).toContain(o1?.reaction);
    expect(o1?.reactAtSeconds).toBeGreaterThanOrEqual(1);
    expect(o1?.reactAtSeconds).toBeLessThan(2.5);
  });
});

describe('OPFOR reactions', () => {
  /** 400 unarmed OPFOR soldiers on a grid, one unarmed Marine far south. */
  const crowd = () =>
    combatScenario({
      blufor: [B('B1', 0, -900, null)],
      opfor: Array.from({ length: 400 }, (_, i) =>
        O(`O${String(i)}`, -400 + 40 * (i % 20), 100 + 40 * Math.floor(i / 20), null),
      ),
    });
  const reactionsOf = (seed: number) => {
    const sim = simOf(crowd(), seed);
    begin(sim);
    sim.step();
    return (sim.state.engagement?.combatants ?? [])
      .filter((c) => c.side === 'OPFOR')
      .map((c) => c.reaction);
  };

  it('are drawn independently per soldier, about 60 % prone and 40 % flee', () => {
    const reactions = reactionsOf(7);
    const prone = reactions.filter((r) => r === 'prone').length / reactions.length;
    expect(prone).toBeGreaterThan(0.52);
    expect(prone).toBeLessThan(0.68);
    expect(reactions.filter((r) => r === 'flee').length).toBe(400 - Math.round(prone * 400));
    // Not one decision for the whole patrol: neighbours differ throughout.
    const changes = reactions.slice(1).filter((r, i) => r !== reactions[i]).length;
    expect(changes).toBeGreaterThan(100);
  });

  it('are reproduced by the same seed and changed by another', () => {
    expect(reactionsOf(7)).toEqual(reactionsOf(7));
    expect(reactionsOf(8)).not.toEqual(reactionsOf(7));
  });

  it('come after each soldier’s own delay, within the configured range', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'blank')],
        opfor: [0, 1, 2, 3, 4, 5].map((k) => O(`O${String(k)}`, -50 + 20 * k, 200, 'blank')),
        config: testCombatConfig({ opfor: proneOnly() }),
      }),
    );
    begin(sim);
    runTo(sim, 0.4);
    expect(
      sim.state.engagement?.combatants.filter((c) => c.behavior === 'awaitingReaction'),
    ).toHaveLength(6);
    const events = runTo(sim, 3);
    const reacted = ofType(events, 'opforReacted');
    expect(reacted).toHaveLength(6);
    const delays = new Set<number>();
    for (const event of reacted) {
      const c = combatantOf(sim, event.soldierId);
      expect(event.atSeconds).toBe(c.reactAtSeconds);
      expect(event.atSeconds).toBeGreaterThanOrEqual(0.5);
      expect(event.atSeconds).toBeLessThanOrEqual(2);
      delays.add(event.atSeconds);
    }
    expect(delays.size).toBe(6);
  });

  it('prone: stops, drops prone facing the threat, and returns fire after the firing delay', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'blank'), B('B2', 100, 0, 'blank')],
        opfor: [O('O1', 0, 200, 'blank')],
        config: testCombatConfig({
          opfor: { ...proneOnly({ minSeconds: 1, maxSeconds: 1 }), returnFireDelaySeconds: 1 },
        }),
      }),
    );
    sim.submit({
      type: 'setOrders',
      tick: 0,
      soldierId: soldierId('O1'),
      orders: { waypoints: [{ id: waypointId('w'), x: 0, y: 50 }], finalFacing: Math.PI },
    });
    begin(sim);
    const before = runTo(sim, 1);
    expect(ofType(before, 'opforReacted')).toEqual([]);
    expect(soldierOf(sim, 'O1').position.y).toBeLessThan(200); // still walking, still a target
    const events = runTo(sim, 1.1);
    expect(ofType(events, 'opforReacted')).toEqual([
      {
        type: 'opforReacted',
        tick: 10,
        atSeconds: 1,
        soldierId: 'O1',
        reaction: 'prone',
        fleeBlocked: false,
        destination: null,
        speed: null,
      },
    ]);
    const o1 = soldierOf(sim, 'O1');
    expect(o1.posture).toBe('prone');
    expect(o1.orders).toBeNull();
    const at = { ...o1.position };
    // Faces the centroid of the Marines, (50, 0).
    expect(o1.azimuth).toBeCloseTo(azimuthOf(50 - at.x, -at.y), 12);
    const later = runTo(sim, 5);
    expect(soldierOf(sim, 'O1').position).toEqual(at);
    const shots = ofType(later, 'shotFired').filter((e) => e.shooterId === 'O1');
    expect(shots[0]?.atSeconds).toBe(2);
    expect(shots[0]?.targetId).toBe('B1'); // the nearer Marine
  });

  it('prone soldiers are half as likely to be hit; a reaction precedes a shot at the same moment', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'rifle0')],
        opfor: [O('O1', 0, 100, null)],
        config: testCombatConfig({
          weapons: [...TEST_COMBAT_CONFIG.weapons, RIFLE_NO_INCAP],
          opfor: proneOnly({ minSeconds: 1, maxSeconds: 1 }),
          engagement: { bluforFirstShotDelay: { minSeconds: 0, maxSeconds: 0 } },
        }),
      }),
    );
    begin(sim);
    const shots = ofType(runTo(sim, 3.5), 'shotFired');
    expect(shots.map((s) => [s.atSeconds, s.rangeM, s.hitProbability])).toEqual([
      [0, 100, 0.3],
      [1, 100, 0.15],
      [2, 100, 0.15],
      [3, 100, 0.15],
    ]);
  });

  it('flee: runs straight away from the threat at the flee speed, and escapes out of reach', () => {
    const sim = simOf(
      combatScenario({
        // The Marine's weapon reaches only 100 m: it can never engage the fleeing soldier.
        blufor: [B('B1', 0, 0, 'short-blank')],
        opfor: [O('O1', 0, 100, null)],
        config: testCombatConfig({ opfor: fleeOnly() }),
      }),
    );
    begin(sim);
    const reacted = ofType(runTo(sim, 0.6), 'opforReacted');
    expect(reacted).toHaveLength(1);
    expect(reacted[0]).toMatchObject({ reaction: 'flee', fleeBlocked: false, speed: 4.5 });
    expect(reacted[0]?.destination?.x).toBeCloseTo(0, 9);
    expect(reacted[0]?.destination?.y).toBeCloseTo(700, 9);
    expect(combatantOf(sim, 'O1').behavior).toBe('fleeing');
    expect(soldierOf(sim, 'O1').posture).toBe('standing');
    runTo(sim, 10.6);
    // Orders given at 0.5 s take effect with the next tick, at 0.6 s.
    expect(soldierOf(sim, 'O1').position.y).toBeCloseTo(100 + 4.5 * 10, 6);
    const events = runToEnd(sim);
    const escaped = ofType(events, 'soldierEscaped');
    // 300 m from the Marine after 200 m / 4.5 m/s = 44.4 s: the end of the tick ending 45.1 s.
    expect(escaped).toEqual([
      {
        type: 'soldierEscaped',
        tick: 450,
        atSeconds: expect.closeTo(45.1, 9) as number,
        soldierId: 'O1',
      },
    ]);
    expect(combatantOf(sim, 'O1').behavior).toBe('escaped');
    expect(soldierOf(sim, 'O1').orders).toBeNull();
    expect(sim.state.engagement?.end?.reason).toBe('opforEscaped');
  });

  it('flee: goes round buildings, never through them', () => {
    const block = rectangle(0, 130, 40, 10);
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'short-blank')],
        opfor: [O('O1', 0, 100, null)],
        config: testCombatConfig({ opfor: fleeOnly() }),
        features: withBuildings(building('block', block)),
      }),
    );
    begin(sim);
    let detoured = false;
    while (!sim.state.engagement?.end && sim.timeSeconds < 120) {
      sim.step();
      const { x, y } = soldierOf(sim, 'O1').position;
      expect(pointInPolygon({ x, y }, block)).toBe(false);
      if (Math.abs(x) > 15) detoured = true;
    }
    expect(detoured).toBe(true);
    expect(combatantOf(sim, 'O1').behavior).toBe('escaped');
  });

  it('flee: does not escape while an armed enemy can still engage; reaching the destination is an escape', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'blank')], // never hits, reaches 1 km
        opfor: [O('O1', 0, 100, null)],
        config: testCombatConfig({ opfor: fleeOnly(), engagement: { maxDurationSeconds: 200 } }),
      }),
    );
    begin(sim);
    const events = runToEnd(sim);
    const escaped = ofType(events, 'soldierEscaped');
    expect(escaped).toHaveLength(1);
    // 600 m at 4.5 m/s from 0.6 s: 133.9 s, at the destination (0, 700).
    expect(escaped[0]?.atSeconds).toBeCloseTo(134, 6);
    expect(soldierOf(sim, 'O1').position.y).toBeCloseTo(700, 6);
    expect(ofType(events, 'shotFired').length).toBeGreaterThan(100);
  });

  it('flee: escapes once far enough and out of sight, though still within range', () => {
    // A tall block 240–260 m north hides the soldier once it has run round and behind it.
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'blank')],
        opfor: [O('O1', 0, 100, null)],
        config: testCombatConfig({ opfor: fleeOnly(), engagement: { maxDurationSeconds: 200 } }),
        features: withBuildings(building('tower', rectangle(0, 250, 60, 20), 30)),
      }),
    );
    begin(sim);
    const escaped = ofType(runToEnd(sim), 'soldierEscaped');
    expect(escaped).toHaveLength(1);
    expect(escaped[0]?.atSeconds).toBeLessThan(100);
    const { x, y } = soldierOf(sim, 'O1').position;
    expect(Math.hypot(x, y)).toBeGreaterThanOrEqual(300);
    expect(y).toBeLessThan(700);
  });

  it('flee: with no walkable way out, drops prone where it is instead', () => {
    // Walls all round the soldier.
    const walls = withBuildings(
      building('n', rectangle(0, 110, 24, 2), 3),
      building('s', rectangle(0, 90, 24, 2), 3),
      building('e', rectangle(11, 100, 2, 24), 3),
      building('w', rectangle(-11, 100, 2, 24), 3),
    );
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'blank')],
        opfor: [O('O1', 0, 100, 'blank')],
        config: testCombatConfig({ opfor: fleeOnly() }),
        features: walls,
      }),
    );
    begin(sim);
    const reacted = ofType(runTo(sim, 1), 'opforReacted');
    expect(reacted).toEqual([
      expect.objectContaining({ reaction: 'flee', fleeBlocked: true, destination: null }),
    ]);
    const o1 = soldierOf(sim, 'O1');
    expect(o1.posture).toBe('prone');
    expect(o1.position).toMatchObject({ x: 0, y: 100 });
    expect(combatantOf(sim, 'O1')).toMatchObject({
      behavior: 'prone',
      fleeBlocked: true,
      nextShotSeconds: 1.5,
    });
  });
});

describe('two-sided combat', () => {
  it('BLUEFOR hits and incapacitates OPFOR, nearest first', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'sure')],
        opfor: [O('O1', 0, 200, 'blank'), O('O2', 0, 300, 'blank')],
        // Still standing when shot: a prone target would halve even this weapon's chance.
        config: testCombatConfig({ opfor: proneOnly({ minSeconds: 5, maxSeconds: 5 }) }),
      }),
    );
    begin(sim);
    const events = runToEnd(sim);
    const shots = ofType(events, 'shotFired');
    expect(shots.map((s) => [s.shooterId, s.targetId, s.hit, s.incapacitated])).toEqual([
      ['B1', 'O1', true, true],
      ['B1', 'O2', true, true],
    ]);
    expect(shots[0]).toMatchObject({
      shooterSide: 'BLUEFOR',
      weaponProfileRef: 'sure',
      rangeM: 200,
      hitProbability: 1,
    });
    expect(ofType(events, 'soldierIncapacitated').map((e) => [e.soldierId, e.byId])).toEqual([
      ['O1', 'B1'],
      ['O2', 'B1'],
    ]);
    expect(combatantOf(sim, 'B1').stats).toEqual({
      shotsFired: 2,
      hits: 2,
      incapacitations: 2,
      timesHit: 0,
    });
    expect(combatantOf(sim, 'O1').stats.timesHit).toBe(1);
    expect(soldierOf(sim, 'O1').status).toBe('incapacitated');
    expect(sim.state.engagement?.end?.reason).toBe('allOpforIncapacitated');
  });

  it('OPFOR returns fire with the same model and can incapacitate BLUEFOR', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'blank')],
        opfor: [O('O1', 0, 200, 'sure')],
        config: testCombatConfig({
          opfor: { ...proneOnly({ minSeconds: 1, maxSeconds: 1 }), returnFireDelaySeconds: 1 },
        }),
      }),
    );
    begin(sim);
    const events = runToEnd(sim);
    const opforShots = ofType(events, 'shotFired').filter((s) => s.shooterSide === 'OPFOR');
    expect(opforShots).toEqual([
      expect.objectContaining({
        atSeconds: 2,
        shooterId: 'O1',
        targetId: 'B1',
        hit: true,
        incapacitated: true,
      }),
    ]);
    expect(soldierOf(sim, 'B1')).toMatchObject({ status: 'incapacitated', orders: null });
    expect(sim.state.engagement?.end).toEqual({
      tick: 20,
      atSeconds: expect.closeTo(2.1, 9) as number,
      reason: 'allBluforIncapacitated',
    });
  });

  it('incapacitated soldiers stop firing and moving, and stay on the map', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'sure')],
        opfor: [O('O1', 0, 200, 'sure'), O('O2', 300, 900, 'blank')],
        config: {
          ...testCombatConfig({
            opfor: { ...proneOnly({ minSeconds: 1, maxSeconds: 1 }), returnFireDelaySeconds: 1 },
            engagement: { bluforFirstShotDelay: { minSeconds: 1.5, maxSeconds: 1.5 } },
          }),
          // Every shot of the sure weapon hits, prone or not.
          postureHitMultipliers: { standing: 1, kneeling: 1, prone: 1 },
        },
      }),
    );
    sim.submit({
      type: 'setOrders',
      tick: 0,
      soldierId: soldierId('O2'),
      orders: { waypoints: [{ id: waypointId('w'), x: 300, y: 500 }], finalFacing: Math.PI },
    });
    begin(sim);
    const events = runToEnd(sim);
    // O1 would have fired at 2 s; B1's shot at 1.5 s came first.
    expect(ofType(events, 'shotFired').filter((s) => s.shooterId === 'O1')).toEqual([]);
    expect(soldierOf(sim, 'B1').status).toBe('active');
    expect(sim.state.soldiers.map((s) => [s.id, s.status])).toEqual([
      ['B1', 'active'],
      ['O1', 'incapacitated'],
      ['O2', 'incapacitated'],
    ]);
    // O2 was walking when hit at 2.5 s; it no longer moves.
    const fallen = { ...soldierOf(sim, 'O2').position };
    for (let i = 0; i < 50; i += 1) sim.step();
    expect(soldierOf(sim, 'O2').position).toEqual(fallen);
    expect(fallen.y).toBeLessThan(900);
  });

  it('chooses the nearest valid target, by soldier order on a tie, never an incapacitated one', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'sure')],
        opfor: [O('OA', 0, 150, null), O('OB', 150, 0, null), O('OC', 0, 300, null)],
        config: testCombatConfig({
          opfor: proneOnly({ minSeconds: 5, maxSeconds: 5 }),
          engagement: { bluforFirstShotDelay: { minSeconds: 0, maxSeconds: 0 } },
        }),
      }),
    );
    begin(sim);
    const shots = ofType(runToEnd(sim), 'shotFired');
    expect(shots.map((s) => [s.atSeconds, s.targetId])).toEqual([
      [0, 'OA'],
      [1, 'OB'],
      [2, 'OC'],
    ]);
  });

  it('skips targets out of range or out of sight, whichever way the shooter faces', () => {
    const sim = simOf(
      combatScenario({
        // Facing south, away from every target.
        blufor: [B('B1', 0, 0, 'rifle', 180)],
        opfor: [O('Far', 0, 450, null), O('Hidden', 0, 150, null), O('Seen', 200, 200, null)],
        config: testCombatConfig({
          opfor: proneOnly(),
          engagement: { bluforFirstShotDelay: { minSeconds: 0, maxSeconds: 0 } },
        }),
        features: withBuildings(building('wall', rectangle(0, 75, 40, 10), 10)),
      }),
    );
    begin(sim);
    const shots = ofType(sim.step(), 'shotFired');
    expect(shots.map((s) => s.targetId)).toEqual(['Seen']);
    // The shooter turns to its target.
    expect(soldierOf(sim, 'B1').azimuth).toBeCloseTo(Math.PI / 4, 12);
  });

  it('looks for a target again after the recheck interval when there is none', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'short-blank')],
        opfor: [O('O1', 0, 150, null)],
        config: testCombatConfig({
          opfor: proneOnly(),
          engagement: {
            bluforFirstShotDelay: { minSeconds: 0, maxSeconds: 0 },
            maxDurationSeconds: 5,
          },
        }),
      }),
    );
    begin(sim);
    sim.step();
    expect(combatantOf(sim, 'B1').nextShotSeconds).toBe(0.5);
    const events = runToEnd(sim);
    expect(ofType(events, 'shotFired')).toEqual([]);
    expect(combatantOf(sim, 'B1').stats.shotsFired).toBe(0);
  });
});

describe('engagement termination', () => {
  it('ends at the configured time limit, however long firing pauses', () => {
    const sim = simOf(
      combatScenario({
        // Out of range all along: nobody fires at all, yet the engagement goes on.
        blufor: [B('B1', 0, 0, 'short-blank')],
        opfor: [O('O1', 0, 150, null)],
        config: testCombatConfig({ opfor: proneOnly(), engagement: { maxDurationSeconds: 20 } }),
      }),
    );
    begin(sim);
    const events = runToEnd(sim);
    expect(ofType(events, 'engagementEnded')).toEqual([
      { type: 'engagementEnded', tick: 199, atSeconds: 20, reason: 'timeLimit' },
    ]);
    expect(sim.tick).toBe(200);
  });

  it('defaults to 60 s', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'blank')],
        opfor: [O('O1', 0, 150, 'blank')],
        config: testCombatConfig({ opfor: proneOnly() }),
      }),
    );
    begin(sim);
    runToEnd(sim);
    expect(sim.state.engagement?.end).toEqual({ tick: 599, atSeconds: 60, reason: 'timeLimit' });
  });

  it('ends at once when nobody on either side can fire', () => {
    const sim = simOf(
      combatScenario({ blufor: [B('B1', 0, 0, null)], opfor: [O('O1', 0, 150, null)] }),
    );
    begin(sim);
    const events = sim.step();
    expect(ofType(events, 'engagementEnded')[0]?.reason).toBe('noCombatCapable');
  });

  it('ends early when all OPFOR are incapacitated, escaped, or all BLUEFOR incapacitated', () => {
    // The individual cases are covered above; here a mix: one escapes, one is incapacitated.
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'rifle')],
        opfor: [O('Near', 0, 50, null), O('Away', 0, 350, null)],
        config: testCombatConfig({
          weapons: [
            {
              ...TEST_RIFLE,
              maxEngagementRangeM: 300,
              hitProbabilityByRange: [{ rangeM: 0, probability: 1 }],
              incapacitationProbabilityOnHit: 1,
            },
            ...TEST_COMBAT_CONFIG.weapons.slice(1),
          ],
          opfor: fleeOnly({ minSeconds: 0.5, maxSeconds: 0.5 }),
          engagement: { bluforFirstShotDelay: { minSeconds: 0, maxSeconds: 0 } },
        }),
      }),
    );
    begin(sim);
    const events = runToEnd(sim);
    expect(ofType(events, 'soldierIncapacitated').map((e) => e.soldierId)).toEqual(['Near']);
    expect(ofType(events, 'soldierEscaped').map((e) => e.soldierId)).toEqual(['Away']);
    expect(sim.state.engagement?.end?.reason).toBe('opforEscaped');
    expect(sim.state.engagement?.end?.atSeconds).toBeLessThan(2);
  });
});

describe('timing and determinism', () => {
  it('resolves simultaneous shots in soldier order: a target already down is not shot again', () => {
    const sim = simOf(
      combatScenario({
        blufor: [B('B1', 0, 0, 'sure'), B('B2', 10, 0, 'sure')],
        opfor: [O('O1', 0, 200, null)],
        config: testCombatConfig({
          engagement: { bluforFirstShotDelay: { minSeconds: 0, maxSeconds: 0 } },
        }),
      }),
    );
    begin(sim);
    const shots = ofType(sim.step(), 'shotFired');
    expect(shots.map((s) => s.shooterId)).toEqual(['B1']);
  });

  it('lets the earlier in soldier order fire first when two enemies fire at the same moment', () => {
    const duel = (opforFirst: boolean) => {
      const sim = simOf(
        combatScenario({
          blufor: [B('B1', 0, 0, 'sure')],
          opfor: [O('O1', 0, 200, 'sure')],
          opforFirst,
          config: testCombatConfig({
            opfor: {
              ...proneOnly({ minSeconds: 0.5, maxSeconds: 0.5 }),
              returnFireDelaySeconds: 0.5,
            },
            engagement: { bluforFirstShotDelay: { minSeconds: 1, maxSeconds: 1 } },
          }),
        }),
      );
      begin(sim);
      return ofType(runToEnd(sim), 'shotFired').map((s) => [s.atSeconds, s.shooterId]);
    };
    expect(duel(false)).toEqual([[1, 'B1']]);
    expect(duel(true)).toEqual([[1, 'O1']]);
  });

  it('fires every shot exactly once, at the same moments, whatever the tick rate', () => {
    const shotsAt = (tickRateHz: number) => {
      const sim = simOf(
        combatScenario({
          blufor: [B('B1', 0, 0, 'rapid'), B('B2', 20, 0, 'rapid')],
          opfor: [O('O1', 0, 150, 'rapid'), O('O2', 30, 160, 'rapid')],
          config: testCombatConfig({
            // Faster than one shot per tick at 10 Hz; hits never incapacitate.
            weapons: [{ ...RIFLE_NO_INCAP, weaponProfileRef: 'rapid', secondsBetweenShots: 0.07 }],
            opfor: proneOnly(),
            engagement: { maxDurationSeconds: 10 },
          }),
        }),
        5,
        tickRateHz,
      );
      begin(sim, 0);
      const events = runToEnd(sim);
      return {
        // Ticks differ with the rate; everything else must not.
        shots: ofType(events, 'shotFired').map((e) => ({ ...e, tick: null })),
        end: sim.state.engagement?.end?.atSeconds,
        rng: sim.state.rng,
      };
    };
    const at10 = shotsAt(10);
    // Each Marine fires every 0.07 s from its first opportunity (within 1 s) until 10 s.
    expect(at10.shots.filter((s) => s.shooterId === 'B1').length).toBeGreaterThan(125);
    expect(at10.shots.some((s) => s.hit)).toBe(true);
    const standing = at10.shots[0]?.hitProbability ?? NaN;
    expect(at10.shots.some((s) => s.hitProbability === 0.5 * standing)).toBe(true);
    expect(shotsAt(30)).toEqual(at10);
    expect(shotsAt(60)).toEqual(at10);
    // In time order, simultaneous ones in soldier order.
    const times = at10.shots.map((s) => s.atSeconds);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  const skirmish = () =>
    combatScenario({
      blufor: [B('B1', 0, 0, 'rifle'), B('B2', 30, 0, 'rifle'), B('B3', -30, 0, 'rifle')],
      opfor: [O('O1', 0, 150, 'rifle'), O('O2', 15, 160, 'rifle'), O('O3', -15, 170, 'rifle')],
      config: testCombatConfig({ engagement: { maxDurationSeconds: 30 } }),
    });

  /** Runs the skirmish: the engagement begins at tick 3. */
  const fight = (seed: number) => {
    const sim = simOf(skirmish(), seed);
    begin(sim, 3);
    const events = runToEnd(sim);
    return { sim, events, hash: hashSimState(sim.state) };
  };

  it('plays out identically for the same seed, and differently for others', () => {
    const a = fight(11);
    expect(fight(11).hash).toBe(a.hash);
    expect(fight(11).events).toEqual(a.events);
    const outcomes = new Set(
      [11, 12, 13, 14, 15, 16].map((seed) => {
        const { sim } = fight(seed);
        return JSON.stringify(sim.state.engagement?.combatants.map((c) => [c.behavior, c.stats]));
      }),
    );
    expect(outcomes.size).toBeGreaterThan(3);
  });

  it('is reproduced by restoring a snapshot taken mid-engagement', () => {
    const whole = fight(21);
    const sim = simOf(skirmish(), 21);
    begin(sim, 3);
    runTo(sim, 4);
    expect(sim.state.engagement?.end).toBeNull();
    const snapshot = sim.snapshot();
    const tail = runToEnd(sim);
    expect(hashSimState(sim.state)).toBe(whole.hash);

    const restored = simOf(skirmish(), 99);
    restored.restore(snapshot);
    expect(runToEnd(restored)).toEqual(tail);
    expect(hashSimState(restored.state)).toBe(whole.hash);
  });

  it('is reproduced by replaying the command log', () => {
    const whole = fight(31);
    const log: SimCommand[] = [{ type: 'beginEngagement', tick: 3 }];
    const replay = simOf(skirmish(), 31);
    for (const command of log) replay.submit(command);
    expect(runToEnd(replay)).toEqual(whole.events);
    expect(hashSimState(replay.state)).toBe(whole.hash);
  });

  it('keeps combat state plain data, and the combat model in the world fingerprint', () => {
    const { sim } = fight(41);
    expect(() => hashSimState(sim.state as SimState)).not.toThrow();
    const other = combatScenario({
      blufor: [B('B1', 0, 0, 'rifle')],
      opfor: [O('O1', 0, 150, 'rifle')],
      config: testCombatConfig({ opfor: proneOnly() }),
    });
    const same = combatScenario({
      blufor: [B('B1', 0, 0, 'rifle')],
      opfor: [O('O1', 0, 150, 'rifle')],
    });
    expect(fingerprintWorld(createWorld(other))).not.toBe(fingerprintWorld(createWorld(same)));
    const without: Scenario = { ...same };
    delete (without as { combat?: unknown }).combat;
    expect(fingerprintWorld(createWorld(without))).not.toBe(fingerprintWorld(createWorld(same)));
  });

  it('refuses a scenario whose soldiers fire weapons the configuration does not know', () => {
    expect(() => simOf(combatScenario({ blufor: [B('B1', 0, 0, 'laser')], opfor: [] }))).toThrow(
      /fires "laser", which has no combat profile/,
    );
  });
});
