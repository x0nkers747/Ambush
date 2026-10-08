import { describe, expect, it } from 'vitest';
import {
  createExercise,
  type AmbushScenario,
  type Exercise,
  type OrganizationTemplate,
} from '#exercise';
import { createSession, setShowVisibility, setTool, type Session } from '#session';
import { createSyntheticTerrain, flatElevation, rectangle, soldierId } from '#sim';
import { createMapActions } from './actions';
import { formatBearing } from './bearing';
import { screenToWorld, type Camera } from './camera';
import { createMapController, DRAG_THRESHOLD_PX } from './interaction';
import {
  buildScene,
  deploymentGeometry,
  FACING_ARROW_PX,
  selectableSoldiersAt,
  symbolLayout,
} from './scene';

// Pointer interaction driven through the real exercise, session and map
// actions, with a camera of 1 m per pixel centred on the origin of a
// 400 × 400 px viewport: map (x, y) is at screen (200 + x, 200 − y).

const A = soldierId('A');

/** A synthetic two-person team (represents no real organization). */
const PAIR: OrganizationTemplate = {
  schema: 'ambush.organization-template',
  schemaVersion: 2,
  id: 'interaction-pair',
  version: '1.0.0',
  name: 'Interaction test pair',
  source: { kind: 'synthetic', title: 'Interaction test pair', notes: 'Test fixture.' },
  conventions: [],
  roles: [
    {
      id: 'member',
      name: 'Member',
      abbreviation: 'M',
      defaultIcon: 'rifleman',
    },
  ],
  units: [
    {
      id: 'TM',
      name: 'Team',
      abbreviation: 'TM',
      echelon: 'team',
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
  id: 'interaction-test',
  terrain: createSyntheticTerrain(
    { originX: -150, originY: -150, cellSize: 30, columns: 11, rows: 11 },
    flatElevation(0),
    // A building well away from the routes the other tests draw.
    {
      roads: [],
      buildings: [{ id: 'B-9', footprint: rectangle(100, -100, 20, 20), heightMeters: 6 }],
      vegetation: [],
    },
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
    id: 'ORP-I',
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

const screen = (x: number, y: number) => ({ x: 200 + x, y: 200 - y });

function setup() {
  const exercise: Exercise = createExercise({
    config: { tickRateHz: 10, seed: 0 },
    scenario: SCENARIO,
  });
  let session: Session = createSession();
  let camera: Camera = { centerX: 0, centerY: 0, metersPerPixel: 1 };
  const viewport = { width: 400, height: 400 };
  const actions = createMapActions(
    exercise,
    {
      get: () => session,
      set: (next) => {
        session = next;
      },
    },
    (next) => {
      camera = next;
    },
    (message) => notices.push(message),
  );
  const notices: string[] = [];
  const scene = () => buildScene(exercise, session, camera, viewport);
  const controller = createMapController(scene, actions);

  const at = (x: number, y: number, button = 0) => ({ ...screen(x, y), button });
  const ui = {
    exercise,
    get session() {
      return session;
    },
    get camera() {
      return camera;
    },
    controller,
    click(x: number, y: number, button = 0) {
      controller.pointerDown(at(x, y, button));
      controller.pointerUp(at(x, y, button));
    },
    /** Drags in screen pixels from map point (x0, y0) by (dx, dy) pixels. */
    dragPixels(x0: number, y0: number, dx: number, dy: number) {
      const start = screen(x0, y0);
      controller.pointerDown({ ...start, button: 0 });
      for (let i = 1; i <= 4; i += 1) {
        controller.pointerMove({ x: start.x + (dx * i) / 4, y: start.y + (dy * i) / 4, button: 0 });
      }
      controller.pointerUp({ x: start.x + dx, y: start.y + dy, button: 0 });
    },
    destination: () => {
      const d = exercise.draft(A)?.destination;
      return d ? [d.east, d.north] : null;
    },
    facingTip: () => {
      const tip = deploymentGeometry(scene())?.facingTip;
      if (!tip) throw new Error('no facing arrow');
      return tip;
    },
    notices,
    setCamera(next: Camera) {
      camera = next;
    },
    setSession(next: Session) {
      session = next;
    },
    useTool(tool: 'deploy' | 'killZone') {
      session = setTool(session, tool);
    },
    useKillZoneTool() {
      session = setTool(session, 'killZone');
    },
    corners: () => exercise.killZone?.vertices.map((v) => [v.x, v.y]),
  };
  return ui;
}

describe('selection', () => {
  it('selects a BLUEFOR soldier by clicking it', () => {
    const ui = setup();
    ui.click(52, 3);
    expect(ui.session.selectedSoldierId).toBe('B');
    ui.click(-1, -2);
    expect(ui.session.selectedSoldierId).toBe('A');
  });

  it('does not select or edit OPFOR', () => {
    const ui = setup();
    ui.click(0, 100);
    expect(ui.session.selectedSoldierId).toBeNull();
    ui.click(0, 0);
    ui.click(0, 100); // clicking OPFOR does not set a destination on top of it either
    expect(ui.session.selectedSoldierId).toBe('A');
    expect(ui.destination()).toBeNull();
    expect(ui.exercise.draft(soldierId('E'))).toBeUndefined();
  });

  it('does nothing when clicking the map with no selection', () => {
    const ui = setup();
    ui.click(30, 30);
    expect(ui.exercise.draft(A)?.destination).toBeNull();
  });
});

// Without a destination the facing handle sits FACING_ARROW_PX (42 px) north
// of the selected soldier at (0, 0), so the destinations below avoid (0, 42).
describe('destination editing', () => {
  it('sets the single destination where the map is clicked; a second click moves it', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-50, 40);
    expect(ui.destination()).toEqual([-50, 40]);
    ui.click(30, 80);
    expect(ui.destination()).toEqual([30, 80]);
  });

  it('keeps an explicit facing when the destination moves', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-40, 40);
    ui.exercise.setFacing(A, Math.PI / 2); // east, as the facing handle would set it
    ui.click(30, 80);
    expect(ui.exercise.draft(A)?.facingDegrees).toBeCloseTo(90, 9);
  });

  it('moves the destination by dragging its marker', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-40, 40);
    ui.dragPixels(-40, 40, 25, -10); // +25 px right, −10 px up the screen = +10 m north
    expect(ui.destination()).toEqual([-15, 50]);
  });

  it('never offers generated path turns as handles', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(130, -130); // beyond building B-9: the path bends round it
    const turn = ui.exercise.displayedRoute(A)?.legs[0]?.turns?.[0];
    if (!turn) throw new Error('expected a generated turn');
    const before = ui.camera.centerX;
    ui.dragPixels(turn.x, turn.y, 15, 0); // pans the map, does not edit the path
    expect(ui.destination()).toEqual([130, -130]);
    expect(ui.camera.centerX).toBeCloseTo(before - 15, 9);
  });

  it('clears the destination with a right click on its marker', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-40, 40);
    ui.click(60, 60, 2); // right click on empty map: nothing
    expect(ui.destination()).toEqual([-40, 40]);
    ui.click(-40, 40, 2);
    expect(ui.destination()).toBeNull();
  });

  it('ignores clicks off the terrain', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(0, 160);
    expect(ui.destination()).toBeNull();
  });

  it('pans instead of setting a destination when the map is dragged', () => {
    const ui = setup();
    ui.click(0, 0);
    const viewport = { width: 400, height: 400 };
    const grabbed = screenToWorld(ui.camera, viewport, screen(60, 60));
    ui.dragPixels(60, 60, 30, 12);
    expect(ui.destination()).toBeNull();
    const under = screenToWorld(ui.camera, viewport, {
      x: screen(60, 60).x + 30,
      y: screen(60, 60).y + 12,
    });
    expect(under.x).toBeCloseTo(grabbed.x, 9);
    expect(under.y).toBeCloseTo(grabbed.y, 9);
  });

  it('treats a press that moves less than the drag threshold as a click where it started', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.dragPixels(60, 60, DRAG_THRESHOLD_PX - 1, 0);
    expect(ui.destination()).toEqual([60, 60]);
  });

  it('is disabled while Executing, but selection and panning still work', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-40, 40);
    ui.exercise.execute();
    ui.click(40, 40);
    ui.click(-40, 40, 2);
    ui.dragPixels(-40, 40, 20, 0); // on the destination: pans, does not move it
    expect(ui.exercise.displayedPlan(A)?.destination).toEqual({ east: -40, north: 40 });
    expect(ui.camera.centerX).toBeCloseTo(-20, 9);
    ui.click(50 + 20, 0); // B, now 20 px further right on screen
    expect(ui.session.selectedSoldierId).toBe('B');
  });
});

