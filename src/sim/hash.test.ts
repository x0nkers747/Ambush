import { describe, expect, it } from 'vitest';
import { fnv1a64, hashSimState } from './hash';
import { createInitialState } from './scenario';
import { TEST_SCENARIO } from './test-scenario';

describe('fnv1a64', () => {
  it('matches the published FNV-1a 64-bit test vectors', () => {
    const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
    expect(fnv1a64([])).toBe('cbf29ce484222325');
    expect(fnv1a64(ascii('a'))).toBe('af63dc4c8601ec8c');
    expect(fnv1a64(ascii('foobar'))).toBe('85944171f73967e8');
  });
});

describe('hashSimState', () => {
  it('ignores the order in which state properties were created', () => {
    const state = createInitialState(TEST_SCENARIO, 3);
    const [first, ...rest] = state.soldiers;
    if (!first) throw new Error('test scenario has no soldiers');
    const { orders, status, posture, azimuth, position, unitId, side, id } = first;
    const reordered = { orders, status, posture, azimuth, position, unitId, side, id };
    expect(hashSimState({ ...state, soldiers: [reordered, ...rest] })).toBe(hashSimState(state));
  });

  it('changes when any value changes', () => {
    const state = createInitialState(TEST_SCENARIO, 3);
    const hash = hashSimState(state);
    const last = state.soldiers.at(-1);
    if (!last) throw new Error('test scenario has no soldiers');
    last.position.z = 1e-9;
    expect(hashSimState(state)).not.toBe(hash);
  });
});
