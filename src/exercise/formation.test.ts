import { describe, expect, it } from 'vitest';
import {
  azimuthFromDegrees,
  createSyntheticTerrain,
  flatElevation,
  OBSTACLE_CLEARANCE_M,
  pointProblem,
  rectangle,
  soldierId,
  type SoldierId,
  type TerrainDataset,
  type Vec2,
} from '#sim';
import { parseDeploymentPlans, serializeDeploymentPlans, toVec2 } from './deployment';
import { createExercise, ExerciseError, type Exercise } from './exercise';
import {
  DEFAULT_FORMATION_SPACING_M,
  fireTeamsOf,
  lineFormationPoints,
  lineSlotOffset,
} from './formation';
import type { RosterUnit } from './organization';
import {
  addRouteWaypoint,
  buildScenario,
  defaultScenarioDefinition,
  setOpforStart,
  setOrp,
  type EditResult,
  type ScenarioDefinition,
} from './scenario-definition';

// Fire-team formation planning (docs/adr/0022): line geometry, fire-team
// membership, and group placement and editing in the exercise.

const deg = azimuthFromDegrees;
const near = (a: Vec2, b: Vec2, digits = 9) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
};
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

describe('line formation geometry', () => {
  it('centres slots on zero: (i − (N − 1) / 2) × spacing', () => {
    expect([0, 1, 2, 3].map((i) => lineSlotOffset(i, 4, 10))).toEqual([-15, -5, 5, 15]);
    expect([0, 1, 2].map((i) => lineSlotOffset(i, 3, 10))).toEqual([-10, 0, 10]);
    expect(lineSlotOffset(0, 1, 10)).toBe(0);
    expect([0, 1, 2, 3, 4].map((i) => lineSlotOffset(i, 5, 4))).toEqual([-8, -4, 0, 4, 8]);
  });

  it.each([
    // Facing, then where slot 0 (the left) stands relative to the centre.
    ['north', 0, { x: -15, y: 0 }],
    ['east', 90, { x: 0, y: 15 }],
    ['south', 180, { x: 15, y: 0 }],
    ['west', 270, { x: 0, y: -15 }],
  ])(
    'facing %s, lies across the facing with slot 0 on the left',
    (_name, facingDeg, firstOffset) => {
      const centre = { x: 100, y: -40 };
      const points = lineFormationPoints(centre, deg(facingDeg), 4, 10);
      expect(points).toHaveLength(4);
      near(points[0] ?? centre, { x: centre.x + firstOffset.x, y: centre.y + firstOffset.y });
      near(points[3] ?? centre, { x: centre.x - firstOffset.x, y: centre.y - firstOffset.y });
      // 30 m wide for four Marines at 10 m.
      expect(dist(points[0] ?? centre, points[3] ?? centre)).toBeCloseTo(30, 9);
    },
  );

  it.each([0, 45, 90, 135, 180, 225, 247.5, 315, 359])(
    'facing %f°: a straight line through the centre, perpendicular to the facing, spacing kept',
    (facingDeg) => {
      const centre = { x: -12.5, y: 7.25 };
      const azimuth = deg(facingDeg);
      for (const count of [1, 2, 3, 4, 5]) {
        const points = lineFormationPoints(centre, azimuth, count, 10);
        const mean = {
          x: points.reduce((s, p) => s + p.x, 0) / count,
          y: points.reduce((s, p) => s + p.y, 0) / count,
        };
        near(mean, centre);
        for (let i = 0; i < count; i += 1) {
          const p = points[i] ?? centre;
          // On the line across the facing: no component along the facing.
          const along = (p.x - centre.x) * Math.sin(azimuth) + (p.y - centre.y) * Math.cos(azimuth);
          expect(along).toBeCloseTo(0, 9);
          expect(dist(p, centre)).toBeCloseTo(Math.abs(lineSlotOffset(i, count, 10)), 9);
          if (i > 0) expect(dist(p, points[i - 1] ?? p)).toBeCloseTo(10, 9);
        }
      }
    },
  );

  it('rotates round its centre: turning 90° turns every slot 90° about it', () => {
    const centre = { x: 50, y: 50 };
    const before = lineFormationPoints(centre, deg(30), 4, 10);
    const after = lineFormationPoints(centre, deg(120), 4, 10);
    before.forEach((p, i) => {
      // A quarter turn clockwise about the centre: (dx, dy) → (dy, −dx).
      const q = after[i] ?? p;
      near({ x: q.x - centre.x, y: q.y - centre.y }, { x: p.y - centre.y, y: -(p.x - centre.x) });
    });
  });

  it('uses the spacing it is given, and 10 m by default', () => {
    expect(DEFAULT_FORMATION_SPACING_M).toBe(10);
    const wide = lineFormationPoints({ x: 0, y: 0 }, 0, 4);
    expect(wide.map((p) => p.x)).toEqual([-15, -5, 5, 15]);
    const tight = lineFormationPoints({ x: 0, y: 0 }, 0, 4, 4);
    expect(tight.map((p) => p.x)).toEqual([-6, -2, 2, 6]);
  });
});

