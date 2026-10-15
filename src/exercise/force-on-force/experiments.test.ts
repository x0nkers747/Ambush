import { describe, expect, it } from 'vitest';
import { FOF_EXPERIMENTS } from './experiments';
import { createFofRun } from './run';

// The experiments' setups are valid runs (fast; the experiments themselves,
// to their outcomes over several seeds, are tools/fof-experiments.test.ts).

describe('force-on-force experiments', () => {
  it('has the default demonstration and the twelve experiments', () => {
    expect(FOF_EXPERIMENTS.map((e) => e.id)).toHaveLength(13);
    expect(FOF_EXPERIMENTS[0]?.id).toBe('demo');
  });

  for (const experiment of FOF_EXPERIMENTS) {
    it(`${experiment.name}: every variant builds and runs cleanly`, () => {
      for (const v of experiment.variants(1)) {
        const run = createFofRun(v.spec);
        const rejected = [];
        for (let i = 0; i < 30 * 20; i += 1) {
          rejected.push(...run.step().filter((e) => e.type === 'commandRejected'));
        }
        expect(rejected).toEqual([]);
        expect(run.sim.state.fof?.outcome?.basis).not.toBe('invalid');
        expect(run.sim.state.fof?.forces).toHaveLength(2);
      }
    }, 60_000);
  }
});