describe('facing', () => {
  it('rotates by dragging the arrow tip at the destination', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-40, 40);
    // The default facing points the way A walks, north-west: drag from wherever
    // its tip is to due east of the destination.
    const tip = ui.facingTip();
    ui.controller.pointerDown({ ...tip, button: 0 });
    ui.controller.pointerMove({ ...screen(-40 + FACING_ARROW_PX, 40), button: 0 });
    ui.controller.pointerUp({ ...screen(-40 + FACING_ARROW_PX, 40), button: 0 });
    expect(ui.exercise.draft(A)?.facingDegrees).toBeCloseTo(90, 9);
    expect(ui.destination()).toEqual([-40, 40]);
  });

  it('operates at the soldier when there is no destination', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.dragPixels(0, FACING_ARROW_PX, 0, 2 * FACING_ARROW_PX); // to due south of the soldier
    expect(formatBearing(ui.exercise.displayedFacing(A)?.azimuth ?? Number.NaN)).toBe('180°');
    expect(ui.exercise.draft(A)?.facingDegrees).toBe(180);
    expect(ui.destination()).toBeNull();
  });

  it('ignores a click on the handle without dragging', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(0, FACING_ARROW_PX);
    expect(ui.destination()).toBeNull();
    expect(ui.exercise.draft(A)?.facingDegrees).toBeNull();
  });
});

