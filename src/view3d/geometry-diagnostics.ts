import { heightAt, planBridges, type Road, type TerrainDataset } from '#sim';
import {
  coordinateBridges,
  LOW_DECK_M,
  roadEntrances,
  type CoordinatedBridges,
} from './bridge-complexes';
import { bridgeGeometry, liftOntoBridges, type BridgeGeometry } from './bridges';
import { createDraper, type MeshData } from './drape';
import { roadSurfaces, type RoadLayer } from './road-geometry';
import { onSurface, roadLevel } from './road-surface';

// Geometry diagnostics (docs/adr/0044): automated checks for the defects
// complex battlefields used to show, reusable on any battlefield (see
// src/view3d/diagnose.cli.test.ts). Each warning names the features, where they
// are and why; warnings are classified, so that intended contacts (a road
// meeting a bridge at its end, a structure of several decks, a road under a
// bridge) are not reported as defects:
//
// - `roadOverlap`: two road surface layers covering the same spot at the same
//   height (unexpected; at different heights it is a grade separation);
// - `duplicateDeck`: decks that overlap at similar heights but are drawn as
//   separate structures (unexpected; in one structure they are expected);
// - `barrierOnRoad`: a bridge barrier standing on another road's surface, or
//   on another deck of its structure (unexpected);
// - `pierOnRoad`: a pier standing on a road's surface (unexpected);
// - `lowDeck`: a deck less than `LOW_DECK_M` above the water under it (a
//   limitation of the elevation data, reported, not an error);
// - `deckStep`: a deck end more than `STEP_M` from the road it meets (unexpected);
// - `invalidVertex` / `degenerateTriangle`: non-finite positions, or triangles
//   with no area, in a mesh (unexpected).

export type WarningKind =
  | 'roadOverlap'
  | 'duplicateDeck'
  | 'barrierOnRoad'
  | 'pierOnRoad'
  | 'lowDeck'
  | 'deckStep'
  | 'invalidVertex'
  | 'degenerateTriangle';

export interface GeometryWarning {
  readonly kind: WarningKind;
  /** Whether it is a defect (`unexpected`), or a reported limitation of the data. */
  readonly severity: 'unexpected' | 'limitation';
  /** The features involved (roads, bridges, meshes). */
  readonly ids: readonly string[];
  /** Where, in map metres, and (with a georeference) in degrees. */
  readonly x: number;
  readonly y: number;
  readonly lat?: number;
  readonly lon?: number;
  readonly reason: string;
}

export interface DiagnosticsReport {
  readonly warnings: readonly GeometryWarning[];
  /** Warnings by kind. */
  readonly counts: Readonly<Partial<Record<WarningKind, number>>>;
  /** Intended contacts seen and not reported, by kind (e.g. decks merged into one structure). */
  readonly expected: Readonly<Record<string, number>>;
}

/** A deck end further than this from its road's surface is a step, metres. */
export const STEP_M = 0.15;
/** Surfaces closer than this in height at one spot overlap; further apart they are grade-separated, metres. */
const SAME_HEIGHT_M = 0.5;

export interface DiagnosticsOptions {
  /** Map metres to degrees, for the report. */
  readonly toLatLon?: (x: number, y: number) => { lat: number; lon: number } | null;
  /** Only report within this box (map metres). */
  readonly within?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Distance between road sample points along each road, metres (default 2). */
  readonly sampleStepM?: number;
  /** Which checks to run (default all): road overlaps, bridges, mesh integrity. */
  readonly checks?: readonly ('roads' | 'bridges' | 'meshes')[];
}

/** Runs every check on a terrain's roads and bridges as the 3D view builds them. */
export function diagnoseGeometry(
  terrain: TerrainDataset,
  options: DiagnosticsOptions = {},
): DiagnosticsReport {
  const draper = createDraper(terrain);
  const roads = roadSurfaces(terrain.features.roads, draper);
  const plan = planBridges(terrain);
  const coordinated = coordinateBridges(plan.bridges);
  const ground = (x: number, y: number) => heightAt(terrain, x, y);
  const structure = bridgeGeometry(coordinated.decks, ground, {
    coordinated,
    roadEntrance: roadEntrances(terrain.features.roads, coordinated),
  });
  // The road surfaces as drawn: lifted onto the decks.
  const lifted = new Map(
    [...roads.layers].map(([layer, mesh]) => [
      layer,
      liftOntoBridges(mesh, coordinated.index, ground),
    ]),
  );
  const run = (check: 'roads' | 'bridges' | 'meshes') => options.checks?.includes(check) ?? true;
  return report(
    [
      ...(run('roads')
        ? roadOverlaps(terrain.features.roads, lifted, options.sampleStepM ?? 2)
        : []),
      ...(run('bridges') ? bridgeChecks(terrain, coordinated, structure) : []),
      ...(run('meshes')
        ? [
            ...[...lifted].flatMap(([layer, mesh]) => meshIntegrity(`roads:${layer}`, mesh)),
            ...meshIntegrity('bridges', structure.mesh),
          ]
        : []),
    ],
    coordinated,
    options,
  );
}

