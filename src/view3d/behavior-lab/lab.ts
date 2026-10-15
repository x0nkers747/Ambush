import { resolveSlot, rosterTree, type RosterUnit } from '#exercise';
import {
  acceptanceFailures,
  buildFormationSpec,
  DEFAULT_FORMATION,
  formationsFor,
  formationTemplate,
  LAB_ORGANIZATIONS,
  LAB_SCENARIOS,
  runScenario,
  scenarioSpec,
  type LabMetrics,
  type LabOrganization,
  type LabRunSpec,
  type LabScenarioId,
} from '#exercise/behavior-lab';
import {
  nearestClearPoint,
  orgUnitId,
  soldierId,
  surfaceHeightAt,
  type AgentDiagnostics,
  type TaskDiagnostics,
} from '#sim';
import { Vector3 } from 'three';
import { createCharacterLayer } from '../characters/layer';
import { groundProjection, type MapPoint } from '../ground-projection';
import type { UnitMarker } from '../unit-markers';
import {
  bandColour,
  DEFAULT_OVERLAYS,
  drawOverlays,
  OVERLAY_LABELS,
  positionAt,
  STATE_TEXT,
  type OverlayOptions,
} from './overlays';
import { createCityLayer, type CityLayer } from './city';
import { createLabScene } from './scene';
import {
  createLabSession,
  recordingFromJson,
  recordingToJson,
  type LabRecording,
  type LabSession,
} from './session';
import { LAB_CSS } from './style';

// Ambush! Behavior Lab (docs/behavior-lab/04): a page for developing and
// judging unit behaviours on the real simulation, the real soldiers and the
// game's renderer settings. Reached at #behavior-lab; loaded only there.
//
// The page never changes the simulation itself: orders, disturbances and
// time all go through the session (commands and steps of the real kernel),
// and everything drawn is read from the simulation's state and diagnostics.

type Mode = 'select' | 'destination' | 'displace';

interface Settings {
  scenario: LabScenarioId | 'free';
  organization: LabOrganization;
  formation: string;
  interval: number;
  elementSpacing: number;
  pace: number;
  seed: number;
  tickRateHz: number;
  terrain: 'open' | 'urban';
}

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16] as const;
const RATES = [10, 20, 30, 60, 120] as const;
/** Lab terrain: flat, ±1200 m, 10 m up (the run's `labTerrain`). */
const HALF_M = 1200;
const ELEVATION_M = 10;

const ORGANIZATION_NAMES: Readonly<Record<LabOrganization, string>> = {
  element3: '3-Marine element',
  fireTeam: '4-Marine fire team',
  squad: '13-Marine squad',
};

const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
};

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

function specOf(settings: Settings): LabRunSpec {
  const options = {
    organization: settings.organization,
    formation: settings.formation,
    interval: settings.interval,
    elementSpacing: settings.elementSpacing,
    pace: settings.pace,
    seed: settings.seed,
    tickRateHz: settings.tickRateHz,
  };
  const terrain = { terrain: settings.terrain };
  if (settings.scenario === 'free') {
    return { ...scenarioSpec('s1-straight', options), waypoints: [], ...terrain };
  }
  return { ...scenarioSpec(settings.scenario, options), ...terrain };
}

