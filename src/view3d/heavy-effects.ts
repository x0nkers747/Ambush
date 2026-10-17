import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  NormalBlending,
  Points,
  ShaderMaterial,
  type Blending,
} from 'three';
import type { CombatEvent, HeavyShotEvent } from '#exercise';
import {
  firesTracers,
  guidedFlightSeconds,
  inBattleTime,
  tracerFlightSeconds,
  tracerShown,
} from './tracers';

// The effects of combined arms in 3D (docs/combined-arms.md §11): muzzle
// flashes and smoke, the smoke trails of rockets and missiles in flight
// (their heads are the tracers': tracers.ts), impacts (dust, flashes, sparks on armour), and burning and smoking
// wrecks. Purely visual, and a function of the combat log, the clock, the
// battle's speed and the vehicles' state in the motion log alone (every
// scatter from a hash of its event), so the After-Action Review shows exactly
// what was seen live, at any time it is moved to. Two pools of soft points
// (glowing, and smoke), filled each frame: no objects per effect. A gun's
// rounds (machine guns, autocannon, main guns) are the tracers' (tracers.ts),
// flying at one speed on screen whatever the battle's: their impacts come
// when the tracer lands.

/** How far back the log is searched for effects still showing (s). */
const WINDOW_S = 12;
const CAPACITY = 6000;

/**
 * Visual speeds of a gun's rounds (m/s of the battle) when its burst is not
 * drawn as tracers (tracers.ts: at speed, most are not).
 */
const SPEED: Readonly<Record<string, number>> = {
  cannon: 1500,
  autocannon: 1000,
  machineGun: 700,
};

/** The kind of a weapon by id, for its effects (the views have no catalog lookups per frame). */
export type WeaponKindOf = (weapon: string) => string;

/** A vehicle's fire and smoke: where (map metres; `z` its roof), burning or a cold wreck. */
export interface Wreck {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly burning: boolean;
}

export interface HeavyEffectsLayer {
  readonly group: Group;
  update(
    combatLog: readonly CombatEvent[],
    seconds: number,
    wrecks: readonly Wreck[],
    surfaceAt: (x: number, y: number) => number,
    /** The battle's speed (simulated seconds per real second), as the tracers are drawn at. */
    timeScale?: number,
  ): void;
  /** Points drawn at the last update. */
  readonly drawn: number;
  dispose(): void;
}