// ---------------------------------------------------------------------------

/**
 * A 1 km flat battlefield with a building east of centre (x 140–160, y −10–10)
 * and a pond west of it (x −260 to −200, y −60 to 60).
 */
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
      water: [{ id: 'W1', kind: 'water', boundary: rectangle(-230, 0, 60, 120, 0) }],
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
/** The USMC rifle squad in an ORP at (0, −300), with an OPFOR patrol to the north. */
function scenario() {
  let d = defaultScenarioDefinition(T, 'formation-test');
  d = ok(setOrp(T, d, { x: 0, y: -300 }));
  d = ok(setOpforStart(T, d, { x: 0, y: 400 }));
  d = ok(addRouteWaypoint(T, d, { x: 0, y: 100 }));
  return buildScenario(T, d);
}
const SCENARIO = scenario();
function setup(formationSpacingM?: number): Exercise {
  return createExercise({
    config: { tickRateHz: 10, seed: 1 },
    scenario: SCENARIO,
    ...(formationSpacingM === undefined ? {} : { formationSpacingM }),
  });
}
const team1 = (exercise: Exercise) => {
  const team = exercise.fireTeams[0];
  if (!team) throw new Error('no fire team');
  return team;
};
const destinations = (exercise: Exercise, ids: readonly SoldierId[]) =>
  ids.map((id) => {
    const d = exercise.draft(id)?.destination;
    return d ? toVec2(d) : null;
  });
const plans = (exercise: Exercise) => exercise.deploymentPlans().plans;

describe('fire teams', () => {
  it('come from the organization: three teams of four, in slot order, without the squad leader', () => {
    const exercise = setup();
    expect(
      exercise.fireTeams.map((t) => [
        t.unitId,
        t.name,
        t.memberIds.map((id) => exercise.rosterMember(id)?.slot.label),
      ]),
    ).toEqual([
      ['FT1', '1st fire team', ['1-FTL', '1-AR', '1-AAR', '1-R']],
      ['FT2', '2nd fire team', ['2-FTL', '2-AR', '2-AAR', '2-R']],
      ['FT3', '3rd fire team', ['3-FTL', '3-AR', '3-AAR', '3-R']],
    ]);
    const leader = exercise.roster.members[0];
    expect(leader?.slot.label).toBe('SL');
    expect(exercise.fireTeamOf(soldierId(leader?.soldierId ?? ''))).toBeUndefined();
    expect(exercise.fireTeamOf(team1(exercise).memberIds[2] ?? soldierId('x'))?.unitId).toBe('FT1');
  });

  it('take any number of members, and only units of echelon fireTeam', () => {
    const member = (id: string) => ({ soldierId: id }) as RosterUnit['members'][number];
    const unit = (id: string, echelon: string, ids: string[], children: RosterUnit[] = []) =>
      ({
        unit: { id, name: id, echelon },
        simUnitId: id,
        members: ids.map(member),
        children,
      }) as unknown as RosterUnit;
    const roster = unit(
      'PLT',
      'platoon',
      ['PL'],
      [
        unit('A', 'fireTeam', ['a1', 'a2', 'a3']),
        unit('B', 'fireTeam', ['b1', 'b2', 'b3', 'b4', 'b5']),
        unit('C', 'fireTeam', []),
        unit('D', 'section', ['d1']),
      ],
    );
    expect(fireTeamsOf(roster).map((t) => [t.unitId, t.memberIds.length])).toEqual([
      ['A', 3],
      ['B', 5],
    ]);
  });
});

