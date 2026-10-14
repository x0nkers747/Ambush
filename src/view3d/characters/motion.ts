import { emptyMotionSample, type CombatEvent, type MotionLog, type MotionSample } from '#exercise';
import { angleDelta, type Carry, type Posture, wrapAngle } from './rig';

// What a soldier's animator is given (docs/character-animation.md): the
// soldier at a fractional simulation time, from the exercise's motion log
// (every tick since the start) and its combat log (shot and incapacitation
// times). A pure function of (logs, time): no clock, no frame count, no
// history of earlier calls but memoised facts about recorded ticks, so the
// same time gives the same input live, in the After Action Review, at any
// speed and however the time was reached.
//
// Between two ticks, position and facing are interpolated. Speed and
// direction of travel come from the distance covered over the last
// `SPEED_WINDOW_S` (the simulation changes speed at once; a short window gives
// the animation a start and a stop). It only looks back, so live (drawn one
// tick behind the simulation) and the review see the same.

/** Look-back for speed and direction of travel (s). */
export const SPEED_WINDOW_S = 0.3;
/** How long a soldier keeps aiming after a shot (s). */
export const AIM_HOLD_S = 4;
/** Below this ground speed a soldier is standing still (m/s). */
export const MOVING_MPS = 0.2;
/** Visual posture changes (s): the simulation changes posture at once. */
export const POSTURE_SECONDS: Record<Posture, Record<Posture, number>> = {
  standing: { standing: 0, kneeling: 0.6, prone: 1.5 },
  kneeling: { standing: 0.6, kneeling: 0, prone: 1.1 },
  prone: { standing: 1.7, kneeling: 1.2, prone: 0 },
};
/** Raising or lowering the weapon (s). */
export const CARRY_SECONDS = 0.35;

export interface PoseInput {
  /** Simulation seconds. */
  readonly time: number;
  readonly x: number;
  readonly y: number;
  /** The surface stood on (m). */
  readonly z: number;
  /** Facing, radians clockwise from north. */
  readonly azimuth: number;
  /** Ground speed (m/s). */
  readonly speed: number;
  /** Direction of travel relative to facing: radians clockwise, 0 = forward, π/2 = right. */
  readonly moveAngle: number;
  /** Turning rate (rad/s, clockwise positive). */
  readonly turnRate: number;
  readonly posture: Posture;
  readonly postureFrom: Posture;
  /** 0 → 1 through the posture change; 1 when settled. */
  readonly postureT: number;
  readonly carry: Carry;
  readonly carryFrom: Carry;
  /** 0 → 1 through the carry change. */
  readonly carryT: number;
  /** Aim above the horizontal (rad): the facing alone, so 0 (no aim point is simulated). */
  readonly aimPitch: number;
  /** Seconds since the last shot (Infinity if none) and its time (−1 if none). */
  readonly sinceShot: number;
  readonly lastShot: number;
  /** No reloads are simulated: always −1. */
  readonly reloadT: number;
  /** Seconds since incapacitation, or −1. */
  readonly sinceDown: number;
}

const CARRIES: readonly Carry[] = ['lowered', 'ready', 'aimed'];
/** Exactly `a` at 0 and `b` at 1 (a tick reached by interpolation equals the tick read directly). */
const lerp = (a: number, b: number, t: number) => (t === 1 ? b : a + (b - a) * t);

/**
 * Last-change lookups over a per-tick code: the tick at which the code at a
 * given tick began (the first tick of its run). Ticks before the log's latest
 * never change, so their changes are memoised once; the latest is looked at
 * afresh each time.
 */
class Changes {
  /** Ticks where the code changed, ascending, over the ticks scanned. */
  private readonly ticks: number[] = [];
  private scanned: number;
  private prev = -1;
  private readonly first: number;
  private readonly codeAt: (tick: number) => number;

  constructor(first: number, codeAt: (tick: number) => number) {
    this.first = first;
    this.codeAt = codeAt;
    this.scanned = first - 1;
  }

