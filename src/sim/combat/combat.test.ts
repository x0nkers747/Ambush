import { describe, expect, it } from 'vitest';
import { createRngState } from '../rng';
import {
  applyHit,
  conditionOf,
  penetrationAt,
  perforationChance,
  presentedZone,
  resolveHit,
} from './armor';
import { COMBAT_WEAPONS, TARGETING, VEHICLE_PLATFORMS } from './catalog';
import { isLaid, layFor, mountAzimuth, mountPivot, slewMounts } from './mounts';
import {
  builtInCatalog,
  catalogOf,
  combatWeaponOf,
  platformOf,
  validateCombatWeapon,
  validatePlatform,
} from './registry';
import { initialVehicleCombat } from './state';
import {
  bestAmmo,
  chooseEngagement,
  effectOnSoldier,
  effectOnVehicle,
  suitabilityOf,
  type EngagementOption,
} from './targeting';
import type { PlatformSpec } from './types';

// Combined arms (docs/combined-arms.md): the definitions, armour, mounts and
// target and weapon selection, as pure functions.

const catalog = builtInCatalog();
const platform = (id: string) => platformOf(catalog, id);
const weapon = (id: string) => combatWeaponOf(catalog, id);
const DEG = Math.PI / 180;

/** The effect of a platform's weapon slot, with its best ammunition, on a target at a range and face. */
function slotEffect(
  shooter: string,
  slot: string,
  target: PlatformSpec | null,
  rangeM: number,
  zone: 'front' | 'side' | 'rear' | 'top' = 'front',
): number {
  const p = platform(shooter);
  const w = p.weapons.find((x) => x.id === slot);
  if (!w) throw new Error(`no slot ${slot}`);
  const spec = weapon(w.weapon);
  return (
    bestAmmo(
      spec,
      w.loads.map((l) => l.ammo),
      target,
      rangeM,
      zone,
    )?.effect ?? 0
  );
}

describe('the catalog', () => {
  it('has the four platforms, each valid, faction-independent', () => {
    expect(VEHICLE_PLATFORMS.map((p) => p.id)).toEqual(['m113', 'm1a1', 'bmp2', 't72b']);
    for (const w of COMBAT_WEAPONS) validateCombatWeapon(w);
    for (const p of VEHICLE_PLATFORMS) {
      validatePlatform(p, catalog);
      expect(p).not.toHaveProperty('side');
    }
    expect(platform('m1a1').targetClass).toBe('heavyArmor');
    expect(platform('t72b').targetClass).toBe('heavyArmor');
    expect(platform('bmp2').targetClass).toBe('lightArmor');
    expect(platform('m113').targetClass).toBe('lightArmor');
  });

  it('refuses a malformed platform: a cycle of mounts, ammunition its weapon does not fire, no crew', () => {
    const m1 = platform('m1a1');
    const cycle: PlatformSpec = {
      ...m1,
      id: 'bad',
      mounts: m1.mounts.map((m) => (m.id === 'turret' ? { ...m, parent: 'cupola' } : m)),
    };
    expect(() => {
      validatePlatform(cycle, catalog);
    }).toThrow(/cycle/);
    const wrongAmmo: PlatformSpec = {
      ...m1,
      id: 'bad',
      weapons: m1.weapons.map((w) =>
        w.id === 'main' ? { ...w, loads: [{ ammo: '3bm42', ready: 1, stowed: 0 }] } : w,
      ),
    };
    expect(() => {
      validatePlatform(wrongAmmo, catalog);
    }).toThrow(/does not fire/);
    expect(() => {
      validatePlatform({ ...m1, id: 'bad', crew: [] }, catalog);
    }).toThrow(/no crew/);
  });

  it('adds a scenario’s own platform beside the catalog’s, by id', () => {
    const btr = { ...platform('bmp2'), id: 'btr80', name: 'BTR-80' };
    const world = { platforms: [btr] };
    expect(catalogOf(world).platforms.get('btr80')?.name).toBe('BTR-80');
    expect(catalogOf(world).platforms.get('m1a1')).toBe(platform('m1a1'));
    expect(catalogOf({})).toBe(catalog);
  });
});

