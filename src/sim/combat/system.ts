import { surfaceHeightAt } from '../bridge-navigation';
import type { Vec2, Vec3 } from '../geometry';
import { azimuthDelta, azimuthOf } from '../geometry';
import { nextFloat } from '../rng';
import { sightLineTracer } from '../sight-tracer';
import type { Soldier, SoldierId } from '../state';
import type { VehicleState } from '../vehicles';
import { dugInFactor, dugInFrom, effectiveDugIn } from '../fof/defence';
import {
  chanceIn,
  confidenceAt,
  cyclesOnTarget,
  draw,
  ttpf,
  vegetationTransmission,
} from '../fof/detection';
import { areaIncapacitation } from '../fof/fire';
import { underFire } from '../fof/force';
import type { FofContext } from '../fof/system';
import { forceActive, glimpse, setLevel, soldierOf } from '../fof/system';
import type { FofForce, FofSoldier, ObservationLevel } from '../fof/types';
import { applyHit, conditionOf, presentedZone, resolveHit, type VehicleCondition } from './armor';
import { TARGETING } from './catalog';
import { isLaid, layFor, layingFactor, muzzleOf, secondsToLay } from './mounts';
import { catalogOf, combatWeaponOf, platformOf, type CombatCatalog } from './registry';
import {
  crewLost,
  crewState,
  type AntiTankState,
  type CombatState,
  type Engagement,
  type MissileState,
  type MountedWeaponState,
  type VehicleCombat,
  type VehicleTrack,
} from './state';
import {
  bestAmmo,
  chooseEngagement,
  effectOnSoldier,
  effectOnVehicle,
  hitVsVehicle,
  suitabilityOf,
  utilityOf,
  type EngagementOption,
} from './targeting';
import type { AmmoSpec, CombatWeaponSpec, MountSpec, PlatformSpec, TargetingConfig } from './types';

// The combat of vehicles and anti-tank weapons (docs/combined-arms.md §5–§9),
// inside the force-on-force decision: one detection model, one picture of
// the enemy per squad, one volley. In each decision, after the soldiers have
// looked at each other (`scan`): soldiers look at enemy vehicles, and
// vehicles' crews at enemy soldiers and vehicles (`scanCombat`). In the
// volley, after the soldiers' bursts and before any of it takes effect
// (`fireCombat`): missiles arrive, vehicles choose targets, lay and fire,
// and anti-tank gunners aim and fire; the hits on vehicles are resolved
// after all of it, so fire within a decision is simultaneous. Every random
// number comes from `SimState.rng`, in that order.

const DEG = Math.PI / 180;

/** Tuning of combined arms not in the catalog (docs/combined-arms.md §16, assumptions). */
export const COMBAT_TUNING = {
  /** A vehicle's shares of its height looked at (top, middle, low). */
  sampleShares: [0.85, 0.55, 0.2] as const,
  /** A moving vehicle is more conspicuous (sound, dust, movement): cycles × this. */
  engineCue: 1.6,
  /** Within this range a moving vehicle is heard all round (m). */
  heardWithinM: 350,
  /** A vehicle above this speed is moving (m/s). */
  movingSpeedMps: 0.5,
  /** Its sights see this much farther than the eye (× the conditions' range), at most `maxObservationM`. */
  maxObservationM: 3000,
  /** A target seen within this is in sight to be laid on and fired at (s). */
  inSightSeconds: 1.5,
  /** A confirmed target seen within this is followed while it stays in sight (s): its crew tracks it. */
  trackingSeconds: 15,
  /** A catastrophic kill burns this long (s). */
  burnSeconds: 150,
  /** A target that fired within this is more dangerous (threat × `firingThreatFactor`). */
  firingThreatSeconds: 10,
  firingThreatFactor: 1.5,
  /** A soldier not known to carry anti-tank weapons: his threat to a vehicle. */
  soldierThreat: 0.01,
  /** A hit on a moving target: × this when it moves faster than 3 m/s. */
  movingTargetHitFactor: 0.8,
  /**
   * Conspicuity (`conspicuity`): resolvable cycles of a target at which its
   * search is no faster than the eye's model (more: proportionally faster),
   * the most it speeds it, and the most a glimpse's confidence is multiplied.
   */
  conspicuityCycles: 2,
  maxConspicuity: 10,
  maxGlimpseGain: 2.5,
  /** Thermal sights: vegetation's transmission is raised to this power (sees through more). */
  thermalTransmissionPower: 0.5,
} as const;

/** What a shot or a look is at: a soldier or a vehicle, where it is now. */
interface Target {
  readonly kind: 'soldier' | 'vehicle';
  readonly id: string;
  readonly position: Vec3;
  readonly soldier: Soldier | null;
  readonly vehicle: VehicleState | null;
}

/** A hit on a vehicle, resolved after the decision's fire. */
interface PendingHit {
  readonly target: VehicleState;
  readonly shooterId: string;
  readonly from: Vec2;
  readonly weapon: CombatWeaponSpec;
  readonly ammo: AmmoSpec;
  readonly rangeM: number;
}

/** What the soldiers' bursts of a decision do (`resolveFire`'s volley): combat adds to it. */
export interface CombatVolley {
  readonly suppression: Map<FofSoldier, number>;
  readonly down: Map<
    string,
    { readonly victim: Soldier; readonly by: { readonly id: string }; readonly force: number }
  >;
}

/** Whether a battle has combined arms: vehicles, or soldiers with anti-tank weapons. */
export function hasCombat(context: FofContext): boolean {
  return (
    (context.state.vehicles?.length ?? 0) > 0 ||
    context.setup.forces.some((f) => f.antiTank && Object.keys(f.antiTank).length > 0)
  );
}

/** The combat state (made at the first decision of a battle that has combined arms), or `undefined`. */
export function combatOf(context: FofContext): CombatState | undefined {
  if (context.state.combat) return context.state.combat;
  if (!hasCombat(context)) return undefined;
  const catalog = catalogOf(context.world);
  const antiTank: AntiTankState[] = [];
  for (const member of context.fof.soldiers) {
    const id = context.setup.forces[member.force]?.antiTank?.[member.soldierId];
    if (id === undefined) continue;
    const weapon = combatWeaponOf(catalog, id);
    const carried = weapon.carriedRounds ?? weapon.readyCapacity;
    antiTank.push({
      soldierId: member.soldierId,
      weapon: id,
      loaded: Math.min(weapon.readyCapacity, carried),
      reserve: Math.max(0, carried - weapon.readyCapacity),
      readyAt: 0,
      reloadUntil: null,
      aimingAt: null,
      aimUntil: 0,
      fired: 0,
    });
  }
  context.state.combat = { thresholds: {}, antiTank, missiles: [], nextMissile: 1 };
  return context.state.combat;
}

// --- Lookups -----------------------------------------------------------------------

const vehicleIndexCache = new WeakMap<readonly VehicleState[], Map<string, VehicleState>>();

function vehicleById(context: FofContext, id: string): VehicleState | undefined {
  const vehicles = context.state.vehicles;
  if (!vehicles) return undefined;
  let index = vehicleIndexCache.get(vehicles);
  if (index?.size !== vehicles.length) {
    index = new Map(vehicles.map((v) => [v.id, v]));
    vehicleIndexCache.set(vehicles, index);
  }
  return index.get(id);
}

/** Whether `id` is a vehicle of the battle. */
export function isVehicleId(context: FofContext, id: string): boolean {
  return vehicleById(context, id) !== undefined;
}

/** Whether a vehicle is still a target: not destroyed (a wreck is not engaged). */
export function vehicleTargetable(context: FofContext, id: string): boolean {
  const v = vehicleById(context, id);
  return v !== undefined && !v.combat.damage.destroyed;
}

function soldierById(context: FofContext, id: string): Soldier | undefined {
  return context.state.soldiers[context.soldierIndex.get(id) ?? -1];
}

function memberOf(context: FofContext, id: string): FofSoldier | undefined {
  return context.fof.soldiers[context.memberIndex.get(id) ?? -1];
}

function platformFor(catalog: CombatCatalog, v: VehicleState): PlatformSpec {
  return platformOf(catalog, v.kind);
}

