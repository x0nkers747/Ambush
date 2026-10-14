import { createMotionRecorder, type MotionLog } from '#exercise';
import type { SimState } from '#sim';
import type { UnitMarker } from '../unit-markers';

// A crowd for measuring (docs/character-animation.md, performance): `count`
// soldiers in rings round a point, walking and running round them on the
// battlefield's surface, half BLUEFOR with M16s or M249s and half OPFOR with
// AKs — the game's own soldiers, layer and renderer, with stand-in motion.
// Used by the 3D view's `ambushBenchCharacters` check hook only.

export interface BenchCrowd {
  readonly log: MotionLog;
  readonly units: UnitMarker[];
  readonly weapons: Record<string, string>;
  /** The crowd's simulated length (s). */
  readonly seconds: number;
}

export function benchCrowd(
  count: number,
  centre: { x: number; y: number },
  surfaceAt: (x: number, y: number) => number,
): BenchCrowd {
  const rate = 30;
  const seconds = 120;
  const log = createMotionRecorder(rate);
  const ids = Array.from({ length: count }, (_, i) => `B${String(i + 1).padStart(3, '0')}`);
  const weapons: Record<string, string> = {};
  ids.forEach((id, i) => {
    weapons[id] =
      i % 2 === 1 ? 'ak-assault-rifle' : i % 8 === 2 ? 'squad-automatic-weapon' : 'm16-rifle';
  });
  const place = (i: number, t: number) => {
    const ring = 4 + 3 * Math.floor(i / 8);
    // Most walk (1.5 m/s, the game's pace); every fourth runs; every eighth stands.
    const speed = i % 8 === 7 ? 0 : i % 4 === 3 ? 3.5 : 1.5;
    const a0 = (i % 8) * (Math.PI / 4) + Math.floor(i / 8) * 0.3;
    const a = a0 + (speed / ring) * t;
    const x = centre.x + ring * Math.cos(a);
    const y = centre.y + ring * Math.sin(a);
    // Facing the way of travel (clockwise from north): tangent to the ring.
    const azimuth =
      ((Math.atan2(-Math.sin(a), Math.cos(a)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    const z = surfaceAt(x, y);
    return { x, y, z: Number.isFinite(z) ? z : 0, azimuth };
  };
  const units: UnitMarker[] = [];
  for (let tick = 0; tick <= seconds * rate; tick += 1) {
    const soldiers = ids.map((id, i) => {
      const p = place(i, tick / rate);
      return {
        id,
        side: i % 2 === 1 ? 'OPFOR' : 'BLUEFOR',
        position: { x: p.x, y: p.y, z: p.z },
        azimuth: p.azimuth,
        posture: i % 16 === 5 ? 'kneeling' : 'standing',
        status: 'active',
      };
    });
    log.record({ tick, soldiers } as unknown as SimState);
    if (tick === 0)
      for (const s of soldiers)
        units.push({
          id: s.id as UnitMarker['id'],
          affiliation: s.side === 'BLUEFOR' ? 'friendly' : 'enemy',
          position: s.position,
          azimuth: s.azimuth,
          posture: s.posture as UnitMarker['posture'],
          status: 'active',
          selected: false,
        });
  }
  return { log, units, weapons, seconds };
}
