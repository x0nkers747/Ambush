import { describe, expect, it } from 'vitest';
import { heightAt, type Road, type RoadClass, type Vec2 } from '#sim';
import { createDraper, finishMesh, type MeshData } from './drape';
import { drapeNetwork, type NetworkLine } from './line-network';
import { ROAD_LAYERS, ROAD_STYLE, roadGeometry, VERGE_M } from './road-geometry';
import { coverage, distanceToLine, roughGround, triangles } from './test-helpers';

// Roads are continuous (docs/adr/0030): the draped network covers every point
// within the width of a road, with no gaps at bends, at the joins between
// ways, or at junctions of any shape, and nothing much beyond it.

const terrain = roughGround();
const draper = createDraper(terrain);

type Line = NetworkLine<'a'>;
const line = (id: string, halfWidth: number, ...pts: [number, number][]): Line => ({
  id,
  style: 'a',
  halfWidth,
  centerline: pts.map(([x, y]) => ({ x, y })),
});

function network(lines: readonly Line[]): MeshData {
  const b = drapeNetwork(lines, draper, () => 0.1).get('a');
  if (!b) throw new Error('nothing drawn');
  return finishMesh(b);
}

/**
 * Samples the area round the lines. Points well inside a line's width must be
 * covered; points clearly outside every line must not be, except near
 * junctions (where a disc as wide as the widest line fills the corners) and
 * beyond free ends.
 */
function checkContinuity(lines: readonly Line[], junctions: readonly Vec2[] = []) {
  const mesh = network(lines);
  const cover = coverage(mesh);
  const pts = lines.flatMap((l) => l.centerline);
  const maxH = Math.max(...lines.map((l) => l.halfWidth));
  const ends = lines.flatMap((l) => [l.centerline[0], l.centerline[l.centerline.length - 1]]);
  const isFreeEnd = (p: Vec2 | undefined) =>
    p !== undefined && ends.filter((q) => q?.x === p.x && q.y === p.y).length === 1;
  const freeEnds = ends.filter(isFreeEnd) as Vec2[];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  let inside = 0;
  for (let x = Math.min(...xs) - 2 * maxH; x <= Math.max(...xs) + 2 * maxH; x += 0.37) {
    for (let y = Math.min(...ys) - 2 * maxH; y <= Math.max(...ys) + 2 * maxH; y += 0.37) {
      if (freeEnds.some((p) => Math.hypot(x - p.x, y - p.y) < 2 * maxH)) continue;
      const ratio = Math.min(...lines.map((l) => distanceToLine(x, y, l.centerline) / l.halfWidth));
      const covered = cover.covered(x, y);
      if (ratio <= 0.95) {
        inside += 1;
        expect(covered, `gap at (${x.toFixed(2)}, ${y.toFixed(2)})`).toBe(true);
      } else if (
        ratio >= 1.06 &&
        !junctions.some((j) => Math.hypot(x - j.x, y - j.y) < 1.06 * maxH)
      ) {
        expect(covered, `spill at (${x.toFixed(2)}, ${y.toFixed(2)})`).toBe(false);
      }
    }
  }
  expect(inside).toBeGreaterThan(100);
  return mesh;
}

