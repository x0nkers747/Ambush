import { describe, expect, it } from 'vitest';
import {
  hashSimState,
  type FofOrder,
  type OrderChangedEvent,
  type SimEvent,
  type TerrainDataset,
} from '#sim';
import { labTerrain } from '../behavior-lab/run';
import {
  createBattle,
  orderSquad,
  validateBattleSpec,
  type Battle,
  type SquadSpec,
} from './battle';

// Milestone A (docs/constructive-simulation/02): several squads a side, each
// with its own plan of move, attack and withdraw orders, carried out by the
// force-on-force behaviour in one simulation; orders given while it runs
// (replace, append, clear), and exact replay from the command log.

const TERRAIN: TerrainDataset = labTerrain();

/** Three squads a side, with different plans (one BLUEFOR squad has none: it holds). */
const SQUADS: readonly SquadSpec[] = [
  {
    id: 'B1',
    name: '1st Squad',
    side: 'BLUEFOR',
    organization: 'squad',
    position: { x: -300, y: -700 },
    facingDeg: 0,
    plan: [
      { kind: 'move', destination: { x: -300, y: -300 } },
      { kind: 'attack', destination: { x: -300, y: 300 } },
    ],
  },
  {
    id: 'B2',
    name: '2nd Squad',
    side: 'BLUEFOR',
    organization: 'squad',
    position: { x: 0, y: -700 },
    facingDeg: 0,
    plan: [
      { kind: 'move', destination: { x: 0, y: 0 } },
      { kind: 'withdraw', destination: { x: 0, y: -600 } },
    ],
  },
  {
    id: 'B3',
    name: '3rd Squad',
    side: 'BLUEFOR',
    organization: 'squad',
    position: { x: 300, y: -700 },
    facingDeg: 0,
    plan: [],
  },
  {
    id: 'O1',
    name: 'Enemy squad',
    side: 'OPFOR',
    organization: 'squad',
    position: { x: -300, y: 700 },
    facingDeg: 180,
    plan: [{ kind: 'move', destination: { x: -300, y: 100 } }],
  },
  {
    id: 'O2',
    name: 'Enemy team',
    side: 'OPFOR',
    organization: 'fireTeam',
    position: { x: 0, y: 700 },
    facingDeg: 180,
    plan: [{ kind: 'attack', destination: { x: 0, y: -200 } }],
  },
  {
    id: 'O3',
    name: 'Enemy patrol',
    side: 'OPFOR',
    organization: 'element3',
    position: { x: 300, y: 700 },
    facingDeg: 180,
    plan: [
      { kind: 'move', destination: { x: 300, y: 400 } },
      { kind: 'move', destination: { x: 600, y: 400 } },
    ],
  },
];

const spec = (seed = 1) => ({ squads: SQUADS, seed, tickRateHz: 30 });

/** Steps to `seconds`, calling `at` before each tick (commands given then apply at that tick). */
function runTo(battle: Battle, seconds: number, at?: (battle: Battle) => void): SimEvent[] {
  const events: SimEvent[] = [];
  while (battle.sim.timeSeconds < seconds) {
    at?.(battle);
    events.push(...battle.step());
  }
  return events;
}

const ordersOf = (battle: Battle, squad: string): readonly FofOrder[] =>
  battle.sim.state.fof?.forces.find((f) => f.unitId.startsWith(`${squad}-`))?.orders ?? [];
const changes = (events: readonly SimEvent[], squad: string) =>
  events.filter(
    (e): e is OrderChangedEvent => e.type === 'orderChanged' && e.unitId.startsWith(`${squad}-`),
  );

