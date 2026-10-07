import { createFixedStepRunner } from '#exercise';
import {
  createSimulation,
  createSyntheticTerrain,
  DEFAULT_TICK_RATE_HZ,
  flatElevation,
} from '#sim';

// Phase 0 composition root: drives a bare simulation from requestAnimationFrame
// and shows its clock, proving the app → exercise → sim wiring and the fixed timestep.

const sim = createSimulation(
  { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 0 },
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
const runner = createFixedStepRunner(sim);

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app element');

root.innerHTML = `
  <h1>Ambush!</h1>
  <p>Phase 0 scaffold: fixed-timestep simulation clock.</p>
  <dl>
    <dt>Tick rate</dt><dd data-field="rate"></dd>
    <dt>Tick</dt><dd data-field="tick"></dd>
    <dt>Simulation time</dt><dd data-field="simTime"></dd>
    <dt>Visible real time</dt><dd data-field="realTime"></dd>
    <dt>Dropped time</dt><dd data-field="dropped"></dd>
    <dt>Status</dt><dd data-field="status"></dd>
  </dl>
`;

function field(name: string): HTMLElement {
  const el = root?.querySelector<HTMLElement>(`[data-field="${name}"]`);
  if (!el) throw new Error(`Missing field ${name}`);
  return el;
}

const fields = {
  rate: field('rate'),
  tick: field('tick'),
  simTime: field('simTime'),
  realTime: field('realTime'),
  dropped: field('dropped'),
  status: field('status'),
};
fields.rate.textContent = `${String(sim.config.tickRateHz)} Hz`;

let lastFrameMs: number | null = null;
let visibleRealSeconds = 0;

// rAF stops in hidden tabs; pause explicitly and discard the gap on return
// rather than letting the runner absorb it (docs/adr/0003).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    runner.pause();
  } else {
    lastFrameMs = null;
    runner.resume();
  }
  render();
});

function render(): void {
  fields.tick.textContent = String(sim.tick);
  fields.simTime.textContent = `${sim.timeSeconds.toFixed(2)} s`;
  fields.realTime.textContent = `${visibleRealSeconds.toFixed(2)} s`;
  fields.dropped.textContent = `${runner.droppedSeconds.toFixed(2)} s`;
  fields.status.textContent = runner.paused ? 'Paused (tab hidden)' : 'Running';
}

function frame(nowMs: number): void {
  if (lastFrameMs !== null && !runner.paused) {
    const dt = (nowMs - lastFrameMs) / 1000;
    visibleRealSeconds += dt;
    runner.advance(dt);
  }
  lastFrameMs = nowMs;
  render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
