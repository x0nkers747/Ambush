import { describe, expect, it } from 'vitest';
import type { PointsMaterial } from 'three';
import { InstancedMesh, Matrix4, Points, Quaternion, Vector3 } from 'three';
import { createMotionRecorder, type CombatEvent, type HeavyShotEvent } from '#exercise';
import type { SimState } from '#sim';
import { createTracerLayer, tracerShown } from './tracers';

// Tracers in the 3D view: one streak per round of each burst, staggered as
// the weapon fires them, gone once landed; nothing for grenades; the same
// picture for the same moment (the review's), and a hit's round ending in
// its target; one speed on screen, and as many in the air, whatever the
// battle's speed; the vehicles' guns alike, a main gun's head bigger.

/** Two soldiers 200 m apart (north), standing still, for 60 s at 30 Hz. */
function motion() {
  const log = createMotionRecorder(30);
  for (let tick = 0; tick <= 1800; tick += 1) {
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

/**
 * A burst as recorded before rounds had a time of flight (`arriveAt` NaN):
 * its tracers fly on screen. `flies`: as recorded now, at 900 m/s.
 */
const shot = (
  atSeconds: number,
  rounds: number,
  weapon: string,
  hit: boolean,
  flies = false,
): CombatEvent => ({
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
  arriveAt: flies ? atSeconds + 200 / 900 : Number.NaN,
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

  it('flying in the battle’s time: the hit arrives with the battle’s, at 900 m/s, whatever the speed', () => {
    const layer = createTracerLayer();
    // A hit, fired at 1 s: 200 m to his body (he kneels, 0.7 m up; the muzzle 1.45 m) in 0.222 s.
    const saw = [shot(1, 1, 'rifle', true, true)];
    layer.update(log, saw, 1.111, flat, eye);
    expect(layer.inFlight).toBe(1);
    expect(heads(layer)[0]?.y).toBeCloseTo(100, 0);
    // At ½× the same moment of the battle: the same place (faster, one burst in so many is drawn).
    layer.update(log, saw, 1.111, flat, eye, 0.5);
    expect(heads(layer)[0]?.y).toBeCloseTo(100, 0);
    // Arrived (as the battle strikes him down): gone.
    layer.update(log, saw, 1.23, flat, eye);
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
    // A burst drawn at 32× (one in 32 is).
    let at = 1;
    while (!tracerShown('B1-01', Math.round(at * 30), 'automaticRifle', 32)) at += 1 / 30;
    const events = [shot(at, 9, 'automaticRifle', false)];
    const slow = createTracerLayer();
    const fast = createTracerLayer();
    // 0.2 real seconds after the burst: at 1×, 0.2 s of the battle; at 32×, 6.4 s.
    slow.update(log, events, at + 0.2, flat, eye, 1);
    fast.update(log, events, at + 0.2 * 32, flat, eye, 32);
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

  it('as many in the air whatever the battle’s speed: at 32×, one burst in 32 is drawn', () => {
    // A rifle shot every tenth of a second for a minute.
    const events = Array.from({ length: 590 }, (_, i) => shot(i / 10, 1, 'rifle', false));
    const inAir = (speed: number) => {
      const layer = createTracerLayer();
      let total = 0;
      const moments = 120;
      for (let k = 0; k < moments; k += 1) {
        layer.update(log, events, 20 + (k * 38) / moments, flat, eye, speed);
        total += layer.inFlight;
      }
      return total / moments;
    };
    const at1 = inAir(1);
    const at32 = inAir(32);
    // About four at once at 1× (a round flies 0.36–0.47 s, one fired each 0.1 s).
    expect(at1).toBeGreaterThan(3);
    expect(at1).toBeLessThan(5);
    // At 32× each burst flies 32 times as long in the battle's time: still about four.
    expect(at32).toBeGreaterThan(at1 * 0.6);
    expect(at32).toBeLessThan(at1 * 1.4);
    // Up to 1×, every burst.
    expect(tracerShown('B1-01', 30, 'rifle', 1)).toBe(true);
    expect(tracerShown('B1-01', 30, 'rifle', 0.5)).toBe(true);
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

  it('a vehicle’s guns fire tracers too, as fast; a main gun’s head is four times the size', () => {
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
    const points = () =>
      layer.group.children
        .filter((c): c is Points => c instanceof Points)
        .map((p) => ({
          px: (p.material as PointsMaterial).size,
          drawn: p.geometry.drawRange.count,
        }));
    // A second after firing: either round 640 m out.
    layer.update(log, [heavy('m240c')], 2, flat, eye);
    expect(heads(layer)[0]?.y).toBeCloseTo(640, 0);
    expect(points()).toEqual([
      { px: 5, drawn: 1 },
      { px: 20, drawn: 0 },
    ]);
    layer.update(log, [heavy('m256')], 2, flat, eye);
    expect(heads(layer)[0]?.y).toBeCloseTo(640, 0);
    expect(points()).toEqual([
      { px: 5, drawn: 0 },
      { px: 20, drawn: 1 },
    ]);
    // A weapon of no known kind is not a tracer.
    layer.update(log, [heavy('m240c-unknown')], 2, flat, eye);
    expect(layer.inFlight).toBe(0);
  });

  it('a missile or rocket is drawn as a main gun’s round, at its own speed in the battle’s time', () => {
    const missile: HeavyShotEvent = {
      type: 'heavyShot',
      tick: 30,
      atSeconds: 1,
      shooterId: 'V1',
      shooter: 'vehicle',
      side: 'OPFOR',
      slot: 'atgm',
      weapon: '9p135m',
      ammo: '9m113',
      rounds: 1,
      targetId: 'V2',
      target: 'vehicle',
      from: { x: 0, y: 0, z: 12 },
      impact: { x: 0, y: 2080, z: 12 },
      hit: true,
      // 2,080 m at 208 m/s: it arrives 10 s after launch.
      missileId: 'M1',
      impactAt: 11,
    };
    const layer = createTracerLayer(() => '');
    const bigDrawn = () =>
      layer.group.children
        .filter((c): c is Points => c instanceof Points)
        .find((p) => (p.material as PointsMaterial).size === 20)?.geometry.drawRange.count;
    // Half way, 5 s after launch: 1,040 m out, with a main gun's head.
    layer.update(log, [missile], 6, flat, eye);
    expect(heads(layer)[0]?.y).toBeCloseTo(1040, 0);
    expect(bigDrawn()).toBe(1);
    // At 32× as at 1×: where the battle's clock puts it (it lands as its hit does).
    layer.update(log, [missile], 6, flat, eye, 32);
    expect(heads(layer)[0]?.y).toBeCloseTo(1040, 0);
    expect(layer.inFlight).toBe(1);
    // Arrived: gone.
    layer.update(log, [missile], 11.5, flat, eye);
    expect(layer.inFlight).toBe(0);
    // An AT4 (a rocket): at 260 m/s, 1 s after firing 260 m out.
    const rocket: HeavyShotEvent = {
      ...missile,
      shooter: 'soldier',
      side: 'BLUEFOR',
      weapon: 'at4',
      missileId: null,
      impactAt: null,
      impact: { x: 0, y: 300, z: 12 },
    };
    const rockets = createTracerLayer((w) => (w === 'at4' ? 'atRocket' : ''));
    rockets.update(log, [rocket], 2, flat, eye);
    expect(heads(rockets)[0]?.y).toBeCloseTo(260, 0);
    // A main gun's round the battle flies (M829A1, 1,575 m/s: 2,080 m in 1.32 s): likewise,
    // in the battle's time, at 32× too, landing when the battle says.
    const sabot: HeavyShotEvent = {
      ...missile,
      side: 'BLUEFOR',
      slot: 'main',
      weapon: 'm256',
      ammo: 'm829a1',
      missileId: null,
      impactAt: 1 + 2080 / 1575,
    };
    const guns = createTracerLayer((w) => (w === 'm256' ? 'cannon' : ''));
    guns.update(log, [sabot], 1.5, flat, eye, 32);
    expect(heads(guns)[0]?.y).toBeCloseTo(787.5, 0);
    guns.update(log, [sabot], 2.4, flat, eye);
    expect(guns.inFlight).toBe(0);
  });
});
