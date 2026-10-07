import { parseArgs } from 'node:util';
import { createFixedStepRunner } from '#exercise';
import { createSimulation, DEFAULT_TICK_RATE_HZ } from '#sim';

// Runs the simulation headless and faster than real time.
// Usage: npm run sim:headless -- --rate 30 --seconds 10

const { values } = parseArgs({
  options: {
    rate: { type: 'string', default: String(DEFAULT_TICK_RATE_HZ) },
    seconds: { type: 'string', default: '10' },
  },
});

const tickRateHz = Number(values.rate);
const seconds = Number(values.seconds);
if (!Number.isFinite(seconds) || seconds < 0) {
  console.error(`--seconds must be a non-negative number, got "${values.seconds}"`);
  process.exit(1);
}

const sim = createSimulation({ tickRateHz });
const runner = createFixedStepRunner(sim, { maxTicksPerAdvance: Number.POSITIVE_INFINITY });

const startMs = performance.now();
runner.advance(seconds);
const wallMs = performance.now() - startMs;

console.log(
  `Ran ${String(sim.tick)} ticks at ${String(tickRateHz)} Hz = ${sim.timeSeconds.toFixed(3)} s simulation time ` +
    `(wall clock ${wallMs.toFixed(1)} ms)`,
);
