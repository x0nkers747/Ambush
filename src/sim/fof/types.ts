import type { FormationSpec, UnitOrder } from '../behavior/types';
import type { Vec2 } from '../geometry';
import type { Side, SoldierId } from '../state';
import type { FofConfig, VisibilityClass } from './config';

// Force-on-force (docs/behavior-lab/force-on-force): two organizations that
// move on their own orders, look for each other, and fight when they meet.
// The setup is world data; the state is plain data in `SimState.fof`,
// absent in every simulation without a force-on-force setup (so their
// states hash as before).

/** One side's organization in the experiment. */
export interface FofForceSetup {
  /** The organization's root unit: every soldier in it or below it belongs to the force. */
  readonly unitId: string;
  readonly side: Side;
  /** The weapon category each member fires (`FofConfig.fire.weapons`), by soldier id; `null`: unarmed. */
  readonly weapons: Readonly<Record<string, string | null>>;
  /** The formation it withdraws in when it has no movement order to take one from. */
  readonly formation?: FormationSpec;
  /** Pace of a withdrawal (m/s); default: the world's movement speed. */
  readonly pace?: number;
}

export interface FofSetup {
  readonly config: FofConfig;
  /** The observation conditions of the experiment. */
  readonly visibility: VisibilityClass;
  /** Exactly two forces, of opposite sides. */
  readonly forces: readonly FofForceSetup[];
}

/** What a force knows about one enemy soldier. */
export type TrackLevel = 'possible' | 'detected' | 'identified' | 'lost';
export type ObservationLevel = 'unaware' | TrackLevel;

/** A force's track on one enemy soldier: its own picture, not the truth. */
export interface FofTrack {
  /** Index of the observing force. */
  readonly force: number;
  readonly targetId: SoldierId;
  /** Confidence when last seen (it halves every `confidenceHalfLifeSeconds` since). */
  confidence: number;
  lastSeenAt: number;
  /** Reached `confirmConfidence` once (stays: it can be lost, not unconfirmed). */
  confirmed: boolean;
  /** Identified as an enemy (stays). */
  identified: boolean;
  level: TrackLevel;
  /** Where the force last saw him (not where he is). */
  lastKnown: Vec2;
  readonly firstAt: number;
  /** The soldier who last saw him; `null` when the cue was being fired on. */
  seenBy: SoldierId | null;
}

/**
 * A force's state in the engagement:
 *
 * - `moving`: on its movement order (or standing, without one);
 * - `possibleContact`: halted, observing a possible contact;
 * - `contact`: a confirmed contact, or under fire: halted in a defensive posture;
 * - `engaged`: exchanging fire;
 * - `holding`: contact lost; holding before resuming its mission;
 * - `withdrawing`: breaking contact, moving away from the threat;
 * - `atObjective`: arrived, observing (reacts to contact as before);
 * - `withdrawn`, `ineffective`: terminal.
 */
export type ForcePhase =
  | 'moving'
  | 'possibleContact'
  | 'contact'
  | 'engaged'
  | 'holding'
  | 'withdrawing'
  | 'atObjective'
  | 'withdrawn'
  | 'ineffective';

export interface FofForceStats {
  /** Observer–target pairs looked at (in range and field of regard). */
  detectionAttempts: number;
  /** Of those, with a clear sight line to some part of the target. */
  visibleAttempts: number;
  /** Successful glimpses. */
  glimpses: number;
  bursts: number;
  rounds: number;
  /** Bursts that hit. */
  hits: number;
  /** Enemies this force incapacitated. */
  casualtiesInflicted: number;
}