/** The point a vehicle is aimed at: its centre of mass, half its height up. */
function vehicleAimPoint(v: VehicleState, platform: PlatformSpec): Vec3 {
  return { x: v.position.x, y: v.position.y, z: v.position.z + platform.dimensions.heightM * 0.5 };
}

/** The point a target is aimed at. */
function aimPointOf(context: FofContext, catalog: CombatCatalog, target: Target): Vec3 {
  if (target.vehicle) return vehicleAimPoint(target.vehicle, platformFor(catalog, target.vehicle));
  return target.soldier ? soldierAimPoint(context, target.soldier) : target.position;
}

/** The point a soldier is aimed at: his middle in his posture. */
function soldierAimPoint(context: FofContext, s: Soldier): Vec3 {
  const heights = context.setup.config.detection.targetSampleHeightsM[s.posture];
  return { x: s.position.x, y: s.position.y, z: s.position.z + (heights[1] ?? 0.5) };
}

// --- Sight -------------------------------------------------------------------------

const zsScratch: number[] = [];

/** The share of a target's sample heights in clear sight from `eye`, × the light through vegetation. */
function exposureFrom(
  context: FofContext,
  eye: Vec3,
  at: Vec2,
  ground: number,
  heights: readonly number[],
  thermal: boolean,
): number {
  const terrain = context.world.terrain;
  zsScratch.length = heights.length;
  heights.forEach((h, i) => {
    zsScratch[i] = ground + h;
  });
  const clear = sightLineTracer(terrain).clearCount(eye, at.x, at.y, zsScratch);
  if (clear <= 0) return 0;
  const veg = vegetationTransmission(terrain, eye, at);
  const transmission = thermal ? Math.pow(veg, COMBAT_TUNING.thermalTransmissionPower) : veg;
  return (clear / heights.length) * transmission;
}

function vehicleHeights(platform: PlatformSpec): number[] {
  return COMBAT_TUNING.sampleShares.map((s) => s * platform.dimensions.heightM);
}

/** A vehicle crew's eye: its sights, at the platform's eye height. */
function vehicleEye(v: VehicleState, platform: PlatformSpec): Vec3 {
  return { x: v.position.x, y: v.position.y, z: v.position.z + platform.sensors.eyeHeightM };
}

function soldierEye(context: FofContext, s: Soldier): Vec3 {
  return {
    x: s.position.x,
    y: s.position.y,
    z:
      surfaceHeightAt(context.world.terrain, s.position.x, s.position.y) +
      context.setup.config.detection.eyeHeightM[s.posture],
  };
}

/** What a vehicle's crew sees of a target now (0: nothing). */
function vehicleSees(
  context: FofContext,
  catalog: CombatCatalog,
  v: VehicleState,
  target: Target,
): number {
  const platform = platformFor(catalog, v);
  const eye = vehicleEye(v, platform);
  if (target.vehicle) {
    const tp = platformFor(catalog, target.vehicle);
    return exposureFrom(
      context,
      eye,
      target.position,
      target.position.z,
      vehicleHeights(tp),
      platform.sensors.thermal,
    );
  }
  const s = target.soldier;
  if (!s) return 0;
  const heights = context.setup.config.detection.targetSampleHeightsM[s.posture];
  return exposureFrom(
    context,
    eye,
    s.position,
    surfaceHeightAt(context.world.terrain, s.position.x, s.position.y),
    heights,
    platform.sensors.thermal,
  );
}

/** What a soldier sees of a vehicle now. */
function soldierSeesVehicle(
  context: FofContext,
  catalog: CombatCatalog,
  s: Soldier,
  v: VehicleState,
): number {
  return exposureFrom(
    context,
    soldierEye(context, s),
    v.position,
    v.position.z,
    vehicleHeights(platformFor(catalog, v)),
    false,
  );
}

// --- Detection ---------------------------------------------------------------------

/** The pair's detectability threshold (drawn when the pair is first looked at). */
function thresholdOf(
  context: FofContext,
  combat: CombatState,
  observer: string,
  target: string,
): number {
  const key = `${observer}>${target}`;
  let th = combat.thresholds[key];
  if (th === undefined) {
    th = nextFloat(context.state.rng);
    combat.thresholds[key] = th;
  }
  return th;
}

/**
 * How plainly a target stands out: its resolvable cycles over
 * `COMBAT_TUNING.conspicuityCycles` (1 at or below, at most
 * `maxConspicuity`). Search is that much faster: a tank in the open at a
 * few hundred metres is found in a look or two, while a target barely
 * detectable is searched for as before.
 */
function conspicuity(cycles: number): number {
  return Math.min(
    COMBAT_TUNING.maxConspicuity,
    Math.max(1, cycles / COMBAT_TUNING.conspicuityCycles),
  );
}

/** A glimpse's confidence: more for a plain target (a very plain one is confirmed at once). */
function glimpseGain(gain: number, plain: number): number {
  return Math.min(1, gain * Math.min(COMBAT_TUNING.maxGlimpseGain, Math.max(1, plain / 2)));
}

/** Whether a force is alert (searching, not merely moving). */
function alerted(force: FofForce): boolean {
  return force.phase !== 'moving' && force.phase !== 'atObjective';
}

/** Whether a vehicle fired within the firing signature's time. */
function vehicleFiredLately(context: FofContext, v: VehicleState): boolean {
  const last = v.combat.lastFiredAt;
  return last !== null && context.t - last <= context.setup.config.detection.firingSignatureSeconds;
}

/**
 * Each decision, before the forces decide: vehicles' speeds; soldiers due a
 * look look at enemy vehicles; vehicles due a look look at enemy soldiers
 * and vehicles (the force-on-force detection model, with a vehicle's size,
 * signature and sights).
 */
export function scanCombat(context: FofContext): void {
  const combat = combatOf(context);
  if (!combat) return;
  const vehicles = context.state.vehicles ?? [];
  for (const v of vehicles) {
    const d = Math.hypot(v.position.x - v.combat.lastX, v.position.y - v.combat.lastY);
    v.combat.speed = context.n === 0 ? 0 : d / context.dt;
    v.combat.lastX = v.position.x;
    v.combat.lastY = v.position.y;
  }
  const catalog = catalogOf(context.world);
  soldiersLook(context, combat, catalog, vehicles);
  vehiclesLook(context, combat, catalog, vehicles);
  ageVehicleTracks(context, vehicles);
}

function lookEvery(context: FofContext): number {
  const { config } = context.setup;
  return Math.max(1, Math.round(config.detection.scanIntervalSeconds * config.decisionHz));
}

