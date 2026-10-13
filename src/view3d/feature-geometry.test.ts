import { describe, expect, it } from 'vitest';
import {
  buildingRoofElevations,
  heightAt,
  pointInPolygon,
  rectangle,
  type EnvironmentFeatures,
  type TerrainDataset,
} from '#sim';
import { buildingGeometry, designBuildings, ROOF_LAYER_BASE } from './building-geometry';
import { BufferAttribute, BufferGeometry } from 'three';
import { boundingSphereOf } from './geo-features';
import { planRoof } from './roof-geometry';
import { roughGround, triangles, triArea } from './test-helpers';

// Buildings (docs/adr/0030, 0035).

const square = (cx: number, cy: number, half: number) => [
  { x: cx - half, y: cy - half },
  { x: cx + half, y: cy - half },
  { x: cx + half, y: cy + half },
  { x: cx - half, y: cy + half },
];

const features: EnvironmentFeatures = {
  roads: [],
  buildings: [
    { id: 'b1', footprint: rectangle(-100, -100, 12, 8, 20), heightMeters: 6 },
    // On the cliff edge at x = 120, where the ground rises 40 m across the footprint.
    { id: 'b2', footprint: rectangle(120, 50, 16, 10), heightMeters: 9 },
    // Clockwise and L-shaped.
    {
      id: 'b3',
      footprint: [
        { x: 0, y: 0 },
        { x: 0, y: 20 },
        { x: 8, y: 20 },
        { x: 8, y: 8 },
        { x: 20, y: 8 },
        { x: 20, y: 0 },
      ],
      heightMeters: 4,
    },
  ],
  vegetation: [
    {
      id: 'wood',
      kind: 'woodland',
      boundary: square(-150, 150, 80),
      holes: [square(-150, 150, 20)],
      canopyHeightMeters: 15,
      seeThroughMeters: 25,
    },
  ],
  water: [
    { id: 'lake', kind: 'water', boundary: square(150, -150, 60), holes: [square(150, -150, 15)] },
    { id: 'marsh', kind: 'wetland', boundary: square(-200, -220, 40) },
  ],
  waterways: [
    {
      id: 'stream',
      kind: 'stream',
      widthMeters: 3,
      centerline: [
        { x: -280, y: 0 },
        { x: -150, y: 20 },
        { x: -60, y: -10 },
      ],
    },
  ],
  landUse: [
    { id: 'village', kind: 'residential', boundary: square(0, 0, 100) },
    { id: 'green', kind: 'meadow', boundary: square(30, 30, 20) },
  ],
};
const terrain = roughGround(features);

