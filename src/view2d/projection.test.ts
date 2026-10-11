import { describe, expect, it } from 'vitest';
import {
  createExercise,
  type AmbushScenario,
  type Exercise,
  type OrganizationTemplate,
} from '#exercise';
import { createSession, selectFireTeam, setShowVisibility, setTool, type Session } from '#session';
import { createSyntheticTerrain, flatElevation, soldierId, type Vec2 } from '#sim';
import { createMapActions } from './actions';
import { worldToScreen, type Camera } from './camera';
import { createMapController, type MapController } from './interaction';
import {
  buildScene,
  cameraProjection,
  deploymentGeometry,
  FACING_ARROW_PX,
  type MapProjection,
  type MapScene,
} from './scene';

// The tactical map's gameplay through any projection (docs/adr/0039): the 2D
// map's plan view, or another view's (the 3D battlefield's ground). The same
// gestures at the same map points must give the same commands, the same plans
// and the same bearings, whatever the projection; the 2D projection must be
// exactly what the map always did.

const A = soldierId('A');

/** A synthetic two-person team (represents no real organization). */
const PAIR: OrganizationTemplate = {
  schema: 'ambush.organization-template',
  schemaVersion: 2,
  id: 'projection-pair',
  version: '1.0.0',
  name: 'Projection test pair',
  source: { kind: 'synthetic', title: 'Projection test pair', notes: 'Test fixture.' },
  conventions: [],
  roles: [{ id: 'member', name: 'Member', abbreviation: 'M', defaultIcon: 'rifleman' }],
  units: [
    {
      id: 'TM',
      name: 'Team',
      abbreviation: 'TM',
      echelon: 'fireTeam',
      parentId: null,
      leaderSlotId: null,
    },
  ],
  slots: [
    { id: 'm1', unitId: 'TM', roleId: 'member', label: 'M1' },
    { id: 'm2', unitId: 'TM', roleId: 'member', label: 'M2' },
  ],
};

const SCENARIO: AmbushScenario = {
  id: 'projection-test',
  terrain: createSyntheticTerrain(
    { originX: -150, originY: -150, cellSize: 30, columns: 11, rows: 11 },
    flatElevation(0),
    { roads: [], buildings: [], vegetation: [] },
  ),
  movement: { speed: 2, maxTurnRate: Math.PI / 2 },
  units: [
    { id: 'TM', echelon: 'fireTeam', parentId: null, leaderId: null },
    { id: 'EN', echelon: 'fireTeam', parentId: null, leaderId: null },
  ],
  soldiers: [
    {
      id: 'A',
      side: 'BLUEFOR',
      unitId: 'TM',
      position: { x: 0, y: 0 },
      azimuthDeg: 0,
      posture: 'standing',
    },
    {
      id: 'B',
      side: 'BLUEFOR',
      unitId: 'TM',
      position: { x: 50, y: 0 },
      azimuthDeg: 0,
      posture: 'standing',
    },
    {
      id: 'E',
      side: 'OPFOR',
      unitId: 'EN',
      position: { x: 0, y: 100 },
      azimuthDeg: 180,
      posture: 'standing',
    },
  ],
  opforRoutes: [],
  orp: {
    id: 'ORP-P',
    name: 'ORP',
    centre: { east: 25, north: 0 },
    shape: { kind: 'circle', radiusM: 30 },
  },
  organization: {
    template: PAIR,
    unitIdPrefix: '',
    members: [
      { soldierId: 'A', slotId: 'm1' },
      { soldierId: 'B', slotId: 'm2' },
    ],
  },
};

const CAMERA: Camera = { centerX: 0, centerY: 0, metersPerPixel: 1 };
const VIEWPORT = { width: 400, height: 400 };

/**
 * A stand-in for the 3D ground projection: a different scale, a rotation
 * (north is not up), shear (an oblique view) and a lift that moves points up
 * the screen. Its `along` and `line` work as the 3D view's do: the bearing's
 * direction comes from projecting map points, and lines get extra points.
 */
function obliqueProjection(): MapProjection {
  const rot = (35 * Math.PI) / 180;
  const toScreen = (p: Vec2, lift = 0) => {
    const x = 1.7 * (p.x * Math.cos(rot) - p.y * Math.sin(rot));
    const y = 1.7 * (p.x * Math.sin(rot) + p.y * Math.cos(rot));
    return { x: 300 + x + 0.4 * y, y: 260 - 0.6 * y - 8 * lift };
  };
  const toWorld = (s: Vec2): Vec2 => {
    const y = (260 - s.y) / 0.6;
    const x = s.x - 300 - 0.4 * y;
    const mx = (x * Math.cos(rot) + y * Math.sin(rot)) / 1.7;
    const my = (-x * Math.sin(rot) + y * Math.cos(rot)) / 1.7;
    return { x: mx, y: my };
  };
  return {
    toScreen,
    toWorld,
    along: (point, azimuth, px) => {
      const a = toScreen(point);
      const b = toScreen({ x: point.x + Math.sin(azimuth), y: point.y + Math.cos(azimuth) });
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      return { x: a.x + ((b.x - a.x) / l) * px, y: a.y + ((b.y - a.y) / l) * px };
    },
    line: (points) =>
      points.flatMap((b, i) => {
        const a = points[i - 1];
        if (!a) return [toScreen(b)];
        return [1, 2, 3, 4].map((k) =>
          toScreen({ x: a.x + ((b.x - a.x) * k) / 4, y: a.y + ((b.y - a.y) * k) / 4 }),
        );
      }),
    perspective: true,
  };
}

