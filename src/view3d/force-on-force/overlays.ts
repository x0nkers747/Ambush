import type { MotionLog } from '#exercise';
import {
  confidenceAt,
  type DeepReadonly,
  type FofForce,
  type FofTrack,
  type Side,
  type SimEvent,
  type SimState,
} from '#sim';
import type { GroundProjection, MapPoint } from '../ground-projection';
import { positionAt } from '../behavior-lab/overlays';

// The Force-on-Force Lab's overlays (docs/behavior-lab/force-on-force/05): a
// 2D canvas over the 3D view, drawn from the simulation's state and events
// only. A perspective chooses what is drawn of the enemy: the omniscient
// observer sees everything; a side sees only its own picture (its tracks, at
// the positions it last saw them).

export type Perspective = 'observer' | Side;

export interface FofOverlayOptions {
  /** Starts, destinations and the forces' movement orders. */
  readonly routes: boolean;
  /** Geometric sight lines (clear or not) from the selected soldier, or between leaders. */
  readonly sight: boolean;
  /** Each track's confidence, as a bar at its last known position. */
  readonly confidence: boolean;
  /** Known contacts: each side's tracks at their last known positions, by level. */
  readonly contacts: boolean;
  /** Each force's state, effectiveness and strength over its centre. */
  readonly forces: boolean;
  /** Bursts as tracers from the shooter to the aim point (aimed solid, area dashed). */
  readonly fire: boolean;
  /** Suppression rings (yellow suppressed, red pinned). */
  readonly suppression: boolean;
  /** Casualties marked. */
  readonly casualties: boolean;
  /** Detections, contact changes and casualties flash where they happen. */
  readonly events: boolean;
}

export const DEFAULT_FOF_OVERLAYS: FofOverlayOptions = {
  routes: true,
  sight: false,
  confidence: false,
  contacts: true,
  forces: true,
  fire: true,
  suppression: true,
  casualties: true,
  events: true,
};

export const FOF_OVERLAY_LABELS: Readonly<Record<keyof FofOverlayOptions, string>> = {
  routes: 'Starts, destinations, orders',
  sight: 'Geometric visibility (observer truth)',
  confidence: 'Detection confidence',
  contacts: 'Known contacts',
  forces: 'Organizational state',
  fire: 'Engagement (fire)',
  suppression: 'Suppression',
  casualties: 'Casualty status',
  events: 'Simulation events',
};

export const SIDE_COLOUR: Readonly<Record<Side, string>> = { BLUEFOR: '#5b9bff', OPFOR: '#ff5f52' };
const LEVEL_TEXT: Readonly<Record<FofTrack['level'], string>> = {
  possible: '?',
  detected: '!',
  identified: '✕',
  lost: '○',
};

export const PHASE_TEXT: Readonly<Record<FofForce['phase'], string>> = {
  moving: 'moving',
  possibleContact: 'possible contact: halted, observing',
  contact: 'CONTACT: halted, defensive posture',
  engaged: 'ENGAGED: exchanging fire',
  holding: 'contact lost: holding',
  assaulting: 'ASSAULTING: fire and movement',
  withdrawing: 'WITHDRAWING: breaking contact',
  atObjective: 'at objective',
  withdrawn: 'WITHDRAWN',
  ineffective: 'COMBAT INEFFECTIVE',
};

/** A sight line computed for the overlay (cached by the lab, not every frame). */
export interface SightLine {
  readonly from: MapPoint;
  readonly to: MapPoint;
  /** Share of the target's sample points in clear sight. */
  readonly visible: number;
}

export interface FofOverlayFrame {
  readonly ctx: CanvasRenderingContext2D;
  readonly projection: GroundProjection;
  readonly state: DeepReadonly<SimState>;
  readonly log: MotionLog;
  /** Fractional render tick and its time (s). */
  readonly tick: number;
  readonly seconds: number;
  readonly halfLife: number;
  readonly perspective: Perspective;
  readonly options: FofOverlayOptions;
  /** Events of the last few seconds up to the time shown. */
  readonly recent: readonly { readonly seconds: number; readonly event: SimEvent }[];
  readonly sight: readonly SightLine[];
  readonly selected: string | null;
  readonly markers: readonly {
    readonly at: MapPoint;
    readonly label: string;
    readonly colour: string;
  }[];
}

/** What a perspective may see of a side's soldiers: everything of its own side, only its tracks of the other. */
export function knows(perspective: Perspective, side: Side): boolean {
  return perspective === 'observer' || perspective === side;
}

