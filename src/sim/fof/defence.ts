import { nearestInArea } from '../behavior/slots';
import type { FormationNode, FormationSpec, FormationSlot } from '../behavior/types';
import { azimuthOf, type Vec2 } from '../geometry';
import type { Soldier } from '../state';
import { pointInPolygon } from '../polygon';
import { roadNetwork, roadPointAt } from '../road-network';
import { isOnTerrain, type TerrainDataset } from '../terrain';
import { centreOf, enter, forceArea, issue, runningTask } from './force';
import { activeOrder } from './orders';
import type { FofContext } from './system';
import type { DefenceSector, FofForce, FofOrder } from './types';

// Defence (docs/behavior-lab/force-on-force/09). A squad on a defend order
// moves to its defensive position like a move. There it deploys across its
// sector: a line across the direction it defends toward when the arc is
// narrow, a ring round the position when it is wide (all round, a
// perimeter), each soldier facing his share of the arc. It lies prone and
// digs in: from lying in the open, through shell scrapes and fighting pits,
// to standing in a trench after `digInSeconds` undisturbed. The deeper it is
// dug in, the harder its soldiers are to hit, to see and to suppress.
//
// It fights from there (its actions on contact are `hold`): it never moves on
// or assaults, and once contact is lost it goes back to its defence and on
// digging. A spent squad still breaks contact (the lifecycle). The order never
// ends by itself: the squad waits for new orders. Given another, it loses its
// dig-in; its soldiers' fighting positions stay where they were dug.

/** Arcs at least this wide (radians) are held from a ring round the position; narrower, from a line across it. */
export const RING_FROM_RAD = (120 * Math.PI) / 180;
/** Metres between soldiers in a defence's line, and along its ring. */
const DEFENCE_INTERVAL_M = 5;
/** A ring's radius, metres: at least and at most. */
const RING_MIN_M = 8;
const RING_MAX_M = 30;

/** Every slot of a formation with its offset from the root (back, right). */
function slotsOf(formation: FormationSpec): { slot: FormationSlot; back: number; right: number }[] {
  const out: { slot: FormationSlot; back: number; right: number }[] = [];
  const walk = (node: FormationNode, back: number, right: number) => {
    for (const slot of node.slots)
      out.push({ slot, back: back + slot.back, right: right + slot.right });
    for (const child of node.children) walk(child, back + child.back, right + child.right);
  };
  walk(formation.root, 0, 0);
  return out;
}

/**
 * The formation a squad defends in: its soldiers, taken left to right as
 * `formation` places them, across `sector` (relative to the formation's
 * facing, which is the sector's): in a line across it when the arc is narrow,
 * on a ring round the position when it is wide. Its tree is kept (offsets are
 * absolute in the slots).
 */
export function defenceFormation(formation: FormationSpec, sector: DefenceSector): FormationSpec {
  const all = slotsOf(formation).sort((a, b) => a.right - b.right || a.back - b.back);
  const n = all.length;
  const place = new Map<string, { back: number; right: number }>();
  if (sector.arc < RING_FROM_RAD) {
    const width = DEFENCE_INTERVAL_M * Math.max(0, n - 1);
    all.forEach(({ slot }, i) =>
      place.set(slot.id, { back: 0, right: -width / 2 + DEFENCE_INTERVAL_M * i }),
    );
  } else {
    const radius = Math.min(
      RING_MAX_M,
      Math.max(RING_MIN_M, (DEFENCE_INTERVAL_M * n) / sector.arc),
    );
    all.forEach(({ slot }, i) => {
      const angle = -sector.arc / 2 + (sector.arc * (i + 0.5)) / n;
      place.set(slot.id, { back: -radius * Math.cos(angle), right: radius * Math.sin(angle) });
    });
  }
  const rebuild = (node: FormationNode): FormationNode => ({
    ...node,
    back: 0,
    right: 0,
    slots: node.slots.map((s) => ({
      ...s,
      ...(place.get(s.id) ?? { back: s.back, right: s.right }),
    })),
    children: node.children.map(rebuild),
  });
  return { ...formation, root: rebuild(formation.root) };
}

/** The way a soldier at `p` faces in a defence at `centre`: his share of the sector's arc. */
export function defenceAzimuth(
  sector: DefenceSector,
  centre: Vec2,
  p: Vec2,
  members: number,
): number {
  const dx = p.x - centre.x;
  const dy = p.y - centre.y;
  if (sector.arc >= RING_FROM_RAD) {
    // On the ring: outward, within the arc.
    if (dx === 0 && dy === 0) return sector.facing;
    let off = azimuthOf(dx, dy) - sector.facing;
    off -= 2 * Math.PI * Math.round(off / (2 * Math.PI));
    return sector.facing + Math.max(-sector.arc / 2, Math.min(sector.arc / 2, off));
  }
  // In the line: the arc spread across it, left to right.
  const across = dx * Math.cos(sector.facing) - dy * Math.sin(sector.facing);
  const half = Math.max(1, (DEFENCE_INTERVAL_M * Math.max(1, members - 1)) / 2);
  const f = Math.max(-1, Math.min(1, across / half));
  return sector.facing + (f * sector.arc) / 2;
}

