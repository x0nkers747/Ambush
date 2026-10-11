import {
  buildPreviewScenario,
  buildScenario,
  createExercise,
  displayPoints,
  frameAt,
  gradeOf,
  frameSeconds,
  NO_KILL_ZONE,
  OPFOR_FORCES,
  scoreEngagement,
  TRAINEE_SIDE,
  type AmbushScenario,
  type EngagementScore,
  type Exercise,
  type ScenarioDefinition,
} from '#exercise';
import {
  clearSelection,
  createSession,
  setShowVisibility,
  setTimeScale,
  setTool,
  stepTimeScale,
  TIME_SCALES,
  type MapTool,
  type Session,
} from '#session';
import {
  DEFAULT_TICK_RATE_HZ,
  MAX_SEED,
  type SoldierId,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import {
  createTacticalMap,
  elevationTints,
  formatBearing,
  typicalElevationRange,
  type MapBinding,
  type MapEditor,
  type TacticalMap,
} from '#view2d';
import type { BattlefieldView3d } from '#view3d';
import { carryPlans, type CarryResult } from './carry-plans';
import {
  clock,
  COMBAT_HELP,
  createExerciseStage,
  minutesSeconds,
  PLANNING_HELP,
  REPLAY_HELP,
  SELECT_HINT,
  TIME_HELP,
} from './exercise-stage';
import { rosterHtml, rosterSource, wireRoster } from './roster';
import {
  createScenarioStage,
  SCENARIO_HELP,
  SCENARIO_TOOL_LABELS,
  scenarioToolHint,
  type ScenarioStage,
  type ScenarioTool,
} from './scenario-stage';
import {
  createConfirm,
  createToast,
  escapeHtml,
  headerHtml,
  htmlSetter,
  TRASH_ICON,
  wireHeader,
} from './shell';
import {
  backBlocker,
  nextBlocker,
  STAGE_NAMES,
  type WorkflowFacts,
  type WorkflowStage,
} from './workflow';

// Stages 2–5 of one battlefield (docs/adr/0025): the workflow header, the
// tactical map and a contextual side panel. Scenario editing (stage 2) and
// the exercise (stages 3–5) share the page and the map, so stepping back to
// the scenario keeps the exercise; a scenario change or an explicit restart
// builds a new exercise and carries the trainee's plans into it. The map can
// come from the terrain-selection preview and goes back to it on leaving, so
// it is never rebuilt between the two; the page stops its own frame loop and
// listeners when it is left.

/** The stages on this page. */
export type WorkspaceStage = Exclude<WorkflowStage, 'terrain'>;

export interface WorkspaceOptions {
  /** Shown in the header, e.g. "Demo battlefield" or the battlefield's name. */
  readonly title: string;
  readonly terrain: TerrainDataset;
  /** A battlefield's scenario, edited and saved here; or the demo's, fixed. */
  readonly scenario:
    | {
        readonly kind: 'editable';
        readonly definition: ScenarioDefinition;
        readonly save: (definition: ScenarioDefinition) => Promise<void>;
      }
    | { readonly kind: 'fixed'; readonly scenario: AmbushScenario };
  /** Source credits shown on the map (empty for the synthetic demo). */
  readonly attribution: readonly string[];
  /** Extra text for the pointer readout, e.g. latitude and longitude. */
  readonly describePoint?: (point: Vec2) => string;
  /** HTML describing the battlefield, for the collapsed Battlefield Information section. */
  readonly infoHtml: string;
  readonly initialStage: 'scenario' | 'bluefor';
  /** A message to show on arrival (e.g. a saved scenario that could not be read). */
  readonly notice?: string | null;
  /**
   * The terrain-selection preview's map of this battlefield, to keep as it is
   * (view and drawn terrain); otherwise a new map fitted to the terrain.
   */
  readonly map?: TacticalMap | null;
  /** Back to terrain selection (stage 1), handing the map over. The page has stopped by then. */
  readonly leave: (map: TacticalMap) => void;
  /** Records the stage in the page address, so a reload stays there. */
  readonly setAddress: (stage: 'scenario' | 'bluefor') => void;
}

/**
 * The simulation seed: `?seed=N` in the page address (an integer in
 * [0, 2^32 − 1]) to reproduce or vary an engagement, otherwise 1.
 */
function seedFromAddress(): number {
  const text = new URLSearchParams(window.location.search).get('seed');
  const seed = text === null ? NaN : Number(text);
  return Number.isInteger(seed) && seed >= 0 && seed <= MAX_SEED ? seed : 1;
}

/**
 * TEMPORARY, for testing: Move puts BLUEFOR in position at once, by stepping
 * the simulation until every Marine has arrived and turned (instead of
 * playing the occupation out in real time). Set to `false` (or delete it and
 * its use below) to restore the normal Move.
 */
const INSTANT_MOVE = true as boolean;

const PLANNING_TOOLS: readonly { tool: 'deploy' | 'killZone'; label: string; key: string }[] = [
  { tool: 'deploy', label: 'Waypoints', key: 'P' },
  { tool: 'killZone', label: 'Kill zone', key: 'K' },
];

export function startWorkspace(app: HTMLElement, o: WorkspaceOptions): void {
  app.className = 'workspace';
  app.innerHTML = `
  ${headerHtml(o.title)}
  <main class="ws-map">
    <div class="ws-canvas">
      <canvas id="map" aria-label="Tactical map"></canvas>
      <div class="attribution" data-ui="attribution" hidden></div>
      <div class="banner" data-ui="banner" hidden></div>
      <section class="sim-float" data-sec="sim" aria-label="Simulation">
        <h2>Simulation</h2>
        <div class="sim-row">
          <span class="clock" data-ui="clock" title="Simulation time"></span>
          <span class="sim-state" data-ui="sim-state" role="status"></span>
        </div>
        <div class="sim-row">
          <button class="action" data-ui="execute" title="Commit the BLUEFOR plans and move into position">Move</button>
          <button data-ui="pause" title="Pause (Space)">Pause</button>
          <button data-ui="resume" title="Commit changed plans and continue (Space)">Resume</button>
        </div>
        <div class="speed" role="group" aria-label="Time acceleration" data-ui="speeds"></div>
        <p class="hint" data-ui="sim-note"></p>
      </section>
      <div class="confirm" data-ui="confirm" hidden></div>
      <div class="toast" data-ui="toast" role="status" hidden></div>
    </div>
    <div class="mapbar">
      <span class="pointer" data-ui="pointer"></span>
      <span class="spacer"></span>
      <span class="mapbar-tool" data-ui="tool-label"></span>
      <div class="view-toggle" role="group" aria-label="Map view">
        <button class="small" data-view="2d" aria-pressed="true" title="The 2D tactical map">2D</button>
        <button class="small" data-view="3d" aria-pressed="false" title="The 3D battlefield view">3D</button>
      </div>
      <button class="small" data-ui="fit" title="Fit the whole map (F)">Fit map</button>
    </div>
  </main>
  <aside class="side" aria-label="Stage tools and status">
    <div class="primary-action" data-ui="primary-wrap">
      <button class="primary-btn" data-ui="primary" aria-describedby="primary-reason"></button>
      <p class="reason warn" id="primary-reason" data-ui="primary-reason"></p>
    </div>
    <section class="sec" data-sec="tools">
      <h2 data-ui="tools-title"></h2>
      <div data-stage="scenario">
        <div class="tool-grid" role="group" aria-label="Scenario tools">
          ${(['orp', 'opfor', 'route'] as const)
            .map(
              (t) =>
                `<button class="tool" data-tool="${t}" aria-pressed="false">${SCENARIO_TOOL_LABELS[t]}</button>`,
            )
            .join('')}
        </div>
        <div class="tool-row">
          <button class="small" data-ui="clear-route" title="Remove the route's waypoints (the OPFOR stays where it starts)">Clear route</button>
          <button class="small" data-ui="reset-scenario" title="Back to a new scenario: no ORP, no OPFOR">Reset scenario</button>
        </div>
        <p class="hint" data-ui="scenario-hint"></p>
      </div>
      <div data-stage="bluefor">
        <div class="tool-grid" role="group" aria-label="Planning tools">
          ${PLANNING_TOOLS.map((t) => {
            const button = `<button class="tool" data-ptool="${t.tool}" aria-pressed="false" title="${t.label}${t.tool === 'killZone' ? ' (K)' : ''}">${t.label}</button>`;
            return t.tool === 'killZone'
              ? `<div class="tool-with-action">${button}<button class="trash-btn" data-ui="clear-kill-zone" aria-label="Delete the kill zone" title="Delete the kill zone">${TRASH_ICON}</button></div>`
              : button;
          }).join('')}
          <button class="tool" data-ui="visibility" aria-pressed="false" title="Show what the selected Marine or fire team can see (V)">Visibility</button>
        </div>
        <div data-ui="planning-lock"></div>
      </div>
      <div data-stage="opfor">
        <div class="combat-actions">
          <button class="action" data-ui="start-opfor" aria-describedby="start-opfor-reason">Start OPFOR</button>
          <p class="reason" id="start-opfor-reason" data-ui="start-opfor-reason"></p>
          <button class="trigger-ambush" data-ui="trigger-ambush" aria-describedby="trigger-reason">Trigger Ambush</button>
          <p class="reason" id="trigger-reason" data-ui="trigger-reason" aria-live="polite"></p>
        </div>
        <dl class="kv readouts">
          <dt>OPFOR in kill zone</dt><dd data-ui="kill-zone-count" title="Active OPFOR (neither incapacitated nor escaped) inside the kill zone, boundary included. Information only: it never blocks the trigger."></dd>
          <dt>Approach time</dt><dd data-ui="approach-time" title="Simulation time since Start OPFOR (frozen when the ambush is triggered)"></dd>
        </dl>
      </div>
      <div data-stage="aar" class="replay">
        <div class="replay-time">
          <span class="clock" data-ui="replay-time">T+ 00:00.0</span>
          <span class="muted">of <span data-ui="replay-duration">00:00.0</span></span>
        </div>
        <input type="range" class="replay-scrub" data-ui="replay-scrub" min="0" max="0" step="1" value="0" aria-label="Replay timeline: time since the ambush was triggered">
        <div class="replay-buttons" role="group" aria-label="Replay">
          <button data-replay="restart" title="Restart from the beginning (Home)" aria-label="Restart from the beginning">⏮</button>
          <button data-replay="back" title="Step back 1 s (←)" aria-label="Step back one second">◀ 1 s</button>
          <button class="action" data-replay="play" data-ui="replay-play" title="Play or pause (Space)">Play</button>
          <button data-replay="forward" title="Step forward 1 s (→)" aria-label="Step forward one second">1 s ▶</button>
          <button data-replay="end" title="Jump to the end (End)" aria-label="Jump to the end">⏭</button>
        </div>
        <div class="speed" role="group" aria-label="Playback speed" data-ui="replay-speeds"></div>
        <label class="replay-follow"><input type="checkbox" data-ui="replay-follow"> Follow the selected Marine</label>
        <div class="replay-unit" data-ui="replay-unit"></div>
      </div>
    </section>
    <section class="sec" data-sec="score" data-stage="aar">
      <h2>Score</h2>
      <div class="scorecard" data-ui="score"></div>
    </section>
    <section class="sec" data-sec="status">
      <h2 data-ui="status-title">Status</h2>
      <div data-ui="status"></div>
    </section>
    <section class="sec" data-sec="roster">
      <h2>Squad roster</h2>
      <p class="muted" data-stage="bluefor">${SELECT_HINT}</p>
      <div data-ui="roster" class="roster"></div>
      <div data-stage="bluefor">
        <div class="selection" data-ui="selection"></div>
        <div data-ui="visibility-panel"></div>
      </div>
    </section>
    <details class="sec collapsible" data-sec="events">
      <summary>Event log</summary>
      <ul class="events" data-ui="events"></ul>
    </details>
    <details class="sec collapsible" data-sec="help">
      <summary>Help</summary>
      <div data-ui="help"></div>
    </details>
    <details class="sec collapsible" data-sec="info">
      <summary>Battlefield Information</summary>
      <div class="bf-info">${o.infoHtml}</div>
    </details>
  </aside>`;

  const ui = (name: string): HTMLElement => {
    const element = app.querySelector<HTMLElement>(`[data-ui="${name}"]`);
    if (!element) throw new Error(`Missing UI element ${name}`);
    return element;
  };
  const button = (name: string): HTMLButtonElement => {
    const element = ui(name);
    if (!(element instanceof HTMLButtonElement)) throw new Error(`${name} is not a button`);
    return element;
  };
  const setHtml = htmlSetter();
  const setText = (element: HTMLElement, text: string) => {
    if (element.textContent !== text) element.textContent = text;
  };
  const notify = createToast(ui('toast'));
  const confirm = createConfirm(ui('confirm'));

  // --- State -------------------------------------------------------------

  let stage: WorkspaceStage = o.initialStage;
  // The exercise runs at the fastest time acceleration unless the trainee slows it.
  let session: Session = setTimeScale(createSession(), 16);
  /** The planning tool last used in stage 3, restored on return. */
  let planningTool: 'deploy' | 'killZone' = 'deploy';
  /** Whether Visibility was on when stage 3 was left. */
  let planningVisibility = false;
  /** What happened to the plans when the exercise was last rebuilt, until the next one. */
  let carryNotice: string | null = null;

  const fixedScenario = o.scenario.kind === 'fixed' ? o.scenario.scenario : null;
  const editableScenario = o.scenario.kind === 'editable' ? o.scenario : null;
  const build = (scenario: AmbushScenario): Exercise =>
    createExercise({
      config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: seedFromAddress() },
      scenario,
    });

  // The scenario stage (battlefields only) needs the map for hit tests; the
  // map is created just below and never used before then.
  let toScreen: (p: Vec2) => Vec2 = (p) => p;
  const scenarioStage: ScenarioStage | null = editableScenario
    ? createScenarioStage({
        terrain: o.terrain,
        definition: editableScenario.definition,
        save: editableScenario.save,
        notify,
        toScreen: (p) => toScreen(p),
        editable: () => scenarioLock() === null,
        changed: (preview) => {
          if (stage === 'scenario') map.setExercise(preview);
        },
      })
    : null;
  const scenarioOf = (d: ScenarioDefinition) => buildScenario(o.terrain, d);
  /** Where the squad's organization comes from (the same for every scenario). */
  const source = rosterSource(
    o.scenario.kind === 'fixed'
      ? o.scenario.scenario
      : buildPreviewScenario(o.terrain, o.scenario.definition).scenario,
  );

  /** The exercise of stages 3–5; created when first needed (on a battlefield). */
  let exercise: Exercise | null = fixedScenario ? build(fixedScenario) : null;
  /** The definition the exercise was built from (battlefields). */
  let builtFrom: ScenarioDefinition | null = null;
  if (stage === 'bluefor' && scenarioStage) {
    builtFrom = scenarioStage.definition;
    exercise = build(scenarioOf(builtFrom));
  }
  /** The exercise, for code that only runs in stages 3–5 (where it always exists). */
  const ex = (): Exercise => {
    if (!exercise) throw new Error('No exercise yet');
    return exercise;
  };
  /** What the map shows: the scenario preview while editing a battlefield's scenario. */
  // --- After Action Review replay (docs/adr/0026) ---------------------------
  // The map, roster and panels show the exercise as it was at the replay's
  // frame (`Exercise.replayAt`); playing only moves the replay clock.
  const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
  const replay = { seconds: 0, playing: false, speed: 1 as number, follow: false };
  /** The recording to review: the exercise's, once the engagement has ended. */
  const reviewed = () => (exercise?.recording?.complete ? exercise.recording : null);
  const replayFrame = () => {
    const recording = reviewed();
    return recording ? frameAt(recording, replay.seconds) : 0;
  };
  /** The exercise as at the replay's frame, in the After Action Review; otherwise `null`. */
  const replayView = (): Exercise | null =>
    stage === 'aar' && exercise && reviewed() ? exercise.replayAt(replayFrame()) : null;

  const shown = (): Exercise =>
    stage === 'scenario' && scenarioStage ? scenarioStage.preview : (replayView() ?? ex());

  /** Whether the squad is not shown: while editing a scenario whose ORP is not placed yet. */
  const squadHidden = () =>
    stage === 'scenario' && scenarioStage !== null && !scenarioStage.squadPlaced;

  /** Whether stage 2 must not change the scenario now, and why. */
  const scenarioLock = (): 'fixed' | 'executed' | null =>
    !scenarioStage ? 'fixed' : exercise && exercise.revisions.length > 0 ? 'executed' : null;

  // While the scenario is locked the route stays labelled on the map, but
  // clicks and drags no longer edit it.
  const unlocked = () => scenarioLock() === null;
  const hooks = scenarioStage?.editor;
  const editor: MapEditor | undefined = hooks
    ? {
        active: () => stage === 'scenario',
        press: (point, screen, b) => unlocked() && (hooks.press?.(point, screen, b) ?? false),
        drag: (point) => hooks.drag?.(point),
        drop: (point) => hooks.drop?.(point),
        click: (point, screen) => {
          if (unlocked()) hooks.click(point, screen);
        },
        draw: (ctx, project) => hooks.draw?.(ctx, project),
        cursor: (point, screen) => (unlocked() ? (hooks.cursor?.(point, screen) ?? null) : null),
      }
    : undefined;

  const placeholder = app.querySelector<HTMLCanvasElement>('#map');
  if (!placeholder) throw new Error('Missing map canvas');
  const binding: MapBinding = {
    exercise: scenarioStage && stage === 'scenario' ? scenarioStage.preview : ex(),
    getSession: () => session,
    setSession: (next) => {
      session = next;
    },
    notify,
    ...(editor ? { editor } : {}),
    hideTrainee: () => squadHidden(),
  };
  const adopt = (handed: TacticalMap): TacticalMap => {
    // The preview's canvas takes the placeholder's place: same size, so the
    // drawn map stays on screen as it is.
    const canvas = handed.canvas;
    canvas.id = 'map';
    canvas.className = '';
    canvas.setAttribute('aria-label', 'Tactical map');
    placeholder.replaceWith(canvas);
    handed.attach(binding);
    return handed;
  };
  const map = o.map ? adopt(o.map) : createTacticalMap({ canvas: placeholder, ...binding });
  toScreen = (p) => map.toScreen(p);

  const exerciseStage = createExerciseStage({
    // In the After Action Review its panels show the replay's moment.
    exercise: () => replayView() ?? ex(),
    session: () => session,
    map,
  });

  // --- Exercise lifecycle -------------------------------------------------

  const describeCarry = (result: CarryResult, why: string): string | null =>
    result.problems.length === 0
      ? null
      : `${why} Not everything could be kept: ${result.problems.join(' ')}`;

  /**
   * A new exercise for the current scenario, with the trainee's plans carried
   * over wherever they are still valid. Reports anything that was not kept.
   */
  const rebuild = (why: string) => {
    const previous = exercise;
    const scenario = scenarioStage
      ? scenarioOf((builtFrom = scenarioStage.definition))
      : fixedScenario;
    if (!scenario) return;
    const next = build(scenario);
    carryNotice = previous ? describeCarry(carryPlans(previous, next), why) : null;
    exercise = next;
    exerciseStage.resetLog();
    if (stage !== 'scenario') map.setExercise(next);
    if (carryNotice) notify(carryNotice);
  };

  /** The exercise for stage 3: built on first entry, rebuilt if the scenario changed since. */
  const ensureExercise = () => {
    if (!scenarioStage) return;
    if (!exercise) {
      builtFrom = scenarioStage.definition;
      exercise = build(scenarioOf(builtFrom));
    } else if (builtFrom !== scenarioStage.definition) {
      rebuild('The scenario changed, so the exercise was rebuilt.');
    }
  };

  /** Restarting discards the execution; plans and the kill zone are carried over. */
  const restart = (then?: () => void) => {
    confirm({
      message:
        'Restart the exercise? BLUEFOR returns to the ORP, OPFOR to its start, and the clock to zero. Positions, formations and the kill zone are kept.',
      action: 'Restart exercise',
      onConfirm: () => {
        rebuild('The exercise was restarted.');
        then?.();
      },
    });
  };

  // --- Navigation ---------------------------------------------------------

  const hasWork = () =>
    exercise !== null &&
    (exercise.revisions.length > 0 || exercise.hasUncommittedChanges || exercise.killZone !== null);

  const enter = (target: WorkflowStage) => {
    // Once OPFOR has started there is no way back to planning or the scenario (workflow.ts).
    const back = backBlocker(target, facts);
    if (back !== null) {
      notify(back);
      return;
    }
    if (target === 'terrain') {
      // Leaving resets the battlefield's scenario (ORP, OPFOR and route): it
      // opens next time as a new one, and terrain selection previews it empty.
      const d = scenarioStage?.definition;
      const scenarioPlaced = d !== undefined && (d.orp !== null || d.opfor.route.length > 0);
      const leave = () => {
        stop();
        if (scenarioPlaced) scenarioStage?.reset();
        o.leave(map);
      };
      if (!hasWork() && !scenarioPlaced) {
        leave();
        return;
      }
      confirm({
        message: `Leave ${o.title}? ${
          scenarioStage
            ? 'The scenario (ORP, OPFOR and route), the BLUEFOR plans and the exercise are discarded.'
            : 'The BLUEFOR plans and the exercise are discarded.'
        }`,
        action: 'Leave battlefield',
        onConfirm: leave,
      });
      return;
    }
    const from = stage;
    if (from === 'bluefor') {
      planningVisibility = session.showVisibility;
      if (session.tool === 'deploy' || session.tool === 'killZone') planningTool = session.tool;
    }
    // The After Action Review opens at the trigger, paused.
    replay.playing = false;
    if (target === 'aar') replay.seconds = 0;
    replayShownFrame = -1;
    if (target === 'scenario' && exercise && exerciseStage.isRunning()) {
      // Nothing runs unseen: the exercise waits, paused, for the trainee's return.
      exercise.pause();
      notify('The simulation is paused while you look at the scenario.');
    }
    if (target === 'bluefor' && from === 'scenario') {
      if (scenarioStage) {
        scenarioStage.saveNow().catch((error: unknown) => {
          notify(
            `The scenario could not be saved: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      ensureExercise();
    }
    stage = target;
    // No editing tool stays armed in a stage where it does not belong.
    const tool: MapTool = target === 'bluefor' ? planningTool : 'view';
    session = setShowVisibility(setTool(session, tool), target === 'bluefor' && planningVisibility);
    map.setExercise(shown());
    if (target === 'scenario' || target === 'bluefor') o.setAddress(target);
    ui('confirm').hidden = true;
    placeRoster();
  };
  /**
   * The roster section comes right after the tools in BLUEFOR planning (with
   * the selected unit's details under the roster), and after the status in the
   * other stages. The section itself moves, so its clicks and selection stay.
   */
  const placeRoster = () => {
    const section = app.querySelector<HTMLElement>('[data-sec="roster"]');
    const after = app.querySelector<HTMLElement>(
      stage === 'bluefor' ? '[data-sec="tools"]' : '[data-sec="status"]',
    );
    if (section && after && after.nextElementSibling !== section) after.after(section);
    // Only BLUEFOR planning needs the roster for now.
    if (section) section.hidden = stage !== 'bluefor';
  };

  const facts: WorkflowFacts = {
    battlefieldSelected: () => true,
    scenarioProblems: () => (scenarioStage ? scenarioStage.problems() : []),
    startOpforProblems: () => (exercise ? exercise.startOpforProblems() : []),
    opforStarted: () => exercise?.opforStart != null,
    engagementComplete: () => exercise?.phase === 'engagementComplete',
  };
  const header = wireHeader(app, { go: enter, blocked: notify });

  // --- Controls -----------------------------------------------------------

  // Stage 2.
  for (const b of app.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
    b.addEventListener('click', () => {
      if (scenarioStage && scenarioLock() === null)
        scenarioStage.tool = b.dataset['tool'] as ScenarioTool;
    });
  }
  ui('clear-route').addEventListener('click', () => {
    if (scenarioStage && scenarioLock() === null) scenarioStage.clearRoute();
  });
  ui('reset-scenario').addEventListener('click', () => {
    if (!scenarioStage || scenarioLock() !== null) return;
    confirm({
      message: 'Reset the scenario? The ORP, the OPFOR and its route are removed.',
      action: 'Reset scenario',
      onConfirm: () => {
        scenarioStage.reset();
      },
    });
  });

  // Stage 3.
  for (const b of app.querySelectorAll<HTMLButtonElement>('[data-ptool]')) {
    b.addEventListener('click', () => {
      session = setTool(session, b.dataset['ptool'] as 'deploy' | 'killZone');
    });
  }
  ui('visibility').addEventListener('click', () => {
    session = setShowVisibility(session, !session.showVisibility);
  });
  exerciseStage.wireSelection(ui('selection'));
  ui('clear-kill-zone').addEventListener('click', () => {
    const e = exercise;
    if (stage === 'bluefor' && e?.killZone && e.canEditPlans) e.clearKillZone();
  });

  // Stage 4.
  ui('start-opfor').addEventListener('click', () => {
    if (exercise?.phase === 'bluforReady') exerciseStage.startOpfor();
  });
  ui('trigger-ambush').addEventListener('click', () => {
    exerciseStage.triggerAmbush();
  });

  // Simulation (stages 3–5).
  ui('execute').addEventListener('click', () => {
    if (stage !== 'bluefor') return;
    exerciseStage.execute();
    // TEMPORARY (INSTANT_MOVE): the occupation is stepped through within the click.
    const e = exercise;
    if (INSTANT_MOVE && e) {
      for (let i = 0; i < 30 * 900 && e.phase === 'bluforOccupation' && !e.paused; i += 1)
        exerciseStage.collect(e.advance(1 / 30));
    }
  });
  ui('pause').addEventListener('click', () => {
    if (stage === 'bluefor' || stage === 'opfor') exerciseStage.pause();
  });
  ui('resume').addEventListener('click', () => {
    if (stage === 'bluefor' || stage === 'opfor') exerciseStage.resume();
  });
  const speedButtons = TIME_SCALES.map((scale) => {
    const b = document.createElement('button');
    b.textContent = `${String(scale)}×`;
    b.setAttribute('aria-label', `${String(scale)} times speed`);
    b.addEventListener('click', () => {
      if (stage === 'bluefor' || stage === 'opfor') session = setTimeScale(session, scale);
    });
    ui('speeds').append(b);
    return { scale, b };
  });

  // The stage's primary action: the same rule as the header's Next; in the
  // After Action Review, back to planning.
  const PRIMARY: Readonly<Record<WorkspaceStage, string>> = {
    scenario: 'Continue to BLUEFOR Planning →',
    bluefor: 'Continue to OPFOR & Combat →',
    opfor: 'View After Action Review →',
    aar: '← Try again',
  };
  /**
   * Back to BLUEFOR planning from the After Action Review: a new exercise with
   * the plan as it was executed (`carryPlans`: positions, formations, facings,
   * the kill zone), nobody hurt, ready to change and run again. The recording
   * stays as it was until the next run makes a new one.
   */
  const returnToPlanning = () => {
    replay.playing = false;
    rebuild('Back to planning.');
    // Back to placing Marines: the Waypoints tool, whichever was used last.
    planningTool = 'deploy';
    enter('bluefor');
    if (!carryNotice)
      notify('Back to BLUEFOR Planning with your plan as it was executed: change it, then Move.');
  };
  const NEXT: Readonly<Record<WorkspaceStage, WorkspaceStage | null>> = {
    scenario: 'bluefor',
    bluefor: 'opfor',
    opfor: 'aar',
    aar: null,
  };
  ui('primary').addEventListener('click', () => {
    if (stage === 'aar') {
      returnToPlanning();
      return;
    }
    const reason = nextBlocker(stage, facts);
    const target = NEXT[stage];
    if (reason !== null || !target) {
      if (reason) notify(reason);
      return;
    }
    enter(target);
  });

  // The replay's controls (stage 5).
  /** Shows the replay's frame on the map when it changed, following the selected Marine. */
  let replayShownFrame = -1;
  const syncReplay = () => {
    const view = replayView();
    if (!view) return;
    const frame = replayFrame();
    if (frame !== replayShownFrame) {
      replayShownFrame = frame;
      map.setExercise(view);
    }
    const id = session.selectedSoldierId;
    const soldier = id === null ? null : view.simulation.state.soldiers.find((s) => s.id === id);
    if (replay.follow && soldier) map.centreOn({ x: soldier.position.x, y: soldier.position.y });
  };
  const seekReplay = (seconds: number) => {
    const recording = reviewed();
    if (!recording) return;
    replay.seconds = Math.min(Math.max(seconds, 0), recording.durationSeconds);
    syncReplay();
  };
  const replayAction = (action: string | undefined) => {
    const recording = reviewed();
    if (!recording || stage !== 'aar') return;
    switch (action) {
      case 'play':
        if (!replay.playing && replay.seconds >= recording.durationSeconds) replay.seconds = 0;
        replay.playing = !replay.playing;
        break;
      case 'restart':
        seekReplay(0);
        break;
      case 'end':
        replay.playing = false;
        seekReplay(recording.durationSeconds);
        break;
      case 'back':
        seekReplay(frameSeconds(recording, replayFrame()) - 1);
        break;
      case 'forward':
        seekReplay(frameSeconds(recording, replayFrame()) + 1);
        break;
    }
  };
  app.querySelector('.replay-buttons')?.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-replay]');
    replayAction(target?.dataset['replay']);
  });
  ui('replay-scrub').addEventListener('input', () => {
    const recording = reviewed();
    if (!recording) return;
    // Dragging the timeline pauses, at the frame it points to.
    replay.playing = false;
    seekReplay(frameSeconds(recording, Number((ui('replay-scrub') as HTMLInputElement).value)));
  });
  const replaySpeedButtons = REPLAY_SPEEDS.map((speed) => {
    const b = document.createElement('button');
    b.textContent = `${String(speed)}×`;
    b.setAttribute('aria-label', `${String(speed)} times speed`);
    b.addEventListener('click', () => {
      replay.speed = speed;
    });
    ui('replay-speeds').append(b);
    return { speed, b };
  });
  ui('replay-follow').addEventListener('change', () => {
    replay.follow = (ui('replay-follow') as HTMLInputElement).checked;
    syncReplay();
  });

  // Status panels' own buttons.
  ui('status').addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-action],[data-delete]',
    );
    if (!target) return;
    const index = target.dataset['delete'];
    if (index !== undefined && scenarioStage && scenarioLock() === null) {
      scenarioStage.deleteWaypoint(Number(index));
      return;
    }
    if (target.dataset['action'] === 'restart-edit') restart();
  });
  ui('planning-lock').addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (target?.dataset['action'] === 'restart') restart();
  });

  wireRoster(ui('roster'), {
    exercise: shown,
    session: () => session,
    setSession: (next) => {
      session = next;
    },
    map,
  });
  // --- 2D / 3D view (docs/adr/0029) ----------------------------------------
  // The 3D view is loaded the first time it is opened and then kept, with its
  // camera, until the page is left. Both views show the same exercise
  // (`shown()`: live, the scenario preview or the replay frame) and the same
  // selection; switching only changes which one draws.
  let viewMode: '2d' | '3d' = '2d';
  let view3d: BattlefieldView3d | null = null;
  let loading3d = false;
  let stopped = false;
  const showViewMode = () => {
    for (const b of app.querySelectorAll<HTMLButtonElement>('[data-view]'))
      b.setAttribute('aria-pressed', String(b.dataset['view'] === viewMode));
    if (view3d) view3d.canvas.hidden = viewMode !== '3d';
    app.dataset['view'] = viewMode;
    ui('fit').title = viewMode === '3d' ? 'Back to the overhead view (F)' : 'Fit the whole map (F)';
    setText(ui('fit'), viewMode === '3d' ? 'Reset view' : 'Fit map');
  };
  const setViewMode = (mode: '2d' | '3d') => {
    if (mode === '2d' || view3d) {
      viewMode = mode;
      showViewMode();
      return;
    }
    if (loading3d) return;
    loading3d = true;
    notify('Loading the 3D view…');
    import('#view3d')
      .then(({ createBattlefieldView3d }) => {
        loading3d = false;
        if (stopped) return;
        view3d = createBattlefieldView3d({
          exercise: shown,
          session: () => session,
          hideTrainee: squadHidden,
          tints: (terrain) => ({
            data: elevationTints(terrain, typicalElevationRange(terrain)),
            channels: 3,
          }),
        });
        ui('attribution').before(view3d.canvas);
        viewMode = '3d';
        showViewMode();
        notify('');
      })
      .catch((error: unknown) => {
        loading3d = false;
        notify(
          `The 3D view could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  for (const b of app.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    b.addEventListener('click', () => {
      setViewMode(b.dataset['view'] === '3d' ? '3d' : '2d');
    });
  }
  /** Fits the 2D map, or returns the 3D view to its overhead view. */
  const fitView = () => {
    if (viewMode === '3d' && view3d) view3d.resetView();
    else map.fitView();
  };
  ui('fit').addEventListener('click', fitView);
  if (o.attribution.length > 0) {
    // Compact on the map; the full list is under Battlefield Information.
    ui('attribution').hidden = false;
    ui('attribution').textContent = o.attribution
      .map((line) => line.replace(/^Map data /, ''))
      .slice(0, 2)
      .join(' · ');
    ui('attribution').title = o.attribution.join('\n');
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    if (!ui('confirm').hidden && event.key === 'Escape') {
      ui('confirm').hidden = true;
      return;
    }
    if (stage === 'aar') {
      const action = (
        {
          ' ': 'play',
          ArrowLeft: 'back',
          ArrowRight: 'forward',
          Home: 'restart',
          End: 'end',
        } as Record<string, string | undefined>
      )[event.key];
      if (action) {
        event.preventDefault();
        replayAction(action);
        return;
      }
    }
    const running = stage === 'bluefor' || stage === 'opfor';
    const planning = stage === 'bluefor';
    switch (event.key) {
      case 'f':
      case 'F':
        fitView();
        break;
      case 'Escape':
        session = clearSelection(session);
        break;
      case ' ':
        if (!running) return;
        event.preventDefault();
        if (exerciseStage.isRunning()) exerciseStage.pause();
        else exerciseStage.resume();
        break;
      case 'k':
      case 'K':
        if (planning)
          session = setTool(session, session.tool === 'killZone' ? 'deploy' : 'killZone');
        break;
      case 'v':
      case 'V':
        if (planning) session = setShowVisibility(session, !session.showVisibility);
        break;
      case '1':
      case '4':
      case '8':
        if (running) session = setTimeScale(session, Number(event.key) as 1 | 4 | 8);
        break;
      case '+':
      case '=':
        if (running) session = stepTimeScale(session, 1);
        break;
      case '-':
      case '_':
        if (running) session = stepTimeScale(session, -1);
        break;
      case 'Backspace':
      case 'Delete': {
        if (!planning || session.tool !== 'deploy') break;
        const e = ex();
        const team = session.selectedFireTeamId;
        if (team !== null && e.canEditPlans && e.formation(team)) {
          event.preventDefault();
          e.clearFormation(team);
          break;
        }
        const selected = session.selectedSoldierId;
        const destination = selected === null ? undefined : e.draft(selected)?.destination;
        if (selected !== null && destination) {
          event.preventDefault();
          e.clearDestination(selected);
        }
        break;
      }
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // --- Panels -------------------------------------------------------------

  const TOOLS_TITLE: Readonly<Record<WorkspaceStage, string>> = {
    scenario: 'Scenario tools',
    bluefor: 'Planning tools',
    opfor: 'OPFOR & combat',
    aar: STAGE_NAMES.aar,
  };
  const STATUS_TITLE: Readonly<Record<WorkspaceStage, string>> = {
    scenario: 'Scenario status',
    bluefor: 'BLUEFOR status',
    opfor: 'Combat status',
    aar: 'Engagement result',
  };
  const HELP: Readonly<Record<WorkspaceStage, string>> = {
    scenario: SCENARIO_HELP,
    bluefor: PLANNING_HELP + TIME_HELP,
    opfor: COMBAT_HELP + TIME_HELP,
    aar: REPLAY_HELP,
  };

  const message = (kind: 'ok' | 'warn' | 'alert', text: string) =>
    `<p class="msg ${kind}"><span aria-hidden="true">${kind === 'ok' ? '✓' : '⚠'}</span> ${escapeHtml(text)}</p>`;

  const problemsHtml = () =>
    exerciseStage.problems.length > 0
      ? `<ul class="problems">${exerciseStage.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`
      : '';
  const carryHtml = () => (carryNotice ? message('warn', carryNotice) : '');

  const scenarioStatusHtml = (): string => {
    const lock = scenarioLock();
    if (!scenarioStage) {
      const e = ex();
      const route = e.opforRoutes[0];
      const opfor = e.simulation.state.soldiers.filter((s) => s.side !== TRAINEE_SIDE).length;
      return `<dl class="kv">
        <dt>ORP</dt><dd><span class="ok">✓ Placed</span></dd>
        <dt>OPFOR</dt><dd><span class="ok">✓ Placed</span> <span class="muted">patrol of ${String(opfor)}</span></dd>
        <dt>Route</dt><dd>${route ? `${String(route.waypoints.length)} waypoints` : 'none'}</dd>
      </dl>${message('ok', 'Scenario ready. The demo’s scenario is fixed; generate a battlefield to edit one.')}`;
    }
    const problems = scenarioStage.problems();
    const ready = problems[0];
    return `${scenarioStage.statusHtml()}
      ${
        lock === 'executed'
          ? `${message('warn', 'BLUEFOR has executed its plan, so the scenario is locked. Restarting the exercise unlocks it; positions, formations and the kill zone are kept.')}
             <p><button class="small" data-action="restart-edit">Restart exercise to edit</button></p>`
          : ''
      }
      ${ready === undefined ? message('ok', 'Scenario ready.') : message('warn', ready)}
      <details class="sub"><summary>Route points (${String(scenarioStage.definition.opfor.route.length)})</summary>
        <ol class="route-list">${scenarioStage.routeHtml()}</ol></details>`;
  };

  const bluforStatusHtml = (): string => {
    const e = ex();
    const trainee = e.simulation.state.soldiers.filter(
      (s) => s.side === TRAINEE_SIDE && e.isPlannable(s.id),
    );
    const assigned = trainee.filter((s) => e.displayedPlan(s.id)?.destination).length;
    const inPosition = trainee.filter((s) => e.deploymentStatus(s.id) === 'inPosition').length;
    const plan =
      e.revisions.length === 0
        ? 'Not executed'
        : `Executed (revision ${String(e.revisions.length)})${e.hasUncommittedChanges ? ' · <span class="warn">changes not executed</span>' : ''}`;
    const blockers = e.opforStart ? [] : e.startOpforProblems();
    // The missing kill zone is not repeated here: Continue's reason gives it when it is the one left.
    // The first problem is Continue's reason at the top, and the missing kill zone is
    // given there when it is the one left: the status lists only the others.
    const listed = blockers.slice(1).filter((b) => b !== NO_KILL_ZONE);
    const readiness = e.opforStart
      ? message('ok', 'OPFOR has started: continue to OPFOR & Combat.')
      : blockers.length === 0
        ? message('ok', 'Ready for OPFOR.')
        : listed.length === 0
          ? ''
          : `<ul class="blockers">${listed.map((b) => `<li>${escapeHtml(b)}</li>`).join('')}</ul>`;
    return `<dl class="kv">
      <dt>Destinations</dt><dd>${String(assigned)} of ${String(trainee.length)} Marines</dd>
      <dt>In position</dt><dd>${String(inPosition)} of ${String(assigned)}</dd>
      <dt>Plan</dt><dd>${plan}</dd>
      <dt>Squad</dt><dd>${exerciseStage.bluforHtml()}</dd>
    </dl>${readiness}${problemsHtml()}${carryHtml()}`;
  };

  const combatStatusHtml = (): string => {
    const e = ex();
    const ambush =
      e.triggerState === 'triggered'
        ? `<span class="alert">Triggered at T+ ${clock(e.trigger?.atSeconds ?? 0)}</span>`
        : e.triggerState === 'queued'
          ? '<span class="alert">Queued: fire opens when the simulation runs</span>'
          : 'Not triggered';
    const combat =
      e.phase === 'engagementComplete'
        ? 'Complete'
        : e.phase === 'engagement'
          ? '<span class="alert">In progress</span>'
          : 'Not started';
    const engagement = exerciseStage.engagementHtml();
    return `<dl class="kv">
      <dt>BLUEFOR</dt><dd>${exerciseStage.bluforHtml()}</dd>
      <dt>OPFOR</dt><dd>${exerciseStage.opforHtml()}</dd>
      <dt>Ambush</dt><dd>${ambush}</dd>
      <dt>Combat</dt><dd>${combat}</dd>
    </dl>${problemsHtml()}${engagement ? `<h3>Engagement</h3>${engagement}` : ''}`;
  };

  const BEHAVIOR_LABELS: Readonly<Record<string, string>> = {
    engaging: 'Engaging',
    awaitingReaction: 'Not yet reacting',
    prone: 'Prone, returning fire',
    fleeing: 'Fleeing',
    escaped: 'Escaped',
    incapacitated: 'Incapacitated',
  };
  /** The selected Marine as at the replay's frame. */
  const replayUnitHtml = (view: Exercise): string => {
    const id = session.selectedSoldierId;
    if (id === null)
      return `<p class="muted">${
        session.selectedFireTeamId !== null
          ? 'Select a single Marine to see what they were doing.'
          : 'Select a Marine on the map to see what they were doing at this moment.'
      }</p>`;
    const state = view.simulation.state;
    const soldier = state.soldiers.find((s) => s.id === id);
    if (!soldier) return '';
    const combatant = state.engagement?.combatants.find((c) => c.soldierId === id);
    const member = view.rosterMember(id);
    const activity =
      soldier.status === 'incapacitated'
        ? 'Incapacitated'
        : combatant
          ? (BEHAVIOR_LABELS[combatant.behavior] ?? combatant.behavior)
          : soldier.orders && soldier.orders.behavior !== 'inPosition'
            ? 'Moving'
            : 'In position';
    const stats = combatant?.stats;
    return `<p class="sel-name">${escapeHtml(member?.slot.label ?? id)} <span class="muted">(${escapeHtml(id)})</span></p>
      <dl class="kv">
        <dt>Status</dt><dd>${soldier.status === 'incapacitated' ? '<span class="alert">Incapacitated</span>' : 'Active'}</dd>
        <dt>Doing</dt><dd>${escapeHtml(activity)}</dd>
        <dt>Posture</dt><dd>${escapeHtml(soldier.posture)}</dd>
        <dt>Position</dt><dd>E ${soldier.position.x.toFixed(0)} · N ${soldier.position.y.toFixed(0)}</dd>
        <dt>Facing</dt><dd>${formatBearing(soldier.azimuth)}</dd>
        <dt>Shots</dt><dd>${stats ? `${String(stats.shotsFired)} fired, ${String(stats.hits)} hit` : 'none yet'}</dd>
      </dl>`;
  };
  // --- The After Action Review's score (docs/adr/0027) ---------------------
  // From the completed engagement of the live exercise, never the replay
  // view: scrubbing or the playback speed cannot change it.
  let scored: { exercise: Exercise; score: EngagementScore } | null = null;
  const currentScore = (): EngagementScore | null => {
    const e = exercise;
    if (e?.phase !== 'engagementComplete') return null;
    if (scored?.exercise !== e)
      scored = { exercise: e, score: scoreEngagement(e.engagementResult) };
    return scored.score;
  };
  const SEVERITY_MARK: Readonly<Record<string, string>> = {
    high: '⚠',
    medium: '⚠',
    low: '•',
    info: '✓',
  };
  const scoreHtml = (): string => {
    const score = currentScore();
    if (!score) return '<p class="muted">The score appears once the engagement has ended.</p>';
    const e = exercise;
    const name = (id: SoldierId) => {
      const member = e?.rosterMember(id);
      return member ? `${member.slot.label} (${id})` : id;
    };
    const head =
      score.complete && score.total !== null
        ? `<div class="score-head"><span class="score-total">${displayPoints(score.total)}</span>
            <span class="muted">/ ${String(score.maxTotal)}</span>
            <span class="score-grade" data-grade="${gradeOf(score.total)}">${gradeOf(score.total)}</span></div>`
        : `<p class="warn">Incomplete assessment: ${escapeHtml(
            score.categories
              .filter((c) => c.points === null)
              .map((c) => c.label)
              .join(', '),
          )} could not be evaluated, so there is no total.</p>`;
    const categories = score.categories
      .map((c) => {
        const share = c.points === null ? 0 : Math.max(0, Math.min(1, c.points / c.maxPoints));
        return `<li class="score-cat">
          <div class="score-cat-row"><span>${escapeHtml(c.label)}</span>
            <span class="score-pts">${c.points === null ? 'unavailable' : `${displayPoints(c.points)} / ${String(c.maxPoints)}`}</span></div>
          <div class="score-bar" aria-hidden="true"><i style="width:${(share * 100).toFixed(1)}%"></i></div>
          ${
            c.points === null
              ? `<p class="hint">${escapeHtml(c.unavailableReason ?? '')}</p>`
              : c.deductions.map((d) => `<p class="hint">${escapeHtml(d)}</p>`).join('')
          }
        </li>`;
      })
      .join('');
    const recommendations =
      score.recommendations.length === 0
        ? '<p class="muted">No recommendations.</p>'
        : score.recommendations
            .map(
              (r) => `<details class="rec" data-severity="${r.severity}">
          <summary><span aria-hidden="true">${SEVERITY_MARK[r.severity] ?? '•'}</span> ${escapeHtml(r.title)}</summary>
          <p>${escapeHtml(r.observation)}</p>
          <p class="muted">${escapeHtml(r.recommendation)}</p>
          <dl class="kv">${r.measurements
            .map((m) => `<dt>${escapeHtml(m.label)}</dt><dd>${escapeHtml(String(m.value))}</dd>`)
            .join('')}</dl>
          ${r.unitIds.length > 0 ? `<p class="hint">Units: ${escapeHtml(r.unitIds.map(name).join(', '))}</p>` : ''}
        </details>`,
            )
            .join('');
    return `${head}<ul class="score-cats">${categories}</ul>
      <h3>Recommendations</h3>${recommendations}
      <p class="hint">Shots are firing opportunities (an aimed shot or a short burst), not rounds. An incapacitated Marine counts as killed.</p>`;
  };

  const updateReplayControls = () => {
    const recording = reviewed();
    const view = replayView();
    if (!recording || !view) return;
    const frame = replayFrame();
    const last = recording.frames.length - 1;
    setText(ui('replay-time'), `T+ ${clock(frameSeconds(recording, frame))}`);
    setText(ui('replay-duration'), clock(recording.durationSeconds));
    const scrub = ui('replay-scrub') as HTMLInputElement;
    if (scrub.max !== String(last)) scrub.max = String(last);
    if (scrub.value !== String(frame)) scrub.value = String(frame);
    const play = button('replay-play');
    setText(play, replay.playing ? 'Pause' : frame >= last ? 'Replay' : 'Play');
    play.classList.toggle('ready', !replay.playing);
    for (const { speed, b } of replaySpeedButtons) pressed(b, replay.speed === speed);
    const at = (name: string) => app.querySelector<HTMLButtonElement>(`[data-replay="${name}"]`);
    const back = at('back');
    const restart = at('restart');
    const forward = at('forward');
    const end = at('end');
    if (back) disable(back, frame === 0);
    if (restart) disable(restart, frame === 0);
    if (forward) disable(forward, frame >= last);
    if (end) disable(end, frame >= last);
    const follow = ui('replay-follow') as HTMLInputElement;
    if (follow.checked !== replay.follow) follow.checked = replay.follow;
    setHtml(ui('replay-unit'), replayUnitHtml(view));
  };

  const aarStatusHtml = (): string =>
    exerciseStage.engagementHtml() || '<p class="muted">No engagement result is available.</p>';

  const pressed = (b: HTMLElement, on: boolean) => {
    const v = String(on);
    if (b.getAttribute('aria-pressed') !== v) b.setAttribute('aria-pressed', v);
  };
  const disable = (b: HTMLButtonElement, off: boolean) => {
    if (b.disabled !== off) b.disabled = off;
  };
  const sections = [...app.querySelectorAll<HTMLElement>('[data-stage]')];

  const updateSimulation = () => {
    const e = ex();
    const live = stage === 'bluefor' || stage === 'opfor';
    setText(ui('clock'), `T+ ${clock(e.simulation.timeSeconds)}`);
    setText(ui('sim-state'), exerciseStage.phaseLabel());
    ui('sim-state').dataset['phase'] = e.paused ? 'paused' : e.phase;
    ui('execute').hidden = stage !== 'bluefor';
    disable(button('execute'), e.phase !== 'bluforPlanning');
    ui('execute').classList.toggle('ready', e.phase === 'bluforPlanning');
    disable(button('pause'), !live || !exerciseStage.isRunning());
    disable(button('resume'), !live || !exerciseStage.canResume());
    for (const { scale, b } of speedButtons) {
      pressed(b, live && session.timeScale === scale);
      disable(b, !live);
    }
    setText(ui('sim-note'), '');
  };

  const updateScenarioTools = () => {
    const lock = scenarioLock();
    for (const b of app.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      pressed(b, lock === null && scenarioStage?.tool === b.dataset['tool']);
      disable(b, lock !== null);
    }
    disable(button('clear-route'), lock !== null);
    disable(button('reset-scenario'), lock !== null);
    setText(
      ui('scenario-hint'),
      lock === 'fixed'
        ? 'The demo’s scenario is fixed and cannot be edited.'
        : lock === 'executed'
          ? 'Locked while the exercise has run: see the status below.'
          : scenarioToolHint(scenarioStage?.tool ?? 'orp'),
    );
  };

  const updatePlanningTools = () => {
    const e = ex();
    const locked = e.opforStart !== null;
    for (const b of app.querySelectorAll<HTMLButtonElement>('[data-ptool]')) {
      pressed(b, !locked && session.tool === b.dataset['ptool']);
      disable(b, locked);
    }
    pressed(ui('visibility'), session.showVisibility);
    setHtml(
      ui('planning-lock'),
      locked
        ? `${message('warn', 'OPFOR has started, so the plan is locked. Restart the exercise to re-plan; positions and the kill zone are kept.')}
           <p><button class="small" data-action="restart">Restart exercise</button></p>`
        : '',
    );
    setHtml(ui('selection'), exerciseStage.selectionHtml(!locked));
    // The kill zone's bin: greyed out with no kill zone, or once plans are locked.
    disable(button('clear-kill-zone'), locked || !e.killZone || !e.canEditPlans);
    setHtml(ui('visibility-panel'), exerciseStage.visibilityHtml());
  };

  const updateCombatTools = () => {
    const e = ex();
    const start = button('start-opfor');
    const startProblems = e.opforStart ? [] : e.startOpforProblems();
    disable(start, e.opforStart !== null || startProblems.length > 0);
    setText(start, e.opforStart ? 'OPFOR started' : 'Start OPFOR');
    start.classList.toggle('ready', !e.opforStart && startProblems.length === 0);
    setText(
      ui('start-opfor-reason'),
      e.opforStart ? '' : (startProblems[0] ?? 'Ready: BLUEFOR is in position.'),
    );
    ui('start-opfor-reason').classList.toggle('warn', !e.opforStart && startProblems.length > 0);

    const state = e.triggerState;
    const trigger = button('trigger-ambush');
    disable(trigger, state !== 'available');
    trigger.dataset['state'] = state;
    setText(
      trigger,
      state === 'queued'
        ? 'Ambush queued'
        : state === 'triggered'
          ? 'Ambush triggered'
          : 'Trigger Ambush',
    );
    setText(
      ui('trigger-reason'),
      state === 'unavailable'
        ? 'Available once the OPFOR approach has started.'
        : state === 'queued'
          ? e.paused
            ? 'Queued: fire opens when you resume.'
            : 'Queued: fire opens now.'
          : state === 'triggered'
            ? e.phase === 'engagementComplete'
              ? 'Engagement complete.'
              : 'Engagement in progress.'
            : 'Open fire now: the engagement begins at the current simulation time.',
    );
    ui('trigger-reason').classList.toggle('warn', state === 'unavailable');
    const occupancy = e.killZoneOccupancy();
    setText(
      ui('kill-zone-count'),
      occupancy ? `${String(occupancy.inside)} / ${String(occupancy.total)}` : '–',
    );
    ui('kill-zone-count').classList.toggle('alert', (occupancy?.inside ?? 0) > 0);
    const approach = e.approachSeconds;
    setText(ui('approach-time'), approach === null ? '--:--' : minutesSeconds(approach));
  };

  const updatePanels = () => {
    header.update(stage, facts);
    app.dataset['stage'] = stage;
    for (const s of sections) {
      const on = s.dataset['stage'] === stage;
      if (s.hidden === on) s.hidden = !on;
    }
    setText(ui('tools-title'), TOOLS_TITLE[stage]);
    setText(ui('status-title'), STATUS_TITLE[stage]);
    const hasExercise = stage !== 'scenario';
    const simSection = app.querySelector<HTMLElement>('[data-sec="sim"]');
    if (simSection) simSection.hidden = !hasExercise || stage === 'aar';
    const events = app.querySelector<HTMLElement>('[data-sec="events"]');
    if (events) events.hidden = !hasExercise;
    setHtml(ui('help'), HELP[stage]);

    switch (stage) {
      case 'scenario':
        updateScenarioTools();
        setHtml(ui('status'), scenarioStatusHtml());
        break;
      case 'bluefor':
        updatePlanningTools();
        setHtml(ui('status'), bluforStatusHtml());
        break;
      case 'opfor':
        updateCombatTools();
        setHtml(ui('status'), combatStatusHtml());
        break;
      case 'aar':
        updateReplayControls();
        setHtml(ui('score'), scoreHtml());
        setHtml(ui('status'), aarStatusHtml());
        break;
    }
    if (hasExercise) {
      updateSimulation();
      setHtml(
        ui('events'),
        stage === 'aar' ? exerciseStage.replayEventsHtml() : exerciseStage.eventsHtml(),
      );
    }

    // The primary action.
    const primary = button('primary');
    const label = PRIMARY[stage];
    ui('primary-wrap').hidden = label === '';
    const reason = label === '' || stage === 'aar' ? null : nextBlocker(stage, facts);
    setText(primary, label);
    const blocked = String(reason !== null);
    if (primary.getAttribute('aria-disabled') !== blocked)
      primary.setAttribute('aria-disabled', blocked);
    setText(ui('primary-reason'), reason ?? '');
    ui('primary-reason').hidden = reason === null;

    if (squadHidden()) {
      // Nothing hidden stays selected (e.g. after Reset scenario).
      if (session.selectedSoldierId !== null || session.selectedFireTeamId !== null)
        session = clearSelection(session);
      setHtml(ui('roster'), '<p class="muted">Place the ORP to deploy the squad.</p>');
    } else setHtml(ui('roster'), rosterHtml(shown(), session, source));

    // The map banner (stages 3 and 4).
    const banner =
      stage === 'bluefor' || stage === 'opfor' ? exerciseStage.bannerHtml(stage) : null;
    ui('banner').hidden = banner === null;
    const e = exercise;
    ui('banner').dataset['kind'] =
      e?.phase === 'engagementComplete' ? 'complete' : e?.trigger ? 'triggered' : 'ready';
    setHtml(ui('banner'), banner ?? '');

    setText(
      ui('tool-label'),
      stage === 'scenario' && scenarioStage && scenarioLock() === null
        ? `Tool: ${SCENARIO_TOOL_LABELS[scenarioStage.tool]}`
        : stage === 'bluefor' && ex().opforStart === null
          ? `Tool: ${session.tool === 'killZone' ? 'Kill zone' : 'Waypoints'}`
          : '',
    );
    const p = viewMode === '3d' ? null : map.pointer;
    setText(
      ui('pointer'),
      viewMode === '3d'
        ? (view3d?.status() ?? 'Drag: orbit · Right-drag: pan · Wheel: zoom · Double-click: focus')
        : p
          ? `E ${p.east.toFixed(1)} m   N ${p.north.toFixed(1)} m   Elev ${p.elevation.toFixed(1)} m${
              o.describePoint ? `   ${o.describePoint({ x: p.east, y: p.north })}` : ''
            }`
          : '',
    );
  };

  // --- Frame loop ---------------------------------------------------------

  let lastFrameMs: number | null = null;
  // rAF stops in hidden tabs; discard the gap on return rather than catching up.
  const onVisibilityChange = () => {
    lastFrameMs = null;
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  let frameId = 0;
  const frame = (nowMs: number) => {
    const recording = reviewed();
    if (stage === 'aar' && replay.playing && recording && lastFrameMs !== null) {
      replay.seconds += ((nowMs - lastFrameMs) / 1000) * replay.speed;
      if (replay.seconds >= recording.durationSeconds) {
        replay.seconds = recording.durationSeconds;
        replay.playing = false;
      }
    }
    if (stage === 'aar') syncReplay();
    if (exercise && stage !== 'aar') {
      const events =
        lastFrameMs === null
          ? []
          : exercise.advance((nowMs - lastFrameMs) / 1000, session.timeScale);
      exerciseStage.collect(events);
    }
    lastFrameMs = nowMs;
    if (viewMode === '3d' && view3d) view3d.render();
    else map.render();
    updatePanels();
    frameId = requestAnimationFrame(frame);
  };
  /** Stops the page (frame loop and global listeners); the map is handed on, not disposed. */
  const stop = () => {
    stopped = true;
    view3d?.dispose();
    view3d = null;
    cancelAnimationFrame(frameId);
    window.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('visibilitychange', onVisibilityChange);
  };

  enter(stage);
  if (o.notice) notify(o.notice);
  frameId = requestAnimationFrame(frame);
}

/** The demo's description for Battlefield Information. */
export function demoInfoHtml(scenario: AmbushScenario): string {
  const route = scenario.opforRoutes[0];
  const force = OPFOR_FORCES['patrol-3'];
  return `<dl class="kv">
    <dt>Location</dt><dd>Synthetic terrain (no real location)</dd>
    <dt>Size</dt><dd>800 × 600 m</dd>
    <dt>Terrain</dt><dd>A valley road through a hamlet, woods and a ridge</dd>
    <dt>OPFOR</dt><dd>Patrol of ${String(force.soldiers.length)}${route ? ` on a route of ${String(route.waypoints.length)} waypoints` : ''}</dd>
    <dt>Map data</dt><dd>None: the demo is generated, not imported</dd>
  </dl>`;
}
