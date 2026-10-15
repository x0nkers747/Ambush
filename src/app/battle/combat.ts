import {
  battleSpecOf,
  ORDER_LABELS,
  placeDestination,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import type {
  DeepReadonly,
  FofForce,
  FofOrder,
  ForcePhase,
  OrderKind,
  OrderSpec,
  Side,
  SimEvent,
  TerrainDataset,
  Vec2,
} from '#sim';
import { BATTLE_TICK_RATE_HZ } from './planner';
import { createBattleSession, type BattleSession } from './session';

// The Combat stage (docs/constructive-simulation/04), without the page: the
// battle the scenario makes, its clock (play, pause, speed), live orders to
// the squads of either side, and what the page shows of each squad. The
// battle never ends by itself: the user ends it.
//
// Orders are the `orderSquad` command: Replace ends the squad's active and
// pending orders and starts on the new one; Append adds it after the
// pending ones. A command given now applies at the next tick, in the order
// given, so orders given while paused take effect, in turn, when play resumes.

export const COMBAT_SPEEDS = [0.5, 1, 2, 4, 8, 16, 32] as const;
export type CombatSpeed = (typeof COMBAT_SPEEDS)[number];

/** A command given but not yet applied (its tick has not been stepped). */
export interface QueuedOrder {
  readonly squadId: string;
  readonly mode: 'replace' | 'append';
  readonly orders: readonly OrderSpec[];
  readonly tick: number;
}

/** What the page shows of a squad now. */
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
  readonly effectiveness: number;
  readonly active: DeepReadonly<FofOrder> | null;
  readonly pending: readonly DeepReadonly<FofOrder>[];
  /** Every order it was given, in turn. */
  readonly orders: readonly DeepReadonly<FofOrder>[];
  readonly queued: readonly QueuedOrder[];
}

