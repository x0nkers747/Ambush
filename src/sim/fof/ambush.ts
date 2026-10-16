import { nearestInArea } from '../behavior/slots';
import type { FormationNode, FormationSpec } from '../behavior/types';
import { azimuthOf, type Vec2 } from '../geometry';
import type { SoldierId } from '../state';
import { isOnTerrain } from '../terrain';
import { centreOf, enter, forceArea, halt, issue, runningTask } from './force';
import { activeOrder } from './orders';
import type { FofContext } from './system';
import { forceActive, glimpse, setLevel } from './system';
import type { FofForce, FofOrder, KillZone } from './types';

// Ambush (docs/behavior-lab/force-on-force/08). A squad on an ambush order
// moves to its ambush position like a move; there it deploys in its
// extended line facing its kill zone, goes prone and lies in wait:
// concealed (the enemy cannot detect its soldiers farther than
// `concealmentRangeM`), holding its fire, not halting for what it sees.
// It springs the ambush (opens fire, all together) when, by where the enemy
// actually is (it watches its kill zone):
//
//   - `ambushTriggerShare` of one enemy squad's active soldiers are in the
//     kill zone; or
//   - an enemy soldier who was in the kill zone has left it (the enemy is
//     getting through); or
//   - it is compromised: fired upon, or an enemy squad has seen one of its
//     soldiers (a confirmed contact) since it occupied the position.
//
// Sprung, it knows the enemy in the kill zone (it has watched them in) and
// fights from where it lies (its actions on contact become `hold`) until the
// enemy is down or gone, then waits there for new orders: the order never
// ends by itself.

/** Whether a point is in a kill zone. */
export function inKillZone(zone: KillZone, p: Vec2): boolean {
  const dx = p.x - zone.centre.x;
  const dy = p.y - zone.centre.y;
  // Depth along the facing, width across it.
  const along = dx * Math.sin(zone.facing) + dy * Math.cos(zone.facing);
  const across = dx * Math.cos(zone.facing) - dy * Math.sin(zone.facing);
  return Math.abs(along) <= zone.depthM / 2 + 1e-9 && Math.abs(across) <= zone.widthM / 2 + 1e-9;
}

/** A kill zone's corners, in order around it (near left, near right, far right, far left from the ambush). */
export function killZoneCorners(zone: KillZone): Vec2[] {
  const fx = Math.sin(zone.facing);
  const fy = Math.cos(zone.facing);
  // Right of the facing.
  const rx = fy;
  const ry = -fx;
  const d = zone.depthM / 2;
  const w = zone.widthM / 2;
  const at = (a: number, r: number) => ({
    x: zone.centre.x + fx * a + rx * r,
    y: zone.centre.y + fy * a + ry * r,
  });
  return [at(-d, -w), at(-d, w), at(d, w), at(d, -w)];
}

/**
 * The force, on its ambush order, is at its position: it deploys there in
 * its extended line (its assault formation; else its formation), facing
 * the kill zone, and lies in wait.
 */
export function occupyAmbush(context: FofContext, force: FofForce, order: FofOrder): void {
  const { world } = context;
  force.killZoneInside = [];
  force.ambushSprungAt = null;
  force.mission = null;
  const zone = order.killZone;
  const at = order.destination ?? centreOf(context, force);
  const forceSetup = context.setup.forces.find((f) => f.unitId === force.unitId);
  const line = forceSetup?.assaultFormation ?? forceSetup?.formation;
  // Its line no wider than the kill zone (so its ends are not out past it, nearer the enemy).
  const formation = line && zone ? fittedTo(line, zone.widthM) : line;
  const area = forceArea(context, force);
  if (zone && at && formation && area > 0 && isOnTerrain(world.terrain, at.x, at.y)) {
    const point = nearestInArea(world.terrain, at, area);
    if (point) {
      issue(context, force, {
        kind: 'moveInFormation',
        destination: point,
        formation,
        finalFacing: azimuthOf(zone.centre.x - point.x, zone.centre.y - point.y),
        ...(forceSetup?.pace !== undefined ? { pace: forceSetup.pace } : {}),
      });
    }
  }
  enter(context, force, 'inAmbush', 'occupying the ambush position');
}

/** The least share of its intervals an ambush line is closed up to. */
const MIN_LINE_SCALE = 0.6;

