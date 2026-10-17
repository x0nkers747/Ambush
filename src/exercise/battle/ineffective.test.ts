import { describe, expect, it } from 'vitest';
import type { KillZone, SimEvent } from '#sim';
import { labTerrain } from '../behavior-lab/run';
import { createBattle, orderSquad, type Battle, type BattleSpec } from './battle';

// A squad made combat ineffective in a battle (docs/behavior-lab/force-on-force/
// 03 §7, docs/constructive-simulation/04): it falls back out of the enemy's
// reach, holding its fire unless fired upon, and only then stays down where
// it is, waiting for orders; it can still be ordered on. An OPFOR squad walks
// across open ground into a BLUEFOR ambush's kill zone 250 m off.

const TERRAIN = labTerrain();
const ZONE: KillZone = { centre: { x: 0, y: -250 }, widthM: 100, depthM: 100, facing: Math.PI };
const spec = (seed: number): BattleSpec => ({
  seed,
  tickRateHz: 30,
  squads: [
    {
      id: 'B1',
      name: 'Blue',
      side: 'BLUEFOR',
      organization: 'squad',
      position: { x: 0, y: 60 },
      facingDeg: 180,
      plan: [{ kind: 'ambush', destination: { x: 0, y: 0 }, killZone: ZONE }],
    },
    {
      id: 'O1',
      name: 'Red',
      side: 'OPFOR',
      organization: 'squad',
      position: { x: -900, y: -250 },
      facingDeg: 90,
      plan: [{ kind: 'move', destination: { x: 900, y: -250 } }],
    },
  ],
});

const red = (b: Battle) => b.sim.state.fof?.forces[1];
const redUp = (b: Battle) =>
  b.sim.state.soldiers.filter((s) => s.side === 'OPFOR' && s.status === 'active');
const centre = (b: Battle) => {
  const up = redUp(b);
  return {
    x: up.reduce((a, s) => a + s.position.x, 0) / up.length,
    y: up.reduce((a, s) => a + s.position.y, 0) / up.length,
  };
};

describe('a combat-ineffective squad in a battle', { timeout: 300_000 }, () => {
  // Seed 6: ambushed, OPFOR breaks, and is made ineffective while it falls back.
  const battle = createBattle(spec(6), TERRAIN);
  const events: SimEvent[] = [];
  let brokeAt: { x: number; y: number } | null = null;
  let ineffectiveWhile: string | null = null;
  while (battle.sim.timeSeconds < 1400) {
    events.push(...battle.step());
    const f = red(battle);
    if (!brokeAt && f?.phase === 'withdrawing') brokeAt = centre(battle);
    if (f?.combatIneffective && ineffectiveWhile === null) ineffectiveWhile = f.phase;
  }

  it('falls back out of reach before it stays down, waiting for orders', () => {
    const f = red(battle);
    // Made ineffective on the way back, it went on falling back.
    expect(ineffectiveWhile).toBe('withdrawing');
    expect(f?.combatIneffective).toBe(true);
    expect(f?.phase).toBe('ineffective');
    expect(redUp(battle).length).toBeGreaterThan(0);
    const phases = events.flatMap((e) =>
      e.type === 'forcePhaseChanged' && e.side === 'OPFOR' ? [`${e.from}>${e.to}`] : [],
    );
    expect(phases.at(-1)).toBe('withdrawing>ineffective');
    // Its full withdrawal: some 500 m back from where it broke.
    const at = centre(battle);
    expect(Math.hypot(at.x - (brokeAt?.x ?? 0), at.y - (brokeAt?.y ?? 0))).toBeGreaterThan(400);
    // Down where it is.
    expect(redUp(battle).every((s) => s.posture === 'prone')).toBe(true);
  });

  it('can still be ordered: it moves on, and stays combat ineffective', () => {
    const from = centre(battle);
    battle.submit(
      orderSquad(battle, 'O1', 'replace', [
        { kind: 'move', destination: { x: from.x, y: from.y - 150 } },
      ]),
    );
    const later: SimEvent[] = [];
    while (battle.sim.timeSeconds < 1460) later.push(...battle.step());
    expect(later.filter((e) => e.type === 'commandRejected')).toEqual([]);
    expect(red(battle)?.combatIneffective).toBe(true);
    const phases = later.flatMap((e) =>
      e.type === 'forcePhaseChanged' && e.side === 'OPFOR'
        ? [`${e.from}>${e.to}: ${e.reason}`]
        : [],
    );
    expect(phases[0]).toBe('ineffective>atObjective: combat ineffective, ordered on');
    expect(phases[1]).toBe('atObjective>moving: ordered to move');
  });
});