describe('placing a fire-team formation', () => {
  it('gives every Marine of the team one destination on a 10 m line and the common facing', () => {
    const exercise = setup();
    const team = team1(exercise);
    const others = plans(exercise).filter((p) => !team.memberIds.includes(p.soldierId));
    const formation = exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    expect(destinations(exercise, team.memberIds)).toEqual([
      { x: -15, y: -100 },
      { x: -5, y: -100 },
      { x: 5, y: -100 },
      { x: 15, y: -100 },
    ]);
    for (const id of team.memberIds) expect(exercise.draft(id)?.facingDegrees).toBe(0);
    expect(formation).toEqual({
      unitId: 'FT1',
      centre: { x: 0, y: -100 },
      azimuth: 0,
      spacingM: 10,
      slots: team.memberIds.map((soldierId, i) => ({
        soldierId,
        point: { x: -15 + 10 * i, y: -100 },
      })),
      linked: team.memberIds,
      movedClear: [],
      movedAshore: [],
    });
    expect(exercise.formation('FT1')).toEqual(formation);
    // Nobody else's plan changes.
    expect(plans(exercise).filter((p) => !team.memberIds.includes(p.soldierId))).toEqual(others);
  });

  it('faces, by default, the way the team will walk: from its centre now to the click', () => {
    const exercise = setup();
    // The ORP is due south: walking north, the line runs east–west.
    const north = exercise.placeFormation('FT1', { x: 0, y: -100 });
    const centreNow = (() => {
      const ps = team1(exercise).memberIds.map(
        (id) => exercise.scenarioStart(id) ?? { x: 0, y: 0 },
      );
      return {
        x: ps.reduce((s, p) => s + p.x, 0) / ps.length,
        y: ps.reduce((s, p) => s + p.y, 0) / ps.length,
      };
    })();
    expect(north.azimuth).toBeCloseTo(
      Math.atan2(0 - centreNow.x, -100 - centreNow.y) + (centreNow.x > 0 ? 2 * Math.PI : 0),
      6,
    );
    // Placed again elsewhere, it keeps the formation's facing.
    const moved = exercise.placeFormation('FT1', { x: -200, y: -150 });
    expect(moved.azimuth).toBe(north.azimuth);
  });

  it('places again with a new click: a single destination each, so the whole line moves', () => {
    const exercise = setup();
    exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    exercise.placeFormation('FT1', { x: 50, y: -200 }, deg(90));
    const team = team1(exercise);
    expect(destinations(exercise, team.memberIds)).toEqual(
      lineFormationPoints({ x: 50, y: -200 }, deg(90), 4, 10),
    );
    for (const id of team.memberIds) expect(exercise.draft(id)?.facingDegrees).toBe(90);
  });

  it('moves a slot in or against a building clear of it, and refuses one off the map', () => {
    const exercise = setup();
    const team = team1(exercise);
    const before = plans(exercise);
    // The west end would be off the map: refused as a whole, nothing changes.
    expect(() => exercise.placeFormation('FT1', { x: -490, y: 0 }, deg(0))).toThrow(
      /Formation not placed: 1-FTL would be off the map/,
    );
    expect(plans(exercise)).toEqual(before);
    expect(exercise.formation('FT1')).toBeUndefined();
    // The east end (x = 145) would be inside the building (x 140–160): 1-R goes to the
    // nearest spot clear of it, just west of the wall; the others keep their places.
    const formation = exercise.placeFormation('FT1', { x: 130, y: 0 }, deg(0));
    const rifleman = team.memberIds[3] ?? soldierId('x');
    expect(formation.movedClear).toEqual([rifleman]);
    const placed = destinations(exercise, team.memberIds);
    expect(placed.slice(0, 3).map((p) => p?.x)).toEqual([115, 125, 135]);
    expect(placed[3]?.x).toBeCloseTo(140 - OBSTACLE_CLEARANCE_M - 0.5);
    expect(placed[3]?.y).toBeCloseTo(0);
    expect(placed[3] && pointProblem(T, placed[3])).toBeNull();
    // The moved Marine still follows the formation.
    expect(formation.linked).toEqual(team.memberIds);
    // A single Marine is still refused inside a building.
    expect(() => {
      exercise.setDestination(rifleman, { x: 150, y: 0 });
    }).toThrow(/inside building B1/);
    // Clear of the building, the line keeps its 10 m spacing.
    exercise.placeFormation('FT1', { x: 110, y: 0 }, deg(0));
    expect(destinations(exercise, team.memberIds).map((p) => p?.x)).toEqual([95, 105, 115, 125]);
    expect(exercise.formation('FT1')?.movedClear).toEqual([]);
  });

  it('moves slots in water out onto the nearest bank', () => {
    const exercise = setup();
    const team = team1(exercise);
    // The line runs east–west at y = 0 from x −212 to −182: the west two are in the
    // pond (x −260 to −200) and go to its east bank; the east two keep their places.
    const formation = exercise.placeFormation('FT1', { x: -197, y: 0 }, deg(0));
    expect(formation.movedClear).toEqual([]);
    expect(formation.movedAshore).toEqual(team.memberIds.slice(0, 2));
    const placed = destinations(exercise, team.memberIds);
    expect(placed.slice(2).map((p) => p?.x)).toEqual([-192, -182]);
    for (const p of placed.slice(0, 2)) {
      expect(p && pointProblem(T, p)).toBeNull();
      // On the bank, a little past the water's edge.
      expect(p?.x).toBeGreaterThan(-200);
      expect(p?.x).toBeLessThan(-194);
    }
    // No two Marines closer than 2 m.
    for (let i = 0; i < placed.length; i += 1)
      for (let j = i + 1; j < placed.length; j += 1) {
        const a = placed[i];
        const b = placed[j];
        expect(a && b && Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(2);
      }
    expect(formation.linked).toEqual(team.memberIds);
    // A single Marine is still refused in the water.
    expect(() => {
      exercise.setDestination(team.memberIds[0] ?? soldierId('x'), { x: -230, y: 0 });
    }).toThrow(/water/);
  });

  it('honours a configured spacing', () => {
    const exercise = setup(4);
    const formation = exercise.placeFormation('FT2', { x: 0, y: -100 }, deg(0));
    expect(formation.spacingM).toBe(4);
    expect(formation.slots.map((s) => s.point.x)).toEqual([-6, -2, 2, 6]);
    expect(() =>
      createExercise({
        config: { tickRateHz: 10, seed: 1 },
        scenario: SCENARIO,
        formationSpacingM: 0,
      }),
    ).toThrow(RangeError);
  });

  it('is refused for anything but a squad or fire team, and when plans are not editable', () => {
    const exercise = setup();
    expect(() => exercise.placeFormation('nope', { x: 0, y: -100 })).toThrow(ExerciseError);
    exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    exercise.execute();
    expect(() => exercise.placeFormation('FT2', { x: 0, y: -100 })).toThrow(ExerciseError);
    expect(exercise.formation('FT1')).toBeUndefined();
  });

  it('is deterministic: the same placement gives identical plans', () => {
    const run = () => {
      const exercise = setup();
      exercise.placeFormation('FT1', { x: 13.37, y: -101.25 }, deg(33.3));
      exercise.setFormationFacing('FT1', deg(301.7));
      exercise.placeFormation('FT3', { x: -60.1, y: -80 });
      return serializeDeploymentPlans(exercise.deploymentPlans());
    };
    expect(run()).toBe(run());
  });
});

describe('editing a formation', () => {
  it('moves: every linked Marine keeps the same slot, the facing is kept', () => {
    const exercise = setup();
    exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(45));
    const moved = exercise.moveFormation('FT1', { x: -30, y: -50 });
    expect(moved.azimuth).toBe(deg(45));
    expect(destinations(exercise, team1(exercise).memberIds)).toEqual(
      lineFormationPoints({ x: -30, y: -50 }, deg(45), 4, 10),
    );
  });

  it('turns round its centre: positions and facings change together', () => {
    const exercise = setup();
    exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    const turned = exercise.setFormationFacing('FT1', deg(90));
    const team = team1(exercise);
    // Facing east, the line runs north–south, the leader (slot 0) at the north end.
    const points = destinations(exercise, team.memberIds);
    points.forEach((p, i) => {
      near(p ?? { x: NaN, y: NaN }, { x: 0, y: -100 + 15 - 10 * i });
    });
    for (const id of team.memberIds) expect(exercise.draft(id)?.facingDegrees).toBe(90);
    expect(turned.centre).toEqual({ x: 0, y: -100 });
    expect(exercise.displayedFacing(team.memberIds[0] ?? soldierId('x'))).toEqual({
      azimuth: deg(90),
      explicit: true,
    });
  });

  it('moves and turns a line clear of buildings, and refuses one that would leave the map', () => {
    const exercise = setup();
    exercise.placeFormation('FT1', { x: 110, y: 0 }, deg(0));
    const before = plans(exercise);
    const formation = exercise.formation('FT1');
    expect(() => exercise.moveFormation('FT1', { x: -490, y: 0 })).toThrow(/Formation not moved/);
    // Near the north edge the line fits; turned to 90° it would run off the map.
    exercise.moveFormation('FT1', { x: 0, y: 488 });
    expect(() => exercise.setFormationFacing('FT1', deg(90))).toThrow(/Formation not turned/);
    // Moved or turned into the building, the slot inside is moved clear of it instead.
    expect(exercise.moveFormation('FT1', { x: 130, y: 0 }).movedClear).toHaveLength(1);
    exercise.moveFormation('FT1', { x: 145, y: 20 });
    expect(exercise.setFormationFacing('FT1', deg(90)).movedClear).toHaveLength(1);
    exercise.setFormationFacing('FT1', deg(0));
    exercise.moveFormation('FT1', { x: 110, y: 0 });
    expect(plans(exercise)).toEqual(before);
    expect(exercise.formation('FT1')).toEqual(formation);
  });

  it('deletes: the linked Marines lose their destination and facing', () => {
    const exercise = setup();
    exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    exercise.clearFormation('FT1');
    for (const id of team1(exercise).memberIds) {
      expect(exercise.draft(id)).toEqual({ soldierId: id, destination: null, facingDegrees: null });
    }
    expect(exercise.formation('FT1')).toBeUndefined();
    expect(() => exercise.moveFormation('FT1', { x: 0, y: 0 })).toThrow(/place it first/);
  });
});

