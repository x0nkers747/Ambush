import { END_BLEND_M, MAX_GRADE, type Bridge, type BridgeIndex, type Road } from '#sim';
import { finishMesh, meshBuffers, type MeshData } from './drape';
import { Occupancy, signedArea2 } from './planar';
import { onSurface, roadLevel } from './road-surface';

// Bridge complexes (docs/adr/0044). OpenStreetMap often maps one physical
// bridge as several ways side by side, each a bridge: the carriageway, a
// tram or bus lane, cycle tracks and footways. The simulation plans a deck for
// each (`planBridges`, unchanged); drawn independently they overlap, each
// with its own slab, parapets and piers, at slightly different heights. Here,
// for display only, decks whose footprints overlap (or nearly touch) at
// similar heights are one structure:
//
// - one deck surface: the structure's spine (its widest deck) keeps its
//   heights, lowered where needed so that it meets the ground wherever
//   another deck of the structure ends on it (as the plan pins each deck to
//   its road at its own ends); every other deck takes the height of the deck
//   it lies on, and ramps back to its own over a few metres beyond that
//   deck's edge, so the structure is flat across, continuous, and each deck
//   keeps its own height where it is alone;
// - slabs, barriers, abutments and piers drawn for the structure, not for
//   each deck (see bridges.ts).
//
// Decks that cross at clearly different heights (more than `SEPARATE_M`)
// are different structures: one passes over the other. Pure and deterministic:
// bridges are taken in order of id.

/** Decks whose edges are this close (metres) belong to one structure. */
export const TOUCH_M = 0.5;
/** Decks more than this far apart in height where they meet are separate structures, metres. */
export const SEPARATE_M = 1.5;
/** Beyond the edge of the deck it lies on, a deck ramps back to its own heights over this, metres. */
export const RAMP_M = 3;
/** The widest half deck considered when looking for decks that touch, metres. */
const MAX_REACH_M = 12;

export interface BridgeComplex {
  /** Stable id: the member decks' ids, sorted. */
  readonly id: string;
  /** Indices into `decks`, in order of id. */
  readonly members: readonly number[];
}

export interface CoordinatedBridges {
  /** The decks as drawn: the plan's, with heights shared where they overlap. */
  readonly decks: readonly Bridge[];
  readonly complexes: readonly BridgeComplex[];
  /** The complex each deck belongs to. */
  readonly complexOf: readonly number[];
  /** The structure's deck surface: `BridgeIndex` over the coordinated decks. */
  readonly index: BridgeIndex;
  /**
   * Whether a map point lies on the deck of another member of deck `deck`'s
   * structure (within its half width plus `margin`).
   */
  onOtherDeck(deck: number, x: number, y: number, margin?: number): boolean;
  /** The deck height of the structure at a point (the weighted mean), or null off every deck. */
  surfaceAt(x: number, y: number): number | null;
}

const BUCKET = 20;
const bucketKey = (gx: number, gy: number) => gx * 100_003 + gy;

/** Segment lookup over decks' centrelines. */
function segmentIndex(decks: readonly Bridge[], reach: (b: Bridge) => number) {
  const buckets = new Map<number, [number, number][]>();
  decks.forEach((b, bi) => {
    const h = reach(b);
    for (let i = 0; i + 3 < b.xy.length; i += 2) {
      const ax = b.xy[i] ?? 0;
      const ay = b.xy[i + 1] ?? 0;
      const bx = b.xy[i + 2] ?? 0;
      const by = b.xy[i + 3] ?? 0;
      for (
        let gx = Math.floor((Math.min(ax, bx) - h) / BUCKET);
        gx <= Math.floor((Math.max(ax, bx) + h) / BUCKET);
        gx += 1
      ) {
        for (
          let gy = Math.floor((Math.min(ay, by) - h) / BUCKET);
          gy <= Math.floor((Math.max(ay, by) + h) / BUCKET);
          gy += 1
        ) {
          const k = bucketKey(gx, gy);
          const list = buckets.get(k);
          if (list) list.push([bi, i / 2]);
          else buckets.set(k, [[bi, i / 2]]);
        }
      }
    }
  });
  return buckets;
}

/** Where a point falls on a deck: distance from its centreline and the sample position along it. */
interface OnDeck {
  readonly d: number;
  /** Fractional sample index. */
  readonly f: number;
}

