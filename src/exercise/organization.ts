import type { Posture, ScenarioSoldier, ScenarioUnit, Side } from '#sim';

// Organization templates (docs/adr/0012): versioned JSON describing an
// organization's structure (units, roles, slots), kept separate from the
// scenario instance that fills the slots with soldiers. Nothing here assumes a
// particular size or hierarchy; identities are always explicit ids, never
// positions in an array.

export const ORGANIZATION_TEMPLATE_SCHEMA = 'ambush.organization-template';
/**
 * 2: a role's loadout and icon are separate properties (`defaultLoadout`,
 * `defaultIcon`) that a slot may override, and individuals are drawn with
 * Ambush! icons instead of APP-6 codes (docs/adr/0013). Version 1 templates
 * are converted by `readOrganizationTemplate`.
 */
export const ORGANIZATION_TEMPLATE_SCHEMA_VERSION = 2;

/**
 * The individual soldier icons a role can be drawn with (docs/adr/0013): custom
 * Ambush! symbols, not APP-6. The 2D view draws one for each id.
 */
export const INDIVIDUAL_ICONS = [
  'squadLeader',
  'fireTeamLeader',
  'rifleman',
  'automaticRifleman',
  'grenadier',
  'marksman',
  'medic',
  'radioOperator',
] as const;
export type IndividualIcon = (typeof INDIVIDUAL_ICONS)[number];

/** Where a template's content comes from. */
export type TemplateSource =
  | {
      /** A published doctrinal source, identified exactly. */
      readonly kind: 'doctrine';
      readonly designation: string;
      readonly title: string;
      readonly publisher: string;
      /** Publication date, YYYY-MM-DD. */
      readonly date: string;
      readonly identifier?: string;
      readonly amendments?: readonly {
        readonly designation: string;
        readonly date: string;
        readonly summary: string;
      }[];
      /** Paragraphs, figures or tables the template is taken from. */
      readonly references: readonly string[];
      /** Currency of the source (e.g. superseded), stated plainly. */
      readonly status: string;
    }
  | {
      /** Made up for testing or development; represents no real organization. */
      readonly kind: 'synthetic';
      readonly title: string;
      readonly notes: string;
    };

/** Unit symbology: a 20-digit APP-6 D / MIL-STD-2525 D symbol identification code. */
export interface TemplateSymbology {
  readonly sidc: string;
}

/**
 * What a soldier carries: references to weapon and equipment profiles, which
 * are names for later phases, not modelled yet.
 */
export interface Loadout {
  readonly weaponProfileRefs: readonly string[];
}

/** A loadout of nothing, for soldiers whose role and slot name none. */
export const EMPTY_LOADOUT: Loadout = Object.freeze({ weaponProfileRefs: Object.freeze([]) });

/**
 * An organizational role: what a position in the organization is (its name,
 * abbreviation and grade). What its holders carry and how they are drawn are
 * separate properties (docs/adr/0013): the role only gives their defaults,
 * which a slot may override.
 */
export interface TemplateRole {
  readonly id: string;
  readonly name: string;
  readonly abbreviation: string;
  /** Grade or rank as the source states it, if it does. */
  readonly grade?: string;
  /** The loadout of the role's holders unless their slot gives one. */
  readonly defaultLoadout?: Loadout;
  /**
   * The map icon of the role's holders unless their slot gives one. Without
   * either, a holder is drawn as the plain circle of an unknown role.
   */
  readonly defaultIcon?: IndividualIcon;
}

export interface TemplateUnit {
  readonly id: string;
  readonly name: string;
  readonly abbreviation: string;
  /** A free echelon label (e.g. "squad"); the simulation attaches no meaning to it. */
  readonly echelon: string;
  readonly parentId: string | null;
  /** The slot whose holder leads this unit; must belong to this unit or a descendant. */
  readonly leaderSlotId: string | null;
  readonly symbology?: TemplateSymbology;
}

/** A position in the organization, filled by one soldier in a scenario. */
export interface TemplateSlot {
  readonly id: string;
  readonly unitId: string;
  readonly roleId: string;
  /** Short map and roster label (e.g. "1-AR"). */
  readonly label: string;
  /** This position's loadout, when it differs from its role's default. */
  readonly loadout?: Loadout;
  /** This position's map icon, when it differs from its role's default. */
  readonly icon?: IndividualIcon;
}