// Dense sampling: a few seconds per case on a slow machine.
describe('drapeNetwork', { timeout: 30_000 }, () => {
  it('draws a straight road at its width', () => {
    checkContinuity([line('r', 3, [-100, 0], [100, 10])]);
  });

  it('keeps bends continuous, from gentle to hairpin', () => {
    checkContinuity([line('r', 3, [-100, -50], [0, -50], [10, 40])]);
    checkContinuity([line('r', 4, [-100, -50], [0, -50], [-80, -30])]); // 166° turn
    checkContinuity([line('r', 3, [-100, -50], [0, -50], [-100, -50.5])]); // doubling back
    // A curve of many short segments, tighter than the road is wide.
    const curve: [number, number][] = [];
    for (let a = 0; a <= Math.PI * 1.5; a += Math.PI / 20) {
      curve.push([Math.cos(a) * 3.5 - 50, Math.sin(a) * 3.5 + 20]);
    }
    checkContinuity([line('r', 3, [-150, 20], ...curve.reverse(), [-46.5, 120])]);
  });

  it('joins ways that continue one another, bending or straight', () => {
    checkContinuity([
      line('w1', 3, [-100, 0], [0, 0]),
      line('w2', 3, [0, 0], [60, 25], [120, 30]),
      line('w3', 3, [120, 30], [200, 30]),
    ]);
  });

  it('fills T-junctions, crossroads, shallow and curved junctions', () => {
    const o = { x: 0, y: 0 };
    checkContinuity(
      [line('main', 3, [-100, 0], [0, 0], [100, 0]), line('side', 3, [0, 0], [0, 90])],
      [o],
    );
    checkContinuity(
      [
        line('n', 3, [0, 0], [0, 100]),
        line('s', 3, [0, 0], [0, -100]),
        line('e', 3, [0, 0], [100, 5]),
        line('w', 3, [0, 0], [-100, -5]),
      ],
      [o],
    );
    // A T where the main road is two ways bending 40° at the junction
    // (common in OSM), the side road on the inside of the bend: the outside of the
    // bend is filled by the junction.
    checkContinuity(
      [
        line('main1', 3, [-100, 0], [0, 0]),
        line('main2', 3, [0, 0], [76.6, 64.3]),
        line('side', 3, [0, 0], [-10, 100]),
      ],
      [o],
    );
    // A shallow fork: 8° between the branches.
    checkContinuity(
      [
        line('stem', 3, [-100, 0], [0, 0]),
        line('left', 3, [0, 0], [100, 7]),
        line('right', 3, [0, 0], [100, -7]),
      ],
      [o],
    );
    // A curved side road leaving at a sharp angle.
    checkContinuity(
      [
        line('main', 4, [-100, 0], [0, 0], [100, 0]),
        line('curve', 2, [0, 0], [30, 4], [55, 15], [70, 35], [75, 80]),
      ],
      [o],
    );
  });

  it('fills junctions of mixed widths', () => {
    checkContinuity(
      [
        line('major', 4, [-100, 0], [0, 0], [100, 0]),
        line('path', 0.75, [0, 0], [-40, 90]),
        line('lane', 2, [0, 0], [50, -90]),
      ],
      [{ x: 0, y: 0 }],
    );
    // One way narrowing into the next.
    checkContinuity(
      [line('wide', 4, [-100, 0], [0, 0]), line('narrow', 2, [0, 0], [100, 30])],
      [{ x: 0, y: 0 }],
    );
  });

  it('lies on the ground, whatever its offset', () => {
    const mesh = network([line('r', 3, [-280, -250], [100, 40], [250, 260])]);
    for (const t of triangles(mesh)) {
      for (const v of [t.a, t.b, t.c]) {
        expect(Math.abs(v.z - 0.1 - heightAt(terrain, v.x, v.y))).toBeLessThan(0.01);
      }
    }
  });

  it('does not depend on the order of the ways', () => {
    const lines = [
      line('c', 3, [0, 0], [0, 90]),
      line('a', 3, [-100, 0], [0, 0]),
      line('b', 2, [0, 0], [100, 10], [150, -20]),
    ];
    const a = network(lines);
    const b = network([...lines].reverse());
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
  });
});

describe('roadGeometry', () => {
  const road = (id: string, roadClass: RoadClass, ...pts: [number, number][]): Road => ({
    id,
    roadClass,
    widthMeters: { major: 8, paved: 6, unpaved: 4, track: 3, path: 1.5 }[roadClass],
    centerline: pts.map(([x, y]) => ({ x, y })),
  });

  it('draws one surface: each point covered by one class, the most important there', () => {
    const roads = [
      road('m', 'major', [-200, 0], [0, 0], [200, 0]),
      road('p', 'paved', [0, 0], [0, 200]),
      road('t', 'track', [0, 0], [0, -200]),
      road('f', 'path', [100, 0], [150, -150]),
    ];
    const layers = roadGeometry(roads, draper);
    expect([...layers.keys()]).toEqual(['verge', 'path', 'track', 'paved', 'major']);
    // One height for every layer: none is lifted over another (docs/adr/0044).
    expect(new Set(ROAD_LAYERS.map((l) => ROAD_STYLE[l].offset)).size).toBe(1);
    const cover = new Map([...layers].map(([layer, mesh]) => [layer, coverage(mesh)]));
    const classesAt = (x: number, y: number) =>
      [...cover].filter(([, c]) => c.covered(x, y)).map(([layer]) => layer);
    // The junction and the major road are the major road's; the side roads stop at its edge.
    expect(classesAt(1, 0.5)).toEqual(['major']);
    expect(classesAt(0.5, 3.5)).toEqual(['major']);
    expect(classesAt(0.5, 5)).toEqual(['paved']);
    expect(classesAt(0.5, -5)).toEqual(['track']);
    // Where the path meets the major road it stops at the road's edge.
    expect(classesAt(100.3, -0.5)).toEqual(['major']);
    // No point of any road is covered twice by different classes.
    for (let x = -30; x <= 160; x += 0.7)
      for (let y = -30; y <= 30; y += 0.7) expect(classesAt(x, y).length).toBeLessThanOrEqual(1);
    // The verge shows beyond the edge of the paved road, the track has none.
    expect(classesAt(3 + VERGE_M / 2, 100)).toEqual(['verge']);
    expect(cover.get('verge')?.covered(1.5 + VERGE_M / 2, -100)).toBe(false);
    // Every surface lies on the ground, at the one height.
    for (const [, mesh] of layers)
      for (const tri of triangles(mesh))
        for (const v of [tri.a, tri.b, tri.c])
          expect(v.z - heightAt(terrain, v.x, v.y)).toBeCloseTo(ROAD_STYLE.major.offset, 3);
  });

  it('draws nothing for no roads', () => {
    expect(roadGeometry([], draper).size).toBe(0);
  });
});
