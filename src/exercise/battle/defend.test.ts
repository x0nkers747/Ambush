import { describe, expect, it } from 'vitest';
import { azimuthDelta, type ForcePhaseChangedEvent, type SimEvent } from '#sim';
import { labTerrain } from '../behavior-lab/run';
import { FOF_DEFAULT_CONFIG } from '../forces/forces';
import { createBattle, type BattleSpec, type SquadSpec } from './battle';
import {
  addOrder,
  addSquad,
  battleSpecOf,
  newBattleScenario,
  parseBattleScenario,
  resizeDefendArc,
  scenarioIssues,
  setDefendPrepared,
  setDefendSector,
  setOrderKind,
  type BattleEdit,
  type BattleScenarioDefinition,
} from './scenario';

// The defend order (docs/behavior-lab/force-on-force/09). A BLUEFOR squad
// defends a position on open ground, facing north; it digs in over time.
// With an OPFOR squad attacking from the north, it fights from the position;
// dug in, it loses fewer soldiers.

const TERRAIN = labTerrain();
const AT = { x: 0, y: 0 };
/** Digging in takes 300 s here (30 min in the game), so the tests are quick. */
const CONFIG = { ...FOF_DEFAULT_CONFIG, force: { ...FOF_DEFAULT_CONFIG.force, digInSeconds: 300 } };

function spec(
  seed: number,
  o: {
    arc?: number;
    prepared?: number;
    attack?: boolean;
    /** The game's own dig-in time (30 minutes) instead of the tests' 300 s. */
    gameDigIn?: boolean;
  } = {},
): BattleSpec {
  const red: SquadSpec = o.attack
    ? {
        id: 'O1',
        name: 'Red',
        side: 'OPFOR',
        organization: 'squad',
        position: { x: 0, y: 900 },
        facingDeg: 180,
        plan: [{ kind: 'attack', destination: { x: 0, y: -100 } }],
      }
    : {
        // Far off (out of sight), holding.
        id: 'O1',
        name: 'Red',
        side: 'OPFOR',
        organization: 'fireTeam',
        position: { x: 1100, y: 1100 },
        facingDeg: 180,
        plan: [],
      };
  return {
    seed,
    tickRateHz: 30,
    config: o.gameDigIn ? FOF_DEFAULT_CONFIG : CONFIG,
    squads: [
      {
        id: 'B1',
        name: 'Blue',
        side: 'BLUEFOR',
        organization: 'squad',
        position: { x: -40, y: -60 },
        facingDeg: 0,
        plan: [
          {
            kind: 'defend',
            destination: AT,
            sector: { facing: 0, arc: o.arc ?? Math.PI / 2 },
            ...(o.prepared !== undefined ? { preparedSeconds: o.prepared } : {}),
          },
        ],
      },
      red,
    ],
  };
}

function run(
  battleSpec: BattleSpec,
  seconds: number,
  at?: (b: ReturnType<typeof createBattle>) => void,
) {
  const battle = createBattle(battleSpec, TERRAIN);
  const events: SimEvent[] = [];
  for (let tick = 1; tick <= seconds * 30; tick += 1) {
    events.push(...battle.step());
    if (tick % 30 === 0) at?.(battle);
  }
  const blue = events.filter(
    (e): e is ForcePhaseChangedEvent => e.type === 'forcePhaseChanged' && e.side === 'BLUEFOR',
  );
  return { battle, events, blue };
}

