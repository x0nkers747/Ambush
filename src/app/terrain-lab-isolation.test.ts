import { describe, expect, it } from 'vitest';

// The terrain lab (docs/ground-level-terrain-architecture-research.md, stage 2)
// is an isolated prototype: no game module may import it. Only the
// composition root loads it, lazily, for its own address.

const sources = import.meta.glob<string>(['/src/**/*.ts', '!/src/**/terrain-lab/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('terrain lab isolation', () => {
  it('is imported by nothing in the game but the composition root, and only lazily', () => {
    const users = Object.entries(sources)
      .filter(
        ([path, text]) =>
          !path.endsWith('terrain-lab-isolation.test.ts') && text.includes('terrain-lab'),
      )
      .map(([path]) => path);
    expect(users).toEqual(['/src/app/main.ts']);
    const main = sources['/src/app/main.ts'] ?? '';
    expect(main).toMatch(/await import\('#view3d\/terrain-lab'\)/);
    expect(main).not.toMatch(/^import[^;]*terrain-lab/m);
  });
});
