import {
  computeUnionRows,
  viewshedGrid,
  type TerrainDataset,
  type Vec2,
  type Viewshed,
  type ViewshedGrid,
} from '#sim';
import { unionViewsheds } from './group-viewshed';
import type { WorkerReply, WorkerRequest } from './viewshed.worker';

// Computes viewsheds for the planning display without blocking the UI
// (docs/adr/0020): rows are split into bands and handed to a small pool of
// persistent Web Workers, which run the simulation's own visibility code.
// A fire team's visible area, the union of its Marines' viewsheds, is
// computed the same way as one job (docs/adr/0022): each band of rows is
// computed for one Marine after another, each skipping cells an earlier one
// already sees.
// Results are cached by exact observer position and cell size. The latest
// request wins: bands of superseded work are never handed out, and replies
// for them are dropped. Results are identical however the work is split.

/**
 * Rows spanned by a band handed to a worker. A viewshed is computed in two
 * passes: every other row first, then the rows between. Half-way, those rows
 * make a preview at no extra cost; each band's rows are close enough together
 * for the proofs to work well.
 */
const BAND_ROWS = 64;
const PASSES = 2;
/** Cached viewsheds: at most this many, and at most this many cells in all (≈ 8 full-detail 5 km viewsheds). */
const CACHE_ENTRIES = 32;
const CACHE_CELLS = 12_500_000;
/**
 * Jobs up to this many cells (quick previews) finish before the next request
 * starts, so a continuous drag yields a steady stream of updates instead of
 * every update being cancelled by the next pointer move. Larger jobs give way
 * to a new request at once.
 */
const FINISH_FIRST_MAX_CELLS = 10_000;

