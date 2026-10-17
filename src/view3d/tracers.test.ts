import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { createMotionRecorder, type CombatEvent, type HeavyShotEvent } from '#exercise';
import type { SimState } from '#sim';
import { createTracerLayer } from './tracers';

// Tracers in the 3D view: one streak per round of each burst, staggered as
// the weapon fires them, gone once landed; nothing for grenades; the same
// picture for the same moment (the review's), and a hit's round ending in
// its target; one speed on screen whatever the battle's; the vehicles' guns
// alike, a main gun's round slower.

/** Two soldiers 200 m apart (north), standing still, for 10 s at 30 Hz. */
function motion() {
  const log = createMotionRecorder(30);
  for (let tick = 0; tick <= 300; tick += 1) {
    log.record({
      tick,
      soldiers: [
        {
          id: 'B1-01',
          side: 'BLUEFOR',
          position: { x: 0, y: 0, z: 10 },
          azimuth: 0,
          posture: 'standing',
          status: 'active',
        },
        {
          id: 'O1-01',
          side: 'OPFOR',
          position: { x: 0, y: 200, z: 10 },
          azimuth: Math.PI,
          posture: 'kneeling',
          status: 'active',
        },
      ],
    } as unknown as SimState);
  }
  return log;
}

const shot = (atSeconds: number, rounds: number, weapon: string, hit: boolean): CombatEvent => ({
  type: 'shotFired',
  tick: Math.round(atSeconds * 30),
  atSeconds,
  shooterId: 'B1-01' as never,
  shooterSide: 'BLUEFOR',
  targetId: 'O1-01' as never,
  weaponProfileRef: weapon,
  rangeM: 200,
  rounds,
  aimPoint: { x: 0, y: 200 },
  aimed: true,
  hitProbability: 0.2,
  hit,
  incapacitated: false,
});

const flat = () => 10;
const eye = { x: 0, y: 50, z: 100 };

/** The streaks drawn: each one's head (the far end of its bar), in map metres. */
function heads(layer: ReturnType<typeof createTracerLayer>) {
  const bars = layer.group.children.find((c): c is InstancedMesh => c instanceof InstancedMesh);
  if (!bars) throw new Error('no bars');
  const m = new Matrix4();
  const p = new Vector3();
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < bars.count; i += 1) {
    bars.getMatrixAt(i, m);
    // The bar's far end: its centre plus half its length along its axis.
    const half = new Vector3(0, 0, 0.5).applyMatrix4(m);
    p.copy(half);
    out.push({ x: p.x, y: -p.z, z: p.y });
  }
  return out;
}