describe('armour', () => {
  it('interpolates penetration by range and holds the last beyond', () => {
    const m829 = weapon('m256').ammo[0];
    if (!m829) throw new Error('no ammo');
    expect(penetrationAt(m829, 0)).toBe(720);
    expect(penetrationAt(m829, 1000)).toBeCloseTo(695);
    expect(penetrationAt(m829, 9000)).toBe(610);
  });

  it('presents the front, side, rear or top by the attack’s bearing from the hull', () => {
    expect(presentedZone(0, 10 * DEG, false)).toBe('front');
    expect(presentedZone(0, 90 * DEG, false)).toBe('side');
    expect(presentedZone(0, 270 * DEG, false)).toBe('side');
    expect(presentedZone(0, 180 * DEG, false)).toBe('rear');
    expect(presentedZone(90 * DEG, 270 * DEG, false)).toBe('rear');
    expect(presentedZone(0, 0, true)).toBe('top');
  });

  it('perforates with a chance rising with the excess of penetration', () => {
    expect(perforationChance(500, 500)).toBeCloseTo(0.5);
    expect(perforationChance(700, 500)).toBeGreaterThan(0.98);
    expect(perforationChance(300, 500)).toBeLessThan(0.02);
    expect(perforationChance(10, 0)).toBe(1);
  });

  it('resolves a hit by its draws alone (the same seed, the same damage), and damage persists', () => {
    const t72 = platform('t72b');
    const ammo = weapon('m256').ammo[0];
    if (!ammo) throw new Error('no ammo');
    const a = initialVehicleCombat(t72, { x: 0, y: 0 });
    const b = initialVehicleCombat(t72, { x: 0, y: 0 });
    const ra = resolveHit(createRngState(11), t72, a, ammo, 1500, 0, 0);
    const rb = resolveHit(createRngState(11), t72, b, ammo, 1500, 0, 0);
    expect(ra).toEqual(rb);
    // Over many hits on its side, an APFSDS round nearly always perforates and often destroys.
    let destroyed = 0;
    const rng = createRngState(5);
    for (let k = 0; k < 200; k += 1) {
      const c = initialVehicleCombat(t72, { x: 0, y: 0 });
      const hit = resolveHit(rng, t72, c, ammo, 1500, 0, 90 * DEG);
      expect(hit.zone === 'side' || hit.zone === 'front' || hit.zone === 'rear').toBe(true);
      applyHit(c, hit, 10, 100);
      if (c.damage.destroyed) {
        destroyed += 1;
        expect(conditionOf(c)).toBe('destroyed');
        expect(c.crew.every((m) => m.state === 'incapacitated')).toBe(true);
        expect(c.damage.burningUntil).toBe(110);
      }
    }
    expect(destroyed).toBeGreaterThan(40);
  });

  it('marks a mission kill when it can neither move nor fight', () => {
    const c = initialVehicleCombat(platform('m113'), { x: 0, y: 0 });
    expect(conditionOf(c)).toBe('operational');
    c.damage.mobility = true;
    expect(conditionOf(c)).toBe('damaged');
    for (const w of c.weapons) w.disabled = true;
    expect(conditionOf(c)).toBe('missionKill');
  });
});

describe('mounts', () => {
  it('slew no faster than their rate, the short way round, within their limits', () => {
    const m1 = platform('m1a1');
    const c = initialVehicleCombat(m1, { x: 0, y: 0 });
    const turret = c.mounts.find((m) => m.id === 'turret');
    if (!turret) throw new Error('no turret');
    turret.goalAzimuth = -90 * DEG;
    slewMounts(m1, c, 1);
    // 40°/s: a second takes it 40° of the 90° to the left.
    expect(turret.azimuth).toBeCloseTo(-40 * DEG);
    slewMounts(m1, c, 2);
    expect(turret.azimuth).toBeCloseTo(-90 * DEG);
    expect(isLaid(turret, TARGETING.layToleranceDeg, TARGETING.elevationToleranceDeg)).toBe(true);
    // The gunner out, the commander lays it, slower; both out, it stays.
    const gunner = c.crew.find((m) => m.role === 'gunner');
    const commander = c.crew.find((m) => m.role === 'commander');
    if (!gunner || !commander) throw new Error('no crew');
    gunner.state = 'incapacitated';
    turret.goalAzimuth = 0;
    slewMounts(m1, c, 1);
    expect(turret.azimuth).toBeCloseTo(-90 * DEG + 40 * 0.7 * DEG);
    commander.state = 'incapacitated';
    const before = turret.azimuth;
    slewMounts(m1, c, 1);
    expect(turret.azimuth).toBe(before);
  });

  it('turn a child with its parent: the Abrams’ cupola on its turret', () => {
    const m1 = platform('m1a1');
    const c = initialVehicleCombat(m1, { x: 0, y: 0 });
    const turret = c.mounts.find((m) => m.id === 'turret');
    const cupola = c.mounts.find((m) => m.id === 'cupola');
    if (!turret || !cupola) throw new Error('no mounts');
    turret.azimuth = 90 * DEG;
    cupola.azimuth = 45 * DEG;
    expect(mountAzimuth(m1, c, 'cupola', 0)).toBeCloseTo(135 * DEG);
    // The cupola's pivot is turned round the turret's.
    const hull = { x: 100, y: 100, z: 0, heading: 0 };
    const pivot = mountPivot(m1, c, 'cupola', hull);
    const turretPivot = mountPivot(m1, c, 'turret', hull);
    // The turret faces east: the cupola's offset (0.55 right, 0.55 back) is turned to south and west.
    expect(pivot.x).toBeCloseTo(turretPivot.x - 0.55);
    expect(pivot.y).toBeCloseTo(turretPivot.y - 0.55);
  });

  it('cannot bear beyond the elevation limits (a T-72’s gun at a target overhead)', () => {
    const t72 = platform('t72b');
    const c = initialVehicleCombat(t72, { x: 0, y: 0 });
    const hull = { x: 0, y: 0, z: 0, heading: 0 };
    expect(layFor(t72, c, 'turret', hull, { x: 0, y: 500, z: 2 })).not.toBeNull();
    expect(layFor(t72, c, 'turret', hull, { x: 0, y: 50, z: 60 })).toBeNull();
  });
});

