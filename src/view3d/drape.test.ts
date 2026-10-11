import { describe, expect, it } from 'vitest';
import { heightAt, polygonArea } from '#sim';
import { createDraper, finishMesh, meshBuffers } from './drape';
import { coverage, random, roughGround, triangles, triArea } from './test-helpers';

// Draped shapes lie exactly on the simulated ground (docs/adr/0030): every
// piece lies in one terrain triangle, so the whole surface, not only its
// corners, is `heightAt` plus the offset.

const terrain = roughGround();
const draper = createDraper(terrain);

function drapeConvex(points: number[], offset = 0.1) {
  const out = meshBuffers();
  draper.convex(points, offset, out);
  return finishMesh(out);
}

describe('createDraper', () => {
  it('puts every point of a draped shape on the ground plus the offset, to 1 cm', () => {
    // A long thin rotated rectangle across the cliff and the rough ground.
    const mesh = drapeConvex([-250, -200, 240, 150, 236, 156, -254, -194], 0.1);
    expect(mesh.triangleCount).toBeGreaterThan(100);
    const rand = random(7);
    for (const t of triangles(mesh)) {
      for (const v of [t.a, t.b, t.c]) {
        expect(Math.abs(v.z - 0.1 - heightAt(terrain, v.x, v.y))).toBeLessThan(0.01);
      }
      // Interior points too: the piece is flat only because it lies in one
      // terrain triangle.
      for (let k = 0; k < 3; k += 1) {
        let u = rand();
        let w = rand();
        if (u + w > 1) [u, w] = [1 - u, 1 - w];
        const x = t.a.x + u * (t.b.x - t.a.x) + w * (t.c.x - t.a.x);
        const y = t.a.y + u * (t.b.y - t.a.y) + w * (t.c.y - t.a.y);
        const z = t.a.z + u * (t.b.z - t.a.z) + w * (t.c.z - t.a.z);
        expect(Math.abs(z - 0.1 - heightAt(terrain, x, y))).toBeLessThan(0.01);
      }
    }
  });

  it('covers the shape exactly: same area, no holes, every triangle facing up', () => {
    const square = [-37, -41, 63, -41, 63, 59, -37, 59];
    const mesh = drapeConvex(square, 0);
    const tris = triangles(mesh);
    for (const t of tris) expect(triArea(t)).toBeGreaterThan(0);
    const area = tris.reduce((s, t) => s + triArea(t), 0);
    expect(area).toBeCloseTo(100 * 100, 6);
    // Clockwise input gives the same.
    const cw = drapeConvex([-37, -41, -37, 59, 63, 59, 63, -41], 0);
    expect(triangles(cw).reduce((s, t) => s + triArea(t), 0)).toBeCloseTo(100 * 100, 6);
    // Normals point up.
    for (let i = 1; i < mesh.normals.length; i += 3) expect(mesh.normals[i]).toBeGreaterThan(0);
    const cover = coverage(mesh);
    const rand = random(3);
    for (let k = 0; k < 2000; k += 1) {
      const x = -36.99 + rand() * 99.98;
      const y = -40.99 + rand() * 99.98;
      expect(cover.covered(x, y)).toBe(true);
    }
  });

  it('cuts away whatever lies off the terrain', () => {
    // Half of this square lies beyond the western edge (x = −300).
    const mesh = drapeConvex([-350, 0, -250, 0, -250, 100, -350, 100], 0);
    const tris = triangles(mesh);
    expect(tris.reduce((s, t) => s + triArea(t), 0)).toBeCloseTo(50 * 100, 6);
    for (const t of tris) for (const v of [t.a, t.b, t.c]) expect(v.x).toBeGreaterThanOrEqual(-300);
    expect(drapeConvex([-400, 0, -350, 0, -350, 50]).triangleCount).toBe(0);
  });

  it('drapes polygons with holes, leaving the holes open', () => {
    const boundary = [
      { x: -100, y: -80 },
      { x: 90, y: -95 },
      { x: 110, y: 60 },
      { x: 10, y: 20 },
      { x: -95, y: 85 },
    ];
    const hole = [
      { x: -40, y: -30 },
      { x: 20, y: -30 },
      { x: 20, y: 0 },
      { x: -40, y: 0 },
    ];
    const out = meshBuffers(true);
    draper.polygon(boundary, [hole], 0.05, out, [0.1, 0.2, 0.3]);
    const mesh = finishMesh(out);
    const area = triangles(mesh).reduce((s, t) => s + triArea(t), 0);
    expect(area).toBeCloseTo(Math.abs(polygonArea(boundary)) - 60 * 30, 4);
    const cover = coverage(mesh);
    expect(cover.covered(-10, -15)).toBe(false); // in the hole
    expect(cover.covered(-60, -50)).toBe(true);
    expect(cover.covered(10, 40)).toBe(false); // in the boundary's notch
    expect(mesh.colors?.length).toBe(mesh.positions.length);
  });

  it('is deterministic', () => {
    const a = drapeConvex([-250, -200, 240, 150, 236, 156, -254, -194]);
    const b = drapeConvex([-250, -200, 240, 150, 236, 156, -254, -194]);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });
});
