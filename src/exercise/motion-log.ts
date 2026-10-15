import type { DeepReadonly, Posture, SimState, SoldierId, SoldierStatus } from '#sim';

// The soldiers' motion at every tick of a battle (docs/character-animation.md):
// where each stood, which way it faced, its posture and status, from the
// battle's first tick to now. The 3D characters are posed from it alone
// (with the combat log's shots), so a pose is a function of the simulation
// time: the same live, in the After-Action Review, at any playback speed and
// however the time was reached. Recording it never changes the simulation.
//
// Compact (34 bytes per soldier per tick, in chunks), unlike the battle's
// full-state keyframes.

const POSTURES: readonly Posture[] = ['standing', 'kneeling', 'prone'];
const STATUSES: readonly SoldierStatus[] = ['active', 'incapacitated'];

/** One soldier at one tick. */
export interface MotionSample {
  /** Map metres east and north, and the surface stood on (as `Soldier.position`). */
  x: number;
  y: number;
  z: number;
  /** Radians clockwise from grid north, in [0, 2π) (as `Soldier.azimuth`). */
  azimuth: number;
  posture: Posture;
  status: SoldierStatus;
}

export const emptyMotionSample = (): MotionSample => ({
  x: 0,
  y: 0,
  z: 0,
  azimuth: 0,
  posture: 'standing',
  status: 'active',
});

export interface MotionLog {
  readonly tickRateHz: number;
  /** The soldiers, in simulation order: a sample's soldier index. */
  readonly soldierIds: readonly SoldierId[];
  /** The first and the latest tick recorded. */
  readonly firstTick: number;
  readonly lastTick: number;
  /**
   * Changes when recorded ticks change: the log restarted (a new soldier set,
   * or time that did not follow on). Ticks before `lastTick` never change
   * otherwise; the latest tick follows the state while it is edited (plans
   * and placements between ticks).
   */
  readonly epoch: number;
  /** The soldier's index, or −1. */
  indexOf(id: SoldierId | string): number;
  /** Soldier `index` at `tick`, clamped to the recorded ticks, written into `out`. */
  read(index: number, tick: number, out: MotionSample): MotionSample;
}

export interface MotionRecorder extends MotionLog {
  /** Records the state at its tick: the next tick, or the latest one again (overwritten). */
  record(state: DeepReadonly<SimState>): void;
}

/** Ticks per chunk. */
const CHUNK = 1024;

interface Track {
  /** x, y, z, azimuth per tick. */
  readonly numbers: Float64Array[];
  /** posture and status codes per tick. */
  readonly codes: Uint8Array[];
}

export function createMotionRecorder(tickRateHz: number): MotionRecorder {
  let soldierIds: SoldierId[] = [];
  let index = new Map<string, number>();
  let tracks: Track[] = [];
  let firstTick = 0;
  let lastTick = -1;
  let epoch = 0;

  const restart = (state: DeepReadonly<SimState>) => {
    soldierIds = state.soldiers.map((s) => s.id);
    index = new Map(soldierIds.map((id, i) => [id, i]));
    tracks = soldierIds.map(() => ({ numbers: [], codes: [] }));
    firstTick = state.tick;
    lastTick = state.tick - 1;
    epoch += 1;
  };

  const write = (state: DeepReadonly<SimState>, offset: number) => {
    const chunk = Math.floor(offset / CHUNK);
    const at = offset - chunk * CHUNK;
    state.soldiers.forEach((s, i) => {
      const track = tracks[i];
      if (!track) return;
      while (track.numbers.length <= chunk) {
        track.numbers.push(new Float64Array(CHUNK * 4));
        track.codes.push(new Uint8Array(CHUNK * 2));
      }
      const n = track.numbers[chunk];
      const c = track.codes[chunk];
      if (!n || !c) return;
      n[at * 4] = s.position.x;
      n[at * 4 + 1] = s.position.y;
      n[at * 4 + 2] = s.position.z;
      n[at * 4 + 3] = s.azimuth;
      c[at * 2] = Math.max(0, POSTURES.indexOf(s.posture));
      c[at * 2 + 1] = Math.max(0, STATUSES.indexOf(s.status));
    });
  };

  const sameSoldiers = (state: DeepReadonly<SimState>) =>
    state.soldiers.length === soldierIds.length &&
    state.soldiers.every((s, i) => s.id === soldierIds[i]);

  return {
    tickRateHz,
    get soldierIds() {
      return soldierIds;
    },
    get firstTick() {
      return firstTick;
    },
    get lastTick() {
      return lastTick;
    },
    get epoch() {
      return epoch;
    },
    indexOf: (id) => index.get(id) ?? -1,
    read(i, tick, out) {
      const track = tracks[i];
      if (!track || lastTick < firstTick) return out;
      const offset = Math.min(Math.max(tick, firstTick), lastTick) - firstTick;
      const chunk = Math.floor(offset / CHUNK);
      const at = offset - chunk * CHUNK;
      const n = track.numbers[chunk];
      const c = track.codes[chunk];
      if (!n || !c) return out;
      out.x = n[at * 4] ?? 0;
      out.y = n[at * 4 + 1] ?? 0;
      out.z = n[at * 4 + 2] ?? 0;
      out.azimuth = n[at * 4 + 3] ?? 0;
      out.posture = POSTURES[c[at * 2] ?? 0] ?? 'standing';
      out.status = STATUSES[c[at * 2 + 1] ?? 0] ?? 'active';
      return out;
    },
    record(state) {
      const followsOn = state.tick === lastTick || state.tick === lastTick + 1;
      if (lastTick < firstTick || !followsOn || !sameSoldiers(state)) restart(state);
      write(state, state.tick - firstTick);
      lastTick = state.tick;
    },
  };
}
