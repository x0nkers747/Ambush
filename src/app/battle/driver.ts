import type { BattleReplay, BattleSpec } from '#exercise/battle';
import type { SimCommand, SimEvent, TerrainDataset } from '#sim';
import {
  createBattleSession,
  type BattleRecording,
  type BattleRun,
  type TimedEvent,
} from './session';
import { squadStatuses, type SquadStatus } from './status';

// Where a battle is simulated (docs/constructive-simulation/04): here, on the
// page's thread (`createLocalDriver`), or in the battle worker
// (`createWorkerDriver`, worker-combat.ts). Combat and the After-Action
// Review read the battle through its driver alone, so either will do; the
// page uses the worker, the tests both.

export interface BattleDriver {
  /** The battle as known here (in the worker's case: as last posted). */
  readonly run: BattleRun;
  /**
   * Has the battle stepped toward `tick` (here: for at most `budgetMs`; in
   * the worker: as fast as it can). Returns the events shown that have
   * come in since the last call.
   */
  advance(tick: number, budgetMs?: number): readonly SimEvent[];
  /** Gives a command now (for the next tick). The function says the tick it was given for, once known. */
  submit(command: SimCommand): () => number | null;
  /** The squads, as last known. */
  squads(): readonly SquadStatus[];
  /** The recording of the battle so far. */
  recording(): Promise<BattleRecording>;
  /** Stops it (the worker's battle is dropped). */
  dispose(): void;
}

export type DriverFactory = (spec: BattleSpec, replay?: BattleReplay) => BattleDriver;

/** A driver stepping the battle on the calling thread. */
export function createLocalDriver(terrain: TerrainDataset): DriverFactory {
  return (spec, replay) => {
    const session = createBattleSession(spec, terrain, replay);
    let seen = session.events.length;
    return {
      run: session,
      advance(tick, budgetMs) {
        session.advance(tick, budgetMs);
        const fresh = session.events.slice(seen).map((e: TimedEvent) => e.event);
        seen = session.events.length;
        return fresh;
      },
      submit(command) {
        session.submit(command);
        const tick = session.tick;
        return () => tick;
      },
      squads: () => squadStatuses(session.battle, session.battle.sim.state),
      recording: () => Promise.resolve(session.recording()),
      dispose() {
        // Nothing to stop on this thread.
      },
    };
  };
}
