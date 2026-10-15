import type { CombatEvent } from '#exercise';
import type {
  FofCommandOrigin,
  FofMetrics,
  FofReplay,
  FofRunSpec,
  FofSample,
} from '#exercise/force-on-force';
import type {
  DeepReadonly,
  FofOutcome,
  Posture,
  SimCommand,
  SimSnapshot,
  SimState,
  SoldierStatus,
} from '#sim';
import {
  createFofSession,
  type FofRecording,
  type FofSession,
  type TimedEvent,
  type Verification,
} from './session';

// The worker side of the lab's session (docs/behavior-lab/force-on-force/05):
// it steps a session toward the tick the page asks for, as fast as it can,
// and posts what the page draws from, in batches. The page never waits for
// it: it draws whatever has arrived. Plain logic, with no Worker in it
// (`sim.worker.ts` wires it to one; the tests wire it to the page side
// directly).

/** Messages to the host. `epoch` numbers each run: answers to an older one are dropped. */
export type HostIn =
  | {
      readonly type: 'init';
      readonly epoch: number;
      readonly spec: FofRunSpec;
      /** Replay a saved run (with its hashes checked). */
      readonly recording?: FofRecording;
      /** Or these commands (a branch), without checks. */
      readonly replay?: FofReplay;
      /** Step at once to this tick. */
      readonly until?: number;
    }
  | { readonly type: 'advance'; readonly epoch: number; readonly until: number }
  | { readonly type: 'submit'; readonly epoch: number; readonly command: SimCommand };

/** What the host posts: the ticks stepped since the last batch, and the run's state. */
export interface HostBatch {
  readonly type: 'batch';
  readonly epoch: number;
  /** The ticks of the frames, from `firstTick` on, one per tick. */
  readonly firstTick: number;
  readonly frameCount: number;
  /** Soldiers in state order, by id (in the first batch of a run), for the frames. */
  readonly soldierIds: readonly string[] | null;
  /** Per frame and soldier: x, y, z, azimuth. */
  readonly numbers: Float64Array;
  /** Per frame and soldier: posture, status (indices into `POSTURES`, `STATUSES`). */
  readonly codes: Uint8Array;
  readonly events: readonly TimedEvent[];
  readonly combat: readonly CombatEvent[];
  readonly samples: readonly FofSample[];
  /** Per-second hashes from second `hashesFrom` on. */
  readonly hashesFrom: number;
  readonly hashes: readonly string[];
  readonly keyframes: readonly (readonly [number, SimSnapshot])[];
  /** The head's state (without the per-pair thresholds, which the page never reads), if due. */
  readonly state: DeepReadonly<SimState> | null;
  readonly metrics: FofMetrics | null;
  readonly cpu: { readonly mean: number; readonly p95: number };
  readonly verification: Verification | null;
  readonly commands: readonly SimCommand[] | null;
  readonly origins: readonly FofCommandOrigin[] | null;
  readonly headTick: number;
  readonly done: boolean;
  readonly settled: boolean;
  readonly outcome: FofOutcome | null;
  /** Ticks per CPU second the host stepped at, over this batch (0: none stepped). */
  readonly ticksPerSecond: number;
}

export const POSTURES: readonly Posture[] = ['standing', 'kneeling', 'prone'];
export const STATUSES: readonly SoldierStatus[] = ['active', 'incapacitated'];

/** How long the host steps before posting and letting messages in (ms). */
const SLICE_MS = 16;
/** The full state goes at most this often (ms): at a thousand soldiers it is large. */
const STATE_EVERY_MS = 150;

export interface FofSessionHost {
  receive(message: HostIn): void;
}

