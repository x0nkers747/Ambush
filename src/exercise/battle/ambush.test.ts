import { describe, expect, it } from 'vitest';
import {
  inKillZone,
  NO_FEATURES,
  type ContactObservedEvent,
  type ForcePhaseChangedEvent,
  type KillZone,
  type OrderKind,
  type SimEvent,
} from '#sim';
import { labTerrain } from '../behavior-lab/run';
import { createBattle, type BattleSpec } from './battle';
import {
  addOrder,
  addSquad,
  newBattleScenario,
  parseBattleScenario,
  resizeKillZone,
  scenarioIssues,
  setKillZone,
  setOrderKind,
  type BattleEdit,
  type BattleScenarioDefinition,
} from './scenario';

// The ambush order (docs/behavior-lab/force-on-force/08). A BLUEFOR squad
// occupies an ambush position 70 m west of a north–south route, 15 m inside
// the edge of a wood, its kill zone on the route; an OPFOR squad, starting
// over a kilometre off, walks down the route. On open ground instead (no
// wood), it shows concealment: without it, OPFOR sees the squad from far off.

const POSITION = { x: -70, y: 0 };
/** A wood west of the route, its edge 55 m from it. */
const WOOD = labTerrain({
  ...NO_FEATURES,
  vegetation: [
    {
      id: 'woodland:0',
      kind: 'woodland',
      boundary: [
        { x: -300, y: -500 },
        { x: -55, y: -500 },
        { x: -55, y: 500 },
        { x: -300, y: 500 },
      ],
      canopyHeightMeters: 15,
      seeThroughMeters: 40,
    },
  ],
});
const OPEN = labTerrain();
const ZONE: KillZone = { centre: { x: 0, y: 0 }, widthM: 50, depthM: 50, facing: Math.PI / 2 };

function spec(seed: number, blue: OrderKind): BattleSpec {
  return {
    seed,
    tickRateHz: 30,
    squads: [
      {
        id: 'B1',
        name: 'Blue',
        side: 'BLUEFOR',
        organization: 'squad',
        position: { x: -110, y: -30 },
        facingDeg: 45,
        plan: [
          blue === 'ambush'
            ? { kind: 'ambush', destination: POSITION, killZone: ZONE }
            : { kind: blue, destination: POSITION, actionsOn: 'hold' },
        ],
      },
      {
        id: 'O1',
        name: 'Red',
        side: 'OPFOR',
        organization: 'squad',
        position: { x: 0, y: 1150 },
        facingDeg: 180,
        plan: [{ kind: 'move', destination: { x: 0, y: -1100 } }],
      },
    ],
  };
}

interface Fought {
  readonly events: SimEvent[];
  readonly blue: ForcePhaseChangedEvent[];
  /** OPFOR sightings of BLUEFOR soldiers, and whether BLUEFOR was concealed then. */
  readonly sightings: { readonly event: ContactObservedEvent; readonly concealed: boolean }[];
  /** OPFOR soldiers in the kill zone when the ambush was sprung. */
  readonly insideAtSpring: number;
  readonly battle: ReturnType<typeof createBattle>;
}

const fights = new Map<string, Fought>();
function fight(seed: number, order: OrderKind, ground: 'wood' | 'open', seconds = 1100): Fought {
  const key = `${String(seed)}/${order}/${ground}`;
  const known = fights.get(key);
  if (known) return known;
  const terrain = ground === 'wood' ? WOOD : OPEN;
  const battle = createBattle(spec(seed, order), terrain);
  const events: SimEvent[] = [];
  const sightings: Fought['sightings'] = [];
  let insideAtSpring = -1;
  for (let tick = 1; tick <= seconds * 30; tick += 1) {
    const fof = battle.sim.state.fof;
    const concealed = fof?.forces[0]?.concealed === true;
    const step = battle.step();
    events.push(...step);
    for (const e of step) {
      if (e.type === 'contactObserved' && e.side === 'OPFOR')
        sightings.push({ event: e, concealed });
      if (e.type === 'forcePhaseChanged' && e.side === 'BLUEFOR' && e.from === 'inAmbush') {
        insideAtSpring = battle.sim.state.soldiers.filter(
          (s) => s.side === 'OPFOR' && s.status === 'active' && inKillZone(ZONE, s.position),
        ).length;
      }
    }
  }
  const blue = events.filter(
    (e): e is ForcePhaseChangedEvent => e.type === 'forcePhaseChanged' && e.side === 'BLUEFOR',
  );
  const fought = { events, blue, sightings, insideAtSpring, battle };
  fights.set(key, fought);
  return fought;
}

const SEEDS = [1, 2, 3];

