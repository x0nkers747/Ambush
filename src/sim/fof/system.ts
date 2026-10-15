import type { SimEvent } from '../events';
import { nextFloat } from '../rng';
import type { TickTime } from '../movement';
import type { SimState, Soldier, SoldierId } from '../state';
import type { SimWorld } from '../world';
import { fofWeapon } from './config';
import { chanceIn, confidenceAt, cyclesOnTarget, draw, levelAt, sight, ttpf } from './detection';
import { resolveFire, updateSuppression } from './fire';
import { updateEffectiveness, updateForces } from './force';
import { adjudicate, updateLifecycle } from './lifecycle';
import { forceMembers } from './setup';
import type { FofForce, FofSetup, FofSoldier, FofState, FofTrack, ObservationLevel } from './types';

// The force-on-force system (docs/behavior-lab/force-on-force/03): runs after
// movement and combat in each tick, and takes its decisions on a fixed grid of
// simulation times, `n / decisionHz` seconds, each at the end of the tick that
// reaches it, against the positions soldiers have then. At tick rates whose
// ticks end on every grid time (multiples of `decisionHz` that divide the
// behavior engine's 120 Hz substeps: 10, 30, 60, 120 Hz with the default 10)
// the decisions, and so the whole run, are bit-identical across rates.
//
// A decision, in order: soldiers' motion and suppression recovery; the
// observers due look (detection draws); tracks age and change level; forces
// take their decisions (contact behavior, fire, withdrawal); the experiment is
// adjudicated. Every random number comes from `SimState.rng`, in that order.

/** Everything one decision works with. */
export interface FofContext {
  readonly state: SimState;
  readonly world: SimWorld;
  readonly setup: FofSetup;
  readonly fof: FofState;
  readonly tick: number;
  readonly events: SimEvent[];
  /** The decision's time (s) and its number. */
  readonly t: number;
  readonly n: number;
  /** Seconds since the previous decision. */
  readonly dt: number;
  /** Soldier and force-member indices by soldier id. */
  readonly soldierIndex: ReadonlyMap<string, number>;
  readonly memberIndex: ReadonlyMap<string, number>;
}

export function updateForceOnForce(
  state: SimState,
  world: SimWorld,
  time: TickTime,
  events: SimEvent[],
): void {
  const setup = world.fof;
  if (!setup) return;
  const hz = setup.config.decisionHz;
  const fof = (state.fof ??= createFofState(state, setup));
  if (fof.outcome) return;
  const tickRateHz = Math.round(1 / time.dtSeconds);
  const lookup = indices(state, fof);
  // Every decision time n / hz up to the end of this tick (exact integer comparison).
  while (!ended(fof) && fof.nextDecision * tickRateHz <= (time.tick + 1) * hz) {
    const n = fof.nextDecision;
    decide({
      state,
      world,
      setup,
      fof,
      tick: time.tick,
      events,
      t: n / hz,
      n,
      dt: 1 / hz,
      ...lookup,
    });
    fof.nextDecision += 1;
  }
}

/** Whether the experiment has ended (an outcome is set by the decisions). */
function ended(fof: FofState): boolean {
  return fof.outcome !== null;
}

function createFofState(state: SimState, setup: FofSetup): FofState {
  const members = setup.forces.map(
    (f) => new Set(forceMembers(f.unitId, state.units, state.soldiers)),
  );
  const forces: FofForce[] = setup.forces.map((f, i) => {
    const ids = state.soldiers.filter((s) => members[i]?.has(s.id)).map((s) => s.id);
    const inForce = new Set(ids.map((id) => state.soldiers.find((s) => s.id === id)?.unitId));
    const leaderIds = state.units.flatMap((u) =>
      inForce.has(u.id) && u.leaderId !== null ? [u.leaderId] : [],
    );
    const initialRounds = ids.reduce((sum, id) => {
      const w = f.weapons[id];
      return sum + (w ? (fofWeapon(setup.config, w)?.basicLoadRounds ?? 0) : 0);
    }, 0);
    return {
      unitId: f.unitId,
      side: f.side,
      phase: 'moving',
      phaseSince: 0,
      memberIds: ids,
      leaderIds: [...new Set(leaderIds)],
      initialRounds,
      effectiveness: 1,
      meanSuppression: 0,
      lastingEffectiveness: 1,
      mission: null,
      threat: null,
      lastContactAt: null,
      lastFireAt: null,
      lastFiredUponAt: null,
      suppressedSince: null,
      withdrawRetryAt: null,
      contactCycles: 0,
      hostile: false,
      observedUntil: 0,
      firstPossibleAt: null,
      firstDetectedAt: null,
      firstIdentifiedAt: null,
      firstFireAt: null,
      stats: {
        detectionAttempts: 0,
        visibleAttempts: 0,
        glimpses: 0,
        bursts: 0,
        rounds: 0,
        hits: 0,
        casualtiesInflicted: 0,
      },
    };
  });
  const soldiers: FofSoldier[] = [];
  for (const s of state.soldiers) {
    const force = members.findIndex((m) => m.has(s.id));
    if (force < 0) continue;
    const weapon = setup.forces[force]?.weapons[s.id] ?? null;
    soldiers.push({
      soldierId: s.id,
      force,
      weapon,
      leader: forces[force]?.leaderIds.includes(s.id) ?? false,
      rounds: weapon ? (fofWeapon(setup.config, weapon)?.basicLoadRounds ?? 0) : 0,
      nextFireAt: null,
      reactAt: null,
      reacted: false,
      suppression: 0,
      level: 'none',
      lastFiredAt: null,
      lastX: s.position.x,
      lastY: s.position.y,
      speed: 0,
      stats: {
        bursts: 0,
        rounds: 0,
        hits: 0,
        timesTargeted: 0,
        timesHit: 0,
        suppressedSeconds: 0,
      },
    });
  }
  // One threshold per observer–target pair, in a fixed order, from the simulation's random numbers.
  const thresholds: number[] = [];
  for (const observer of soldiers) {
    for (const target of soldiers) {
      thresholds.push(observer.force === target.force ? 1 : nextFloat(state.rng));
    }
  }
  return {
    nextDecision: 0,
    forces,
    soldiers,
    tracks: [],
    thresholds,
    stalemate: null,
    outcome: null,
  };
}

