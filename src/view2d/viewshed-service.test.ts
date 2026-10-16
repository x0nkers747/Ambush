import { describe, expect, it } from 'vitest';
import {
  cellCentre,
  computeViewshed,
  inSector,
  computeUnionRows,
  createSyntheticTerrain,
  rectangle,
  viewshedGrid,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import {
  createViewshedService,
  defaultWorkerCount,
  LIGHT_TERRAIN_POINTS,
  featurePoints,
  HEAVY_TERRAIN_POINTS,
  viewshedKey,
  type ViewshedWorker,
} from './viewshed-service';
import type { WorkerReply, WorkerRequest } from './viewshed.worker';

// The viewshed service (docs/adr/0020) with fake workers whose replies the
// tests deliver one at a time: caching, superseded and cancelled work,
// stale replies, worker failure.

/** 200 m square with a building; at 1 m cells the viewshed has 200 × 200 cells (7 bands). */
const TERRAIN: TerrainDataset = createSyntheticTerrain(
  { originX: -100, originY: -100, cellSize: 10, columns: 21, rows: 21 },
  (x, y) => 50 + x / 20 + Math.sin(y / 15),
  {
    roads: [],
    buildings: [{ id: 'b', footprint: rectangle(10, 20, 20, 10), heightMeters: 8 }],
    vegetation: [],
  },
);
const CELL = 1;

interface Fake extends ViewshedWorker {
  readonly inbox: WorkerRequest[];
  /** Makes this worker fail on its next band. */
  failNext: boolean;
}

function fakes() {
  const workers: Fake[] = [];
  const createWorker = (): ViewshedWorker => {
    const worker: Fake = {
      inbox: [],
      failNext: false,
      onmessage: null,
      onerror: null,
      postMessage(message) {
        worker.inbox.push(message);
        if (message.type === 'rows') order.push(worker);
      },
      terminate() {
        worker.inbox.length = 0;
      },
    };
    workers.push(worker);
    return worker;
  };
  /** Workers in the order their bands were posted: bands complete first come, first served. */
  const order: Fake[] = [];
  /** Delivers the oldest band any worker holds; returns false when none is left. */
  const step = (): boolean => {
    for (;;) {
      const worker = order.shift();
      if (!worker) return false;
      const index = worker.inbox.findIndex((m) => m.type === 'rows');
      if (index < 0) continue;
      const [message] = worker.inbox.splice(index, 1);
      if (message?.type !== 'rows') continue;
      if (worker.failNext) {
        worker.onerror?.(new Error('worker crashed'));
        return true;
      }
      const data = computeUnionRows(
        TERRAIN,
        message.observers,
        message.grid,
        message.rowStart,
        message.rowEnd,
        message.rowStep,
        message.known ?? null,
        {},
        message.sectors ?? [],
      );
      const reply: WorkerReply = {
        type: 'rows',
        jobId: message.jobId,
        rowStart: message.rowStart,
        rowEnd: message.rowEnd,
        rowStep: message.rowStep,
        data,
        computeMs: 1,
      };
      worker.onmessage?.({ data: reply });
      return true;
    }
  };
  const drain = () => {
    while (step());
  };
  const posted = () =>
    workers.reduce((n, w) => n + w.inbox.filter((m) => m.type === 'rows').length, 0);
  return { workers, createWorker, step, drain, posted };
}

const expected = (observer: Vec2) =>
  computeViewshed(TERRAIN, observer, viewshedGrid(TERRAIN, CELL)).visible;

describe('the viewshed service', () => {
  it('starts its workers on the first request, sends each the terrain once, and computes in bands', () => {
    const f = fakes();
    const service = createViewshedService(TERRAIN, {
      workerCount: 3,
      createWorker: f.createWorker,
    });
    // No worker (and no copy of the terrain) until a viewshed is needed (docs/adr/0045).
    expect(f.workers).toEqual([]);
    expect(service.has({ x: 0, y: -60 }, CELL)).toBe(false);
    expect(f.workers).toEqual([]);
    const a = { x: 0, y: -60 };
    expect(service.request(a, CELL)).toEqual({
      viewshed: null,
      pending: true,
      failed: false,
      preview: false,
    });
    expect(f.workers.map((w) => w.inbox[0]?.type)).toEqual(['terrain', 'terrain', 'terrain']);
    expect(f.posted()).toBe(3); // one band per worker at a time
    f.drain();
    const done = service.request(a, CELL);
    expect(done.pending).toBe(false);
    expect(done.viewshed?.visible).toEqual(expected(a));
    expect(service.lastTimings).toMatchObject({
      cellSize: CELL,
      cells: 40_000,
      bands: 8,
      workers: 3,
    });
  });

  it('shows every other row as a preview half-way, then the full result', () => {
    const f = fakes();
    const service = createViewshedService(TERRAIN, {
      workerCount: 2,
      createWorker: f.createWorker,
    });
    const a = { x: 0, y: -60 };
    service.request(a, CELL);
    // The first-pass bands (every other row) are all handed out before any other.
    let steps = 0;
    while (!service.request(a, CELL).preview && f.step()) steps += 1;
    const half = service.request(a, CELL);
    expect(half).toMatchObject({ pending: true, preview: true });
    expect(steps).toBeLessThan(8);
    const full = expected(a);
    const columns = 200;
    for (let r = 0; r < 200; r += 1) {
      // Computed rows are exact; each row between is a copy of the row below it.
      const source = r % 2 === 0 ? r : r - 1;
      expect(half.viewshed?.visible.subarray(r * columns, (r + 1) * columns)).toEqual(
        full.subarray(source * columns, (source + 1) * columns),
      );
    }
    f.drain();
    expect(service.request(a, CELL)).toMatchObject({ pending: false, preview: false });
    expect(service.request(a, CELL).viewshed?.visible).toEqual(full);
  });

  it('answers an identical request from the cache, without new work', () => {
    const f = fakes();
    const service = createViewshedService(TERRAIN, {
      workerCount: 2,
      createWorker: f.createWorker,
    });
    const a = { x: 0, y: -60 };
    service.request(a, CELL);
    f.drain();
    const first = service.request(a, CELL).viewshed;
    const again = service.request({ x: 0, y: -60 }, CELL);
    expect(again).toEqual({ viewshed: first, pending: false, failed: false, preview: false });
    expect(f.posted()).toBe(0);
  });

  it('never treats another position or resolution as the same', () => {
    expect(viewshedKey({ x: 0, y: -60 }, 4)).not.toBe(viewshedKey({ x: 1e-9, y: -60 }, 4));
    expect(viewshedKey({ x: 0, y: -60 }, 4)).not.toBe(viewshedKey({ x: 0, y: -60 }, 8));
    const f = fakes();
    const service = createViewshedService(TERRAIN, {
      workerCount: 1,
      createWorker: f.createWorker,
    });
    service.request({ x: 0, y: -60 }, CELL);
    f.drain();
    expect(service.request({ x: 1e-9, y: -60 }, CELL).pending).toBe(true);
    f.drain();
    expect(service.request({ x: 1e-9, y: -60 }, CELL).viewshed?.observer).toEqual({
      x: 1e-9,
      y: -60,
    });
  });

  it('drops superseded work: replies for it never overwrite the newer result', () => {
    const f = fakes();
    const service = createViewshedService(TERRAIN, {
      workerCount: 2,
      createWorker: f.createWorker,
    });
    const a = { x: -50, y: -50 };
    const b = { x: 40, y: 60 };
    service.request(a, CELL);
    f.step(); // one of A's bands arrives; another is still being computed
    expect(service.request(b, CELL).pending).toBe(true);
    f.drain(); // A's band in flight arrives late, then B's
    const result = service.request(b, CELL);
    expect(result.pending).toBe(false);
    expect(result.viewshed?.observer).toEqual(b);
    expect(result.viewshed?.visible).toEqual(expected(b));
    // A was never finished, so it is not cached.
    expect(service.request(a, CELL).pending).toBe(true);
  });

  it('keeps up with quick successive selections, showing only the last', () => {
    const f = fakes();
    const service = createViewshedService(TERRAIN, {
      workerCount: 2,
      createWorker: f.createWorker,
    });
    const observers = [
      { x: -80, y: 0 },
      { x: 0, y: 80 },
      { x: 80, y: -20 },
      { x: 5, y: 5 },
    ];
    for (const o of observers) {
      service.request(o, CELL);
      f.step();
    }
    f.drain();
    const last = observers[observers.length - 1] ?? { x: 0, y: 0 };
    expect(service.request(last, CELL).viewshed?.visible).toEqual(expected(last));
    expect(service.cached).toBe(1);
    // While the next one computes, the last finished one is what is shown.
    expect(service.request({ x: 1, y: 1 }, CELL).viewshed?.observer).toEqual(last);
  });

  it('stops work when cancelled, keeping what was finished', () => {
    const f = fakes();
    const service = createViewshedService(TERRAIN, {
      workerCount: 2,
      createWorker: f.createWorker,
    });
    const a = { x: 0, y: 0 };
    service.request(a, CELL);
    f.drain();
    service.request({ x: 30, y: 30 }, CELL);
    service.cancel();
    f.drain();
    expect(f.posted()).toBe(0);
    expect(service.cached).toBe(1);
    expect(service.request(a, CELL).pending).toBe(false);
  });

  it('hands a failed worker’s band to another worker', () => {
    const f = fakes();
    const service = createViewshedService(TERRAIN, {
      workerCount: 2,
      createWorker: f.createWorker,
    });
    const first = f.workers[0];
    if (first) first.failNext = true;
    const a = { x: 0, y: -60 };
    service.request(a, CELL);
    f.drain();
    const result = service.request(a, CELL);
    expect(result).toMatchObject({ pending: false, failed: false });
    expect(result.viewshed?.visible).toEqual(expected(a));
  });

  it('reports failure when every worker has failed', () => {
    const f = fakes();
    const service = createViewshedService(TERRAIN, {
      workerCount: 1,
      createWorker: f.createWorker,
    });
    service.request({ x: 0, y: 0 }, CELL);
    const only = f.workers[0];
    if (only) only.failNext = true;
    f.drain();
    expect(service.request({ x: 0, y: 0 }, CELL)).toEqual({
      viewshed: null,
      pending: false,
      failed: true,
      preview: false,
    });
  });

  it('starts fewer workers on a heavy battlefield (docs/adr/0045)', () => {
    // One per spare core, at most 4, on an ordinary battlefield.
    expect(defaultWorkerCount(8, 30_000)).toBe(4);
    expect(defaultWorkerCount(2, 30_000)).toBe(1);
    // Each worker holds the terrain: fewer of them as it grows.
    expect(defaultWorkerCount(8, HEAVY_TERRAIN_POINTS.two + 1)).toBe(2);
    expect(defaultWorkerCount(2, HEAVY_TERRAIN_POINTS.two + 1)).toBe(1);
    expect(defaultWorkerCount(8, HEAVY_TERRAIN_POINTS.one + 1)).toBe(1);
    // A light battlefield on many cores: up to half of them, at most 8.
    expect(defaultWorkerCount(20, LIGHT_TERRAIN_POINTS - 1)).toBe(8);
    expect(defaultWorkerCount(12, LIGHT_TERRAIN_POINTS - 1)).toBe(6);
    expect(defaultWorkerCount(20, LIGHT_TERRAIN_POINTS)).toBe(4);
    // A terrain's size as workers hold it: its features' map points.
    const small = {
      ...TERRAIN,
      features: {
        ...TERRAIN.features,
        roads: [
          {
            id: 'r',
            roadClass: 'paved',
            widthMeters: 6,
            centerline: [
              { x: 0, y: 0 },
              { x: 9, y: 0 },
            ],
          },
        ],
        buildings: [],
        vegetation: [],
        water: [],
        waterways: [],
        landUse: [],
      },
    } as TerrainDataset;
    expect(featurePoints(small)).toBe(2);
  });

  it('keeps a bounded number of viewsheds', () => {
    const service = createViewshedService(TERRAIN, { workerCount: 0 });
    for (let i = 0; i < 40; i += 1) service.request({ x: i, y: 0 }, 4);
    expect(service.cached).toBe(32);
    // The most recent are kept.
    expect(service.request({ x: 39, y: 0 }, 4).pending).toBe(false);
  });

  it('limits a viewshed to a firing arc: only the rows it reaches, exactly the full one inside it', () => {
    const f = fakes();
    const service = createViewshedService(TERRAIN, {
      workerCount: 2,
      createWorker: f.createWorker,
    });
    const a = { x: -60, y: -80 };
    // 35° north-east, out to 60 m.
    const sector = { azimuth: Math.PI / 4, halfWidth: (17.5 * Math.PI) / 180, rangeM: 60 };
    expect(service.request(a, CELL, sector).pending).toBe(true);
    f.drain();
    const done = service.request(a, CELL, sector);
    expect(done.pending).toBe(false);
    const full = expected(a);
    const grid = viewshedGrid(TERRAIN, CELL);
    let inside = 0;
    done.viewshed?.visible.forEach((v, i) => {
      const p = cellCentre(grid, i % grid.columns, Math.floor(i / grid.columns));
      if (inSector(sector, a, p.x, p.y)) {
        inside += 1;
        expect(v).toBe(full[i]);
      } else expect(v).toBe(0);
    });
    expect(inside).toBeGreaterThan(400);
    expect(done.viewshed?.sector).toEqual(sector);
    // Only the bands of rows the arc reaches: 60 of 200 rows, not all seven bands per pass.
    expect(service.lastTimings?.bands).toBeLessThan(2 * Math.ceil(200 / 64));
    // Another arc, or none, is another viewshed.
    expect(viewshedKey(a, CELL, sector)).not.toBe(viewshedKey(a, CELL));
    expect(service.has(a, CELL)).toBe(false);
    expect(service.has(a, CELL, sector)).toBe(true);
  });

  it('unions a fire team’s arcs: each Marine sees only in his own', () => {
    const service = createViewshedService(TERRAIN, { workerCount: 0 });
    const a = { x: -60, y: -80 };
    const b = { x: 60, y: -80 };
    const north = { azimuth: 0, halfWidth: 0.3, rangeM: 80 };
    const union = service.requestUnion([a, b], CELL, [north, north]);
    const grid = viewshedGrid(TERRAIN, CELL);
    union.viewshed?.visible.forEach((v, i) => {
      const p = cellCentre(grid, i % grid.columns, Math.floor(i / grid.columns));
      if (!inSector(north, a, p.x, p.y) && !inSector(north, b, p.x, p.y)) expect(v).toBe(0);
    });
    const each = [a, b].map(
      (o) => service.request(o, CELL, north).viewshed?.visible ?? new Uint8Array(),
    );
    union.viewshed?.visible.forEach((v, i) => {
      expect(v).toBe((each[0]?.[i] ?? 0) | (each[1]?.[i] ?? 0));
    });
  });
});
