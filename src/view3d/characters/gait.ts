import { emptyMotionSample, type MotionLog } from '#exercise';
import { angleDelta, type Posture } from './rig';

// Locomotion phase as a function of the motion log and the time — no
// per-frame accumulation — so playing, pausing, scrubbing backward and
// jumping all give the same phase at the same time (docs/character-animation.md).
//
// The phase advances by the distance travelled in each tick divided by the
// cycle distance (metres per loop) of the blend at that tick, so the feet
// keep pace with the ground whatever the speed. Turning on the spot also
// steps the feet (0.25 m of "travel" per radian). Phases of settled ticks are
// memoised, so normal playback integrates one tick per tick, and a seek
// integrates at most once over ticks not yet seen.

export const TURN_STEP_M_PER_RAD = 0.25;

/** The blend's cycle distance at a tick, from the speed, direction and posture there. */
export type CycleDistanceAt = (travel: {
  speed: number;
  moveAngle: number;
  posture: Posture;
}) => number;

export class GaitClock {
  /** Phase (loops, unbounded) at each settled tick from the log's first. */
  private readonly phase: number[] = [0];
  private readonly a = emptyMotionSample();
  private readonly b = emptyMotionSample();
  private readonly log: MotionLog;
  private readonly index: number;
  private readonly travelAt: (tick: number) => Parameters<CycleDistanceAt>[0];
  private readonly cycleDistance: CycleDistanceAt;

  constructor(
    log: MotionLog,
    index: number,
    travelAt: (tick: number) => Parameters<CycleDistanceAt>[0],
    cycleDistance: CycleDistanceAt,
  ) {
    this.log = log;
    this.index = index;
    this.travelAt = travelAt;
    this.cycleDistance = cycleDistance;
  }

  /** Metres stepped over the tick ending at `tick`. */
  private stepped(tick: number): number {
    const p = this.log.read(this.index, tick - 1, this.a);
    const q = this.log.read(this.index, tick, this.b);
    return (
      Math.hypot(q.x - p.x, q.y - p.y) +
      Math.abs(angleDelta(p.azimuth, q.azimuth)) * TURN_STEP_M_PER_RAD
    );
  }

  private advance(prev: number, tick: number): number {
    const cycle = this.cycleDistance(this.travelAt(tick));
    return cycle > 1e-6 ? prev + this.stepped(tick) / cycle : prev;
  }

  /** Phase at a whole tick. */
  private at(tick: number): number {
    const first = this.log.firstTick;
    const settled = this.log.lastTick - 1;
    while (first + this.phase.length - 1 < Math.min(tick, settled)) {
      const k = first + this.phase.length;
      this.phase.push(this.advance(this.phase[this.phase.length - 1] ?? 0, k));
    }
    const memo = first + this.phase.length - 1;
    if (tick <= memo) return this.phase[Math.max(0, tick - first)] ?? 0;
    // Unsettled ticks (the latest): not memoised.
    let p = this.phase[this.phase.length - 1] ?? 0;
    for (let k = memo + 1; k <= tick; k += 1) p = this.advance(p, k);
    return p;
  }

  /** Phase in loops at `time` seconds (fractional part = position in the cycle). */
  phaseAt(time: number): number {
    const log = this.log;
    const f = Math.max(log.firstTick, Math.min(log.lastTick, time * log.tickRateHz));
    const i = Math.min(Math.floor(f + 1e-9), Math.max(log.firstTick, log.lastTick - 1));
    const w = Math.max(0, Math.min(1, f - i));
    const p0 = this.at(i);
    const p1 = this.at(Math.min(i + 1, log.lastTick));
    return w === 1 ? p1 : p0 + (p1 - p0) * w;
  }
}
