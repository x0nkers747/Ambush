import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO, type Exercise } from '#exercise';
import { clearSelection, createSession, selectSoldier, setShowVisibility } from '#session';
import { azimuthOf, soldierId, type Viewshed } from '#sim';
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
const fail = (): never => {
  throw new Error('missing');
};
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
  });

  it('changes range when another Marine with another weapon is selected', () => {
    const { exercise } = setup();
    let session = select(exercise, 'M05');
    const radiusOf = () =>
      wedgeOnScreen(
        buildScene(exercise, session, CAMERA, viewport).engagement ?? fail(),
        CAMERA,
        viewport,
      ).radius;
    expect(radiusOf()).toBeCloseTo(550 / CAMERA.metersPerPixel, 9);
    session = selectSoldier(session, exercise, soldierId('M03'));
    expect(radiusOf()).toBeCloseTo(600 / CAMERA.metersPerPixel, 9);
    session = selectSoldier(session, exercise, soldierId('M02'));
    expect(radiusOf()).toBeCloseTo(550 / CAMERA.metersPerPixel, 9);
  });

  it('follows a slot’s own loadout over its role’s default', () => {
    // A fixture: the 1st fire team's rifleman (slot FT1.R) given a SAW instead of his role's rifle.
    const { organization } = DEMO_SCENARIO;
    const scenario = {
      ...DEMO_SCENARIO,
      organization: {
        ...organization,
        template: {
          ...organization.template,
          slots: organization.template.slots.map((s) =>
            s.id === 'FT1.R'
              ? {
                  ...s,
                  loadout: { weaponProfileRefs: ['squad-automatic-weapon', 'bayonet-knife'] },
                }
              : s,
          ),
        },
      },
    };
    const holderOf = (slotId: string) =>
      organization.members.find((m) => m.slotId === slotId)?.soldierId ?? fail();
    const exercise = createExercise({ config: { tickRateHz: 30, seed: 0 }, scenario });
    const wedgeOf = (slotId: string) =>
      buildScene(exercise, select(exercise, holderOf(slotId)), CAMERA, viewport).engagement;
    expect(wedgeOf('FT1.R')).toMatchObject({ weaponRef: 'squad-automatic-weapon', rangeM: 600 });
    // The other riflemen keep their role's rifle; without the override, so does he.
    expect(wedgeOf('FT2.R')).toMatchObject({ weaponRef: 'm16-rifle', rangeM: 550 });
    expect(wedgeOf('FT3.R')).toMatchObject({ weaponRef: 'm16-rifle', rangeM: 550 });
    const plain = setup().exercise;
    expect(
      buildScene(plain, select(plain, holderOf('FT1.R')), CAMERA, viewport).engagement,
    ).toMatchObject({ weaponRef: 'm16-rifle', rangeM: 550 });
  });

  it('draws none without a known primary firearm, or for OPFOR', () => {
    const withLoadout = (weaponProfileRefs: string[]) => {
      const { organization } = DEMO_SCENARIO;
      const scenario = {
        ...DEMO_SCENARIO,
        organization: {
          ...organization,
          template: {
            ...organization.template,
            slots: organization.template.slots.map((s) =>
              s.id === 'SL' ? { ...s, loadout: { weaponProfileRefs } } : s,
            ),
          },
        },
      };
      const exercise = createExercise({ config: { tickRateHz: 30, seed: 0 }, scenario });
      return buildScene(exercise, select(exercise, 'M01'), CAMERA, viewport).engagement;
    };
    expect(withLoadout(['bayonet-knife'])).toBeNull();
    expect(withLoadout(['m203-grenade-launcher', 'bayonet-knife'])).toBeNull();
    expect(withLoadout(['m4-carbine', 'm203-grenade-launcher'])).toBeNull();
    expect(withLoadout(['m203-grenade-launcher', 'm16-rifle'])).toMatchObject({
      weaponRef: 'm16-rifle',
    });
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

/** The squad leader's wedge, in the ORP, with a planned facing of `degrees`. */
function wedgeFacing(degrees: number, exercise = setup().exercise): EngagementWedge {
  exercise.setFacing(soldierId('M01'), deg(degrees));
  const wedge = engagementWedge(exercise, exercise.simulation.state.soldiers, soldierId('M01'));
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

describe('the wedge and combat (docs/adr/0019)', () => {
  it('shows the weapon each Marine fires, out to its maximum engagement range', () => {
    const { exercise } = setup();
    for (const soldier of exercise.simulation.state.soldiers.filter((s) => s.side === 'BLUEFOR')) {
      const wedge = buildScene(exercise, select(exercise, soldier.id), CAMERA, viewport).engagement;
      const fired = exercise.combatWeapons[soldier.id] ?? null;
      const profile = exercise.combatConfig.weapons.find((w) => w.weaponProfileRef === fired);
      expect(wedge?.weaponRef, soldier.id).toBe(fired);
      expect(wedge?.rangeM, soldier.id).toBe(profile?.maxEngagementRangeM);
    }
  });

  it('is not shown for an incapacitated Marine', () => {
    const { exercise } = setup();
    const scene = buildScene(exercise, select(exercise, 'M01'), CAMERA, viewport);
    const soldiers = scene.soldiers.map((s) =>
      s.id === 'M01' ? { ...s, status: 'incapacitated' as const } : s,
    );
    expect(engagementWedge(exercise, soldiers, soldierId('M01'))).toBeNull();
  });
});

describe('the wedge follows the planned destination and facing', () => {
  const M05 = soldierId('M05');
  const wedgeOf = (exercise: Exercise, id: string, camera: Camera = CAMERA) =>
    buildScene(exercise, select(exercise, id), camera, viewport).engagement;
  const where = (exercise: Exercise, id: string) => {
    const s = exercise.simulation.state.soldiers.find((x) => x.id === id) ?? fail();
    return { position: { x: s.position.x, y: s.position.y }, azimuth: s.azimuth };
  };
  /** A destination 30 m north-east of where M05 stands. */
  const destinationFor = (exercise: Exercise) => {
    const { position } = where(exercise, 'M05');
    return { x: position.x + 20, y: position.y + 22 };
  };

  it('without a destination, stands where the Marine is and faces his current way', () => {
    const { exercise } = setup();
    const now = where(exercise, 'M05');
    expect(wedgeOf(exercise, 'M05')).toMatchObject({ origin: now.position, azimuth: now.azimuth });
  });

  it('moves to a new destination at once, facing the way he will arrive', () => {
    const { exercise } = setup();
    const before = where(exercise, 'M05');
    const destination = destinationFor(exercise);
    exercise.setDestination(M05, destination);
    const wedge = wedgeOf(exercise, 'M05');
    expect(wedge?.origin).toEqual(destination);
    // No facing chosen: the planning convention, the direction of arrival (the facing arrow's).
    const planned = exercise.displayedFacing(M05) ?? fail();
    expect(planned.explicit).toBe(false);
    expect(wedge?.azimuth).toBe(planned.azimuth);
    const route = exercise.displayedRoute(M05) ?? fail();
    const leg = route.legs[0] ?? fail();
    const path = [route.start, ...(leg.turns ?? []), leg.to];
    const last = path[path.length - 1] ?? fail();
    const previous = path[path.length - 2] ?? fail();
    expect(wedge?.azimuth).toBeCloseTo(azimuthOf(last.x - previous.x, last.y - previous.y), 12);
    // The Marine himself has not moved or turned.
    expect(where(exercise, 'M05')).toEqual(before);
  });

  it('turns to the planned facing at once, at the destination or where he stands', () => {
    const { exercise } = setup();
    exercise.setFacing(M05, deg(200));
    expect(wedgeOf(exercise, 'M05')).toMatchObject({
      origin: where(exercise, 'M05').position,
      azimuth: expect.closeTo(deg(200), 12) as number,
    });
    const destination = destinationFor(exercise);
    exercise.setDestination(M05, destination);
    expect(wedgeOf(exercise, 'M05')).toMatchObject({
      origin: destination,
      azimuth: expect.closeTo(deg(200), 12) as number,
    });
    exercise.setFacing(M05, deg(15));
    expect(wedgeOf(exercise, 'M05')?.azimuth).toBeCloseTo(deg(15), 12);
    // Back to the default facing: the direction of arrival again.
    exercise.clearFacing(M05);
    expect(wedgeOf(exercise, 'M05')?.azimuth).toBe(exercise.displayedFacing(M05)?.azimuth);
  });

  it('follows the destination when it is moved, and the last one set', () => {
    const { exercise } = setup();
    const first = destinationFor(exercise);
    exercise.setDestination(M05, first);
    const second = { x: first.x - 15, y: first.y + 6 };
    exercise.setDestination(M05, second);
    expect(wedgeOf(exercise, 'M05')?.origin).toEqual(second);
    const third = { x: second.x + 3, y: second.y - 9 };
    exercise.setDestination(M05, third);
    expect(wedgeOf(exercise, 'M05')?.origin).toEqual(third);
  });

  it('returns to where the Marine stands when the destination is deleted or the plan reset', () => {
    const { exercise } = setup();
    const now = where(exercise, 'M05');
    exercise.setDestination(M05, destinationFor(exercise));
    exercise.clearDestination(M05);
    expect(wedgeOf(exercise, 'M05')).toMatchObject({ origin: now.position, azimuth: now.azimuth });
    // A chosen facing survives deleting the destination, as in the plan.
    exercise.setDestination(M05, destinationFor(exercise));
    exercise.setFacing(M05, deg(300));
    exercise.clearDestination(M05);
    expect(wedgeOf(exercise, 'M05')).toMatchObject({
      origin: now.position,
      azimuth: expect.closeTo(deg(300), 12) as number,
    });
    exercise.resetPlan(M05);
    expect(wedgeOf(exercise, 'M05')).toMatchObject({ origin: now.position, azimuth: now.azimuth });
  });

  it('shows each selected Marine’s own plan, and nothing when deselected', () => {
    const { exercise } = setup();
    const destination = destinationFor(exercise);
    exercise.setDestination(M05, destination);
    exercise.setFacing(soldierId('M03'), deg(45));
    expect(wedgeOf(exercise, 'M05')?.origin).toEqual(destination);
    const other = wedgeOf(exercise, 'M03');
    expect(other?.origin).toEqual(where(exercise, 'M03').position);
    expect(other?.azimuth).toBeCloseTo(deg(45), 12);
    const session = clearSelection(select(exercise, 'M05'));
    expect(buildScene(exercise, session, CAMERA, viewport).engagement).toBeNull();
  });

  it('keeps the weapon, its range and the 35° width at the destination', () => {
    const { exercise } = setup();
    exercise.setDestination(M05, destinationFor(exercise));
    exercise.setFacing(M05, deg(80));
    const rifle = wedgeOf(exercise, 'M05') ?? fail();
    expect(rifle).toMatchObject({ weaponRef: 'm16-rifle', rangeM: 550 });
    const [left, right] = wedgeEdges(rifle);
    expect(right - left).toBeCloseTo(deg(35), 12);
    expect((left + right) / 2).toBeCloseTo(deg(80), 12);
    const saw = soldierId('M03');
    const { position } = where(exercise, 'M03');
    exercise.setDestination(saw, { x: position.x - 20, y: position.y + 20 });
    expect(wedgeOf(exercise, 'M03')).toMatchObject({
      weaponRef: 'squad-automatic-weapon',
      rangeM: 600,
    });
  });

  it('stays at the destination on screen when panning and zooming', () => {
    const { exercise } = setup();
    const destination = destinationFor(exercise);
    exercise.setDestination(M05, destination);
    for (const camera of [
      CAMERA,
      { centerX: destination.x, centerY: destination.y, metersPerPixel: 0.05 },
      { centerX: 300, centerY: -200, metersPerPixel: 2.5 },
    ]) {
      const wedge = wedgeOf(exercise, 'M05', camera) ?? fail();
      const { apex, radius } = wedgeOnScreen(wedge, camera, viewport);
      const at = worldToScreen(camera, viewport, destination);
      expect(apex.x).toBeCloseTo(at.x, 9);
      expect(apex.y).toBeCloseTo(at.y, 9);
      expect(radius).toBeCloseTo(550 / camera.metersPerPixel, 9);
    }
  });

  it('shares its point with the visibility overlay', () => {
    const { exercise } = setup();
    exercise.setDestination(M05, destinationFor(exercise));
    expect(wedgeOf(exercise, 'M05')?.origin).toEqual(exercise.observer(M05)?.point);
  });

  it('shows where the Marine really is while the exercise runs', () => {
    const { exercise } = setup();
    exercise.setDestination(M05, destinationFor(exercise));
    exercise.setFacing(M05, deg(120));
    expect(exercise.execute().ok).toBe(true);
    exercise.advance(1, 4); // part of the way
    expect(exercise.canEditPlans).toBe(false);
    const now = where(exercise, 'M05');
    expect(wedgeOf(exercise, 'M05')).toMatchObject({ origin: now.position, azimuth: now.azimuth });
    // Paused, the plans are editable again and the wedge shows the plan.
    exercise.pause();
    const draft = { x: now.position.x - 5, y: now.position.y + 5 };
    exercise.setDestination(M05, draft);
    expect(wedgeOf(exercise, 'M05')?.origin).toEqual(draft);
  });
});
