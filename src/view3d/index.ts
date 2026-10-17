// Public API of the 3D battlefield view (`#view3d`, docs/adr/0029). The app
// loads it with a dynamic `import()` the first time 3D is opened, so Three.js
// is not part of the initial bundle.

export {
  createBattlefieldView3d,
  type BattlefieldView3d,
  type CameraPose,
  type BattlefieldView3dOptions,
  type PointerHandler,
  type ViewFigures,
  type ViewLoading,
} from './view';
export type { UnitMarker } from './unit-markers';
export type { AnimationClock } from './characters/layer';
export type { GroundProjection, MapPoint, ScreenPoint } from './ground-projection';
export type { QualityLevel } from './quality';
export { terrainGround, type GroundAt } from './camera-math';
export type { GroundOverlay } from './terrain-renderer';
export type { ViewEarthwork } from './earthworks';
export type { ViewVehicle } from './vehicles';
