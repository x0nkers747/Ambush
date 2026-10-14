/**
 * The comparison page: one shared scene, the same soldiers, clips, weapon,
 * lighting, camera and simulated movement for every animation runtime.
 */

import * as THREE from 'three';
import { type AssetSet, type CharacterId, loadAssets } from './assets';
import { runBenchmark, type BenchConfig } from './bench';
import {
  createSoldier,
  enableCcd,
  type IkMode,
  placeSoldier,
  postProcess,
  type PostOptions,
  type SoldierView,
} from './character';
import { CHECK_TIMES, type Harness, type PassResult, runDeterminism } from './determinism';
import { createForest, type Forest } from './forest';
import { type PoseInput, poseInputAt } from './pose-input';
import { CLIP_SLOTS } from './rigs';
import { animouseRuntime } from './runtimes/animouse';
import { nativeRuntime, upperBodySettings } from './runtimes/native';
import type { Animator, Runtime, RuntimeId } from './runtimes/types';
import { createStage, type GroundKind } from './scene';
import {
  DT,
  type Intent,
  MiniSim,
  recordTestSequence,
  type SimFrame,
  TEST_SEQUENCE_SECONDS,
  TICK_HZ,
  wrap,
} from './sim';
import { saveScreenshot, screenshotName } from './screenshot';
import { makeRifle, makeSawPlaceholder, type WeaponInstance } from './weapons';

const RUNTIMES: Record<RuntimeId, Runtime> = { native: nativeRuntime, animouse: animouseRuntime };
type RuntimeChoice = RuntimeId | 'both';
type WeaponChoice = 'm16' | 'm249' | 'ak' | 'none';

const $ = (id: string): HTMLElement => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e;
};
const canvas = $('c') as HTMLCanvasElement;
const plan = $('plan') as HTMLCanvasElement;
const tags = $('tags') as HTMLDivElement;
const loading = $('loading') as HTMLDivElement;
const stage = createStage(canvas);
const params = new URLSearchParams(location.search);

const state = {
  runtime: (params.get('runtime') as RuntimeChoice | null) ?? 'both',
  character: (params.get('character') as CharacterId | null) ?? 'rocketbox',
  weapon: (params.get('weapon') as WeaponChoice | null) ?? 'm16',
  mode: 'sequence' as 'sequence' | 'live',
  playing: !params.has('paused'),
  rate: 1,
  time: 0,
  crowd: 1,
  ik: 'two-bone' as IkMode,
  footIk: true,
  spineAim: true,
  weaponHold: true,
  skeleton: false,
  shadows: true,
  ground: 'flat' as GroundKind,
  forest: false,
  follow: true,
  view: '3d' as '3d' | '2d',
  review: false,
};

/** The URL settings beyond runtime, character and weapon (see `shareUrl`). */
function readParams(): void {
  const flag = (k: string, d: boolean) => (params.has(k) ? params.get(k) !== '0' : d);
  const num = (k: string, d: number) => {
    const v = Number(params.get(k));
    return params.has(k) && Number.isFinite(v) ? v : d;
  };
  state.ik = (params.get('ik') as IkMode | null) ?? state.ik;
  state.crowd = Math.max(1, Math.min(100, Math.round(num('crowd', state.crowd))));
  state.rate = num('rate', state.rate);
  state.time = num('t', state.time);
  state.footIk = flag('footIk', state.footIk);
  state.spineAim = flag('spineAim', state.spineAim);
  state.weaponHold = flag('weaponHold', state.weaponHold);
  state.skeleton = flag('skeleton', state.skeleton);
  state.shadows = flag('shadows', state.shadows);
  state.forest = flag('forest', state.forest);
  state.follow = flag('follow', state.follow);
  state.ground = (params.get('ground') as GroundKind | null) ?? state.ground;
  const upper = params.get('upper');
  if (upper === 'idle' || upper === 'kaykit') upperBodySettings.source = upper;
}
readParams();

interface Live {
  readonly sim: MiniSim;
  speed: number;
  rel: number; // travel direction relative to facing (rad)
  facing: number; // absolute facing (rad)
  faceTravel: boolean;
}

interface Placed {
  readonly view: SoldierView;
  readonly animator: Animator;
  readonly runtime: Runtime;
  readonly timeOffset: number;
  readonly dx: number;
  readonly dy: number;
  readonly helper: THREE.SkeletonHelper;
  readonly tag: HTMLDivElement | null;
}

let sequenceFrames: SimFrame[] = recordTestSequence();
let live: Live | null = null;
let soldiers: Placed[] = [];
let forest: Forest | null = null;
let lastInput: PoseInput | null = null;
let determinismResults: Record<string, PassResult[]> = {};
let lastUpdateTime = 0;
let pendingSeek = true;

const frames = (): readonly SimFrame[] =>
  state.mode === 'live' && live ? live.sim.frames : sequenceFrames;
const duration = () =>
  state.mode === 'live' && live ? live.sim.seconds : (sequenceFrames.length - 1) / TICK_HZ;

function makeWeapon(choice: WeaponChoice): WeaponInstance | null {
  if (choice === 'none') return null;
  if (choice === 'm249') return makeSawPlaceholder();
  if (choice === 'ak') {
    const w = makeRifle(assets.ak);
    return {
      ...w,
      profile: {
        ...w.profile,
        label: 'AK (Quaternius via Mesh2Motion, CC0), scaled to 0.9 m',
        placeholder: false,
      },
    };
  }
  return makeRifle(assets.rifle);
}

function runtimesFor(choice: RuntimeChoice): Runtime[] {
  return choice === 'both' ? [nativeRuntime, animouseRuntime] : [RUNTIMES[choice]];
}