/** The nearest point of deck `b`'s centreline to (x, y), via segment `i`; null past the deck's ends. */
function project(b: Bridge, i: number, x: number, y: number): OnDeck | null {
  const ax = b.xy[2 * i] ?? 0;
  const ay = b.xy[2 * i + 1] ?? 0;
  const dx = (b.xy[2 * i + 2] ?? 0) - ax;
  const dy = (b.xy[2 * i + 3] ?? 0) - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return null;
  const tRaw = ((x - ax) * dx + (y - ay) * dy) / l2;
  if ((i === 0 && tRaw < 0) || (i === b.deck.length - 2 && tRaw > 1)) return null;
  const t = Math.max(0, Math.min(1, tRaw));
  return { d: Math.hypot(x - ax - t * dx, y - ay - t * dy), f: i + t };
}

const interpolate = (values: readonly number[], f: number) => {
  const i = Math.max(0, Math.min(values.length - 2, Math.floor(f)));
  const t = Math.max(0, Math.min(1, f - i));
  return (values[i] ?? 0) + t * ((values[i + 1] ?? 0) - (values[i] ?? 0));
};

/** Groups decks into structures and shares their heights where they overlap. */
export function coordinateBridges(plan: readonly Bridge[]): CoordinatedBridges {
  const decks = [...plan].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Reach: a deck's own half width, and room for another deck's (up to MAX_REACH_M) to touch it.
  const buckets = segmentIndex(decks, (b) => b.halfWidth + TOUCH_M + MAX_REACH_M);
  const steps = decks.map(stepLength);
  /** The nearest point of each deck within reach of (x, y) (its half width plus `margin`). */
  const near = (x: number, y: number, margin: number) => {
    const best = new Map<number, OnDeck>();
    for (const [bi, i] of buckets.get(bucketKey(Math.floor(x / BUCKET), Math.floor(y / BUCKET))) ??
      []) {
      const b = decks[bi];
      if (!b) continue;
      const on = project(b, i, x, y);
      if (!on || on.d > b.halfWidth + margin) continue;
      const known = best.get(bi);
      if (!known || on.d < known.d) best.set(bi, on);
    }
    return best;
  };

  // Structures: union of decks that overlap or touch at similar heights.
  const parent = decks.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    return r;
  };
  decks.forEach((b, bi) => {
    for (let k = 0; k < b.deck.length; k += 1) {
      const x = b.xy[2 * k] ?? 0;
      const y = b.xy[2 * k + 1] ?? 0;
      for (const [oi, on] of near(x, y, b.halfWidth + TOUCH_M)) {
        if (oi === bi) continue;
        const o = decks[oi];
        if (!o) continue;
        if (Math.abs(interpolate(o.deck, on.f) - (b.deck[k] ?? 0)) > SEPARATE_M) continue;
        const ra = find(bi);
        const rb = find(oi);
        if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
      }
    }
  });
  const complexOf = decks.map((_, i) => find(i));
  const roots = [...new Set(complexOf)].sort((a, b) => a - b);
  const complexIndex = new Map(roots.map((r, i) => [r, i]));
  const complexes: BridgeComplex[] = roots.map((r) => {
    const members = decks.flatMap((_, i) => (complexOf[i] === r ? [i] : []));
    return { id: members.map((i) => decks[i]?.id ?? '').join('+'), members };
  });
  const complexOfDeck = complexOf.map((r) => complexIndex.get(r) ?? 0);

  // The shared heights. In each structure the spine (the widest deck, then the
  // longest, then by id) keeps its own; every other deck, taken in order of
  // how much it overlaps those already done, takes the height of the deck it
  // lies on, and ramps back to its own over `RAMP_M` beyond that deck's edge.
  // So a structure is flat across, as a real deck is, and continuous.
  const rank = new Int32Array(decks.length);
  const order: number[][] = complexes.map((c) => {
    const lengthOf = (i: number) => (decks[i]?.deck.length ?? 0) * (steps[i] ?? 1);
    const spine = [...c.members].sort(
      (a, b) =>
        (decks[b]?.halfWidth ?? 0) - (decks[a]?.halfWidth ?? 0) ||
        lengthOf(b) - lengthOf(a) ||
        a - b,
    )[0];
    const done = spine === undefined ? [] : [spine];
    const left = c.members.filter((m) => m !== spine);
    while (left.length > 0) {
      // The deck with the most samples on (or next to) those done; ties by index.
      let best = -1;
      let bestCount = -1;
      for (const m of left) {
        const b = decks[m];
        if (!b) continue;
        let count = 0;
        for (let k = 0; k < b.deck.length; k += 1) {
          const at = nearOf(b.xy[2 * k] ?? 0, b.xy[2 * k + 1] ?? 0, done, RAMP_M + 0.3);
          if (at) count += 1;
        }
        if (count > bestCount) {
          best = m;
          bestCount = count;
        }
      }
      done.push(best);
      left.splice(left.indexOf(best), 1);
    }
    done.forEach((m, i) => (rank[m] = i));
    return done;
  });
  /** The nearest of `among` decks whose footprint, plus `margin`, holds (x, y). */
  function nearOf(x: number, y: number, among: readonly number[], margin: number) {
    let best: { deck: number; on: OnDeck } | null = null;
    for (const [bi, on] of near(x, y, margin)) {
      if (!among.includes(bi)) continue;
      if (
        !best ||
        on.d - (decks[bi]?.halfWidth ?? 0) < best.on.d - (decks[best.deck]?.halfWidth ?? 0)
      )
        best = { deck: bi, on };
    }
    return best;
  }
  const coordinated: Bridge[] = [...decks];
  // Each deck meets the ground where it ends (the plan pins it to its road
  // there). Those ends pin the deck they lie on too, and so on down to the
  // spine: each deck is lowered (never raised, and never below the ground
  // under it) to within `MAX_GRADE` of every pin it carries, as the plan does
  // for one deck's own ends. So the structure reaches the ground wherever one
  // of its decks does.
  const pinsOf = new Map<number, { x: number; y: number; z: number }[]>();
  for (const members of order) {
    // From the last deck back to the spine: a deck's pins pass to the deck it lies on.
    for (let i = members.length - 1; i >= 1; i -= 1) {
      const m = members[i] ?? -1;
      const d = decks[m];
      if (!d) continue;
      const own = [0, d.deck.length - 1].map((k) => ({
        x: d.xy[2 * k] ?? 0,
        y: d.xy[2 * k + 1] ?? 0,
        z: d.deck[k] ?? 0,
      }));
      const carried = [...own, ...(pinsOf.get(m) ?? [])];
      pinsOf.set(m, carried);
      const before = members.slice(0, i);
      for (const pin of carried) {
        const on = nearOf(pin.x, pin.y, before, 0.3);
        if (!on) continue;
        pinsOf.set(on.deck, [...(pinsOf.get(on.deck) ?? []), pin]);
      }
    }
  }
  for (const [m, pins] of pinsOf) {
    const b = decks[m];
    if (!b || pins.length === 0) continue;
    const step = steps[m] ?? 1;
    // Each pin at its station along this deck (where it lies on it), or not at all.
    const stations = pins.flatMap((pin) => {
      const on = nearOf(pin.x, pin.y, [m], 0.3);
      return on ? [{ s: on.on.f * step, z: pin.z }] : [];
    });
    if (stations.length === 0) continue;
    const deck = b.deck.map((z, k) => {
      const ground = z - (b.lift[k] ?? 0);
      const low = stations.reduce(
        (lowest, pin) => Math.min(lowest, pin.z + MAX_GRADE * Math.abs(k * step - pin.s)),
        z,
      );
      return Math.max(Math.min(z, ground), low);
    });
    coordinated[m] = {
      ...b,
      deck,
      lift: b.lift.map((l, k) => l + ((deck[k] ?? 0) - (b.deck[k] ?? 0))),
    };
  }
  for (const members of order) {
    members.forEach((m, i) => {
      if (i === 0) return;
      const b = coordinated[m];
      if (!b) return;
      const before = members.slice(0, i);
      const deck = b.deck.map((own, k) => {
        const at = nearOf(b.xy[2 * k] ?? 0, b.xy[2 * k + 1] ?? 0, before, RAMP_M + 0.3);
        const parent = at && coordinated[at.deck];
        if (!at || !parent) return own;
        const theirs = interpolate(parent.deck, at.on.f);
        // Off the deck it lies on, it ramps back to its own height; near its own
        // ends too, where it meets its road (unless the end is on that deck,
        // whose height the end has pinned already).
        const beyond = at.on.d - (parent.halfWidth + 0.3);
        if (beyond <= 0) return theirs;
        const fromEnd = Math.min(k, b.deck.length - 1 - k) * (steps[m] ?? 1);
        const t = Math.max(Math.min(1, beyond / RAMP_M), 1 - Math.min(1, fromEnd / RAMP_M));
        return theirs + t * (own - theirs);
      });
      coordinated[m] = {
        ...b,
        deck,
        lift: b.lift.map((l, k) => l + ((deck[k] ?? 0) - (b.deck[k] ?? 0))),
      };
    });
  }

  /** The structure's deck at a point: the earliest deck (in its structure's order) holding it. */
  const surface = (x: number, y: number) => {
    let best: { deck: number; on: OnDeck } | null = null;
    for (const [bi, on] of near(x, y, 0.3)) {
      if (
        !best ||
        (rank[bi] ?? 0) < (rank[best.deck] ?? 0) ||
        ((rank[bi] ?? 0) === (rank[best.deck] ?? 0) && on.d < best.on.d)
      )
        best = { deck: bi, on };
    }
    const b = best && coordinated[best.deck];
    return best && b ? interpolate(b.deck, best.on.f) : null;
  };
  const touchBuckets = segmentIndex(coordinated, (b) => b.halfWidth + 0.5);
  const stamp = new Uint32Array(coordinated.length);
  const bestD = new Float64Array(coordinated.length);
  const bestF = new Float64Array(coordinated.length);
  const found: number[] = [];
  let query = 0;
  const index: BridgeIndex = {
    count: coordinated.length,
    touches(minX, minY, maxX, maxY) {
      for (let gx = Math.floor(minX / BUCKET); gx <= Math.floor(maxX / BUCKET); gx += 1) {
        for (let gy = Math.floor(minY / BUCKET); gy <= Math.floor(maxY / BUCKET); gy += 1) {
          if (touchBuckets.has(bucketKey(gx, gy))) return true;
        }
      }
      return false;
    },
    at(x, y) {
      // Within a deck (plus the 0.3 m the lifting has always reached past its edge).
      // The hot path of lifting road meshes: no allocation per call.
      query = (query + 1) >>> 0;
      if (query === 0) {
        stamp.fill(0);
        query = 1;
      }
      found.length = 0;
      for (const entry of touchBuckets.get(
        bucketKey(Math.floor(x / BUCKET), Math.floor(y / BUCKET)),
      ) ?? []) {
        const bi = entry[0];
        const i = entry[1];
        const b = coordinated[bi];
        if (!b) continue;
        const ax = b.xy[2 * i] ?? 0;
        const ay = b.xy[2 * i + 1] ?? 0;
        const dx = (b.xy[2 * i + 2] ?? 0) - ax;
        const dy = (b.xy[2 * i + 3] ?? 0) - ay;
        const l2 = dx * dx + dy * dy;
        if (l2 === 0) continue;
        const tRaw = ((x - ax) * dx + (y - ay) * dy) / l2;
        if ((i === 0 && tRaw < 0) || (i === b.deck.length - 2 && tRaw > 1)) continue;
        const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d > b.halfWidth + 0.3) continue;
        if (stamp[bi] !== query) {
          stamp[bi] = query;
          bestD[bi] = d;
          bestF[bi] = i + t;
          found.push(bi);
        } else if (d < (bestD[bi] ?? Infinity)) {
          bestD[bi] = d;
          bestF[bi] = i + t;
        }
      }
      if (found.length === 0) return null;
      // The earliest deck of its structure holding the point (then the nearest).
      let pick = -1;
      for (const bi of found) {
        if (
          pick < 0 ||
          (rank[bi] ?? 0) < (rank[pick] ?? 0) ||
          ((rank[bi] ?? 0) === (rank[pick] ?? 0) && (bestD[bi] ?? 0) < (bestD[pick] ?? 0))
        )
          pick = bi;
      }
      const b = coordinated[pick];
      if (!b) return null;
      const f = bestF[pick] ?? 0;
      const z = interpolate(b.deck, f);
      const lift = interpolate(b.lift, f);
      const step = steps[pick] ?? 1;
      const s = f * step;
      const length = (b.deck.length - 1) * step;
      const e = Math.min(s, length - s);
      const u = Math.min(1, Math.max(0, e / END_BLEND_M));
      return { deck: z, blend: u * u * (3 - 2 * u), centreGround: z - lift };
    },
  };

  return {
    decks: coordinated,
    complexes,
    complexOf: complexOfDeck,
    index,
    onOtherDeck(deck, x, y, margin = 0) {
      const complex = complexOfDeck[deck];
      for (const [bi] of near(x, y, margin)) {
        if (bi !== deck && complexOfDeck[bi] === complex) return true;
      }
      return false;
    },
    surfaceAt: surface,
  };
}