/** Starts the lab in `root`; returns a function that stops it. */
export function startBehaviorLab(root: HTMLElement): () => void {
  const style = document.createElement('style');
  style.textContent = LAB_CSS;
  document.head.append(style);
  root.className = '';
  root.innerHTML = `
<div class="blab">
  <header>
    <h1>Ambush! Behavior Lab</h1>
    <div class="group">
      <button data-a="play" class="primary" title="Play / pause (Space)">▶ Play</button>
      <button data-a="step" title="One tick (.)">Step</button>
      <button data-a="reset" title="Start the run again (R)">Reset</button>
    </div>
    <div class="group speed">${SPEEDS.map((s) => `<button data-speed="${String(s)}">${s < 1 ? (s === 0.25 ? '¼' : '½') : String(s)}×</button>`).join('')}</div>
    <span class="time" data-o="time">T+ 00:00.0</span>
    <span class="grow"></span>
    <label>Ground <select data-i="ground" style="width:110px"><option value="urban">Urban district</option><option value="open">Open ground</option></select></label>
    <label>Seed <input data-i="seed" type="number" min="0" step="1" style="width:72px"></label>
    <label>Tick rate <select data-i="rate" style="width:84px">${RATES.map((r) => `<option value="${String(r)}">${String(r)} Hz</option>`).join('')}</select></label>
  </header>
  <aside class="left">
    <section>
      <h2>SCENARIO</h2>
      <select data-i="scenario">
        <option value="free">Free: click to order</option>
        ${LAB_SCENARIOS.map((s) => `<option value="${s.id}">${escape(s.name)}</option>`).join('')}
      </select>
      <p class="hint" data-o="scenario-hint"></p>
    </section>
    <section>
      <h2>ORGANIZATION</h2>
      <select data-i="organization">${(Object.keys(ORGANIZATION_NAMES) as LabOrganization[]).map((o) => `<option value="${o}">${ORGANIZATION_NAMES[o]}</option>`).join('')}</select>
      <label class="row">Formation <select data-i="formation"></select><span></span></label>
      <label class="row">Interval <input data-i="interval" type="range" min="3" max="20" step="1"><output data-o="interval"></output></label>
      <label class="row" data-o="spacing-row">Team spacing <input data-i="spacing" type="range" min="8" max="50" step="1"><output data-o="spacing"></output></label>
      <label class="row">Pace <input data-i="pace" type="range" min="0.6" max="2.2" step="0.05"><output data-o="pace"></output></label>
      <p class="hint">Changes start a new run.</p>
    </section>
    <section>
      <h2>ORDERS</h2>
      <div class="buttons">
        <button data-a="destination" title="Then click the ground (D)">Set destination</button>
        <button data-a="cancel">Halt</button>
      </div>
      <p class="hint">One order moves the whole organization: click a point on the ground. A new order while moving carries on without stopping.</p>
    </section>
    <section>
      <h2>OVERLAYS</h2>
      <div class="checks" data-o="overlays"></div>
    </section>
    <section>
      <h2>RECORDING</h2>
      <div class="buttons">
        <button data-a="replay" title="Re-simulate this run from the start, checking every second's state hash">Replay &amp; verify</button>
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
  </div>
  <aside class="right">
    <section>
      <h2>INSPECTOR</h2>
      <div class="tree" data-o="tree"></div>
    </section>
    <section data-o="detail"></section>
    <section>
      <h2>DISTURB</h2>
      <div class="buttons">
        <button data-a="hold" title="Keep the selected Marine where he stands">Hold</button>
        <button data-a="release" title="Release a hold, or call him back">Release</button>
        <button data-a="displace" title="Then click the ground: he walks there, then rejoins">Displace…</button>
      </div>
      <p class="hint">Disturbances are simulation commands: recorded and replayed like orders.</p>
    </section>
    <section>
      <h2>COMPARE</h2>
      <div class="buttons"><button data-a="sweep" title="Run this scenario and these settings over 10 seeds, headless">Sweep 10 seeds</button></div>
      <div data-o="runs"></div>
    </section>
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
    if (!el) throw new Error(`behavior lab: missing ${selector}`);
    return el;
  };
  const canvas = q('[data-o="canvas"]') as HTMLCanvasElement;
  const overlay = q('[data-o="overlay"]') as HTMLCanvasElement;
  const graph = q('[data-o="graph"]') as HTMLCanvasElement;
  const timeline = q('[data-i="timeline"]') as HTMLInputElement;

  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const settings: Settings = {
    scenario: (params.get('scenario') as Settings['scenario'] | null) ?? 's1-straight',
    organization: (params.get('org') as LabOrganization | null) ?? 'squad',
    formation: '',
    interval: 10,
    elementSpacing: 20,
    pace: 1.4,
    seed: Number(params.get('seed') ?? 1),
    tickRateHz: 30,
    terrain: params.get('ground') === 'open' ? 'open' : 'urban',
  };
  settings.formation = params.get('formation') ?? DEFAULT_FORMATION[settings.organization];
  let overlays: OverlayOptions = { ...DEFAULT_OVERLAYS };
  let session: LabSession = createLabSession(specOf(settings));
  let playing = false;
  let speed = 1;
  let pending = 0;
  let mode: Mode = 'select';
  let selected: { kind: 'soldier' | 'unit'; id: string } | null = null;
  let destination: MapPoint | null = null;
  const runs: { label: string; metrics: LabMetrics; accepted: string }[] = [];

  const scene = createLabScene(canvas, HALF_M, ELEVATION_M);
  const characters = createCharacterLayer(new URL('characters/', document.baseURI).href);
  scene.scene.add(characters.group);
  let city: { terrain: unknown; layer: CityLayer } | null = null;
  const showCity = () => {
    const terrain = session.view.sim.world.terrain;
    if (city?.terrain === terrain) return;
    if (city) {
      scene.scene.remove(city.layer.group);
      city.layer.dispose();
    }
    city = { terrain, layer: createCityLayer(terrain, ELEVATION_M) };
    scene.scene.add(city.layer.group);
  };
  scene.camera.setPose(new Vector3(0, ELEVATION_M, -60), new Vector3(70, ELEVATION_M + 70, 40));

  // --- the run ---------------------------------------------------------------
  const restart = (recording?: LabRecording) => {
    session = recording
      ? createLabSession(recording.spec, recording)
      : createLabSession(specOf(settings));
    pending = 0;
    destination = null;
    if (!recording) playing = settings.scenario !== 'free';
    refreshControls();
  };
  const unitId = () => session.head.unitId;
  const weapons = (): Record<string, string | null> => {
    const org = session.head.organization;
    const out: Record<string, string | null> = {};
    for (const m of org.members) {
      const slot = org.template.slots.find((s) => s.id === m.slotId);
      out[m.soldierId] = slot
        ? (resolveSlot(org.template, slot).loadout.weaponProfileRefs[0] ?? null)
        : null;
    }
    return out;
  };
  let weaponMap = weapons();

  /** The formation chosen in the controls, built for this run's organization and spacing. */
  const commandedFormation = () => {
    const org = session.head.organization;
    const root = org.template.units.find((u) => u.parentId === null)?.id ?? '';
    return buildFormationSpec(org, root, settings.formation, {
      interval: session.spec.interval,
      elementSpacing: session.spec.elementSpacing,
    });
  };
  const order = (point: MapPoint) => {
    session.submit({
      type: 'orderUnit',
      tick: 0,
      unitId: orgUnitId(unitId()),
      order: {
        kind: 'moveInFormation',
        destination: point,
        formation: commandedFormation(),
        pace: session.spec.pace,
      },
    });
    destination = point;
    playing = true;
  };
  const disturb = (
    disturbance: { kind: 'hold' } | { kind: 'goTo'; x: number; y: number } | null,
  ) => {
    if (selected?.kind !== 'soldier') return;
    session.submit({
      type: 'disturbAgent',
      tick: 0,
      soldierId: soldierId(selected.id),
      disturbance,
    });
  };

  // --- controls ----------------------------------------------------------------
  const input = (name: string) => q(`[data-i="${name}"]`) as HTMLInputElement;
  const output = (name: string) => q(`[data-o="${name}"]`);
  const refreshControls = () => {
    input('scenario').value = settings.scenario;
    input('organization').value = settings.organization;
    const members = LAB_ORGANIZATIONS[settings.organization].slots.length;
    const echelon =
      LAB_ORGANIZATIONS[settings.organization].units.find((u) => u.parentId === null)?.echelon ??
      '';
    const formations = formationsFor(echelon, members);
    input('formation').innerHTML = formations
      .map(
        (t) =>
          `<option value="${t.id}" title="${escape(t.doctrine)}">${escape(t.name)}${t.id.startsWith('army.') ? '' : ''}</option>`,
      )
      .join('');
    input('formation').value = settings.formation;
    input('interval').value = String(settings.interval);
    output('interval').textContent = `${String(settings.interval)} m`;
    input('spacing').value = String(settings.elementSpacing);
    output('spacing').textContent = `${String(settings.elementSpacing)} m`;
    output('spacing-row').hidden = settings.organization !== 'squad';
    input('pace').value = String(settings.pace);
    output('pace').textContent = `${settings.pace.toFixed(2)} m/s`;
    input('seed').value = String(settings.seed);
    input('ground').value = settings.terrain;
    input('rate').value = String(settings.tickRateHz);
    const scenario = LAB_SCENARIOS.find((s) => s.id === settings.scenario);
    output('scenario-hint').textContent = scenario
      ? scenario.description
      : 'Choose Set destination, then click the ground. The organization moves there in formation.';
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
      b.classList.toggle('on', Number(b.dataset['speed']) === speed);
    }
    weaponMap = weapons();
    selected = null;
    renderTree();
  };
  const changed = (apply: () => void) => {
    apply();
    restart();
  };
  input('scenario').addEventListener('change', (e) => {
    changed(() => {
      settings.scenario = (e.target as HTMLSelectElement).value as Settings['scenario'];
    });
  });
  input('organization').addEventListener('change', (e) => {
    changed(() => {
      settings.organization = (e.target as HTMLSelectElement).value as LabOrganization;
      settings.formation = DEFAULT_FORMATION[settings.organization];
    });
  });
  // A new formation is an order: once the unit has been ordered, it goes on
  // to the same destination in the new formation, without stopping, its
  // Marines making for their new slots on the move (at rest, it re-forms
  // where it stands). Before any order, the run starts again in it.
  input('formation').addEventListener('change', (e) => {
    const id = (e.target as HTMLSelectElement).value;
    const last = session.head.sim.state.behavior?.tasks.filter((t) => t.unitId === unitId()).at(-1);
    if (last?.outcome === 'cancelled') {
      // Halted: the next order uses it.
      settings.formation = id;
      return;
    }
    if (!last) {
      changed(() => {
        settings.formation = id;
      });
      return;
    }
    settings.formation = id;
    const formation = commandedFormation();
    session.submit({
      type: 'orderUnit',
      tick: 0,
      unitId: orgUnitId(unitId()),
      order: {
        kind: 'moveInFormation',
        destination: last.order.destination,
        formation,
        pace: last.order.pace ?? session.spec.pace,
        ...(last.order.finalFacing === undefined ? {} : { finalFacing: last.order.finalFacing }),
      },
    });
    playing = true;
  });
  for (const [name, key] of [
    ['interval', 'interval'],
    ['spacing', 'elementSpacing'],
    ['pace', 'pace'],
  ] as const) {
    input(name).addEventListener('input', (e) => {
      settings[key] = Number((e.target as HTMLInputElement).value);
      if (key === 'interval') settings.elementSpacing = 2 * settings.interval;
      output('interval').textContent = `${String(settings.interval)} m`;
      output('spacing').textContent = `${String(settings.elementSpacing)} m`;
      output('pace').textContent = `${settings.pace.toFixed(2)} m/s`;
    });
    input(name).addEventListener('change', () => {
      changed(() => undefined);
    });
  }
  input('seed').addEventListener('change', (e) => {
    changed(() => {
      settings.seed = Math.max(0, Math.floor(Number((e.target as HTMLInputElement).value) || 0));
    });
  });
  input('ground').addEventListener('change', (e) => {
    changed(() => {
      settings.terrain = (e.target as HTMLSelectElement).value === 'open' ? 'open' : 'urban';
    });
  });
  input('rate').addEventListener('change', (e) => {
    changed(() => {
      settings.tickRateHz = Number((e.target as HTMLSelectElement).value);
    });
  });
  for (const b of root.querySelectorAll<HTMLButtonElement>('[data-speed]')) {
    b.addEventListener('click', () => {
      speed = Number(b.dataset['speed']);
      refreshControls();
    });
  }
  const checks = output('overlays');
  checks.innerHTML = (Object.keys(OVERLAY_LABELS) as (keyof OverlayOptions)[])
    .map(
      (k) =>
        `<label><input type="checkbox" data-overlay="${k}" ${overlays[k] ? 'checked' : ''}> ${OVERLAY_LABELS[k]}</label>`,
    )
    .join('');
  for (const c of checks.querySelectorAll<HTMLInputElement>('[data-overlay]')) {
    c.addEventListener('change', () => {
      overlays = { ...overlays, [c.dataset['overlay'] ?? '']: c.checked };
    });
  }
  const actions: Record<string, () => void> = {
    play: () => {
      playing = !playing;
      pending = 0;
    },
    step: () => {
      playing = false;
      session.step();
    },
    reset: () => {
      restart();
    },
    destination: () => {
      mode = mode === 'destination' ? 'select' : 'destination';
    },
    cancel: () => {
      session.submit({ type: 'orderUnit', tick: 0, unitId: orgUnitId(unitId()), order: null });
    },
    hold: () => {
      disturb({ kind: 'hold' });
    },
    release: () => {
      disturb(null);
    },
    displace: () => {
      mode = mode === 'displace' ? 'select' : 'displace';
    },
    save: () => {
      const blob = new Blob([recordingToJson(session.recording())], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `behavior-lab-${settings.organization}-${String(settings.seed)}-t${String(Math.round(session.head.sim.timeSeconds))}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    load: () => {
      input('file').click();
    },
    replay: () => {
      const recording = session.recording();
      restart(recording);
      playing = true;
    },
    sweep: () => {
      void sweep();
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
        restart(recordingFromJson(text));
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
    else if (e.key === 'd' || e.key === 'D') actions['destination']?.();
    else if (e.key === 'Escape') mode = 'select';
  };
  window.addEventListener('keydown', onKey);

  // --- picking -------------------------------------------------------------------
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
    if (mode === 'destination' || mode === 'displace') {
      const point = projection.toWorld(screen);
      if (!point) return;
      // A click on a building or a car: the nearest point a soldier can stand on.
      const clear = nearestClearPoint(session.head.sim.world.terrain, point);
      if (!clear) return;
      if (mode === 'destination') order(clear);
      else disturb({ kind: 'goTo', x: clear.x, y: clear.y });
      if (mode === 'displace') destination = clear;
      mode = 'select';
      return;
    }
    // Select the nearest Marine on screen.
    let best: string | null = null;
    let bestD = 24;
    const tick = renderTick();
    for (const s of session.view.sim.state.soldiers) {
      const at = positionAt(session.motion, s.id, tick);
      if (!at) continue;
      const p = projection.toScreen(at, 1);
      const d = Math.hypot(p.x - screen.x, p.y - screen.y);
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    selected = best ? { kind: 'soldier', id: best } : null;
    renderTree();
  });

  // --- inspector -------------------------------------------------------------------
  const tree = output('tree');
  const renderTree = () => {
    const org = session.head.organization;
    const roster = rosterTree(org);
    const html: string[] = [];
    const walk = (u: RosterUnit, depth: number) => {
      const id = u.simUnitId;
      const sel = selected?.kind === 'unit' && selected.id === id ? ' sel' : '';
      html.push(
        `<div class="unit${sel}" data-unit="${id}" style="margin-left:${String(depth * 10)}px">${escape(u.unit.name)}</div>`,
      );
      for (const m of u.members) {
        const s = selected?.kind === 'soldier' && selected.id === m.soldierId ? ' sel' : '';
        html.push(
          `<div class="member${s}" data-soldier="${m.soldierId}" style="margin-left:${String(depth * 10)}px"><span class="dot" data-dot="${m.soldierId}"></span>${escape(m.slot.label)} <span class="muted">${escape(m.role.abbreviation)} · ${m.soldierId}${m.leads ? ' · leader' : ''}</span></div>`,
        );
      }
      for (const c of u.children) walk(c, depth + 1);
    };
    walk(roster, 0);
    tree.innerHTML = html.join('');
    for (const el of tree.querySelectorAll<HTMLElement>('[data-unit]')) {
      el.addEventListener('click', () => {
        selected = { kind: 'unit', id: el.dataset['unit'] ?? '' };
        renderTree();
      });
    }
    for (const el of tree.querySelectorAll<HTMLElement>('[data-soldier]')) {
      el.addEventListener('click', () => {
        selected = { kind: 'soldier', id: el.dataset['soldier'] ?? '' };
        renderTree();
      });
    }
  };

  /** One line of plain explanation of why the selected Marine moves as he does. */
  const why = (a: AgentDiagnostics, task: TaskDiagnostics | undefined): string => {
    const d = a.desire;
    const parts: string[] = [];
    if (a.override?.kind === 'hold')
      return 'Held by a disturbance: standing where he is until released.';
    if (a.override?.kind === 'goTo') {
      return `Sent away by a disturbance: walking to E ${a.override.x.toFixed(0)} N ${a.override.y.toFixed(0)}, then he rejoins his slot.`;
    }
    if (a.latched) return 'In position at the destination: stopped, facing the final direction.';
    if (d.state === 'detouring') {
      return `Going round an obstacle: the straight way to his slot (${d.error.toFixed(1)} m away) is blocked, so he follows a short path round it (purple), re-checked every half second.`;
    }
    if (d.state === 'fallingIn') {
      return `Falling in: the leader has stepped off and he is making for his slot (${d.error.toFixed(1)} m away) on the move, up to ${d.cap.toFixed(2)} m/s. The unit keeps an easier pace until everyone has fallen in.`;
    }
    parts.push(
      `His slot is ${d.error.toFixed(1)} m away (${d.along >= 0 ? `${d.along.toFixed(1)} m ahead of him` : `${(-d.along).toFixed(1)} m behind him`}, ${Math.abs(d.across).toFixed(1)} m to his ${d.across >= 0 ? 'right' : 'left'}).`,
    );
    if (d.state === 'onStation')
      parts.push(
        `Within the ${d.band.toFixed(1)} m dead band: he keeps his slot's pace and lets small errors fade.`,
      );
    if (d.state === 'catchingUp')
      parts.push(
        `Behind: he walks faster, up to ${d.cap.toFixed(2)} m/s (1.3 × pace), to close the gap.`,
      );
    if (d.state === 'easingOff')
      parts.push('Ahead of his slot: he eases off until it comes back to him.');
    if (d.state === 'correcting')
      parts.push("Off his slot sideways: he angles toward it at his slot's pace.");
    if (d.state === 'arriving')
      parts.push('Settling at the destination: slowing so he can stop in his slot.');
    if (d.turnFactor < 0.99)
      parts.push(
        `Turning first: facing away from where he means to go, so he goes at ${(d.turnFactor * 100).toFixed(0)} % speed until he faces it.`,
      );
    if (Math.hypot(a.separation.x, a.separation.y) > 0.01)
      parts.push('A comrade is within 1.2 m: easing apart.');
    if (a.straggling) parts.push('Out of contact for 10 s: the unit no longer waits for him.');
    if (a.stuck)
      parts.push('No progress for 10 s: marked stuck; the unit no longer waits for him.');
    if (task?.pace.worstLagId === a.soldierId && task.pace.limitedBy === 'cohesion') {
      parts.push('He is the furthest behind: the unit is slowing for him.');
    }
    return parts.join(' ');
  };

  const detail = output('detail');
  const renderDetail = () => {
    const diag = session.diagnostics;
    if (!selected) {
      detail.innerHTML =
        '<p class="hint">Click a Marine (or a unit in the tree) to inspect him.</p>';
      return;
    }
    if (selected.kind === 'soldier') {
      const id = selected.id;
      const soldier = session.view.sim.state.soldiers.find((s) => s.id === id);
      const a = diag.agents.find((x) => x.soldierId === id);
      const task = a ? diag.tasks.find((t) => t.taskId === a.taskId) : undefined;
      const member = session.head.organization.members.find((m) => m.soldierId === id);
      const slot = session.head.organization.template.slots.find((s) => s.id === member?.slotId);
      const unit = session.head.organization.template.units.find((u) => u.id === slot?.unitId);
      const heading = soldier
        ? (Math.round((soldier.azimuth * 180) / Math.PI) % 360).toFixed(0)
        : '–';
      detail.innerHTML = `<h2>MARINE ${escape(id)}</h2><dl>
        <dt>Organization</dt><dd>${escape(unit?.name ?? '–')}</dd>
        <dt>Role / slot</dt><dd>${escape(slot?.label ?? '–')} · ${escape(a?.slotId ?? 'not steered')}</dd>
        <dt>Task · phase</dt><dd>${escape(a?.taskId ?? '–')} · ${escape(task?.phase ?? '–')}</dd>
        <dt>Speed</dt><dd>${a ? a.speed.toFixed(2) : '–'} m/s</dd>
        <dt>Wanted speed</dt><dd>${a ? a.wantedSpeed.toFixed(2) : '–'} m/s</dd>
        <dt>Position error</dt><dd>${a ? `${a.desire.error.toFixed(2)} m (along ${a.desire.along.toFixed(2)}, across ${a.desire.across.toFixed(2)})` : '–'}</dd>
        <dt>Heading</dt><dd>${heading}°</dd>
        <dt>State</dt><dd>${a ? `<span style="color:${bandColour(a, session.spec.interval)}">${STATE_TEXT[a.desire.state]}</span>${a.straggling ? ' · straggling' : ''}${a.stuck ? ' · stuck' : ''}` : 'standing (no task)'}</dd>
      </dl>${a ? `<div class="why">${escape(why(a, task))}</div>` : ''}`;
      return;
    }
    const task =
      diag.tasks.find((t) => t.unitId === selected?.id && t.outcome === null) ??
      diag.tasks.filter((t) => t.unitId === selected?.id).at(-1);
    if (!task) {
      const parentTask = diag.tasks.find((t) => t.outcome === null);
      detail.innerHTML = `<h2>UNIT ${escape(selected.id)}</h2><p class="hint">No task of its own: its Marines hold their slots in ${escape(parentTask ? `the ${parentTask.unitId} formation` : 'no formation')} (subordinate elements are nested positions of the ordered unit's formation).</p>`;
      return;
    }
    const p = task.pace;
    detail.innerHTML = `<h2>UNIT ${escape(task.unitId)} · TASK ${escape(task.taskId)}</h2><dl>
      <dt>Phase</dt><dd>${task.phase}${task.outcome ? ` (${task.outcome})` : ''}</dd>
      <dt>Formation</dt><dd>${escape(formationTemplate(settings.formation).name)} · d ${String(session.spec.interval)} m</dd>
      <dt>Anchor</dt><dd>${task.anchorS.toFixed(1)} / ${task.routeLength.toFixed(1)} m · ${task.anchorSpeed.toFixed(2)} m/s</dd>
      <dt>Pace law</dt><dd>wants ${p.want.toFixed(2)} m/s, limited by ${p.limitedBy}</dd>
      <dt>Worst lag</dt><dd>${p.worstLag.toFixed(2)} m ${p.worstLagId ? `(${escape(p.worstLagId)})` : ''}</dd>
      <dt>In position</dt><dd>${String(p.latched)} / ${String(p.members)}</dd>
    </dl><div class="why">${escape(
      p.limitedBy === 'joining'
        ? `The leader has stepped off at an easier pace while ${String(p.joining)} Marine(s) fall in on the move.`
        : p.limitedBy === 'cohesion'
          ? `Slowing to ${(p.keep * 100).toFixed(0)} % of pace: ${p.worstLagId ?? 'a Marine'} is ${p.worstLag.toFixed(1)} m behind his slot.`
          : p.limitedBy === 'bend'
            ? 'Slowing for a bend, so the outermost Marine need not run.'
            : p.limitedBy === 'arrival'
              ? 'Braking to stop at the destination.'
              : 'At the commanded pace: every Marine is near his slot.',
    )}</div>`;
  };

  // --- metrics, graphs, comparison ---------------------------------------------------
  const metricsEl = output('metrics');
  const renderMetrics = () => {
    const m = session.metrics();
    const cpu = session.cpu();
    const v = session.verification;
    const verify = output('verify');
    verify.className = `hint verify ${v ? (v.mismatches === 0 ? 'ok' : 'bad') : ''}`;
    verify.textContent = v
      ? v.mismatches === 0
        ? `Replay matches the recording: ${String(v.checked)} s checked, every state hash equal.`
        : `Replay differs from the recording from T+${String(v.firstMismatch)} s (${String(v.mismatches)} of ${String(v.checked)} s).`
      : 'Every run is recorded: save it, load it back, or replay it to check it reproduces exactly.';
    const row = (k: string, val: string) => `<tr><td>${k}</td><td class="n">${val}</td></tr>`;
    metricsEl.innerHTML = `<table>
      ${row('Mean / max formation error', `${m.meanError.toFixed(2)} / ${m.maxError.toFixed(2)} m`)}
      ${row('Cohesion (spread ÷ designed)', `${m.cohesionMean.toFixed(2)} (worst ${m.cohesionWorst.toFixed(2)})`)}
      ${row('Fastest Marine', `${m.maxSpeed.toFixed(2)} m/s (${m.maxSpeedRatio.toFixed(2)} × pace)`)}
      ${row('Anchor speed min / mean', `${m.anchorMinSpeed.toFixed(2)} / ${m.anchorMeanSpeed.toFixed(2)} m/s`)}
      ${row('Catch-up / reversals', `${m.catchUpSeconds.toFixed(0)} Marine-s · ${m.reversalsPerMinute.toFixed(2)}/min`)}
      ${row('Sideways speed max', `${m.maxSlip.toFixed(2)} m/s`)}
      ${row('Completion', m.completionSeconds === null ? '–' : `${m.completionSeconds.toFixed(1)} s (${String(m.outcome)})`)}
      ${row('Collisions · stuck · straggling', `${String(m.collisions)} · ${String(m.stuck)} · ${String(m.straggling)}`)}
      ${row('Simulation CPU per tick', `${cpu.mean.toFixed(3)} ms (p95 ${cpu.p95.toFixed(3)})`)}
    </table>`;
  };
  const renderRuns = () => {
    output('runs').innerHTML =
      runs.length === 0
        ? '<p class="hint">Completed runs and sweeps are listed here, to compare settings.</p>'
        : `<table><tr><th>Run</th><th class="n">Err</th><th class="n">Max</th><th class="n">Done</th><th>Accepted</th></tr>${runs
            .map(
              (r) =>
                `<tr><td>${escape(r.label)}</td><td class="n">${r.metrics.steadyMeanError.toFixed(2)}</td><td class="n">${r.metrics.steadyMaxError.toFixed(1)}</td><td class="n">${r.metrics.completionSeconds?.toFixed(0) ?? '–'}</td><td>${escape(r.accepted)}</td></tr>`,
            )
            .join('')}</table>`;
  };
  const label = () =>
    `${settings.scenario === 'free' ? 'free' : settings.scenario.slice(0, 2)} ${ORGANIZATION_NAMES[settings.organization].split(' ')[0] ?? ''} ${formationTemplate(settings.formation).name.toLowerCase()} d${String(settings.interval)} ${settings.pace.toFixed(1)} m/s s${String(settings.seed)}`;
  let recorded = false;
  const noteCompletion = () => {
    const m = session.metrics();
    if (recorded || m.outcome === null || session.scrubbed) return;
    recorded = true;
    const failures =
      settings.scenario === 'free' ? [] : acceptanceFailures(settings.scenario, session.spec, m);
    runs.unshift({
      label: label(),
      metrics: m,
      accepted:
        settings.scenario === 'free' ? '–' : failures.length === 0 ? 'yes' : failures.join('; '),
    });
    renderRuns();
  };
  const sweep = async () => {
    if (settings.scenario === 'free') {
      runs.unshift({ label: 'sweep needs a scenario', metrics: session.metrics(), accepted: '–' });
      renderRuns();
      return;
    }
    const all: LabMetrics[] = [];
    let accepted = 0;
    for (let seed = 1; seed <= 10; seed += 1) {
      await new Promise((r) => setTimeout(r, 0));
      const spec = specOf({ ...settings, seed });
      const { metrics } = runScenario(spec);
      all.push(metrics);
      if (acceptanceFailures(settings.scenario, spec, metrics).length === 0) accepted += 1;
    }
    const mean = (f: (m: LabMetrics) => number) => all.reduce((s, m) => s + f(m), 0) / all.length;
    const worst = (f: (m: LabMetrics) => number) => Math.max(...all.map(f));
    runs.unshift({
      label: `${label().replace(/ s\d+$/, '')} × 10 seeds`,
      metrics: {
        ...all[0],
        steadyMeanError: mean((m) => m.steadyMeanError),
        steadyMaxError: worst((m) => m.steadyMaxError),
        completionSeconds: mean((m) => m.completionSeconds ?? 0),
      } as LabMetrics,
      accepted: `${String(accepted)}/10`,
    });
    renderRuns();
  };

  const drawGraph = () => {
    const ratio = window.devicePixelRatio || 1;
    const w = graph.clientWidth;
    const h = graph.clientHeight;
    if (graph.width !== Math.round(w * ratio)) graph.width = Math.round(w * ratio);
    if (graph.height !== Math.round(h * ratio)) graph.height = Math.round(h * ratio);
    const g = graph.getContext('2d');
    if (!g) return;
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    const samples = session.samples;
    const end = Math.max(10, session.head.sim.timeSeconds);
    const pad = { l: 34, r: 34, t: 14, b: 14 };
    const x = (t: number) => pad.l + (t / end) * (w - pad.l - pad.r);
    const maxError = Math.max(2, ...samples.map((s) => s.maxError));
    const yE = (v: number) => h - pad.b - (v / maxError) * (h - pad.t - pad.b);
    const maxSpeed = Math.max(2, session.spec.pace * 1.4);
    const yS = (v: number) => h - pad.b - (v / maxSpeed) * (h - pad.t - pad.b);
    g.strokeStyle = '#2c3238';
    g.lineWidth = 1;
    g.strokeRect(pad.l, pad.t, w - pad.l - pad.r, h - pad.t - pad.b);
    // Speed band of the Marines.
    g.fillStyle = 'rgba(138,148,158,0.18)';
    g.beginPath();
    samples.forEach((s, i) => {
      const top = yS(Math.max(0, ...s.speeds));
      if (i === 0) g.moveTo(x(s.t), top);
      else g.lineTo(x(s.t), top);
    });
    for (let i = samples.length - 1; i >= 0; i -= 1) {
      const s = samples[i];
      if (s) g.lineTo(x(s.t), yS(s.speeds.length > 0 ? Math.min(...s.speeds) : 0));
    }
    g.closePath();
    g.fill();
    const series = (
      pick: (s: (typeof samples)[number]) => number,
      y: (v: number) => number,
      colour: string,
    ) => {
      g.strokeStyle = colour;
      g.lineWidth = 1.5;
      g.beginPath();
      samples.forEach((s, i) => {
        if (i === 0) g.moveTo(x(s.t), y(pick(s)));
        else g.lineTo(x(s.t), y(pick(s)));
      });
      g.stroke();
    };
    series((s) => s.maxError, yE, '#ff9a3c');
    series((s) => s.meanError, yE, '#6fdc8c');
    series((s) => s.worstLag, yE, '#f2d24a');
    series((s) => s.anchorSpeed, yS, '#78beff');
    // The tick shown.
    const now = session.view.sim.timeSeconds;
    g.strokeStyle = '#f2c230';
    g.beginPath();
    g.moveTo(x(now), pad.t);
    g.lineTo(x(now), h - pad.b);
    g.stroke();
    g.font = '11px system-ui, sans-serif';
    g.fillStyle = '#8a949e';
    g.fillText(`${maxError.toFixed(1)} m`, 2, pad.t + 8);
    g.fillText(`${maxSpeed.toFixed(1)} m/s`, w - pad.r + 2, pad.t + 8);
    const legend = [
      ['#6fdc8c', 'mean error'],
      ['#ff9a3c', 'max error'],
      ['#f2d24a', 'worst lag'],
      ['#78beff', 'anchor speed'],
      ['rgba(138,148,158,0.8)', "Marines' speeds"],
    ] as const;
    let lx = pad.l + 6;
    for (const [c, t] of legend) {
      g.fillStyle = c;
      g.fillRect(lx, 3, 10, 3);
      g.fillStyle = '#8a949e';
      g.fillText(t, lx + 14, 9);
      lx += g.measureText(t).width + 30;
    }
  };

  // --- frame loop -------------------------------------------------------------------
  let disposed = false;
  let last = performance.now();
  let lastPanels = 0;
  const renderTick = () => {
    const alpha = playing && !session.scrubbed ? Math.min(1, pending) : 1;
    return session.viewTick - 1 + alpha;
  };
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

  const frame = (now: number) => {
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (playing) {
      pending += dt * speed * session.spec.tickRateHz;
      const budget = Math.max(1, Math.ceil(0.1 * speed * session.spec.tickRateHz));
      let stepped = 0;
      while (pending >= 1 && stepped < budget) {
        session.step();
        pending -= 1;
        stepped += 1;
      }
      if (pending >= 1) pending = pending % 1;
      noteCompletion();
    }
    const tick = renderTick();
    const rate = session.spec.tickRateHz;
    const state = session.view.sim.state;
    const terrain = session.view.sim.world.terrain;
    const units: UnitMarker[] = state.soldiers.map((s) => ({
      id: s.id,
      affiliation: 'friendly',
      position: { x: s.position.x, y: s.position.y, z: s.position.z },
      azimuth: s.azimuth,
      posture: s.posture,
      status: s.status,
      selected: selected?.kind === 'soldier' && selected.id === s.id,
    }));
    if (characters.ready) {
      characters.update({
        units,
        clock: { log: session.motion, combatLog: [], seconds: Math.max(0, tick) / rate },
        weapons: weaponMap,
        surfaceAt: (x, y) => surfaceHeightAt(terrain, x, y),
        camera: scene.camera.camera,
        viewportHeightPx: size.height,
      });
    }
    output('loading').hidden = characters.ready;
    showCity();
    scene.render();
    const ctx = overlay.getContext('2d');
    if (ctx) {
      const ratio = overlay.width / Math.max(size.width, 1);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const selectedIds = new Set<string>();
      if (selected?.kind === 'soldier') selectedIds.add(selected.id);
      drawOverlays({
        ctx,
        projection: groundProjection(scene.camera.camera, scene.groundAt, size, ELEVATION_M),
        state,
        diagnostics: session.diagnostics,
        previous: session.previousDiagnostics,
        alpha: tick - (session.viewTick - 1),
        log: session.motion,
        tick: Math.max(0, tick),
        selected: selectedIds,
        options: overlays,
        destination,
      });
      if (mode !== 'select') {
        ctx.font = '600 13px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(15,19,24,0.8)';
        ctx.fillRect(10, 10, 360, 24);
        ctx.fillStyle = '#f2c230';
        ctx.fillText(
          mode === 'destination'
            ? 'Click the ground: the whole organization moves there (Esc: cancel)'
            : 'Click the ground: the selected Marine walks there, then rejoins',
          18,
          27,
        );
      }
    }
    if (now - lastPanels > 200) {
      lastPanels = now;
      output('time').textContent =
        `T+ ${clock(session.view.sim.timeSeconds)}${session.scrubbed ? ` / ${clock(session.head.sim.timeSeconds)}` : ''} · tick ${String(session.viewTick)}`;
      q('[data-a="play"]').textContent = playing ? '❚❚ Pause' : '▶ Play';
      q('[data-a="destination"]').classList.toggle('armed', mode === 'destination');
      q('[data-a="displace"]').classList.toggle('armed', mode === 'displace');
      timeline.max = String(session.headTick);
      if (document.activeElement !== timeline) timeline.value = String(session.viewTick);
      for (const a of session.diagnostics.agents) {
        const dot = tree.querySelector<HTMLElement>(`[data-dot="${a.soldierId}"]`);
        if (dot) dot.style.background = bandColour(a, session.spec.interval);
      }
      renderDetail();
      renderMetrics();
      drawGraph();
    }
    requestAnimationFrame(frame);
  };

  // Hooks for checks and the Feedback button (screenshots).
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
    settings,
    get playing() {
      return playing;
    },
    play(on = true) {
      playing = on;
    },
    setSpeed(s: number) {
      speed = s;
    },
    select(kind: 'soldier' | 'unit', id: string) {
      selected = { kind, id };
      renderTree();
    },
    order,
    disturb,
    /** Camera on `target` from `distance` m, `pitchDeg` up, from compass direction `azimuthDeg` (test hook). */
    view(target: { x: number; y: number }, distance: number, pitchDeg: number, azimuthDeg: number) {
      const t = scene.camera.pose().target.clone().set(target.x, ELEVATION_M, -target.y);
      const p = (pitchDeg * Math.PI) / 180;
      const a = (azimuthDeg * Math.PI) / 180;
      const pos = t
        .clone()
        .set(
          target.x + distance * Math.cos(p) * Math.sin(a),
          ELEVATION_M + distance * Math.sin(p),
          -target.y - distance * Math.cos(p) * Math.cos(a),
        );
      scene.camera.setPose(t, pos);
    },
    project(x: number, y: number, lift = 0) {
      return groundProjection(scene.camera.camera, scene.groundAt, size, ELEVATION_M).toScreen(
        { x, y },
        lift,
      );
    },
    /** The current run's recording as saved (JSON text). */
    recordingJson: () => recordingToJson(session.recording()),
    characters: () => characters.stats(),
    positions: () => characters.positions(),
    restart: (s: Partial<Settings>) => {
      Object.assign(settings, s);
      restart();
    },
  };
  (window as unknown as { ambushBehaviorLab?: typeof hook }).ambushBehaviorLab = hook;
  (root as HTMLElement & { ambushState?: () => unknown }).ambushState = () => ({
    stage: 'behavior-lab',
    settings: { ...settings },
    tick: session.viewTick,
    headTick: session.headTick,
    metrics: session.metrics(),
  });

  refreshControls();
  renderRuns();
  restart();
  requestAnimationFrame(frame);

  return () => {
    disposed = true;
    observer.disconnect();
    window.removeEventListener('keydown', onKey);
    characters.dispose();
    city?.layer.dispose();
    scene.dispose();
    style.remove();
  };
}
