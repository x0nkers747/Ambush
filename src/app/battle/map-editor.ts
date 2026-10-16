import {
  killZoneSpec,
  ORDER_LABELS,
  vehiclesOf,
  type PlannedSector,
  type PlannedVehicle,
  type ScenarioSquad,
} from '#exercise/battle';
import {
  killZoneCorners,
  planPath,
  type KillZone,
  type OrderKind,
  type Side,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import type { MapEditor } from '#view2d';
import type { Planner } from './planner';

// The battle planner on the map (docs/constructive-simulation/03): squads,
// their soldiers where they start and their plans, drawn over the 2D map or
// the 3D view (the same drawing, through each view's projection), and the
// clicks and drags that edit them through the planner. The 3D view hands its
// pointer to the 2D map's surface, which calls this editor (docs/adr/0039),
// so both views edit alike.
//
//   click empty ground   the tool's action: place a squad, give an order, or deselect
//   click a squad        select it          drag it    move it (Scenario Setup)
//   click a waypoint     select its order   drag it    move the destination
//   drag the knob        turn the selected squad (its facing at the start)
//   drag a corner        resize the selected ambush order's kill zone
//   drag the arc handle  widen or narrow the selected defend order's sector
//   right-click a waypoint  delete the order
//
// Vehicles (docs/vehicles.md) alike: click to select, drag to move (Scenario
// Setup), drag the knob to turn, drag a waypoint of the route to move it,
// right-click it to delete it.

/** Friendly blue and hostile red (APP-6 affiliation colours, as the map has always drawn them). */
export const SIDE_COLORS: Readonly<Record<Side, string>> = {
  BLUEFOR: '#5ec8f7',
  OPFOR: '#f25c5c',
};
const ISSUE_COLOR = '#e0a63a';
export const OUTLINE = '#0b0d0f';

/** Hit radii and handle distance, CSS pixels. */
const WAYPOINT_HIT_PX = 11;
const SQUAD_HIT_PX = 16;
const SOLDIER_HIT_PX = 6;
const KNOB_PX = 46;
const KNOB_HIT_PX = 9;
const CORNER_HIT_PX = 9;

export const ORDER_INITIALS: Readonly<Record<OrderKind, string>> = {
  move: 'M',
  attack: 'A',
  withdraw: 'W',
  ambush: 'B',
  defend: 'D',
};

type Hit =
  | { readonly kind: 'waypoint'; readonly squad: ScenarioSquad; readonly index: number }
  | {
      readonly kind: 'corner';
      readonly squad: ScenarioSquad;
      readonly index: number;
      readonly corner: number;
    }
  /** The handle that widens or narrows the selected defend order's arc. */
  | { readonly kind: 'arc'; readonly squad: ScenarioSquad; readonly index: number }
  /** The handle at the selected ambush order's kill zone's centre, that moves it. */
  | { readonly kind: 'zone'; readonly squad: ScenarioSquad; readonly index: number }
  /** The handle that turns the selected defend order's sector round its position. */
  | { readonly kind: 'facing'; readonly squad: ScenarioSquad; readonly index: number }
  | { readonly kind: 'knob'; readonly squad: ScenarioSquad }
  | { readonly kind: 'squad'; readonly squad: ScenarioSquad }
  | { readonly kind: 'vehicle'; readonly vehicle: PlannedVehicle }
  | { readonly kind: 'vehicleKnob'; readonly vehicle: PlannedVehicle }
  | { readonly kind: 'vehicleWaypoint'; readonly vehicle: PlannedVehicle; readonly index: number };

export interface BattleMapEditor extends MapEditor {
  /** Whether OPFOR is drawn (and can be picked) while BLUEFOR plans. */
  showOpfor: boolean;
}

const toVec = (p: { east: number; north: number }): Vec2 => ({ x: p.east, y: p.north });

export function createBattleMapEditor(planner: Planner): BattleMapEditor {
  /** The projection of the view drawn last: the one the pointer is over. */
  let project: ((p: Vec2) => Vec2) | null = null;
  /** Whether that view is the 3D view (vehicles' symbols drawn above them). */
  let perspective = false;
  let drag: Hit | null = null;

  const visible = (s: ScenarioSquad) =>
    editor.showOpfor || planner.stage !== 'bluefor' || s.side === 'BLUEFOR';
  const squads = () => planner.definition.squads.filter(visible);

  const vehiclesShown = () =>
    vehiclesOf(planner.definition).filter(
      (v) => editor.showOpfor || planner.stage !== 'bluefor' || v.side === 'BLUEFOR',
    );

  /** The facing knob of the selected squad, on screen, when it can be turned. */
  const knobOf = (s: ScenarioSquad, at: (p: Vec2) => Vec2): Vec2 | null => {
    if (planner.selection.squadId !== s.id) return null;
    if (!planner.canPlace() && !planner.canPlan(s)) return null;
    return knobAt(s.position, s.facingDeg, at);
  };
  /** The facing knob of the selected vehicle, on screen, when it can be turned. */
  const vehicleKnobOf = (v: PlannedVehicle, at: (p: Vec2) => Vec2): Vec2 | null => {
    if (planner.selection.vehicleId !== v.id) return null;
    if (!planner.canPlace() && !planner.canRoute(v)) return null;
    // Giving it waypoints, a click ahead of it is one, not its knob.
    if (planner.tool.kind === 'order') return null;
    return knobAt(v.position, v.facingDeg, at);
  };

  const hitVehicle = (screen: Vec2, at: (p: Vec2) => Vec2): Hit | null => {
    const near = (p: Vec2, r: number) => Math.hypot(p.x - screen.x, p.y - screen.y) <= r;
    const list = vehiclesShown();
    const selected = planner.selectedVehicle;
    if (selected) {
      const knob = vehicleKnobOf(selected, at);
      if (knob && near(knob, KNOB_HIT_PX)) return { kind: 'vehicleKnob', vehicle: selected };
    }
    const ordered = selected ? [selected, ...list.filter((v) => v.id !== selected.id)] : list;
    for (const v of ordered) {
      for (let k = v.route.length - 1; k >= 0; k -= 1) {
        const p = v.route[k];
        if (p && near(at(toVec(p)), WAYPOINT_HIT_PX))
          return { kind: 'vehicleWaypoint', vehicle: v, index: k };
      }
    }
    for (const v of ordered) {
      const c = at(toVec(v.position));
      const lifted = vehicleSymbolAt(c, perspective, pxPerMetre(at, toVec(v.position)));
      if (near(c, SQUAD_HIT_PX) || near(lifted, SQUAD_HIT_PX))
        return { kind: 'vehicle', vehicle: v };
    }
    return null;
  };
  const hitAt = (screen: Vec2): Hit | null => {
    const at = project;
    if (!at) return null;
    // Vehicles over squads: one is easily lost in a squad's soldiers.
    const car = hitVehicle(screen, at);
    if (car) return car;
    const near = (p: Vec2, r: number) => Math.hypot(p.x - screen.x, p.y - screen.y) <= r;
    const list = squads();
    // The selected squad's handles first, then waypoints, then squads.
    const selected = planner.selectedSquad;
    if (selected && visible(selected)) {
      const knob = knobOf(selected, at);
      if (knob && near(knob, KNOB_HIT_PX)) return { kind: 'knob', squad: selected };
      // The selected defend order's arc handle.
      const index = planner.selection.orderIndex;
      const defence = index === null ? undefined : selected.plan[index];
      if (defence?.sector && index !== null && planner.canPlan(selected)) {
        const handle = arcHandle(toVec(defence.destination), defence.sector);
        if (near(at(handle), CORNER_HIT_PX)) return { kind: 'arc', squad: selected, index };
        const facing = facingHandle(toVec(defence.destination), defence.sector);
        if (near(at(facing), CORNER_HIT_PX)) return { kind: 'facing', squad: selected, index };
      }
      // The selected ambush order's kill zone corners.
      const zone = index === null ? undefined : selected.plan[index]?.killZone;
      if (zone && index !== null && planner.canPlan(selected)) {
        const corners = killZoneCorners(killZoneSpec(zone));
        for (let corner = 0; corner < corners.length; corner += 1) {
          const p = corners[corner];
          if (p && near(at(p), CORNER_HIT_PX))
            return { kind: 'corner', squad: selected, index, corner };
        }
        if (near(at(toVec(zone.centre)), CORNER_HIT_PX))
          return { kind: 'zone', squad: selected, index };
      }
    }
    const ordered = selected ? [selected, ...list.filter((s) => s !== selected)] : list;
    for (const s of ordered) {
      for (let k = s.plan.length - 1; k >= 0; k -= 1) {
        const order = s.plan[k];
        if (order && near(at(toVec(order.destination)), WAYPOINT_HIT_PX))
          return { kind: 'waypoint', squad: s, index: k };
      }
    }
    for (const s of ordered) {
      if (near(at(toVec(s.position)), SQUAD_HIT_PX)) return { kind: 'squad', squad: s };
    }
    const soldiers = planner.soldiers();
    for (const m of soldiers) {
      if (!near(at(m.position), SOLDIER_HIT_PX)) continue;
      const s = list.find((q) => q.id === m.squadId);
      if (s) return { kind: 'squad', squad: s };
    }
    return null;
  };

  const editor: BattleMapEditor = {
    showOpfor: true,
    press(_point, screen, button) {
      const hit = hitAt(screen);
      if (!hit) return false;
      if (button === 2) {
        if (hit.kind === 'waypoint') planner.removeOrder(hit.squad.id, hit.index);
        if (hit.kind === 'vehicleWaypoint')
          planner.removeVehicleWaypoint(hit.vehicle.id, hit.index);
        return true;
      }
      if (button !== 0) return false;
      if (hit.kind === 'waypoint') planner.select(hit.squad.id, hit.index);
      else if (hit.kind === 'squad') planner.select(hit.squad.id);
      else if (hit.kind === 'vehicle') planner.selectVehicle(hit.vehicle.id);
      else if (hit.kind === 'vehicleWaypoint') planner.selectVehicle(hit.vehicle.id, hit.index);
      drag = hit;
      return true;
    },
    drag(point) {
      if (!drag) return;
      if (drag.kind === 'vehicle') {
        planner.moveVehicleTo(drag.vehicle.id, point, false);
        return;
      }
      if (drag.kind === 'vehicleKnob') {
        planner.turnVehicleToward(drag.vehicle.id, point, false);
        return;
      }
      if (drag.kind === 'vehicleWaypoint') {
        planner.moveVehicleWaypointTo(drag.vehicle.id, drag.index, point, false);
        return;
      }
      const id = drag.squad.id;
      if (drag.kind === 'squad') planner.moveSquadTo(id, point, false);
      else if (drag.kind === 'knob') planner.turnSquadToward(id, point, false);
      else if (drag.kind === 'corner')
        planner.resizeKillZoneTo(id, drag.index, drag.corner, point, false);
      else if (drag.kind === 'arc') planner.resizeDefendArcTo(id, drag.index, point, false);
      else if (drag.kind === 'facing') planner.turnDefendTo(id, drag.index, point, false);
      else if (drag.kind === 'zone') planner.moveKillZoneTo(id, drag.index, point, false);
      else planner.moveOrderTo(id, drag.index, point, false);
    },
    drop() {
      drag = null;
      planner.commit();
    },
    click(point) {
      planner.click(point);
    },
    cursor(_point, screen) {
      const hit = hitAt(screen);
      if (hit?.kind === 'knob' || hit?.kind === 'vehicleKnob' || hit?.kind === 'facing')
        return 'grab';
      if (hit?.kind === 'zone') return 'move';
      if (hit?.kind === 'vehicle') return planner.canPlace() ? 'move' : 'pointer';
      if (hit?.kind === 'vehicleWaypoint')
        return planner.canRoute(hit.vehicle) ? 'move' : 'pointer';
      if (hit?.kind === 'corner' || hit?.kind === 'arc') return 'nwse-resize';
      if (hit?.kind === 'squad') return planner.canPlace() ? 'move' : 'pointer';
      if (hit?.kind === 'waypoint') return planner.canPlan(hit.squad) ? 'move' : 'pointer';
      return planner.tool.kind === 'select' ? null : 'crosshair';
    },
    draw(ctx, toScreen, inPerspective = false) {
      project = toScreen;
      perspective = inPerspective;
      drawBattle(ctx, planner, toScreen, squads(), (s) => knobOf(s, toScreen));
      drawVehicles(
        ctx,
        planner,
        toScreen,
        vehiclesShown(),
        (v) => vehicleKnobOf(v, toScreen),
        inPerspective,
      );
    },
  };
  return editor;
}

/** A facing knob on screen: `KNOB_PX` from `position` the way `facingDeg` points, in either view. */
function knobAt(
  position: { east: number; north: number },
  facingDeg: number,
  at: (p: Vec2) => Vec2,
): Vec2 | null {
  const c = at(toVec(position));
  const rad = (facingDeg * Math.PI) / 180;
  // A point 20 m ahead gives the screen direction of the facing in either view.
  const ahead = at({
    x: position.east + 20 * Math.sin(rad),
    y: position.north + 20 * Math.cos(rad),
  });
  const dx = ahead.x - c.x;
  const dy = ahead.y - c.y;
  const n = Math.hypot(dx, dy);
  if (!Number.isFinite(n) || n < 1e-6) return null;
  return { x: c.x + (dx / n) * KNOB_PX, y: c.y + (dy / n) * KNOB_PX };
}

function drawKnob(ctx: CanvasRenderingContext2D, c: Vec2, knob: Vec2): void {
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.lineTo(knob.x, knob.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = OUTLINE;
  ctx.beginPath();
  ctx.arc(knob.x, knob.y, 5, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
}

/** Road routes drawn lately, by their start (to the nearest `ROUTE_START_M`) and destination. */
const roadLines = new Map<string, readonly Vec2[]>();
const ROUTE_START_M = 20;

/**
 * A plan's line on the map (map metres): from `start` through each stop;
 * straight to a stop, but along the roads to one preferring them (the way
 * `planPath` plans it: to the road, along it, off it). A moving start is taken
 * to the nearest `ROUTE_START_M`, so a road route is planned again only as
 * the squad moves on.
 */
export function routeLine(
  terrain: TerrainDataset,
  start: Vec2,
  stops: readonly { readonly point: Vec2; readonly followRoads: boolean }[],
): Vec2[] {
  const line: Vec2[] = [start];
  let from = start;
  for (const stop of stops) {
    if (stop.followRoads) {
      const q = {
        x: Math.round(from.x / ROUTE_START_M) * ROUTE_START_M,
        y: Math.round(from.y / ROUTE_START_M) * ROUTE_START_M,
      };
      const key = `${String(q.x)},${String(q.y)}>${String(stop.point.x)},${String(stop.point.y)}`;
      let turns = roadLines.get(key);
      if (!turns) {
        const path = planPath(terrain, from, stop.point, { followRoads: true });
        turns = path.ok ? path.turns.map((p) => ({ x: p.x, y: p.y })) : [];
        if (roadLines.size > 500) roadLines.clear();
        roadLines.set(key, turns);
      }
      line.push(...turns);
    }
    line.push(stop.point);
    from = stop.point;
  }
  return line;
}

/** A route on the map: a line from `points[0]` through the rest, a chevron along each leg. */
export function drawRoute(
  ctx: CanvasRenderingContext2D,
  points: readonly Vec2[],
  color: string,
  isSelected: boolean,
  dash: readonly number[] = [],
): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = isSelected ? 1 : 0.75;
  ctx.setLineDash(dash as number[]);
  for (const [width, stroke] of [
    [isSelected ? 5 : 4, OUTLINE],
    [isSelected ? 3 : 2, color],
  ] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = stroke;
    ctx.beginPath();
    points.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 40) continue;
    chevron(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, Math.atan2(b.y - a.y, b.x - a.x), color);
  }
  ctx.restore();
}

/** The scenario's vehicles: their routes, symbols, knobs and names. */
function drawVehicles(
  ctx: CanvasRenderingContext2D,
  planner: Planner,
  at: (p: Vec2) => Vec2,
  vehicles: readonly PlannedVehicle[],
  knobOf: (v: PlannedVehicle) => Vec2 | null,
  perspective: boolean,
): void {
  const issues = planner.issues();
  const selection = planner.selection;
  ctx.save();
  ctx.font = '600 11px system-ui, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';
  for (const v of vehicles) {
    const isSelected = selection.vehicleId === v.id;
    const color = SIDE_COLORS[v.side];
    if (v.route.length > 0) {
      const points = [toVec(v.position), ...v.route.map(toVec)].map(at);
      const line = routeLine(
        planner.terrain,
        toVec(v.position),
        v.route.map((p) => ({ point: toVec(p), followRoads: p.followRoads === true })),
      );
      drawRoute(ctx, line.map(at), color, isSelected, [12, 4, 2, 4]);
      v.route.forEach((_, k) => {
        const q = points[k + 1];
        if (!q) return;
        const issue = issues.some((i) => i.vehicleId === v.id && i.orderIndex === k);
        waypoint(ctx, q, 'move', k + 1, color, isSelected && selection.orderIndex === k, issue);
      });
    }
  }
  for (const v of vehicles) {
    const isSelected = selection.vehicleId === v.id;
    const c = at(toVec(v.position));
    const knob = knobOf(v);
    if (knob) drawKnob(ctx, c, knob);
    const issue = issues.some((i) => i.vehicleId === v.id && i.orderIndex === null);
    const s = vehicleMarker(
      ctx,
      c,
      v.side,
      isSelected,
      issue,
      perspective,
      pxPerMetre(at, toVec(v.position)),
    );
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = OUTLINE;
    ctx.strokeText(v.name, s.x, s.y + 22);
    ctx.fillStyle = isSelected ? '#fff' : '#d8dde2';
    ctx.fillText(v.name, s.x, s.y + 22);
  }
  ctx.restore();
}

/** How far above a vehicle its symbol is drawn in the 3D view (px), clear of the model. */
const VEHICLE_SYMBOL_LIFT_PX = 48;
/** The height above the ground the model reaches (m), its machine gun's top. */
const VEHICLE_HEIGHT_M = 2.5;

/**
 * Where a vehicle's symbol is drawn for a vehicle at `c` on screen: on it in
 * 2D; in 3D above it, clear of the model (`pxPerM`: the view's scale there).
 */
export function vehicleSymbolAt(c: Vec2, perspective: boolean, pxPerM = 0): Vec2 {
  if (!perspective) return c;
  const lift = Math.min(400, VEHICLE_SYMBOL_LIFT_PX + VEHICLE_HEIGHT_M * pxPerM);
  return { x: c.x, y: c.y - lift };
}

/** The view's scale at map point `p` (screen px per metre, across the screen). */
export function pxPerMetre(at: (p: Vec2) => Vec2, p: Vec2): number {
  const a = at(p);
  const b = at({ x: p.x + 2, y: p.y });
  const c = at({ x: p.x, y: p.y + 2 });
  const s = Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y)) / 2;
  return Number.isFinite(s) ? s : 0;
}

