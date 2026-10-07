import {
  computeViewshed,
  viewshedGrid,
  type TerrainDataset,
  type Vec2,
  type Viewshed,
  type ViewshedGrid,
} from '#sim';
import type { WorkerReply, WorkerRequest } from './viewshed.worker';

// Computes viewsheds for the planning display without blocking the UI: rows
// are split into bands and handed to a small pool of Web Workers, which run
// the simulation's own sight-line code. Results are cached by observer
// position and cell size. The latest request wins; superseded work is dropped.
// Results are identical however the work is split (rows are independent).

/** Rows per band handed to a worker. */
const BAND_ROWS = 8;
/** Viewsheds kept, most recently used first. */
const CACHE_SIZE = 48;
/**
 * Jobs up to this many cells (quick previews) finish before the next request
 * starts, so a continuous drag yields a steady stream of updates instead of
 * every update being cancelled by the next pointer move. Larger jobs give way
 * to a new request at once.
 */
const FINISH_FIRST_MAX_CELLS = 10_000;

export interface ViewshedService {
  /**
   * The viewshed from `observer` on a grid of `cellSize` metres if it is ready.
   * Otherwise starts computing it and returns the most recent finished
   * viewshed (possibly for another observer or resolution) with `pending`.
   */
  request(
    observer: Vec2,
    cellSize: number,
  ): { readonly viewshed: Viewshed | null; readonly pending: boolean };
  dispose(): void;
}

interface Job {
  readonly id: number;
  readonly key: string;
  readonly observer: Vec2;
  readonly grid: ViewshedGrid;
  readonly visible: Uint8Array;
  /** Bands not yet handed out, as row starts. */
  readonly queue: number[];
  outstanding: number;
}

export function createViewshedService(
  terrain: TerrainDataset,
  workerCount = defaultWorkerCount(),
): ViewshedService {
  const cache = new Map<string, Viewshed>();
  let latest: Viewshed | null = null;
  let job: Job | null = null;
  let nextJobId = 1;

  const remember = (key: string, viewshed: Viewshed) => {
    cache.delete(key);
    cache.set(key, viewshed);
    if (cache.size > CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    latest = viewshed;
  };

  const workers = workerCount > 0 && typeof Worker !== 'undefined' ? startWorkers(workerCount) : [];
  const idle: Worker[] = [...workers];

  /** The latest request, waiting for a quick job to finish. */
  let next: { key: string; observer: Vec2; grid: ViewshedGrid } | null = null;

  const start = (key: string, observer: Vec2, grid: ViewshedGrid) => {
    const queue: number[] = [];
    for (let r = 0; r < grid.rows; r += BAND_ROWS) queue.push(r);
    job = {
      id: nextJobId,
      key,
      observer: { x: observer.x, y: observer.y },
      grid,
      visible: new Uint8Array(grid.rows * grid.columns),
      queue,
      outstanding: queue.length,
    };
    nextJobId += 1;
    next = null;
    dispatch();
  };

  const dispatch = () => {
    while (job && job.queue.length > 0 && idle.length > 0) {
      const worker = idle.pop();
      const rowStart = job.queue.shift();
      if (!worker || rowStart === undefined) break;
      const message: WorkerRequest = {
        type: 'rows',
        jobId: job.id,
        observer: job.observer,
        grid: job.grid,
        rowStart,
        rowEnd: Math.min(rowStart + BAND_ROWS, job.grid.rows),
      };
      worker.postMessage(message);
    }
  };

  function startWorkers(count: number): Worker[] {
    return Array.from({ length: count }, () => {
      const worker = new Worker(new URL('./viewshed.worker.ts', import.meta.url), {
        type: 'module',
      });
      const init: WorkerRequest = { type: 'terrain', terrain };
      worker.postMessage(init);
      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        idle.push(worker);
        const reply = event.data;
        const current = job;
        if (current?.id === reply.jobId) {
          current.visible.set(reply.data, reply.rowStart * current.grid.columns);
          current.outstanding -= 1;
          if (current.outstanding === 0) {
            remember(current.key, {
              grid: current.grid,
              observer: current.observer,
              visible: current.visible,
            });
            job = null;
            const waiting = next;
            next = null;
            if (waiting && !cache.has(waiting.key))
              start(waiting.key, waiting.observer, waiting.grid);
          }
        }
        dispatch();
      };
      return worker;
    });
  }

  return {
    request(observer, cellSize) {
      const key = `${String(cellSize)}:${String(observer.x)},${String(observer.y)}`;
      const cached = cache.get(key);
      if (cached) {
        remember(key, cached);
        return { viewshed: cached, pending: false };
      }
      const grid = viewshedGrid(terrain, cellSize);
      if (workers.length === 0) {
        // No workers (e.g. tests): compute synchronously.
        const viewshed = computeViewshed(terrain, observer, grid);
        remember(key, viewshed);
        return { viewshed, pending: false };
      }
      if (job?.key !== key) {
        const running = job;
        if (running && running.grid.rows * running.grid.columns <= FINISH_FIRST_MAX_CELLS) {
          next = { key, observer: { x: observer.x, y: observer.y }, grid };
        } else {
          start(key, observer, grid);
        }
      }
      return { viewshed: latest, pending: true };
    },
    dispose() {
      for (const worker of workers) worker.terminate();
      job = null;
    },
  };
}

function defaultWorkerCount(): number {
  const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency;
  return Math.min(4, Math.max(1, cores - 1));
}
