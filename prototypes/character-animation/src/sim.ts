/**
 * A miniature deterministic soldier simulation, standing in for Ambush!'s
 * `src/sim` in this prototype. It has the same shape as the real one — plain
 * data, a fixed 30 Hz tick, commands stamped with a tick, a full state frame
 * recorded per tick — plus the state the animation proposal adds (velocity
 * with acceleration, an odometer, posture changes with a time window, weapon
 * carry, aim, shots, a reload window, incapacitation; see
 * docs/character-animation-architecture.md §4).
 *
 * No three.js, no clocks, no randomness: the same commands always give the
 * same frames, so every animation runtime is driven by identical input.
 */

export const TICK_HZ = 30;
export const DT = 1 / TICK_HZ;

export type Posture = 'standing' | 'kneeling' | 'prone';
export type Carry = 'lowered' | 'ready' | 'aimed';
export type WeaponKind = 'm16' | 'm249';

export interface SoldierState {
  /** Map metres, x east, y north. */
  x: number;
  y: number;
  /** Ground velocity, m/s (map axes). */
  vx: number;
  vy: number;
  /** Distance travelled, m (a gait phase that survives speed changes and seeks). */
  odometer: number;
  /** Facing: radians clockwise from north. */
  azimuth: number;
  posture: Posture;
  /** The posture being left and the window of the change; `postureFrom === posture` when settled. */
  postureFrom: Posture;
  postureStart: number;
  postureUntil: number;
  carry: Carry;
  carryFrom: Carry;
  carryStart: number;
  /** Weapon direction relative to north (rad) and pitch (rad, up positive). */
  aimAzimuth: number;
  aimPitch: number;
  /** Simulation seconds of the last shot, or -1. */
  lastShot: number;
  shots: number;
  reloadStart: number;
  reloadUntil: number;
  /** Simulation seconds of incapacitation, or -1. */
  downAt: number;
}

export interface Intent {
  /** Desired ground speed, m/s (capped by posture). */
  speed: number;
  /** Direction of travel, radians clockwise from north. */
  heading: number;
  /** Facing: follow travel, or hold an azimuth (strafing, backing away). */
  face: 'travel' | number;
  posture: Posture;
  carry: Carry;
  aimPitch: number;
  /** Seconds between shots while > 0. */
  fireInterval: number;
  reload: boolean;
  down: boolean;
}

export interface SimFrame {
  readonly tick: number;
  readonly s: Readonly<SoldierState>;
}

/** Timings the proposal moves into simulation data (posture, weapon handling). */
export const POSTURE_SECONDS: Record<Posture, Record<Posture, number>> = {
  standing: { standing: 0, kneeling: 0.6, prone: 1.5 },
  kneeling: { standing: 0.6, kneeling: 0, prone: 1.1 },
  prone: { standing: 1.7, kneeling: 1.2, prone: 0 },
};
export const MAX_SPEED: Record<Posture, number> = { standing: 6, kneeling: 1.6, prone: 0.45 };
export const CARRY_SECONDS = 0.35;
export const RELOAD_SECONDS = 2.1;
export const ACCELERATION = 3.2; // m/s²
export const TURN_RATE = Math.PI; // rad/s

export function initialState(): SoldierState {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    odometer: 0,
    azimuth: 0,
    posture: 'standing',
    postureFrom: 'standing',
    postureStart: 0,
    postureUntil: 0,
    carry: 'lowered',
    carryFrom: 'lowered',
    carryStart: -1,
    aimAzimuth: 0,
    aimPitch: 0,
    lastShot: -1,
    shots: 0,
    reloadStart: -1,
    reloadUntil: -1,
    downAt: -1,
  };
}

export function idleIntent(): Intent {
  return {
    speed: 0,
    heading: 0,
    face: 'travel',
    posture: 'standing',
    carry: 'lowered',
    aimPitch: 0,
    fireInterval: 0,
    reload: false,
    down: false,
  };
}

const TAU = Math.PI * 2;
export const wrap = (a: number) => ((a % TAU) + TAU) % TAU;
/** Signed shortest difference b − a in (−π, π]. */
export const angleDelta = (a: number, b: number) => {
  const d = wrap(b - a);
  return d > Math.PI ? d - TAU : d;
};
const turnToward = (from: number, to: number, max: number) => {
  const d = angleDelta(from, to);
  return wrap(from + Math.max(-max, Math.min(max, d)));
};

