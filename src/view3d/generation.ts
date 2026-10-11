import type { TerrainDataset } from '#sim';
import { buildFeatures, featureBuffers, type FeatureGeometry } from './geo-features';
import { bakeGroundMap, type GroundMap } from './ground-map';
import {
  placeVegetation,
  type PlacementStats,
  type VegetationInstances,
} from './vegetation-placement';

// Generating a battlefield's 3D content off the main thread (docs/adr/0031):
// the feature geometry (roads, water, buildings) and the vegetation
// placement, both pure and deterministic, run in a Web Worker. The terrain is
// sent once per job; the results come back as typed arrays whose buffers are
// transferred, not copied. Starting a new job cancels the previous one (its
// worker is terminated), and replies from a cancelled job are ignored, so a
// stale result can never reach a newer battlefield. Where workers are not
// available (tests), the same work runs on this thread, asynchronously.
//
// The ground map for the terrain material (docs/adr/0038) is baked by a
// second worker at the same time, so it neither waits for nor delays the
// features and vegetation.

export type GenerationStage = 'features' | 'vegetation';

export interface GeneratedBattlefield {
  readonly features: FeatureGeometry;
  readonly vegetation: { readonly instances: VegetationInstances; readonly stats: PlacementStats };
  /** Milliseconds per stage, measured where the work ran. */
  readonly ms: { readonly features: number; readonly vegetation: number };
}

/** The generators, in order. Pure. */
export function generateBattlefield(
  terrain: TerrainDataset,
  progress: (stage: GenerationStage) => void = () => undefined,
): GeneratedBattlefield {
  progress('features');
  let t = performance.now();
  const { geometry: features, decorInstances } = buildFeatures(terrain);
  const featureMs = performance.now() - t;
  progress('vegetation');
  t = performance.now();
  // The roadside trees and props (docs/adr/0036) are drawn with the vegetation.
  const vegetation = placeVegetation(terrain, { extra: decorInstances });
  return { features, vegetation, ms: { features: featureMs, vegetation: performance.now() - t } };
}

/** Every buffer of a result, to transfer it. */
export function battlefieldBuffers(g: GeneratedBattlefield): ArrayBuffer[] {
  const v = g.vegetation.instances;
  return [
    ...featureBuffers(g.features),
    ...[
      v.plant,
      v.position,
      v.yaw,
      v.scale,
      v.tint,
      v.rank,
      v.tiles.starts,
      v.tiles.zMin,
      v.tiles.zMax,
    ].map((a) => a.buffer as ArrayBuffer),
  ];
}

export interface GenerationRequest {
  readonly type: 'generate' | 'ground';
  readonly jobId: number;
  readonly terrain: TerrainDataset;
}

/** The ground map and how long it took, ms. */
export interface BakedGround {
  readonly map: GroundMap;
  readonly ms: number;
}

/** The ground map of a terrain. Pure. */
export function bakeGround(terrain: TerrainDataset): BakedGround {
  const t = performance.now();
  const map = bakeGroundMap(terrain);
  return { map, ms: performance.now() - t };
}

export type GenerationReply =
  | { readonly type: 'progress'; readonly jobId: number; readonly stage: GenerationStage }
  | { readonly type: 'done'; readonly jobId: number; readonly result: GeneratedBattlefield }
  | { readonly type: 'ground'; readonly jobId: number; readonly result: BakedGround }
  | { readonly type: 'error'; readonly jobId: number; readonly message: string };

/** What the generator needs of a worker: a Web Worker running generation.worker.ts. */
export interface GenerationWorker {
  postMessage(message: GenerationRequest): void;
  onmessage: ((event: { readonly data: GenerationReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

/** A job: its result, or a rejection when it fails or is cancelled. */
export interface GenerationJob<T = GeneratedBattlefield> {
  readonly id: number;
  readonly result: Promise<T>;
  /** Stops the job; its promise rejects with a `GenerationCancelled`. */
  cancel(): void;
}

export class GenerationCancelled extends Error {
  constructor() {
    super('generation cancelled');
    this.name = 'GenerationCancelled';
  }
}

export interface Generator {
  /** Starts generating for a terrain, cancelling any job still running. */
  start(terrain: TerrainDataset, progress?: (stage: GenerationStage) => void): GenerationJob;
  /** Starts baking a terrain's ground map, cancelling any bake still running. */
  ground(terrain: TerrainDataset): GenerationJob<BakedGround>;
  dispose(): void;
}

export interface GeneratorOptions {
  /** Starts one worker, or returns null to work on this thread. Defaults to a module Web Worker. */
  readonly createWorker?: () => GenerationWorker | null;
}

export function createGenerator({
  createWorker = defaultWorker,
}: GeneratorOptions = {}): Generator {
  let nextId = 1;
  const current: {
    generate: GenerationJob<unknown> | null;
    ground: GenerationJob<unknown> | null;
  } = { generate: null, ground: null };

  /** Runs one job of a kind in a fresh worker (or on this thread), cancelling the kind's previous job. */
  const run = <T>(
    type: GenerationRequest['type'],
    terrain: TerrainDataset,
    inThread: () => T,
    progress: (stage: GenerationStage) => void,
  ): GenerationJob<T> => {
    current[type]?.cancel();
    const id = nextId;
    nextId += 1;
    let settled = false;
    let resolveJob: (g: T) => void = () => undefined;
    let rejectJob: (error: Error) => void = () => undefined;
    const result = new Promise<T>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (current[type] === job) current[type] = null;
      fn();
    };
    let stopWork: () => void = () => undefined;
    const worker = createWorker();
    if (worker) {
      stopWork = () => {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
      };
      worker.onmessage = ({ data }) => {
        // A reply for another job, or after this one ended, is stale: ignore it.
        if (data.jobId !== id || settled) return;
        if (data.type === 'progress') {
          progress(data.stage);
          return;
        }
        stopWork();
        if (data.type === 'error') {
          settle(() => {
            rejectJob(new Error(data.message));
          });
        } else {
          settle(() => {
            resolveJob(data.result as T);
          });
        }
      };
      worker.onerror = (event) => {
        stopWork();
        const message = (event as { message?: unknown } | null)?.message;
        settle(() => {
          rejectJob(new Error(`generation worker failed: ${String(message ?? event)}`));
        });
      };
      worker.postMessage({ type, jobId: id, terrain });
    } else {
      // On this thread, after the caller has had a chance to cancel.
      const timer = setTimeout(() => {
        try {
          const g = inThread();
          settle(() => {
            resolveJob(g);
          });
        } catch (error) {
          settle(() => {
            rejectJob(error instanceof Error ? error : new Error(String(error)));
          });
        }
      }, 0);
      stopWork = () => {
        clearTimeout(timer);
      };
    }
    const job: GenerationJob<T> = {
      id,
      result,
      cancel() {
        if (settled) return;
        stopWork();
        settle(() => {
          rejectJob(new GenerationCancelled());
        });
      },
    };
    current[type] = job;
    return job;
  };

  return {
    start(terrain, progress = () => undefined) {
      return run('generate', terrain, () => generateBattlefield(terrain, progress), progress);
    },
    ground(terrain) {
      return run(
        'ground',
        terrain,
        () => bakeGround(terrain),
        () => undefined,
      );
    },
    dispose() {
      current.generate?.cancel();
      current.ground?.cancel();
    },
  };
}

function defaultWorker(): GenerationWorker | null {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./generation.worker.ts', import.meta.url), {
    type: 'module',
    name: 'ambush-3d-generation',
  }) as unknown as GenerationWorker;
}
