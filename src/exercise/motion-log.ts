import {
  conditionOf,
  type DeepReadonly,
  type Posture,
  type SimState,
  type SoldierId,
  type SoldierStatus,
  type VehicleCombat,
  type VehicleCondition,
} from '#sim';

// The soldiers' motion at every tick of a battle (docs/character-animation.md):
// where each stood, which way it faced, its posture and status, from the
// battle's first tick to now. The 3D characters are posed from it alone
// (with the combat log's shots), so a pose is a function of the simulation
// time: the same live, in the After-Action Review, at any playback speed and
// however the time was reached. Recording it never changes the simulation.
//
// Compact (34 bytes per soldier per tick, in chunks), unlike the battle's
// full-state keyframes.
//
// Vehicles (docs/vehicles.md) are recorded after the soldiers, as movers of
// their own: where each is, its heading as the azimuth, always standing and
// active (`motionMovers`). Each vehicle's articulation is recorded beside
// (docs/combined-arms.md §11): its mounts' traverse and elevation, its
// condition, immobilized and burning, so the views pose turrets and show
// damage from the log alone, live and in the review alike.

/** Mounts recorded per vehicle (their azimuth and elevation, in platform order). */
export const MAX_LOGGED_MOUNTS = 4;
/** Numbers per vehicle per tick: two per mount, then its condition and its flags. */
export const ARTICULATION_STRIDE = MAX_LOGGED_MOUNTS * 2 + 2;
const CONDITIONS: readonly VehicleCondition[] = [
  'operational',
  'damaged',
  'missionKill',
  'destroyed',
];

/** A vehicle's articulation at one tick. */
export interface ArticulationSample {
  /** Azimuth (rad, from its parent's forward, clockwise) and elevation of each mount, in pairs. */
  readonly mounts: Float64Array;
  condition: VehicleCondition;
  immobilized: boolean;
  burning: boolean;
}

export const emptyArticulation = (): ArticulationSample => ({
  mounts: new Float64Array(MAX_LOGGED_MOUNTS * 2),
  condition: 'operational',
  immobilized: false,
  burning: false,
});

/** Writes the state's vehicles' articulation into `out` from `at` (`ARTICULATION_STRIDE` each). */
export function writeArticulation(
  state: DeepReadonly<SimState>,
  tickRateHz: number,
  out: Float32Array,
  at: number,
): void {
  const now = state.tick / tickRateHz;
  (state.vehicles ?? []).forEach((v, i) => {
    const o = at + i * ARTICULATION_STRIDE;
    for (let m = 0; m < MAX_LOGGED_MOUNTS; m += 1) {
      const mount = v.combat.mounts[m];
      out[o + m * 2] = mount?.azimuth ?? 0;
      out[o + m * 2 + 1] = mount?.elevation ?? 0;
    }
    const d = v.combat.damage;
    out[o + MAX_LOGGED_MOUNTS * 2] = CONDITIONS.indexOf(conditionOf(v.combat as VehicleCombat));
    out[o + MAX_LOGGED_MOUNTS * 2 + 1] =
      (d.mobility ? 1 : 0) | (d.burningUntil !== null && now < d.burningUntil ? 2 : 0);
  });
}

/** Reads one vehicle's articulation from `from` at `at`. */
export function readArticulation(
  from: ArrayLike<number>,
  at: number,
  out: ArticulationSample,
): ArticulationSample {
  for (let m = 0; m < MAX_LOGGED_MOUNTS * 2; m += 1) out.mounts[m] = from[at + m] ?? 0;
  out.condition = CONDITIONS[from[at + MAX_LOGGED_MOUNTS * 2] ?? 0] ?? 'operational';
  const flags = from[at + MAX_LOGGED_MOUNTS * 2 + 1] ?? 0;
  out.immobilized = (flags & 1) !== 0;
  out.burning = (flags & 2) !== 0;
  return out;
}

const POSTURES: readonly Posture[] = ['standing', 'kneeling', 'prone'];
const STATUSES: readonly SoldierStatus[] = ['active', 'incapacitated'];

