import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { emptyMotionSample, type CombatEvent, type MotionLog } from '#exercise';
import { SMALL_ARMS_VELOCITY_MPS } from '#sim';

// Tracers in the 3D view: every round of every burst fired (a battle's
// `fofFire`, as the characters' shots) flies from the shooter's muzzle
// toward his target as a glowing streak, and so do the vehicles' machine
// guns, autocannon and main guns (their `heavyShot`s), and anti-tank rockets
// and missiles (their smoke trails are the heavy effects'). Purely visual:
// the battle resolves a burst as one event, and nothing here changes it.
//
// Rounds fly at their speed in the battle's time, as the battle has them: a
// soldier's at `SMALL_ARMS_VELOCITY_MPS` (900 m/s), its burst's hit arriving
// as the battle strikes its target down (`arriveAt`); a vehicle's machine
// gun's, autocannon's or main gun's from firing until it arrives
// (`impactAt`). At 1× a round is seen for as long as it flies (a third of a
// second at 300 m); faster, for as much less. As many are in the air whatever
// the speed: at 32× the battle fires 32 times as many bursts a second, so
// one burst of small arms in 32 is drawn (`tracerShown`, by a hash of the
// burst); every main gun's round, rocket and missile is. Each streak is a
// function of the event and the clock (its scatter drawn from a hash of the
// event), so the After-Action Review shows the same tracers at the same
// moments, seeking or not. (Recordings from before rounds had a time of
// flight, without one, fly at `TRACER_SPEED_MPS` on screen.)
//
// A main gun's round, a rocket and a missile (their heads four times the
// size) fly at their own speed in the battle's time, as the simulation has
// them: a main gun's round and a missile from firing until they arrive
// (`impactAt`: the range over the round's velocity, 850–1,700 m/s, or the
// missile's flight speed, 170–208 m/s), a rocket at `ROCKET_SPEED_MPS`. At 1×
// each is seen as long as it flies; faster, it keeps up with the battle,
// landing as its hit does. Every one is drawn, whatever the speed (there are
// few).
//
// Red for BLUEFOR, green for OPFOR (as US and
// Warsaw Pact tracer ammunition). Each streak is a glowing bar at least a
// couple of pixels wide at any distance, with a bright head; one instanced
// mesh and one point buffer, filled each frame: no objects per tracer.

/** Visual speed of a round (m/s of real time; slower than a real one, to be seen). */
export const TRACER_SPEED_MPS = 640;
/** A round's glowing head on screen (px); a main gun's is four times the size. */
const HEAD_PX = 5;
const BIG_HEAD_PX = HEAD_PX * 4;
/** Shortest flight shown (real s), so close shots are seen too. */
const MIN_FLIGHT_S = 0.12;
/** Length of a streak (m). */
const STREAK_M = 11;
/** Rounds in flight at once, at most. */
const CAPACITY = 2048;
/** How long a round can still be in flight (real s): a main gun's, at its longest range. */
const WINDOW_S = 10;
/** How long a rocket or missile can still be in flight (battle s): a missile's, at its longest range. */
const GUIDED_WINDOW_S = 30;

/** An anti-tank rocket's speed (m/s of the battle; an AT4's 285, an RPG-7's sustained 295). */
export const ROCKET_SPEED_MPS = 260;

/**
 * How long a main gun's round, rocket or missile flies (battle s): until it
 * arrives (`impactAt`: a round's or a missile's), or a rocket `lengthM` at
 * `ROCKET_SPEED_MPS`.
 */
export function guidedFlightSeconds(
  atSeconds: number,
  impactAt: number | null,
  lengthM: number,
): number {
  return impactAt !== null
    ? Math.max(0.05, impactAt - atSeconds)
    : Math.max(0.06, lengthM / ROCKET_SPEED_MPS);
}

/** The kind of a vehicle's weapon by id (`cannon`, `autocannon`, `machineGun`…). */
export type TracerWeaponKind = (weapon: string) => string;

/** The weapons whose rounds are tracers (rockets and missiles fly as the heavy effects). */
const TRACER_KINDS = new Set(['machineGun', 'autocannon', 'cannon']);

/** How long a round flies `lengthM` (real s), as drawn. */
export function tracerFlightSeconds(lengthM: number): number {
  return Math.max(MIN_FLIGHT_S, lengthM / TRACER_SPEED_MPS);
}

/**
 * Whether a burst's tracers are drawn at `timeScale`: all of them up to 1×;
 * faster, one burst in `timeScale` (by a hash of the burst), so as many are
 * in the air as at 1×. The same burst at the same speed, always.
 */
