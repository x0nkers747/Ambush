import { describe, expect, it } from 'vitest';
import {
  createExercise,
  DEMO_SCENARIO,
  engagementWeapon,
  WEAPON_DISPLAY_RANGES,
  type Exercise,
} from '#exercise';
import { clearSelection, createSession, selectSoldier, setShowVisibility } from '#session';
import { soldierId, type Viewshed } from '#sim';
import { worldToScreen, type Camera } from './camera';
import {
  ENGAGEMENT_WEDGE_WIDTH_DEG,
  engagementWedge,
  pointAlong,
  wedgeEdges,
  wedgeOnScreen,
  type EngagementWedge,
} from './engagement';
import { createGeoCache, type CacheCanvas, type CacheContext } from './geo-cache';
import { hasVisibilityOverlay } from './render';
import { buildScene, type MapScene } from './scene';

// The selected Marine's weapon engagement wedge on the demo squad (the MCWP
// 3-11.2 rifle squad): when it shows, its shape, its range and its place on
// screen. Display only: nothing here touches the simulation.

const viewport = { width: 1200, height: 900 };
const CAMERA: Camera = { centerX: 0, centerY: 0, metersPerPixel: 0.75 };
const deg = (d: number) => (d * Math.PI) / 180;

function setup() {
  const exercise = createExercise({ config: { tickRateHz: 30, seed: 0 }, scenario: DEMO_SCENARIO });
  return { exercise, session: createSession() };
}
const select = (exercise: Exercise, id: string) =>
  selectSoldier(createSession(), exercise, soldierId(id));

describe('the engagement wedge in the scene', () => {
  it('shows for the selected Marine only, follows the selection, and hides when deselected', () => {
    const { exercise, session } = setup();
    expect(buildScene(exercise, session, CAMERA, viewport).engagement).toBeNull();
    const first = select(exercise, 'M01');
    expect(buildScene(exercise, first, CAMERA, viewport).engagement?.soldierId).toBe('M01');
    const other = selectSoldier(first, exercise, soldierId('M03'));
    expect(buildScene(exercise, other, CAMERA, viewport).engagement?.soldierId).toBe('M03');
    expect(buildScene(exercise, clearSelection(other), CAMERA, viewport).engagement).toBeNull();
  });

  it('starts at the Marine and points the way he faces now', () => {
    const { exercise } = setup();
    const scene = buildScene(exercise, select(exercise, 'M05'), CAMERA, viewport);
    const soldier = exercise.simulation.state.soldiers.find((s) => s.id === 'M05');
    expect(scene.engagement?.origin).toEqual({ x: soldier?.position.x, y: soldier?.position.y });
    expect(scene.engagement?.azimuth).toBe(soldier?.azimuth);
  });

  it('reaches as far as the Marine’s weapon: rifle 550 m, SAW 600 m', () => {
    const { exercise } = setup();
    const wedgeOf = (id: string) =>
      buildScene(exercise, select(exercise, id), CAMERA, viewport).engagement;
    // Squad leader and rifleman: M16A2. Automatic rifleman: M249 SAW.
    expect(wedgeOf('M01')).toMatchObject({ weaponRef: 'm16-rifle', rangeM: 550 });
    expect(wedgeOf('M05')).toMatchObject({ weaponRef: 'm16-rifle', rangeM: 550 });
    expect(wedgeOf('M03')).toMatchObject({ weaponRef: 'squad-automatic-weapon', rangeM: 600 });
    // The fire team leader carries rifle and grenade launcher: the rifle, his primary weapon.
    expect(wedgeOf('M02')).toMatchObject({ weaponRef: 'm16-rifle', rangeM: 550 });
    expect(WEAPON_DISPLAY_RANGES['m203-grenade-launcher']?.effectiveRangeM).toBe(150);
  });

  it('draws none for a loadout without a weapon range, or for OPFOR', () => {
    expect(engagementWeapon({ weaponProfileRefs: ['bayonet-knife', 'combat-knife'] })).toBeNull();
    expect(
      engagementWeapon({ weaponProfileRefs: ['m203-grenade-launcher', 'm16-rifle'] })?.ref,
    ).toBe('m203-grenade-launcher');
    const { exercise } = setup();
    const { soldiers } = exercise.simulation.state;
    expect(engagementWedge(exercise, soldiers, soldierId('EN-1'))).toBeNull();
  });

  it('moves with the Marine and turns with him', () => {
    const { exercise } = setup();
    const id = soldierId('M05');
    const soldier = exercise.simulation.state.soldiers.find((s) => s.id === id);
    if (!soldier) throw new Error('no M05');
    // A copy: the simulation updates its state in place.
    const start = { position: { ...soldier.position } };
    exercise.setDestination(id, { x: start.position.x + 25, y: start.position.y + 5 });
    exercise.setFacing(id, deg(120));
    const session = select(exercise, 'M05');
    expect(exercise.execute().ok).toBe(true);
    for (let i = 0; i < 400 && exercise.phase === 'bluforOccupation'; i += 1)
      exercise.advance(1, 4);
    const now = exercise.simulation.state.soldiers.find((s) => s.id === id);
    const wedge = buildScene(exercise, session, CAMERA, viewport).engagement;
    expect(wedge?.origin).toEqual({ x: now?.position.x, y: now?.position.y });
    expect(wedge?.origin.x).not.toBeCloseTo(start.position.x, 3);
    expect(wedge?.azimuth).toBeCloseTo(deg(120), 6);
  });
});

