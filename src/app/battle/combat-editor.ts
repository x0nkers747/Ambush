import { emptyArticulation, emptyMotionSample, type MotionLog } from '#exercise';
import {
  addOrder,
  deleteOrder,
  killZoneSpec,
  moveKillZone,
  moveOrder,
  plannedOrderOf,
  resizeDefendArc,
  resizeKillZone,
  setDefendSector,
  setKillZone,
  type Battle,
  type BattleEdit,
  type BattleScenarioDefinition,
  type PlannedOrder,
} from '#exercise/battle';
import {
  killZoneCorners,
  type OrderKind,
  type TerrainDataset,
  type Vec2,
  type VehicleDestination,
} from '#sim';
import type { MapEditor } from '#view2d';
import { SECOND_CLICK } from './planner';
import type { TimedEvent } from './session';
import { vehicleActivity, type SquadStatus, type VehicleStatus } from './status';
import {
  arcHandle,
  defenceSector,
  drawRoute,
  facingHandle,
  killZone,
  OUTLINE,
  ring,
  SIDE_COLORS,
  unitSymbol,
  pxPerMetre,
  routeLine,
  vehicleHull,
  vehicleMarker,
  vehicleSymbolAt,
  waypoint,
} from './map-editor';

// The Combat stage on the map (docs/constructive-simulation/04): every
// soldier where the battle has him at the time drawn (smooth between
// ticks), each squad's symbol at its soldiers' centre with its state, its
// plan as it stands, and the bursts of the last moments. Drawn over the 2D
// map or the 3D view through either's projection.
//
// Live, the plans are edited as in planning: click a squad or vehicle to
// select it, a waypoint to select its order; drag a waypoint to move it,
// right-click it to delete it; drag the selected order's kill zone (its
// corners and centre) or sector (its square and circle). With an order
// picked, a click adds one after the selected order (an ambush or defence:
// its position, then its kill zone or direction). Each edit is given to the
// squad at once (`PlanEditing.editPlan`).

/** The plans of a live battle and their edits (`Combat`'s). */
export interface PlanEditing {
  readonly terrain: TerrainDataset;
  plan(squadId: string): readonly PlannedOrder[];
  editPlan(squadId: string, change: (d: BattleScenarioDefinition) => BattleEdit): boolean;
  previewPlan(
    squadId: string,
    change: (d: BattleScenarioDefinition) => BattleEdit,
  ): readonly PlannedOrder[] | null;
  vehicleRoute(vehicleId: string): readonly VehicleDestination[];
  setVehicleRoute(vehicleId: string, route: readonly VehicleDestination[]): boolean;
}

/**
 * A battle as the map shows it: live (Combat) or replayed (the After-Action
 * Review). `edit` is there only where plans can be edited (live, not ended).
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
  readonly edit?: PlanEditing;
  /** The battlefield (routes preferring roads are drawn along them). */
  readonly terrain?: TerrainDataset;
}

export interface CombatUi {
  /** The squad (or vehicle) selected (either side), or `null`. */
  selected: string | null;
  /** The selected order of its plan (a waypoint of a vehicle's route), or `null`. */
  selectedOrder: number | null;
  /** The order a map click gives the selected squad, or `null` (select only). */
  tool: OrderKind | null;
  /**
   * An ambush or defence being given: its position, clicked first, for the
   * selected squad; the next click sets its kill zone or direction and gives
   * it. `null`: none.
   */
  ambush: { readonly squadId: string; readonly at: Vec2 } | null;
  /** An order of the plan whose kill zone or direction the next click sets again ("Set kill zone"). */
  second: {
    readonly squadId: string;
    readonly index: number;
    readonly kind: 'killZone' | 'sector';
  } | null;
}

/** The ambush or defensive position being given to the selected squad, if any (its second click is next). */
export function pendingAmbush(ui: CombatUi): Vec2 | null {
  return (ui.tool === 'ambush' || ui.tool === 'defend') && ui.ambush?.squadId === ui.selected
    ? ui.ambush.at
    : null;
}

/** A squad's plan as the map draws it: as edited live, else (the review) its orders at the time. */
export function shownPlan(c: BattleDisplay, s: SquadStatus): readonly PlannedOrder[] {
  if (c.edit) return c.edit.plan(s.id);
  return [s.active, ...s.pending].flatMap((o) => {
    const p = o ? plannedOrderOf(o) : null;
    return p ? [p] : [];
  });
}

