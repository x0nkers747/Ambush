import type { FormationSpec, UnitOrder } from '../behavior/types';
import type { Vec2 } from '../geometry';
import type { Side, SoldierId } from '../state';
import type { FofConfig, VisibilityClass } from './config';

// Force-on-force (docs/behavior-lab/force-on-force, docs/constructive-simulation):
// organizations (squads) of two sides that move on their own orders, look
// for each other, and fight when they meet. The setup is world data; the
// state is plain data in `SimState.fof`, absent in every simulation without
// a force-on-force setup (so their states hash as before).

/**
 * What a force does when it comes into contact (a confirmed contact within
 * the engagement range, or fire on it):
 *
 * - `attack`: halts to return fire and locate the enemy, then assaults the
 *   enemy's believed position by fire and movement (one element bounds
 *   forward while the rest cover it with fire, in turn); once contact is
 *   gone it returns to its original movement order;
 * - `withdraw`: disengages at once and moves back to where it started,
 *   firing on the move at what it can see;
 * - `continue`: halts to fight where it is, and resumes its movement order
 *   once contact is lost.
 */
/**
 * What a squad does on contact (docs/behavior-lab/force-on-force/07):
 * `continue` fights where it halts and presses on when it has nothing to
 * engage; `attack` assaults the enemy in an extended line; `hold` fights
 * where it halts and stays there until ordered on; `withdraw` avoids
 * contact: it falls back as soon as it sees the enemy and holds its fire
 * unless fired upon.
 */
export type ActionsOn = 'continue' | 'attack' | 'hold' | 'withdraw';

/**
 * A squad's tactical order (docs/constructive-simulation/02): the
 * commander's intent, carried out by the squad's own behaviour.
 *
 * - `move`: to the destination, in formation; on contact it halts and fights,
 *   then carries on;
 * - `attack`: toward the destination, assaulting the enemy it meets (fire and
 *   movement); done on the objective with no enemy within reach for a while;
 * - `withdraw`: to the destination, breaking contact: it does not halt to
 *   fight, firing on the move at what it can see.
 */
export type OrderKind = 'move' | 'attack' | 'withdraw';
export const ORDER_KINDS: readonly OrderKind[] = ['move', 'attack', 'withdraw'];

/**
 * An order's state: `pending` (waiting its turn), `active` (being carried
 * out), and how it ended: `completed`, `failed` (it could not be: see
 * `reason`), `superseded` (replaced by a new plan) or `canceled` (the plan
 * cleared).
 */
export type OrderStatus = 'pending' | 'active' | 'completed' | 'failed' | 'superseded' | 'canceled';

/** An order as given: its intent and where (the plan editor's and the command's form). */
export interface OrderSpec {
  readonly kind: OrderKind;
  /** Where to go (a map point). Every order kind has one now; future kinds may not. */
  readonly destination: Vec2 | null;
  /** What the squad does on contact while carrying it out (default: by the order's kind, `actionsOnFor`). */
  readonly actionsOn?: ActionsOn;
}

/** Who gave an order: the scenario's initial plan, or a player during the run. */
export type OrderSource = 'scenario' | 'player';

/** An order of a squad's plan, with its life (plain data in the state). */
export interface FofOrder {
  /** `${unitId}#${sequence}`. */
  readonly id: string;
  readonly unitId: string;
  /** The squad's orders in the order they were issued (from 1). */
  readonly sequence: number;
  readonly kind: OrderKind;
  /** What the squad does on contact while carrying it out. */
  readonly actionsOn: ActionsOn;
  readonly destination: Vec2 | null;
  readonly source: OrderSource;
  /** When it was issued (tick and seconds), started, and ended. */
  readonly issuedTick: number;
  readonly issuedAt: number;
  activatedAt: number | null;
  endedAt: number | null;
  status: OrderStatus;
  /** Why it ended (or failed), in words; `null` while pending or active. */
  reason: string | null;
}