function soldiersLook(
  context: FofContext,
  combat: CombatState,
  catalog: CombatCatalog,
  vehicles: readonly VehicleState[],
): void {
  if (vehicles.length === 0) return;
  const { fof, setup, n: decision } = context;
  const detection = setup.config.detection;
  const conditions = setup.config.visibility[setup.visibility];
  const every = lookEvery(context);
  const lookSeconds = every / setup.config.decisionHz;
  fof.soldiers.forEach((member, i) => {
    if ((decision + i) % every !== 0) return;
    const observer = soldierOf(context, member);
    const force = fof.forces[member.force];
    if (observer.status !== 'active' || !force || !forceActive(force)) return;
    const search = alerted(force) ? detection.alertedSearchFactor : detection.unalertedSearchFactor;
    for (const v of vehicles) {
      if (v.side === observer.side || v.combat.damage.destroyed) continue;
      const dx = v.position.x - observer.position.x;
      const dy = v.position.y - observer.position.y;
      const rangeM = Math.hypot(dx, dy);
      if (rangeM > conditions.maxObservationRangeM || rangeM < 1e-6) continue;
      const moving = v.combat.speed > COMBAT_TUNING.movingSpeedMps;
      const off = Math.abs(azimuthDelta(observer.azimuth, azimuthOf(dx, dy))) / DEG;
      const heard = moving && rangeM <= COMBAT_TUNING.heardWithinM;
      if (off > detection.regardHalfAngleDeg && !heard) continue;
      const attention =
        off <= detection.centralHalfAngleDeg || heard ? 1 : detection.peripheralFactor;
      const seen = soldierSeesVehicle(context, catalog, observer, v);
      if (seen <= 0) continue;
      const platform = platformFor(catalog, v);
      const dimension = Math.sqrt(platform.dimensions.heightM * platform.dimensions.widthM);
      const cue =
        (moving ? COMBAT_TUNING.engineCue : 1) *
        (vehicleFiredLately(context, v) ? detection.firingSignatureFactor : 1);
      const sighting = { rangeM, visibleFraction: seen, transmission: 1, attention };
      const cycles = cyclesOnTarget(sighting, dimension, detection, conditions, cue);
      const pInf = ttpf(cycles, detection.detectionCycles50);
      const threshold = thresholdOf(context, combat, observer.id, v.id);
      if (pInf <= threshold) continue;
      const existing = fof.tracks.find((tr) => tr.force === member.force && tr.targetId === v.id);
      const tracking = existing?.confirmed === true ? detection.trackingFactor : 1;
      const plain = conspicuity(cycles);
      const rate = (pInf / detection.searchSeconds) * search * attention * tracking * plain;
      if (!draw(context.state.rng, chanceIn(rate, lookSeconds))) continue;
      const from: ObservationLevel = existing?.level ?? 'unaware';
      const track = glimpse(
        context,
        member.force,
        v,
        existing,
        glimpseGain(detection.confidenceGain, plain),
        observer.id,
      );
      if (track.confirmed && !track.identified) {
        const pId = ttpf(cycles, detection.identificationCycles50);
        const idRate =
          pId <= threshold ? 0 : (pId / detection.searchSeconds) * search * attention * plain;
        if (draw(context.state.rng, chanceIn(idRate, lookSeconds))) track.identified = true;
      }
      setLevel(context, track, from, observer.id, rangeM);
    }
  });
}

/** How well a vehicle's crew observes: its commander's, else its gunner's eyes, and its sights' damage. */
function observingFactor(combat: VehicleCombat): number {
  const commander = crewState(combat, 'commander');
  const gunner = crewState(combat, 'gunner');
  const eyes =
    commander === 'operational'
      ? 1
      : gunner === 'operational'
        ? 0.7
        : commander === 'degraded' || gunner === 'degraded'
          ? 0.5
          : 0;
  return eyes * combat.damage.sensors;
}

function vehiclesLook(
  context: FofContext,
  combat: CombatState,
  catalog: CombatCatalog,
  vehicles: readonly VehicleState[],
): void {
  const { fof, setup, t, n: decision } = context;
  const detection = setup.config.detection;
  const conditions = setup.config.visibility[setup.visibility];
  const every = lookEvery(context);
  const lookSeconds = every / setup.config.decisionHz;
  const offset = fof.soldiers.length;
  vehicles.forEach((v, vi) => {
    if ((decision + offset + vi) % every !== 0) return;
    if (v.combat.damage.destroyed || crewLost(v.combat)) return;
    const eyes = observingFactor(v.combat);
    if (eyes <= 0) return;
    const platform = platformFor(catalog, v);
    const sensors = platform.sensors;
    const maxRange = Math.min(
      COMBAT_TUNING.maxObservationM,
      conditions.maxObservationRangeM * Math.max(1, sensors.opticsFactor),
    );
    const eye = vehicleEye(v, platform);
    const look = (
      target: Target,
      dimension: number,
      heights: readonly number[],
      ground: number,
      cue: number,
    ) => {
      const dx = target.position.x - v.position.x;
      const dy = target.position.y - v.position.y;
      const rangeM = Math.hypot(dx, dy);
      if (rangeM > maxRange || rangeM < 1e-6) return;
      const seen = exposureFrom(context, eye, target.position, ground, heights, sensors.thermal);
      if (seen <= 0) return;
      const sighting = { rangeM, visibleFraction: seen, transmission: 1, attention: 1 };
      const cycles =
        cyclesOnTarget(sighting, dimension, detection, conditions, cue) *
        sensors.opticsFactor *
        (sensors.thermal ? 1.5 : 1) *
        eyes;
      const pInf = ttpf(cycles, detection.detectionCycles50);
      const threshold = thresholdOf(context, combat, v.id, target.id);
      if (pInf <= threshold) return;
      const existing = v.combat.tracks.find((tr) => tr.targetId === target.id);
      const tracking = existing?.confirmed === true ? detection.trackingFactor : 1;
      const plain = conspicuity(cycles);
      const rate =
        (pInf / detection.searchSeconds) * detection.alertedSearchFactor * tracking * plain;
      if (!draw(context.state.rng, chanceIn(rate, lookSeconds))) return;
      vehicleGlimpse(context, v.combat, target, glimpseGain(detection.confidenceGain, plain));
    };
    // Enemy soldiers, in soldier order.
    for (const member of fof.soldiers) {
      const s = soldierOf(context, member);
      if (s.side === v.side || s.status !== 'active') continue;
      const force = fof.forces[member.force];
      const rangeM = Math.hypot(s.position.x - v.position.x, s.position.y - v.position.y);
      const hidden = force?.concealed === true;
      if (hidden && rangeM > setup.config.force.concealmentRangeM) continue;
      const moving = member.speed > detection.movingSpeedMps;
      const firedLately =
        member.lastFiredAt !== null && t - member.lastFiredAt <= detection.firingSignatureSeconds;
      const cue =
        (moving ? detection.movingTargetFactor : 1) *
        (firedLately ? detection.firingSignatureFactor : 1) *
        (hidden ? setup.config.force.concealedDetectionFactor : 1) *
        dugInFactor(effectiveDugIn(force ?? null), setup.config.force.dugInDetectionFactor);
      look(
        { kind: 'soldier', id: s.id, position: s.position, soldier: s, vehicle: null },
        detection.criticalDimensionM[s.posture],
        detection.targetSampleHeightsM[s.posture],
        surfaceHeightAt(context.world.terrain, s.position.x, s.position.y),
        cue,
      );
    }
    // Enemy vehicles, in vehicle order.
    for (const other of vehicles) {
      if (other.side === v.side || other.combat.damage.destroyed) continue;
      const op = platformFor(catalog, other);
      const cue =
        (other.combat.speed > COMBAT_TUNING.movingSpeedMps ? COMBAT_TUNING.engineCue : 1) *
        (vehicleFiredLately(context, other) ? detection.firingSignatureFactor : 1);
      look(
        { kind: 'vehicle', id: other.id, position: other.position, soldier: null, vehicle: other },
        Math.sqrt(op.dimensions.heightM * op.dimensions.widthM),
        vehicleHeights(op),
        other.position.z,
        cue,
      );
    }
  });
}

/** Adds `gain` to a vehicle crew's confidence in a target, seen now. */
function vehicleGlimpse(
  context: FofContext,
  combat: VehicleCombat,
  target: Target,
  gain: number,
): VehicleTrack {
  const detection = context.setup.config.detection;
  let track = combat.tracks.find((tr) => tr.targetId === target.id);
  if (!track) {
    track = {
      targetId: target.id,
      target: target.kind,
      confidence: 0,
      lastSeenAt: context.t,
      confirmed: false,
      lastKnown: { x: target.position.x, y: target.position.y },
      firstAt: context.t,
    };
    combat.tracks.push(track);
  }
  const now = confidenceAt(track, context.t, detection.confidenceHalfLifeSeconds);
  track.confidence = Math.min(1, now + gain);
  track.lastSeenAt = context.t;
  track.lastKnown = { x: target.position.x, y: target.position.y };
  if (track.confidence >= detection.confirmConfidence - 1e-12) track.confirmed = true;
  return track;
}

/** A vehicle comes under fire from `shooter`: its crew gets a cue on him (the flash, the impact). */
function vehicleUnderFire(context: FofContext, v: VehicleState, shooter: Target): void {
  if (v.combat.damage.destroyed) return;
  const detection = context.setup.config.detection;
  const existing = v.combat.tracks.find((tr) => tr.targetId === shooter.id);
  const now = existing ? confidenceAt(existing, context.t, detection.confidenceHalfLifeSeconds) : 0;
  if (now < detection.confirmConfidence)
    vehicleGlimpse(context, v.combat, shooter, detection.confirmConfidence - now + 1e-9);
}

