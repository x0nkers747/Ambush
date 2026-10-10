import { describe, expect, it } from 'vitest';
import { soldierId, type EngagementSummary, type Vec2 } from '#sim';
import { DEMO_SCENARIO } from './demo-scenario';
import { createExercise, type Exercise } from './exercise';
import {
  displayPoints,
  gradeOf,
  scoreEngagement,
  type EngagementScore,
  type ScoreCategoryId,
} from './scoring';

// The After Action Review's score and recommendations (docs/adr/0027).

type Outcome = 'active' | 'incapacitated' | 'escaped';
interface Spec {
  readonly id: string;
  readonly side: 'BLUEFOR' | 'OPFOR';
  readonly shots?: number;
  readonly outcome?: Outcome;
  readonly armed?: boolean;
}
/** A completed engagement's summary with these soldiers. */
function summary(specs: readonly Spec[], ended = true): EngagementSummary {
  const soldiers = specs.map((s) => ({
    soldierId: soldierId(s.id),
    side: s.side,
    weaponProfileRef: s.armed === false ? null : 'rifle',
    reaction: null,
    fleeBlocked: false,
    outcome: s.outcome ?? 'active',
    outAtSeconds: null,
    stats: { shotsFired: s.shots ?? 0, hits: 0, incapacitations: 0, timesHit: 0 },
  }));
  const side = (which: 'BLUEFOR' | 'OPFOR') => {
    const own = soldiers.filter((s) => s.side === which);
    return {
      startingStrength: own.length,
      incapacitated: own.filter((s) => s.outcome === 'incapacitated').length,
      escaped: own.filter((s) => s.outcome === 'escaped').length,
      survivingNotEscaped: own.filter((s) => s.outcome === 'active').length,
      shotsFired: own.reduce((n, s) => n + s.stats.shotsFired, 0),
      hits: 0,
      incapacitations: 0,
    };
  };
  return {
    startTick: 0,
    startSeconds: 0,
    endSeconds: ended ? 30 : null,
    durationSeconds: ended ? 30 : null,
    endReason: ended ? 'allOpforIncapacitated' : null,
    sides: { BLUEFOR: side('BLUEFOR'), OPFOR: side('OPFOR') },
    soldiers,
  };
}
const marines = (n: number, each: (i: number) => Partial<Spec> = () => ({ shots: 1 })) =>
  Array.from({ length: n }, (_, i): Spec => ({
    id: `M${String(i + 1)}`,
    side: 'BLUEFOR',
    ...each(i),
  }));
const enemies = (
  n: number,
  each: (i: number) => Partial<Spec> = () => ({ outcome: 'incapacitated' }),
) =>
  Array.from({ length: n }, (_, i): Spec => ({
    id: `EN-${String(i + 1)}`,
    side: 'OPFOR',
    ...each(i),
  }));
const points = (s: EngagementScore, id: ScoreCategoryId) =>
  s.categories.find((c) => c.id === id)?.points;
const ids = (s: EngagementScore) => s.recommendations.map((r) => r.id);

describe('fire participation (20)', () => {
  it('gives full points when every armed Marine fired, and a share otherwise', () => {
    expect(points(scoreEngagement(summary([...marines(4), ...enemies(1)])), 'participation')).toBe(
      20,
    );
    const partial = scoreEngagement(
      summary([...marines(4, (i) => ({ shots: i < 3 ? 2 : 0 })), ...enemies(1)]),
    );
    expect(points(partial, 'participation')).toBe(15);
    expect(partial.categories[0]?.unitIds).toEqual(['M4']);
    expect(partial.categories[0]?.deductions[0]).toMatch(/1 eligible Marine never fired/);
  });

  it('leaves unarmed Marines out, and is unavailable when nobody could fire', () => {
    const s = scoreEngagement(
      summary([...marines(3), { id: 'M9', side: 'BLUEFOR', armed: false }, ...enemies(1)]),
    );
    expect(points(s, 'participation')).toBe(20);
    const none = scoreEngagement(summary([...marines(2, () => ({ armed: false })), ...enemies(1)]));
    expect(none.categories[0]).toMatchObject({ points: null, supported: false });
    expect(none.categories[0]?.unavailableReason).toMatch(/No Marine had a weapon/);
    expect(none.complete).toBe(false);
    expect(none.total).toBeNull();
  });
});