describe('individual Marines in a formation', () => {
  it('can be edited on their own, which detaches them: group edits leave them alone', () => {
    const exercise = setup();
    const [ftl, ar, aar, r] = team1(exercise).memberIds as [
      SoldierId,
      SoldierId,
      SoldierId,
      SoldierId,
    ];
    exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    exercise.setDestination(ar, { x: -5, y: -90 });
    exercise.setFacing(aar, deg(200));
    // Only the AR moved; the others are untouched by that edit.
    expect(destinations(exercise, [ftl, ar, aar, r])).toEqual([
      { x: -15, y: -100 },
      { x: -5, y: -90 },
      { x: 5, y: -100 },
      { x: 15, y: -100 },
    ]);
    expect(exercise.formation('FT1')?.linked).toEqual([ftl, r]);
    // Moving and turning the formation moves only the FTL and the R.
    exercise.moveFormation('FT1', { x: 0, y: -150 });
    exercise.setFormationFacing('FT1', deg(90));
    expect(exercise.draft(ar)).toEqual({
      soldierId: ar,
      destination: { east: -5, north: -90 },
      facingDegrees: 0,
    });
    expect(exercise.draft(aar)?.destination).toEqual({ east: 5, north: -100 });
    expect(exercise.draft(aar)?.facingDegrees).toBeCloseTo(200, 9);
    near(toVec2(exercise.draft(ftl)?.destination ?? { east: NaN, north: NaN }), {
      x: 0,
      y: -135,
    });
    near(toVec2(exercise.draft(r)?.destination ?? { east: NaN, north: NaN }), { x: 0, y: -165 });
    // Detached for good: back on the old slot by hand, the AR is still not re-linked.
    exercise.setDestination(ar, { x: 0, y: -145 });
    exercise.setFacing(ar, deg(90));
    expect(exercise.formation('FT1')?.linked).toEqual([ftl, r]);
    // Deleting the formation clears only the linked Marines.
    exercise.clearFormation('FT1');
    expect(exercise.draft(ftl)?.destination).toBeNull();
    expect(exercise.draft(aar)?.facingDegrees).toBeCloseTo(200, 9);
    // A new placement is a new order for the whole team again.
    exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    expect(exercise.formation('FT1')?.linked).toEqual([ftl, ar, aar, r]);
  });

  it('cleared or reset on their own, are detached too; once nobody follows, the formation is gone', () => {
    const exercise = setup();
    const ids = team1(exercise).memberIds;
    exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    exercise.clearDestination(ids[0] ?? soldierId('x'));
    exercise.clearFacing(ids[1] ?? soldierId('x'));
    exercise.resetPlan(ids[2] ?? soldierId('x'));
    expect(exercise.formation('FT1')?.linked).toEqual([ids[3]]);
    exercise.setDestination(ids[3] ?? soldierId('x'), { x: 40, y: -100 });
    expect(exercise.formation('FT1')).toBeUndefined();
  });

  it('teams are independent: placing one never changes another', () => {
    const exercise = setup();
    const a = exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(0));
    exercise.placeFormation('FT2', { x: -60, y: -100 }, deg(0));
    exercise.setFormationFacing('FT2', deg(270));
    expect(exercise.formation('FT1')).toEqual(a);
  });
});