/** Vehicle tracks age; those on targets that are down or destroyed, or forgotten, are dropped. */
function ageVehicleTracks(context: FofContext, vehicles: readonly VehicleState[]): void {
  const detection = context.setup.config.detection;
  for (const v of vehicles) {
    v.combat.tracks = v.combat.tracks.filter((tr) => {
      if (tr.target === 'soldier') {
        if (soldierById(context, tr.targetId)?.status !== 'active') return false;
      } else if (!vehicleTargetable(context, tr.targetId)) return false;
      const c = confidenceAt(tr, context.t, detection.confidenceHalfLifeSeconds);
      return c >= (tr.confirmed ? detection.forgetConfidence : detection.dropConfidence);
    });
  }
}

// --- Fire --------------------------------------------------------------------------

/**
 * A crew follows the confirmed targets it has seen lately while they stay in
 * sight (a gunner on his target needs no new detection): seen now, a track
 * is current again where the target is.
 */
function keepTracking(context: FofContext, catalog: CombatCatalog, v: VehicleState): void {
  const t = context.t;
  for (const track of v.combat.tracks) {
    const age = t - track.lastSeenAt;
    if (!track.confirmed || age <= 1e-9 || age > COMBAT_TUNING.trackingSeconds) continue;
    const target = targetOf(context, track.target, track.targetId);
    if (!target || vehicleSees(context, catalog, v, target) <= 0) continue;
    track.lastSeenAt = t;
    track.lastKnown = { x: target.position.x, y: target.position.y };
  }
}

/** A whole number in [min, max], one draw. */
function drawInt(context: FofContext, r: { readonly min: number; readonly max: number }): number {
  const u = nextFloat(context.state.rng);
  return Math.min(r.max, r.min + Math.floor(u * (r.max - r.min + 1)));
}

function drawSecondsIn(
  context: FofContext,
  r: { readonly minSeconds: number; readonly maxSeconds: number },
): number {
  return r.minSeconds + nextFloat(context.state.rng) * (r.maxSeconds - r.minSeconds);
}

/**
 * In the volley, after the soldiers' bursts: missiles arrive, vehicles fire,
 * anti-tank gunners fire; then the hits on vehicles are resolved together.
 */
export function fireCombat(context: FofContext, volley: CombatVolley): void {
  const combat = combatOf(context);
  if (!combat) return;
  const catalog = catalogOf(context.world);
  const pending: PendingHit[] = [];
  arriveMissiles(context, combat, catalog, pending);
  for (const v of context.state.vehicles ?? [])
    vehicleFire(context, combat, catalog, v, volley, pending);
  for (const at of combat.antiTank) antiTankFire(context, combat, catalog, at, pending);
  for (const hit of pending) resolvePendingHit(context, catalog, hit);
}

/** The target of a track id now, or `null` when it is gone (down, destroyed, unknown). */
function targetOf(context: FofContext, kind: 'soldier' | 'vehicle', id: string): Target | null {
  if (kind === 'vehicle') {
    const v = vehicleById(context, id);
    return v && !v.combat.damage.destroyed
      ? { kind, id, position: v.position, soldier: null, vehicle: v }
      : null;
  }
  const s = soldierById(context, id);
  return s?.status === 'active'
    ? { kind, id, position: s.position, soldier: s, vehicle: null }
    : null;
}

/** A vehicle seen knocked out: its crew gone or it can neither move nor fight, still and silent a while. */
function seenKnockedOut(context: FofContext, v: VehicleState): boolean {
  if (conditionOf(v.combat) !== 'missionKill' || v.combat.speed > 0.1) return false;
  const last = v.combat.lastFiredAt;
  return last === null || context.t - last > COMBAT_TUNING.firingThreatSeconds;
}

/** What a target can do to a vehicle (its effect, more when it has fired lately). */
function threatToVehicle(
  context: FofContext,
  combat: CombatState,
  catalog: CombatCatalog,
  shooter: VehicleState,
  shooterPlatform: PlatformSpec,
  target: Target,
  rangeM: number,
): number {
  const bearing = azimuthOf(
    target.position.x - shooter.position.x,
    target.position.y - shooter.position.y,
  );
  const zone = presentedZone(shooter.heading, bearing, false);
  if (target.vehicle) {
    const tv = target.vehicle;
    if (crewLost(tv.combat)) return 0;
    const tp = platformFor(catalog, tv);
    let best = 0;
    for (const w of tp.weapons) {
      const ws = tv.combat.weapons.find((x) => x.id === w.id);
      if (!ws || ws.disabled) continue;
      const spec = combatWeaponOf(catalog, w.weapon);
      const loads = ws.loads.filter((l) => l.ready + l.stowed > 0).map((l) => l.ammo);
      const top = bestAmmo(spec, loads, shooterPlatform, rangeM, zone);
      if (top) best = Math.max(best, top.effect);
    }
    const lately =
      tv.combat.lastFiredAt !== null &&
      context.t - tv.combat.lastFiredAt <= COMBAT_TUNING.firingThreatSeconds;
    return best * (lately ? COMBAT_TUNING.firingThreatFactor : 1);
  }
  // A soldier: dangerous to it once he has shown an anti-tank weapon (fired one, or aims one at it).
  const at = combat.antiTank.find((a) => a.soldierId === target.id);
  if (at && (at.fired > 0 || at.aimingAt === shooter.id) && at.loaded + at.reserve > 0) {
    const spec = combatWeaponOf(catalog, at.weapon);
    const ammo = spec.ammo[0];
    return ammo
      ? effectOnVehicle(spec, ammo, shooterPlatform, rangeM, zone) *
          COMBAT_TUNING.firingThreatFactor
      : 0;
  }
  return COMBAT_TUNING.soldierThreat;
}

/** The weapons a mount lays: its own and those on its fixed children (a launcher on a turret). */
function weaponsLaidBy(platform: PlatformSpec, mount: MountSpec): readonly string[] {
  const fixedChildren = platform.mounts.filter(
    (m) =>
      m.parent === mount.id &&
      m.traverse !== null &&
      m.traverse.leftDeg === 0 &&
      m.traverse.rightDeg === 0,
  );
  const mounts = new Set([mount.id, ...fixedChildren.map((m) => m.id)]);
  return platform.weapons.filter((w) => mounts.has(w.mount)).map((w) => w.id);
}

/** Whether a mount is laid by its parent (a fixed launcher on a turret): it chooses nothing itself. */
function laidByParent(mount: MountSpec): boolean {
  return (
    mount.parent !== null &&
    mount.traverse !== null &&
    mount.traverse.leftDeg === 0 &&
    mount.traverse.rightDeg === 0
  );
}

/** How fast the gun is served: its loader's state (or without one, `reloadWithoutFactor`). */
function loadingFactor(platform: PlatformSpec, combat: VehicleCombat, slot: string): number {
  const w = platform.weapons.find((x) => x.id === slot);
  if (!w?.loader) return 1;
  const state = crewState(combat, w.loader);
  return state === 'operational' ? 1 : state === 'degraded' ? 1.5 : (w.reloadWithoutFactor ?? 2);
}

/** A mounted weapon's rounds of an ammunition ready, and in all. */
function roundsOf(ws: MountedWeaponState, ammo: string): { ready: number; all: number } {
  const load = ws.loads.find((l) => l.ammo === ammo);
  return { ready: load?.ready ?? 0, all: (load?.ready ?? 0) + (load?.stowed ?? 0) };
}

/** Refills a weapon's ready rounds from stowage when its reload is done. */
function updateMountedReload(platform: PlatformSpec, ws: MountedWeaponState, t: number): void {
  if (ws.reloadUntil === null || t < ws.reloadUntil - 1e-9) return;
  ws.reloadUntil = null;
  const spec = platform.weapons.find((w) => w.id === ws.id);
  for (const load of ws.loads) {
    if (load.ready > 0 || load.stowed <= 0) continue;
    const initial = spec?.loads.find((l) => l.ammo === load.ammo)?.ready ?? 1;
    const n = Math.min(load.stowed, Math.max(1, initial));
    load.ready += n;
    load.stowed -= n;
  }
}

