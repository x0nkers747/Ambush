import { describe, expect, it } from 'vitest';
import {
  addRouteWaypoint,
  buildScenario,
  createExercise,
  defaultScenarioDefinition,
  lineFormationPoints,
  setOpforStart,
  setOrp,
  toVec2,
  type EditResult,
  type Exercise,
  type ScenarioDefinition,
} from '#exercise';
import {
  clearSelection,
  createSession,
  selectFireTeam,
  selectSoldier,
  setTool,
  type Session,
} from '#session';
import {
  azimuthFromDegrees,
  createSyntheticTerrain,
  flatElevation,
  rectangle,
  type SoldierId,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import { createMapActions } from './actions';
import { screenToWorld, worldToScreen, type Camera } from './camera';
import { ENGAGEMENT_WEDGE_WIDTH_DEG } from './engagement';
import { createMapController } from './interaction';
import { buildScene, FACING_ARROW_PX, formationGeometry, isSelected, symbolLayout } from './scene';

// Fire-team formation planning on the map (docs/adr/0022): team selection,
// the members' wedges, and placing, moving, turning and deleting a formation
// with the pointer, through the real exercise, session and map actions.

const deg = azimuthFromDegrees;

/** A 1 km flat battlefield with a building east of centre (x 140–160, y −10–10). */
function terrain(): TerrainDataset {
  const base = createSyntheticTerrain(
    { originX: -500, originY: -500, cellSize: 10, columns: 101, rows: 101 },
    flatElevation(50),
  );
  return {
    ...base,
    formatVersion: 3,
    features: {
      roads: [],
      buildings: [{ id: 'B1', footprint: rectangle(150, 0, 20, 20, 0), heightMeters: 6 }],
      vegetation: [],
      water: [],
      waterways: [],
      landUse: [],
    },
  };
}
const T = terrain();
const ok = (r: EditResult): ScenarioDefinition => {
  if (!r.ok) throw new Error(r.problem);
  return r.definition;
};
const SCENARIO = (() => {
  let d = defaultScenarioDefinition(T, 'formation-map-test');
  d = ok(setOrp(T, d, { x: 0, y: -300 }));
  d = ok(setOpforStart(T, d, { x: 0, y: 400 }));
  d = ok(addRouteWaypoint(T, d, { x: 0, y: 100 }));
  return buildScenario(T, d);
})();

function setup(metersPerPixel = 1) {
  const exercise: Exercise = createExercise({
    config: { tickRateHz: 10, seed: 0 },
    scenario: SCENARIO,
  });
  let session: Session = createSession();
  let camera: Camera = { centerX: 0, centerY: -100, metersPerPixel };
  const viewport = { width: 600, height: 600 };
  const notices: string[] = [];
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
  const scene = () => buildScene(exercise, session, camera, viewport);
  const controller = createMapController(scene, actions);
  const toScreen = (p: Vec2) => worldToScreen(camera, viewport, p);
  const team = exercise.fireTeams[0];
  if (!team) throw new Error('no fire team');
  return {
    exercise,
    scene,
    controller,
    notices,
    team,
    toScreen,
    toWorld: (p: Vec2) => screenToWorld(camera, viewport, p),
    get session() {
      return session;
    },
    set session(next: Session) {
      session = next;
    },
    /** Left click (or right with button 2) at a map point. */
    click(p: Vec2, button = 0) {
      const s = toScreen(p);
      controller.pointerDown({ ...s, button });
      controller.pointerUp({ ...s, button });
    },
    /** Drags from one screen point to another. */
    drag(from: Vec2, to: Vec2) {
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
    destinations(ids: readonly SoldierId[] = team.memberIds) {
      return ids.map((id) => {
        const d = exercise.draft(id)?.destination;
        return d ? toVec2(d) : null;
      });
    },
  };
}

const near = (a: Vec2 | null | undefined, b: Vec2, digits = 6) => {
  expect(a?.x).toBeCloseTo(b.x, digits);
  expect(a?.y).toBeCloseTo(b.y, digits);
};

describe('selecting a fire team', () => {
  it('selects and highlights all its Marines, shows their wedges, and changes no plan', () => {
    const ui = setup();
    const plans = ui.exercise.deploymentPlans();
    ui.session = selectFireTeam(ui.session, ui.exercise, 'FT1');
    const scene = ui.scene();
    expect(scene.selectedId).toBeNull();
    expect(scene.selectedTeam).toMatchObject({
      unitId: 'FT1',
      memberIds: ui.team.memberIds,
      formation: undefined,
      editable: true,
    });
    for (const s of scene.soldiers) {
      expect(isSelected(scene, s.id)).toBe(ui.team.memberIds.includes(s.id));
    }
    // Every member's label is shown, as for a selected Marine.
    const layout = symbolLayout(scene);
    for (const id of ui.team.memberIds) expect(layout.get(id)?.showLabel).toBe(true);
    // Four wedges, one per Marine, each with that Marine's own weapon and range.
    expect(scene.engagement).toBeNull();
    expect(scene.engagements.map((w) => [w.soldierId, w.weaponRef, w.rangeM])).toEqual(
      ui.team.memberIds.map((id) => {
        const slot = ui.exercise.rosterMember(id)?.slot.label;
        return slot === '1-AR' ? [id, 'squad-automatic-weapon', 600] : [id, 'm16-rifle', 550];
      }),
    );
    expect(ui.exercise.deploymentPlans()).toEqual(plans);
  });

  it('switches between teams and back to one Marine; clearing removes the group overlays', () => {
    const ui = setup();
    ui.session = selectFireTeam(ui.session, ui.exercise, 'FT1');
    ui.session = selectFireTeam(ui.session, ui.exercise, 'FT2');
    const second = ui.exercise.fireTeams[1]?.memberIds ?? [];
    expect(ui.scene().engagements.map((w) => w.soldierId)).toEqual(second);
    const one = second[2];
    if (one === undefined) throw new Error('no third Marine');
    ui.session = selectSoldier(ui.session, ui.exercise, one);
    expect(ui.scene().selectedTeam).toBeNull();
    expect(ui.scene().engagements.map((w) => w.soldierId)).toEqual([one]);
    ui.session = clearSelection(ui.session);
    expect(ui.scene().engagements).toEqual([]);
    expect(ui.scene().selectedTeam).toBeNull();
  });
});

describe('placing a formation on the map', () => {
  it('one click places the whole team in a 10 m line centred on the click', () => {
    const ui = setup();
    ui.session = selectFireTeam(ui.session, ui.exercise, 'FT1');
    ui.click({ x: 0, y: -100 });
    const formation = ui.exercise.formation('FT1');
    expect(formation?.centre).toEqual({ x: 0, y: -100 });
    const points = lineFormationPoints({ x: 0, y: -100 }, formation?.azimuth ?? NaN, 4, 10);
    ui.destinations().forEach((p, i) => {
      near(p, points[i] ?? { x: NaN, y: NaN });
    });
    expect(ui.notices.at(-1)).toMatch(
      /^1st fire team placed: 4 Marines 10 m apart, facing \d{3}°\.$/,
    );
    // Wedges at each Marine's planned position, facing the formation's way, 35° wide.
    const wedges = ui.scene().engagements;
    expect(wedges).toHaveLength(4);
    wedges.forEach((w, i) => {
      near(w.origin, points[i] ?? { x: NaN, y: NaN });
      expect(w.azimuth).toBeCloseTo(formation?.azimuth ?? NaN, 9);
      expect((2 * w.halfWidth * 180) / Math.PI).toBeCloseTo(ENGAGEMENT_WEDGE_WIDTH_DEG, 9);
    });
  });

  it.each([0.1, 0.5, 2, 6])('keeps 10 m between Marines at %f m per pixel', (metersPerPixel) => {
    const ui = setup(metersPerPixel);
    ui.session = selectFireTeam(ui.session, ui.exercise, 'FT1');
    ui.click({ x: 20, y: -120 });
    const points = ui.destinations();
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      expect(Math.hypot((a?.x ?? NaN) - (b?.x ?? NaN), (a?.y ?? NaN) - (b?.y ?? NaN))).toBeCloseTo(
        10,
        9,
      );
    }
  });

  it('moves a slot that would stand in a building clear of it, and says so', () => {
    const ui = setup();
    ui.session = selectFireTeam(ui.session, ui.exercise, 'FT1');
    // Facing north from the ORP, the east end would stand in the building.
    ui.exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    ui.exercise.clearFormation('FT1');
    ui.click({ x: 130, y: 0 });
    expect(ui.notices.at(-1)).toMatch(
      /^1st fire team placed: 4 Marines .* 1-R was moved clear of a building\.$/,
    );
    expect(ui.exercise.formation('FT1')?.movedClear).toHaveLength(1);
  });

  it('moves with the diamond, turns with the handle, and is deleted with a right click', () => {
    const ui = setup();
    ui.session = selectFireTeam(ui.session, ui.exercise, 'FT1');
    ui.exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    // Drag the centre 40 m east.
    const centre = formationGeometry(ui.scene())?.centre ?? { x: NaN, y: NaN };
    ui.drag(centre, ui.toScreen({ x: 40, y: -100 }));
    expect(ui.exercise.formation('FT1')?.centre).toEqual({ x: 40, y: -100 });
    expect(ui.exercise.formation('FT1')?.azimuth).toBe(0);
    // Drag the facing handle round to the east: the line turns to run north–south.
    const tip = formationGeometry(ui.scene())?.facingTip ?? { x: NaN, y: NaN };
    const c = ui.toScreen({ x: 40, y: -100 });
    expect(tip.y).toBeCloseTo(c.y - FACING_ARROW_PX, 9);
    ui.drag(tip, { x: c.x + FACING_ARROW_PX, y: c.y });
    const turned = ui.exercise.formation('FT1');
    expect(turned?.azimuth).toBeCloseTo(deg(90), 9);
    ui.destinations().forEach((p, i) => {
      near(p, { x: 40, y: -100 + 15 - 10 * i });
    });
    // The wedges turned and moved with their Marines.
    ui.scene().engagements.forEach((w, i) => {
      near(w.origin, { x: 40, y: -100 + 15 - 10 * i });
      expect(w.azimuth).toBeCloseTo(deg(90), 9);
    });
    // Right click on the diamond deletes it.
    ui.click({ x: 40, y: -100 }, 2);
    expect(ui.exercise.formation('FT1')).toBeUndefined();
    expect(ui.destinations()).toEqual([null, null, null, null]);
  });

  it('places nothing with the kill-zone tool or while plans cannot be edited', () => {
    const ui = setup();
    ui.session = setTool(selectFireTeam(ui.session, ui.exercise, 'FT1'), 'killZone');
    ui.click({ x: 0, y: -100 });
    expect(ui.exercise.formation('FT1')).toBeUndefined();
    ui.session = setTool(ui.session, 'deploy');
    ui.exercise.execute();
    ui.click({ x: 0, y: -100 });
    expect(ui.exercise.formation('FT1')).toBeUndefined();
    expect(ui.scene().selectedTeam?.editable).toBe(false);
  });
});

describe('one Marine of a placed team', () => {
  it('is selected on its own and adjusted alone; the others stay put', () => {
    const ui = setup();
    ui.session = selectFireTeam(ui.session, ui.exercise, 'FT1');
    ui.exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    const [ftl, ar, aar, r] = ui.team.memberIds as [SoldierId, SoldierId, SoldierId, SoldierId];
    const others = () => ui.destinations([ftl, aar, r]);
    const before = others();
    ui.session = selectSoldier(ui.session, ui.exercise, ar);
    expect(ui.scene().engagements.map((w) => w.soldierId)).toEqual([ar]);
    // A new destination for the AR alone.
    ui.click({ x: -5, y: -80 });
    expect(ui.destinations([ar])).toEqual([{ x: -5, y: -80 }]);
    expect(others()).toEqual(before);
    expect(ui.notices.at(-1)).toBe(
      "1-AR now has separate orders: moving or turning the 1st fire team's formation no longer changes them.",
    );
    // Back to the team: moving the formation leaves the AR where it was put.
    ui.session = selectFireTeam(ui.session, ui.exercise, 'FT1');
    ui.exercise.moveFormation('FT1', { x: 0, y: -150 });
    expect(ui.destinations([ar])).toEqual([{ x: -5, y: -80 }]);
    expect(ui.destinations([ftl])).toEqual([{ x: -15, y: -150 }]);
  });
});
