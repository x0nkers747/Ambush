import { createMotionRecorder, type CombatEvent, type MotionRecorder } from '#exercise';
import {
  createFofMetrics,
  createFofRun,
  type FofCommandOrigin,
  type FofMetrics,
  type FofRun,
  type FofRunSpec,
  type FofSample,
} from '#exercise/force-on-force';
import type { DeepReadonly, FofOutcome, SimCommand, SimSnapshot, SimState } from '#sim';
import type { HostBatch, HostIn } from './session-host';
import { POSTURES, STATUSES } from './session-host';
import {
  keptCommands,
  runAt,
  type FofRecording,
  type FofRunView,
  type FofSession,
  type TimedEvent,
  type Verification,
} from './session';

// The page side of the lab's session when the simulation runs in a worker
// (docs/behavior-lab/force-on-force/05). It has the session's interface; its
// head is a mirror of the worker's, filled by the batches it posts: the
// soldiers at every tick (for the motion log the characters and dots are
// drawn from), the events, metrics, hashes and keyframes, and the latest
// state. Asking for ticks never blocks: the worker steps, the page draws
// what has arrived. Scrubbing back re-simulates here from the keyframes, as
// the in-page session does.

/** A two-way message channel to a session host (a worker, or the host itself in tests). */
export interface FofHostChannel {
  post(message: HostIn): void;
  listen(receive: (batch: HostBatch) => void): void;
  close(): void;
}

/** A channel to a new worker running the session host. */
export function workerChannel(): FofHostChannel {
  const worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
  return {
    post: (message) => {
      worker.postMessage(message);
    },
    listen: (receive) => {
      worker.onmessage = (e: MessageEvent<HostBatch>) => {
        receive(e.data);
      };
    },
    close: () => {
      worker.terminate();
    },
  };
}