/** One vehicle's decision: for each mount, a target (committed), laying, and fire when it can. */
function vehicleFire(
  context: FofContext,
  combat: CombatState,
  catalog: CombatCatalog,
  v: VehicleState,
  volley: CombatVolley,
  pending: PendingHit[],
): void {
  const vc = v.combat;
  if (vc.damage.destroyed || crewLost(vc)) {
    vc.engagements = [];
    return;
  }
  const t = context.t;
  const platform = platformFor(catalog, v);
  const config = TARGETING;
  const hull = { x: v.position.x, y: v.position.y, z: v.position.z, heading: v.heading };
  for (const ws of vc.weapons) updateMountedReload(platform, ws, t);
  if (vc.haltUntil !== null && t >= vc.haltUntil - 1e-9) vc.haltUntil = null;
  keepTracking(context, catalog, v);
  for (const mount of platform.mounts) {
    if (laidByParent(mount)) continue;
    const ms = vc.mounts.find((m) => m.id === mount.id);
    const current = vc.engagements.find((e) => e.mount === mount.id);
    const drop = () => {
      vc.engagements = vc.engagements.filter((e) => e.mount !== mount.id);
    };
    if (!ms || ms.disabled || layingFactor(mount, vc) <= 0) {
      drop();
      continue;
    }
    const options = optionsFor(context, combat, catalog, v, platform, mount, config);
    const chosen = chooseEngagement(current, options, t, config);
    if (!chosen) {
      drop();
      continue;
    }
    const engagement = commit(vc, mount.id, current, chosen, t, config);
    const target = targetOf(context, chosen.target, chosen.targetId);
    if (!target) continue;
    // Laying: on where the target is (seen now), the weapon's mount and any fixed child.
    const aim = aimPointOf(context, catalog, target);
    const lay = layFor(platform, vc, mount.id, hull, aim);
    if (!lay) continue;
    ms.goalAzimuth = lay.azimuth;
    ms.goalElevation = lay.elevation;
    for (const child of platform.mounts) {
      if (child.parent !== mount.id || !laidByParent(child)) continue;
      const cs = vc.mounts.find((m) => m.id === child.id);
      if (!cs) continue;
      cs.goalAzimuth = 0;
      cs.goalElevation = Math.min(
        child.elevation.maxDeg * DEG,
        Math.max(child.elevation.minDeg * DEG, lay.elevation),
      );
    }
    tryFire(context, combat, catalog, v, platform, mount, engagement, target, aim, volley, pending);
  }
}

/** The suitable engagements of a mount's weapons against what its crew sees. */
function optionsFor(
  context: FofContext,
  combat: CombatState,
  catalog: CombatCatalog,
  v: VehicleState,
  platform: PlatformSpec,
  mount: MountSpec,
  config: TargetingConfig,
): EngagementOption[] {
  const t = context.t;
  const vc = v.combat;
  const ms = vc.mounts.find((m) => m.id === mount.id);
  if (!ms) return [];
  const hull = { x: v.position.x, y: v.position.y, z: v.position.z, heading: v.heading };
  const slots = weaponsLaidBy(platform, mount);
  const options: EngagementOption[] = [];
  for (const track of vc.tracks) {
    if (!track.confirmed || t - track.lastSeenAt > COMBAT_TUNING.inSightSeconds) continue;
    const target = targetOf(context, track.target, track.targetId);
    if (!target || (target.vehicle && seenKnockedOut(context, target.vehicle))) continue;
    const rangeM = Math.hypot(target.position.x - v.position.x, target.position.y - v.position.y);
    const aim = aimPointOf(context, catalog, target);
    const lay = layFor(platform, vc, mount.id, hull, aim);
    if (!lay) continue;
    const targetPlatform = target.vehicle ? platformFor(catalog, target.vehicle) : null;
    const zone = target.vehicle
      ? presentedZone(
          target.vehicle.heading,
          azimuthOf(v.position.x - target.position.x, v.position.y - target.position.y),
          false,
        )
      : 'front';
    const threat = threatToVehicle(context, combat, catalog, v, platform, target, rangeM);
    const layDelay = secondsToLay(mount, vc, ms, lay.azimuth);
    for (const slot of slots) {
      const ws = vc.weapons.find((w) => w.id === slot);
      const spec = platform.weapons.find((w) => w.id === slot);
      if (!ws || !spec || ws.disabled) continue;
      const own = vc.mounts.find((m) => m.id === spec.mount);
      if (own?.disabled === true) continue;
      const weapon = combatWeaponOf(catalog, spec.weapon);
      if (rangeM < weapon.minRangeM || rangeM > weapon.maxRangeM) continue;
      const loads = ws.loads.filter((l) => l.ready + l.stowed > 0).map((l) => l.ammo);
      const best = bestAmmo(weapon, loads, targetPlatform, rangeM, zone);
      if (!best || suitabilityOf(best.effect, config) === 'ineffective') continue;
      const wait = Math.max(0, ws.readyAt - t, (ws.reloadUntil ?? t) - t);
      const delay = Math.max(layDelay, wait) + weapon.aimSeconds;
      const targetClass = targetPlatform ? targetPlatform.targetClass : 'infantry';
      options.push({
        targetId: target.id,
        target: target.kind,
        targetClass,
        weapon: slot,
        ammo: best.ammo.id,
        rangeM,
        effect: best.effect,
        threat,
        cost: weapon.costPerShot,
        utility: utilityOf(best.effect, threat, targetClass, weapon.costPerShot, delay, config),
        delaySeconds: delay,
      });
    }
  }
  return options;
}

/** Takes (or keeps) an engagement: a new target is committed to until its reassessment. */
function commit(
  vc: VehicleCombat,
  mount: string,
  current: Engagement | undefined,
  chosen: EngagementOption,
  t: number,
  config: TargetingConfig,
): Engagement {
  if (current?.targetId === chosen.targetId) {
    if (t >= current.reassessAt - 1e-9) current.reassessAt = t + config.reassessSeconds;
    if (current.weapon !== chosen.weapon || current.ammo !== chosen.ammo) current.aimedAt = null;
    current.weapon = chosen.weapon;
    current.ammo = chosen.ammo;
    current.utility = chosen.utility;
    return current;
  }
  const made: Engagement = {
    mount,
    targetId: chosen.targetId,
    target: chosen.target,
    weapon: chosen.weapon,
    ammo: chosen.ammo,
    since: t,
    reassessAt: t + config.reassessSeconds,
    utility: chosen.utility,
    aimedAt: null,
  };
  vc.engagements = [...vc.engagements.filter((e) => e.mount !== mount), made];
  return made;
}

/** The shooter's accuracy against a target: crew, sights, motion. */
function vehicleAccuracy(mount: MountSpec, vc: VehicleCombat, target: Target): number {
  const operator = crewState(vc, mount.operator);
  const crew =
    operator === 'operational'
      ? 1
      : operator === 'degraded'
        ? 0.8
        : 0.85 * (mount.alternate ? 1 : 0);
  const moving = vc.speed > COMBAT_TUNING.movingSpeedMps ? mount.movingAccuracyFactor : 1;
  const targetMoving =
    target.vehicle && target.vehicle.combat.speed > 3 ? COMBAT_TUNING.movingTargetHitFactor : 1;
  const sights = 0.5 + 0.5 * vc.damage.sensors;
  return crew * moving * targetMoving * sights;
}