/**
 * The force, on its defend order, is at its position: it deploys across its
 * sector and starts digging in (from its preparation, if any, when it first
 * occupies it).
 */
export function occupyDefence(context: FofContext, force: FofForce, order: FofOrder): void {
  const { world, t } = context;
  force.mission = null;
  force.actionsOn = 'hold';
  const sector = order.sector;
  const at = order.destination ?? centreOf(context, force);
  const forceSetup = context.setup.forces.find((f) => f.unitId === force.unitId);
  const shape = forceSetup?.formation ?? forceSetup?.assaultFormation;
  const area = forceArea(context, force);
  if (sector && at && shape && area > 0 && isOnTerrain(world.terrain, at.x, at.y)) {
    const point = nearestInArea(world.terrain, at, area);
    if (point) {
      issue(context, force, {
        kind: 'moveInFormation',
        destination: point,
        formation: defenceFormation(shape, sector),
        finalFacing: sector.facing,
        ...(forceSetup?.pace !== undefined ? { pace: forceSetup.pace } : {}),
      });
    }
  }
  const prepared = Math.min(1, order.preparedSeconds / context.setup.config.force.digInSeconds);
  force.dugIn = Math.max(force.dugIn, prepared);
  force.diggingSince = t;
  enter(context, force, 'defending', 'occupying the defensive position');
}

/** Back in its defence after a fight (contact lost): it digs on. */
export function resumeDefence(context: FofContext, force: FofForce): void {
  force.diggingSince = context.t;
  enter(context, force, 'defending', 'contact lost: back in the defence');
}

/**
 * A decision in the defence: deployed (its move into place done), it digs
 * in, and each soldier's fighting position is recorded where he lies.
 */
export function updateDefence(context: FofContext, force: FofForce): void {
  const { t, setup } = context;
  const order = activeOrder(force);
  if (order?.kind !== 'defend') return;
  if (runningTask(context, force)) {
    // Still moving into place: digging starts once it is.
    force.diggingSince = t;
    return;
  }
  const since = force.diggingSince ?? t;
  force.dugIn = Math.min(1, force.dugIn + (t - since) / setup.config.force.digInSeconds);
  force.diggingSince = t;
  for (const id of force.memberIds) {
    const soldier = context.state.soldiers[context.soldierIndex.get(id) ?? -1];
    if (soldier?.status !== 'active') continue;
    recordEarthwork(context, force, soldier);
  }
}

function recordEarthwork(context: FofContext, force: FofForce, soldier: Soldier): void {
  const { x, y } = soldier.position;
  const work = force.earthworks.find((w) => w.soldierId === soldier.id);
  if (work) {
    // Where it is hard ground is looked up again only when he has moved.
    if (Math.hypot(work.x - x, work.y - y) > 0.5)
      work.hard = hardGround(context.world.terrain, x, y);
    work.x = x;
    work.y = y;
    work.azimuth = soldier.azimuth;
    work.level = force.dugIn;
  } else {
    force.earthworks.push({
      soldierId: soldier.id,
      x,
      y,
      azimuth: soldier.azimuth,
      level: force.dugIn,
      hard: hardGround(context.world.terrain, x, y),
    });
  }
}

/** Footways and the like: paved paths (the ground's own rule, docs/adr/0048). */
const PAVED_PATHS: ReadonlySet<string> = new Set(['footway', 'pedestrian', 'cycleway', 'steps']);

/**
 * Whether nothing can be dug at (x, y): on the carriageway of a paved or major
 * road (or a paved path), on mapped paved ground (a car park, a square), or
 * inside a building.
 */
export function hardGround(terrain: TerrainDataset, x: number, y: number): boolean {
  const p = { x, y };
  const on = roadPointAt(terrain, p);
  if (on) {
    const net = roadNetwork(terrain);
    const edge = net.edges[on.edge];
    const road = edge ? net.roads[edge.road] : undefined;
    if (
      edge &&
      road &&
      on.distance <= edge.halfWidth &&
      (road.roadClass === 'major' ||
        road.roadClass === 'paved' ||
        (road.highway !== undefined && PAVED_PATHS.has(road.highway)))
    )
      return true;
  }
  const { landUse = [], buildings } = terrain.features;
  for (const area of landUse) {
    if (area.kind === 'paved' && pointInPolygon(p, area.boundary)) return true;
  }
  return buildings.some((b) => pointInPolygon(p, b.footprint));
}

/**
 * How far a force's soldiers are dug in (0–1) for fire and observation: its
 * dig-in while it holds its defence (deploying, digging, or fighting from
 * it); 0 on the move or on any other order.
 */
export function effectiveDugIn(force: FofForce | null | undefined): number {
  if (!force || force.dugIn <= 0 || activeOrder(force)?.kind !== 'defend') return 0;
  switch (force.phase) {
    case 'defending':
    case 'contact':
    case 'engaged':
    case 'holding':
    case 'possibleContact':
      return force.dugIn;
    default:
      return 0;
  }
}

/** A factor that is 1 in the open and `full` fully dug in, linear between. */
export const dugInFactor = (dugIn: number, full: number): number => 1 - dugIn * (1 - full);
