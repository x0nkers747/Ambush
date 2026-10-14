import type { SoldierView } from '../character';
import type { PoseInput } from '../pose-input';
import type { SimFrame } from '../sim';

export type RuntimeId = 'native' | 'animouse';

export interface FrameContext {
  /** Simulation seconds since the previous update in continuous playback. */
  readonly dt: number;
  /** True when time jumped (seek, scrub, restart) instead of advancing by `dt`. */
  readonly seeked: boolean;
  /** The recording (stateless runtimes read history from it). */
  readonly frames: readonly SimFrame[];
}

/** One soldier's animator: poses `soldier`'s skeleton for an input. */
export interface Animator {
  update(input: PoseInput, ctx: FrameContext): void;
  /** Current layers, states and weights, for the info panel. */
  describe(): string;
  /** The recording changed (live sim extended it, or a new one started). */
  reset(frames: readonly SimFrame[]): void;
  dispose(): void;
}

export interface Runtime {
  readonly id: RuntimeId;
  readonly label: string;
  /** Whether a pose depends only on (recording, time) — no hidden history. */
  readonly stateless: boolean;
  create(soldier: SoldierView, frames: readonly SimFrame[]): Animator;
}
