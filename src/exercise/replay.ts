import { clonePlainData, type DeepReadonly, type SimEvent, type SimState } from '#sim';

// The After Action Review's recording (docs/adr/0026): the authoritative
// simulation state at every tick from the trainee's TRIGGER AMBUSH to the end
// of the engagement. A replay shows these states; it never steps the
// simulation, draws a random number or resolves a shot.

/**
 * What happened from the trigger on. `frames[0]` is the state at the start of
 * the trigger tick (the moment the ambush was sprung, before the engagement
 * begins); `frames[k]` the state after `k` more ticks. The combat events and
 * timeline that go with it are the exercise's own (`combatLog`, `timeline`):
 * a replay view shows those up to its frame.
 */
export interface ReplayRecording {
  readonly tickRateHz: number;
  /** The tick and simulation time of the trigger: replay time T+0. */
  readonly triggerTick: number;
  readonly triggerSeconds: number;
  readonly frames: readonly DeepReadonly<SimState>[];
  /**
   * Every simulation event from the trigger tick on, in order: a tick's
   * events come with the frame after it (`frames[event.tick - triggerTick + 1]`).
   */
  readonly events: readonly SimEvent[];
  /** Whether the engagement has ended, so no more frames will come. */
  readonly complete: boolean;
  /** Replay time of the last frame, in simulation seconds since the trigger. */
  readonly durationSeconds: number;
}

/** Replay seconds since the trigger of `frame`. */
export function frameSeconds(recording: ReplayRecording, frame: number): number {
  return frame / recording.tickRateHz;
}

/**
 * The frame shown at `seconds` of replay time: the last one at or before it,
 * within the recording. The same time always gives the same frame, however
 * playback got there (speed, seeking backward or forward).
 */
export function frameAt(recording: ReplayRecording, seconds: number): number {
  const last = recording.frames.length - 1;
  if (last <= 0 || !(seconds > 0)) return 0;
  // A small tolerance, so a time computed as `k / rate` lands on frame k.
  return Math.min(last, Math.floor(seconds * recording.tickRateHz + 1e-9));
}

/**
 * A function that copies the live simulation state into a frame. Everything
 * is copied, except the parts the simulation never changes in place (a
 * soldier's orders and generated route, an engagement area): those are copied
 * once and shared by every frame until the simulation replaces them, which
 * keeps a recording small. Frames are never changed afterwards.
 */
export function createStateRecorder(): (state: DeepReadonly<SimState>) => DeepReadonly<SimState> {
  const shared = new WeakMap<object, unknown>();
  const share = <T extends object>(live: T): T => {
    let copy = shared.get(live) as T | undefined;
    if (copy === undefined) {
      copy = clonePlainData(live);
      shared.set(live, copy);
    }
    return copy;
  };
  return (s) => {
    const engagement = s.engagement;
    return {
      ...s,
      rng: clonePlainData(s.rng),
      units: s.units.map((u) => ({ ...u })),
      soldiers: s.soldiers.map((soldier) => ({
        ...soldier,
        position: { ...soldier.position },
        orders: soldier.orders && {
          ...soldier.orders,
          orders: share(soldier.orders.orders),
          legPaths: share(soldier.orders.legPaths),
        },
      })),
      engagementAreas: s.engagementAreas.map(share),
      ...(engagement
        ? {
            engagement: {
              ...engagement,
              combatants: engagement.combatants.map((c) => ({ ...c, stats: { ...c.stats } })),
              end: engagement.end && { ...engagement.end },
            },
          }
        : {}),
    };
  };
}