/** A slot's role, loadout and icon: three separate properties, resolved from the template. */
export interface ResolvedSlot {
  readonly role: TemplateRole;
  readonly loadout: Loadout;
  /** `null`: no icon is defined, so the holder is drawn as an unknown role. */
  readonly icon: IndividualIcon | null;
}

/** Resolves a slot of a validated template: the slot's own loadout and icon, else its role's. */
export function resolveSlot(template: OrganizationTemplate, slot: TemplateSlot): ResolvedSlot {
  const role = template.roles.find((r) => r.id === slot.roleId);
  if (!role) {
    throw new OrganizationTemplateError(
      `template "${template.id}": slot "${slot.id}" has unknown role "${slot.roleId}"`,
    );
  }
  return {
    role,
    loadout: slot.loadout ?? role.defaultLoadout ?? EMPTY_LOADOUT,
    icon: slot.icon ?? role.defaultIcon ?? null,
  };
}

export interface OrganizationTemplate {
  readonly schema: typeof ORGANIZATION_TEMPLATE_SCHEMA;
  readonly schemaVersion: typeof ORGANIZATION_TEMPLATE_SCHEMA_VERSION;
  readonly id: string;
  /** The template's own version (semantic versioning). */
  readonly version: string;
  readonly name: string;
  readonly source: TemplateSource;
  /** Ambush!-specific choices that are not taken from the source. */
  readonly conventions: readonly string[];
  readonly roles: readonly TemplateRole[];
  /** Exactly one root unit (`parentId: null`). Order is display order only. */
  readonly units: readonly TemplateUnit[];
  /** Order is display order within a unit only. */
  readonly slots: readonly TemplateSlot[];
}

export class OrganizationTemplateError extends Error {
  override name = 'OrganizationTemplateError';
}

const ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SIDC = /^\d{20}$/;

/**
 * Checks that `data` (e.g. parsed JSON) is a valid organization template and
 * returns it typed. Throws an `OrganizationTemplateError` naming the first
 * problem by its path. Unknown fields are refused so typos cannot pass silently.
 */