/** One side's organization in the experiment. */
export interface FofForceSetup {
  /** The organization's root unit: every soldier in it or below it belongs to the force. */
  readonly unitId: string;
  readonly side: Side;
  /** The weapon each member fires (`FofConfig.fire.weapons`), by soldier id; `null`: unarmed. */
  readonly weapons: Readonly<Record<string, string | null>>;
  /** A second weapon some members carry (a grenade launcher, docs/behavior-lab/force-on-force/06 §4), by soldier id. */
  readonly secondaryWeapons?: Readonly<Record<string, string | null>>;
  /** The formation it withdraws in when it has no movement order to take one from. */
  readonly formation?: FormationSpec;
  /** The formation it assaults in (an extended line); default: its formation. */
  readonly assaultFormation?: FormationSpec;
  /** Pace of a withdrawal (m/s); default: the world's movement speed. */
  readonly pace?: number;
  /** What it does on contact; default `continue`. */
  readonly actionsOn?: ActionsOn;
  /** Where it starts (a `withdraw` force goes back there); default: its members' centre when the experiment begins. */
  readonly start?: Vec2;
  /** A name to show (default: the unit id). */
  readonly name?: string;
  /**
   * Its initial plan: orders carried out in turn. A force with a plan (or
   * given orders by `orderSquad`) is driven by it; without, by its movement
   * order and actions on contact (the lab's experiments).
   */
  readonly plan?: readonly OrderSpec[];
}

/**
 * How the experiment ends: `experiment` (the lab: two forces, adjudicated
 * to an outcome), or `manual` (the constructive simulation: any number of
 * squads; it runs until the player ends it).
 */
export type FofTermination = 'experiment' | 'manual';

