/**
 * Characterisation of a defect found in animouse 0.8.0 while building the
 * prototype: FreeformBlendTree.setBlend throws "Invariant violation: no edge
 * data found for outer vertex" for many blend points of an ordinary 2D
 * locomotion layout (clips along the forward axis plus strafes), including
 * points inside the blend space. If an animouse release fixes it, this test
 * fails and the evaluation should be revisited.
 */

import { FreeformBlendTree } from 'animouse';
import * as THREE from 'three';
import { expect, test } from 'vitest';

const mixer = new THREE.AnimationMixer(new THREE.Object3D());
const action = (name: string) =>
  mixer.clipAction(
    new THREE.AnimationClip(name, 1, [new THREE.NumberKeyframeTrack('.x', [0, 1], [0, 1])]),
  );

function failures(points: [string, number, number][]): number {
  const tree = new FreeformBlendTree(points.map(([n, x, y]) => ({ action: action(n), x, y })));
  let fails = 0;
  for (let x = -1; x <= 1.0001; x += 0.05) {
    for (let y = -1; y <= 7.0001; y += 0.05) {
      try {
        tree.setBlend(x, y);
      } catch {
        fails++;
      }
    }
  }
  return fails;
}

test('animouse 0.8.0 FreeformBlendTree throws for a locomotion blend space', () => {
  // Speeds (m/s) measured from the prototype's clips: idle, walk, run,
  // sprint forward; walk back; strafes.
  const n = failures([
    ['idle', 0, 0],
    ['walk', 0, 0.77],
    ['run', 0, 4.6],
    ['sprint', 0, 6.9],
    ['back', 0, -0.85],
    ['left', -0.7, 0],
    ['right', 0.47, 0],
  ]);
  expect(n).toBeGreaterThan(1000); // 2,830 of 6,440 points on 2026-10-14
});

test('points inside the blend space throw too', () => {
  const pts: [string, number, number][] = [
    ['idle', 0, 0],
    ['walk', 0, 0.77],
    ['run', 0, 4.6],
    ['sprint', 0, 6.9],
    ['back', 0, -0.85],
    ['left', -0.7, 0],
    ['right', 0.47, 0],
  ];
  const tree = new FreeformBlendTree(pts.map(([n, x, y]) => ({ action: action(`in-${n}`), x, y })));
  // Convex hull: sprint, right, back, left (counter-clockwise order checked by sign).
  const hull: [number, number][] = [
    [0, 6.9],
    [-0.7, 0],
    [0, -0.85],
    [0.47, 0],
  ];
  const inside = (x: number, y: number) =>
    hull.every(([ax, ay], i) => {
      const [bx, by] = hull[(i + 1) % hull.length] ?? [0, 0];
      return (bx - ax) * (y - ay) - (by - ay) * (x - ax) > 1e-6;
    });
  let insideFails = 0;
  for (let x = -0.7; x <= 0.47; x += 0.01) {
    for (let y = -0.85; y <= 6.9; y += 0.01) {
      if (!inside(x, y)) continue;
      try {
        tree.setBlend(x, y);
      } catch {
        insideFails++;
      }
    }
  }
  expect(insideFails).toBeGreaterThan(0);
});