/**
 * A vehicle's marker: its symbol on it (2D), or above it on a leader line (3D,
 * so the model shows). Returns where the symbol is.
 */
export function vehicleMarker(
  ctx: CanvasRenderingContext2D,
  c: Vec2,
  side: Side,
  isSelected: boolean,
  issue: boolean,
  perspective: boolean,
  pxPerM = 0,
): Vec2 {
  const s = vehicleSymbolAt(c, perspective, pxPerM);
  if (perspective) {
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = OUTLINE;
    ctx.beginPath();
    // From the top of the model (not across it) to the symbol.
    ctx.moveTo(c.x, Math.max(s.y + 9, c.y - VEHICLE_HEIGHT_M * pxPerM));
    ctx.lineTo(s.x, s.y + 9);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isSelected ? '#fff' : SIDE_COLORS[side];
    ctx.stroke();
    ctx.restore();
  }
  vehicleSymbol(ctx, s, side, isSelected, issue);
  return s;
}

/**
 * A vehicle's symbol (APP-6 / MIL-STD-2525 style): the frame of its side (a
 * rectangle friendly, a diamond hostile) holding an armoured personnel
 * carrier: the infantry cross over the oval of tracks.
 */
export function vehicleSymbol(
  ctx: CanvasRenderingContext2D,
  c: Vec2,
  side: Side,
  isSelected: boolean,
  issue = false,
): void {
  const color = SIDE_COLORS[side];
  const w = 13;
  const h = 9;
  ctx.save();
  ctx.lineWidth = isSelected ? 2.5 : 1.5;
  ctx.strokeStyle = isSelected ? '#fff' : OUTLINE;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (side === 'BLUEFOR') ctx.rect(c.x - w, c.y - h, 2 * w, 2 * h);
  else {
    ctx.moveTo(c.x, c.y - 14);
    ctx.lineTo(c.x + 14, c.y);
    ctx.lineTo(c.x, c.y + 14);
    ctx.lineTo(c.x - 14, c.y);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = OUTLINE;
  // Tracks: a long oval low in the frame.
  ctx.beginPath();
  const ow = side === 'BLUEFOR' ? 8.5 : 6.5;
  ctx.ellipse(c.x, c.y + 3, ow, 2.6, 0, 0, 2 * Math.PI);
  ctx.stroke();
  // Infantry: a cross above it.
  ctx.beginPath();
  const cw = side === 'BLUEFOR' ? 7 : 5;
  ctx.moveTo(c.x - cw, c.y - 6);
  ctx.lineTo(c.x + cw, c.y - 0.5);
  ctx.moveTo(c.x + cw, c.y - 6);
  ctx.lineTo(c.x - cw, c.y - 0.5);
  ctx.stroke();
  ctx.restore();
  if (issue) ring(ctx, c, 20);
}

function drawBattle(
  ctx: CanvasRenderingContext2D,
  planner: Planner,
  at: (p: Vec2) => Vec2,
  squads: readonly ScenarioSquad[],
  knobOf: (s: ScenarioSquad) => Vec2 | null,
): void {
  const issues = planner.issues();
  const selected = planner.selection;
  const shown = new Set(squads.map((s) => s.id));
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.font = '600 11px system-ui, "Segoe UI", sans-serif';
  ctx.textBaseline = 'middle';

  // Plans under everything else; the selected squad's last, on top.
  const order = [...squads].sort(
    (a, b) => Number(a.id === selected.squadId) - Number(b.id === selected.squadId),
  );
  // Sectors of defend orders, and kill zones of ambush orders, under the routes.
  for (const s of order) {
    s.plan.forEach((o, k) => {
      if (!o.sector) return;
      const isSelected = s.id === selected.squadId && selected.orderIndex === k;
      defenceSector(
        ctx,
        toVec(o.destination),
        o.sector,
        at,
        SIDE_COLORS[s.side],
        k + 1,
        isSelected,
        isSelected && planner.canPlan(s),
      );
    });
  }
  for (const s of order) {
    s.plan.forEach((o, k) => {
      if (!o.killZone) return;
      const isSelected = s.id === selected.squadId && selected.orderIndex === k;
      killZone(
        ctx,
        killZoneSpec(o.killZone),
        at(toVec(o.destination)),
        at,
        SIDE_COLORS[s.side],
        k + 1,
        isSelected,
        isSelected && planner.canPlan(s),
      );
    });
  }
  for (const s of order) {
    if (s.plan.length === 0) continue;
    const isSelected = s.id === selected.squadId;
    const color = SIDE_COLORS[s.side];
    const line = routeLine(
      planner.terrain,
      toVec(s.position),
      s.plan.map((o) => ({ point: toVec(o.destination), followRoads: o.followRoads === true })),
    );
    drawRoute(ctx, line.map(at), color, isSelected, s.side === 'OPFOR' ? [7, 5] : []);
    const points = [toVec(s.position), ...s.plan.map((o) => toVec(o.destination))].map(at);
    ctx.globalAlpha = isSelected ? 1 : 0.75;
    s.plan.forEach((o, k) => {
      const p = points[k + 1];
      if (!p) return;
      const issue = issues.some((i) => i.squadId === s.id && i.orderIndex === k);
      waypoint(ctx, p, o.kind, k + 1, color, isSelected && selected.orderIndex === k, issue);
    });
    ctx.globalAlpha = 1;
  }

  // Soldiers where they start.
  for (const m of planner.soldiers()) {
    if (!shown.has(m.squadId)) continue;
    const p = at(m.position);
    ctx.fillStyle = SIDE_COLORS[m.side];
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, m.squadId === selected.squadId ? 3.5 : 2.6, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  }

  // Squad symbols, facing ticks and names.
  for (const s of order) {
    const isSelected = s.id === selected.squadId;
    const c = at(toVec(s.position));
    const issue = issues.some((i) => i.squadId === s.id && i.orderIndex === null);
    const knob = knobOf(s);
    if (knob) drawKnob(ctx, c, knob);
    unitSymbol(ctx, c, s, isSelected, issue);
    const label = s.name;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = OUTLINE;
    ctx.strokeText(label, c.x, c.y + 22);
    ctx.fillStyle = isSelected ? '#fff' : '#d8dde2';
    ctx.fillText(label, c.x, c.y + 22);
  }
  ctx.restore();
}

export function chevron(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(-4, -5);
  ctx.lineTo(3, 0);
  ctx.lineTo(-4, 5);
  ctx.lineWidth = 4;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

/** A waypoint: its order's kind by shape and initial (move ●, attack ◆, withdraw ■, ambush ▲) and its number. */
export function waypoint(
  ctx: CanvasRenderingContext2D,
  p: Vec2,
  kind: OrderKind,
  n: number,
  color: string,
  isSelected: boolean,
  issue: boolean,
): void {
  const r = 8;
  ctx.beginPath();
  if (kind === 'attack') {
    ctx.moveTo(p.x, p.y - r - 2);
    ctx.lineTo(p.x + r + 2, p.y);
    ctx.lineTo(p.x, p.y + r + 2);
    ctx.lineTo(p.x - r - 2, p.y);
    ctx.closePath();
  } else if (kind === 'withdraw') ctx.rect(p.x - r, p.y - r, 2 * r, 2 * r);
  else if (kind === 'ambush') {
    ctx.moveTo(p.x, p.y - r - 3);
    ctx.lineTo(p.x + r + 2, p.y + r - 1);
    ctx.lineTo(p.x - r - 2, p.y + r - 1);
    ctx.closePath();
  } else ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = isSelected ? 3 : 1.5;
  ctx.strokeStyle = isSelected ? '#fff' : OUTLINE;
  ctx.stroke();
  if (issue) ring(ctx, p, r + 6);
  ctx.textAlign = 'center';
  ctx.fillStyle = OUTLINE;
  ctx.fillText(ORDER_INITIALS[kind], p.x, p.y + 0.5);
  ctx.textAlign = 'left';
  const label = `${String(n)} ${ORDER_LABELS[kind]}`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = OUTLINE;
  ctx.strokeText(label, p.x + r + 5, p.y);
  ctx.fillStyle = isSelected ? '#fff' : '#d8dde2';
  ctx.fillText(label, p.x + r + 5, p.y);
}

/** How far a defence's sector is drawn from its position (map metres). */
export const SECTOR_DRAW_M = 45;

/** Where a defence's facing handle is: the middle of its arc, the way it faces (its label just under it). */
export function facingHandle(at: Vec2, sector: PlannedSector): Vec2 {
  const rad = (sector.facingDeg * Math.PI) / 180;
  return { x: at.x + SECTOR_DRAW_M * Math.sin(rad), y: at.y + SECTOR_DRAW_M * Math.cos(rad) };
}

/** Where a defence's arc handle is: on its arc's right-hand edge (all round, behind it). */
export function arcHandle(at: Vec2, sector: PlannedSector): Vec2 {
  const half = Math.min(180, sector.arcDeg / 2);
  const rad = ((sector.facingDeg + half) * Math.PI) / 180;
  return { x: at.x + SECTOR_DRAW_M * Math.sin(rad), y: at.y + SECTOR_DRAW_M * Math.cos(rad) };
}

/**
 * A defence's sector: a shaded wedge from its position toward the direction
 * it defends (a disc, all round), its label, and (when it can be changed)
 * the handle that widens or narrows it.
 */
export function defenceSector(
  ctx: CanvasRenderingContext2D,
  centre: Vec2,
  sector: PlannedSector,
  at: (p: Vec2) => Vec2,
  color: string,
  n: number,
  isSelected: boolean,
  handle: boolean,
): void {
  const arc = Math.min(360, sector.arcDeg);
  const steps = Math.max(8, Math.ceil(arc / 6));
  const edge: Vec2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const deg = sector.facingDeg - arc / 2 + (arc * i) / steps;
    const rad = (deg * Math.PI) / 180;
    edge.push(
      at({
        x: centre.x + SECTOR_DRAW_M * Math.sin(rad),
        y: centre.y + SECTOR_DRAW_M * Math.cos(rad),
      }),
    );
  }
  const c = at(centre);
  ctx.save();
  ctx.beginPath();
  if (arc < 360) ctx.moveTo(c.x, c.y);
  edge.forEach((p, i) => {
    if (i === 0 && arc >= 360) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = isSelected ? 0.26 : 0.15;
  ctx.fill();
  ctx.globalAlpha = isSelected ? 1 : 0.8;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = isSelected ? 2.5 : 1.5;
  ctx.strokeStyle = isSelected ? '#fff' : color;
  ctx.stroke();
  ctx.setLineDash([]);
  // Its facing: a line from the position to the arc's middle.
  const mid = at(facingHandle(centre, sector));
  if (arc < 360) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(mid.x, mid.y);
    ctx.stroke();
  }
  // Its label just under the arc's middle (and the facing handle there).
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const label = `Defend ${String(n)} · ${String(Math.round(arc))}°`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = OUTLINE;
  ctx.strokeText(label, mid.x, mid.y + 9);
  ctx.fillStyle = isSelected ? '#fff' : '#d8dde2';
  ctx.fillText(label, mid.x, mid.y + 9);
  if (handle) {
    // The facing handle (a circle: drag to turn the sector round the position).
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(mid.x, mid.y, 5.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    const h = at(arcHandle(centre, sector));
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(h.x - 5, h.y - 5, 10, 10);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * An ambush's kill zone: a shaded rectangle with a dashed edge, a line to it
 * from the ambush position, its label, and (resizing) its corner handles.
 */
export function killZone(
  ctx: CanvasRenderingContext2D,
  zone: KillZone,
  from: Vec2,
  at: (p: Vec2) => Vec2,
  color: string,
  n: number,
  isSelected: boolean,
  handles: boolean,
): void {
  const corners = killZoneCorners(zone).map(at);
  const centre = at(zone.centre);
  ctx.save();
  ctx.globalAlpha = isSelected ? 1 : 0.8;
  // From the ambush position to the zone: its line of fire.
  ctx.setLineDash([3, 4]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(centre.x, centre.y);
  ctx.stroke();
  ctx.beginPath();
  corners.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.globalAlpha = isSelected ? 0.28 : 0.18;
  ctx.fill();
  ctx.globalAlpha = isSelected ? 1 : 0.8;
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = isSelected ? 2.5 : 1.5;
  ctx.strokeStyle = isSelected ? '#fff' : color;
  ctx.stroke();
  ctx.setLineDash([]);
  // Its label just under its centre (and the handle that moves it).
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const label = `Kill zone ${String(n)}`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = OUTLINE;
  ctx.strokeText(label, centre.x, centre.y + 9);
  ctx.fillStyle = isSelected ? '#fff' : '#d8dde2';
  ctx.fillText(label, centre.x, centre.y + 9);
  if (handles) {
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, 5.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    for (const p of corners) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(p.x - 4.5, p.y - 4.5, 9, 9);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function ring(ctx: CanvasRenderingContext2D, p: Vec2, r: number): void {
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = ISSUE_COLOR;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.restore();
}

/**
 * The squad's unit symbol (APP-6 / MIL-STD-2525 style): a rectangle for
 * friendly, a diamond for hostile, the infantry cross, and the echelon above
 * (squad ●, fire team and element Ø).
 */
export function unitSymbol(
  ctx: CanvasRenderingContext2D,
  c: Vec2,
  s: Pick<ScenarioSquad, 'side' | 'organization'>,
  isSelected: boolean,
  issue: boolean,
): void {
  const color = SIDE_COLORS[s.side];
  const w = 13;
  const h = 9;
  ctx.save();
  ctx.lineWidth = isSelected ? 2.5 : 1.5;
  ctx.strokeStyle = isSelected ? '#fff' : OUTLINE;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (s.side === 'BLUEFOR') ctx.rect(c.x - w, c.y - h, 2 * w, 2 * h);
  else {
    ctx.moveTo(c.x, c.y - 13);
    ctx.lineTo(c.x + 13, c.y);
    ctx.lineTo(c.x, c.y + 13);
    ctx.lineTo(c.x - 13, c.y);
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
  // Infantry: the frame's diagonals.
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = OUTLINE;
  ctx.beginPath();
  if (s.side === 'BLUEFOR') {
    ctx.moveTo(c.x - w, c.y - h);
    ctx.lineTo(c.x + w, c.y + h);
    ctx.moveTo(c.x + w, c.y - h);
    ctx.lineTo(c.x - w, c.y + h);
  } else {
    ctx.moveTo(c.x - 6.5, c.y - 6.5);
    ctx.lineTo(c.x + 6.5, c.y + 6.5);
    ctx.moveTo(c.x + 6.5, c.y - 6.5);
    ctx.lineTo(c.x - 6.5, c.y + 6.5);
  }
  ctx.stroke();
  // Echelon, above the frame.
  const top = c.y - (s.side === 'BLUEFOR' ? h : 13) - 6;
  ctx.fillStyle = isSelected ? '#fff' : '#d8dde2';
  ctx.strokeStyle = isSelected ? '#fff' : '#d8dde2';
  ctx.beginPath();
  if (s.organization === 'squad') ctx.arc(c.x, top, 2.5, 0, 2 * Math.PI);
  else {
    ctx.lineWidth = 1.3;
    ctx.arc(c.x, top, 3, 0, 2 * Math.PI);
    ctx.moveTo(c.x - 4.5, top + 4.5);
    ctx.lineTo(c.x + 4.5, top - 4.5);
  }
  if (s.organization === 'squad') ctx.fill();
  else ctx.stroke();
  ctx.restore();
  if (issue) ring(ctx, c, 20);
}
