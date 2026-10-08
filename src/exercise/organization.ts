import type { Posture, ScenarioSoldier, ScenarioUnit, Side } from '#sim';

// Organization templates (docs/adr/0012): versioned JSON describing an
// organization's structure (units, roles, slots), kept separate from the
// scenario instance that fills the slots with soldiers. Nothing here assumes a
// particular size or hierarchy; identities are always explicit ids, never
// positions in an array.

export const ORGANIZATION_TEMPLATE_SCHEMA = 'ambush.organization-template';
export const ORGANIZATION_TEMPLATE_SCHEMA_VERSION = 1;

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

/** Symbology metadata: a 20-digit APP-6 D / MIL-STD-2525 D symbol identification code. */
export interface TemplateSymbology {
  readonly sidc: string;
}

export interface TemplateRole {
  readonly id: string;
  readonly name: string;
  readonly abbreviation: string;
  /** Grade or rank as the source states it, if it does. */
  readonly grade?: string;
  /** References to weapon or equipment profiles; not resolved or modelled yet. */
  readonly weaponProfileRefs?: readonly string[];
  readonly symbology: TemplateSymbology;
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
      `${JSON.stringify(root['schemaVersion'])} is not supported (expected ${String(ORGANIZATION_TEMPLATE_SCHEMA_VERSION)})`,
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
      ['id', 'name', 'abbreviation', 'symbology'],
      ['grade', 'weaponProfileRefs'],
    );
    const id = text(role['id'], `${path}.id`, ID);
    text(role['name'], `${path}.name`);
    text(role['abbreviation'], `${path}.abbreviation`);
    if (role['grade'] !== undefined) text(role['grade'], `${path}.grade`);
    if (role['weaponProfileRefs'] !== undefined) {
      list(role['weaponProfileRefs'], `${path}.weaponProfileRefs`, false).forEach((r, k) => {
        text(r, `${path}.weaponProfileRefs[${String(k)}]`, ID);
      });
    }
    symbology(role['symbology'], `${path}.symbology`);
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
    const slot = object(value, path, ['id', 'unitId', 'roleId', 'label']);
    const id = text(slot['id'], `${path}.id`, ID);
    const unitId = text(slot['unitId'], `${path}.unitId`);
    const roleId = text(slot['roleId'], `${path}.roleId`);
    const label = text(slot['label'], `${path}.label`);
    if (!unitIds.has(unitId)) fail(`${path}.unitId`, `refers to unknown unit "${unitId}"`);
    if (!roleIds.has(roleId)) fail(`${path}.roleId`, `refers to unknown role "${roleId}"`);
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

/** One soldier of a scenario filling one template slot. */
export interface OrganizationMember {
  readonly soldierId: string;
  readonly slotId: string;
  /** Starting position (map metres east, north); laid out in the ORP when omitted. */
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

/** The trainee's organization as an exercise sees it: template plus who holds each slot. */
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

export interface RosterMember {
  readonly soldierId: string;
  readonly slot: TemplateSlot;
  readonly role: TemplateRole;
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
  const roles = new Map(template.roles.map((r) => [r.id, r]));
  const build = (unit: TemplateUnit): RosterUnit => ({
    unit,
    simUnitId: `${organization.unitIdPrefix}${unit.id}`,
    members: template.slots
      .filter((s) => s.unitId === unit.id)
      .flatMap((slot) => {
        const soldierId = holder.get(slot.id);
        const role = roles.get(slot.roleId);
        return soldierId === undefined || !role
          ? []
          : [{ soldierId, slot, role, leads: unit.leaderSlotId === slot.id }];
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