/** The spacing of a deck's samples, metres. */
function stepLength(b: Bridge): number {
  let l = 0;
  for (let i = 2; i < b.xy.length; i += 2)
    l += Math.hypot((b.xy[i] ?? 0) - (b.xy[i - 2] ?? 0), (b.xy[i + 1] ?? 0) - (b.xy[i - 1] ?? 0));
  return l / Math.max(1, b.deck.length - 1);
}

/** A deck closer than this to the water under it (or below it) has the water cut away beneath it, metres. */
export const LOW_DECK_M = 0.1;

/**
 * The water surface with holes under low decks (docs/adr/0044): where a deck
 * is lower than `LOW_DECK_M` above the water (the DEM and the water level
 * leave no room for a proper bridge), the water under it is cut away, so the
 * deck is never drawn under a sheet of water. Water elsewhere is unchanged.
 * Returns the mesh and how many decks were low.
 */
export function cutUnderDecks(
  water: MeshData,
  decks: readonly Bridge[],
): { mesh: MeshData; lowDecks: number } {
  const holes = new Occupancy<number>(() => true);
  let lowDecks = 0;
  decks.forEach((b, bi) => {
    let low = false;
    for (let k = 0; k + 1 < b.deck.length; k += 1) {
      const wet = b.wet[k] === true || b.wet[k + 1] === true;
      const clear = Math.min(
        (b.deck[k] ?? 0) - (b.under[k] ?? 0),
        (b.deck[k + 1] ?? 0) - (b.under[k + 1] ?? 0),
      );
      if (!wet || clear >= LOW_DECK_M) continue;
      low = true;
      const corner = (i: number, side: number) => {
        const n = b.deck.length;
        const j0 = Math.max(0, i - 1);
        const j1 = Math.min(n - 1, i + 1);
        let dx = (b.xy[2 * j1] ?? 0) - (b.xy[2 * j0] ?? 0);
        let dy = (b.xy[2 * j1 + 1] ?? 0) - (b.xy[2 * j0 + 1] ?? 0);
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        return [(b.xy[2 * i] ?? 0) - dy * side, (b.xy[2 * i + 1] ?? 0) + dx * side] as const;
      };
      const h = b.halfWidth;
      holes.add([...corner(k, -h), ...corner(k + 1, -h), ...corner(k + 1, h), ...corner(k, h)], bi);
    }
    if (low) lowDecks += 1;
  });
  if (holes.size === 0 || water.triangleCount === 0) return { mesh: water, lowDecks };
  const out = meshBuffers(water.colors !== null);
  const p = water.positions;
  const n = water.normals;
  const c = water.colors;
  for (let t = 0; t < water.triangleCount; t += 1) {
    const o = 9 * t;
    const tri = [
      p[o] ?? 0,
      -(p[o + 2] ?? 0),
      p[o + 3] ?? 0,
      -(p[o + 5] ?? 0),
      p[o + 6] ?? 0,
      -(p[o + 8] ?? 0),
    ];
    const pieces = holes.free(tri, -1);
    // Untouched: one piece, as large as the triangle.
    const untouched =
      pieces.length === 1 &&
      Math.abs(Math.abs(signedArea2(pieces[0] ?? [])) - Math.abs(signedArea2(tri))) < 1e-9;
    if (untouched) {
      for (let k = 0; k < 9; k += 1) {
        out.positions.push(p[o + k] ?? 0);
        out.normals.push(n[o + k] ?? 0);
        if (c && out.colors) out.colors.push(c[o + k] ?? 0);
      }
      continue;
    }
    // Barycentric interpolation of the original triangle's attributes.
    const [ax, ay, bx, by, cx, cy] = tri as [number, number, number, number, number, number];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(det) < 1e-12) continue;
    const vertex = (x: number, y: number) => {
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
      const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
      const l3 = 1 - l1 - l2;
      const mix = (arr: ArrayLike<number>, k: number) =>
        l1 * (arr[o + k] ?? 0) + l2 * (arr[o + 3 + k] ?? 0) + l3 * (arr[o + 6 + k] ?? 0);
      out.positions.push(x, mix(p, 1), -y);
      out.normals.push(mix(n, 0), mix(n, 1), mix(n, 2));
      if (c && out.colors) out.colors.push(mix(c, 0), mix(c, 1), mix(c, 2));
    };
    // The pieces are counter-clockwise from above; keep the triangle's own winding.
    const flip = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0;
    for (const piece of pieces) {
      const m = piece.length / 2;
      for (let i = 1; i + 1 < m; i += 1) {
        const [j, k] = flip ? [i + 1, i] : [i, i + 1];
        vertex(piece[0] ?? 0, piece[1] ?? 0);
        vertex(piece[2 * j] ?? 0, piece[2 * j + 1] ?? 0);
        vertex(piece[2 * k] ?? 0, piece[2 * k + 1] ?? 0);
      }
    }
  }
  return { mesh: finishMesh(out), lowDecks };
}