/** Fires the engagement's weapon when it can: laid, loaded, ready, in sight and range, halted if it must be. */
function tryFire(
  context: FofContext,
  combat: CombatState,
  catalog: CombatCatalog,
  v: VehicleState,
  platform: PlatformSpec,
  mount: MountSpec,
  engagement: Engagement,
  target: Target,
  aim: Vec3,
  volley: CombatVolley,
  pending: PendingHit[],
): void {
  const t = context.t;
  const vc = v.combat;
  const ws = vc.weapons.find((w) => w.id === engagement.weapon);
  const spec = platform.weapons.find((w) => w.id === engagement.weapon);
  if (!ws || !spec || ws.disabled) return;
  const weapon = combatWeaponOf(catalog, spec.weapon);
  const ammo = weapon.ammo.find((a) => a.id === engagement.ammo);
  if (!ammo) return;
  const rounds = roundsOf(ws, ammo.id);
  if (rounds.all <= 0) return;
  // Changing ammunition: the round loaded is swapped (a loading cycle).
  if (ws.ammo !== ammo.id) {
    ws.ammo = ammo.id;
    if (weapon.readyCapacity === 1)
      ws.readyAt = Math.max(
        ws.readyAt,
        t + weapon.secondsBetweenShots.minSeconds * loadingFactor(platform, vc, ws.id),
      );
  }
  if (rounds.ready <= 0) {
    ws.reloadUntil ??=
      t + drawSecondsIn(context, weapon.reloadSeconds) * loadingFactor(platform, vc, ws.id);
    return;
  }
  if (ws.reloadUntil !== null || t < ws.readyAt - 1e-9) return;
  const ms = vc.mounts.find((m) => m.id === mount.id);
  const own = vc.mounts.find((m) => m.id === spec.mount);
  if (!ms || !own) return;
  if (!isLaid(ms, TARGETING.layToleranceDeg, TARGETING.elevationToleranceDeg)) {
    engagement.aimedAt = null;
    return;
  }
  if (own !== ms && !isLaid(own, TARGETING.layToleranceDeg, TARGETING.elevationToleranceDeg))
    return;
  const rangeM = Math.hypot(aim.x - v.position.x, aim.y - v.position.y);
  if (rangeM < weapon.minRangeM || rangeM > weapon.maxRangeM) return;
  // A weapon fired only from a halt: it stops first.
  if (weapon.requiresHalt) {
    if (vc.speed > 0.3) {
      vc.haltUntil = t + weapon.aimSeconds + 3;
      return;
    }
    vc.haltUntil = Math.max(vc.haltUntil ?? t, t + 1);
  }
  engagement.aimedAt ??= t;
  if (t - engagement.aimedAt < weapon.aimSeconds - 1e-9) return;
  const seen = vehicleSees(context, catalog, v, target);
  if (seen <= 0) return;
  const accuracy = vehicleAccuracy(mount, vc, target) * seen;
  const muzzle = muzzleOf(platform, vc, ws.id, {
    x: v.position.x,
    y: v.position.y,
    z: v.position.z,
    heading: v.heading,
  });
  const shooter: Target = {
    kind: 'vehicle',
    id: v.id,
    position: v.position,
    soldier: null,
    vehicle: v,
  };
  const fired = Math.min(rounds.ready, drawInt(context, weapon.roundsPerShot));
  const load = ws.loads.find((l) => l.ammo === ammo.id);
  if (load) load.ready -= fired;
  ws.fired += fired;
  ws.readyAt =
    t + drawSecondsIn(context, weapon.secondsBetweenShots) * loadingFactor(platform, vc, ws.id);
  vc.lastFiredAt = t;
  if ((load?.ready ?? 0) <= 0 && (load?.stowed ?? 0) > 0)
    ws.reloadUntil =
      t + drawSecondsIn(context, weapon.reloadSeconds) * loadingFactor(platform, vc, ws.id);
  shoot(context, combat, {
    shooter,
    side: v.side,
    slot: ws.id,
    weapon,
    ammo,
    rounds: fired,
    from: muzzle,
    target,
    aim,
    rangeM,
    accuracy,
    volley,
    pending,
  });
  if (weapon.guided?.guidedToImpact === true) {
    // The gunner guides it to impact: the vehicle waits, and the mount is busy.
    const impactAt = t + rangeM / weapon.guided.flightSpeedMps;
    vc.haltUntil = Math.max(vc.haltUntil ?? t, impactAt);
    ws.readyAt = Math.max(ws.readyAt, impactAt);
    for (const other of vc.weapons) {
      const os = platform.weapons.find((w) => w.id === other.id);
      if (os && weaponsLaidBy(platform, mount).includes(os.id))
        other.readyAt = Math.max(other.readyAt, impactAt);
    }
  }
  engagement.aimedAt = null;
}

interface Shot {
  readonly shooter: Target;
  readonly side: 'BLUEFOR' | 'OPFOR';
  readonly slot: string;
  readonly weapon: CombatWeaponSpec;
  readonly ammo: AmmoSpec;
  readonly rounds: number;
  readonly from: Vec3;
  readonly target: Target;
  readonly aim: Vec3;
  readonly rangeM: number;
  /** The shooter's accuracy and what it sees of the target (× the hit table). */
  readonly accuracy: number;
  readonly volley: CombatVolley;
  readonly pending: PendingHit[];
}

/** Resolves one shot (a round, a burst, a missile launched): its event, its hit, its effects. */
function shoot(context: FofContext, combat: CombatState, shot: Shot): void {
  const { t, tick, events, state } = context;
  const { weapon, ammo, target } = shot;
  // A missile: launched now, resolved when it arrives.
  if (weapon.guided) {
    const id = `M${String(combat.nextMissile)}`;
    combat.nextMissile += 1;
    const p = Math.min(1, hitVsVehicle(weapon, shot.rangeM) * shot.accuracy);
    const impactAt = t + shot.rangeM / weapon.guided.flightSpeedMps;
    const missile: MissileState = {
      id,
      shooterId: shot.shooter.id,
      side: shot.side,
      weapon: weapon.id,
      ammo: ammo.id,
      targetId: target.id,
      from: shot.from,
      launchedAt: t,
      impactAt,
      hitProbability: p,
      rangeM: shot.rangeM,
    };
    combat.missiles.push(missile);
    events.push({
      type: 'vehicleFire',
      tick,
      atSeconds: t,
      shooterId: shot.shooter.id,
      shooter: shot.shooter.kind,
      side: shot.side,
      slot: shot.slot,
      weapon: weapon.id,
      ammo: ammo.id,
      rounds: 1,
      targetId: target.id,
      target: target.kind,
      from: shot.from,
      aimPoint: shot.aim,
      rangeM: shot.rangeM,
      hitProbability: p,
      hit: false,
      incapacitated: [],
      missileId: id,
      impactAt,
      impact: shot.aim,
    });
    if (target.vehicle) vehicleUnderFire(context, target.vehicle, shot.shooter);
    return;
  }
  if (target.vehicle) {
    const effective = 1 + (shot.rounds - 1) * 0.3;
    const p = Math.min(
      1,
      1 - Math.pow(1 - Math.min(1, hitVsVehicle(weapon, shot.rangeM) * shot.accuracy), effective),
    );
    const hit = nextFloat(state.rng) < p;
    const impact = hit ? shot.aim : missPoint(context, shot);
    events.push({
      type: 'vehicleFire',
      tick,
      atSeconds: t,
      shooterId: shot.shooter.id,
      shooter: shot.shooter.kind,
      side: shot.side,
      slot: shot.slot,
      weapon: weapon.id,
      ammo: ammo.id,
      rounds: shot.rounds,
      targetId: target.id,
      target: 'vehicle',
      from: shot.from,
      aimPoint: shot.aim,
      rangeM: shot.rangeM,
      hitProbability: p,
      hit,
      incapacitated: [],
      missileId: null,
      impactAt: null,
      impact,
    });
    if (hit)
      shot.pending.push({
        target: target.vehicle,
        shooterId: shot.shooter.id,
        from: { x: shot.shooter.position.x, y: shot.shooter.position.y },
        weapon,
        ammo,
        rangeM: shot.rangeM,
      });
    else vehicleUnderFire(context, target.vehicle, shot.shooter);
    return;
  }
  // At soldiers.
  const soldier = target.soldier;
  const vs = ammo.vsInfantry;
  if (!soldier || !vs) return;
  const down: SoldierId[] = [];
  let p = 0;
  let hit: boolean;
  let impact: Vec3 = shot.aim;
  if (vs.area) {
    // A blast: where it lands (its dispersion), whom it strikes down unless cover stands between.
    const area = vs.area;
    const spread = area.dispersionM.atZeroM + (shot.rangeM / 100) * area.dispersionM.per100M;
    const r = spread * Math.sqrt(nextFloat(state.rng));
    const angle = 2 * Math.PI * nextFloat(state.rng);
    const ix = shot.aim.x + r * Math.sin(angle);
    const iy = shot.aim.y + r * Math.cos(angle);
    const iz = surfaceHeightAt(context.world.terrain, ix, iy);
    impact = { x: ix, y: iy, z: iz };
    const tracer = sightLineTracer(context.world.terrain);
    for (const other of context.fof.soldiers) {
      const s = soldierOf(context, other);
      if (s.status !== 'active') continue;
      const d = Math.hypot(s.position.x - ix, s.position.y - iy);
      if (d >= area.maxEffectRadiusM) continue;
      const covered =
        d > 0.5 &&
        tracer.blocked(
          { x: ix, y: iy, z: iz + 0.5 },
          { x: s.position.x, y: s.position.y, z: s.position.z + 0.5 },
        );
      if (covered) continue;
      const force = context.fof.forces[other.force];
      const pk =
        areaIncapacitation(area, d) *
        (s.posture === 'prone' ? area.proneFactor : 1) *
        dugInFactor(
          dugInFrom(force ?? null, s, { x: ix, y: iy }),
          context.setup.config.force.dugInHitFactor,
        );
      if (s.id === soldier.id) p = pk;
      if (nextFloat(state.rng) < pk && !shot.volley.down.has(s.id)) {
        down.push(s.id);
        other.stats.timesHit += 1;
        shot.volley.down.set(s.id, { victim: s, by: { id: shot.shooter.id }, force: -1 });
      }
    }
    hit = down.length > 0;
  } else {
    const fire = context.setup.config.fire;
    const member = memberOf(context, soldier.id);
    const force = member ? context.fof.forces[member.force] : undefined;
    const base =
      effectOnSoldier(weapon, ammo, shot.rangeM) /
      Math.max(vs.incapacitationProbabilityOnHit, 1e-9);
    // `effectOnSoldier` is for a standing soldier in the open, aimed from a still mount.
    p = Math.min(
      1,
      base *
        fire.postureHitMultipliers[soldier.posture] *
        dugInFactor(
          dugInFrom(force ?? null, soldier, shot.from),
          context.setup.config.force.dugInHitFactor,
        ) *
        shot.accuracy,
    );
    hit = nextFloat(state.rng) < p;
    const struck = hit && nextFloat(state.rng) < vs.incapacitationProbabilityOnHit;
    if (struck && !shot.volley.down.has(soldier.id)) {
      down.push(soldier.id);
      if (member) member.stats.timesHit += 1;
      shot.volley.down.set(soldier.id, { victim: soldier, by: { id: shot.shooter.id }, force: -1 });
    }
    if (!hit) impact = missPoint(context, shot);
  }
  events.push({
    type: 'vehicleFire',
    tick,
    atSeconds: t,
    shooterId: shot.shooter.id,
    shooter: shot.shooter.kind,
    side: shot.side,
    slot: shot.slot,
    weapon: weapon.id,
    ammo: ammo.id,
    rounds: shot.rounds,
    targetId: target.id,
    target: 'soldier',
    from: shot.from,
    aimPoint: shot.aim,
    rangeM: shot.rangeM,
    hitProbability: p,
    hit,
    incapacitated: down,
    missileId: null,
    impactAt: null,
    impact,
  });
  // Suppression where it lands, and the soldiers' force comes under fire.
  suppressNear(context, shot, impact, soldier.id, vs.suppressionPerBurst, vs.suppressionRadiusM);
  const member = memberOf(context, soldier.id);
  if (member) {
    member.stats.timesTargeted += 1;
    underFire(context, member.force, shot.shooter);
  }
}

