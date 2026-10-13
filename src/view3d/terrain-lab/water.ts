import { BufferAttribute, BufferGeometry, Mesh, ShapeUtils, Vector2 } from 'three';
import type { Vec2, WaterClass, WaterSurfaces } from '#sim';
import { CHANNEL_STEP_M, channelLevelAt, type TerrainField } from '#sim/terrain-lab';
import { srgbToLinear } from '../terrain-mesh';
import { createWaterMaterial } from '../water-material';
import { WATER_PROFILES, type WaterProfileName } from '../water-profiles';

// The lab's water (research §5.6): flat sheets at the water grading's levels
// for water areas (their mapped outlines, where the field's banks start at
// the water's level) and ribbons for levelled rivers and the small channels
// the field cuts, reaching past the channel so the waterline is where the
// banks rise out of the water.

/** Sheets and ribbons reach this far past the mapped edge, metres. */
const OVERLAP_M = 1.5;
/** Boundary points at most this far apart (rivers' levels vary along them), metres. */
const DENSIFY_M = 6;

const PROFILE_OF: Readonly<Record<WaterClass, WaterProfileName>> = {
  sea: 'ocean',
  lake: 'lake',
  reservoir: 'reservoir',
  pond: 'pond',
  basin: 'lake',
  river: 'river',
  canal: 'river',
  other: 'lake',
};

function densify(ring: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(l / DENSIFY_M));
    for (let k = 0; k < n; k += 1)
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

export interface LabWater {
  readonly mesh: Mesh;
  readonly triangles: number;
  dispose(): void;
}

export function labWater(
  field: TerrainField,
  features: {
    water?: readonly {
      id: string;
      kind: string;
      boundary: readonly Vec2[];
      holes?: readonly (readonly Vec2[])[];
    }[];
  },
  surfaces: WaterSurfaces | null,
): LabWater {
  const pos: number[] = [];
  const col: number[] = [];
  const colour = (p: WaterProfileName) => {
    const c = WATER_PROFILES[p].color;
    return [srgbToLinear((c >> 16) & 255), srgbToLinear((c >> 8) & 255), srgbToLinear(c & 255)];
  };
  const q = field.water;
  // Water areas: at their levels (standing) or along the river's profile.
  if (q) {
    for (const area of features.water ?? []) {
      if (area.kind !== 'water') continue;
      const cls = q.bodyClass(area.id);
      if (!cls) continue;
      // The mapped outline itself: the field's banks rise from its level right at it.
      const outer = densify(area.boundary);
      const holes = (area.holes ?? []).map((h) => densify(h));
      const tris = ShapeUtils.triangulateShape(
        outer.map((p) => new Vector2(p.x, p.y)),
        holes.map((h) => h.map((p) => new Vector2(p.x, p.y))),
      );
      const all = [...outer, ...holes.flat()];
      const rgb = colour(PROFILE_OF[cls]);
      for (const t of tris)
        for (const i of t) {
          const p = all[i];
          if (!p) continue;
          const level = q.bodyLevel(area.id, p.x, p.y) ?? q.levelAt(p.x, p.y) ?? 0;
          pos.push(p.x, level, -p.y);
          col.push(...rgb);
        }
    }
  }
  const ribbon = (
    xy: ArrayLike<number>,
    level: (i: number) => number,
    half: (i: number) => number,
    rgb: number[],
  ) => {
    const n = xy.length / 2;
    for (let i = 0; i + 1 < n; i += 1) {
      const ends = [i, i + 1].map((k) => {
        const a = Math.max(0, k - 1);
        const b = Math.min(n - 1, k + 1);
        const dx = (xy[2 * b] ?? 0) - (xy[2 * a] ?? 0);
        const dy = (xy[2 * b + 1] ?? 0) - (xy[2 * a + 1] ?? 0);
        const l = Math.hypot(dx, dy) || 1;
        const h = half(k);
        const x = xy[2 * k] ?? 0;
        const y = xy[2 * k + 1] ?? 0;
        const z = level(k);
        return {
          lx: x - (dy / l) * h,
          ly: y + (dx / l) * h,
          rx: x + (dy / l) * h,
          ry: y - (dx / l) * h,
          z,
        };
      });
      const [a, b] = ends;
      if (!a || !b) continue;
      pos.push(a.lx, a.z, -a.ly, a.rx, a.z, -a.ry, b.rx, b.z, -b.ry);
      pos.push(a.lx, a.z, -a.ly, b.rx, b.z, -b.ry, b.lx, b.z, -b.ly);
      for (let k = 0; k < 6; k += 1) col.push(...rgb);
    }
  };
  // Levelled rivers drawn as lines (their channels are in the field through the water query).
  for (const r of surfaces?.rivers ?? []) {
    if (!r.halfWidths.some((h) => h > 0)) continue;
    ribbon(
      r.xy,
      (k) => r.levels[k] ?? 0,
      (k) => ((r.halfWidths[k] ?? 0) > 0 ? (r.halfWidths[k] ?? 0) + OVERLAP_M : 0),
      colour('river'),
    );
  }
  // The field's own channels.
  for (const c of field.channels) {
    const total = c.cum[c.cum.length - 1] ?? 0;
    const n = Math.max(2, Math.ceil(total / CHANNEL_STEP_M) + 1);
    const xy = new Float64Array(2 * n);
    let seg = 0;
    for (let k = 0; k < n; k += 1) {
      const s = Math.min(total, k * CHANNEL_STEP_M);
      while (seg < c.cum.length - 2 && (c.cum[seg + 1] ?? 0) < s) seg += 1;
      const l = (c.cum[seg + 1] ?? 0) - (c.cum[seg] ?? 0);
      const t = l > 0 ? (s - (c.cum[seg] ?? 0)) / l : 0;
      xy[2 * k] = (c.xy[2 * seg] ?? 0) + t * ((c.xy[2 * seg + 2] ?? 0) - (c.xy[2 * seg] ?? 0));
      xy[2 * k + 1] =
        (c.xy[2 * seg + 1] ?? 0) + t * ((c.xy[2 * seg + 3] ?? 0) - (c.xy[2 * seg + 1] ?? 0));
    }
    ribbon(
      xy,
      (k) => channelLevelAt(c, Math.min(total, k * CHANNEL_STEP_M)),
      () => c.half + OVERLAP_M,
      colour(c.kind === 'river' || c.kind === 'canal' ? 'river' : 'pond'),
    );
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  geometry.computeVertexNormals();
  // Flat water: straight up.
  const normals = geometry.getAttribute('normal');
  for (let i = 0; i < normals.count; i += 1) normals.setXYZ(i, 0, 1, 0);
  geometry.computeBoundingSphere();
  const material = createWaterMaterial(null);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'lab water';
  mesh.receiveShadow = true;
  return {
    mesh,
    triangles: pos.length / 9,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
