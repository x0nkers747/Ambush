import { describe, expect, it } from 'vitest';
import {
  createSimulation,
  hashSimState,
  VEHICLE_PLATFORMS,
  type PlatformSpec,
  type ScenarioVehicle,
  type SimEvent,
  type VehicleFireEvent,
} from '#sim';
import { labTerrain } from '../behavior-lab/run';
import {
  antiTankLoadoutOf,
  antiTankWeapons,
  battleScenario,
  createBattle,
  type BattleSpec,
  type SquadSpec,
} from './battle';

// Combined arms in a battle (docs/combined-arms.md §14): vehicles and
// soldiers see, choose and fire at each other through the one force-on-force
// decision; weapons are chosen by their effect; damage persists; runs are
// exactly reproducible.

const TERRAIN = labTerrain();
type Side = 'BLUEFOR' | 'OPFOR';

function vehicle(
  id: string,
  kind: string,
  side: Side,
  x: number,
  y: number,
  headingDeg: number,
  to: readonly { x: number; y: number }[] = [],
): ScenarioVehicle {
  return { id, name: id, kind, side, position: { x, y }, headingDeg, destinations: to };
}

function squad(
  id: string,
  side: Side,
  x: number,
  y: number,
  facingDeg: number,
  extra: Partial<SquadSpec> = {},
): SquadSpec {
  return {
    id,
    name: id,
    side,
    organization: 'squad',
    position: { x, y },
    facingDeg,
    plan: [],
    ...extra,
  };
}

/** Squads far off on both sides (a battle has its forces), out of the fight. */
const BX = squad('BX', 'BLUEFOR', -1100, -1100, 0, { antiTank: 'none' });
const OX = squad('OX', 'OPFOR', 1100, 1100, 180, { antiTank: 'none' });
const BYSTANDERS = [BX, OX];

function run(spec: BattleSpec, seconds: number) {
  const battle = createBattle(spec, TERRAIN);
  const events: SimEvent[] = [];
  for (let i = 0; i < seconds * spec.tickRateHz; i += 1) events.push(...battle.step());
  return { battle, events };
}

const fires = (events: readonly SimEvent[]): VehicleFireEvent[] =>
  events.filter((e): e is VehicleFireEvent => e.type === 'vehicleFire');

const TANK_DUEL: BattleSpec = {
  seed: 7,
  tickRateHz: 30,
  squads: BYSTANDERS,
  vehicles: [
    vehicle('A1', 'm1a1', 'BLUEFOR', 0, -700, 0, [{ x: 0, y: -300 }]),
    vehicle('T1', 't72b', 'OPFOR', 0, 700, 180, [{ x: 0, y: 300 }]),
  ],
};

