import { Vector3, type PerspectiveCamera } from 'three';
import { groundHit, type GroundAt } from './camera-math';

// The 3D view's ground as a map projection (docs/adr/0039): battlefield map
// points (x east, y north, metres) on the authoritative ground, to and from
// the canvas (CSS pixels) through the 3D camera. The app hands it to the 2D
// map's scene, controller and overlay renderer, so the 3D view selects,
// edits and draws the tactical picture with the same code and commands as
// the 2D map. Pure Three.js maths: no WebGL, so it is tested as it is used.

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** A map point (battlefield metres). */
export interface MapPoint {
  readonly x: number;
  readonly y: number;
}

/** Structurally the 2D map's `MapProjection` (view2d), which this layer cannot import. */
export interface GroundProjection {
  toScreen(point: MapPoint, lift?: number): ScreenPoint;
  toWorld(screen: ScreenPoint): MapPoint | null;
  along(point: MapPoint, azimuth: number, px: number): ScreenPoint;
  line(points: readonly MapPoint[]): ScreenPoint[];
  readonly perspective: true;
}

/**
 * Overlays sit this far above the ground (metres): enough that a point on the
 * ground between two mesh vertices is not hidden by rounding, small enough
 * that nothing visibly floats.
 */
export const OVERLAY_LIFT_M = 0.05;
/** Ground-following lines get a point at least this often (metres), up to `MAX_LINE_STEPS` per segment. */
export const LINE_STEP_M = 4;
const MAX_LINE_STEPS = 96;

const NOT_DRAWN: ScreenPoint = Object.freeze({ x: Number.NaN, y: Number.NaN });

export function groundProjection(
  camera: PerspectiveCamera,
  groundAt: GroundAt,
  /** The canvas size in CSS pixels. */
  size: { readonly width: number; readonly height: number },
  /** The ground off the battlefield (the plain round it), where `groundAt` has none. */
  floor: number,
): GroundProjection {
  // The camera's matrices as of this projection (one per frame).
  camera.updateMatrixWorld();
  const view = camera.matrixWorldInverse.clone();
  const projection = camera.projectionMatrix.clone();
  const v = new Vector3();
  const ground = (p: MapPoint) => groundAt(p.x, -p.y) ?? floor;

  const toScreen = (point: MapPoint, lift = 0): ScreenPoint => {
    v.set(point.x, ground(point) + OVERLAY_LIFT_M + lift, -point.y).applyMatrix4(view);
    // Behind the camera (or at it): not drawable.
    if (v.z > -camera.near) return NOT_DRAWN;
    v.applyMatrix4(projection);
    return { x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height };
  };

  const ray = new Vector3();
  const toWorld = (screen: ScreenPoint): MapPoint | null => {
    if (!(size.width > 0 && size.height > 0)) return null;
    const ndc = new Vector3(
      (screen.x / size.width) * 2 - 1,
      -(screen.y / size.height) * 2 + 1,
      0.5,
    );
    ray.copy(ndc).unproject(camera).sub(camera.position).normalize();
    const hit = groundHit(camera.position, ray, groundAt, camera.far);
    return hit ? { x: hit.x, y: -hit.z } : null;
  };

  return {
    toScreen,
    toWorld,
    along(point, azimuth, px) {
      const from = toScreen(point);
      // The bearing's direction on screen, from a metre along it on the ground.
      const to = toScreen({
        x: point.x + Math.sin(azimuth),
        y: point.y + Math.cos(azimuth),
      });
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy);
      if (!(length > 1e-9)) {
        return { x: from.x + Math.sin(azimuth) * px, y: from.y - Math.cos(azimuth) * px };
      }
      return { x: from.x + (dx / length) * px, y: from.y + (dy / length) * px };
    },
    line(points) {
      const out: ScreenPoint[] = [];
      points.forEach((b, i) => {
        const a = points[i - 1];
        if (!a) {
          out.push(toScreen(b));
          return;
        }
        const steps = Math.min(
          MAX_LINE_STEPS,
          Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / LINE_STEP_M)),
        );
        for (let k = 1; k <= steps; k += 1) {
          const t = k / steps;
          out.push(toScreen({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
        }
      });
      return out;
    },
    perspective: true,
  };
}
