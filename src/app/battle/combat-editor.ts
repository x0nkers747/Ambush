import { emptyMotionSample } from '#exercise';
import type { OrderKind, Vec2 } from '#sim';
import type { MapEditor } from '#view2d';
import type { Combat, SquadStatus } from './combat';
import { chevron, OUTLINE, ring, SIDE_COLORS, unitSymbol, waypoint } from './map-editor';

// The Combat stage on the map (docs/constructive-simulation/04): every
// soldier where the battle has him at the time drawn (smooth between
// ticks), each squad's symbol at its soldiers' centre with its state, the
// orders it is carrying out and those given but not yet applied, and the
// bursts of the last moments. Drawn over the 2D map or the 3D view through
// either's projection; clicks select squads and give orders, in both views.

export interface CombatUi {
  /** The squad selected (either side), or `null`. */
  selected: string | null;
  /** The order a map click gives the selected squad, or `null` (select only). */
  tool: OrderKind | null;
  /** Append orders (else replace the plan); Shift inverts it for one click. */
  append: boolean;
  /** Whether Shift is held now. */
  shift: boolean;
}

/** How long a burst stays drawn (s of simulation). */
const BURST_SECONDS = 0.6;
const SQUAD_HIT_PX = 16;
const SOLDIER_HIT_PX = 6;

