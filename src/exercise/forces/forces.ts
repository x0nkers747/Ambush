import {
  flattenFormation,
  orgUnitId,
  smoothNoise,
  validateFofConfig,
  type FofConfig,
  type FormationNode,
  type FormationSpec,
  type ScenarioSoldier,
  type ScenarioUnit,
  type Side,
  type Vec2,
} from '#sim';
import {
  buildFormationSpec,
  formationsFor,
  type FormationTemplate,
} from '../formations/formations';
import {
  instantiateOrganization,
  validateOrganizationTemplate,
  type OrganizationTemplate,
  type TemplateSlot,
  type TraineeOrganization,
} from '../organization';
import elementTemplate from '../organizations/three-marine-element.json';
import fireTeamTemplate from '../organizations/usmc-fire-team-mcwp-3-11-2.json';
import { USMC_RIFLE_SQUAD_TEMPLATE } from '../squad';
import defaultConfig from './fof-v2.json';

// Forces (docs/constructive-simulation/01): the organizations a force can
// be, and how one is built into units and soldiers loosely in formation,
// with its weapons, for the force-on-force model. Shared by battles and the
// labs, which keep their own pages and runs.

export type SquadOrganization = 'element3' | 'fireTeam' | 'squad';

export const SQUAD_ORGANIZATIONS: Readonly<Record<SquadOrganization, OrganizationTemplate>> = {
  element3: validateOrganizationTemplate(elementTemplate),
  fireTeam: validateOrganizationTemplate(fireTeamTemplate),
  squad: USMC_RIFLE_SQUAD_TEMPLATE,
};

/** The default experimental configuration (validated). */
export const FOF_DEFAULT_CONFIG: FofConfig = validateFofConfig(defaultConfig);

/** The formations an organization can take. */
export function formationsForOrganization(
  organization: SquadOrganization,
): readonly FormationTemplate[] {
  const template = SQUAD_ORGANIZATIONS[organization];
  const echelon = template.units.find((u) => u.parentId === null)?.echelon ?? '';
  return formationsFor(echelon, template.slots.length);
}

/**
 * The formation an organization assaults in: its extended line (a squad's
 * line, a fire team's skirmishers), or `null` when it has none.
 */
export function assaultFormationId(organization: SquadOrganization): string | null {
  return (
    formationsForOrganization(organization).find((f) => /\.line$|skirmishers/.test(f.id))?.id ??
    null
  );
}

/**
 * The formation an organization follows a road in: its column (a squad's
 * teams one behind another; a fire team's), else its file; `null` when it has
 * neither.
 */
export function roadFormationId(organization: SquadOrganization): string | null {
  const formations = formationsForOrganization(organization);
  return (
    formations.find((f) => f.id.endsWith('.column'))?.id ??
    formations.find((f) => f.id.endsWith('.file'))?.id ??
    null
  );
}

/** The simulation weapon category of a slot (from its primary weapon), or `null`. */
export function weaponCategory(template: OrganizationTemplate, slot: TemplateSlot): string | null {
  const role = template.roles.find((r) => r.id === slot.roleId);
  const refs = (slot.loadout ?? role?.defaultLoadout)?.weaponProfileRefs ?? [];
  if (refs.includes('squad-automatic-weapon')) return 'automaticRifle';
  if (refs.some((r) => r.includes('rifle'))) return 'rifle';
  return null;
}

/** The simulation weapon of a slot's second weapon (an underslung grenade launcher), or `null`. */
export function secondaryWeaponCategory(
  template: OrganizationTemplate,
  slot: TemplateSlot,
): string | null {
  const role = template.roles.find((r) => r.id === slot.roleId);
  const refs = (slot.loadout ?? role?.defaultLoadout)?.weaponProfileRefs ?? [];
  return refs.includes('m203-grenade-launcher') ? 'grenadeLauncher' : null;
}