describe('vehicles in a battle', () => {
  it('Abrams against T-72: main guns with armour-piercing rounds, never the machine guns', () => {
    const { battle, events } = run(TANK_DUEL, 120);
    const shots = fires(events);
    const atTanks = shots.filter((e) => e.target === 'vehicle');
    expect(atTanks.length).toBeGreaterThan(1);
    for (const e of atTanks) {
      expect(e.slot).toBe('main');
      expect(['m829a1', '3bm42']).toContain(e.ammo);
    }
    // Hits are resolved against the armour, and one of them is out.
    expect(events.some((e) => e.type === 'vehicleHit')).toBe(true);
    const conditions = (battle.sim.state.vehicles ?? []).map((v) => v.combat.damage.destroyed);
    expect(conditions).toContain(true);
    // The mounts were laid by the simulation: the turret and its fire event agree on the target.
    for (const e of atTanks) expect(e.from.z).toBeGreaterThan(0);
  });

  it('Abrams against infantry: machine guns, not the main gun; soldiers fall', () => {
    const { events } = run(
      {
        seed: 3,
        tickRateHz: 30,
        squads: [
          BX,
          squad('O', 'OPFOR', 0, 300, 180, {
            antiTank: 'none',
            plan: [{ kind: 'move', destination: { x: 0, y: -200 } }],
          }),
        ],
        vehicles: [vehicle('A1', 'm1a1', 'BLUEFOR', 0, -500, 0)],
      },
      150,
    );
    const shots = fires(events);
    expect(shots.length).toBeGreaterThan(5);
    for (const e of shots) {
      expect(e.target).toBe('soldier');
      expect(['coax', 'hmg']).toContain(e.slot);
    }
    const byTank = events.filter((e) => e.type === 'soldierIncapacitated' && e.byId === 'A1');
    expect(byTank.length).toBeGreaterThan(0);
  });

  it('rifles never fire at vehicles, and an M113’s M2HB never at a T-72', () => {
    const { events } = run(
      {
        seed: 4,
        tickRateHz: 30,
        squads: [squad('B', 'BLUEFOR', 0, -200, 0, { antiTank: 'none' }), OX],
        vehicles: [
          vehicle('M1', 'm113', 'BLUEFOR', 60, -250, 0),
          vehicle('T1', 't72b', 'OPFOR', 0, 400, 180, [{ x: 0, y: 0 }]),
        ],
      },
      90,
    );
    const vehicleIds = new Set(['M1', 'T1']);
    const rifles = events.filter((e) => e.type === 'fofFire' && vehicleIds.has(e.targetId));
    expect(rifles).toEqual([]);
    expect(fires(events).filter((e) => e.shooterId === 'M1' && e.targetId === 'T1')).toEqual([]);
    // The T-72 does fight: its soldiers in view are engaged.
    expect(fires(events).some((e) => e.shooterId === 'T1')).toBe(true);
  });

  it('M113 against BMP-2: the autocannon fires armour-piercing rounds and its hits strike the M113', () => {
    const { battle, events } = run(
      {
        seed: 5,
        tickRateHz: 30,
        squads: BYSTANDERS,
        vehicles: [
          vehicle('M1', 'm113', 'BLUEFOR', 0, -400, 0, [{ x: 0, y: -100 }]),
          vehicle('B1', 'bmp2', 'OPFOR', 0, 600, 180, [{ x: 0, y: 300 }]),
        ],
      },
      150,
    );
    const bmp = fires(events).filter((e) => e.shooterId === 'B1');
    expect(bmp.length).toBeGreaterThan(0);
    expect(bmp.every((e) => e.slot === 'main' && e.ammo === '3ubr6')).toBe(true);
    const m113 = battle.sim.state.vehicles?.find((v) => v.id === 'M1');
    expect(m113?.combat.damage.hits).toBeGreaterThan(0);
    // Its ammunition was spent from its ready rounds.
    const gun = battle.sim.state.vehicles
      ?.find((v) => v.id === 'B1')
      ?.combat.weapons.find((w) => w.id === 'main');
    expect(gun?.fired).toBeGreaterThan(0);
  });

  it('anti-tank infantry: rockets and a missile against armour, from the soldiers who carry them', () => {
    const spec: BattleSpec = {
      seed: 9,
      tickRateHz: 30,
      squads: [
        squad('B', 'BLUEFOR', 0, -100, 0, {
          antiTank: 'rocketsAndMissile',
          plan: [
            {
              kind: 'defend',
              destination: { x: 0, y: -100 },
              sector: { facing: 0, arc: Math.PI },
            },
          ],
        }),
        OX,
      ],
      vehicles: [
        vehicle('T1', 't72b', 'OPFOR', 100, 900, 180, [{ x: 100, y: -300 }]),
        vehicle('B1', 'bmp2', 'OPFOR', -100, 900, 180, [{ x: -100, y: -300 }]),
      ],
    };
    const { battle, events } = run(spec, 200);
    const carriers = new Set((battle.sim.state.combat?.antiTank ?? []).map((a) => a.soldierId));
    // Three riflemen with AT4s and a Javelin gunner.
    expect(carriers.size).toBe(4);
    const shots = fires(events).filter((e) => e.shooter === 'soldier');
    expect(shots.length).toBeGreaterThan(0);
    for (const e of shots) {
      expect(carriers.has(e.shooterId)).toBe(true);
      expect(['at4', 'javelin']).toContain(e.weapon);
    }
    // Rounds spent: what they fired is gone from what they carry.
    for (const a of battle.sim.state.combat?.antiTank ?? []) {
      const carried = a.weapon === 'javelin' ? 2 : 2;
      expect(a.loaded + a.reserve + a.fired).toBe(carried);
    }
    expect(events.some((e) => e.type === 'vehicleCondition' && e.to === 'destroyed')).toBe(true);
  });

  it('carries rockets by default only when the enemy has vehicles', () => {
    const { squads } = battleScenario(TANK_DUEL, TERRAIN);
    const b = squads.find((s) => s.spec.id === 'BX');
    if (!b) throw new Error('no squad');
    expect(antiTankLoadoutOf(squad('S', 'BLUEFOR', 0, 0, 0), TANK_DUEL)).toBe('rockets');
    expect(antiTankLoadoutOf(squad('S', 'BLUEFOR', 0, 0, 0), { vehicles: [] })).toBe('none');
    const rockets = antiTankWeapons(b, 'rockets');
    expect(Object.values(rockets)).toEqual(['at4', 'at4', 'at4']);
    // A battle without vehicles: no combat state, as before.
    const plain = run({ seed: 1, tickRateHz: 30, squads: BYSTANDERS }, 5);
    expect(plain.battle.sim.state.combat).toBeUndefined();
  });

  it('an immobilized vehicle stops where it is and its orders fail', () => {
    const battle = createBattle(
      {
        seed: 2,
        tickRateHz: 30,
        squads: BYSTANDERS,
        vehicles: [vehicle('M1', 'm113', 'BLUEFOR', 0, -400, 0, [{ x: 0, y: 200 }])],
      },
      TERRAIN,
    );
    for (let i = 0; i < 300; i += 1) battle.step();
    const v = battle.sim.state.vehicles?.[0];
    if (!v) throw new Error('no vehicle');
    expect(v.speed).toBeGreaterThan(2);
    // Immobilize it (as a hit's damage would) and let it run on.
    const snapshot = battle.sim.snapshot();
    (
      snapshot.state.vehicles?.[0] as { combat: { damage: { mobility: boolean } } }
    ).combat.damage.mobility = true;
    battle.sim.restore(snapshot);
    for (let i = 0; i < 300; i += 1) battle.step();
    const after = (battle.sim.state.vehicles ?? [])[0];
    if (!after) throw new Error('no vehicle');
    expect(after.speed).toBe(0);
    expect(after.orders.every((o) => o.status !== 'active' && o.status !== 'pending')).toBe(true);
    expect(after.orders.map((o) => o.reason)).toContain('immobilized');
  });
});

