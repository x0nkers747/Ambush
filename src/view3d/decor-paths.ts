import type { Building, Vec2 } from '#sim';
import type { BuildingDesign, BuildingEntrance } from './building-geometry';
import type { Region } from './building-style';
import { roadEdge, type DecorContext } from './decor-context';
import type { DecorSpace } from './decor-space';
import { hashString, unit } from './hash';

// Paths and driveways from buildings to the road (docs/adr/0036). Mapped
// access comes first: a building with a mapped footway, path or service road
// at its door gets nothing more (the mapped way is drawn as a road already).
// Otherwise its entrance (the door the building generator put on the wall
// facing the nearest road, docs/adr/0035) is joined to the road by the
// simplest route that works: straight out from the door, straight to the
// nearest road, or out a few metres and then to the road, with the corner
// rounded. A route is refused if it passes through or squeezes between
// buildings, crosses water or another road, climbs too steeply, or mostly
// runs along a path already made; a building with no acceptable route gets
// none. Walkways may end on the building's own driveway. Paths are drawn on
// the authoritative ground, which is never changed for them. Pure.

export type PathStyle =
  | 'walkConcrete'
  | 'walkPaving'
  | 'driveAsphalt'
  | 'driveConcrete'
  | 'drivePaving'
  | 'driveGravel'
  | 'trackDirt';

export interface PathLine {
  readonly id: string;
  readonly buildingId: string;
  readonly kind: 'walk' | 'drive' | 'track';
  readonly style: PathStyle;
  readonly points: readonly Vec2[];
  readonly halfWidth: number;
}

/** A mailbox (North American houses) at the road end of a path. */
export interface MailboxSpot {
  readonly x: number;
  readonly y: number;
  /** Facing the road. */
  readonly yaw: number;
  readonly seed: number;
}

interface Spec {
  readonly kind: PathLine['kind'];
  readonly style: PathStyle;
  readonly width: number;
  readonly maxLength: number;
  readonly maxGrade: number;
}

/** Steepest grades: walkways may take a few steps, vehicles may not. */
const WALK_GRADE = 0.25;
const DRIVE_GRADE = 0.17;
/** Routes keep this far from walls (except leaving their own door). */
const WALL_CLEARANCE_M = 0.6;
/** Grades are measured over this run, metres. */
const GRADE_WINDOW_M = 3.5;
/** Locally (a step, a kerb) no steeper than this. */
const MAX_STEP_GRADE = 0.7;
/** Sample spacing along a route, metres. */
const STEP_M = 1;

function specFor(
  design: BuildingDesign,
  entrance: BuildingEntrance,
  region: Region,
  u: number,
): Spec | null {
  const eu = region === 'central-european';
  const { category, door } = design.style;
  if (entrance.kind === 'garage') {
    const style: PathStyle = eu
      ? u < 0.6
        ? 'drivePaving'
        : 'driveGravel'
      : u < 0.55
        ? 'driveAsphalt'
        : 'driveConcrete';
    return {
      kind: 'drive',
      style,
      width: 3,
      maxLength: category === 'outbuilding' ? 35 : 70,
      maxGrade: DRIVE_GRADE,
    };
  }
  switch (category) {
    case 'residential':
    case 'military':
      return {
        kind: 'walk',
        style: eu ? 'walkPaving' : 'walkConcrete',
        width: 1.2,
        maxLength: 45,
        maxGrade: WALK_GRADE,
      };
    case 'commercial':
    case 'institutional':
      return {
        kind: 'walk',
        style: eu ? 'walkPaving' : 'walkConcrete',
        width: 2,
        maxLength: 60,
        maxGrade: WALK_GRADE,
      };
    case 'industrial':
      return {
        kind: 'drive',
        style: door === 'roller' ? (u < 0.5 ? 'driveAsphalt' : 'driveConcrete') : 'walkConcrete',
        width: door === 'roller' ? 5 : 1.5,
        maxLength: 90,
        maxGrade: DRIVE_GRADE,
      };
    case 'agricultural':
      return {
        kind: 'track',
        style: u < 0.55 ? 'driveGravel' : 'trackDirt',
        width: 3.5,
        maxLength: 160,
        maxGrade: DRIVE_GRADE,
      };
    case 'outbuilding':
      return null;
  }
}

/** Points of a polyline every `step` metres (ends included), with the distance along it. */
function samples(points: readonly Vec2[], step: number): { x: number; y: number; s: number }[] {
  const out: { x: number; y: number; s: number }[] = [];
  let s0 = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = i === 0 ? 0 : 1; k <= n; k += 1) {
      const t = k / n;
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), s: s0 + t * len });
    }
    s0 += len;
  }
  return out;
}

const lengthOf = (pts: readonly Vec2[]) =>
  pts.reduce(
    (sum, p, i) =>
      i === 0 ? 0 : sum + Math.hypot(p.x - (pts[i - 1]?.x ?? p.x), p.y - (pts[i - 1]?.y ?? p.y)),
    0,
  );

