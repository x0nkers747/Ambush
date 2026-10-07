import { describe, expect, it } from 'vitest';
import { createExercise, type AmbushScenario, type Exercise } from '#exercise';
import { createSession, setTool, type Session } from '#session';
import { createSyntheticTerrain, flatElevation, soldierId } from '#sim';
import { createMapActions } from './actions';
import { formatBearing } from './bearing';
import { screenToWorld, type Camera } from './camera';
import { createMapController, DRAG_THRESHOLD_PX } from './interaction';
import { buildScene, FACING_ARROW_PX } from './scene';

// Pointer interaction driven through the real exercise, session and map
// actions, with a camera of 1 m per pixel centred on the origin of a
// 400 × 400 px viewport: map (x, y) is at screen (200 + x, 200 − y).

const A = soldierId('A');

const SCENARIO: AmbushScenario = {
  id: 'interaction-test',
  terrain: createSyntheticTerrain(
    { originX: -150, originY: -150, cellSize: 30, columns: 11, rows: 11 },
    flatElevation(0),
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
  );
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
    route: () => exercise.draft(A)?.waypoints.map((w) => [w.x, w.y]),
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
    ui.click(0, 100); // clicking OPFOR does not add a waypoint on top of it either
    expect(ui.session.selectedSoldierId).toBe('A');
    expect(ui.route()).toEqual([]);
    expect(ui.exercise.draft(soldierId('E'))).toBeUndefined();
  });

  it('does nothing when clicking the map with no selection', () => {
    const ui = setup();
    ui.click(30, 30);
    expect(ui.exercise.draft(A)?.waypoints).toEqual([]);
  });
});

// With no waypoints the facing handle sits FACING_ARROW_PX (42 px) north of
// the selected soldier at (0, 0), so the routes below avoid (0, 42).
describe('waypoint editing', () => {
  it('appends waypoints where the map is clicked', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-50, 40);
    ui.click(30, 80);
    expect(ui.route()).toEqual([
      [-50, 40],
      [30, 80],
    ]);
  });

  it('inserts a waypoint when a route leg is clicked', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-40, 40);
    ui.click(40, 40);
    ui.click(0, 41); // 1 px from the leg (−40, 40)–(40, 40)
    expect(ui.route()).toEqual([
      [-40, 40],
      [0, 41],
      [40, 40],
    ]);
  });

  it('moves a waypoint by dragging it, keeping its id', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-40, 40);
    const id = ui.exercise.draft(A)?.waypoints[0]?.id;
    ui.dragPixels(-40, 40, 25, -10); // +25 px right, −10 px up the screen = +10 m north
    expect(ui.route()).toEqual([[-15, 50]]);
    expect(ui.exercise.draft(A)?.waypoints[0]?.id).toBe(id);
  });

  it('deletes a waypoint with a right click', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-40, 40);
    ui.click(40, 80);
    ui.click(-40, 40, 2);
    expect(ui.route()).toEqual([[40, 80]]);
    ui.click(60, 60, 2); // right click on empty map: nothing
    expect(ui.route()).toEqual([[40, 80]]);
  });

  it('ignores clicks off the terrain', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(0, 160);
    expect(ui.route()).toEqual([]);
  });

  it('pans instead of adding a waypoint when the map is dragged', () => {
    const ui = setup();
    ui.click(0, 0);
    const viewport = { width: 400, height: 400 };
    const grabbed = screenToWorld(ui.camera, viewport, screen(60, 60));
    ui.dragPixels(60, 60, 30, 12);
    expect(ui.route()).toEqual([]);
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
    expect(ui.route()).toEqual([[60, 60]]);
  });

  it('is disabled while Executing, but selection and panning still work', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-40, 40);
    ui.exercise.execute();
    ui.click(40, 40);
    ui.click(-40, 40, 2);
    ui.dragPixels(-40, 40, 20, 0); // on the waypoint: pans, does not move it
    expect(ui.exercise.displayedPlan(A)?.waypoints.map((w) => [w.x, w.y])).toEqual([[-40, 40]]);
    expect(ui.camera.centerX).toBeCloseTo(-20, 9);
    ui.click(50 + 20, 0); // B, now 20 px further right on screen
    expect(ui.session.selectedSoldierId).toBe('B');
  });
});

describe('final facing', () => {
  it('rotates by dragging the arrow tip at the last waypoint', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(-40, 40);
    // Facing starts at 000°: the tip is FACING_ARROW_PX north of the waypoint.
    ui.dragPixels(-40, 40 + FACING_ARROW_PX, FACING_ARROW_PX, FACING_ARROW_PX); // to due east of it
    expect(formatBearing(ui.exercise.draft(A)?.finalFacing ?? Number.NaN)).toBe('090°');
    expect(ui.route()).toEqual([[-40, 40]]);
  });

  it('operates at the soldier when there are no waypoints', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.dragPixels(0, FACING_ARROW_PX, 0, 2 * FACING_ARROW_PX); // to due south of the soldier
    expect(formatBearing(ui.exercise.draft(A)?.finalFacing ?? Number.NaN)).toBe('180°');
    expect(ui.route()).toEqual([]);
  });

  it('ignores a click on the handle without dragging', () => {
    const ui = setup();
    ui.click(0, 0);
    ui.click(0, FACING_ARROW_PX);
    expect(ui.route()).toEqual([]);
    expect(ui.exercise.draft(A)?.finalFacing).toBe(0);
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

  it('does not edit routes with the kill-zone tool, nor the kill zone with the route tool', () => {
    const ui = withZone();
    expect(ui.route()).toEqual([]);
    const ui2 = setup();
    ui2.click(0, 0);
    ui2.click(-60, 30);
    expect(ui2.exercise.killZone).toBeNull();
    expect(ui2.route()).toEqual([[-60, 30]]);
  });

  it('is read-only while BLUEFOR is moving', () => {
    const ui = withZone();
    ui.exercise.addWaypoint(A, { x: 0, y: 140 });
    ui.exercise.execute();
    ui.click(0, -50);
    ui.click(60, 90, 2);
    ui.dragPixels(-60, 30, 10, 10);
    expect(ui.corners()).toHaveLength(4);
    expect(ui.corners()?.[0]).toEqual([-60, 30]);
  });
});