export interface FofSetup {
  readonly config: FofConfig;
  /** The observation conditions of the experiment. */
  readonly visibility: VisibilityClass;
  /** The forces (squads) of both sides: exactly two, opposed, under `experiment` termination. */
  readonly forces: readonly FofForceSetup[];
  /** Default `experiment`. */
  readonly termination?: FofTermination;
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
 * - `assaulting`: attacking the enemy's believed position by fire and movement;
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
  | 'assaulting'
  | 'withdrawing'
  | 'atObjective'
  | 'withdrawn'
  | 'ineffective';

export interface FofForceStats {
  /** Observer–target pairs looked at (in range and field of regard). */
  detectionAttempts: number;
  /**
   * Of those, the ones that could detect (the best case, all of the target
   * in view, above the pair's threshold): only these are traced.
   */
  tracedAttempts: number;
  /** Of those, with a clear sight line to some part of the target. */
  visibleAttempts: number;
  /**
   * Looks not taken because they could change nothing: the target already
   * seen in the same decision, at full confidence, and identified.
   */
  redundantLooks: number;
  /** Successful glimpses. */
  glimpses: number;
  bursts: number;
  rounds: number;
  /** Bursts that hit. */
  hits: number;
  /** Enemies this force incapacitated. */
  casualtiesInflicted: number;
  /** Grenades fired, and reloads done. */
  grenades: number;
  reloads: number;
}

export interface FofForce {
  readonly unitId: string;
  readonly side: Side;
  /** A name to show. */
  readonly name: string;
  phase: ForcePhase;
  phaseSince: number;
  /** What it does on contact: its setup's, or, driven by a plan, its active order's. */
  actionsOn: ActionsOn;
  /**
   * Driven by a plan (`orders`): its movement and actions on contact come
   * from its active order. Set from the setup's plan, or by the first
   * `orderSquad` command.
   */
  planned: boolean;
  /** Every order it has been given, in the order given (the plan and its history). */
  orders: FofOrder[];
  /** The order being carried out, or `null`. */
  activeOrderId: string | null;
  /** The next order's sequence number. */
  nextOrderSequence: number;
  /** Attacking, on the objective: since when no enemy has been within reach (`null`: one is). */
  objectiveQuietSince: number | null;
  /** Broke contact on its own, spent: its next order waits until it has recovered. */
  holdUntilRecovered: boolean;
  /** Its centre at the start (where a `withdraw` force goes back to). */
  readonly start: Vec2;
  /** Attacking: when it assaults (after returning fire and locating the enemy), or `null`. */
  assaultAt: number | null;
  /** Assaulting: the position it is assaulting (where it believes the enemy is) and when it was set. */
  objective: Vec2 | null;
  objectiveAt: number;
  /** Assaulting: the soldiers of the element bounding now (empty: all down, firing). */
  bounding: readonly SoldierId[];
  /** Assaulting: the unit of the element bounding now (for display), or `null`. */
  boundUnit: string | null;
  /** Assaulting: the element to bound next (index into the force's elements). */
  boundElement: number;
  /** Assaulting: when the current bound began, or the last one ended. */
  boundSince: number;
  /** Members in soldier order. */
  readonly memberIds: readonly SoldierId[];
  readonly leaderIds: readonly SoldierId[];
  readonly initialRounds: number;
  /** Effectiveness and mean suppression of the active members, as of the last decision. */
  effectiveness: number;
  meanSuppression: number;
  /** Effectiveness without suppression (strength × ammunition × leadership): what lasts. */
  lastingEffectiveness: number;
  /** The movement order it was on when contact interrupted it (resumed after contact). */
  mission: UnitOrder | null;
  /** Where it believes the threat is (centroid of its current tracks), or `null`. */
  threat: Vec2 | null;
  /** Last time it had a confirmed, current contact; its own last burst; last fire at it. */
  lastContactAt: number | null;
  /** When it last halted in contact (`null`: never). */
  contactAt: number | null;
  /** When one of its soldiers last fired at an enemy he could see (an aimed burst). */
  lastAimedFireAt: number | null;
  /** Pressing on through contact (actions on contact `continue`) until then: it does not halt for contact. */
  pressOnUntil: number | null;
  lastFireAt: number | null;
  lastFiredUponAt: number | null;
  /** Since when its mean suppression has stayed above `withdrawSuppression`. */
  suppressedSince: number | null;
  /** A withdrawal found no way: when to try again (`null`: at once). */
  withdrawRetryAt: number | null;
  /** Times it entered contact (a regained contact after holding counts again). */
  contactCycles: number;
  /** Hostile intent established: it has identified an enemy or been fired on (rules of engagement). */
  hostile: boolean;
  /** Possible contacts first seen before this have been observed (no new halt for them). */
  observedUntil: number;
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
  /** Grenades fired, and reloads done. */
  grenades: number;
  reloads: number;
  /** Bursts aimed at him, and hits on him. */
  timesTargeted: number;
  timesHit: number;
  /** Seconds spent suppressed or pinned. */
  suppressedSeconds: number;
}

/**
 * A weapon a soldier carries and its ammunition (docs/behavior-lab/force-on-force/06):
 * always `loaded + reserve + fired` = its basic load, `loaded` at most its capacity.
 */
export interface FofWeaponState {
  /** The weapon (`FofConfig.fire.weapons`). */
  readonly id: string;
  /** Rounds in the magazine, belt or launcher. */
  loaded: number;
  /** Rounds carried besides. */
  reserve: number;
  /** Rounds fired so far. */
  fired: number;
  /** It may not fire again before this (s): a launcher's least interval. */
  readyAt: number;
  /** It has run out (reported once). */
  exhausted: boolean;
}

export interface FofSoldier {
  readonly soldierId: SoldierId;
  readonly force: number;
  /** His primary weapon's id, or `null` when unarmed (`arms[0]`). */
  readonly weapon: string | null;
  /** A leader of his force or of one of its units. */
  readonly leader: boolean;
  /** His weapons: the primary, then a secondary (a grenade launcher) if any. */
  arms: FofWeaponState[];
  /** The arm he is reloading (index), or -1; and when he is done (`null`: not reloading). */
  reloading: number;
  reloadUntil: number | null;
  /** When his posture in contact (the lowest he can see the enemy from) is next chosen. */
  postureAt: number;
  /** His next burst, or `null` when he does not fire. */
  nextFireAt: number | null;
  /** When he takes up his contact posture (after his reaction delay), or `null`. */
  reactAt: number | null;
  /** Has taken up the posture of his force's halt. */
  reacted: boolean;
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
  /** Lasting effectiveness of each force. */
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
