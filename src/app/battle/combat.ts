import {
  battleSpecOf,
  ORDER_LABELS,
  placeDestination,
  type BattleScenarioDefinition,
  ACTIONS_ON_LABELS,
  defaultActionsOn,
  defaultKillZone,
  DEFEND_ARC_DEFAULT_DEG,
} from '#exercise/battle';
import type {
  ForcePhase,
  OrderKind,
  OrderSpec,
  SimEvent,
  TerrainDataset,
  Vec2,
  ActionsOn,
} from '#sim';
import { BATTLE_TICK_RATE_HZ } from './planner';
import { createLocalDriver, type DriverFactory } from './driver';
import type { BattleRecording, BattleRun } from './session';
import { summarize, type BattleSummary, type QueuedOrder, type SquadStatus } from './status';

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

export type { QueuedOrder, SquadStatus } from './status';
/** The battle's results by side. */
export type CombatSummary = BattleSummary;

export interface Combat {
  /** The battle as known on the page (stepped here, or in the worker). */
  readonly session: BattleRun;
  readonly playing: boolean;
  readonly speed: CombatSpeed;
  readonly ended: boolean;
  /** The time drawn: simulation seconds, smooth between ticks, at least a tick behind the battle. */
  readonly renderSeconds: number;
  play(): void;
  pause(): void;
  setSpeed(speed: CombatSpeed): void;
  /**
   * The page's frame: moves the clock on by `dtSeconds` of real time at the
   * speed, while playing, and steps the battle toward it. Returns the
   * events of the ticks stepped.
   */
  frame(dtSeconds: number, budgetMs?: number): readonly SimEvent[];
  /**
   * The speed the battle has actually kept up lately (simulated seconds per
   * real second, smoothed): below the speed chosen when it is slower to
   * simulate than that.
   */
  readonly achievedSpeed: number;
  /** Orders a squad to `point` (snapped clear of water and buildings). `true` when given. */
  /** Orders a squad; `actionsOn`: what it does on contact (`null`: its order kind's). */
  order(
    squadId: string,
    kind: OrderKind,
    point: Vec2,
    mode: 'replace' | 'append',
    actionsOn?: ActionsOn | null,
    /**
     * The second click of an ambush or a defence (`point` is its position): an
     * ambush's kill zone centre (a default kill zone there), or the direction a
     * defence defends toward (a 90° sector that way).
     */
    killZoneAt?: Vec2 | null,
  ): boolean;
  /** Clears a squad's orders: it holds where it is. */
  hold(squadId: string): void;
  squads(): readonly SquadStatus[];
  squad(id: string | null): SquadStatus | undefined;
  /** Ends the battle (for good): the clock stops. */
  end(): void;
  summary(): CombatSummary;
  /** The battle's recording (once ended: the whole battle). */
  recording(): Promise<BattleRecording>;
  /** Stops the battle's simulation (its worker's battle). */
  dispose(): void;
}

export interface CombatOptions {
  readonly terrain: TerrainDataset;
  readonly definition: BattleScenarioDefinition;
  readonly notify: (message: string) => void;
  /** How long a frame may step the battle (ms; default `ADVANCE_BUDGET_MS`). */
  readonly stepBudgetMs?: number;
  /** Where the battle is simulated (default: here). */
  readonly driver?: DriverFactory;
}

/** Lead the drawn time keeps behind the clock while the battle catches up (s of simulation). */
const MAX_LAG_SECONDS = 2;

