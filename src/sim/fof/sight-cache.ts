import { surfaceHeightAt } from '../bridge-navigation';
import { sightLineTracer } from '../sight-tracer';
import type { Posture, Soldier } from '../state';
import { vegetationTransmission } from './detection';
import type { FofContext } from './system';
import type { FofState } from './types';

// The sight between two force-on-force soldiers, remembered
// (docs/behavior-lab/force-on-force/04 §5.1). What an observer sees of a
// target — the share of the target's sample points in clear sight, and the
// light through vegetation — depends only on where each stands and his
// posture (the terrain does not change). Each soldier has a version that
// changes whenever his position or posture does; a pair's answer is reused
// while neither version has changed, so it is exactly the answer tracing
// again would give. In a firefight, where most soldiers lie still, most
// looks and bursts reuse it. Detection and fire's exposure use the same.
//
// Not simulation state: kept beside it, per force-on-force state object, and
// rebuilt (by tracing) after a restore.

const POSTURE_CODE: Readonly<Record<Posture, number>> = { standing: 1, kneeling: 2, prone: 3 };

interface SightCache {
  readonly n: number;
  /** Per member: the position and posture his version is for, and the version. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly posture: Uint8Array;
  readonly version: Int32Array;
  /** Per member: the surface height where he stands (for his version). */
  readonly ground: Float64Array;
  /** Per observer–target pair (observer-major): the versions the answer is for, and the answer. */
  readonly forObserver: Int32Array;
  readonly forTarget: Int32Array;
  readonly visible: Float64Array;
  readonly transmission: Float64Array;
}

const caches = new WeakMap<FofState, SightCache>();

function cacheFor(fof: FofState): SightCache {
  let cache = caches.get(fof);
  if (cache?.n !== fof.soldiers.length) {
    const n = fof.soldiers.length;
    cache = {
      n,
      x: new Float64Array(n).fill(Number.NaN),
      y: new Float64Array(n).fill(Number.NaN),
      posture: new Uint8Array(n),
      version: new Int32Array(n),
      ground: new Float64Array(n),
      forObserver: new Int32Array(n * n),
      forTarget: new Int32Array(n * n),
      visible: new Float64Array(n * n),
      transmission: new Float64Array(n * n),
    };
    caches.set(fof, cache);
  }
  return cache;
}

/** The member's version: a new one whenever his position or posture differs from the last seen. */
function versionOf(context: FofContext, cache: SightCache, i: number, s: Soldier): number {
  const code = POSTURE_CODE[s.posture];
  if (cache.x[i] !== s.position.x || cache.y[i] !== s.position.y || cache.posture[i] !== code) {
    if (cache.x[i] !== s.position.x || cache.y[i] !== s.position.y) {
      cache.ground[i] = surfaceHeightAt(context.world.terrain, s.position.x, s.position.y);
    }
    cache.x[i] = s.position.x;
    cache.y[i] = s.position.y;
    cache.posture[i] = code;
    cache.version[i] = (cache.version[i] ?? 0) + 1;
  }
  return cache.version[i] ?? 0;
}

/** The target's sample points' heights, reused. */
const heightsScratch: number[] = [];

/** What one soldier sees of another: the share of the target in clear sight, and the light through vegetation. */
export interface SightBetween {
  visibleFraction: number;
  transmission: number;
}

const scratch: SightBetween = { visibleFraction: 0, transmission: 0 };

/**
 * What observer member `i` sees of target member `j` (indices into
 * `FofState.soldiers`): exactly what tracing gives, traced only when either
 * has moved or changed posture since the pair was last traced. The result is
 * a shared object, valid until the next call.
 */
export function sightBetween(
  context: FofContext,
  i: number,
  j: number,
  observer: Soldier,
  target: Soldier,
): SightBetween {
  const cache = cacheFor(context.fof);
  const vo = versionOf(context, cache, i, observer);
  const vt = versionOf(context, cache, j, target);
  const k = i * cache.n + j;
  if (cache.forObserver[k] === vo && cache.forTarget[k] === vt) {
    scratch.visibleFraction = cache.visible[k] ?? 0;
    scratch.transmission = cache.transmission[k] ?? 0;
    return scratch;
  }
  const { terrain } = context.world;
  const detection = context.setup.config.detection;
  // The surface heights where they stand: the same numbers as computing them
  // now (they are computed when a soldier moves).
  const eye = {
    x: observer.position.x,
    y: observer.position.y,
    z: (cache.ground[i] ?? 0) + detection.eyeHeightM[observer.posture],
  };
  const ground = cache.ground[j] ?? 0;
  const heights = detection.targetSampleHeightsM[target.posture];
  heightsScratch.length = heights.length;
  heights.forEach((h, q) => {
    heightsScratch[q] = ground + h;
  });
  // The sample points share their map path: one walk for all of them.
  const clear = sightLineTracer(terrain).clearCount(
    eye,
    target.position.x,
    target.position.y,
    heightsScratch,
  );
  const visibleFraction = clear / heights.length;
  const transmission =
    visibleFraction > 0 ? vegetationTransmission(terrain, observer.position, target.position) : 0;
  cache.forObserver[k] = vo;
  cache.forTarget[k] = vt;
  cache.visible[k] = visibleFraction;
  cache.transmission[k] = transmission;
  scratch.visibleFraction = visibleFraction;
  scratch.transmission = transmission;
  return scratch;
}