describe('BLUEFOR survival (30)', () => {
  it('gives full points without casualties', () => {
    expect(points(scoreEngagement(summary([...marines(10), ...enemies(1)])), 'survival')).toBe(30);
  });

  it('counts an incapacitated Marine as killed (×2); wounded is not modelled', () => {
    const one = scoreEngagement(
      summary([
        ...marines(10, (i) => ({ shots: 1, outcome: i === 0 ? 'incapacitated' : 'active' })),
        ...enemies(1),
      ]),
    );
    expect(points(one, 'survival')).toBeCloseTo(30 * (1 - 2 / 10));
    expect(one.categories[1]?.measurements).toContainEqual({
      label: 'Wounded',
      value: 'not modelled',
    });
    // Two of ten fallen: 30 × (1 − 4/10); never below zero.
    const two = scoreEngagement(
      summary([
        ...marines(10, (i) => ({ shots: 1, outcome: i < 2 ? 'incapacitated' : 'active' })),
        ...enemies(1),
      ]),
    );
    expect(points(two, 'survival')).toBeCloseTo(18);
    const most = scoreEngagement(
      summary([
        ...marines(4, (i) => ({ shots: 1, outcome: i < 3 ? 'incapacitated' : 'active' })),
        ...enemies(1),
      ]),
    );
    expect(points(most, 'survival')).toBe(0);
  });
});

describe('OPFOR containment (30)', () => {
  it('uses the recorded escapes only, not survivors', () => {
    expect(points(scoreEngagement(summary([...marines(4), ...enemies(3)])), 'containment')).toBe(
      30,
    );
    // A survivor who did not escape costs nothing.
    const survivor = scoreEngagement(
      summary([
        ...marines(4),
        ...enemies(3, (i) => ({ outcome: i === 0 ? 'active' : 'incapacitated' })),
      ]),
    );
    expect(points(survivor, 'containment')).toBe(30);
    const one = scoreEngagement(
      summary([
        ...marines(4),
        ...enemies(3, (i) => ({ outcome: i === 0 ? 'escaped' : 'incapacitated' })),
      ]),
    );
    expect(points(one, 'containment')).toBeCloseTo(20);
    expect(one.categories[2]?.unitIds).toEqual(['EN-1']);
    const all = scoreEngagement(
      summary([...marines(4), ...enemies(3, () => ({ outcome: 'escaped' }))]),
    );
    expect(points(all, 'containment')).toBe(0);
  });
});

describe('fire efficiency (20)', () => {
  const run = (shots: number, kills: number) =>
    scoreEngagement(
      summary([
        ...marines(1, () => ({ shots })),
        ...enemies(Math.max(kills, 1), (i) => ({
          outcome: i < kills ? 'incapacitated' : 'active',
        })),
      ]),
    );
  it('scores shots per enemy incapacitated: 1 is full, 10 is about half, 20 or more none', () => {
    expect(points(run(3, 3), 'efficiency')).toBe(20);
    expect(points(run(30, 3), 'efficiency')).toBeCloseTo((20 * 10) / 19);
    expect(points(run(60, 3), 'efficiency')).toBe(0);
    expect(points(run(90, 3), 'efficiency')).toBe(0);
  });
  it('gives no points without an enemy incapacitated', () => {
    expect(points(run(12, 0), 'efficiency')).toBe(0);
    expect(run(12, 0).categories[3]?.deductions[0]).toMatch(/No enemy was incapacitated/);
  });
});

describe('the total and grade', () => {
  it('adds the four categories at full precision, and grades the total as shown', () => {
    const s = scoreEngagement(
      summary([...marines(4, (i) => ({ shots: i < 3 ? 2 : 0 })), ...enemies(3)]),
    );
    expect(s.complete).toBe(true);
    expect(s.total).toBeCloseTo(15 + 30 + 30 + 20 * ((20 - 2) / 19));
    // The grade follows the total as shown (one decimal): 89.96 shows as 90.0, an A.
    expect([95, 89.9, 89.96, 70, 60, 59.94].map((t) => [displayPoints(t), gradeOf(t)])).toEqual([
      ['95.0', 'A'],
      ['89.9', 'B'],
      ['90.0', 'A'],
      ['70.0', 'C'],
      ['60.0', 'D'],
      ['59.9', 'F'],
    ]);
  });
  it('is an incomplete assessment, with nothing invented, before the engagement ends or without one', () => {
    for (const s of [
      scoreEngagement(summary([...marines(2), ...enemies(1)], false)),
      scoreEngagement(null),
    ]) {
      expect(s.complete).toBe(false);
      expect(s.total).toBeNull();
      expect(s.categories.every((c) => c.points === null && !c.supported)).toBe(true);
      expect(s.recommendations).toEqual([]);
    }
  });
  it('is deterministic', () => {
    const input = summary([
      ...marines(5, (i) => ({ shots: i })),
      ...enemies(3, (i) => ({ outcome: i === 0 ? 'escaped' : 'incapacitated' })),
    ]);
    expect(scoreEngagement(input)).toEqual(
      scoreEngagement(JSON.parse(JSON.stringify(input)) as EngagementSummary),
    );
  });
});