/** A polyline with its corners rounded (radius at most `r`, and under half of each leg). */
export function roundCorners(points: readonly Vec2[], r: number): Vec2[] {
  if (points.length < 3) return [...points];
  const out: Vec2[] = [points[0] ?? { x: 0, y: 0 }];
  for (let i = 1; i + 1 < points.length; i += 1) {
    const a = points[i - 1];
    const p = points[i];
    const b = points[i + 1];
    if (!a || !p || !b) continue;
    const l1 = Math.hypot(p.x - a.x, p.y - a.y);
    const l2 = Math.hypot(b.x - p.x, b.y - p.y);
    const rr = Math.min(r, 0.45 * l1, 0.45 * l2);
    if (rr < 0.05) {
      out.push(p);
      continue;
    }
    const s = { x: p.x + ((a.x - p.x) / l1) * rr, y: p.y + ((a.y - p.y) / l1) * rr };
    const e = { x: p.x + ((b.x - p.x) / l2) * rr, y: p.y + ((b.y - p.y) / l2) * rr };
    // A quadratic Bézier from s to e with control point p.
    for (let k = 0; k <= 4; k += 1) {
      const t = k / 4;
      out.push({
        x: (1 - t) * (1 - t) * s.x + 2 * (1 - t) * t * p.x + t * t * e.x,
        y: (1 - t) * (1 - t) * s.y + 2 * (1 - t) * t * p.y + t * t * e.y,
      });
    }
  }
  out.push(points[points.length - 1] ?? { x: 0, y: 0 });
  return out;
}

export interface PathResult {
  readonly paths: readonly PathLine[];
  readonly mailboxes: readonly MailboxSpot[];
  /** Buildings left without an inferred path because mapped access was found. */
  readonly mapped: number;
  /** Entrances for which no acceptable route was found. */
  readonly refused: number;
  /** Why the most direct route was refused, for the entrances left without a path. */
  readonly reasons: Readonly<Record<RefusalReason, number>>;
}

export type RefusalReason = 'length' | 'edge' | 'building' | 'water' | 'road' | 'slope' | 'overlap';

/**
 * Infers paths and driveways for buildings. `designs` and `entrances` come
 * from the building generator.
 */
