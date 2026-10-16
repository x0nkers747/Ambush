import type { SimEvent } from '../events';
import { azimuthDelta, azimuthOf } from '../geometry';
import { nextFloat } from '../rng';
import type { TickTime } from '../movement';
import type { SimState, Soldier, SoldierId } from '../state';
import type { SimWorld } from '../world';
import { fofWeapon } from './config';
import { chanceIn, confidenceAt, cyclesOnTarget, draw, levelAt, ttpf } from './detection';
import { resolveFire, updateSuppression } from './fire';
import { armed, updateReloads } from './weapons';
import { actionsOnFor } from './orders';
import { updateEffectiveness, updateForces } from './force';
import { adjudicate, updateLifecycle } from './lifecycle';
import { forceMembers } from './setup';
import { cyclesNeeded, deferLook, scheduleFor, travelled } from './look-schedule';
import { sightBetween } from './sight-cache';
import type {
  FofForce,
  FofOrder,
  FofSetup,
  FofSoldier,
  FofState,
  FofTrack,
  ObservationLevel,
} from './types';

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

const ARCMIN_RAD = Math.PI / (180 * 60);

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
  const fof = fofStateOf(state, setup);
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

/** The force-on-force state of a simulation (made at its first use: a decision, or an order). */
export function fofStateOf(state: SimState, setup: FofSetup): FofState {
  return (state.fof ??= createFofState(state, setup));
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
    let sx = 0;
    let sy = 0;
    for (const id of ids) {
      const s = state.soldiers.find((x) => x.id === id);
      sx += s?.position.x ?? 0;
      sy += s?.position.y ?? 0;
    }
    const start =
      f.start ?? (ids.length > 0 ? { x: sx / ids.length, y: sy / ids.length } : { x: 0, y: 0 });
    const initialRounds = ids.reduce((sum, id) => {
      const w = f.weapons[id];
      return sum + (w ? (fofWeapon(setup.config, w)?.basicLoadRounds ?? 0) : 0);
    }, 0);
    // The initial plan: the scenario's orders, pending, in turn.
    const orders: FofOrder[] = (f.plan ?? []).map((spec, k) => ({
      id: `${f.unitId}#${String(k + 1)}`,
      unitId: f.unitId,
      sequence: k + 1,
      kind: spec.kind,
      actionsOn: spec.actionsOn ?? actionsOnFor(spec.kind),
      destination: spec.destination ? { x: spec.destination.x, y: spec.destination.y } : null,
      killZone: spec.killZone ?? null,
      source: 'scenario',
      issuedTick: 0,
      issuedAt: 0,
      activatedAt: null,
      endedAt: null,
      status: 'pending',
      reason: null,
    }));
    return {
      unitId: f.unitId,
      side: f.side,
      name: f.name ?? f.unitId,
      phase: 'moving',
      phaseSince: 0,
      actionsOn: f.actionsOn ?? 'continue',
      planned: f.plan !== undefined,
      orders,
      activeOrderId: null,
      nextOrderSequence: orders.length + 1,
      objectiveQuietSince: null,
      holdUntilRecovered: false,
      start,
      assaultAt: null,
      objective: null,
      objectiveAt: 0,
      bounding: [],
      boundUnit: null,
      boundElement: 0,
      boundSince: 0,
      memberIds: ids,
      leaderIds: [...new Set(leaderIds)],
      initialRounds,
      effectiveness: 1,
      meanSuppression: 0,
      lastingEffectiveness: 1,
      mission: null,
      threat: null,
      lastContactAt: null,
      contactAt: null,
      lastAimedFireAt: null,
      pressOnUntil: null,
      killZoneInside: [],
      ambushSprungAt: null,
      surprisedUntil: null,
      concealed: false,
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
        tracedAttempts: 0,
        redundantLooks: 0,
        visibleAttempts: 0,
        glimpses: 0,
        bursts: 0,
        rounds: 0,
        hits: 0,
        casualtiesInflicted: 0,
        grenades: 0,
        reloads: 0,
      },
    };
  });
  const soldiers: FofSoldier[] = [];
  for (const s of state.soldiers) {
    const force = members.findIndex((m) => m.has(s.id));
    if (force < 0) continue;
    const weapon = setup.forces[force]?.weapons[s.id] ?? null;
    const second = weapon === null ? null : (setup.forces[force]?.secondaryWeapons?.[s.id] ?? null);
    const arms = [weapon, second].flatMap((id) => {
      const arm = id === null ? null : armed(setup.config, id);
      return arm ? [arm] : [];
    });
    soldiers.push({
      soldierId: s.id,
      force,
      weapon,
      leader: forces[force]?.leaderIds.includes(s.id) ?? false,
      arms,
      reloading: -1,
      reloadUntil: null,
      postureAt: 0,
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
        grenades: 0,
        reloads: 0,
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
      // Only enemies are detected: a friendly pair (same side) is never drawn.
      const friendly = forces[observer.force]?.side === forces[target.force]?.side;
      thresholds.push(friendly ? 1 : nextFloat(state.rng));
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

/** Whether two members are enemies: of forces of different sides. */
export function hostile(fof: FofState, a: FofSoldier, b: FofSoldier): boolean {
  return fof.forces[a.force]?.side !== fof.forces[b.force]?.side;
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
  updateReloads(context);
  resolveFire(context);
  updateEffectiveness(context);
  updateLifecycle(context);
  adjudicate(context);
}

/** Each member's ground speed since the previous decision. */
function updateMotion(context: FofContext): void {
  context.fof.soldiers.forEach((member, i) => {
    const soldier = soldierOf(context, member);
    const d = Math.hypot(soldier.position.x - member.lastX, soldier.position.y - member.lastY);
    member.speed = context.n === 0 ? 0 : d / context.dt;
    travelled(context, i, d);
    member.lastX = soldier.position.x;
    member.lastY = soldier.position.y;
  });
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
  const { fof, setup, state, t, n: decision } = context;
  const detection = setup.config.detection;
  const conditions = setup.config.visibility[setup.visibility];
  const every = Math.max(1, Math.round(detection.scanIntervalSeconds * setup.config.decisionHz));
  const lookSeconds = every / setup.config.decisionHz;
  const n = fof.soldiers.length;
  // This decision's soldiers, their cues and the tracks by observing force and target member.
  const soldiers: Soldier[] = fof.soldiers.map((m) => soldierOf(context, m));
  const cues = new Float64Array(n);
  const firing = new Uint8Array(n);
  fof.soldiers.forEach((enemy, j) => {
    firing[j] =
      enemy.lastFiredAt !== null && t - enemy.lastFiredAt <= detection.firingSignatureSeconds
        ? 1
        : 0;
    cues[j] =
      (enemy.speed > detection.movingSpeedMps ? detection.movingTargetFactor : 1) *
      (firing[j] === 1 ? detection.firingSignatureFactor : 1);
  });
  const tracks: (FofTrack | undefined)[][] = fof.forces.map(
    () => new Array<FofTrack | undefined>(n),
  );
  for (const tr of fof.tracks) {
    const j = context.memberIndex.get(tr.targetId);
    const row = tracks[tr.force];
    if (j !== undefined && row) row[j] = tr;
  }
  const enemies = enemiesOf(fof);
  const schedule = scheduleFor(fof);
  const odometer = schedule.odometer;
  const budget = schedule.budget;
  const sumAt = schedule.sumAt;
  const firedAt = schedule.firedAt;
  const thresholds = fof.thresholds;
  const maxRange = conditions.maxObservationRangeM;
  // Forces lying in wait in ambush: their soldiers cannot be detected beyond the concealment range.
  const concealedFrom = setup.config.force.concealmentRangeM;
  const concealed = fof.forces.map((f) => f.concealed);
  const camouflage = setup.config.force.concealedDetectionFactor;
  const regard = detection.regardHalfAngleDeg;
  const central = detection.centralHalfAngleDeg;
  const n50 = detection.detectionCycles50;
  // One sighting, reused: the cycles of a look are computed from it.
  const sighting = { rangeM: 0, visibleFraction: 1, transmission: 1, attention: 1 };
  for (let i = 0; i < n; i += 1) {
    if ((decision + i) % every !== 0) continue;
    const member = fof.soldiers[i];
    const observer = soldiers[i];
    if (!member || !observer) continue;
    const force = fof.forces[member.force];
    if (observer.status !== 'active' || !force || !forceActive(force)) continue;
    const search = alerted(force) ? detection.alertedSearchFactor : detection.unalertedSearchFactor;
    const row = tracks[member.force] ?? [];
    const others = enemies[member.force] ?? [];
    const ox = observer.position.x;
    const oy = observer.position.y;
    const odoI = odometer[i] ?? 0;
    for (const j of others) {
      const k = i * n + j;
      // Out of this pair's reach (look-schedule.ts): this look could not detect.
      const b = budget[k] ?? 0;
      if (b > 0) {
        const f = firedAt[k] ?? Number.NaN;
        const fired = !Number.isNaN(f) && f !== (fof.soldiers[j]?.lastFiredAt ?? -1);
        if (!fired && odoI + (odometer[j] ?? 0) - (sumAt[k] ?? 0) < b) continue;
        budget[k] = 0;
      }
      const target = soldiers[j];
      if (target?.status !== 'active') continue;
      const threshold = thresholds[k] ?? 1;
      const dx = target.position.x - ox;
      const dy = target.position.y - oy;
      const rangeM = Math.hypot(dx, dy);
      // Concealed in ambush, and farther than the concealment range: not looked at (no deferral:
      // concealment ends when the ambush is sprung, without anyone moving).
      const hidden = concealed[fof.soldiers[j]?.force ?? -1] === true;
      if (hidden && rangeM > concealedFrom) continue;
      if (rangeM > maxRange) {
        deferLook(context, i, j, rangeM, maxRange);
        continue;
      }
      if (rangeM < 1e-6) continue;
      // Within it, camouflaged and still: harder to make out.
      const cue = (cues[j] ?? 1) * (hidden ? camouflage : 1);
      const dimension = detection.criticalDimensionM[target.posture];
      // Cheaper first: haze only lowers the cycles, so short of what the pair
      // needs even without it, he is not detectable now (as below, exactly).
      const clearAir =
        (dimension / (rangeM * detection.cycleArcmin * ARCMIN_RAD)) *
        conditions.backgroundContrast *
        cue;
      if (clearAir < cyclesNeeded(context, k)) {
        deferLook(context, i, j, rangeM, Infinity, quietOf(fof.soldiers[j]));
        continue;
      }
      // The best case first (all of him in view, nothing in the way): when even
      // that is not detectable to this observer, nothing is traced or drawn,
      // and the pair is left out until it may be within reach.
      sighting.rangeM = rangeM;
      sighting.visibleFraction = 1;
      sighting.transmission = 1;
      const best = ttpf(cyclesOnTarget(sighting, dimension, detection, conditions, cue), n50);
      if (best <= threshold - 1e-9) {
        // Showing no firing cue now: out of reach until he fires (or comes nearer).
        deferLook(context, i, j, rangeM, Infinity, quietOf(fof.soldiers[j]));
        continue;
      }
      // His field of regard.
      const off = Math.abs(azimuthDelta(observer.azimuth, azimuthOf(dx, dy))) * (180 / Math.PI);
      if (off > regard) continue;
      const attention = off <= central ? 1 : detection.peripheralFactor;
      force.stats.detectionAttempts += 1;
      const track = row[j];
      // Seen already in this decision, at full confidence, and identified: another
      // look would change nothing the force knows (the same time, confidence,
      // place and level), so it is not taken.
      if (track?.identified === true && track.lastSeenAt === t && track.confidence >= 1) {
        force.stats.redundantLooks += 1;
        continue;
      }
      force.stats.tracedAttempts += 1;
      const between = sightBetween(context, i, j, observer, target);
      if (between.visibleFraction <= 0 || between.transmission <= 0) continue;
      force.stats.visibleAttempts += 1;
      sighting.visibleFraction = between.visibleFraction;
      sighting.transmission = between.transmission;
      const cycles = cyclesOnTarget(sighting, dimension, detection, conditions, cue);
      // Detectable to this observer only while P∞ exceeds the pair's threshold;
      // then found at rate P∞ / searchSeconds (the time law's asymptote is P∞).
      const pInf = ttpf(cycles, n50);
      if (pInf <= threshold) continue;
      const tracking = track?.confirmed === true ? detection.trackingFactor : 1;
      const rate = (pInf / detection.searchSeconds) * search * attention * tracking;
      if (!draw(state.rng, chanceIn(rate, lookSeconds))) continue;
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
      row[j] = glimpsed;
      // Identification: a further draw once the contact is confirmed.
      if (glimpsed.confirmed && !glimpsed.identified) {
        const pId = ttpf(cycles, detection.identificationCycles50);
        const idRate = pId <= threshold ? 0 : (pId / detection.searchSeconds) * search * attention;
        if (draw(state.rng, chanceIn(idRate, lookSeconds))) glimpsed.identified = true;
      }
      glimpsed.lastKnown = { x: target.position.x, y: target.position.y };
      setLevel(context, glimpsed, from, observer.id, rangeM);
    }
  }
}

/**
 * A soldier who has never fired is left out on the reach without the firing
 * cue, until he fires; once he has fired, on the reach with every cue (which
 * no later burst changes).
 */
function quietOf(member: FofSoldier | undefined): FofSoldier | null {
  return member?.lastFiredAt === null ? member : null;
}

/** Each force's enemies: the members of the other side's forces, in soldier order (fixed for a run). */
const enemyLists = new WeakMap<FofState, number[][]>();
function enemiesOf(fof: FofState): number[][] {
  let lists = enemyLists.get(fof);
  if (!lists) {
    // The members of the forces of the other side.
    lists = fof.forces.map((force) =>
      fof.soldiers.flatMap((m, j) => (fof.forces[m.force]?.side === force.side ? [] : [j])),
    );
    enemyLists.set(fof, lists);
  }
  return lists;
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
