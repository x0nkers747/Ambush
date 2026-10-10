import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO } from '#exercise';
import { createSession, selectSoldier } from '#session';
import { soldierId } from '#sim';
import {
  buildScene,
  deploymentGeometry,
  SHOT_DISPLAY_SECONDS,
  SOLDIER_ICON_PX,
  symbolLayout,
} from './scene';
import { FACING_REACH } from './soldier-icons';

// The scene for the demo squad: symbols, labels and the selected Marine's plan.

const viewport = { width: 1200, height: 900 };
/** About the fitted zoom of the demo map in a typical window. */
const FITTED = { centerX: 0, centerY: 0, metersPerPixel: 0.75 };
/** Zoomed in on the ORP. */
const CLOSE = { centerX: -60, centerY: -236, metersPerPixel: 0.05 };

function setup() {
  const exercise = createExercise({ config: { tickRateHz: 30, seed: 0 }, scenario: DEMO_SCENARIO });
  return { exercise, session: createSession() };
}

describe('soldier markings', () => {
  it('map each Marine’s soldier id to its slot label and template role icon', () => {
    const { exercise, session } = setup();
    const scene = buildScene(exercise, session, FITTED, viewport);
    expect(scene.markings.size).toBe(13);
    expect(scene.markings.get(soldierId('M01'))).toEqual({ icon: 'squadLeader', label: 'SL' });
    expect(scene.markings.get(soldierId('M02'))).toEqual({
      icon: 'fireTeamLeader',
      label: '1-FTL',
    });
    expect(scene.markings.get(soldierId('M03'))).toEqual({
      icon: 'automaticRifleman',
      label: '1-AR',
    });
    expect(scene.markings.get(soldierId('M04'))).toEqual({ icon: 'rifleman', label: '1-AAR' });
    expect(scene.markings.get(soldierId('M13'))?.label).toBe('3-R');
    expect(scene.markings.has(soldierId('EN-1'))).toBe(false); // OPFOR is not in the organization
    // The mapping follows soldier ids, not the order soldiers are listed in.
    const labels = new Map([...scene.markings].map(([id, m]) => [id, m.label]));
    const again = buildScene(exercise, session, CLOSE, viewport);
    expect(new Map([...again.markings].map(([id, m]) => [id, m.label]))).toEqual(labels);
  });
});

describe('symbols in the ORP', () => {
  it('declutter at the fitted zoom without moving anyone, keeping the selected Marine in full', () => {
    const { exercise, session } = setup();
    const selected = selectSoldier(session, exercise, soldierId('M07'));
    const scene = buildScene(exercise, selected, FITTED, viewport);
    const layout = symbolLayout(scene);
    expect(layout.size).toBe(16); // 13 Marines and 3 OPFOR
    expect(layout.get(soldierId('M07'))).toMatchObject({ mode: 'full', showLabel: true });
    expect([...layout.values()].filter((p) => p.mode === 'full').length).toBeLessThan(13);
    // Every compact soldier is either visible or counted on the symbol that hides it.
    const marines = [...layout.entries()].filter(([id]) => scene.markings.has(id));
    const full = marines.filter(([, p]) => p.mode === 'full').map(([, p]) => p);
    const compact = 13 - full.length;
    const counted = full.reduce((n, p) => n + p.covered, 0);
    expect(counted).toBeLessThanOrEqual(compact);
    // No Marine is hidden without being counted on the symbol above it.
    const hiddenIds = new Set(full.flatMap((p) => p.hidden.map((h) => h.id)));
    for (const [id, p] of marines) {
      if (p.mode === 'compact' && !hiddenIds.has(id)) {
        // Visible: not inside any full symbol's box.
        for (const f of full) {
          expect(Math.abs(p.at.x - f.at.x) > 12 || Math.abs(p.at.y - f.at.y) > 12).toBe(true);
        }
      }
    }
    expect(layout.get(soldierId('M07'))?.covered).toBeGreaterThan(0);
    for (const soldier of scene.soldiers.filter((s) => s.side === 'BLUEFOR')) {
      const at = layout.get(soldier.id)?.at;
      expect(at?.x).toBeCloseTo(600 + soldier.position.x / FITTED.metersPerPixel, 9);
      expect(at?.y).toBeCloseTo(450 - soldier.position.y / FITTED.metersPerPixel, 9);
    }
  });

  it('are all full, each with its label, when zoomed in on the ORP', () => {
    const { exercise, session } = setup();
    const scene = buildScene(exercise, session, CLOSE, viewport);
    const layout = [...symbolLayout(scene)].filter(([id]) => scene.markings.has(id));
    expect(layout).toHaveLength(13);
    expect(layout.every(([, p]) => p.mode === 'full')).toBe(true);
    expect(layout.every(([, p]) => p.covered === 0)).toBe(true);
    expect(layout.filter(([, p]) => p.showLabel).length).toBe(13);
  });
});

