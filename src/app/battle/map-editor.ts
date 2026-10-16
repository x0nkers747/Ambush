import {
  killZoneSpec,
  ORDER_LABELS,
  type PlannedSector,
  type ScenarioSquad,
} from '#exercise/battle';
import { killZoneCorners, type KillZone, type OrderKind, type Side, type Vec2 } from '#sim';
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
  | { readonly kind: 'knob'; readonly squad: ScenarioSquad }
  | { readonly kind: 'squad'; readonly squad: ScenarioSquad };

export interface BattleMapEditor extends MapEditor {
  /** Whether OPFOR is drawn (and can be picked) while BLUEFOR plans. */
  showOpfor: boolean;
}

const toVec = (p: { east: number; north: number }): Vec2 => ({ x: p.east, y: p.north });

export function createBattleMapEditor(planner: Planner): BattleMapEditor {
  /** The projection of the view drawn last: the one the pointer is over. */
  let project: ((p: Vec2) => Vec2) | null = null;
  let drag: Hit | null = null;

  const visible = (s: ScenarioSquad) =>
    editor.showOpfor || planner.stage !== 'bluefor' || s.side === 'BLUEFOR';
  const squads = () => planner.definition.squads.filter(visible);

  /** The facing knob of the selected squad, on screen, when it can be turned. */
  const knobOf = (s: ScenarioSquad, at: (p: Vec2) => Vec2): Vec2 | null => {
    if (planner.selection.squadId !== s.id) return null;
    if (!planner.canPlace() && !planner.canPlan(s)) return null;
    const c = at(toVec(s.position));
    const rad = (s.facingDeg * Math.PI) / 180;
    // A point 20 m ahead gives the screen direction of the facing in either view.
    const ahead = at({
      x: s.position.east + 20 * Math.sin(rad),
      y: s.position.north + 20 * Math.cos(rad),
    });
    const dx = ahead.x - c.x;
    const dy = ahead.y - c.y;
    const n = Math.hypot(dx, dy);
    if (!Number.isFinite(n) || n < 1e-6) return null;
    return { x: c.x + (dx / n) * KNOB_PX, y: c.y + (dy / n) * KNOB_PX };
  };

  const hitAt = (screen: Vec2): Hit | null => {
    const at = project;
    if (!at) return null;
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
        return true;
      }
      if (button !== 0) return false;
      if (hit.kind === 'waypoint') planner.select(hit.squad.id, hit.index);
      else if (hit.kind === 'squad') planner.select(hit.squad.id);
      drag = hit;
      return true;
    },
    drag(point) {
      if (!drag) return;
      const id = drag.squad.id;
      if (drag.kind === 'squad') planner.moveSquadTo(id, point, false);
      else if (drag.kind === 'knob') planner.turnSquadToward(id, point, false);
      else if (drag.kind === 'corner')
        planner.resizeKillZoneTo(id, drag.index, drag.corner, point, false);
      else if (drag.kind === 'arc') planner.resizeDefendArcTo(id, drag.index, point, false);
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
      if (hit?.kind === 'knob') return 'grab';
      if (hit?.kind === 'corner' || hit?.kind === 'arc') return 'nwse-resize';
      if (hit?.kind === 'squad') return planner.canPlace() ? 'move' : 'pointer';
      if (hit?.kind === 'waypoint') return planner.canPlan(hit.squad) ? 'move' : 'pointer';
      return planner.tool.kind === 'select' ? null : 'crosshair';
    },
    draw(ctx, toScreen) {
      project = toScreen;
      drawBattle(ctx, planner, toScreen, squads(), (s) => knobOf(s, toScreen));
    },
  };
  return editor;
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
    const points = [toVec(s.position), ...s.plan.map((o) => toVec(o.destination))].map(at);
    ctx.globalAlpha = isSelected ? 1 : 0.75;
    ctx.setLineDash(s.side === 'OPFOR' ? [7, 5] : []);
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
    // A chevron half-way along each leg, pointing the way.
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 40) continue;
      chevron(ctx, (a.x + b.x) / 2, (a.y + b.y) / 2, Math.atan2(b.y - a.y, b.x - a.x), color);
    }
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
    if (knob) {
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
export const SECTOR_DRAW_M = 90;

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
  const mid = edge[Math.floor(steps / 2)];
  if (mid && arc < 360) {
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(mid.x, mid.y);
    ctx.stroke();
  }
  const labelAt = mid ?? c;
  ctx.textAlign = 'center';
  const label = `Defend ${String(n)} · ${String(Math.round(arc))}°`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = OUTLINE;
  ctx.strokeText(label, labelAt.x, labelAt.y);
  ctx.fillStyle = isSelected ? '#fff' : '#d8dde2';
  ctx.fillText(label, labelAt.x, labelAt.y);
  if (handle) {
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
  ctx.textAlign = 'center';
  const label = `Kill zone ${String(n)}`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = OUTLINE;
  ctx.strokeText(label, centre.x, centre.y);
  ctx.fillStyle = isSelected ? '#fff' : '#d8dde2';
  ctx.fillText(label, centre.x, centre.y);
  if (handles) {
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
