import type { DecorLine, DecorPoint, Road, TerrainDataset, Vec2 } from '#sim';
import type { BuildingDesign, BuildingEntrance } from './building-geometry';
import { decorContext, isStreet, roadEdge } from './decor-context';
import { inferPaths, type PathLine } from './decor-paths';
import { DecorSpace } from './decor-space';
import { hashInts, hashString, unit, valueNoise } from './hash';
import { PLANTS, propIndex } from './plant-models';
import type { PropName } from './prop-models';
import { srgbToLinear } from './srgb';
import type { PlacedInstance } from './vegetation-placement';

// The roadside and settlement details of a battlefield (docs/adr/0036):
// paths and driveways, street lamps, utility poles, fences, walls
// and hedges, roadside and garden trees, signs and a little street furniture.
// Decorative only: none of it is an obstacle, cover or concealment, and the
// simulation never sees it. Mapped features (the terrain's `decor`, and the
// roads) come first and constrain what is inferred. Generators run in
// priority order on one shared record of the room taken (decor-space.ts):
//
//   1. roads, buildings and water (the battlefield's own features);
//   2. mapped lamps, power, barriers, trees, signs and furniture;
//   3. entrances and inferred paths and driveways;
//   4. inferred utility poles and street lamps;
//   5. inferred fences and hedges;
//   6. roadside and garden trees, and shrubs;
//   7. small props (mailboxes, signs).
//
// Everything is inferred from context, not invented: lamps only along streets
// in built-up places, poles only along some roads near buildings, trees
// thinning out in towns and industry, never doubling a wood. Every choice
// comes from hashes of ids and positions, and features are taken in id order,
// so the same battlefield always gets the same details. Pure.

/** Bump when the generated details change (independent of the terrain and simulation). */
export const DECOR_VERSION = 2;

export interface DecorStats {
  /** Details by kind and origin (mapped or inferred). */
  readonly counts: Readonly<Record<string, number>>;
  readonly paths: {
    readonly inferred: number;
    readonly mappedAccess: number;
    readonly refused: number;
    readonly reasons: Readonly<Record<string, number>>;
  };
  readonly ms: number;
}

export interface DecorPlan {
  readonly paths: readonly PathLine[];
  /** Plants and props, drawn by the vegetation layer. */
  readonly instances: readonly PlacedInstance[];
  readonly stats: DecorStats;
}

const WHITE: [number, number, number] = [1, 1, 1];
const lin = (hex: number): [number, number, number] => [
  srgbToLinear((hex >> 16) & 255) / srgbToLinear(230),
  srgbToLinear((hex >> 8) & 255) / srgbToLinear(230),
  srgbToLinear(hex & 255) / srgbToLinear(230),
];

type Settlement = 'industrial' | 'town' | 'suburb' | 'rural';