export function createCombat(o: CombatOptions): Combat {
  const spec = battleSpecOf(o.definition, BATTLE_TICK_RATE_HZ);
  const driver = (o.driver ?? createLocalDriver(o.terrain))(spec);
  const session = driver.run;
  const battle = session.battle;
  const rate = spec.tickRateHz;
  let playing = false;
  let speed: CombatSpeed = 1;
  let ended = false;
  /** The clock: where play has got to (simulation seconds). */
  let clock = 0;
  /** Orders given and not yet applied, with when each was given for (once known). */
  let queued: (QueuedOrder & { readonly given: () => number | null })[] = [];
  let achieved = 1;

  const byId = new Map(battle.squads.map((s) => [s.spec.id, s]));
  const statusOf = (id: string): SquadStatus | undefined => {
    const status = driver.squads().find((q) => q.id === id);
    return status ? { ...status, queued: queued.filter((q) => q.squadId === id) } : undefined;
  };
  /** Gives a command now; it shows queued until its tick has been stepped. */
  const give = (squadId: string, mode: 'replace' | 'append', orders: OrderSpec[]) => {
    const squad = byId.get(squadId);
    if (!squad) return;
    const given = driver.submit({
      type: 'orderSquad',
      tick: session.tick,
      unitId: squad.unitId,
      mode,
      orders,
    });
    queued.push({ squadId, mode, orders, tick: session.tick, given });
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
      // A tick behind the battle: the characters' pose at a time may read the
      // tick after it, which must be there already (or a live pose would
      // differ from the review's).
      return Math.max(0, Math.min(clock, session.seconds - 1 / rate));
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
    get achievedSpeed() {
      return achieved;
    },
    frame(dtSeconds, budgetMs) {
      if (ended) return [];
      const before = session.seconds;
      if (playing) {
        clock += Math.max(0, Math.min(dtSeconds, 0.25)) * speed;
        // Never run away from a battle that cannot keep up.
        clock = Math.min(clock, session.seconds + MAX_LAG_SECONDS);
      } else clock = Math.min(clock, session.seconds);
      const target = Math.ceil(clock * rate);
      const events = driver.advance(target, budgetMs ?? o.stepBudgetMs);
      if (playing && dtSeconds > 0) {
        const rateNow = (session.seconds - before) / Math.min(dtSeconds, 0.25);
        achieved += (rateNow - achieved) * Math.min(1, dtSeconds / 1.5);
      } else if (!playing) achieved = speed;
      if (queued.length > 0)
        queued = queued.filter((q) => {
          const tick = q.given();
          return tick === null || tick >= session.tick;
        });
      for (const event of events) {
        if (event.type === 'commandRejected') {
          const reason =
            {
              unitIneffective: 'the squad has nobody left',
              destinationOffTerrain: 'the destination is off the map',
              unknownUnit: 'there is no such squad',
              noForceModel: 'the battle has no force model',
            }[event.reason as string] ?? event.reason;
          o.notify(`Order refused: ${reason}.`);
        }
      }
      return events;
    },
    order(squadId, kind, point, mode, actionsOn = null, killZoneAt = null) {
      const squad = byId.get(squadId);
      if (ended || !squad) return false;
      if (kind === 'ambush' && !killZoneAt) {
        o.notify('An ambush needs its kill zone: click it after the ambush position.');
        return false;
      }
      if (kind === 'defend' && !killZoneAt) {
        o.notify('A defence needs its direction: click it after the defensive position.');
        return false;
      }
      const placed = placeDestination(o.terrain, point);
      if ('problem' in placed) {
        o.notify(placed.problem);
        return false;
      }
      if (placed.note !== undefined) o.notify(placed.note);
      give(squadId, mode, [
        {
          kind,
          destination: placed.point,
          actionsOn: actionsOn ?? defaultActionsOn(kind),
          ...(kind === 'ambush' && killZoneAt
            ? { killZone: defaultKillZone(placed.point, killZoneAt) }
            : {}),
          ...(kind === 'defend' && killZoneAt
            ? {
                sector: {
                  facing: Math.atan2(killZoneAt.x - placed.point.x, killZoneAt.y - placed.point.y),
                  arc: (DEFEND_ARC_DEFAULT_DEG * Math.PI) / 180,
                },
              }
            : {}),
        },
      ]);
      return true;
    },
    hold(squadId) {
      const squad = byId.get(squadId);
      if (ended || !squad) return;
      give(squadId, 'replace', []);
      o.notify(`${squad.name} will hold where it is.`);
    },
    squads: () => battle.squads.flatMap((s) => statusOf(s.spec.id) ?? []),
    squad: (id) => (id === null ? undefined : statusOf(id)),
    end() {
      ended = true;
      playing = false;
      clock = session.seconds;
    },
    summary: () => summarize(combat.squads(), session.seconds),
    recording: () => driver.recording(),
    dispose: () => {
      driver.dispose();
    },
  };
  return combat;
}

/** "Move to 120 E, 340 N", for lists. */
export function describeOrder(order: {
  readonly kind: OrderKind;
  readonly destination: Vec2 | null;
  readonly actionsOn?: ActionsOn;
}): string {
  const d = order.destination;
  const what = d
    ? `${ORDER_LABELS[order.kind]} ${order.kind === 'ambush' || order.kind === 'defend' ? 'at' : 'to'} ${String(Math.round(d.x))} E, ${String(Math.round(d.y))} N`
    : ORDER_LABELS[order.kind];
  // Its actions on contact, when not its kind's.
  const on = order.actionsOn;
  return on && on !== defaultActionsOn(order.kind)
    ? `${what} (on contact: ${ACTIONS_ON_LABELS[on]})`
    : what;
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
  inAmbush: 'In ambush',
  defending: 'Defending',
  withdrawn: 'Withdrawn',
  ineffective: 'Combat ineffective',
};
