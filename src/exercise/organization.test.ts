import { describe, expect, it } from 'vitest';
import type { ScenarioSoldier } from '#sim';
import { USMC_RIFLE_SQUAD_TEMPLATE } from './squad';
import {
  instantiateOrganization,
  migrateOrganizationTemplate,
  OrganizationTemplateError,
  readOrganizationTemplate,
  resolveSlot,
  rosterMembers,
  rosterTree,
  validateOrganizationTemplate,
  type OrganizationInstance,
} from './organization';
import usmc from './organizations/usmc-rifle-squad-mcwp-3-11-2.json';
import patrol from './test-data/synthetic-patrol.template.json';
import usmcV1 from './test-data/usmc-rifle-squad-v1.template.json';

const PATROL = validateOrganizationTemplate(patrol);

/** A deep copy of a template as plain JSON, for editing in tests. */
const copy = (template: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
const list = (value: unknown) => value as Record<string, unknown>[];
/** Entry `index` of the array field `key` of a template copy. */
const item = (t: Record<string, unknown>, key: string, index: number) => {
  const entry = list(t[key])[index];
  if (!entry) throw new Error(`no ${key}[${String(index)}]`);
  return entry;
};

describe('the USMC rifle squad template (MCWP 3-11.2)', () => {
  const template = USMC_RIFLE_SQUAD_TEMPLATE;

  it('identifies its exact doctrinal source, date and currency', () => {
    expect(template.source).toMatchObject({
      kind: 'doctrine',
      designation: 'MCWP 3-11.2 (formerly FMFM 6-5)',
      title: 'Marine Rifle Squad',
      date: '1991-12-02',
      identifier: 'PCN 143 000112 00',
    });
    if (template.source.kind !== 'doctrine') throw new Error('not doctrine');
    expect(template.source.references).toContain('para 1003, Composition of the Rifle Squad');
    expect(template.source.status).toMatch(/supersede/i);
    expect(template.source.amendments?.map((a) => a.date)).toEqual(['1997-07-24', '2002-11-27']);
    // What is Ambush!'s own choice rather than doctrine is said so.
    expect(template.conventions.length).toBeGreaterThan(0);
  });

  it('is 13 Marines: a squad leader and three fire teams of four (para 1003)', () => {
    expect(template.slots).toHaveLength(13);
    const tree = rosterTree({
      template,
      unitIdPrefix: '',
      members: template.slots.map((s) => ({ soldierId: s.id, slotId: s.id })),
    });
    expect(tree.unit).toMatchObject({ id: 'SQD', echelon: 'squad', leaderSlotId: 'SL' });
    expect(tree.members.map((m) => m.role.id)).toEqual(['squadLeader']);
    expect(tree.children.map((c) => c.unit.echelon)).toEqual(['fireTeam', 'fireTeam', 'fireTeam']);
    for (const team of tree.children) {
      expect(team.members.map((m) => m.role.abbreviation)).toEqual(['FTL', 'AR', 'AAR', 'R']);
      expect(team.members.filter((m) => m.leads).map((m) => m.role.id)).toEqual(['fireTeamLeader']);
    }
  });

  it('records grades and weapons as the source gives them (paras 1003, 1004a)', () => {
    const role = (id: string) => template.roles.find((r) => r.id === id);
    expect(role('squadLeader')?.grade).toBe('Sergeant');
    expect(role('fireTeamLeader')?.grade).toBe('Corporal');
    expect(role('automaticRifleman')?.grade).toBe('Lance corporal');
    expect(role('rifleman')?.grade).toBe('Private or private first class');
    expect(role('fireTeamLeader')?.defaultLoadout?.weaponProfileRefs).toContain(
      'm203-grenade-launcher',
    );
    expect(role('automaticRifleman')?.defaultLoadout?.weaponProfileRefs).toContain(
      'squad-automatic-weapon',
    );
  });

  it('maps every role to an Ambush! individual icon (docs/adr/0013)', () => {
    expect(Object.fromEntries(template.roles.map((r) => [r.id, r.defaultIcon]))).toEqual({
      squadLeader: 'squadLeader',
      fireTeamLeader: 'fireTeamLeader',
      automaticRifleman: 'automaticRifleman',
      // Armed with a rifle (para 1004a); there is no assistant automatic rifleman icon.
      assistantAutomaticRifleman: 'rifleman',
      rifleman: 'rifleman',
    });
  });

  it('keeps APP-6 unit symbols for the squad and its fire teams', () => {
    expect(template.units.map((u) => u.symbology?.sidc)).toEqual([
      '10031000121211000000',
      '10031000111211000000',
      '10031000111211000000',
      '10031000111211000000',
    ]);
  });

  it('is the JSON file, validated unchanged', () => {
    expect(template).toEqual(usmc);
  });
});

describe('role, loadout and icon', () => {
  const template = USMC_RIFLE_SQUAD_TEMPLATE;
  const slot = (id: string) => {
    const found = template.slots.find((s) => s.id === id);
    if (!found) throw new Error(`no slot ${id}`);
    return found;
  };

  it('resolve as three separate properties, the role giving the defaults', () => {
    const ftl = resolveSlot(template, slot('FT1.FTL'));
    expect(ftl.role.id).toBe('fireTeamLeader');
    expect(ftl.loadout.weaponProfileRefs).toEqual([
      'm16-rifle',
      'm203-grenade-launcher',
      'bayonet-knife',
    ]);
    expect(ftl.icon).toBe('fireTeamLeader');
    // Same role-derived icon as a rifleman, different role and the same rifle.
    const aar = resolveSlot(template, slot('FT1.AAR'));
    expect([aar.role.id, aar.icon]).toEqual(['assistantAutomaticRifleman', 'rifleman']);
  });

  it('let a slot override its loadout and icon without changing its role', () => {
    const data = copy(usmc);
    item(data, 'slots', 1)['icon'] = 'grenadier';
    item(data, 'slots', 1)['loadout'] = { weaponProfileRefs: ['m203-grenade-launcher'] };
    const edited = validateOrganizationTemplate(data);
    const ftl = resolveSlot(edited, edited.slots[1] ?? slot('FT1.FTL'));
    expect(ftl.role.id).toBe('fireTeamLeader');
    expect(ftl.icon).toBe('grenadier');
    expect(ftl.loadout.weaponProfileRefs).toEqual(['m203-grenade-launcher']);
    // The other fire team leaders keep their role's defaults.
    expect(resolveSlot(edited, slot('FT2.FTL')).icon).toBe('fireTeamLeader');
  });

  it('fall back to no loadout and no icon (unknown role) when none is given', () => {
    const data = copy(usmc);
    delete item(data, 'roles', 4)['defaultIcon'];
    delete item(data, 'roles', 4)['defaultLoadout'];
    const edited = validateOrganizationTemplate(data);
    expect(resolveSlot(edited, slot('FT1.R'))).toMatchObject({
      icon: null,
      loadout: { weaponProfileRefs: [] },
    });
  });

  it('are what the roster shows for each member', () => {
    const members = rosterMembers(
      rosterTree({
        template,
        unitIdPrefix: '',
        members: template.slots.map((s, i) => ({ soldierId: `M${String(i)}`, slotId: s.id })),
      }),
    );
    for (const m of members) expect(m).toMatchObject(resolveSlot(template, m.slot));
  });
});

describe('version 1 templates', () => {
  it('are converted to version 2 automatically by readOrganizationTemplate', () => {
    const read = readOrganizationTemplate(usmcV1);
    expect(read.migratedFrom).toBe(1);
    expect(read.template.schemaVersion).toBe(2);
    // The template's own version is the author's and is kept.
    expect(read.template.version).toBe('1.0.0');
    // Units, slots, source and loadouts carry over; roles lose only their APP-6 code.
    expect(read.template.units).toEqual(usmc.units);
    expect(read.template.slots).toEqual(usmc.slots);
    expect(read.template.source).toEqual(usmc.source);
    const withoutIcon = (role: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(role).filter(([key]) => key !== 'defaultIcon'));
    expect(read.template.roles).toEqual(usmc.roles.map(withoutIcon));
  });

  it('get no role icon: an individual APP-6 code names none, so nothing is guessed', () => {
    const { template: migrated, notes } = readOrganizationTemplate(usmcV1);
    for (const s of migrated.slots) expect(resolveSlot(migrated, s).icon).toBeNull();
    expect(notes).toContain(
      'role "squadLeader": APP-6 code "10032700001101010000" dropped; it names no role icon, so the role has no defaultIcon and is drawn as an unknown role until one is added',
    );
    expect(notes).toContain('role "rifleman": weaponProfileRefs moved to defaultLoadout');
  });

  it('can then be instantiated like any template', () => {
    const { template: migrated } = readOrganizationTemplate(usmcV1);
    const { soldiers } = instantiateOrganization(
      migrated,
      {
        templateId: migrated.id,
        templateVersion: migrated.version,
        side: 'BLUEFOR',
        unitIdPrefix: '',
        facingDeg: 0,
        posture: 'standing',
        members: migrated.slots.map((s, i) => ({ soldierId: `S${String(i)}`, slotId: s.id })),
      },
      (_member, i) => ({ east: i * 2, north: 0 }),
    );
    expect(soldiers).toHaveLength(13);
  });

  it('are still refused by the strict validator, which reads only the current version', () => {
    expect(() => validateOrganizationTemplate(usmcV1)).toThrow(
      /schemaVersion: 1 is not supported \(expected 2; readOrganizationTemplate converts version 1\)/,
    );
  });

  it('leave current, unknown and malformed data to validation, unchanged', () => {
    expect(migrateOrganizationTemplate(usmc)).toEqual({
      data: usmc,
      migratedFrom: null,
      notes: [],
    });
    const other = { schema: 'something-else', schemaVersion: 1 };
    expect(migrateOrganizationTemplate(other).data).toBe(other);
    expect(() => readOrganizationTemplate({ ...copy(usmcV1), roles: 'none' })).toThrow(
      /\$\.roles: must be an array/,
    );
    expect(() => readOrganizationTemplate({ ...copy(usmcV1), schemaVersion: 0 })).toThrow(
      /schemaVersion: 0 is not supported/,
    );
  });

  it('do not alter the data they are given', () => {
    const before = JSON.stringify(usmcV1);
    readOrganizationTemplate(usmcV1);
    expect(JSON.stringify(usmcV1)).toBe(before);
  });
});

describe('validateOrganizationTemplate', () => {
  it('accepts a different organization: six people, three levels, no fire teams', () => {
    expect(PATROL.slots).toHaveLength(6);
    const tree = rosterTree({
      template: PATROL,
      unitIdPrefix: '',
      members: PATROL.slots.map((s) => ({ soldierId: s.id, slotId: s.id })),
    });
    expect(tree.children.map((c) => c.unit.id)).toEqual(['NORTH', 'SOUTH']);
    expect(tree.children[1]?.members).toEqual([]);
    expect(tree.children[1]?.children[0]?.unit.id).toBe('REAR');
    expect(rosterMembers(tree).map((m) => m.slot.label)).toEqual([
      'PL',
      'SIG',
      'N1',
      'N2',
      'R1',
      'R2',
    ]);
  });

  it.each<[string, (t: Record<string, unknown>) => void, RegExp]>([
    ['another schema', (t) => (t['schema'] = 'something-else'), /\$\.schema/],
    [
      'a newer schema version',
      (t) => (t['schemaVersion'] = 3),
      /schemaVersion: 3 is not supported/,
    ],
    [
      'a role with an APP-6 code (version 1 style)',
      (t) => (item(t, 'roles', 0)['symbology'] = { sidc: '10032700001101010000' }),
      /\$\.roles\[0\]\.symbology: is not a known field/,
    ],
    [
      'a role with an unknown icon',
      (t) => (item(t, 'roles', 0)['defaultIcon'] = 'sniper'),
      /\$\.roles\[0\]\.defaultIcon: "sniper" is not one of squadLeader, fireTeamLeader/,
    ],
    [
      'a slot with an unknown icon',
      (t) => (item(t, 'slots', 0)['icon'] = 'sniper'),
      /\$\.slots\[0\]\.icon: "sniper" is not one of/,
    ],
    [
      'a loadout that is not a list of profile references',
      (t) => (item(t, 'slots', 0)['loadout'] = { weaponProfileRefs: 'm16-rifle' }),
      /\$\.slots\[0\]\.loadout\.weaponProfileRefs: must be an array/,
    ],
    ['an unknown field', (t) => (t['colour'] = 'blue'), /\$\.colour: is not a known field/],
    ['a version that is not semantic', (t) => (t['version'] = 'v1'), /\$\.version/],
    ['a repeated slot id', (t) => (item(t, 'slots', 1)['id'] = 'SL'), /repeats id "SL"/],
    ['a repeated label', (t) => (item(t, 'slots', 1)['label'] = 'SL'), /repeats label "SL"/],
    [
      'a slot in an unknown unit',
      (t) => (item(t, 'slots', 0)['unitId'] = 'XX'),
      /unknown unit "XX"/,
    ],
    [
      'a slot with an unknown role',
      (t) => (item(t, 'slots', 0)['roleId'] = 'medic'),
      /unknown role "medic"/,
    ],
    ['two root units', (t) => (item(t, 'units', 1)['parentId'] = null), /exactly one root unit/],
    [
      'a parent cycle',
      (t) => {
        item(t, 'units', 0)['parentId'] = 'FT1';
        item(t, 'units', 1)['parentId'] = 'SQD';
        item(t, 'units', 2)['parentId'] = null;
      },
      /cycle|root/,
    ],
    [
      'a leader from another unit',
      (t) => (item(t, 'units', 1)['leaderSlotId'] = 'FT2.FTL'),
      /not part of unit "FT1"/,
    ],
    [
      'an unknown leader slot',
      (t) => (item(t, 'units', 1)['leaderSlotId'] = 'FT9.FTL'),
      /unknown slot "FT9.FTL"/,
    ],
    [
      'a malformed unit symbol code',
      (t) => (item(t, 'units', 0)['symbology'] = { sidc: 'SFGPUCI----' }),
      /sidc/,
    ],
    [
      'a doctrinal source without a date',
      (t) => delete (t['source'] as Record<string, unknown>)['date'],
      /\$\.source\.date: is missing/,
    ],
    [
      'a unit with nobody in it',
      (t) =>
        list(t['units']).push({
          id: 'EMPTY',
          name: 'Empty',
          abbreviation: 'E',
          echelon: 'team',
          parentId: 'SQD',
          leaderSlotId: null,
        }),
      /unit "EMPTY" has no slots/,
    ],
  ])('refuses %s', (_label, change, message) => {
    const t = copy(usmc);
    change(t);
    expect(() => validateOrganizationTemplate(t)).toThrow(OrganizationTemplateError);
    expect(() => validateOrganizationTemplate(t)).toThrow(message);
  });
});

describe('instantiateOrganization', () => {
  const instance = (members: OrganizationInstance['members']): OrganizationInstance => ({
    templateId: PATROL.id,
    templateVersion: PATROL.version,
    side: 'BLUEFOR',
    unitIdPrefix: 'P/',
    facingDeg: 90,
    posture: 'standing',
    members,
  });
  const ALL = PATROL.slots.map((s, i) => ({ soldierId: `S${String(i)}`, slotId: s.id }));
  const at = (_m: unknown, i: number) => ({ east: i * 2, north: 0 });

  it('builds units and soldiers from the template; ids come from the instance, not array positions', () => {
    const { units, soldiers } = instantiateOrganization(PATROL, instance(ALL), at);
    expect(units.map((u) => [u.id, u.echelon, u.parentId, u.leaderId])).toEqual([
      ['P/PTL', 'patrol', null, 'S0'],
      ['P/NORTH', 'group', 'P/PTL', 'S2'],
      ['P/SOUTH', 'group', 'P/PTL', null],
      ['P/REAR', 'element', 'P/SOUTH', 'S4'],
    ]);
    expect(soldiers.find((s) => s.id === 'S5')).toMatchObject({ unitId: 'P/REAR', azimuthDeg: 90 });
    // The same assignment listed in another order gives every soldier the same slot and unit.
    const reversed = instantiateOrganization(PATROL, instance([...ALL].reverse()), at);
    const unitOf = (list: ScenarioSoldier[]) =>
      Object.fromEntries(list.map((s) => [s.id, s.unitId]));
    expect(unitOf(reversed.soldiers)).toEqual(unitOf(soldiers));
    expect(reversed.units).toEqual(units);
  });

  it.each<[string, OrganizationInstance, RegExp]>([
    ['another template', { ...instance(ALL), templateId: 'other' }, /refers to template "other"/],
    [
      'another (e.g. an older) template version',
      { ...instance(ALL), templateVersion: '0.1.0' },
      /needs template version 0.1.0/,
    ],
    ['an unfilled slot', instance(ALL.slice(1)), /slots "lead" are not filled/],
    [
      'a slot filled twice',
      instance([...ALL, { soldierId: 'X', slotId: 'lead' }]),
      /"lead" is filled twice/,
    ],
    [
      'an unknown slot',
      instance([...ALL, { soldierId: 'X', slotId: 'nope' }]),
      /unknown slot "nope"/,
    ],
    [
      'a soldier in two slots',
      instance(ALL.map((m, i) => (i === 1 ? { ...m, soldierId: 'S0' } : m))),
      /"S0" fills two slots/,
    ],
  ])('refuses %s', (_label, bad, message) => {
    expect(() => instantiateOrganization(PATROL, bad, at)).toThrow(message);
  });
});
