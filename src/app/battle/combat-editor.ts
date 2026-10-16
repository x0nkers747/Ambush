import { emptyMotionSample, type MotionLog } from '#exercise';
import type { Battle } from '#exercise/battle';
import type { OrderKind, Vec2, ActionsOn, KillZone } from '#sim';
import type { MapEditor } from '#view2d';
import { SECOND_CLICK } from './planner';
import type { TimedEvent } from './session';
import { vehicleActivity, type SquadStatus, type VehicleStatus } from './status';
import {
  defenceSector,
  drawRoute,
  chevron,
  killZone,
  OUTLINE,
  ring,
  SIDE_COLORS,
  unitSymbol,
  pxPerMetre,
  vehicleMarker,
  vehicleSymbolAt,
  waypoint,
} from './map-editor';

// The Combat stage on the map (docs/constructive-simulation/04): every
// soldier where the battle has him at the time drawn (smooth between
// ticks), each squad's symbol at its soldiers' centre with its state, the
// orders it is carrying out and those given but not yet applied, and the
// bursts of the last moments. Drawn over the 2D map or the 3D view through
// either's projection; clicks select squads and give orders, in both views.

/**
 * A battle as the map shows it: live (Combat) or replayed (the After-Action
 * Review). `order` is there only where orders can be given.
 */
export interface BattleDisplay {
  readonly motion: MotionLog;
  readonly events: readonly TimedEvent[];
  /** The time drawn (simulation seconds). */
  readonly renderSeconds: number;
  readonly battle: Pick<Battle, 'squads'>;
  squads(): readonly SquadStatus[];
  squad(id: string | null): SquadStatus | undefined;
  /** The vehicles (docs/vehicles.md). */
  vehicles(): readonly VehicleStatus[];
  orderVehicle?(vehicleId: string, point: Vec2, mode: 'replace' | 'append'): boolean;
  order?(
    squadId: string,
    kind: OrderKind,
    point: Vec2,
    mode: 'replace' | 'append',
    actionsOn: ActionsOn | null,
    killZoneAt?: Vec2 | null,
  ): boolean;
}

export interface CombatUi {
  /** The squad (or vehicle) selected (either side), or `null`. */
  selected: string | null;
  /** The order a map click gives the selected squad, or `null` (select only). */
  tool: OrderKind | null;
  /** Append orders (else replace the plan); Shift inverts it for one click. */
  append: boolean;
  /** Whether Shift is held now. */
  shift: boolean;
  /** What a squad ordered now does on contact (`null`: its order kind's). */
  actionsOn: ActionsOn | null;
  /**
   * An ambush being given: its position, clicked first, for the selected
   * squad; the next click sets its kill zone and gives the order. `null`: none.
   */
  ambush: { readonly squadId: string; readonly at: Vec2 } | null;
}

/** The ambush or defensive position being given to the selected squad, if any (its second click is next). */
export function pendingAmbush(ui: CombatUi): Vec2 | null {
  return (ui.tool === 'ambush' || ui.tool === 'defend') && ui.ambush?.squadId === ui.selected
    ? ui.ambush.at
    : null;
}

/** How long a burst stays drawn (s of simulation). */
const BURST_SECONDS = 0.6;
/** How long a grenade shows on the map (s), and its effect radius drawn (m; the M203's). */
const GRENADE_SECONDS = 2;
const GRENADE_EFFECT_M = 10;
const SQUAD_HIT_PX = 16;
const SOLDIER_HIT_PX = 6;

