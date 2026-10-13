import type { FieldInput, FieldSpec, SurfaceTile } from '#sim/terrain-lab';

// Workers generating terrain tiles (research §7): each compiles the field
// from the same inputs; requests go to the least busy worker, nearest first
// (the caller orders them). Tiles come back as transferred buffers.

export type TileRequest =
  | { type: 'init'; input: FieldInput; spec: FieldSpec; spacing: number }
  | { type: 'tile'; id: number; level: number; tx: number; ty: number };

export type TileReply =
  | { type: 'ready'; ms: number }
  | { type: 'tile'; id: number; tile: SurfaceTile }
  | { type: 'error'; id: number; message: string };

export interface TilePool {
  /** Resolves when every worker has compiled the field (ms: slowest compile). */
  readonly ready: Promise<number>;
  /** Asks for a tile; `done` is called once with it. Returns false when the queue is full. */
  request(level: number, tx: number, ty: number, done: (tile: SurfaceTile) => void): boolean;
  /** Requests in flight. */
  pending(): number;
  readonly size: number;
  dispose(): void;
}

/** Most requests outstanding per worker. */
const PER_WORKER = 3;

export function createTilePool(
  input: FieldInput,
  spec: FieldSpec,
  spacing: number,
  workers: number,
): TilePool {
  let nextId = 1;
  const pool = Array.from({ length: Math.max(1, workers) }, () => ({
    worker: new Worker(new URL('./tile.worker.ts', import.meta.url), {
      type: 'module',
      name: 'terrain-lab-tiles',
    }),
    busy: 0,
  }));
  const waiting = new Map<
    number,
    { done: (tile: SurfaceTile) => void; slot: (typeof pool)[number] }
  >();
  const readies = pool.map(
    (slot) =>
      new Promise<number>((resolve, reject) => {
        slot.worker.onmessage = ({ data }: MessageEvent<TileReply>) => {
          if (data.type === 'ready') {
            resolve(data.ms);
            return;
          }
          if (data.type === 'error') {
            if (data.id < 0) reject(new Error(data.message));
            const w = waiting.get(data.id);
            if (w) {
              waiting.delete(data.id);
              w.slot.busy -= 1;
            }
            console.error(`terrain lab tile: ${data.message}`);
            return;
          }
          const w = waiting.get(data.id);
          if (!w) return;
          waiting.delete(data.id);
          w.slot.busy -= 1;
          w.done(data.tile);
        };
        slot.worker.onerror = (e) => {
          reject(new Error(`terrain lab worker failed: ${e.message}`));
        };
        slot.worker.postMessage({ type: 'init', input, spec, spacing } satisfies TileRequest);
      }),
  );
  return {
    ready: Promise.all(readies).then((ms) => Math.max(...ms)),
    size: pool.length,
    request(level, tx, ty, done) {
      let best = pool[0];
      for (const s of pool) if (best && s.busy < best.busy) best = s;
      if (!best || best.busy >= PER_WORKER) return false;
      const id = nextId;
      nextId += 1;
      best.busy += 1;
      waiting.set(id, { done, slot: best });
      best.worker.postMessage({ type: 'tile', id, level, tx, ty } satisfies TileRequest);
      return true;
    },
    pending: () => waiting.size,
    dispose() {
      for (const s of pool) s.worker.terminate();
      waiting.clear();
    },
  };
}
