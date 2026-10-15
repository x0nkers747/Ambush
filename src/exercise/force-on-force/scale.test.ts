import { describe, expect, it } from 'vitest';
import { createFofRun, type FofRunSpec } from './run';

// Forces of several organizations (`count`), as the scalability test uses
// (tools/fof-scale.test.ts runs them at up to 38 squads a side).

function spec(count: number): FofRunSpec {
  const force = {
    organization: 'squad' as const,
    formation: 'usmc.squad.wedge',
    pace: 1.4,
    interval: 10,
    elementSpacing: 20,
    count,
    actionsOn: 'attack' as const,
  };
  return {
    blufor: { ...force, start: { x: 0, y: -500 }, destination: { x: 0, y: 500 } },
    opfor: { ...force, start: { x: 0, y: 500 }, destination: { x: 0, y: -500 } },
    terrain: 'open',
    seed: 1,
    tickRateHz: 30,
  };
}

describe('force-on-force forces of several squads', () => {
  it('builds the copies under one parent unit, with unique soldiers and slots', () => {
    const run = createFofRun(spec(3));
    const { soldiers, units } = run.sim.state;
    expect(soldiers).toHaveLength(2 * 3 * 13);
    expect(new Set(soldiers.map((s) => s.id)).size).toBe(soldiers.length);
    expect(units.find((u) => u.id === 'B-GRP')?.parentId).toBeNull();
    expect(units.filter((u) => u.parentId === 'B-GRP').map((u) => u.id)).toEqual([
      'B1-SQD',
      'B2-SQD',
      'B3-SQD',
    ]);
    expect(run.sim.state.fof).toBeUndefined();
    run.step();
    expect(run.sim.state.fof?.forces.map((f) => f.memberIds.length)).toEqual([39, 39]);
  });

  it('a single copy is the organization as before', () => {
    const one = createFofRun(spec(1));
    expect(one.sim.state.soldiers.map((s) => s.id).slice(0, 2)).toEqual(['B01', 'B02']);
    expect(one.forces[0].unitId).toBe('B-SQD');
  });

  it('attacks by fire and movement, a squad bounding at a time, with no refused orders', () => {
    const run = createFofRun(spec(2));
    let rejected = 0;
    const bounding = new Set<string>();
    while (!run.done && run.sim.timeSeconds < 600) {
      for (const e of run.step()) if (e.type === 'commandRejected') rejected += 1;
      for (const f of run.sim.state.fof?.forces ?? []) {
        if (f.boundUnit) {
          bounding.add(f.boundUnit);
          expect(f.bounding.length).toBeLessThanOrEqual(13);
        }
      }
    }
    expect(rejected).toBe(0);
    expect([...bounding].filter((u) => u.startsWith('B')).length).toBeGreaterThanOrEqual(2);
    expect(run.outcome?.basis ?? 'none').not.toBe('invalid');
  }, 120_000);
});
