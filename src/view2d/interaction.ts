import { TRAINEE_SIDE } from '#exercise';
import type { Azimuth, SoldierId, Vec2, WaypointId } from '#sim';
import { facingToward } from './bearing';
import { panBy, screenToWorld, zoomAt, type Camera } from './camera';
import {
  insertionIndexAt,
  isOnFacingHandle,
  killZoneInsertionIndexAt,
  killZoneVertexAt,
  selectedSoldier,
  soldierAt,
  waypointAt,
  type MapScene,
} from './scene';

// Pointer interaction on the tactical map, as a small state machine over
// screen-space input. Independent of the DOM: the map feeds it pointer and
// wheel input and it calls `MapActions`.
//
//   Left click a BLUEFOR soldier      select it
//   Left click the map                append a waypoint to the selected route
//   Left click on a route leg         insert a waypoint into that leg
//   Left drag a waypoint              move it
//   Left drag the facing arrow tip    set the final facing
//   Right click a waypoint            delete it
//   Left drag the map / middle drag   pan
//   Mouse wheel                       zoom at the cursor
//
// With the kill-zone tool, clicks edit the kill zone instead of routes:
//
//   Left click the map                add a corner after the last one
//   Left click on a side              insert a corner into that side
//   Left drag a corner                move it
//   Right click a corner              delete it

export interface MapActions {
  select(id: SoldierId): void;
  addWaypoint(point: Vec2, index?: number): void;
  moveWaypoint(id: WaypointId, point: Vec2): void;
  deleteWaypoint(id: WaypointId): void;
  setFinalFacing(azimuth: Azimuth): void;
  addKillZoneVertex(point: Vec2, index?: number): void;
  moveKillZoneVertex(index: number, point: Vec2): void;
  deleteKillZoneVertex(index: number): void;
  setCamera(camera: Camera): void;
}

export interface PointerInput {
  /** Position in CSS pixels relative to the map's top-left corner. */
  readonly x: number;
  readonly y: number;
  /** 0 = left, 1 = middle, 2 = right. */
  readonly button: number;
}

/** Movement in pixels that turns a press into a drag. */
export const DRAG_THRESHOLD_PX = 4;
/** Zoom factor per wheel delta unit (a typical notch, 100, zooms by ~16%). */
export const WHEEL_ZOOM_RATE = 0.0015;

type Mode =
  | { readonly kind: 'idle' }
  /** Left button down on the map; becomes a click or a pan. */
  | { readonly kind: 'press'; readonly start: Vec2 }
  | { readonly kind: 'pan'; readonly last: Vec2 }
  | { readonly kind: 'waypoint'; readonly id: WaypointId }
  | { readonly kind: 'facing' }
  | { readonly kind: 'killZoneVertex'; readonly index: number };

export type MapCursor = 'default' | 'pointer' | 'crosshair' | 'grab' | 'grabbing' | 'move';

export interface MapController {
  pointerDown(input: PointerInput): void;
  pointerMove(input: PointerInput): void;
  pointerUp(input: PointerInput): void;
  /** `deltaY` as reported by a wheel event (positive scrolls down, zooming out). */
  wheel(screen: Vec2, deltaY: number): void;
  /** Cursor that suits what is under the pointer and the current drag. */
  readonly cursor: MapCursor;
}