export function planDecor(
  terrain: TerrainDataset,
  designs: ReadonlyMap<string, BuildingDesign>,
  entrances: readonly BuildingEntrance[],
): DecorPlan {
  const started = performance.now();
  const ctx = decorContext(terrain);
  const space = new DecorSpace();
  const instances: PlacedInstance[] = [];
  const counts: Record<string, number> = {};
  const eu = ctx.region === 'central-european';
  const na = ctx.region === 'north-american';
  const count = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const put = (
    name: PropName,
    x: number,
    y: number,
    yaw: number,
    origin: 'mapped' | 'inferred',
    seed: number,
    scaleW = 1,
    scaleH = 1,
    tint: readonly [number, number, number] = WHITE,
  ) => {
    instances.push({ plant: propIndex(name), x, y, yaw, scaleW, scaleH, tint, seed });
    count(`${name}:${origin}`);
  };
  const decor = terrain.decor ?? { points: [], lines: [] };
  const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const points = [...decor.points].sort(byId);
  const lines = [...decor.lines].sort(byId);

  const settlement = (x: number, y: number): Settlement => {
    const n = ctx.builtUp(x, y);
    const lu = ctx.landUse({ x, y })?.kind;
    if ((lu === 'industrial' || lu === 'commercial') && n >= 2) return 'industrial';
    if (n >= 9) return 'town';
    if (n >= 4) return 'suburb';
    return 'rural';
  };
  /** Direction (yaw) from a point to the nearest vehicle road, or 0. */
  const facingRoad = (x: number, y: number) => {
    const r = ctx.nearestRoad(x, y, 60);
    return r && r.distance > 1e-6 ? Math.atan2(r.y - y, r.x - x) : 0;
  };
  /** Whether a post at (x, y) stands clear of buildings, roads (by `margin` past their edge), water and mapped access ways. */
  const standable = (x: number, y: number, margin: number) => {
    if (!ctx.onTerrain(x, y)) return false;
    if (ctx.buildingAt(x, y) >= 0 || ctx.walls.near(x, y, 0.8)) return false;
    const r = ctx.nearestRoad(x, y, 30);
    if (r) {
      const road = ctx.roads[r.road];
      if (road && r.distance < roadEdge(road) + margin) return false;
    }
    if (ctx.access.near(x, y, 0.3)) return false;
    if (ctx.water(x, y, 0.5)) return false;
    return ctx.slope(x, y) < 0.8;
  };

  // --- 2. Mapped features -------------------------------------------------------------

  /** Mapped trees inside vegetation areas are already drawn by the wood or row they are in. */
  const mappedTrees = points.filter((p) => p.kind === 'tree');
  const mappedLamps = points.filter((p) => p.kind === 'streetLamp');
  const supports = points.filter((p) => p.kind === 'powerPole' || p.kind === 'powerTower');

  for (const p of mappedLamps) {
    const { x, y } = p.position;
    if (!standable(x, y, 0.1)) continue;
    const s = settlement(x, y);
    const name: PropName =
      s === 'industrial' ? 'lampIndustrial' : eu ? 'lampVillage' : 'lampResidential';
    put(name, x, y, facingRoad(x, y), 'mapped', hashString(p.id));
    space.addDisc(x, y, 0.4, 'post');
  }

  // Power lines: their supports only (no wires are drawn, docs/adr/0037).
  const supportName = (kind: 'powerLine' | 'minorLine'): PropName =>
    kind === 'powerLine' ? 'pylon' : eu ? 'poleConcrete' : 'poleTimber';
  const usedSupports = new Set<string>();
  /** A support placed for a line: position, yaw (along the line), model. */
  interface Support {
    x: number;
    y: number;
    yaw: number;
    name: PropName;
  }
  const placeSupport = (sp: Support, origin: 'mapped' | 'inferred', seed: number) => {
    put(sp.name, sp.x, sp.y, sp.yaw, origin, seed);
    space.addDisc(sp.x, sp.y, sp.name === 'pylon' ? 4 : 0.5, 'post');
  };

  for (const line of lines.filter((l) => l.kind === 'powerLine' || l.kind === 'minorLine')) {
    const kind = line.kind as 'powerLine' | 'minorLine';
    const pts = line.points;
    pts.forEach((v, i) => {
      const a = pts[Math.max(0, i - 1)] ?? v;
      const b = pts[Math.min(pts.length - 1, i + 1)] ?? v;
      const yaw = Math.atan2(b.y - a.y, b.x - a.x);
      // A mapped support at the vertex, else one drawn there.
      const mappedHere = supports.find(
        (s) => !usedSupports.has(s.id) && Math.hypot(s.position.x - v.x, s.position.y - v.y) < 6,
      );
      if (mappedHere) {
        usedSupports.add(mappedHere.id);
        const sp: Support = {
          x: mappedHere.position.x,
          y: mappedHere.position.y,
          yaw,
          name: mappedHere.kind === 'powerTower' ? 'pylon' : supportName(kind),
        };
        placeSupport(sp, 'mapped', hashString(mappedHere.id));
      } else if (
        ctx.onTerrain(v.x, v.y) &&
        ctx.buildingAt(v.x, v.y) < 0 &&
        !ctx.water(v.x, v.y, 1)
      ) {
        const sp: Support = { x: v.x, y: v.y, yaw, name: supportName(kind) };
        placeSupport(sp, 'mapped', hashString(`${line.id}:${String(i)}`));
      }
    });
  }
  // Mapped supports on no mapped line (their line is outside the query, or unmapped).
  for (const s of supports) {
    if (usedSupports.has(s.id)) continue;
    const { x, y } = s.position;
    if (!ctx.onTerrain(x, y) || ctx.buildingAt(x, y) >= 0) continue;
    const name: PropName = s.kind === 'powerTower' ? 'pylon' : eu ? 'poleConcrete' : 'poleTimber';
    const r = ctx.nearestRoad(x, y, 40);
    placeSupport({ x, y, yaw: r ? Math.atan2(r.dy, r.dx) : 0, name }, 'mapped', hashString(s.id));
  }
  const minorLines = lines.filter((l) => l.kind === 'minorLine');

  // Mapped barriers, in segments along their lines.
  const barrierModel = (l: DecorLine): PropName => {
    if (l.kind === 'guardRail') return 'guardRail';
    const m = l.material ?? '';
    if (l.kind === 'wall') {
      if (/concrete|block/.test(m)) return 'wallConcrete';
      if (/stone|brick|dry_stone/.test(m)) return 'wallStone';
      return eu ? 'wallStone' : 'wallConcrete';
    }
    if (/chain|wire|mesh/.test(m)) return 'fenceChain';
    if (/wood|picket|board|split_rail|pole/.test(m)) return 'fenceWood';
    if (/metal|railing|bars|steel/.test(m)) return 'fenceMetal';
    return eu ? 'fenceMetal' : 'fenceChain';
  };
  /**
   * Segments along a line, each at most 2.4 m (shorter on slopes), skipping
   * those in buildings, on roads or access ways (openings), or in water.
   */
  const segments = (
    pts: readonly Vec2[],
    name: PropName,
    origin: 'mapped' | 'inferred',
    seed: number,
    scaleH: number,
    allow: (x: number, y: number) => boolean,
  ): number => {
    let placed = 0;
    for (let i = 0; i + 1 < pts.length; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.3) continue;
      const rise = Math.abs(ctx.ground(b.x, b.y) - ctx.ground(a.x, a.y));
      const n = Math.max(1, Math.round(len / 2.4), Math.ceil(rise / 0.35));
      const l = len / n;
      const yaw = Math.atan2(b.y - a.y, b.x - a.x);
      for (let k = 0; k < n; k += 1) {
        const t = (k + 0.5) / n;
        const x = a.x + t * (b.x - a.x);
        const y = a.y + t * (b.y - a.y);
        if (!ctx.onTerrain(x, y) || !allow(x, y)) continue;
        put(name, x, y, yaw, origin, hashInts(seed, i * 1000 + k, 0xb1), l / 2.4, scaleH);
        placed += 1;
      }
      space.addSegment(a.x, a.y, b.x, b.y, 0.3, 'barrier');
    }
    return placed;
  };
  const clearOfAccess = (halfGap: number) => (x: number, y: number) => {
    if (ctx.buildingAt(x, y) >= 0) return false;
    const r = ctx.nearestRoad(x, y, 30);
    const road = r ? ctx.roads[r.road] : undefined;
    if (r && road && r.distance < road.widthMeters / 2 + halfGap) return false;
    if (ctx.access.near(x, y, halfGap)) return false;
    if (space.corridorDistance(x, y, halfGap + 0.01, ['path']) < halfGap) return false;
    return !ctx.water(x, y, 0);
  };
  for (const l of lines.filter(
    (x) => x.kind === 'fence' || x.kind === 'wall' || x.kind === 'guardRail',
  )) {
    const name = barrierModel(l);
    const spec = PLANTS[propIndex(name)];
    const h = l.heightMeters && spec ? Math.min(3, Math.max(0.5, l.heightMeters / spec.height)) : 1;
    segments(l.points, name, 'mapped', hashString(l.id), h, clearOfAccess(0.4));
  }

  // Mapped signs and furniture.
  const signModel = (sign: string | undefined): PropName => {
    const s = sign ?? '';
    if (/(^|[;:])(stop|206|r1-1)\b/.test(s)) return 'signStop';
    if (/(^|[;:])(give_way|205|r1-2|yield)\b/.test(s)) return 'signGiveWay';
    return 'signGeneric';
  };
  const placeOffRoad = (p: DecorPoint): { x: number; y: number } | null => {
    let { x, y } = p.position;
    // Signs are often mapped on the road's centreline: stand them at its edge.
    const r = ctx.nearestRoad(x, y, 30);
    const road = r ? ctx.roads[r.road] : undefined;
    if (r && road && r.distance < roadEdge(road) + 0.6) {
      const nx = r.distance > 1e-6 ? (x - r.x) / r.distance : -r.dy;
      const ny = r.distance > 1e-6 ? (y - r.y) / r.distance : r.dx;
      x = r.x + nx * (roadEdge(road) + 0.7);
      y = r.y + ny * (roadEdge(road) + 0.7);
    }
    return ctx.onTerrain(x, y) && ctx.buildingAt(x, y) < 0 && !ctx.water(x, y, 0) ? { x, y } : null;
  };
  for (const p of points) {
    const furniture: Partial<Record<DecorPoint['kind'], PropName>> = {
      trafficSign: signModel(p.sign),
      bench: 'bench',
      wasteBasket: 'bin',
      bollard: 'bollard',
      postBox: 'postBox',
    };
    const name = furniture[p.kind];
    if (!name) continue;
    const at = name === 'bollard' ? p.position : placeOffRoad(p);
    if (!at || !ctx.onTerrain(at.x, at.y)) continue;
    const tint = name === 'postBox' ? lin(na ? 0x2b4c8c : 0xe8b80c) : WHITE;
    const yaw = name.startsWith('sign')
      ? facingRoad(at.x, at.y) + Math.PI / 2
      : facingRoad(at.x, at.y);
    put(name, at.x, at.y, yaw, 'mapped', hashString(p.id), 1, 1, tint);
    space.addDisc(at.x, at.y, 0.5, 'prop');
  }

  // --- 3. Paths and driveways ----------------------------------------------------------

  const pathResult = inferPaths(ctx, space, terrain.features.buildings, designs, entrances);
  for (const m of pathResult.mailboxes) {
    if (!standable(m.x, m.y, 0.3)) continue;
    put('mailbox', m.x, m.y, m.yaw, 'inferred', m.seed);
    space.addDisc(m.x, m.y, 0.4, 'prop');
  }

  // --- 4. Utility poles and street lamps ------------------------------------------------

  /** Walks a road at `spacing`, calling `at` with the point, the unit direction and the distance along. */
  const walk = (
    r: Road,
    spacing: number,
    phase: number,
    at: (x: number, y: number, dx: number, dy: number, s: number) => void,
  ) => {
    let s = phase;
    let base = 0;
    for (let i = 0; i + 1 < r.centerline.length; i += 1) {
      const a = r.centerline[i];
      const b = r.centerline[i + 1];
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      const dx = (b.x - a.x) / len;
      const dy = (b.y - a.y) / len;
      while (s <= base + len) {
        const t = s - base;
        at(a.x + dx * t, a.y + dy * t, dx, dy, s);
        s += spacing;
      }
      base += len;
    }
  };
  const roadLength = (r: Road) =>
    r.centerline.reduce(
      (sum, p, i) =>
        i === 0
          ? 0
          : sum +
            Math.hypot(
              p.x - (r.centerline[i - 1]?.x ?? p.x),
              p.y - (r.centerline[i - 1]?.y ?? p.y),
            ),
      0,
    );
  /** Which side of a road its lamps stand on (+1 left, −1 right); poles take the other. */
  const lampSide = (r: Road) => (unit(hashString(`${r.id}:side`)) < 0.5 ? 1 : -1);

  // Utility poles along some roads near buildings (standalone: no wires, docs/adr/0037).
  const poleShare = na ? 0.7 : eu ? 0.22 : 0.35;
  for (const r of ctx.roads) {
    if (!isStreet(r) || roadLength(r) < 90) continue;
    if (unit(hashString(`${r.id}:poles`)) >= poleShare) continue;
    // Served roads only: buildings along them, and no mapped minor line alongside.
    const mid = r.centerline[Math.floor(r.centerline.length / 2)];
    if (!mid) continue;
    let served = 0;
    walk(r, 40, 0, (x, y) => {
      if (ctx.builtUp(x, y) >= 1) served += 1;
    });
    if (served < 2) continue;
    if (minorLines.some((l) => l.points.some((p) => Math.hypot(p.x - mid.x, p.y - mid.y) < 40)))
      continue;
    const side = -lampSide(r);
    const name: PropName = eu ? 'poleConcrete' : 'poleTimber';
    const spacing = eu ? 48 : 42;
    const offset = roadEdge(r) + 2.2;
    walk(r, spacing, spacing * 0.5 * unit(hashString(`${r.id}:phase`)), (cx, cy, dx, dy, s) => {
      let placed: Support | null = null;
      for (const shift of [0, 3, -3]) {
        const x = cx + dx * shift - dy * side * offset;
        const y = cy + dy * shift + dx * side * offset;
        if (ctx.junctionDistance(cx, cy, 12) < 8) break;
        if (!standable(x, y, 1.2) || ctx.nearWoodland(x, y, 4)) continue;
        if (!space.free(x, y, 0.8, ['post', 'path', 'entrance', 'prop', 'barrier'])) continue;
        placed = { x, y, yaw: Math.atan2(dy, dx), name };
        break;
      }
      if (!placed) return;
      placeSupport(placed, 'inferred', hashInts(hashString(r.id), Math.round(s), 0x9a));
    });
  }

  // Street lamps along streets in built-up places, where none are mapped near.
  const lampMapped = (x: number, y: number, d: number) =>
    mappedLamps.some((p) => Math.hypot(p.position.x - x, p.position.y - y) < d);
  for (const r of ctx.roads) {
    if (!isStreet(r) || r.roadClass === 'unpaved') continue;
    const side = lampSide(r);
    const major = r.roadClass === 'major';
    const phase = 20 * unit(hashString(`${r.id}:lamps`));
    walk(r, major ? 42 : eu ? 31 : 44, phase, (cx, cy, dx, dy) => {
      const s = settlement(cx, cy);
      if (s === 'rural') return;
      if (
        s === 'suburb' &&
        !major &&
        unit(hashInts(Math.round(cx), Math.round(cy), 0x3c)) < (na ? 0.25 : 0.1)
      )
        return;
      if (ctx.junctionDistance(cx, cy, 14) < 10) return;
      if (lampMapped(cx, cy, 30)) return;
      const name: PropName =
        s === 'industrial'
          ? 'lampIndustrial'
          : major
            ? 'lampModern'
            : eu
              ? 'lampVillage'
              : 'lampResidential';
      const offset = roadEdge(r) + 0.7;
      for (const shift of [0, 4, -4]) {
        const x = cx + dx * shift - dy * side * offset;
        const y = cy + dy * shift + dx * side * offset;
        if (!standable(x, y, 0.5) || ctx.junctionDistance(x, y, 14) < 10) continue;
        if (!space.free(x, y, 1.2, ['post', 'path', 'entrance', 'prop', 'barrier'])) continue;
        // The arm reaches over the road.
        put(
          name,
          x,
          y,
          Math.atan2(-dx * side, dy * side),
          'inferred',
          hashInts(Math.round(x * 10), Math.round(y * 10), 0x1a),
        );
        space.addDisc(x, y, 0.4, 'post');
        return;
      }
    });
  }

  // --- 5. Front-garden fences and hedges ------------------------------------------------

  const gardenShare = eu ? 0.45 : na ? 0.12 : 0.25;
  const doors = entrances.filter((e) => e.kind === 'door');
  for (const e of [...doors].sort((a, b) => (a.buildingId < b.buildingId ? -1 : 1))) {
    const design = designs.get(e.buildingId);
    if (design?.style.category !== 'residential') continue;
    const u = unit(hashString(`${e.buildingId}:garden`));
    if (u >= gardenShare) continue;
    if (ctx.builtUp(e.x, e.y) < 3) continue;
    const r = ctx.nearestRoad(e.x, e.y, 25);
    const road = r ? ctx.roads[r.road] : undefined;
    if (!r || !road || !isStreet(road)) continue;
    const off = roadEdge(road) + 0.9;
    if (r.distance < off + 3) continue;
    // Along the road, in front of the building: the footprint's extent along the road.
    const b = terrain.features.buildings.find((x) => x.id === e.buildingId);
    if (!b) continue;
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const p of b.footprint) {
      const t = (p.x - r.x) * r.dx + (p.y - r.y) * r.dy;
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t);
    }
    // Which side of the road the building is on.
    const nx = (e.x - r.x) / r.distance;
    const ny = (e.y - r.y) / r.distance;
    const side = nx * -r.dy + ny * r.dx > 0 ? 1 : -1;
    const ox = -r.dy * side * off;
    const oy = r.dx * side * off;
    const pts = [
      { x: r.x + r.dx * (t0 - 1.5) + ox, y: r.y + r.dy * (t0 - 1.5) + oy },
      { x: r.x + r.dx * (t1 + 1.5) + ox, y: r.y + r.dy * (t1 + 1.5) + oy },
    ];
    const v = unit(hashString(`${e.buildingId}:gardenkind`));
    const name: PropName = eu
      ? v < 0.5
        ? 'hedge'
        : v < 0.75
          ? 'fenceMetal'
          : 'fenceWood'
      : v < 0.5
        ? 'fenceWood'
        : 'hedge';
    segments(
      pts,
      name,
      'inferred',
      hashString(`${e.buildingId}:garden`),
      name === 'fenceWood' && na ? 0.8 : 1,
      (x, y) => {
        if (!clearOfAccess(0.9)(x, y)) return false;
        if (ctx.walls.near(x, y, 0.8)) return false;
        if (ctx.junctionDistance(x, y, 10) < 8) return false;
        // Never across another fence, a post or a doorway.
        if (space.corridorDistance(x, y, 1.2, ['barrier']) < 1.2) return false;
        return space.free(x, y, 0.6, ['post', 'entrance', 'prop']);
      },
    );
  }

  // --- 6. Trees and shrubs --------------------------------------------------------------

  const broadleaf = [0, 1, 2]; // oak, beech, lime
  const treeIndex = (x: number, y: number, h: number, allowConifer: boolean): number => {
    const patch = (valueNoise(x, y, 90, 0xd1) + 1) / 2;
    const pick = unit(hashInts(h, 1, 0xd2)) < 0.75 ? patch : unit(hashInts(h, 2, 0xd2));
    if (allowConifer && unit(hashInts(h, 3, 0xd2)) < (na ? 0.15 : 0.1)) return na ? 4 : 3; // pine, spruce
    if (unit(hashInts(h, 4, 0xd2)) < 0.12) return 5; // a young tree
    // Lime and oak along central European roads; oak and lime (for maple) and beech in North America.
    const order = eu ? [2, 0, 1] : [0, 2, 1];
    return order[Math.min(2, Math.floor(pick * 3))] ?? broadleaf[0] ?? 0;
  };
  const tintFor = (seed: number, x: number, y: number): [number, number, number] => {
    const bright =
      (0.88 + 0.22 * unit(hashInts(seed, 2, 0x78))) * (1 + 0.07 * valueNoise(x, y, 45, 0x79));
    const warm = (unit(hashInts(seed, 3, 0x78)) - 0.5) * 0.12;
    return [bright * (1 + warm), bright, bright * (1 - warm)];
  };
  const plantTree = (
    plant: number,
    x: number,
    y: number,
    heightShare: number,
    seed: number,
    origin: 'mapped' | 'inferred',
    label: string,
  ) => {
    const spec = PLANTS[plant];
    if (!spec) return;
    const sh = heightShare;
    const sw = sh * (0.88 + 0.24 * unit(hashInts(seed, 5, 0xd3)));
    instances.push({
      plant,
      x,
      y,
      yaw: unit(hashInts(seed, 1, 0xd3)) * Math.PI * 2,
      scaleW: sw,
      scaleH: sh,
      tint: tintFor(seed, x, y),
      seed,
    });
    count(`${label}:${origin}`);
    space.addDisc(x, y, Math.max(2.2, spec.crown * sw * 0.55), 'tree');
  };

  for (const p of mappedTrees) {
    const { x, y } = p.position;
    if (!ctx.onTerrain(x, y) || ctx.inVegetation(x, y)) continue;
    if (ctx.buildingAt(x, y) >= 0 || ctx.water(x, y, 0)) continue;
    const r = ctx.nearestRoad(x, y, 20);
    const road = r ? ctx.roads[r.road] : undefined;
    if (r && road && r.distance < road.widthMeters / 2) continue;
    const seed = hashString(p.id);
    const plant = p.leafType === 'needleleaved' ? (na ? 4 : 3) : treeIndex(x, y, seed, false);
    const spec = PLANTS[plant];
    const share =
      p.heightMeters && spec ? Math.min(1.6, Math.max(0.3, p.heightMeters / spec.height)) : 0.75;
    plantTree(plant, x, y, share, seed, 'mapped', 'tree');
  }

  for (const r of ctx.roads) {
    if (r.highway === 'service' || r.roadClass === 'track') continue;
    const rh = hashString(r.id);
    const major = r.roadClass === 'major';
    // Some rural roads are lined with trees for a stretch (planted, but never perfectly regular).
    const avenue = unit(hashInts(rh, 7, 0xd4)) < (eu ? 0.18 : 0.05);
    for (const side of [1, -1]) {
      walk(r, avenue ? 13 : 8, 6 * unit(hashInts(rh, side, 0xd5)), (cx, cy, dx, dy, s) => {
        const h = hashInts(rh, Math.round(s * 10) * 2 + (side > 0 ? 1 : 0), 0xd6);
        const kind = settlement(cx, cy);
        if (ctx.nearWoodland(cx, cy, 25)) return; // the wood dominates
        let p: number;
        const patch = valueNoise(cx, cy, 160, 0xd7);
        if (kind === 'industrial') p = 0.04;
        else if (kind === 'town') p = na ? 0.22 : 0.12;
        else if (kind === 'suburb') p = na ? 0.3 : 0.2;
        else if (avenue && patch > -0.1) p = 0.8;
        else p = Math.max(0, 0.45 * (patch + 0.15));
        if (major) p *= 0.6;
        if (unit(hashInts(h, 1, 0xd8)) >= p) return;
        if (ctx.junctionDistance(cx, cy, 14) < 11) return;
        const along = (unit(hashInts(h, 2, 0xd8)) - 0.5) * (avenue ? 2 : 5);
        const offset =
          roadEdge(r) + (major ? 6 : 2.4) + (avenue ? 0.8 : 3) * unit(hashInts(h, 3, 0xd8));
        const x = cx + dx * along - dy * side * offset;
        const y = cy + dy * along + dx * side * offset;
        if (!ctx.onTerrain(x, y) || ctx.inVegetation(x, y) || ctx.slope(x, y) > 0.6) return;
        const plant = avenue ? (eu ? 2 : 0) : treeIndex(x, y, h, kind === 'rural');
        const spec = PLANTS[plant];
        if (!spec) return;
        const share = (avenue ? 0.7 : 0.55) + 0.35 * unit(hashInts(h, 4, 0xd8));
        const crown = spec.crown * share;
        if (ctx.exclusions.reason(x, y, crown) !== null) return;
        if (!space.free(x, y, crown * 0.6, ['post'])) return;
        if (!space.free(x, y, 1 + crown * 0.25, ['path', 'barrier'])) return;
        if (!space.free(x, y, 1.2, ['entrance', 'prop'])) return;
        if (!space.free(x, y, Math.max(1.5, crown * 0.6), ['tree'])) return;
        plantTree(plant, x, y, share, h, 'inferred', 'roadsideTree');
      });
    }
  }

  // Around buildings: shrubs by the door, a garden tree behind houses, trees at institutions and farms.
  const buildingsById = new Map(terrain.features.buildings.map((b) => [b.id, b]));
  for (const e of [...doors].sort((a, b) => (a.buildingId < b.buildingId ? -1 : 1))) {
    const design = designs.get(e.buildingId);
    const b = buildingsById.get(e.buildingId);
    if (!design || !b) continue;
    const cat = design.style.category;
    const h = hashString(`${e.buildingId}:garden-plants`);
    const tx = -e.ny;
    const ty = e.nx;
    if (cat === 'residential') {
      const shrubs = 1 + Math.floor(unit(hashInts(h, 1, 0xe1)) * (eu ? 4 : 3));
      for (let k = 0; k < shrubs; k += 1) {
        const along =
          (k % 2 === 0 ? 1 : -1) * (2.2 + 1.6 * Math.floor(k / 2) + unit(hashInts(h, k, 0xe2)));
        const out = 0.9 + 0.4 * unit(hashInts(h, k, 0xe3));
        const x = e.x + tx * along + e.nx * out;
        const y = e.y + ty * along + e.ny * out;
        if (!ctx.onTerrain(x, y) || ctx.buildingAt(x, y) >= 0 || ctx.walls.near(x, y, 0.5))
          continue;
        if (ctx.water(x, y, 0.5) || ctx.inVegetation(x, y)) continue;
        if (!space.free(x, y, 0.6, ['path', 'entrance', 'post', 'barrier', 'prop'])) continue;
        const r = ctx.nearestRoad(x, y, 20);
        const road = r ? ctx.roads[r.road] : undefined;
        if (r && road && r.distance < roadEdge(road) + 0.8) continue;
        const plant = unit(hashInts(h, k, 0xe4)) < 0.6 ? 7 : 8;
        const sh = 0.45 + 0.35 * unit(hashInts(h, k, 0xe5));
        instances.push({
          plant,
          x,
          y,
          yaw: unit(hashInts(h, k, 0xe6)) * Math.PI * 2,
          scaleW: sh * 0.9,
          scaleH: sh,
          tint: tintFor(hashInts(h, k, 0xe7), x, y),
          seed: hashInts(h, k, 0xe7),
        });
        count('gardenShrub:inferred');
        space.addDisc(x, y, 0.5, 'prop');
      }
    }
    const treeShare =
      cat === 'residential'
        ? eu
          ? 0.55
          : 0.5
        : cat === 'institutional'
          ? 0.5
          : cat === 'agricultural'
            ? 0.4
            : 0;
    if (unit(hashInts(h, 9, 0xe8)) >= treeShare) continue;
    // Behind the house (houses), or to one side in front (institutions, farms); some gardens have two.
    const trees = cat === 'residential' && unit(hashInts(h, 14, 0xe8)) < 0.35 ? 2 : 1;
    let cx = 0;
    let cy = 0;
    for (const p of b.footprint) {
      cx += p.x;
      cy += p.y;
    }
    cx /= b.footprint.length;
    cy /= b.footprint.length;
    let depth = 0;
    for (const p of b.footprint)
      depth = Math.max(depth, Math.abs((p.x - cx) * e.nx + (p.y - cy) * e.ny));
    const behind = cat === 'residential';
    for (let k = 0; k < trees; k += 1) {
      const hk = hashInts(h, k, 0xe9);
      const dist = depth + 5 + 4 * unit(hashInts(hk, 10, 0xe8));
      const sideways = (unit(hashInts(hk, 11, 0xe8)) - 0.5) * 8 + (behind ? (k === 0 ? -2 : 4) : 6);
      const x = cx + (behind ? -e.nx : e.nx) * dist + tx * sideways;
      const y = cy + (behind ? -e.ny : e.ny) * dist + ty * sideways;
      if (!ctx.onTerrain(x, y) || ctx.inVegetation(x, y)) continue;
      const plant =
        cat === 'residential' && unit(hashInts(hk, 12, 0xe8)) < 0.35
          ? 5
          : treeIndex(x, y, hk, false);
      const spec = PLANTS[plant];
      if (!spec) continue;
      const share = (plant === 5 ? 0.75 : 0.55) + 0.3 * unit(hashInts(hk, 13, 0xe8));
      const crown = spec.crown * share;
      if (ctx.exclusions.reason(x, y, crown) !== null) continue;
      if (!space.free(x, y, crown * 0.6, ['post', 'tree'])) continue;
      if (!space.free(x, y, 1 + crown * 0.25, ['path', 'barrier', 'entrance'])) continue;
      plantTree(plant, x, y, share, hk, 'inferred', 'gardenTree');
    }
  }

  // --- 7. Give-way signs where minor streets join main roads ----------------------------

  const mappedSignNear = (x: number, y: number) =>
    points.some(
      (p) => p.kind === 'trafficSign' && Math.hypot(p.position.x - x, p.position.y - y) < 25,
    );
  for (const j of ctx.junctions) {
    // The roads meeting here.
    const here: number[] = [];
    for (let k = 0; k < 6; k += 1) {
      const r = ctx.nearestRoad(j.x, j.y, 1, (o) => !here.includes(o));
      if (!r) break;
      here.push(r.road);
    }
    const major = here.map((i) => ctx.roads[i]).find((x) => x?.roadClass === 'major');
    if (!major || mappedSignNear(j.x, j.y)) continue;
    for (const ri of here) {
      const r = ctx.roads[ri];
      if (!r || r.roadClass === 'major' || !isStreet(r)) continue;
      // Only a road that ends here arrives here: its approach, from its neighbouring point.
      const pts = r.centerline;
      const first = pts[0];
      const last = pts[pts.length - 1];
      const from =
        first && Math.hypot(first.x - j.x, first.y - j.y) < 1
          ? pts[1]
          : last && Math.hypot(last.x - j.x, last.y - j.y) < 1
            ? pts[pts.length - 2]
            : undefined;
      if (!from) continue;
      const len = Math.hypot(j.x - from.x, j.y - from.y);
      if (len < 8) continue;
      const tx = (j.x - from.x) / len;
      const ty = (j.y - from.y) / len;
      const back = roadEdge(major) + 3;
      const off = roadEdge(r) + 0.8;
      // On the right of traffic arriving at the junction.
      const x = j.x - tx * back + ty * off;
      const y = j.y - ty * back - tx * off;
      if (!standable(x, y, 0.4) || !space.free(x, y, 0.8, ['post', 'path', 'prop', 'entrance'])) {
        continue;
      }
      // The plate faces arriving drivers.
      put(
        'signGiveWay',
        x,
        y,
        Math.atan2(-ty, -tx),
        'inferred',
        hashInts(Math.round(x * 10), Math.round(y * 10), 0x5e),
      );
      space.addDisc(x, y, 0.5, 'prop');
    }
  }

  return {
    paths: pathResult.paths,
    instances,
    stats: {
      counts,
      paths: {
        inferred: pathResult.paths.length,
        mappedAccess: pathResult.mapped,
        refused: pathResult.refused,
        reasons: pathResult.reasons,
      },
      ms: performance.now() - started,
    },
  };
}
