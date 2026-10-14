import type { Azimuth, Vec2 } from '../geometry';
import type { OrgUnitId, SoldierId } from '../state';

// Unit tasks and the agents they drive (docs/behavior-lab/03): plain data in
// `SimState.behavior`, so they are cloned, hashed, snapshotted and recorded
// like the rest of the state. An ordered organization (fire team, squad, …)
// gets one task; its Marines are agents steering to their slots of the
// task's formation along the task's one route.

/**
 * A formation as the simulation sees it: resolved slots in metres, nested by
 * organization. Built outside the simulation from doctrinal templates and the
 * roster (`#exercise` formations); the simulation attaches no meaning to roles.
 *
 * Offsets are route-relative: `back` metres behind the parent's reference
 * point along the route (negative: ahead), `right` metres to its right.
 */
export interface FormationSpec {
  readonly root: FormationNode;
  /** The individual interval the formation was built with (m): the scale of its tolerances. */
  readonly interval: number;
}

export interface FormationNode {
  readonly unitId: OrgUnitId;
  /** Offset of this node's reference point from its parent's (the root's is ignored). */
  readonly back: number;
  readonly right: number;
  /** Soldiers placed by this node, relative to its reference point. */
  readonly slots: readonly FormationSlot[];
  readonly children: readonly FormationNode[];
}

export interface FormationSlot {
  /** Unique within the formation (e.g. "FT1.AR"). */
  readonly id: string;
  readonly soldierId: SoldierId;
  readonly back: number;
  readonly right: number;
}

/** An order to an organization (the `orderUnit` command's payload). */
export interface UnitOrder {
  readonly kind: 'moveInFormation';
  /** Route points to pass through on the way, in order (the route bends there). */
  readonly via?: readonly Readonly<Vec2>[];
  readonly destination: Readonly<Vec2>;
  readonly formation: FormationSpec;
  /** Facing at the destination; default: the route's last heading. */
  readonly finalFacing?: Azimuth;
  /** Preferred speed (m/s); default: the world's movement speed. */
  readonly pace?: number;
}

/**
 * The organization's one route: the planned path with its corners rounded,
 * as parallel arrays by point (plain data). `cum` is the arc length at each
 * point; `tx, ty` the unit tangent there (interpolated between points, so
 * the route's normal turns continuously); `k` the signed curvature (1/m,
 * positive turning right, i.e. clockwise), 0 on straight pieces.
 */
export interface GroupRoute {
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly tx: readonly number[];
  readonly ty: readonly number[];
  readonly k: readonly number[];
  readonly cum: readonly number[];
  readonly length: number;
}

/**
 * - `forming`: the anchor waits at the start while Marines take their slots;
 * - `moving`: the anchor advances along the route at a pace that waits for
 *   the Marines;
 * - `settling`: the anchor has stopped at the destination; slots blend into
 *   the final layout and Marines stop in them;
 * - `complete`: every Marine is in position (or the task gave up waiting);
 * - `failed`: the task could not continue (no Marines left).
 */
export type TaskPhase = 'forming' | 'moving' | 'settling' | 'complete' | 'failed';

/**
 * `superseded`: replaced by a new order to the same unit in the same
 * formation, which carried on from where it was.
 */
export type TaskOutcome =
  'arrived' | 'arrivedIncomplete' | 'cancelled' | 'superseded' | 'noMembers';

export interface UnitTask {
  /** `${unitId}#${seq}`. */
  readonly id: string;
  readonly unitId: OrgUnitId;
  /** The order as given (never changed). */
  readonly order: UnitOrder;
  readonly route: GroupRoute;
  /** Facing of the final layout (the order's, or the route's last heading). */
  readonly finalFacing: Azimuth;
  /** Preferred speed (m/s). */
  readonly pace: number;
  /** One draw from the simulation's random numbers when the order applied (per-Marine variation). */
  readonly seed: number;
  phase: TaskPhase;
  /** When the current phase began (s). */
  phaseSince: number;
  /** The anchor: arc length along the route (m) and speed (m/s). */
  anchorS: number;
  anchorSpeed: number;
  readonly startedAt: number;
  endedAt: number | null;
  outcome: TaskOutcome | null;
}

/** A Marine driven by a task. Agents are kept in soldier order. */
export interface AgentState {
  readonly soldierId: SoldierId;
  readonly taskId: string;
  readonly slotId: string;
  /** Velocity (m/s), map axes. */
  vx: number;
  vy: number;
  /** In position at the destination and stopping (completion hysteresis). */
  latched: boolean;
  /**
   * A disturbance (the Behavior Lab's `disturbAgent`): held where he is, or
   * sent to a point, after which he rejoins his slot. `null`: none.
   */
  override: AgentOverride | null;
  /** Since when he has been out of contact (beyond `contactRadius`), or `null`. */
  farSince: number | null;
  /** Out of contact for `stragglerSeconds`: the pace law no longer waits for him. */
  straggling: boolean;
  /** Stuck detection: his error at the start of the current window, and when it began. */
  checkError: number;
  checkAt: number;
  /** Made less than `stuckProgress` m of progress toward his slot over a window. */
  stuck: boolean;
}

export type AgentOverride =
  { readonly kind: 'hold' } | { readonly kind: 'goTo'; readonly x: number; readonly y: number };

export interface BehaviorState {
  /** Tasks in order of issue. Ended tasks stay (for review) until no agent refers to them. */
  tasks: UnitTask[];
  /** One per controlled soldier, in soldier order. */
  agents: AgentState[];
  /** Sequence number of the next task. */
  nextTaskSeq: number;
}
