import type { BattleReplay, BattleSpec } from '#exercise/battle';
import { motionMovers } from '#exercise';
import type { SimCommand, SimSnapshot, TerrainDataset } from '#sim';
import { CODES_PER_SOLDIER, NUMBERS_PER_SOLDIER, writeFrame } from './frame-log';
import {
  createBattleSession,
  type BattleRecording,
  type BattleSession,
  type TimedEvent,
} from './session';
import { squadStatuses, vehicleStatuses, type SquadStatus, type VehicleStatus } from './status';

// The battle worker's side (docs/constructive-simulation/04): a battle
// session stepped toward the tick the page asks for, as fast as it can, in
// slices, posting after each slice what the page draws and records from:
// the soldiers' frames, the events, the state hashes, the keyframes and the
// squads' states. The page never waits for it: it draws whatever has
// arrived. A battle fought (Combat) steps toward the page's clock; a battle
// replayed (the After-Action Review) runs to its end at once. Plain logic,
// with no Worker in it: `battle.worker.ts` wires it to one, and the tests
// wire it to the page's side directly.

/** Messages to the host. `epoch` numbers each battle: answers about an older one are dropped. */
export type HostIn =
  /** The battlefield's ground, once (the battles that follow are on it). */
  | { readonly type: 'terrain'; readonly terrain: TerrainDataset }
  | {
      readonly type: 'init';
      readonly epoch: number;
      readonly spec: BattleSpec;
      /** A replay: these commands, from tick 0, instead of the user's. */
      readonly replay?: BattleReplay;
      /** Step at once toward this tick. */
      readonly until?: number;
    }
  | { readonly type: 'advance'; readonly epoch: number; readonly until: number }
  | {
      readonly type: 'submit';
      readonly epoch: number;
      /** The page's id for it: the batch that applies it says so (`applied`). */
      readonly id: number;
      readonly command: SimCommand;
    }
  | { readonly type: 'recording'; readonly epoch: number };

/** What the host posts after each slice. */
export interface HostBatch {
  readonly type: 'batch';
  readonly epoch: number;
  /** The soldiers in state order (in the first batch of a battle), for the frames. */
  readonly soldierIds: readonly string[] | null;
  /** Frames for ticks `firstTick` … `firstTick + frameCount − 1`. */
  readonly firstTick: number;
  readonly frameCount: number;
  readonly numbers: Float64Array;
  readonly codes: Uint8Array;
  /** The events shown, since the last batch. */
  readonly events: readonly TimedEvent[];
  /** Per-second state hashes from second `hashesFrom` on. */
  readonly hashesFrom: number;
  readonly hashes: readonly (string | null)[];
  readonly keyframes: readonly (readonly [number, SimSnapshot])[];
  /** Commands given (by the page's id) and the tick each was given for. */
  readonly applied: readonly { readonly id: number; readonly tick: number }[];
  /** The squads at `headTick`. */
  readonly squads: readonly SquadStatus[];
  /** The vehicles at `headTick`. */
  readonly vehicles: readonly VehicleStatus[];
  readonly headTick: number;
  readonly cpu: { readonly mean: number; readonly p95: number };
  /** The recording, when asked for. */
  readonly recording: BattleRecording | null;
}

/** How long the host steps before posting and letting messages in (ms). */
const SLICE_MS = 16;
/** Most frames in one batch. */
const MAX_FRAMES = 4096;

export interface BattleHost {
  receive(message: HostIn): void;
}

export function createBattleHost(
  post: (batch: HostBatch, transfer: Transferable[]) => void,
  schedule: (run: () => void) => void = (run) => setTimeout(run, 0),
): BattleHost {
  let terrain: TerrainDataset | null = null;
  let session: BattleSession | null = null;
  let epoch = -1;
  let target = 0;
  let running = false;
  let wantRecording = false;
  let sentIds = false;
  let sentEvents = 0;
  let sentHashes = 0;
  let sentKeyframes = new Set<number>();
  let applied: { id: number; tick: number }[] = [];
  /** The next tick whose frame has not been sent. */
  let frameFrom = 0;
  let frames: { numbers: Float64Array; codes: Uint8Array; count: number } | null = null;

  const soldierCount = () => (session ? motionMovers(session.battle.sim.state).length : 0);
  const newFrames = () => {
    const n = soldierCount();
    return {
      numbers: new Float64Array(MAX_FRAMES * n * NUMBERS_PER_SOLDIER),
      codes: new Uint8Array(MAX_FRAMES * n * CODES_PER_SOLDIER),
      count: 0,
    };
  };
  /** Records the session's current tick as the next frame. */
  const frame = () => {
    if (!session) return;
    frames ??= newFrames();
    writeFrame(session.battle.sim.state, frames.numbers, frames.codes, frames.count);
    frames.count += 1;
  };

  const flush = () => {
    if (!session) return;
    const s = session;
    const n = soldierCount();
    const f = frames ?? { numbers: new Float64Array(0), codes: new Uint8Array(0), count: 0 };
    const numbers = f.numbers.slice(0, f.count * n * NUMBERS_PER_SOLDIER);
    const codes = f.codes.slice(0, f.count * n * CODES_PER_SOLDIER);
    const keyframes = [...s.keyframes].filter(([tick]) => !sentKeyframes.has(tick));
    for (const [tick] of keyframes) sentKeyframes.add(tick);
    const batch: HostBatch = {
      type: 'batch',
      epoch,
      soldierIds: sentIds ? null : motionMovers(s.battle.sim.state).map((x) => x.id),
      firstTick: frameFrom,
      frameCount: f.count,
      numbers,
      codes,
      events: s.events.slice(sentEvents),
      hashesFrom: sentHashes,
      hashes: Array.from(s.hashes.slice(sentHashes), (h) => h ?? null),
      keyframes,
      applied,
      squads: squadStatuses(s.battle, s.battle.sim.state),
      vehicles: vehicleStatuses(s.battle.sim.state),
      headTick: s.tick,
      cpu: s.cpu(),
      recording: wantRecording ? s.recording() : null,
    };
    sentIds = true;
    sentEvents = s.events.length;
    sentHashes = s.hashes.length;
    frameFrom += f.count;
    frames = null;
    applied = [];
    wantRecording = false;
    post(batch, [numbers.buffer, codes.buffer]);
  };

  const run = () => {
    running = false;
    if (!session) return;
    const until = performance.now() + SLICE_MS;
    while (session.tick < target && performance.now() < until) {
      session.step();
      frame();
      if ((frames?.count ?? 0) >= MAX_FRAMES) break;
    }
    flush();
    if (session.tick < target) {
      running = true;
      schedule(run);
    }
  };
  const kick = () => {
    if (running) return;
    running = true;
    schedule(run);
  };

  return {
    receive(message) {
      if (message.type === 'terrain') {
        terrain = message.terrain;
        return;
      }
      if (message.type === 'init') {
        if (!terrain) throw new Error('The battle host has no terrain.');
        epoch = message.epoch;
        session = createBattleSession(message.spec, terrain, message.replay);
        target = message.until ?? 0;
        sentIds = false;
        sentEvents = 0;
        sentHashes = 0;
        sentKeyframes = new Set();
        applied = [];
        frameFrom = session.tick;
        frames = null;
        wantRecording = false;
        frame();
        kick();
        return;
      }
      if (message.epoch !== epoch || !session) return;
      if (message.type === 'advance') {
        target = Math.max(target, message.until);
        kick();
      } else if (message.type === 'submit') {
        session.submit(message.command);
        applied.push({ id: message.id, tick: session.tick });
        kick();
      } else {
        wantRecording = true;
        kick();
      }
    },
  };
}
