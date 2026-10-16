import { motionMovers, type MotionLog, type MotionSample } from '#exercise';
import type { DeepReadonly, Posture, SimState, SoldierId, SoldierStatus } from '#sim';

// Every soldier's motion as compact frames (docs/constructive-simulation/04):
// per tick and soldier, x, y, z and azimuth (a Float64Array), posture and
// status (a Uint8Array). The battle worker writes them as it steps
// (`writeFrame`) and posts them in batches; the page keeps them as a
// `MotionLog` (`createFrameLog`), which the map and the characters read.

export const POSTURES: readonly Posture[] = ['standing', 'kneeling', 'prone'];
export const STATUSES: readonly SoldierStatus[] = ['active', 'incapacitated'];

/** Values per soldier per frame. */
export const NUMBERS_PER_SOLDIER = 4;
export const CODES_PER_SOLDIER = 2;

/** Writes `state` (its soldiers, then its vehicles: `motionMovers`) as frame `k` of the arrays. */
export function writeFrame(
  state: DeepReadonly<SimState>,
  numbers: Float64Array,
  codes: Uint8Array,
  k: number,
): void {
  const movers = motionMovers(state);
  const n = movers.length;
  movers.forEach((s, i) => {
    const at = (k * n + i) * NUMBERS_PER_SOLDIER;
    numbers[at] = s.position.x;
    numbers[at + 1] = s.position.y;
    numbers[at + 2] = s.position.z;
    numbers[at + 3] = s.azimuth;
    const c = (k * n + i) * CODES_PER_SOLDIER;
    codes[c] = Math.max(0, POSTURES.indexOf(s.posture));
    codes[c + 1] = Math.max(0, STATUSES.indexOf(s.status));
  });
}

/** A batch of frames: ticks `firstTick` … `firstTick + count − 1`. */
export interface FrameBatch {
  readonly firstTick: number;
  readonly count: number;
  readonly numbers: Float64Array;
  readonly codes: Uint8Array;
}

export interface FrameLog extends MotionLog {
  /** Adds the next frames (ticks that follow on from the last). */
  add(batch: FrameBatch): void;
}

export function createFrameLog(tickRateHz: number, soldierIds: readonly SoldierId[]): FrameLog {
  const n = soldierIds.length;
  const index = new Map<string, number>(soldierIds.map((id, i) => [id, i]));
  const batches: FrameBatch[] = [];
  let firstTick = 0;
  let lastTick = -1;

  /** The batch holding `tick` (binary search: batches are in tick order). */
  const batchOf = (tick: number): FrameBatch | undefined => {
    let lo = 0;
    let hi = batches.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = batches[mid];
      if (!b) return undefined;
      if (tick < b.firstTick) hi = mid - 1;
      else if (tick >= b.firstTick + b.count) lo = mid + 1;
      else return b;
    }
    return undefined;
  };

  return {
    tickRateHz,
    soldierIds,
    get firstTick() {
      return firstTick;
    },
    get lastTick() {
      return lastTick;
    },
    epoch: 1,
    indexOf: (id) => index.get(id) ?? -1,
    add(given) {
      let batch = given;
      // Frames already held (the battle's start, shown before the worker sends it) are kept.
      if (batches.length > 0 && batch.firstTick <= lastTick) {
        const skip = lastTick + 1 - batch.firstTick;
        if (skip >= batch.count) return;
        batch = {
          firstTick: lastTick + 1,
          count: batch.count - skip,
          numbers: batch.numbers.subarray(skip * n * NUMBERS_PER_SOLDIER),
          codes: batch.codes.subarray(skip * n * CODES_PER_SOLDIER),
        };
      }
      if (batch.count === 0) return;
      if (batches.length === 0) firstTick = batch.firstTick;
      else if (batch.firstTick !== lastTick + 1)
        throw new Error(
          `frames do not follow on: ${String(batch.firstTick)} after ${String(lastTick)}`,
        );
      batches.push(batch);
      lastTick = batch.firstTick + batch.count - 1;
    },
    read(i, tick, out: MotionSample) {
      if (lastTick < firstTick || i < 0 || i >= n) return out;
      const t = Math.min(Math.max(tick, firstTick), lastTick);
      const b = batchOf(t);
      if (!b) return out;
      const k = t - b.firstTick;
      const at = (k * n + i) * NUMBERS_PER_SOLDIER;
      out.x = b.numbers[at] ?? 0;
      out.y = b.numbers[at + 1] ?? 0;
      out.z = b.numbers[at + 2] ?? 0;
      out.azimuth = b.numbers[at + 3] ?? 0;
      const c = (k * n + i) * CODES_PER_SOLDIER;
      out.posture = POSTURES[b.codes[c] ?? 0] ?? 'standing';
      out.status = STATUSES[b.codes[c + 1] ?? 0] ?? 'active';
      return out;
    },
  };
}