describe('a battle of several squads a side, each on its own plan', () => {
  const battle = createBattle(spec(), TERRAIN);
  const inContact: number[] = [];
  const events = runTo(battle, 1500, (b) => {
    if (b.sim.tick % 300 !== 0) return;
    const fighting = (b.sim.state.fof?.forces ?? []).filter((f) =>
      ['contact', 'engaged', 'assaulting'].includes(f.phase),
    );
    inContact.push(fighting.length);
  });

  it('builds every squad as a force of its own, with stable ids', () => {
    const forces = battle.sim.state.fof?.forces ?? [];
    expect(forces.map((f) => f.unitId)).toEqual([
      'B1-SQD',
      'B2-SQD',
      'B3-SQD',
      'O1-SQD',
      'O2-FT',
      'O3-TM',
    ]);
    expect(forces.map((f) => f.name)).toEqual(SQUADS.map((s) => s.name));
    expect(battle.sim.state.soldiers.some((s) => s.id === 'B2-13')).toBe(true);
    expect(battle.sim.state.soldiers.some((s) => s.id === 'O3-03')).toBe(true);
  });

  it('carries out each squad’s orders in turn, through contact', () => {
    // B2: its move, through contact with O1, which breaks and falls back
    // 500 m; B2 fights it at long range until its own ammunition runs low,
    // breaking contact in turn (its move fails), then starts its withdrawal.
    const b2 = changes(events, 'B2');
    expect(b2.map((e) => `${e.orderId} ${e.to}`)).toEqual([
      'B2-SQD#1 active',
      'B2-SQD#1 failed',
      'B2-SQD#2 active',
    ]);
    expect(b2[1]?.reason).toBe('broke contact: ammunition low');
    // O3: two moves, in turn.
    expect(ordersOf(battle, 'O3').map((o) => o.status)).toEqual(['completed', 'completed']);
    // The order is the intent; the phases are what the squad did meanwhile.
    const b2Phases = events.filter(
      (e) => e.type === 'forcePhaseChanged' && e.unitId === 'B2-SQD' && e.to === 'engaged',
    );
    expect(b2Phases.length).toBeGreaterThan(0);
  });

  it('a squad without orders holds where it is', () => {
    expect(ordersOf(battle, 'B3')).toEqual([]);
    const b3 = battle.sim.state.fof?.forces.find((f) => f.unitId === 'B3-SQD');
    expect(b3?.phase).not.toBe('moving');
    const start = SQUADS[2]?.position ?? { x: 0, y: 0 };
    const own = battle.sim.state.soldiers.filter((s) => s.unitId.startsWith('B3-'));
    const cx = own.reduce((a, s) => a + s.position.x, 0) / own.length;
    const cy = own.reduce((a, s) => a + s.position.y, 0) / own.length;
    expect(Math.hypot(cx - start.x, cy - start.y)).toBeLessThan(15);
  });

  it('fights several engagements at once', () => {
    expect(Math.max(...inContact)).toBeGreaterThanOrEqual(3);
  });

  it('a squad made combat ineffective fails its orders; nothing is left active or pending', () => {
    const forces = battle.sim.state.fof?.forces ?? [];
    for (const force of forces.filter((f) => f.phase === 'ineffective')) {
      for (const order of force.orders) {
        expect(['completed', 'failed']).toContain(order.status);
      }
      expect(force.activeOrderId).toBeNull();
    }
    expect(forces.some((f) => f.phase === 'ineffective')).toBe(true);
    // Every order that ended says why.
    for (const order of forces.flatMap((f) => f.orders)) {
      if (order.status !== 'active' && order.status !== 'pending') {
        expect(order.reason).not.toBeNull();
        expect(order.endedAt).not.toBeNull();
      }
    }
  });

  it('never ends by itself, and refuses nothing', () => {
    expect(battle.sim.state.fof?.outcome).toBeNull();
    expect(events.some((e) => e.type === 'fofEnded')).toBe(false);
    expect(events.filter((e) => e.type === 'commandRejected')).toEqual([]);
  });
});

// A combat-ineffective squad, ordered on: ineffective.test.ts.

