import { describe, expect, it } from 'vitest';
import { flattenFormation, hashSimState, orgUnitId, type SimEvent } from '#sim';
import { buildFormationSpec, formationsFor, FORMATION_TEMPLATES } from '../formations/formations';
import { createMetrics } from './metrics';
import { rosterTree } from '../organization';
import { createLabRun, LAB_ORGANIZATIONS, type LabOrganization } from './run';
import { runScenario, scenarioSpec, type ScenarioOptions } from './scenarios';

// The Behavior Lab's first scenarios (docs/behavior-lab/05 §2, 1–5) for the
// 13-Marine squad and the 3-Marine element, with the plan's acceptance
// thresholds (experimental calibration targets, not doctrine), and the
// formation templates they use.

const ORGS: readonly LabOrganization[] = ['squad', 'element3'];

function organization(kind: LabOrganization) {
  const template = LAB_ORGANIZATIONS[kind];
  return {
    template,
    unitIdPrefix: '',
    members: template.slots.map((slot, i) => ({ soldierId: `S${String(i)}`, slotId: slot.id })),
  };
}

describe('formation templates', () => {
  it('builds the squad wedge from the doctrinal templates, roles in their places', () => {
    const spec = buildFormationSpec(organization('squad'), 'SQD', 'usmc.squad.wedge');
    const flat = flattenFormation(spec);
    expect(flat.slotIds).toHaveLength(13);
    const at = (slot: string) => {
      const i = flat.slotIds.indexOf(slot);
      return { back: flat.back[i] ?? NaN, right: flat.right[i] ?? NaN };
    };
    // 1st team at the point: its rifleman leads (Marine wedge, MCRP 3-10A.4 Fig 1-12).
    expect(at('FT1.R')).toEqual({ back: -10, right: 0 });
    // The squad leader just behind the lead team.
    expect(at('SL')).toEqual({ back: 12, right: 0 });
    // 3rd team behind on the right: its leader on the inner (left) shoulder.
    expect(at('FT3.FTL')).toEqual({ back: 20, right: 20 - 7 });
    // 2nd team behind on the left, mirrored: its leader on its inner (right) shoulder.
    expect(at('FT2.FTL')).toEqual({ back: 20, right: -20 + 7 });
  });

  it('offers each organization the formations its echelon and size can take', () => {
    expect(formationsFor('fireTeam', 4).map((t) => t.id)).toEqual([
      'usmc.fireTeam.wedge',
      'usmc.fireTeam.column',
      'usmc.fireTeam.file',
      'usmc.fireTeam.skirmishers',
      'army.fireTeam.wedge',
    ]);
    expect(formationsFor('fireTeam', 3).map((t) => t.id)).toContain('element3.file');
    expect(formationsFor('squad', 13).map((t) => t.id)).toEqual([
      'usmc.squad.wedge',
      'usmc.squad.column',
      'usmc.squad.line',
      'usmc.squad.file',
    ]);
  });

  it('places every member in every built-in formation of his organization', () => {
    for (const kind of ['squad', 'fireTeam', 'element3'] as const) {
      const org = organization(kind);
      const root = rosterTree(org);
      const count = org.members.length;
      for (const t of formationsFor(root.unit.echelon, count)) {
        const flat = flattenFormation(buildFormationSpec(org, root.unit.id, t.id));
        expect([...flat.soldierIds].sort(), `${kind} ${t.id}`).toEqual(
          org.members.map((m) => m.soldierId).sort(),
        );
      }
    }
    expect(FORMATION_TEMPLATES.every((t) => t.doctrine.length > 0)).toBe(true);
  });

  it('puts the Army wedge leader at the point', () => {
    const flat = flattenFormation(
      buildFormationSpec(organization('fireTeam'), 'FT', 'army.fireTeam.wedge'),
    );
    const leader = flat.slotIds.indexOf('FT.FTL');
    expect(Math.min(...flat.back)).toBe(flat.back[leader]);
  });
});

function scenario(id: Parameters<typeof scenarioSpec>[0], options: ScenarioOptions) {
  return runScenario(scenarioSpec(id, options));
}