/** A force as built: its side, organization, ids, formation and weapons. */
export interface SquadForce {
  readonly side: Side;
  readonly unitId: string;
  readonly organization: TraineeOrganization;
  readonly formation: FormationSpec;
  readonly soldierIds: readonly string[];
  /** The formation it assaults in (an extended line), when its organization has one. */
  readonly assaultFormation: FormationSpec | null;
  /** The formation it follows a road in (`roadFormationId`), or `null`. */
  readonly roadFormation: FormationSpec | null;
  /** Weapon category (simulation) and model (display) of each soldier. */
  readonly weapons: Readonly<Record<string, string | null>>;
  /** The second weapon (simulation) each soldier carries, if any (a grenade launcher). */
  readonly secondaryWeapons: Readonly<Record<string, string | null>>;
  readonly displayWeapons: Readonly<Record<string, string | null>>;
}

/** How a force's organization stands at the start. */
export interface ForceLayout {
  readonly organization: SquadOrganization;
  /** Formation template id. */
  readonly formation: string;
  /** Its centre at the start. */
  readonly start: Vec2;
  /** Individual interval and element spacing (m). */
  readonly interval: number;
  readonly elementSpacing: number;
  /** Start in this posture (default standing). */
  readonly posture?: 'standing' | 'kneeling' | 'prone';
  /** How many of the organization (default 1): copies under one parent unit. */
  readonly count?: number;
  /** The spacing of copies (default 60 m). */
  readonly groupSpacingM?: number;
}

/** How a force's organization is laid out and named. */
export interface ForceInstance {
  readonly side: Side;
  /** Organization, formation, spacing, pace, posture, start and (`count`) copies. */
  readonly spec: ForceLayout;
  readonly seed: number;
  /** Its facing (azimuth, radians): the formation is laid out facing it. */
  readonly heading: number;
  /** Varies the small seeded jitter of the start positions between forces. */
  readonly salt: number;
  /** The parent unit of copies (`count` > 1). */
  readonly groupId: string;
  readonly unitIdPrefix: (copy: number, grouped: boolean) => string;
  readonly soldierId: (copy: number, slot: number, grouped: boolean) => string;
}

/**
 * A force's units, soldiers (loosely in formation round its start, facing
 * `heading`), formation and weapons: one organization, or
 * several copies under one parent unit.
 */