export function tracerShown(
  shooterId: string,
  tick: number,
  slot: string,
  timeScale: number,
): boolean {
  if (timeScale <= 1) return true;
  return scatter(`${shooterId}:${slot}`, tick, 0, 9) < 1 / timeScale;
}

/**
 * Whether a shot of a weapon of `kind` flies in the battle's time: a rocket,
 * a missile, or a round the battle flies (`impactAt`: a main gun's).
 */
export function inBattleTime(kind: string, impactAt: number | null): boolean {
  return kind === 'atgm' || kind === 'atRocket' || impactAt !== null;
}

/** Whether a weapon of `kind` fires tracers drawn here. */
export function firesTracers(kind: string): boolean {
  return TRACER_KINDS.has(kind);
}

/** Seconds between the rounds of a burst: an automatic burst, or aimed shots. */
const roundSpacing = (weapon: string) => (weapon === 'automaticRifle' ? 0.075 : 0.18);
/** A vehicle's burst: its rounds drawn, at most, and the seconds between them. */
const HEAVY_BURST: Readonly<Record<string, { rounds: number; spacing: number }>> = {
  machineGun: { rounds: 12, spacing: 0.09 },
  autocannon: { rounds: 6, spacing: 0.2 },
  cannon: { rounds: 1, spacing: 0 },
};

/** Muzzle height, and the height aimed at, by posture (m). */
const MUZZLE_M = { standing: 1.45, kneeling: 0.95, prone: 0.3 } as const;
const BODY_M = { standing: 1.1, kneeling: 0.7, prone: 0.2 } as const;

const COLOURS = {
  BLUEFOR: [1, 0.18, 0.08],
  OPFOR: [0.2, 1, 0.25],
} as const;

export interface TracerLayer {
  readonly group: Group;
  /** Draws the rounds in flight at `seconds` of the battle whose motion and shots are given. */
  update(
    log: MotionLog,
    combatLog: readonly CombatEvent[],
    seconds: number,
    surfaceAt: (x: number, y: number) => number,
    /** The camera's position (Three.js coordinates), to keep streaks visible far off. */
    eye: { readonly x: number; readonly y: number; readonly z: number },
    /** The battle's speed (simulated seconds per real second): rounds fly at one speed whatever it is. */
    timeScale?: number,
  ): void;
  /** Rounds drawn at the last update. */
  readonly inFlight: number;
  dispose(): void;
}

