import { describe, expect, it } from 'vitest';
import { createSyntheticTerrain, flatElevation, soldierId, type ScenarioSoldier } from '#sim';
import { deployInOrp, type AmbushScenario } from './ambush-scenario';
import { USMC_RIFLE_SQUAD_TEMPLATE } from './demo-scenario';
import { createExercise } from './exercise';
import {
  instantiateOrganization,
  OrganizationTemplateError,
  rosterMembers,
  rosterTree,
  validateOrganizationTemplate,
  type OrganizationInstance,
} from './organization';
import usmc from './organizations/usmc-rifle-squad-mcwp-3-11-2.json';
import patrol from './test-data/synthetic-patrol.template.json';

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
    expect(role('fireTeamLeader')?.weaponProfileRefs).toContain('m203-grenade-launcher');
    expect(role('automaticRifleman')?.weaponProfileRefs).toContain('squad-automatic-weapon');
  });

  it('gives every Marine the same standard individual symbol, whatever the role', () => {
    expect(new Set(template.roles.map((r) => r.symbology.sidc))).toEqual(
      new Set(['10032700001101010000']),
    );
  });

  it('is the JSON file, validated unchanged', () => {
    expect(template).toEqual(usmc);
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
      (t) => (t['schemaVersion'] = 2),
      /schemaVersion: 2 is not supported/,
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
      'a malformed symbol code',
      (t) => (item(t, 'roles', 0)['symbology'] = { sidc: 'SFGPUCI----' }),
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
      'another template version',
      { ...instance(ALL), templateVersion: '0.2.0' },
      /needs template version 0.2.0/,
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

describe('an exercise with the alternative organization', () => {
  it('runs from the ORP to readiness with no assumptions about size or fire teams', () => {
    const terrain = createSyntheticTerrain(
      { originX: -100, originY: -100, cellSize: 10, columns: 21, rows: 21 },
      flatElevation(0),
    );
    const orp = {
      id: 'ORP-P',
      name: 'ORP',
      centre: { east: 0, north: -60 },
      shape: { kind: 'ellipse', majorAxisM: 20, minorAxisM: 8, orientationDeg: 90 },
    } as const;
    const patrolForce = deployInOrp(
      PATROL,
      {
        templateId: PATROL.id,
        templateVersion: PATROL.version,
        side: 'BLUEFOR',
        unitIdPrefix: '',
        facingDeg: 0,
        posture: 'standing',
        members: PATROL.slots.map((s, i) => ({ soldierId: `P${String(i + 1)}`, slotId: s.id })),
      },
      orp,
      terrain,
    );
    const scenario: AmbushScenario = {
      id: 'patrol',
      terrain,
      movement: { speed: 2, maxTurnRate: Math.PI },
      units: [...patrolForce.units, { id: 'EN', echelon: 'team', parentId: null, leaderId: null }],
      soldiers: [
        ...patrolForce.soldiers,
        {
          id: 'E',
          side: 'OPFOR',
          unitId: 'EN',
          position: { x: 0, y: 80 },
          azimuthDeg: 180,
          posture: 'standing',
        },
      ],
      opforRoutes: [],
      orp,
      organization: patrolForce.organization,
    };
    const exercise = createExercise({ config: { tickRateHz: 10, seed: 1 }, scenario });
    expect(rosterMembers(exercise.roster)).toHaveLength(6);
    expect(exercise.roster.children.map((c) => c.unit.name)).toEqual([
      'North group',
      'South group',
    ]);
    // Only two of the six are given destinations; the others do not hold up readiness.
    exercise.setDestination(soldierId('P3'), { x: -20, y: 0 });
    exercise.setDestination(soldierId('P6'), { x: 20, y: 0 });
    expect(exercise.execute().ok).toBe(true);
    for (let i = 0; i < 600 && exercise.phase !== 'bluforReady'; i += 1) exercise.advance(0.1);
    expect(exercise.phase).toBe('bluforReady');
    expect(exercise.deploymentStatus(soldierId('P3'))).toBe('inPosition');
    expect(exercise.deploymentStatus(soldierId('P1'))).toBe('atOrp');
  });
});