export function validateOrganizationTemplate(data: unknown): OrganizationTemplate {
  const fail = (path: string, message: string): never => {
    throw new OrganizationTemplateError(`organization template ${path}: ${message}`);
  };
  const object = (value: unknown, path: string, required: string[], optional: string[] = []) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(path, 'must be an object');
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!required.includes(key) && !optional.includes(key))
        fail(`${path}.${key}`, 'is not a known field');
    }
    for (const key of required) if (!(key in record)) fail(`${path}.${key}`, 'is missing');
    return record;
  };
  const text = (value: unknown, path: string, pattern?: RegExp): string => {
    if (typeof value !== 'string' || value.trim() === '')
      return fail(path, 'must be a non-empty string');
    if (pattern && !pattern.test(value)) fail(path, `"${value}" has the wrong format`);
    return value;
  };
  const list = (value: unknown, path: string, nonEmpty = true): unknown[] => {
    if (!Array.isArray(value)) return fail(path, 'must be an array');
    if (nonEmpty && value.length === 0) fail(path, 'must not be empty');
    return value as unknown[];
  };
  const symbology = (value: unknown, path: string) => {
    const s = object(value, path, ['sidc']);
    text(s['sidc'], `${path}.sidc`, SIDC);
  };
  const icon = (value: unknown, path: string) => {
    const id = text(value, path);
    if (!(INDIVIDUAL_ICONS as readonly string[]).includes(id)) {
      fail(path, `"${id}" is not one of ${INDIVIDUAL_ICONS.join(', ')}`);
    }
  };
  const loadout = (value: unknown, path: string) => {
    const l = object(value, path, ['weaponProfileRefs']);
    list(l['weaponProfileRefs'], `${path}.weaponProfileRefs`, false).forEach((r, k) => {
      text(r, `${path}.weaponProfileRefs[${String(k)}]`, ID);
    });
  };
  const unique = (ids: string[], path: string) => {
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (seen.has(id)) fail(`${path}[${String(i)}].id`, `repeats id "${id}"`);
      seen.add(id);
    });
  };

  const root = object(data, '$', [
    'schema',
    'schemaVersion',
    'id',
    'version',
    'name',
    'source',
    'conventions',
    'roles',
    'units',
    'slots',
  ]);
  if (root['schema'] !== ORGANIZATION_TEMPLATE_SCHEMA) {
    fail('$.schema', `must be "${ORGANIZATION_TEMPLATE_SCHEMA}"`);
  }
  if (root['schemaVersion'] !== ORGANIZATION_TEMPLATE_SCHEMA_VERSION) {
    fail(
      '$.schemaVersion',
      `${JSON.stringify(root['schemaVersion'])} is not supported (expected ${String(ORGANIZATION_TEMPLATE_SCHEMA_VERSION)}; readOrganizationTemplate converts version 1)`,
    );
  }
  text(root['id'], '$.id', ID);
  text(root['version'], '$.version', SEMVER);
  text(root['name'], '$.name');

  const source = object(
    root['source'],
    '$.source',
    ['kind', 'title'],
    [
      'designation',
      'publisher',
      'date',
      'identifier',
      'amendments',
      'references',
      'status',
      'notes',
    ],
  );
  text(source['title'], '$.source.title');
  if (source['kind'] === 'doctrine') {
    object(
      source,
      '$.source',
      ['kind', 'title', 'designation', 'publisher', 'date', 'references', 'status'],
      ['identifier', 'amendments'],
    );
    text(source['designation'], '$.source.designation');
    text(source['publisher'], '$.source.publisher');
    text(source['date'], '$.source.date', DATE);
    text(source['status'], '$.source.status');
    if (source['identifier'] !== undefined) text(source['identifier'], '$.source.identifier');
    list(source['references'], '$.source.references').forEach((r, i) => {
      text(r, `$.source.references[${String(i)}]`);
    });
    if (source['amendments'] !== undefined) {
      list(source['amendments'], '$.source.amendments', false).forEach((a, i) => {
        const path = `$.source.amendments[${String(i)}]`;
        const amendment = object(a, path, ['designation', 'date', 'summary']);
        text(amendment['designation'], `${path}.designation`);
        text(amendment['date'], `${path}.date`, DATE);
        text(amendment['summary'], `${path}.summary`);
      });
    }
  } else if (source['kind'] === 'synthetic') {
    object(source, '$.source', ['kind', 'title', 'notes']);
    text(source['notes'], '$.source.notes');
  } else {
    fail('$.source.kind', 'must be "doctrine" or "synthetic"');
  }
  list(root['conventions'], '$.conventions', false).forEach((c, i) => {
    text(c, `$.conventions[${String(i)}]`);
  });

  const roles = list(root['roles'], '$.roles').map((value, i) => {
    const path = `$.roles[${String(i)}]`;
    const role = object(
      value,
      path,
      ['id', 'name', 'abbreviation'],
      ['grade', 'defaultLoadout', 'defaultIcon'],
    );
    const id = text(role['id'], `${path}.id`, ID);
    text(role['name'], `${path}.name`);
    text(role['abbreviation'], `${path}.abbreviation`);
    if (role['grade'] !== undefined) text(role['grade'], `${path}.grade`);
    if (role['defaultLoadout'] !== undefined)
      loadout(role['defaultLoadout'], `${path}.defaultLoadout`);
    if (role['defaultIcon'] !== undefined) icon(role['defaultIcon'], `${path}.defaultIcon`);
    return id;
  });
  unique(roles, '$.roles');

  const units = list(root['units'], '$.units').map((value, i) => {
    const path = `$.units[${String(i)}]`;
    const unit = object(
      value,
      path,
      ['id', 'name', 'abbreviation', 'echelon', 'parentId', 'leaderSlotId'],
      ['symbology'],
    );
    const id = text(unit['id'], `${path}.id`, ID);
    text(unit['name'], `${path}.name`);
    text(unit['abbreviation'], `${path}.abbreviation`);
    text(unit['echelon'], `${path}.echelon`, ID);
    const parentId = unit['parentId'] === null ? null : text(unit['parentId'], `${path}.parentId`);
    const leaderSlotId =
      unit['leaderSlotId'] === null ? null : text(unit['leaderSlotId'], `${path}.leaderSlotId`);
    if (unit['symbology'] !== undefined) symbology(unit['symbology'], `${path}.symbology`);
    return { id, parentId, leaderSlotId, path };
  });
  unique(
    units.map((u) => u.id),
    '$.units',
  );
  const unitIds = new Set(units.map((u) => u.id));
  const parentOf = new Map(units.map((u) => [u.id, u.parentId]));
  const roots = units.filter((u) => u.parentId === null);
  if (roots.length !== 1) {
    fail(
      '$.units',
      `must have exactly one root unit (parentId null), found ${String(roots.length)}`,
    );
  }
  for (const unit of units) {
    if (unit.parentId !== null && !unitIds.has(unit.parentId)) {
      fail(`${unit.path}.parentId`, `refers to unknown unit "${unit.parentId}"`);
    }
    const seen = new Set([unit.id]);
    for (let p = unit.parentId; p !== null; p = parentOf.get(p) ?? null) {
      if (seen.has(p)) fail(`${unit.path}.parentId`, 'forms a cycle');
      seen.add(p);
    }
  }
  /** Whether `unitId` is `ancestorId` or lies below it. */
  const within = (unitId: string, ancestorId: string) => {
    for (let u: string | null = unitId; u !== null; u = parentOf.get(u) ?? null) {
      if (u === ancestorId) return true;
    }
    return false;
  };

  const roleIds = new Set(roles);
  const slots = list(root['slots'], '$.slots').map((value, i) => {
    const path = `$.slots[${String(i)}]`;
    const slot = object(value, path, ['id', 'unitId', 'roleId', 'label'], ['loadout', 'icon']);
    const id = text(slot['id'], `${path}.id`, ID);
    const unitId = text(slot['unitId'], `${path}.unitId`);
    const roleId = text(slot['roleId'], `${path}.roleId`);
    const label = text(slot['label'], `${path}.label`);
    if (!unitIds.has(unitId)) fail(`${path}.unitId`, `refers to unknown unit "${unitId}"`);
    if (!roleIds.has(roleId)) fail(`${path}.roleId`, `refers to unknown role "${roleId}"`);
    if (slot['loadout'] !== undefined) loadout(slot['loadout'], `${path}.loadout`);
    if (slot['icon'] !== undefined) icon(slot['icon'], `${path}.icon`);
    return { id, unitId, label };
  });
  unique(
    slots.map((s) => s.id),
    '$.slots',
  );
  const labels = new Set<string>();
  slots.forEach((s, i) => {
    if (labels.has(s.label)) fail(`$.slots[${String(i)}].label`, `repeats label "${s.label}"`);
    labels.add(s.label);
  });
  const slotUnit = new Map(slots.map((s) => [s.id, s.unitId]));
  for (const unit of units) {
    if (!slots.some((s) => within(s.unitId, unit.id))) {
      fail(unit.path, `unit "${unit.id}" has no slots, directly or below it`);
    }
    if (unit.leaderSlotId === null) continue;
    const leaderUnit = slotUnit.get(unit.leaderSlotId);
    if (leaderUnit === undefined) {
      fail(`${unit.path}.leaderSlotId`, `refers to unknown slot "${unit.leaderSlotId}"`);
    } else if (!within(leaderUnit, unit.id)) {
      fail(
        `${unit.path}.leaderSlotId`,
        `slot "${unit.leaderSlotId}" is not part of unit "${unit.id}"`,
      );
    }
  }
  return data as OrganizationTemplate;
}

