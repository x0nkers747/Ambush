// Public API of the data acquisition layer (`#acquire`, docs/adr/0014): the
// geographic services, battlefield generation and saved battlefields.
export {
  DEFAULT_SERVICES,
  loadServiceConfig,
  SERVICE_CONFIG_KEY,
  type ServiceConfig,
} from './config';
export {
  generateBattlefield,
  OsmUnavailableError,
  type GenerateOptions,
  type GenerationProgress,
  type GenerationStep,
} from './generate';
export {
  CancelledError,
  createRateLimiter,
  fetchWithRetry,
  isCancelled,
  mapWithConcurrency,
  ServiceError,
  sleep,
  type FetchLike,
  type RetryOptions,
  type Sleep,
} from './http';
export {
  decodePngInBrowser,
  decodeStoredTile,
  fetchOverpass,
  fetchTerrainTile,
  NOMINATIM,
  OVERPASS,
  searchPlaces,
  TERRAIN_TILES,
  tileUrl,
  type DecodePng,
  type FetchedTile,
  type OverpassResult,
  type PlaceResult,
} from './services';
export {
  createMemoryStore,
  openIndexedDbStore,
  summarize,
  type BattlefieldSources,
  type BattlefieldStore,
  type BattlefieldSummary,
} from './store';