describe('recommendations', () => {
  it('names each problem once, most severe first, with its measurements and units', () => {
    const s = scoreEngagement(
      summary([
        ...marines(4, (i) => ({
          shots: i === 3 ? 0 : 20,
          outcome: i === 0 ? 'incapacitated' : 'active',
        })),
        ...enemies(3, (i) => ({ outcome: i === 0 ? 'escaped' : 'incapacitated' })),
      ]),
    );
    expect(ids(s)).toEqual([
      'friendly-casualties',
      'enemy-escape',
      'inefficient-fire', // medium, but 20 points lost
      'incomplete-participation', // medium, 5 points lost
    ]);
    const escape = s.recommendations.find((r) => r.id === 'enemy-escape');
    expect(escape?.unitIds).toEqual(['EN-1']);
    expect(escape?.recommendation).toMatch(/covers likely exit routes/);
    expect(s.recommendations.find((r) => r.id === 'incomplete-participation')?.unitIds).toEqual([
      'M4',
    ]);
    expect(new Set(ids(s)).size).toBe(ids(s).length);
  });
  it('says "no enemy casualties" rather than "inefficient" when nobody was incapacitated', () => {
    const s = scoreEngagement(
      summary([...marines(3, () => ({ shots: 40 })), ...enemies(2, () => ({ outcome: 'active' }))]),
    );
    expect(ids(s)).toContain('no-enemy-casualties');
    expect(ids(s)).not.toContain('inefficient-fire');
  });
  it('notes strong performance only when nothing went wrong', () => {
    const good = scoreEngagement(summary([...marines(4, () => ({ shots: 1 })), ...enemies(3)]));
    expect(ids(good)).toEqual(['excellent-performance']);
    const wasteful = scoreEngagement(summary([...marines(4, () => ({ shots: 4 })), ...enemies(3)]));
    // 16 shots for 3 kills: 5.3 per kill, 15.4 points (< 16): no praise, and not "inefficient" either.
    expect(ids(wasteful)).toEqual([]);
  });
});

// --- On a real engagement -----------------------------------------------------------

const KILL_ZONE: Vec2[] = [
  { x: -40, y: -20 },
  { x: 40, y: -20 },
  { x: 40, y: 30 },
  { x: -40, y: 30 },
];
function played(seed: number, plan?: (e: Exercise) => void): Exercise {
  const exercise = createExercise({ config: { tickRateHz: 30, seed }, scenario: DEMO_SCENARIO });
  for (const v of KILL_ZONE) exercise.addKillZoneVertex(v);
  plan?.(exercise);
  exercise.execute();
  for (let i = 0; i < 30 * 600 && !exercise.bluforMovementComplete; i += 1)
    exercise.advance(1 / 30);
  if (!exercise.startOpfor().ok) throw new Error('START OPFOR refused');
  for (let i = 0; i < 30 * 300 && (exercise.killZoneOccupancy()?.inside ?? 0) < 1; i += 1)
    exercise.advance(1 / 30);
  if (!exercise.triggerAmbush().ok) throw new Error('TRIGGER AMBUSH refused');
  for (let i = 0; i < 30 * 120 && exercise.phase !== 'engagementComplete'; i += 1)
    exercise.advance(1 / 30);
  return exercise;
}

describe('the score of a played engagement', () => {
  it('comes from the completed engagement, whatever the replay shows', () => {
    const exercise = played(7);
    const score = scoreEngagement(exercise.engagementResult);
    expect(score.complete).toBe(true);
    expect(score.total).not.toBeNull();
    const frames = exercise.recording?.frames.length ?? 0;
    // Scrubbing back and forth changes nothing.
    for (const k of [frames - 1, 0, Math.floor(frames / 2), 3, frames - 1]) exercise.replayAt(k);
    expect(scoreEngagement(exercise.engagementResult)).toEqual(score);
    // A frame before the end is not a completed engagement: no score from it.
    expect(scoreEngagement(exercise.replayAt(1).engagementResult).complete).toBe(false);
    expect(scoreEngagement(exercise.replayAt(frames - 1).engagementResult)).toEqual(score);
  });
  it('is fresh for a new run, and the first run’s stays as it was', () => {
    const first = played(7);
    const firstScore = scoreEngagement(first.engagementResult);
    const second = played(7, (e) => e.placeFormation('FT1', { x: -30, y: -50 }));
    const secondScore = scoreEngagement(second.engagementResult);
    expect(secondScore.complete).toBe(true);
    expect(scoreEngagement(first.engagementResult)).toEqual(firstScore);
    expect(secondScore).not.toBe(firstScore);
  });
});