export function createMapController(scene: () => MapScene, actions: MapActions): MapController {
  let mode: Mode = { kind: 'idle' };
  let cursor: MapCursor = 'default';

  const toWorld = (s: MapScene, p: Vec2) => screenToWorld(s.camera, s.viewport, p);

  const hoverCursor = (s: MapScene, p: Vec2): MapCursor => {
    if (s.tool === 'killZone') {
      if (!s.killZoneEditable) return 'grab';
      return killZoneVertexAt(s, p) !== undefined ? 'move' : 'crosshair';
    }
    if (s.editable && (isOnFacingHandle(s, p) || waypointAt(s, p) !== undefined)) return 'move';
    const soldier = soldierAt(s, p);
    if (soldier?.side === TRAINEE_SIDE) return 'pointer';
    return s.editable ? 'crosshair' : 'grab';
  };

  const click = (s: MapScene, p: Vec2) => {
    if (s.tool === 'killZone') {
      // Soldiers are not selected with the kill-zone tool, so corners can go anywhere.
      const point = toWorld(s, p);
      if (!s.killZoneEditable || !s.isOnMap(point)) return;
      const index = killZoneInsertionIndexAt(s, p);
      if (index === undefined) actions.addKillZoneVertex(point);
      else actions.addKillZoneVertex(point, index);
      return;
    }
    const soldier = soldierAt(s, p);
    if (soldier) {
      actions.select(soldier.id);
      return;
    }
    if (!s.editable) return;
    const point = toWorld(s, p);
    if (!s.isOnMap(point)) return;
    const index = insertionIndexAt(s, p);
    if (index === undefined) actions.addWaypoint(point);
    else actions.addWaypoint(point, index);
  };

  return {
    get cursor() {
      return cursor;
    },

    pointerDown(input) {
      const s = scene();
      const p = { x: input.x, y: input.y };
      if (input.button === 1) {
        mode = { kind: 'pan', last: p };
      } else if (input.button === 2) {
        if (s.tool === 'killZone') {
          const index = s.killZoneEditable ? killZoneVertexAt(s, p) : undefined;
          if (index !== undefined) actions.deleteKillZoneVertex(index);
        } else {
          const id = s.editable ? waypointAt(s, p) : undefined;
          if (id !== undefined) actions.deleteWaypoint(id);
        }
      } else if (input.button === 0 && s.tool === 'killZone') {
        const index = s.killZoneEditable ? killZoneVertexAt(s, p) : undefined;
        mode =
          index === undefined ? { kind: 'press', start: p } : { kind: 'killZoneVertex', index };
      } else if (input.button === 0) {
        const waypoint = s.editable ? waypointAt(s, p) : undefined;
        if (s.editable && isOnFacingHandle(s, p)) mode = { kind: 'facing' };
        else if (waypoint !== undefined) mode = { kind: 'waypoint', id: waypoint };
        else mode = { kind: 'press', start: p };
      }
      cursor = mode.kind === 'pan' ? 'grabbing' : cursor;
    },

    pointerMove(input) {
      const s = scene();
      const p = { x: input.x, y: input.y };
      switch (mode.kind) {
        case 'idle':
          cursor = hoverCursor(s, p);
          return;
        case 'press':
          if (Math.hypot(p.x - mode.start.x, p.y - mode.start.y) < DRAG_THRESHOLD_PX) return;
          actions.setCamera(panBy(s.camera, p.x - mode.start.x, p.y - mode.start.y));
          mode = { kind: 'pan', last: p };
          cursor = 'grabbing';
          return;
        case 'pan':
          actions.setCamera(panBy(s.camera, p.x - mode.last.x, p.y - mode.last.y));
          mode = { kind: 'pan', last: p };
          return;
        case 'waypoint': {
          const point = toWorld(s, p);
          if (s.editable && s.isOnMap(point)) actions.moveWaypoint(mode.id, point);
          return;
        }
        case 'facing': {
          const soldier = selectedSoldier(s);
          if (!s.editable || !soldier) return;
          const anchor = s.selectedPlan?.waypoints.at(-1) ?? soldier.position;
          const azimuth = facingToward(anchor, toWorld(s, p));
          if (azimuth !== undefined) actions.setFinalFacing(azimuth);
          return;
        }
        case 'killZoneVertex': {
          // Positions the zone would refuse (crossing itself, off the map) are skipped.
          const point = toWorld(s, p);
          if (s.killZoneEditable && s.isOnMap(point)) actions.moveKillZoneVertex(mode.index, point);
          return;
        }
      }
    },

    pointerUp(input) {
      const s = scene();
      const p = { x: input.x, y: input.y };
      // A click acts where the button went down, ignoring jitter below the drag threshold.
      if (mode.kind === 'press') click(s, mode.start);
      mode = { kind: 'idle' };
      cursor = hoverCursor(s, p);
    },

    wheel(screen, deltaY) {
      const s = scene();
      actions.setCamera(zoomAt(s.camera, s.viewport, screen, Math.exp(-deltaY * WHEEL_ZOOM_RATE)));
    },
  };
}
