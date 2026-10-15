import { emptyMotionSample } from '#exercise';
import {
  FOF_DEFAULT_CONFIG,
  FOF_EXPERIMENTS,
  fofExperiment,
  formationsForLab,
  LAB_ORGANIZATION_NAMES,
  type FofExperimentId,
  type FofForceSpec,
  type FofRunSpec,
  type FofSample,
  type FofTerrainKind,
} from '#exercise/force-on-force';
import {
  nearestClearPoint,
  orgUnitId,
  sight,
  surfaceHeightAt,
  type ActionsOn,
  type FofConfig,
  type Side,
  type SimEvent,
  type VisibilityClass,
  roundsLeft,
} from '#sim';
import { Vector3 } from 'three';
import { createCharacterLayer } from '../characters/layer';
import { groundProjection, type MapPoint } from '../ground-projection';
import type { UnitMarker } from '../unit-markers';
import { createCityLayer, type CityLayer } from '../behavior-lab/city';
import { positionAt } from '../behavior-lab/overlays';
import { createLabScene } from '../behavior-lab/scene';
import { LAB_CSS } from '../behavior-lab/style';
import {
  DEFAULT_FOF_OVERLAYS,
  drawFofOverlays,
  FOF_OVERLAY_LABELS,
  knows,
  PHASE_TEXT,
  SIDE_COLOUR,
  type FofOverlayOptions,
  type Perspective,
  type SightLine,
} from './overlays';
import {
  createFofSession,
  fofRecordingFromJson,
  fofRecordingToJson,
  type FofRecording,
  type FofSession,
  type TimedEvent,
} from './session';
import { createFofWorkerSession, workerChannel } from './worker-session';
import { createWoodsLayer, type WoodsLayer } from './woods';

// Ambush! Force-on-Force Lab (docs/behavior-lab/force-on-force/05): two
// organizations on their own orders, detecting, engaging and ending in an
// adjudicated outcome, on the real simulation, the real soldiers and the
// game's renderer settings. Reached at #force-on-force; loaded only there.
//
// The page never changes the simulation itself: setups are run specs, orders
// are commands, and time is steps of the real kernel; everything drawn and
// listed is read from the simulation's state and events.

type Mode = 'select' | 'blue-start' | 'blue-dest' | 'red-start' | 'red-dest';

interface Settings {
  experiment: FofExperimentId;
  spec: FofRunSpec;
  /** Knobs over the experiment's configuration. */
  rules: 'detected' | 'identified';
  engageRangeM: number;
  lethality: number;
  suppression: number;
  maxDurationSeconds: number;
}

const SPEEDS = [0.5, 1, 2, 4, 8, 16, 32] as const;
const RATES = [10, 30, 60, 120] as const;
const HALF_M = 1200;
const ELEVATION_M = 10;
const SIDES: readonly Side[] = ['BLUEFOR', 'OPFOR'];

const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
};
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);
const pct = (x: number) => `${(x * 100).toFixed(0)} %`;

const FOF_CSS = `
.blab header { gap: 8px; }
.blab header h1 { white-space: nowrap; }
.blab header label { display: flex; gap: 4px; align-items: center; white-space: nowrap; }
.blab header button { white-space: nowrap; }
.blab .force { border-left: 3px solid; padding: 4px 8px; margin-bottom: 8px; background: var(--panel-2); border-radius: 4px; }
.blab .force h3 { margin: 0 0 4px; font-size: 13px; }
.blab .bar { height: 5px; background: rgba(255,255,255,0.12); border-radius: 3px; margin: 3px 0 6px; }
.blab .bar > i { display: block; height: 100%; border-radius: 3px; }
.blab .log { font-size: 12px; line-height: 1.4; max-height: 260px; overflow-y: auto; }
.blab .log div { padding: 1px 2px; cursor: pointer; border-radius: 3px; }
.blab .log div:hover { background: var(--panel-2); }
.blab .log time { color: var(--muted); font-variant-numeric: tabular-nums; margin-right: 6px; }
.blab .outcome { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); background: rgba(15,19,24,0.88);
  border: 1px solid var(--line); border-radius: 6px; padding: 8px 14px; text-align: center; max-width: 70%; }
.blab .outcome b { font-size: 16px; display: block; }
.blab .outcome small { color: var(--muted); }
.blab .perspective { position: absolute; right: 12px; top: 10px; background: rgba(15,19,24,0.8); padding: 3px 8px; border-radius: 4px; font-size: 12px; }
`;

/** A spec's force, with its configuration knobs applied. */
function configOf(settings: Settings): FofConfig {
  const base = settings.spec.config ?? FOF_DEFAULT_CONFIG;
  const c = JSON.parse(JSON.stringify(base)) as {
    fire: {
      engageLevel: string;
      weapons: { hitProbabilityByRange: { probability: number }[]; suppressionPerBurst: number }[];
    };
    force: { engageRangeM: number };
    termination: { maxDurationSeconds: number };
  };
  c.fire.engageLevel = settings.rules;
  c.force.engageRangeM = settings.engageRangeM;
  c.termination.maxDurationSeconds = settings.maxDurationSeconds;
  for (const w of c.fire.weapons) {
    for (const p of w.hitProbabilityByRange)
      p.probability = Math.min(1, p.probability * settings.lethality);
    w.suppressionPerBurst = Math.min(1, w.suppressionPerBurst * settings.suppression);
  }
  return c as unknown as FofConfig;
}

function specOf(settings: Settings): FofRunSpec {
  return { ...settings.spec, config: configOf(settings) };
}

function settingsFor(id: FofExperimentId, seed: number, tickRateHz: number): Settings {
  const spec = fofExperiment(id).variants(seed, tickRateHz)[0]?.spec;
  if (!spec) throw new Error(`experiment ${id} has no variant`);
  const config = spec.config ?? FOF_DEFAULT_CONFIG;
  return {
    experiment: id,
    spec,
    rules: config.fire.engageLevel,
    engageRangeM: config.force.engageRangeM,
    lethality: 1,
    suppression: 1,
    maxDurationSeconds: config.termination.maxDurationSeconds,
  };
}