describe('formation plans in the rest of the exercise', () => {
  it('are the planned poses the visibility and wedge displays use', () => {
    const exercise = setup();
    const formation = exercise.placeFormation('FT2', { x: 30, y: -120 }, deg(135));
    for (const { soldierId: id, point } of formation.slots) {
      expect(exercise.observer(id)).toEqual({ point, planned: true });
      expect(exercise.plannedPose(id)).toEqual({
        point,
        azimuth: formation.azimuth,
        planned: true,
      });
    }
  });

  it('play through the ambush: occupation, START OPFOR, TRIGGER AMBUSH and Combat v1', () => {
    const exercise = setup();
    exercise.placeFormation('FT1', { x: -40, y: 40 }, deg(0));
    exercise.placeFormation('FT2', { x: 0, y: 40 }, deg(0));
    exercise.placeFormation('FT3', { x: 40, y: 40 }, deg(0));
    for (const v of [
      { x: -60, y: 90 },
      { x: 60, y: 90 },
      { x: 60, y: 130 },
      { x: -60, y: 130 },
    ])
      exercise.addKillZoneVertex(v);
    expect(exercise.execute().ok).toBe(true);
    for (let i = 0; i < 2000 && exercise.phase === 'bluforOccupation'; i += 1)
      exercise.advance(1, 16);
    expect(exercise.phase).toBe('bluforReady');
    expect(exercise.startOpfor().ok).toBe(true);
    for (let i = 0; i < 30 * 600 && (exercise.killZoneOccupancy()?.inside ?? 0) < 3; i += 1)
      exercise.advance(0.1);
    expect(exercise.triggerAmbush().ok).toBe(true);
    for (let i = 0; i < 2000 && exercise.phase !== 'engagementComplete'; i += 1)
      exercise.advance(1, 16);
    expect(exercise.phase).toBe('engagementComplete');
    expect(exercise.engagementResult?.sides.BLUEFOR.shotsFired).toBeGreaterThan(0);
  });

  it('save and load as ordinary plans, identically', () => {
    const exercise = setup();
    exercise.placeFormation('FT1', { x: 0, y: -100 }, deg(30));
    exercise.placeFormation('FT3', { x: -80, y: -60 }, deg(330));
    exercise.setFacing(exercise.fireTeams[2]?.memberIds[1] ?? soldierId('x'), deg(10));
    const text = serializeDeploymentPlans(exercise.deploymentPlans());
    const fresh = setup();
    fresh.loadDeploymentPlans(
      parseDeploymentPlans(text, {
        scenarioFingerprint: fresh.scenarioFingerprint,
        soldierIds: fresh.deploymentPlans().plans.map((p) => p.soldierId),
      }),
    );
    expect(fresh.deploymentPlans()).toEqual(exercise.deploymentPlans());
    expect(serializeDeploymentPlans(fresh.deploymentPlans())).toBe(text);
    // The formation itself is planning metadata and is not saved.
    expect(fresh.formation('FT1')).toBeUndefined();
    // Loading the same plans back into the same exercise keeps its formations.
    exercise.loadDeploymentPlans(fresh.deploymentPlans());
    expect(exercise.formation('FT1')?.linked).toHaveLength(4);
    expect(exercise.formation('FT3')?.linked).toHaveLength(3);
  });

  it('are executed as each Marine’s own orders: everyone ends on the right slot, facing the common way', () => {
    const exercise = setup();
    const formation = exercise.placeFormation('FT1', { x: 0, y: -150 }, deg(20));
    expect(exercise.execute().ok).toBe(true);
    // The formation is not shown, nor editable, while BLUEFOR moves.
    expect(exercise.formation('FT1')).toBeUndefined();
    for (let i = 0; i < 2000 && exercise.phase === 'bluforOccupation'; i += 1)
      exercise.advance(1, 16);
    expect(exercise.phase).toBe('bluforReady');
    for (const { soldierId: id, point } of formation.slots) {
      const s = exercise.simulation.state.soldiers.find((x) => x.id === id);
      near({ x: s?.position.x ?? NaN, y: s?.position.y ?? NaN }, point, 6);
      expect(s?.azimuth).toBeCloseTo(deg(20), 9);
    }
    // Ready: the committed formation is editable again, still linked.
    expect(exercise.formation('FT1')?.linked).toHaveLength(4);
  });
});