const indexCache = new WeakMap<
  readonly Soldier[],
  { soldierIndex: Map<string, number>; memberIndex: Map<string, number>; members: unknown }
>();

function indices(state: SimState, fof: FofState) {
  let known = indexCache.get(state.soldiers);
  if (known?.members !== fof.soldiers) {
    known = {
      soldierIndex: new Map(state.soldiers.map((s, i) => [s.id as string, i])),
      memberIndex: new Map(fof.soldiers.map((s, i) => [s.soldierId as string, i])),
      members: fof.soldiers,
    };
    indexCache.set(state.soldiers, known);
  }
  return { soldierIndex: known.soldierIndex, memberIndex: known.memberIndex };
}

/** The soldier of a force member. */
export function soldierOf(context: FofContext, member: FofSoldier): Soldier {
  const soldier = context.state.soldiers[context.soldierIndex.get(member.soldierId) ?? -1];
  if (!soldier) throw new Error(`force-on-force member ${member.soldierId} has no soldier`);
  return soldier;
}

function decide(context: FofContext): void {
  updateMotion(context);
  updateSuppression(context);
  scan(context);
  updateTracks(context);
  updateForces(context);
  resolveFire(context);
  updateEffectiveness(context);
  updateLifecycle(context);
  adjudicate(context);
}

/** Each member's ground speed since the previous decision. */
function updateMotion(context: FofContext): void {
  for (const member of context.fof.soldiers) {
    const soldier = soldierOf(context, member);
    const d = Math.hypot(soldier.position.x - member.lastX, soldier.position.y - member.lastY);
    member.speed = context.n === 0 ? 0 : d / context.dt;
    member.lastX = soldier.position.x;
    member.lastY = soldier.position.y;
  }
}

/** Whether a force still looks and acts (not terminal). */
export function forceActive(force: FofForce): boolean {
  return force.phase !== 'withdrawn' && force.phase !== 'ineffective';
}

/** Whether a force is alert (searching, not merely moving). */
function alerted(force: FofForce): boolean {
  return force.phase !== 'moving' && force.phase !== 'atObjective';
}

/** Tracks by force and target. */
export function trackKey(force: number, targetId: string): string {
  return `${String(force)}:${targetId}`;
}

/** The observers due look at every enemy in their field of regard. */
function scan(context: FofContext): void {
  const { fof, setup, state, world, t, n } = context;
  const detection = setup.config.detection;
  const conditions = setup.config.visibility[setup.visibility];
  const every = Math.max(1, Math.round(detection.scanIntervalSeconds * setup.config.decisionHz));
  const lookSeconds = every / setup.config.decisionHz;
  const tracks = new Map(fof.tracks.map((tr) => [trackKey(tr.force, tr.targetId), tr]));
  fof.soldiers.forEach((member, i) => {
    if ((n + i) % every !== 0) return;
    const observer = soldierOf(context, member);
    const force = fof.forces[member.force];
    if (observer.status !== 'active' || !force || !forceActive(force)) return;
    const search = alerted(force) ? detection.alertedSearchFactor : detection.unalertedSearchFactor;
    fof.soldiers.forEach((enemy, j) => {
      if (enemy.force === member.force) return;
      const threshold = fof.thresholds[i * fof.soldiers.length + j] ?? 1;
      const target = soldierOf(context, enemy);
      if (target.status !== 'active') return;
      const seen = sight(world.terrain, observer, target, detection, conditions);
      if (!seen) return;
      force.stats.detectionAttempts += 1;
      if (seen.visibleFraction <= 0 || seen.transmission <= 0) return;
      force.stats.visibleAttempts += 1;
      const cue =
        (enemy.speed > detection.movingSpeedMps ? detection.movingTargetFactor : 1) *
        (enemy.lastFiredAt !== null && t - enemy.lastFiredAt <= detection.firingSignatureSeconds
          ? detection.firingSignatureFactor
          : 1);
      const cycles = cyclesOnTarget(
        seen,
        detection.criticalDimensionM[target.posture],
        detection,
        conditions,
        cue,
      );
      // Detectable to this observer only while P∞ exceeds the pair's threshold;
      // then found at rate P∞ / searchSeconds (the time law's asymptote is P∞).
      const pInf = ttpf(cycles, detection.detectionCycles50);
      if (pInf <= threshold) return;
      const key = trackKey(member.force, target.id);
      const track = tracks.get(key);
      const tracking = track?.confirmed === true ? detection.trackingFactor : 1;
      const rate = (pInf / detection.searchSeconds) * search * seen.attention * tracking;
      if (!draw(state.rng, chanceIn(rate, lookSeconds))) return;
      force.stats.glimpses += 1;
      const from: ObservationLevel = track?.level ?? 'unaware';
      const glimpsed = glimpse(
        context,
        member.force,
        target,
        track,
        detection.confidenceGain,
        observer.id,
      );
      tracks.set(key, glimpsed);
      // Identification: a further draw once the contact is confirmed.
      if (glimpsed.confirmed && !glimpsed.identified) {
        const pId = ttpf(cycles, detection.identificationCycles50);
        const idRate =
          pId <= threshold ? 0 : (pId / detection.searchSeconds) * search * seen.attention;
        if (draw(state.rng, chanceIn(idRate, lookSeconds))) glimpsed.identified = true;
      }
      glimpsed.lastKnown = { x: target.position.x, y: target.position.y };
      setLevel(context, glimpsed, from, observer.id, seen.rangeM);
    });
  });
}