/** Starts the lab in `root`; returns a function that stops it. */
export function startForceOnForceLab(root: HTMLElement): () => void {
  const style = document.createElement('style');
  style.textContent = LAB_CSS + FOF_CSS;
  document.head.append(style);
  root.className = '';
  const forceControls = (side: 'blue' | 'red', title: string) => `
    <section>
      <h2 style="color:${side === 'blue' ? SIDE_COLOUR.BLUEFOR : SIDE_COLOUR.OPFOR}">${title}</h2>
      <label class="row">Organization <select data-i="${side}-org">${Object.entries(
        LAB_ORGANIZATION_NAMES,
      )
        .map(([k, v]) => `<option value="${k}">${escape(v)}</option>`)
        .join('')}</select><span></span></label>
      <label class="row">Formation <select data-i="${side}-formation"></select><span></span></label>
      <label class="row" title="What the force does when it comes into contact">Actions on contact <select data-i="${side}-actions"><option value="attack">Attack</option><option value="withdraw">Withdraw</option><option value="continue">Continue</option></select><span></span></label>
      <label class="row">Posture <select data-i="${side}-posture"><option value="standing">Standing</option><option value="kneeling">Kneeling</option><option value="prone">Prone</option></select><span></span></label>
      <div class="buttons">
        <button data-a="${side}-start" title="Then click the ground">Set start</button>
        <button data-a="${side}-dest" title="Then click the ground (during the run: a new order)">Set destination</button>
        <button data-a="${side}-stay" title="No movement order: it stays where it starts">Stay</button>
      </div>
    </section>`;
  root.innerHTML = `
<div class="blab">
  <header>
    <h1>Ambush! Force-on-Force Lab</h1>
    <div class="group">
      <button data-a="play" class="primary" title="Play / pause (Space)">▶ Play</button>
      <button data-a="step" title="One tick (.)">Step</button>
      <button data-a="reset" title="Start the run again (R)">Reset</button>
    </div>
    <div class="group speed">${SPEEDS.map((s) => `<button data-speed="${String(s)}">${s < 1 ? '½' : String(s)}×</button>`).join('')}</div>
    <span class="time" data-o="time">T+ 00:00.0</span>
    <span class="grow"></span>
    <label>Terrain <select data-i="terrain" style="width:96px"><option value="open">Open</option><option value="wooded">Wooded</option><option value="urban">Urban</option></select></label>
    <label>Conditions <select data-i="visibility" style="width:150px"><option value="auto">As the terrain</option><option value="open">Clear (open)</option><option value="wooded">Clear (wooded)</option><option value="urban">Urban haze</option><option value="restricted">Restricted (dusk, mist)</option></select></label>
    <label>View as <select data-i="perspective" style="width:150px"><option value="observer">Observer (omniscient)</option><option value="BLUEFOR">BLUEFOR's picture</option><option value="OPFOR">OPFOR's picture</option></select></label>
    <label>Seed <input data-i="seed" type="number" min="0" step="1" style="width:64px"></label>
    <label>Tick rate <select data-i="rate" style="width:76px">${RATES.map((r) => `<option value="${String(r)}">${String(r)} Hz</option>`).join('')}</select></label>
  </header>
  <aside class="left">
    <section>
      <h2>EXPERIMENT</h2>
      <select data-i="experiment">${FOF_EXPERIMENTS.map((e) => `<option value="${e.id}">${escape(e.name)}</option>`).join('')}</select>
      <p class="hint" data-o="experiment-hint"></p>
      <div class="buttons"><button data-a="demo" class="primary" title="Two squads meet in the open; plays at 8×">Run the default demonstration</button></div>
    </section>
    ${forceControls('blue', 'BLUEFOR')}
    ${forceControls('red', 'OPFOR')}
    <section>
      <h2>RULES AND COMBAT (EXPERIMENTAL)</h2>
      <label class="row">Engage <select data-i="rules"><option value="detected">Confirmed contacts</option><option value="identified">Identified only</option></select><span></span></label>
      <label class="row">Engage range <input data-i="engage" type="range" min="100" max="700" step="25"><output data-o="engage"></output></label>
      <label class="row">Lethality <select data-i="lethality"><option value="0.5">× 0.5</option><option value="1">× 1</option><option value="2">× 2</option></select><span></span></label>
      <label class="row">Suppression <select data-i="suppression"><option value="0.5">× 0.5</option><option value="1">× 1</option><option value="2">× 2</option></select><span></span></label>
      <label class="row">Time limit <select data-i="limit"><option value="600">10 min</option><option value="1200">20 min</option><option value="1800">30 min</option><option value="3600">60 min</option></select><span></span></label>
      <p class="hint">Changes start a new run. Values are experimental, not validated (docs/behavior-lab/force-on-force).</p>
    </section>
    <section>
      <h2>OVERLAYS</h2>
      <div class="checks" data-o="overlays"></div>
    </section>
    <section>
      <h2>RECORDING</h2>
      <div class="buttons">
        <button data-a="replay" title="Re-simulate this run from its commands, checking every second's state hash">Replay &amp; verify</button>
        <button data-a="save">Save</button>
        <button data-a="load">Load…</button>
      </div>
      <p class="hint verify" data-o="verify"></p>
      <input data-i="file" type="file" accept=".json,application/json" hidden>
    </section>
  </aside>
  <div class="stage">
    <canvas class="view3d" data-o="canvas"></canvas>
    <canvas class="overlay" data-o="overlay"></canvas>
    <div class="loading" data-o="loading">Loading soldiers…</div>
    <div class="perspective" data-o="perspective-label"></div>
    <div class="outcome" data-o="outcome" hidden></div>
  </div>
  <aside class="right">
    <section>
      <h2>ORGANIZATIONS <span class="hint">(observer: both sides' true state)</span></h2>
      <div data-o="forces"></div>
    </section>
    <section>
      <h2>EVENTS <span class="hint">(click: go to that moment)</span></h2>
      <div class="log" data-o="log"></div>
    </section>
    <section data-o="detail"></section>
  </aside>
  <footer>
    <div class="timeline">
      <input data-i="timeline" type="range" min="0" max="0" step="1" value="0" title="Scrub (pauses)">
      <div class="graph-wrap"><canvas class="graph" data-o="graph"></canvas></div>
    </div>
    <div class="metrics" data-o="metrics"></div>
  </footer>
</div>`;
  const q = (selector: string): HTMLElement => {
    const el = root.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`force-on-force lab: missing ${selector}`);
    return el;
  };
  const input = (name: string) => q(`[data-i="${name}"]`) as HTMLInputElement;
  const output = (name: string) => q(`[data-o="${name}"]`);
  const canvas = q('[data-o="canvas"]') as HTMLCanvasElement;
  const overlay = q('[data-o="overlay"]') as HTMLCanvasElement;
  const graph = q('[data-o="graph"]') as HTMLCanvasElement;
  const timeline = input('timeline');

  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const firstExperiment = (params.get('experiment') as FofExperimentId | null) ?? 'demo';
  let settings = settingsFor(
    FOF_EXPERIMENTS.some((e) => e.id === firstExperiment) ? firstExperiment : 'demo',
    Number(params.get('seed') ?? 1),
    30,
  );
  let overlays: FofOverlayOptions = { ...DEFAULT_FOF_OVERLAYS };
  let perspective: Perspective = 'observer';
  // The simulation runs in a worker, so the page keeps drawing whatever it
  // costs (`worker=0` in the address: on the page, as before).
  const inWorker = typeof Worker !== 'undefined' && params.get('worker') !== '0';
  const newSession = (spec: FofRunSpec, recording?: FofRecording): FofSession =>
    inWorker
      ? createFofWorkerSession(spec, recording, workerChannel())
      : createFofSession(spec, recording);
  let session: FofSession = newSession(specOf(settings));
  let playing = false;
  let speed = 4;
  /** The tick play has reached (fractional; the head follows it as fast as it can). */
  let wanted = 0;
  let mode: Mode = 'select';
  let selected: string | null = null;
  let sightLines: SightLine[] = [];

  const scene = createLabScene(canvas, HALF_M, ELEVATION_M);
  const characters = createCharacterLayer(new URL('characters/', document.baseURI).href);
  // `soldiers=dots` in the address: soldiers as dots on the overlay instead of
  // animated characters, to measure the simulation without their rendering.
  const dots = new URLSearchParams(location.hash.split('?')[1] ?? '').get('soldiers') === 'dots';
  if (!dots) scene.scene.add(characters.group);
  let ground: { terrain: unknown; city: CityLayer; woods: WoodsLayer } | null = null;
  const showGround = () => {
    const terrain = session.view.sim.world.terrain;
    if (ground?.terrain === terrain) return;
    if (ground) {
      scene.scene.remove(ground.city.group, ground.woods.group);
      ground.city.dispose();
      ground.woods.dispose();
    }
    ground = {
      terrain,
      city: createCityLayer(terrain, ELEVATION_M),
      woods: createWoodsLayer(terrain, ELEVATION_M),
    };
    scene.scene.add(ground.city.group, ground.woods.group);
  };
  const lookAtStart = () => {
    const a = settings.spec.blufor.start;
    const b = settings.spec.opfor.start;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const span = Math.hypot(a.x - b.x, a.y - b.y);
    hook.view(mid, Math.min(1400, Math.max(260, span * 0.9)), 50, 250);
  };

  // --- the run --------------------------------------------------------------------
  const weaponMap = () => {
    const out: Record<string, string | null> = {};
    for (const f of session.head.forces) Object.assign(out, f.displayWeapons);
    return out;
  };
  let weapons = weaponMap();
  const restart = (recording?: FofRecording) => {
    session.dispose();
    session = recording ? newSession(recording.spec, recording) : newSession(specOf(settings));
    wanted = 0;
    weapons = weaponMap();
    selected = null;
    sightLines = [];
    refreshControls();
  };
  const forceSpec = (side: 'blue' | 'red'): FofForceSpec =>
    side === 'blue' ? settings.spec.blufor : settings.spec.opfor;
  const setForce = (side: 'blue' | 'red', patch: Partial<FofForceSpec>) => {
    const next = { ...forceSpec(side), ...patch };
    settings = {
      ...settings,
      spec:
        side === 'blue' ? { ...settings.spec, blufor: next } : { ...settings.spec, opfor: next },
    };
  };

  // --- controls ---------------------------------------------------------------------
  const refreshControls = () => {
    input('experiment').value = settings.experiment;
    output('experiment-hint').textContent = fofExperiment(settings.experiment).description;
    input('terrain').value = settings.spec.terrain;
    input('visibility').value = settings.spec.visibility ?? 'auto';
    input('perspective').value = perspective;
    input('seed').value = String(settings.spec.seed);
    input('rate').value = String(settings.spec.tickRateHz);
    for (const side of ['blue', 'red'] as const) {
      const f = forceSpec(side);
      input(`${side}-org`).value = f.organization;
      const formations = formationsForLab(f.organization);
      input(`${side}-formation`).innerHTML = formations
        .map((t) => `<option value="${t.id}">${escape(t.name)}</option>`)
        .join('');
      input(`${side}-formation`).value = f.formation;
      input(`${side}-posture`).value = f.posture ?? 'standing';
      input(`${side}-actions`).value = f.actionsOn ?? 'continue';
    }
    input('rules').value = settings.rules;
    input('engage').value = String(settings.engageRangeM);
    output('engage').textContent = `${String(settings.engageRangeM)} m`;
    input('lethality').value = String(settings.lethality);
    input('suppression').value = String(settings.suppression);
    input('limit').value = String(settings.maxDurationSeconds);
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      b.classList.toggle('on', Number(b.dataset['speed']) === speed);
    }
  };
  const changed = (apply: () => void) => {
    apply();
    settings = { ...settings, experiment: settings.experiment };
    restart();
  };
  input('experiment').addEventListener('change', (e) => {
    settings = settingsFor(
      (e.target as HTMLSelectElement).value as FofExperimentId,
      settings.spec.seed,
      settings.spec.tickRateHz,
    );
    restart();
    lookAtStart();
  });
  input('terrain').addEventListener('change', (e) => {
    changed(() => {
      settings = {
        ...settings,
        spec: {
          ...settings.spec,
          terrain: (e.target as HTMLSelectElement).value as FofTerrainKind,
        },
      };
    });
  });
  input('visibility').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    changed(() => {
      const spec: FofRunSpec = { ...settings.spec };
      if (v === 'auto') delete (spec as { visibility?: VisibilityClass }).visibility;
      else (spec as { visibility?: VisibilityClass }).visibility = v as VisibilityClass;
      settings = { ...settings, spec };
    });
  });
  input('perspective').addEventListener('change', (e) => {
    perspective = (e.target as HTMLSelectElement).value as Perspective;
  });
  input('seed').addEventListener('change', (e) => {
    changed(() => {
      const seed = Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0));
      settings = { ...settings, spec: { ...settings.spec, seed } };
    });
  });
  input('rate').addEventListener('change', (e) => {
    changed(() => {
      settings = {
        ...settings,
        spec: { ...settings.spec, tickRateHz: Number((e.target as HTMLSelectElement).value) },
      };
    });
  });
  for (const side of ['blue', 'red'] as const) {
    input(`${side}-org`).addEventListener('change', (e) => {
      changed(() => {
        const organization = (e.target as HTMLSelectElement).value as FofForceSpec['organization'];
        setForce(side, { organization, formation: formationsForLab(organization)[0]?.id ?? '' });
      });
    });
    input(`${side}-formation`).addEventListener('change', (e) => {
      changed(() => {
        setForce(side, { formation: (e.target as HTMLSelectElement).value });
      });
    });
    input(`${side}-actions`).addEventListener('change', (e) => {
      changed(() => {
        setForce(side, { actionsOn: (e.target as HTMLSelectElement).value as ActionsOn });
      });
    });
    input(`${side}-posture`).addEventListener('change', (e) => {
      changed(() => {
        setForce(side, {
          posture: (e.target as HTMLSelectElement).value as NonNullable<FofForceSpec['posture']>,
        });
      });
    });
  }
  input('rules').addEventListener('change', (e) => {
    changed(() => {
      settings = { ...settings, rules: (e.target as HTMLSelectElement).value as Settings['rules'] };
    });
  });
  input('engage').addEventListener('input', (e) => {
    output('engage').textContent = `${(e.target as HTMLInputElement).value} m`;
  });
  input('engage').addEventListener('change', (e) => {
    changed(() => {
      settings = { ...settings, engageRangeM: Number((e.target as HTMLInputElement).value) };
    });
  });
  for (const [name, key] of [
    ['lethality', 'lethality'],
    ['suppression', 'suppression'],
    ['limit', 'maxDurationSeconds'],
  ] as const) {
    input(name).addEventListener('change', (e) => {
      changed(() => {
        settings = { ...settings, [key]: Number((e.target as HTMLSelectElement).value) };
      });
    });
  }
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
    b.addEventListener('click', () => {
      speed = Number(b.dataset['speed']);
      refreshControls();
    });
  }
  const checks = output('overlays');
  checks.innerHTML = (Object.keys(FOF_OVERLAY_LABELS) as (keyof FofOverlayOptions)[])
    .map(
      (k) =>
        `<label><input type="checkbox" data-overlay="${k}" ${overlays[k] ? 'checked' : ''}> ${FOF_OVERLAY_LABELS[k]}</label>`,
    )
    .join('');
  for (const c of checks.querySelectorAll<HTMLInputElement>('[data-overlay]')) {
    c.addEventListener('change', () => {
      overlays = { ...overlays, [c.dataset['overlay'] ?? '']: c.checked };
    });
  }

  /** A new destination during the run: an order to that force (refused by the kernel while it is in contact). */
  const reorder = (side: 'blue' | 'red', point: MapPoint) => {
    const force = session.head.forces[side === 'blue' ? 0 : 1];
    session.submit({
      type: 'orderUnit',
      tick: 0,
      unitId: orgUnitId(force.unitId),
      order: {
        kind: 'moveInFormation',
        destination: point,
        formation: force.formation,
        pace: forceSpec(side).pace,
      },
    });
  };
  const actions: Record<string, () => void> = {
    play: () => {
      playing = !playing;
      wanted = session.viewTick;
    },
    step: () => {
      playing = false;
      session.step();
    },
    reset: () => {
      restart();
    },
    demo: () => {
      settings = settingsFor('demo', settings.spec.seed, settings.spec.tickRateHz);
      perspective = 'observer';
      restart();
      lookAtStart();
      speed = 8;
      playing = true;
      refreshControls();
    },
    'blue-start': () => (mode = mode === 'blue-start' ? 'select' : 'blue-start'),
    'blue-dest': () => (mode = mode === 'blue-dest' ? 'select' : 'blue-dest'),
    'red-start': () => (mode = mode === 'red-start' ? 'select' : 'red-start'),
    'red-dest': () => (mode = mode === 'red-dest' ? 'select' : 'red-dest'),
    'blue-stay': () => {
      changed(() => {
        setForce('blue', { destination: null, facingDeg: 0 });
      });
    },
    'red-stay': () => {
      changed(() => {
        setForce('red', { destination: null, facingDeg: 180 });
      });
    },
    save: () => {
      const blob = new Blob([fofRecordingToJson(session.recording())], {
        type: 'application/json',
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `force-on-force-${settings.experiment}-${String(settings.spec.seed)}-t${String(Math.round(session.head.sim.timeSeconds))}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    load: () => {
      input('file').click();
    },
    replay: () => {
      restart(session.recording());
      playing = true;
    },
  };
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-a]')) {
    b.addEventListener('click', () => {
      actions[b.dataset['a'] ?? '']?.();
    });
  }
  input('file').addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      try {
        const recording = fofRecordingFromJson(text);
        settings = { ...settings, experiment: settings.experiment, spec: recording.spec };
        restart(recording);
        playing = true;
      } catch (error) {
        output('verify').textContent =
          `Could not load: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
  });
  timeline.addEventListener('input', () => {
    playing = false;
    session.seek(Number(timeline.value));
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === ' ') {
      e.preventDefault();
      actions['play']?.();
    } else if (e.key === '.') actions['step']?.();
    else if (e.key === 'r' || e.key === 'R') actions['reset']?.();
    else if (e.key === 'Escape') mode = 'select';
  };
  window.addEventListener('keydown', onKey);

  // --- picking -------------------------------------------------------------------------
  let size = { width: 1, height: 1 };
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
    down = null;
    const r = canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const projection = groundProjection(scene.camera.camera, scene.groundAt, size, ELEVATION_M);
    if (mode !== 'select') {
      const point = projection.toWorld(screen);
      const clear = point ? nearestClearPoint(session.head.sim.world.terrain, point) : null;
      if (!clear) return;
      const side = mode.startsWith('blue') ? 'blue' : 'red';
      if (mode.endsWith('start')) {
        changed(() => {
          setForce(side, { start: clear });
        });
      } else if (session.headTick === 0) {
        changed(() => {
          setForce(side, { destination: clear });
        });
      } else {
        reorder(side, clear);
      }
      mode = 'select';
      return;
    }
    let best: string | null = null;
    let bestD = 24;
    const tick = renderTick();
    for (const s of session.view.sim.state.soldiers) {
      if (!visibleTo(s.id, s.side)) continue;
      const at = positionAt(session.motion, s.id, tick);
      if (!at) continue;
      const p = projection.toScreen(at, 1);
      const d = Math.hypot(p.x - screen.x, p.y - screen.y);
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    selected = best;
  });

  /** Whether the perspective shows a soldier: its own side, or an enemy it has a current track on. */
  const visibleTo = (id: string, side: Side): boolean => {
    if (knows(perspective, side)) return true;
    const fof = session.view.sim.state.fof;
    const force = fof?.forces.findIndex((f) => f.side === perspective) ?? -1;
    return (
      fof?.tracks.some(
        (t) =>
          t.force === force &&
          t.targetId === id &&
          (t.level === 'detected' || t.level === 'identified'),
      ) ?? false
    );
  };

  // --- panels ---------------------------------------------------------------------------
  const forcesEl = output('forces');
  const lastReason = new Map<Side, string>();
  const renderForces = () => {
    const state = session.view.sim.state;
    const fof = state.fof;
    if (!fof) return;
    const metrics = session.metrics();
    for (const { event } of session.events) {
      if (event.type === 'forcePhaseChanged' && event.tick < session.viewTick) {
        lastReason.set(event.side, event.reason);
      }
    }
    forcesEl.innerHTML = fof.forces
      .map((force, i) => {
        const members = fof.soldiers.filter((m) => m.force === i);
        const up = members.filter(
          (m) => state.soldiers.find((s) => s.id === m.soldierId)?.status === 'active',
        );
        const rounds = members.reduce((s, m) => s + roundsLeft(m), 0);
        const levels = { possible: 0, detected: 0, identified: 0, lost: 0 };
        for (const t of fof.tracks) if (t.force === i) levels[t.level] += 1;
        const m = metrics.sides[force.side];
        const first = (x: { seconds: number; rangeM: number | null } | null) =>
          x ? `${clock(x.seconds)}${x.rangeM === null ? '' : ` @ ${x.rangeM.toFixed(0)} m`}` : '–';
        const colour = SIDE_COLOUR[force.side];
        return `<div class="force" style="border-color:${colour}">
          <h3 style="color:${colour}">${force.side} · ${escape(force.unitId)}</h3>
          <div>${escape(PHASE_TEXT[force.phase])}</div>
          <div class="hint">${escape(lastReason.get(force.side) ?? 'on its movement order')}</div>
          <dl>
            <dt>Effectiveness</dt><dd>${pct(force.effectiveness)}</dd>
          </dl>
          <div class="bar"><i style="width:${pct(Math.max(0, force.effectiveness))};background:${colour}"></i></div>
          <dl>
            <dt>Active</dt><dd>${String(up.length)} / ${String(members.length)}</dd>
            <dt>Suppressed · pinned</dt><dd>${String(up.filter((x) => x.level === 'suppressed').length)} · ${String(up.filter((x) => x.level === 'pinned').length)} (mean ${pct(force.meanSuppression)})</dd>
            <dt>Ammunition</dt><dd>${pct(force.initialRounds > 0 ? rounds / force.initialRounds : 0)} (${String(rounds)} rounds)</dd>
            <dt>Contacts</dt><dd>? ${String(levels.possible)} · ! ${String(levels.detected)} · ✕ ${String(levels.identified)} · ○ ${String(levels.lost)}</dd>
            <dt>First possible</dt><dd>${first(m.firstPossible)}</dd>
            <dt>First detected</dt><dd>${first(m.firstDetected)}</dd>
            <dt>First identified</dt><dd>${first(m.firstIdentified)}</dd>
            <dt>Bursts · hits</dt><dd>${String(force.stats.bursts)} · ${String(force.stats.hits)}</dd>
          </dl></div>`;
      })
      .join('');
  };

  const detail = output('detail');
  const renderDetail = () => {
    if (!selected) {
      detail.innerHTML = '<h2>INSPECTOR</h2><p class="hint">Click a soldier to inspect him.</p>';
      return;
    }
    const state = session.view.sim.state;
    const soldier = state.soldiers.find((s) => s.id === selected);
    const fof = state.fof;
    const member = fof?.soldiers.find((m) => m.soldierId === selected);
    const force = member ? fof?.forces[member.force] : undefined;
    if (!soldier || !member || !force) return;
    const enemy = fof?.forces.findIndex((f) => f.side !== soldier.side) ?? -1;
    const known = fof?.tracks.find((t) => t.force === enemy && t.targetId === soldier.id);
    const why =
      soldier.status !== 'active'
        ? 'Incapacitated: out of the engagement; he no longer moves, looks or fires.'
        : member.level === 'pinned'
          ? 'Pinned by fire: prone, not firing, held in place until his suppression falls below the clear threshold.'
          : force.phase === 'engaged' || force.phase === 'contact'
            ? member.reacted
              ? member.nextFireAt !== null
                ? `In contact: ${soldier.posture}, facing the nearest known contact, firing when his next burst is due (${clock(member.nextFireAt)}).`
                : 'In contact: in position, with no target he can see or reach.'
              : 'His force has halted in contact: he is taking up his position (reaction delay).'
            : force.phase === 'possibleContact'
              ? 'His force has halted to observe a possible or distant contact: kneeling, watching.'
              : force.phase === 'assaulting'
                ? force.bounding.includes(soldier.id)
                  ? 'His element is bounding: rushing toward where his force believes the enemy is, not firing, while the rest of the force covers it with fire.'
                  : 'Base of fire: down, facing the enemy and firing to cover the element bounding forward; his element bounds in its turn.'
                : force.phase === 'withdrawing'
                  ? 'His force is breaking contact: moving back in formation, firing on the move at what he can see.'
                  : force.phase === 'holding'
                    ? 'Contact lost: holding in position before the force resumes its mission.'
                    : `${PHASE_TEXT[force.phase]}: on his unit's movement order.`;
    detail.innerHTML = `<h2>${escape(soldier.side)} ${escape(soldier.id)}</h2><dl>
      <dt>Unit</dt><dd>${escape(soldier.unitId)}${member.leader ? ' · leader' : ''}</dd>
      <dt>Status · posture</dt><dd>${soldier.status} · ${soldier.posture}</dd>
      ${member.arms.map((a) => `<dt>${escape(a.id)}</dt><dd>${String(a.loaded)} loaded · ${String(a.reserve)} in reserve${member.reloadUntil !== null && member.arms[member.reloading] === a ? ' · reloading' : ''}</dd>`).join('') || '<dt>Weapon</dt><dd>none</dd>'}
      <dt>Suppression</dt><dd>${pct(member.suppression)} (${member.level})</dd>
      <dt>Bursts · hits</dt><dd>${String(member.stats.bursts)} · ${String(member.stats.hits)}</dd>
      <dt>Targeted · hit</dt><dd>${String(member.stats.timesTargeted)} · ${String(member.stats.timesHit)}</dd>
      <dt>Enemy knows him</dt><dd>${known ? `${known.level} (seen ${clock(known.lastSeenAt)})` : 'no'} <span class="hint">(observer)</span></dd>
    </dl><div class="why">${escape(why)}</div>`;
  };

  // The event timeline: major events only, each from a recorded simulation event or the state.
  const logEl = output('log');
  let loggedFor = '';
  const describe = (e: SimEvent, firsts: Set<string>): string | null => {
    switch (e.type) {
      case 'unitOrdered': {
        const side = e.unitId.startsWith('B-') ? 'BLUEFOR' : 'OPFOR';
        const key = `move:${side}`;
        if (firsts.has(key)) return null;
        firsts.add(key);
        return `${side} begins movement`;
      }
      case 'contactObserved': {
        if (e.to !== 'possible' && e.to !== 'detected' && e.to !== 'identified') return null;
        const key = `${e.to}:${e.side}`;
        if (firsts.has(key)) return null;
        firsts.add(key);
        const range = e.rangeM === null ? '' : ` at ${e.rangeM.toFixed(0)} m`;
        const by = e.observerId ? `, seen by ${e.observerId}` : ' (under fire)';
        const what =
          e.to === 'possible'
            ? 'detects a possible contact'
            : e.to === 'detected'
              ? 'confirms a contact'
              : 'identifies OPFOR'.replace('OPFOR', e.side === 'BLUEFOR' ? 'OPFOR' : 'BLUEFOR');
        return `${e.side} ${what} (${e.targetId}${range}${by})`;
      }
      case 'forcePhaseChanged':
        return `${e.side}: ${PHASE_TEXT[e.to]} — ${e.reason}`;
      case 'fofFire': {
        const fired = `fire:${e.side}`;
        const received = `fired-on:${e.side === 'BLUEFOR' ? 'OPFOR' : 'BLUEFOR'}`;
        const lines: string[] = [];
        if (!firsts.has(fired)) {
          firsts.add(fired);
          lines.push(
            `${e.side} opens fire (${e.shooterId}, ${e.weapon}, ${e.rangeM.toFixed(0)} m)`,
          );
        }
        if (!firsts.has(received)) {
          firsts.add(received);
          lines.push(`${received.slice(9)} receives simulated fire`);
        }
        return lines.length > 0 ? lines.join(' · ') : null;
      }
      case 'soldierIncapacitated':
        return `${e.soldierId} incapacitated (by ${e.byId})`;
      case 'suppressionChanged': {
        if (e.to !== 'pinned') return null;
        const side = e.soldierId.startsWith('B') ? 'BLUEFOR' : 'OPFOR';
        const key = `pinned:${side}`;
        if (firsts.has(key)) return null;
        firsts.add(key);
        return `${side}: first soldier pinned (${e.soldierId})`;
      }
      case 'fofEnded': {
        const o = e.outcome;
        return `END: ${o.outcome} (${o.basis}) — ${o.reason}`;
      }
      case 'commandRejected':
        return e.reason === 'unitInContact' ? 'Order refused: the force is in contact' : null;
      default:
        return null;
    }
  };
  const renderLog = () => {
    const key = `${String(session.viewTick)}:${String(session.events.length)}`;
    if (key === loggedFor) return;
    loggedFor = key;
    const firsts = new Set<string>();
    const lines: string[] = [];
    // Effectiveness milestones, from the state sampled each second.
    const crossed = new Map<Side, number>();
    let sampleIndex = 0;
    const samples = session.samples;
    const flushSamples = (until: number) => {
      while (sampleIndex < samples.length && (samples[sampleIndex]?.seconds ?? Infinity) <= until) {
        const s = samples[sampleIndex];
        sampleIndex += 1;
        if (!s) continue;
        for (const side of SIDES) {
          const e = s.sides[side].effectiveness;
          const level = e < 0.5 ? 2 : e < 0.75 ? 1 : 0;
          if (level > (crossed.get(side) ?? 0)) {
            crossed.set(side, level);
            lines.push(
              `<div data-seek="${String(s.seconds)}"><time>${clock(s.seconds)}</time>${side} effectiveness below ${level === 2 ? '50' : '75'} %</div>`,
            );
          }
        }
      }
    };
    for (const { seconds, event } of session.events) {
      if (event.tick >= session.viewTick) break;
      flushSamples(seconds);
      const text = describe(event, firsts);
      if (!text) continue;
      const colour = 'side' in event ? SIDE_COLOUR[event.side] : 'inherit';
      lines.push(
        `<div data-seek="${String(seconds)}" style="color:${colour}"><time>${clock(seconds)}</time>${escape(text)}</div>`,
      );
    }
    logEl.innerHTML = lines.join('') || '<p class="hint">Nothing yet.</p>';
    logEl.scrollTop = logEl.scrollHeight;
    for (const el of logEl.querySelectorAll<HTMLElement>('[data-seek]')) {
      el.addEventListener('click', () => {
        playing = false;
        session.seek(Math.round(Number(el.dataset['seek']) * session.spec.tickRateHz));
      });
    }
  };

  const metricsEl = output('metrics');
  const renderMetrics = () => {
    const m = session.metrics();
    const cpu = session.cpu();
    const v = session.verification;
    const verify = output('verify');
    verify.className = `hint verify ${v ? (v.mismatches === 0 ? 'ok' : 'bad') : ''}`;
    verify.textContent = v
      ? v.mismatches === 0
        ? `Replay matches the recording: ${String(v.checked)} s verified.`
        : `MISMATCH at ${String(v.firstMismatch)} s (${String(v.mismatches)} of ${String(v.checked)} s).`
      : 'Replay re-simulates from the commands and checks every second.';
    const row = (label: string, b: string, o: string) =>
      `<tr><td>${label}</td><td class="n" style="color:${SIDE_COLOUR.BLUEFOR}">${b}</td><td class="n" style="color:${SIDE_COLOUR.OPFOR}">${o}</td></tr>`;
    const s = m.sides;
    const t = (x: { seconds: number } | null) => (x ? clock(x.seconds) : '–');
    metricsEl.innerHTML = `<table>
      <tr><th></th><th class="n">BLUEFOR</th><th class="n">OPFOR</th></tr>
      ${row('Possible · confirmed', `${t(s.BLUEFOR.firstPossible)} · ${t(s.BLUEFOR.firstDetected)}`, `${t(s.OPFOR.firstPossible)} · ${t(s.OPFOR.firstDetected)}`)}
      ${row('Identified', t(s.BLUEFOR.firstIdentified), t(s.OPFOR.firstIdentified))}
      ${row('Attempts · glimpses', `${String(s.BLUEFOR.detectionAttempts)} · ${String(s.BLUEFOR.glimpses)}`, `${String(s.OPFOR.detectionAttempts)} · ${String(s.OPFOR.glimpses)}`)}
      ${row('Lost · regained', `${String(s.BLUEFOR.contactsLost)} · ${String(s.BLUEFOR.reacquisitions)}`, `${String(s.OPFOR.contactsLost)} · ${String(s.OPFOR.reacquisitions)}`)}
      ${row('Rounds · hits', `${String(s.BLUEFOR.rounds)} · ${String(s.BLUEFOR.hits)}`, `${String(s.OPFOR.rounds)} · ${String(s.OPFOR.hits)}`)}
      ${row('Casualties', String(s.BLUEFOR.casualties), String(s.OPFOR.casualties))}
      ${row('Suppressed (soldier-s)', s.BLUEFOR.suppressedSeconds.toFixed(0), s.OPFOR.suppressedSeconds.toFixed(0))}
      ${row('Participation', pct(s.BLUEFOR.participation), pct(s.OPFOR.participation))}
      ${row('Effectiveness', pct(s.BLUEFOR.effectiveness), pct(s.OPFOR.effectiveness))}
      <tr><td>Engagement</td><td colspan="2" class="n">${m.engagementStart === null ? 'none yet' : `from ${clock(m.engagementStart)}, ${m.engagementSeconds.toFixed(0)} s`}</td></tr>
      <tr><td>Outcome</td><td colspan="2" class="n">${m.outcome ? `${escape(m.outcome.outcome)} (${m.outcome.basis})` : 'running'}</td></tr>
      <tr><td>Simulation CPU / tick</td><td colspan="2" class="n">${cpu.mean.toFixed(2)} ms (p95 ${cpu.p95.toFixed(2)})</td></tr>
      <tr><td>Agents · invalid</td><td colspan="2" class="n">${String(session.view.sim.state.soldiers.length)} · ${String(m.invalidTransitions)}</td></tr>
    </table>`;
  };

  const outcomeEl = output('outcome');
  const renderOutcome = () => {
    const o = session.view.sim.state.fof?.outcome;
    outcomeEl.hidden = !o;
    if (!o) return;
    const title: Record<string, string> = {
      blueforVictory: 'BLUEFOR VICTORY',
      opforVictory: 'OPFOR VICTORY',
      blueforWithdrawal: 'BLUEFOR WITHDREW',
      opforWithdrawal: 'OPFOR WITHDREW',
      mutualIneffective: 'BOTH COMBAT INEFFECTIVE',
      mutualDisengagement: 'MUTUAL DISENGAGEMENT',
      stalemate: 'STALEMATE (ADJUDICATED)',
      timeLimit: 'TIME LIMIT (ADJUDICATED)',
      noContact: 'NO CONTACT',
      invalid: 'INVALID SIMULATION STATE',
    };
    outcomeEl.innerHTML = `<b>${title[o.outcome] ?? o.outcome}</b>${escape(o.reason)} at ${clock(o.atSeconds)}<br><small>${o.basis}${o.advantage ? ` · advantage ${o.advantage}` : ''} · casualties BLUEFOR ${String(o.casualties.BLUEFOR)}, OPFOR ${String(o.casualties.OPFOR)} · effectiveness ${pct(o.effectiveness.BLUEFOR)} / ${pct(o.effectiveness.OPFOR)}</small>`;
  };

  const drawGraph = () => {
    const ratio = window.devicePixelRatio || 1;
    const w = graph.clientWidth;
    const h = graph.clientHeight;
    graph.width = Math.round(w * ratio);
    graph.height = Math.round(h * ratio);
    const g = graph.getContext('2d');
    if (!g) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    const samples: readonly FofSample[] = session.samples;
    const end = Math.max(60, session.headTick / session.spec.tickRateHz);
    const pad = { l: 30, r: 8, t: 14, b: 14 };
    const x = (s: number) => pad.l + ((w - pad.l - pad.r) * s) / end;
    const y = (v: number) => h - pad.b - (h - pad.t - pad.b) * Math.max(0, Math.min(1, v));
    g.strokeStyle = 'rgba(255,255,255,0.1)';
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      g.beginPath();
      g.moveTo(pad.l, y(v));
      g.lineTo(w - pad.r, y(v));
      g.stroke();
    }
    const series = (side: Side, pick: (s: FofSample) => number, dash: number[], alpha: number) => {
      g.strokeStyle = SIDE_COLOUR[side];
      g.globalAlpha = alpha;
      g.setLineDash(dash);
      g.lineWidth = 1.5;
      g.beginPath();
      samples.forEach((s, i) => {
        const px = x(s.seconds);
        const py = y(pick(s));
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    };
    for (const side of SIDES) {
      series(side, (s) => s.sides[side].effectiveness, [], 1);
      series(side, (s) => s.sides[side].suppression, [4, 3], 0.7);
      series(side, (s) => s.sides[side].confidence, [1, 3], 0.6);
    }
    g.strokeStyle = '#f2c230';
    const now = x(session.viewTick / session.spec.tickRateHz);
    g.beginPath();
    g.moveTo(now, pad.t);
    g.lineTo(now, h - pad.b);
    g.stroke();
    g.font = '11px system-ui, sans-serif';
    g.fillStyle = '#8a949e';
    g.fillText('100 %', 0, pad.t + 4);
    g.fillText('0', 18, h - pad.b);
    g.fillText(clock(end), w - 60, h - 2);
    const legend = [
      ['—', 'effectiveness'],
      ['- -', 'mean suppression'],
      ['···', 'highest detection confidence'],
    ];
    let lx = pad.l + 6;
    for (const [mark, label] of legend) {
      const t = `${mark ?? ''} ${label ?? ''}`;
      g.fillText(t, lx, 10);
      lx += g.measureText(t).width + 18;
    }
  };

  /** Geometric sight lines (observer information): from the selected soldier, or between the leaders. */
  const computeSight = () => {
    const state = session.view.sim.state;
    const setup = session.view.sim.world.fof;
    if (!overlays.sight || !setup) {
      sightLines = [];
      return;
    }
    const detection = {
      ...setup.config.detection,
      regardHalfAngleDeg: 180,
      centralHalfAngleDeg: 180,
    };
    const conditions = setup.config.visibility[setup.visibility];
    const from = selected
      ? state.soldiers.filter((s) => s.id === selected)
      : state.soldiers.filter((s) =>
          state.units.some((u) => u.leaderId === s.id && u.parentId === null),
        );
    const lines: SightLine[] = [];
    for (const o of from) {
      if (o.status !== 'active') continue;
      for (const t of state.soldiers) {
        if (t.side === o.side || t.status !== 'active') continue;
        const seen = sight(session.view.sim.world.terrain, o, t, detection, conditions);
        if (!seen) continue;
        lines.push({
          from: { x: o.position.x, y: o.position.y },
          to: { x: t.position.x, y: t.position.y },
          visible: seen.visibleFraction * seen.transmission,
        });
      }
    }
    sightLines = lines;
  };

  // --- frame loop -------------------------------------------------------------------------
  let disposed = false;
  let last = performance.now();
  let lastPanels = 0;
  /**
   * The tick drawn while playing: a clock that runs at the rate the head
   * really advances (at most the speed chosen), a little behind it, so that
   * motion is smooth however the ticks arrive (in batches from the worker, or
   * slower than asked for). Drawing only: the simulation never sees it.
   */
  let shown = 0;
  let headRate = 0;
  let lastHeadTick = 0;
  const updateShown = (dt: number) => {
    const head = session.headTick;
    const rate = session.spec.tickRateHz;
    if (!playing || session.scrubbed || head < lastHeadTick) {
      shown = session.viewTick;
      headRate = 0;
      lastHeadTick = head;
      return;
    }
    if (dt > 0) headRate += ((head - lastHeadTick) / dt - headRate) * Math.min(1, dt * 2);
    lastHeadTick = head;
    // About 150 ms of the head's progress behind it (at least a tick).
    const behind = Math.max(1, headRate * 0.15);
    const pace = Math.min(speed * rate, headRate);
    const next = shown + dt * pace + (head - behind - shown) * Math.min(1, dt * 3);
    shown = Math.min(head, Math.max(shown, next));
  };
  const dotSample = emptyMotionSample();
  const renderTick = () => (playing && !session.scrubbed ? shown : session.viewTick);
  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    size = { width: w, height: h };
    scene.resize(w, h);
    const ratio = window.devicePixelRatio || 1;
    overlay.width = Math.round(w * ratio);
    overlay.height = Math.round(h * ratio);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  /**
   * Whether the run is over (read afresh: stepping changes it): the
   * experiment has its outcome and the forces have finished carrying on.
   */
  const over = () => session.head.settled;
  const frame = (now: number) => {
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing && !over()) {
      // Play asks for time at the speed chosen; the head follows as fast as it
      // can (in the worker, without holding up the page), and play waits for it.
      const rate = session.spec.tickRateHz;
      const lead = Math.max(rate, 0.5 * speed * rate);
      wanted = Math.min(
        Math.max(wanted, session.viewTick) + dt * speed * rate,
        session.viewTick + lead,
      );
      session.advance(Math.floor(wanted));
    } else if (over() && !session.scrubbed) {
      // The experiment has an outcome and the forces have stopped: the run is over.
      playing = false;
    }
    updateShown(dt);
    const tick = renderTick();
    const rate = session.spec.tickRateHz;
    const state = session.view.sim.state;
    const terrain = session.view.sim.world.terrain;
    const units: UnitMarker[] = state.soldiers
      .filter((s) => visibleTo(s.id, s.side))
      .map((s) => ({
        id: s.id,
        affiliation: (perspective === 'observer' ? s.side === 'BLUEFOR' : s.side === perspective)
          ? 'friendly'
          : 'enemy',
        position: { x: s.position.x, y: s.position.y, z: s.position.z },
        azimuth: s.azimuth,
        posture: s.posture,
        status: s.status,
        selected: selected === s.id,
      }));
    if (characters.ready && !dots) {
      characters.update({
        units,
        clock: {
          log: session.motion,
          combatLog: session.combatLog,
          seconds: Math.max(0, tick) / rate,
        },
        weapons,
        surfaceAt: (x, y) => surfaceHeightAt(terrain, x, y),
        camera: scene.camera.camera,
        viewportHeightPx: size.height,
      });
    }
    output('loading').hidden = characters.ready || dots;
    showGround();
    scene.render();
    const ctx = overlay.getContext('2d');
    if (ctx) {
      const ratio = overlay.width / Math.max(size.width, 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const seconds = Math.max(0, tick) / rate;
      const recent: TimedEvent[] = [];
      for (let i = session.events.length - 1; i >= 0; i -= 1) {
        const e = session.events[i];
        if (!e) continue;
        if (e.seconds < seconds - 3) break;
        if (e.seconds <= seconds) recent.push(e);
      }
      const spec = session.spec;
      const markers = [
        { at: spec.blufor.start, label: 'BLUEFOR start', colour: SIDE_COLOUR.BLUEFOR },
        { at: spec.opfor.start, label: 'OPFOR start', colour: SIDE_COLOUR.OPFOR },
        ...(spec.blufor.destination
          ? [
              {
                at: spec.blufor.destination,
                label: 'BLUEFOR destination',
                colour: SIDE_COLOUR.BLUEFOR,
              },
            ]
          : []),
        ...(spec.opfor.destination
          ? [{ at: spec.opfor.destination, label: 'OPFOR destination', colour: SIDE_COLOUR.OPFOR }]
          : []),
      ].filter((m) => perspective === 'observer' || m.label.startsWith(perspective));
      const projection = groundProjection(scene.camera.camera, scene.groundAt, size, ELEVATION_M);
      if (dots) {
        // From the motion log at the tick drawn (interpolated), as the characters are.
        const sides = new Map(state.soldiers.map((x) => [x.id as string, x.side]));
        const log = session.motion;
        for (const u of units) {
          const at = positionAt(log, u.id, Math.max(0, tick));
          if (!at) continue;
          const p = projection.toScreen(at, 1);
          if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
          const side = sides.get(u.id) ?? 'BLUEFOR';
          const status = log.read(
            log.indexOf(u.id),
            Math.floor(Math.max(0, tick)),
            dotSample,
          ).status;
          ctx.fillStyle = status === 'active' ? SIDE_COLOUR[side] : '#6b7280';
          ctx.beginPath();
          ctx.arc(p.x, p.y, u.selected ? 5 : 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      drawFofOverlays({
        ctx,
        projection,
        state,
        log: session.motion,
        tick: Math.max(0, tick),
        seconds,
        halfLife: session.view.sim.world.fof?.config.detection.confidenceHalfLifeSeconds ?? 15,
        perspective,
        options: overlays,
        recent,
        sight: sightLines,
        selected,
        markers,
      });
      if (mode !== 'select') {
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(15,19,24,0.8)';
        ctx.fillRect(10, 10, 420, 24);
        ctx.fillStyle = '#f2c230';
        const who = mode.startsWith('blue') ? 'BLUEFOR' : 'OPFOR';
        ctx.fillText(
          mode.endsWith('start')
            ? `Click the ground: ${who} starts there (a new run) · Esc: cancel`
            : `Click the ground: ${who}'s destination${session.headTick > 0 ? ' (an order now)' : ''} · Esc: cancel`,
          18,
          27,
        );
      }
    }
    if (now - lastPanels > 250) {
      lastPanels = now;
      output('time').textContent =
        `T+ ${clock(session.view.sim.timeSeconds)}${session.scrubbed ? ` / ${clock(session.head.sim.timeSeconds)}` : ''} · tick ${String(session.viewTick)}`;
      q('[data-a="play"]').textContent = playing ? '❚❚ Pause' : '▶ Play';
      for (const m of ['blue-start', 'blue-dest', 'red-start', 'red-dest'] as const) {
        q(`[data-a="${m}"]`).classList.toggle('armed', mode === m);
      }
      output('perspective-label').textContent =
        perspective === 'observer'
          ? 'Observer: omniscient (true positions)'
          : `${perspective}'s picture: its own soldiers, and only the enemies it has confirmed (contacts at last known positions)`;
      timeline.max = String(session.headTick);
      if (document.activeElement !== timeline) timeline.value = String(session.viewTick);
      computeSight();
      renderForces();
      renderDetail();
      renderLog();
      renderMetrics();
      renderOutcome();
      drawGraph();
    }
    requestAnimationFrame(frame);
  };

  Object.defineProperty(canvas, 'ambushCapture', {
    configurable: true,
    value: () => {
      scene.render();
      return canvas.toDataURL('image/jpeg', 0.9);
    },
  });
  const hook = {
    get session() {
      return session;
    },
    get settings() {
      return settings;
    },
    get playing() {
      return playing;
    },
    play(on = true) {
      playing = on;
    },
    setSpeed(s: number) {
      speed = s;
    },
    setPerspective(p: Perspective) {
      perspective = p;
    },
    setOverlays(o: Partial<FofOverlayOptions>) {
      overlays = { ...overlays, ...o };
    },
    select(id: string | null) {
      selected = id;
    },
    runDemo: () => actions['demo']?.(),
    experiment(id: FofExperimentId, seed = settings.spec.seed) {
      settings = settingsFor(id, seed, settings.spec.tickRateHz);
      restart();
      lookAtStart();
    },
    /** Camera on `target` from `distance` m, `pitchDeg` up, from compass direction `azimuthDeg` (test hook). */
    view(target: { x: number; y: number }, distance: number, pitchDeg: number, azimuthDeg: number) {
      const t = new Vector3(target.x, ELEVATION_M, -target.y);
      const p = (pitchDeg * Math.PI) / 180;
      const a = (azimuthDeg * Math.PI) / 180;
      const pos = new Vector3(
        target.x + distance * Math.cos(p) * Math.sin(a),
        ELEVATION_M + distance * Math.sin(p),
        -target.y - distance * Math.cos(p) * Math.cos(a),
      );
      scene.camera.setPose(t, pos);
    },
    recordingJson: () => fofRecordingToJson(session.recording()),
    load(json: string) {
      const recording = fofRecordingFromJson(json);
      settings = { ...settings, spec: recording.spec };
      restart(recording);
    },
    characters: () => characters.stats(),
    /** The tick drawn now (fractional while playing). */
    renderTick: () => renderTick(),
  };
  (window as unknown as { ambushForceOnForceLab?: typeof hook }).ambushForceOnForceLab = hook;
  (root as HTMLElement & { ambushState?: () => unknown }).ambushState = () => ({
    stage: 'force-on-force',
    experiment: settings.experiment,
    tick: session.viewTick,
    headTick: session.headTick,
    metrics: session.metrics(),
  });

  refreshControls();
  restart();
  lookAtStart();
  requestAnimationFrame(frame);

  return () => {
    disposed = true;
    session.dispose();
    observer.disconnect();
    window.removeEventListener('keydown', onKey);
    characters.dispose();
    ground?.city.dispose();
    ground?.woods.dispose();
    scene.dispose();
    style.remove();
  };
}
