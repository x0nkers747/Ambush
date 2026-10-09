import { describe, expect, it } from 'vitest';
import {
  computeViewshed,
  computeUnionRows,
  createSyntheticTerrain,
  rectangle,
  viewshedGrid,
  type TerrainDataset,
  type Vec2,
  type Viewshed,
} from '#sim';
import { createTeamVisibility, unionViewsheds } from './group-viewshed';
import { viewshedPixels } from './render';
import { createViewshedService, type ViewshedWorker } from './viewshed-service';
import type { WorkerReply, WorkerRequest } from './viewshed.worker';

// A fire team's visible area (docs/adr/0022): the union of its Marines'
// viewsheds, from the viewshed service with fake workers whose replies the
// tests deliver.

/** 200 m square, rolling, with a building: Marines in different places see different ground. */
const TERRAIN: TerrainDataset = createSyntheticTerrain(
  { originX: -100, originY: -100, cellSize: 10, columns: 21, rows: 21 },
  (x, y) => 50 + 3 * Math.sin(x / 25) + 2 * Math.cos(y / 18),
  {
    roads: [],
    buildings: [{ id: 'b', footprint: rectangle(0, 20, 30, 10), heightMeters: 8 }],
    vegetation: [],
  },
);
// 200 × 200 cells: more than the service lets finish before a newer request (it supersedes them).
const CELL = 1;
const GRID = viewshedGrid(TERRAIN, CELL);
const exact = (observer: Vec2) => computeViewshed(TERRAIN, observer, GRID);
const TEAM: Vec2[] = [
  { x: -15, y: -10 },
  { x: -5, y: -10 },
  { x: 5, y: -10 },
  { x: 15, y: -10 },
];

function fakeWorkers() {
  const inboxes: { worker: ViewshedWorker; message: WorkerRequest & { type: 'rows' } }[] = [];
  /** Each job's id, with the number of observers its bands compute. */
  const jobs = new Map<number, number>();
  const createWorker = (): ViewshedWorker => {
    const worker: ViewshedWorker = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        if (message.type !== 'rows') return;
        jobs.set(message.jobId, message.observers.length);
        inboxes.push({ worker, message });
      },
      terminate() {
        // Nothing to stop.
      },
    };
    return worker;
  };
  /** Delivers the oldest band posted; returns false when there is none. */
  const step = (): boolean => {
    const next = inboxes.shift();
    if (!next) return false;
    const { worker, message } = next;
    const data = computeUnionRows(
      TERRAIN,
      message.observers,
      message.grid,
      message.rowStart,
      message.rowEnd,
      message.rowStep,
      message.known ?? null,
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
  };
  /** Delivers every band posted so far, and any posted meanwhile. */
  const drain = () => {
    while (step());
  };
  return { createWorker, drain, step, jobs };
}

/** Requests until ready, delivering worker replies in between; returns the result and the calls made. */
function settle(
  team: ReturnType<typeof createTeamVisibility>,
  observers: readonly Vec2[],
  f: ReturnType<typeof fakeWorkers>,
) {
  let previous: Viewshed | null = null;
  for (let i = 0; i < 50; i += 1) {
    const r = team(observers, CELL, previous);
    if (!r.pending) return r;
    previous = r.viewshed;
    f.drain();
  }
  throw new Error('never ready');
}