describe('tracers', () => {
  const log = motion();

  it('one per round, staggered as fired, gone once landed', () => {
    const layer = createTracerLayer();
    const saw = [shot(1, 8, 'automaticRifle', false)];
    layer.update(log, saw, 0.99, flat, eye);
    expect(layer.inFlight).toBe(0);
    // The first round, just out of the muzzle (at the instant of firing it has no length yet).
    layer.update(log, saw, 1.01, flat, eye);
    expect(layer.inFlight).toBe(1);
    // Rounds 0.075 s apart: just after 1.3 s, five are out (none landed: 230 m and more, 0.36 s).
    layer.update(log, saw, 1.31, flat, eye);
    expect(layer.inFlight).toBe(5);
    // The last is out at 1.525 s.
    layer.update(log, saw, 1.53, flat, eye);
    expect(layer.inFlight).toBeGreaterThanOrEqual(1);
    // 200 m and more at the visual speed (640 m/s): all landed within half a second of the last.
    layer.update(log, saw, 2.1, flat, eye);
    expect(layer.inFlight).toBe(0);
    layer.update(log, saw, 3.5, flat, eye);
    expect(layer.inFlight).toBe(0);
  });

  it('nothing for a grenade: only its explosion is shown, elsewhere', () => {
    const layer = createTracerLayer();
    const grenade: CombatEvent = {
      type: 'grenadeImpact',
      tick: 30,
      atSeconds: 1,
      shooterId: 'B1-01' as never,
      impact: { x: 0, y: 200 },
    };
    layer.update(log, [grenade], 1.2, flat, eye);
    expect(layer.inFlight).toBe(0);
  });

  it('the same moment gives the same picture (as the review needs)', () => {
    const events = [shot(1, 3, 'rifle', false), shot(1.4, 9, 'automaticRifle', true)];
    const a = createTracerLayer();
    const b = createTracerLayer();
    a.update(log, events, 1.55, flat, eye);
    b.update(log, events, 4, flat, eye);
    b.update(log, events, 1.55, flat, eye);
    expect(heads(b)).toEqual(heads(a));
    expect(a.inFlight).toBeGreaterThan(0);
  });

  it('a hit’s round flies into the target; misses scatter round it and fly on', () => {
    const layer = createTracerLayer();
    // The first round of a hit, nearly arrived (flight about 0.31 s).
    layer.update(log, [shot(1, 1, 'rifle', true)], 1.3, flat, eye);
    const [hit] = heads(layer);
    expect(hit && Math.abs(hit.x)).toBeLessThan(0.5);
    expect(hit?.y).toBeGreaterThan(190);
    expect(hit?.y).toBeLessThanOrEqual(200.5);
    layer.update(log, [shot(1, 3, 'rifle', false)], 1.35, flat, eye);
    expect(heads(layer).some((h) => Math.abs(h.x) > 0.3)).toBe(true);
  });

  it('flies at one speed on screen whatever the battle’s speed', () => {
    const events = [shot(1, 9, 'automaticRifle', false)];
    const slow = createTracerLayer();
    const fast = createTracerLayer();
    // 0.2 real seconds after the burst: at 1×, 0.2 s of the battle; at 32×, 6.4 s.
    slow.update(log, events, 1.2, flat, eye, 1);
    fast.update(log, events, 1 + 0.2 * 32, flat, eye, 32);
    expect(fast.inFlight).toBe(slow.inFlight);
    expect(fast.inFlight).toBeGreaterThan(0);
    const a = heads(slow);
    const b = heads(fast);
    b.forEach((h, i) => {
      expect(h.x).toBeCloseTo(a[i]?.x ?? NaN, 6);
      expect(h.y).toBeCloseTo(a[i]?.y ?? NaN, 6);
    });
    // The first round has flown 0.2 s at 640 m/s.
    expect(Math.max(...a.map((h) => h.y))).toBeGreaterThan(120);
    expect(Math.max(...a.map((h) => h.y))).toBeLessThan(130);
  });

  it('a streak is 11 m long', () => {
    const layer = createTracerLayer();
    layer.update(log, [shot(1, 1, 'rifle', false)], 1.15, flat, eye);
    const bars = layer.group.children.find((c): c is InstancedMesh => c instanceof InstancedMesh);
    const m = new Matrix4();
    bars?.getMatrixAt(0, m);
    const scale = new Vector3();
    m.decompose(new Vector3(), new Quaternion(), scale);
    expect(scale.z).toBeCloseTo(11, 3);
  });

  it('a vehicle’s guns fire tracers too; a main gun’s round flies a quarter as fast', () => {
    const heavy = (weapon: string): HeavyShotEvent => ({
      type: 'heavyShot',
      tick: 30,
      atSeconds: 1,
      shooterId: 'V1',
      shooter: 'vehicle',
      side: 'BLUEFOR',
      slot: 'main',
      weapon,
      ammo: 'x',
      rounds: 1,
      targetId: 'V2',
      target: 'vehicle',
      from: { x: 0, y: 0, z: 12 },
      impact: { x: 0, y: 1000, z: 12 },
      hit: true,
      missileId: null,
      impactAt: null,
    });
    const kinds: Record<string, string> = { m256: 'cannon', m240c: 'machineGun' };
    const layer = createTracerLayer((w) => kinds[w] ?? '');
    // A second after firing: the machine gun's round 640 m out, the main gun's 160 m.
    layer.update(log, [heavy('m240c')], 2, flat, eye);
    expect(heads(layer)[0]?.y).toBeCloseTo(640, 0);
    layer.update(log, [heavy('m256')], 2, flat, eye);
    expect(heads(layer)[0]?.y).toBeCloseTo(160, 0);
    // A missile is not a tracer (the heavy effects draw it), nor is a weapon of no known kind.
    layer.update(log, [{ ...heavy('m256'), missileId: 'M1', impactAt: 5 }], 2, flat, eye);
    expect(layer.inFlight).toBe(0);
    layer.update(log, [heavy('9k111')], 2, flat, eye);
    expect(layer.inFlight).toBe(0);
  });
});
