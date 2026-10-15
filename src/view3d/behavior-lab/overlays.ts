import { emptyMotionSample, type MotionLog } from '#exercise';
import type { AgentDiagnostics, BehaviorDiagnostics, DeepReadonly, SimState } from '#sim';
import type { GroundProjection, MapPoint } from '../ground-projection';

// The Behavior Lab's overlays (docs/behavior-lab/04 §6), drawn over the 3D
// view from the simulation's state and its diagnostics only: the same
// numbers the system steered with. Between ticks they are interpolated
// exactly as the characters are (from the previous tick to the current one).

export interface OverlayOptions {
  readonly route: boolean;
  readonly anchor: boolean;
  readonly slots: boolean;
  /** Line from each Marine to his slot, coloured by how far off he is. */
  readonly errors: boolean;
  readonly heading: boolean;
  readonly velocity: boolean;
  /** The error in metres beside each Marine. */
  readonly errorLabels: boolean;
  /** What each Marine is doing (on station, catching up, …). */
  readonly states: boolean;
  /** The task's phase and pace beside the anchor. */
  readonly phase: boolean;
  /** The last 20 s of each Marine's path. */
  readonly trails: boolean;
}

export const DEFAULT_OVERLAYS: OverlayOptions = {
  route: true,
  anchor: true,
  slots: true,
  errors: true,
  heading: false,
  velocity: false,
  errorLabels: false,
  states: false,
  phase: true,
  trails: false,
};

export const OVERLAY_LABELS: Readonly<Record<keyof OverlayOptions, string>> = {
  route: 'Shared route',
  anchor: 'Formation anchor',
  slots: 'Formation slots',
  errors: 'Actual → desired',
  heading: 'Heading',
  velocity: 'Velocity',
  errorLabels: 'Formation error (m)',
  states: 'Agent state',
  phase: 'Task phase',
  trails: 'Movement trails',
};

/** How far off his slot a Marine is, as a colour. */
export function bandColour(a: AgentDiagnostics, interval: number): string {
  if (a.straggling || a.stuck) return '#ff5a4a';
  if (a.override) return '#c58cff';
  const e = a.desire.error;
  if (e <= 0.15 * interval) return '#6fdc8c';
  if (e <= 0.5 * interval) return '#f2d24a';
  return '#ff9a3c';
}

export const STATE_TEXT: Readonly<Record<AgentDiagnostics['desire']['state'], string>> = {
  inPosition: 'in position',
  onStation: 'on station',
  correcting: 'correcting',
  catchingUp: 'catching up',
  easingOff: 'easing off',
  arriving: 'arriving',
  held: 'held',
  displaced: 'sent away',
  fallingIn: 'falling in',
  detouring: 'going round',
};

