// Public API of the 3D battlefield view (`#view3d`, docs/adr/0029). The app
// loads it with a dynamic `import()` the first time 3D is opened, so Three.js
// is not part of the initial bundle.

export {
  createBattlefieldView3d,
  type BattlefieldView3d,
  type BattlefieldView3dOptions,
  type PointerHandler,
} from './view';
export type { GroundOverlay } from './terrain-renderer';
export type { GroundProjection, MapPoint, ScreenPoint } from './ground-projection';
export type { QualityLevel } from './quality';
export { terrainGround, type GroundAt } from './camera-math';
