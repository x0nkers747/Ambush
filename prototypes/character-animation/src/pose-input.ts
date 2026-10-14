/**
 * What an animation runtime is given: the soldier's state at a fractional
 * simulation time, interpolated between the two recorded ticks around it (the
 * "render interpolation" of the proposal's phase 0). A pure function of the
 * recorded frames and the time — no three.js — so the same time always gives
 * the same input, whether reached by playing, pausing or seeking.
 */

import {
  angleDelta,
  type Carry,
  CARRY_SECONDS,
  type Posture,
  type SimFrame,
  TICK_HZ,
  wrap,
} from './sim';

export interface PoseInput {
  /** Simulation seconds. */
  readonly time: number;
  readonly x: number;
  readonly y: number;
  /** Facing, radians clockwise from north. */
  readonly azimuth: number;
  /** Ground speed (m/s). */
  readonly speed: number;
  /** Direction of travel relative to facing: radians clockwise, 0 = forward, π/2 = right. */
  readonly moveAngle: number;
  /** Turning rate (rad/s, clockwise positive). */
  readonly turnRate: number;
  /** Distance travelled (m). */
  readonly odometer: number;
  readonly posture: Posture;
  readonly postureFrom: Posture;
  /** 0 → 1 through the posture change; 1 when settled. */
  readonly postureT: number;
  readonly postureStart: number;
  readonly postureUntil: number;
  readonly carry: Carry;
  readonly carryFrom: Carry;
  /** 0 → 1 through the carry change. */
  readonly carryT: number;
  readonly carryStart: number;
  readonly aimPitch: number;
  /** Seconds since the last shot (Infinity if none). */
  readonly sinceShot: number;
  readonly lastShot: number;
  /** 0 → 1 through a reload, or -1. */
  readonly reloadT: number;
  readonly reloadStart: number;
  /** Seconds since incapacitation, or -1. */
  readonly sinceDown: number;
  readonly downAt: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The pose input at `time` (seconds) of a recording. */
export function poseInputAt(frames: readonly SimFrame[], time: number): PoseInput {
  const last = frames.length - 1;
  const f = Math.max(0, Math.min(last, time * TICK_HZ));
  const i = Math.min(Math.floor(f + 1e-9), Math.max(0, last - 1));
  const alpha = last === 0 ? 0 : Math.min(1, f - i);
  const a = frames[i]?.s;
  const b = frames[Math.min(i + 1, last)]?.s;
  if (!a || !b) throw new Error('empty recording');
  const t = Math.max(0, Math.min(time, last / TICK_HZ));

  const vx = lerp(a.vx, b.vx, alpha);
  const vy = lerp(a.vy, b.vy, alpha);
  const speed = Math.hypot(vx, vy);
  const azimuth = wrap(a.azimuth + angleDelta(a.azimuth, b.azimuth) * alpha);
  const moveAngle = speed > 1e-4 ? angleDelta(azimuth, Math.atan2(vx, vy)) : 0;
  const turnRate = angleDelta(a.azimuth, b.azimuth) * TICK_HZ;
  // Discrete state comes from the later tick once it has begun (its window
  // starts at the earlier tick), so a change shows from its start time.
  const d = b;
  const span = d.postureUntil - d.postureStart;
  const postureT = span > 0 ? Math.max(0, Math.min(1, (t - d.postureStart) / span)) : 1;
  const carryT =
    d.carryStart < 0 ? 1 : Math.max(0, Math.min(1, (t - d.carryStart) / CARRY_SECONDS));
  const reloadT =
    d.reloadStart >= 0 && t >= d.reloadStart && t < d.reloadUntil
      ? (t - d.reloadStart) / (d.reloadUntil - d.reloadStart)
      : -1;
  const shotVisible = d.lastShot >= 0 && d.lastShot <= t + 1e-9;
  return {
    time: t,
    x: lerp(a.x, b.x, alpha),
    y: lerp(a.y, b.y, alpha),
    azimuth,
    speed,
    moveAngle,
    turnRate,
    odometer: lerp(a.odometer, b.odometer, alpha),
    posture: d.posture,
    postureFrom: d.postureFrom,
    postureT,
    postureStart: d.postureStart,
    postureUntil: d.postureUntil,
    carry: d.carry,
    carryFrom: d.carryFrom,
    carryT,
    carryStart: d.carryStart,
    aimPitch: lerp(a.aimPitch, b.aimPitch, alpha),
    sinceShot: shotVisible ? t - d.lastShot : a.lastShot >= 0 ? t - a.lastShot : Infinity,
    lastShot: shotVisible ? d.lastShot : a.lastShot,
    reloadT,
    reloadStart: d.reloadStart,
    sinceDown: d.downAt >= 0 && t >= d.downAt ? t - d.downAt : -1,
    downAt: d.downAt,
  };
}