describe('zoom', () => {
  it('zooms in on wheel-up around the cursor', () => {
    const ui = setup();
    const cursor = screen(-80, 30);
    ui.controller.wheel(cursor, -100);
    expect(ui.camera.metersPerPixel).toBeLessThan(1);
    const under = screenToWorld(ui.camera, { width: 400, height: 400 }, cursor);
    expect(under.x).toBeCloseTo(-80, 9);
    expect(under.y).toBeCloseTo(30, 9);
    ui.controller.wheel(cursor, 100);
    expect(ui.camera.metersPerPixel).toBeCloseTo(1, 12);
  });
});

describe('cursor', () => {
  it('shows what a click would do', () => {
    const ui = setup();
    const move = (x: number, y: number) => {
      ui.controller.pointerMove({ ...screen(x, y), button: 0 });
      return ui.controller.cursor;
    };
    expect(move(50, 0)).toBe('pointer');
    expect(move(30, 30)).toBe('grab');
    ui.click(0, 0);
    expect(move(30, 30)).toBe('crosshair');
    expect(move(0, FACING_ARROW_PX)).toBe('move');
    ui.click(30, 30);
    expect(move(30, 30)).toBe('move');
  });
});

describe('kill-zone editing', () => {
  function withZone() {
    const ui = setup();
    ui.useKillZoneTool();
    ui.click(-60, 30);
    ui.click(60, 30);
    ui.click(60, 90);
    ui.click(-60, 90);
    return ui;
  }

  it('adds corners where the map is clicked, ignoring soldiers', () => {
    const ui = withZone();
    expect(ui.corners()).toEqual([
      [-60, 30],
      [60, 30],
      [60, 90],
      [-60, 90],
    ]);
    expect(ui.session.selectedSoldierId).toBeNull();
    const fresh = setup();
    fresh.useKillZoneTool();
    fresh.click(50, 0); // on soldier B: a corner, not a selection
    expect(fresh.session.selectedSoldierId).toBeNull();
    expect(fresh.corners()).toEqual([[50, 0]]);
  });

  it('inserts a corner when a side is clicked', () => {
    const ui = withZone();
    ui.click(0, 91); // 1 px from the north side, which runs from corner 2 to corner 3
    expect(ui.corners()).toEqual([
      [-60, 30],
      [60, 30],
      [60, 90],
      [0, 91],
      [-60, 90],
    ]);
    ui.click(-61, 60); // the closing side, from the last corner back to the first
    expect(ui.corners()?.at(-1)).toEqual([-61, 60]);
  });

  it('moves a corner by dragging it, and stops where the zone would cross itself', () => {
    const ui = withZone();
    ui.dragPixels(60, 90, 10, -10); // to (70, 100)
    expect(ui.corners()?.[2]).toEqual([70, 100]);
    // Dragging corner 0 (−60, 30) to (80, 60) would make it cross itself; it stays at the last valid point.
    const start = screen(-60, 30);
    ui.controller.pointerDown({ ...start, button: 0 });
    ui.controller.pointerMove({ ...screen(-50, 35), button: 0 });
    ui.controller.pointerMove({ ...screen(80, 60), button: 0 });
    ui.controller.pointerUp({ ...screen(80, 60), button: 0 });
    expect(ui.corners()?.[0]).toEqual([-50, 35]);
  });

  it('deletes a corner with a right click', () => {
    const ui = withZone();
    ui.click(60, 90, 2);
    expect(ui.corners()).toEqual([
      [-60, 30],
      [60, 30],
      [-60, 90],
    ]);
  });

  it('does not set destinations with the kill-zone tool, nor edit the kill zone with the deployment tool', () => {
    const ui = withZone();
    expect(ui.destination()).toBeNull();
    const ui2 = setup();
    ui2.click(0, 0);
    ui2.click(-60, 30);
    expect(ui2.exercise.killZone).toBeNull();
    expect(ui2.destination()).toEqual([-60, 30]);
  });

  it('is read-only while BLUEFOR is moving', () => {
    const ui = withZone();
    ui.exercise.setDestination(A, { x: 0, y: 140 });
    ui.exercise.execute();
    ui.click(0, -50);
    ui.click(60, 90, 2);
    ui.dragPixels(-60, 30, 10, 10);
    expect(ui.corners()).toHaveLength(4);
    expect(ui.corners()?.[0]).toEqual([-60, 30]);
  });
});