describe('the union of viewsheds', () => {
  it('is visible exactly where at least one Marine sees', () => {
    const parts = TEAM.map(exact);
    const union = unionViewsheds(parts);
    expect(union.grid).toEqual(GRID);
    let seenByMany = 0;
    for (let i = 0; i < union.visible.length; i += 1) {
      const seers = parts.filter((p) => p.visible[i] === 1).length;
      expect(union.visible[i]).toBe(seers > 0 ? 1 : 0);
      if (seers > 1) seenByMany += 1;
    }
    // The members' areas do overlap, and differ: the union is more than any one.
    expect(seenByMany).toBeGreaterThan(0);
    const count = (v: Viewshed) => v.visible.reduce((n, x) => n + x, 0);
    expect(count(union)).toBeGreaterThan(Math.max(...parts.map(count)));
  });

  it('is shaded the same wherever it is visible, however many Marines see there', () => {
    const parts = TEAM.map(exact);
    const union = unionViewsheds(parts);
    const pixels = viewshedPixels(union);
    const { columns, rows } = union.grid;
    // An interior cell (not on the edge of the visible area) seen by one Marine and one seen by all.
    const interior = (i: number) => {
      const c = i % columns;
      const r = Math.floor(i / columns);
      return [
        [c - 1, r],
        [c + 1, r],
        [c, r - 1],
        [c, r + 1],
      ].every(
        ([x, y]) =>
          x !== undefined &&
          y !== undefined &&
          x >= 0 &&
          y >= 0 &&
          x < columns &&
          y < rows &&
          union.visible[y * columns + x] === 1,
      );
    };
    const seers = (i: number) => parts.filter((p) => p.visible[i] === 1).length;
    const cells = [...union.visible.keys()].filter((i) => union.visible[i] === 1 && interior(i));
    const one = cells.find((i) => seers(i) === 1);
    const all = cells.find((i) => seers(i) === TEAM.length);
    expect(one).toBeDefined();
    expect(all).toBeDefined();
    // The image is drawn top row first.
    const pixel = (i: number) => {
      const c = i % columns;
      const r = rows - 1 - Math.floor(i / columns);
      return [...pixels.subarray((r * columns + c) * 4, (r * columns + c) * 4 + 4)];
    };
    expect(pixel(one ?? 0)).toEqual(pixel(all ?? 0));
  });

  it('refuses viewsheds on different grids', () => {
    const coarse = computeViewshed(TERRAIN, { x: 0, y: 0 }, viewshedGrid(TERRAIN, 4));
    expect(() => unionViewsheds([exact({ x: 0, y: 0 }), coarse])).toThrow(RangeError);
    expect(() => unionViewsheds([])).toThrow(RangeError);
  });
});