/** A wedge for a soldier standing at (100, −50) facing `degrees`. */
function wedgeFacing(degrees: number, exercise = setup().exercise): EngagementWedge {
  const soldiers = exercise.simulation.state.soldiers.map((s) =>
    s.id === 'M01' ? { ...s, position: { x: 100, y: -50, z: 0 }, azimuth: deg(degrees) } : s,
  );
  const wedge = engagementWedge(exercise, soldiers, soldierId('M01'));
  if (!wedge) throw new Error('no wedge');
  return wedge;
}

describe('wedge geometry', () => {
  it('is exactly 35° wide, bisected by the facing', () => {
    expect(ENGAGEMENT_WEDGE_WIDTH_DEG).toBe(35);
    for (const facing of [0, 37, 90, 181.5, 270]) {
      const wedge = wedgeFacing(facing);
      const [left, right] = wedgeEdges(wedge);
      expect(right - left).toBeCloseTo(deg(35), 12);
      expect((left + right) / 2).toBeCloseTo(deg(facing), 12);
      expect(wedge.azimuth - left).toBeCloseTo(deg(17.5), 12);
      expect(right - wedge.azimuth).toBeCloseTo(deg(17.5), 12);
    }
  });

  it('turns with the facing, on the map and on screen', () => {
    for (const facing of [0, 45, 90, 200, 315]) {
      const wedge = wedgeFacing(facing);
      const { apex, radius, start, end } = wedgeOnScreen(wedge, CAMERA, viewport);
      // The middle of the arc on screen is the map point at full range straight ahead.
      const mid = (start + end) / 2;
      const ahead = worldToScreen(CAMERA, viewport, pointAlong(wedge.origin, wedge.azimuth, 550));
      expect(apex.x + radius * Math.cos(mid)).toBeCloseTo(ahead.x, 6);
      expect(apex.y + radius * Math.sin(mid)).toBeCloseTo(ahead.y, 6);
    }
    // East (090°) is to the right on screen, south (180°) down.
    const east = wedgeOnScreen(wedgeFacing(90), CAMERA, viewport);
    expect(Math.cos((east.start + east.end) / 2)).toBeCloseTo(1, 12);
    const south = wedgeOnScreen(wedgeFacing(180), CAMERA, viewport);
    expect(Math.sin((south.start + south.end) / 2)).toBeCloseTo(1, 12);
  });

  it('spans north when facing across 0°/360°', () => {
    for (const facing of [350, 355, 359.9, 0, 5, 10]) {
      const wedge = wedgeFacing(facing);
      const [left, right] = wedgeEdges(wedge);
      const edge = (a: number) => pointAlong(wedge.origin, a, 100);
      // The edges are 17.5° either side of the facing, whichever side of north it lies.
      const leftDeg = (((facing - 17.5) % 360) + 360) % 360;
      const rightDeg = (facing + 17.5) % 360;
      expect(edge(left).x).toBeCloseTo(edge(deg(leftDeg)).x, 9);
      expect(edge(left).y).toBeCloseTo(edge(deg(leftDeg)).y, 9);
      expect(edge(right).x).toBeCloseTo(edge(deg(rightDeg)).x, 9);
      expect(edge(right).y).toBeCloseTo(edge(deg(rightDeg)).y, 9);
      // Due north lies inside the wedge: its screen angle (−90°) is between the arc's ends.
      const { start, end } = wedgeOnScreen(wedge, CAMERA, viewport);
      const north = -Math.PI / 2;
      const within = [north - 2 * Math.PI, north, north + 2 * Math.PI].some(
        (a) => a >= start && a <= end,
      );
      expect(within).toBe(true);
    }
  });

  it('stays aligned with the map when panning and zooming', () => {
    const wedge = wedgeFacing(63);
    for (const camera of [
      CAMERA,
      { centerX: 400, centerY: -300, metersPerPixel: 0.75 },
      { centerX: 100, centerY: -50, metersPerPixel: 0.1 },
      { centerX: -2000, centerY: 900, metersPerPixel: 5.9 },
    ]) {
      const { apex, radius, start, end } = wedgeOnScreen(wedge, camera, viewport);
      const origin = worldToScreen(camera, viewport, wedge.origin);
      expect(apex.x).toBeCloseTo(origin.x, 9);
      expect(apex.y).toBeCloseTo(origin.y, 9);
      expect(radius).toBeCloseTo(550 / camera.metersPerPixel, 9);
      for (const [angle, azimuth] of [
        [start, wedgeEdges(wedge)[0]],
        [end, wedgeEdges(wedge)[1]],
      ] as const) {
        const tip = worldToScreen(camera, viewport, pointAlong(wedge.origin, azimuth, 550));
        expect(apex.x + radius * Math.cos(angle)).toBeCloseTo(tip.x, 6);
        expect(apex.y + radius * Math.sin(angle)).toBeCloseTo(tip.y, 6);
      }
    }
  });
});

