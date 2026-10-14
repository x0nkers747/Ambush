import type { Vec2 } from '../geometry';
import { flattenFormation } from './formation-spec';
import type { FormationNode, FormationSpec } from './types';

// Falling in "as best they can" (docs/behavior-lab/implementation.md, M3
// review): when an organization is ordered off, it takes the arrangement of
// its formation that asks the least walking of its Marines from where they
// stand. The free choices are which subordinate element takes which element
// position (whichever team is nearest the front leads) and whether the
// whole formation is mirrored left for right (teams keep their sides
// instead of crossing through each other). Roles within an element stay as
// the template places them; an element moved across the centre line is
// mirrored inside, so its leader stays on the side nearest the unit's leader.

/** Negates every lateral offset of `node` and its subtree (but not its own placement). */
function mirrorInside(node: FormationNode): FormationNode {
  return {
    ...node,
    slots: node.slots.map((s) => ({ ...s, right: -s.right + 0 })),
    children: node.children.map((c) => ({ ...mirrorInside(c), right: -c.right + 0 })),
  };
}

/** Every permutation of `0..n-1`, identity first, in lexicographic order. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const walk = (prefix: number[], rest: number[]) => {
    if (rest.length === 0) out.push(prefix);
    rest.forEach((r, i) => {
      walk([...prefix, r], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    });
  };
  walk(
    [],
    Array.from({ length: n }, (_, i) => i),
  );
  return out;
}

/** Arrangements are tried for up to this many elements (4! = 24). */
const MAX_PERMUTED = 4;

/**
 * The arrangement of `spec` to take: the one whose slots, laid out facing
 * `heading` around `reference`, are nearest the Marines' `positions` (least
 * sum of squared distances). `reference` is where the slot `referenceSoldier`
 * holds (the leader, who steps off from where he is), or the Marines' centre
 * for the slots' centre when there is no leader. Ties keep the template's
 * own arrangement (it is tried first).
 */
export function arrangeFormation(
  spec: FormationSpec,
  positions: ReadonlyMap<string, Vec2>,
  heading: Vec2,
  referenceSoldier: string | null,
): FormationSpec {
  const root = spec.root;
  const children = root.children;
  const orders =
    children.length <= MAX_PERMUTED ? permutations(children.length) : [children.map((_, i) => i)];
  const fx = heading.x;
  const fy = heading.y;
  let best = spec;
  let bestCost = Infinity;
  for (const mirrored of [false, true]) {
    for (const order of orders) {
      // Element position i is taken by child order[i], turned to its new side.
      const placed = order.map((from, i) => {
        const child = children[from] ?? children[i];
        const at = children[i] ?? child;
        if (!child || !at) return child;
        const wasLeft = child.right < 0;
        const isLeft = at.right < 0;
        const inner = wasLeft === isLeft ? child : mirrorInside(child);
        return { ...inner, back: at.back, right: at.right };
      });
      let candidate: FormationSpec = {
        ...spec,
        root: { ...root, children: placed.filter((c): c is FormationNode => c !== undefined) },
      };
      if (mirrored) {
        candidate = { ...candidate, root: mirrorInside(candidate.root) };
      }
      const cost = layoutCost(candidate, positions, fx, fy, referenceSoldier);
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }
  }
  return best;
}

function layoutCost(
  spec: FormationSpec,
  positions: ReadonlyMap<string, Vec2>,
  fx: number,
  fy: number,
  referenceSoldier: string | null,
): number {
  const flat = flattenFormation(spec);
  // Slot offsets relative to the reference slot (the leader's), or the centre.
  let rb = 0;
  let rr = 0;
  let px = 0;
  let py = 0;
  let n = 0;
  const lead = referenceSoldier === null ? -1 : flat.soldierIds.indexOf(referenceSoldier);
  const leaderAt = referenceSoldier === null ? undefined : positions.get(referenceSoldier);
  if (lead >= 0 && leaderAt) {
    rb = flat.back[lead] ?? 0;
    rr = flat.right[lead] ?? 0;
    px = leaderAt.x;
    py = leaderAt.y;
  } else {
    flat.soldierIds.forEach((id, i) => {
      const p = positions.get(id);
      if (!p) return;
      rb += flat.back[i] ?? 0;
      rr += flat.right[i] ?? 0;
      px += p.x;
      py += p.y;
      n += 1;
    });
    if (n === 0) return 0;
    rb /= n;
    rr /= n;
    px /= n;
    py /= n;
  }
  // Facing (fx, fy); right is (fy, −fx).
  let cost = 0;
  flat.soldierIds.forEach((id, i) => {
    const p = positions.get(id);
    if (!p) return;
    const back = (flat.back[i] ?? 0) - rb;
    const right = (flat.right[i] ?? 0) - rr;
    const x = px - fx * back + fy * right;
    const y = py - fy * back - fx * right;
    cost += (x - p.x) ** 2 + (y - p.y) ** 2;
  });
  return cost;
}
