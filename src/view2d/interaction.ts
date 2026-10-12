import type { Azimuth, SoldierId, Vec2 } from '#sim';
import { facingToward } from './bearing';
import { panBy, zoomAt, type Camera } from './camera';
import {
  formationGeometry,
  destinationOwnerAt,
  isOnDestination,
  isOnFacingHandle,
  isOnFormationCentre,
  isOnFormationFacingHandle,
  killZoneInsertionIndexAt,
  killZoneVertexAt,
  nextSelectionAt,
  selectableSoldiersAt,
  selectedSoldier,
  soldierAt,
  type MapScene,
} from './scene';

// Pointer interaction on the tactical map, as a small state machine over
// screen-space input. Independent of the DOM: the map feeds it pointer and
// wheel input and it calls `MapActions`.
//
//   Left click a BLUEFOR soldier      select it
//   Left click another soldier's      select him, as clicking him does
//     destination (waypoint)
//   Left click the map                set (or move) the selected soldier's destination
//   Left drag the destination         move it
//   Left drag the facing arrow tip    set the facing
//   Right click the destination       clear it
//   Left drag the map / middle drag   pan
//   Mouse wheel                       zoom at the cursor
//
// Generated path turns are shown but are never handles: they are not intent.
//
// With a fire team selected (docs/adr/0022), the same gestures act on its
// formation:
//
//   Left click the map                place the team in a line centred there
//   Left drag the formation centre    move the formation
//   Left drag its facing arrow tip    turn it round its centre
//   Right click the formation centre  delete it
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
  /** The selected fire team: a new line formation centred on `point`. */
  placeFormation(point: Vec2): void;
  moveFormation(point: Vec2): void;
  setFormationFacing(azimuth: Azimuth): void;
  clearFormation(): void;
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
  | { readonly kind: 'formationCentre' }
  | { readonly kind: 'formationFacing' }
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
  /** Whether a destination or formation is being dragged (e.g. to show a quicker preview meanwhile). */
  readonly draggingDestination: boolean;
  /**
   * Whether the pointer is holding a handle (destination, facing arrow,
   * formation, kill-zone corner): a view whose camera also takes drags (3D)
   * leaves this gesture to the controller.
   */
  readonly holdingHandle: boolean;
  /** Ends the current gesture without acting on it (e.g. a click another handler took). */
  cancel(): void;
}

export function createMapController(scene: () => MapScene, actions: MapActions): MapController {
  let mode: Mode = { kind: 'idle' };
  let cursor: MapCursor = 'default';

  /** The map point under a screen point (`null`: none, e.g. the sky in 3D). */
  const toWorld = (s: MapScene, p: Vec2) => s.projection.toWorld(p);

  const hoverCursor = (s: MapScene, p: Vec2): MapCursor => {
    if (s.tool === 'killZone') {
      if (!s.killZoneEditable) return 'grab';
      return killZoneVertexAt(s, p) !== undefined ? 'move' : 'crosshair';
    }
    const team = s.selectedTeam?.editable === true;
    if (team && (isOnFormationFacingHandle(s, p) || isOnFormationCentre(s, p))) return 'move';
    if (s.editable && (isOnFacingHandle(s, p) || isOnDestination(s, p))) return 'move';
    if (selectableSoldiersAt(s, p).length > 0) return 'pointer';
    if (destinationOwnerAt(s, p) !== undefined) return 'pointer';
    return s.editable || team ? 'crosshair' : 'grab';
  };

  const click = (s: MapScene, p: Vec2) => {
    if (s.tool === 'killZone') {
      // Soldiers are not selected with the kill-zone tool, so corners can go anywhere.
      const point = toWorld(s, p);
      if (!s.killZoneEditable || !point || !s.isOnMap(point)) return;
      const index = killZoneInsertionIndexAt(s, p);
      if (index === undefined) actions.addKillZoneVertex(point);
      else actions.addKillZoneVertex(point, index);
      return;
    }
    // Repeated clicks on a cluster step through every Marine in it.
    const next = nextSelectionAt(s, p);
    if (next !== undefined) {
      actions.select(next);
      return;
    }
    // A click on another soldier's waypoint selects him, as a click on him would.
    const owner = destinationOwnerAt(s, p);
    if (owner !== undefined) {
      actions.select(owner);
      return;
    }
    // A click on an OPFOR symbol selects nothing and sets no destination.
    if (soldierAt(s, p)) return;
    const point = toWorld(s, p);
    if (!point || !s.isOnMap(point)) return;
    if (s.selectedTeam?.editable) actions.placeFormation(point);
    else if (s.editable) actions.setDestination(point);
  };

  return {
    get cursor() {
      return cursor;
    },
    get draggingDestination() {
      return mode.kind === 'destination' || mode.kind === 'formationCentre';
    },
    get holdingHandle() {
      return (
        mode.kind === 'destination' ||
        mode.kind === 'facing' ||
        mode.kind === 'formationCentre' ||
        mode.kind === 'formationFacing' ||
        mode.kind === 'killZoneVertex'
      );
    },

    cancel() {
      mode = { kind: 'idle' };
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
        } else if (s.selectedTeam?.editable) {
          if (isOnFormationCentre(s, p)) actions.clearFormation();
        } else {
          if (s.editable && isOnDestination(s, p)) actions.clearDestination();
        }
      } else if (input.button === 0 && s.tool === 'killZone') {
        const index = s.killZoneEditable ? killZoneVertexAt(s, p) : undefined;
        mode =
          index === undefined ? { kind: 'press', start: p } : { kind: 'killZoneVertex', index };
      } else if (input.button === 0) {
        const team = s.selectedTeam?.editable === true;
        if (team && isOnFormationFacingHandle(s, p)) mode = { kind: 'formationFacing' };
        else if (team && isOnFormationCentre(s, p)) mode = { kind: 'formationCentre' };
        else if (s.editable && isOnFacingHandle(s, p)) mode = { kind: 'facing' };
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
          if (s.editable && point && s.isOnMap(point)) actions.setDestination(point);
          return;
        }
        case 'facing': {
          const soldier = selectedSoldier(s);
          if (!s.editable || !soldier) return;
          const destination = s.selectedPlan?.destination;
          const anchor = destination
            ? { x: destination.east, y: destination.north }
            : soldier.position;
          const toward = toWorld(s, p);
          const azimuth = toward ? facingToward(anchor, toward) : undefined;
          if (azimuth !== undefined) actions.setFacing(azimuth);
          return;
        }
        case 'formationCentre': {
          // Positions where the line would not fit are skipped.
          const point = toWorld(s, p);
          if (s.selectedTeam?.editable && point && s.isOnMap(point)) actions.moveFormation(point);
          return;
        }
        case 'formationFacing': {
          const formation = s.selectedTeam?.formation;
          if (!s.selectedTeam?.editable || !formation || !formationGeometry(s)) return;
          const toward = toWorld(s, p);
          const azimuth = toward ? facingToward(formation.centre, toward) : undefined;
          if (azimuth !== undefined) actions.setFormationFacing(azimuth);
          return;
        }
        case 'killZoneVertex': {
          // Positions the zone would refuse (crossing itself, off the map) are skipped.
          const point = toWorld(s, p);
          if (s.killZoneEditable && point && s.isOnMap(point)) {
            actions.moveKillZoneVertex(mode.index, point);
          }
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
