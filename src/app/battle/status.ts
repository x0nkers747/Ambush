import { FOF_DEFAULT_CONFIG, type Battle } from '#exercise/battle';
import {
  recovered,
  spent,
  type DeepReadonly,
  type FofConfig,
  type FofForce,
  type FofOrder,
  type ForcePhase,
  type OrderSpec,
  type Side,
  type SimState,
  type Vec2,
} from '#sim';

// What the pages show of a battle's squads (docs/constructive-simulation/04,
// 05): read from a battle state, the live one (Combat) or one replayed to a
// moment (the After-Action Review). No state of its own.

/** A command given but not yet applied (its tick has not been stepped). */
export interface QueuedOrder {
  readonly squadId: string;
  readonly mode: 'replace' | 'append';
  readonly orders: readonly OrderSpec[];
  readonly tick: number;
}

/** What the page shows of a squad at a moment. */
export interface SquadStatus {
  readonly id: string;
  readonly name: string;
  readonly side: Side;
  readonly unitId: string;
  /** Where its active soldiers are on average (its start, once none is). */
  readonly centre: Vec2;
  readonly up: number;
  readonly total: number;
  readonly phase: ForcePhase;
  /** Made combat ineffective (it may since have been ordered on: it stays so). */
  readonly ineffective: boolean;
  /** What it is doing now, in a word, and why (`activityOf`). */
  readonly activity: SquadActivity;
  /** How far dug in it is (0–1) while it holds a defence; else 0. */
  readonly dugIn: number;
  /** Its soldiers' fighting positions (they stay where they were dug). */
  readonly earthworks: readonly {
    readonly soldierId: string;
    readonly x: number;
    readonly y: number;
    readonly azimuth: number;
    readonly level: number;
    /** On hard ground (paved): nothing dug, he lies prone there. */
    readonly hard: boolean;
  }[];
  readonly effectiveness: number;
  readonly active: DeepReadonly<FofOrder> | null;
  readonly pending: readonly DeepReadonly<FofOrder>[];
  /** Every order it was given, in turn. */
  readonly orders: readonly DeepReadonly<FofOrder>[];
  readonly queued: readonly QueuedOrder[];
  /**
   * Its ammunition by weapon (docs/behavior-lab/force-on-force/06): rounds
   * loaded and in reserve among its active soldiers, and how many carry it.
   */
  readonly ammunition: readonly WeaponAmmunition[];
  /** Active soldiers reloading now, and out of ammunition for their primary weapon. */
  readonly reloading: number;
  readonly outOfAmmunition: number;
}

/** What a squad is doing, in a word (shown by its name and count), and why. */
export interface SquadActivity {
  readonly word: string;
  readonly why: string;
}

const percent = (x: number) => `${String(Math.round(x * 100))} %`;

/** What a defence's dig-in looks like on the ground. */
export function digStage(dugIn: number): string {
  if (dugIn < 0.05) return 'lying in the open';
  if (dugIn < 0.5) return 'in shell scrapes';
  if (dugIn < 1) return 'in fighting pits';
  return 'in its trench';
}

/**
 * What a force is doing and why, from its state: its phase, refined by its
 * order, its actions on contact, and whether it is recovering or spent.
 */
export function activityOf(
  force: DeepReadonly<FofForce>,
  config: FofConfig = FOF_DEFAULT_CONFIG,
): SquadActivity {
  const base = phaseActivity(force, config);
  // Fighting from its defence: how far dug in it is.
  const defending = force.orders.find((o) => o.id === force.activeOrderId)?.kind === 'defend';
  const activity =
    defending && force.phase !== 'defending' && force.phase !== 'moving' && force.dugIn > 0
      ? { word: base.word, why: `${base.why} (dug in ${percent(force.dugIn)})` }
      : base;
  // Ordered on after it was made combat ineffective: it stays ineffective.
  return force.combatIneffective && force.phase !== 'ineffective'
    ? { word: activity.word, why: `${activity.why} (combat ineffective)` }
    : activity;
}

