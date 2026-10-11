import { ShapeUtils, Vector2 } from 'three';
import { buildingRoofElevations, heightAt, type Building, type TerrainDataset } from '#sim';
import type { MeshData, Rgb } from './drape';
import { hashString, unit } from './hash';
import { srgbToLinear } from './terrain-mesh';

// Buildings in 3D (docs/adr/0030): each footprint extruded to a flat roof.
//
// The roof is exactly where line of sight finds it: `buildingRoofElevations`,
// the lowest ground at the footprint's corners plus the building's height. On
// a slope that is the downhill side, so the building looks as tall as its
// height there and shorter uphill, as the simulation treats it. The walls
// reach down past the lowest ground anywhere along the footprint's edges, so
// they always meet the ground with no gap, and the ground itself is never
// changed. A darker plinth runs along the bottom.
//
// The imported data has only an outer ring per building (courtyards are not
// kept) and a height that the importer has already chosen (the `height` tag,
// else storeys × 3 m, else Overture's height or floors, else 6 m), and no
// roof shape, so roofs are flat. Colours come from a small muted palette,
// picked by a hash of the building's id: the same building always looks the
// same. All buildings form one mesh with vertex colours: one draw call.

/** Muted wall colours (sRGB): renders, brick and concrete. */
const WALLS = [0xd6cebd, 0xc8c2b6, 0xddd2bd, 0xbcb09f, 0xcfbea4, 0xb3a493, 0xd3ccc3];
/** Muted roof colours (sRGB): slate, tar, terracotta and zinc. */
const ROOFS = [0x8a8884, 0x958b80, 0x9c7360, 0x9a9c97, 0x7c7e80, 0xa38a72];
/** The plinth is the wall colour darkened by this factor. */
const PLINTH_SHADE = 0.62;
/** Plinth height above the lowest corner, at most. */
const PLINTH_M = 0.5;
/** The walls reach this far below the lowest ground on the footprint's edges. */
const FOOTING_M = 0.5;
/** Ground along the edges is sampled at least this often. */
const EDGE_SAMPLE_M = 0.5;

export interface BuildingGeometry {
  readonly mesh: MeshData;
  /** Buildings drawn. */
  readonly count: number;
  /**
   * Buildings whose roof (as line of sight uses it) is below the highest
   * ground at their corners: on steep ground the uphill wall disappears.
   */
  readonly buried: number;
}

function linear(srgb: number, shade = 1): Rgb {
  return [
    srgbToLinear(((srgb >> 16) & 255) * shade),
    srgbToLinear(((srgb >> 8) & 255) * shade),
    srgbToLinear((srgb & 255) * shade),
  ];
}

/** A building's wall and roof colours: fixed by its id. */
export function buildingColors(id: string): { wall: Rgb; roof: Rgb; plinth: Rgb } {
  const h = hashString(id);
  const wall = WALLS[h % WALLS.length] ?? 0xc0b8a8;
  const roof = ROOFS[(h >>> 8) % ROOFS.length] ?? 0x5b5a58;
  // A little variation within each colour, ±5 %.
  const shade = 0.95 + 0.1 * unit(Math.imul(h, 0x9e3779b1) >>> 0);
  return {
    wall: linear(wall, shade),
    roof: linear(roof, shade),
    plinth: linear(wall, PLINTH_SHADE),
  };
}

export function buildingGeometry(terrain: TerrainDataset): BuildingGeometry {
  const roofs = buildingRoofElevations(terrain);
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const vertex = (x: number, y: number, z: number, n: readonly number[], c: Rgb) => {
    positions.push(x, z, -y);
    normals.push(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0);
    colors.push(c[0], c[1], c[2]);
  };
  /** A wall quad from (a) to (b), between two heights, facing outwards (`n`, Three.js axes). */
  const quad = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    z0: number,
    z1: number,
    n: readonly number[],
    c: Rgb,
  ) => {
    if (z1 <= z0) return;
    vertex(ax, ay, z0, n, c);
    vertex(bx, by, z0, n, c);
    vertex(bx, by, z1, n, c);
    vertex(ax, ay, z0, n, c);
    vertex(bx, by, z1, n, c);
    vertex(ax, ay, z1, n, c);
  };

  const sorted = [...terrain.features.buildings].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  let buried = 0;
  for (const building of sorted) {
    const roofZ = roofs.get(building.id);
    if (roofZ === undefined) continue;
    const ring = counterClockwise(building);
    const corners = ring.map((p) => heightAt(terrain, p.x, p.y));
    const lowestCorner = Math.min(...corners);
    if (Math.max(...corners) > roofZ) buried += 1;
    // The lowest ground anywhere along the edges, so no wall stops short of it.
    let lowest = lowestCorner;
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length] ?? a;
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / EDGE_SAMPLE_M);
      for (let k = 1; k < steps; k += 1) {
        const t = k / steps;
        lowest = Math.min(lowest, heightAt(terrain, a.x + t * (b.x - a.x), a.y + t * (b.y - a.y)));
      }
    });
    const bottom = lowest - FOOTING_M;
    const plinthTop = Math.min(lowestCorner + PLINTH_M, roofZ);
    const { wall, roof, plinth } = buildingColors(building.id);

    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length] ?? a;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) return;
      // Outward normal of a counter-clockwise ring: (dy, −dx), into Three.js axes.
      const n = [(b.y - a.y) / len, 0, (b.x - a.x) / len];
      quad(a.x, a.y, b.x, b.y, bottom, plinthTop, n, plinth);
      quad(a.x, a.y, b.x, b.y, plinthTop, roofZ, n, wall);
    });

    const contour = ring.map((p) => new Vector2(p.x, p.y));
    for (const [i, j, k] of ShapeUtils.triangulateShape(contour, [])) {
      const tri = [i, j, k].map((t) => ring[t ?? 0] ?? { x: 0, y: 0 });
      const [p, q, r] = tri as [(typeof tri)[0], (typeof tri)[0], (typeof tri)[0]];
      const area = (q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y);
      // Counter-clockwise seen from above.
      const order = area >= 0 ? [p, q, r] : [p, r, q];
      for (const v of order) vertex(v.x, v.y, roofZ, [0, 1, 0], roof);
    }
  }
  return {
    mesh: {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      colors: Float32Array.from(colors),
      triangleCount: positions.length / 9,
    },
    count: sorted.length,
    buried,
  };
}

/** The footprint counter-clockwise (seen from above), without a repeated closing corner. */
function counterClockwise(building: Building) {
  const ring = [...building.footprint];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && ring.length > 3 && first.x === last.x && first.y === last.y) ring.pop();
  let area = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length] ?? a;
    area += a.x * b.y - b.x * a.y;
  });
  return area < 0 ? ring.reverse() : ring;
}
