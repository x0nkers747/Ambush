import { createExercise, DEMO_SCENARIO, type CommitResult, type SoldierPlan } from '#exercise';
import { clearSelection, createSession, setTimeScale, TIME_SCALES, type Session } from '#session';
import { DEFAULT_TICK_RATE_HZ, type SimEvent, type SoldierId } from '#sim';
import { createTacticalMap, formatBearing } from '#view2d';

// Composition root for the Phase 3 vertical slice: the demo scenario, the
// exercise, the session, the tactical map and the controls around them.

const exercise = createExercise({
  config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
  scenario: DEMO_SCENARIO,
});
let session: Session = createSession();
let problems: string[] = [];
const eventLog: string[] = [];

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app element');
app.innerHTML = `
  <header>
    <h1>AMBUSH!</h1>
    <span class="phase" data-ui="phase"></span>
    <span class="clock" data-ui="clock" title="Simulation time"></span>
    <div class="group">
      <button class="primary" data-ui="execute" title="Commit the plans and start the simulation">Execute</button>
      <button data-ui="pause" title="Pause (Space)">Pause</button>
      <button class="primary" data-ui="resume" title="Commit changed plans and continue (Space)">Resume</button>
    </div>
    <div class="group" data-ui="speeds"><span class="label">Speed</span></div>
    <span class="spacer"></span>
    <button data-ui="fit" title="Fit the whole map (F)">Fit map</button>
  </header>
  <main><canvas id="map" aria-label="Tactical map"></canvas></main>
  <aside>
    <h2>Selected soldier</h2>
    <div data-ui="selection"></div>
    <div data-ui="problems" class="problems"></div>
    <h2>Events</h2>
    <ul class="events" data-ui="events"></ul>
    <h2>Controls</h2>
    <dl class="help">
      <dt>Click soldier</dt><dd>Select a BLUEFOR soldier</dd>
      <dt>Click map</dt><dd>Add a waypoint at the end of the route</dd>
      <dt>Click a route leg</dt><dd>Insert a waypoint into that leg</dd>
      <dt>Drag waypoint</dt><dd>Move it</dd>
      <dt>Right-click waypoint</dt><dd>Delete it</dd>
      <dt>Drag yellow handle</dt><dd>Set final facing</dd>
      <dt>Backspace / Del</dt><dd>Delete the last waypoint</dd>
      <dt>Drag map</dt><dd>Pan (left or middle button)</dd>
      <dt>Wheel</dt><dd>Zoom at the cursor</dd>
      <dt>F</dt><dd>Fit the map</dd>
      <dt>Space</dt><dd>Pause / Resume</dd>
      <dt>1 · 2 · 4</dt><dd>Time scale</dd>
      <dt>Esc</dt><dd>Clear selection</dd>
    </dl>
    <p class="muted">Routes can be edited while Planning or Paused. OPFOR (red diamonds) cannot be selected.</p>
  </aside>
  <footer data-ui="pointer"></footer>
`;

function ui(name: string): HTMLElement {
  const element = app?.querySelector<HTMLElement>(`[data-ui="${name}"]`);
  if (!element) throw new Error(`Missing UI element ${name}`);
  return element;
}

function button(name: string): HTMLButtonElement {
  const element = ui(name);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`${name} is not a button`);
  return element;
}

const canvas = app.querySelector<HTMLCanvasElement>('#map');
if (!canvas) throw new Error('Missing map canvas');
const map = createTacticalMap({
  canvas,
  exercise,
  getSession: () => session,
  setSession: (next) => {
    session = next;
  },
});

const speedButtons = TIME_SCALES.map((scale) => {
  const speedButton = document.createElement('button');
  speedButton.textContent = `${String(scale)}×`;
  speedButton.addEventListener('click', () => {
    session = setTimeScale(session, scale);
  });
  ui('speeds').append(speedButton);
  return { scale, speedButton };
});

function report(result: CommitResult): void {
  problems = result.ok ? [] : result.problems.map((p) => `${p.soldierId}: ${p.problem}`);
  if (result.ok) {
    const { revision } = result;
    const changed = revision.changedSoldierIds.length;
    eventLog.unshift(
      `${clock(revision.timeSeconds)}  Plan revision ${String(revision.revision)} committed (${String(changed)} soldier${changed === 1 ? '' : 's'} re-tasked)`,
    );
  }
}

const execute = () => {
  if (exercise.phase === 'planning') report(exercise.execute());
};
const pause = () => {
  if (exercise.phase === 'executing') exercise.pause();
};
const resume = () => {
  if (exercise.phase === 'paused') report(exercise.resume());
};
ui('execute').addEventListener('click', execute);
ui('pause').addEventListener('click', pause);
ui('resume').addEventListener('click', resume);
ui('fit').addEventListener('click', () => {
  map.fitView();
});

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  const selected = session.selectedSoldierId;
  switch (event.key) {
    case ' ':
      event.preventDefault();
      if (exercise.phase === 'executing') pause();
      else resume();
      break;
    case 'f':
    case 'F':
      map.fitView();
      break;
    case 'Escape':
      session = clearSelection(session);
      break;
    case '1':
    case '2':
    case '4':
      session = setTimeScale(session, Number(event.key) as Session['timeScale']);
      break;
    case 'Backspace':
    case 'Delete': {
      const last = selected === null ? undefined : exercise.draft(selected)?.waypoints.at(-1);
      if (selected !== null && last) {
        event.preventDefault();
        exercise.deleteWaypoint(selected, last.id);
      }
      break;
    }
  }
});

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