describe('orders given during the battle', () => {
  it('replace supersedes the active and pending orders; append adds after them; an empty replace clears', () => {
    const battle = createBattle(spec(2), TERRAIN);
    const events = runTo(battle, 400, (b) => {
      const t = b.sim.tick;
      if (t === 30 * 60) {
        // B3 (no plan) is ordered forward; O3 gets a third move appended.
        b.submit(
          orderSquad(b, 'B3', 'replace', [{ kind: 'move', destination: { x: 300, y: -400 } }]),
        );
        b.submit(
          orderSquad(b, 'O3', 'append', [{ kind: 'move', destination: { x: 600, y: 600 } }]),
        );
      }
      if (t === 30 * 100) {
        // B1, on its first move, is told to go elsewhere instead.
        b.submit(
          orderSquad(b, 'B1', 'replace', [{ kind: 'move', destination: { x: -500, y: -500 } }]),
        );
      }
      if (t === 30 * 150) {
        // B3's plan cleared: it stops and holds.
        b.submit(orderSquad(b, 'B3', 'replace', []));
      }
    });
    const b1 = ordersOf(battle, 'B1');
    expect(b1.map((o) => [o.sequence, o.status, o.source])).toEqual([
      [1, 'superseded', 'scenario'],
      [2, 'superseded', 'scenario'],
      [3, 'completed', 'player'],
    ]);
    expect(b1[0]?.reason).toBe('replaced by a new plan');
    const o3 = ordersOf(battle, 'O3');
    expect(o3.map((o) => o.sequence)).toEqual([1, 2, 3]);
    expect(o3[2]?.source).toBe('player');
    expect(o3[2]?.issuedTick).toBe(30 * 60);
    const b3 = ordersOf(battle, 'B3');
    expect(b3.map((o) => o.status)).toEqual(['canceled']);
    expect(changes(events, 'B3').map((e) => e.to)).toEqual(['pending', 'active', 'canceled']);
    // It stopped where it was.
    const force = battle.sim.state.fof?.forces.find((f) => f.unitId === 'B3-SQD');
    expect(force?.phase).not.toBe('moving');
  }, 60_000);

  it('pending replaces the pending orders only: the active one goes on', () => {
    const battle = createBattle(spec(2), TERRAIN);
    runTo(battle, 30, (b) => {
      if (b.sim.tick === 30 * 10) {
        // B1 is on the first of its two moves: its second is changed, its first goes on.
        b.submit(
          orderSquad(b, 'B1', 'pending', [{ kind: 'move', destination: { x: -400, y: -450 } }]),
        );
      }
    });
    const b1 = ordersOf(battle, 'B1');
    expect(b1.map((o) => [o.sequence, o.status])).toEqual([
      [1, 'active'],
      [2, 'superseded'],
      [3, 'pending'],
    ]);
    // The active order was not interrupted: it began at the start, not when the plan changed.
    expect(b1[0]?.activatedAt).toBe(0);
  }, 60_000);

  it('several orders at the same tick apply in the order given', () => {
    const run = (first: 'replace' | 'append') => {
      const battle = createBattle(spec(3), TERRAIN);
      runTo(battle, 30, (b) => {
        if (b.sim.tick !== 30 * 20) return;
        const a = { kind: 'move' as const, destination: { x: 300, y: -500 } };
        const c = { kind: 'attack' as const, destination: { x: 300, y: 0 } };
        if (first === 'replace') {
          b.submit(orderSquad(b, 'B3', 'replace', [a]));
          b.submit(orderSquad(b, 'B3', 'append', [c]));
        } else {
          b.submit(orderSquad(b, 'B3', 'append', [c]));
          b.submit(orderSquad(b, 'B3', 'replace', [a]));
        }
      });
      return ordersOf(battle, 'B3').map((o) => `${o.kind}:${o.status}`);
    };
    expect(run('replace')).toEqual(['move:active', 'attack:pending']);
    expect(run('append')).toEqual(['attack:superseded', 'move:active']);
  }, 60_000);

  it('refuses orders for an unknown squad and destinations off the battlefield', () => {
    const battle = createBattle(spec(), TERRAIN);
    battle.submit({
      type: 'orderSquad',
      tick: 0,
      unitId: 'X9-SQD',
      mode: 'replace',
      orders: [{ kind: 'move', destination: { x: 0, y: 0 } }],
    });
    battle.submit(
      orderSquad(battle, 'B1', 'append', [{ kind: 'move', destination: { x: 9e5, y: 0 } }]),
    );
    const events = battle.step();
    const reasons = events.flatMap((e) => (e.type === 'commandRejected' ? [e.reason] : []));
    expect(reasons).toEqual(['unknownUnit', 'destinationOffTerrain']);
    expect(ordersOf(battle, 'B1')).toHaveLength(2);
  });

  it('validates the squads: ids and formations', () => {
    const first = SQUADS[0];
    if (!first) throw new Error('no squad');
    const bad = (squads: readonly SquadSpec[]) => () => {
      validateBattleSpec({ ...spec(), squads });
    };
    expect(bad([...SQUADS, { ...first, name: 'again' }])).toThrow(/used twice/);
    expect(bad([{ ...first, id: '1-bad' }])).toThrow(/letters and digits/);
    expect(bad([{ ...first, formation: 'nonsense' }])).toThrow(/no formation/);
  });
});

describe('determinism', () => {
  /** A battle with player orders during it, as the command log records them. */
  const withOrders = () => {
    const battle = createBattle(spec(4), TERRAIN);
    runTo(battle, 600, (b) => {
      if (b.sim.tick === 30 * 120) {
        b.submit(
          orderSquad(b, 'B3', 'replace', [{ kind: 'attack', destination: { x: 300, y: 200 } }]),
        );
      }
      if (b.sim.tick === 30 * 300) {
        b.submit(
          orderSquad(b, 'O1', 'append', [{ kind: 'withdraw', destination: { x: -300, y: 600 } }]),
        );
      }
    });
    return battle;
  };

  it('the same spec and commands give the same run, bit for bit; replay from the log matches', () => {
    const a = withOrders();
    const b = withOrders();
    expect(hashSimState(a.sim.state)).toBe(hashSimState(b.sim.state));
    const replay = createBattle(spec(4), TERRAIN, { commands: a.commands, origins: a.origins });
    while (replay.sim.tick < a.sim.tick) replay.step();
    expect(hashSimState(replay.sim.state)).toBe(hashSimState(a.sim.state));
    expect(a.commands).toHaveLength(2);
    expect(a.origins).toEqual(['user', 'user']);
  }, 120_000);

  it('continues identically from a snapshot taken mid-battle', () => {
    const whole = withOrders();
    const part = createBattle(spec(4), TERRAIN, {
      commands: whole.commands,
      origins: whole.origins,
    });
    while (part.sim.tick < 30 * 200) part.step();
    const snapshot = part.sim.snapshot();
    const resumed = createBattle(spec(4), TERRAIN);
    resumed.sim.restore(snapshot);
    for (const c of whole.commands) if (c.tick >= 30 * 200) resumed.sim.submit(c);
    while (resumed.sim.tick < whole.sim.tick) resumed.sim.step();
    expect(hashSimState(resumed.sim.state)).toBe(hashSimState(whole.sim.state));
  }, 120_000);
});