export function inferPaths(
  ctx: DecorContext,
  space: DecorSpace,
  buildings: readonly Building[],
  designs: ReadonlyMap<string, BuildingDesign>,
  entrances: readonly BuildingEntrance[],
): PathResult {
  const paths: PathLine[] = [];
  const mailboxes: MailboxSpot[] = [];
  let mapped = 0;
  let refused = 0;
  const reasons: Record<RefusalReason, number> = {
    length: 0,
    edge: 0,
    building: 0,
    water: 0,
    road: 0,
    slope: 0,
    overlap: 0,
  };
  const byBuilding = new Map<string, BuildingEntrance[]>();
  for (const e of entrances) {
    const list = byBuilding.get(e.buildingId) ?? [];
    list.push(e);
    byBuilding.set(e.buildingId, list);
  }
  const ids = [...byBuilding.keys()].sort();
  const indexOf = new Map(buildings.map((b, i) => [b.id, i]));

  // Every doorway keeps a little room clear (trees, lamps and props stay out of it).
  for (const id of ids) {
    for (const e of byBuilding.get(id) ?? [])
      space.addDisc(e.x + e.nx * 1.5, e.y + e.ny * 1.5, 1.6, 'entrance');
  }

  for (const id of ids) {
    const design = designs.get(id);
    const list = byBuilding.get(id) ?? [];
    if (!design) continue;
    const own = indexOf.get(id) ?? -1;
    // Garages first: a walkway may then end on the driveway.
    const ordered = [...list].sort(
      (a, b) => (a.kind === 'garage' ? 0 : 1) - (b.kind === 'garage' ? 0 : 1),
    );
    let driveway: readonly Vec2[] | null = null;
    let mailboxPlaced = false;
    for (const [k, e] of ordered.entries()) {
      const u = unit(hashString(`${id}:${String(k)}:path`));
      const spec = specFor(design, e, ctx.region, u);
      if (!spec) continue;
      const start = { x: e.x + e.nx * 0.25, y: e.y + e.ny * 0.25 };
      // Mapped access at the door: nothing to infer.
      if (ctx.access.near(start.x + e.nx * 2, start.y + e.ny * 2, 2.5)) {
        mapped += 1;
        continue;
      }
      const reach = spec.maxLength + 12;
      const near = ctx.nearestRoad(start.x, start.y, reach);
      if (!near) {
        refused += 1;
        reasons.length += 1;
        continue;
      }
      const target = near.road;
      const edgeOf = (road: number) => {
        const r = ctx.roads[road];
        return r ? roadEdge(r) : 0;
      };
      // Already at the road: no path needed.
      if (near.distance < edgeOf(target) + 0.8) continue;

      const check = (route: readonly Vec2[]): RefusalReason | null => {
        const total = lengthOf(route);
        if (total > reach) return 'length';
        let overlap = 0;
        let checked = 0;
        // Ground along the route, for grades over a few metres (a step at a
        // graded pad's edge is allowed, a steep bank is not).
        const zs: { s: number; z: number }[] = [];
        for (const q of samples(route, STEP_M)) {
          if (!ctx.onTerrain(q.x, q.y)) return 'edge';
          const onTarget = ctx.nearestRoad(q.x, q.y, 30, (r) => r === target);
          if (onTarget && onTarget.distance < edgeOf(target)) break; // reached the road
          checked += 1;
          if (q.s > 0.3 && ctx.buildingAt(q.x, q.y) >= 0) return 'building';
          if (q.s > 1.5 && ctx.walls.near(q.x, q.y, WALL_CLEARANCE_M + spec.width / 2 - 0.4))
            return 'building';
          if (ctx.water(q.x, q.y, 0.5)) return 'water';
          const other = ctx.nearestRoad(q.x, q.y, 20, (r) => r !== target);
          if (other && other.distance < edgeOf(other.road) + 0.3) return 'road';
          // (Where a walkway joins a driveway its last metres overlap it, as they should.)
          if (q.s < total - 2.5 && space.corridorDistance(q.x, q.y, 0.01, ['path']) <= 0)
            overlap += 1;
          const z = ctx.ground(q.x, q.y);
          zs.push({ s: q.s, z });
          for (let k = zs.length - 2; k >= 0; k -= 1) {
            const p = zs[k];
            if (!p) break;
            const run = q.s - p.s;
            if (run < GRADE_WINDOW_M) continue;
            if (Math.abs(z - p.z) / run > spec.maxGrade) return 'slope';
            break;
          }
          const last = zs[zs.length - 2];
          if (last && q.s > last.s && Math.abs(z - last.z) / (q.s - last.s) > MAX_STEP_GRADE) {
            return 'slope';
          }
        }
        return checked === 0 ? 'length' : overlap > 0.3 * checked ? 'overlap' : null;
      };

      // Candidates, simplest first.
      const candidates: Vec2[][] = [];
      const rayHit = (() => {
        for (let d = 1; d <= reach; d += 1) {
          const q = { x: start.x + e.nx * d, y: start.y + e.ny * d };
          const r = ctx.nearestRoad(q.x, q.y, 30);
          if (r && r.distance < edgeOf(r.road)) return r;
        }
        return null;
      })();
      if (rayHit) candidates.push([start, { x: rayHit.x, y: rayHit.y }]);
      candidates.push([start, { x: near.x, y: near.y }]);
      for (const out of [3, 6]) {
        const p = { x: start.x + e.nx * out, y: start.y + e.ny * out };
        const r = ctx.nearestRoad(p.x, p.y, reach);
        if (r)
          candidates.push(roundCorners([start, p, { x: r.x, y: r.y }], Math.max(1.5, spec.width)));
      }
      // A walkway may end on the building's own driveway, when that is shorter.
      if (spec.kind === 'walk' && driveway) {
        let best: Vec2 | null = null;
        let bestD = Infinity;
        for (const q of samples(driveway, 0.5)) {
          const d = Math.hypot(q.x - start.x, q.y - start.y);
          if (d < bestD) {
            bestD = d;
            best = q;
          }
        }
        if (best && bestD < 15 && bestD < near.distance) candidates.unshift([start, best]);
      }

      let route: Vec2[] | null = null;
      let first: RefusalReason | null = null;
      for (const c of candidates) {
        if (c.length < 2) continue;
        const why = check(c);
        if (why === null) {
          route = c;
          break;
        }
        first ??= why;
      }
      if (!route) {
        refused += 1;
        reasons[first ?? 'length'] += 1;
        continue;
      }
      const half = spec.width / 2;
      paths.push({
        id: `${id}:${e.kind}`,
        buildingId: id,
        kind: spec.kind,
        style: spec.style,
        points: route,
        halfWidth: half,
      });
      space.addPolyline(route, half + 0.3, 'path');
      if (spec.kind === 'drive') driveway = route;

      // A mailbox where a North American house's path or driveway meets the road.
      if (
        ctx.region === 'north-american' &&
        design.style.category === 'residential' &&
        !mailboxPlaced &&
        own >= 0
      ) {
        const end = route[route.length - 1];
        const before = route[route.length - 2];
        const r = ctx.roads[target];
        if (end && before && r) {
          const len = Math.hypot(end.x - before.x, end.y - before.y);
          const ux = (before.x - end.x) / len;
          const uy = (before.y - end.y) / len;
          const back = roadEdge(r) + 1.0;
          if (len > back + 1) {
            const side = unit(hashString(`${id}:mailbox`)) < 0.5 ? 1 : -1;
            const off = half + 0.7;
            mailboxes.push({
              x: end.x + ux * back - uy * off * side,
              y: end.y + uy * back + ux * off * side,
              yaw: Math.atan2(-uy, -ux),
              seed: hashString(`${id}:mailbox`),
            });
            mailboxPlaced = true;
          }
        }
      }
    }
  }
  return { paths, mailboxes, mapped, refused, reasons };
}