interface Ui {
  readonly exercise: Exercise;
  readonly session: Session;
  readonly controller: MapController;
  scene(): MapScene;
  /** A click at a map point (on the ground, or at a soldier's middle with `lift`). */
  click(p: Vec2, button?: number, lift?: number): void;
  /** A drag between screen points. */
  drag(from: Vec2, to: Vec2): void;
  setSession(next: Session): void;
}

function setup(projection: MapProjection | null): Ui {
  const exercise = createExercise({ config: { tickRateHz: 10, seed: 0 }, scenario: SCENARIO });
  let session: Session = createSession();
  const actions = createMapActions(
    exercise,
    {
      get: () => session,
      set: (next) => {
        session = next;
      },
    },
    () => undefined,
  );
  const scene = () =>
    buildScene(
      exercise,
      session,
      CAMERA,
      VIEWPORT,
      null,
      false,
      projection ?? cameraProjection(CAMERA, VIEWPORT),
    );
  const controller = createMapController(scene, actions);
  const project = (p: Vec2, lift = 0) => scene().projection.toScreen(p, lift);
  return {
    exercise,
    get session() {
      return session;
    },
    controller,
    scene,
    click(p, button = 0, lift = 0) {
      const s = project(p, lift);
      controller.pointerDown({ ...s, button });
      controller.pointerUp({ ...s, button });
    },
    drag(from, to) {
      controller.pointerDown({ ...from, button: 0 });
      for (let i = 1; i <= 5; i += 1) {
        controller.pointerMove({
          x: from.x + ((to.x - from.x) * i) / 5,
          y: from.y + ((to.y - from.y) * i) / 5,
          button: 0,
        });
      }
      controller.pointerUp({ ...to, button: 0 });
    },
    setSession(next) {
      session = next;
    },
  };
}

/** The same planning session, gesture by gesture at the same map points, in a view. */
function plan(ui: Ui) {
  // Select A at his middle (in 3D the figure stands above his ground point).
  ui.click({ x: 0, y: 0 }, 0, 0.9);
  // A destination, then dragged elsewhere.
  ui.click({ x: 40, y: 30 });
  const destination = ui.scene().projection.toScreen({ x: 40, y: 30 });
  ui.drag(destination, ui.scene().projection.toScreen({ x: 60, y: 20 }));
  // Face due east: drag the arrow tip toward a point east of the destination.
  const tip = deploymentGeometry(ui.scene())?.facingTip;
  if (!tip) throw new Error('no facing arrow');
  ui.drag(tip, ui.scene().projection.toScreen({ x: 90, y: 20 }));
  // A's own plan, before the fire team's formation takes him over.
  const draftA = ui.exercise.draft(A);
  // A kill zone, a corner moved, another deleted with a right click.
  ui.setSession(setTool(ui.session, 'killZone'));
  for (const p of [
    { x: -40, y: 60 },
    { x: 40, y: 60 },
    { x: 40, y: 110 },
    { x: -40, y: 110 },
  ]) {
    ui.click(p);
  }
  ui.drag(
    ui.scene().projection.toScreen({ x: 40, y: 110 }),
    ui.scene().projection.toScreen({ x: 50, y: 120 }),
  );
  ui.click({ x: -40, y: 110 }, 2);
  // The fire team placed by a click, then turned.
  ui.setSession(setTool(ui.session, 'deploy'));
  ui.setSession(selectFireTeam(ui.session, ui.exercise, 'TM'));
  ui.click({ x: -60, y: -60 });
  const formation = ui.exercise.formation('TM');
  if (!formation) throw new Error('no formation');
  ui.drag(
    ui.scene().projection.along(formation.centre, formation.azimuth, FACING_ARROW_PX),
    ui.scene().projection.toScreen({ x: formation.centre.x, y: formation.centre.y - 30 }),
  );
  return {
    selected: ui.session.selectedFireTeamId,
    draftA,
    killZone: ui.exercise.killZone?.vertices.map((v) => ({ x: v.x, y: v.y })),
    formation: ui.exercise.formation('TM'),
  };
}

