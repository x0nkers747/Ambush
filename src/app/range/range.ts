import {
  emptyArticulation,
  emptyMotionSample,
  type ArticulationSample,
  type MotionSample,
} from '#exercise';
import { RANGE_SCENARIOS, rangeTerrain, type RangeScenario } from '#exercise/battle';
import { builtInCatalog, conditionOf, type VehicleCombat } from '#sim';
import type { RangeScene } from '#view3d/combined-arms';
import { describeEvent, clockText, vehicleDiagnosticsHtml } from '../battle/combat-panel';
import { OUTLINE, SIDE_COLORS, vehicleHull, vehicleSymbol } from '../battle/map-editor';
import { createBattleSession, type BattleSession } from '../battle/session';
import { vehicleStatuses } from '../battle/status';
import { escapeHtml } from '../shell';

// The combined-arms range (docs/combined-arms.md §14): the six range
// scenarios (`RANGE_SCENARIOS`) played by the real battle simulation on the
// lab's open ground, in 3D (the game's own vehicle, soldier and effect
// layers) or on a 2D map (the battle page's own symbols), with each
// vehicle's diagnostics: its targets, weapons and ammunition, readiness,
// mounts' bearings, crew and damage, and the events. Time can be moved back
// and forth: a battle run again from its start, whose every second's state
// hash is checked against the first run's (the review's determinism).
// Reached at #combined-arms.

const SPEEDS = [0.5, 1, 2, 4, 8] as const;

const CSS = `
.range { position: fixed; inset: 0; display: grid; grid-template-columns: 1fr 380px; background: #15181b; color: #d8dde2; font: 13px system-ui, "Segoe UI", sans-serif; }
.range .stage { position: relative; overflow: hidden; }
.range canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.range .panel { overflow-y: auto; padding: 10px 12px; border-left: 1px solid #2a2f35; }
.range h1 { font-size: 16px; margin: 0 0 8px; }
.range h2 { font-size: 13px; margin: 14px 0 6px; color: #9fb0c0; text-transform: uppercase; letter-spacing: .04em; }
.range button { background: #232931; color: #d8dde2; border: 1px solid #3a424c; border-radius: 4px; padding: 4px 8px; cursor: pointer; }
.range button[aria-pressed="true"] { background: #2f6db5; border-color: #4f8fd8; color: #fff; }
.range .row { display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; align-items: center; }
.range .scenarios button { width: 100%; text-align: left; margin: 2px 0; }
.range .muted { color: #8a949e; }
.range .warn { color: #ff9a2e; }
.range .ok { color: #7bd88f; }
.range .card { border: 1px solid #2a2f35; border-radius: 6px; padding: 6px 8px; margin: 6px 0; }
.range .card.blue { border-left: 4px solid ${SIDE_COLORS.BLUEFOR}; }
.range .card.red { border-left: 4px solid ${SIDE_COLORS.OPFOR}; }
.range .card h3 { margin: 0 0 4px; font-size: 13px; }
.range dl.kv { display: grid; grid-template-columns: 78px 1fr; gap: 2px 8px; margin: 0; }
.range dl.kv dt { color: #8a949e; }
.range dl.kv dd { margin: 0; }
.range ol.events { padding-left: 0; list-style: none; margin: 0; max-height: 260px; overflow-y: auto; }
.range ol.events li { margin: 2px 0; }
.range .clock { color: #8a949e; margin-right: 4px; }
.range input[type=range] { width: 100%; }
`;

interface RangeState {
  scenario: RangeScenario;
  session: BattleSession;
  /** Each second's state hash of the first run of this scenario. */
  firstHashes: (string | null)[];
  /** Seconds compared on runs again, and whether every one matched. */
  checked: number;
  mismatch: number | null;
  playing: boolean;
  speed: number;
  /** The time drawn (s): between ticks, interpolated. */
  seconds: number;
  view: '3d' | 'map';
  follow: string | null;
}