/** A template read from data, and how it was converted to the current schema version. */
export interface ReadTemplate {
  readonly template: OrganizationTemplate;
  /** The schema version the data had, when it was converted; `null` when it was current. */
  readonly migratedFrom: number | null;
  /** What the conversion did, for whoever maintains the template; empty when nothing changed. */
  readonly notes: readonly string[];
}

/**
 * Converts template data from an older schema version to the current one,
 * without validating it. Data in the current version, or that is not a
 * template at all, is returned unchanged for validation to judge.
 *
 * Version 1 → 2 (docs/adr/0013):
 * - a role's `weaponProfileRefs` become its `defaultLoadout`;
 * - a role's APP-6 `symbology` code is dropped. It cannot name a role icon
 *   (version 1 templates gave every role the same individual code), so the
 *   converted role has no `defaultIcon` and its holders are drawn as the plain
 *   circle of an unknown role until one is added. Nothing is guessed.
 * - units, slots and everything else are unchanged; so is the template's own `version`.
 */
export function migrateOrganizationTemplate(data: unknown): {
  readonly data: unknown;
  readonly migratedFrom: number | null;
  readonly notes: readonly string[];
} {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (
    !isRecord(data) ||
    data['schema'] !== ORGANIZATION_TEMPLATE_SCHEMA ||
    data['schemaVersion'] !== 1
  ) {
    return { data, migratedFrom: null, notes: [] };
  }
  const notes: string[] = [];
  const roles = Array.isArray(data['roles'])
    ? (data['roles'] as unknown[]).map((role) => {
        if (!isRecord(role)) return role;
        const { weaponProfileRefs, symbology, ...rest } = role;
        const id = typeof rest['id'] === 'string' ? rest['id'] : '?';
        if (weaponProfileRefs !== undefined) {
          notes.push(`role "${id}": weaponProfileRefs moved to defaultLoadout`);
        }
        if (symbology !== undefined) {
          const sidc = isRecord(symbology) ? JSON.stringify(symbology['sidc']) : 'symbology';
          notes.push(
            `role "${id}": APP-6 code ${sidc} dropped; it names no role icon, so the role has no defaultIcon and is drawn as an unknown role until one is added`,
          );
        }
        return {
          ...rest,
          ...(weaponProfileRefs === undefined ? {} : { defaultLoadout: { weaponProfileRefs } }),
        };
      })
    : data['roles'];
  return {
    data: { ...data, schemaVersion: ORGANIZATION_TEMPLATE_SCHEMA_VERSION, roles },
    migratedFrom: 1,
    notes,
  };
}