/** What the service needs of a worker: a Web Worker running viewshed.worker.ts. */
export interface ViewshedWorker {
  postMessage(message: WorkerRequest): void;
  onmessage: ((event: { readonly data: WorkerReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

export interface ViewshedServiceOptions {
  /** Workers to start; 0 computes synchronously (tests, or no Worker support). */
  readonly workerCount?: number;
  /** Starts one worker; defaults to a module Web Worker. */
  readonly createWorker?: () => ViewshedWorker;
}

export interface ViewshedRequest {
  /** The requested viewshed if ready, else the most recent finished one (possibly another observer's). */
  readonly viewshed: Viewshed | null;
  /** Whether the requested viewshed is still being computed. */
  readonly pending: boolean;
  /** Whether viewsheds cannot be computed: every worker has failed. */
  readonly failed: boolean;
  /**
   * Whether `viewshed` is the requested one half-computed: every other row
   * is computed, and the rows between are copies of the row below them.
   */
  readonly preview: boolean;
}

/** Timings of the last completed viewshed, for diagnostics and benchmarks. */
export interface ViewshedTimings {
  readonly cellSize: number;
  readonly cells: number;
  /** From the request to the last band's arrival, in milliseconds. */
  readonly elapsedMs: number;
  /** Computing time summed over workers. */
  readonly computeMs: number;
  readonly bands: number;
  readonly workers: number;
}

export interface ViewshedService {
  /**
   * The viewshed from `observer` on a grid of `cellSize` metres if it is ready.
   * Otherwise starts computing it and returns the most recent finished
   * viewshed (possibly for another observer or resolution) with `pending`.
   */
  request(observer: Vec2, cellSize: number): ViewshedRequest;
  /** Whether that viewshed is cached (ready), without starting any work. */
  has(observer: Vec2, cellSize: number): boolean;
  /**
   * The union of the viewsheds from `observers` (a fire team's visible area:
   * visible where any of them sees), exactly as `unionViewsheds` of each
   * one's viewshed, on a grid of `cellSize` metres, if it is ready; otherwise
   * as `request`. Single viewsheds already cached are used as they are; the
   * rest are computed as one job, each band one observer after another, each
   * skipping the cells an earlier one already sees (`computeViewshedRows`'s
   * `alreadyVisible`), which is where most of the work would be. The result's
   * observer is the first one. It is cached by the exact observers, in order.
   */
  requestUnion(observers: readonly Vec2[], cellSize: number): ViewshedRequest;
  /** Drops work in progress, e.g. when no viewshed is shown any more. Cached results stay. */
  cancel(): void;
  /** Number of cached viewsheds. */
  readonly cached: number;
  /** Timings of the last completed viewshed, or `null`. */
  readonly lastTimings: ViewshedTimings | null;
  dispose(): void;
}

interface Band {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly rowStep: number;
  readonly pass: number;
}

/** What a job computes: one viewshed, or a union of several (`requestUnion`). */
interface JobSpec {
  readonly key: string;
  /** The result's observer. */
  readonly observer: Vec2;
  /** The observers whose viewsheds are computed, in order (one for a single viewshed). */
  readonly observers: readonly Vec2[];
  /** Cells already known to be visible (from cached viewsheds), the whole grid; or none. */
  readonly known: Uint8Array | null;
  readonly grid: ViewshedGrid;
}

interface Job {
  readonly id: number;
  readonly key: string;
  readonly observer: Vec2;
  readonly observers: readonly Vec2[];
  readonly known: Uint8Array | null;
  readonly grid: ViewshedGrid;
  readonly visible: Uint8Array;
  /** Bands not yet handed out: every first-pass band before any second-pass band. */
  readonly queue: Band[];
  outstanding: number;
  /** First-pass bands not yet received. */
  firstPassOutstanding: number;
  /** The first pass's rows, the rows between filled from below; set once the first pass is in. */
  preview: Viewshed | null;
  readonly startedAt: number;
  computeMs: number;
}

/** The cache key: the exact observer position and cell size, never rounded. */
export function viewshedKey(observer: Vec2, cellSize: number): string {
  return `${String(cellSize)}:${String(observer.x)},${String(observer.y)}`;
}

/** The cache key of a union: every observer's key, in order. A single observer's is `viewshedKey`. */
export function unionKey(observers: readonly Vec2[], cellSize: number): string {
  return observers.length === 1 && observers[0]
    ? viewshedKey(observers[0], cellSize)
    : `union:${observers.map((o) => viewshedKey(o, cellSize)).join('|')}`;
}

export function createViewshedService(
  terrain: TerrainDataset,
  options: ViewshedServiceOptions = {},
): ViewshedService {
  const canUseWorkers = typeof Worker !== 'undefined' || options.createWorker !== undefined;
  const workerCount = canUseWorkers ? (options.workerCount ?? defaultWorkerCount()) : 0;
  const createWorker = options.createWorker ?? defaultWorker;
  const cache = new Map<string, Viewshed>();
  let cachedCells = 0;
  let latest: Viewshed | null = null;
  let job: Job | null = null;
  let nextJobId = 1;
  let lastTimings: ViewshedTimings | null = null;

  const remember = (key: string, viewshed: Viewshed) => {
    const old = cache.get(key);
    if (old) {
      cache.delete(key);
      cachedCells -= old.visible.length;
    }
    cache.set(key, viewshed);
    cachedCells += viewshed.visible.length;
    // Least recently used first.
    for (const [oldest, value] of cache) {
      if (cache.size <= CACHE_ENTRIES && cachedCells <= CACHE_CELLS) break;
      if (oldest === key) break;
      cache.delete(oldest);
      cachedCells -= value.visible.length;
    }
    latest = viewshed;
  };

  const workers: ViewshedWorker[] = [];
  const idle: ViewshedWorker[] = [];
  /** The band each busy worker is computing. */
  const assigned = new Map<ViewshedWorker, { jobId: number; band: Band }>();
  let failed = false;

  /** The latest request, waiting for a quick job to finish. */
  let next: JobSpec | null = null;

  const start = ({ key, observer, observers, known, grid }: JobSpec) => {
    const queue: Band[] = [];
    for (let pass = 0; pass < PASSES; pass += 1) {
      for (let r = 0; r < grid.rows; r += BAND_ROWS) {
        if (r + pass < grid.rows) {
          queue.push({
            rowStart: r + pass,
            rowEnd: Math.min(r + BAND_ROWS, grid.rows),
            rowStep: PASSES,
            pass,
          });
        }
      }
    }
    job = {
      id: nextJobId,
      key,
      observer: { x: observer.x, y: observer.y },
      observers: observers.map((o) => ({ x: o.x, y: o.y })),
      known,
      grid,
      visible: new Uint8Array(grid.rows * grid.columns),
      queue,
      outstanding: queue.length,
      firstPassOutstanding: queue.filter((b) => b.pass === 0).length,
      preview: null,
      startedAt: performance.now(),
      computeMs: 0,
    };
    nextJobId += 1;
    next = null;
    dispatch();
  };

  const dispatch = () => {
    while (job && job.queue.length > 0 && idle.length > 0) {
      const worker = idle.pop();
      const band = job.queue.shift();
      if (!worker || band === undefined) break;
      assigned.set(worker, { jobId: job.id, band });
      worker.postMessage({
        type: 'rows',
        jobId: job.id,
        observers: job.observers,
        ...(job.known ? { known: bandRows(job.known, job.grid, band) } : {}),
        grid: job.grid,
        rowStart: band.rowStart,
        rowEnd: band.rowEnd,
        rowStep: band.rowStep,
      });
    }
  };

  const finish = (current: Job) => {
    const viewshed = { grid: current.grid, observer: current.observer, visible: current.visible };
    remember(current.key, viewshed);
    const elapsedMs = performance.now() - current.startedAt;
    lastTimings = {
      cellSize: current.grid.cellSize,
      cells: current.visible.length,
      elapsedMs,
      computeMs: current.computeMs,
      bands: Math.ceil(current.grid.rows / BAND_ROWS) * PASSES,
      workers: workers.length,
    };
    try {
      performance.measure(`viewshed ${String(current.grid.cellSize)} m`, {
        start: current.startedAt,
        duration: elapsedMs,
        detail: lastTimings,
      });
    } catch {
      // Diagnostics only.
    }
    job = null;
    const waiting = next;
    next = null;
    if (waiting && !cache.has(waiting.key)) start(waiting);
  };

  const onReply = (worker: ViewshedWorker, reply: WorkerReply) => {
    if (reply.type === 'ready') {
      try {
        performance.measure('viewshed worker ready', {
          start: performance.now() - reply.prepareMs,
          duration: reply.prepareMs,
        });
      } catch {
        // Diagnostics only.
      }
      return;
    }
    const band = assigned.get(worker)?.band;
    assigned.delete(worker);
    idle.push(worker);
    const current = job;
    // Replies for superseded jobs are dropped: they can never overwrite newer results.
    if (current?.id === reply.jobId) {
      const { columns } = current.grid;
      for (let k = 0, r = reply.rowStart; r < reply.rowEnd; r += reply.rowStep, k += 1) {
        current.visible.set(reply.data.subarray(k * columns, (k + 1) * columns), r * columns);
      }
      current.computeMs += reply.computeMs;
      current.outstanding -= 1;
      if (band?.pass === 0) {
        current.firstPassOutstanding -= 1;
        if (current.firstPassOutstanding === 0 && current.outstanding > 0) {
          current.preview = previewOf(current);
        }
      }
      if (current.outstanding === 0) finish(current);
    }
    dispatch();
  };

  const onFailure = (worker: ViewshedWorker) => {
    worker.terminate();
    workers.splice(workers.indexOf(worker), 1);
    const at = idle.indexOf(worker);
    if (at >= 0) idle.splice(at, 1);
    const band = assigned.get(worker);
    assigned.delete(worker);
    // Its band goes back to the queue for another worker.
    if (band && job?.id === band.jobId) job.queue.unshift(band.band);
    if (workers.length === 0) {
      failed = true;
      job = null;
      next = null;
      return;
    }
    dispatch();
  };

  for (let i = 0; i < workerCount; i += 1) {
    let worker: ViewshedWorker;
    try {
      worker = createWorker();
    } catch {
      continue;
    }
    worker.onmessage = (event) => {
      onReply(worker, event.data);
    };
    worker.onerror = () => {
      onFailure(worker);
    };
    worker.postMessage({ type: 'terrain', terrain });
    workers.push(worker);
    idle.push(worker);
  }
  if (workerCount > 0 && workers.length === 0) failed = true;

  /** The result of `spec` if cached; otherwise starts (or continues) computing it. */
  const requestJob = (spec: JobSpec): ViewshedRequest => {
    const { key, grid } = spec;
    const cached = cache.get(key);
    if (cached) {
      remember(key, cached);
      return { viewshed: cached, pending: false, failed: false, preview: false };
    }
    if (failed) return { viewshed: latest, pending: false, failed: true, preview: false };
    if (workers.length === 0) {
      // No workers (e.g. tests): compute synchronously.
      const viewshed = {
        grid,
        observer: { x: spec.observer.x, y: spec.observer.y },
        visible: computeUnionRows(terrain, spec.observers, grid, 0, grid.rows, 1, spec.known),
      };
      remember(key, viewshed);
      return { viewshed, pending: false, failed: false, preview: false };
    }
    if (job?.key !== key) {
      const running = job;
      if (running && running.grid.rows * running.grid.columns <= FINISH_FIRST_MAX_CELLS) {
        next = spec;
      } else {
        start(spec);
      }
    }
    const half = job?.key === key ? job.preview : null;
    return half
      ? { viewshed: half, pending: true, failed: false, preview: true }
      : { viewshed: latest, pending: true, failed: false, preview: false };
  };

  return {
    request(observer, cellSize) {
      const key = viewshedKey(observer, cellSize);
      const grid = viewshedGrid(terrain, cellSize);
      return requestJob({ key, observer, observers: [observer], known: null, grid });
    },
    requestUnion(observers, cellSize) {
      const first = observers[0];
      if (!first) throw new RangeError('a union needs at least one observer');
      const key = unionKey(observers, cellSize);
      const cachedUnion = cache.get(key);
      if (cachedUnion) {
        remember(key, cachedUnion);
        return { viewshed: cachedUnion, pending: false, failed: false, preview: false };
      }
      const grid = viewshedGrid(terrain, cellSize);
      // Viewsheds already cached count as they are; only the rest are computed.
      const ready = observers.flatMap((o) => cache.get(viewshedKey(o, cellSize)) ?? []);
      const missing = observers.filter((o) => !cache.has(viewshedKey(o, cellSize)));
      const known = ready.length > 0 ? unionViewsheds(ready).visible : null;
      if (missing.length === 0 && known) {
        const viewshed = { grid, observer: { x: first.x, y: first.y }, visible: known };
        remember(key, viewshed);
        return { viewshed, pending: false, failed: false, preview: false };
      }
      return requestJob({ key, observer: first, observers: missing, known, grid });
    },
    has(observer, cellSize) {
      return cache.has(viewshedKey(observer, cellSize));
    },
    cancel() {
      job = null;
      next = null;
    },
    get cached() {
      return cache.size;
    },
    get lastTimings() {
      return lastTimings;
    },
    dispose() {
      for (const worker of workers) worker.terminate();
      workers.length = 0;
      idle.length = 0;
      job = null;
      next = null;
    },
  };
}

/** The first pass's rows of a job, each row between them filled from the row below. */
function previewOf(job: Job): Viewshed {
  const { columns, rows } = job.grid;
  const visible = job.visible.slice();
  for (let r = 1; r < rows; r += PASSES) {
    visible.copyWithin(r * columns, (r - 1) * columns, r * columns);
  }
  return { grid: job.grid, observer: job.observer, visible };
}

/** The rows of a whole-grid mask that a band covers, packed as the band's result is. */
function bandRows(mask: Uint8Array, grid: ViewshedGrid, band: Band): Uint8Array {
  const { columns } = grid;
  const out = new Uint8Array(Math.ceil((band.rowEnd - band.rowStart) / band.rowStep) * columns);
  for (let k = 0, r = band.rowStart; r < band.rowEnd; r += band.rowStep, k += 1) {
    out.set(mask.subarray(r * columns, (r + 1) * columns), k * columns);
  }
  return out;
}

function defaultWorker(): ViewshedWorker {
  return new Worker(new URL('./viewshed.worker.ts', import.meta.url), {
    type: 'module',
  }) as unknown as ViewshedWorker;
}

function defaultWorkerCount(): number {
  const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency;
  return Math.min(4, Math.max(1, cores - 1));
}
