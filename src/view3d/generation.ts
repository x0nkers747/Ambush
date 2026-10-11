import type { TerrainDataset } from '#sim';
import { buildFeatureGeometry, featureBuffers, type FeatureGeometry } from './geo-features';
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
  const features = buildFeatureGeometry(terrain);
  const featureMs = performance.now() - t;
  progress('vegetation');
  t = performance.now();
  const vegetation = placeVegetation(terrain);
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
  readonly type: 'generate';
  readonly jobId: number;
  readonly terrain: TerrainDataset;
}

export type GenerationReply =
  | { readonly type: 'progress'; readonly jobId: number; readonly stage: GenerationStage }
  | { readonly type: 'done'; readonly jobId: number; readonly result: GeneratedBattlefield }
  | { readonly type: 'error'; readonly jobId: number; readonly message: string };

/** What the generator needs of a worker: a Web Worker running generation.worker.ts. */
export interface GenerationWorker {
  postMessage(message: GenerationRequest): void;
  onmessage: ((event: { readonly data: GenerationReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate(): void;
}

/** A job: its result, or a rejection when it fails or is cancelled. */
export interface GenerationJob {
  readonly id: number;
  readonly result: Promise<GeneratedBattlefield>;
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
  let current: GenerationJob | null = null;
  return {
    start(terrain, progress = () => undefined) {
      current?.cancel();
      const id = nextId;
      nextId += 1;
      let settled = false;
      let resolveJob: (g: GeneratedBattlefield) => void = () => undefined;
      let rejectJob: (error: Error) => void = () => undefined;
      const result = new Promise<GeneratedBattlefield>((resolve, reject) => {
        resolveJob = resolve;
        rejectJob = reject;
      });
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (current === job) current = null;
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
          if (data.type === 'done')
            settle(() => {
              resolveJob(data.result);
            });
          else
            settle(() => {
              rejectJob(new Error(data.message));
            });
        };
        worker.onerror = (event) => {
          stopWork();
          const message = (event as { message?: unknown } | null)?.message;
          settle(() => {
            rejectJob(new Error(`generation worker failed: ${String(message ?? event)}`));
          });
        };
        worker.postMessage({ type: 'generate', jobId: id, terrain });
      } else {
        // On this thread, after the caller has had a chance to cancel.
        const timer = setTimeout(() => {
          try {
            const g = generateBattlefield(terrain, progress);
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
      const job: GenerationJob = {
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
      current = job;
      return job;
    },
    dispose() {
      current?.cancel();
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