export async function startCombinedArmsRange(app: HTMLElement): Promise<void> {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  app.innerHTML = `<div class="range">
      <div class="stage"><canvas class="three"></canvas><canvas class="overlay"></canvas></div>
      <div class="panel">
        <h1>Combined-arms range</h1>
        <div class="scenarios"></div>
        <p class="description muted"></p>
        <div class="row">
          <button data-act="play">Pause</button>
          <button data-act="restart">Restart</button>
          ${SPEEDS.map((s) => `<button data-speed="${String(s)}">${String(s)}×</button>`).join('')}
        </div>
        <div class="row"><span class="clock-text"></span></div>
        <input type="range" class="seek" min="0" step="0.5" value="0">
        <div class="row">
          <button data-view="3d">3D</button><button data-view="map">Map</button>
          <span class="muted">Follow</span><select class="follow"></select>
        </div>
        <p class="replay muted"></p>
        <h2>Vehicles</h2><div class="vehicles"></div>
        <h2>Anti-tank weapons</h2><div class="anti-tank"></div>
        <h2>Events</h2><ol class="events"></ol>
      </div>
    </div>`;
  const q = (sel: string): HTMLElement => {
    const e = app.querySelector<HTMLElement>(sel);
    if (!e) throw new Error(`range: no ${sel}`);
    return e;
  };
  const threeCanvas = q('canvas.three') as HTMLCanvasElement;
  const overlay = q('canvas.overlay') as HTMLCanvasElement;
  const stage = q('.stage');
  const { createRangeScene } = await import('#view3d/combined-arms');
  const scene: RangeScene = createRangeScene(threeCanvas);
  const terrain = rangeTerrain();
  const sample: MotionSample = emptyMotionSample();
  const articulation: ArticulationSample = emptyArticulation();

  const firstRuns = new Map<string, (string | null)[]>();
  const begin = (scenario: RangeScenario): RangeState => {
    const session = createBattleSession(scenario.spec, terrain);
    const first = firstRuns.get(scenario.id);
    return {
      scenario,
      session,
      firstHashes: first ?? [],
      checked: 0,
      mismatch: null,
      playing: true,
      speed: state?.speed ?? 1,
      seconds: 0,
      view: state?.view ?? '3d',
      follow: null,
    };
  };
  let state: RangeState | null = null;
  const choose = (scenario: RangeScenario) => {
    state = begin(scenario);
    if (!firstRuns.has(scenario.id)) firstRuns.set(scenario.id, state.firstHashes);
    const v = scenario.spec.vehicles ?? [];
    // Look at the middle of the vehicles, from the south-east.
    const cx = v.reduce((s, x) => s + x.position.x, 0) / Math.max(1, v.length);
    const cy = v.reduce((s, x) => s + x.position.y, 0) / Math.max(1, v.length);
    scene.look(cx, cy, 900, 35, 140);
    q('.description').textContent = scenario.description;
    const follow = q('select.follow') as HTMLSelectElement;
    follow.innerHTML = `<option value="">—</option>${v.map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('')}`;
    (q('input.seek') as HTMLInputElement).max = String(scenario.seconds);
    showButtons();
  };

  /** Runs the battle to `seconds`: on, or (back in time) again from its start. */
  const seek = (seconds: number) => {
    if (!state) return;
    const rate = state.scenario.spec.tickRateHz;
    const tick = Math.round(seconds * rate);
    if (tick < state.session.tick) {
      const again = begin(state.scenario);
      again.playing = state.playing;
      again.follow = state.follow;
      state = again;
    }
    state.session.advance(tick, Infinity);
    state.seconds = state.session.seconds;
    checkHashes();
  };

  /** Each second's hash: kept on the first run, compared on runs again. */
  const checkHashes = () => {
    if (!state) return;
    const hashes = state.session.hashes;
    const first = state.firstHashes;
    for (let s = state.checked; s < hashes.length; s += 1) {
      const h = hashes[s] ?? null;
      if (first[s] === undefined) first[s] = h;
      else if (first[s] !== h && state.mismatch === null) state.mismatch = s;
    }
    state.checked = hashes.length;
  };

  const showButtons = () => {
    if (!state) return;
    const s = state;
    q('.scenarios').innerHTML = RANGE_SCENARIOS.map(
      (x) =>
        `<button data-scenario="${x.id}" aria-pressed="${String(x.id === s.scenario.id)}">${escapeHtml(x.name)}</button>`,
    ).join('');
    for (const b of app.querySelectorAll<HTMLButtonElement>('[data-speed]'))
      b.setAttribute('aria-pressed', String(Number(b.dataset['speed']) === s.speed));
    for (const b of app.querySelectorAll<HTMLButtonElement>('[data-view]'))
      b.setAttribute('aria-pressed', String(b.dataset['view'] === s.view));
    q('[data-act="play"]').textContent = s.playing ? 'Pause' : 'Play';
    threeCanvas.style.visibility = s.view === '3d' ? 'visible' : 'hidden';
  };

  app.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest<HTMLElement>('button');
    if (!t || !state) return;
    const scenario = RANGE_SCENARIOS.find((x) => x.id === t.dataset['scenario']);
    if (scenario) choose(scenario);
    if (t.dataset['speed']) state.speed = Number(t.dataset['speed']);
    if (t.dataset['view'] === '3d' || t.dataset['view'] === 'map') state.view = t.dataset['view'];
    if (t.dataset['act'] === 'play') state.playing = !state.playing;
    if (t.dataset['act'] === 'restart') seek(0);
    showButtons();
  });
  (q('input.seek') as HTMLInputElement).addEventListener('input', (ev) => {
    seek(Number((ev.target as HTMLInputElement).value));
  });
  (q('select.follow') as HTMLSelectElement).addEventListener('change', (ev) => {
    if (state) state.follow = (ev.target as HTMLSelectElement).value || null;
  });

  /** Names for the panels: vehicles by name, soldiers by their squad and number. */
  const namesOf = (s: RangeState) => {
    const names = new Map<string, string>();
    for (const v of s.scenario.spec.vehicles ?? []) names.set(v.id, v.name);
    for (const q2 of s.session.battle.squads) {
      names.set(q2.unitId, q2.name);
      q2.soldierIds.forEach((id, k) => names.set(id, `${q2.name} #${String(k + 1)}`));
    }
    return names;
  };

  let panelsAt = -Infinity;
  const showPanels = (s: RangeState) => {
    const now = performance.now();
    if (now - panelsAt < 250) return;
    panelsAt = now;
    const names = namesOf(s);
    const st = s.session.battle.sim.state;
    const rate = s.scenario.spec.tickRateHz;
    q('.clock-text').textContent =
      `${clockText(s.seconds)} · tick ${String(s.session.tick)} · sim ${s.session.cpu().mean.toFixed(2)} ms/tick`;
    (q('input.seek') as HTMLInputElement).value = String(s.seconds);
    q('.replay').innerHTML =
      s.mismatch !== null
        ? `<span class="warn">Run again: second ${String(s.mismatch)} differs from the first run.</span>`
        : `Determinism: ${String(s.checked)} seconds hashed; every one run again matches the first run <span class="ok">✓</span>`;
    q('.vehicles').innerHTML = vehicleStatuses(st)
      .map((v) => {
        const raw = st.vehicles?.find((x) => x.id === v.id);
        const ready = (raw?.combat.weapons ?? [])
          .map((w) => {
            const wait = Math.max(0, w.readyAt - st.tick / rate);
            return `${escapeHtml(w.id)} ${w.reloadUntil !== null ? `reload ${(w.reloadUntil - st.tick / rate).toFixed(1)} s` : wait > 0.05 ? `next in ${wait.toFixed(1)} s` : 'ready'}`;
          })
          .join(' · ');
        const tracks = raw?.combat.tracks.filter((t) => t.confirmed).length ?? 0;
        return `<div class="card ${v.side === 'BLUEFOR' ? 'blue' : 'red'}"><h3>${escapeHtml(v.name)}</h3>
          ${vehicleDiagnosticsHtml(v, names)}
          <dl class="kv"><dt>Readiness</dt><dd>${ready}</dd><dt>Sees</dt><dd>${String(tracks)} confirmed</dd></dl></div>`;
      })
      .join('');
    const at = st.combat?.antiTank ?? [];
    q('.anti-tank').innerHTML =
      at.length === 0
        ? '<p class="muted">None.</p>'
        : `<dl class="kv">${at
            .map((a) => {
              const soldier = st.soldiers.find((x) => x.id === a.soldierId);
              const down = soldier?.status !== 'active';
              return `<dt>${escapeHtml(a.weapon)}</dt><dd>${escapeHtml(names.get(a.soldierId) ?? a.soldierId)}: ${String(a.loaded)}+${String(a.reserve)}, ${String(a.fired)} fired${a.aimingAt ? ` · aiming at ${escapeHtml(names.get(a.aimingAt) ?? a.aimingAt)}` : ''}${down ? ' <span class="warn">down</span>' : ''}</dd>`;
            })
            .join('')}</dl>`;
    const lines: string[] = [];
    const events = s.session.events;
    for (let i = events.length - 1; i >= 0 && lines.length < 30; i -= 1) {
      const e = events[i];
      if (!e) continue;
      const text = describeEvent(e, names);
      if (text)
        lines.push(
          `<li><span class="clock">${clockText(e.seconds)}</span>${escapeHtml(text)}</li>`,
        );
    }
    q('ol.events').innerHTML = lines.join('') || '<li class="muted">Nothing yet.</li>';
  };

  /** The 2D map: soldiers, vehicles (hull, gun, symbol), and the fire of the last moments. */
  const drawMap = (s: RangeState, ctx: CanvasRenderingContext2D, w: number, h: number) => {
    const log = s.session.motion;
    const tick = Math.round(s.seconds * log.tickRateHz);
    const vehicles = s.scenario.spec.vehicles ?? [];
    // Fit everything at the start in view, with a margin.
    const xs: number[] = [];
    const ys: number[] = [];
    log.soldierIds.forEach((_, i) => {
      log.read(i, tick, sample);
      xs.push(sample.x);
      ys.push(sample.y);
    });
    const minX = Math.min(...xs) - 80;
    const maxX = Math.max(...xs) + 80;
    const minY = Math.min(...ys) - 80;
    const maxY = Math.max(...ys) + 80;
    const scale = Math.min(w / (maxX - minX), h / (maxY - minY));
    const at = (p: { x: number; y: number }) => ({
      x: w / 2 + (p.x - (minX + maxX) / 2) * scale,
      y: h / 2 - (p.y - (minY + maxY) / 2) * scale,
    });
    ctx.fillStyle = '#3d4a33';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let gx = Math.ceil(minX / 100) * 100; gx < maxX; gx += 100) {
      const a = at({ x: gx, y: minY });
      ctx.beginPath();
      ctx.moveTo(a.x, 0);
      ctx.lineTo(a.x, h);
      ctx.stroke();
    }
    for (let gy = Math.ceil(minY / 100) * 100; gy < maxY; gy += 100) {
      const a = at({ x: minX, y: gy });
      ctx.beginPath();
      ctx.moveTo(0, a.y);
      ctx.lineTo(w, a.y);
      ctx.stroke();
    }
    // Fire of the last moments.
    for (const e of s.session.events) {
      const age = s.seconds - e.seconds;
      if (age < 0 || age > 1.2) continue;
      const ev = e.event;
      if (ev.type !== 'vehicleFire') continue;
      const a = at(ev.from);
      const f =
        ev.missileId !== null && ev.impactAt !== null
          ? Math.min(1, age / Math.max(0.05, ev.impactAt - ev.atSeconds))
          : 1;
      const b = at({
        x: ev.from.x + (ev.impact.x - ev.from.x) * f,
        y: ev.from.y + (ev.impact.y - ev.from.y) * f,
      });
      ctx.globalAlpha = 1 - age / 1.2;
      ctx.strokeStyle = ev.side === 'BLUEFOR' ? '#9fd8ff' : '#ffb0a0';
      ctx.lineWidth = ev.slot === 'main' || ev.shooter === 'soldier' ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Soldiers.
    const vehicleIds = new Set(vehicles.map((v) => v.id));
    const st = s.session.battle.sim.state;
    log.soldierIds.forEach((id, i) => {
      if (vehicleIds.has(id)) return;
      log.read(i, tick, sample);
      const p = at(sample);
      const side = st.soldiers.find((x) => x.id === id)?.side ?? 'BLUEFOR';
      ctx.fillStyle = sample.status === 'active' ? SIDE_COLORS[side] : '#8a949e';
      ctx.strokeStyle = OUTLINE;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.6, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    });
    // Vehicles: the hull to scale with its gun, then its symbol and name.
    for (const v of vehicles) {
      const i = log.indexOf(v.id);
      if (i < 0) continue;
      log.read(i, tick, sample);
      log.readArticulation(i, tick, articulation);
      const centre = { x: sample.x, y: sample.y };
      vehicleHull(
        ctx,
        at,
        centre,
        sample.azimuth,
        v.kind,
        v.side,
        sample.azimuth + (articulation.mounts[0] ?? 0),
        articulation.condition,
      );
      const p = at(centre);
      const sym = { x: p.x, y: p.y - 26 };
      vehicleSymbol(ctx, sym, v.side, v.id === s.follow, false, v.kind, articulation.condition);
      ctx.fillStyle = '#e8ecef';
      ctx.font = '600 11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(v.name, sym.x, sym.y - 18);
    }
  };

  /** In 3D: the vehicles' names over them, and a line to each target. */
  const drawLabels = (s: RangeState, ctx: CanvasRenderingContext2D) => {
    const st = s.session.battle.sim.state;
    const log = s.session.motion;
    const tick = Math.round(s.seconds * log.tickRateHz);
    const where = new Map<string, { x: number; y: number; z: number }>();
    log.soldierIds.forEach((id, i) => {
      log.read(i, tick, sample);
      where.set(id, { x: sample.x, y: sample.y, z: sample.z });
    });
    ctx.font = '600 12px system-ui';
    ctx.textAlign = 'center';
    for (const v of st.vehicles ?? []) {
      const at = where.get(v.id);
      if (!at) continue;
      const p = scene.project(at.x, at.y, at.z + 4);
      if (!p) continue;
      const condition = conditionOf(v.combat as VehicleCombat);
      for (const e of v.combat.engagements) {
        const t = where.get(e.targetId);
        const tp = t ? scene.project(t.x, t.y, t.z + 1.5) : null;
        const from = scene.project(at.x, at.y, at.z + 2);
        if (!tp || !from) continue;
        ctx.strokeStyle =
          v.side === 'BLUEFOR' ? 'rgba(120,190,255,0.55)' : 'rgba(255,140,120,0.55)';
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(tp.x, tp.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const label = `${v.name}${condition === 'operational' ? '' : ` · ${condition}`}`;
      ctx.lineWidth = 3;
      ctx.strokeStyle = OUTLINE;
      ctx.strokeText(label, p.x, p.y);
      ctx.fillStyle = v.side === 'BLUEFOR' ? '#9fd8ff' : '#ffb0a0';
      ctx.fillText(label, p.x, p.y);
    }
  };

  const first = RANGE_SCENARIOS[0];
  if (!first) return;
  choose(first);
  let last = performance.now();
  const frame = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const s = state;
    if (s) {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (overlay.width !== width || overlay.height !== height) {
        overlay.width = width;
        overlay.height = height;
        scene.resize(width, height);
      }
      if (s.playing && s.seconds < s.scenario.seconds) {
        s.seconds = Math.min(s.scenario.seconds, s.seconds + dt * s.speed);
        const rate = s.scenario.spec.tickRateHz;
        s.session.advance(Math.ceil(s.seconds * rate) + 1);
        checkHashes();
      }
      const log = s.session.motion;
      if (s.follow !== null) {
        const i = log.indexOf(s.follow);
        if (i >= 0) {
          log.read(i, Math.round(s.seconds * log.tickRateHz), sample);
          scene.look(sample.x, sample.y, 45, 22, ((sample.azimuth * 180) / Math.PI + 200) % 360);
        }
      }
      const st = s.session.battle.sim.state;
      const ctx = overlay.getContext('2d');
      if (s.view === '3d') {
        scene.render({
          log,
          combatLog: s.session.combatLog,
          seconds: s.seconds,
          timeScale: s.speed,
          units: st.soldiers.map((x) => ({
            id: x.id,
            affiliation: x.side === 'BLUEFOR' ? 'friendly' : 'enemy',
            position: x.position,
            azimuth: x.azimuth,
            posture: x.posture,
            status: x.status,
            selected: false,
          })),
          vehicles: (s.scenario.spec.vehicles ?? []).map((v) => ({
            id: v.id,
            side: v.side,
            kind: v.kind,
          })),
          weapons: Object.fromEntries(
            s.session.battle.squads.flatMap((q2) => Object.entries(q2.weapons)),
          ),
        });
        if (ctx) {
          ctx.clearRect(0, 0, overlay.width, overlay.height);
          drawLabels(s, ctx);
        }
      } else if (ctx) drawMap(s, ctx, overlay.width, overlay.height);
      showPanels(s);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // For checks in the browser: the range's state.
  (app as HTMLElement & { ambushRange?: () => unknown }).ambushRange = () => ({
    scenario: state?.scenario.id,
    seconds: state?.seconds,
    tick: state?.session.tick,
    checked: state?.checked,
    mismatch: state?.mismatch,
    effects: scene.stats(),
    vehicles: state ? vehicleStatuses(state.session.battle.sim.state) : [],
    select: (id: string) => {
      const s = RANGE_SCENARIOS.find((x) => x.id === id);
      if (s) choose(s);
    },
    seek,
    view: (v: '3d' | 'map') => {
      if (state) state.view = v;
      showButtons();
    },
    look: (x: number, y: number, d: number, p: number, b: number) => {
      scene.look(x, y, d, p, b);
    },
    play: (on: boolean) => {
      if (state) state.playing = on;
      showButtons();
    },
    catalog: [...builtInCatalog().platforms.keys()],
  });
}
