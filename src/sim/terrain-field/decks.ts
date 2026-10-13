import { levelAt, type RoadStamp } from './roads';

// Bridge decks (research §5.6): a bridge's deck is its road, carried on.
// Its top is the bridge road's profile (laid straight between the levels of
// the roads it joins, `pinJunctions`), so road and deck meet exactly at each
// end. Under the deck the ground is held below its underside, rising to the
// road's level only at the ends (the abutments), so no ground shows through.

/** Deck slab thickness, metres. */
export const DECK_THICKNESS_M = 0.6;
/** Least gap between the deck's underside and the ground under it, metres. */
export const DECK_CLEARANCE_M = 0.3;
/**
 * The deck sits on its ground for this far in from each end, just above it
 * (by `DECK_SEAT_DROP_M`); then over `DECK_END_M` the ground drops to the
 * clearance, metres.
 */
export const DECK_SEAT_M = 0.5;
export const DECK_SEAT_DROP_M = 0.04;
export const DECK_END_M = 0.8;
/** Beyond the deck's edge the hold on the ground fades out over this far, metres. */
export const DECK_FADE_M = 1.5;

/** Half the deck's width: the road's surface (carriageway and shoulder) and a parapet's width. */
export function deckHalfWidth(road: RoadStamp): number {
  return road.half + road.shoulder + (road.rule.rank <= 2 ? 0.15 : 0.35);
}

/** Where a point is over a deck: the deck's top there, how far in from the nearer end, and from the centre line. */
export interface DeckAt {
  top: number;
  /** Distance from the deck's nearer end, along it, metres. */
  fromEnd: number;
  /** Distance from the centre line, metres. */
  across: number;
}

/**
 * The nearest point of bridge `road`'s deck to (x, y), into `out`; false
 * beyond its ends (a point past an end is on the road, not the deck).
 */
export function deckNear(road: RoadStamp, x: number, y: number, out: DeckAt): boolean {
  const xy = road.xy;
  const total = road.cum[road.cum.length - 1] ?? 0;
  let best = Infinity;
  let bestS = 0;
  const last = xy.length - 4;
  for (let i = 0; i <= last; i += 2) {
    const ax = xy[i] ?? 0;
    const ay = xy[i + 1] ?? 0;
    const dx = (xy[i + 2] ?? 0) - ax;
    const dy = (xy[i + 3] ?? 0) - ay;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) continue;
    const tRaw = ((x - ax) * dx + (y - ay) * dy) / l2;
    if ((i === 0 && tRaw < 0) || (i === last && tRaw > 1)) continue;
    const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
    const px = ax + t * dx - x;
    const py = ay + t * dy - y;
    const d2 = px * px + py * py;
    if (d2 < best) {
      best = d2;
      const c = road.cum[i / 2] ?? 0;
      bestS = c + t * ((road.cum[i / 2 + 1] ?? 0) - c);
    }
  }
  if (best === Infinity) return false;
  out.top = levelAt(road, bestS);
  out.fromEnd = bestS < total - bestS ? bestS : total - bestS;
  out.across = Math.sqrt(best);
  return true;
}

/** The highest ground allowed under a deck at `at` (with its weight, 0–1), or null where it does not hold. */
export function deckHold(road: RoadStamp, at: DeckAt, out: { hi: number; w: number }): boolean {
  const half = deckHalfWidth(road);
  const beyond = at.across - half;
  if (beyond >= DECK_FADE_M) return false;
  // Just under the deck at first (the road's level carries on flat under its
  // end, so the ground there is shaded as the road is), then down to the
  // clearance.
  const near = at.fromEnd >= DECK_SEAT_M ? 1 : at.fromEnd / DECK_SEAT_M;
  const r = (at.fromEnd - DECK_SEAT_M) / DECK_END_M;
  const u = r <= 0 ? 0 : r >= 1 ? 1 : r;
  out.hi =
    at.top -
    DECK_SEAT_DROP_M * near -
    u * u * (3 - 2 * u) * (DECK_THICKNESS_M + DECK_CLEARANCE_M - DECK_SEAT_DROP_M);
  const f = beyond <= 0 ? 0 : beyond / DECK_FADE_M;
  out.w = 1 - f * f * (3 - 2 * f);
  return true;
}

/** Bridge decks by position, for walking on them and keeping clutter off them. */
export interface DeckIndex {
  /** The top of the deck over (x, y), or null when there is none. */
  topAt(x: number, y: number): number | null;
  readonly count: number;
}

export function deckIndex(roads: readonly RoadStamp[]): DeckIndex {
  const B = 32;
  const decks = roads.filter((r) => r.bridge);
  const buckets = new Map<string, RoadStamp[]>();
  for (const road of decks) {
    const r = deckHalfWidth(road);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < road.xy.length; i += 2) {
      x0 = Math.min(x0, road.xy[i] ?? 0);
      x1 = Math.max(x1, road.xy[i] ?? 0);
      y0 = Math.min(y0, road.xy[i + 1] ?? 0);
      y1 = Math.max(y1, road.xy[i + 1] ?? 0);
    }
    for (let bx = Math.floor((x0 - r) / B); bx <= Math.floor((x1 + r) / B); bx += 1)
      for (let by = Math.floor((y0 - r) / B); by <= Math.floor((y1 + r) / B); by += 1) {
        const k = `${String(bx)},${String(by)}`;
        const list = buckets.get(k);
        if (list) list.push(road);
        else buckets.set(k, [road]);
      }
  }
  const at: DeckAt = { top: 0, fromEnd: 0, across: 0 };
  return {
    count: decks.length,
    topAt(x, y) {
      let top: number | null = null;
      for (const road of buckets.get(`${String(Math.floor(x / B))},${String(Math.floor(y / B))}`) ??
        []) {
        if (!deckNear(road, x, y, at) || at.across > deckHalfWidth(road)) continue;
        if (top === null || at.top > top) top = at.top;
      }
      return top;
    },
  };
}
