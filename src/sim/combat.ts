import {
  hitProbabilityAt,
  weaponCombatProfile,
  type CombatConfig,
  type UniformSeconds,
  type WeaponCombatProfile,
} from './combat-config';
import type { BeginEngagementCommand } from './commands';
import type { SimEvent } from './events';
import { azimuthOf, normalizeAzimuth, type Vec2 } from './geometry';
import { lineOfSight } from './los';
import type { TickTime } from './movement';
import { planPath, pointProblem } from './navigation';
import { nextFloat, type RngState } from './rng';
import {
  waypointId,
  type Combatant,
  type CombatantStats,
  type DeepReadonly,
  type EngagementEndReason,
  type EngagementState,
  type OpforReaction,
  type Side,
  type SimState,
  type Soldier,
  type SoldierId,
} from './state';
import type { TerrainDataset } from './terrain';
import type { CombatSetup, SimWorld } from './world';

// Combat v1 (docs/adr/0019): probabilistic, two-sided shot-event combat.
//
// A shot is one firing opportunity, not a bullet. Each armed soldier has the
// time of its next opportunity in seconds; when it comes, the soldier picks a
// valid target (see `selectTarget`), rolls a hit with the probability of its
// weapon's curve at the target's range times the target's posture multiplier,
// and on a hit rolls incapacitation. Every roll comes from `SimState.rng`, in
// the order the opportunities happen, so a seed decides the outcome.
//
// Timing: within a tick, reactions and shots are resolved one at a time in
// order of their exact time; simultaneous ones in a fixed order (reactions
// before shots, then scenario soldier order). A soldier incapacitated by an
// earlier shot does not fire later. All of this depends on simulation seconds
// only, never on frames or playback speed. Positions are those at the end of
// the tick (after movement), so a tick is the resolution of where soldiers
// are, not of when they act.

/**
 * Directions a fleeing soldier tries, in order, in degrees from straight away
 * from the threat. The first with a walkable route is taken (docs/adr/0019).
 * A fixed escape-direction policy, not a balance parameter.
 */
export const FLEE_HEADING_OFFSETS_DEG: readonly number[] = [0, 30, -30, 60, -60, 90, -90];
/** A flee destination is kept at least this far inside the edge of the terrain. */
export const FLEE_EDGE_MARGIN_M = 5;
/** A flee destination closer than this (cut short by the map edge) is not tried. */
const MIN_FLEE_DISTANCE_M = 10;
/** Absorbs rounding when comparing event times with the end of a tick. */
const TIME_EPSILON_SECONDS = 1e-9;

/** Starts the engagement at `startSeconds` (the start of the command's tick). */
export function beginEngagement(
  state: SimState,
  world: SimWorld,
  command: BeginEngagementCommand,
  startSeconds: number,
  events: SimEvent[],
): void {
  const combat = world.combat;
  if (!combat) {
    events.push({ type: 'commandRejected', tick: state.tick, command, reason: 'noCombatModel' });
    return;
  }
  if (state.engagement) {
    events.push({
      type: 'commandRejected',
      tick: state.tick,
      command,
      reason: 'engagementAlreadyBegun',
    });
    return;
  }
  const { config } = combat;
  // Draws in soldier order: per BLUEFOR soldier able to fire, its first-shot
  // delay; per OPFOR soldier, its reaction and then its reaction delay.
  const combatants = state.soldiers.map((soldier): Combatant => {
    const weapon = combat.weapons[soldier.id] ?? null;
    const active = soldier.status === 'active';
    const base = {
      soldierId: soldier.id,
      side: soldier.side,
      weaponProfileRef: weapon,
      fleeBlocked: false,
      outAtSeconds: null,
      stats: { shotsFired: 0, hits: 0, incapacitations: 0, timesHit: 0 },
    };
    if (!active) {
      return {
        ...base,
        behavior: 'incapacitated',
        reaction: null,
        reactAtSeconds: null,
        nextShotSeconds: null,
      };
    }
    if (soldier.side === 'BLUEFOR') {
      return {
        ...base,
        behavior: 'engaging',
        reaction: null,
        reactAtSeconds: null,
        nextShotSeconds:
          weapon === null
            ? null
            : startSeconds + uniform(state.rng, config.engagement.bluforFirstShotDelay),
      };
    }
    const reaction: OpforReaction =
      nextFloat(state.rng) < config.opfor.reactionProbabilities.prone ? 'prone' : 'flee';
    return {
      ...base,
      behavior: 'awaitingReaction',
      reaction,
      reactAtSeconds: startSeconds + uniform(state.rng, config.opfor.reactionDelay),
      nextShotSeconds: null,
    };
  });
  state.engagement = {
    startTick: state.tick,
    startSeconds,
    endsBySeconds: startSeconds + config.engagement.maxDurationSeconds,
    combatants,
    end: null,
  };
  events.push({ type: 'engagementStarted', tick: state.tick, atSeconds: startSeconds });
}

