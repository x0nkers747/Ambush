import {
  cleanTerrain,
  gradeTerrain,
  TERRAIN_MODEL,
  type DemQualityReport,
  type SourceCorrections,
  type TerrainDataset,
} from '#sim';
import type { TerrainJob, TerrainJobResult } from './grading.worker';

// The authoritative terrain of a battlefield (docs/adr/0032, docs/adr/0033):
// its stored raw terrain, with its DEM cleaned and then graded. Prepared once
// per battlefield, page and terrain model, in a worker where the browser has
// them, so the page stays responsive; the stored package is never changed.

export interface PreparedTerrain {
  readonly terrain: TerrainDataset;
  readonly quality: DemQualityReport;
}

const prepared = new Map<string, Promise<PreparedTerrain>>();

/**
 * The authoritative terrain of battlefield `id`, whose stored (raw) terrain is
 * `source` and import-time DEM corrections `corrections`. Cached by id and by
 * terrain model (cleaning and grading versions), so a terrain prepared by
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
    pending = prepareOffThread({ source, corrections });
    // Only the latest battlefield is kept.
    prepared.clear();
    prepared.set(key, pending);
  }
  return pending;
}

function prepareInline(job: TerrainJob): PreparedTerrain {
  const { terrain, report } = cleanTerrain(job.source, job.corrections);
  return { terrain: gradeTerrain(terrain), quality: report };
}

function prepareOffThread(job: TerrainJob): Promise<PreparedTerrain> {
  if (typeof Worker === 'undefined') return Promise.resolve(prepareInline(job));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./grading.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ambush-terrain',
    });
    worker.onmessage = ({ data }: MessageEvent<TerrainJobResult>) => {
      worker.terminate();
      if ('error' in data) {
        reject(new Error(`The terrain could not be prepared: ${data.error}`));
        return;
      }
      // For the browser's performance tools: the two steps, timed apart.
      const end = performance.now();
      performance.measure('terrain: DEM cleaning', {
        start: end - data.cleanMs - data.gradeMs,
        duration: data.cleanMs,
      });
      performance.measure('terrain: grading', {
        start: end - data.gradeMs,
        duration: data.gradeMs,
      });
      resolve({ terrain: data.terrain, quality: data.quality });
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(`The terrain could not be prepared: ${event.message}`));
    };
    worker.postMessage(job);
  });
}