describe('the ambush order', { timeout: 300_000 }, () => {
  it('occupies its position, lies in wait, and springs when the enemy is in the kill zone', () => {
    for (const seed of SEEDS) {
      const f = fight(seed, 'ambush', 'wood');
      const occupied = f.blue.find((e) => e.to === 'inAmbush');
      expect(occupied?.reason).toBe('occupying the ambush position');
      const sprung = f.blue.find((e) => e.from === 'inAmbush');
      expect(sprung?.to).toBe('contact');
      expect(sprung?.reason).toMatch(/^ambush sprung: /);
      // Sprung on the enemy in (or leaving) the kill zone, not on being found.
      expect(sprung?.reason).not.toMatch(/compromised|fired upon/);
      expect(f.insideAtSpring).toBeGreaterThan(0);
      // It fires first; the enemy, surprised, returns fire only after the surprise (4 s).
      const fire = f.events.filter((e) => e.type === 'fofFire');
      expect(fire[0]?.side).toBe('BLUEFOR');
      expect(fire[0]?.atSeconds).toBeGreaterThanOrEqual(sprung?.atSeconds ?? Infinity);
      const returned = fire.find((e) => e.side === 'OPFOR');
      if (returned) expect(returned.atSeconds - (sprung?.atSeconds ?? 0)).toBeGreaterThanOrEqual(4);
    }
  });

  it('is concealed while it lies in wait: never seen farther than the concealment range', () => {
    let concealedLooks = 0;
    for (const seed of SEEDS) {
      for (const { event, concealed } of fight(seed, 'ambush', 'open').sightings) {
        if (!concealed) continue;
        concealedLooks += 1;
        expect(event.rangeM ?? 0).toBeLessThanOrEqual(100);
      }
    }
    expect(concealedLooks).toBeGreaterThan(0);
    // The same squad halted there on a move order (not concealed) is seen from farther.
    const far = SEEDS.flatMap((seed) =>
      fight(seed, 'move', 'open').sightings.filter((s) => (s.event.rangeM ?? 0) > 100),
    );
    expect(far.length).toBeGreaterThan(0);
  });

  it('fights from its position and waits there for new orders', () => {
    let downed = 0;
    for (const seed of SEEDS) {
      const f = fight(seed, 'ambush', 'wood');
      const sprung = f.blue.find((e) => e.from === 'inAmbush');
      const after = f.blue.filter((e) => e.atSeconds > (sprung?.atSeconds ?? Infinity));
      expect(after.some((e) => e.to === 'moving' || e.to === 'assaulting')).toBe(false);
      const blue = f.battle.sim.state.fof?.forces[0];
      const order = blue?.orders[0];
      // Unless it broke contact, spent, its ambush order is still active: it waits.
      if (!after.some((e) => e.to === 'withdrawing')) expect(order?.status).toBe('active');
      downed += f.battle.sim.state.soldiers.filter(
        (s) => s.side === 'OPFOR' && s.status !== 'active',
      ).length;
    }
    expect(downed).toBeGreaterThan(0);
  });
});

describe('an ambush in a scenario', () => {
  const terrain = labTerrain();
  const done = (e: BattleEdit): BattleScenarioDefinition => {
    if (!e.ok) throw new Error(e.problem);
    return e.definition;
  };
  const withAmbush = () => {
    let d = newBattleScenario(terrain, 'bf');
    d = done(addSquad(terrain, d, 'BLUEFOR', 'squad', { x: -100, y: -100 }));
    d = done(addSquad(terrain, d, 'OPFOR', 'squad', { x: 0, y: 300 }));
    return done(addOrder(terrain, d, 'B1', 'ambush', { x: -70, y: 0 }));
  };

  it('needs a kill zone, which is 50 m square and faces the ambush position', () => {
    let d = withAmbush();
    expect(scenarioIssues(terrain, d).some((i) => i.message.includes('set its kill zone'))).toBe(
      true,
    );
    // Only an ambush has one.
    expect(
      setKillZone(terrain, done(setOrderKind(d, 'B1', 0, 'move')), 'B1', 0, { x: 0, y: 0 }).ok,
    ).toBe(false);
    d = done(setKillZone(terrain, d, 'B1', 0, { x: 0, y: 0 }));
    const zone = d.squads[0]?.plan[0]?.killZone;
    expect(zone).toEqual({ centre: { east: 0, north: 0 }, widthM: 50, depthM: 50, facingDeg: 90 });
    expect(scenarioIssues(terrain, d).some((i) => i.message.includes('kill zone'))).toBe(false);
  });

  it('resizes by a corner, the opposite corner staying, keeping its facing', () => {
    let d = withAmbush();
    d = done(setKillZone(terrain, d, 'B1', 0, { x: 0, y: 0 }));
    // Facing east: corner 2 (far right) is at (25, -25); the near left (corner 0) at (-25, 25).
    d = done(resizeKillZone(terrain, d, 'B1', 0, 2, { x: 35, y: -75 }));
    const zone = d.squads[0]?.plan[0]?.killZone;
    expect(zone?.depthM).toBeCloseTo(60);
    expect(zone?.widthM).toBeCloseTo(100);
    expect(zone?.facingDeg).toBe(90);
    expect(zone?.centre.east).toBeCloseTo(5);
    expect(zone?.centre.north).toBeCloseTo(-25);
    // Never smaller than 5 m.
    d = done(resizeKillZone(terrain, d, 'B1', 0, 2, { x: -25, y: 25 }));
    expect(d.squads[0]?.plan[0]?.killZone?.widthM).toBeCloseTo(5);
  });

  it('is saved and read back; changing the kind drops the kill zone; orders after it are flagged', () => {
    let d = done(setKillZone(terrain, withAmbush(), 'B1', 0, { x: 0, y: 0 }));
    const read = parseBattleScenario(JSON.parse(JSON.stringify(d)));
    expect(read.squads[0]?.plan[0]?.killZone).toEqual(d.squads[0]?.plan[0]?.killZone);
    expect(done(setOrderKind(d, 'B1', 0, 'move')).squads[0]?.plan[0]?.killZone).toBeUndefined();
    const bad = JSON.parse(JSON.stringify(done(setOrderKind(d, 'B1', 0, 'move')))) as {
      squads: { plan: Record<string, unknown>[] }[];
    };
    const order = bad.squads[0]?.plan[0];
    if (order) order['killZone'] = d.squads[0]?.plan[0]?.killZone;
    expect(() => parseBattleScenario(bad)).toThrow(/only an ambush has a kill zone/);
    d = done(addOrder(terrain, d, 'B1', 'move', { x: -100, y: 50 }));
    expect(
      scenarioIssues(terrain, d).some(
        (i) => i.orderIndex === 1 && i.message.includes('waits for new orders'),
      ),
    ).toBe(true);
  });
});