describe('the squad as a formation', () => {
  it('is a formation group before its fire teams, with every Marine in slot order', () => {
    const exercise = setup();
    const labels = (ids: readonly SoldierId[]) =>
      ids.map((id) => exercise.rosterMember(id)?.slot.label);
    const [squad, ...teams] = exercise.formationGroups;
    expect(squad?.unitId).toBe('SQD');
    expect(labels(squad?.memberIds ?? [])).toEqual([
      'SL',
      ...['1', '2', '3'].flatMap((t) => [`${t}-FTL`, `${t}-AR`, `${t}-AAR`, `${t}-R`]),
    ]);
    expect(teams.map((t) => t.unitId)).toEqual(['FT1', 'FT2', 'FT3']);
    // The fire teams alone are unchanged.
    expect(exercise.fireTeams.map((t) => t.unitId)).toEqual(['FT1', 'FT2', 'FT3']);
  });

  it('is placed like a fire team: one destination per Marine, in a line', () => {
    const exercise = setup();
    const squad = exercise.formationGroups[0];
    if (!squad) throw new Error('no squad');
    const formation = exercise.placeFormation('SQD', { x: 0, y: -120 }, deg(0));
    expect(formation.slots).toHaveLength(13);
    expect(formation.linked).toHaveLength(13);
    expect(destinations(exercise, squad.memberIds)).toEqual(
      lineFormationPoints({ x: 0, y: -120 }, deg(0), 13, 10),
    );
    // Moving and turning work as for a fire team.
    exercise.moveFormation('SQD', { x: 10, y: -120 });
    expect(exercise.formation('SQD')?.centre).toEqual({ x: 10, y: -120 });
  });

  it('gives way to a fire team placed after it, and takes over when placed after one', () => {
    const exercise = setup();
    exercise.placeFormation('SQD', { x: 0, y: -120 }, deg(0));
    exercise.placeFormation('FT2', { x: -40, y: -60 }, deg(0));
    const ft2 = exercise.formationGroups.find((g) => g.unitId === 'FT2')?.memberIds ?? [];
    // The fire team's Marines now follow their team's formation, not the squad's.
    expect(exercise.formation('FT2')?.linked).toEqual(ft2);
    expect(exercise.formation('SQD')?.linked).toHaveLength(9);
    expect(exercise.formation('SQD')?.linked.some((id) => ft2.includes(id))).toBe(false);
    // Placing the squad again re-links everyone; the fire team's formation then has nobody.
    exercise.placeFormation('SQD', { x: 0, y: -100 }, deg(0));
    expect(exercise.formation('SQD')?.linked).toHaveLength(13);
    expect(exercise.formation('FT2')).toBeUndefined();
  });
});