/** A small deterministic hash of an event's round: its scatter (in [0, 1)). */
function scatter(id: string, tick: number, round: number, k: number): number {
  let h = 2166136261 ^ (tick * 2654435761) ^ (round * 40503) ^ (k * 97);
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export function createTracerLayer(
  /** The kind of a vehicle's weapon (its rounds are drawn if a gun's); without it, soldiers' alone. */
  kindOf: TracerWeaponKind = () => '',
): TracerLayer {
  const group = new Group();
  group.name = 'tracers';
  const barGeometry = new BoxGeometry(1, 1, 1);
  // Normal blending, saturated colours: a tracer reads red or green in daylight too.
  const barMaterial = new MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
  const bars = new InstancedMesh(barGeometry, barMaterial, CAPACITY);
  // The colours exist from the first frame, so the shader is built with them.
  bars.instanceColor = new InstancedBufferAttribute(new Float32Array(CAPACITY * 3), 3);
  bars.count = 0;
  const colour = new Color();
  const matrix = new Matrix4();
  const along = new Vector3();
  const mid = new Vector3();
  const size = new Vector3();
  const turn = new Quaternion();
  const zAxis = new Vector3(0, 0, 1);
  // Radians a pixel spans, roughly (the views' 45° field over about 900 pixels).
  const PIXEL_RAD = 0.00087;
  /** The rounds' glowing heads, `px` across: a pool of points. */
  const headPool = (px: number) => {
    const positions = new Float32Array(CAPACITY * 3);
    const colours = new Float32Array(CAPACITY * 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('color', new BufferAttribute(colours, 3));
    const material = new PointsMaterial({
      size: px,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    return { positions, colours, geometry, material, points: new Points(geometry, material), n: 0 };
  };
  const heads = headPool(HEAD_PX);
  // A main gun's.
  const bigHeads = headPool(BIG_HEAD_PX);
  for (const o of [bars, heads.points, bigHeads.points]) {
    o.frustumCulled = false;
    o.renderOrder = 3;
  }
  group.add(bars, heads.points, bigHeads.points);
  const shooter = emptyMotionSample();
  const target = emptyMotionSample();

  let inFlight = 0;
  const draw = (n: number) => {
    inFlight = n;
    bars.count = n;
    bars.instanceMatrix.needsUpdate = true;
    if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
    for (const pool of [heads, bigHeads]) {
      pool.geometry.setDrawRange(0, pool.n);
      (pool.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
      (pool.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
    }
  };

  return {
    group,
    get inFlight() {
      return inFlight;
    },
    update(log, combatLog, seconds, surfaceAt, eye, timeScale = 1) {
      const scale = Math.max(1e-6, timeScale);
      // The last shot at or before `seconds` (the log is in time order), then back.
      let lo = 0;
      let hi = combatLog.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((combatLog[mid]?.atSeconds ?? Infinity) <= seconds + 1e-9) lo = mid + 1;
        else hi = mid;
      }
      let n = 0;
      heads.n = 0;
      bigHeads.n = 0;
      /**
       * A round from (sx, sy, sz) to (ex, ey, ez) (map metres), `age` real
       * seconds after it left the muzzle, flying `flight` real seconds: its
       * streak, if in flight. Three.js: x east, y up, z south.
       */
      const streak = (
        sx: number,
        sy: number,
        sz: number,
        ex: number,
        ey: number,
        ez: number,
        age: number,
        flight: number,
        r: number,
        g: number,
        b: number,
        /** A main gun's round: its head four times the size. */
        big = false,
      ) => {
        if (age < 0 || age > flight || n >= CAPACITY) return;
        const dx = ex - sx;
        const dy = ey - sy;
        const dz = ez - sz;
        const length = Math.hypot(dx, dy, dz);
        const f = age / flight;
        const travelled = f * length;
        const tail = Math.max(0, travelled - STREAK_M) / Math.max(1e-9, length);
        // The streak from its tail to its head.
        const t0x = sx + dx * tail;
        const t0y = sz + dz * tail;
        const t0z = -(sy + dy * tail);
        const hx = sx + dx * f;
        const hy = sz + dz * f;
        const hz = -(sy + dy * f);
        along.set(hx - t0x, hy - t0y, hz - t0z);
        const len = along.length();
        if (len < 1e-6) return;
        mid.set((hx + t0x) / 2, (hy + t0y) / 2, (hz + t0z) / 2);
        const distance = Math.hypot(mid.x - eye.x, mid.y - eye.y, mid.z - eye.z);
        const width = Math.max(0.05, distance * PIXEL_RAD * 2.5);
        turn.setFromUnitVectors(zAxis, along.divideScalar(len));
        size.set(width, width, len);
        matrix.compose(mid, turn, size);
        bars.setMatrixAt(n, matrix);
        bars.setColorAt(n, colour.setRGB(r, g, b));
        const pool = big ? bigHeads : heads;
        const p = pool.n * 3;
        pool.positions[p] = hx;
        pool.positions[p + 1] = hy;
        pool.positions[p + 2] = hz;
        pool.colours[p] = Math.min(1, r + 0.4);
        pool.colours[p + 1] = Math.min(1, g + 0.4);
        pool.colours[p + 2] = Math.min(1, b + 0.3);
        pool.n += 1;
        n += 1;
      };
      const rate = log.tickRateHz;
      for (let i = lo - 1; i >= 0 && n < CAPACITY; i -= 1) {
        const e = combatLog[i];
        if (!e) continue;
        // Real seconds since it was fired.
        const since = (seconds - e.atSeconds) / scale;
        if (since > WINDOW_S && seconds - e.atSeconds > GUIDED_WINDOW_S) break;
        if (e.type === 'heavyShot') {
          const kind = e.missileId !== null ? 'atgm' : kindOf(e.weapon);
          const length = Math.hypot(
            e.impact.x - e.from.x,
            e.impact.y - e.from.y,
            e.impact.z - e.from.z,
          );
          const [r, g, b] = COLOURS[e.side];
          const burst = HEAVY_BURST[kind];
          if (!burst || kind === 'cannon') {
            // A main gun's round, a rocket or a missile: one, at its own speed in the
            // battle's time, every one drawn.
            if (!inBattleTime(kind, e.impactAt) && !burst) continue;
            const battle = inBattleTime(kind, e.impactAt);
            streak(
              e.from.x,
              e.from.y,
              e.from.z,
              e.impact.x,
              e.impact.y,
              e.impact.z,
              battle ? seconds - e.atSeconds : since,
              battle
                ? guidedFlightSeconds(e.atSeconds, e.impactAt, length)
                : tracerFlightSeconds(length),
              r,
              g,
              b,
              true,
            );
            continue;
          }
          // A machine gun's or autocannon's burst, its rounds spaced as fired: in the
          // battle's time when the battle flies it (else, from before, on screen); one
          // burst in so many drawn at speed.
          if (!tracerShown(e.shooterId, e.tick, e.slot, scale)) continue;
          const battle = e.impactAt !== null;
          const age0 = battle ? seconds - e.atSeconds : since;
          const flight =
            e.impactAt !== null
              ? Math.max(1e-3, e.impactAt - e.atSeconds)
              : tracerFlightSeconds(length);
          const rounds = Math.min(e.rounds, burst.rounds);
          if (age0 > flight + rounds * burst.spacing) continue;
          const tick = Math.round(e.atSeconds * rate);
          for (let k = 0; k < rounds; k += 1) {
            // A machine gun's misses spread a little round where the burst landed.
            const spread = kind === 'machineGun' && !(e.hit && k === 0) ? 4 : 0;
            const ox = (scatter(e.shooterId, tick, k, 4) - 0.5) * spread;
            const oy = (scatter(e.shooterId, tick, k, 5) - 0.5) * spread;
            streak(
              e.from.x,
              e.from.y,
              e.from.z,
              e.impact.x + ox,
              e.impact.y + oy,
              e.impact.z,
              age0 - k * burst.spacing,
              flight,
              r,
              g,
              b,
            );
          }
          continue;
        }
        if (e.type !== 'shotFired') continue;
        // In the battle's time, at the rounds' speed (a recording from before: on screen).
        const flies = Number.isFinite(e.arriveAt);
        const age0 = flies ? seconds - e.atSeconds : since;
        const flightOf = (lengthM: number) =>
          flies ? lengthM / SMALL_ARMS_VELOCITY_MPS : tracerFlightSeconds(lengthM);
        const spacing = roundSpacing(e.weaponProfileRef);
        // Long past: every round landed (a miss flies on to half again its range, and more).
        if (age0 > flightOf(e.rangeM * 1.6 + 20) + e.rounds * spacing) continue;
        if (!flies && since > WINDOW_S) continue;
        const tick = Math.round(e.atSeconds * rate);
        if (!tracerShown(e.shooterId, e.tick, e.weaponProfileRef, scale)) continue;
        const from = log.indexOf(e.shooterId);
        if (from < 0) continue;
        log.read(from, tick, shooter);
        const to = log.indexOf(e.targetId);
        if (to >= 0) log.read(to, tick, target);
        const sx = shooter.x;
        const sy = shooter.y;
        // The soldiers' heights are the surfaces they stand on (ground, or a bridge deck).
        const sz = shooter.z + MUZZLE_M[shooter.posture];
        // Aimed at the target's body (or, area fire, at the point aimed at).
        const ax = e.aimed && to >= 0 ? target.x : e.aimPoint.x;
        const ay = e.aimed && to >= 0 ? target.y : e.aimPoint.y;
        const ground = surfaceAt(ax, ay);
        const az =
          e.aimed && to >= 0
            ? target.z + BODY_M[target.posture]
            : (Number.isFinite(ground) ? ground : sz) + 0.6;
        const dx0 = ax - sx;
        const dy0 = ay - sy;
        const range = Math.max(1, Math.hypot(dx0, dy0));
        const [r, g, b] = COLOURS[e.shooterSide];
        for (let k = 0; k < e.rounds && n < CAPACITY; k += 1) {
          const age = age0 - k * spacing;
          if (age < 0) continue;
          // Where this round goes: the target (the burst's hit, its first round), or scattered
          // round the aim point, flying on past it.
          const hit = e.hit && k === 0;
          const side = hit ? 0 : (scatter(e.shooterId, tick, k, 1) - 0.5) * (1 + range / 60);
          const up = hit ? 0 : (scatter(e.shooterId, tick, k, 2) - 0.35) * (0.8 + range / 150);
          const past = hit ? 1 : 1.15 + 0.35 * scatter(e.shooterId, tick, k, 3);
          const ux = dx0 / range;
          const uy = dy0 / range;
          const ex = sx + dx0 * past - uy * side;
          const ey = sy + dy0 * past + ux * side;
          const ez = sz + (az - sz) * past + up;
          // The hit: from the muzzle to his body as the battle has it, arriving with the hit.
          const length = hit ? range : Math.hypot(ex - sx, ey - sy, ez - sz);
          streak(sx, sy, sz, ex, ey, ez, age, flightOf(length), r, g, b);
        }
      }
      draw(n);
    },
    dispose() {
      barGeometry.dispose();
      barMaterial.dispose();
      bars.dispose();
      for (const pool of [heads, bigHeads]) {
        pool.geometry.dispose();
        pool.material.dispose();
      }
    },
  };
}
