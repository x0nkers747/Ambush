import { describe, expect, it } from 'vitest';
import { labTerrain, urbanFeatures } from '#exercise/behavior-lab';
import { createBattle, type BattleSpec, type SquadSpec } from '#exercise/battle';
import { hashSimState, type TerrainDataset } from '#sim';
import { createReview } from './review';
import { createBattleSession } from './session';

// Battle benchmarks (docs/constructive-simulation/05 §5):
//   AMBUSH_BATTLE_BENCH=1 npx vitest run src/app/battle/benchmark.test.ts --silent=false
// Battles of 2, 6 and 12 rifle squads (half a side) on open ground and in an
// urban district, the two sides 800 m apart, each attacking across. Each is
// fought for AMBUSH_BATTLE_BENCH_SECONDS (default 600) simulated seconds
// through the battle session (as the Combat stage runs it: keyframes, a
// hash every second, motion and events recorded), then replayed from its
// recording and verified (as the After-Action Review does). Reports the
// simulation's cost per tick and the real-time multiple it allows, the
// recording's cost (snapshot size and time, hash time), and the review's.
// Opt-in: it takes minutes.

/** Node's, where Vitest runs this (the app's types are the browser's). */
declare const process: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { write(text: string): void };
};

const enabled = process.env['AMBUSH_BATTLE_BENCH'] === '1';
const seconds = Number(process.env['AMBUSH_BATTLE_BENCH_SECONDS'] ?? 600);
const RATE = 30;

/** `n` squads, half a side, abreast 150 m apart, 800 m between the sides, each attacking the other's line. */
function spec(n: number): BattleSpec {
  const perSide = n / 2;
  const squads: SquadSpec[] = [];
  for (const side of ['BLUEFOR', 'OPFOR'] as const) {
    for (let k = 0; k < perSide; k += 1) {
      const x = (k - (perSide - 1) / 2) * 150;
      const y = side === 'BLUEFOR' ? -400 : 400;
      squads.push({
        id: `${side === 'BLUEFOR' ? 'B' : 'O'}${String(k + 1)}`,
        name: `${side} ${String(k + 1)}`,
        side,
        organization: 'squad',
        position: { x, y },
        facingDeg: side === 'BLUEFOR' ? 0 : 180,
        plan: [{ kind: 'attack', destination: { x, y: -y } }],
      });
    }
  }
  return { squads, seed: 1, tickRateHz: RATE };
}

function terrainFor(kind: 'open' | 'urban', n: number): TerrainDataset {
  if (kind === 'open') return labTerrain();
  const keepClear = spec(n).squads.map((s) => s.position);
  return labTerrain(urbanFeatures({ seed: 3, keepClear, clearRadius: 45, half: 700 }));
}

const percentile = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

describe.runIf(enabled)('battle benchmarks', { timeout: 3_600_000 }, () => {
  const rows: string[] = [];
  for (const kind of ['open', 'urban'] as const) {
    for (const n of [2, 6, 12]) {
      it(`${String(n)} squads, ${kind}`, () => {
        const battleSpec = spec(n);
        const terrain = terrainFor(kind, n);
        const built = performance.now();
        createBattle(battleSpec, terrain);
        const buildMs = performance.now() - built;
        const session = createBattleSession(battleSpec, terrain);
        const ticks: number[] = [];
        const end = seconds * RATE;
        while (session.tick < end) {
          const t = performance.now();
          session.step();
          ticks.push(performance.now() - t);
        }
        const state = session.battle.sim.state;
        const soldiers = state.soldiers.length;
        const casualties = state.soldiers.filter((s) => s.status !== 'active').length;
        const fire = session.events.filter((e) => e.event.type === 'fofFire').length;
        // The recording's costs.
        const t0 = performance.now();
        const snapshot = session.battle.sim.snapshot();
        const snapshotMs = performance.now() - t0;
        const snapshotKb = JSON.stringify(snapshot).length / 1024;
        const t1 = performance.now();
        for (let k = 0; k < 10; k += 1) hashSimState(state);
        const hashMs = (performance.now() - t1) / 10;
        // The review: replay from tick 0 and verify every second.
        const t2 = performance.now();
        const review = createReview({
          terrain,
          recording: session.recording(),
          budgetMs: Infinity,
        });
        const reviewMs = performance.now() - t2;
        expect(review.verification.mismatches).toBe(0);
        expect(review.verification.complete).toBe(true);
        const mean = ticks.reduce((a, b) => a + b, 0) / ticks.length;
        const p95 = percentile(ticks, 0.95);
        const multiple = 1000 / (mean * RATE);
        const row = `| ${String(n)} | ${kind} | ${String(soldiers)} | ${mean.toFixed(3)} | ${p95.toFixed(3)} | ${multiple.toFixed(0)}× | ${String(casualties)} | ${String(fire)} | ${buildMs.toFixed(0)} | ${snapshotKb.toFixed(0)} | ${snapshotMs.toFixed(1)} | ${hashMs.toFixed(2)} | ${(reviewMs / 1000).toFixed(1)} s (${(seconds / (reviewMs / 1000)).toFixed(0)}×) |`;
        rows.push(row);
        process.stdout.write(`${row}\n`);
      });
    }
  }
  it('summary', () => {
    process.stdout.write(
      [
        `Battles of ${String(seconds)} s at ${String(RATE)} Hz.`,
        '| Squads | Ground | Soldiers | ms/tick | p95 | × real time | Casualties | Bursts | Build ms | Snapshot KB | Snapshot ms | Hash ms | Replay & verify |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
      ].join('\n') + '\n',
    );
  });
});