/**
 * The combat system: resolves the tick's reactions and firing opportunities
 * in time order, then escapes, then whether the engagement has ended.
 */
export function resolveCombat(
  state: SimState,
  world: SimWorld,
  time: TickTime,
  events: SimEvent[],
): void {
  const engagement = state.engagement;
  const combat = world.combat;
  if (!engagement || engagement.end || !combat) return;
  const tickEnd = time.startSeconds + time.dtSeconds;
  // Nothing happens at or after the time limit.
  const limit = Math.min(tickEnd, engagement.endsBySeconds);
  const context: Context = { state, world, combat, engagement, tick: time.tick, events };

  for (;;) {
    const next = nextAction(state, engagement, limit);
    if (next === null) break;
    if (next.kind === 'react') react(context, next.index, next.atSeconds);
    else fire(context, next.index, next.atSeconds);
  }
  checkEscapes(context, tickEnd);

  const reason = endReason(state, engagement, tickEnd);
  if (reason !== null) {
    engagement.end = { tick: time.tick, atSeconds: tickEnd, reason };
    events.push({ type: 'engagementEnded', tick: time.tick, atSeconds: tickEnd, reason });
  }
}

interface Context {
  readonly state: SimState;
  readonly world: SimWorld;
  readonly combat: CombatSetup;
  readonly engagement: EngagementState;
  readonly tick: number;
  readonly events: SimEvent[];
}

interface Action {
  kind: 'react' | 'fire';
  index: number;
  atSeconds: number;
}

/** The earliest due reaction or shot before `limit`: by time, then reactions first, then soldier order. */
function nextAction(state: SimState, engagement: EngagementState, limit: number): Action | null {
  let best: Action | null = null;
  const consider = (kind: Action['kind'], index: number, atSeconds: number) => {
    if (!(atSeconds < limit)) return;
    if (
      best === null ||
      atSeconds < best.atSeconds ||
      (atSeconds === best.atSeconds && kind === 'react' && best.kind === 'fire')
    ) {
      best = { kind, index, atSeconds };
    }
  };
  engagement.combatants.forEach((c, index) => {
    if (state.soldiers[index]?.status !== 'active') return;
    if (c.behavior === 'awaitingReaction' && c.reactAtSeconds !== null) {
      consider('react', index, c.reactAtSeconds);
    } else if (
      (c.behavior === 'engaging' || c.behavior === 'prone') &&
      c.nextShotSeconds !== null
    ) {
      consider('fire', index, c.nextShotSeconds);
    }
  });
  return best;
}

function soldierAt(state: SimState, index: number): Soldier {
  const soldier = state.soldiers[index];
  if (!soldier) throw new Error(`combatant ${String(index)} has no soldier`);
  return soldier;
}

function combatantAt(engagement: EngagementState, index: number): Combatant {
  const combatant = engagement.combatants[index];
  if (!combatant) throw new Error(`no combatant ${String(index)}`);
  return combatant;
}