/** Where a miss lands: beyond or short of the aim point, a little to the side (no draw: by the shot's numbers). */
function missPoint(context: FofContext, shot: Shot): Vec3 {
  const dx = shot.aim.x - shot.from.x;
  const dy = shot.aim.y - shot.from.y;
  const len = Math.max(1e-6, Math.hypot(dx, dy));
  const over = 6 + (shot.rangeM / 100) * 1.5;
  const side = ((context.n % 7) - 3) * 0.8;
  const x = shot.aim.x + (dx / len) * over + (dy / len) * side;
  const y = shot.aim.y + (dy / len) * over - (dx / len) * side;
  return { x, y, z: surfaceHeightAt(context.world.terrain, x, y) };
}

/** Suppression of the enemies of the shooter near an impact: full for the one aimed at, fading to `radiusM`. */
function suppressNear(
  context: FofContext,
  shot: Shot,
  impact: Vec2,
  aimedAt: string,
  perShot: number,
  radiusM: number,
): void {
  const { fof, setup } = context;
  for (const enemy of fof.soldiers) {
    if (fof.forces[enemy.force]?.side === shot.side) continue;
    const s = soldierOf(context, enemy);
    if (s.status !== 'active') continue;
    const d = Math.hypot(s.position.x - impact.x, s.position.y - impact.y);
    const share = s.id === aimedAt ? 1 : d < radiusM ? 1 - d / radiusM : 0;
    if (share <= 0) continue;
    const prone = s.posture === 'prone' ? setup.config.suppression.proneSuppressionFactor : 1;
    const dug = dugInFactor(
      dugInFrom(fof.forces[enemy.force] ?? null, s, shot.from),
      setup.config.force.dugInSuppressionFactor,
    );
    shot.volley.suppression.set(
      enemy,
      (shot.volley.suppression.get(enemy) ?? 0) + perShot * share * prone * dug,
    );
  }
}

/** Missiles arriving by now: each hits by its draw, unless its guidance was lost or its target gone. */
function arriveMissiles(
  context: FofContext,
  combat: CombatState,
  catalog: CombatCatalog,
  pending: PendingHit[],
): void {
  const t = context.t;
  const due = combat.missiles.filter((m) => m.impactAt <= t + 1e-9);
  if (due.length === 0) return;
  combat.missiles = combat.missiles.filter((m) => m.impactAt > t + 1e-9);
  for (const m of due) {
    const weapon = combatWeaponOf(catalog, m.weapon);
    const ammo = weapon.ammo.find((a) => a.id === m.ammo);
    const target = vehicleById(context, m.targetId);
    const u = nextFloat(context.state.rng);
    let reason: 'hit' | 'missed' | 'guidanceLost' | 'targetGone';
    let shooterAt: Vec2 = { x: m.from.x, y: m.from.y };
    if (!target || target.combat.damage.destroyed || !ammo) reason = 'targetGone';
    else {
      let guiding = true;
      if (weapon.guided?.guidedToImpact === true) {
        // The gunner must still be there and see the target.
        const sv = vehicleById(context, m.shooterId);
        const ss = soldierById(context, m.shooterId);
        if (sv) {
          shooterAt = sv.position;
          const platform = platformFor(catalog, sv);
          const launcher = platform.weapons.find((w) => w.weapon === m.weapon);
          const mount = launcher ? platform.mounts.find((x) => x.id === launcher.mount) : undefined;
          const parent = mount?.parent ? platform.mounts.find((x) => x.id === mount.parent) : mount;
          guiding =
            !sv.combat.damage.destroyed &&
            (parent ? layingFactor(parent, sv.combat) > 0 : true) &&
            vehicleSees(context, catalog, sv, {
              kind: 'vehicle',
              id: target.id,
              position: target.position,
              soldier: null,
              vehicle: target,
            }) > 0;
        } else if (ss) {
          shooterAt = ss.position;
          guiding = ss.status === 'active' && soldierSeesVehicle(context, catalog, ss, target) > 0;
        } else guiding = false;
      }
      reason = !guiding ? 'guidanceLost' : u < m.hitProbability ? 'hit' : 'missed';
    }
    const at = target ?? null;
    const impact: Vec3 = at
      ? reason === 'hit'
        ? vehicleAimPoint(at, platformFor(catalog, at))
        : {
            x: at.position.x + 8,
            y: at.position.y + 5,
            z: surfaceHeightAt(context.world.terrain, at.position.x + 8, at.position.y + 5),
          }
      : { x: m.from.x, y: m.from.y, z: m.from.z };
    context.events.push({
      type: 'missileImpact',
      tick: context.tick,
      atSeconds: t,
      missileId: m.id,
      shooterId: m.shooterId,
      targetId: m.targetId,
      hit: reason === 'hit',
      reason,
      impact,
    });
    if (reason === 'hit' && target && ammo)
      pending.push({
        target,
        shooterId: m.shooterId,
        from: shooterAt,
        weapon,
        ammo,
        rangeM: m.rangeM,
      });
  }
}

