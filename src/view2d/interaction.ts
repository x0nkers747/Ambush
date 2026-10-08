import { TRAINEE_SIDE } from '#exercise';
import type { Azimuth, SoldierId, Vec2 } from '#sim';
import { facingToward } from './bearing';
import { panBy, screenToWorld, zoomAt, type Camera } from './camera';
import {
  isOnDestination,
  isOnFacingHandle,
  killZoneInsertionIndexAt,
  killZoneVertexAt,
  selectedSoldier,
  soldierAt,
  type MapScene,
} from './scene';

// Pointer interaction on the tactical map, as a small state machine over
// screen-space input. Independent of the DOM: the map feeds it pointer and
// wheel input and it calls `MapActions`.
//
//   Left click a BLUEFOR soldier      select it
//   Left click the map                set (or move) the selected soldier's destination
//   Left drag the destination         move it
//   Left drag the facing arrow tip    set the facing
//   Right click the destination       clear it
//   Left drag the map / middle drag   pan
//   Mouse wheel                       zoom at the cursor
//
// Generated path turns are shown but are never handles: they are not intent.
//
// With the kill-zone tool, clicks edit the kill zone instead of destinations:
//
//   Left click the map                add a corner after the last one
//   Left click on a side              insert a corner into that side
//   Left drag a corner                move it
//   Right click a corner              delete it

export interface MapActions {
  select(id: SoldierId): void;
  setDestination(point: Vec2): void;
  clearDestination(): void;
  setFacing(azimuth: Azimuth): void;
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
  | { readonly kind: 'destination' }
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
  /** Whether the destination is being dragged (e.g. to show a quicker preview meanwhile). */
  readonly draggingDestination: boolean;
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
    if (s.editable && (isOnFacingHandle(s, p) || isOnDestination(s, p))) return 'move';
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
    if (s.isOnMap(point)) actions.setDestination(point);
  };

  return {
    get cursor() {
      return cursor;
    },
    get draggingDestination() {
      return mode.kind === 'destination';
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
          if (s.editable && isOnDestination(s, p)) actions.clearDestination();
        }
      } else if (input.button === 0 && s.tool === 'killZone') {
        const index = s.killZoneEditable ? killZoneVertexAt(s, p) : undefined;
        mode =
          index === undefined ? { kind: 'press', start: p } : { kind: 'killZoneVertex', index };
      } else if (input.button === 0) {
        if (s.editable && isOnFacingHandle(s, p)) mode = { kind: 'facing' };
        else if (s.editable && isOnDestination(s, p)) mode = { kind: 'destination' };
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
        case 'destination': {
          // Positions the exercise refuses (in a building, unreachable) are skipped.
          const point = toWorld(s, p);
          if (s.editable && s.isOnMap(point)) actions.setDestination(point);
          return;
        }
        case 'facing': {
          const soldier = selectedSoldier(s);
          if (!s.editable || !soldier) return;
          const destination = s.selectedPlan?.destination;
          const anchor = destination
            ? { x: destination.east, y: destination.north }
            : soldier.position;
          const azimuth = facingToward(anchor, toWorld(s, p));
          if (azimuth !== undefined) actions.setFacing(azimuth);
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