// Each scenario runs the real simulation for minutes of simulated time: alone
// about a second, but several times that while the whole suite runs in
// parallel, so the default 5 s limit is too tight.
describe.each(ORGS)('scenarios, %s', { timeout: 30_000 }, (kind) => {
  const d = 10;

  it('1. straight line: formation error, completion, no collisions, no oscillation', () => {
    const { metrics: m } = scenario('s1-straight', { organization: kind });
    expect(m.outcome).toBe('arrived');
    expect(m.steadyMeanError).toBeLessThanOrEqual(0.15 * d);
    expect(m.steadyMaxError).toBeLessThanOrEqual(0.4 * d);
    expect(m.completionSeconds ?? Infinity).toBeLessThanOrEqual((300 / 1.4) * 1.15 + 20);
    expect(m.collisions).toBe(0);
    expect(m.worstReversalsPerMinute).toBeLessThanOrEqual(1);
    expect(m.stuck).toBe(0);
  });

  it.each([
    [1.0, 5],
    [1.0, 15],
    [1.8, 5],
    [1.8, 15],
  ])('2. pace %f m/s, interval %f m', (pace, interval) => {
    const { metrics: m } = scenario('s2-speeds', { organization: kind, pace, interval });
    expect(m.outcome).toBe('arrived');
    expect(m.steadyMeanError).toBeLessThanOrEqual(0.15 * interval);
    expect(m.steadyMaxError).toBeLessThanOrEqual(0.4 * interval);
    expect(m.completionSeconds ?? Infinity).toBeLessThanOrEqual((300 / pace) * 1.15 + 20);
    expect(m.maxSpeedRatio).toBeLessThanOrEqual(1.3 + 1e-9);
    expect(m.collisions).toBe(0);
  });

  it('3. a held Marine recovers; the others keep formation and the unit never stops', () => {
    const { metrics: m } = scenario('s3-straggler', { organization: kind });
    expect(m.outcome).toBe('arrived');
    expect(m.recoverySeconds ?? Infinity).toBeLessThanOrEqual(40);
    expect(m.longestStop).toBe(0);
    expect(m.othersMaxError).toBeLessThanOrEqual(0.5 * d);
    expect(m.maxSpeedRatio).toBeLessThanOrEqual(1.3 + 1e-9);
  });

  it('4. 90° turn: error, sideways speed, speed cap, team order', () => {
    const result = scenario('s4-turn', { organization: kind });
    const m = result.metrics;
    expect(m.outcome).toBe('arrived');
    expect(m.maxError).toBeLessThanOrEqual(0.5 * d);
    expect(m.maxSlip).toBeLessThanOrEqual(0.4);
    expect(m.maxSpeedRatio).toBeLessThanOrEqual(1.3 + 1e-9);
    expect(m.collisions).toBe(0);
  });

  it('5. consecutive waypoints: every leg, no stop between legs, formation kept', () => {
    const { metrics: m, events } = scenario('s5-waypoints', { organization: kind });
    const ends = events.flatMap((e) => (e.type === 'unitTaskEnded' ? [e.outcome] : []));
    expect(ends).toEqual(['superseded', 'superseded', 'superseded', 'arrived']);
    expect(m.longestStop).toBeLessThanOrEqual(2);
    expect(m.steadyMeanError).toBeLessThanOrEqual(0.15 * d);
    expect(m.steadyMaxError).toBeLessThanOrEqual(0.4 * d);
    expect(m.collisions).toBe(0);
  });
});

