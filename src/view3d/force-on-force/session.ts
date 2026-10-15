import {
  combatEventOf,
  createMotionRecorder,
  type CombatEvent,
  type MotionRecorder,
} from '#exercise';
import {
  createFofMetrics,
  createFofRun,
  type FofCommandOrigin,
  type FofMetrics,
  type FofMetricsRecorder,
  type FofReplay,
  type FofRun,
  type FofRunSpec,
  type FofSample,
} from '#exercise/force-on-force';
import {
  hashSimState,
  type FofOutcome,
  type SimCommand,
  type SimEvent,
  type SimSnapshot,
  type Simulation,
} from '#sim';

// A Force-on-Force Lab session (docs/behavior-lab/force-on-force/05): the run
// being built (the head), the tick shown (live or scrubbed back), and the
// recording that reproduces it. Everything shown comes from the simulation:
// the head steps the real kernel; scrubbing back restores a keyframe and
// re-simulates to the tick shown; a saved recording is replayed by
// re-simulation and checked against its per-second state hashes.
//
// This session steps the kernel on the calling thread. The lab runs it in a
// worker (`worker-session.ts`), so that the page keeps drawing whatever the
// simulation costs; both have this interface.

/** A saved experiment: enough to reproduce every tick of it. */
export interface FofRecording {
  readonly schema: 'ambush.fof-lab-run';
  readonly version: 1;
  readonly spec: FofRunSpec;
  readonly commands: readonly SimCommand[];
  readonly origins: readonly FofCommandOrigin[];
  readonly endTick: number;
  /**
   * `hashSimState` at every whole second (index = second); for runs of more
   * than 100 soldiers, only at every `hashSecondsFor` seconds (the others empty).
   */
  readonly hashes: readonly (string | null)[];
}

export interface Verification {
  readonly checked: number;
  readonly mismatches: number;
  readonly firstMismatch: number | null;
}

/** An event of the head, with its time. */
export interface TimedEvent {
  readonly seconds: number;
  readonly event: SimEvent;
}

/** What the lab reads of a run (a real run, or the page's mirror of the worker's). */
export interface FofRunView {
  readonly spec: FofRunSpec;
  readonly forces: FofRun['forces'];
  readonly sim: Pick<Simulation, 'state' | 'tick' | 'timeSeconds' | 'world'>;
  readonly commands: readonly SimCommand[];
  readonly origins: readonly FofCommandOrigin[];
  readonly done: boolean;
  readonly settled: boolean;
  readonly outcome: FofOutcome | null;
}

/** Seconds between keyframes, per 100 soldiers begun (a snapshot of a large run is large). */
const KEYFRAME_SECONDS = 5;
const HISTORY_SECONDS = 2;
const CPU_SAMPLES = 300;
/** `advance` steps for at most this long (ms; at least one tick), so a frame keeps drawing. */
export const ADVANCE_BUDGET_MS = 40;

/**
 * Seconds between state hashes of a run with `soldiers` soldiers: every
 * second, and for large runs at each keyframe (hashing a thousand soldiers'
 * state takes over 100 ms).
 */
export function hashSecondsFor(soldiers: number): number {
  return soldiers <= 100 ? 1 : keyframeSecondsFor(soldiers);
}

/** Seconds between keyframes of a run with `soldiers` soldiers. */
export function keyframeSecondsFor(soldiers: number): number {
  return KEYFRAME_SECONDS * Math.max(1, Math.ceil(soldiers / 100));
}

export interface FofSession {
  readonly spec: FofRunSpec;
  readonly head: FofRunView;
  /** The run at the tick shown. */
  readonly view: FofRunView;
  readonly motion: MotionRecorder;
  /** Shots and casualties up to the tick shown, for the characters (aiming, firing, falling). */
  readonly combatLog: readonly CombatEvent[];
  /** Every event of the head that the lab shows (no movement bookkeeping), oldest first. */
  readonly events: readonly TimedEvent[];
  readonly viewTick: number;
  readonly headTick: number;
  readonly scrubbed: boolean;
  metrics(): FofMetrics;
  readonly samples: readonly FofSample[];
  /** Simulation CPU per tick (ms), over the last ticks. */
  cpu(): { mean: number; p95: number };
  readonly verification: Verification | null;
  /** One tick. */
  step(): void;
  /** Steps toward `tick` (at most `ADVANCE_BUDGET_MS` here; the worker keeps going). */
  advance(tick: number): void;
  seek(tick: number): void;
  submit(command: SimCommand): void;
  recording(): FofRecording;
  /** Stops the session (its worker, if any). */
  dispose(): void;
}

