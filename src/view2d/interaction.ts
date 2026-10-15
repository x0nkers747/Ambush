import type { Vec2 } from '#sim';
import { panBy, zoomAt, type Camera } from './camera';
import type { MapScene } from './scene';

// The 2D map's own pointer handling: panning and zooming. Pure state
// machine; the map widget feeds it pointer events in CSS pixels relative to
// the map and applies the cameras it asks for. Clicks and drags an editor
// takes (map.ts) never reach it.
//
//   Left drag / middle drag   pan
//   Mouse wheel               zoom at the cursor

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
  | { readonly kind: 'pan'; readonly last: Vec2 };

export type MapCursor = 'grab' | 'grabbing';

export interface MapController {
  pointerDown(input: PointerInput): void;
  pointerMove(input: PointerInput): void;
  pointerUp(input: PointerInput): void;
  /** `deltaY` as reported by a wheel event (positive scrolls down, zooming out). */
  wheel(screen: Vec2, deltaY: number): void;
  /** The cursor for the current gesture. */
  readonly cursor: MapCursor;
  /** Ends the current gesture without acting on it (e.g. a click an editor took). */
  cancel(): void;
}

export function createMapController(
  scene: () => MapScene,
  setCamera: (camera: Camera) => void,
): MapController {
  let mode: Mode = { kind: 'idle' };
  return {
    get cursor() {
      return mode.kind === 'pan' ? 'grabbing' : 'grab';
    },
    cancel() {
      mode = { kind: 'idle' };
    },
    pointerDown(input) {
      const p = { x: input.x, y: input.y };
      if (input.button === 1) mode = { kind: 'pan', last: p };
      else if (input.button === 0) mode = { kind: 'press', start: p };
    },
    pointerMove(input) {
      const s = scene();
      const p = { x: input.x, y: input.y };
      if (mode.kind === 'press') {
        if (Math.hypot(p.x - mode.start.x, p.y - mode.start.y) < DRAG_THRESHOLD_PX) return;
        setCamera(panBy(s.camera, p.x - mode.start.x, p.y - mode.start.y));
        mode = { kind: 'pan', last: p };
      } else if (mode.kind === 'pan') {
        setCamera(panBy(s.camera, p.x - mode.last.x, p.y - mode.last.y));
        mode = { kind: 'pan', last: p };
      }
    },
    pointerUp() {
      mode = { kind: 'idle' };
    },
    wheel(screen, deltaY) {
      const s = scene();
      setCamera(zoomAt(s.camera, s.viewport, screen, Math.exp(-deltaY * WHEEL_ZOOM_RATE)));
    },
  };
}