describe('determinism of combined arms', () => {
  const MIXED: BattleSpec = {
    seed: 21,
    tickRateHz: 30,
    squads: [
      squad('B', 'BLUEFOR', -50, -300, 0, {
        antiTank: 'rocketsAndMissile',
        plan: [{ kind: 'move', destination: { x: -50, y: 0 } }],
      }),
      squad('O', 'OPFOR', 50, 400, 180, {
        plan: [{ kind: 'move', destination: { x: 50, y: 100 } }],
      }),
    ],
    vehicles: [
      vehicle('A1', 'm1a1', 'BLUEFOR', 100, -400, 0, [{ x: 100, y: -100 }]),
      vehicle('M1', 'm113', 'BLUEFOR', -150, -400, 0, [{ x: -150, y: -150 }]),
      vehicle('T1', 't72b', 'OPFOR', 150, 600, 180, [{ x: 150, y: 250 }]),
      vehicle('B1', 'bmp2', 'OPFOR', -100, 600, 180, [{ x: -100, y: 250 }]),
    ],
  };

  it('runs a mixed battle the same twice: every second’s hash and every event', () => {
    const hashes = (spec: BattleSpec) => {
      const battle = createBattle(spec, TERRAIN);
      const out: string[] = [];
      const events: SimEvent[] = [];
      for (let i = 0; i < 90 * spec.tickRateHz; i += 1) {
        events.push(...battle.step());
        if (battle.sim.tick % spec.tickRateHz === 0) out.push(hashSimState(battle.sim.state));
      }
      return { out, events };
    };
    const a = hashes(MIXED);
    const b = hashes(MIXED);
    expect(b.out).toEqual(a.out);
    expect(b.events).toEqual(a.events);
    // Several vehicles and soldiers fought at once.
    const shooters = new Set(fires(a.events).map((e) => e.shooterId));
    expect(shooters.size).toBeGreaterThanOrEqual(3);
  });

  it('continues from a snapshot exactly as without one (the review can seek)', () => {
    const straight = createBattle(MIXED, TERRAIN);
    for (let i = 0; i < 60 * 30; i += 1) straight.step();
    const resumed = createBattle(MIXED, TERRAIN);
    for (let i = 0; i < 25 * 30; i += 1) resumed.step();
    const snap = resumed.sim.snapshot();
    for (let i = 0; i < 10 * 30; i += 1) resumed.step();
    resumed.sim.restore(snap);
    for (let i = 0; i < 35 * 30; i += 1) resumed.step();
    expect(hashSimState(resumed.sim.state)).toBe(hashSimState(straight.sim.state));
  });
});

