import {
  fingerprintPlainData,
  validateTerrain,
  type EnvironmentFeatures,
  type TerrainDataset,
} from '#sim';
import { summarizeElevationSources, type SurfaceModel } from './elevation-sources';
import { createFrame, geographicBounds, type BattlefieldFrame, type GeoBox } from './frame';
import { featuresFromOsm, overpassQuery, type OsmImportReport, type OverpassResponse } from './osm';
import { battlefieldGrid, resampleToGrid, tilesForGrid, type ElevationTile } from './terrarium';
import { zoomForCellSize, type TileId } from './tiles';
import { normalizeLon, validateLatLon, type Hemisphere, type LatLon } from './utm';

// Battlefield packages (docs/adr/0014): a generated battlefield, complete and
// self-contained. It holds the terrain in the simulation's own format plus
// everything needed to trust, credit and reproduce it: the georeference, the
// sources, the processing report and the attribution. Once built it never
// changes, so a saved battlefield is the same every time it is loaded, however
// OpenStreetMap changes afterwards. Packages are plain data (JSON-safe), so
// they can be stored, exported and imported as they are.

export const BATTLEFIELD_SCHEMA = 'ambush.battlefield';
export const BATTLEFIELD_SCHEMA_VERSION = 1;
/** The importer's own version: tag mapping, defaults and processing rules. */
export const IMPORTER_VERSION = '1.0.0';

/** The only battlefield size offered for now; the format supports others. */
export const DEFAULT_BATTLEFIELD_SIZE_M = 5000;
/** Default elevation grid spacing: 501 × 501 samples for 5 km. */
export const DEFAULT_CELL_SIZE_M = 10;
/** Margin around the battlefield for the OSM query, so features crossing the edge are complete. */
export const OSM_QUERY_MARGIN_M = 100;

export interface BattlefieldRequest {
  readonly centre: LatLon;
  readonly widthM: number;
  readonly heightM: number;
  readonly cellSizeM: number;
  /** e.g. the place-name search result chosen; defaults to the coordinates. */
  readonly name?: string;
}

export interface BattlefieldPackage {
  readonly schema: typeof BATTLEFIELD_SCHEMA;
  readonly schemaVersion: typeof BATTLEFIELD_SCHEMA_VERSION;
  /** Content fingerprint of the request and terrain: identical inputs give the same id. */
  readonly id: string;
  readonly name: string;
  /** When it was generated (ISO 8601). Metadata only. */
  readonly createdAt: string;
  readonly request: BattlefieldRequest;
  readonly frame: {
    readonly zone: number;
    readonly hemisphere: Hemisphere;
    readonly epsg: number;
    readonly falseEasting: number;
    readonly falseNorthing: number;
  };
  /** WGS84 boxes covering the battlefield (two across ±180°). */
  readonly geographicBounds: readonly GeoBox[];
  /** The terrain in the simulation's format (3), with its georeference. */
  readonly terrain: TerrainDataset;
  readonly elevation: {
    readonly provider: 'aws-terrain-tiles-terrarium';
    readonly urlTemplate: string;
    readonly zoom: number;
    readonly tiles: readonly (TileId & { readonly sources: string; readonly missing: boolean })[];
    readonly datasets: readonly {
      readonly key: string;
      readonly name: string;
      readonly resolutionM: number;
      readonly model: 'DTM' | 'DSM';
    }[];
    readonly unrecognisedSources: readonly string[];
    /** Finest native resolution listed for these tiles; the 10 m grid adds no detail beyond it. */
    readonly finestResolutionM: number | null;
    readonly coarsestResolutionM: number | null;
    readonly surfaceModel: SurfaceModel;
    /** Grid samples with no source pixels, filled from their neighbours. */
    readonly filledSamples: number;
    readonly minM: number;
    readonly maxM: number;
  };
  readonly osm: {
    readonly endpoint: string;
    readonly query: string;
    readonly timestampOsmBase: string | null;
    readonly elementCount: number;
    /** `false` when OSM could not be fetched and the battlefield has elevation only. */
    readonly available: boolean;
  };
  /** Credits the sources' licences require, to be shown with the map. */
  readonly attribution: readonly string[];
  readonly processing: {
    readonly importerVersion: string;
    readonly counts: OsmImportReport['counts'];
    readonly dropped: OsmImportReport['dropped'];
    readonly warnings: readonly string[];
  };
}

export class BattlefieldPackageError extends Error {
  override name = 'BattlefieldPackageError';
}

export const OSM_ATTRIBUTION =
  'Map data © OpenStreetMap contributors (ODbL), openstreetmap.org/copyright';
export const TERRAIN_TILES_ATTRIBUTION = 'Terrain Tiles (Mapzen / Linux Foundation), AWS Open Data';

