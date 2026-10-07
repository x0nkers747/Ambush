/** What the runner drives: anything with a fixed tick duration and a step. */
export interface Steppable {
  readonly dtSeconds: number;
  /** Advances one tick. Any return value (e.g. simulation events) is ignored. */
  step(): unknown;
}

export interface FixedStepRunnerOptions {
  /**
   * Catch-up budget per `advance` call, in seconds of real time (docs/adr/0003).
   * One call steps at most the ticks that this much real time is worth at the
   * current time scale; anything beyond it (after a stall) is dropped, not
   * deferred, which prevents a "spiral of death". Use `Infinity` for headless,
   * faster-than-real-time execution. Default `DEFAULT_MAX_CATCH_UP_SECONDS`.
   */
  readonly maxCatchUpSeconds?: number;
  /** Initial ratio of simulation time to real time. Default 1. */
  readonly timeScale?: number;
}

/**
 * Converts variable real-time frame deltas into whole fixed simulation ticks.
 * The caller supplies elapsed real time; the runner never reads a clock, so it
 * behaves identically in the browser, in Node and in tests.
 */
export interface FixedStepRunner {
  readonly paused: boolean;
  /** Ratio of simulation time to real time; 0 freezes time without pausing. */
  timeScale: number;
  /** Fraction of a tick accumulated but not yet stepped, in [0, 1). Used for render interpolation. */
  readonly alpha: number;
  /** Total simulation seconds discarded by the catch-up budget. */
  readonly droppedSeconds: number;
  pause(): void;
  resume(): void;
  /** Accumulates `realDtSeconds` (scaled) and steps whole ticks. Returns the number of ticks stepped. */
  advance(realDtSeconds: number): number;
}

/**
 * Default catch-up budget: 100 ms of real time per frame. Covers ordinary
 * frames and missed display refreshes (33 ms at 60 Hz) with a wide margin,
 * while a stall of seconds is cut short instead of being simulated in one frame.
 */
export const DEFAULT_MAX_CATCH_UP_SECONDS = 0.1;

/** Absorbs floating-point error so e.g. 10 s at 30 Hz yields exactly 300 ticks. */
const TICK_EPSILON = 1e-9;

/**
 * The most ticks one `advance` may step: the budget's worth of simulation time
 * at the current time scale, rounded up so a frame exactly at the budget never
 * drops time, and at least one tick.
 */
export function maxTicksPerAdvance(
  maxCatchUpSeconds: number,
  timeScale: number,
  ticksPerSecond: number,
): number {
  return Math.max(1, Math.ceil(maxCatchUpSeconds * timeScale * ticksPerSecond - TICK_EPSILON));
}

export function createFixedStepRunner(
  target: Steppable,
  options: FixedStepRunnerOptions = {},
): FixedStepRunner {
  const maxCatchUpSeconds = options.maxCatchUpSeconds ?? DEFAULT_MAX_CATCH_UP_SECONDS;
  if (!(maxCatchUpSeconds > 0)) {
    throw new RangeError(`maxCatchUpSeconds must be > 0, got ${String(maxCatchUpSeconds)}`);
  }
  const ticksPerSecond = 1 / target.dtSeconds;

  let timeScale = checkTimeScale(options.timeScale ?? 1);
  let paused = false;
  // Pending simulation time measured in ticks (not seconds) so whole-tick
  // subtraction stays exact.
  let pendingTicks = 0;
  let droppedSeconds = 0;

  return {
    get paused() {
      return paused;
    },
    get timeScale() {
      return timeScale;
    },
    set timeScale(value: number) {
      timeScale = checkTimeScale(value);
    },
    get alpha() {
      return Math.min(Math.max(pendingTicks, 0), 1 - Number.EPSILON);
    },
    get droppedSeconds() {
      return droppedSeconds;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    advance(realDtSeconds: number): number {
      if (!(realDtSeconds >= 0) || !Number.isFinite(realDtSeconds)) {
        throw new RangeError(
          `realDtSeconds must be a finite number >= 0, got ${String(realDtSeconds)}`,
        );
      }
      if (paused) return 0;

      pendingTicks += realDtSeconds * timeScale * ticksPerSecond;
      const budget = maxTicksPerAdvance(maxCatchUpSeconds, timeScale, ticksPerSecond);
      let stepped = 0;
      while (pendingTicks >= 1 - TICK_EPSILON && stepped < budget) {
        target.step();
        pendingTicks -= 1;
        stepped += 1;
      }
      if (pendingTicks >= 1) {
        const whole = Math.floor(pendingTicks);
        droppedSeconds += whole / ticksPerSecond;
        pendingTicks -= whole;
      }
      return stepped;
    },
  };
}

function checkTimeScale(value: number): number {
  if (!(value >= 0) || !Number.isFinite(value)) {
    throw new RangeError(`timeScale must be a finite number >= 0, got ${String(value)}`);
  }
  return value;
}