  at(tick: number, settled: number): { code: number; since: number } {
    while (this.scanned < Math.min(tick, settled)) {
      const k = this.scanned + 1;
      const code = this.codeAt(k);
      if (k > this.first && code !== this.prev) this.ticks.push(k);
      this.prev = code;
      this.scanned = k;
    }
    const code = this.codeAt(tick);
    let search = tick;
    if (tick > this.scanned) {
      // Unsettled ticks: walk back to the memoised ones.
      let k = tick;
      while (k > this.scanned && k > this.first && this.codeAt(k - 1) === code) k -= 1;
      if (k > this.scanned || k <= this.first) return { code, since: Math.max(k, this.first) };
      search = this.scanned;
    }
    // The last change at or before `search`.
    let lo = 0;
    let hi = this.ticks.length - 1;
    let since = this.first;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const m = this.ticks[mid] ?? 0;
      if (m <= search) {
        since = m;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return { code, since };
  }
}

/** Times (s) of the soldier's shots and incapacitation, from the combat log. */
interface CombatTimes {
  readonly shots: number[];
  downAt: number;
  /** Who fired the shot that incapacitated the soldier, and when. */
  hitBy: { readonly shooterId: string; readonly atSeconds: number } | null;
}

/**
 * One soldier's pose input from the logs. Memoises facts about settled ticks;
 * create a new one when the motion log's `epoch` changes.
 */
export class SoldierMotion {
  readonly index: number;
  private readonly log: MotionLog;
  private readonly rate: number;
  private readonly a = emptyMotionSample();
  private readonly b = emptyMotionSample();
  private readonly c = emptyMotionSample();
  /** Scratch for the per-tick codes and speeds (never the interpolation's). */
  private readonly d = emptyMotionSample();
  private readonly e = emptyMotionSample();
  private readonly posture: Changes;
  private readonly carry: Changes;
  private readonly status: Changes;
  private combat: CombatTimes = { shots: [], downAt: -1, hitBy: null };
  private combatSeen = -1;
  private readonly id: string;

  constructor(log: MotionLog, id: string) {
    this.log = log;
    this.id = id;
    this.index = log.indexOf(id);
    this.rate = log.tickRateHz;
    const POSTURES: Posture[] = ['standing', 'kneeling', 'prone'];
    this.posture = new Changes(log.firstTick, (k) =>
      POSTURES.indexOf(this.read(k, this.c).posture),
    );
    this.carry = new Changes(log.firstTick, (k) => CARRIES.indexOf(this.carryAtTick(k)));
    this.status = new Changes(log.firstTick, (k) =>
      this.read(k, this.c).status === 'incapacitated' ? 1 : 0,
    );
  }

  private read(tick: number, out: MotionSample): MotionSample {
    return this.log.read(this.index, tick, out);
  }

  /** Brings the shot and incapacitation times up to date with the combat log (append-only). */
  updateCombat(combatLog: readonly CombatEvent[]): void {
    if (combatLog.length === this.combatSeen) return;
    if (combatLog.length < this.combatSeen) this.combat = { shots: [], downAt: -1, hitBy: null };
    for (let i = Math.max(0, this.combatSeen); i < combatLog.length; i += 1) {
      const e = combatLog[i];
      if (e?.type === 'shotFired' && e.shooterId === this.id) this.combat.shots.push(e.atSeconds);
      if (e?.type === 'soldierIncapacitated' && e.soldierId === this.id)
        this.combat.downAt = e.atSeconds;
      if (e?.type === 'shotFired' && e.targetId === this.id && e.incapacitated)
        this.combat.hitBy = { shooterId: e.shooterId, atSeconds: e.atSeconds };
    }
    this.combatSeen = combatLog.length;
  }

  /** The time of the soldier's last shot at or before `t`, or −1. */
  private lastShotBy(t: number): number {
    const s = this.combat.shots;
    let lo = 0;
    let hi = s.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((s[mid] ?? Infinity) <= t + 1e-9) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found >= 0 ? (s[found] ?? -1) : -1;
  }

  /** Ground speed over the tick ending at `tick` (m/s). */
  private tickSpeed(tick: number): number {
    if (tick <= this.log.firstTick) return 0;
    const p = this.read(tick - 1, this.d);
    const q = this.read(tick, this.e);
    return Math.hypot(q.x - p.x, q.y - p.y) * this.rate;
  }

  /** How the weapon is carried at `tick`: aimed when firing or engaging, lowered on the move. */
  private carryAtTick(tick: number): Carry {
    const s = this.read(tick, this.c);
    const t = tick / this.rate;
    const shot = this.lastShotBy(t);
    if (shot >= 0 && t - shot < AIM_HOLD_S) return 'aimed';
    if (s.behavior === 'engaging') return 'aimed';
    if (this.tickSpeed(tick) > MOVING_MPS) return 'lowered';
    return 'ready';
  }

  /** Position at a fractional tick `f` (interpolated), written into `out`. */
  private positionAt(f: number, out: { x: number; y: number }) {
    const k = Math.floor(f);
    const p = this.read(k, this.a);
    const q = this.read(k + 1, this.b);
    const w = f - k;
    out.x = lerp(p.x, q.x, w);
    out.y = lerp(p.y, q.y, w);
  }

