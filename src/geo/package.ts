import {
  DEM_CLEANING_VERSION,
  fingerprintPlainData,
  validateTerrain,
  type EnvironmentFeatures,
  type SourceCorrections,
  type TerrainDataset,
} from '#sim';
import { summarizeElevationSources, type SurfaceModel } from './elevation-sources';
import { createFrame, geographicBounds, type BattlefieldFrame, type GeoBox } from './frame';
import { featuresFromOsm, overpassQuery, type OsmImportReport, type OverpassResponse } from './osm';
import {
  buildingsFromOverture,
  OVERTURE_BUILDINGS_ZOOM,
  overtureAttribution,
  overtureTilesFor,
  type OvertureImportReport,
  type OvertureTile,
  type OvertureTileId,
} from './overture';
import {
  battlefieldGrid,
  cleanElevationTiles,
  resampleToGrid,
  tilesForGrid,
  type ElevationTile,
} from './terrarium';
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
export const IMPORTER_VERSION = '1.3.0';

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
    /**
     * The check of the source pixels (docs/adr/0033): grid samples a faulty
     * pixel reached, with their corrected values. The raw grid in `terrain`
     * is left as resampled. Absent in packages made before importer 1.2.
     */
    readonly cleaning?: SourceCorrections;
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
  /**
   * Where the buildings came from (docs/adr/0023). Absent in packages made
   * before importer 1.1, whose buildings are OpenStreetMap's.
   */
  readonly buildings?: {
    readonly source: 'overture' | 'openstreetmap' | 'none';
    /** The Overture release and tiles read, when the buildings are Overture's. */
    readonly overture: {
      readonly release: string;
      readonly url: string;
      readonly zoom: number;
      readonly tiles: readonly (TileId & { readonly missing: boolean })[];
      /** Buildings by the dataset their outline came from. */
      readonly bySource: Readonly<Record<string, number>>;
      readonly datasets: readonly string[];
      readonly merged: number;
      readonly heights: OvertureImportReport['heights'];
    } | null;
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

/** What to download for a request: the frame, the elevation tiles, the building tiles and the OSM queries. */
export interface BattlefieldPlan {
  readonly frame: BattlefieldFrame;
  readonly zoom: number;
  readonly tiles: readonly TileId[];
  /** The Overture building tiles covering the battlefield (docs/adr/0023). */
  readonly buildingTiles: readonly OvertureTileId[];
  /** The OSM query with buildings (when Overture's are not used). */
  readonly osmQuery: string;
  /** The OSM query without buildings (when Overture's are used). */
  readonly osmQueryWithoutBuildings: string;
}

export function planBattlefield(request: BattlefieldRequest): BattlefieldPlan {
  const frame = createFrame(request.centre, request.widthM, request.heightM);
  const zoom = zoomForCellSize(request.centre.lat, request.cellSizeM);
  return {
    frame,
    zoom,
    tiles: tilesForGrid(frame, battlefieldGrid(frame, request.cellSizeM), zoom),
    buildingTiles: overtureTilesFor(frame, OVERTURE_BUILDINGS_ZOOM),
    osmQuery: overpassQuery(geographicBounds(frame, OSM_QUERY_MARGIN_M)),
    osmQueryWithoutBuildings: overpassQuery(geographicBounds(frame, OSM_QUERY_MARGIN_M), {
      buildings: false,
    }),
  };
}

/** Everything downloaded for a battlefield, as the builder needs it. */
export interface BattlefieldInputs {
  readonly request: BattlefieldRequest;
  /** Decoded tiles (elevations `null` when a tile could not be fetched) and their source headers. */
  readonly tiles: readonly (ElevationTile & { readonly sources: string })[];
  readonly elevationUrlTemplate: string;
  /** `null` when OSM was unavailable: the battlefield then has no OSM features. */
  readonly osm: OverpassResponse | null;
  readonly osmEndpoint: string;
  /**
   * Overture's building tiles (docs/adr/0023), or `null` to take the
   * buildings from OSM. When given, the OSM response is read without
   * buildings (it was fetched with `osmQueryWithoutBuildings`).
   */
  readonly overture?: {
    readonly release: string;
    readonly url: string;
    readonly tiles: readonly OvertureTile[];
  } | null;
  /** Why Overture's buildings were not used (it could not be reached), for the warnings. */
  readonly overtureProblem?: string;
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
  // The source pixels checked before resampling (docs/adr/0033): where a faulty
  // pixel reached the grid, the corrected value is kept beside the raw one.
  const checked = cleanElevationTiles(inputs.tiles);
  const corrections: [number, number][] = [];
  if (checked.faultyPixels + checked.invalidPixels + checked.brokenEdges > 0) {
    const clean = resampleToGrid(frame, grid, zoom, checked.tiles).elevations;
    clean.forEach((v, i) => {
      if (Math.abs(v - (resampled.elevations[i] ?? v)) >= 0.01) corrections.push([i, v]);
    });
  }
  const sources = summarizeElevationSources(inputs.tiles.map((t) => t.sources));
  const overture = inputs.overture ?? null;
  const osm = inputs.osm
    ? featuresFromOsm(inputs.osm, frame, { buildings: overture === null })
    : null;
  const ovt = overture ? buildingsFromOverture(overture.tiles, frame) : null;
  const osmFeatures: Required<EnvironmentFeatures> = osm?.features ?? {
    roads: [],
    buildings: [],
    vegetation: [],
    water: [],
    waterways: [],
    landUse: [],
  };
  const features: Required<EnvironmentFeatures> = ovt
    ? { ...osmFeatures, buildings: ovt.buildings }
    : osmFeatures;
  const buildingSource = ovt ? 'overture' : inputs.osm ? 'openstreetmap' : 'none';
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
  const warnings = [...(osm?.report.warnings ?? []), ...(ovt?.report.warnings ?? [])];
  if (inputs.overtureProblem !== undefined && !ovt) {
    warnings.push(
      `Buildings are from OpenStreetMap: Overture Maps could not be used (${inputs.overtureProblem}).`,
    );
  }
  if (!inputs.osm) {
    warnings.push(
      ovt
        ? 'OpenStreetMap data could not be fetched: the battlefield has terrain and buildings only (no roads, vegetation or water).'
        : 'OpenStreetMap data could not be fetched: the battlefield has terrain only.',
    );
  }
  if (resampled.filled > 0) {
    warnings.push(
      `${String(resampled.filled)} elevation sample(s) had no source data and were filled from their neighbours.`,
    );
  }
  if (checked.unresolvedRegions - checked.seamOffsets > 0) {
    warnings.push(
      `The elevation source has ${String(checked.unresolvedRegions - checked.seamOffsets)} region(s) of faulty data too large to rebuild with confidence.`,
    );
  }
  if (checked.seamOffsets > 0) {
    warnings.push(
      `The elevation source steps by a few metres along ${String(checked.seamOffsets)} tile edge(s) (sources that disagree); the steps are left as they are.`,
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
      cleaning: {
        version: DEM_CLEANING_VERSION,
        faultyPixels: checked.faultyPixels,
        invalidPixels: checked.invalidPixels,
        brokenEdges: checked.brokenEdges,
        seamOffsets: checked.seamOffsets,
        unresolvedRegions: checked.unresolvedRegions,
        samples: corrections,
      },
      // A loop, not Math.min(...elevations): spreading 251 001 samples (5 km) overflows the stack.
      minM: elevations.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY),
      maxM: elevations.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY),
    },
    osm: {
      endpoint: inputs.osmEndpoint,
      query: overture ? plan.osmQueryWithoutBuildings : plan.osmQuery,
      timestampOsmBase: osm?.report.timestampOsmBase ?? null,
      elementCount: osm?.report.elements ?? 0,
      available: inputs.osm !== null,
    },
    buildings: {
      source: buildingSource,
      overture:
        overture && ovt
          ? {
              release: overture.release,
              url: overture.url,
              zoom: overture.tiles[0]?.z ?? OVERTURE_BUILDINGS_ZOOM,
              tiles: overture.tiles.map((t) => ({
                z: t.z,
                x: t.x,
                y: t.y,
                missing: t.data === null,
              })),
              bySource: ovt.report.bySource,
              datasets: ovt.report.datasets,
              merged: ovt.report.merged,
              heights: ovt.report.heights,
            }
          : null,
    },
    attribution: [
      // OpenStreetMap's credit also covers Overture buildings drawn from OSM.
      ...(inputs.osm || ovt?.report.datasets.includes('OpenStreetMap') ? [OSM_ATTRIBUTION] : []),
      ...(ovt ? overtureAttribution(ovt.report.datasets) : []),
      TERRAIN_TILES_ATTRIBUTION,
      ...sources.attribution,
    ],
    processing: {
      importerVersion: IMPORTER_VERSION,
      counts: {
        ...(osm?.report.counts ?? {
          roads: 0,
          buildings: 0,
          vegetation: 0,
          water: 0,
          waterways: 0,
          landUse: 0,
        }),
        buildings: features.buildings.length,
      },
      dropped: [...(osm?.report.dropped ?? []), ...(ovt?.report.dropped ?? [])],
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
  const cleaning = (d['elevation'] as { cleaning?: unknown } | undefined)?.cleaning;
  if (cleaning !== undefined) {
    const c = cleaning as Partial<SourceCorrections>;
    const count = terrain.heightfield.elevations.length;
    if (
      typeof c.version !== 'string' ||
      !Array.isArray(c.samples) ||
      !c.samples.every(
        (e) =>
          Array.isArray(e) &&
          Number.isInteger(e[0]) &&
          (e[0] ?? -1) >= 0 &&
          (e[0] ?? count) < count &&
          Number.isFinite(e[1]),
      )
    ) {
      fail('its elevation corrections are invalid');
    }
  }
  const pkg = data as BattlefieldPackage;
  if (fingerprintPlainData({ request: pkg.request, terrain: pkg.terrain }) !== pkg.id) {
    fail('its content does not match its id (the data was changed or damaged)');
  }
  return pkg;
}