describe('MapProjection', () => {
  it('the 2D projection is exactly the map camera: points, arrows and lines', () => {
    const p = cameraProjection(CAMERA, VIEWPORT);
    for (const point of [
      { x: 0, y: 0 },
      { x: 37.5, y: -12.25 },
    ]) {
      expect(p.toScreen(point)).toEqual(worldToScreen(CAMERA, VIEWPORT, point));
      // Lift means nothing in plan view.
      expect(p.toScreen(point, 5)).toEqual(p.toScreen(point));
      const at = p.toScreen(point);
      const az = 1.1;
      expect(p.along(point, az, 42)).toEqual({
        x: at.x + Math.sin(az) * 42,
        y: at.y - Math.cos(az) * 42,
      });
      const w = p.toWorld(at);
      expect(w?.x).toBeCloseTo(point.x, 9);
      expect(w?.y).toBeCloseTo(point.y, 9);
    }
    expect(
      p.line([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ]),
    ).toHaveLength(2);
    expect(p.perspective).toBe(false);
  });

  it('the same gestures at the same map points give the same plans in 2D and in another view', () => {
    const plan2d = plan(setup(null));
    const plan3d = plan(setup(obliqueProjection()));
    expect(plan2d.selected).toBe('TM');
    expect(plan3d.selected).toBe('TM');
    // Positions picked through each view agree to rounding.
    const dest2d = plan2d.draftA?.destination;
    const dest3d = plan3d.draftA?.destination;
    expect(dest2d?.east).toBeCloseTo(60, 6);
    expect(dest2d?.north).toBeCloseTo(20, 6);
    expect(dest3d?.east).toBeCloseTo(60, 6);
    expect(dest3d?.north).toBeCloseTo(20, 6);
    expect(plan2d.killZone).toHaveLength(3);
    expect(plan3d.killZone).toHaveLength(3);
    plan2d.killZone?.forEach((v, i) => {
      expect(plan3d.killZone?.[i]?.x).toBeCloseTo(v.x, 6);
      expect(plan3d.killZone?.[i]?.y).toBeCloseTo(v.y, 6);
    });
    expect(plan3d.formation?.centre.x).toBeCloseTo(plan2d.formation?.centre.x ?? NaN, 6);
    expect(plan3d.formation?.centre.y).toBeCloseTo(plan2d.formation?.centre.y ?? NaN, 6);
  });

  it('bearings are the map’s in every view: dragging toward the east faces 090°', () => {
    for (const projection of [null, obliqueProjection()]) {
      const result = plan(setup(projection));
      expect(result.draftA?.facingDegrees).toBeCloseTo(90, 6);
      // The formation turned toward the south: 180°.
      expect(((result.formation?.azimuth ?? NaN) * 180) / Math.PI).toBeCloseTo(180, 6);
    }
  });

  it('a press on a handle holds it (the 3D camera then stays still); elsewhere it does not', () => {
    const ui = setup(obliqueProjection());
    ui.click({ x: 0, y: 0 }, 0, 0.9);
    ui.click({ x: 40, y: 30 });
    const destination = ui.scene().projection.toScreen({ x: 40, y: 30 });
    ui.controller.pointerDown({ ...destination, button: 0 });
    expect(ui.controller.holdingHandle).toBe(true);
    ui.controller.pointerUp({ ...destination, button: 0 });
    const empty = ui.scene().projection.toScreen({ x: -100, y: -100 });
    ui.controller.pointerDown({ ...empty, button: 0 });
    expect(ui.controller.holdingHandle).toBe(false);
    ui.controller.cancel();
  });

  it('a point a view cannot draw (NaN, behind a 3D camera) hits nothing; no ground under the pointer edits nothing', () => {
    const base = obliqueProjection();
    const blind: MapProjection = {
      ...base,
      toScreen: () => ({ x: Number.NaN, y: Number.NaN }),
      toWorld: () => null,
    };
    const ui = setup(blind);
    ui.controller.pointerDown({ x: 300, y: 260, button: 0 });
    ui.controller.pointerUp({ x: 300, y: 260, button: 0 });
    expect(ui.session.selectedSoldierId).toBeNull();
    ui.setSession({ ...ui.session, selectedSoldierId: A });
    ui.controller.pointerDown({ x: 10, y: 10, button: 0 });
    ui.controller.pointerUp({ x: 10, y: 10, button: 0 });
    expect(ui.exercise.draft(A)?.destination ?? null).toBeNull();
  });

  it('what the scene shows (combat, viewshed, plans) does not depend on the projection', () => {
    const ui2d = setup(null);
    const ui3d = setup(obliqueProjection());
    for (const ui of [ui2d, ui3d]) ui.setSession(setShowVisibility(ui.session, true));
    const strip = (s: MapScene) => ({
      plans: s.plans,
      facings: [...s.facings],
      routes: [...s.routes],
      killZone: s.killZone,
      combat: s.combat,
      trigger: s.trigger,
      engagements: s.engagements,
    });
    expect(JSON.stringify(strip(ui3d.scene()))).toBe(JSON.stringify(strip(ui2d.scene())));
  });
});