/** Resolves a hit on a vehicle: armour, damage, its crew's reaction. */
function resolvePendingHit(context: FofContext, catalog: CombatCatalog, hit: PendingHit): void {
  const v = hit.target;
  const platform = platformFor(catalog, v);
  const before: VehicleCondition = conditionOf(v.combat);
  const bearing = azimuthOf(hit.from.x - v.position.x, hit.from.y - v.position.y);
  const result = resolveHit(
    context.state.rng,
    platform,
    v.combat,
    hit.ammo,
    hit.rangeM,
    v.heading,
    bearing,
  );
  if (before !== 'destroyed') applyHit(v.combat, result, context.t, COMBAT_TUNING.burnSeconds);
  const after = conditionOf(v.combat);
  context.events.push({
    type: 'vehicleHit',
    tick: context.tick,
    atSeconds: context.t,
    vehicleId: v.id,
    byId: hit.shooterId,
    weapon: hit.weapon.id,
    ammo: hit.ammo.id,
    zone: result.zone,
    penetrationMm: result.penetrationMm,
    protectionMm: result.protectionMm,
    perforated: result.perforated,
    catastrophic: result.catastrophic,
    mobility: result.mobility,
    firepower: result.firepower,
    sensorsLost: result.sensorsLost,
    crew: result.crew,
    condition: after,
  });
  if (after !== before) {
    context.events.push({
      type: 'vehicleCondition',
      tick: context.tick,
      atSeconds: context.t,
      vehicleId: v.id,
      from: before,
      to: after,
    });
  }
  const shooterVehicle = vehicleById(context, hit.shooterId);
  const shooterSoldier = soldierById(context, hit.shooterId);
  const shooter: Target | null = shooterVehicle
    ? {
        kind: 'vehicle',
        id: shooterVehicle.id,
        position: shooterVehicle.position,
        soldier: null,
        vehicle: shooterVehicle,
      }
    : shooterSoldier
      ? {
          kind: 'soldier',
          id: shooterSoldier.id,
          position: shooterSoldier.position,
          soldier: shooterSoldier,
          vehicle: null,
        }
      : null;
  if (shooter) vehicleUnderFire(context, v, shooter);
}

// --- Anti-tank soldiers -----------------------------------------------------------

/** Phases in which a squad's anti-tank gunners fire (as its riflemen do). */
function antiTankFiring(force: FofForce): boolean {
  return (
    !force.concealed &&
    (force.phase === 'contact' ||
      force.phase === 'engaged' ||
      force.phase === 'holding' ||
      force.phase === 'withdrawing' ||
      force.phase === 'assaulting')
  );
}

/** One anti-tank gunner's decision: reload, choose a vehicle his squad sees, aim, fire. */
function antiTankFire(
  context: FofContext,
  combat: CombatState,
  catalog: CombatCatalog,
  at: AntiTankState,
  pending: PendingHit[],
): void {
  const t = context.t;
  const soldier = soldierById(context, at.soldierId);
  const member = memberOf(context, at.soldierId);
  if (soldier?.status !== 'active' || !member) {
    at.aimingAt = null;
    return;
  }
  const weapon = combatWeaponOf(catalog, at.weapon);
  if (at.reloadUntil !== null && t >= at.reloadUntil - 1e-9) {
    at.reloadUntil = null;
    if (at.reserve > 0 && at.loaded < weapon.readyCapacity) {
      at.loaded += 1;
      at.reserve -= 1;
    }
  }
  if (at.loaded <= 0) {
    if (at.reserve > 0 && at.reloadUntil === null)
      at.reloadUntil = t + drawSecondsIn(context, weapon.reloadSeconds);
    return;
  }
  const force = context.fof.forces[member.force];
  if (!force || !forceActive(force) || !antiTankFiring(force) || member.level === 'pinned') {
    at.aimingAt = null;
    return;
  }
  const config = TARGETING;
  const ammo = weapon.ammo[0];
  if (!ammo) return;
  // The vehicles his squad has confirmed, in range: the most worth it.
  let best: { v: VehicleState; utility: number; rangeM: number } | null = null;
  let kept: { v: VehicleState; utility: number; rangeM: number } | null = null;
  for (const track of context.fof.tracks) {
    if (track.force !== member.force || !track.confirmed) continue;
    if (track.level !== 'detected' && track.level !== 'identified') continue;
    const v = vehicleById(context, track.targetId);
    if (!v || v.combat.damage.destroyed || v.side === soldier.side) continue;
    if (seenKnockedOut(context, v)) continue;
    const rangeM = Math.hypot(v.position.x - soldier.position.x, v.position.y - soldier.position.y);
    if (rangeM < weapon.minRangeM || rangeM > weapon.maxRangeM) continue;
    const platform = platformFor(catalog, v);
    const zone = presentedZone(
      v.heading,
      azimuthOf(soldier.position.x - v.position.x, soldier.position.y - v.position.y),
      ammo.topAttack === true,
    );
    const effect = effectOnVehicle(weapon, ammo, platform, rangeM, zone);
    if (suitabilityOf(effect, config) === 'ineffective') continue;
    // Its threat to his squad: its best effect on a soldier.
    let threat = 0;
    for (const w of platform.weapons) {
      const ws = v.combat.weapons.find((x) => x.id === w.id);
      if (!ws || ws.disabled) continue;
      const spec = combatWeaponOf(catalog, w.weapon);
      for (const a of spec.ammo) threat = Math.max(threat, effectOnSoldier(spec, a, rangeM));
    }
    const utility = utilityOf(effect, threat, platform.targetClass, weapon.costPerShot, 0, config);
    const candidate = { v, utility, rangeM };
    if (!best || utility > best.utility + 1e-12) best = candidate;
    if (v.id === at.aimingAt) kept = candidate;
  }
  // Committed to the one he aims at unless a markedly better one appears.
  const chosen =
    kept && (!best || best.utility <= kept.utility * config.switchFactor) ? kept : best;
  if (!chosen) {
    at.aimingAt = null;
    return;
  }
  if (at.aimingAt !== chosen.v.id) {
    at.aimingAt = chosen.v.id;
    at.aimUntil = t + weapon.aimSeconds;
    return;
  }
  if (t < at.aimUntil - 1e-9 || t < at.readyAt - 1e-9) return;
  const v = chosen.v;
  const seen = soldierSeesVehicle(context, catalog, soldier, v);
  if (seen <= 0) return;
  const suppression = Math.max(
    0,
    1 - context.setup.config.suppression.accuracyLoss * member.suppression,
  );
  const steady = member.speed > 0.3 ? 0.5 : 1;
  const targetMoving = v.combat.speed > 3 ? COMBAT_TUNING.movingTargetHitFactor : 1;
  const platform = platformFor(catalog, v);
  const aim = vehicleAimPoint(v, platform);
  const eye = soldierEye(context, soldier);
  at.loaded -= 1;
  at.fired += 1;
  at.readyAt = t + drawSecondsIn(context, weapon.secondsBetweenShots);
  at.aimingAt = null;
  member.lastFiredAt = t;
  if (at.reserve > 0) at.reloadUntil = t + drawSecondsIn(context, weapon.reloadSeconds);
  const dx = v.position.x - soldier.position.x;
  const dy = v.position.y - soldier.position.y;
  if (dx !== 0 || dy !== 0) soldier.azimuth = azimuthOf(dx, dy);
  force.lastFireAt = t;
  force.firstFireAt ??= t;
  shoot(context, combat, {
    shooter: {
      kind: 'soldier',
      id: soldier.id,
      position: soldier.position,
      soldier,
      vehicle: null,
    },
    side: soldier.side,
    slot: weapon.id,
    weapon,
    ammo,
    rounds: 1,
    from: eye,
    target: { kind: 'vehicle', id: v.id, position: v.position, soldier: null, vehicle: v },
    aim,
    rangeM: chosen.rangeM,
    accuracy: seen * suppression * steady * targetMoving,
    volley: { suppression: new Map(), down: new Map() },
    pending,
  });
}
