import { describe, expect, it } from 'vitest';
import { generationFraction } from './generate';

// A generation's progress as one fraction, for the progress bars
// (docs/loading-overlay.md): through its steps in order, and within a step by
// its parts.

describe('generationFraction', () => {
  it('rises through the steps and their parts, from 0 to 1', () => {
    const at = [
      generationFraction({ step: 'elevation', message: '', done: 0, total: 10 }),
      generationFraction({ step: 'elevation', message: '', done: 5, total: 10 }),
      generationFraction({ step: 'buildings', message: '' }),
      generationFraction({ step: 'osm', message: '' }),
      generationFraction({ step: 'trees', message: '', done: 3, total: 4 }),
      generationFraction({ step: 'processing', message: '' }),
      generationFraction({ step: 'saving', message: '', done: 1, total: 1 }),
    ];
    expect(at[0]).toBe(0);
    for (let i = 1; i < at.length; i += 1) expect(at[i]).toBeGreaterThan(at[i - 1] ?? 0);
    expect(at[at.length - 1]).toBeCloseTo(1);
  });
});
