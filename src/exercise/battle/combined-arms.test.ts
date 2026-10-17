import { describe, expect, it } from 'vitest';
import {
  createSimulation,
  hashSimState,
  NO_FEATURES,
  VEHICLE_PLATFORMS,
  type PlatformSpec,
  type ScenarioVehicle,
  type SimEvent,
  type VehicleFireEvent,
  type VehicleHitEvent,
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
  seed: 8,
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

  it('a main gun’s round flies at its velocity, and its hit lands when it arrives', () => {
    const { events } = run(TANK_DUEL, 120);
    const shots = fires(events).filter((e) => e.slot === 'main');
    expect(shots.length).toBeGreaterThan(0);
    for (const e of shots) {
      // M829A1 1,575 m/s, 3BM42 1,700 m/s: range ÷ velocity.
      const v = e.ammo === 'm829a1' ? 1575 : 1700;
      expect(e.impactAt).toBeCloseTo(e.atSeconds + e.rangeM / v, 6);
    }
    const hit = shots.find((e) => e.hit && e.rangeM > 700);
    if (!hit?.impactAt) throw new Error('no hit at range');
    // Its damage: at the first decision once it has arrived (decisions every 0.1 s), not when fired.
    const struck = events.find(
      (e): e is VehicleHitEvent =>
        e.type === 'vehicleHit' && e.byId === hit.shooterId && e.atSeconds > hit.atSeconds,
    );
    expect(struck?.atSeconds).toBeGreaterThanOrEqual(hit.impactAt - 1e-9);
    expect(struck?.atSeconds).toBeLessThan(hit.impactAt + 0.1 + 1e-9);
  });

  it('tanks in plain view of each other engage within seconds (a plain target is found at once)', () => {
    for (const seed of [6, 7, 8, 9, 10]) {
      const { events } = run(
        {
          seed,
          tickRateHz: 30,
          squads: BYSTANDERS,
          vehicles: [
            vehicle('A1', 'm1a1', 'BLUEFOR', 0, -200, 0),
            vehicle('T1', 't72b', 'OPFOR', 0, 200, 180),
          ],
        },
        10,
      );
      const first = fires(events).find((e) => e.target === 'vehicle');
      expect(first?.atSeconds).toBeLessThan(7);
    }
  });

  it('Abrams against infantry: machine guns, not the main gun; soldiers fall', () => {
    const { events } = run(
      {
        seed: 3,
        tickRateHz: 30,
        squads: [
          BX,
          squad('O', 'OPFOR', 0, 0, 180, {
            antiTank: 'none',
            plan: [{ kind: 'move', destination: { x: 0, y: -300 } }],
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
      // An AT4's rocket flies at 285 m/s: it strikes when it arrives.
      if (e.weapon === 'at4') expect(e.impactAt).toBeCloseTo(e.atSeconds + e.rangeM / 285, 6);
    }
    // Rounds spent: what they fired is gone from what they carry.
    for (const a of battle.sim.state.combat?.antiTank ?? []) {
      const carried = a.weapon === 'javelin' ? 2 : 2;
      expect(a.loaded + a.reserve + a.fired).toBe(carried);
    }
    // Their hits tell on the armour (the vehicles may still win the fight).
    const struck = events.filter(
      (e) => e.type === 'vehicleHit' && carriers.has(e.byId) && e.perforated,
    );
    expect(struck.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'vehicleCondition' && e.from === 'operational')).toBe(
      true,
    );
  });

  it('carries rockets by default, and only in a battle with vehicles', () => {
    const { squads } = battleScenario(TANK_DUEL, TERRAIN);
    const b = squads.find((s) => s.spec.id === 'BX');
    if (!b) throw new Error('no squad');
    expect(antiTankLoadoutOf(squad('S', 'BLUEFOR', 0, 0, 0))).toBe('rockets');
    expect(antiTankLoadoutOf(squad('S', 'OPFOR', 0, 0, 0, { antiTank: 'none' }))).toBe('none');
    const rockets = antiTankWeapons(b, 'rockets');
    expect(Object.values(rockets)).toEqual(['at4', 'at4', 'at4']);
    // A battle without vehicles: no anti-tank weapons and no combat state, as before.
    const plain = run({ seed: 1, tickRateHz: 30, squads: BYSTANDERS }, 5);
    expect(plain.battle.sim.state.combat).toBeUndefined();
    const { scenario } = battleScenario({ seed: 1, tickRateHz: 30, squads: BYSTANDERS }, TERRAIN);
    expect(scenario.fof?.forces.every((f) => f.antiTank === undefined)).toBe(true);
  });

  it('a vehicle at rest turns its front toward the enemy it sees; on the move it drives on', () => {
    const battle = createBattle(
      {
        seed: 6,
        tickRateHz: 30,
        // Facing north, an enemy squad off to the east; an M113 driving north past it.
        squads: [BX, squad('OE', 'OPFOR', 600, 0, 270, { antiTank: 'none', posture: 'prone' })],
        vehicles: [
          vehicle('A1', 'm1a1', 'BLUEFOR', 0, 0, 0),
          vehicle('M1', 'm113', 'BLUEFOR', -200, -300, 0, [{ x: -200, y: 300 }]),
        ],
      },
      TERRAIN,
    );
    for (let i = 0; i < 12 * 30; i += 1) battle.step();
    const a1 = battle.sim.state.vehicles?.find((v) => v.id === 'A1');
    const m1 = battle.sim.state.vehicles?.find((v) => v.id === 'M1');
    if (!a1 || !m1) throw new Error('no vehicles');
    const deg = (rad: number) => (rad * 180) / Math.PI;
    expect(a1.combat.tracks.some((t) => t.targetId.startsWith('OE-') && t.confirmed)).toBe(true);
    expect(Math.abs(deg(a1.heading) - 90)).toBeLessThan(10);
    // The M113 on its way keeps its heading for its waypoint.
    expect(Math.min(deg(m1.heading), 360 - deg(m1.heading))).toBeLessThan(10);
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
    const shooters = new Set([
      ...fires(a.events).map((e) => e.shooterId),
      ...a.events.flatMap((e) => (e.type === 'fofFire' ? [e.shooterId as string] : [])),
    ]);
    expect(shooters.size).toBeGreaterThanOrEqual(3);
    expect(fires(a.events).filter((e) => e.shooter === 'vehicle').length).toBeGreaterThan(1);
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

  it('draws every pair’s detectability threshold at the start, enemies only', () => {
    // So a pair that could not detect its target in full view is known
    // before its sight line is traced.
    const battle = createBattle(MIXED, TERRAIN);
    battle.step();
    const { state } = battle.sim;
    const vehicles = state.vehicles ?? [];
    const keys = Object.keys(state.combat?.thresholds ?? {}).sort();
    const expected: string[] = [];
    for (const v of vehicles) {
      for (const s of state.soldiers) if (s.side !== v.side) expected.push(`${v.id}>${s.id}`);
      for (const o of vehicles) if (o.side !== v.side) expected.push(`${v.id}>${o.id}`);
    }
    for (const s of state.soldiers)
      for (const v of vehicles) if (v.side !== s.side) expected.push(`${s.id}>${v.id}`);
    expect(keys).toEqual(expected.sort());
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
      seed: 12,
      tickRateHz: 30,
      squads: BYSTANDERS,
      vehicles: [
        vehicle('R1', 'btr80', 'OPFOR', 0, 300, 180, [{ x: 0, y: 100 }]),
        vehicle('M1', 'm113', 'BLUEFOR', 0, -200, 0),
      ],
    };
    const { scenario } = battleScenario(spec, TERRAIN);
    const sim = createSimulation({ tickRateHz: 30, seed: 12 }, { ...scenario, platforms: [btr] });
    const events: SimEvent[] = [];
    for (let i = 0; i < 120 * 30; i += 1) events.push(...sim.step());
    const r1 = sim.state.vehicles?.find((v) => v.id === 'R1');
    expect(r1?.combat.mounts.map((m) => m.id)).toEqual(['turret']);
    expect(fires(events).some((e) => e.shooterId === 'R1' && e.weapon === 'm2hb')).toBe(true);
    // Without its definition the scenario is refused.
    expect(() => createSimulation({ tickRateHz: 30, seed: 12 }, scenario)).toThrow(/btr80/);
  });
});

describe('under fire it cannot return', () => {
  it('a squad pressing on under fire crawls on: prone the whole way, at a crawl, not walking upright', () => {
    // An OPFOR squad moving on (actions on contact: continue) toward an M113
    // whose machine gun outranges every weapon it has.
    const spec: BattleSpec = {
      seed: 3,
      tickRateHz: 30,
      squads: [
        BX,
        squad('O1', 'OPFOR', 0, -200, 0, {
          antiTank: 'none',
          plan: [{ kind: 'move', destination: { x: 0, y: 900 }, actionsOn: 'continue' }],
        }),
      ],
      vehicles: [vehicle('V1', 'm113', 'BLUEFOR', 0, 700, 180)],
    };
    const battle = createBattle(spec, TERRAIN);
    const fof = () => battle.sim.state.fof?.forces.find((f) => f.unitId.startsWith('O1'));
    const ahead = () => {
      const up = battle.sim.state.soldiers.filter(
        (s) => s.id.startsWith('O1-') && s.status === 'active',
      );
      return up.reduce((m, s) => m + s.position.y, 0) / Math.max(1, up.length);
    };
    /** When the M113 last fired at the squad. */
    let firedAt = -Infinity;
    let fired = 0;
    let upright = 0;
    let crawled = 0;
    let crawlFrom: number | null = null;
    let crawlTo = 0;
    for (let i = 0; i < 300 * 30; i += 1) {
      const t = i / 30;
      for (const e of battle.step())
        if (e.type === 'vehicleFire' && e.targetId.startsWith('O1-')) {
          firedAt = t;
          fired += 1;
        }
      const force = fof();
      if (force?.phase === 'moving' && force.crawling) {
        crawled += 1;
        crawlFrom ??= ahead();
        crawlTo = ahead();
      }
      // From 3 s after a burst (time to react) to 10 s: everyone down.
      if (t - firedAt < 3 || t - firedAt > 10) continue;
      for (const s of battle.sim.state.soldiers)
        if (s.id.startsWith('O1-') && s.status === 'active' && s.posture === 'standing')
          upright += 1;
    }
    expect(fired).toBeGreaterThanOrEqual(5);
    expect(upright).toBe(0);
    // Fired on as it pressed on, it crawled on (45 s from the last burst), at a crawl's pace.
    expect(crawled / 30).toBeGreaterThan(45);
    const gained = crawlTo - (crawlFrom ?? 0);
    expect(gained).toBeGreaterThan(0.15 * (crawled / 30));
    expect(gained).toBeLessThan(0.45 * (crawled / 30));
  });
});

describe('vehicles and soldiers', () => {
  it('a vehicle does not drive over soldiers in its way: it passes a squad walking on its line, and arrives', () => {
    // A squad walking north in file, and behind it, on the same line, an M113 of its side.
    const spec: BattleSpec = {
      seed: 5,
      tickRateHz: 30,
      squads: [
        squad('B1', 'BLUEFOR', 0, -300, 0, {
          antiTank: 'none',
          formation: 'usmc.squad.column',
          plan: [{ kind: 'move', destination: { x: 0, y: 500 } }],
        }),
        OX,
      ],
      vehicles: [vehicle('V1', 'm113', 'BLUEFOR', 0, -420, 0, [{ x: 0, y: 700 }])],
    };
    const battle = createBattle(spec, TERRAIN);
    const m113 = VEHICLE_PLATFORMS.find((p) => p.id === 'm113');
    const length = m113?.dimensions.lengthM ?? 5;
    const width = m113?.dimensions.widthM ?? 3;
    let under = 0;
    let passed = false;
    for (let i = 0; i < 200 * 30; i += 1) {
      battle.step();
      const v = battle.sim.state.vehicles?.[0];
      if (!v) throw new Error('no vehicle');
      const fx = Math.sin(v.heading);
      const fy = Math.cos(v.heading);
      for (const s of battle.sim.state.soldiers) {
        if (!s.id.startsWith('B1-') || s.status !== 'active') continue;
        const dx = s.position.x - v.position.x;
        const dy = s.position.y - v.position.y;
        // Under its hull (with a hand's breadth round it).
        if (
          Math.abs(dx * fx + dy * fy) < length / 2 + 0.2 &&
          Math.abs(dx * fy - dy * fx) < width / 2 + 0.2
        )
          under += 1;
      }
      const lead = Math.max(
        ...battle.sim.state.soldiers.filter((s) => s.id.startsWith('B1-')).map((s) => s.position.y),
      );
      if (v.position.y > lead + 10) passed = true;
    }
    expect(under).toBe(0);
    // It went past them (round them), and on to its destination.
    expect(passed).toBe(true);
    const v = battle.sim.state.vehicles?.[0];
    expect(v?.orders[0]?.status).toBe('completed');
  });

  it('nor over soldiers crossing its way: they step aside, it brakes', () => {
    // A squad walking east across the line an M113 drives north along, as it comes.
    const spec: BattleSpec = {
      seed: 9,
      tickRateHz: 30,
      squads: [
        squad('B1', 'BLUEFOR', -45, 0, 90, {
          antiTank: 'none',
          formation: 'usmc.squad.column',
          plan: [{ kind: 'move', destination: { x: 200, y: 0 } }],
        }),
        OX,
      ],
      vehicles: [vehicle('V1', 'm113', 'BLUEFOR', 0, -240, 0, [{ x: 0, y: 300 }])],
    };
    const battle = createBattle(spec, TERRAIN);
    const m113 = VEHICLE_PLATFORMS.find((p) => p.id === 'm113');
    const length = m113?.dimensions.lengthM ?? 5;
    const width = m113?.dimensions.widthM ?? 3;
    let under = 0;
    let closest = Infinity;
    for (let i = 0; i < 150 * 30; i += 1) {
      battle.step();
      const v = battle.sim.state.vehicles?.[0];
      if (!v) throw new Error('no vehicle');
      const fx = Math.sin(v.heading);
      const fy = Math.cos(v.heading);
      for (const s of battle.sim.state.soldiers) {
        if (!s.id.startsWith('B1-') || s.status !== 'active') continue;
        const dx = s.position.x - v.position.x;
        const dy = s.position.y - v.position.y;
        closest = Math.min(closest, Math.hypot(dx, dy));
        if (Math.abs(dx * fx + dy * fy) < length / 2 && Math.abs(dx * fy - dy * fx) < width / 2)
          under += 1;
      }
    }
    // They met (the squad crossed close in front of it), and none was under it.
    expect(closest).toBeLessThan(8);
    expect(under).toBe(0);
    expect(battle.sim.state.vehicles?.[0]?.orders[0]?.status).toBe('completed');
  });

  it('a squad of its side halted in a narrow street makes way for it', () => {
    // A street 9 m wide between two long blocks, a squad standing in column
    // down the middle of it (no orders), and an M113 to drive through: there
    // is no way past them; they step aside, and it goes on.
    const block = (id: string, x0: number, x1: number) => ({
      id,
      footprint: [
        { x: x0, y: -150 },
        { x: x1, y: -150 },
        { x: x1, y: 150 },
        { x: x0, y: 150 },
      ],
      heightMeters: 10,
    });
    const street = labTerrain({
      ...NO_FEATURES,
      buildings: [block('west', -60, -4.5), block('east', 4.5, 60)],
    });
    const spec: BattleSpec = {
      seed: 4,
      tickRateHz: 30,
      squads: [
        squad('B1', 'BLUEFOR', 0, 0, 0, { antiTank: 'none', formation: 'usmc.squad.column' }),
        OX,
      ],
      vehicles: [vehicle('V1', 'm113', 'BLUEFOR', 0, -250, 0, [{ x: 0, y: 250 }])],
    };
    const battle = createBattle(spec, street);
    const m113 = VEHICLE_PLATFORMS.find((p) => p.id === 'm113');
    const length = m113?.dimensions.lengthM ?? 5;
    const width = m113?.dimensions.widthM ?? 3;
    let under = 0;
    for (let i = 0; i < 180 * 30; i += 1) {
      battle.step();
      const v = battle.sim.state.vehicles?.[0];
      if (!v) throw new Error('no vehicle');
      for (const s of battle.sim.state.soldiers) {
        if (!s.id.startsWith('B1-') || s.status !== 'active') continue;
        const dx = s.position.x - v.position.x;
        const dy = s.position.y - v.position.y;
        if (Math.abs(dy) < length / 2 && Math.abs(dx) < width / 2) under += 1;
      }
    }
    // It waited for good behind them.
    expect(battle.sim.state.vehicles?.[0]?.orders[0]?.status).toBe('completed');
    expect(under).toBe(0);
  });
});