/** An OPFOR soldier's reaction comes due: drop prone, or flee (prone when no route away exists). */
function react(context: Context, index: number, atSeconds: number): void {
  const { state, world, combat, engagement, tick, events } = context;
  const soldier = soldierAt(state, index);
  const combatant = combatantAt(engagement, index);
  const config = combat.config;
  const threat = threatPoint(state, soldier.side);

  if (combatant.reaction === 'flee') {
    const route = fleeRoute(world, soldier, threat, config);
    if (route) {
      soldier.orders = {
        orders: {
          waypoints: [{ id: waypointId(`${soldier.id}.flee`), ...route.destination }],
          finalFacing: route.heading,
        },
        nextWaypointIndex: 0,
        behavior: 'moving',
        legPaths: [route.turns],
        nextTurnIndex: 0,
        speed: config.opfor.fleeSpeedMps,
      };
      combatant.behavior = 'fleeing';
      events.push({
        type: 'opforReacted',
        tick,
        atSeconds,
        soldierId: soldier.id,
        reaction: 'flee',
        fleeBlocked: false,
        destination: { ...route.destination },
        speed: config.opfor.fleeSpeedMps,
      });
      return;
    }
    // No walkable route away: the soldier goes to ground where it is instead.
    combatant.fleeBlocked = true;
  }

  soldier.orders = null;
  soldier.posture = 'prone';
  if (threat) {
    const dx = threat.x - soldier.position.x;
    const dy = threat.y - soldier.position.y;
    if (dx !== 0 || dy !== 0) soldier.azimuth = azimuthOf(dx, dy);
  }
  combatant.behavior = 'prone';
  combatant.nextShotSeconds =
    combatant.weaponProfileRef === null ? null : atSeconds + config.opfor.returnFireDelaySeconds;
  events.push({
    type: 'opforReacted',
    tick,
    atSeconds,
    soldierId: soldier.id,
    reaction: combatant.reaction ?? 'prone',
    fleeBlocked: combatant.fleeBlocked,
    destination: null,
    speed: null,
  });
}

/** Where a soldier perceives the threat: the centroid of the active enemy soldiers, or `null`. */
function threatPoint(state: SimState, side: Side): Vec2 | null {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const s of state.soldiers) {
    if (s.side === side || s.status !== 'active') continue;
    x += s.position.x;
    y += s.position.y;
    n += 1;
  }
  return n === 0 ? null : { x: x / n, y: y / n };
}

/**
 * Where a fleeing soldier runs: `fleeDistanceM` away along the first heading
 * of `FLEE_HEADING_OFFSETS_DEG` (from straight away from the threat, or from
 * straight behind the soldier when there is none) whose destination is open
 * ground the soldier can walk to. Destinations are cut short at the terrain
 * edge. `null` when no heading works.
 */
function fleeRoute(
  world: SimWorld,
  soldier: Soldier,
  threat: Vec2 | null,
  config: CombatConfig,
): { destination: Vec2; turns: Vec2[]; heading: number } | null {
  const from = { x: soldier.position.x, y: soldier.position.y };
  const dx = threat ? from.x - threat.x : 0;
  const dy = threat ? from.y - threat.y : 0;
  const away =
    dx !== 0 || dy !== 0 ? azimuthOf(dx, dy) : normalizeAzimuth(soldier.azimuth + Math.PI);
  const bounds = heightfieldBounds(world.terrain, FLEE_EDGE_MARGIN_M);
  for (const offset of FLEE_HEADING_OFFSETS_DEG) {
    const heading = normalizeAzimuth(away + (offset * Math.PI) / 180);
    const ux = Math.sin(heading);
    const uy = Math.cos(heading);
    const distance = Math.min(config.opfor.fleeDistanceM, distanceToEdge(bounds, from, ux, uy));
    if (distance < MIN_FLEE_DISTANCE_M) continue;
    const destination = { x: from.x + ux * distance, y: from.y + uy * distance };
    if (pointProblem(world.terrain, destination)) continue;
    const path = planPath(world.terrain, from, destination);
    if (!path.ok) continue;
    return { destination, turns: path.turns.map((p) => ({ x: p.x, y: p.y })), heading };
  }
  return null;
}

interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** The terrain's extent, shrunk by `margin` on every side. */
function heightfieldBounds(terrain: TerrainDataset, margin: number): Bounds {
  const { originX, originY, cellSize, columns, rows } = terrain.heightfield;
  return {
    minX: originX + margin,
    maxX: originX + (columns - 1) * cellSize - margin,
    minY: originY + margin,
    maxY: originY + (rows - 1) * cellSize - margin,
  };
}

/** How far from `from` along the unit vector (ux, uy) the bounds extend. */
function distanceToEdge(bounds: Bounds, from: Vec2, ux: number, uy: number): number {
  let t = Infinity;
  if (ux > 0) t = Math.min(t, (bounds.maxX - from.x) / ux);
  if (ux < 0) t = Math.min(t, (bounds.minX - from.x) / ux);
  if (uy > 0) t = Math.min(t, (bounds.maxY - from.y) / uy);
  if (uy < 0) t = Math.min(t, (bounds.minY - from.y) / uy);
  return Math.max(0, t);
}

/** A firing opportunity comes due: shoot at a valid target, or look again later. */
function fire(context: Context, index: number, atSeconds: number): void {
  const { state, world, combat, engagement, tick, events } = context;
  const shooter = soldierAt(state, index);
  const combatant = combatantAt(engagement, index);
  const ref = combatant.weaponProfileRef;
  const weapon = ref === null ? undefined : weaponCombatProfile(combat.config, ref);
  if (ref === null || !weapon) {
    combatant.nextShotSeconds = null;
    return;
  }
  const target = selectTarget(state, world, engagement, index, weapon);
  if (target === null) {
    combatant.nextShotSeconds = atSeconds + combat.config.engagement.targetRecheckSeconds;
    return;
  }
  const victim = soldierAt(state, target.index);
  const victimCombatant = combatantAt(engagement, target.index);
  const dx = victim.position.x - shooter.position.x;
  const dy = victim.position.y - shooter.position.y;
  if (dx !== 0 || dy !== 0) shooter.azimuth = azimuthOf(dx, dy);

  const hitProbability =
    hitProbabilityAt(weapon, target.rangeM) * combat.config.postureHitMultipliers[victim.posture];
  const hit = nextFloat(state.rng) < hitProbability;
  const incapacitated = hit && nextFloat(state.rng) < weapon.incapacitationProbabilityOnHit;

  combatant.stats.shotsFired += 1;
  if (hit) {
    combatant.stats.hits += 1;
    victimCombatant.stats.timesHit += 1;
  }
  events.push({
    type: 'shotFired',
    tick,
    atSeconds,
    shooterId: shooter.id,
    shooterSide: shooter.side,
    targetId: victim.id,
    weaponProfileRef: ref,
    rangeM: target.rangeM,
    hitProbability,
    hit,
    incapacitated,
  });
  if (incapacitated) {
    combatant.stats.incapacitations += 1;
    victim.status = 'incapacitated';
    victim.orders = null;
    victimCombatant.behavior = 'incapacitated';
    victimCombatant.nextShotSeconds = null;
    victimCombatant.outAtSeconds = atSeconds;
    events.push({
      type: 'soldierIncapacitated',
      tick,
      atSeconds,
      soldierId: victim.id,
      byId: shooter.id,
    });
  }
  combatant.nextShotSeconds = atSeconds + weapon.secondsBetweenShots;
}

/**
 * The shooter's target under its side's policy, or `null`. Valid targets are
 * active enemy soldiers that have not escaped, within the weapon's maximum
 * engagement range (horizontal distance), with a clear line of sight from the
 * shooter (`lineOfSight`, standing eye and target heights). The shooter's
 * facing plays no part: the planning map's engagement wedge does not restrict fire.
 *
 * `nearest`: the closest valid target; on equal range, the first in soldier order.
 */
