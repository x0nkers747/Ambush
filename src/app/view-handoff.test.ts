import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handOffView, takeView } from './view-handoff';

// The map view handed between terrain selection and the workspace (docs/adr/0025).

const view = { centre: { x: 120.5, y: -40 }, metersPerPixel: 0.8 };

describe('the map view hand-off', () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => stored.set(k, v),
        removeItem: (k: string) => stored.delete(k),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('gives the view to the next page showing the same battlefield, once', () => {
    handOffView('bf-1', view);
    expect(takeView('bf-1')).toEqual(view);
    expect(takeView('bf-1')).toBeNull();
  });

  it('gives nothing to another battlefield, and uses the view up', () => {
    handOffView('bf-1', view);
    expect(takeView('demo')).toBeNull();
    expect(takeView('bf-1')).toBeNull();
  });

  it('clears an earlier view when there is none to hand off', () => {
    handOffView('bf-1', view);
    handOffView('bf-1', null);
    expect(takeView('bf-1')).toBeNull();
  });

  it('ignores anything that is not a view', () => {
    for (const text of [
      'not json',
      'null',
      '{"battlefieldId":"bf-1","centre":null,"metersPerPixel":1}',
      '{"battlefieldId":"bf-1","centre":{"x":1,"y":"2"},"metersPerPixel":1}',
      '{"battlefieldId":"bf-1","centre":{"x":1,"y":2},"metersPerPixel":0}',
    ]) {
      stored.set('ambush.mapView', text);
      expect(takeView('bf-1')).toBeNull();
    }
  });

  it('works without storage: nothing is handed off', () => {
    vi.stubGlobal('window', {
      get sessionStorage(): Storage {
        throw new Error('blocked');
      },
    });
    handOffView('bf-1', view);
    expect(takeView('bf-1')).toBeNull();
  });
});
