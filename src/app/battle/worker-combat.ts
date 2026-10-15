import type { CombatEvent } from '#exercise';
import { battleScenario, type BattleCommandOrigin } from '#exercise/battle';
import {
  soldierId,
  type SimCommand,
  type SimEvent,
  type SimSnapshot,
  type TerrainDataset,
} from '#sim';
import type { HostBatch, HostIn } from './battle-host';
import type { BattleDriver, DriverFactory } from './driver';
import { createFrameLog } from './frame-log';
import { combatEventOf, type BattleRecording, type BattleRun, type TimedEvent } from './session';
import type { SquadStatus } from './status';

// The page's side of the battle worker (docs/constructive-simulation/04): a
// driver whose battle is simulated in the worker (battle-host.ts), and a
// mirror of it built from the worker's batches: the soldiers' frames as a
// motion log, the events, the hashes, the keyframes and the squads as last
// posted. Asking it to advance only tells the worker where the page's clock
// is; the page draws whatever has arrived.

/** A connection to a battle host: the worker, or (in tests) a host on this thread. */
export interface BattleChannel {
  post(message: HostIn, transfer?: Transferable[]): void;
  /** Calls `listener` with every batch; the returned function stops it. */
  listen(listener: (batch: HostBatch) => void): () => void;
  /** Stops the worker. */
  close(): void;
}

/** A channel to a new battle worker. */
export function createWorkerChannel(): BattleChannel {
  const worker = new Worker(new URL('./battle.worker.ts', import.meta.url), {
    type: 'module',
    name: 'ambush-battle',
  });
  const listeners = new Set<(batch: HostBatch) => void>();
  worker.onmessage = (e: MessageEvent<HostBatch>) => {
    for (const listener of listeners) listener(e.data);
  };
  return {
    post: (message, transfer = []) => {
      worker.postMessage(message, transfer);
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
      worker.terminate();
    },
  };
}

let epochs = 0;

/**
 * Drivers whose battles are simulated by the host at the other end of
 * `channel`, on `terrain` (sent to it once, here).
 */
export function createWorkerDriver(channel: BattleChannel, terrain: TerrainDataset): DriverFactory {
  channel.post({ type: 'terrain', terrain });
  return (spec, replay) => {
    epochs += 1;
    const epoch = epochs;
    const rate = spec.tickRateHz;
    // The squads and soldiers, laid out here as the worker lays them out.
    const { scenario, squads } = battleScenario(spec, terrain);
    const motion = createFrameLog(
      rate,
      scenario.soldiers.map((s) => soldierId(s.id)),
    );
    const commands: SimCommand[] = replay ? [...replay.commands] : [];
    const origins: BattleCommandOrigin[] = replay ? [...replay.origins] : [];
    const events: TimedEvent[] = [];
    const combatLog: CombatEvent[] = [];
    const keyframes = new Map<number, SimSnapshot>();
    const hashes: (string | null)[] = [];
    const appliedTicks = new Map<number, number>();
    let fresh: SimEvent[] = [];
    let headTick = 0;
    let cpu = { mean: 0, p95: 0 };
    let statuses: readonly SquadStatus[] = [];
    let asked = 0;
    let nextId = 0;
    let waiting: ((recording: BattleRecording) => void)[] = [];

    const stop = channel.listen((batch) => {
      if (batch.epoch !== epoch) return;
      if (batch.frameCount > 0)
        motion.add({
          firstTick: batch.firstTick,
          count: batch.frameCount,
          numbers: batch.numbers,
          codes: batch.codes,
        });
      for (const e of batch.events) {
        events.push(e);
        fresh.push(e.event);
        const c = combatEventOf(e.event);
        if (c) combatLog.push(c);
      }
      batch.hashes.forEach((h, k) => {
        hashes[batch.hashesFrom + k] = h;
      });
      for (const [tick, snapshot] of batch.keyframes) keyframes.set(tick, snapshot);
      for (const a of batch.applied) appliedTicks.set(a.id, a.tick);
      statuses = batch.squads;
      headTick = batch.headTick;
      cpu = batch.cpu;
      if (batch.recording) {
        const recording = batch.recording;
        const resolve = waiting;
        waiting = [];
        for (const r of resolve) r(recording);
      }
    });

    const run: BattleRun = {
      battle: { squads, commands, origins },
      get tick() {
        return headTick;
      },
      get seconds() {
        return headTick / rate;
      },
      motion,
      combatLog,
      events,
      keyframes,
      hashes,
      cpu: () => cpu,
    };
    channel.post({ type: 'init', epoch, spec, ...(replay ? { replay } : {}) });

    const driver: BattleDriver = {
      run,
      advance(tick) {
        if (tick > asked) {
          asked = tick;
          channel.post({ type: 'advance', epoch, until: tick });
        }
        const out = fresh;
        fresh = [];
        return out;
      },
      submit(command) {
        nextId += 1;
        const id = nextId;
        commands.push(command);
        origins.push('user');
        channel.post({ type: 'submit', epoch, id, command });
        return () => appliedTicks.get(id) ?? null;
      },
      squads: () => statuses,
      recording() {
        return new Promise((resolve) => {
          waiting.push(resolve);
          channel.post({ type: 'recording', epoch });
        });
      },
      dispose() {
        stop();
        waiting = [];
      },
    };
    return driver;
  };
}