  /** The pose input at `time` simulation seconds (clamped to the recorded ticks). */
  at(time: number): PoseInput {
    return this.atTick(time * this.rate);
  }

  /** The pose input at fractional tick `tick` (clamped to the recorded ticks). */
  atTick(tick: number): PoseInput {
    const log = this.log;
    const f = Math.max(log.firstTick, Math.min(log.lastTick, tick));
    const t = f / this.rate;
    // Past the latest tick (the timeline has ended: `AnimationClock`), motion
    // stays at the last tick but transitions under way (a fall, a posture
    // change, recoil) carry on.
    const te = Math.max(t, tick / this.rate);
    const k = Math.min(Math.floor(f + 1e-9), Math.max(log.firstTick, log.lastTick - 1));
    const w = Math.max(0, Math.min(1, f - k));
    const a = this.read(k, this.a);
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const aAz = a.azimuth;
    const b = this.read(k + 1, this.b);
    const dAz = angleDelta(aAz, b.azimuth);
    const x = lerp(ax, b.x, w);
    const y = lerp(ay, b.y, w);
    const z = lerp(az, b.z, w);
    const azimuth = w === 1 ? b.azimuth : wrapAngle(aAz + dAz * w);
    // Discrete state from the later tick, which begins at the earlier one, so
    // a change shows from the start of the tick in which it happened.
    const posture = b.posture;
    const status = b.status;
    const settled = log.lastTick - 1;

    // Travel over the look-back window.
    const back = { x: 0, y: 0 };
    this.positionAt(Math.max(log.firstTick, f - SPEED_WINDOW_S * this.rate), back);
    const span = Math.min(SPEED_WINDOW_S, t - log.firstTick / this.rate);
    const vx = span > 1e-6 ? (x - back.x) / span : 0;
    const vy = span > 1e-6 ? (y - back.y) / span : 0;
    const speed = Math.hypot(vx, vy);
    const moveAngle = speed > 1e-4 ? angleDelta(azimuth, Math.atan2(vx, vy)) : 0;

    const p = this.posture.at(k + 1, settled);
    const POSTURES: Posture[] = ['standing', 'kneeling', 'prone'];
    const postureFrom =
      p.since > log.firstTick
        ? (POSTURES[this.posture.at(p.since - 1, settled).code] ?? posture)
        : posture;
    const postureStart = (p.since - 1) / this.rate;
    const postureSpan = POSTURE_SECONDS[postureFrom][posture];
    const postureT =
      postureSpan > 0 ? Math.max(0, Math.min(1, (te - postureStart) / postureSpan)) : 1;

    const cNow = this.carry.at(k + 1, settled);
    const carry = CARRIES[cNow.code] ?? 'ready';
    const carryFrom =
      cNow.since > log.firstTick
        ? (CARRIES[this.carry.at(cNow.since - 1, settled).code] ?? carry)
        : carry;
    const carryStart = (cNow.since - 1) / this.rate;
    const carryT =
      carryFrom === carry ? 1 : Math.max(0, Math.min(1, (te - carryStart) / CARRY_SECONDS));

    const lastShot = this.lastShotBy(te);
    // From the combat log; failing that, from the tick the status changed.
    const downAt =
      this.combat.downAt >= 0
        ? this.combat.downAt
        : status === 'incapacitated'
          ? (this.status.at(k + 1, settled).since - 1) / this.rate
          : -1;
    return {
      time: te,
      x,
      y,
      z,
      azimuth,
      speed,
      moveAngle,
      turnRate: dAz * this.rate,
      posture,
      postureFrom,
      postureT,
      carry,
      carryFrom,
      carryT,
      aimPitch: 0,
      sinceShot: lastShot >= 0 ? te - lastShot : Infinity,
      lastShot,
      reloadT: -1,
      sinceDown: downAt >= 0 && te >= downAt - 1e-9 ? te - downAt : -1,
    };
  }

  /**
   * Where the shot that incapacitated the soldier came from (map x, y), or
   * null (no such shot in the combat log).
   */
  shooterPosition(): { x: number; y: number } | null {
    const hit = this.combat.hitBy;
    if (!hit) return null;
    const i = this.log.indexOf(hit.shooterId);
    if (i < 0) return null;
    const s = this.log.read(i, Math.floor(hit.atSeconds * this.rate), this.e);
    return { x: s.x, y: s.y };
  }

  /** Ground speed and travel angle at a tick (for the gait clock). */
  travelAt(tick: number): { speed: number; moveAngle: number; posture: Posture } {
    return this.atTick(tick);
  }
}
