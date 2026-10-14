/**
 * Locomotion phase as a function of the recording and the time — no
 * per-frame accumulation — so playing, pausing, scrubbing backward and
 * jumping all give the same phase at the same time.
 *
 * The phase advances by distance travelled divided by the current blend's
 * cycle distance (metres per loop), integrated tick by tick over the recorded
 * frames. Turning on the spot also steps the feet (0.25 m of "travel" per
 * radian). Integrated values are memoised per tick, so normal playback costs
 * one tick of integration per tick, and a seek integrates at most once over
 * ticks not yet seen.
 */

import { angleDelta, type SimFrame, TICK_HZ } from './sim';

export type CycleDistanceAt = (frame: SimFrame['s']) => number;

export const TURN_STEP_M_PER_RAD = 0.25;

export class GaitClock {
  /** Phase (loops, unbounded) at each tick. */
  private readonly phase: number[] = [0];

  private readonly frames: readonly SimFrame[];
  private readonly cycleDistance: CycleDistanceAt;

  constructor(frames: readonly SimFrame[], cycleDistance: CycleDistanceAt) {
    this.frames = frames;
    this.cycleDistance = cycleDistance;
  }

  private travel(i: number): number {
    const a = this.frames[i]?.s;
    const b = this.frames[i + 1]?.s;
    if (!a || !b) return 0;
    return (
      b.odometer - a.odometer + Math.abs(angleDelta(a.azimuth, b.azimuth)) * TURN_STEP_M_PER_RAD
    );
  }

  private at(tick: number): number {
    while (this.phase.length <= tick) {
      const i = this.phase.length - 1;
      const s = this.frames[i + 1]?.s;
      const prev = this.phase[i] ?? 0;
      // Live recording not this far yet: answer without memoising.
      if (!s) return prev;
      const cycle = this.cycleDistance(s);
      this.phase.push(cycle > 1e-6 ? prev + this.travel(i) / cycle : prev);
    }
    return this.phase[tick] ?? 0;
  }

  /** Phase in loops at `time` seconds (fractional part = position in the cycle). */
  phaseAt(time: number): number {
    const last = this.frames.length - 1;
    const f = Math.max(0, Math.min(last, time * TICK_HZ));
    const i = Math.min(Math.floor(f + 1e-9), Math.max(0, last - 1));
    const alpha = Math.min(1, f - i);
    const p0 = this.at(i);
    const p1 = this.at(Math.min(i + 1, last));
    return p0 + (p1 - p0) * alpha;
  }

  /** Forget memoised ticks after `tick` (the live recording was extended or changed). */
  invalidateAfter(tick: number): void {
    if (this.phase.length > tick + 1) this.phase.length = tick + 1;
  }
}