export function drawFofOverlays(f: FofOverlayFrame): void {
  const { ctx, projection, state, options } = f;
  const fof = state.fof;
  const at = (id: string): MapPoint | null => positionAt(f.log, id, f.tick);
  ctx.lineCap = 'round';
  ctx.font = '600 12px system-ui, sans-serif';

  if (options.routes) {
    for (const m of f.markers) {
      const p = projection.toScreen(m.at, 0.1);
      ctx.strokeStyle = m.colour;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.stroke();
      text(ctx, m.label, p.x + 10, p.y + 4, m.colour);
    }
    for (const task of state.behavior?.tasks ?? []) {
      if (task.outcome !== null) continue;
      const side = fof?.forces.find((x) => x.unitId === task.unitId)?.side;
      if (!side || !knows(f.perspective, side)) continue;
      const pts = projection.line(task.route.x.map((x, i) => ({ x, y: task.route.y[i] ?? 0 })));
      ctx.strokeStyle = SIDE_COLOUR[side];
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      polyline(ctx, pts);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  if (options.sight) {
    for (const s of f.sight) {
      const a = projection.toScreen(s.from, 1.6);
      const b = projection.toScreen(s.to, 1.2);
      ctx.strokeStyle =
        s.visible <= 0
          ? 'rgba(160,160,160,0.25)'
          : `rgba(110,230,140,${String(0.35 + 0.6 * s.visible)})`;
      ctx.lineWidth = s.visible > 0 ? 1.5 : 1;
      if (s.visible <= 0) ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  if (fof && (options.contacts || options.confidence)) {
    for (const track of fof.tracks) {
      const observer = fof.forces[track.force];
      if (!observer || !knows(f.perspective, observer.side)) continue;
      const p = projection.toScreen(track.lastKnown, 0.5);
      const colour = SIDE_COLOUR[observer.side];
      if (options.contacts) {
        ctx.strokeStyle = colour;
        ctx.fillStyle = colour;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = track.level === 'lost' ? 0.4 : 0.75;
        ctx.setLineDash(track.level === 'possible' || track.level === 'lost' ? [3, 3] : []);
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 7);
        ctx.lineTo(p.x + 7, p.y);
        ctx.lineTo(p.x, p.y + 7);
        ctx.lineTo(p.x - 7, p.y);
        ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        text(ctx, LEVEL_TEXT[track.level], p.x - 4, p.y + 4, colour);
        ctx.globalAlpha = 1;
      }
      if (options.confidence) {
        const c = confidenceAt(track, f.seconds, f.halfLife);
        ctx.fillStyle = 'rgba(15,19,24,0.75)';
        ctx.fillRect(p.x - 14, p.y + 12, 28, 5);
        ctx.fillStyle = colour;
        ctx.fillRect(p.x - 14, p.y + 12, 28 * Math.min(1, c), 5);
      }
    }
  }

  if (fof && options.suppression) {
    for (const m of fof.soldiers) {
      if (m.level === 'none' && m.suppression < 0.1) continue;
      const soldier = state.soldiers.find((s) => s.id === m.soldierId);
      if (soldier?.status !== 'active' || !knows(f.perspective, soldier.side)) continue;
      const pos = at(m.soldierId);
      if (!pos) continue;
      const p = projection.toScreen(pos, 0.1);
      ctx.strokeStyle =
        m.level === 'pinned'
          ? '#ff5050'
          : m.level === 'suppressed'
            ? '#ffcf40'
            : 'rgba(255,207,64,0.45)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6 + 14 * m.suppression, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (options.fire) {
    for (const { seconds, event } of f.recent) {
      if (event.type !== 'fofFire') continue;
      const age = f.seconds - seconds;
      if (age < 0 || age > 0.8) continue;
      if (!knows(f.perspective, event.side) && f.perspective !== 'observer') {
        // A side sees the enemy's fire only where it lands near it.
        continue;
      }
      const from = at(event.shooterId);
      if (!from) continue;
      const a = projection.toScreen(from, 1.3);
      const b = projection.toScreen(event.aimPoint, 1);
      ctx.strokeStyle = event.hit ? '#ffffff' : SIDE_COLOUR[event.side];
      ctx.globalAlpha = 1 - age / 0.8;
      ctx.lineWidth = event.kind === 'aimed' ? 2 : 1.5;
      if (event.kind === 'area') ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }
  }

  if (options.casualties) {
    for (const s of state.soldiers) {
      if (s.status === 'active' || !knows(f.perspective, s.side)) continue;
      const pos = at(s.id);
      if (!pos) continue;
      const p = projection.toScreen(pos, 0.2);
      ctx.strokeStyle = '#ff3b30';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(p.x - 6, p.y - 6);
      ctx.lineTo(p.x + 6, p.y + 6);
      ctx.moveTo(p.x + 6, p.y - 6);
      ctx.lineTo(p.x - 6, p.y + 6);
      ctx.stroke();
    }
  }

  if (options.events) {
    for (const { seconds, event } of f.recent) {
      const age = f.seconds - seconds;
      if (age < 0 || age > 2.5) continue;
      let where: MapPoint | null = null;
      let colour = '#ffffff';
      if (
        event.type === 'contactObserved' &&
        (event.to === 'detected' || event.to === 'identified')
      ) {
        if (!knows(f.perspective, event.side)) continue;
        where = event.observerId ? at(event.observerId) : null;
        colour = SIDE_COLOUR[event.side];
      } else if (event.type === 'soldierIncapacitated') {
        where = at(event.soldierId);
        colour = '#ff3b30';
      } else if (event.type === 'suppressionChanged' && event.to === 'pinned') {
        where = at(event.soldierId);
        colour = '#ffcf40';
      }
      if (!where) continue;
      const p = projection.toScreen(where, 1);
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 1 - age / 2.5;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8 + 30 * (age / 2.5), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  if (fof && options.forces) {
    for (const force of fof.forces) {
      if (!knows(f.perspective, force.side) && f.perspective !== 'observer') continue;
      let x = 0;
      let y = 0;
      let n = 0;
      for (const id of force.memberIds) {
        const s = state.soldiers.find((q) => q.id === id);
        if (s?.status !== 'active') continue;
        const pos = at(id);
        if (!pos) continue;
        x += pos.x;
        y += pos.y;
        n += 1;
      }
      if (n === 0) continue;
      // An assault: an arrow to the position it is attacking (where it believes the enemy is).
      if (force.phase === 'assaulting' && force.objective) {
        const from = projection.toScreen({ x: x / n, y: y / n }, 1);
        const to = projection.toScreen(force.objective, 1);
        ctx.strokeStyle = SIDE_COLOUR[force.side];
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        polyline(ctx, [from, to]);
        ctx.setLineDash([]);
        const a = Math.atan2(to.y - from.y, to.x - from.x);
        ctx.beginPath();
        ctx.moveTo(to.x, to.y);
        ctx.lineTo(to.x - 12 * Math.cos(a - 0.4), to.y - 12 * Math.sin(a - 0.4));
        ctx.moveTo(to.x, to.y);
        ctx.lineTo(to.x - 12 * Math.cos(a + 0.4), to.y - 12 * Math.sin(a + 0.4));
        ctx.stroke();
      }
      const p = projection.toScreen({ x: x / n, y: y / n }, 6);
      const active = force.memberIds.filter(
        (id) => state.soldiers.find((s) => s.id === id)?.status === 'active',
      ).length;
      const line1 = `${force.side} · ${PHASE_TEXT[force.phase]}${force.boundUnit ? ` · ${force.boundUnit} bounding` : ''}`;
      const line2 = `effectiveness ${(force.effectiveness * 100).toFixed(0)} % · ${String(active)}/${String(force.memberIds.length)} up · suppression ${(force.meanSuppression * 100).toFixed(0)} %`;
      ctx.font = '600 12px system-ui, sans-serif';
      const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 12;
      ctx.fillStyle = 'rgba(15,19,24,0.78)';
      ctx.fillRect(p.x - w / 2, p.y - 40, w, 34);
      ctx.fillStyle = SIDE_COLOUR[force.side];
      ctx.fillRect(p.x - w / 2, p.y - 40, 3, 34);
      text(ctx, line1, p.x - w / 2 + 7, p.y - 26, '#e8edf2');
      ctx.font = '11px system-ui, sans-serif';
      text(ctx, line2, p.x - w / 2 + 7, p.y - 12, '#aab4be');
      // Effectiveness bar.
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(p.x - w / 2, p.y - 6, w, 3);
      ctx.fillStyle = SIDE_COLOUR[force.side];
      ctx.fillRect(p.x - w / 2, p.y - 6, w * Math.max(0, force.effectiveness), 3);
    }
  }
}

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, colour: string) {
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillText(s, x + 1, y + 1);
  ctx.fillStyle = colour;
  ctx.fillText(s, x, y);
}

function polyline(ctx: CanvasRenderingContext2D, pts: readonly { x: number; y: number }[]) {
  ctx.beginPath();
  let started = false;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      started = false;
      continue;
    }
    if (started) ctx.lineTo(p.x, p.y);
    else ctx.moveTo(p.x, p.y);
    started = true;
  }
  ctx.stroke();
}
