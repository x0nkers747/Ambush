// Adaptive render resolution (docs/adr/0029, performance): the 3D view's
// drawing buffer is scaled down when frames are slow and back up when there
// is room, so a GPU that cannot fill every pixel of a large, dense display at
// the quality chosen still draws smoothly, a little softer. A function of
// the frame times alone.
//
// - Slow: frames over the last second average longer than `slowMs` (below
//   about 54 fps): one step down.
// - No gain: two steps down did not make frames faster (they are slow for
//   another reason, the simulation, the CPU): back to where it was, and no
//   step down for `holdMs`. (Two: frames are shown at the display's refresh,
//   so one step may not show its gain until a frame fits in one refresh.)
// - Room: frames steady at the display's own rate (within 10% of the
//   fastest seen) for `upAfterMs`: one step up. One that is slow again soon
//   after waits twice as long before trying again (at most `maxUpAfterMs`).

/** The scales of the full resolution it steps through. */
export const RESOLUTION_STEPS: readonly number[] = [1, 0.85, 0.72, 0.6, 0.5];

export interface ResolutionOptions {
  /** Frames slower than this on average are slow (ms). */
  readonly slowMs?: number;
  /** Frames measured before deciding. */
  readonly window?: number;
  /** Steady this long before trying a step up (ms), and at most, after failed tries. */
  readonly upAfterMs?: number;
  readonly maxUpAfterMs?: number;
  /** No step down for this long after one that gained nothing (ms). */
  readonly holdMs?: number;
}

export interface ResolutionGovernor {
  /** A frame drawn at `nowMs`: the scale of the full resolution to draw the next at. */
  frame(nowMs: number): number;
  /** The frames stopped (loading, hidden): the next interval is not measured. */
  pause(): void;
  /** Back to full resolution, nothing measured (the quality changed). */
  reset(): void;
  readonly scale: number;
}

export function createResolutionGovernor(o: ResolutionOptions = {}): ResolutionGovernor {
  const slowMs = o.slowMs ?? 18.5;
  const size = o.window ?? 60;
  const baseUpAfter = o.upAfterMs ?? 4000;
  const maxUpAfter = o.maxUpAfterMs ?? 64_000;
  const holdMs = o.holdMs ?? 20_000;
  let step = 0;
  let last: number | null = null;
  let times: number[] = [];
  /** The fastest frame seen lately (ms): about the display's own rate. */
  let fastest = Infinity;
  let steadySince: number | null = null;
  let upAfter = baseUpAfter;
  /** Stepping down: where it started, and the mean then (to see whether it gains anything). */
  let downStart: { step: number; mean: number } | null = null;
  /** After a step up, until when a slow spell counts against it. */
  let upAt: number | null = null;
  let holdUntil = -Infinity;

  const change = (next: number) => {
    step = Math.max(0, Math.min(RESOLUTION_STEPS.length - 1, next));
    times = [];
    steadySince = null;
  };

  return {
    get scale() {
      return RESOLUTION_STEPS[step] ?? 1;
    },
    frame(now) {
      const dt = last === null ? null : now - last;
      last = now;
      // A pause (a hidden tab, a load): not a frame time.
      if (dt === null || dt <= 0 || dt > 250) return RESOLUTION_STEPS[step] ?? 1;
      fastest = Math.min(fastest * 1.002, dt);
      times.push(dt);
      if (times.length < size) return RESOLUTION_STEPS[step] ?? 1;
      if (times.length > size) times.shift();
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      // Stepping down: it helped (frames faster, or no longer slow), or two steps
      // gained nothing: back to where it was, and leave it for a while.
      if (downStart !== null) {
        if (mean < 0.93 * downStart.mean || mean <= slowMs) downStart = null;
        else if (step - downStart.step >= 2) {
          holdUntil = now + holdMs;
          change(downStart.step);
          downStart = null;
          return RESOLUTION_STEPS[step] ?? 1;
        }
      }
      if (mean > slowMs) {
        steadySince = null;
        // Slow soon after a step up: that step was too much; wait longer before the next.
        if (upAt !== null && now - upAt < 3000) upAfter = Math.min(maxUpAfter, upAfter * 2);
        upAt = null;
        if (step < RESOLUTION_STEPS.length - 1 && now >= holdUntil) {
          downStart ??= { step, mean };
          change(step + 1);
        }
        return RESOLUTION_STEPS[step] ?? 1;
      }
      if (upAt !== null && now - upAt >= 3000) {
        // The step up held.
        upAt = null;
        upAfter = Math.max(baseUpAfter, upAfter / 2);
      }
      // Steady at the display's rate: room to try a step up.
      if (step > 0 && mean <= 1.1 * fastest) {
        steadySince ??= now;
        if (now - steadySince >= upAfter) {
          upAt = now;
          change(step - 1);
        }
      } else steadySince = null;
      return RESOLUTION_STEPS[step] ?? 1;
    },
    pause() {
      last = null;
    },
    reset() {
      step = 0;
      last = null;
      times = [];
      fastest = Infinity;
      steadySince = null;
      upAfter = baseUpAfter;
      downStart = null;
      upAt = null;
      holdUntil = -Infinity;
    },
  };
}