/** How long a burst stays drawn (s of simulation). */
const BURST_SECONDS = 0.6;
/** How long a heavy shot's line stays drawn (s of simulation). */
const HEAVY_SECONDS = 1.2;
/** How long a grenade shows on the map (s), and its effect radius drawn (m; the M203's). */
const GRENADE_SECONDS = 2;
const GRENADE_EFFECT_M = 10;
const SQUAD_HIT_PX = 16;
const SOLDIER_HIT_PX = 6;
const WAYPOINT_HIT_PX = 11;
const HANDLE_HIT_PX = 9;

/** What is under the pointer of a live plan. */
type PlanHit =
  | { readonly kind: 'waypoint'; readonly squadId: string; readonly index: number }
  | {
      readonly kind: 'corner';
      readonly squadId: string;
      readonly index: number;
      readonly corner: number;
    }
  | { readonly kind: 'zone'; readonly squadId: string; readonly index: number }
  | { readonly kind: 'arc'; readonly squadId: string; readonly index: number }
  | { readonly kind: 'facing'; readonly squadId: string; readonly index: number }
  | { readonly kind: 'vehicleWaypoint'; readonly vehicleId: string; readonly index: number };

const toVec = (p: { east: number; north: number }): Vec2 => ({ x: p.east, y: p.north });