function rebuild(): void {
  for (const s of soldiers) {
    s.animator.dispose();
    stage.scene.remove(s.view.root, s.helper);
    if (s.view.weapon) stage.scene.remove(s.view.weapon.object);
    s.tag?.remove();
  }
  soldiers = [];
  const asset = assets.characters[state.character] ?? assets.characters.rocketbox;
  const rts = runtimesFor(state.runtime);
  const n = state.crowd;
  const cols = Math.ceil(Math.sqrt(n));
  rts.forEach((rt, ri) => {
    for (let i = 0; i < n; i++) {
      const view = createSoldier(asset);
      view.weapon = makeWeapon(state.weapon);
      if (state.ik === 'ccd') enableCcd(view);
      const side = rts.length > 1 ? (ri === 0 ? -1 : 1) : 0;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const dx =
        side * 0.9 * (n > 1 ? 1 + cols * 1.4 : 1) + (n > 1 ? (col - (cols - 1) / 2) * 1.6 : 0);
      const dy = n > 1 ? -row * 1.8 : 0;
      const helper = new THREE.SkeletonHelper(view.root);
      helper.visible = state.skeleton;
      stage.scene.add(view.root, helper);
      if (view.weapon) stage.scene.add(view.weapon.object);
      let tag: HTMLDivElement | null = null;
      if (i === 0 && rts.length > 1) {
        tag = document.createElement('div');
        tag.className = 'tag';
        tag.textContent = rt.id === 'native' ? 'A · three.js native' : 'B · animouse';
        tags.append(tag);
      }
      soldiers.push({
        view,
        animator: createAnimator(rt, view),
        runtime: rt,
        timeOffset: state.mode === 'sequence' && n > 1 ? (i * 1.37) % 8 : 0,
        dx,
        dy,
        helper,
        tag,
      });
    }
  });
  pendingSeek = true;
  buildInfoStatic();
}

/**
 * The runtime's animator, or the native one with a notice when the runtime
 * cannot be built for this character (animouse needs clips some characters
 * lack); the reason is shown in the animation-state panel.
 */
function createAnimator(rt: Runtime, view: SoldierView): Animator {
  try {
    return rt.create(view, frames());
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    const fallback = nativeRuntime.create(view, frames());
    return {
      update: (input, ctx) => {
        fallback.update(input, ctx);
      },
      describe: () => `NOT AVAILABLE for this character (${reason}); showing runtime A instead.`,
      reset: (f) => {
        fallback.reset(f);
      },
      dispose: () => {
        fallback.dispose();
      },
    };
  }
}

const postOptions = (): PostOptions => ({
  ik: state.ik,
  footIk: state.footIk,
  weaponHold: state.weaponHold,
  spineAim: state.spineAim,
});

function poseSoldier(s: Placed, t: number, dt: number, seeked: boolean): PoseInput {
  const f = frames();
  const tt = Math.max(0, t - s.timeOffset);
  const base = poseInputAt(f, tt);
  const input: PoseInput = { ...base, x: base.x + s.dx, y: base.y + s.dy };
  placeSoldier(s.view, input, stage.heightAt(input.x, input.y));
  s.animator.update(input, { dt, seeked, frames: f });
  postProcess(s.view, input, postOptions(), stage.heightAt, stage.ground === 'flat');
  return input;
}

// ---------------------------------------------------------------- live control

function startLive(): void {
  live ??= { sim: new MiniSim(), speed: 0, rel: 0, facing: 0, faceTravel: true };
  if (state.mode !== 'live') {
    state.mode = 'live';
    state.review = false;
    rebuild();
  }
  state.playing = true;
}

function command(set: Partial<Intent>): void {
  startLive();
  live?.sim.command(set);
}

function applyMove(): void {
  if (!live) return;
  const heading = wrap(live.facing + live.rel);
  command({ speed: live.speed, heading, face: live.faceTravel ? 'travel' : live.facing });
}