/** A formation closed up (every offset scaled) to be at most `widthM` across, by at most `MIN_LINE_SCALE`. */
export function fittedTo(formation: FormationSpec, widthM: number): FormationSpec {
  let left = Infinity;
  let right = -Infinity;
  const walk = (node: FormationNode, r: number) => {
    const at = r + node.right;
    for (const slot of node.slots) {
      left = Math.min(left, at + slot.right);
      right = Math.max(right, at + slot.right);
    }
    for (const child of node.children) walk(child, at);
  };
  walk({ ...formation.root, right: 0 }, 0);
  const width = right - left;
  if (!(width > widthM)) return formation;
  const k = Math.max(MIN_LINE_SCALE, widthM / width);
  const scale = (node: FormationNode): FormationNode => ({
    ...node,
    back: node.back * k,
    right: node.right * k,
    slots: node.slots.map((s) => ({ ...s, back: s.back * k, right: s.right * k })),
    children: node.children.map(scale),
  });
  return { root: scale(formation.root), interval: formation.interval * k };
}

/**
 * In ambush: deployed, it is concealed; it springs the ambush when the
 * enemy is in its kill zone, getting through it, or has found it.
 */
export function updateAmbush(context: FofContext, force: FofForce): void {
  const order = activeOrder(force);
  const zone = order?.killZone ?? null;
  force.concealed = runningTask(context, force) === undefined;
  if (!zone) return;
  const reason = triggerOf(context, force, zone);
  if (reason) springAmbush(context, force, zone, reason);
}

/** Why the ambush is sprung now, or `null`. */
function triggerOf(context: FofContext, force: FofForce, zone: KillZone): string | null {
  const { fof, state, soldierIndex } = context;
  const share = context.setup.config.force.ambushTriggerShare;
  const own = fof.forces.indexOf(force);
  const inside: SoldierId[] = [];
  let full: string | null = null;
  for (const enemy of fof.forces) {
    if (enemy.side === force.side || !forceActive(enemy)) continue;
    let active = 0;
    let n = 0;
    for (const id of enemy.memberIds) {
      const s = state.soldiers[soldierIndex.get(id) ?? -1];
      if (s?.status !== 'active') continue;
      active += 1;
      if (inKillZone(zone, s.position)) {
        n += 1;
        inside.push(id);
      }
    }
    if (active > 0 && n > 0 && n >= share * active - 1e-9) full ??= enemy.name;
  }
  const before = force.killZoneInside;
  force.killZoneInside = inside;
  if (full !== null) return `ambush sprung: ${full} in the kill zone`;
  // Someone who was in the kill zone (and is still up) has left it: the enemy is getting through.
  const leaving = before.some(
    (id) => !inside.includes(id) && state.soldiers[soldierIndex.get(id) ?? -1]?.status === 'active',
  );
  if (leaving) return 'ambush sprung: the enemy is leaving the kill zone';
  // Compromised: an enemy force has seen one of its soldiers since it lay in wait (a confirmed contact).
  const members = new Set<string>(force.memberIds);
  const found = fof.tracks.some(
    (tr) =>
      tr.force !== own &&
      fof.forces[tr.force]?.side !== force.side &&
      (tr.level === 'detected' || tr.level === 'identified') &&
      tr.lastSeenAt >= force.phaseSince - 1e-9 &&
      members.has(tr.targetId),
  );
  return found ? 'ambush sprung: compromised (the enemy has seen it)' : null;
}

/**
 * Springs the ambush: it opens fire at once, all together, on the enemy in
 * the kill zone (which it knows: it has watched them in), and fights from
 * where it lies; it then waits there for new orders.
 */
export function springAmbush(
  context: FofContext,
  force: FofForce,
  zone: KillZone | null,
  reason: string,
): void {
  const { fof, state, soldierIndex, t } = context;
  const own = fof.forces.indexOf(force);
  force.ambushSprungAt = t;
  force.concealed = false;
  force.hostile = true;
  force.actionsOn = 'hold';
  force.killZoneInside = [];
  if (zone) {
    const surprise = context.setup.config.force.ambushSurpriseSeconds;
    for (const enemy of fof.forces) {
      if (enemy.side === force.side || !forceActive(enemy)) continue;
      for (const id of enemy.memberIds) {
        const s = state.soldiers[soldierIndex.get(id) ?? -1];
        if (s?.status !== 'active' || !inKillZone(zone, s.position)) continue;
        // Caught in the kill zone, its squad is surprised (unless it has already found the ambush).
        if (!reason.includes('compromised') && !reason.includes('fired upon'))
          enemy.surprisedUntil = Math.max(enemy.surprisedUntil ?? -Infinity, t + surprise);
        const existing = fof.tracks.find((tr) => tr.force === own && tr.targetId === id);
        const from = existing?.level ?? 'unaware';
        const track = glimpse(context, own, s, existing, 1, null);
        track.identified = true;
        setLevel(context, track, from, null, null);
      }
    }
  }
  halt(context, force, 'contact', reason);
  // Ready and waiting: no reaction delay, the whole ambush fires together.
  for (const id of force.memberIds) {
    const member = fof.soldiers[context.memberIndex.get(id) ?? -1];
    if (member) member.reactAt = t;
  }
}
