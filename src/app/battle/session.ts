import {
  combatEventOf,
  createMotionRecorder,
  type CombatEvent,
  type MotionLog,
  type MotionRecorder,
} from '#exercise';
import {
  createBattle,
  type Battle,
  type BattleCommandOrigin,
  type BattleReplay,
  type BattleSpec,
} from '#exercise/battle';
import {
  hashSimState,
  type SimCommand,
  type SimEvent,
  type SimSnapshot,
  type TerrainDataset,
} from '#sim';

// A battle session (docs/constructive-simulation/04): the battle being
// fought, stepped on the calling thread, and everything that reproduces it
// and shows it. It records every command with its origin, a snapshot every
// few seconds (keyframes), the state hash every second, every soldier's
// motion (for the characters and smooth drawing) and the events shown. The
// same spec, terrain and commands give the same battle tick for tick: the
// After-Action Review replays it from tick 0 (docs/constructive-simulation/05).

/** A fought battle: enough to reproduce every tick of it, and check it did. */
export interface BattleRecording {
  readonly schema: 'ambush.battle-run';
  readonly version: 1;
  readonly spec: BattleSpec;
  readonly commands: readonly SimCommand[];
  readonly origins: readonly BattleCommandOrigin[];
  readonly endTick: number;
  /** `hashSimState` at every whole second (index = second). */
  readonly hashes: readonly (string | null)[];
}

/** An event shown, with its time. */
export interface TimedEvent {
  readonly seconds: number;
  readonly event: SimEvent;
}

/** Events a battle shows (its log, its overlays and the characters). */
export const SHOWN_EVENTS: ReadonlySet<SimEvent['type']> = new Set([
  'contactObserved',
  'forcePhaseChanged',
  'orderChanged',
  'fofFire',
  'fofGrenade',
  'fofReload',
  'ammunitionExhausted',
  'soldierIncapacitated',
  'commandRejected',
]);

/** Seconds between keyframes. */
export const KEYFRAME_SECONDS = 5;
/** Battles of up to this many soldiers hash their state every second; larger ones at each keyframe. */
export const HASH_EVERY_SECOND_MAX_SOLDIERS = 100;
/** `advance` steps for at most this long (ms; at least one tick), so a frame keeps drawing. */
export const ADVANCE_BUDGET_MS = 30;
const CPU_SAMPLES = 300;

/**
 * What the pages read of a battle being simulated: here (`BattleSession`)
 * or in the battle worker (`worker-combat.ts`, its mirror of the worker's).
 */
export { combatEventOf };

export interface BattleRun {
  /** The battle's squads, and every command given (with `origins`). */
  readonly battle: Pick<Battle, 'squads' | 'commands' | 'origins'>;
  readonly tick: number;
  readonly seconds: number;
  readonly motion: MotionLog;
  readonly combatLog: readonly CombatEvent[];
  readonly events: readonly TimedEvent[];
  readonly keyframes: ReadonlyMap<number, SimSnapshot>;
  readonly hashes: readonly (string | null)[];
  /** Simulation CPU per tick (ms), over the last ticks. */
  cpu(): { readonly mean: number; readonly p95: number };
}

export interface BattleSession extends BattleRun {
  readonly battle: Battle;
  readonly motion: MotionRecorder;
  /** One tick; its events. */
  step(): readonly SimEvent[];
  /** Steps toward `tick`, for at most `budgetMs` (at least one tick). The events of the ticks stepped. */
  advance(tick: number, budgetMs?: number): SimEvent[];
  /** A command for the next tick (given now: its tick is the current one). */
  submit(command: SimCommand, origin?: BattleCommandOrigin): void;
  recording(): BattleRecording;
}

export function createBattleSession(
  spec: BattleSpec,
  terrain: TerrainDataset,
  replay?: BattleReplay,
): BattleSession {
  const battle = createBattle(spec, terrain, replay);
  const rate = spec.tickRateHz;
  const motion = createMotionRecorder(rate);
  const combat: CombatEvent[] = [];
  const events: TimedEvent[] = [];
  const keyframes = new Map<number, SimSnapshot>();
  const hashes: (string | null)[] = [];
  const cpu: number[] = [];

  // A large battle's state hash (over 100 ms at 988 soldiers) is taken at each
  // keyframe only; the seconds between hold `null` (not checked on replay).
  const hashEvery =
    battle.sim.state.soldiers.length > HASH_EVERY_SECOND_MAX_SOLDIERS ? KEYFRAME_SECONDS : 1;
  const atTick = () => {
    const sim = battle.sim;
    motion.record(sim.state);
    if (sim.tick % rate === 0) {
      const second = sim.tick / rate;
      hashes[second] = second % hashEvery === 0 ? hashSimState(sim.state) : null;
    }
    if (sim.tick % (KEYFRAME_SECONDS * rate) === 0) keyframes.set(sim.tick, sim.snapshot());
  };
  atTick();

  const step = () => {
    const t = performance.now();
    const stepped = battle.step();
    cpu.push(performance.now() - t);
    if (cpu.length > CPU_SAMPLES) cpu.shift();
    for (const event of stepped) {
      if (!SHOWN_EVENTS.has(event.type)) continue;
      events.push({ seconds: battle.sim.timeSeconds, event });
      const c = combatEventOf(event);
      if (c) combat.push(c);
    }
    atTick();
    return stepped;
  };

  return {
    battle,
    get tick() {
      return battle.sim.tick;
    },
    get seconds() {
      return battle.sim.timeSeconds;
    },
    motion,
    combatLog: combat,
    events,
    keyframes,
    hashes,
    step,
    advance(tick, budgetMs = ADVANCE_BUDGET_MS) {
      const until = performance.now() + budgetMs;
      const out: SimEvent[] = [];
      for (let n = 0; battle.sim.tick < tick; n += 1) {
        if (n > 0 && performance.now() >= until) break;
        out.push(...step());
      }
      return out;
    },
    submit(command, origin = 'user') {
      battle.submit({ ...command, tick: battle.sim.tick }, origin);
    },
    recording: () => ({
      schema: 'ambush.battle-run',
      version: 1,
      spec,
      commands: battle.commands,
      origins: battle.origins,
      endTick: battle.sim.tick,
      hashes: Array.from(hashes, (h) => h ?? null),
    }),
    cpu() {
      if (cpu.length === 0) return { mean: 0, p95: 0 };
      const sorted = [...cpu].sort((a, b) => a - b);
      return {
        mean: cpu.reduce((a, b) => a + b, 0) / cpu.length,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      };
    },
  };
}