export interface FofForce {
  readonly unitId: string;
  readonly side: Side;
  phase: ForcePhase;
  phaseSince: number;
  /** Members in soldier order. */
  readonly memberIds: readonly SoldierId[];
  readonly leaderIds: readonly SoldierId[];
  readonly initialRounds: number;
  /** Effectiveness and mean suppression of the active members, as of the last decision. */
  effectiveness: number;
  meanSuppression: number;
  /** The movement order it was on when contact interrupted it (resumed after contact). */
  mission: UnitOrder | null;
  /** Where it believes the threat is (centroid of its current tracks), or `null`. */
  threat: Vec2 | null;
  /** Last time it had a confirmed, current contact; its own last burst; last fire at it. */
  lastContactAt: number | null;
  lastFireAt: number | null;
  lastFiredUponAt: number | null;
  /** Since when its mean suppression has stayed above `withdrawSuppression`. */
  suppressedSince: number | null;
  /** Times it entered contact (a regained contact after holding counts again). */
  contactCycles: number;
  /** Times of the first possible, confirmed and identified contact, first burst, and when it became terminal. */
  firstPossibleAt: number | null;
  firstDetectedAt: number | null;
  firstIdentifiedAt: number | null;
  firstFireAt: number | null;
  stats: FofForceStats;
}

export type SuppressionLevel = 'none' | 'suppressed' | 'pinned';

export interface FofSoldierStats {
  bursts: number;
  rounds: number;
  hits: number;
  /** Bursts aimed at him, and hits on him. */
  timesTargeted: number;
  timesHit: number;
  /** Seconds spent suppressed or pinned. */
  suppressedSeconds: number;
}

export interface FofSoldier {
  readonly soldierId: SoldierId;
  readonly force: number;
  readonly weapon: string | null;
  /** A leader of his force or of one of its units. */
  readonly leader: boolean;
  /** Rounds left (never negative). */
  rounds: number;
  /** His next burst, or `null` when he does not fire. */
  nextFireAt: number | null;
  /** When he takes up his contact posture (after his reaction delay), or `null`. */
  reactAt: number | null;
  suppression: number;
  level: SuppressionLevel;
  /** His last burst (`null`: none yet), for the firing signature. */
  lastFiredAt: number | null;
  /** Where he stood at the previous decision, and his ground speed since. */
  lastX: number;
  lastY: number;
  speed: number;
  stats: FofSoldierStats;
}

export type FofOutcomeKind =
  | 'blueforVictory'
  | 'opforVictory'
  | 'blueforWithdrawal'
  | 'opforWithdrawal'
  | 'mutualIneffective'
  | 'mutualDisengagement'
  | 'stalemate'
  | 'timeLimit'
  | 'noContact'
  | 'invalid';

/**
 * How an experiment ended. `decisive`: reached by the forces' states;
 * `adjudicated`: a stalemate or the time limit, decided by the stated rule
 * (no hits or casualties invented); `invalid`: an invariant failed.
 */
export interface FofOutcome {
  readonly outcome: FofOutcomeKind;
  readonly basis: 'decisive' | 'adjudicated' | 'invalid';
  /** The rule that ended it, in words. */
  readonly reason: string;
  readonly tick: number;
  readonly atSeconds: number;
  /** Adjudicated: the side whose effectiveness is ahead by `advantageMargin`, if any. */
  readonly advantage: Side | null;
  readonly casualties: Readonly<Record<Side, number>>;
  readonly effectiveness: Readonly<Record<Side, number>>;
}

/** The stalemate window: what each force was at its start. */
export interface FofWindow {
  startAt: number;
  effectiveness: number[];
  casualties: number;
  hits: number;
  contactCycles: number;
}

export interface FofState {
  /** The next decision to take (decisions are at `n / decisionHz` seconds). */
  nextDecision: number;
  forces: FofForce[];
  /** Every member of every force, in soldier order. */
  soldiers: FofSoldier[];
  /** Tracks in order of creation. */
  tracks: FofTrack[];
  /**
   * Each observer–target pair's detectability threshold, drawn once at the
   * start (`soldiers.length`² numbers, observer-major): the target is
   * detectable to the observer while the asymptotic probability P∞ exceeds it.
   */
  thresholds: number[];
  stalemate: FofWindow | null;
  outcome: FofOutcome | null;
}
