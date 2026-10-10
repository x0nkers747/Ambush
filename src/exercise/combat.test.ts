import { describe, expect, it } from 'vitest';
import {
  createSyntheticTerrain,
  fingerprintPlainData,
  hashSimState,
  pointInPolygon,
  rectangle,
  soldierId,
  validateCombatConfig,
  weaponCombatProfile,
  type SimEvent,
  type Vec2,
} from '#sim';
import type { AmbushScenario } from './ambush-scenario';
import { DEFAULT_COMBAT_CONFIG } from './combat';
import combatV1 from './combat/combat-v1.json';
import { DEMO_SCENARIO } from './demo-scenario';
import { createExercise, type Exercise } from './exercise';
import type { OrganizationTemplate } from './organization';
import {
  addRouteWaypoint,
  buildScenario,
  defaultScenarioDefinition,
  OPFOR_FORCES,
  setOpforStart,
  setOrp,
  type EditResult,
  type ScenarioDefinition,
} from './scenario-definition';
import { WEAPON_DISPLAY_PROFILES } from './weapon-display';

// Combat in the exercise (docs/adr/0019): the default configuration, which
// weapon each soldier fires, and complete engagements after the trainee's
// TRIGGER AMBUSH (docs/adr/0021).

/** A kill zone across the demo patrol's road, 40 m south of the ORP's northern edge. */
const DEMO_KILL_ZONE: Vec2[] = [
  { x: -40, y: -20 },
  { x: 40, y: -20 },
  { x: 40, y: 30 },
  { x: -40, y: 30 },
];

/** The demo with its kill zone: Execute, then START OPFOR. Returns as the approach begins. */
function approachingDemo(seed: number, scenario: AmbushScenario = DEMO_SCENARIO): Exercise {
  const exercise = createExercise({ config: { tickRateHz: 30, seed }, scenario });
  for (const v of DEMO_KILL_ZONE) exercise.addKillZoneVertex(v);
  exercise.execute();
  exercise.advance(1 / 30);
  if (!exercise.startOpfor().ok) throw new Error('START OPFOR refused');
  return exercise;
}

/**
 * The demo, sprung: the trainee presses TRIGGER AMBUSH once `inside` patrol
 * members are in the kill zone, stepping one tick at a time so that the trigger
 * tick does not depend on frame timing. Returns at the trigger.
 */
function sprungDemo(seed: number, scenario: AmbushScenario = DEMO_SCENARIO, inside = 1): Exercise {
  const exercise = approachingDemo(seed, scenario);
  for (let i = 0; i < 30 * 300 && (exercise.killZoneOccupancy()?.inside ?? 0) < inside; i += 1)
    exercise.advance(1 / 30);
  if (!exercise.triggerAmbush().ok) throw new Error('TRIGGER AMBUSH refused');
  return exercise;
}

/** Plays the approach at `timeScale` (60 frames per real second) to exactly `tick`, and triggers. */
function triggerAtTick(exercise: Exercise, tick: number, timeScale: number): void {
  const perFrame = Math.round((timeScale * 30) / 60);
  while (exercise.simulation.tick + perFrame <= tick) exercise.advance(1 / 60, timeScale);
  while (exercise.simulation.tick < tick) exercise.advance(1 / 30);
  if (exercise.simulation.tick !== tick) throw new Error('overshot the trigger tick');
  if (!exercise.triggerAmbush().ok) throw new Error('TRIGGER AMBUSH refused');
}

/** Plays at `timeScale` with 60 frames per real second until the engagement ends. */
function playOut(exercise: Exercise, timeScale = 16): SimEvent[] {
  const events: SimEvent[] = [];
  for (let frame = 0; frame < 60 * 2000 && exercise.phase !== 'engagementComplete'; frame += 1) {
    events.push(...exercise.advance(1 / 60, timeScale));
  }
  return events;
}