function report(
  found: readonly GeometryWarning[],
  coordinated: CoordinatedBridges,
  options: DiagnosticsOptions,
): DiagnosticsReport {
  const box = options.within;
  const warnings = found
    .filter(
      (w) => !box || (w.x >= box.minX && w.x <= box.maxX && w.y >= box.minY && w.y <= box.maxY),
    )
    .map((w) => {
      const ll = options.toLatLon?.(w.x, w.y);
      return ll ? { ...w, lat: ll.lat, lon: ll.lon } : w;
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.x - b.x || a.y - b.y);
  const counts: Partial<Record<WarningKind, number>> = {};
  for (const w of warnings) counts[w.kind] = (counts[w.kind] ?? 0) + 1;
  const shared = coordinated.complexes.filter((c) => c.members.length > 1);
  return {
    warnings,
    counts,
    expected: {
      decksInSharedStructures: shared.reduce((s, c) => s + c.members.length, 0),
      sharedStructures: shared.length,
    },
  };
}

/** Non-finite positions and triangles with no area in a mesh. */
export function meshIntegrity(id: string, mesh: MeshData): GeometryWarning[] {
  const out: GeometryWarning[] = [];
  const p = mesh.positions;
  let invalid = 0;
  let degenerate = 0;
  let first: { x: number; y: number } | null = null;
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const o = 9 * t;
    let finite = true;
    for (let k = 0; k < 9; k += 1) if (!Number.isFinite(p[o + k] ?? NaN)) finite = false;
    if (!finite) {
      invalid += 1;
      continue;
    }
    const ux = (p[o + 3] ?? 0) - (p[o] ?? 0);
    const uy = (p[o + 4] ?? 0) - (p[o + 1] ?? 0);
    const uz = (p[o + 5] ?? 0) - (p[o + 2] ?? 0);
    const wx = (p[o + 6] ?? 0) - (p[o] ?? 0);
    const wy = (p[o + 7] ?? 0) - (p[o + 1] ?? 0);
    const wz = (p[o + 8] ?? 0) - (p[o + 2] ?? 0);
    const area = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    if (area < 1e-10) {
      degenerate += 1;
      first ??= { x: p[o] ?? 0, y: -(p[o + 2] ?? 0) };
    }
  }
  if (invalid > 0)
    out.push({
      kind: 'invalidVertex',
      severity: 'unexpected',
      ids: [id],
      x: 0,
      y: 0,
      reason: `${String(invalid)} triangles with non-finite positions`,
    });
  if (degenerate > 0 && first)
    out.push({
      kind: 'degenerateTriangle',
      severity: 'unexpected',
      ids: [id],
      x: first.x,
      y: first.y,
      reason: `${String(degenerate)} triangles with no area (the first here)`,
    });
  return out;
}

/** Triangles of a mesh, bucketed in plan for point queries. */
function triangleIndex(mesh: MeshData) {
  const BUCKET = 8;
  const p = mesh.positions;
  const counts = new Map<number, number>();
  const keys: number[][] = [];
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const o = 9 * t;
    const xs = [p[o] ?? 0, p[o + 3] ?? 0, p[o + 6] ?? 0];
    const ys = [-(p[o + 2] ?? 0), -(p[o + 5] ?? 0), -(p[o + 8] ?? 0)];
    const ks: number[] = [];
    for (
      let gx = Math.floor(Math.min(...xs) / BUCKET);
      gx <= Math.floor(Math.max(...xs) / BUCKET);
      gx += 1
    )
      for (
        let gy = Math.floor(Math.min(...ys) / BUCKET);
        gy <= Math.floor(Math.max(...ys) / BUCKET);
        gy += 1
      ) {
        const k = gx * 100_003 + gy;
        ks.push(k);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    keys.push(ks);
  }
  const lists = new Map<number, number[]>();
  keys.forEach((ks, t) => {
    for (const k of ks) {
      const list = lists.get(k);
      if (list) list.push(t);
      else lists.set(k, [t]);
    }
  });
  /** The heights of the triangles covering (x, y). */
  return (x: number, y: number): number[] => {
    const out: number[] = [];
    for (const t of lists.get(Math.floor(x / BUCKET) * 100_003 + Math.floor(y / BUCKET)) ?? []) {
      const o = 9 * t;
      const ax = p[o] ?? 0;
      const ay = -(p[o + 2] ?? 0);
      const bx = p[o + 3] ?? 0;
      const by = -(p[o + 5] ?? 0);
      const cx = p[o + 6] ?? 0;
      const cy = -(p[o + 8] ?? 0);
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(det) < 1e-12) continue;
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
      const l3 = 1 - l1 - l2;
      // Strictly inside: points on shared edges are where two pieces meet, not overlap.
      if (l1 > 1e-4 && l2 > 1e-4 && l3 > 1e-4)
        out.push(l1 * (p[o + 1] ?? 0) + l2 * (p[o + 4] ?? 0) + l3 * (p[o + 7] ?? 0));
    }
    return out;
  };
}