describe('falling in: the leader steps off, the others fall in on the move', () => {
  it.each(ORGS)('%s ordered off to the rear', (kind) => {
    const result = scenario('fall-in', { organization: kind });
    const m = result.metrics;
    expect(m.outcome).toBe('arrived');
    // Nobody forms up first: the unit is moving from the order on.
    const phases = result.events.flatMap((e) => (e.type === 'unitPhaseChanged' ? [e.phase] : []));
    expect(phases).toEqual(['settling']);
    expect(m.joinSeconds ?? Infinity).toBeLessThanOrEqual(60);
    expect(m.collisions).toBe(0);
    expect(m.stuck).toBe(0);
    expect(m.steadyMaxError).toBeLessThanOrEqual(4);
  });

  it('the leader starts toward the objective within 5 s; a reversing squad does not walk through itself', () => {
    const spec = {
      ...scenarioSpec('fall-in', { organization: 'squad' }),
      waypoints: [{ x: 0, y: -200 }],
    };
    const run = createLabRun(spec);
    const leader = run.sim.state.units.find((u) => u.id === run.unitId)?.leaderId ?? '';
    const start = run.sim.state.soldiers.find((s) => s.id === leader)?.position;
    const y0 = start?.y ?? 0;
    let moved: number | null = null;
    let closest = Infinity;
    for (let i = 0; i < 30 * 300 && !run.done; i += 1) {
      run.step();
      const s = run.sim.state.soldiers;
      const p = s.find((x) => x.id === leader)?.position;
      if (moved === null && p && y0 - p.y > 1) moved = run.sim.timeSeconds;
      for (let a = 0; a < s.length; a += 1) {
        for (let b = a + 1; b < s.length; b += 1) {
          const pa = s[a]?.position;
          const pb = s[b]?.position;
          if (pa && pb) closest = Math.min(closest, Math.hypot(pa.x - pb.x, pa.y - pb.y));
        }
      }
    }
    expect(moved ?? Infinity).toBeLessThanOrEqual(5);
    expect(closest).toBeGreaterThan(0.6);
    expect(run.sim.state.behavior?.tasks[0]?.outcome).toBe('arrived');
  }, 60_000);
});

describe('changing formation', () => {
  const change = (from: string, to: string, atSeconds: number, destination = { x: 0, y: 400 }) => {
    const run = createLabRun({
      ...scenarioSpec('s1-straight', { organization: 'squad', formation: from }),
      waypoints: [destination],
    });
    const metrics = createMetrics(run.sim, run.unitId);
    const events: SimEvent[] = [];
    let closest = Infinity;
    for (let i = 0; i < 30 * 900 && (!run.done || run.sim.tick <= atSeconds * 30); i += 1) {
      if (run.sim.tick === atSeconds * 30) {
        run.submit({
          type: 'orderUnit',
          tick: run.sim.tick,
          unitId: orgUnitId('SQD'),
          order: {
            kind: 'moveInFormation',
            destination,
            formation: buildFormationSpec(run.organization, 'SQD', to),
            pace: 1.4,
          },
        });
      }
      const step = run.step();
      events.push(...step);
      metrics.sample(step);
      if (run.sim.tick > atSeconds * 30) {
        const s = run.sim.state.soldiers;
        for (let a = 0; a < s.length; a += 1) {
          for (let b = a + 1; b < s.length; b += 1) {
            const pa = s[a]?.position;
            const pb = s[b]?.position;
            if (pa && pb) closest = Math.min(closest, Math.hypot(pa.x - pb.x, pa.y - pb.y));
          }
        }
      }
    }
    return { run, metrics: metrics.result(), events, closest };
  };

  it('on the move: carries on without stopping and re-forms on the move (wedge to column)', () => {
    const { run, metrics, events, closest } = change('usmc.squad.wedge', 'usmc.squad.column', 60);
    const ends = events.flatMap((e) => (e.type === 'unitTaskEnded' ? [e.outcome] : []));
    expect(ends).toEqual(['superseded', 'arrived']);
    expect(metrics.longestStop).toBe(0);
    expect(metrics.stuck).toBe(0);
    expect(closest).toBeGreaterThan(0.6);
    // The column is what it ends in.
    const last = run.sim.state.behavior?.tasks.at(-1);
    expect(last?.order.formation.root.children[0]?.slots.length).toBe(4);
    expect(flattenFormation(last?.formation ?? run.formation).slotIds).toHaveLength(13);
    expect(run.sim.state.behavior?.agents.every((a) => a.joined)).toBe(true);
  }, 60_000);

  it('at rest: re-forms where it stands', () => {
    const { metrics, events } = change('usmc.squad.wedge', 'usmc.squad.line', 300, {
      x: 0,
      y: 150,
    });
    const ends = events.flatMap((e) => (e.type === 'unitTaskEnded' ? [e.outcome] : []));
    expect(ends).toEqual(['arrived', 'arrived']);
    expect(metrics.stuck).toBe(0);
  }, 60_000);
});

