import { parseArgs } from 'node:util';
import { createFixedStepRunner } from '#exercise';
import {
  createSimulation,
  createSyntheticTerrain,
  DEFAULT_TICK_RATE_HZ,
  flatElevation,
  hashSimState,
} from '#sim';

// Runs the simulation headless and faster than real time.
// Usage: npm run sim:headless -- --rate 30 --seconds 10 --seed 0

const { values } = parseArgs({
  options: {
    rate: { type: 'string', default: String(DEFAULT_TICK_RATE_HZ) },
    seconds: { type: 'string', default: '10' },
    seed: { type: 'string', default: '0' },
  },
});

const tickRateHz = Number(values.rate);
const seconds = Number(values.seconds);
if (!Number.isFinite(seconds) || seconds < 0) {
  console.error(`--seconds must be a non-negative number, got "${values.seconds}"`);
  process.exit(1);
}

const sim = createSimulation(
  { tickRateHz, seed: Number(values.seed) },
  {
    id: 'empty',
    terrain: createSyntheticTerrain(
      { originX: 0, originY: 0, cellSize: 100, columns: 2, rows: 2 },
      flatElevation(0),
    ),
    movement: { speed: 1.5, maxTurnRate: Math.PI / 2 },
    units: [],
    soldiers: [],
  },
);
const runner = createFixedStepRunner(sim, { maxCatchUpSeconds: Number.POSITIVE_INFINITY });

const startMs = performance.now();
runner.advance(seconds);
const wallMs = performance.now() - startMs;

console.log(
  `Ran ${String(sim.tick)} ticks at ${String(tickRateHz)} Hz = ${sim.timeSeconds.toFixed(3)} s simulation time ` +
    `(wall clock ${wallMs.toFixed(1)} ms), state hash ${hashSimState(sim.state)}`,
);
