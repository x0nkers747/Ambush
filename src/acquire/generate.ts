import {
  buildBattlefield,
  planBattlefield,
  type BattlefieldPackage,
  type BattlefieldRequest,
  type OverpassResponse,
} from '#geo';
import type { ServiceConfig } from './config';
import {
  CancelledError,
  mapWithConcurrency,
  ServiceError,
  type FetchLike,
  type Sleep,
} from './http';
import { fetchOverpass, fetchTerrainTile, type DecodePng, type FetchedTile } from './services';
import type { BattlefieldStore } from './store';

// Generating a battlefield (docs/adr/0014): download the elevation tiles and
// the OSM features, build the package, save it. Elevation comes first: without
// it there is no battlefield. OSM problems can be accepted (terrain only) when
// the player chooses to.

export type GenerationStep = 'elevation' | 'osm' | 'processing' | 'saving';

export interface GenerationProgress {
  readonly step: GenerationStep;
  readonly message: string;
  /** For steps with parts (tiles): how many are done of how many. */
  readonly done?: number;
  readonly total?: number;
}

export interface GenerateOptions {
  readonly config: ServiceConfig;
  readonly store: BattlefieldStore;
  readonly fetch: FetchLike;
  readonly decodePng: DecodePng;
  readonly signal?: AbortSignal;
  readonly sleep?: Sleep;
  /** The time recorded in the package. */
  readonly now?: () => Date;
  readonly onProgress?: (progress: GenerationProgress) => void;
  /** When OSM cannot be fetched, build a terrain-only battlefield instead of failing. */
  readonly allowMissingOsm?: boolean;
}

/** OSM failed; the player may choose to continue with terrain only. */
export class OsmUnavailableError extends ServiceError {
  override name = 'OsmUnavailableError';
}

/**
 * Downloads, builds and saves a battlefield. Throws `ServiceError` (naming the
 * service) when a download fails, `OsmUnavailableError` when only OSM failed,
 * `BattlefieldPackageError` when the data cannot make a battlefield, and
 * `CancelledError` when cancelled.
 */
export async function generateBattlefield(
  request: BattlefieldRequest,
  o: GenerateOptions,
): Promise<BattlefieldPackage> {
  const report = o.onProgress ?? (() => undefined);
  const check = () => {
    if (o.signal?.aborted) throw new CancelledError();
  };
  const plan = planBattlefield(request);
  const client = (step: GenerationStep) => ({
    fetch: o.fetch,
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    onRetry: ({ waitMs, reason }: { waitMs: number; reason: string }) => {
      report({ step, message: `Retrying in ${String(Math.round(waitMs / 1000))} s: ${reason}.` });
    },
  });

  // 1. Elevation.
  let done = 0;
  const total = plan.tiles.length;
  report({
    step: 'elevation',
    message: `Downloading elevation tiles (0 of ${String(total)})…`,
    done,
    total,
  });
  const tiles: FetchedTile[] = await mapWithConcurrency(
    plan.tiles,
    o.config.tileConcurrency,
    async (tile) => {
      const fetched = await fetchTerrainTile(tile, o.config, o.decodePng, client('elevation'));
      done += 1;
      report({
        step: 'elevation',
        message: `Downloading elevation tiles (${String(done)} of ${String(total)})…`,
        done,
        total,
      });
      return fetched;
    },
  );
  check();

  // 2. OpenStreetMap.
  report({ step: 'osm', message: 'Downloading map features from OpenStreetMap…' });
  let osm: { response: OverpassResponse; endpoint: string; text: string } | null = null;
  try {
    osm = await fetchOverpass(plan.osmQuery, o.config, client('osm'));
  } catch (error) {
    if (!(error instanceof ServiceError) || !o.allowMissingOsm) {
      if (error instanceof ServiceError)
        throw new OsmUnavailableError(error.service, error.message, error.status);
      throw error;
    }
  }
  check();

  // 3. Processing (pure; fast enough for a 1 km battlefield to run here).
  report({ step: 'processing', message: 'Building the battlefield…' });
  const pkg = buildBattlefield({
    request,
    tiles,
    elevationUrlTemplate: o.config.terrainTileUrl,
    osm: osm?.response ?? null,
    osmEndpoint: osm?.endpoint ?? o.config.overpassEndpoints[0] ?? '',
    createdAt: (o.now ?? (() => new Date()))().toISOString(),
  });
  check();

  // 4. Saving, with the source data for reprocessing.
  report({ step: 'saving', message: 'Saving the battlefield…' });
  await o.store.put(pkg, {
    overpassText: osm?.text ?? null,
    overpassEndpoint: osm?.endpoint ?? '',
    tiles: tiles.map((t) => ({ z: t.z, x: t.x, y: t.y, png: t.png, sources: t.sources })),
  });
  return pkg;
}
