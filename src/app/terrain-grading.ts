import { gradeTerrain, type TerrainDataset } from '#sim';

// The authoritative terrain of a battlefield (docs/adr/0032): its stored
// source terrain, graded. Graded once per battlefield and page, in a worker
// where the browser has them, so the page stays responsive; the stored
// package itself is never changed.

const graded = new Map<string, Promise<TerrainDataset>>();

/** The graded terrain of battlefield `id`, whose stored (source) terrain is `source`. */
export function authoritativeTerrain(id: string, source: TerrainDataset): Promise<TerrainDataset> {
  let pending = graded.get(id);
  if (!pending) {
    pending = gradeOffThread(source);
    // Only the latest battlefield is kept.
    graded.clear();
    graded.set(id, pending);
  }
  return pending;
}

function gradeOffThread(source: TerrainDataset): Promise<TerrainDataset> {
  if (typeof Worker === 'undefined') return Promise.resolve(gradeTerrain(source));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./grading.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ambush-terrain-grading',
    });
    worker.onmessage = ({
      data,
    }: MessageEvent<{ terrain: TerrainDataset } | { error: string }>) => {
      worker.terminate();
      if ('terrain' in data) resolve(data.terrain);
      else reject(new Error(`The terrain could not be graded: ${data.error}`));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(`The terrain could not be graded: ${event.message}`));
    };
    worker.postMessage(source);
  });
}