/** A deterministic hash in [0, 1) of a key and two numbers. */
function hash(key: string, a: number, b: number): number {
  let h = 2166136261 ^ Math.imul(a + 1, 2654435761) ^ Math.imul(b + 7, 40503);
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const VERTEX = `
attribute float size;
attribute vec4 rgba;
varying vec4 vRgba;
void main() {
  vRgba = rgba;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * (900.0 / max(0.1, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const FRAGMENT = `
varying vec4 vRgba;
void main() {
  float d = length(gl_PointCoord - vec2(0.5));
  float a = smoothstep(0.5, 0.15, d) * vRgba.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vRgba.rgb, a);
}`;

interface Pool {
  readonly points: Points;
  readonly position: Float32Array;
  readonly size: Float32Array;
  readonly rgba: Float32Array;
  n: number;
}

function pool(blending: Blending, order: number): Pool {
  const position = new Float32Array(CAPACITY * 3);
  const size = new Float32Array(CAPACITY);
  const rgba = new Float32Array(CAPACITY * 4);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('size', new BufferAttribute(size, 1));
  geometry.setAttribute('rgba', new BufferAttribute(rgba, 4));
  const material = new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = order;
  return { points, position, size, rgba, n: 0 };
}

/** Adds a point (map metres) to a pool. */
function add(
  p: Pool,
  x: number,
  y: number,
  z: number,
  size: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  if (p.n >= CAPACITY || a <= 0.01 || size <= 0) return;
  const i = p.n;
  // Three.js: x east, y up, z south.
  p.position[i * 3] = x;
  p.position[i * 3 + 1] = z;
  p.position[i * 3 + 2] = -y;
  p.size[i] = size;
  p.rgba[i * 4] = r;
  p.rgba[i * 4 + 1] = g;
  p.rgba[i * 4 + 2] = b;
  p.rgba[i * 4 + 3] = a;
  p.n += 1;
}

/** Draws a pool's points, uploading only those (none: nothing, not the whole buffers every frame). */
function commit(p: Pool): void {
  const g = p.points.geometry;
  g.setDrawRange(0, p.n);
  if (p.n <= 0) return;
  for (const [name, size] of [
    ['position', 3],
    ['size', 1],
    ['rgba', 4],
  ] as const) {
    const a = g.getAttribute(name) as BufferAttribute;
    a.clearUpdateRanges();
    a.addUpdateRange(0, p.n * size);
    a.needsUpdate = true;
  }
}

/** Where a shot's round is `age` seconds after it was fired, and how far along (0–1). */
function flightOf(e: HeavyShotEvent, kind: string): { flight: number; length: number } {
  const dx = e.impact.x - e.from.x;
  const dy = e.impact.y - e.from.y;
  const dz = e.impact.z - e.from.z;
  const length = Math.hypot(dx, dy, dz);
  const flight = inBattleTime(kind, e.impactAt)
    ? guidedFlightSeconds(e.atSeconds, e.impactAt, length)
    : Math.max(0.06, length / (SPEED[kind] ?? 900));
  return { flight, length };
}

export function createHeavyEffectsLayer(kindOf: WeaponKindOf): HeavyEffectsLayer {
  const group = new Group();
  group.name = 'heavy-effects';
  const glow = pool(AdditiveBlending, 4);
  const smoke = pool(NormalBlending, 3);
  group.add(smoke.points, glow.points);
  let drawn = 0;

  /** Dust and smoke where a round lands (`big`: a cannon or a warhead). */
  const impactAt = (
    key: string,
    x: number,
    y: number,
    z: number,
    age: number,
    big: boolean,
    armour: boolean,
  ) => {
    if (age < 0) return;
    if (age < 0.15) {
      const s = big ? 6 : 1.2;
      add(glow, x, y, z + 0.5, s * (1 + age * 4), 1, 0.85, 0.5, 1 - age / 0.15);
    }
    if (armour && age < 0.4) {
      // Sparks off the armour.
      for (let k = 0; k < 8; k += 1) {
        const a = hash(key, k, 1) * Math.PI * 2;
        const r = age * (6 + 10 * hash(key, k, 2));
        add(
          glow,
          x + Math.cos(a) * r,
          y + Math.sin(a) * r,
          z + 0.5 + age * 3,
          0.35,
          1,
          0.75,
          0.3,
          1 - age / 0.4,
        );
      }
    }
    const puffs = big ? 6 : 2;
    const life = big ? 4 : 1.6;
    if (age > life) return;
    for (let k = 0; k < puffs; k += 1) {
      const a = hash(key, k, 3) * Math.PI * 2;
      const spread = (big ? 2.5 : 0.8) * (0.4 + age);
      add(
        smoke,
        x + Math.cos(a) * spread * hash(key, k, 4),
        y + Math.sin(a) * spread * hash(key, k, 4),
        z + 0.4 + age * (big ? 1.4 : 0.8) * (0.5 + hash(key, k, 5)),
        (big ? 3 : 1) * (1 + age * 0.8),
        0.45,
        0.4,
        0.33,
        (big ? 0.6 : 0.45) * (1 - age / life),
      );
    }
  };

  return {
    group,
    get drawn() {
      return drawn;
    },
    update(combatLog, seconds, wrecks, surfaceAt, timeScale = 1) {
      const scale = Math.max(1e-6, timeScale);
      // A gun's round lands when its tracer does (up to 10 real seconds: a main gun's, far off).
      const window = Math.max(WINDOW_S, 10 * scale + WINDOW_S);
      glow.n = 0;
      smoke.n = 0;
      // The last event at or before now (the log is in time order), then back.
      let lo = 0;
      let hi = combatLog.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((combatLog[mid]?.atSeconds ?? Infinity) <= seconds + 1e-9) lo = mid + 1;
        else hi = mid;
      }
      // Missiles that have arrived: where and whether they struck.
      const arrived = new Map<string, number>();
      for (let i = lo - 1; i >= 0; i -= 1) {
        const e = combatLog[i];
        if (!e) continue;
        if (seconds - e.atSeconds > WINDOW_S) break;
        if (e.type === 'missileArrived') arrived.set(e.missileId, e.atSeconds);
      }
      for (let i = lo - 1; i >= 0; i -= 1) {
        const e = combatLog[i];
        if (!e) continue;
        const age = seconds - e.atSeconds;
        if (age > window) break;
        if (e.type !== 'heavyShot') continue;
        const kind = e.missileId !== null ? 'atgm' : kindOf(e.weapon);
        // A gun's round drawn as a tracer (at speed, one burst in so many is).
        const tracer =
          !inBattleTime(kind, e.impactAt) &&
          firesTracers(kind) &&
          tracerShown(e.shooterId, e.tick, e.slot, scale);
        const key = `${e.shooterId}:${String(e.tick)}:${e.slot}`;
        const { flight: own, length } = flightOf(e, kind);
        // A gun's round: as long as its tracer flies (simulated seconds).
        const flight = tracer ? tracerFlightSeconds(length) * scale : own;
        if (age > flight + WINDOW_S) continue;
        const big = kind === 'cannon' || kind === 'atgm' || kind === 'atRocket';
        // The muzzle: a flash, and (a gun, a launcher) its blast's smoke.
        if (age < 0.12) {
          const s =
            kind === 'cannon' ? 7 : kind === 'autocannon' ? 2.5 : kind === 'machineGun' ? 1.1 : 3;
          add(glow, e.from.x, e.from.y, e.from.z, s, 1, 0.8, 0.45, 1 - age / 0.12);
        }
        if (big && age < 3.5) {
          const dx = e.impact.x - e.from.x;
          const dy = e.impact.y - e.from.y;
          const l = Math.max(1, Math.hypot(dx, dy));
          const back = e.shooter === 'soldier' ? -1 : 1;
          for (let k = 0; k < 5; k += 1) {
            const d = (k + 1) * 0.9 * back;
            add(
              smoke,
              e.from.x + (dx / l) * d + (hash(key, k, 9) - 0.5) * 2 * age,
              e.from.y + (dy / l) * d + (hash(key, k, 10) - 0.5) * 2 * age,
              e.from.z + age * 0.6,
              2.2 + age * 2.2,
              0.78,
              0.76,
              0.72,
              0.5 * (1 - age / 3.5),
            );
          }
        }
        // In flight: a rocket's or a missile's smoke trail back to the launcher (its
        // head, as a gun's rounds, is the tracers').
        if ((kind === 'atgm' || kind === 'atRocket') && age >= 0 && age <= flight) {
          const t = age;
          for (let s = 1; s <= 30; s += 1) {
            const back = t - s * 0.08;
            if (back < 0) break;
            const fb = back / flight;
            const fade = 1 - (t - back) / 2.6;
            add(
              smoke,
              e.from.x + (e.impact.x - e.from.x) * fb,
              e.from.y + (e.impact.y - e.from.y) * fb,
              e.from.z + (e.impact.z - e.from.z) * fb + (t - back) * 0.3,
              0.9 + (t - back) * 1.2,
              0.85,
              0.85,
              0.82,
              0.45 * fade,
            );
          }
        }
        // Where it lands: a round when it arrives; a missile when the log says it did.
        const landed = e.missileId !== null ? arrived.get(e.missileId) : e.atSeconds + flight;
        if (landed !== undefined) {
          const ground = surfaceAt(e.impact.x, e.impact.y);
          const z = e.hit ? e.impact.z : Number.isFinite(ground) ? ground : e.impact.z;
          impactAt(
            key,
            e.impact.x,
            e.impact.y,
            z,
            seconds - landed,
            big,
            e.hit && e.target === 'vehicle',
          );
        }
      }
      // Burning vehicles: flames and a column of black smoke; cold wrecks smoulder.
      for (const w of wrecks) {
        const step = w.burning ? 0.35 : 0.9;
        const life = w.burning ? 9 : 6;
        const born = Math.floor(seconds / step);
        for (let j = 0; j < life / step; j += 1) {
          const at = (born - j) * step;
          const age = seconds - at;
          const h = hash(w.id, born - j, 0);
          add(
            smoke,
            w.x + age * 0.6 + (h - 0.5) * 1.5,
            w.y + age * 0.2 + (hash(w.id, born - j, 1) - 0.5) * 1.5,
            w.z + age * (w.burning ? 1.8 : 0.9),
            (w.burning ? 2.2 : 1.4) + age * (w.burning ? 0.9 : 0.6),
            w.burning ? 0.12 : 0.35,
            w.burning ? 0.11 : 0.33,
            w.burning ? 0.1 : 0.31,
            (w.burning ? 0.7 : 0.35) * (1 - age / life),
          );
        }
        if (w.burning) {
          for (let k = 0; k < 7; k += 1) {
            const flicker = hash(w.id, Math.floor(seconds * 12), k);
            add(
              glow,
              w.x + (hash(w.id, k, 2) - 0.5) * 2.2,
              w.y + (hash(w.id, k, 3) - 0.5) * 2.2,
              w.z - 0.3 + flicker * 0.9,
              1.4 + flicker * 1.6,
              1,
              0.45 + flicker * 0.3,
              0.12,
              0.65 + flicker * 0.35,
            );
          }
        }
      }
      commit(glow);
      commit(smoke);
      drawn = glow.n + smoke.n;
    },
    dispose() {
      for (const p of [glow, smoke]) {
        p.points.geometry.dispose();
        (p.points.material as ShaderMaterial).dispose();
      }
    },
  };
}
