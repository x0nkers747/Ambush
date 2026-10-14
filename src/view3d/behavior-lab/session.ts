import { createMotionRecorder, type MotionRecorder } from '#exercise';
import {
  createLabRun,
  createMetrics,
  type CommandOrigin,
  type LabMetrics,
  type LabRun,
  type LabRunSpec,
  type LabSample,
  type MetricsRecorder,
} from '#exercise/behavior-lab';
import {
  behaviorDiagnostics,
  hashSimState,
  type BehaviorDiagnostics,
  type SimCommand,
  type SimEvent,
  type SimSnapshot,
} from '#sim';

// A Behavior Lab session (docs/behavior-lab/04 §4): the run being built (the
// head), what is shown (a tick of it, live or scrubbed back), and the
// recording that reproduces it. Everything shown comes from the simulation:
// the head steps the real kernel; scrubbing back restores a keyframe and
// re-simulates the recorded commands to the tick shown; a saved recording is
// replayed by re-simulation and checked against its per-second state hashes.

/** A saved run: enough to reproduce every tick of it. */
export interface LabRecording {
  readonly schema: 'ambush.behavior-lab-run';
  readonly version: 1;
  readonly spec: LabRunSpec;
  readonly commands: readonly SimCommand[];
  readonly origins: readonly CommandOrigin[];
  /** The last tick recorded. */
  readonly endTick: number;
  /** `hashSimState` at every whole second (index = second). */
  readonly hashes: readonly string[];
}

/** Checking a replay against a recording's hashes. */
export interface Verification {
  readonly checked: number;
  readonly mismatches: number;
  /** First second whose hash differed, or null. */
  readonly firstMismatch: number | null;
}

/** Keyframes every this many seconds of the head, for scrubbing. */
const KEYFRAME_SECONDS = 5;
/** Ticks of motion recorded before a scrubbed tick (the characters read speed from history). */
const HISTORY_SECONDS = 2;
/** Simulation CPU samples kept (ticks). */
const CPU_SAMPLES = 300;

export interface LabSession {
  readonly spec: LabRunSpec;
  /** The run being built; `view` is the tick shown (the head's, or earlier when scrubbed back). */
  readonly head: LabRun;
  readonly view: LabRun;
  readonly motion: MotionRecorder;
  /** Diagnostics at the tick shown and the tick before it (for interpolation). */
  readonly diagnostics: BehaviorDiagnostics;
  readonly previousDiagnostics: BehaviorDiagnostics;
  /** Tick shown, and the last tick of the head. */
  readonly viewTick: number;
  readonly headTick: number;
  readonly scrubbed: boolean;
  /** Metrics of the head so far, and its per-second samples. */
  metrics(): LabMetrics;
  readonly samples: readonly LabSample[];
  /** Simulation CPU per tick (ms): mean and 95th percentile of recent ticks. */
  cpu(): { mean: number; p95: number };
  /** Events of the head, newest last (bounded). */
  readonly events: readonly { readonly seconds: number; readonly event: SimEvent }[];
  readonly verification: Verification | null;
  /** Advances the head one tick (from the tick shown: scrubbed back, the future is dropped first). */
  step(): void;
  /** Shows tick `tick` of the head (scrubbing; nothing is simulated beyond the head). */
  seek(tick: number): void;
  /** Gives a command at the head (dropping any future first). */
  submit(command: SimCommand): void;
  recording(): LabRecording;
}