describe('the wedge and the rest of the map', () => {
  it('leaves the visibility overlay as it was', () => {
    const { exercise } = setup();
    const viewshed = {
      grid: {},
      observer: { x: 0, y: 0 },
      visible: new Uint8Array(),
    } as unknown as Viewshed;
    const visibility = { observer: { x: 0, y: 0 }, planned: false, viewshed, pending: false };
    const selected = select(exercise, 'M01');
    const on = buildScene(
      exercise,
      setShowVisibility(selected, true),
      CAMERA,
      viewport,
      visibility,
    );
    const off = buildScene(exercise, selected, CAMERA, viewport, visibility);
    // The overlay shows exactly when it did before, with or without the wedge.
    expect(on.visibility).toBe(visibility);
    expect(off.visibility).toBeNull();
    // The wedge does not depend on it.
    expect(on.engagement).toEqual(off.engagement);
  });

  it('never makes the cached map redraw: selecting and turning only redraw the tactical layer', () => {
    const { exercise } = setup();
    const canvases: CacheCanvas[] = [];
    const noop = () => undefined;
    const ctx = {
      save: noop,
      restore: noop,
      setTransform: noop,
      beginPath: noop,
      rect: noop,
      clip: noop,
      clearRect: noop,
      fillRect: noop,
      drawImage: noop,
      fillStyle: '',
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'low',
    } as unknown as CacheContext;
    let painted = 0;
    const cache = createGeoCache<MapScene>(
      {
        ground: [() => (painted += 1)],
        features: [() => (painted += 1)],
        between: () => undefined,
        hasBetween: hasVisibilityOverlay,
      },
      (width, height) => {
        const c = { width, height, getContext: () => ctx };
        canvases.push(c);
        return c;
      },
      (s, camera) => ({ ...s, camera }),
      '#000',
    );
    const view = { camera: CAMERA, viewport, width: 1200, height: 900 };
    const frame = (scene: MapScene, now: number) => {
      cache.draw(ctx, scene, view, CAMERA, now);
    };
    frame(buildScene(exercise, createSession(), CAMERA, viewport), 0);
    expect(painted).toBe(2);
    let t = 0;
    for (const id of ['M01', 'M03', 'M05', 'M02']) {
      const scene = buildScene(exercise, select(exercise, id), CAMERA, viewport);
      expect(scene.engagement).not.toBeNull();
      for (let i = 0; i < 5; i += 1) frame(scene, (t += 16));
    }
    frame(buildScene(exercise, createSession(), CAMERA, viewport), t + 16);
    expect(painted).toBe(2);
    expect(cache.stats).toMatchObject({ renders: 1, reuses: 21 });
  });
});