/** Events the lab keeps (its timeline, overlays and the characters). */
export const KEPT: ReadonlySet<SimEvent['type']> = new Set([
  'contactObserved',
  'forcePhaseChanged',
  'fofFire',
  'suppressionChanged',
  'soldierIncapacitated',
  'fofEnded',
  'unitOrdered',
  'unitTaskEnded',
  'commandRejected',
]);

/** Mean and 95th percentile of CPU samples. */
export function cpuSummary(cpu: readonly number[]): { mean: number; p95: number } {
  if (cpu.length === 0) return { mean: 0, p95: 0 };
  const sorted = [...cpu].sort((a, b) => a - b);
  return {
    mean: cpu.reduce((a, b) => a + b, 0) / cpu.length,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
  };
}

/**
 * A run at `tick`, re-simulated from the last keyframe at least
 * `HISTORY_SECONDS` before it (with its motion over that stretch, for the
 * characters' recent history).
 */
export function runAt(
  spec: FofRunSpec,
  commands: readonly SimCommand[],
  origins: readonly FofCommandOrigin[],
  keyframes: ReadonlyMap<number, SimSnapshot>,
  tick: number,
): { run: FofRun; motion: MotionRecorder } {
  const rate = spec.tickRateHz;
  let from = 0;
  for (const k of keyframes.keys()) if (k <= tick - HISTORY_SECONDS * rate && k > from) from = k;
  const run = createFofRun(spec, undefined, { commands, origins });
  const snapshot = keyframes.get(from);
  if (snapshot) {
    run.sim.restore(snapshot);
    for (const command of commands) if (command.tick >= from) run.sim.submit(command);
  }
  const motion = createMotionRecorder(rate);
  motion.record(run.sim.state);
  while (run.sim.tick < tick) {
    run.sim.step();
    motion.record(run.sim.state);
  }
  return { run, motion };
}

/** The commands of a run to keep when it branches at `tick`: the setup's, and the user's before it. */
export function keptCommands(
  commands: readonly SimCommand[],
  origins: readonly FofCommandOrigin[],
  tick: number,
): { commands: SimCommand[]; origins: FofCommandOrigin[] } {
  const keep = commands
    .map((command, i) => ({ command, origin: origins[i] ?? 'user' }))
    .filter(({ command, origin }) => origin !== 'user' || command.tick < tick);
  return { commands: keep.map((c) => c.command), origins: keep.map((c) => c.origin) };
}

/** Hooks of a session for its worker host: everything it records, as it records it. */
export interface FofSessionHooks {
  /** After every tick of the head, with that tick's events. */
  onTick?(run: FofRun, events: readonly SimEvent[]): void;
  /** A keyframe taken. */
  onKeyframe?(tick: number, snapshot: SimSnapshot): void;
  /** Without a recording: commands to run with instead of the setup's (a branch). */
  replay?: FofReplay;
}