/**
 * Whether a road joins a bridge at a point (docs/adr/0044): a road whose
 * surface is there, that is not carried by the deck's structure, and that is
 * on the deck's level or shares a node with one of its roads (a road passing
 * under the bridge does not count). Barriers stop there.
 */
export function roadEntrances(
  roads: readonly Road[],
  coordinated: CoordinatedBridges,
): (deck: number, x: number, y: number) => boolean {
  const drawn = roads.filter(onSurface);
  const byId = new Map(drawn.map((r) => [r.id, r]));
  const key = (p: { x: number; y: number }) =>
    `${String(Math.round(p.x * 1000))},${String(Math.round(p.y * 1000))}`;
  const atNode = new Map<string, string[]>();
  for (const r of drawn)
    for (const p of r.centerline) {
      const k = key(p);
      atNode.set(k, [...(atNode.get(k) ?? []), r.id]);
    }
  const BUCKET = 25;
  const buckets = new Map<number, number[]>();
  const segs: { road: Road; ax: number; ay: number; bx: number; by: number }[] = [];
  for (const road of drawn) {
    const h = road.widthMeters / 2;
    for (let i = 0; i + 1 < road.centerline.length; i += 1) {
      const a = road.centerline[i];
      const b = road.centerline[i + 1];
      if (!a || !b) continue;
      const s = segs.length;
      segs.push({ road, ax: a.x, ay: a.y, bx: b.x, by: b.y });
      for (
        let gx = Math.floor((Math.min(a.x, b.x) - h) / BUCKET);
        gx <= Math.floor((Math.max(a.x, b.x) + h) / BUCKET);
        gx += 1
      )
        for (
          let gy = Math.floor((Math.min(a.y, b.y) - h) / BUCKET);
          gy <= Math.floor((Math.max(a.y, b.y) + h) / BUCKET);
          gy += 1
        ) {
          const k = gx * 100_003 + gy;
          buckets.set(k, [...(buckets.get(k) ?? []), s]);
        }
    }
  }
  // For each structure: the roads it carries, its level, and the roads joined to them.
  const carried = coordinated.complexes.map(
    (c) => new Set(c.members.flatMap((m) => coordinated.decks[m]?.roadIds ?? [])),
  );
  const joined = carried.map((ids) => {
    const out = new Set<string>();
    for (const id of ids)
      for (const p of byId.get(id)?.centerline ?? [])
        for (const other of atNode.get(key(p)) ?? []) out.add(other);
    return out;
  });
  const levels = carried.map(
    (ids) =>
      new Set(
        [...ids].flatMap((id) => {
          const r = byId.get(id);
          return r ? [roadLevel(r)] : [];
        }),
      ),
  );
  return (deck, x, y) => {
    const c = coordinated.complexOf[deck] ?? -1;
    const mine = carried[c];
    for (const s of buckets.get(Math.floor(x / BUCKET) * 100_003 + Math.floor(y / BUCKET)) ?? []) {
      const seg = segs[s];
      if (!seg || mine?.has(seg.road.id)) continue;
      if (!(levels[c]?.has(roadLevel(seg.road)) || joined[c]?.has(seg.road.id))) continue;
      const dx = seg.bx - seg.ax;
      const dy = seg.by - seg.ay;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - seg.ax) * dx + (y - seg.ay) * dy) / l2)) : 0;
      if (Math.hypot(x - seg.ax - t * dx, y - seg.ay - t * dy) < seg.road.widthMeters / 2)
        return true;
    }
    return false;
  };
}