/**
 * Road surface layers covering one spot at the same height: sampled along
 * every road, across its width, every `step` metres. Layers at clearly
 * different heights there are grade-separated and not reported.
 */
export function roadOverlaps(
  roads: readonly Road[],
  layers: ReadonlyMap<RoadLayer, MeshData>,
  step: number,
): GeometryWarning[] {
  const indices = [...layers].map(([layer, mesh]) => [layer, triangleIndex(mesh)] as const);
  const out: GeometryWarning[] = [];
  const seen = new Set<string>();
  for (const road of [...roads].filter(onSurface).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const h = road.widthMeters / 2;
    for (let i = 0; i + 1 < road.centerline.length; i += 1) {
      const a = road.centerline[i];
      const b = road.centerline[i + 1];
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      const nx = -(b.y - a.y) / len;
      const ny = (b.x - a.x) / len;
      for (let s = step / 2; s < len; s += step) {
        for (const f of [-0.8, 0, 0.8]) {
          const x = a.x + ((b.x - a.x) * s) / len + nx * h * f;
          const y = a.y + ((b.y - a.y) * s) / len + ny * h * f;
          const hits = indices.flatMap(([layer, at]) => at(x, y).map((z) => ({ layer, z })));
          for (let u = 0; u < hits.length; u += 1)
            for (let v = u + 1; v < hits.length; v += 1) {
              const p = hits[u];
              const q = hits[v];
              if (!p || !q || p.layer === q.layer || Math.abs(p.z - q.z) > SAME_HEIGHT_M) continue;
              const k = `${road.id}:${p.layer}:${q.layer}:${String(Math.round(x / 10))},${String(Math.round(y / 10))}`;
              if (seen.has(k)) continue;
              seen.add(k);
              out.push({
                kind: 'roadOverlap',
                severity: 'unexpected',
                ids: [road.id, `${p.layer}/${q.layer}`],
                x,
                y,
                reason: `${p.layer} and ${q.layer} surfaces both cover this point of ${road.id} at the same height`,
              });
            }
        }
      }
    }
  }
  return out;
}

