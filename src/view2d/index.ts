// Public API of the 2D tactical view (`#view2d`).
export {
  fitBounds,
  panBy,
  screenToWorld,
  terrainBounds,
  worldToScreen,
  zoomAt,
  type Bounds,
  type Camera,
  type Viewport,
} from './camera';
export { buildScene, cameraProjection, type MapProjection, type MapScene } from './scene';
export { elevationAt, elevationTints, typicalElevationRange } from './terrain-layer';
export {
  createTacticalMap,
  type MapBinding,
  type MapEditor,
  type MapSurface,
  type MapView,
  type PointerReadout,
  type TacticalMap,
  type TacticalMapOptions,
} from './map';
export { createViewshedService, type ViewshedService } from './viewshed-service';
export { drawViewshed, viewshedPixels } from './viewshed-overlay';
