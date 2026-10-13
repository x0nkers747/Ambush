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

const prepared = new Map<string, Promise<PreparedTerrain>>();

/** Grid rows per band handed to a worker: small enough to share the work out evenly. */
const BAND_ROWS = 24;
/** Most workers sampling the field at once. */
const MAX_WORKERS = 8;

/**
 * The authoritative terrain of battlefield `id`, whose stored (raw) terrain is
 * `source` and import-time DEM corrections `corrections`. Cached by id and by
 * terrain model (cleaning and field versions), so a terrain prepared by
 * other rules is never reused.
 */
export function authoritativeTerrain(
  id: string,
  source: TerrainDataset,
  corrections: SourceCorrections | null,
): Promise<PreparedTerrain> {
  const key = `${id}|${TERRAIN_MODEL}`;
  let pending = prepared.get(key);
  if (!pending) {
    pending =
      typeof Worker === 'undefined'
        ? Promise.resolve(prepareInline(source, corrections))
        : prepareOffThread(source, corrections);
    // Only the latest battlefield is kept.
    prepared.clear();
    prepared.set(key, pending);
  }
  return pending;
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

/** Runs one job on a fresh worker. */
function run(job: TerrainJob): Promise<TerrainJobResult> {
  return new Promise((resolve, reject) => {
    const worker = startWorker();
    worker.onmessage = ({ data }: MessageEvent<TerrainJobResult>) => {
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

async function prepareOffThread(
  source: TerrainDataset,
  corrections: SourceCorrections | null,
): Promise<PreparedTerrain> {
  const t0 = performance.now();
  const cleaned = await run({ kind: 'clean', source, corrections });
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
  const results = await Promise.all(
    shares.map((bands, i) => run({ kind: 'bands', input, bands, decks: i === 0 })),
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