/** Duplicate decks, barriers and piers on roads, low decks and steps at deck ends. */
function bridgeChecks(
  terrain: TerrainDataset,
  coordinated: CoordinatedBridges,
  structure: BridgeGeometry,
): GeometryWarning[] {
  const out: GeometryWarning[] = [];
  const { decks, complexOf } = coordinated;
  const byId = new Map(decks.map((d, i) => [d.id, i]));
  // Decks overlapping at similar heights but drawn as separate structures.
  const boxes = decks.map((b) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < b.xy.length; i += 2) {
      minX = Math.min(minX, (b.xy[i] ?? 0) - b.halfWidth);
      maxX = Math.max(maxX, (b.xy[i] ?? 0) + b.halfWidth);
      minY = Math.min(minY, (b.xy[i + 1] ?? 0) - b.halfWidth);
      maxY = Math.max(maxY, (b.xy[i + 1] ?? 0) + b.halfWidth);
    }
    return { minX, minY, maxX, maxY };
  });
  const reported = new Set<string>();
  decks.forEach((b, bi) => {
    const bb = boxes[bi];
    const candidates = decks.flatMap((o, oi) => {
      const ob = boxes[oi];
      return oi > bi &&
        complexOf[oi] !== complexOf[bi] &&
        bb &&
        ob &&
        bb.minX < ob.maxX &&
        ob.minX < bb.maxX &&
        bb.minY < ob.maxY &&
        ob.minY < bb.maxY
        ? [[o, oi] as const]
        : [];
    });
    if (candidates.length === 0) return;
    for (let k = 0; k < b.deck.length; k += 3) {
      const x = b.xy[2 * k] ?? 0;
      const y = b.xy[2 * k + 1] ?? 0;
      candidates.forEach(([o, oi]) => {
        const pair = `${String(bi)}:${String(oi)}`;
        if (reported.has(pair)) return;
        for (let j = 0; j < o.deck.length; j += 1) {
          const ox = o.xy[2 * j] ?? 0;
          const oy = o.xy[2 * j + 1] ?? 0;
          if (
            Math.abs(ox - x) > o.halfWidth + b.halfWidth ||
            Math.abs(oy - y) > o.halfWidth + b.halfWidth
          )
            continue;
          if (
            Math.hypot(ox - x, oy - y) < Math.min(o.halfWidth, b.halfWidth) &&
            Math.abs((o.deck[j] ?? 0) - (b.deck[k] ?? 0)) < SAME_HEIGHT_M
          ) {
            out.push({
              kind: 'duplicateDeck',
              severity: 'unexpected',
              ids: [b.id, o.id],
              x,
              y,
              reason: 'two decks overlap at the same height but are drawn as separate structures',
            });
            reported.add(pair);
            return;
          }
        }
      });
    }
  });
  // Roads as segments, for the barrier and pier checks.
  const roads = terrain.features.roads.filter(onSurface);
  const onRoad = (x: number, y: number, except: ReadonlySet<string>, levels: ReadonlySet<string>) =>
    roads.find((r) => {
      if (except.has(r.id) || !levels.has(roadLevel(r))) return false;
      for (let i = 0; i + 1 < r.centerline.length; i += 1) {
        const a = r.centerline[i];
        const c = r.centerline[i + 1];
        if (!a || !c) continue;
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
        if (Math.hypot(x - a.x - t * dx, y - a.y - t * dy) < r.widthMeters / 2 - 0.2) return true;
      }
      return false;
    });
  const structureRoads = (deck: number) => {
    const c = coordinated.complexes[complexOf[deck] ?? -1];
    const ids = new Set((c?.members ?? [deck]).flatMap((m) => decks[m]?.roadIds ?? []));
    const levels = new Set(
      terrain.features.roads.filter((r) => ids.has(r.id)).map((r) => roadLevel(r)),
    );
    return { ids, levels };
  };
  // Barriers standing on a road joining the bridge, or inside the structure.
  for (const run of structure.barriers) {
    const bi = byId.get(run.deck) ?? -1;
    const { ids, levels } = structureRoads(bi);
    for (let k = 0; k + 1 < run.points.length; k += 2) {
      const x = run.points[k] ?? 0;
      const y = run.points[k + 1] ?? 0;
      const road = onRoad(x, y, ids, levels);
      const inside = coordinated.onOtherDeck(bi, x, y, 0);
      if (!road && !inside) continue;
      out.push({
        kind: 'barrierOnRoad',
        severity: 'unexpected',
        ids: [run.deck, road?.id ?? 'another deck of its structure'],
        x,
        y,
        reason: road
          ? `a barrier of ${run.deck} stands across ${road.id}`
          : `a barrier of ${run.deck} stands inside its own structure`,
      });
      break;
    }
  }
  // Piers standing on a road.
  for (const pier of structure.pierAt) {
    const bi = byId.get(pier.deck) ?? -1;
    const { ids } = structureRoads(bi);
    const road = onRoad(pier.x, pier.y, ids, new Set(roads.map(roadLevel)));
    if (road)
      out.push({
        kind: 'pierOnRoad',
        severity: 'unexpected',
        ids: [pier.deck, road.id],
        x: pier.x,
        y: pier.y,
        reason: `a pier of ${pier.deck} stands on ${road.id}`,
      });
  }
  // Low decks and steps at the ends.
  decks.forEach((b) => {
    let worst = Infinity;
    let at = 0;
    b.wet.forEach((w, k) => {
      const clear = (b.deck[k] ?? 0) - (b.under[k] ?? 0);
      if (w && clear < worst) {
        worst = clear;
        at = k;
      }
    });
    if (worst < LOW_DECK_M)
      out.push({
        kind: 'lowDeck',
        severity: 'limitation',
        ids: [b.id],
        x: b.xy[2 * at] ?? 0,
        y: b.xy[2 * at + 1] ?? 0,
        reason: `the deck is ${worst.toFixed(2)} m above the water (the elevation data leaves no room for clearance); the water is cut away beneath it`,
      });
    for (const k of [0, b.deck.length - 1]) {
      const x = b.xy[2 * k] ?? 0;
      const y = b.xy[2 * k + 1] ?? 0;
      const step = (b.deck[k] ?? 0) - heightAt(terrain, x, y);
      if (Math.abs(step) > STEP_M)
        out.push({
          kind: 'deckStep',
          severity: 'unexpected',
          ids: [b.id],
          x,
          y,
          reason: `the deck's end is ${step.toFixed(2)} m from the road it meets`,
        });
    }
  });
  return out;
}