describe('refused destinations', () => {
  it('tells the trainee why a destination inside a building was not set', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(100, -100);
    expect(ui.destination()).toBeNull();
    expect(ui.notices).toEqual([
      'Destination not set: inside building B-9; soldiers cannot enter buildings.',
    ]);
  });

  it('keeps the destination where it was when a drag enters a building', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(100, -60);
    ui.dragPixels(100, -60, 0, 40); // 40 px down the screen: into B-9
    expect(ui.destination()).toEqual([100, -80]); // the last point a soldier could stand on
  });
});

describe('visibility overlay', () => {
  const viewport = { width: 400, height: 400 };

  it('is shown only when switched on, for the selected trainee soldier', () => {
    const ui = setup();
    const view = { observer: { x: 0, y: 0 }, planned: false, viewshed: null, pending: true };
    ui.click(0, 0);
    expect(buildScene(ui.exercise, ui.session, ui.camera, viewport, view).visibility).toBeNull();
    const on = setShowVisibility(ui.session, true);
    expect(buildScene(ui.exercise, on, ui.camera, viewport, view).visibility).toEqual(view);
  });

  it('does not take map clicks: destination editing works as usual', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.setSession(setShowVisibility(ui.session, true));
    ui.click(-40, 40);
    expect(ui.destination()).toEqual([-40, 40]);
  });

  it('reports when the destination is being dragged, for the quick preview', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-40, 40);
    const start = screen(-40, 40);
    ui.controller.pointerDown({ ...start, button: 0 });
    ui.controller.pointerMove({ x: start.x + 10, y: start.y, button: 0 });
    expect(ui.controller.draggingDestination).toBe(true);
    ui.controller.pointerUp({ x: start.x + 10, y: start.y, button: 0 });
    expect(ui.controller.draggingDestination).toBe(false);
  });
});

describe('the ORP', () => {
  it('is in the scene as a reference outline and never takes clicks', () => {
    const ui = setup();
    const scene = buildScene(ui.exercise, ui.session, ui.camera, { width: 400, height: 400 });
    expect(scene.orp.name).toBe('ORP');
    expect(scene.orp.outline.length).toBeGreaterThan(8);
    ui.click(0, 0);
    ui.click(25, 20); // inside the ORP, away from both soldiers: a destination like anywhere else
    expect(ui.destination()).toEqual([25, 20]);
  });
});