/**
 * Reads template data of any supported schema version: converts it to the
 * current version (`migrateOrganizationTemplate`), then validates it
 * (`validateOrganizationTemplate`). Throws an `OrganizationTemplateError` when
 * the result is not a valid template.
 */
export function readOrganizationTemplate(data: unknown): ReadTemplate {
  const migrated = migrateOrganizationTemplate(data);
  return {
    template: validateOrganizationTemplate(migrated.data),
    migratedFrom: migrated.migratedFrom,
    notes: migrated.notes,
  };
}

/** One soldier of a scenario filling one template slot. */
export interface OrganizationMember {
  readonly soldierId: string;
  readonly slotId: string;
  /** Starting position (map metres east, north); as `startOf` lays it out when omitted. */
  readonly start?: { readonly east: number; readonly north: number };
  /** Starting facing, degrees clockwise from grid north; the instance default when omitted. */
  readonly facingDeg?: number;
}

/**
 * A scenario's use of a template: which soldier fills which slot, and where
 * the organization's units appear in the simulation. Refers to the template by
 * id and version, which must match the template supplied.
 */
export interface OrganizationInstance {
  readonly templateId: string;
  readonly templateVersion: string;
  readonly side: Side;
  /** Prefixed to every template unit id to form simulation unit ids (may be empty). */
  readonly unitIdPrefix: string;
  /** Default starting facing, degrees clockwise from grid north. */
  readonly facingDeg: number;
  readonly posture: Posture;
  /** Exactly one member per template slot. */
  readonly members: readonly OrganizationMember[];
}

/** An organization as its users see it: template plus who holds each slot. */
export interface TraineeOrganization {
  readonly template: OrganizationTemplate;
  readonly unitIdPrefix: string;
  readonly members: readonly { readonly soldierId: string; readonly slotId: string }[];
}

/**
 * Builds the simulation units and soldiers for an instance of a template.
 * `startOf` gives each member's starting position (`member.start` when set).
 * Throws an `OrganizationTemplateError` when the instance does not match the template.
 */