describe('the default combat configuration', () => {
  it('is valid, versioned, and gives every primary weapon a combat profile', () => {
    expect(validateCombatConfig(combatV1)).toEqual(DEFAULT_COMBAT_CONFIG);
    expect(DEFAULT_COMBAT_CONFIG).toMatchObject({
      schema: 'ambush.combat-config',
      schemaVersion: 1,
      id: 'ambush-combat-v1',
    });
    const primaries = Object.entries(WEAPON_DISPLAY_PROFILES)
      .filter(([, p]) => p.weaponClass === 'primary')
      .map(([ref]) => ref);
    expect(primaries).toEqual(['m16-rifle', 'squad-automatic-weapon', 'ak-assault-rifle']);
    for (const ref of primaries)
      expect(weaponCombatProfile(DEFAULT_COMBAT_CONFIG, ref), ref).toBeDefined();
  });

  it('has the documented defaults', () => {
    const { opfor, engagement, postureHitMultipliers } = DEFAULT_COMBAT_CONFIG;
    expect(opfor.reactionProbabilities).toEqual({ prone: 0.6, flee: 0.4 });
    expect(postureHitMultipliers.prone).toBe(0.5);
    expect(engagement.maxDurationSeconds).toBe(60);
    expect(weaponCombatProfile(DEFAULT_COMBAT_CONFIG, 'm16-rifle')).toEqual({
      weaponProfileRef: 'm16-rifle',
      hitProbabilityByRange: [
        { rangeM: 0, probability: 0.75 },
        { rangeM: 50, probability: 0.65 },
        { rangeM: 100, probability: 0.45 },
        { rangeM: 200, probability: 0.2 },
        { rangeM: 300, probability: 0.1 },
        { rangeM: 500, probability: 0.02 },
      ],
      maxEngagementRangeM: 550,
      incapacitationProbabilityOnHit: 0.6,
      secondsBetweenShots: 1.5,
    });
  });
});

describe('which weapon each soldier fires', () => {
  it('is the primary weapon of the resolved loadout, for both sides', () => {
    const exercise = createExercise({
      config: { tickRateHz: 30, seed: 1 },
      scenario: DEMO_SCENARIO,
    });
    const byRole = Object.fromEntries(
      exercise.simulation.state.soldiers.map((s) => [
        exercise.rosterMember(s.id)?.slot.id ?? s.id,
        exercise.combatWeapons[s.id],
      ]),
    );
    expect(byRole).toEqual({
      SL: 'm16-rifle',
      ...Object.fromEntries(
        [1, 2, 3].flatMap((t) => [
          [`FT${String(t)}.FTL`, 'm16-rifle'], // not the M203 or the bayonet
          [`FT${String(t)}.AR`, 'squad-automatic-weapon'],
          [`FT${String(t)}.AAR`, 'm16-rifle'],
          [`FT${String(t)}.R`, 'm16-rifle'],
        ]),
      ),
      'EN-1': 'ak-assault-rifle',
      'EN-2': 'ak-assault-rifle',
      'EN-3': 'ak-assault-rifle',
    });
    expect(OPFOR_FORCES['patrol-3'].loadout.weaponProfileRefs).toEqual(['ak-assault-rifle']);
  });

  it('follows a slot’s own loadout over its role’s default', () => {
    const template: OrganizationTemplate = {
      ...DEMO_SCENARIO.organization.template,
      slots: DEMO_SCENARIO.organization.template.slots.map((s) =>
        s.id === 'FT1.R' ? { ...s, loadout: { weaponProfileRefs: ['squad-automatic-weapon'] } } : s,
      ),
    };
    const scenario = {
      ...DEMO_SCENARIO,
      organization: { ...DEMO_SCENARIO.organization, template },
    };
    const exercise = createExercise({ config: { tickRateHz: 30, seed: 1 }, scenario });
    const fireTeam1Rifleman = DEMO_SCENARIO.organization.members.find((m) => m.slotId === 'FT1.R');
    const fireTeam2Rifleman = DEMO_SCENARIO.organization.members.find((m) => m.slotId === 'FT2.R');
    expect(exercise.combatWeapons[fireTeam1Rifleman?.soldierId ?? '']).toBe(
      'squad-automatic-weapon',
    );
    expect(exercise.combatWeapons[fireTeam2Rifleman?.soldierId ?? '']).toBe('m16-rifle');
  });

  it('is none for an unknown weapon: that soldier reacts but never fires', () => {
    const scenario: AmbushScenario = {
      ...DEMO_SCENARIO,
      opforLoadouts: {
        ...DEMO_SCENARIO.opforLoadouts,
        'EN-1': { weaponProfileRefs: ['mystery-rifle'] },
      },
    };
    const exercise = sprungDemo(4, scenario);
    expect(exercise.combatWeapons['EN-1']).toBeNull();
    playOut(exercise);
    const result = exercise.engagementResult;
    const en1 = result?.soldiers.find((s) => s.soldierId === 'EN-1');
    expect(en1?.weaponProfileRef).toBeNull();
    expect(en1?.stats.shotsFired).toBe(0);
    expect(en1?.reaction !== null || en1.outcome === 'incapacitated').toBe(true);
  });

  it('is none for an OPFOR soldier without a loadout', () => {
    const unarmed: AmbushScenario = { ...DEMO_SCENARIO };
    delete (unarmed as { opforLoadouts?: unknown }).opforLoadouts;
    const exercise = createExercise({ config: { tickRateHz: 30, seed: 1 }, scenario: unarmed });
    expect(exercise.combatWeapons['EN-2']).toBeNull();
  });
});