/** Advances `s` by one tick under `intent`. `tick` is the tick being completed. */
export function step(s: SoldierState, intent: Intent, tick: number): void {
  const t = (tick + 1) * DT;
  if (s.downAt >= 0) return;
  if (intent.down) {
    s.downAt = t;
    s.vx = s.vy = 0;
    return;
  }

  // Posture: a change takes a fixed time and blocks movement.
  const changing = t < s.postureUntil;
  if (!changing && intent.posture !== s.posture) {
    s.postureFrom = s.posture;
    s.posture = intent.posture;
    s.postureStart = t - DT;
    s.postureUntil = s.postureStart + POSTURE_SECONDS[s.postureFrom][s.posture];
  } else if (!changing) {
    s.postureFrom = s.posture;
  }
  const settled = t >= s.postureUntil;

  // Velocity: accelerate toward the intended velocity (zero while changing posture).
  const reloading = t < s.reloadUntil;
  let cap = MAX_SPEED[s.posture];
  if (reloading) cap = Math.min(cap, 1.6);
  const speed = settled ? Math.min(intent.speed, cap) : 0;
  const tx = Math.sin(intent.heading) * speed;
  const ty = Math.cos(intent.heading) * speed;
  const dx = tx - s.vx;
  const dy = ty - s.vy;
  const dv = Math.hypot(dx, dy);
  const maxDv = ACCELERATION * DT;
  if (dv <= maxDv) {
    s.vx = tx;
    s.vy = ty;
  } else {
    s.vx += (dx / dv) * maxDv;
    s.vy += (dy / dv) * maxDv;
  }
  s.x += s.vx * DT;
  s.y += s.vy * DT;
  s.odometer += Math.hypot(s.vx, s.vy) * DT;

  // Facing.
  const moving = Math.hypot(s.vx, s.vy) > 0.05;
  const faceTarget =
    intent.face === 'travel' ? (moving ? Math.atan2(s.vx, s.vy) : s.azimuth) : intent.face;
  const rate = s.posture === 'prone' ? TURN_RATE * 0.35 : TURN_RATE;
  s.azimuth = turnToward(s.azimuth, wrap(faceTarget), rate * DT);

  // Weapon carry: raising and lowering take a fixed time.
  const carry = reloading || !settled ? (s.carry === 'aimed' ? 'ready' : s.carry) : intent.carry;
  if (carry !== s.carry && t >= s.carryStart + CARRY_SECONDS) {
    s.carryFrom = s.carry;
    s.carry = carry;
    s.carryStart = t - DT;
  }
  s.aimAzimuth = s.azimuth;
  s.aimPitch = s.carry === 'aimed' ? intent.aimPitch : 0;

  // Reload.
  if (intent.reload && !reloading && settled) {
    s.reloadStart = t - DT;
    s.reloadUntil = s.reloadStart + RELOAD_SECONDS;
  }

  // Fire: only aimed, settled and not reloading; at most one shot per interval.
  if (intent.fireInterval > 0 && s.carry === 'aimed' && t >= s.carryStart + CARRY_SECONDS) {
    if (settled && !reloading && (s.lastShot < 0 || t - s.lastShot >= intent.fireInterval - 1e-9)) {
      s.lastShot = t;
      s.shots += 1;
    }
  }
}

/** A command applied from a given tick on (merged into the running intent). */
export interface Command {
  readonly atTick: number;
  readonly set: Partial<Intent>;
}

const deg = (d: number) => (d * Math.PI) / 180;
const at = (seconds: number, set: Partial<Intent>): Command => ({
  atTick: Math.round(seconds * TICK_HZ),
  set,
});

/**
 * The fixed test sequence: walking, running, sprinting, stopping, turning,
 * strafing and backing while aiming, firing, kneeling, prone, crawling,
 * getting up, diagonal movement, a reload and incapacitation.
 */
export const TEST_SEQUENCE: readonly Command[] = [
  at(1, { speed: 0.9, heading: 0 }),
  at(3, { speed: 1.5 }),
  at(5.5, { speed: 3.4 }),
  at(8, { speed: 5.6 }),
  at(10, { speed: 0 }),
  at(12, { face: deg(90) }),
  at(13.5, { carry: 'ready' }),
  at(14.2, { carry: 'aimed' }),
  at(14.6, { speed: 1.2, heading: deg(0) }),
  at(17, { heading: deg(270) }),
  at(19, { speed: 0, fireInterval: 0.5 }),
  at(20.6, { fireInterval: 0 }),
  at(21, { posture: 'kneeling' }),
  at(22.4, { fireInterval: 0.5 }),
  at(23.6, { fireInterval: 0 }),
  at(24, { posture: 'prone' }),
  at(26, { carry: 'ready', face: 'travel', speed: 0.4, heading: deg(90) }),
  at(30, { speed: 0, carry: 'aimed', face: deg(90) }),
  at(30.8, { fireInterval: 0.5 }),
  at(32, { fireInterval: 0 }),
  at(32.5, { posture: 'standing', carry: 'ready' }),
  at(35, { speed: 1.4, heading: deg(45), face: deg(90), carry: 'aimed', aimPitch: deg(-8) }),
  at(37.5, { speed: 0, aimPitch: 0 }),
  at(38, { carry: 'ready', reload: true }),
  at(38.2, { reload: false }),
  at(41, { carry: 'aimed' }),
  at(41.6, { fireInterval: 0.25 }),
  at(42.4, { fireInterval: 0 }),
  at(43, { down: true }),
];
export const TEST_SEQUENCE_SECONDS = 47;

/** A running simulation that records a frame per tick (like Ambush!'s review recording). */
export class MiniSim {
  readonly frames: SimFrame[] = [];
  private readonly state = initialState();
  private intent = idleIntent();
  private tick = 0;
  private queue: Command[];

  constructor(commands: readonly Command[] = []) {
    this.queue = [...commands].sort((a, b) => a.atTick - b.atTick);
    this.frames.push({ tick: 0, s: { ...this.state } });
  }

  get ticks(): number {
    return this.tick;
  }
  get seconds(): number {
    return this.tick * DT;
  }
  get current(): Readonly<Intent> {
    return this.intent;
  }

  /** Queues a change of intent at the next tick (live control). */
  command(set: Partial<Intent>): void {
    this.queue.push({ atTick: this.tick, set });
  }

  stepTo(tick: number): void {
    while (this.tick < tick) {
      while (this.queue.length > 0 && (this.queue[0]?.atTick ?? Infinity) <= this.tick) {
        const c = this.queue.shift();
        if (c) this.intent = { ...this.intent, ...c.set };
      }
      step(this.state, this.intent, this.tick);
      this.tick += 1;
      this.frames.push({ tick: this.tick, s: { ...this.state } });
    }
  }
}

/** Runs the test sequence to the end and returns its frames. */
export function recordTestSequence(): SimFrame[] {
  const sim = new MiniSim(TEST_SEQUENCE);
  sim.stepTo(Math.round(TEST_SEQUENCE_SECONDS * TICK_HZ));
  return sim.frames;
}
