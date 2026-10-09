import { describe, expect, it } from 'vitest';
import {
  resolveSlot,
  validateOrganizationTemplate,
  type OrganizationTemplate,
} from './organization';
import { USMC_RIFLE_SQUAD_TEMPLATE } from './squad';
import { primaryWeapon, WEAPON_DISPLAY_PROFILES } from './weapon-display';

// Which weapon a Marine's engagement wedge shows: his primary firearm, from
// his resolved loadout (docs/adr/0018). Display only.

const refs = (...weaponProfileRefs: string[]) => ({ weaponProfileRefs });

describe('primaryWeapon', () => {
  it('shows the rifle of a rifle, grenade launcher and bayonet, in any order', () => {
    const rifle = { kind: 'weapon', ref: 'm16-rifle', maxEngagementRangeM: 550 };
    expect(
      primaryWeapon(refs('m16-rifle', 'm203-grenade-launcher', 'bayonet-knife')),
    ).toMatchObject(rifle);
    expect(
      primaryWeapon(refs('m203-grenade-launcher', 'bayonet-knife', 'm16-rifle')),
    ).toMatchObject(rifle);
    expect(primaryWeapon(refs('bayonet-knife', 'm16-rifle'))).toMatchObject(rifle);
  });

  it('shows the automatic rifleman’s SAW', () => {
    expect(primaryWeapon(refs('squad-automatic-weapon', 'combat-knife'))).toMatchObject({
      kind: 'weapon',
      ref: 'squad-automatic-weapon',
      name: 'M249 SAW',
      maxEngagementRangeM: 600,
    });
  });

  it('takes the first of several primary firearms, not the longest-ranged', () => {
    expect(primaryWeapon(refs('m16-rifle', 'squad-automatic-weapon'))).toMatchObject({
      ref: 'm16-rifle',
      maxEngagementRangeM: 550,
    });
    expect(primaryWeapon(refs('squad-automatic-weapon', 'm16-rifle'))).toMatchObject({
      ref: 'squad-automatic-weapon',
    });
  });

  it('shows nothing for melee or auxiliary weapons alone, or no weapons', () => {
    expect(primaryWeapon(refs('bayonet-knife', 'combat-knife'))).toEqual({
      kind: 'noPrimaryWeapon',
    });
    expect(primaryWeapon(refs('m203-grenade-launcher', 'bayonet-knife'))).toEqual({
      kind: 'noPrimaryWeapon',
    });
    expect(primaryWeapon(refs())).toEqual({ kind: 'noPrimaryWeapon' });
  });

  it('never guesses round an unknown weapon', () => {
    // An unknown weapon might be the primary: no wedge, rather than the grenade launcher or rifle.
    expect(primaryWeapon(refs('m4-carbine', 'm203-grenade-launcher'))).toEqual({
      kind: 'unknownWeapon',
      ref: 'm4-carbine',
    });
    expect(primaryWeapon(refs('m16-rifle', 'mystery-weapon'))).toEqual({
      kind: 'unknownWeapon',
      ref: 'mystery-weapon',
    });
    // References must match exactly.
    expect(primaryWeapon(refs('M16-Rifle')).kind).toBe('unknownWeapon');
  });
});

describe('the USMC rifle squad template', () => {
  it('names only weapons with a display profile', () => {
    const named = new Set([
      ...USMC_RIFLE_SQUAD_TEMPLATE.roles.flatMap((r) => r.defaultLoadout?.weaponProfileRefs ?? []),
      ...USMC_RIFLE_SQUAD_TEMPLATE.slots.flatMap((s) => s.loadout?.weaponProfileRefs ?? []),
    ]);
    for (const ref of named) expect(WEAPON_DISPLAY_PROFILES[ref], ref).toBeDefined();
  });

  it('gives every position its primary firearm and range', () => {
    const shown = Object.fromEntries(
      USMC_RIFLE_SQUAD_TEMPLATE.slots.map((slot) => {
        const weapon = primaryWeapon(resolveSlot(USMC_RIFLE_SQUAD_TEMPLATE, slot).loadout);
        return [
          slot.id,
          weapon.kind === 'weapon'
            ? `${weapon.ref} ${String(weapon.maxEngagementRangeM)}`
            : weapon.kind,
        ];
      }),
    );
    expect(shown).toEqual({
      SL: 'm16-rifle 550',
      ...Object.fromEntries(
        [1, 2, 3].flatMap((t) => [
          [`FT${String(t)}.FTL`, 'm16-rifle 550'],
          [`FT${String(t)}.AR`, 'squad-automatic-weapon 600'],
          [`FT${String(t)}.AAR`, 'm16-rifle 550'],
          [`FT${String(t)}.R`, 'm16-rifle 550'],
        ]),
      ),
    });
  });

  it('uses a slot’s own loadout over its role’s default', () => {
    // A fixture: the 1st fire team's rifleman given a SAW (not a change to the squad).
    const withOverride: OrganizationTemplate = {
      ...USMC_RIFLE_SQUAD_TEMPLATE,
      slots: USMC_RIFLE_SQUAD_TEMPLATE.slots.map((s) =>
        s.id === 'FT1.R' ? { ...s, loadout: refs('squad-automatic-weapon', 'bayonet-knife') } : s,
      ),
    };
    expect(() => {
      validateOrganizationTemplate(withOverride);
    }).not.toThrow();
    const rangeOf = (template: OrganizationTemplate, slotId: string) => {
      const slot = template.slots.find((s) => s.id === slotId);
      if (!slot) throw new Error(slotId);
      const weapon = primaryWeapon(resolveSlot(template, slot).loadout);
      return weapon.kind === 'weapon' ? weapon.maxEngagementRangeM : null;
    };
    expect(rangeOf(withOverride, 'FT1.R')).toBe(600);
    // Others in the same role keep the role's default; without the override it comes back.
    expect(rangeOf(withOverride, 'FT2.R')).toBe(550);
    expect(rangeOf(withOverride, 'FT3.R')).toBe(550);
    expect(rangeOf(USMC_RIFLE_SQUAD_TEMPLATE, 'FT1.R')).toBe(550);
  });
});
