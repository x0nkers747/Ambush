import type { Battle } from '#exercise/battle';
import type {
  DeepReadonly,
  FofForce,
  FofOrder,
  ForcePhase,
  OrderSpec,
  Side,
  SimState,
  Vec2,
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
  readonly effectiveness: number;
  readonly active: DeepReadonly<FofOrder> | null;
  readonly pending: readonly DeepReadonly<FofOrder>[];
  /** Every order it was given, in turn. */
  readonly orders: readonly DeepReadonly<FofOrder>[];
  readonly queued: readonly QueuedOrder[];
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
      ineffective: list.filter((s) => s.phase === 'ineffective').length,
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