export function createCombatMapEditor(
  combat: () => Combat | null,
  ui: CombatUi,
  notify: (message: string) => void,
  organizationOf: (squadId: string) => 'squad' | 'fireTeam' | 'element3',
): MapEditor {
  let project: ((p: Vec2) => Vec2) | null = null;
  const sample = emptyMotionSample();

  /** Where each soldier is at the time drawn, from the motion log (interpolated). */
  const positions = (c: Combat) => {
    const log = c.session.motion;
    const seconds = c.renderSeconds;
    const exact = seconds * log.tickRateHz;
    const t0 = Math.floor(exact);
    const f = exact - t0;
    const out = new Map<string, { x: number; y: number; active: boolean }>();
    log.soldierIds.forEach((id, i) => {
      log.read(i, t0, sample);
      const ax = sample.x;
      const ay = sample.y;
      const active = sample.status === 'active';
      log.read(i, t0 + 1, sample);
      out.set(id, { x: ax + (sample.x - ax) * f, y: ay + (sample.y - ay) * f, active });
    });
    return out;
  };

  const squadAt = (screen: Vec2): SquadStatus | null => {
    const c = combat();
    const at = project;
    if (!c || !at) return null;
    const near = (p: Vec2, r: number) => Math.hypot(p.x - screen.x, p.y - screen.y) <= r;
    const squads = c.squads();
    for (const s of squads) if (near(at(s.centre), SQUAD_HIT_PX)) return s;
    const where = positions(c);
    for (const s of c.session.battle.squads) {
      for (const id of s.soldierIds) {
        const p = where.get(id);
        if (p?.active && near(at(p), SOLDIER_HIT_PX))
          return squads.find((q) => q.id === s.spec.id) ?? null;
      }
    }
    return null;
  };

  return {
    press(_point, screen, button) {
      const hit = squadAt(screen);
      if (!hit) return false;
      // With an order to give, a click on the selected squad's enemy is the
      // order's destination (an attack on it), not a new selection.
      const c = combat();
      const selected = c?.squad(ui.selected);
      if (button === 0 && ui.tool !== null && selected && hit.side !== selected.side) return false;
      if (button === 0) ui.selected = hit.id;
      return true;
    },
    click(point) {
      const c = combat();
      if (!c) return;
      if (ui.tool === null) {
        ui.selected = null;
        return;
      }
      if (ui.selected === null) {
        notify('Select a squad first (of either side), then click where its order takes it.');
        return;
      }
      c.order(ui.selected, ui.tool, point, ui.append !== ui.shift ? 'append' : 'replace');
    },
    cursor(_point, screen) {
      const hit = squadAt(screen);
      const selected = combat()?.squad(ui.selected);
      if (hit && !(ui.tool !== null && selected && hit.side !== selected.side)) return 'pointer';
      return ui.tool === null ? null : 'crosshair';
    },
    draw(ctx, toScreen) {
      project = toScreen;
      const c = combat();
      if (!c) return;
      const where = positions(c);
      const squads = c.squads();
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.font = '600 11px system-ui, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';

      // Orders: from the squad through the active and pending destinations; queued ones dashed white.
      const ordered = [...squads].sort(
        (a, b) => Number(a.id === ui.selected) - Number(b.id === ui.selected),
      );
      for (const s of ordered) {
        if (s.up === 0) continue;
        const isSelected = s.id === ui.selected;
        const color = SIDE_COLORS[s.side];
        const live = [s.active, ...s.pending].flatMap((x) => {
          const d = x?.destination;
          return x && d ? [{ kind: x.kind, destination: { x: d.x, y: d.y } }] : [];
        });
        const replaced = s.queued.some((q) => q.mode === 'replace');
        const queued = s.queued.flatMap((q) =>
          q.orders.flatMap((x) => {
            const d = x.destination;
            return d ? [{ kind: x.kind, destination: d }] : [];
          }),
        );
        const drawn = replaced ? queued : [...live, ...queued];
        if (drawn.length === 0) continue;
        const points = [s.centre, ...drawn.map((x) => x.destination)].map(toScreen);
        const firstQueued = replaced ? 0 : live.length;
        ctx.globalAlpha = isSelected ? 1 : 0.6;
        for (let i = 1; i < points.length; i += 1) {
          const a = points[i - 1];
          const b = points[i];
          if (!a || !b) continue;
          const isQueued = i - 1 >= firstQueued;
          ctx.setLineDash(isQueued ? [5, 5] : s.side === 'OPFOR' ? [7, 5] : []);
          for (const [width, stroke] of [
            [isSelected ? 5 : 4, OUTLINE],
            [isSelected ? 3 : 2, isQueued ? '#ffffff' : color],
          ] as const) {
            ctx.lineWidth = width;
            ctx.strokeStyle = stroke;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
          ctx.setLineDash([]);
          if (Math.hypot(b.x - a.x, b.y - a.y) > 40)
            chevron(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, Math.atan2(b.y - a.y, b.x - a.x), color);
        }
        drawn.forEach((x, k) => {
          const p = points[k + 1];
          if (p) waypoint(ctx, p, x.kind, k + 1, color, isSelected && k === 0, false);
        });
        ctx.globalAlpha = 1;
      }

      // Bursts of the last moments: shooter to aim point.
      const now = c.renderSeconds;
      const log = c.session.events;
      for (let i = log.length - 1; i >= 0; i -= 1) {
        const e = log[i];
        if (!e) continue;
        if (e.seconds < now - BURST_SECONDS) break;
        if (e.seconds > now || e.event.type !== 'fofFire') continue;
        const from = where.get(e.event.shooterId);
        if (!from) continue;
        const a = toScreen(from);
        const b = toScreen(e.event.aimPoint);
        ctx.globalAlpha = 1 - (now - e.seconds) / BURST_SECONDS;
        ctx.strokeStyle = e.event.side === 'BLUEFOR' ? '#9fd8ff' : '#ffb0a0';
        ctx.lineWidth = e.event.kind === 'aimed' ? 1.5 : 1;
        ctx.setLineDash(e.event.kind === 'aimed' ? [] : [2, 3]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;

      // Soldiers: active as dots, casualties as small grey crosses.
      for (const s of c.session.battle.squads) {
        const selected = s.spec.id === ui.selected;
        for (const id of s.soldierIds) {
          const m = where.get(id);
          if (!m) continue;
          const p = toScreen(m);
          if (!m.active) {
            ctx.strokeStyle = '#8a949e';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(p.x - 3, p.y - 3);
            ctx.lineTo(p.x + 3, p.y + 3);
            ctx.moveTo(p.x + 3, p.y - 3);
            ctx.lineTo(p.x - 3, p.y + 3);
            ctx.stroke();
            continue;
          }
          ctx.fillStyle = SIDE_COLORS[s.side];
          ctx.strokeStyle = OUTLINE;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, selected ? 3.5 : 2.6, 0, 2 * Math.PI);
          ctx.fill();
          ctx.stroke();
        }
      }

      // Squad symbols with their state.
      for (const s of ordered) {
        const isSelected = s.id === ui.selected;
        const p = toScreen(s.centre);
        if (s.up === 0) ctx.globalAlpha = 0.45;
        unitSymbol(ctx, p, { side: s.side, organization: organizationOf(s.id) }, isSelected, false);
        if (s.phase === 'engaged' || s.phase === 'contact' || s.phase === 'assaulting')
          ring(ctx, p, 20);
        ctx.textAlign = 'center';
        const label = `${s.name} · ${String(s.up)}/${String(s.total)}`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = OUTLINE;
        ctx.strokeText(label, p.x, p.y + 22);
        ctx.fillStyle = isSelected ? '#fff' : '#d8dde2';
        ctx.fillText(label, p.x, p.y + 22);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    },
  };
}
