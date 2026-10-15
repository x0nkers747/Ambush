import { isOnTerrain, type TerrainDataset, type Vec2 } from '#sim';
import { screenToWorld, worldToScreen, type Camera, type Viewport } from './camera';

// Where the map is on screen: the camera and viewport of the 2D map, or a
// perspective view's projection (the 3D battlefield, docs/adr/0039). Pure:
// shared by the renderer, the map's pointer handling and the editors that
// draw over either view.

/**
 * How map points meet the screen (CSS pixels): the 2D map's plan view, or a
 * perspective view of the ground (the 3D battlefield).
 */
export interface MapProjection {
  /**
   * The screen point of a map point on the ground, raised `lift` metres
   * where the view shows height (ignored in plan view). NaN coordinates when
   * it cannot be drawn (behind a perspective camera): such a point hits
   * nothing, and lines are broken there.
   */
  toScreen(point: Vec2, lift?: number): Vec2;
  /** The map point on the ground under a screen point, or `null` (the sky). */
  toWorld(screen: Vec2): Vec2 | null;
  /** The screen point `px` pixels from `point`'s screen point, toward map bearing `azimuth`. */
  along(point: Vec2, azimuth: number, px: number): Vec2;
  /**
   * A map polyline on screen. In perspective, extra points follow the ground
   * between the given ones, so the line lies on the terrain.
   */
  line(points: readonly Vec2[]): Vec2[];
  /** Whether this is a perspective view: no grid, scale bar or north arrow. */
  readonly perspective: boolean;
}

/** The 2D map's projection: plan view through its camera. */
export function cameraProjection(camera: Camera, viewport: Viewport): MapProjection {
  const toScreen = (point: Vec2) => worldToScreen(camera, viewport, point);
  return {
    toScreen,
    toWorld: (screen) => screenToWorld(camera, viewport, screen),
    along: (point, azimuth, px) => {
      const at = toScreen(point);
      return { x: at.x + Math.sin(azimuth) * px, y: at.y - Math.cos(azimuth) * px };
    },
    line: (points) => points.map(toScreen),
    perspective: false,
  };
}

/** What a frame of the map is drawn from. */
export interface MapScene {
  /** The 2D map's camera (plan-view drawing); a perspective view leaves it unused. */
  readonly camera: Camera;
  readonly viewport: Viewport;
  /** Where map points are on screen. */
  readonly projection: MapProjection;
  /** Whether a map point lies on the terrain. */
  isOnMap(point: Vec2): boolean;
}

/** The scene of a frame: by default the 2D map's plan view through `camera`. */
export function buildScene(
  terrain: TerrainDataset,
  camera: Camera,
  viewport: Viewport,
  projection: MapProjection = cameraProjection(camera, viewport),
): MapScene {
  return {
    camera,
    viewport,
    projection,
    isOnMap: (point) => isOnTerrain(terrain, point.x, point.y),
  };
}
