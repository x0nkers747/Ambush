import type { FormationNode, FormationSpec } from './types';

// Formation specs: shape checks and the flattened slot table the movement
// laws read (docs/behavior-lab/03 §6.2).

/** Every slot with its offset from the formation's reference point (nested offsets summed). */
export interface FlatFormation {
  readonly slotIds: readonly string[];
  readonly soldierIds: readonly string[];
  readonly back: readonly number[];
  readonly right: readonly number[];
  /** Largest |right| of any slot (m). */
  readonly halfWidth: number;
  /** Slot index by slot id. */
  readonly indexOf: ReadonlyMap<string, number>;
}

const flatCache = new WeakMap<FormationSpec, FlatFormation>();

/** The slot table of `spec` (derived; cached per spec object). */
export function flattenFormation(spec: FormationSpec): FlatFormation {
  const known = flatCache.get(spec);
  if (known) return known;
  const slotIds: string[] = [];
  const soldierIds: string[] = [];
  const back: number[] = [];
  const right: number[] = [];
  const walk = (node: FormationNode, b: number, r: number) => {
    for (const slot of node.slots) {
      slotIds.push(slot.id);
      soldierIds.push(slot.soldierId);
      back.push(b + slot.back);
      right.push(r + slot.right);
    }
    for (const child of node.children) walk(child, b + child.back, r + child.right);
  };
  walk(spec.root, 0, 0);
  const flat: FlatFormation = {
    slotIds,
    soldierIds,
    back,
    right,
    halfWidth: right.reduce((m, v) => Math.max(m, Math.abs(v)), 0),
    indexOf: new Map(slotIds.map((id, i) => [id, i])),
  };
  flatCache.set(spec, flat);
  return flat;
}

/**
 * Throws a RangeError unless `spec` is well formed: finite offsets, a
 * positive interval, unique slot ids and soldiers, at least one slot.
 */
export function validateFormationSpec(spec: FormationSpec): void {
  if (!(typeof spec.interval === 'number' && Number.isFinite(spec.interval) && spec.interval > 0)) {
    throw new RangeError(
      `formation interval must be a finite number > 0, got ${String(spec.interval)}`,
    );
  }
  const ids = new Set<string>();
  const soldiers = new Set<string>();
  const check = (node: FormationNode, path: string) => {
    if (typeof node.unitId !== 'string' || node.unitId === '') {
      throw new RangeError(`${path}: unitId must be a non-empty string`);
    }
    if (!Number.isFinite(node.back) || !Number.isFinite(node.right)) {
      throw new RangeError(`${path}: offsets must be finite`);
    }
    for (const slot of node.slots) {
      if (typeof slot.id !== 'string' || slot.id === '' || ids.has(slot.id)) {
        throw new RangeError(
          `${path}: slot ids must be unique, non-empty strings, got "${slot.id}"`,
        );
      }
      if (
        typeof slot.soldierId !== 'string' ||
        slot.soldierId === '' ||
        soldiers.has(slot.soldierId)
      ) {
        throw new RangeError(`${path}: slot "${slot.id}": each soldier may hold one slot`);
      }
      if (!Number.isFinite(slot.back) || !Number.isFinite(slot.right)) {
        throw new RangeError(`${path}: slot "${slot.id}": offsets must be finite`);
      }
      ids.add(slot.id);
      soldiers.add(slot.soldierId);
    }
    node.children.forEach((child, i) => {
      check(child, `${path}.children[${String(i)}]`);
    });
  };
  check(spec.root, 'formation.root');
  if (ids.size === 0) throw new RangeError('formation must have at least one slot');
}