describe('the selected Marine’s plan', () => {
  it('shows the default facing until one is chosen, then the chosen one', () => {
    const { exercise, session } = setup();
    const id = soldierId('M03');
    exercise.setDestination(id, { x: -60, y: -58 });
    const selected = selectSoldier(session, exercise, id);
    const geometry = () => deploymentGeometry(buildScene(exercise, selected, FITTED, viewport));
    expect(geometry()?.facing.explicit).toBe(false);
    expect(geometry()?.facingAnchor).toEqual(geometry()?.destination);
    exercise.setFacing(id, Math.PI / 2);
    const g = geometry();
    expect(g?.facing).toEqual({ azimuth: Math.PI / 2, explicit: true });
    // The handle sits east of the destination.
    expect((g?.facingTip.x ?? 0) - (g?.destination?.x ?? 0)).toBeCloseTo(42, 9);
    // One straight or bending line from the Marine to the destination: no intermediate handles.
    expect(g?.path[0]).toEqual(g?.soldier);
    expect(g?.path.at(-1)).toEqual(g?.destination);
  });

  it('has no path without a destination, and the facing handle at the Marine', () => {
    const { exercise, session } = setup();
    const selected = selectSoldier(session, exercise, soldierId('M01'));
    const g = deploymentGeometry(buildScene(exercise, selected, FITTED, viewport));
    expect(g?.destination).toBeNull();
    expect(g?.path).toEqual([]);
    expect(g?.facingAnchor).toEqual(g?.soldier);
  });
});

describe('the facing arrow of the selected Marine', () => {
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  /** Beyond the icon's circle and its facing triangle. */
  const clearOfIcon = FACING_REACH * SOLDIER_ICON_PX;

  it.each([0, 90, 180, 270])(
    'starts outside the icon when anchored on the Marine (no destination), facing %i°',
    (degrees) => {
      const { exercise, session } = setup();
      const id = soldierId('M03'); // automatic rifleman: two dashes, no third line
      exercise.setFacing(id, (degrees * Math.PI) / 180);
      const selected = selectSoldier(session, exercise, id);
      const g = deploymentGeometry(buildScene(exercise, selected, CLOSE, viewport));
      if (!g) throw new Error('no geometry');
      expect(g.facingAnchor).toEqual(g.soldier);
      expect(dist(g.facingShaftStart, g.soldier)).toBeGreaterThan(clearOfIcon);
      // Along the facing, and short of the handle, which has not moved.
      const along = (p: { x: number; y: number }) =>
        (p.x - g.soldier.x) * Math.sin(g.facing.azimuth) -
        (p.y - g.soldier.y) * Math.cos(g.facing.azimuth);
      expect(along(g.facingShaftStart)).toBeCloseTo(dist(g.facingShaftStart, g.soldier), 9);
      expect(dist(g.facingTip, g.soldier)).toBeCloseTo(42, 9);
      expect(dist(g.facingShaftStart, g.soldier)).toBeLessThan(42);
    },
  );

  it('starts outside the icon when the Marine stands on its destination', () => {
    const { exercise, session } = setup();
    const id = soldierId('M01');
    const here = exercise.simulation.state.soldiers.find((s) => s.id === id)?.position;
    if (!here) throw new Error('no M01');
    exercise.setDestination(id, { x: here.x, y: here.y });
    const selected = selectSoldier(session, exercise, id);
    const g = deploymentGeometry(buildScene(exercise, selected, CLOSE, viewport));
    if (!g?.destination) throw new Error('no destination');
    expect(dist(g.destination, g.soldier)).toBeLessThan(1e-6);
    expect(dist(g.facingShaftStart, g.soldier)).toBeGreaterThan(clearOfIcon);
  });

  it('starts at a destination away from the Marine', () => {
    const { exercise, session } = setup();
    const id = soldierId('M03');
    exercise.setDestination(id, { x: -60, y: -200 });
    const selected = selectSoldier(session, exercise, id);
    const g = deploymentGeometry(buildScene(exercise, selected, CLOSE, viewport));
    expect(g?.facingShaftStart).toEqual(g?.destination);
  });
});