export interface OverlayFrame {
  readonly ctx: CanvasRenderingContext2D;
  readonly projection: GroundProjection;
  readonly state: DeepReadonly<SimState>;
  readonly diagnostics: BehaviorDiagnostics;
  readonly previous: BehaviorDiagnostics;
  /** 0 → 1 from the previous tick to the current one. */
  readonly alpha: number;
  readonly log: MotionLog;
  /** Fractional tick shown (as the characters). */
  readonly tick: number;
  readonly selected: ReadonlySet<string>;
  readonly options: OverlayOptions;
  /** Where a destination or displacement was last given (drawn as a flag). */
  readonly destination: MapPoint | null;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sample = emptyMotionSample();
const sampleB = emptyMotionSample();

/** Soldier `id`'s position at fractional tick `tick`, from the motion log. */
export function positionAt(log: MotionLog, id: string, tick: number): MapPoint | null {
  const i = log.indexOf(id);
  if (i < 0) return null;
  const k = Math.floor(tick);
  log.read(i, k, sample);
  log.read(i, k + 1, sampleB);
  const u = tick - k;
  return { x: lerp(sample.x, sampleB.x, u), y: lerp(sample.y, sampleB.y, u) };
}

export function drawOverlays(f: OverlayFrame): void {
  const { ctx, projection: p, diagnostics, previous, alpha, options } = f;
  const behavior = f.state.behavior;
  if (!behavior) {
    drawFlag(f);
    return;
  }
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const before = new Map(previous.agents.map((a) => [a.soldierId, a]));
  const tasksBefore = new Map(previous.tasks.map((t) => [t.taskId, t]));

  for (const task of behavior.tasks) {
    const d = diagnostics.tasks.find((t) => t.taskId === task.id);
    if (!d) continue;
    const interval = task.formation.interval;
    const running = task.outcome === null;
    // The shared route.
    if (options.route) {
      const points: MapPoint[] = task.route.x.map((x, i) => ({ x, y: task.route.y[i] ?? 0 }));
      line(ctx, p.line(points), running ? 'rgba(120,190,255,0.85)' : 'rgba(120,190,255,0.35)', 3);
      // Every 10 m along the route.
      ctx.fillStyle = 'rgba(200,230,255,0.7)';
      for (let s = 10; s < task.route.length; s += 10) {
        const q = routePoint(task.route, s);
        const sp = p.toScreen(q);
        if (Number.isFinite(sp.x)) ctx.fillRect(sp.x - 1.5, sp.y - 1.5, 3, 3);
      }
      const end = p.toScreen({ x: task.route.x.at(-1) ?? 0, y: task.route.y.at(-1) ?? 0 });
      flag(ctx, end, '#78beff');
    }
    // The anchor, interpolated, with the task's phase and pace.
    const was = tasksBefore.get(task.id) ?? d;
    const anchor = {
      x: lerp(was.anchor.x, d.anchor.x, alpha),
      y: lerp(was.anchor.y, d.anchor.y, alpha),
    };
    const a = p.toScreen(anchor);
    if (options.anchor && Number.isFinite(a.x)) {
      ctx.fillStyle = '#78beff';
      ctx.strokeStyle = '#0b1520';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y - 8);
      ctx.lineTo(a.x + 8, a.y);
      ctx.lineTo(a.x, a.y + 8);
      ctx.lineTo(a.x - 8, a.y);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      const tip = p.along(anchor, Math.atan2(d.anchor.tx, d.anchor.ty), 26);
      line(ctx, [a, tip], '#78beff', 2);
    }
    if (options.phase && Number.isFinite(a.x)) {
      const text = running
        ? `${d.phase} · ${d.anchorSpeed.toFixed(2)} m/s (${d.pace.limitedBy})`
        : `${d.phase} · ${String(d.outcome)}`;
      label(ctx, a.x + 12, a.y - 12, text, '#cfe6ff');
    }

    for (const agent of diagnostics.agents) {
      if (agent.taskId !== task.id) continue;
      const at = positionAt(f.log, agent.soldierId, f.tick);
      if (!at) continue;
      const s = p.toScreen(at);
      if (!Number.isFinite(s.x)) continue;
      const old = before.get(agent.soldierId) ?? agent;
      const slot = {
        x: lerp(old.desire.target.x, agent.desire.target.x, alpha),
        y: lerp(old.desire.target.y, agent.desire.target.y, alpha),
      };
      const t = p.toScreen(slot);
      const colour = bandColour(agent, interval);
      if (agent.detour && options.errors) {
        // His way round an obstacle, then on to his slot.
        line(ctx, [s, ...agent.detour.map((q) => p.toScreen(q))], '#c58cff', 2);
      } else if (options.errors && Number.isFinite(t.x)) line(ctx, [s, t], colour, 2);
      if (options.slots && Number.isFinite(t.x)) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(t.x - 5, t.y - 5);
        ctx.lineTo(t.x + 5, t.y + 5);
        ctx.moveTo(t.x + 5, t.y - 5);
        ctx.lineTo(t.x - 5, t.y + 5);
        ctx.stroke();
      }
      const soldier = f.state.soldiers.find((x) => x.id === agent.soldierId);
      if (options.heading && soldier) {
        line(ctx, [s, p.along(at, soldier.azimuth, 22)], '#ffffff', 2);
      }
      const v = behavior.agents.find((g) => g.soldierId === agent.soldierId);
      if (options.velocity && v) {
        const tip = p.toScreen({ x: at.x + v.vx * 2, y: at.y + v.vy * 2 });
        if (Number.isFinite(tip.x)) line(ctx, [s, tip], '#3fe0e0', 2);
      }
      let y = s.y + 16;
      if (options.errorLabels) {
        label(ctx, s.x + 8, y, `${agent.desire.error.toFixed(1)} m`, colour);
        y += 13;
      }
      if (options.states) {
        const extra = agent.straggling ? ' · straggling' : agent.stuck ? ' · stuck' : '';
        label(ctx, s.x + 8, y, STATE_TEXT[agent.desire.state] + extra, '#dfe6ec');
      }
      if (f.selected.has(agent.soldierId)) {
        ctx.strokeStyle = '#f2c230';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 11, 0, 2 * Math.PI);
        ctx.stroke();
      }
    }
  }
  if (options.trails) drawTrails(f);
  drawFlag(f);
  ctx.restore();
}