/** What the log records of a soldier or a vehicle. */
export interface Mover {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly azimuth: number;
  readonly posture: Posture;
  readonly status: SoldierStatus;
}

/** The state's movers in the log's order: its soldiers, then its vehicles. */
export function motionMovers(state: DeepReadonly<SimState>): readonly Mover[] {
  const vehicles = state.vehicles;
  if (!vehicles || vehicles.length === 0) return state.soldiers;
  return [
    ...state.soldiers,
    ...vehicles.map((v) => ({
      id: v.id,
      position: v.position,
      azimuth: v.heading,
      posture: 'standing' as const,
      status: 'active' as const,
    })),
  ];
}

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
  /** The soldiers, in simulation order, then the vehicles: a sample's index. */
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
  /**
   * The articulation of the vehicle at mover `index` (a vehicle's index in
   * `soldierIds`) at `tick`, clamped to the recorded ticks; a soldier's or
   * an unrecorded one: `out` unchanged.
   */
  readArticulation(index: number, tick: number, out: ArticulationSample): ArticulationSample;
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
  /** A vehicle's articulation per tick (`ARTICULATION_STRIDE` each). */
  readonly articulation: Float32Array[];
}

export function createMotionRecorder(tickRateHz: number): MotionRecorder {
  let soldierIds: SoldierId[] = [];
  let index = new Map<string, number>();
  let tracks: Track[] = [];
  let soldierCount = 0;
  const scratch = new Float32Array(ARTICULATION_STRIDE * 64);
  let firstTick = 0;
  let lastTick = -1;
  let epoch = 0;

  const restart = (state: DeepReadonly<SimState>) => {
    soldierIds = motionMovers(state).map((s) => s.id as SoldierId);
    index = new Map(soldierIds.map((id, i) => [id, i]));
    tracks = soldierIds.map(() => ({ numbers: [], codes: [], articulation: [] }));
    soldierCount = state.soldiers.length;
    firstTick = state.tick;
    lastTick = state.tick - 1;
    epoch += 1;
  };

  const write = (state: DeepReadonly<SimState>, offset: number) => {
    const chunk = Math.floor(offset / CHUNK);
    const at = offset - chunk * CHUNK;
    const vehicles = state.vehicles?.length ?? 0;
    const art =
      vehicles * ARTICULATION_STRIDE <= scratch.length
        ? scratch
        : new Float32Array(vehicles * ARTICULATION_STRIDE);
    if (vehicles > 0) writeArticulation(state, tickRateHz, art, 0);
    motionMovers(state).forEach((s, i) => {
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
      const v = i - soldierCount;
      if (v < 0) return;
      while (track.articulation.length <= chunk)
        track.articulation.push(new Float32Array(CHUNK * ARTICULATION_STRIDE));
      track.articulation[chunk]?.set(
        art.subarray(v * ARTICULATION_STRIDE, (v + 1) * ARTICULATION_STRIDE),
        at * ARTICULATION_STRIDE,
      );
    });
  };

  const sameSoldiers = (state: DeepReadonly<SimState>) => {
    const movers = motionMovers(state);
    return movers.length === soldierIds.length && movers.every((s, i) => s.id === soldierIds[i]);
  };

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
    readArticulation(i, tick, out) {
      const track = tracks[i];
      if (!track || lastTick < firstTick) return out;
      const offset = Math.min(Math.max(tick, firstTick), lastTick) - firstTick;
      const chunk = Math.floor(offset / CHUNK);
      const a = track.articulation[chunk];
      if (!a) return out;
      return readArticulation(a, (offset - chunk * CHUNK) * ARTICULATION_STRIDE, out);
    },
    record(state) {
      const followsOn = state.tick === lastTick || state.tick === lastTick + 1;
      if (lastTick < firstTick || !followsOn || !sameSoldiers(state)) restart(state);
      write(state, state.tick - firstTick);
      lastTick = state.tick;
    },
  };
}