export function createFofSession(
  spec: FofRunSpec,
  recording?: FofRecording,
  hooks: FofSessionHooks = {},
): FofSession {
  const rate = spec.tickRateHz;
  const replay = recording
    ? { commands: recording.commands, origins: recording.origins }
    : hooks.replay;
  let head = createFofRun(spec, undefined, replay);
  const keyframeSeconds = keyframeSecondsFor(head.sim.state.soldiers.length);
  const hashSeconds = hashSecondsFor(head.sim.state.soldiers.length);
  let view: FofRun = head;
  let headMotion = createMotionRecorder(rate);
  let viewMotion: MotionRecorder = headMotion;
  let metrics: FofMetricsRecorder = createFofMetrics(head.sim);
  let hashes: (string | null)[] = [];
  let keyframes = new Map<number, SimSnapshot>();
  let events: TimedEvent[] = [];
  let combat: CombatEvent[] = [];
  let viewCombat: CombatEvent[] = combat;
  const cpu: number[] = [];
  let reference = recording ?? null;
  let verification: Verification | null = recording
    ? { checked: 0, mismatches: 0, firstMismatch: null }
    : null;

  const atTick = () => {
    const sim = head.sim;
    if (sim.tick % (hashSeconds * rate) === 0) {
      const second = sim.tick / rate;
      const hash = hashSimState(sim.state);
      hashes[second] = hash;
      const expected = reference?.hashes[second];
      if (reference && verification && typeof expected === 'string') {
        const same = expected === hash;
        verification = {
          checked: verification.checked + 1,
          mismatches: verification.mismatches + (same ? 0 : 1),
          firstMismatch: verification.firstMismatch ?? (same ? null : second),
        };
      }
    }
    if (sim.tick % (keyframeSeconds * rate) === 0) {
      const snapshot = sim.snapshot();
      keyframes.set(sim.tick, snapshot);
      hooks.onKeyframe?.(sim.tick, snapshot);
    }
  };
  headMotion.record(head.sim.state);
  atTick();

  const stepHead = () => {
    const t = performance.now();
    const stepped = head.step();
    cpu.push(performance.now() - t);
    if (cpu.length > CPU_SAMPLES) cpu.shift();
    metrics.sample(stepped);
    headMotion.record(head.sim.state);
    for (const event of stepped) {
      if (!KEPT.has(event.type)) continue;
      events.push({ seconds: head.sim.timeSeconds, event });
      const c = combatEventOf(event);
      if (c) combat.push(c);
    }
    atTick();
    hooks.onTick?.(head, stepped);
  };

  /** Drops the head's future beyond the tick shown, re-simulating from the start. */
  const branch = () => {
    const at = view.sim.tick;
    head = createFofRun(spec, undefined, keptCommands(head.commands, head.origins, at));
    view = head;
    headMotion = createMotionRecorder(rate);
    viewMotion = headMotion;
    metrics = createFofMetrics(head.sim);
    hashes = [];
    keyframes = new Map();
    events = [];
    combat = [];
    viewCombat = combat;
    reference = null;
    verification = null;
    headMotion.record(head.sim.state);
    atTick();
    while (head.sim.tick < at) stepHead();
  };

  const session: FofSession = {
    spec,
    get head() {
      return head;
    },
    get view() {
      return view;
    },
    get motion() {
      return view === head ? headMotion : viewMotion;
    },
    get combatLog() {
      return view === head ? combat : viewCombat;
    },
    get events() {
      return events;
    },
    get viewTick() {
      return view.sim.tick;
    },
    get headTick() {
      return head.sim.tick;
    },
    get scrubbed() {
      return view !== head;
    },
    metrics: () => metrics.result(),
    get samples() {
      return metrics.samples;
    },
    cpu: () => cpuSummary(cpu),
    get verification() {
      return verification;
    },
    step() {
      if (view !== head) {
        if (view.sim.tick === head.sim.tick) view = head;
        else branch();
      }
      stepHead();
    },
    advance(tick) {
      const until = performance.now() + ADVANCE_BUDGET_MS;
      for (let n = 0; head.sim.tick < tick && !head.settled; n += 1) {
        if (n > 0 && performance.now() >= until) break;
        session.step();
      }
    },
    seek(tick) {
      const target = Math.max(0, Math.min(Math.round(tick), head.sim.tick));
      if (target === view.sim.tick) return;
      if (target === head.sim.tick) {
        view = head;
      } else {
        const at = runAt(spec, head.commands, head.origins, keyframes, target);
        view = at.run;
        viewMotion = at.motion;
        viewCombat = combat.filter((e) => e.tick < target);
      }
    },
    submit(command) {
      if (view !== head) branch();
      head.submit({ ...command, tick: head.sim.tick });
    },
    recording() {
      return {
        schema: 'ambush.fof-lab-run',
        version: 1,
        spec,
        commands: head.commands,
        origins: head.origins,
        endTick: head.sim.tick,
        hashes: Array.from(hashes, (h) => h ?? null),
      };
    },
    dispose() {
      // Nothing to stop on this thread.
    },
  };
  return session;
}

/** A recording as JSON text (negative zero kept, as in the Behavior Lab). */
export function fofRecordingToJson(recording: FofRecording): string {
  return JSON.stringify(recording, (_key, value: unknown) =>
    typeof value === 'number' && Object.is(value, -0) ? 'NUM:-0' : value,
  );
}

/** A recording from its JSON text; throws an Error saying why it is not one. */
export function fofRecordingFromJson(text: string): FofRecording {
  const data = JSON.parse(text, (_key, value: unknown) => (value === 'NUM:-0' ? -0 : value)) as
    Partial<FofRecording> | undefined;
  if (data?.schema !== 'ambush.fof-lab-run' || data.version !== 1) {
    throw new Error('not a Force-on-Force Lab run (schema ambush.fof-lab-run, version 1)');
  }
  if (!data.spec || !Array.isArray(data.commands) || !Array.isArray(data.hashes)) {
    throw new Error('the run has no spec, commands or hashes');
  }
  return data as FofRecording;
}