function drawTrails(f: OverlayFrame): void {
  const { ctx, projection: p, log } = f;
  const rate = log.tickRateHz;
  const from = Math.max(log.firstTick, Math.floor(f.tick - 20 * rate));
  const step = Math.max(1, Math.round(rate / 4));
  for (const id of log.soldierIds) {
    const points: MapPoint[] = [];
    for (let k = from; k <= f.tick; k += step) {
      const q = positionAt(log, id, k);
      if (q) points.push(q);
    }
    const now = positionAt(log, id, f.tick);
    if (now) points.push(now);
    line(
      ctx,
      points.map((q) => p.toScreen(q)),
      'rgba(255,255,255,0.35)',
      1.5,
    );
  }
}

function drawFlag(f: OverlayFrame): void {
  if (!f.destination) return;
  flag(f.ctx, f.projection.toScreen(f.destination), '#f2c230');
}

function routePoint(
  route: { x: readonly number[]; y: readonly number[]; cum: readonly number[] },
  s: number,
): MapPoint {
  let i = 0;
  while (i + 1 < route.cum.length && (route.cum[i + 1] ?? 0) < s) i += 1;
  const s0 = route.cum[i] ?? 0;
  const l = (route.cum[i + 1] ?? s0) - s0;
  const u = l > 0 ? (s - s0) / l : 0;
  const x0 = route.x[i] ?? 0;
  const y0 = route.y[i] ?? 0;
  return { x: x0 + ((route.x[i + 1] ?? x0) - x0) * u, y: y0 + ((route.y[i + 1] ?? y0) - y0) * u };
}

function line(
  ctx: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
  colour: string,
  width: number,
): void {
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  let pen = false;
  for (const q of points) {
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) {
      pen = false;
      continue;
    }
    if (pen) ctx.lineTo(q.x, q.y);
    else ctx.moveTo(q.x, q.y);
    pen = true;
  }
  ctx.stroke();
}

function flag(ctx: CanvasRenderingContext2D, at: { x: number; y: number }, colour: string): void {
  if (!Number.isFinite(at.x)) return;
  ctx.strokeStyle = '#0b1520';
  ctx.fillStyle = colour;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(at.x, at.y);
  ctx.lineTo(at.x, at.y - 26);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(at.x, at.y - 26);
  ctx.lineTo(at.x + 14, at.y - 21);
  ctx.lineTo(at.x, at.y - 16);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function label(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  colour: string,
): void {
  ctx.font = '600 11px system-ui, sans-serif';
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(15,19,24,0.72)';
  ctx.fillRect(x - 3, y - 11, w + 6, 15);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}