/** A request for a battlefield centred on a position. Throws for positions outside UTM. */
export function battlefieldRequest(
  centre: LatLon,
  options: { name?: string; widthM?: number; heightM?: number; cellSizeM?: number } = {},
): BattlefieldRequest {
  validateLatLon(centre);
  const widthM = options.widthM ?? DEFAULT_BATTLEFIELD_SIZE_M;
  return {
    centre: { lat: centre.lat, lon: normalizeLon(centre.lon) },
    widthM,
    heightM: options.heightM ?? widthM,
    cellSizeM: options.cellSizeM ?? DEFAULT_CELL_SIZE_M,
    ...(options.name !== undefined && options.name.trim() !== ''
      ? { name: options.name.trim() }
      : {}),
  };
}

/** What to download for a request: the frame, the elevation tiles and the OSM query. */
export interface BattlefieldPlan {
  readonly frame: BattlefieldFrame;
  readonly zoom: number;
  readonly tiles: readonly TileId[];
  readonly osmQuery: string;
}

export function planBattlefield(request: BattlefieldRequest): BattlefieldPlan {
  const frame = createFrame(request.centre, request.widthM, request.heightM);
  const zoom = zoomForCellSize(request.centre.lat, request.cellSizeM);
  return {
    frame,
    zoom,
    tiles: tilesForGrid(frame, battlefieldGrid(frame, request.cellSizeM), zoom),
    osmQuery: overpassQuery(geographicBounds(frame, OSM_QUERY_MARGIN_M)),
  };
}

/** Everything downloaded for a battlefield, as the builder needs it. */
export interface BattlefieldInputs {
  readonly request: BattlefieldRequest;
  /** Decoded tiles (elevations `null` when a tile could not be fetched) and their source headers. */
  readonly tiles: readonly (ElevationTile & { readonly sources: string })[];
  readonly elevationUrlTemplate: string;
  /** `null` when OSM was unavailable: the battlefield then has terrain only. */
  readonly osm: OverpassResponse | null;
  readonly osmEndpoint: string;
  /** ISO 8601 time of generation (the builder is pure, so the caller supplies it). */
  readonly createdAt: string;
}

/**
 * Builds a battlefield package from downloaded data. Pure and deterministic
 * (except `createdAt`, which is supplied). Throws a `BattlefieldPackageError`
 * when the elevation data is unusable; OSM problems only produce warnings.
 */
export function buildBattlefield(inputs: BattlefieldInputs): BattlefieldPackage {
  const { request } = inputs;
  const plan = planBattlefield(request);
  const { frame, zoom } = plan;
  const grid = battlefieldGrid(frame, request.cellSizeM);
  let resampled;
  try {
    resampled = resampleToGrid(frame, grid, zoom, inputs.tiles);
  } catch (error) {
    throw new BattlefieldPackageError(
      `Elevation data unavailable: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const sources = summarizeElevationSources(inputs.tiles.map((t) => t.sources));
  const osm = inputs.osm ? featuresFromOsm(inputs.osm, frame) : null;
  const features: Required<EnvironmentFeatures> = osm?.features ?? {
    roads: [],
    buildings: [],
    vegetation: [],
    water: [],
    waterways: [],
    landUse: [],
  };
  const terrain: TerrainDataset = {
    formatVersion: 3,
    georef: {
      crs: `EPSG:${String(frame.epsg)}`,
      falseEasting: frame.falseEasting,
      falseNorthing: frame.falseNorthing,
      verticalDatum: 'as provided by AWS Terrain Tiles (varies by source dataset)',
    },
    heightfield: { ...grid, elevations: resampled.elevations },
    features,
    metadata: {
      elevationResolutionM: sources.finestResolutionM,
      surfaceModel: sources.surfaceModel,
    },
  };
  try {
    validateTerrain(terrain);
  } catch (error) {
    throw new BattlefieldPackageError(
      `The generated terrain is invalid: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const warnings = [...(osm?.report.warnings ?? [])];
  if (!inputs.osm)
    warnings.push('OpenStreetMap data could not be fetched: the battlefield has terrain only.');
  if (resampled.filled > 0) {
    warnings.push(
      `${String(resampled.filled)} elevation sample(s) had no source data and were filled from their neighbours.`,
    );
  }
  if (sources.surfaceModel === 'DSM' || sources.surfaceModel === 'mixed') {
    warnings.push(
      'The elevation source is (at least partly) a surface model: tree canopy and buildings may raise the ground, so woods and built-up areas can be counted twice in line of sight.',
    );
  }
  const missingTiles = inputs.tiles.filter((t) => t.elevations === null).length;
  if (missingTiles > 0)
    warnings.push(`${String(missingTiles)} elevation tile(s) could not be fetched.`);
  const elevations = resampled.elevations;
  const name = request.name ?? formatCoordinates(request.centre);
  const id = fingerprintPlainData({ request, terrain });
  return {
    schema: BATTLEFIELD_SCHEMA,
    schemaVersion: BATTLEFIELD_SCHEMA_VERSION,
    id,
    name,
    createdAt: inputs.createdAt,
    request,
    frame: {
      zone: frame.zone,
      hemisphere: frame.hemisphere,
      epsg: frame.epsg,
      falseEasting: frame.falseEasting,
      falseNorthing: frame.falseNorthing,
    },
    geographicBounds: geographicBounds(frame, 0),
    terrain,
    elevation: {
      provider: 'aws-terrain-tiles-terrarium',
      urlTemplate: inputs.elevationUrlTemplate,
      zoom,
      tiles: inputs.tiles.map((t) => ({
        z: t.z,
        x: t.x,
        y: t.y,
        sources: t.sources,
        missing: t.elevations === null,
      })),
      datasets: sources.datasets.map(({ key, name: n, resolutionM, model }) => ({
        key,
        name: n,
        resolutionM,
        model,
      })),
      unrecognisedSources: sources.unrecognised,
      finestResolutionM: sources.finestResolutionM,
      coarsestResolutionM: sources.coarsestResolutionM,
      surfaceModel: sources.surfaceModel,
      filledSamples: resampled.filled,
      // A loop, not Math.min(...elevations): spreading 251 001 samples (5 km) overflows the stack.
      minM: elevations.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY),
      maxM: elevations.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY),
    },
    osm: {
      endpoint: inputs.osmEndpoint,
      query: plan.osmQuery,
      timestampOsmBase: osm?.report.timestampOsmBase ?? null,
      elementCount: osm?.report.elements ?? 0,
      available: inputs.osm !== null,
    },
    attribution: [
      ...(inputs.osm ? [OSM_ATTRIBUTION] : []),
      TERRAIN_TILES_ATTRIBUTION,
      ...sources.attribution,
    ],
    processing: {
      importerVersion: IMPORTER_VERSION,
      counts: osm?.report.counts ?? {
        roads: 0,
        buildings: 0,
        vegetation: 0,
        water: 0,
        waterways: 0,
        landUse: 0,
      },
      dropped: osm?.report.dropped ?? [],
      warnings,
    },
  };
}

