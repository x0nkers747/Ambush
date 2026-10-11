import type {
  DecorFeatures,
  DecorLine,
  DecorLineKind,
  DecorPoint,
  DecorPointKind,
  Vec2,
} from '#sim';
import { clipPolyline, type Rect } from './clip';
import { toLocal, type BattlefieldFrame, type GeoBox } from './frame';
import type { LatLon } from './utm';

// Mapped roadside and settlement details from OpenStreetMap (docs/adr/0036):
// street lamps, single trees, power poles, towers and lines, fences, walls
// and guard rails, traffic signs and a little street furniture. They are
// display only: the 3D view draws them, and uses them in preference to
// anything it would otherwise infer; the simulation never reads them. Tree
// rows and hedges are not here: they are vegetation areas already (osm.ts),
// with a part in line of sight.

/** The Overpass statements for the details, per bounding box. Nodes only where a node is the feature. */
export function decorStatements(bbox: string): string[] {
  return [
    `node["highway"~"^(street_lamp|stop|give_way)$"](${bbox});`,
    `node["natural"="tree"](${bbox});`,
    `node["power"~"^(pole|tower)$"](${bbox});`,
    `way["power"~"^(line|minor_line)$"](${bbox});`,
    `way["barrier"~"^(fence|wall|retaining_wall|guard_rail|city_wall)$"](${bbox});`,
    `node["traffic_sign"](${bbox});`,
    `node["amenity"~"^(bench|waste_basket|post_box)$"](${bbox});`,
    `node["barrier"="bollard"](${bbox});`,
  ];
}

/** The details query alone, for measuring it or fetching it separately. */
export function decorQuery(boxes: readonly GeoBox[], timeoutSeconds = 90): string {
  const parts = boxes.flatMap((b) =>
    decorStatements([b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(',')),
  );
  return `[out:json][timeout:${String(timeoutSeconds)}];\n(\n  ${parts.join('\n  ')}\n);\nout geom;`;
}

type Tags = Readonly<Record<string, string>>;

const plain = (v: string | undefined, max = 40) =>
  v !== undefined && new RegExp(`^[a-z0-9_:;.-]{1,${String(max)}}$`, 'i').test(v.trim())
    ? v.trim().toLowerCase()
    : undefined;

/** A height in metres from "12", "12 m" or "12.5"; null for anything else or implausible. */
function height(v: string | undefined, max: number): number | null {
  if (v === undefined) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*m?\s*$/.exec(v);
  const h = m ? Number(m[1]?.replace(',', '.')) : NaN;
  return Number.isFinite(h) && h > 0 && h <= max ? h : null;
}

/** The kind of a node, or null if it is not a detail. */
export function decorPointKind(t: Tags): DecorPointKind | null {
  if (t['highway'] === 'street_lamp') return 'streetLamp';
  if (t['natural'] === 'tree') return 'tree';
  if (t['power'] === 'pole') return 'powerPole';
  if (t['power'] === 'tower') return 'powerTower';
  if (t['traffic_sign'] !== undefined || t['highway'] === 'stop' || t['highway'] === 'give_way') {
    return 'trafficSign';
  }
  if (t['amenity'] === 'bench') return 'bench';
  if (t['amenity'] === 'waste_basket') return 'wasteBasket';
  if (t['amenity'] === 'post_box') return 'postBox';
  if (t['barrier'] === 'bollard') return 'bollard';
  return null;
}

/** The kind of a way, or null if it is not a detail. */
export function decorLineKind(t: Tags): DecorLineKind | null {
  if (t['power'] === 'line') return 'powerLine';
  if (t['power'] === 'minor_line') return 'minorLine';
  const b = t['barrier'];
  if (b === 'fence') return 'fence';
  if (b === 'wall' || b === 'retaining_wall' || b === 'city_wall') return 'wall';
  if (b === 'guard_rail') return 'guardRail';
  return null;
}

export interface DecorNode {
  readonly type: 'node';
  readonly id: number;
  readonly lat?: number;
  readonly lon?: number;
  readonly tags?: Tags;
}
export interface DecorWay {
  readonly type: 'way';
  readonly id: number;
  readonly tags?: Tags;
  readonly geometry?: readonly (LatLon | null)[];
}

/**
 * The details among the elements, in local metres, within `rect`. Elements
 * that are not details are ignored; details without usable geometry are
 * dropped and counted.
 */
export function decorFromOsm(
  elements: readonly (DecorNode | DecorWay | { readonly type: 'relation' })[],
  frame: BattlefieldFrame,
  rect: Rect,
): { decor: DecorFeatures; dropped: number } {
  const points: DecorPoint[] = [];
  const lines: DecorLine[] = [];
  let dropped = 0;
  const inside = (p: Vec2) =>
    p.x >= rect.minX && p.x <= rect.maxX && p.y >= rect.minY && p.y <= rect.maxY;
  for (const el of elements) {
    if (el.type === 'node') {
      const tags = el.tags ?? {};
      const kind = decorPointKind(tags);
      if (!kind) continue;
      if (typeof el.lat !== 'number' || typeof el.lon !== 'number') {
        dropped += 1;
        continue;
      }
      const position = toLocal(frame, { lat: el.lat, lon: el.lon });
      if (!inside(position)) continue;
      const leaf = tags['leaf_type'];
      const h = height(tags['height'], kind === 'powerTower' ? 120 : 60);
      const sign =
        kind === 'trafficSign'
          ? (plain(tags['traffic_sign']) ??
            (tags['highway'] === 'stop'
              ? 'stop'
              : tags['highway'] === 'give_way'
                ? 'give_way'
                : undefined))
          : undefined;
      points.push({
        id: `osm-n${String(el.id)}`,
        kind,
        position,
        ...(leaf === 'broadleaved' || leaf === 'needleleaved' ? { leafType: leaf } : {}),
        ...(h !== null ? { heightMeters: h } : {}),
        ...(sign !== undefined ? { sign } : {}),
      });
    } else if (el.type === 'way') {
      const tags = el.tags ?? {};
      const kind = decorLineKind(tags);
      if (!kind) continue;
      const g = el.geometry;
      if (!g || g.length < 2 || g.some((p) => p === null)) {
        dropped += 1;
        continue;
      }
      const line = (g as LatLon[]).map((p) => toLocal(frame, p));
      const material =
        kind === 'fence'
          ? plain(tags['fence_type'] ?? tags['material'])
          : kind === 'wall'
            ? plain(tags['wall'] ?? tags['material'])
            : undefined;
      const h = height(tags['height'], kind === 'powerLine' ? 120 : 10);
      const pieces = clipPolyline(line, rect).filter((p) => p.length >= 2);
      pieces.forEach((piece, i) => {
        lines.push({
          id:
            pieces.length === 1
              ? `osm-w${String(el.id)}`
              : `osm-w${String(el.id)}-${String(i + 1)}`,
          kind,
          points: piece,
          ...(material !== undefined ? { material } : {}),
          ...(h !== null ? { heightMeters: h } : {}),
        });
      });
    }
  }
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  points.sort(byId);
  lines.sort(byId);
  return { decor: { points, lines }, dropped };
}
