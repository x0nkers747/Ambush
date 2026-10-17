import type { ViewLoading } from '#view3d';
import type { BusyTask } from './busy';

// The 3D view's progress bar (docs/loading-overlay.md): from the view built
// until everything in it is in (the ground, buildings and vegetation, its
// textures, the finest ground tiles near the camera, the soldiers' models).
// The bar moves with the parts as they arrive, and between them with the
// time the last 3D view took to load in this browser, so it fills about as
// loading completes; it reaches 100 % only when the view is done.

/** Each part's share of the bar. */
const SHARES = {
  ground: 0.3,
  features: 0.2,
  vegetation: 0.2,
  textures: 0.05,
  tiles: 0.2,
  characters: 0.05,
} as const;

/** Expected loading time (ms) before any is known, and where the last one is kept. */
const DEFAULT_MS = 6000;
const KEY = 'ambush.view3dLoadMs';
/** Frames in a row it must report done (a tile requested late does not end it early). */
const DONE_FRAMES = 6;
/** Never waits longer than this (ms): the bar goes and the view goes on loading. */
const GIVE_UP_MS = 90_000;

function expectedMs(): number {
  try {
    const v = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 500 ? v : DEFAULT_MS;
  } catch {
    return DEFAULT_MS;
  }
}

function remember(ms: number): void {
  try {
    const previous = expectedMs();
    window.localStorage.setItem(KEY, String(Math.round(0.5 * previous + 0.5 * ms)));
  } catch {
    // Not remembered: the default next time.
  }
}

/**
 * Shows `task`'s progress while `loading` says the view is loading, and
 * calls `done` once it is all in, the view is gone (`alive`), or after
 * `GIVE_UP_MS`. Returns a function that stops following (without `done`).
 */
export function followViewLoading(
  loading: () => ViewLoading,
  task: BusyTask,
  done: () => void,
  /** Whether the view is still there: if not, it is over at once. */
  alive: () => boolean = () => true,
): () => void {
  const start = performance.now();
  const expected = expectedMs();
  let shown = 0;
  let maxWaiting = 0;
  let doneFrames = 0;
  let stopped = false;
  let frame = 0;
  const step = () => {
    if (stopped) return;
    if (!alive()) {
      stopped = true;
      done();
      return;
    }
    const l = loading();
    const elapsed = performance.now() - start;
    if (l.ground) maxWaiting = Math.max(maxWaiting, l.tilesWaiting);
    const tiles = !l.ground ? 0 : maxWaiting === 0 ? 1 : 1 - l.tilesWaiting / maxWaiting;
    const parts =
      (l.ground ? SHARES.ground : 0) +
      (l.features ? SHARES.features : 0) +
      (l.vegetation ? SHARES.vegetation : 0) +
      (l.textures ? SHARES.textures : 0) +
      SHARES.tiles * tiles +
      (l.characters ? SHARES.characters : 0);
    // Between the parts, the clock: no further than the expected time allows.
    const clock = Math.min(0.97, elapsed / expected);
    const target = Math.min(0.99, Math.max(parts, Math.min(clock, parts + 0.3)));
    // Never backwards.
    shown = Math.max(shown, target);
    doneFrames = l.done ? doneFrames + 1 : 0;
    if (doneFrames >= DONE_FRAMES || elapsed > GIVE_UP_MS) {
      stopped = true;
      if (doneFrames >= DONE_FRAMES) remember(elapsed);
      task.update(1);
      done();
      return;
    }
    task.update(shown);
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
  };
}