export function createCombatMapEditor(
  combat: () => BattleDisplay | null,
  ui: CombatUi,
  notify: (message: string) => void,
  organizationOf: (squadId: string) => 'squad' | 'fireTeam' | 'element3',
): MapEditor {
  let project: ((p: Vec2) => Vec2) | null = null;
  const sample = emptyMotionSample();
  /** Whether the view drawn last is the 3D view. */
  let perspective = false;

  /** Where each soldier is at the time drawn, from the motion log (interpolated). */
  const positions = (c: BattleDisplay) => {
    const log = c.motion;
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
    for (const s of c.battle.squads) {
      for (const id of s.soldierIds) {
        const p = where.get(id);
        if (p?.active && near(at(p), SOLDIER_HIT_PX))
          return squads.find((q) => q.id === s.spec.id) ?? null;
      }
    }
    return null;
  };

  /** The vehicle under `screen`, where the motion log has it at the time drawn. */
  const vehicleAt = (screen: Vec2): VehicleStatus | null => {
    const c = combat();
    const at = project;
    if (!c || !at) return null;
    const vehicles = c.vehicles();
    if (vehicles.length === 0) return null;
    const where = positions(c);
    for (const v of vehicles) {
      const ground = where.get(v.id) ?? v.position;
      const p = at(ground);
      const s = vehicleSymbolAt(p, perspective, pxPerMetre(at, ground));
      if (
        Math.hypot(p.x - screen.x, p.y - screen.y) <= SQUAD_HIT_PX ||
        Math.hypot(s.x - screen.x, s.y - screen.y) <= SQUAD_HIT_PX
      )
        return v;
    }
    return null;
  };

  return {
    press(_point, screen, button) {
      const car = vehicleAt(screen);
      if (car) {
        if (button === 0) ui.selected = car.id;
        return true;
      }
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
      if (ui.tool === null || !c.order) {
        ui.selected = null;
        return;
      }
      if (ui.selected === null) {
        notify('Select a squad first (of either side), then click where its order takes it.');
        return;
      }
      const mode = ui.append !== ui.shift ? 'append' : 'replace';
      const car = c.vehicles().find((v) => v.id === ui.selected);
      if (car) {
        if (ui.tool !== 'move') {
          notify(`${car.name} is a vehicle: it only takes Move orders.`);
          return;
        }
        c.orderVehicle?.(car.id, point, mode);
        return;
      }
      if (ui.tool === 'ambush' || ui.tool === 'defend') {
        // First its position; then its kill zone (an ambush) or direction (a defence), which gives the order.
        const at = pendingAmbush(ui);
        if (!at) {
          ui.ambush = { squadId: ui.selected, at: point };
          notify(ui.tool === 'ambush' ? SECOND_CLICK.killZone : SECOND_CLICK.sector);
          return;
        }
        if (c.order(ui.selected, ui.tool, at, mode, ui.actionsOn, point)) ui.ambush = null;
        return;
      }
      c.order(ui.selected, ui.tool, point, mode, ui.actionsOn);
    },
    cursor(_point, screen) {
      if (vehicleAt(screen)) return 'pointer';
      const hit = squadAt(screen);
      const selected = combat()?.squad(ui.selected);
      if (hit && !(ui.tool !== null && selected && hit.side !== selected.side)) return 'pointer';
      return ui.tool === null ? null : 'crosshair';
    },
    draw(ctx, toScreen, inPerspective = false) {
      project = toScreen;
      perspective = inPerspective;
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
      // Sectors of defend orders (active, pending and queued), under the routes.
      for (const s of ordered) {
        if (s.up === 0) continue;
        const orders = [s.active, ...s.pending, ...s.queued.flatMap((q) => q.orders)];
        let n = 0;
        for (const x of orders) {
          if (!x?.sector || !x.destination) continue;
          n += 1;
          defenceSector(
            ctx,
            x.destination,
            {
              facingDeg: (x.sector.facing * 180) / Math.PI,
              arcDeg: (x.sector.arc * 180) / Math.PI,
            },
            toScreen,
            SIDE_COLORS[s.side],
            n,
            s.id === ui.selected,
            false,
          );
        }
      }
      // Kill zones of ambush orders (active, pending and queued), under the routes.
      for (const s of ordered) {
        if (s.up === 0) continue;
        const zones: { zone: KillZone; from: Vec2 }[] = [];
        for (const x of [s.active, ...s.pending]) {
          if (x?.killZone && x.destination) zones.push({ zone: x.killZone, from: x.destination });
        }
        for (const q of s.queued) {
          for (const x of q.orders) {
            if (x.killZone && x.destination) zones.push({ zone: x.killZone, from: x.destination });
          }
        }
        zones.forEach(({ zone, from }, k) => {
          killZone(
            ctx,
            zone,
            toScreen(from),
            toScreen,
            SIDE_COLORS[s.side],
            k + 1,
            s.id === ui.selected,
            false,
          );
        });
      }
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

      // The ambush position being given, waiting for its kill zone.
      const pending = pendingAmbush(ui);
      const pendingSquad = c.squad(ui.selected);
      if (pending && pendingSquad) {
        const p = toScreen(pending);
        const from = toScreen(pendingSquad.centre);
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.setLineDash([]);
        waypoint(
          ctx,
          p,
          ui.tool === 'defend' ? 'defend' : 'ambush',
          1,
          SIDE_COLORS[pendingSquad.side],
          true,
          false,
        );
      }

      // Bursts of the last moments: shooter to aim point (2D only: the 3D view
      // shows them as tracers, and grenades as explosions).
      const now = c.renderSeconds;
      const log = perspective ? [] : c.events;
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

      // Grenades of the last moments: an arc from the grenadier to the burst, and its effect radius.
      for (let i = log.length - 1; i >= 0; i -= 1) {
        const e = log[i];
        if (!e) continue;
        if (e.seconds < now - GRENADE_SECONDS) break;
        if (e.seconds > now || e.event.type !== 'fofGrenade') continue;
        const from = where.get(e.event.shooterId);
        if (!from) continue;
        const a = toScreen(from);
        const b = toScreen(e.event.impact);
        const edge = toScreen({ x: e.event.impact.x + GRENADE_EFFECT_M, y: e.event.impact.y });
        const radius = Math.max(3, Math.hypot(edge.x - b.x, edge.y - b.y));
        const fade = 1 - (now - e.seconds) / GRENADE_SECONDS;
        ctx.globalAlpha = fade;
        ctx.strokeStyle = e.event.side === 'BLUEFOR' ? '#9fd8ff' : '#ffb0a0';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        // A shallow arc: the grenade's high trajectory, seen from above.
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(
          mx - ((b.y - a.y) / Math.max(1, len)) * len * 0.15,
          my + ((b.x - a.x) / Math.max(1, len)) * len * 0.15,
          b.x,
          b.y,
        );
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255, 196, 90, 0.35)';
        ctx.strokeStyle = '#ffc45a';
        ctx.beginPath();
        ctx.arc(b.x, b.y, radius, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Soldiers: active as dots, casualties as small grey crosses.
      for (const s of c.battle.squads) {
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

      // Vehicles: where each still drives, its symbol where it is, and its state.
      for (const v of c.vehicles()) {
        const isSelected = v.id === ui.selected;
        const at = where.get(v.id) ?? v.position;
        const color = SIDE_COLORS[v.side];
        if (v.route.length > 0) {
          const points = [at, ...v.route].map(toScreen);
          drawRoute(ctx, points, color, isSelected, [12, 4, 2, 4]);
          v.route.forEach((d, k) => {
            waypoint(ctx, toScreen(d), 'move', k + 1, color, isSelected && k === 0, false);
          });
        }
      }
      for (const v of c.vehicles()) {
        const isSelected = v.id === ui.selected;
        const ground = where.get(v.id) ?? v.position;
        const p = vehicleMarker(
          ctx,
          toScreen(ground),
          v.side,
          isSelected,
          false,
          inPerspective,
          pxPerMetre(toScreen, ground),
        );
        ctx.textAlign = 'center';
        const label = `${v.name} · ${vehicleActivity(v)}`;
        ctx.lineWidth = 3;
        ctx.strokeStyle = OUTLINE;
        ctx.strokeText(label, p.x, p.y + 22);
        ctx.fillStyle = isSelected ? '#fff' : '#d8dde2';
        ctx.fillText(label, p.x, p.y + 22);
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
        const label = `${s.name} · ${String(s.up)}/${String(s.total)} · ${s.activity.word}`;
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
