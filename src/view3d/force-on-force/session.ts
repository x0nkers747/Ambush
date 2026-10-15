import { createMotionRecorder, type CombatEvent, type MotionRecorder } from '#exercise';
import {
  createFofMetrics,
  createFofRun,
  type FofCommandOrigin,
  type FofMetrics,
  type FofMetricsRecorder,
  type FofRun,
  type FofRunSpec,
  type FofSample,
} from '#exercise/force-on-force';
import { hashSimState, type SimCommand, type SimEvent, type SimSnapshot } from '#sim';

// A Force-on-Force Lab session (docs/behavior-lab/force-on-force/05): the run
// being built (the head), the tick shown (live or scrubbed back), and the
// recording that reproduces it. Everything shown comes from the simulation:
// the head steps the real kernel; scrubbing back restores a keyframe and
// re-simulates to the tick shown; a saved recording is replayed by
// re-simulation and checked against its per-second state hashes.

/** A saved experiment: enough to reproduce every tick of it. */
export interface FofRecording {
  readonly schema: 'ambush.fof-lab-run';
  readonly version: 1;
  readonly spec: FofRunSpec;
  readonly commands: readonly SimCommand[];
  readonly origins: readonly FofCommandOrigin[];
  readonly endTick: number;
  /** `hashSimState` at every whole second (index = second). */
  readonly hashes: readonly string[];
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

/** Seconds between keyframes, per 100 soldiers begun (a snapshot of a large run is large). */
const KEYFRAME_SECONDS = 5;
const HISTORY_SECONDS = 2;
const CPU_SAMPLES = 300;

export interface FofSession {
  readonly spec: FofRunSpec;
  readonly head: FofRun;
  /** The run at the tick shown. */
  readonly view: FofRun;
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
  cpu(): { mean: number; p95: number };
  readonly verification: Verification | null;
  step(): void;
  seek(tick: number): void;
  submit(command: SimCommand): void;
  recording(): FofRecording;
}

/** Events the lab keeps (its timeline, overlays and the characters). */
const KEPT: ReadonlySet<SimEvent['type']> = new Set([
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

/** A burst as the character layer's shot (it reads the shooter and the time). */
function asCombatEvent(event: SimEvent): CombatEvent | null {
  if (event.type === 'soldierIncapacitated') return event;
  if (event.type !== 'fofFire') return null;
  return {
    type: 'shotFired',
    tick: event.tick,
    atSeconds: event.atSeconds,
    shooterId: event.shooterId,
    shooterSide: event.side,
    targetId: event.targetId,
    weaponProfileRef: event.weapon,
    rangeM: event.rangeM,
    hitProbability: event.hitProbability,
    hit: event.hit,
    incapacitated: event.incapacitated,
  };
}

export function createFofSession(spec: FofRunSpec, recording?: FofRecording): FofSession {
  const rate = spec.tickRateHz;
  const replay = recording
    ? { commands: recording.commands, origins: recording.origins }
    : undefined;
  let head = createFofRun(spec, undefined, replay);
  const keyframeSeconds =
    KEYFRAME_SECONDS * Math.max(1, Math.ceil(head.sim.state.soldiers.length / 100));
  let view = head;
  let motion = createMotionRecorder(rate);
  let metrics: FofMetricsRecorder = createFofMetrics(head.sim);
  let hashes: string[] = [];
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
    if (sim.tick % (keyframeSeconds * rate) === 0) keyframes.set(sim.tick, sim.snapshot());
  };
  motion.record(head.sim.state);
  atTick();

  const stepHead = () => {
    const t = performance.now();
    const stepped = head.step();
    cpu.push(performance.now() - t);
    if (cpu.length > CPU_SAMPLES) cpu.shift();
    metrics.sample(stepped);
    motion.record(head.sim.state);
    for (const event of stepped) {
      if (!KEPT.has(event.type)) continue;
      events.push({ seconds: head.sim.timeSeconds, event });
      const c = asCombatEvent(event);
      if (c) combat.push(c);
    }
    atTick();
  };

  /** Drops the head's future beyond the tick shown, re-simulating from the start. */
  const branch = () => {
    const at = view.sim.tick;
    const keep = head.commands
      .map((command, i) => ({ command, origin: head.origins[i] ?? 'user' }))
      .filter(({ command, origin }) => origin !== 'user' || command.tick < at);
    head = createFofRun(spec, undefined, {
      commands: keep.map((c) => c.command),
      origins: keep.map((c) => c.origin),
    });
    view = head;
    motion = createMotionRecorder(rate);
    metrics = createFofMetrics(head.sim);
    hashes = [];
    keyframes = new Map();
    events = [];
    combat = [];
    viewCombat = combat;
    reference = null;
    verification = null;
    motion.record(head.sim.state);
    atTick();
    while (head.sim.tick < at) stepHead();
  };

  /** A run at tick `tick` of the head: from the keyframe before it, re-simulated. */
  const viewAt = (tick: number): FofRun => {
    let from = 0;
    for (const k of keyframes.keys()) if (k <= tick - HISTORY_SECONDS * rate && k > from) from = k;
    const run = createFofRun(spec, undefined, { commands: head.commands, origins: head.origins });
    const snapshot = keyframes.get(from);
    if (snapshot) {
      run.sim.restore(snapshot);
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

  return {
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
    cpu() {
      if (cpu.length === 0) return { mean: 0, p95: 0 };
      const sorted = [...cpu].sort((a, b) => a - b);
      return {
        mean: cpu.reduce((a, b) => a + b, 0) / cpu.length,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      };
    },
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
    seek(tick) {
      const target = Math.max(0, Math.min(Math.round(tick), head.sim.tick));
      if (target === view.sim.tick) return;
      if (target === head.sim.tick) {
        viewAt(target);
        view = head;
      } else {
        view = viewAt(target);
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
        hashes: [...hashes],
      };
    },
  };
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