function selectTarget(
  state: SimState,
  world: SimWorld,
  engagement: EngagementState,
  shooterIndex: number,
  weapon: WeaponCombatProfile,
): { index: number; rangeM: number } | null {
  const shooter = soldierAt(state, shooterIndex);
  const candidates: { index: number; rangeM: number }[] = [];
  state.soldiers.forEach((s, index) => {
    if (s.side === shooter.side || s.status !== 'active') return;
    if (engagement.combatants[index]?.behavior === 'escaped') return;
    const rangeM = Math.hypot(s.position.x - shooter.position.x, s.position.y - shooter.position.y);
    if (rangeM <= weapon.maxEngagementRangeM) candidates.push({ index, rangeM });
  });
  // The only policy in v1 is `nearest` (validated with the configuration).
  candidates.sort((a, b) => a.rangeM - b.rangeM || a.index - b.index);
  for (const candidate of candidates) {
    const target = soldierAt(state, candidate.index);
    if (lineOfSight(world.terrain, shooter.position, target.position).clear) return candidate;
  }
  return null;
}

/**
 * Fleeing soldiers escape at the end of the tick once out of the fight: at
 * least `escapeDistanceM` from every active enemy, and no active, armed
 * enemy could engage them (within its weapon's maximum engagement range with
 * a clear line of sight). Reaching the flee destination is also an escape.
 */
function checkEscapes(context: Context, tickEnd: number): void {
  const { state, world, combat, engagement, tick, events } = context;
  engagement.combatants.forEach((c, index) => {
    const soldier = state.soldiers[index];
    if (c.behavior !== 'fleeing' || soldier?.status !== 'active') return;
    const arrived = soldier.orders?.behavior !== 'moving';
    if (!arrived && !outOfTheFight(state, world, combat, soldier)) return;
    soldier.orders = null;
    c.behavior = 'escaped';
    c.outAtSeconds = tickEnd;
    events.push({ type: 'soldierEscaped', tick, atSeconds: tickEnd, soldierId: soldier.id });
  });
}

function outOfTheFight(
  state: SimState,
  world: SimWorld,
  combat: CombatSetup,
  soldier: Soldier,
): boolean {
  const enemies = state.soldiers.filter((s) => s.side !== soldier.side && s.status === 'active');
  if (enemies.length === 0) return false;
  const range = (s: Soldier) =>
    Math.hypot(s.position.x - soldier.position.x, s.position.y - soldier.position.y);
  // Distances first: line of sight is only traced once the soldier is far enough from everyone.
  if (enemies.some((s) => range(s) < combat.config.opfor.escapeDistanceM)) return false;
  return !enemies.some((s) => {
    const ref = combat.weapons[s.id] ?? null;
    const weapon = ref === null ? undefined : weaponCombatProfile(combat.config, ref);
    return (
      weapon !== undefined &&
      range(s) <= weapon.maxEngagementRangeM &&
      lineOfSight(world.terrain, s.position, soldier.position).clear
    );
  });
}

/**
 * Whether a combatant can still fire: active, armed, and engaging, prone, or
 * yet to react. Fleeing and escaped soldiers cannot.
 */
export function isCombatCapable(combatant: Combatant, soldier: Soldier): boolean {
  return (
    soldier.status === 'active' &&
    combatant.weaponProfileRef !== null &&
    (combatant.behavior === 'engaging' ||
      combatant.behavior === 'prone' ||
      combatant.behavior === 'awaitingReaction')
  );
}