export interface CombatSummary {
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

export interface Combat {
  readonly session: BattleSession;
  readonly playing: boolean;
  readonly speed: CombatSpeed;
  readonly ended: boolean;
  /** The time drawn: simulation seconds, smooth between ticks (never ahead of the battle). */
  readonly renderSeconds: number;
  play(): void;
  pause(): void;
  setSpeed(speed: CombatSpeed): void;
  /**
   * The page's frame: moves the clock on by `dtSeconds` of real time at the
   * speed, while playing, and steps the battle toward it. Returns the
   * events of the ticks stepped.
   */
  frame(dtSeconds: number): SimEvent[];
  /** Orders a squad to `point` (snapped clear of water and buildings). `true` when given. */
  order(squadId: string, kind: OrderKind, point: Vec2, mode: 'replace' | 'append'): boolean;
  /** Clears a squad's orders: it holds where it is. */
  hold(squadId: string): void;
  squads(): readonly SquadStatus[];
  squad(id: string | null): SquadStatus | undefined;
  /** Ends the battle (for good): the clock stops. */
  end(): void;
  summary(): CombatSummary;
}

export interface CombatOptions {
  readonly terrain: TerrainDataset;
  readonly definition: BattleScenarioDefinition;
  readonly notify: (message: string) => void;
  /** How long a frame may step the battle (ms; default `ADVANCE_BUDGET_MS`). */
  readonly stepBudgetMs?: number;
}

/** Lead the drawn time keeps behind the clock while the battle catches up (s of simulation). */
const MAX_LAG_SECONDS = 2;

export function createCombat(o: CombatOptions): Combat {
  const spec = battleSpecOf(o.definition, BATTLE_TICK_RATE_HZ);
  const session = createBattleSession(spec, o.terrain);
  const battle = session.battle;
  const rate = spec.tickRateHz;
  let playing = false;
  let speed: CombatSpeed = 1;
  let ended = false;
  /** The clock: where play has got to (simulation seconds). */
  let clock = 0;
  let queued: QueuedOrder[] = [];

  const byId = new Map(battle.squads.map((s) => [s.spec.id, s]));
  const forceOf = (unitId: string): DeepReadonly<FofForce> | undefined =>
    battle.sim.state.fof?.forces.find((f) => f.unitId === unitId);

  const statusOf = (id: string): SquadStatus | undefined => {
    const squad = byId.get(id);
    if (!squad) return undefined;
    const force = forceOf(squad.unitId);
    const members = new Set(squad.soldierIds);
    const soldiers = battle.sim.state.soldiers.filter((s) => members.has(s.id));
    const up = soldiers.filter((s) => s.status === 'active');
    const centre =
      up.length > 0
        ? {
            x: up.reduce((a, s) => a + s.position.x, 0) / up.length,
            y: up.reduce((a, s) => a + s.position.y, 0) / up.length,
          }
        : squad.spec.position;
    const orders = force?.orders ?? [];
    return {
      id,
      name: squad.name,
      side: squad.side,
      unitId: squad.unitId,
      centre,
      up: up.length,
      total: soldiers.length,
      phase: force?.phase ?? 'holding',
      effectiveness: force?.effectiveness ?? 0,
      active: orders.find((x) => x.id === force?.activeOrderId) ?? null,
      pending: orders.filter((x) => x.status === 'pending'),
      orders,
      queued: queued.filter((q) => q.squadId === id),
    };
  };

  const combat: Combat = {
    session,
    get playing() {
      return playing;
    },
    get speed() {
      return speed;
    },
    get ended() {
      return ended;
    },
    get renderSeconds() {
      return Math.min(clock, session.seconds);
    },
    play() {
      if (!ended) playing = true;
    },
    pause() {
      playing = false;
    },
    setSpeed(next) {
      speed = next;
    },
    frame(dtSeconds) {
      if (ended) return [];
      if (playing) {
        clock += Math.max(0, Math.min(dtSeconds, 0.25)) * speed;
        // Never run away from a battle that cannot keep up.
        clock = Math.min(clock, session.seconds + MAX_LAG_SECONDS);
      } else clock = Math.min(clock, session.seconds);
      const target = Math.ceil(clock * rate);
      const events = session.advance(target, o.stepBudgetMs);
      if (queued.length > 0) queued = queued.filter((q) => q.tick >= session.tick);
      for (const event of events) {
        if (event.type === 'commandRejected') {
          const reason =
            {
              unitIneffective: 'the squad is combat ineffective',
              destinationOffTerrain: 'the destination is off the map',
              unknownUnit: 'there is no such squad',
              noForceModel: 'the battle has no force model',
            }[event.reason as string] ?? event.reason;
          o.notify(`Order refused: ${reason}.`);
        }
      }
      return events;
    },
    order(squadId, kind, point, mode) {
      const squad = byId.get(squadId);
      if (ended || !squad) return false;
      const placed = placeDestination(o.terrain, point);
      if ('problem' in placed) {
        o.notify(placed.problem);
        return false;
      }
      if (placed.note !== undefined) o.notify(placed.note);
      const orders: OrderSpec[] = [{ kind, destination: placed.point }];
      session.submit({
        type: 'orderSquad',
        tick: session.tick,
        unitId: squad.unitId,
        mode,
        orders,
      });
      queued.push({ squadId, mode, orders, tick: session.tick });
      return true;
    },
    hold(squadId) {
      const squad = byId.get(squadId);
      if (ended || !squad) return;
      session.submit({
        type: 'orderSquad',
        tick: session.tick,
        unitId: squad.unitId,
        mode: 'replace',
        orders: [],
      });
      queued.push({ squadId, mode: 'replace', orders: [], tick: session.tick });
      o.notify(`${squad.name} will hold where it is.`);
    },
    squads: () => battle.squads.flatMap((s) => statusOf(s.spec.id) ?? []),
    squad: (id) => (id === null ? undefined : statusOf(id)),
    end() {
      ended = true;
      playing = false;
      clock = session.seconds;
    },
    summary() {
      const squads = combat.squads();
      const sides = (['BLUEFOR', 'OPFOR'] as const).map((side) => {
        const list = squads.filter((s) => s.side === side);
        const soldiers = list.reduce((n, s) => n + s.total, 0);
        return {
          side,
          soldiers,
          casualties: soldiers - list.reduce((n, s) => n + s.up, 0),
          squads: list.length,
          ineffective: list.filter((s) => s.phase === 'ineffective').length,
        };
      });
      const all = squads.flatMap((s) => s.orders);
      return {
        seconds: session.seconds,
        sides,
        orders: {
          given: all.length,
          completed: all.filter((x) => x.status === 'completed').length,
          failed: all.filter((x) => x.status === 'failed').length,
        },
      };
    },
  };
  return combat;
}

/** "Move to 120 E, 340 N", for lists. */
export function describeOrder(order: {
  readonly kind: OrderKind;
  readonly destination: Vec2 | null;
}): string {
  const d = order.destination;
  return d
    ? `${ORDER_LABELS[order.kind]} to ${String(Math.round(d.x))} E, ${String(Math.round(d.y))} N`
    : ORDER_LABELS[order.kind];
}

export const PHASE_LABELS: Readonly<Record<ForcePhase, string>> = {
  moving: 'Moving',
  possibleContact: 'Possible contact',
  contact: 'Contact',
  engaged: 'Engaged',
  holding: 'Holding',
  assaulting: 'Assaulting',
  withdrawing: 'Withdrawing',
  atObjective: 'On objective',
  withdrawn: 'Withdrawn',
  ineffective: 'Combat ineffective',
};