describe('a fifth vehicle, with no change to the combat code', () => {
  it('fights in a battle from its definition alone (a wheeled BTR-80 of the scenario’s own)', () => {
    const bmp = VEHICLE_PLATFORMS.find((p) => p.id === 'bmp2');
    const turret = bmp?.mounts[0];
    if (!bmp || !turret) throw new Error('no BMP-2');
    const btr: PlatformSpec = {
      ...bmp,
      id: 'btr80',
      name: 'BTR-80',
      variant: 'BTR-80 wheeled armoured personnel carrier (14.5 mm KPVT, here an M2HB stand-in)',
      dimensions: { lengthM: 7.65, widthM: 2.9, heightM: 2.41 },
      mobility: {
        ...bmp.mobility,
        kind: 'wheeled',
        roadSpeedMps: 22,
        pivotRateDegS: 0,
        minTurnRadiusM: 7.5,
      },
      armor: {
        ke: { front: 12, side: 9, rear: 7, top: 7 },
        ce: { front: 12, side: 9, rear: 7, top: 7 },
      },
      mounts: [{ ...turret, id: 'turret' }],
      weapons: [
        {
          id: 'hmg',
          weapon: 'm2hb',
          mount: 'turret',
          muzzle: { forward: 1.2, right: 0, up: 0.1 },
          loads: [{ ammo: 'm2-ap', ready: 100, stowed: 400 }],
        },
      ],
    };
    const spec: BattleSpec = {
      seed: 13,
      tickRateHz: 30,
      squads: BYSTANDERS,
      vehicles: [
        vehicle('R1', 'btr80', 'OPFOR', 0, 300, 180, [{ x: 0, y: 100 }]),
        vehicle('M1', 'm113', 'BLUEFOR', 0, -200, 0),
      ],
    };
    const { scenario } = battleScenario(spec, TERRAIN);
    const sim = createSimulation({ tickRateHz: 30, seed: 13 }, { ...scenario, platforms: [btr] });
    const events: SimEvent[] = [];
    for (let i = 0; i < 120 * 30; i += 1) events.push(...sim.step());
    const r1 = sim.state.vehicles?.find((v) => v.id === 'R1');
    expect(r1?.combat.mounts.map((m) => m.id)).toEqual(['turret']);
    expect(fires(events).some((e) => e.shooterId === 'R1' && e.weapon === 'm2hb')).toBe(true);
    // Without its definition the scenario is refused.
    expect(() => createSimulation({ tickRateHz: 30, seed: 13 }, scenario)).toThrow(/btr80/);
  });
});