/**
 * Adds `gain` to a force's confidence in a track on `target` (creating it),
 * seen now at his position. Returns the track (its level is set by `setLevel`).
 */
export function glimpse(
  context: FofContext,
  force: number,
  target: Soldier,
  existing: FofTrack | undefined,
  gain: number,
  by: SoldierId | null,
): FofTrack {
  const { fof, setup, t } = context;
  const detection = setup.config.detection;
  const track =
    existing ??
    fof.tracks.find((tr) => tr.force === force && tr.targetId === target.id) ??
    (() => {
      const created: FofTrack = {
        force,
        targetId: target.id,
        confidence: 0,
        lastSeenAt: t,
        confirmed: false,
        identified: false,
        level: 'possible',
        lastKnown: { x: target.position.x, y: target.position.y },
        firstAt: t,
        seenBy: by,
      };
      fof.tracks.push(created);
      return created;
    })();
  const now = fof.tracks.includes(track)
    ? confidenceAt(track, t, detection.confidenceHalfLifeSeconds)
    : 0;
  track.confidence = Math.min(1, now + gain);
  track.lastSeenAt = t;
  track.lastKnown = { x: target.position.x, y: target.position.y };
  track.seenBy = by;
  if (track.confidence >= detection.confirmConfidence - 1e-12) track.confirmed = true;
  return track;
}

/**
 * Sets a track's level from its confidence now, reporting a change from
 * `from` (`unaware` for a new track). Returns `false` when the track is gone.
 */
export function setLevel(
  context: FofContext,
  track: FofTrack,
  from: ObservationLevel,
  observerId: SoldierId | null,
  rangeM: number | null,
): boolean {
  const { fof, setup, t, events, tick } = context;
  const detection = setup.config.detection;
  const { level, confirmed } = levelAt(track, t, detection);
  track.confirmed = confirmed;
  const to: ObservationLevel = level ?? 'unaware';
  if (level) track.level = level;
  else fof.tracks.splice(fof.tracks.indexOf(track), 1);
  if (from !== to) {
    const force = fof.forces[track.force];
    if (force) {
      if (to === 'possible' || to === 'detected' || to === 'identified')
        force.firstPossibleAt ??= t;
      if (to === 'detected' || to === 'identified') force.firstDetectedAt ??= t;
      if (to === 'identified') force.firstIdentifiedAt ??= t;
      events.push({
        type: 'contactObserved',
        tick,
        atSeconds: t,
        unitId: force.unitId,
        side: force.side,
        targetId: track.targetId,
        from,
        to,
        observerId,
        rangeM,
        confidence: confidenceAt(track, t, detection.confidenceHalfLifeSeconds),
      });
    }
  }
  return level !== null;
}

/**
 * Tracks age: each takes the level its confidence gives now. Tracks on
 * soldiers who are down are closed (the force saw him fall or stops looking for him).
 */
function updateTracks(context: FofContext): void {
  const { fof } = context;
  for (const track of [...fof.tracks]) {
    const target = context.state.soldiers[context.soldierIndex.get(track.targetId) ?? -1];
    if (target?.status !== 'active') {
      fof.tracks.splice(fof.tracks.indexOf(track), 1);
      const force = fof.forces[track.force];
      if (force) {
        context.events.push({
          type: 'contactObserved',
          tick: context.tick,
          atSeconds: context.t,
          unitId: force.unitId,
          side: force.side,
          targetId: track.targetId,
          from: track.level,
          to: 'unaware',
          observerId: null,
          rangeM: null,
          confidence: 0,
        });
      }
      continue;
    }
    setLevel(context, track, track.level, null, null);
  }
}