function endReason(
  state: SimState,
  engagement: EngagementState,
  tickEnd: number,
): EngagementEndReason | null {
  const out = (c: Combatant) => c.behavior === 'incapacitated';
  const opfor = engagement.combatants.filter((c) => c.side === 'OPFOR');
  const blufor = engagement.combatants.filter((c) => c.side === 'BLUEFOR');
  if (opfor.length > 0 && opfor.every(out)) return 'allOpforIncapacitated';
  if (
    opfor.some((c) => c.behavior === 'escaped') &&
    opfor.every((c) => out(c) || c.behavior === 'escaped')
  ) {
    return 'opforEscaped';
  }
  if (blufor.length > 0 && blufor.every(out)) return 'allBluforIncapacitated';
  const capable = engagement.combatants.some((c, i) => {
    const soldier = state.soldiers[i];
    return soldier !== undefined && isCombatCapable(c, soldier);
  });
  if (!capable) return 'noCombatCapable';
  if (tickEnd >= engagement.endsBySeconds - TIME_EPSILON_SECONDS) return 'timeLimit';
  return null;
}

function uniform(rng: RngState, range: UniformSeconds): number {
  return range.minSeconds + nextFloat(rng) * (range.maxSeconds - range.minSeconds);
}

/** One side's totals in an engagement. */
export interface SideCombatSummary {
  readonly startingStrength: number;
  readonly incapacitated: number;
  readonly escaped: number;
  /** Neither incapacitated nor escaped. */
  readonly survivingNotEscaped: number;
  readonly shotsFired: number;
  readonly hits: number;
  /** Enemies this side incapacitated. */
  readonly incapacitations: number;
}

/** One soldier's part in an engagement. */
export interface SoldierCombatSummary {
  readonly soldierId: SoldierId;
  readonly side: Side;
  readonly weaponProfileRef: string | null;
  readonly reaction: OpforReaction | null;
  readonly fleeBlocked: boolean;
  readonly outcome: 'active' | 'incapacitated' | 'escaped';
  /** When the soldier was incapacitated or escaped. */
  readonly outAtSeconds: number | null;
  readonly stats: Readonly<CombatantStats>;
}

/** The facts of an engagement, from simulation state (docs/adr/0019). */
export interface EngagementSummary {
  readonly startTick: number;
  readonly startSeconds: number;
  /** `null` while the engagement is still running. */
  readonly endSeconds: number | null;
  readonly durationSeconds: number | null;
  readonly endReason: EngagementEndReason | null;
  readonly sides: Readonly<Record<Side, SideCombatSummary>>;
  readonly soldiers: readonly SoldierCombatSummary[];
}

export function summarizeEngagement(engagement: DeepReadonly<EngagementState>): EngagementSummary {
  const soldiers = engagement.combatants.map((c): SoldierCombatSummary => ({
    soldierId: c.soldierId,
    side: c.side,
    weaponProfileRef: c.weaponProfileRef,
    reaction: c.reaction,
    fleeBlocked: c.fleeBlocked,
    outcome:
      c.behavior === 'incapacitated'
        ? 'incapacitated'
        : c.behavior === 'escaped'
          ? 'escaped'
          : 'active',
    outAtSeconds: c.outAtSeconds,
    stats: { ...c.stats },
  }));
  const side = (which: Side): SideCombatSummary => {
    const own = soldiers.filter((s) => s.side === which);
    const count = (outcome: SoldierCombatSummary['outcome']) =>
      own.filter((s) => s.outcome === outcome).length;
    const sum = (key: keyof CombatantStats) => own.reduce((n, s) => n + s.stats[key], 0);
    return {
      startingStrength: own.length,
      incapacitated: count('incapacitated'),
      escaped: count('escaped'),
      survivingNotEscaped: count('active'),
      shotsFired: sum('shotsFired'),
      hits: sum('hits'),
      incapacitations: sum('incapacitations'),
    };
  };
  const end = engagement.end;
  return {
    startTick: engagement.startTick,
    startSeconds: engagement.startSeconds,
    endSeconds: end?.atSeconds ?? null,
    durationSeconds: end ? end.atSeconds - engagement.startSeconds : null,
    endReason: end?.reason ?? null,
    sides: { BLUEFOR: side('BLUEFOR'), OPFOR: side('OPFOR') },
    soldiers,
  };
}