export function createFofWorkerSession(
  spec: FofRunSpec,
  recording: FofRecording | undefined,
  channel: FofHostChannel,
): FofSession {
  const rate = spec.tickRateHz;
  const replay = recording
    ? { commands: recording.commands, origins: recording.origins }
    : undefined;
  // The run as it starts, built here too: its forces, its world, its first state.
  const base: FofRun = createFofRun(spec, undefined, replay);
  const empty = createFofMetrics(base.sim).result();

  let epoch = 0;
  let requested = 0;
  let headTick = 0;
  let state: DeepReadonly<SimState> = base.sim.state;
  let commands: readonly SimCommand[] = base.commands;
  let origins: readonly FofCommandOrigin[] = base.origins;
  let done = false;
  let settled = false;
  let outcome: FofOutcome | null = null;
  let headMotion: MotionRecorder = createMotionRecorder(rate);
  let soldierIds: readonly string[] = base.sim.state.soldiers.map((s) => s.id);
  let events: TimedEvent[] = [];
  let combat: CombatEvent[] = [];
  let samples: FofSample[] = [];
  let hashes: (string | null)[] = [];
  let keyframes = new Map<number, SimSnapshot>();
  let metrics: FofMetrics = empty;
  let cpu = { mean: 0, p95: 0 };
  let verification: Verification | null = null;
  let view: FofRunView | null = null;
  /** A branch the worker is re-simulating up to: the view stays on its tick until the head is there. */
  let catchUp: number | null = null;
  let viewMotion: MotionRecorder = headMotion;
  let viewCombat: CombatEvent[] = combat;
  let ticksPerSecond = 0;

  const head: FofRunView = {
    spec,
    forces: base.forces,
    sim: {
      get state() {
        return state;
      },
      get tick() {
        return headTick;
      },
      get timeSeconds() {
        return headTick / rate;
      },
      world: base.sim.world,
    },
    get commands() {
      return commands;
    },
    get origins() {
      return origins;
    },
    get done() {
      return done;
    },
    get settled() {
      return settled;
    },
    get outcome() {
      return outcome;
    },
  };

  /** A tick's soldiers as the motion log reads them. */
  const frameState = (batch: HostBatch, k: number, tick: number) => {
    const n = soldierIds.length;
    const soldiers = soldierIds.map((id, i) => {
      const o = (k * n + i) * 4;
      const c = (k * n + i) * 2;
      return {
        id,
        position: {
          x: batch.numbers[o] ?? 0,
          y: batch.numbers[o + 1] ?? 0,
          z: batch.numbers[o + 2] ?? 0,
        },
        azimuth: batch.numbers[o + 3] ?? 0,
        posture: POSTURES[batch.codes[c] ?? 0] ?? 'standing',
        status: STATUSES[batch.codes[c + 1] ?? 0] ?? 'active',
      };
    });
    return { tick, soldiers } as unknown as DeepReadonly<SimState>;
  };

  const receive = (batch: HostBatch) => {
    if (batch.epoch !== epoch) return;
    if (batch.soldierIds) soldierIds = batch.soldierIds;
    for (let k = 0; k < batch.frameCount; k += 1) {
      headMotion.record(frameState(batch, k, batch.firstTick + k));
    }
    events.push(...batch.events);
    combat.push(...batch.combat);
    samples.push(...batch.samples);
    batch.hashes.forEach((h, i) => (hashes[batch.hashesFrom + i] = h));
    for (const [tick, snapshot] of batch.keyframes) keyframes.set(tick, snapshot);
    if (batch.state) state = batch.state;
    if (batch.metrics) metrics = batch.metrics;
    if (batch.commands) commands = batch.commands;
    if (batch.origins) origins = batch.origins;
    cpu = batch.cpu;
    verification = batch.verification;
    headTick = batch.headTick;
    done = batch.done;
    settled = batch.settled;
    outcome = batch.outcome;
    if (batch.ticksPerSecond > 0) ticksPerSecond = batch.ticksPerSecond;
    if (catchUp !== null && headTick >= catchUp) {
      catchUp = null;
      view = null;
    }
  };
  channel.listen(receive);

  /** A new run in the worker (the start, or a branch), and an empty mirror for it. */
  const start = (message: Omit<Extract<HostIn, { type: 'init' }>, 'type' | 'epoch'>) => {
    epoch += 1;
    requested = message.until ?? 0;
    headTick = 0;
    state = base.sim.state;
    done = false;
    settled = false;
    outcome = null;
    headMotion = createMotionRecorder(rate);
    viewMotion = headMotion;
    events = [];
    combat = [];
    viewCombat = combat;
    samples = [];
    hashes = [];
    keyframes = new Map();
    metrics = empty;
    verification = null;
    channel.post({ type: 'init', epoch, ...message });
  };
  start({ spec, ...(recording ? { recording } : {}) });

  /** Drops the head's future beyond the tick shown, re-simulating it in the worker. */
  const branch = () => {
    const at = view?.sim.tick ?? headTick;
    const kept = keptCommands(commands, origins, at);
    commands = kept.commands;
    origins = kept.origins;
    start({ spec, replay: kept, until: at });
    // The view (the run at that tick, here) stays until the worker is back there.
    if (at > 0) catchUp = at;
    else view = null;
  };

  /** Live again: back to the head, branching first if the view is behind it. */
  const live = () => {
    if (!view || catchUp !== null) return;
    if (view.sim.tick === headTick) view = null;
    else branch();
  };

  const session: FofSession & { readonly ticksPerSecond: number } = {
    spec,
    head,
    get view() {
      return view ?? head;
    },
    get motion() {
      return view ? viewMotion : headMotion;
    },
    get combatLog() {
      return view ? viewCombat : combat;
    },
    get events() {
      return events;
    },
    get viewTick() {
      return view ? view.sim.tick : headTick;
    },
    get headTick() {
      return headTick;
    },
    get scrubbed() {
      return view !== null;
    },
    metrics: () => metrics,
    get samples() {
      return samples;
    },
    cpu: () => cpu,
    get verification() {
      return verification;
    },
    /** Ticks per CPU second the worker last stepped at. */
    get ticksPerSecond() {
      return ticksPerSecond;
    },
    step() {
      live();
      session.advance(Math.max(requested, headTick) + 1);
    },
    advance(tick) {
      live();
      if (tick <= requested || settled) return;
      requested = tick;
      channel.post({ type: 'advance', epoch, until: tick });
    },
    seek(tick) {
      if (catchUp !== null) return;
      const target = Math.max(0, Math.min(Math.round(tick), headTick));
      if (target === (view ? view.sim.tick : headTick)) return;
      if (target === headTick) {
        view = null;
        return;
      }
      const at = runAt(spec, commands, origins, keyframes, target);
      view = at.run;
      viewMotion = at.motion;
      viewCombat = combat.filter((e) => e.tick < target);
    },
    submit(command) {
      live();
      channel.post({ type: 'submit', epoch, command });
    },
    recording() {
      return {
        schema: 'ambush.fof-lab-run',
        version: 1,
        spec,
        commands,
        origins,
        endTick: headTick,
        hashes: Array.from(hashes, (h) => h ?? null),
      };
    },
    dispose() {
      channel.close();
    },
  };
  return session;
}