describe('buildingGeometry', () => {
  const built = buildingGeometry(terrain);
  const tris = triangles(built.surfaces);
  const layerOf = (i: number) => built.surfaces.layers[i * 3] ?? NaN;
  const roofs = buildingRoofElevations(terrain);
  const designs = designBuildings(terrain);
  /** The triangles within a building's footprint box, widened by its overhang. */
  const near = (b: (typeof features.buildings)[number], margin: number) => {
    const box = {
      minX: Math.min(...b.footprint.map((p) => p.x)) - margin,
      maxX: Math.max(...b.footprint.map((p) => p.x)) + margin,
      minY: Math.min(...b.footprint.map((p) => p.y)) - margin,
      maxY: Math.max(...b.footprint.map((p) => p.y)) + margin,
    };
    return tris
      .map((t, i) => ({ t, layer: layerOf(i) }))
      .filter(({ t }) =>
        [t.a, t.b, t.c].every(
          (v) => v.x >= box.minX && v.x <= box.maxX && v.y >= box.minY && v.y <= box.maxY,
        ),
      );
  };

  it('keeps every roof where line of sight finds it: at it if flat, around it if pitched', () => {
    for (const b of terrain.features.buildings) {
      const roofZ = roofs.get(b.id) ?? NaN;
      const design = designs.get(b.id);
      const shape = design?.shape;
      if (!design || !shape) throw new Error(`no design for ${b.id}`);
      const corners = b.footprint.map((p) => heightAt(terrain, p.x, p.y));
      const plan = planRoof({
        shape,
        kind: design.style.roof,
        pitchDegrees: design.style.pitchDegrees,
        overhangM: design.style.overhangM,
        reference: roofZ,
        base: Math.min(...corners),
        appearance: b.appearance,
        chance: 0,
      });
      const mine = near(b, 1.5 * design.style.overhangM + 0.01);
      const roof = mine.filter(({ layer }) => layer >= ROOF_LAYER_BASE).map(({ t }) => t);
      expect(roof.length).toBeGreaterThan(0);
      const top = Math.max(...roof.flatMap((t) => [t.a.z, t.b.z, t.c.z]));
      if (plan.kind === 'flat') {
        // The flat roof covers the footprint exactly, at the reference.
        expect(Math.abs(top - roofZ)).toBeLessThan(0.01);
        const area = roof.reduce((sum, t) => sum + triArea(t), 0);
        let footprint = 0;
        b.footprint.forEach((p, i) => {
          const q = b.footprint[(i + 1) % b.footprint.length] ?? p;
          footprint += (p.x * q.y - q.x * p.y) / 2;
        });
        expect(area).toBeCloseTo(Math.abs(footprint), 3);
      } else {
        // The ridge as far above the reference as the eaves are below it.
        expect(top).toBeCloseTo(plan.top, 3);
        if (shape.kind === 'rectangle') expect(plan.top - roofZ).toBeCloseTo(roofZ - plan.eaves, 6);
      }
      // Roof triangles face up.
      for (const t of roof) expect(triArea(t)).toBeGreaterThan(0);
    }
  });

  it('reaches below the ground all along its walls, even across a cliff', () => {
    const b = terrain.features.buildings[1];
    if (!b) throw new Error('no building');
    const bottom = Math.min(
      ...tris
        .flatMap((t) => [t.a, t.b, t.c])
        .filter((v) => v.x > 110 && v.x < 130 && v.y > 40 && v.y < 60)
        .map((v) => v.z),
    );
    for (let i = 0; i < b.footprint.length; i += 1) {
      const p = b.footprint[i];
      const q = b.footprint[(i + 1) % b.footprint.length];
      if (!p || !q) continue;
      for (let t = 0; t <= 1; t += 0.01) {
        expect(bottom).toBeLessThan(
          heightAt(terrain, p.x + t * (q.x - p.x), p.y + t * (q.y - p.y)),
        );
      }
    }
    // Buildings whose uphill corners stand above their roof are counted.
    const buried = terrain.features.buildings.filter((x) =>
      x.footprint.some((p) => heightAt(terrain, p.x, p.y) > (roofs.get(x.id) ?? 0)),
    ).length;
    expect(buried).toBeGreaterThan(0);
    expect(built.buried).toBe(buried);
  });

  it('turns every wall outwards', () => {
    let walls = 0;
    tris.forEach((t, i) => {
      const layer = layerOf(i);
      if (layer < 0 || layer >= ROOF_LAYER_BASE) return; // roofs and trim
      const nx = (t.b.y - t.a.y) * (t.c.z - t.a.z) - (t.b.z - t.a.z) * (t.c.y - t.a.y);
      const ny = (t.b.z - t.a.z) * (t.c.x - t.a.x) - (t.b.x - t.a.x) * (t.c.z - t.a.z);
      const nz = (t.b.x - t.a.x) * (t.c.y - t.a.y) - (t.b.y - t.a.y) * (t.c.x - t.a.x);
      const len = Math.hypot(nx, ny, nz);
      expect(Math.abs(nz) / len).toBeLessThan(1e-3);
      walls += 1;
      // Just in front of the wall (its winding's normal) is outside the
      // building, just behind it inside.
      const cx = (t.a.x + t.b.x + t.c.x) / 3;
      const cy = (t.a.y + t.b.y + t.c.y) / 3;
      const inside = (d: number) =>
        features.buildings.some((b) =>
          pointInPolygon({ x: cx + (d * nx) / len, y: cy + (d * ny) / len }, b.footprint),
        );
      expect(inside(0.05)).toBe(false);
      expect(inside(-0.05)).toBe(true);
    });
    expect(walls).toBeGreaterThan(20);
  });

  it('draws buildings from their ids alone, in muted colours', () => {
    const again = designBuildings(terrain);
    for (const [id, d] of designs) expect(again.get(id)).toEqual(d);
    for (const v of built.surfaces.colors) {
      expect(v).toBeGreaterThan(0.05);
      expect(v).toBeLessThanOrEqual(1);
    }
    // The same buildings in another order give the same meshes.
    const shuffled: TerrainDataset = {
      ...terrain,
      features: { ...features, buildings: [...features.buildings].reverse() },
    };
    const other = buildingGeometry(shuffled);
    expect(Array.from(other.surfaces.colors)).toEqual(Array.from(built.surfaces.colors));
    expect(Array.from(other.surfaces.positions)).toEqual(Array.from(built.surfaces.positions));
    expect(Array.from(other.openings.positions)).toEqual(Array.from(built.openings.positions));
  });
});

describe('boundingSphereOf', () => {
  it('is the sphere Three.js computes', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const positions = Float32Array.from({ length: 3000 }, () => (rnd() - 0.3) * 1000);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.computeBoundingSphere();
    const three = g.boundingSphere;
    const ours = boundingSphereOf(positions);
    expect(ours.center.distanceTo(three?.center ?? ours.center)).toBeLessThan(1e-6);
    expect(ours.radius).toBeCloseTo(three?.radius ?? -1, 6);
  });
});
