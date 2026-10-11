// Public API of the 2D tactical view (`#view2d`).
export { azimuthFromBearing, bearingDegrees, facingToward, formatBearing } from './bearing';
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
export {
  cameraProjection,
  SOLDIER_ICON_PX,
  SOLDIER_LIFT_M,
  type MapProjection,
  type VisibilityView,
} from './scene';
export { SHOT_LIFT_M, viewshedPixels } from './render';
export {
  AFFILIATION_COLORS,
  drawSoldierIcon,
  ICON_BOX_SCALE,
  soldierIconSvg,
  type Affiliation,
  type SoldierIconSpec,
} from './soldier-icons';
export { describeSymbol, displaySymbolCode, symbolSvg } from './symbology';
export { elevationAt, elevationTints, typicalElevationRange } from './terrain-layer';
export { createViewshedService, type ViewshedService } from './viewshed-service';
export {
  createTacticalMap,
  VIEWSHED_CELL_M,
  VIEWSHED_PREVIEW_CELL_M,
  type MapBinding,
  type MapEditor,
  type MapSurface,
  type MapView,
  type PointerReadout,
  type TacticalMap,
  type TacticalMapOptions,
} from './map';