export function createFofSessionHost(
  post: (batch: HostBatch, transfer: Transferable[]) => void,
  schedule: (run: () => void) => void = (run) => setTimeout(run, 0),
): FofSessionHost {
  let session: FofSession | null = null;
  let epoch = -1;
  let target = 0;
  let running = false;
  let firstTick = 0;
  let frames: { numbers: Float64Array; codes: Uint8Array }[] = [];
  let keyframes: [number, SimSnapshot][] = [];
  let soldierIdsSent = false;
  let sentEvents = 0;
  let sentCombat = 0;
  let sentSamples = 0;
  let sentHashes = 0;
  let sentCommands = -1;
  let lastState = -Infinity;
  let stepped = 0;
  let steppingMs = 0;

  const frameOf = (state: DeepReadonly<SimState>) => {
    const n = state.soldiers.length;
    const numbers = new Float64Array(n * 4);
    const codes = new Uint8Array(n * 2);
    state.soldiers.forEach((s, i) => {
      numbers[i * 4] = s.position.x;
      numbers[i * 4 + 1] = s.position.y;
      numbers[i * 4 + 2] = s.position.z;
      numbers[i * 4 + 3] = s.azimuth;
      codes[i * 2] = Math.max(0, POSTURES.indexOf(s.posture));
      codes[i * 2 + 1] = Math.max(0, STATUSES.indexOf(s.status));
    });
    return { numbers, codes };
  };

  const flush = (forceState: boolean) => {
    if (!session) return;
    const head = session.head;
    const n = head.sim.state.soldiers.length;
    const numbers = new Float64Array(frames.length * n * 4);
    const codes = new Uint8Array(frames.length * n * 2);
    frames.forEach((f, k) => {
      numbers.set(f.numbers, k * n * 4);
      codes.set(f.codes, k * n * 2);
    });
    const now = performance.now();
    const stateDue = forceState || now - lastState >= STATE_EVERY_MS;
    if (stateDue) lastState = now;
    const recording = session.recording();
    const commandsChanged = recording.commands.length !== sentCommands;
    sentCommands = recording.commands.length;
    const state = head.sim.state;
    const batch: HostBatch = {
      type: 'batch',
      epoch,
      firstTick,
      frameCount: frames.length,
      soldierIds: soldierIdsSent ? null : state.soldiers.map((s) => s.id),
      numbers,
      codes,
      events: session.events.slice(sentEvents),
      combat: session.combatLog.slice(sentCombat),
      samples: session.samples.slice(sentSamples),
      hashesFrom: sentHashes,
      hashes: recording.hashes.slice(sentHashes),
      keyframes,
      state: stateDue
        ? { ...state, ...(state.fof ? { fof: { ...state.fof, thresholds: [] } } : {}) }
        : null,
      metrics: stateDue ? session.metrics() : null,
      cpu: session.cpu(),
      verification: session.verification,
      commands: commandsChanged ? recording.commands : null,
      origins: commandsChanged ? recording.origins : null,
      headTick: head.sim.tick,
      done: head.done,
      settled: head.settled,
      outcome: head.outcome,
      ticksPerSecond: steppingMs > 0 ? (stepped / steppingMs) * 1000 : 0,
    };
    soldierIdsSent = true;
    sentEvents = session.events.length;
    sentCombat = session.combatLog.length;
    sentSamples = session.samples.length;
    sentHashes = recording.hashes.length;
    firstTick = head.sim.tick + 1;
    frames = [];
    keyframes = [];
    stepped = 0;
    steppingMs = 0;
    post(batch, [numbers.buffer, codes.buffer]);
  };

  const loop = () => {
    const s = session;
    if (!s) {
      running = false;
      return;
    }
    const start = performance.now();
    while (s.headTick < target && !s.head.settled && performance.now() - start < SLICE_MS) {
      s.step();
      stepped += 1;
    }
    steppingMs += performance.now() - start;
    const more = s.headTick < target && !s.head.settled;
    flush(!more);
    if (more) schedule(loop);
    else running = false;
  };

  const kick = () => {
    if (running) return;
    running = true;
    schedule(loop);
  };

  return {
    receive(message) {
      if (message.type === 'init') {
        epoch = message.epoch;
        target = message.until ?? 0;
        frames = [];
        keyframes = [];
        soldierIdsSent = false;
        sentEvents = 0;
        sentCombat = 0;
        sentSamples = 0;
        sentHashes = 0;
        sentCommands = -1;
        lastState = -Infinity;
        stepped = 0;
        steppingMs = 0;
        session = createFofSession(message.spec, message.recording, {
          ...(message.replay ? { replay: message.replay } : {}),
          onTick: (run) => frames.push(frameOf(run.sim.state)),
          onKeyframe: (tick, snapshot) => keyframes.push([tick, snapshot]),
        });
        // The first frame: the run at its start.
        firstTick = session.headTick;
        frames.push(frameOf(session.head.sim.state));
        flush(true);
        kick();
        return;
      }
      if (message.epoch !== epoch || !session) return;
      if (message.type === 'advance') {
        target = Math.max(target, message.until);
        kick();
        return;
      }
      session.submit(message.command);
      flush(true);
    },
  };
}
