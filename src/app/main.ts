import {
  createExercise,
  DEMO_SCENARIO,
  TRAINEE_SIDE,
  type CommitResult,
  type ExerciseEvent,
  type SoldierPlan,
} from '#exercise';
import {
  clearSelection,
  createSession,
  setTimeScale,
  setTool,
  TIME_SCALES,
  type MapTool,
  type Session,
} from '#session';
import { DEFAULT_TICK_RATE_HZ, polygonArea, type SimEvent, type SoldierId } from '#sim';
import { createTacticalMap, formatBearing } from '#view2d';

// Composition root for the ambush slice: the demo scenario, the exercise, the
// session, the tactical map and the controls around them.

const exercise = createExercise({
  config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
  scenario: DEMO_SCENARIO,
});
let session: Session = createSession();
let problems: string[] = [];
const eventLog: string[] = [];
let timelineSeen = 0;

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app element');
app.innerHTML = `
  <header>
    <h1>AMBUSH!</h1>
    <span class="phase" data-ui="phase"></span>
    <span class="clock" data-ui="clock" title="Simulation time"></span>
    <div class="group">
      <button class="primary" data-ui="execute" title="Commit the BLUEFOR plans and move into position">Execute</button>
      <button data-ui="pause" title="Pause (Space)">Pause</button>
      <button class="primary" data-ui="resume" title="Commit changed plans and continue (Space)">Resume</button>
      <button class="start-opfor" data-ui="start-opfor" title="Declare the ambush ready and start the OPFOR approach">START OPFOR</button>
    </div>
    <div class="group" data-ui="speeds"><span class="label">Speed</span></div>
    <div class="group" data-ui="tools"><span class="label">Edit</span></div>
    <span class="spacer"></span>
    <button data-ui="fit" title="Fit the whole map (F)">Fit map</button>
  </header>
  <main>
    <canvas id="map" aria-label="Tactical map"></canvas>
    <div class="banner" data-ui="banner" hidden></div>
  </main>
  <aside>
    <h2>Ambush status</h2>
    <dl class="status" data-ui="status"></dl>
    <div data-ui="start-check" class="start-check"></div>
    <h2>Kill zone</h2>
    <div data-ui="kill-zone"></div>
    <h2>Selected soldier</h2>
    <div data-ui="selection"></div>
    <div data-ui="problems" class="problems"></div>
    <h2>Events</h2>
    <ul class="events" data-ui="events"></ul>
    <h2>Controls: routes</h2>
    <dl class="help">
      <dt>Click soldier</dt><dd>Select a BLUEFOR soldier</dd>
      <dt>Click map</dt><dd>Add a waypoint at the end of the route</dd>
      <dt>Click a route leg</dt><dd>Insert a waypoint into that leg</dd>
      <dt>Drag waypoint</dt><dd>Move it</dd>
      <dt>Right-click waypoint</dt><dd>Delete it</dd>
      <dt>Drag yellow handle</dt><dd>Set final facing</dd>
      <dt>Backspace / Del</dt><dd>Delete the last waypoint</dd>
    </dl>
    <h2>Controls: kill zone (K)</h2>
    <dl class="help">
      <dt>K</dt><dd>Switch between editing routes and the kill zone</dd>
      <dt>Click map</dt><dd>Add a corner after the last one</dd>
      <dt>Click a side</dt><dd>Insert a corner into that side</dd>
      <dt>Drag corner</dt><dd>Move it (it cannot cross itself)</dd>
      <dt>Right-click corner</dt><dd>Delete it</dd>
    </dl>
    <h2>Controls: map and time</h2>
    <dl class="help">
      <dt>Drag map</dt><dd>Pan (left or middle button)</dd>
      <dt>Wheel</dt><dd>Zoom at the cursor</dd>
      <dt>F</dt><dd>Fit the map</dd>
      <dt>Space</dt><dd>Pause / Resume</dd>
      <dt>1 · 2 · 4</dt><dd>Time scale</dd>
      <dt>Esc</dt><dd>Clear selection</dd>
    </dl>
    <p class="muted">Routes and the kill zone can be edited during planning, while occupation is
    paused, and once BLUEFOR is ready. The dashed dark-red line is the OPFOR route given by the
    scenario; it cannot be edited.</p>
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

const TOOL_LABELS: Record<MapTool, string> = { routes: 'Routes', killZone: 'Kill zone' };
const toolButtons = (['routes', 'killZone'] as const).map((tool) => {
  const toolButton = document.createElement('button');
  toolButton.textContent = TOOL_LABELS[tool];
  toolButton.addEventListener('click', () => {
    session = setTool(session, tool);
  });
  ui('tools').append(toolButton);
  return { tool, toolButton };
});

function report(result: CommitResult): void {
  problems = result.ok ? [] : result.problems.map((p) => `${p.soldierId}: ${p.problem}`);
}

const execute = () => {
  if (exercise.phase === 'bluforPlanning') report(exercise.execute());
};
const pause = () => {
  if (isRunning()) exercise.pause();
};
const resume = () => {
  if (canResume()) report(exercise.resume());
};
const startOpfor = () => {
  const result = exercise.startOpfor();
  problems = result.ok ? [] : [...result.problems];
};
ui('execute').addEventListener('click', execute);
ui('pause').addEventListener('click', pause);
ui('resume').addEventListener('click', resume);
ui('start-opfor').addEventListener('click', startOpfor);
ui('fit').addEventListener('click', () => {
  map.fitView();
});

function isRunning(): boolean {
  return (
    !exercise.paused &&
    (exercise.phase === 'bluforOccupation' || exercise.phase === 'opforApproach')
  );
}

function canResume(): boolean {
  return exercise.paused || (exercise.phase === 'bluforReady' && exercise.hasUncommittedChanges);
}

window.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement) return;
  const selected = session.selectedSoldierId;
  switch (event.key) {
    case ' ':
      event.preventDefault();
      if (isRunning()) pause();
      else resume();
      break;
    case 'f':
    case 'F':
      map.fitView();
      break;
    case 'k':
    case 'K':
      session = setTool(session, session.tool === 'killZone' ? 'routes' : 'killZone');
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
      if (session.tool === 'routes' && selected !== null && last) {
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
      return `${clock(event.tick / exercise.simulation.config.tickRateHz)}  Command rejected (${event.reason})`;
    case 'ordersChanged':
    case 'engagementAreaChanged':
    case 'engagementAreaEntered':
      // Covered by the exercise's own milestones.
      return undefined;
  }
}

function describeMilestone(event: ExerciseEvent): string {
  const at = clock(event.timeSeconds);
  switch (event.type) {
    case 'planCommitted': {
      const { revision } = event;
      const changed = revision.changedSoldierIds.length;
      return `${at}  Plan revision ${String(revision.revision)} committed (${String(changed)} soldier${changed === 1 ? '' : 's'} re-tasked)`;
    }
    case 'paused':
      return `${at}  Paused`;
    case 'resumed':
      return `${at}  Resumed`;
    case 'bluforInPosition':
      return `${at}  BLUEFOR in position`;
    case 'opforStarted':
      return `${at}  START OPFOR: OPFOR approach begins`;
    case 'ambushTriggered':
      return `${clock(event.trigger.atSeconds)}  AMBUSH TRIGGERED by ${event.trigger.soldierId}`;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
}

function phaseLabel(): string {
  switch (exercise.phase) {
    case 'bluforPlanning':
      return 'BLUEFOR planning';
    case 'bluforOccupation':
      return exercise.paused ? 'Occupation paused' : 'BLUEFOR occupation';
    case 'bluforReady':
      return 'BLUEFOR ready';
    case 'opforApproach':
      return exercise.paused ? 'OPFOR approach paused' : 'OPFOR approach';
    case 'ambushTriggered':
      return 'Ambush triggered';
  }
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

function routeTable(plan: SoldierPlan, start: { x: number; y: number }, editable: boolean): string {
  if (plan.waypoints.length === 0) {
    return editable
      ? '<p class="muted">No waypoints. Click the map to add one.</p>'
      : '<p class="muted">No waypoints.</p>';
  }
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
    ${routeTable(plan, soldier.position, editable && session.tool === 'routes')}
    <h2>Final facing</h2>
    <div class="facing">${formatBearing(plan.finalFacing)}</div>
    ${editable ? '<p><button data-action="clear-route">Clear route</button></p>' : '<p class="muted">Plans can be changed while occupation is paused or once BLUEFOR is ready.</p>'}
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

function statusHtml(): string {
  const { soldiers } = exercise.simulation.state;
  const blufor = soldiers.filter((s) => s.side === TRAINEE_SIDE);
  const moving = blufor.filter(
    (s) => s.orders !== null && s.orders.behavior !== 'inPosition',
  ).length;
  const bluforText =
    exercise.phase === 'bluforPlanning'
      ? `${String(blufor.length)} soldiers at their start positions`
      : moving > 0
        ? `<span class="warn">${String(moving)} of ${String(blufor.length)} still moving</span>`
        : `<span class="ok">All ${String(blufor.length)} in position</span>`;
  const opforText = exercise.trigger
    ? `<span class="alert">${escapeHtml(exercise.trigger.soldierId)} entered the kill zone</span>`
    : exercise.opforStart
      ? `<span class="warn">Approaching along the scenario route</span>`
      : 'Waiting (not started)';
  return `
    <dt>BLUEFOR</dt><dd>${bluforText}</dd>
    <dt>OPFOR</dt><dd>${opforText}</dd>
  `;
}

function startCheckHtml(): string {
  if (exercise.opforStart) return '';
  const blockers = exercise.startOpforProblems();
  if (blockers.length === 0) {
    return '<p class="ok"><b>Ready.</b> Review positions and the kill zone, then press START OPFOR.</p>';
  }
  return `<p class="muted">START OPFOR is available when:</p><ul class="blockers">${blockers
    .map((b) => `<li>${escapeHtml(b)}</li>`)
    .join('')}</ul>`;
}

function killZoneHtml(): string {
  const zone = exercise.killZone;
  const editing = session.tool === 'killZone';
  const hint = exercise.canEditPlans
    ? editing
      ? '<p class="muted">Click the map to add corners.</p>'
      : '<p class="muted">Press <b>K</b> or choose <b>Edit: Kill zone</b> to draw it.</p>'
    : '';
  if (!zone) return `<p>Not drawn.</p>${hint}`;
  const area =
    zone.vertices.length >= 3
      ? ` · ${Math.round(polygonArea(zone.vertices)).toLocaleString()} m²`
      : '';
  const clear = exercise.canEditPlans
    ? '<p><button data-action="clear-kill-zone">Clear kill zone</button></p>'
    : '';
  return `<p>${escapeHtml(zone.id)}: ${String(zone.vertices.length)} corners${area}</p>${hint}${clear}`;
}

ui('kill-zone').addEventListener('click', (event) => {
  if (event.target instanceof HTMLElement && event.target.dataset['action'] === 'clear-kill-zone') {
    exercise.clearKillZone();
  }
});

function bannerHtml(): string | null {
  const trigger = exercise.trigger;
  if (trigger) {
    return `<div class="banner-title">AMBUSH TRIGGERED</div>
      <div>T+ ${clock(trigger.atSeconds)} · ${escapeHtml(trigger.soldierId)} entered the kill zone at
      E ${trigger.point.x.toFixed(0)} N ${trigger.point.y.toFixed(0)}</div>
      <div class="muted">Simulation stopped. Combat begins here in a later phase.</div>`;
  }
  if (exercise.phase === 'bluforReady') {
    return `<div class="banner-title ready">BLUEFOR IN POSITION</div>
      <div>Check the positions and kill zone, then press <b>START OPFOR</b>.</div>`;
  }
  return null;
}

const cached = new Map<string, string>();
function setHtml(name: string, html: string): void {
  if (cached.get(name) === html) return;
  ui(name).innerHTML = html;
  cached.set(name, html);
}

function updatePanels(): void {
  const { phase } = exercise;
  const phaseEl = ui('phase');
  phaseEl.dataset['phase'] = exercise.paused ? 'paused' : phase;
  phaseEl.textContent = phaseLabel();
  ui('clock').textContent = `T+ ${clock(exercise.simulation.timeSeconds)}`;
  button('execute').disabled = phase !== 'bluforPlanning';
  button('pause').disabled = !isRunning();
  button('resume').disabled = !canResume();
  const start = button('start-opfor');
  start.disabled = phase !== 'bluforReady';
  start.classList.toggle(
    'armed',
    phase === 'bluforReady' && exercise.startOpforProblems().length === 0,
  );
  for (const { scale, speedButton } of speedButtons) {
    speedButton.setAttribute('aria-pressed', String(session.timeScale === scale));
  }
  for (const { tool, toolButton } of toolButtons) {
    toolButton.setAttribute('aria-pressed', String(session.tool === tool));
  }

  setHtml('status', statusHtml());
  setHtml('start-check', startCheckHtml());
  setHtml('kill-zone', killZoneHtml());
  setHtml('selection', selectionHtml());
  ui('problems').textContent = problems.join('\n');
  setHtml(
    'events',
    eventLog
      .slice(0, 14)
      .map((line) => `<li>${escapeHtml(line)}</li>`)
      .join('') || '<li class="muted">Nothing yet.</li>',
  );
  const banner = bannerHtml();
  ui('banner').hidden = banner === null;
  ui('banner').dataset['kind'] = exercise.trigger ? 'triggered' : 'ready';
  setHtml('banner', banner ?? '');

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
  }
  for (const milestone of exercise.timeline.slice(timelineSeen))
    eventLog.unshift(describeMilestone(milestone));
  timelineSeen = exercise.timeline.length;
  eventLog.length = Math.min(eventLog.length, 60);
  lastFrameMs = nowMs;
  map.render();
  updatePanels();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