describe('an engagement in the exercise', () => {
  it('lets the patrol run away and escape when no Marine can fire (docs/adr/0028)', () => {
    // Every weapon reaches only 1 m: as if the Marines were hidden where they cannot shoot.
    const combat = {
      ...DEFAULT_COMBAT_CONFIG,
      weapons: DEFAULT_COMBAT_CONFIG.weapons.map((w) => ({
        ...w,
        hitProbabilityByRange: [{ rangeM: 0, probability: 0.5 }],
        maxEngagementRangeM: 1,
      })),
    };
    const exercise = createExercise({
      config: { tickRateHz: 30, seed: 3 },
      scenario: DEMO_SCENARIO,
      combat,
    });
    for (const v of DEMO_KILL_ZONE) exercise.addKillZoneVertex(v);
    exercise.execute();
    exercise.advance(1 / 30);
    if (!exercise.startOpfor().ok) throw new Error('START OPFOR refused');
    for (let i = 0; i < 30 * 300 && (exercise.killZoneOccupancy()?.inside ?? 0) < 1; i += 1)
      exercise.advance(1 / 30);
    if (!exercise.triggerAmbush().ok) throw new Error('TRIGGER AMBUSH refused');
    const at = new Map(
      exercise.simulation.state.soldiers
        .filter((s) => s.side === 'OPFOR')
        .map((s) => [s.id, { ...s.position }]),
    );
    const events = playOut(exercise, 1);
    const result = exercise.engagementResult;
    expect(result?.endReason).toBe('opforEscaped');
    expect(result?.sides.OPFOR.escaped).toBe(3);
    expect(result?.sides.BLUEFOR.shotsFired).toBe(0);
    expect(events.filter((e) => e.type === 'opforReacted').map((e) => e.reaction)).toEqual([
      'flee',
      'flee',
      'flee',
    ]);
    for (const s of exercise.simulation.state.soldiers.filter((x) => x.side === 'OPFOR')) {
      const from = at.get(s.id);
      if (!from) throw new Error('fixture');
      // At least the escape distance from where it was, give or take the distance walked
      // before reacting.
      expect(Math.hypot(s.position.x - from.x, s.position.y - from.y)).toBeGreaterThan(45);
    }
    // Well before the time limit: 50 m at 4.5 m/s, after a reaction of at most 2 s.
    expect(result?.durationSeconds).toBeLessThan(15);
  });

  it('begins at the trigger and runs to a result that matches its combat log', () => {
    const exercise = sprungDemo(5);
    expect(exercise.phase).toBe('opforApproach');
    expect(exercise.triggerState).toBe('queued');
    const trigger = exercise.trigger;
    expect(trigger).not.toBeNull();
    exercise.advance(1 / 30);
    expect(exercise.phase).toBe('engagement');
    playOut(exercise, 1);
    expect(exercise.phase).toBe('engagementComplete');

    const result = exercise.engagementResult;
    if (!result) throw new Error('no result');
    // The engagement begins at the start of the tick the trainee triggered at.
    expect(result.startTick).toBe(trigger?.tick);
    expect(result.startSeconds).toBe(trigger?.atSeconds);
    expect(trigger).toMatchObject({ opforInKillZone: 1, opforTotal: 3, whilePaused: false });
    expect(trigger?.opforPositions.map((p) => p.soldierId)).toEqual(['EN-1', 'EN-2', 'EN-3']);
    expect(result.seed).toBe(5);
    expect(result.tickRateHz).toBe(30);
    expect(result.combatConfig).toEqual({
      id: 'ambush-combat-v1',
      version: DEFAULT_COMBAT_CONFIG.version,
      fingerprint: fingerprintPlainData(DEFAULT_COMBAT_CONFIG),
    });
    expect(result.trigger).toEqual(trigger);
    expect(result.durationSeconds).toBeCloseTo(
      (result.endSeconds ?? NaN) - result.startSeconds,
      12,
    );
    expect(result.durationSeconds).toBeLessThanOrEqual(60 + 1e-9);

    const log = exercise.combatLog;
    expect(log[0]?.type).toBe('engagementStarted');
    expect(log.at(-1)?.type).toBe('engagementEnded');
    for (const side of ['BLUEFOR', 'OPFOR'] as const) {
      const shots = log.filter((e) => e.type === 'shotFired' && e.shooterSide === side);
      const sideResult = result.sides[side];
      expect(sideResult.shotsFired).toBe(shots.length);
      expect(sideResult.hits).toBe(shots.filter((e) => e.type === 'shotFired' && e.hit).length);
      expect(sideResult.incapacitations).toBe(
        shots.filter((e) => e.type === 'shotFired' && e.incapacitated).length,
      );
      const members = new Set(
        result.soldiers.filter((s) => s.side === side).map((s) => s.soldierId),
      );
      expect(sideResult.startingStrength).toBe(members.size);
      expect(sideResult.incapacitated).toBe(
        log.filter((e) => e.type === 'soldierIncapacitated' && members.has(e.soldierId)).length,
      );
      expect(sideResult.escaped).toBe(
        log.filter((e) => e.type === 'soldierEscaped' && members.has(e.soldierId)).length,
      );
      expect(sideResult.incapacitated + sideResult.escaped + sideResult.survivingNotEscaped).toBe(
        sideResult.startingStrength,
      );
    }
    expect(result.sides.OPFOR.startingStrength).toBe(3);
    expect(result.sides.BLUEFOR.startingStrength).toBe(13);
    expect(exercise.timeline.at(-1)).toMatchObject({ type: 'engagementEnded', result });
    // Frozen once complete.
    const tick = exercise.simulation.tick;
    expect(exercise.advance(10, 16)).toEqual([]);
    expect(exercise.simulation.tick).toBe(tick);
  });

  it('gives identical results at 1×, 4×, 8× and 16× playback', () => {
    const start = approachingDemo(6).simulation.tick;
    const outcomes = [1, 4, 8, 16].map((scale) => {
      const exercise = approachingDemo(6);
      // The approach, too, is played at that speed; the trigger lands on the same tick.
      triggerAtTick(exercise, start + 30 * 40, scale);
      const events = playOut(exercise, scale);
      return {
        hash: hashSimState(exercise.simulation.state),
        result: exercise.engagementResult,
        log: exercise.combatLog,
        events: events.length,
      };
    });
    expect(outcomes[0]?.result?.sides.BLUEFOR.shotsFired).toBeGreaterThan(0);
    for (const outcome of outcomes.slice(1)) {
      expect(outcome.hash).toBe(outcomes[0]?.hash);
      expect(outcome.result).toEqual(outcomes[0]?.result);
      expect(outcome.log).toEqual(outcomes[0]?.log);
    }
  });

  it('can be paused and resumed during the engagement without changing the outcome', () => {
    const straight = sprungDemo(7);
    playOut(straight);
    const paused = sprungDemo(7);
    paused.advance(1, 2);
    if (paused.phase === 'engagement') {
      paused.pause();
      expect(paused.advance(5)).toEqual([]);
      expect(paused.resume()).toEqual({ ok: true, revision: null });
    }
    playOut(paused);
    expect(hashSimState(paused.simulation.state)).toBe(hashSimState(straight.simulation.state));
  });

  it('is triggered while paused: queued until resumed, then identical to triggering at that tick', () => {
    const straight = approachingDemo(8);
    const tick = straight.simulation.tick + 30 * 45;
    triggerAtTick(straight, tick, 1);
    playOut(straight);

    const paused = approachingDemo(8);
    while (paused.simulation.tick < tick) paused.advance(1 / 30);
    paused.pause();
    expect(paused.triggerAmbush().ok).toBe(true);
    expect(paused.trigger?.whilePaused).toBe(true);
    expect(paused.triggerState).toBe('queued');
    expect(paused.advance(3)).toEqual([]);
    expect(paused.simulation.state.engagement).toBeUndefined();
    paused.resume();
    playOut(paused);
    expect(paused.engagementResult?.startTick).toBe(tick);
    expect(hashSimState(paused.simulation.state)).toBe(hashSimState(straight.simulation.state));
    expect(paused.combatLog).toEqual(straight.combatLog);
  });

  it('turns out differently when triggered at a different moment', () => {
    const outcomes = [35, 45, 55].map((seconds) => {
      const exercise = approachingDemo(9);
      triggerAtTick(exercise, exercise.simulation.tick + 30 * seconds, 4);
      playOut(exercise);
      return hashSimState(exercise.simulation.state);
    });
    expect(new Set(outcomes).size).toBe(3);
  });

  it('counts only active OPFOR in the kill zone: the incapacitated and escaped drop out', () => {
    let checked = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const exercise = sprungDemo(seed, DEMO_SCENARIO, 3);
      expect(exercise.killZoneOccupancy()).toEqual({ inside: 3, total: 3 });
      expect(exercise.trigger?.opforInKillZone).toBe(3);
      while (exercise.phase !== 'engagementComplete') {
        exercise.advance(1 / 30);
        const combatants = exercise.simulation.state.engagement?.combatants ?? [];
        const out = new Set(
          combatants
            .filter((c) => c.behavior === 'escaped' || c.behavior === 'incapacitated')
            .map((c) => c.soldierId),
        );
        const inside = exercise.simulation.state.soldiers.filter(
          (s) =>
            s.side === 'OPFOR' &&
            s.status === 'active' &&
            !out.has(s.id) &&
            pointInPolygon(s.position, DEMO_KILL_ZONE),
        ).length;
        expect(exercise.killZoneOccupancy()).toEqual({ inside, total: 3 });
        if (out.size > 0) checked += 1;
      }
      // Falling or escaping inside the kill zone is not walking out of it.
      for (const left of exercise.timeline) {
        if (left.type !== 'killZoneLeft') continue;
        const out = exercise.combatLog.find(
          (e) =>
            (e.type === 'soldierIncapacitated' || e.type === 'soldierEscaped') &&
            e.soldierId === left.soldierId,
        );
        expect(out === undefined || out.tick > left.tick).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('turns out differently with different seeds', () => {
    const outcomes = [1, 2, 3, 4, 5, 6].map((seed) => {
      const exercise = sprungDemo(seed);
      playOut(exercise);
      const r = exercise.engagementResult;
      return JSON.stringify([r?.durationSeconds, r?.sides, r?.soldiers.map((s) => s.reaction)]);
    });
    expect(new Set(outcomes).size).toBeGreaterThan(3);
  });

  it('keeps the scenario fingerprint (and saved plans) independent of the combat model', () => {
    const a = createExercise({ config: { tickRateHz: 30, seed: 1 }, scenario: DEMO_SCENARIO });
    const b = createExercise({
      config: { tickRateHz: 30, seed: 1 },
      scenario: DEMO_SCENARIO,
      combat: {
        ...DEFAULT_COMBAT_CONFIG,
        version: '1.0.1',
        postureHitMultipliers: { standing: 1, kneeling: 1, prone: 0.4 },
      },
    });
    expect(b.scenarioFingerprint).toBe(a.scenarioFingerprint);
    expect(b.simulation.world.combat?.config.version).toBe('1.0.1');
  });
});

describe('a complete engagement on a 5 km battlefield', () => {
  /** 5 km × 5 km of rolling ground with a wood, a hamlet and a road-side patrol route. */
  function battlefield() {
    const terrain = createSyntheticTerrain(
      { originX: -2500, originY: -2500, cellSize: 10, columns: 501, rows: 501 },
      (x, y) => 120 + 12 * Math.sin(x / 450) * Math.cos(y / 520) + 4 * Math.sin((x + y) / 160),
      {
        roads: [],
        buildings: [0, 1, 2, 3].map((k) => ({
          id: `house-${String(k)}`,
          footprint: rectangle(-300 + 40 * k, 700, 12, 10),
          heightMeters: 6,
        })),
        vegetation: [
          {
            id: 'wood',
            kind: 'woodland',
            boundary: rectangle(600, 520, 300, 200),
            canopyHeightMeters: 15,
            seeThroughMeters: 40,
          },
        ],
      },
    );
    const ok = (r: EditResult): ScenarioDefinition => {
      if (!r.ok) throw new Error(r.problem);
      return r.definition;
    };
    let d = defaultScenarioDefinition(terrain, 'synthetic-5km');
    d = ok(setOrp(terrain, d, { x: 0, y: 200 }));
    d = ok(setOpforStart(terrain, d, { x: -1800, y: 520 }));
    d = ok(addRouteWaypoint(terrain, d, { x: 0, y: 520 }));
    d = ok(addRouteWaypoint(terrain, d, { x: 1800, y: 520 }));
    return { terrain, scenario: buildScenario(terrain, d) };
  }

  it('plays from planning through the ambush to an engagement result', () => {
    const { scenario } = battlefield();
    const exercise = createExercise({ config: { tickRateHz: 30, seed: 2 }, scenario });
    // The squad on a line 200 m south of the road, facing it.
    const marines = exercise.simulation.state.soldiers.filter((s) => s.side === 'BLUEFOR');
    marines.forEach((m, k) => {
      exercise.setDestination(m.id, { x: -120 + 20 * k, y: 330 });
      exercise.setFacing(m.id, 0);
    });
    for (const v of rectangle(0, 520, 80, 40)) exercise.addKillZoneVertex(v);
    expect(exercise.execute().ok).toBe(true);
    for (let i = 0; i < 2000 && exercise.phase === 'bluforOccupation'; i += 1)
      exercise.advance(1, 16);
    expect(exercise.phase).toBe('bluforReady');
    expect(exercise.startOpfor().ok).toBe(true);
    // The patrol walks into the kill zone; the trainee triggers once two are in it.
    for (let i = 0; i < 30 * 4000 && (exercise.killZoneOccupancy()?.inside ?? 0) < 2; i += 1)
      exercise.advance(1 / 30);
    expect(exercise.phase).toBe('opforApproach');
    expect(exercise.simulation.state.engagement).toBeUndefined();
    expect(exercise.triggerAmbush().ok).toBe(true);
    expect(exercise.trigger).toMatchObject({ opforInKillZone: 2, opforTotal: 3 });
    exercise.advance(1 / 30);
    expect(exercise.phase).toBe('engagement');
    for (let i = 0; i < 200 && exercise.phase === 'engagement'; i += 1) exercise.advance(1, 16);
    expect(exercise.phase).toBe('engagementComplete');
    const result = exercise.engagementResult;
    expect(result?.sides.BLUEFOR.shotsFired).toBeGreaterThan(0);
    expect(result?.durationSeconds).toBeLessThanOrEqual(60 + 1e-9);
    expect(result?.endReason).not.toBeNull();
    // Every OPFOR soldier reacted or was incapacitated before it could.
    const reacted = new Set(
      exercise.combatLog.flatMap((e) => (e.type === 'opforReacted' ? [e.soldierId] : [])),
    );
    for (const s of result?.soldiers.filter((x) => x.side === 'OPFOR') ?? []) {
      expect(reacted.has(soldierId(s.soldierId)) || s.outcome === 'incapacitated').toBe(true);
    }
  }, 120_000);
});