export function instantiateOrganization(
  template: OrganizationTemplate,
  instance: OrganizationInstance,
  startOf: (member: OrganizationMember, index: number) => { east: number; north: number },
): { units: ScenarioUnit[]; soldiers: ScenarioSoldier[]; organization: TraineeOrganization } {
  const fail = (message: string): never => {
    throw new OrganizationTemplateError(`organization instance of "${template.id}": ${message}`);
  };
  if (instance.templateId !== template.id) {
    fail(`refers to template "${instance.templateId}"`);
  }
  if (instance.templateVersion !== template.version) {
    fail(`needs template version ${instance.templateVersion}, got ${template.version}`);
  }
  const slotIds = new Set(template.slots.map((s) => s.id));
  const filled = new Set<string>();
  const soldierIds = new Set<string>();
  for (const member of instance.members) {
    if (!slotIds.has(member.slotId))
      fail(`soldier "${member.soldierId}" fills unknown slot "${member.slotId}"`);
    if (filled.has(member.slotId)) fail(`slot "${member.slotId}" is filled twice`);
    if (soldierIds.has(member.soldierId)) fail(`soldier "${member.soldierId}" fills two slots`);
    filled.add(member.slotId);
    soldierIds.add(member.soldierId);
  }
  const vacant = template.slots.filter((s) => !filled.has(s.id)).map((s) => s.id);
  if (vacant.length > 0) fail(`slots ${vacant.map((s) => `"${s}"`).join(', ')} are not filled`);

  const holder = new Map(instance.members.map((m) => [m.slotId, m.soldierId]));
  const unitId = (id: string) => `${instance.unitIdPrefix}${id}`;
  const slotsById = new Map(template.slots.map((s) => [s.id, s]));
  const units: ScenarioUnit[] = template.units.map((u) => ({
    id: unitId(u.id),
    echelon: u.echelon,
    parentId: u.parentId === null ? null : unitId(u.parentId),
    leaderId: u.leaderSlotId === null ? null : (holder.get(u.leaderSlotId) ?? null),
  }));
  const soldiers: ScenarioSoldier[] = instance.members.map((member, i) => {
    const start = startOf(member, i);
    return {
      id: member.soldierId,
      side: instance.side,
      unitId: unitId(slotsById.get(member.slotId)?.unitId ?? ''),
      position: { x: start.east, y: start.north },
      azimuthDeg: member.facingDeg ?? instance.facingDeg,
      posture: instance.posture,
    };
  });
  return {
    units,
    soldiers,
    organization: {
      template,
      unitIdPrefix: instance.unitIdPrefix,
      members: instance.members.map(({ soldierId, slotId }) => ({ soldierId, slotId })),
    },
  };
}

/** A unit of the roster tree: the unit, its own members, then its child units. */
export interface RosterUnit {
  readonly unit: TemplateUnit;
  /** The simulation's id for this unit. */
  readonly simUnitId: string;
  readonly members: readonly RosterMember[];
  readonly children: readonly RosterUnit[];
}

/** A soldier in the roster: the slot it fills, and that slot's resolved role, loadout and icon. */
export interface RosterMember extends ResolvedSlot {
  readonly soldierId: string;
  readonly slot: TemplateSlot;
  /** Whether this soldier leads `RosterUnit.unit`. */
  readonly leads: boolean;
}

/**
 * The organization as a tree for display, in template order: each unit with
 * the soldiers holding its slots, then its child units.
 */
export function rosterTree(organization: TraineeOrganization): RosterUnit {
  const { template } = organization;
  const holder = new Map(organization.members.map((m) => [m.slotId, m.soldierId]));
  const build = (unit: TemplateUnit): RosterUnit => ({
    unit,
    simUnitId: `${organization.unitIdPrefix}${unit.id}`,
    members: template.slots
      .filter((s) => s.unitId === unit.id)
      .flatMap((slot) => {
        const soldierId = holder.get(slot.id);
        return soldierId === undefined
          ? []
          : [
              {
                soldierId,
                slot,
                ...resolveSlot(template, slot),
                leads: unit.leaderSlotId === slot.id,
              },
            ];
      }),
    children: template.units.filter((u) => u.parentId === unit.id).map(build),
  });
  const root = template.units.find((u) => u.parentId === null);
  if (!root) throw new OrganizationTemplateError(`template "${template.id}" has no root unit`);
  return build(root);
}

/** Every member of the roster tree, depth first in display order. */
export function rosterMembers(tree: RosterUnit): RosterMember[] {
  return [...tree.members, ...tree.children.flatMap(rosterMembers)];
}