describe('a fire team’s visible area from the viewshed service', () => {
  const service = (f: ReturnType<typeof fakeWorkers>) =>
    createViewshedService(TERRAIN, { workerCount: 2, createWorker: f.createWorker });

  it('is the exact union, computed in the background as one job, then cached', () => {
    const f = fakeWorkers();
    const team = createTeamVisibility(service(f));
    expect(team(TEAM, CELL, null)).toEqual({
      viewshed: null,
      pending: true,
      preview: false,
      failed: false,
    });
    const done = settle(team, TEAM, f);
    expect(done).toMatchObject({ pending: false, preview: false, failed: false });
    expect(done.viewshed?.visible).toEqual(unionViewsheds(TEAM.map(exact)).visible);
    expect([...f.jobs.values()]).toEqual([4]);
    // Ready: asked again, nothing is computed and the same object is returned.
    expect(team(TEAM, CELL, null).viewshed).toBe(done.viewshed);
    expect(f.jobs.size).toBe(1);
  });

  it('shows the union’s own half-way preview, never another observer’s result', () => {
    const f = fakeWorkers();
    const s = service(f);
    // A single Marine's viewshed elsewhere is the service's latest result…
    s.request({ x: 60, y: 60 }, CELL);
    f.drain();
    const team = createTeamVisibility(s);
    // …but the team shows its own previous union (here none) until its preview.
    const first = team(TEAM, CELL, null);
    expect(first.viewshed).toBeNull();
    let r = first;
    for (let i = 0; i < 20 && !r.preview && r.pending; i += 1) {
      f.step();
      r = team(TEAM, CELL, null);
    }
    expect(r).toMatchObject({ pending: true, preview: true });
    // Every other row is already the union's.
    const union = unionViewsheds(TEAM.map(exact)).visible;
    const { columns } = GRID;
    for (let row = 0; row < GRID.rows; row += 2) {
      expect(r.viewshed?.visible.subarray(row * columns, (row + 1) * columns)).toEqual(
        union.subarray(row * columns, (row + 1) * columns),
      );
    }
  });

  it('reuses Marines’ cached viewsheds: only the others are computed', () => {
    const f = fakeWorkers();
    const s = service(f);
    for (const o of TEAM.slice(0, 2)) {
      s.request(o, CELL);
      f.drain();
    }
    expect([...f.jobs.values()]).toEqual([1, 1]);
    const team = createTeamVisibility(s);
    const done = settle(team, TEAM, f);
    expect([...f.jobs.values()]).toEqual([1, 1, 2]);
    expect(done.viewshed?.visible).toEqual(unionViewsheds(TEAM.map(exact)).visible);
    // With every Marine's own viewshed cached, the union needs no job at all.
    const all = fakeWorkers();
    const s2 = service(all);
    for (const o of TEAM) {
      s2.request(o, CELL);
      all.drain();
    }
    const at = createTeamVisibility(s2)(TEAM, CELL, null);
    expect(at.pending).toBe(false);
    expect(at.viewshed?.visible).toEqual(done.viewshed?.visible);
    expect(all.jobs.size).toBe(4);
  });

  it('is recomputed when a Marine moves, the previous union shown meanwhile; going back is cached', () => {
    const f = fakeWorkers();
    const team = createTeamVisibility(service(f));
    const before = settle(team, TEAM, f);
    const moved = [TEAM[0], TEAM[1], { x: 40, y: 30 }, TEAM[3]] as Vec2[];
    const meanwhile = team(moved, CELL, before.viewshed);
    expect(meanwhile).toEqual({
      viewshed: before.viewshed,
      pending: true,
      preview: false,
      failed: false,
    });
    const after = settle(team, moved, f);
    expect(after.viewshed?.visible).toEqual(unionViewsheds(moved.map(exact)).visible);
    expect(after.viewshed?.visible).not.toEqual(before.viewshed?.visible);
    expect(f.jobs.size).toBe(2);
    expect(team(TEAM, CELL, null).viewshed).toBe(before.viewshed);
    expect(f.jobs.size).toBe(2);
  });

  it('never shows an outdated result: work for positions given up is dropped', () => {
    const f = fakeWorkers();
    const s = service(f);
    const team = createTeamVisibility(s);
    const old = [{ x: -60, y: -60 }, ...TEAM.slice(1)];
    expect(team(old, CELL, null).pending).toBe(true);
    // Part of the old union arrives…
    f.step();
    // …then the formation moves before it is done.
    expect(team(TEAM, CELL, null)).toEqual({
      viewshed: null,
      pending: true,
      preview: false,
      failed: false,
    });
    const done = settle(team, TEAM, f);
    expect(done.viewshed?.visible).toEqual(unionViewsheds(TEAM.map(exact)).visible);
    // The old union was never finished, so asking for it starts again.
    expect(s.requestUnion(old, CELL).pending).toBe(true);
  });

  it('says so when viewsheds cannot be computed', () => {
    const s = createViewshedService(TERRAIN, {
      workerCount: 1,
      createWorker: () => {
        throw new Error('no workers here');
      },
    });
    expect(createTeamVisibility(s)(TEAM, CELL, null)).toEqual({
      viewshed: null,
      pending: false,
      preview: false,
      failed: true,
    });
  });

  it('computes at once without workers, giving the same union', () => {
    const s = createViewshedService(TERRAIN, { workerCount: 0 });
    const r = createTeamVisibility(s)(TEAM, CELL, null);
    expect(r.pending).toBe(false);
    expect(r.viewshed?.visible).toEqual(unionViewsheds(TEAM.map(exact)).visible);
  });
});