export function instantiateForce(o: ForceInstance): {
  force: SquadForce;
  units: ScenarioUnit[];
  soldiers: ScenarioSoldier[];
} {
  const { side, spec, seed } = o;
  const template = SQUAD_ORGANIZATIONS[spec.organization];
  const root = template.units.find((u) => u.parentId === null)?.id ?? '';
  const count = Math.max(1, Math.floor(spec.count ?? 1));
  const grouped = count > 1;
  const groupId = o.groupId;
  const copies = Array.from({ length: count }, (_, k) => {
    const unitIdPrefix = o.unitIdPrefix(k, grouped);
    const members = template.slots.map((slot, i) => ({
      soldierId: o.soldierId(k, i, grouped),
      slotId: slot.id,
    }));
    const organization: TraineeOrganization = { template, unitIdPrefix, members };
    const formation = buildFormationSpec(organization, root, spec.formation, {
      interval: spec.interval,
      elementSpacing: spec.elementSpacing,
    });
    const line = assaultFormationId(spec.organization);
    const assault =
      line === null
        ? null
        : buildFormationSpec(organization, root, line, {
            interval: spec.interval,
            elementSpacing: spec.elementSpacing,
          });
    const column = roadFormationId(spec.organization);
    const road =
      column === null
        ? null
        : buildFormationSpec(organization, root, column, {
            interval: spec.interval,
            elementSpacing: spec.elementSpacing,
          });
    return { unitIdPrefix, members, organization, formation, assault, road };
  });
  const first = copies[0];
  if (!first) throw new Error('force-on-force force needs an organization');
  // Copies in a block, abreast and in depth, centred on the start.
  const across = Math.ceil(Math.sqrt(count));
  const deep = Math.ceil(count / across);
  const spacing = spec.groupSpacingM ?? 60;
  const formation: FormationSpec = grouped
    ? {
        interval: first.formation.interval,
        root: {
          unitId: orgUnitId(groupId),
          back: 0,
          right: 0,
          slots: [],
          children: copies.map((c, k) => ({
            ...renameSlots(c.formation.root, `${String(k + 1)}.`),
            back: (Math.floor(k / across) - (deep - 1) / 2) * spacing,
            right: ((k % across) - (across - 1) / 2) * spacing,
          })),
        },
      }
    : first.formation;
  const unitId = grouped ? groupId : `${first.unitIdPrefix}${root}`;
  const heading = o.heading;
  const flat = flattenFormation(formation);
  const meanBack = flat.back.reduce((a, b) => a + b, 0) / flat.back.length;
  const meanRight = flat.right.reduce((a, b) => a + b, 0) / flat.right.length;
  const fx = Math.sin(heading);
  const fy = Math.cos(heading);
  const startOf = (member: { soldierId: string }) => {
    const i = flat.soldierIds.indexOf(member.soldierId);
    const jitter = Math.min(2, 0.15 * spec.interval);
    const salt = o.salt;
    const jx = smoothNoise(seed, i + salt, 2, 0.5, 1) * jitter;
    const jy = smoothNoise(seed, i + salt, 3, 0.5, 1) * jitter;
    const r = (flat.right[i] ?? 0) - meanRight;
    const b = (flat.back[i] ?? 0) - meanBack;
    // Right is (fy, −fx) of forward (fx, fy).
    return {
      east: spec.start.x + r * fy - b * fx + jx,
      north: spec.start.y - r * fx - b * fy + jy,
    };
  };
  const units: ScenarioUnit[] = grouped
    ? [{ id: groupId, echelon: 'group', parentId: null, leaderId: null }]
    : [];
  const soldiers: ScenarioSoldier[] = [];
  const weapons: Record<string, string | null> = {};
  const secondaryWeapons: Record<string, string | null> = {};
  const displayWeapons: Record<string, string | null> = {};
  for (const copy of copies) {
    const instance = {
      templateId: template.id,
      templateVersion: template.version,
      side,
      unitIdPrefix: copy.unitIdPrefix,
      facingDeg: (heading * 180) / Math.PI,
      posture: spec.posture ?? ('standing' as const),
      members: copy.members,
    };
    const built = instantiateOrganization(template, instance, startOf);
    for (const u of built.units) {
      units.push(grouped && u.parentId === null ? { ...u, parentId: groupId } : u);
    }
    soldiers.push(...built.soldiers);
    for (const m of copy.members) {
      const slot = template.slots.find((x) => x.id === m.slotId);
      const category = slot ? weaponCategory(template, slot) : null;
      weapons[m.soldierId] = category;
      secondaryWeapons[m.soldierId] =
        slot && category !== null ? secondaryWeaponCategory(template, slot) : null;
      displayWeapons[m.soldierId] =
        category === null
          ? null
          : side === 'OPFOR'
            ? 'ak-assault-rifle'
            : category === 'automaticRifle'
              ? 'squad-automatic-weapon'
              : 'm16-rifle';
    }
  }
  const force: SquadForce = {
    side,
    unitId,
    organization: first.organization,
    formation,
    assaultFormation: grouped ? null : first.assault,
    roadFormation: grouped ? null : first.road,
    soldierIds: copies.flatMap((c) => c.members.map((m) => m.soldierId)),
    weapons,
    secondaryWeapons,
    displayWeapons,
  };
  return { force, units, soldiers };
}

function renameSlots(node: FormationNode, prefix: string): FormationNode {
  return {
    ...node,
    slots: node.slots.map((slot) => ({ ...slot, id: `${prefix}${slot.id}` })),
    children: node.children.map((child) => renameSlots(child, prefix)),
  };
}
