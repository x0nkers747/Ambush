import { beforeAll, describe, expect, it } from 'vitest';
import { labTerrain } from '#exercise/behavior-lab';
import {
  newBattleScenario,
  parseBattleScenario,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import { hashSimState, NO_FEATURES, rectangle, type OrderKind, type Vec2 } from '#sim';
import { createCombat } from './combat';
import { createPlanner } from './planner';
import { createReview } from './review';
import type { BattleRecording } from './session';

// The reference battle (docs/constructive-simulation/05): three BLUEFOR
// squads against three OPFOR squads, made, fought and reviewed end to end
// through the same planner, combat and review the page uses, as a user
// would: squads placed in Scenario Setup and given their orders in Planning,
// the battle fought with orders to both sides (replacing, appending,
// holding, some while paused) until the user ends it, then replayed from
// tick 0 and verified, and inspected at moments of it.

/** Open ground with a hamlet of four houses between the two sides. */
const terrain = labTerrain({
  ...NO_FEATURES,
  buildings: [
    { id: 'h1', footprint: rectangle(-60, 20, 14, 10), heightMeters: 7 },
    { id: 'h2', footprint: rectangle(-20, 40, 12, 12), heightMeters: 6 },
    { id: 'h3', footprint: rectangle(30, 10, 16, 10, 20), heightMeters: 8 },
    { id: 'h4', footprint: rectangle(70, 45, 10, 14), heightMeters: 6 },
  ],
});

/** The scenario, made through the planner as Scenario Setup and Planning make it. */
function makeScenario(): BattleScenarioDefinition {
  const saved: BattleScenarioDefinition[] = [];
  const notices: string[] = [];
  const p = createPlanner({
    terrain,
    definition: newBattleScenario(terrain, 'reference', 'Reference 3v3'),
    stage: 'scenario',
    save: (d) => {
      saved.push(d);
      return Promise.resolve();
    },
    notify: (m) => notices.push(m),
  });
  const place = (side: 'BLUEFOR' | 'OPFOR', organization: 'squad' | 'fireTeam', at: Vec2) => {
    p.setTool({ kind: 'place', side, organization });
    p.click(at);
  };
  const order = (squadId: string, kind: OrderKind, at: Vec2) => {
    const plan = p.squad(squadId)?.plan.length ?? 0;
    p.select(squadId, plan > 0 ? plan - 1 : null);
    p.setTool({ kind: 'order', order: kind });
    p.click(at);
  };
  // Scenario Setup: three OPFOR squads round the hamlet, three BLUEFOR squads to the south.
  place('OPFOR', 'squad', { x: -150, y: 350 });
  place('OPFOR', 'fireTeam', { x: 0, y: 150 });
  place('OPFOR', 'squad', { x: 200, y: 400 });
  place('BLUEFOR', 'squad', { x: -250, y: -500 });
  place('BLUEFOR', 'squad', { x: 0, y: -550 });
  place('BLUEFOR', 'fireTeam', { x: 250, y: -500 });
  expect(p.rules.next('scenario')).toBeNull();
  // Planning. OPFOR: O1 occupies the hamlet's west; O3 moves down the east, then withdraws.
  p.setStage('bluefor');
  order('O1', 'move', { x: -100, y: 60 });
  order('O3', 'move', { x: 200, y: 0 });
  order('O3', 'withdraw', { x: 300, y: 500 });
  // BLUEFOR: B1 attacks the hamlet; B2 moves up, then attacks; B3 holds.
  order('B1', 'attack', { x: -60, y: 70 });
  order('B2', 'move', { x: 0, y: -250 });
  order('B2', 'attack', { x: 20, y: 60 });
  expect(p.rules.next('bluefor')).toBeNull();
  expect(notices).toEqual([]);
  // What was saved is what the planner holds, and reads back.
  const last = saved.at(-1);
  if (!last) throw new Error('nothing saved');
  expect(parseBattleScenario(JSON.parse(JSON.stringify(last)))).toEqual(p.definition);
  return p.definition;
}

// Each test re-simulates 15 minutes of battle: seconds alone, longer in the full suite.
describe('the reference battle, 3 v 3', { timeout: 60_000 }, () => {
  const definition = makeScenario();
  const notices: string[] = [];
  const combat = createCombat({
    terrain,
    definition,
    notify: (m) => notices.push(m),
    stepBudgetMs: Infinity,
  });
  const until = (seconds: number) => {
    while (combat.session.seconds < seconds) combat.frame(0.25);
  };
  combat.setSpeed(32);
  combat.play();
  until(60);
  // OPFOR: O2 replaced: it pushes south-east.
  combat.order('O2', 'move', { x: 120, y: -100 }, 'replace');
  until(120);
  // Paused: B3 is sent up the east, then told to attack after it.
  combat.pause();
  combat.order('B3', 'move', { x: 250, y: -200 }, 'replace');
  combat.order('B3', 'attack', { x: 150, y: 0 }, 'append');
  // B1's attack is replaced: it goes round by the west first.
  combat.order('B1', 'move', { x: -250, y: -150 }, 'replace');
  combat.play();
  until(400);
  // O3 holds where it is (its plan cleared).
  combat.hold('O3');
  until(900);
  combat.end();
  let recording: BattleRecording;
  beforeAll(async () => {
    recording = await combat.recording();
  });
  const summary = combat.summary();

  it('is fought: squads meet, fire is exchanged, soldiers fall, orders run their course', () => {
    const events = combat.session.events.map((e) => e.event);
    expect(events.some((e) => e.type === 'forcePhaseChanged' && e.to === 'engaged')).toBe(true);
    expect(events.filter((e) => e.type === 'fofFire').length).toBeGreaterThan(50);
    expect(summary.sides.reduce((n, s) => n + s.casualties, 0)).toBeGreaterThan(0);
    // Replaced, cleared (held), failed (a squad spent or combat ineffective), still under way.
    const statuses = new Set(combat.squads().flatMap((s) => s.orders.map((x) => x.status)));
    for (const status of ['superseded', 'canceled', 'failed', 'active'] as const)
      expect(statuses).toContain(status);
    // A combat-ineffective squad has no order left to carry out.
    for (const s of combat.squads().filter((q) => q.phase === 'ineffective'))
      expect(s.orders.filter((x) => x.status === 'active' || x.status === 'pending')).toEqual([]);
    expect(recording.origins.filter((x) => x === 'user')).toHaveLength(5);
    expect(notices.filter((n) => n.startsWith('Order refused'))).toEqual([]);
  });

  it('never ends by itself', () => {
    expect(recording.endTick).toBe(900 * 30);
    expect(combat.session.events.some((e) => e.event.type === 'fofEnded')).toBe(false);
  });

  it('is replayed from tick 0 and every second verified, from the recording as exported', () => {
    const exported = JSON.parse(JSON.stringify(recording)) as BattleRecording;
    const review = createReview({ terrain, recording: exported, budgetMs: Infinity });
    expect(review.verification).toEqual({
      checked: 901,
      mismatches: 0,
      firstMismatch: null,
      complete: true,
    });
    expect(review.summary()).toEqual(summary);
  });

  it('can be inspected at any moment: the state, the squads and the key moments then', () => {
    const review = createReview({ terrain, recording, budgetMs: Infinity });
    const markers = review.markers();
    expect(markers.filter((m) => m.kind === 'order')).toHaveLength(5);
    const contact = markers.find((m) => m.kind === 'contact');
    expect(contact).toBeDefined();
    for (const s of [0, 61, 121, 401, Math.ceil(contact?.seconds ?? 0), 899]) {
      review.seek(s);
      expect(hashSimState(review.view.sim.state)).toBe(recording.hashes[s]);
    }
    review.seek(130);
    const b3 = review.squad('B3');
    expect(b3?.orders.map((x) => [x.kind, x.source])).toEqual([
      ['move', 'player'],
      ['attack', 'player'],
    ]);
    review.seek(899);
    expect(review.squad('O3')?.orders.at(-1)?.status).toBe('canceled');
  });
});