function phaseActivity(force: DeepReadonly<FofForce>, config: FofConfig): SquadActivity {
  const order = force.orders.find((o) => o.id === force.activeOrderId) ?? null;
  const tooWeak = () =>
    `its losses leave it too weak to go on (effectiveness at best ${percent(force.lastingEffectiveness)}, under ${percent(config.force.withdrawEffectiveness)}); it waits for new orders`;
  const suppressed = () =>
    `suppressed (${percent(force.meanSuppression)}): it waits for that to wear off to ${percent(config.force.resumeSuppression)}`;
  switch (force.phase) {
    case 'moving':
      if (force.pressOnUntil !== null)
        return {
          word: 'Pressing on',
          why: 'nothing to engage from where it halted: moving on, firing as it goes',
        };
      if (order?.kind === 'withdraw') return { word: 'Withdrawing', why: 'on its Withdraw order' };
      if (order?.kind === 'attack')
        return { word: 'Advancing', why: 'on its Attack order, to the objective' };
      if (order?.kind === 'ambush') return { word: 'Moving', why: 'to its ambush position' };
      if (order?.kind === 'defend') return { word: 'Moving', why: 'to its defensive position' };
      return { word: 'Moving', why: order ? 'on its Move order' : 'to where it was sent' };
    case 'possibleContact':
      return { word: 'Observing', why: 'halted to look at a possible enemy' };
    case 'contact':
      return { word: 'Reacting', why: 'in contact: halted, taking cover, finding the enemy' };
    case 'engaged':
      return {
        word: 'Engaging',
        why:
          force.actionsOn === 'attack'
            ? 'exchanging fire; it attacks once the enemy is located'
            : force.actionsOn === 'hold' || order?.kind === 'ambush'
              ? 'exchanging fire from where it is'
              : 'exchanging fire where it halted; it presses on if it has nothing to engage',
      };
    case 'assaulting':
      return { word: 'Attacking', why: 'assaulting the enemy by fire and movement' };
    case 'withdrawing':
      return force.brokenWithdrawal
        ? { word: 'Withdrawing', why: 'broken by the fight: falling back out of the enemy’s reach' }
        : force.actionsOn === 'withdraw'
          ? { word: 'Withdrawing', why: 'avoiding contact (actions on contact: Avoid)' }
          : { word: 'Withdrawing', why: 'breaking contact' };
    case 'holding':
      if (spent(force, config)) return { word: 'Spent', why: tooWeak() };
      if (force.holdUntilRecovered)
        return recovered(force, config)
          ? { word: 'Recovering', why: 'broke contact; it starts its next order now' }
          : { word: 'Recovering', why: `broke contact, ${suppressed()} before its next order` };
      if (order?.kind === 'ambush')
        return { word: 'Holding', why: 'the ambush is over; it waits in place for new orders' };
      if (force.actionsOn === 'hold')
        return { word: 'Holding', why: 'contact lost; on Hold it waits for new orders' };
      if (force.actionsOn === 'withdraw')
        return { word: 'Holding', why: 'fell back from contact; it waits for new orders' };
      if (!order) return { word: 'Holding', why: 'contact lost; it has no more orders' };
      return recovered(force, config)
        ? { word: 'Regrouping', why: 'contact lost; it resumes its order shortly' }
        : { word: 'Recovering', why: `contact lost, ${suppressed()} before resuming its order` };
    case 'atObjective':
      if (spent(force, config)) return { word: 'Spent', why: tooWeak() };
      return order
        ? {
            word: 'Holding',
            why: `on the objective of its ${order.kind === 'attack' ? 'Attack' : 'order'}`,
          }
        : { word: 'Holding', why: 'arrived; it has no more orders' };
    case 'defending':
      return {
        word: `Defending ${percent(force.dugIn).replace(' ', '')}`,
        why:
          force.dugIn >= 1
            ? 'in its defensive position: fully dug in, standing in its trench'
            : `in its defensive position, digging in: ${percent(force.dugIn)} (${digStage(force.dugIn)})`,
      };
    case 'inAmbush':
      return force.concealed
        ? { word: 'Waiting', why: 'in ambush: concealed, watching its kill zone' }
        : { word: 'Deploying', why: 'occupying its ambush position' };
    case 'withdrawn':
      return { word: 'Withdrawn', why: 'broke contact and withdrew: out of the fight' };
    case 'ineffective':
      return {
        word: 'Ineffective',
        why: 'combat ineffective: too few fit to fight; it waits for new orders',
      };
  }
}

/** A squad's rounds of one weapon. */
export interface WeaponAmmunition {
  readonly weapon: string;
  readonly loaded: number;
  readonly reserve: number;
  readonly carriers: number;
}

export interface BattleSummary {
  readonly seconds: number;
  readonly sides: readonly {
    readonly side: Side;
    readonly soldiers: number;
    readonly casualties: number;
    readonly squads: number;
    readonly ineffective: number;
  }[];
  readonly orders: { readonly completed: number; readonly failed: number; readonly given: number };
}

