// The terrain field (docs/adr/0049, docs/ground-level-terrain-architecture-research.md):
// the ground as constraints (roads, bridge decks, building pads, channels,
// water beds) on the cleaned elevation model, and its sampled surface. The
// simulation's ground is sampled from it (../ground.ts); the 3D view draws it.
export { baseSurface, type BaseSurface } from './base';
export { PAD_APRON_M, padDistance, type PadStamp } from './buildings';
export { CHANNEL_STEP_M, channelLevelAt, type ChannelStamp } from './channels';
export {
  compileField,
  DEFAULT_FIELD_SPEC,
  emptySample,
  TERRAIN_FIELD_VERSION,
  type Clock,
  type FieldInput,
  type FieldSample,
  type FieldSpec,
  type FieldStats,
  type TerrainField,
} from './field';
export { Cover, COVER_LOOK, coverMap, RELIEF_WAVELENGTHS, type CoverMap } from './landcover';
export { gradientNoise, hash01, hash2, smoothstep } from './noise';
export {
  DECK_CLEARANCE_M,
  DECK_END_M,
  DECK_SEAT_M,
  DECK_THICKNESS_M,
  deckHalfWidth,
  deckIndex,
  type DeckIndex,
} from './decks';
export { levelAt, nearestOnRoad, roadLevel, RoadSurface, type RoadStamp } from './roads';
export {
  BLOCK_CELLS,
  BUILDING_RANGE,
  createSurface,
  generateTile,
  MATERIAL_BYTES,
  PAVED_AREA_SURFACE,
  ROAD_EDGE_RANGE,
  SHORE_RANGE,
  TILE_M,
  tileHash,
  type SurfaceOptions,
  type SurfaceStats,
  type SurfaceTile,
  type TerrainSurface,
} from './surface';
