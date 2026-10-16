import {
  assembleGround,
  cleanTerrain,
  gradeTerrain,
  groundBands,
  TERRAIN_MODEL,
  type DemQualityReport,
  type GroundBand,
  type SourceCorrections,
  type TerrainDataset,
} from '#sim';
import { preparedTerrainFrom } from '#geo';
import type { TerrainJob, TerrainJobResult } from './grading.worker';

// The authoritative terrain of a battlefield (docs/adr/0033, docs/adr/0049):
// its stored raw terrain, with its DEM cleaned and the terrain field sampled
// from it. Prepared once per battlefield, page and terrain model, in workers
// where the browser has them, so the page stays responsive; the stored
// package is never changed.

export interface PreparedTerrain {
  readonly terrain: TerrainDataset;
  readonly quality: DemQualityReport;
}

/** A preparation under way (or done): its result, and its progress for those waiting on it. */
interface Preparation {
  readonly promise: Promise<PreparedTerrain>;
  /** 0–1, or `null` while it is only being read back from the cache. */
  progress: number | null;
  readonly listeners: Set<(progress: number) => void>;
}

const prepared = new Map<string, Preparation>();

/** Reported progress: preparing a terrain, 0 to 1. */
export type TerrainProgress = (fraction: number) => void;

/** Grid rows per band handed to a worker: small enough to share the work out evenly. */
const BAND_ROWS = 24;
/** Most workers sampling the field at once. */
const MAX_WORKERS = 8;

/**
 * Where prepared terrain is kept between visits (the battlefield store's
 * `getPrepared` / `putPrepared` for one battlefield), so a battlefield is
 * prepared once, not on every page load.
 */
export interface PreparedTerrainCache {
  get(model: string): Promise<unknown>;
  put(model: string, prepared: PreparedTerrain): Promise<void>;
}

/** A prepared terrain read back from storage, or `null` when it is not one (damaged: prepared again). */
export const preparedFrom = (data: unknown): PreparedTerrain | null => preparedTerrainFrom(data);

/**
 * The authoritative terrain of battlefield `id`, whose stored (raw) terrain is
 * `source` and import-time DEM corrections `corrections`. Cached by id and by
 * terrain model (cleaning and field versions), so a terrain prepared by
 * other rules is never reused: in memory for the page, and in `cache` (the
 * battlefield store) across visits, where it is saved once prepared.
 */
export function authoritativeTerrain(
  id: string,
  source: TerrainDataset,
  corrections: SourceCorrections | null,
  cache?: PreparedTerrainCache,
  onProgress?: TerrainProgress,
): Promise<PreparedTerrain> {
  const key = `${id}|${TERRAIN_MODEL}`;
  let entry = prepared.get(key);
  if (!entry) {
    const listeners = new Set<(progress: number) => void>();
    let made: Preparation | null = null;
    const report = (fraction: number) => {
      if (made) made.progress = fraction;
      for (const l of listeners) l(fraction);
    };
    const prepare = () =>
      typeof Worker === 'undefined'
        ? Promise.resolve(prepareInline(source, corrections))
        : prepareOffThread(source, corrections, report);
    const promise = cache
      ? cache
          .get(TERRAIN_MODEL)
          .catch(() => undefined)
          .then(async (stored) => {
            const known = preparedFrom(stored);
            if (known) return known;
            const made = await prepare();
            // Saving is a convenience: a failure only means preparing it again next time.
            await cache.put(TERRAIN_MODEL, made).catch(() => undefined);
            return made;
          })
      : prepare();
    made = { promise, progress: null, listeners };
    entry = made;
    // Only the latest battlefield is kept.
    prepared.clear();
    prepared.set(key, made);
  }
  if (onProgress) {
    const e = entry;
    e.listeners.add(onProgress);
    if (e.progress !== null) onProgress(e.progress);
    void e.promise.finally(() => e.listeners.delete(onProgress)).catch(() => undefined);
  }
  return entry.promise;
}

function prepareInline(
  source: TerrainDataset,
  corrections: SourceCorrections | null,
): PreparedTerrain {
  const { terrain, report } = cleanTerrain(source, corrections);
  return { terrain: gradeTerrain(terrain), quality: report };
}

function startWorker(): Worker {
  return new Worker(new URL('./grading.worker.ts', import.meta.url), {
    type: 'module',
    name: 'ambush-terrain',
  });
}

/** Runs one job on a fresh worker (`onBand`: each band of a `bands` job done). */
function run(job: TerrainJob, onBand?: () => void): Promise<TerrainJobResult> {
  return new Promise((resolve, reject) => {
    const worker = startWorker();
    worker.onmessage = ({ data }: MessageEvent<TerrainJobResult>) => {
      if (data.kind === 'progress') {
        onBand?.();
        return;
      }
      worker.terminate();
      if (data.kind === 'error')
        reject(new Error(`The terrain could not be prepared: ${data.error}`));
      else resolve(data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(`The terrain could not be prepared: ${event.message}`));
    };
    worker.postMessage(job);
  });
}

/** Of a preparation's progress: the share of the DEM cleaning (the rest is the field's bands). */
const CLEANING_SHARE = 0.05;

async function prepareOffThread(
  source: TerrainDataset,
  corrections: SourceCorrections | null,
  report: TerrainProgress = () => undefined,
): Promise<PreparedTerrain> {
  const t0 = performance.now();
  report(0);
  const cleaned = await run({ kind: 'clean', source, corrections });
  report(CLEANING_SHARE);
  if (cleaned.kind !== 'clean') throw new Error('The terrain could not be prepared');
  const t1 = performance.now();
  const { terrain, water, quality } = cleaned;
  const input = { heightfield: terrain.heightfield, features: terrain.features, water };
  const rows = terrain.heightfield.rows;
  const all = groundBands(rows, Math.ceil((rows - 1) / BAND_ROWS));
  const count = Math.max(
    1,
    Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 4) - 1, all.length),
  );
  // Bands dealt out in turn, so every worker gets a share of the busy and the empty ground.
  const shares = Array.from({ length: count }, (_, w) => all.filter((_, i) => i % count === w));
  let done = 0;
  const onBand = () => {
    done += 1;
    report(CLEANING_SHARE + (1 - CLEANING_SHARE) * (done / all.length));
  };
  const results = await Promise.all(
    shares.map((bands, i) => run({ kind: 'bands', input, bands, decks: i === 0 }, onBand)),
  );
  const bands: GroundBand[] = results.flatMap((r) => (r.kind === 'bands' ? r.bands : []));
  const decks = results.flatMap((r) => (r.kind === 'bands' ? r.decks : []));
  const ground = assembleGround(terrain, water, bands, decks);
  const end = performance.now();
  // For the browser's performance tools: the two steps, timed apart.
  performance.measure('terrain: DEM cleaning', { start: t0, duration: t1 - t0 });
  performance.measure('terrain: field', { start: t1, duration: end - t1 });
  return { terrain: ground, quality };
}