/** "38.52230° N, 77.29340° W". */
export function formatCoordinates(p: LatLon, digits = 5): string {
  const lat = `${Math.abs(p.lat).toFixed(digits)}° ${p.lat >= 0 ? 'N' : 'S'}`;
  const lon = `${Math.abs(p.lon).toFixed(digits)}° ${p.lon >= 0 ? 'E' : 'W'}`;
  return `${lat}, ${lon}`;
}

/**
 * Reads a stored or imported package: checks the schema and version and
 * validates the terrain. Throws a `BattlefieldPackageError` saying what is
 * wrong, so corrupted or incompatible data is reported, never half-loaded.
 */
export function parseBattlefieldPackage(data: unknown): BattlefieldPackage {
  const fail = (message: string): never => {
    throw new BattlefieldPackageError(`Battlefield not loaded: ${message}.`);
  };
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return fail('the data is not an object');
  const d = data as Record<string, unknown>;
  if (d['schema'] !== BATTLEFIELD_SCHEMA) fail(`the schema is not "${BATTLEFIELD_SCHEMA}"`);
  if (d['schemaVersion'] !== BATTLEFIELD_SCHEMA_VERSION) {
    fail(
      `schema version ${JSON.stringify(d['schemaVersion'])} is not supported (this version reads ${String(BATTLEFIELD_SCHEMA_VERSION)})`,
    );
  }
  for (const key of ['id', 'name', 'createdAt']) {
    if (typeof d[key] !== 'string' || d[key] === '') fail(`"${key}" is missing`);
  }
  const request = d['request'] as BattlefieldRequest | undefined;
  if (!request || typeof request !== 'object') return fail('"request" is missing');
  try {
    validateLatLon(request.centre);
  } catch (error) {
    fail(`its centre is invalid (${error instanceof Error ? error.message : String(error)})`);
  }
  const terrain = d['terrain'] as TerrainDataset | undefined;
  if (!terrain || typeof terrain !== 'object') return fail('"terrain" is missing');
  try {
    validateTerrain(terrain);
  } catch (error) {
    fail(`its terrain is invalid (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!Array.isArray(d['attribution'])) fail('"attribution" is missing');
  const pkg = data as BattlefieldPackage;
  if (fingerprintPlainData({ request: pkg.request, terrain: pkg.terrain }) !== pkg.id) {
    fail('its content does not match its id (the data was changed or damaged)');
  }
  return pkg;
}