/** Squad `id` of `battle` in `state` (by default the battle's own), or `undefined`. */
export function squadStatus(
  battle: Pick<Battle, 'squads'>,
  state: DeepReadonly<SimState>,
  id: string,
  queued: readonly QueuedOrder[] = [],
  config: FofConfig = FOF_DEFAULT_CONFIG,
): SquadStatus | undefined {
  const squad = battle.squads.find((s) => s.spec.id === id);
  if (!squad) return undefined;
  const force: DeepReadonly<FofForce> | undefined = state.fof?.forces.find(
    (f) => f.unitId === squad.unitId,
  );
  const members = new Set<string>(squad.soldierIds);
  const soldiers = state.soldiers.filter((s) => members.has(s.id));
  const up = soldiers.filter((s) => s.status === 'active');
  const centre =
    up.length > 0
      ? {
          x: up.reduce((a, s) => a + s.position.x, 0) / up.length,
          y: up.reduce((a, s) => a + s.position.y, 0) / up.length,
        }
      : squad.spec.position;
  const orders = force?.orders ?? [];
  const active = new Set<string>(up.map((s) => s.id));
  const ammunition = new Map<string, { loaded: number; reserve: number; carriers: number }>();
  let reloading = 0;
  let outOfAmmunition = 0;
  for (const m of state.fof?.soldiers ?? []) {
    if (!active.has(m.soldierId)) continue;
    if (m.reloadUntil !== null) reloading += 1;
    const primary = m.arms[0];
    if (primary && primary.loaded + primary.reserve === 0) outOfAmmunition += 1;
    for (const a of m.arms) {
      const w = ammunition.get(a.id) ?? { loaded: 0, reserve: 0, carriers: 0 };
      ammunition.set(a.id, {
        loaded: w.loaded + a.loaded,
        reserve: w.reserve + a.reserve,
        carriers: w.carriers + 1,
      });
    }
  }
  return {
    id,
    name: squad.name,
    side: squad.side,
    unitId: squad.unitId,
    centre,
    up: up.length,
    total: soldiers.length,
    phase: force?.phase ?? 'holding',
    ineffective: force ? force.combatIneffective || force.phase === 'ineffective' : false,
    activity: force ? activityOf(force, config) : { word: 'Holding', why: 'not yet started' },
    dugIn:
      force && force.orders.find((o) => o.id === force.activeOrderId)?.kind === 'defend'
        ? force.dugIn
        : 0,
    earthworks: force?.earthworks ?? [],
    effectiveness: force?.effectiveness ?? 0,
    active: orders.find((x) => x.id === force?.activeOrderId) ?? null,
    pending: orders.filter((x) => x.status === 'pending'),
    orders,
    queued: queued.filter((q) => q.squadId === id),
    ammunition: [...ammunition.entries()].map(([weapon, a]) => ({ weapon, ...a })),
    reloading,
    outOfAmmunition,
  };
}

/** Every squad of `battle` in `state`. */
export function squadStatuses(
  battle: Pick<Battle, 'squads'>,
  state: DeepReadonly<SimState>,
  queued: readonly QueuedOrder[] = [],
): SquadStatus[] {
  return battle.squads.flatMap((s) => squadStatus(battle, state, s.spec.id, queued) ?? []);
}

/** The battle's results by side, at `seconds`, from its squads then. */
export function summarize(squads: readonly SquadStatus[], seconds: number): BattleSummary {
  const sides = (['BLUEFOR', 'OPFOR'] as const).map((side) => {
    const list = squads.filter((s) => s.side === side);
    const soldiers = list.reduce((n, s) => n + s.total, 0);
    return {
      side,
      soldiers,
      casualties: soldiers - list.reduce((n, s) => n + s.up, 0),
      squads: list.length,
      ineffective: list.filter((s) => s.ineffective).length,
    };
  });
  const all = squads.flatMap((s) => s.orders);
  return {
    seconds,
    sides,
    orders: {
      given: all.length,
      completed: all.filter((x) => x.status === 'completed').length,
      failed: all.filter((x) => x.status === 'failed').length,
    },
  };
}

/** What the page shows of a vehicle at a moment (docs/vehicles.md). */
export interface VehicleStatus {
  readonly id: string;
  readonly name: string;
  readonly side: Side;
  readonly position: Vec2;
  /** Radians clockwise from grid north. */
  readonly heading: number;
  /** m/s. */
  readonly speed: number;
  /** Where it still drives: its active order's destination, then the pending ones. */
  readonly route: readonly Vec2[];
}

/** The vehicles of a battle state. */
export function vehicleStatuses(state: DeepReadonly<SimState>): VehicleStatus[] {
  return (state.vehicles ?? []).map((v) => ({
    id: v.id,
    name: v.name,
    side: v.side,
    position: { x: v.position.x, y: v.position.y },
    heading: v.heading,
    speed: v.speed,
    route: v.orders
      .filter((o) => o.status === 'active' || o.status === 'pending')
      .map((o) => ({ x: o.destination.x, y: o.destination.y })),
  }));
}

/** A vehicle's activity in words: "Driving 28 km/h", "Stopped". */
export function vehicleActivity(v: VehicleStatus): string {
  const kmh = Math.round(v.speed * 3.6);
  if (kmh >= 1) return `Driving ${String(kmh)} km/h`;
  return v.route.length > 0 ? 'Turning' : 'Stopped';
}