describe('scenario 4, squad team order', () => {
  it('keeps the 1st team ahead of the 2nd and 3rd through the turn', () => {
    const run = createLabRun(scenarioSpec('s4-turn', { organization: 'squad' }));
    const teams = ['FT1', 'FT2', 'FT3'].map((t) =>
      ['FTL', 'AR', 'AAR', 'R'].map((r) => run.soldierOf(`${t}.${r}`) ?? ''),
    );
    let checked = 0;
    for (let i = 0; i < 30 * 400 && !run.done; i += 1) {
      run.step();
      const task = run.sim.state.behavior?.tasks[0];
      if (task?.phase !== 'moving' || run.sim.tick % 30 !== 0) continue;
      // Progress of each team's centre along the route (nearest route point).
      const progress = teams.map((ids) => {
        const ps = ids.map((id) => run.sim.state.soldiers.find((s) => s.id === id)?.position);
        const cx = ps.reduce((s, p) => s + (p?.x ?? 0), 0) / ps.length;
        const cy = ps.reduce((s, p) => s + (p?.y ?? 0), 0) / ps.length;
        let best = 0;
        let bestD = Infinity;
        const { x, y, cum } = task.route;
        for (let k = 0; k + 1 < x.length; k += 1) {
          const ax = x[k] ?? 0;
          const ay = y[k] ?? 0;
          const dx = (x[k + 1] ?? 0) - ax;
          const dy = (y[k + 1] ?? 0) - ay;
          const l2 = dx * dx + dy * dy;
          const u = l2 > 0 ? Math.max(0, Math.min(1, ((cx - ax) * dx + (cy - ay) * dy) / l2)) : 0;
          const dd = (ax + u * dx - cx) ** 2 + (ay + u * dy - cy) ** 2;
          if (dd < bestD) {
            bestD = dd;
            best = (cum[k] ?? 0) + u * Math.sqrt(l2);
          }
        }
        return best;
      });
      expect(progress[0]).toBeGreaterThan(progress[1] ?? Infinity);
      expect(progress[0]).toBeGreaterThan(progress[2] ?? Infinity);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('a run reproduces', () => {
  const states = (rate: number, seconds: number) => {
    const run = createLabRun(scenarioSpec('s4-turn', { organization: 'squad', tickRateHz: rate }));
    for (let i = 0; i < seconds * rate; i += 1) run.step();
    return run;
  };

  it('repeats exactly, and differs with the seed', () => {
    const a = createLabRun(scenarioSpec('s3-straggler', { organization: 'squad', seed: 3 }));
    const b = createLabRun(scenarioSpec('s3-straggler', { organization: 'squad', seed: 3 }));
    const c = createLabRun(scenarioSpec('s3-straggler', { organization: 'squad', seed: 4 }));
    for (let i = 0; i < 30 * 60; i += 1) {
      a.step();
      b.step();
      c.step();
    }
    expect(hashSimState(a.sim.state)).toBe(hashSimState(b.sim.state));
    expect(hashSimState(c.sim.state)).not.toBe(hashSimState(a.sim.state));
  });

  it('is bit-identical at 10, 30, 60 and 120 Hz', () => {
    const exact = (rate: number) => {
      const run = states(rate, 120);
      // Shortest round-trip number text: equal strings mean equal bits.
      return JSON.stringify({ s: run.sim.state.soldiers, b: run.sim.state.behavior });
    };
    const reference = exact(120);
    for (const rate of [10, 30, 60]) expect(exact(rate)).toBe(reference);
  }, 60_000);

  it('continues identically from a snapshot', () => {
    const whole = states(30, 150);
    const part = states(30, 75);
    const resumed = createLabRun(scenarioSpec('s4-turn', { organization: 'squad' }));
    resumed.sim.restore(part.sim.snapshot());
    for (let i = 0; i < 75 * 30; i += 1) resumed.sim.step();
    expect(hashSimState(resumed.sim.state)).toBe(hashSimState(whole.sim.state));
  });

  it('ends cleanly: nobody moves after the unit is in position', () => {
    const result = scenario('s1-straight', { organization: 'squad' });
    const at = result.run.sim.state.soldiers.map((s) => ({ ...s.position }));
    const events: SimEvent[] = [];
    for (let i = 0; i < 30 * 20; i += 1) events.push(...result.run.sim.step());
    expect(result.run.sim.state.soldiers.map((s) => ({ ...s.position }))).toEqual(at);
    expect(events).toEqual([]);
  });
});
