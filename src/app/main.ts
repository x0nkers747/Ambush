import {
  createExercise,
  DEMO_SCENARIO,
  TRAINEE_SIDE,
  type CommitResult,
  type DeploymentStatus,
  type ExerciseEvent,
  type RosterUnit,
} from '#exercise';
import {
  clearSelection,
  createSession,
  selectSoldier,
  setShowVisibility,
  setTimeScale,
  setTool,
  stepTimeScale,
  TIME_SCALES,
  type MapTool,
  type Session,
} from '#session';
import { DEFAULT_TICK_RATE_HZ, polygonArea, soldierId, type SimEvent, type SoldierId } from '#sim';
import { createTacticalMap, formatBearing, symbolSvg } from '#view2d';

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
    <div class="group">
      <span class="label">View</span>
      <button data-ui="visibility" title="Show what the selected Marine can see (V)">Visibility</button>
    </div>
    <span class="spacer"></span>
    <button data-ui="fit" title="Fit the whole map (F)">Fit map</button>
  </header>
  <main>
    <canvas id="map" aria-label="Tactical map"></canvas>
    <div class="banner" data-ui="banner" hidden></div>
    <div class="toast" data-ui="toast" hidden></div>
  </main>
  <aside>
    <h2>Ambush status</h2>
    <dl class="status" data-ui="status"></dl>
    <div data-ui="start-check" class="start-check"></div>
    <h2>Roster</h2>
    <div data-ui="roster" class="roster"></div>
    <h2>Selected Marine</h2>
    <div data-ui="selection"></div>
    <div data-ui="problems" class="problems"></div>
    <h2>Kill zone</h2>
    <div data-ui="kill-zone"></div>
    <h2>Visibility</h2>
    <div data-ui="visibility-panel"></div>
    <h2>Events</h2>
    <ul class="events" data-ui="events"></ul>
    <h2>Controls: positions</h2>
    <dl class="help">
      <dt>Roster / symbol</dt><dd>Select a Marine</dd>
      <dt>Click map</dt><dd>Set the Marine's destination (click again to move it)</dd>
      <dt>Drag destination</dt><dd>Move it</dd>
      <dt>Drag yellow handle</dt><dd>Set the facing (kept when the destination moves)</dd>
      <dt>Right-click destination</dt><dd>Clear it</dd>
      <dt>Backspace / Del</dt><dd>Clear the destination</dd>
    </dl>
    <p class="muted">One destination and one facing per Marine. Paths are planned automatically
    round buildings; their bends are not handles. Without a chosen facing a Marine faces the way
    it arrives (dashed arrow). Marines without a destination stay put and never hold up
    readiness.</p>
    <h2>Controls: kill zone (K)</h2>
    <dl class="help">
      <dt>K</dt><dd>Switch between editing positions and the kill zone</dd>
      <dt>Click map</dt><dd>Add a corner after the last one</dd>
      <dt>Click a side</dt><dd>Insert a corner into that side</dd>
      <dt>Drag corner</dt><dd>Move it (it cannot cross itself)</dd>
      <dt>Right-click corner</dt><dd>Delete it</dd>
    </dl>
    <h2>Controls: visibility (V)</h2>
    <dl class="help">
      <dt>V</dt><dd>Show or hide what the selected Marine can see</dd>
      <dt>Select Marine</dt><dd>Show that Marine's visible area</dd>
      <dt>Drag destination</dt><dd>Compare positions: the green area follows</dd>
    </dl>
    <p class="muted">Green is the ground a standing Marine at the destination (or where they stand,
    if they have none) can see a standing person on. Terrain, buildings and vegetation block the
    view.</p>
    <h2>Controls: map and time</h2>
    <dl class="help">
      <dt>Drag map</dt><dd>Pan (left or middle button)</dd>
      <dt>Wheel</dt><dd>Zoom at the cursor</dd>
      <dt>F</dt><dd>Fit the map</dd>
      <dt>Space</dt><dd>Pause / Resume</dd>
      <dt>1 · 8</dt><dd>Time scale 1× · 8×</dd>
      <dt>+ / −</dt><dd>Faster / slower (1× · 8× · 16×)</dd>
      <dt>Esc</dt><dd>Clear selection</dd>
    </dl>
    <p class="muted">Positions and the kill zone can be edited during planning, while occupation is
    paused, and once BLUEFOR is ready. Destinations cannot be placed in or against a building. The
    dashed outline is the ORP, where the squad starts. The dashed dark-red line is the OPFOR route
    given by the scenario; it cannot be edited.</p>
    <h2>Symbols</h2>
    <p class="muted">Each Marine is the APP-6 friendly dismounted-individual infantry symbol
    (blue frame), the same for every role. The role label, facing stroke and yellow selection
    ring are Ambush! additions, not part of the standard. Where symbols would overlap, Marines
    are shown as small blue dots at their true positions; zoom in or use the roster.</p>
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
  notify: (message) => {
    showToast(message);
  },
});

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Shows a short message over the map, e.g. why a waypoint was refused. */
function showToast(message: string): void {
  const toast = ui('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 3500);
}

const speedButtons = TIME_SCALES.map((scale) => {
  const speedButton = document.createElement('button');
  speedButton.textContent = `${String(scale)}×`;
  speedButton.addEventListener('click', () => {
    session = setTimeScale(session, scale);
  });
  ui('speeds').append(speedButton);
  return { scale, speedButton };
});

const TOOL_LABELS: Record<MapTool, string> = { deploy: 'Positions', killZone: 'Kill zone' };
const toolButtons = (['deploy', 'killZone'] as const).map((tool) => {
  const toolButton = document.createElement('button');
  toolButton.textContent = TOOL_LABELS[tool];
  toolButton.addEventListener('click', () => {
    session = setTool(session, tool);
  });
  ui('tools').append(toolButton);
  return { tool, toolButton };
});

function report(result: CommitResult): void {
  problems = result.ok
    ? []
    : result.problems.map((p) => `${soldierName(p.soldierId)}: ${p.problem}`);
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
      session = setTool(session, session.tool === 'killZone' ? 'deploy' : 'killZone');
      break;
    case 'v':
    case 'V':
      session = setShowVisibility(session, !session.showVisibility);
      break;
    case 'Escape':
      session = clearSelection(session);
      break;
    case '1':
      session = setTimeScale(session, 1);
      break;
    case '8':
      session = setTimeScale(session, 8);
      break;
    case '+':
    case '=':
      session = stepTimeScale(session, 1);
      break;
    case '-':
    case '_':
      session = stepTimeScale(session, -1);
      break;
    case 'Backspace':
    case 'Delete': {
      const destination = selected === null ? undefined : exercise.draft(selected)?.destination;
      if (session.tool === 'deploy' && selected !== null && destination) {
        event.preventDefault();
        exercise.clearDestination(selected);
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
      const what = exercise.isPlannable(event.soldierId) ? 'destination' : 'route point';
      return `${clock(event.atSeconds)}  ${soldierName(event.soldierId)} reached ${what}${where}`;
    }
    case 'soldierInPosition':
      return `${clock(event.atSeconds)}  ${soldierName(event.soldierId)} in position`;
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
      return `${at}  Plan revision ${String(revision.revision)} committed (${String(changed)} Marine${changed === 1 ? '' : 's'} re-tasked)`;
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

const STATUS_LABELS: Record<DeploymentStatus, string> = {
  atOrp: 'At ORP',
  destinationAssigned: 'Destination assigned',
  moving: 'Moving',
  inPosition: 'In position',
  holding: 'Holding (no destination)',
};

/** Status counts for the status panel, e.g. "12 at the ORP". */
const COUNT_LABELS: Record<DeploymentStatus, string> = {
  atOrp: 'at the ORP',
  destinationAssigned: 'with a destination',
  moving: 'moving',
  inPosition: 'in position',
  holding: 'holding',
};

/** "1-AR (M03)" for a trainee soldier; the plain id for anyone else. */
function soldierName(id: string): string {
  const member = exercise.rosterMember(soldierId(id));
  return member ? `${member.slot.label} (${id})` : id;
}

function rosterUnitHtml(node: RosterUnit, depth: number): string {
  const sidc = node.unit.symbology?.sidc;
  const icon = sidc
    ? `<span class="unit-symbol" aria-hidden="true">${symbolSvg(sidc, 11)}</span>`
    : '';
  const rows = node.members
    .map((m) => {
      const id = soldierId(m.soldierId);
      const status = exercise.deploymentStatus(id) ?? 'atOrp';
      const selected = session.selectedSoldierId === id;
      const tip = `${m.role.name}${m.leads ? ` (leads ${node.unit.name})` : ''} · map label ${m.slot.label} · ${m.soldierId}`;
      return `<button class="roster-row" data-soldier="${escapeHtml(m.soldierId)}" aria-pressed="${String(selected)}" title="${escapeHtml(tip)}">
        <span class="abbr">${escapeHtml(m.role.abbreviation)}</span>
        <span class="role">${escapeHtml(m.role.name)}</span>
        <span class="sid">${escapeHtml(m.soldierId)}</span>
        <span class="st" data-status="${status}">${STATUS_LABELS[status]}</span>
      </button>`;
    })
    .join('');
  const children = node.children.map((c) => rosterUnitHtml(c, depth + 1)).join('');
  return `<div class="roster-unit" style="--depth:${String(depth)}">
    <div class="roster-unit-name">${icon}${escapeHtml(node.unit.name)}</div>${rows}${children}</div>`;
}

function rosterHtml(): string {
  const template = exercise.roster.unit;
  return `${rosterUnitHtml(exercise.roster, 0)}<p class="muted roster-source">${escapeHtml(
    template.name,
  )} · ${escapeHtml(sourceLine())}</p>`;
}

function sourceLine(): string {
  const { source, version } = DEMO_SCENARIO.organization.template;
  return source.kind === 'doctrine'
    ? `${source.designation}, ${source.date} (template ${version})`
    : `synthetic (template ${version})`;
}

ui('roster').addEventListener('click', (event) => {
  const row = event.target instanceof Element ? event.target.closest('[data-soldier]') : null;
  const id = row instanceof HTMLElement ? row.dataset['soldier'] : undefined;
  if (id === undefined) return;
  session = selectSoldier(session, exercise, soldierId(id));
  const soldier = exercise.simulation.state.soldiers.find((s) => s.id === id);
  if (soldier && !map.isInView(soldier.position)) map.centreOn(soldier.position);
});

/** Walked length of a planned route, metres. */
function routeLength(id: SoldierId): number {
  const route = exercise.displayedRoute(id);
  const leg = route?.legs[0];
  if (!route || !leg) return 0;
  const points = [route.start, ...(leg.turns ?? []), leg.to];
  return points
    .slice(1)
    .reduce(
      (sum, p, k) => sum + Math.hypot(p.x - (points[k]?.x ?? p.x), p.y - (points[k]?.y ?? p.y)),
      0,
    );
}

function selectionHtml(): string {
  const id = session.selectedSoldierId;
  if (id === null)
    return '<p class="muted">Choose a Marine in the roster or click a blue symbol on the map.</p>';
  const soldier = exercise.simulation.state.soldiers.find((s) => s.id === id);
  const plan = exercise.displayedPlan(id);
  const member = exercise.rosterMember(id);
  const facing = exercise.displayedFacing(id);
  if (!soldier || !plan || !member || !facing) return '';
  const editable = exercise.canEditPlans;
  const route = exercise.displayedRoute(id);
  const problem = route?.legs[0]?.problem;
  const status = exercise.deploymentStatus(id) ?? 'atOrp';
  const d = plan.destination;
  const length = routeLength(id);
  const speed = exercise.simulation.world.movement.speed;
  const detour = (route?.legs[0]?.turns?.length ?? 0) > 0 ? ' · bends round buildings' : '';
  const destination = d
    ? `<p>E ${d.east.toFixed(0)} · N ${d.north.toFixed(0)}</p>
       <p class="muted">${
         length < 0.5
           ? 'The Marine is there.'
           : `${length.toFixed(0)} m from where the Marine stands · about ${clock(length / speed)} at ${String(speed)} m/s${detour}`
       }</p>
       ${problem ? `<p class="alert">The destination is ${escapeHtml(problem)}.</p>` : ''}`
    : `<p class="muted">None: stays where they are.${editable && session.tool === 'deploy' ? ' Click the map to set one.' : ''}</p>`;
  const buttons = editable
    ? `<p class="buttons">
        <button data-action="clear-destination" ${d ? '' : 'disabled'}>Clear destination</button>
        <button data-action="default-facing" ${plan.facingDegrees === null ? 'disabled' : ''}>Default facing</button>
        <button data-action="reset-plan" title="Back to the last executed plan">Reset</button>
      </p>`
    : '<p class="muted">Plans can be changed while occupation is paused or once BLUEFOR is ready.</p>';
  return `
    <div class="soldier-title">${escapeHtml(member.slot.label)} · ${escapeHtml(member.role.name)}</div>
    <div class="muted">${escapeHtml(id)} · ${escapeHtml(unitName(member.slot.unitId))}${member.leads ? ' · leader' : ''}</div>
    <div>${STATUS_LABELS[status]}</div>
    <h2>Destination${editable ? ' (editable)' : ''}</h2>
    ${destination}
    <h2>Facing</h2>
    <div class="facing">${formatBearing(facing.azimuth)}</div>
    <div class="muted">${facing.explicit ? 'Set by you.' : d ? 'Default: the direction of arrival. Drag the yellow handle to choose one.' : 'Default: the current facing.'}</div>
    ${buttons}
  `;
}

function unitName(templateUnitId: string): string {
  const find = (node: RosterUnit): string | undefined =>
    node.unit.id === templateUnitId ? node.unit.name : node.children.map(find).find(Boolean);
  return find(exercise.roster) ?? templateUnitId;
}

ui('selection').addEventListener('click', (event) => {
  const id = session.selectedSoldierId;
  const action = event.target instanceof HTMLElement ? event.target.dataset['action'] : undefined;
  if (id === null || action === undefined) return;
  if (action === 'clear-destination') exercise.clearDestination(id);
  if (action === 'default-facing') exercise.clearFacing(id);
  if (action === 'reset-plan') exercise.resetPlan(id);
});

function statusHtml(): string {
  const trainee = exercise.simulation.state.soldiers.filter((s) => s.side === TRAINEE_SIDE);
  const counts = new Map<DeploymentStatus, number>();
  for (const s of trainee) {
    const status = exercise.deploymentStatus(s.id) ?? 'atOrp';
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const moving = counts.get('moving') ?? 0;
  const parts = (Object.keys(STATUS_LABELS) as DeploymentStatus[])
    .filter((k) => (counts.get(k) ?? 0) > 0)
    .map((k) => `${String(counts.get(k))} ${COUNT_LABELS[k]}`);
  const bluforText =
    exercise.phase !== 'bluforPlanning' && moving > 0
      ? `<span class="warn">${parts.join(' · ')}</span>`
      : exercise.phase === 'bluforReady'
        ? `<span class="ok">${parts.join(' · ')}</span>`
        : parts.join(' · ');
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

function visibilityHtml(): string {
  if (!session.showVisibility) {
    return '<p class="muted">Press <b>V</b> or <b>View: Visibility</b> to see what the selected Marine can see.</p>';
  }
  const id = session.selectedSoldierId;
  const view = map.visibility;
  if (id === null || !view)
    return '<p class="muted">Select a Marine to see their visible area.</p>';
  const name = escapeHtml(soldierName(id));
  const from = view.planned
    ? `From ${name}'s <b>DESTINATION</b>.`
    : `From ${name}'s <b>CURRENT POSITION</b> (no destination).`;
  // The viewshed shown may still be the previous one while the new one is computed.
  const shown = view.viewshed;
  const current =
    shown !== null && shown.observer.x === view.observer.x && shown.observer.y === view.observer.y
      ? shown
      : null;
  const resolution = shown ? `${String(shown.grid.cellSize)} m` : '';
  const status = view.pending
    ? `<p class="muted">Calculating…${shown ? ` (showing ${current ? `${resolution} preview` : `${resolution} result for the previous position`})` : ''}</p>`
    : `<p class="muted">Ground sampled every ${resolution}.</p>`;
  const coverage = current ? exercise.killZoneCoverage(current) : undefined;
  const zone = exercise.killZone
    ? coverage
      ? `<p><b>KILL ZONE VISIBLE: ${coverage.percent.toFixed(0)}%</b></p>
         <p class="muted">${String(coverage.visibleCells)} of the ${String(coverage.cells)} sample points (${resolution} grid) inside the kill zone can be seen.</p>`
      : view.pending
        ? ''
        : '<p class="muted">Complete the kill zone to see how much of it is visible.</p>'
    : '<p class="muted">Draw a kill zone to see how much of it is visible.</p>';
  return `<p>${from}</p>${status}${zone}`;
}

ui('visibility').addEventListener('click', () => {
  session = setShowVisibility(session, !session.showVisibility);
});

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
  setHtml('visibility-panel', visibilityHtml());
  ui('visibility').setAttribute('aria-pressed', String(session.showVisibility));
  setHtml('roster', rosterHtml());
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
