import { describe, expect, it } from 'vitest';
import { Group } from 'three';
import { createSyntheticTerrain, flatElevation, groundFieldInput, NO_FEATURES } from '#sim';
import { compileField, createSurface } from '#sim/terrain-field';
import { createClutter } from './clutter';

// The ground clutter (grass, leaves, pebbles) round the camera: placed from
// the ground's finest tiles, as they arrive; none from high above.

function setup() {
  const terrain = createSyntheticTerrain(
    { originX: -200, originY: -200, cellSize: 5, columns: 81, rows: 81 },
    flatElevation(10),
    NO_FEATURES,
  );
  const surface = createSurface(compileField(groundFieldInput(terrain)), { spacing: 0.5 });
  const clutter = createClutter(surface, new Group());
  /** Loads the finest tiles round (x, y), as the ground's workers would. */
  const load = (x: number, y: number, r: number) => {
    const tileM = surface.cells * surface.spacing;
    for (
      let ty = Math.floor((y - r - surface.originY) / tileM);
      ty <= Math.floor((y + r - surface.originY) / tileM);
      ty += 1
    )
      for (
        let tx = Math.floor((x - r - surface.originX) / tileM);
        tx <= Math.floor((x + r - surface.originX) / tileM);
        tx += 1
      )
        surface.tile(0, tx, ty);
  };
  return { surface, clutter, load };
}

describe('ground clutter', () => {
  it('placed before the ground was loaded, it appears once the tiles arrive, the camera still', () => {
    const { clutter, load } = setup();
    clutter.update(0, 0, 0, false, 2);
    expect(clutter.stats.instances).toBe(0);
    load(0, 0, 70);
    // Not moved: placed again once the tiles have arrived (no sooner than 0.3 s after).
    clutter.update(0, 0, 0.1, false, 2);
    expect(clutter.stats.instances).toBe(0);
    clutter.update(0, 0, 0.5, false, 2);
    expect(clutter.stats.instances).toBeGreaterThan(1000);
  });

  it('none from higher above the ground than its radius (none of it could show)', () => {
    const { clutter, load } = setup();
    load(0, 0, 70);
    clutter.update(0, 0, 0, false, 2);
    expect(clutter.stats.instances).toBeGreaterThan(1000);
    clutter.update(0, 0, 1, false, 500);
    expect(clutter.stats.instances).toBe(0);
    // Down again: placed again.
    clutter.update(0, 0, 2, false, 2);
    expect(clutter.stats.instances).toBeGreaterThan(1000);
  });
});