describe('weapon suitability (data-driven, by effect)', () => {
  const t72 = platform('t72b');
  const m1 = platform('m1a1');
  const bmp = platform('bmp2');
  const m113 = platform('m113');
  const ineffective = (e: number) => suitabilityOf(e, TARGETING) === 'ineffective';

  it('a machine gun is ineffective against a tank; the main gun is suitable', () => {
    expect(ineffective(slotEffect('m1a1', 'coax', t72, 800, 'side'))).toBe(true);
    expect(ineffective(slotEffect('m1a1', 'hmg', t72, 300, 'rear'))).toBe(true);
    expect(ineffective(slotEffect('m1a1', 'main', t72, 1500, 'front'))).toBe(false);
    expect(ineffective(slotEffect('t72b', 'coax', m1, 400, 'side'))).toBe(true);
  });

  it('the M2HB defeats an M113’s and a BMP-2’s sides close in, not a BMP-2’s front far off', () => {
    expect(ineffective(slotEffect('m113', 'hmg', m113, 300, 'side'))).toBe(false);
    expect(ineffective(slotEffect('m113', 'hmg', bmp, 200, 'side'))).toBe(false);
    expect(ineffective(slotEffect('m113', 'hmg', bmp, 800, 'front'))).toBe(true);
  });

  it('an RPG-7 cannot defeat an Abrams’ front, but can its side and rear', () => {
    const rpg = weapon('rpg7');
    const pg7 = rpg.ammo[0];
    if (!pg7) throw new Error('no ammo');
    expect(ineffective(effectOnVehicle(rpg, pg7, m1, 150, 'front'))).toBe(true);
    expect(ineffective(effectOnVehicle(rpg, pg7, m1, 150, 'rear'))).toBe(false);
    // A Javelin attacks the roof: whichever face it is fired at.
    const jav = weapon('javelin');
    const top = jav.ammo[0];
    if (!top) throw new Error('no ammo');
    expect(ineffective(effectOnVehicle(jav, top, t72, 1500, 'front'))).toBe(false);
  });

  it('an anti-tank weapon does nothing to soldiers; a coaxial gun does', () => {
    const at4 = weapon('at4');
    const heat = at4.ammo[0];
    const m240 = weapon('m240c');
    const ball = m240.ammo[0];
    if (!heat || !ball) throw new Error('no ammo');
    expect(effectOnSoldier(at4, heat, 100)).toBe(0);
    expect(effectOnSoldier(m240, ball, 300)).toBeGreaterThan(TARGETING.minimumEffect);
  });

  it('prefers the coax at soldiers (cheaper) and the main gun at tanks (the only effect)', () => {
    const option = (o: Partial<EngagementOption> & { effect: number; cost: number }) => {
      const value = TARGETING.classValue[o.targetClass ?? 'infantry'];
      return {
        targetId: 'x',
        target: 'soldier' as const,
        targetClass: 'infantry' as const,
        weapon: 'main',
        ammo: 'a',
        rangeM: 500,
        threat: 0,
        delaySeconds: 0,
        ...o,
        utility: (o.effect * ((o.threat ?? 0) + value)) / o.cost,
      };
    };
    const coax = slotEffect('m1a1', 'coax', null, 400);
    const heat = slotEffect('m1a1', 'main', null, 400);
    const choice = chooseEngagement(
      undefined,
      [
        option({ weapon: 'main', effect: heat, cost: 8 }),
        option({ weapon: 'coax', effect: coax, cost: 0.6 }),
      ],
      0,
      TARGETING,
    );
    expect(choice?.weapon).toBe('coax');
  });

  it('keeps its target until reassessing, then switches only for a markedly better one', () => {
    const base = {
      target: 'vehicle' as const,
      targetClass: 'heavyArmor' as const,
      weapon: 'main',
      ammo: 'a',
      rangeM: 1000,
      effect: 0.5,
      threat: 0.5,
      cost: 8,
      delaySeconds: 0,
    };
    const a = { ...base, targetId: 'A', utility: 1 };
    const b = { ...base, targetId: 'B', utility: 1.3 };
    const c = { ...base, targetId: 'C', utility: 1.6 };
    const current = {
      mount: 'turret',
      targetId: 'A',
      target: 'vehicle' as const,
      weapon: 'main',
      ammo: 'a',
      since: 0,
      reassessAt: 4,
      utility: 1,
      aimedAt: null,
    };
    expect(chooseEngagement(current, [a, c], 1, TARGETING)?.targetId).toBe('A');
    expect(chooseEngagement(current, [a, b], 5, TARGETING)?.targetId).toBe('A');
    expect(chooseEngagement(current, [a, c], 5, TARGETING)?.targetId).toBe('C');
    // Its target gone: the best of the rest.
    expect(chooseEngagement(current, [b, c], 1, TARGETING)?.targetId).toBe('C');
  });
});
