import { describe, expect, it } from 'vitest';
import { createExercise, DEMO_SCENARIO } from '#exercise';
import { createSession, selectSoldier } from '#session';
import { soldierId } from '#sim';
import { buildScene, deploymentGeometry, symbolLayout } from './scene';

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
  it('map each Marine’s soldier id to its slot label and template symbol code', () => {
    const { exercise, session } = setup();
    const scene = buildScene(exercise, session, FITTED, viewport);
    expect(scene.markings.size).toBe(13);
    expect(scene.markings.get(soldierId('M01'))).toEqual({
      sidc: '10032700001101010000',
      label: 'SL',
    });
    expect(scene.markings.get(soldierId('M03'))?.label).toBe('1-AR');
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
    expect(layout.size).toBe(13);
    expect(layout.get(soldierId('M07'))).toMatchObject({ mode: 'full', showLabel: true });
    expect([...layout.values()].filter((p) => p.mode === 'full').length).toBeLessThan(13);
    // Every compact Marine is either visible or counted on the symbol that hides it.
    const full = [...layout.values()].filter((p) => p.mode === 'full');
    const compact = 13 - full.length;
    const counted = full.reduce((n, p) => n + p.covered, 0);
    expect(counted).toBeLessThanOrEqual(compact);
    expect(layout.get(soldierId('M07'))?.covered).toBeGreaterThan(0);
    for (const soldier of scene.soldiers.filter((s) => s.side === 'BLUEFOR')) {
      const at = layout.get(soldier.id)?.at;
      expect(at?.x).toBeCloseTo(600 + soldier.position.x / FITTED.metersPerPixel, 9);
      expect(at?.y).toBeCloseTo(450 - soldier.position.y / FITTED.metersPerPixel, 9);
    }
  });

  it('are all full, each with its label, when zoomed in on the ORP', () => {
    const { exercise, session } = setup();
    const layout = symbolLayout(buildScene(exercise, session, CLOSE, viewport));
    expect([...layout.values()].every((p) => p.mode === 'full')).toBe(true);
    expect([...layout.values()].every((p) => p.covered === 0)).toBe(true);
    expect([...layout.values()].filter((p) => p.showLabel).length).toBe(13);
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