function describeEvent(event: SimEvent): string | undefined {
  switch (event.type) {
    case 'waypointReached': {
      const waypoint = exercise.simulation.state.soldiers
        .find((s) => s.id === event.soldierId)
        ?.orders?.orders.waypoints.find((w) => w.id === event.waypointId);
      const where = waypoint ? ` at E ${waypoint.x.toFixed(0)} N ${waypoint.y.toFixed(0)}` : '';
      return `${clock(event.atSeconds)}  ${event.soldierId} reached waypoint${where}`;
    }
    case 'soldierInPosition':
      return `${clock(event.atSeconds)}  ${event.soldierId} in position`;
    case 'commandRejected':
      return `${clock(event.tick / exercise.simulation.config.tickRateHz)}  Orders for ${event.command.soldierId} rejected (${event.reason})`;
    case 'ordersChanged':
      return undefined;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

function soldierStatus(id: SoldierId): string {
  const soldier = exercise.simulation.state.soldiers.find((s) => s.id === id);
  const active = soldier?.orders;
  if (!active) return 'No orders';
  switch (active.behavior) {
    case 'moving':
      return `Moving to waypoint ${String(active.nextWaypointIndex + 1)} of ${String(active.orders.waypoints.length)}`;
    case 'facing':
      return 'Turning to final facing';
    case 'inPosition':
      return 'In position';
  }
}

function routeTable(plan: SoldierPlan, start: { x: number; y: number }): string {
  if (plan.waypoints.length === 0)
    return '<p class="muted">No waypoints. Click the map to add one.</p>';
  let previous = start;
  let total = 0;
  const rows = plan.waypoints.map((w, i) => {
    const leg = Math.hypot(w.x - previous.x, w.y - previous.y);
    total += leg;
    previous = w;
    return `<tr><td>${String(i + 1)}</td><td>${w.x.toFixed(0)}</td><td>${w.y.toFixed(0)}</td><td>${leg.toFixed(0)} m</td></tr>`;
  });
  return `<table><tr><th>#</th><th>East</th><th>North</th><th>Leg</th></tr>${rows.join('')}</table>
    <p class="muted">Total ${total.toFixed(0)} m · about ${clock(total / exercise.simulation.world.movement.speed)} at ${String(exercise.simulation.world.movement.speed)} m/s</p>`;
}

function selectionHtml(): string {
  const id = session.selectedSoldierId;
  if (id === null)
    return '<p class="muted">Click a blue soldier on the map to plan their route.</p>';
  const soldier = exercise.simulation.state.soldiers.find((s) => s.id === id);
  const plan = exercise.displayedPlan(id);
  if (!soldier || !plan) return '';
  const unit = exercise.simulation.state.units.find((u) => u.id === soldier.unitId);
  const leader = unit?.leaderId === id ? ' · leader' : '';
  const editable = exercise.canEditPlans;
  return `
    <div class="soldier-title">${escapeHtml(id)}</div>
    <div class="muted">${escapeHtml(soldier.unitId)} (${unit?.echelon === 'squad' ? 'squad' : 'fire team'})${leader}</div>
    <div>${soldierStatus(id)}</div>
    <h2>${editable ? 'Route (editable)' : 'Remaining route'}</h2>
    ${routeTable(plan, soldier.position)}
    <h2>Final facing</h2>
    <div class="facing">${formatBearing(plan.finalFacing)}</div>
    ${editable ? '<p><button data-action="clear-route">Clear route</button></p>' : '<p class="muted">Pause to change the plan.</p>'}
  `;
}

ui('selection').addEventListener('click', (event) => {
  const id = session.selectedSoldierId;
  if (
    event.target instanceof HTMLElement &&
    event.target.dataset['action'] === 'clear-route' &&
    id !== null
  ) {
    exercise.clearRoute(id);
  }
});

let lastSelectionHtml = '';
let lastEventsHtml: string | null = null;
function updatePanels(): void {
  const { phase } = exercise;
  const phaseEl = ui('phase');
  phaseEl.dataset['phase'] = phase;
  phaseEl.textContent = phase;
  ui('clock').textContent = `T+ ${clock(exercise.simulation.timeSeconds)}`;
  button('execute').disabled = phase !== 'planning';
  button('pause').disabled = phase !== 'executing';
  button('resume').disabled = phase !== 'paused';
  for (const { scale, speedButton } of speedButtons) {
    speedButton.setAttribute('aria-pressed', String(session.timeScale === scale));
  }

  const selection = selectionHtml();
  if (selection !== lastSelectionHtml) {
    ui('selection').innerHTML = selection;
    lastSelectionHtml = selection;
  }
  ui('problems').textContent = problems.join('\n');
  const events = eventLog
    .slice(0, 12)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join('');
  if (events !== lastEventsHtml) {
    ui('events').innerHTML = events || '<li class="muted">Nothing yet.</li>';
    lastEventsHtml = events;
  }
  const p = map.pointer;
  ui('pointer').textContent = p
    ? `E ${p.east.toFixed(1)} m   N ${p.north.toFixed(1)} m   Elev ${p.elevation.toFixed(1)} m`
    : '';
}

let lastFrameMs: number | null = null;

// rAF stops in hidden tabs; discard the gap on return rather than catching up.
document.addEventListener('visibilitychange', () => {
  lastFrameMs = null;
});

function frame(nowMs: number): void {
  if (lastFrameMs !== null) {
    const events = exercise.advance((nowMs - lastFrameMs) / 1000, session.timeScale);
    for (const event of events) {
      const line = describeEvent(event);
      if (line) eventLog.unshift(line);
    }
    eventLog.length = Math.min(eventLog.length, 50);
  }
  lastFrameMs = nowMs;
  map.render();
  updatePanels();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