/** Starts a session for `spec`, or replays `recording` (checking its hashes as it goes). */
export function createLabSession(spec: LabRunSpec, recording?: LabRecording): LabSession {
  const rate = spec.tickRateHz;
  let head = recording
    ? createLabRun(spec, undefined, {
        commands: recording.commands,
        origins: recording.origins,
        legsIssued: recording.origins.filter((o) => o === 'leg').length,
      })
    : createLabRun(spec);
  let view = head;
  let motion = createMotionRecorder(rate);
  let metrics: MetricsRecorder = createMetrics(head.sim, head.unitId);
  let hashes: string[] = [];
  let keyframes = new Map<number, SimSnapshot>();
  let events: { seconds: number; event: SimEvent }[] = [];
  const cpu: number[] = [];
  let reference = recording ?? null;
  let verification: Verification | null = recording
    ? { checked: 0, mismatches: 0, firstMismatch: null }
    : null;
  let diagnostics = behaviorDiagnostics(head.sim.state, head.sim.world, 0);
  let previousDiagnostics = diagnostics;

  const atTick = () => {
    const sim = head.sim;
    if (sim.tick % rate === 0) {
      const second = sim.tick / rate;
      const hash = hashSimState(sim.state);
      hashes[second] = hash;
      if (reference && verification && second < reference.hashes.length) {
        const same = reference.hashes[second] === hash;
        verification = {
          checked: verification.checked + 1,
          mismatches: verification.mismatches + (same ? 0 : 1),
          firstMismatch: verification.firstMismatch ?? (same ? null : second),
        };
      }
    }
    if (sim.tick % (KEYFRAME_SECONDS * rate) === 0) keyframes.set(sim.tick, sim.snapshot());
  };
  motion.record(head.sim.state);
  atTick();

  /** Steps the head one tick, recording everything. */
  const stepHead = () => {
    const t = performance.now();
    const stepped = head.step();
    cpu.push(performance.now() - t);
    if (cpu.length > CPU_SAMPLES) cpu.shift();
    metrics.sample(stepped);
    motion.record(head.sim.state);
    for (const event of stepped) events.push({ seconds: head.sim.timeSeconds, event });
    if (events.length > 400) events = events.slice(-300);
    atTick();
  };

  const refreshDiagnostics = () => {
    previousDiagnostics = diagnostics;
    diagnostics = behaviorDiagnostics(view.sim.state, view.sim.world, view.sim.timeSeconds);
  };

  /**
   * Drops the head's future beyond the tick shown: rebuilds it from the
   * commands given before that tick (and the script's own), re-simulating
   * from the start so metrics, motion and hashes are those of the new branch.
   */
  const branch = () => {
    const at = view.sim.tick;
    const keep = head.commands
      .map((command, i) => ({ command, origin: head.origins[i] ?? 'user' }))
      .filter(({ command, origin }) => origin !== 'user' || command.tick < at);
    const legs = keep.filter((c) => c.origin === 'leg' && c.command.tick < at).length;
    const commands = keep.filter((c) => c.origin !== 'leg' || c.command.tick < at);
    head = createLabRun(spec, undefined, {
      commands: commands.map((c) => c.command),
      origins: commands.map((c) => c.origin),
      legsIssued: legs,
    });
    view = head;
    motion = createMotionRecorder(rate);
    metrics = createMetrics(head.sim, head.unitId);
    hashes = [];
    keyframes = new Map();
    events = [];
    // A branch is a new run: the recording it came from no longer describes it.
    reference = null;
    verification = null;
    motion.record(head.sim.state);
    atTick();
    while (head.sim.tick < at) stepHead();
    refreshDiagnostics();
  };

  /** A run showing tick `tick` of the head: from the keyframe before it, re-simulated. */
  const viewAt = (tick: number): LabRun => {
    let from = 0;
    for (const k of keyframes.keys()) if (k <= tick - HISTORY_SECONDS * rate && k > from) from = k;
    const run = createLabRun(spec, undefined, {
      commands: head.commands,
      origins: head.origins,
      legsIssued: head.origins.filter((o) => o === 'leg').length,
    });
    const snapshot = keyframes.get(from);
    if (snapshot) {
      run.sim.restore(snapshot);
      // Restoring drops queued commands: give back those still to come.
      for (const command of head.commands) if (command.tick >= from) run.sim.submit(command);
    }
    motion = createMotionRecorder(rate);
    motion.record(run.sim.state);
    while (run.sim.tick < tick) {
      run.sim.step();
      motion.record(run.sim.state);
    }
    return run;
  };

  const session: LabSession = {
    spec,
    get head() {
      return head;
    },
    get view() {
      return view;
    },
    get motion() {
      return motion;
    },
    get diagnostics() {
      return diagnostics;
    },
    get previousDiagnostics() {
      return previousDiagnostics;
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
    cpu() {
      if (cpu.length === 0) return { mean: 0, p95: 0 };
      const sorted = [...cpu].sort((a, b) => a - b);
      return {
        mean: cpu.reduce((a, b) => a + b, 0) / cpu.length,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      };
    },
    get events() {
      return events;
    },
    get verification() {
      return verification;
    },
    step() {
      if (view !== head) {
        if (view.sim.tick === head.sim.tick) {
          view = head;
        } else {
          branch();
        }
      }
      stepHead();
      refreshDiagnostics();
    },
    seek(tick) {
      const target = Math.max(0, Math.min(Math.round(tick), head.sim.tick));
      if (target === view.sim.tick) return;
      if (target === head.sim.tick) {
        view = head;
        // The head's own motion log was replaced while scrubbing: rebuild its recent history.
        viewAt(target);
        view = head;
      } else {
        view = viewAt(target);
      }
      refreshDiagnostics();
      previousDiagnostics = diagnostics;
    },
    submit(command) {
      if (view !== head) branch();
      head.submit({ ...command, tick: head.sim.tick });
    },
    recording() {
      return {
        schema: 'ambush.behavior-lab-run',
        version: 1,
        spec,
        commands: head.commands,
        origins: head.origins,
        endTick: head.sim.tick,
        hashes: [...hashes],
      };
    },
  };
  refreshDiagnostics();
  return session;
}

/**
 * A recording as JSON text. Negative zero is kept (as the string "NUM:-0"):
 * plain JSON writes it as 0, and the state hash tells them apart, so a
 * command with a −0 in it would otherwise replay to different hashes.
 */
export function recordingToJson(recording: LabRecording): string {
  return JSON.stringify(recording, (_key, value: unknown) =>
    typeof value === 'number' && Object.is(value, -0) ? 'NUM:-0' : value,
  );
}

/** A recording from its JSON text (see `recordingToJson`). */
export function recordingFromJson(text: string): LabRecording {
  return parseRecording(
    JSON.parse(text, (_key, value: unknown) => (value === 'NUM:-0' ? -0 : value)),
  );
}

/** Checks that `data` is a recording this lab can replay (throws an Error saying why not). */
export function parseRecording(data: unknown): LabRecording {
  const r = data as Partial<LabRecording>;
  if (r.schema !== 'ambush.behavior-lab-run' || r.version !== 1) {
    throw new Error('not a Behavior Lab run (schema ambush.behavior-lab-run, version 1)');
  }
  if (!r.spec || !Array.isArray(r.commands) || !Array.isArray(r.hashes)) {
    throw new Error('the run has no spec, commands or hashes');
  }
  return r as LabRecording;
}