describe('symbol decluttering', () => {
  const sceneAt = (ui: ReturnType<typeof setup>, metersPerPixel: number, selected?: string) =>
    buildScene(
      ui.exercise,
      selected ? { ...ui.session, selectedSoldierId: soldierId(selected) } : ui.session,
      { centerX: 0, centerY: 0, metersPerPixel },
      { width: 400, height: 400 },
    );

  it('draws full symbols where they do not overlap, at the soldiers’ true positions', () => {
    const ui = setup();
    const layout = symbolLayout(sceneAt(ui, 1));
    expect([...layout.values()].map((p) => p.mode)).toEqual(['full', 'full', 'full']);
    expect(layout.get(A)?.at).toEqual(screen(0, 0));
    // OPFOR is laid out by the same rules, as an enemy labelled with its soldier id.
    expect(layout.get(soldierId('E'))).toMatchObject({
      at: screen(0, 100),
      affiliation: 'enemy',
      label: 'E',
      mode: 'full',
    });
    expect(layout.get(A)).toMatchObject({ affiliation: 'friendly', label: 'M1' });
  });

  it('draws overlapping symbols compact, the selected soldier always in full with its label', () => {
    const ui = setup();
    // A (0, 0), B (50, 0) and OPFOR E (0, 100) are 5–10 px apart: they overlap.
    const far = sceneAt(ui, 10, 'B');
    const layout = symbolLayout(far);
    expect(layout.get(soldierId('B'))).toMatchObject({ mode: 'full', showLabel: true });
    expect(layout.get(A)).toMatchObject({ mode: 'compact', showLabel: false });
    expect(layout.get(soldierId('E'))).toMatchObject({ mode: 'compact', showLabel: false });
    // Both are hidden under B, and counted with their affiliations.
    expect(layout.get(soldierId('B'))?.hidden).toEqual([
      { id: A, affiliation: 'friendly' },
      { id: soldierId('E'), affiliation: 'enemy' },
    ]);
    expect(layout.get(soldierId('B'))?.covered).toBe(2);
    // Positions are never moved to make room.
    expect(layout.get(A)?.at.x).toBeCloseTo(200, 9);
    expect(layout.get(soldierId('B'))?.at.x).toBeCloseTo(205, 9);
    expect(layout.get(soldierId('E'))?.at.y).toBeCloseTo(190, 9);
  });

  it('gives OPFOR the full symbol when no Marine is in the way', () => {
    const ui = setup();
    // 2 m per pixel: A and B are 25 px apart, E 50 px north of A.
    const layout = symbolLayout(sceneAt(ui, 2));
    expect([...layout.values()].every((p) => p.mode === 'full' && p.covered === 0)).toBe(true);
  });
});

describe('selecting soldiers in a cluster', () => {
  /** The cluster at 10 m per pixel: A at (200, 200), B at (205, 200), OPFOR E at (200, 190). */
  const clustered = () => {
    const ui = setup();
    ui.setCamera({ centerX: 0, centerY: 0, metersPerPixel: 10 });
    return ui;
  };
  const clickPixel = (ui: ReturnType<typeof setup>, x: number, y: number) => {
    ui.controller.pointerDown({ x, y, button: 0 });
    ui.controller.pointerUp({ x, y, button: 0 });
  };

  it('lists every Marine whose symbol is under the pointer, nearest first, never OPFOR', () => {
    const ui = clustered();
    const scene = buildScene(ui.exercise, ui.session, ui.camera, { width: 400, height: 400 });
    expect(selectableSoldiersAt(scene, { x: 201, y: 200 })).toEqual([A, soldierId('B')]);
    expect(selectableSoldiersAt(scene, { x: 205, y: 199 })).toEqual([soldierId('B'), A]);
    expect(selectableSoldiersAt(scene, { x: 260, y: 260 })).toEqual([]);
  });

  it('steps through the cluster on repeated clicks, including the hidden Marine', () => {
    const ui = clustered();
    clickPixel(ui, 201, 200);
    expect(ui.session.selectedSoldierId).toBe('A');
    clickPixel(ui, 201, 200);
    expect(ui.session.selectedSoldierId).toBe('B');
    // B is now drawn in full on top of A; the same click still reaches A.
    expect(
      symbolLayout(buildScene(ui.exercise, ui.session, ui.camera, { width: 400, height: 400 })).get(
        A,
      )?.mode,
    ).toBe('compact');
    clickPixel(ui, 201, 200);
    expect(ui.session.selectedSoldierId).toBe('A');
  });

  it('does not set a destination when an OPFOR symbol alone is clicked', () => {
    const ui = setup();
    ui.click(0, 0); // select A
    ui.click(0, 100); // E's symbol
    expect(ui.session.selectedSoldierId).toBe('A');
    expect(ui.destination()).toBeNull();
  });
});
