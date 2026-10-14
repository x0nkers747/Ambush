import {
  orgUnitId,
  soldierId,
  type FormationNode,
  type FormationSlot,
  type FormationSpec,
} from '#sim';
import { rosterTree, type RosterUnit, type TraineeOrganization } from '../organization';
import templateData from './templates.json';

// Movement formations (docs/behavior-lab/03 §6): doctrinal templates (data,
// `templates.json`) that place roles and child units, and the builder that
// turns a template and an organization's roster into the simulation's
// `FormationSpec` (metres and soldier ids; no roles).

/** A slot of a template: who may hold it, and where (see `templates.json` for units). */
export interface TemplateSlotPlace {
  readonly roles: readonly string[];
  readonly forward: number;
  readonly right: number;
}

/** Where a child unit goes, and in which formation. */
export interface TemplateElement {
  readonly forward: number;
  readonly right: number;
  readonly formation: string;
}

export interface FormationTemplate {
  readonly id: string;
  readonly name: string;
  /** The echelon of the units it is for (organization template `echelon`). */
  readonly echelon: string;
  /** For units of exactly this many members, when given. */
  readonly members?: number;
  /** The doctrinal figure or text it follows. */
  readonly doctrine: string;
  /** Mirrored when placed left of its parent's reference line (default true). */
  readonly mirror?: boolean;
  readonly slots: readonly TemplateSlotPlace[];
  readonly elements?: readonly TemplateElement[];
}

export class FormationTemplateError extends Error {
  override name = 'FormationTemplateError';
}

/** Checks the template file and returns its templates. */
export function validateFormationTemplates(data: unknown): readonly FormationTemplate[] {
  const fail = (message: string): never => {
    throw new FormationTemplateError(`formation templates: ${message}`);
  };
  const file = data as { schema?: unknown; schemaVersion?: unknown; templates?: unknown };
  if (file.schema !== 'ambush.formation-templates' || file.schemaVersion !== 1) {
    fail('unknown schema or version');
  }
  if (!Array.isArray(file.templates)) return fail('templates must be an array');
  const templates = file.templates as FormationTemplate[];
  const ids = new Set<string>();
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  for (const t of templates) {
    if (typeof t.id !== 'string' || ids.has(t.id)) fail(`duplicate or missing id "${t.id}"`);
    ids.add(t.id);
    for (const s of t.slots) {
      if (!Array.isArray(s.roles) || s.roles.length === 0) fail(`${t.id}: a slot lists no roles`);
      if (!finite(s.forward) || !finite(s.right)) fail(`${t.id}: slot offsets must be finite`);
    }
    for (const e of t.elements ?? []) {
      if (!finite(e.forward) || !finite(e.right)) fail(`${t.id}: element offsets must be finite`);
    }
  }
  for (const t of templates) {
    for (const e of t.elements ?? []) {
      if (!ids.has(e.formation)) fail(`${t.id}: unknown element formation "${e.formation}"`);
    }
  }
  return Object.freeze(templates);
}

/** The built-in movement formations. */
export const FORMATION_TEMPLATES = validateFormationTemplates(templateData);

export function formationTemplate(id: string): FormationTemplate {
  const t = FORMATION_TEMPLATES.find((f) => f.id === id);
  if (!t) throw new FormationTemplateError(`unknown formation "${id}"`);
  return t;
}

/** The formations a unit of `echelon` with `members` members (its own and its children's) can take. */
export function formationsFor(echelon: string, members: number): FormationTemplate[] {
  return FORMATION_TEMPLATES.filter(
    (t) => t.echelon === echelon && (t.members === undefined || t.members === members),
  );
}

export interface FormationOptions {
  /** Individual interval (m); default 10. */
  readonly interval?: number;
  /** Element spacing (m); default 2 × interval. */
  readonly elementSpacing?: number;
}

/** Spacing within the file that holds members a template has no slot for (× interval). */
const SPARE_SPACING = 0.8;

/**
 * The `FormationSpec` of organization unit `unitId` (a template unit id) in
 * formation `formationId`: roles placed by the template, child units placed
 * by its elements in their own formations, nested; soldiers from the roster.
 */
export function buildFormationSpec(
  organization: TraineeOrganization,
  unitId: string,
  formationId: string,
  options: FormationOptions = {},
): FormationSpec {
  const interval = options.interval ?? 10;
  const spacing = options.elementSpacing ?? 2 * interval;
  const find = (unit: RosterUnit): RosterUnit | null =>
    unit.unit.id === unitId ? unit : (unit.children.map(find).find((u) => u !== null) ?? null);
  const unit = find(rosterTree(organization));
  if (!unit) throw new FormationTemplateError(`unknown unit "${unitId}"`);

  const build = (
    node: RosterUnit,
    templateId: string,
    back: number,
    right: number,
    mirrored: boolean,
  ): FormationNode => {
    const template = formationTemplate(templateId);
    const elements = template.elements ?? [];
    const scale = elements.length > 0 ? spacing : interval;
    const flip = mirrored ? -1 : 1;
    // Members to slots, by role in template order; the rest follow in file.
    const free = [...node.members];
    const slots: FormationSlot[] = [];
    let rear = 0;
    for (const place of template.slots) {
      const i = free.findIndex((m) => place.roles.includes(m.role.id));
      if (i < 0) continue;
      const [member] = free.splice(i, 1);
      if (!member) continue;
      slots.push({
        id: member.slot.id,
        soldierId: soldierId(member.soldierId),
        back: -place.forward * scale,
        right: place.right * scale * flip,
      });
      rear = Math.max(rear, -place.forward * scale);
    }
    for (const member of free) {
      rear += SPARE_SPACING * interval;
      slots.push({
        id: member.slot.id,
        soldierId: soldierId(member.soldierId),
        back: rear,
        right: 0,
      });
    }
    // Child units: by the template's elements, in order; any beyond them follow in column.
    const children = node.children.map((child, i) => {
      const place = elements[i];
      if (!place) {
        rear += 2 * spacing;
        return build(child, defaultFormation(child, templateId), rear, 0, false);
      }
      const childRight = place.right * spacing * flip;
      const childTemplate = formationTemplate(place.formation);
      return build(
        child,
        place.formation,
        -place.forward * spacing,
        childRight,
        childRight < 0 && childTemplate.mirror !== false,
      );
    });
    return {
      unitId: orgUnitId(`${organization.unitIdPrefix}${node.unit.id}`),
      back,
      right,
      slots,
      children,
    };
  };

  const root = build(unit, formationId, 0, 0, false);
  return { root, interval };
}

/** A child's formation when its parent's template does not place it: its echelon's first. */
function defaultFormation(child: RosterUnit, parentTemplate: string): string {
  const count = (u: RosterUnit): number =>
    u.members.length + u.children.reduce((n, c) => n + count(c), 0);
  return formationsFor(child.unit.echelon, count(child))[0]?.id ?? parentTemplate;
}