describe('the defend order', { timeout: 300_000 }, () => {
  it('occupies its position, lies prone facing its sector, and digs in over time', () => {
    const levels: number[] = [];
    const { battle, blue } = run(spec(1), 250, (b) =>
      levels.push(b.sim.state.fof?.forces[0]?.dugIn ?? 0),
    );
    expect(blue.map((e) => e.to)).toContain('defending');
    const force = battle.sim.state.fof?.forces[0];
    // Once deployed it digs at a steady rate: fully dug in after 300 s here.
    const start = levels.findIndex((l) => l > 0);
    expect(start).toBeGreaterThan(0);
    expect(force?.dugIn).toBeCloseTo((levels.length - start) / 300, 1);
    for (let k = 1; k < levels.length; k += 1)
      expect(levels[k] ?? 0).toBeGreaterThanOrEqual(levels[k - 1] ?? 0);
    const soldiers = battle.sim.state.soldiers.filter((s) => s.side === 'BLUEFOR');
    for (const s of soldiers) {
      expect(s.posture).toBe('prone');
      // Each faces within the 90° sector toward north.
      expect(Math.abs(azimuthDelta(0, s.azimuth))).toBeLessThanOrEqual(Math.PI / 4 + 1e-6);
    }
    // Facing its whole width: from one end of the arc to the other.
    const spread = soldiers.map((s) => azimuthDelta(0, s.azimuth));
    expect(Math.max(...spread) - Math.min(...spread)).toBeGreaterThan(Math.PI / 3);
    // Every soldier's fighting position is recorded, as far dug as the squad.
    expect(force?.earthworks).toHaveLength(13);
    for (const w of force?.earthworks ?? []) expect(w.level).toBeCloseTo(force?.dugIn ?? 0, 2);
  });

  it('is fully dug in after its dig-in time, and a prepared position starts dug in', () => {
    expect(run(spec(1), 450).battle.sim.state.fof?.forces[0]?.dugIn).toBe(1);
    const prepared = run(spec(1, { prepared: 150 }), 120).battle.sim.state.fof?.forces[0];
    expect(prepared?.phase).toBe('defending');
    expect(prepared?.dugIn).toBeGreaterThanOrEqual(0.5);
  });

  it('all round, it forms a ring, each soldier facing outward', () => {
    const { battle } = run(spec(1, { arc: 2 * Math.PI }), 150);
    const soldiers = battle.sim.state.soldiers.filter((s) => s.side === 'BLUEFOR');
    const cx = soldiers.reduce((a, s) => a + s.position.x, 0) / soldiers.length;
    const cy = soldiers.reduce((a, s) => a + s.position.y, 0) / soldiers.length;
    for (const s of soldiers) {
      const out = Math.atan2(s.position.x - cx, s.position.y - cy);
      expect(Math.abs(azimuthDelta(out, s.azimuth))).toBeLessThan(0.3);
      expect(Math.hypot(s.position.x - cx, s.position.y - cy)).toBeGreaterThan(6);
    }
  });

  it('fights from its position when attacked, never moving on; dug in, it loses fewer soldiers', () => {
    // The game's 30 minutes to dig in: unprepared, it is about a fifth dug in when the attack comes.
    let inOpen = 0;
    let dugIn = 0;
    for (const seed of [1, 2, 3]) {
      for (const prepared of [0, 1800]) {
        const { battle, blue } = run(spec(seed, { attack: true, prepared, gameDigIn: true }), 700);
        const after = blue.slice(blue.findIndex((e) => e.to === 'defending'));
        expect(after.some((e) => e.to === 'moving' || e.to === 'assaulting')).toBe(false);
        expect(after.some((e) => e.to === 'contact' || e.to === 'engaged')).toBe(true);
        const down = battle.sim.state.soldiers.filter(
          (s) => s.side === 'BLUEFOR' && s.status !== 'active',
        ).length;
        if (prepared === 0) inOpen += down;
        else dugIn += down;
      }
    }
    expect(dugIn).toBeLessThan(inOpen);
  });

  it('given another order, loses its dig-in', () => {
    const { battle } = run(spec(1, { prepared: 300 }), 140, (b) => {
      if (b.sim.tick === 130 * 30) {
        b.submit({
          type: 'orderSquad',
          tick: b.sim.tick,
          unitId: 'B1-SQD',
          mode: 'replace',
          orders: [{ kind: 'move', destination: { x: -100, y: -100 } }],
        });
      }
    });
    const force = battle.sim.state.fof?.forces[0];
    expect(force?.dugIn).toBe(0);
    // Its fighting positions stay where they were dug.
    expect(force?.earthworks.length).toBe(13);
    expect(force?.earthworks.every((w) => w.level === 1)).toBe(true);
  });
});

describe('a defence in the scenario', () => {
  const done = (edit: BattleEdit): BattleScenarioDefinition => {
    if (!edit.ok) throw new Error(edit.problem);
    return edit.definition;
  };
  let d = newBattleScenario(TERRAIN, 'bf');
  d = done(addSquad(TERRAIN, d, 'BLUEFOR', 'squad', { x: -300, y: -300 }));
  d = done(addOrder(TERRAIN, d, 'B1', 'defend', { x: 0, y: 0 }));

  it('needs its direction; a second click sets it, facing that way with a 90° arc', () => {
    expect(scenarioIssues(TERRAIN, d).some((i) => i.message.includes('direction it defends'))).toBe(
      true,
    );
    const set = done(setDefendSector(d, 'B1', 0, { x: 100, y: 0 }));
    expect(set.squads[0]?.plan[0]?.sector).toEqual({ facingDeg: 90, arcDeg: 90 });
    expect(
      scenarioIssues(TERRAIN, set).some((i) => i.message.includes('direction it defends')),
    ).toBe(false);
  });

  it('its arc is dragged wider or narrower by its handle, at least 20°, and near all round, all round', () => {
    const set = done(setDefendSector(d, 'B1', 0, { x: 0, y: 100 }));
    const arc = (p: { x: number; y: number }) =>
      done(resizeDefendArc(set, 'B1', 0, p)).squads[0]?.plan[0]?.sector?.arcDeg;
    // The handle 60° off the facing: 120° wide.
    expect(arc({ x: 100 * Math.sin(Math.PI / 3), y: 100 * Math.cos(Math.PI / 3) })).toBeCloseTo(
      120,
      6,
    );
    expect(arc({ x: 1, y: 100 })).toBe(20);
    expect(arc({ x: -1, y: -100 })).toBe(360);
  });

  it('can be prepared for up to 30 minutes, saved and read back, and is the simulation’s in radians', () => {
    let p = done(setDefendSector(d, 'B1', 0, { x: 0, y: 100 }));
    p = done(setDefendPrepared(p, 'B1', 0, 20));
    expect(setDefendPrepared(p, 'B1', 0, 31).ok).toBe(false);
    expect(parseBattleScenario(JSON.parse(JSON.stringify(p)))).toEqual(p);
    const order = battleSpecOf(p, 30).squads[0]?.plan[0];
    expect(order?.sector?.facing).toBeCloseTo(0, 9);
    expect(order?.sector?.arc).toBeCloseTo(Math.PI / 2, 9);
    expect(order?.preparedSeconds).toBe(1200);
    // Another kind drops the sector and the preparation.
    const moved = done(setOrderKind(p, 'B1', 0, 'move')).squads[0]?.plan[0];
    expect(moved?.sector).toBeUndefined();
    expect(moved?.preparedMinutes).toBeUndefined();
    // An order after a defence is never carried out.
    const after = done(addOrder(TERRAIN, p, 'B1', 'move', { x: 100, y: 100 }));
    expect(
      scenarioIssues(TERRAIN, after).some((i) =>
        i.message.includes('a defence waits for new orders'),
      ),
    ).toBe(true);
  });
});