function preset(name: string): void {
  startLive();
  const L = live;
  if (!L) return;
  const deg = (d: number) => (d * Math.PI) / 180;
  const cur = L.sim.frames[L.sim.frames.length - 1]?.s.azimuth ?? 0;
  const move = (speed: number, rel: number, faceTravel: boolean) => {
    L.speed = speed;
    L.rel = deg(rel);
    L.faceTravel = faceTravel;
    if (!faceTravel) L.facing = cur;
    applyMove();
  };
  switch (name) {
    case 'Idle':
      move(0, 0, true);
      command({ posture: 'standing', carry: 'lowered', fireInterval: 0 });
      break;
    case 'Slow walk':
      move(0.9, 0, true);
      break;
    case 'Walk':
      move(1.5, 0, true);
      break;
    case 'Run':
      move(3.4, 0, true);
      break;
    case 'Sprint':
      move(5.6, 0, true);
      break;
    case 'Back':
      move(1.1, 180, false);
      break;
    case 'Strafe L':
      move(1.1, -90, false);
      break;
    case 'Strafe R':
      move(1.1, 90, false);
      break;
    case 'Diagonal':
      move(1.4, 45, false);
      break;
    case 'Stop':
      move(0, 0, L.faceTravel);
      break;
    case 'Turn 90°':
      L.facing = wrap(cur + deg(90));
      L.faceTravel = false;
      applyMove();
      break;
    case 'Stand':
      command({ posture: 'standing' });
      break;
    case 'Kneel':
      command({ posture: 'kneeling' });
      break;
    case 'Prone':
      command({ posture: 'prone' });
      break;
    case 'Crawl':
      command({ posture: 'prone' });
      move(0.35, 0, true);
      break;
    case 'Aim':
      command({ carry: 'aimed' });
      break;
    case 'Ready':
      command({ carry: 'ready', fireInterval: 0 });
      break;
    case 'Lower':
      command({ carry: 'lowered', fireInterval: 0 });
      break;
    case 'Fire':
      command({ carry: 'aimed', fireInterval: state.weapon === 'm249' ? 0.09 : 0.5 });
      break;
    case 'Cease fire':
      command({ fireInterval: 0 });
      break;
    case 'Reload':
      command({ reload: true });
      setTimeout(() => {
        command({ reload: false });
      }, 100);
      break;
    case 'Incapacitate':
      command({ down: true });
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------- UI

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

function selectRow(
  label: string,
  options: [string, string][],
  value: string,
  on: (v: string) => void,
) {
  const s = el('select');
  for (const [v, t] of options) s.add(new Option(t, v));
  s.value = value;
  s.onchange = () => {
    on(s.value);
  };
  return el('label', {}, el('span', {}, label), s);
}

function rangeRow(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  on: (v: number) => void,
  fmt: (v: number) => string = (v) => v.toFixed(2),
) {
  const r = el('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
  });
  const v = el('span', { className: 'val' }, fmt(value));
  r.oninput = () => {
    v.textContent = fmt(Number(r.value));
    on(Number(r.value));
  };
  return el('label', {}, el('span', {}, label), r, v);
}

function checkRow(label: string, value: boolean, on: (v: boolean) => void) {
  const c = el('input', { type: 'checkbox', checked: value });
  c.onchange = () => {
    on(c.checked);
  };
  return el('label', {}, el('span', {}, label), c);
}

function buttons(names: string[], on: (n: string) => void) {
  return el(
    'div',
    { className: 'row' },
    ...names.map((n) =>
      el(
        'button',
        {
          onclick: () => {
            on(n);
          },
        },
        n,
      ),
    ),
  );
}

const timeline = el('input', {
  id: 'timeline',
  type: 'range',
  min: '0',
  max: '47',
  step: '0.001',
  value: '0',
});
const timeLabel = el('span', { className: 'val' });
timeLabel.style.width = '110px';
const playBtn = el('button', {}, 'Pause');
const statsPre = el('pre');
const infoPre = el('pre');
const inputPre = el('pre');
const staticInfo = el('div');
const detDiv = el('div');
const shotNote = el('input', {
  type: 'text',
  placeholder: 'note for the screenshot…',
  title: 'Saved with the screenshot (Enter saves)',
});
shotNote.style.width = '220px';
const shotStatus = el('span', { className: 'note' });

// ---------------------------------------------------------------- screenshots

let shotRequested = false;

/** A URL that reopens this view: settings, time (paused) and camera. */
function shareUrl(): string {
  const q = new URLSearchParams({
    runtime: state.runtime,
    character: state.character,
    weapon: state.weapon,
    t: state.time.toFixed(3),
    paused: '1',
    rate: String(state.rate),
    crowd: String(state.crowd),
    ik: state.ik,
    upper: upperBodySettings.source,
    footIk: state.footIk ? '1' : '0',
    spineAim: state.spineAim ? '1' : '0',
    weaponHold: state.weaponHold ? '1' : '0',
    skeleton: state.skeleton ? '1' : '0',
    shadows: state.shadows ? '1' : '0',
    forest: state.forest ? '1' : '0',
    follow: state.follow ? '1' : '0',
    ground: state.ground,
    cam: [...stage.camera.position.toArray(), ...stage.controls.target.toArray()]
      .map((v) => v.toFixed(3))
      .join(','),
  });
  return `${location.origin}${location.pathname}?${q.toString()}`;
}

/**
 * Saves what is on screen (called right after rendering, while the drawing
 * buffer still holds the frame): the 3D view or the 2D map, the A/B tags,
 * and a caption with the note and time; the notes hold everything needed to
 * find the moment again.
 */
function takeScreenshot(): void {
  const src = state.view === '2d' ? plan : canvas;
  const out = document.createElement('canvas');
  const k = src.width / Math.max(1, src.clientWidth);
  const captionH = Math.round(26 * k);
  out.width = src.width;
  out.height = src.height + captionH;
  const g = out.getContext('2d');
  if (!g) return;
  g.drawImage(src, 0, 0);
  g.font = `${String(Math.round(12 * k))}px system-ui, sans-serif`;
  g.textBaseline = 'middle';
  if (state.view === '3d')
    for (const s of soldiers) {
      if (!s.tag) continue;
      const x = parseFloat(s.tag.style.left) * k;
      const y = parseFloat(s.tag.style.top) * k;
      const text = s.tag.textContent;
      const w = g.measureText(text).width + 10 * k;
      g.fillStyle = '#000a';
      g.fillRect(x - w / 2, y - 16 * k, w, 16 * k);
      g.fillStyle = '#fff';
      g.fillText(text, x - w / 2 + 5 * k, y - 8 * k);
    }
  const note = shotNote.value.trim();
  g.fillStyle = '#1b1e22';
  g.fillRect(0, src.height, out.width, captionH);
  g.fillStyle = '#e8e8e8';
  g.fillText(
    `t ${state.time.toFixed(2)} s · ${state.character} · ${state.runtime} · ${state.weapon}` +
      (note ? ` — ${note}` : ''),
    8 * k,
    src.height + captionH / 2,
  );

  const when = new Date();
  const name = screenshotName(state.character, state.time, when);
  const notes = {
    note,
    taken: when.toISOString(),
    time: state.time,
    mode: state.mode,
    reproducible:
      state.mode === 'sequence'
        ? 'open url'
        : 'live control: the url shows the scripted sequence instead',
    url: shareUrl(),
    settings: { ...state, upperBody: upperBodySettings.source },
    camera: {
      position: stage.camera.position.toArray(),
      target: stage.controls.target.toArray(),
    },
    input: lastInput,
    animation: soldiers
      .filter((s, i) => i === 0 || s.tag)
      .map((s) => ({ runtime: s.runtime.label, state: s.animator.describe() })),
    performance: statsPre.textContent,
  };
  const label = shotStatus;
  label.textContent = 'Saving…';
  void saveScreenshot(out, name, notes).then((file) => {
    label.textContent = file ? `Saved ${file}` : 'Downloaded';
    shotNote.value = '';
  });
}

function buildUi(): void {
  const left = $('left') as HTMLDivElement;
  const ids = Object.keys(assets.characters) as CharacterId[];
  left.append(
    el('h2', {}, 'Implementation'),
    selectRow(
      'Runtime',
      [
        ['both', 'A + B side by side'],
        ['native', 'A · three.js native (explicit time)'],
        ['animouse', 'B · animouse 0.8.0'],
      ],
      state.runtime,
      (v) => {
        state.runtime = v as RuntimeChoice;
        rebuild();
      },
    ),
    selectRow(
      'Character',
      ids.map((id) => [id, assets.characters[id]?.label ?? id]),
      state.character,
      (v) => {
        state.character = v as CharacterId;
        rebuild();
      },
    ),
    selectRow(
      'Weapon',
      [
        ['m16', 'M16A2 stand-in (CC0 AR-15 model)'],
        ['m249', 'M249 SAW — PLACEHOLDER'],
        ['ak', 'AK (CC0)'],
        ['none', 'none'],
      ],
      state.weapon,
      (v) => {
        state.weapon = v as WeaponChoice;
        rebuild();
      },
    ),
    rangeRow(
      'Soldiers',
      1,
      100,
      1,
      state.crowd,
      (v) => {
        state.crowd = v;
        rebuild();
      },
      (v) => v.toFixed(0),
    ),

    el('h2', {}, 'Movement'),
    selectRow(
      'Source',
      [
        ['sequence', 'Scripted test sequence (47 s)'],
        ['live', 'Live control'],
      ],
      state.mode,
      (v) => {
        if (v === 'live') startLive();
        else {
          state.mode = 'sequence';
          rebuild();
        }
      },
    ),
    el('div', { className: 'note' }, 'States (switch to live control):'),
    buttons(
      [
        'Idle',
        'Slow walk',
        'Walk',
        'Run',
        'Sprint',
        'Stop',
        'Back',
        'Strafe L',
        'Strafe R',
        'Diagonal',
        'Turn 90°',
      ],
      preset,
    ),
    rangeRow('Speed m/s', 0, 6, 0.05, 0, (v) => {
      startLive();
      if (live) {
        live.speed = v;
        applyMove();
      }
    }),
    rangeRow(
      'Direction °',
      -180,
      180,
      5,
      0,
      (v) => {
        startLive();
        if (live) {
          const cur = live.sim.frames[live.sim.frames.length - 1]?.s.azimuth ?? 0;
          if (live.faceTravel) live.facing = cur;
          live.rel = (v * Math.PI) / 180;
          live.faceTravel = v === 0;
          if (!live.faceTravel && live.speed === 0) live.facing = cur;
          applyMove();
        }
      },
      (v) => v.toFixed(0),
    ),
    el('h2', {}, 'Posture'),
    buttons(['Stand', 'Kneel', 'Prone', 'Crawl'], preset),
    el('h2', {}, 'Weapon / action'),
    buttons(['Lower', 'Ready', 'Aim', 'Fire', 'Cease fire', 'Reload', 'Incapacitate'], preset),
    rangeRow(
      'Aim pitch °',
      -30,
      30,
      1,
      0,
      (v) => {
        command({ aimPitch: (v * Math.PI) / 180 });
      },
      (v) => v.toFixed(0),
    ),

    el('h2', {}, 'Post-processing (shared)'),
    selectRow(
      'Arm IK',
      [
        ['two-bone', 'analytic two-bone (custom, 80 lines)'],
        ['ccd', 'three.js CCDIKSolver'],
        ['off', 'off (clip arms)'],
      ],
      state.ik,
      (v) => {
        state.ik = v as IkMode;
        rebuild();
      },
    ),
    selectRow(
      'Rifle upper body',
      [
        ['idle', 'procedural hold over idle clip'],
        ['kaykit', 'KayKit rifle clips (retargeted)'],
      ],
      upperBodySettings.source,
      (v) => {
        upperBodySettings.source = v as 'idle' | 'kaykit';
        rebuild();
      },
    ),
    checkRow('Weapon hold', state.weaponHold, (v) => (state.weaponHold = v)),
    checkRow('Spine aim', state.spineAim, (v) => (state.spineAim = v)),
    checkRow('Foot IK', state.footIk, (v) => (state.footIk = v)),

    el('h2', {}, 'Scene'),
    selectRow(
      'Ground',
      [
        ['flat', 'flat test plane (1 m grid)'],
        ['uneven', 'uneven + 15° ramp'],
      ],
      state.ground,
      (v) => {
        state.ground = v as GroundKind;
        stage.setGround(state.ground);
      },
    ),
    checkRow('Ambush trees', state.forest, (v) => {
      state.forest = v;
      if (v && !forest) {
        forest = createForest((x, y) => stage.heightAt(x, y));
        stage.scene.add(forest.group);
      } else if (forest) forest.group.visible = v;
    }),
    checkRow('Shadows', state.shadows, (v) => {
      state.shadows = v;
      stage.setShadows(v);
    }),
    checkRow('Skeleton', state.skeleton, (v) => {
      state.skeleton = v;
      for (const s of soldiers) s.helper.visible = v;
    }),
    checkRow('Camera follows', state.follow, (v) => (state.follow = v)),
    checkRow('2D map view', false, (v) => {
      state.view = v ? '2d' : '3d';
      plan.style.display = v ? 'block' : 'none';
      canvas.style.visibility = v ? 'hidden' : 'visible';
    }),
  );

  const bottom = $('bottom') as HTMLDivElement;
  playBtn.onclick = () => {
    state.playing = !state.playing;
    playBtn.textContent = state.playing ? 'Pause' : 'Play';
  };
  timeline.oninput = () => {
    state.time = Number(timeline.value);
    if (state.mode === 'live') state.review = state.time < duration() - 0.05;
    pendingSeek = true;
  };
  const rateSel = el('select');
  for (const r of [0.1, 0.25, 0.5, 1, 2, 4, 8, 16])
    rateSel.add(new Option(`${String(r)}×`, String(r)));
  rateSel.value = String(state.rate);
  rateSel.onchange = () => (state.rate = Number(rateSel.value));
  const step = (d: number) => () => {
    state.playing = false;
    playBtn.textContent = 'Play';
    state.time = Math.max(0, Math.min(duration(), state.time + d));
    pendingSeek = true;
  };
  bottom.append(
    playBtn,
    el('button', { onclick: step(-DT), title: 'one tick back' }, '◀'),
    el('button', { onclick: step(DT), title: 'one tick forward' }, '▶'),
    el('span', { className: 'note' }, 'speed'),
    rateSel,
    timeline,
    timeLabel,
    el(
      'button',
      {
        onclick: () => {
          state.review = false;
        },
        title: 'live control: return to the live edge',
      },
      'Live',
    ),
    shotNote,
    el(
      'button',
      {
        onclick: () => {
          shotRequested = true;
        },
        title: 'Save a picture of the view with your note, the time and every setting',
      },
      'Screenshot',
    ),
    shotStatus,
  );
  shotNote.onkeydown = (e) => {
    if (e.key === 'Enter') shotRequested = true;
  };

  const right = $('right') as HTMLDivElement;
  right.append(
    el('h2', {}, 'Performance'),
    statsPre,
    el('h2', {}, 'Animation state'),
    infoPre,
    el('h2', {}, 'Simulation input'),
    inputPre,
    el('h2', {}, 'Determinism / replay test'),
    el(
      'button',
      {
        onclick: () => {
          runDeterminismUi();
        },
      },
      'Run test (both runtimes)',
    ),
    detDiv,
    staticInfo,
  );
}

function buildInfoStatic(): void {
  const a = assets.characters[state.character];
  if (!a) return;
  const rows = CLIP_SLOTS.map((slot) => {
    const c = a.clips[slot];
    return `<tr><td>${slot}</td><td>${c ? `${c.origin}${c.retargeted ? ' <span class="warn">(retargeted)</span>' : ''}` : '<span class="bad">missing</span>'}</td><td class="n">${c && c.metrics.speed > 0 ? c.metrics.speed.toFixed(2) : ''}</td></tr>`;
  }).join('');
  const w = soldiers[0]?.view.weapon;
  staticInfo.innerHTML =
    `<h2>Character</h2><div>${a.label}</div><div class="note">${String(a.triangles)} triangles, ${String(a.boneCount)} bones, licence: ${a.licence}</div>` +
    `<div class="note">Weapon: ${w ? w.profile.label : 'none'}</div>` +
    `<h2>Clip slots</h2><table><tr><th>slot</th><th>source</th><th>m/s</th></tr>${rows}</table>` +
    `<p class="note">Missing or substituted: prone and low crawl (procedural for the Rocketbox soldier, prone.ts), stand↔kneel↔prone transitions (timed crossfades), rifle reload (procedural hand path), M249 handling (rifle hold, placeholder model), turn-in-place (stepping from the walk clip).</p>` +
    `<p class="note">Assets load in ${(assets.loadMs / 1000).toFixed(1)} s (download, parse, retarget, measure).</p>`;
}

function runDeterminismUi(): void {
  detDiv.textContent = 'Running…';
  setTimeout(() => {
    determinismResults = runAllDeterminism();
    renderDeterminism();
  }, 20);
}

function renderDeterminism(): void {
  const parts: string[] = [];
  for (const [id, res] of Object.entries(determinismResults)) {
    parts.push(
      `<div><b>${id}</b></div><table><tr><th>pass</th><th>max °</th><th>max mm</th><th></th></tr>` +
        res
          .map(
            (r) =>
              `<tr><td>${r.name}</td><td class="n">${r.maxDeg.toFixed(4)}</td><td class="n">${r.maxMm.toFixed(2)}</td><td>${r.exact ? '<span class="ok">exact</span>' : r.visual ? '<span class="warn">visual</span>' : '<span class="bad">FAIL</span>'}</td></tr>`,
          )
          .join('') +
        '</table>',
    );
  }
  detDiv.innerHTML =
    parts.join('') +
    `<p class="note">Poses at ${String(CHECK_TIMES.length)} times of the test sequence. exact ≤ 0.01° and 0.1 mm; visual ≤ 1° and 5 mm.</p>`;
}

function runAllDeterminism(): Record<string, PassResult[]> {
  const out: Record<string, PassResult[]> = {};
  const asset = assets.characters[state.character] ?? assets.characters.rocketbox;
  for (const rt of [nativeRuntime, animouseRuntime]) {
    const h: Harness = {
      create: () => {
        const soldier = createSoldier(asset);
        soldier.weapon = makeWeapon(state.weapon);
        return { soldier, animator: rt.create(soldier, sequenceFrames) };
      },
      pose(view, animator, time, ctx) {
        const input = poseInputAt(sequenceFrames, time);
        placeSoldier(view, input, stage.heightAt(input.x, input.y));
        animator.update(input, ctx);
        postProcess(view, input, postOptions(), stage.heightAt, stage.ground === 'flat');
      },
    };
    out[rt.label] = runDeterminism(h, sequenceFrames);
  }
  return out;
}

// ---------------------------------------------------------------- 2D view

function drawPlan(t: number): void {
  const w = (plan.width = plan.clientWidth);
  const h = (plan.height = plan.clientHeight);
  const g = plan.getContext('2d');
  if (!g) return;
  const f = frames();
  const scale = 18;
  const cx = w / 2;
  const cy = h / 2;
  g.fillStyle = '#20261d';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#2f382a';
  for (let x = cx % scale; x < w; x += scale) g.strokeRect(x, 0, 0, h);
  for (let y = cy % scale; y < h; y += scale) g.strokeRect(0, y, w, 0);
  g.strokeStyle = '#7d8f5a';
  g.beginPath();
  f.forEach((fr, i) => {
    const x = cx + fr.s.x * scale;
    const y = cy - fr.s.y * scale;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
  g.stroke();
  const p = poseInputAt(f, t);
  g.fillStyle = '#e9d36a';
  g.beginPath();
  g.arc(cx + p.x * scale, cy - p.y * scale, 6, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#e9d36a';
  g.beginPath();
  g.moveTo(cx + p.x * scale, cy - p.y * scale);
  g.lineTo(
    cx + (p.x + Math.sin(p.azimuth) * 1.2) * scale,
    cy - (p.y + Math.cos(p.azimuth) * 1.2) * scale,
  );
  g.stroke();
  g.fillStyle = '#ccc';
  g.fillText(
    `2D view: the 3D soldiers are not updated. t = ${t.toFixed(2)} s, ${p.posture}, ${p.carry}`,
    10,
    18,
  );
}

// ---------------------------------------------------------------- stats

const frameMs: number[] = [];
const animMs: number[] = [];
const renderMs: number[] = [];
let lastFrame = performance.now();

function pct(a: number[], p: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
}
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function updateStats(): void {
  const info = stage.renderer.info;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  statsPre.textContent =
    `frame ${avg(frameMs).toFixed(2)} ms avg, ${pct(frameMs, 0.95).toFixed(2)} ms p95 (${(1000 / Math.max(1e-3, avg(frameMs))).toFixed(0)} fps)\n` +
    `animation CPU ${avg(animMs).toFixed(3)} ms (${((avg(animMs) / Math.max(1, soldiers.length)) * 1000).toFixed(0)} µs/soldier)\n` +
    `render CPU ${avg(renderMs).toFixed(2)} ms, ${String(info.render.calls)} draw calls, ${(info.render.triangles / 1000).toFixed(0)}k triangles\n` +
    `soldiers ${String(soldiers.length)}${forest ? `, trees ${String(forest.trees)}` : ''}` +
    (mem ? `, JS heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB` : '');
}

// ---------------------------------------------------------------- loop

function tick(): void {
  const now = performance.now();
  const realDt = Math.min(0.25, (now - lastFrame) / 1000);
  frameMs.push(now - lastFrame);
  if (frameMs.length > 240) frameMs.shift();
  lastFrame = now;
  stage.resize();

  // Advance time.
  if (state.playing) state.time += realDt * state.rate;
  if (state.mode === 'live' && live) {
    if (!state.review) {
      // The live edge: the simulation runs one tick ahead of the rendered time.
      live.sim.stepTo(Math.ceil(state.time * TICK_HZ) + 1);
      state.time = Math.min(state.time, live.sim.seconds);
    } else if (state.time >= live.sim.seconds) state.review = false;
  } else if (state.time > duration()) {
    state.time = 0;
    pendingSeek = true;
  }
  timeline.max = String(Math.max(0.1, duration()));
  timeline.value = String(state.time);
  timeLabel.textContent = `${state.time.toFixed(2)} / ${duration().toFixed(1)} s`;

  if (state.view === '2d') {
    drawPlan(state.time);
    if (shotRequested) {
      shotRequested = false;
      takeScreenshot();
    }
    return;
  }

  // Animate. When the 3D view comes back (or time jumped), the elapsed
  // simulation time since the last 3D update is passed as dt.
  const t0 = performance.now();
  const seeked = pendingSeek;
  const stepDt = seeked ? 0 : state.time - lastUpdateTime;
  for (const s of soldiers) {
    const input = poseSoldier(s, state.time, Math.max(0, stepDt), seeked || stepDt < 0);
    if (s === soldiers[0]) lastInput = input;
  }
  pendingSeek = false;
  lastUpdateTime = state.time;
  const t1 = performance.now();
  animMs.push(t1 - t0);
  if (animMs.length > 240) animMs.shift();

  // Camera follows the first soldier.
  const first = soldiers[0];
  if (state.follow && first) {
    const p = first.view.root.position;
    const off = stage.camera.position.clone().sub(stage.controls.target);
    const mid = soldiers.length > 1 && state.runtime === 'both' ? 0 : 0;
    stage.controls.target.set(p.x + mid, p.y + 1.0, p.z);
    stage.camera.position.copy(stage.controls.target).add(off);
  }
  stage.controls.update();
  stage.sun.position.copy(stage.controls.target).add(new THREE.Vector3(6, 10, 4));
  stage.sun.target.position.copy(stage.controls.target);

  const r0 = performance.now();
  stage.renderer.render(stage.scene, stage.camera);
  renderMs.push(performance.now() - r0);
  if (renderMs.length > 240) renderMs.shift();

  // Tags over the side-by-side soldiers.
  for (const s of soldiers) {
    if (!s.tag) continue;
    const p = s.view.root.position.clone();
    p.y += 2.1;
    p.project(stage.camera);
    s.tag.style.left = `${String(((p.x + 1) / 2) * canvas.clientWidth)}px`;
    s.tag.style.top = `${String(((1 - p.y) / 2) * canvas.clientHeight)}px`;
  }
  if (shotRequested) {
    shotRequested = false;
    takeScreenshot();
  }
  if (Math.floor(now / 250) !== Math.floor((now - realDt * 1000) / 250)) {
    updateStats();
    infoPre.textContent = soldiers
      .filter(
        (s, i) =>
          i === 0 ||
          (state.runtime === 'both' &&
            s.runtime !== soldiers[0]?.runtime &&
            soldiers.indexOf(s) === state.crowd),
      )
      .map((s) => `[${s.runtime.label}]\n${s.animator.describe()}`)
      .join('\n\n');
    if (lastInput) {
      const i = lastInput;
      inputPre.textContent =
        `t ${i.time.toFixed(3)} s  speed ${i.speed.toFixed(2)} m/s  dir ${((i.moveAngle * 180) / Math.PI).toFixed(0)}°  turn ${i.turnRate.toFixed(2)} rad/s\n` +
        `posture ${i.postureFrom}→${i.posture} ${(i.postureT * 100).toFixed(0)}%   carry ${i.carryFrom}→${i.carry} ${(i.carryT * 100).toFixed(0)}%\n` +
        `aim pitch ${((i.aimPitch * 180) / Math.PI).toFixed(0)}°  since shot ${Number.isFinite(i.sinceShot) ? i.sinceShot.toFixed(2) : '–'} s  reload ${i.reloadT >= 0 ? (i.reloadT * 100).toFixed(0) + '%' : '–'}  down ${i.sinceDown >= 0 ? i.sinceDown.toFixed(2) + ' s' : '–'}`;
    }
  }
}

// ---------------------------------------------------------------- start

const assets: AssetSet = await loadAssets((m) => (loading.textContent = m));
loading.remove();
buildUi();
rebuild();
stage.setGround(state.ground);
stage.setShadows(state.shadows);
if (state.forest) {
  forest = createForest((x, y) => stage.heightAt(x, y));
  stage.scene.add(forest.group);
}
const cam = params.get('cam')?.split(',').map(Number);
if (cam?.length === 6 && cam.every(Number.isFinite)) {
  stage.camera.position.fromArray(cam);
  stage.controls.target.fromArray(cam, 3);
  stage.controls.update();
}
stage.renderer.setAnimationLoop(tick);

// Hooks for scripted checks (Playwright): state, seeking, determinism, benchmarks.
const hooks = {
  state,
  upperBody(source: 'idle' | 'kaykit') {
    upperBodySettings.source = source;
    rebuild();
  },
  setTime(t: number) {
    state.playing = false;
    state.time = t;
    pendingSeek = true;
  },
  set(patch: Partial<typeof state>) {
    Object.assign(state, patch);
    if (patch.ground) stage.setGround(patch.ground);
    if (patch.shadows !== undefined) stage.setShadows(patch.shadows);
    if (patch.forest && !forest) {
      forest = createForest((x, y) => stage.heightAt(x, y));
      stage.scene.add(forest.group);
    }
    if (forest && patch.forest !== undefined) forest.group.visible = patch.forest;
    rebuild();
  },
  preset,
  /** Camera relative to the first soldier: azimuth (deg, 0 = in front), distance, height. */
  orbit(azDeg: number, dist: number, height: number, lookY = 1.1) {
    const s = soldiers[0];
    if (!s) return;
    state.follow = false;
    tick();
    // Centre on all soldiers (both runtimes side by side).
    const p = new THREE.Vector3();
    for (const o of soldiers) p.add(o.view.root.position);
    p.divideScalar(soldiers.length);
    const yaw = s.view.root.rotation.y + (azDeg * Math.PI) / 180;
    stage.camera.position.set(p.x + Math.sin(yaw) * dist, p.y + height, p.z + Math.cos(yaw) * dist);
    stage.controls.target.set(p.x, p.y + lookY, p.z);
    stage.controls.update();
    tick();
  },
  camera(pos: [number, number, number], target: [number, number, number]) {
    stage.camera.position.set(...pos);
    stage.controls.target.set(...target);
    stage.controls.update();
  },
  /** The placed soldiers and loaded assets (for probes from the console). */
  soldiers: () => soldiers.map((s) => s.view),
  assets: () => assets,
  determinism: () => runAllDeterminism(),
  bench: (cfg: BenchConfig) => runBenchmark(stage, assets, cfg, { makeWeapon, loop: tick }),
  describe: () => soldiers.map((s) => s.animator.describe()),
  input: () => lastInput,
  info: () => ({
    calls: stage.renderer.info.render.calls,
    triangles: stage.renderer.info.render.triangles,
    loadMs: assets.loadMs,
    gl: stage.renderer.getContext().getParameter(stage.renderer.getContext().VERSION) as string,
  }),
  newSequence() {
    sequenceFrames = recordTestSequence();
    rebuild();
  },
  footSlide: () => footSlide(),
  toeProbe(t = 1.7, bone = 'Bip01_L_Toe0') {
    const asset = assets.characters[state.character] ?? assets.characters.rocketbox;
    const out: string[] = [];
    const view = createSoldier(asset);
    for (let k = 0; k < 3; k++) {
      const a = nativeRuntime.create(view, sequenceFrames);
      const steps = Math.round(t * 60);
      for (let i = 0; i <= steps; i++) {
        const tt = i === steps ? t : i / 60;
        const input = poseInputAt(sequenceFrames, tt);
        placeSoldier(view, input, 0);
        a.update(input, { dt: 1 / 60, seeked: i === 0, frames: sequenceFrames });
        postProcess(view, input, postOptions(), () => 0, true);
      }
      const b = view.root.getObjectByName(bone);
      out.push(
        `${String(k)}: ${
          b
            ? b.quaternion
                .toArray()
                .map((x) => x.toFixed(5))
                .join(',')
            : '-'
        } | ${a.describe().split('\n')[0] ?? ''}`,
      );
      a.dispose();
    }
    return out.join('\n');
  },
  /** Hand-to-socket misses (m) at sequence times, for the first soldier. */
  holdReport(times: number[]) {
    const rows: string[] = [];
    for (const t of times) {
      hooks.setTime(t);
      tick();
      const d = hooks.debugWeapon();
      const i = lastInput;
      rows.push(
        `${t.toFixed(1)} ${i?.posture ?? ''}/${i?.carry ?? ''}${i && i.reloadT >= 0 ? '/reload' : ''} L ${String(d?.missL)} R ${String(d?.missR)}`,
      );
    }
    return rows.join('\n');
  },
  restGeometry(id: CharacterId) {
    const a = assets.characters[id];
    if (!a) return null;
    const v = createSoldier(a);
    v.root.updateMatrixWorld(true);
    const out: Record<string, number[]> = {};
    for (const [k, b] of Object.entries(v.bones)) {
      out[k] = b
        .getWorldPosition(new THREE.Vector3())
        .toArray()
        .map((x) => +x.toFixed(3));
    }
    return out;
  },
  debugWeapon() {
    const s = soldiers[0];
    const w = s?.view.weapon;
    if (!s || !w) return null;
    const v = (o: THREE.Object3D | undefined) =>
      o
        ?.getWorldPosition(new THREE.Vector3())
        .toArray()
        .map((x) => +x.toFixed(3));
    const box = new THREE.Box3().setFromObject(w.object, true);
    return {
      root: v(s.view.root),
      shoulderR: v(s.view.bones.upperArmR),
      handR: v(s.view.bones.handR),
      handL: v(s.view.bones.handL),
      weaponPos: w.object.position.toArray().map((x) => +x.toFixed(3)),
      weaponFwd: new THREE.Vector3(0, 0, 1)
        .applyQuaternion(w.object.quaternion)
        .toArray()
        .map((x) => +x.toFixed(3)),
      support: w.profile.support.point
        .clone()
        .applyMatrix4(w.object.matrixWorld)
        .toArray()
        .map((x) => +x.toFixed(3)),
      missL: s.view.bones.handL
        ? +s.view.bones.handL
            .getWorldPosition(new THREE.Vector3())
            .distanceTo(w.profile.support.point.clone().applyMatrix4(w.object.matrixWorld))
            .toFixed(3)
        : null,
      missR: s.view.bones.handR
        ? +s.view.bones.handR
            .getWorldPosition(new THREE.Vector3())
            .distanceTo(w.object.position)
            .toFixed(3)
        : null,
      box: [
        box.min.toArray().map((x) => +x.toFixed(2)),
        box.max.toArray().map((x) => +x.toFixed(2)),
      ],
    };
  },
  get seconds() {
    return TEST_SEQUENCE_SECONDS;
  },
};
(window as unknown as Record<string, unknown>)['proto'] = hooks;
(window as unknown as Record<string, unknown>)['protoReady'] = true;

/**
 * Foot sliding over the test sequence at 60 Hz: at each frame, among the
 * foot joints in contact (ankle or toe within 2.5 cm of its rest height, in
 * this frame and the previous one), the slowest one's horizontal world speed
 * is the slide (a rolling foot always has one joint at rest). Reported in
 * cm/s by movement phase; 0 is perfect.
 */
type SlideStats = Record<string, { mean: number; p95: number; samples: number }>;
function footSlide(): Record<string, SlideStats> {
  const out: Record<string, SlideStats> = {};
  const asset = assets.characters[state.character] ?? assets.characters.rocketbox;
  for (const rt of [nativeRuntime, animouseRuntime]) {
    const view = createSoldier(asset);
    view.weapon = makeWeapon(state.weapon);
    const keys = ['footL', 'toesL', 'footR', 'toesR'] as const;
    const joints = keys.map((k) => view.bones[k]).filter((j): j is THREE.Bone => !!j);
    view.root.updateMatrixWorld(true);
    const rest = joints.map((j) => j.getWorldPosition(new THREE.Vector3()).y);
    const a = rt.create(view, sequenceFrames);
    const buckets: Record<string, number[]> = {};
    let prev: THREE.Vector3[] | null = null;
    const step = 1 / 60;
    for (let i = 0; i * step < 43; i++) {
      const t = i * step;
      const input = poseInputAt(sequenceFrames, t);
      placeSoldier(view, input, 0);
      a.update(input, { dt: i === 0 ? 0 : step, seeked: i === 0, frames: sequenceFrames });
      postProcess(view, input, postOptions(), () => 0, true);
      view.root.updateMatrixWorld(true);
      const now = joints.map((j) => j.getWorldPosition(new THREE.Vector3()));
      if (prev && input.posture === 'standing' && input.postureT >= 1 && input.sinceDown < 0) {
        let best = Infinity;
        now.forEach((p, k) => {
          const q = prev?.[k];
          const r = rest[k] ?? 0;
          if (q && p.y - r < 0.025 && q.y - r < 0.025)
            best = Math.min(best, Math.hypot(p.x - q.x, p.z - q.z) / step);
        });
        if (Number.isFinite(best)) {
          const ang = Math.abs((input.moveAngle * 180) / Math.PI);
          const phase =
            input.speed < 0.05
              ? Math.abs(input.turnRate) > 0.1
                ? 'turn in place'
                : 'standing still'
              : ang > 30
                ? 'strafe / back / diagonal'
                : input.speed < 2
                  ? 'walk'
                  : input.speed < 4.5
                    ? 'run'
                    : 'sprint';
          (buckets[phase] ??= []).push(best * 100);
          (buckets['all'] ??= []).push(best * 100);
        }
      }
      prev = now;
    }
    a.dispose();
    const stats: SlideStats = {};
    for (const [k, v] of Object.entries(buckets))
      stats[k] = { mean: avg(v), p95: pct(v, 0.95), samples: v.length };
    out[rt.label] = stats;
  }
  return out;
}
