import { describe, expect, it } from 'vitest';
import { squadScenario, squadWedge } from '#sim/behavior-fixtures';
import {
  buildGroupRoute,
  createSimulation,
  DEFAULT_BEHAVIOR_PARAMS,
  hashSimState,
  orgUnitId,
  planPath,
  soldierId,
  waypointId,
  type BehaviorParams,
  type FormationSpec,
  type Scenario,
  type ScenarioSoldier,
  type ScenarioUnit,
} from '#sim';

// Opt-in benchmark of unit movement (docs/behavior-lab/05 §4):
//   AMBUSH_BEHAVIOR_BENCH=1 npx vitest run tools/behavior-bench.test.ts
// Prints a Markdown table of costs per tick by soldier count, the cost of
// route creation and of hashing, and the accuracy and cost of the internal
// substep rate (60, 120, 240 Hz against a 960 Hz reference).

const enabled = process.env['AMBUSH_BEHAVIOR_BENCH'] !== undefined;

/** `squads` squads side by side (100 m apart), each a copy of the test squad. */
function squads(count: number, behavior?: BehaviorParams): Scenario {
  const base = squadScenario();
  const units: ScenarioUnit[] = [];
  const soldiers: ScenarioSoldier[] = [];
  for (let q = 0; q < count; q += 1) {
    const p = `Q${String(q)}.`;
    const dx = (q % 10) * 100 - 450;
    const dy = Math.floor(q / 10) * 60 - 500;
    for (const u of base.units) {
      units.push({
        ...u,
        id: p + u.id,
        parentId: u.parentId && p + u.parentId,
        leaderId: u.leaderId && p + u.leaderId,
      });
    }
    for (const s of base.soldiers) {
      soldiers.push({
        ...s,
        id: p + s.id,
        unitId: p + s.unitId,
        position: { x: s.position.x + dx, y: s.position.y + dy },
      });
    }
  }
  return { ...base, units, soldiers, ...(behavior ? { behavior } : {}) };
}

function prefixed(spec: FormationSpec, p: string): FormationSpec {
  const node = (n: FormationSpec['root']): FormationSpec['root'] => ({
    ...n,
    unitId: orgUnitId(p + n.unitId),
    slots: n.slots.map((s) => ({ ...s, id: p + s.id, soldierId: soldierId(p + s.soldierId) })),
    children: n.children.map(node),
  });
  return { ...spec, root: node(spec.root) };
}

function orderAll(sim: ReturnType<typeof createSimulation>, count: number) {
  for (let q = 0; q < count; q += 1) {
    const p = `Q${String(q)}.`;
    const dx = (q % 10) * 100 - 450;
    sim.submit({
      type: 'orderUnit',
      tick: 0,
      unitId: orgUnitId(`${p}SQD`),
      order: {
        kind: 'moveInFormation',
        via: [{ x: dx, y: 0 }],
        destination: { x: dx + 60, y: 300 },
        formation: prefixed(squadWedge(), p),
        pace: 1.4,
      },
    });
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;

describe.skipIf(!enabled)('unit movement benchmark', () => {
  it('measures cost per tick by soldier count, against the kernel with individual orders', () => {
    const rows: string[] = [
      '| Soldiers | Behaviour tick p50 (µs) | p95 (µs) | Kernel, individual orders p50 (µs) | Order (ms) | Hash (ms) |',
      '| ---: | ---: | ---: | ---: | ---: | ---: |',
    ];
    for (const count of [1, 3, 8, 77]) {
      const scenario = squads(count);
      const n = scenario.soldiers.length;
      const sim = createSimulation({ tickRateHz: 30, seed: 1 }, scenario);
      orderAll(sim, count);
      let t = performance.now();
      sim.step();
      const orderMs = performance.now() - t;
      for (let i = 0; i < 30 * 20; i += 1) sim.step(); // past forming
      const times: number[] = [];
      for (let i = 0; i < 30 * 30; i += 1) {
        t = performance.now();
        sim.step();
        times.push((performance.now() - t) * 1000);
      }
      t = performance.now();
      hashSimState(sim.state);
      const hashMs = performance.now() - t;
      // The same soldiers with individual orders (the existing movement).
      const plain = createSimulation({ tickRateHz: 30, seed: 1 }, scenario);
      scenario.soldiers.forEach((s) => {
        plain.submit({
          type: 'setOrders',
          tick: 0,
          soldierId: soldierId(s.id),
          orders: {
            waypoints: [{ id: waypointId('W'), x: s.position.x + 60, y: 300 }],
            finalFacing: 0,
          },
        });
      });
      for (let i = 0; i < 30 * 20; i += 1) plain.step();
      const base: number[] = [];
      for (let i = 0; i < 30 * 30; i += 1) {
        t = performance.now();
        plain.step();
        base.push((performance.now() - t) * 1000);
      }
      rows.push(
        `| ${String(n)} | ${median(times).toFixed(1)} | ${p95(times).toFixed(1)} | ${median(base).toFixed(1)} | ${orderMs.toFixed(2)} | ${hashMs.toFixed(2)} |`,
      );
    }
    console.log(rows.join('\n'));
    expect(rows.length).toBeGreaterThan(2);
  }, 600_000);

  it('measures route creation', () => {
    const terrain = squadScenario().terrain;
    const t = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      const path = planPath(terrain, { x: 0, y: 0 }, { x: 300, y: 300 });
      if (path.ok)
        buildGroupRoute(
          terrain,
          [
            { x: 0, y: 0 },
            { x: 0, y: 150 + (i % 7) },
            { x: 300, y: 300 },
          ],
          30,
        );
    }
    console.log(
      `route creation (open ground, one corner): ${((performance.now() - t) / 1000).toFixed(3)} ms`,
    );
  });

  it('compares substep rates for accuracy and cost', () => {
    const at = (substepHz: number) => {
      const scenario = squads(1, { ...DEFAULT_BEHAVIOR_PARAMS, substepHz });
      const sim = createSimulation({ tickRateHz: 30, seed: 1 }, scenario);
      orderAll(sim, 1);
      const t = performance.now();
      for (let i = 0; i < 30 * 200; i += 1) sim.step();
      return {
        ms: performance.now() - t,
        soldiers: sim.state.soldiers.map((s) => ({ ...s.position })),
      };
    };
    const reference = at(960);
    const rows = [
      '| Substep (Hz) | 200 s of squad movement (ms) | Max position difference vs 960 Hz (m) |',
      '| ---: | ---: | ---: |',
    ];
    for (const hz of [60, 120, 240, 480]) {
      const r = at(hz);
      const diff = Math.max(
        ...r.soldiers.map((p, i) =>
          Math.hypot(p.x - (reference.soldiers[i]?.x ?? 0), p.y - (reference.soldiers[i]?.y ?? 0)),
        ),
      );
      rows.push(`| ${String(hz)} | ${r.ms.toFixed(0)} | ${diff.toFixed(4)} |`);
    }
    console.log(rows.join('\n'));
  }, 600_000);
});