describe('combat on the map (docs/adr/0019)', () => {
  it('shows nothing before the ambush, then recent shots and each soldier’s part', () => {
    const exercise = createExercise({
      config: { tickRateHz: 30, seed: 3 },
      scenario: DEMO_SCENARIO,
    });
    const camera = { centerX: 0, centerY: 0, metersPerPixel: 1 };
    const viewport = { width: 800, height: 600 };
    expect(buildScene(exercise, createSession(), camera, viewport).combat).toBeNull();
    for (const v of [
      { x: -40, y: -20 },
      { x: 40, y: -20 },
      { x: 40, y: 30 },
      { x: -40, y: 30 },
    ])
      exercise.addKillZoneVertex(v);
    exercise.execute();
    exercise.advance(1 / 30);
    exercise.startOpfor();
    let sawShots = false;
    for (let i = 0; i < 30 * 400 && exercise.phase !== 'engagementComplete'; i += 1) {
      // The trainee springs the ambush once the patrol leader is in the kill zone.
      if (exercise.triggerState === 'available' && (exercise.killZoneOccupancy()?.inside ?? 0) > 0)
        exercise.triggerAmbush();
      exercise.advance(1 / 30);
      const combat = buildScene(exercise, createSession(), camera, viewport).combat;
      if (exercise.phase === 'engagement' && combat) {
        for (const shot of combat.shots) {
          expect(shot.ageSeconds).toBeGreaterThanOrEqual(0);
          expect(shot.ageSeconds).toBeLessThan(SHOT_DISPLAY_SECONDS);
        }
        if (combat.shots.length > 0) sawShots = true;
      }
    }
    expect(sawShots).toBe(true);
    const combat = buildScene(exercise, createSession(), camera, viewport).combat;
    expect(combat?.ended).toBe(true);
    for (const s of exercise.simulation.state.soldiers) {
      const behavior = combat?.behaviors.get(s.id);
      if (s.status === 'incapacitated') expect(behavior).toBe('incapacitated');
    }
    // Incapacitated soldiers stay in the scene.
    expect(buildScene(exercise, createSession(), camera, viewport).soldiers).toHaveLength(16);
  });
});

describe('a squad that is not placed yet', () => {
  it('is left out of the scene, with its ORP; the OPFOR stays', () => {
    const { exercise, session } = setup();
    const shown = buildScene(exercise, session, FITTED, viewport);
    const hidden = buildScene(exercise, session, FITTED, viewport, null, true);
    expect(shown.orp).not.toBeNull();
    expect(hidden.orp).toBeNull();
    expect(hidden.soldiers.some((s) => s.side === 'BLUEFOR')).toBe(false);
    expect(hidden.soldiers).toHaveLength(shown.soldiers.filter((s) => s.side !== 'BLUEFOR').length);
    expect(hidden.plans).toEqual([]);
  });
});