export function createCombatMapEditor(
  combat: () => BattleDisplay | null,
  ui: CombatUi,
  notify: (message: string) => void,
  organizationOf: (squadId: string) => 'squad' | 'fireTeam' | 'element3',
): MapEditor {
  let project: ((p: Vec2) => Vec2) | null = null;
  const sample = emptyMotionSample();
  const articulation = emptyArticulation();
  /** Whether the view drawn last is the 3D view. */
  let perspective = false;
  /** A drag of a live plan: what was pressed, and where the pointer is now. */
  let drag: { readonly hit: PlanHit; point: Vec2 | null } | null = null;

  /** Where each soldier is at the time drawn, from the motion log (interpolated). */
  const positions = (c: BattleDisplay) => {
    const log = c.motion;
    const seconds = c.renderSeconds;
    const exact = seconds * log.tickRateHz;
    const t0 = Math.floor(exact);
    const f = exact - t0;
    const out = new Map<string, { x: number; y: number; active: boolean; azimuth: number }>();
    log.soldierIds.forEach((id, i) => {
      log.read(i, t0, sample);
      const ax = sample.x;
      const ay = sample.y;
      const az = sample.azimuth;
      const active = sample.status === 'active';
      log.read(i, t0 + 1, sample);
      let turn = sample.azimuth - az;
      turn -= 2 * Math.PI * Math.round(turn / (2 * Math.PI));
      out.set(id, {
        x: ax + (sample.x - ax) * f,
        y: ay + (sample.y - ay) * f,
        active,
        azimuth: az + turn * f,
      });
    });
    return out;
  };
  /** A vehicle's articulation at the time drawn (its mounts and condition), from the motion log. */
  const articulationOf = (c: BattleDisplay, id: string) => {
    const log = c.motion;
    const index = log.indexOf(id);
    if (index < 0) return null;
    return log.readArticulation(index, Math.round(c.renderSeconds * log.tickRateHz), articulation);
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

  /** The edit a drag of `hit` to `point` makes. */
  const changeFor =
    (edit: PlanEditing, hit: PlanHit, point: Vec2) =>
    (d: BattleScenarioDefinition): BattleEdit => {
      switch (hit.kind) {
        case 'waypoint':
          return moveOrder(edit.terrain, d, hit.squadId, hit.index, point);
        case 'corner':
          return resizeKillZone(edit.terrain, d, hit.squadId, hit.index, hit.corner, point);
        case 'zone':
          return moveKillZone(edit.terrain, d, hit.squadId, hit.index, point);
        case 'arc':
          return resizeDefendArc(d, hit.squadId, hit.index, point);
        case 'facing':
          return setDefendSector(d, hit.squadId, hit.index, point);
        case 'vehicleWaypoint':
          return { ok: true, definition: d };
      }
    };

  /** A squad's plan as drawn now: while dragging it, as the drag would leave it. */
  const planNow = (c: BattleDisplay, s: SquadStatus): readonly PlannedOrder[] => {
    const edit = c.edit;
    if (edit && drag?.point && drag.hit.kind !== 'vehicleWaypoint' && drag.hit.squadId === s.id)
      return edit.previewPlan(s.id, changeFor(edit, drag.hit, drag.point)) ?? edit.plan(s.id);
    return shownPlan(c, s);
  };
  /** A vehicle's route as drawn now: while dragging a waypoint of it, there. */
  const routeNow = (c: BattleDisplay, v: VehicleStatus): readonly VehicleDestination[] => {
    const route = c.edit ? c.edit.vehicleRoute(v.id) : v.route;
    if (drag?.point && drag.hit.kind === 'vehicleWaypoint' && drag.hit.vehicleId === v.id) {
      const { index } = drag.hit;
      const point = drag.point;
      return route.map((p, k) => (k === index ? { ...p, x: point.x, y: point.y } : p));
    }
    return route;
  };

  /** The live plan's handle or waypoint under `screen`: the selected order's handles first. */
  const planHitAt = (screen: Vec2): PlanHit | null => {
    const c = combat();
    const at = project;
    if (!c?.edit || !at) return null;
    const near = (p: Vec2, r: number) => Math.hypot(p.x - screen.x, p.y - screen.y) <= r;
    const squads = c.squads().filter((s) => s.up > 0);
    const selected = squads.find((s) => s.id === ui.selected);
    if (selected && ui.selectedOrder !== null) {
      const index = ui.selectedOrder;
      const order = c.edit.plan(selected.id)[index];
      const id = selected.id;
      if (order?.killZone) {
        const corners = killZoneCorners(killZoneSpec(order.killZone));
        for (let corner = 0; corner < corners.length; corner += 1) {
          const p = corners[corner];
          if (p && near(at(p), HANDLE_HIT_PX))
            return { kind: 'corner', squadId: id, index, corner };
        }
        if (near(at(toVec(order.killZone.centre)), HANDLE_HIT_PX))
          return { kind: 'zone', squadId: id, index };
      }
      if (order?.sector) {
        const from = toVec(order.destination);
        if (near(at(arcHandle(from, order.sector)), HANDLE_HIT_PX))
          return { kind: 'arc', squadId: id, index };
        if (near(at(facingHandle(from, order.sector)), HANDLE_HIT_PX))
          return { kind: 'facing', squadId: id, index };
      }
    }
    const ordered = selected ? [selected, ...squads.filter((s) => s !== selected)] : squads;
    for (const s of ordered) {
      const plan = c.edit.plan(s.id);
      for (let k = plan.length - 1; k >= 0; k -= 1) {
        const o = plan[k];
        if (o && near(at(toVec(o.destination)), WAYPOINT_HIT_PX))
          return { kind: 'waypoint', squadId: s.id, index: k };
      }
    }
    const vehicles = c.vehicles();
    const car = vehicles.find((v) => v.id === ui.selected);
    for (const v of car ? [car, ...vehicles.filter((x) => x !== car)] : vehicles) {
      const route = c.edit.vehicleRoute(v.id);
      for (let k = route.length - 1; k >= 0; k -= 1) {
        const p = route[k];
        if (p && near(at(p), WAYPOINT_HIT_PX))
          return { kind: 'vehicleWaypoint', vehicleId: v.id, index: k };
      }
    }
    return null;
  };

  /** Selects a squad or vehicle, and an order of its plan. */
  const select = (id: string | null, order: number | null = null) => {
    if (id !== ui.selected) {
      ui.ambush = null;
      ui.second = null;
    }
    ui.selected = id;
    ui.selectedOrder = order;
  };

  return {
    press(_point, screen, button) {
      const c = combat();
      const hit = planHitAt(screen);
      if (hit && c?.edit) {
        if (button === 2) {
          // Right-click a waypoint: its order deleted.
          if (hit.kind === 'waypoint') {
            const { squadId, index } = hit;
            if (c.edit.editPlan(squadId, (d) => deleteOrder(d, squadId, index)))
              select(squadId, index > 0 ? index - 1 : null);
          } else if (hit.kind === 'vehicleWaypoint') {
            const route = c.edit.vehicleRoute(hit.vehicleId).filter((_, k) => k !== hit.index);
            if (c.edit.setVehicleRoute(hit.vehicleId, route))
              select(hit.vehicleId, hit.index > 0 ? hit.index - 1 : null);
          }
          return true;
        }
        if (button !== 0) return false;
        if (hit.kind === 'vehicleWaypoint') select(hit.vehicleId, hit.index);
        else select(hit.squadId, hit.index);
        drag = { hit, point: null };
        return true;
      }
      const car = vehicleAt(screen);
      if (car) {
        if (button === 0) select(car.id);
        return true;
      }
      const squad = squadAt(screen);
      if (!squad) return false;
      // With an order to give, a click on the selected squad's enemy is the
      // order's destination (an attack on it), not a new selection.
      const selected = c?.squad(ui.selected);
      if (button === 0 && ui.tool !== null && selected && squad.side !== selected.side)
        return false;
      if (button === 0) select(squad.id);
      return true;
    },
    drag(point) {
      if (drag) drag.point = point;
    },
    drop() {
      const c = combat();
      const done = drag;
      drag = null;
      if (!c?.edit || !done?.point) return;
      const { hit, point } = done;
      if (hit.kind === 'vehicleWaypoint') {
        const route = c.edit
          .vehicleRoute(hit.vehicleId)
          .map((p, k) => (k === hit.index ? point : p));
        c.edit.setVehicleRoute(hit.vehicleId, route);
        return;
      }
      c.edit.editPlan(hit.squadId, changeFor(c.edit, hit, point));
    },
    click(point) {
      const c = combat();
      const edit = c?.edit;
      if (!c || !edit) {
        select(null);
        return;
      }
      // "Set kill zone" / "Set direction" of an order of the plan: this click sets it.
      const second = ui.second?.squadId === ui.selected ? ui.second : null;
      if (second) {
        const { squadId, index } = second;
        const done = edit.editPlan(squadId, (d) =>
          second.kind === 'killZone'
            ? setKillZone(edit.terrain, d, squadId, index, point)
            : setDefendSector(d, squadId, index, point),
        );
        if (done) ui.second = null;
        return;
      }
      if (ui.tool === null) {
        select(null);
        return;
      }
      if (ui.selected === null) {
        notify('Select a squad first (of either side), then click where its order takes it.');
        return;
      }
      const car = c.vehicles().find((v) => v.id === ui.selected);
      if (car) {
        if (ui.tool !== 'move') {
          notify(`${car.name} is a vehicle: it only takes Move orders.`);
          return;
        }
        const route = edit.vehicleRoute(car.id);
        const at = ui.selectedOrder === null ? route.length : ui.selectedOrder + 1;
        if (edit.setVehicleRoute(car.id, [...route.slice(0, at), point, ...route.slice(at)]))
          select(car.id, at);
        return;
      }
      const squadId = ui.selected;
      const kind = ui.tool;
      // After the selected order, or at the end of the plan.
      const at = ui.selectedOrder === null ? edit.plan(squadId).length : ui.selectedOrder + 1;
      if (kind === 'ambush' || kind === 'defend') {
        // First its position; then its kill zone (an ambush) or direction (a defence), which gives the order.
        const position = pendingAmbush(ui);
        if (!position) {
          ui.ambush = { squadId, at: point };
          notify(kind === 'ambush' ? SECOND_CLICK.killZone : SECOND_CLICK.sector);
          return;
        }
        const done = edit.editPlan(squadId, (d) => {
          const added = addOrder(edit.terrain, d, squadId, kind, position, at);
          if (!added.ok) return added;
          return kind === 'ambush'
            ? setKillZone(edit.terrain, added.definition, squadId, at, point)
            : setDefendSector(added.definition, squadId, at, point);
        });
        if (done) {
          ui.ambush = null;
          select(squadId, at);
        }
        return;
      }
      if (edit.editPlan(squadId, (d) => addOrder(edit.terrain, d, squadId, kind, point, at)))
        select(squadId, at);
    },
    cursor(_point, screen) {
      const hit = planHitAt(screen);
      if (hit) {
        if (hit.kind === 'corner' || hit.kind === 'arc') return 'nwse-resize';
        if (hit.kind === 'facing') return 'grab';
        return 'move';
      }
      if (vehicleAt(screen)) return 'pointer';
      const squad = squadAt(screen);
      const selected = combat()?.squad(ui.selected);
      if (squad && !(ui.tool !== null && selected && squad.side !== selected.side))
        return 'pointer';
      return ui.tool === null && ui.second === null ? null : 'crosshair';
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

      // Plans: from the squad through its orders as they stand; the selected
      // order's kill zone or sector with its handles (live).
      const ordered = [...squads].sort(
        (a, b) => Number(a.id === ui.selected) - Number(b.id === ui.selected),
      );
      const plans = new Map(ordered.map((s) => [s.id, planNow(c, s)]));
      const editable = c.edit !== undefined;
      for (const s of ordered) {
        if (s.up === 0) continue;
        const isSquad = s.id === ui.selected;
        (plans.get(s.id) ?? []).forEach((x, k) => {
          const isSelected = isSquad && ui.selectedOrder === k;
          if (x.sector)
            defenceSector(
              ctx,
              toVec(x.destination),
              x.sector,
              toScreen,
              SIDE_COLORS[s.side],
              k + 1,
              isSelected,
              isSelected && editable,
            );
          if (x.killZone)
            killZone(
              ctx,
              killZoneSpec(x.killZone),
              toScreen(toVec(x.destination)),
              toScreen,
              SIDE_COLORS[s.side],
              k + 1,
              isSelected,
              isSelected && editable,
            );
        });
      }
      for (const s of ordered) {
        if (s.up === 0) continue;
        const plan = plans.get(s.id) ?? [];
        if (plan.length === 0) continue;
        const isSelected = s.id === ui.selected;
        const color = SIDE_COLORS[s.side];
        const points = [s.centre, ...plan.map((x) => toVec(x.destination))].map(toScreen);
        const stops = plan.map((x) => ({
          point: toVec(x.destination),
          followRoads: x.followRoads === true,
        }));
        const line = c.terrain
          ? routeLine(c.terrain, s.centre, stops)
          : [s.centre, ...stops.map((x) => x.point)];
        drawRoute(ctx, line.map(toScreen), color, isSelected, s.side === 'OPFOR' ? [7, 5] : []);
        ctx.globalAlpha = isSelected ? 1 : 0.6;
        plan.forEach((x, k) => {
          const p = points[k + 1];
          if (p)
            waypoint(ctx, p, x.kind, k + 1, color, isSelected && ui.selectedOrder === k, false);
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

      // Heavy fire of the last moments (vehicles' guns, anti-tank weapons): muzzle to where it
      // landed, a missile as a dot along its flight until it arrives, a burst where it struck.
      for (let i = log.length - 1; i >= 0; i -= 1) {
        const e = log[i];
        if (!e) continue;
        if (e.seconds < now - HEAVY_SECONDS) break;
        if (e.seconds > now || e.event.type !== 'vehicleFire') continue;
        const ev = e.event;
        const a = toScreen(ev.from);
        const b = toScreen(ev.impact);
        const color = ev.side === 'BLUEFOR' ? '#9fd8ff' : '#ffb0a0';
        if (ev.missileId !== null && ev.impactAt !== null) {
          const flight = Math.max(0.05, ev.impactAt - ev.atSeconds);
          const f = (now - ev.atSeconds) / flight;
          if (f <= 1) {
            ctx.globalAlpha = 0.8;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#ffd36b';
            ctx.beginPath();
            ctx.arc(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, 3, 0, 2 * Math.PI);
            ctx.fill();
          }
          continue;
        }
        const age = now - e.seconds;
        if (age > HEAVY_SECONDS) continue;
        ctx.globalAlpha = 1 - age / HEAVY_SECONDS;
        ctx.strokeStyle = color;
        ctx.lineWidth = ev.slot === 'main' || ev.shooter === 'soldier' ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        if (ev.hit && ev.target === 'vehicle') {
          ctx.fillStyle = '#ffc45a';
          ctx.beginPath();
          ctx.arc(b.x, b.y, 5, 0, 2 * Math.PI);
          ctx.fill();
        }
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
        const route = routeNow(c, v);
        if (route.length > 0) {
          const stops = route.map((p) => ({
            point: { x: p.x, y: p.y },
            followRoads: p.followRoads === true,
          }));
          const line = c.terrain
            ? routeLine(c.terrain, at, stops)
            : [at, ...stops.map((x) => x.point)];
          drawRoute(ctx, line.map(toScreen), color, isSelected, [12, 4, 2, 4]);
          route.forEach((d, k) => {
            const selected = isSelected && ui.selectedOrder === k;
            waypoint(ctx, toScreen(d), 'move', k + 1, color, selected, false);
          });
        }
      }
      for (const v of c.vehicles()) {
        const isSelected = v.id === ui.selected;
        const ground = where.get(v.id) ?? v.position;
        const heading = where.get(v.id)?.azimuth ?? v.heading;
        const art = articulationOf(c, v.id);
        const condition = art?.condition ?? v.condition;
        if (!inPerspective) {
          // Its hull to scale, and its main mount's bearing (the first mount's, on the hull).
          const turret = art ? (art.mounts[0] ?? 0) : (v.mounts[0]?.azimuth ?? 0);
          vehicleHull(ctx, toScreen, ground, heading, v.kind, v.side, heading + turret, condition);
        }
        const p = vehicleMarker(
          ctx,
          toScreen(ground),
          v.side,
          isSelected,
          false,
          inPerspective,
          pxPerMetre(toScreen, ground),
          v.kind,
          condition,
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
