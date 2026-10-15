import { describe, expect, it } from 'vitest';

// The Force-on-Force Lab (docs/behavior-lab/force-on-force) is isolated from
// the game: no game module imports its page or its headless side. Only the
// composition root loads the page, lazily, at its own address (#force-on-force).

const sources = import.meta.glob<string>(
  ['/src/**/*.ts', '!/src/**/force-on-force/**', '!/src/**/*.test.ts'],
  { query: '?raw', import: 'default', eager: true },
);

describe('force-on-force lab isolation', () => {
  it('is imported by nothing in the game but the composition root, and only lazily', () => {
    const users = Object.entries(sources)
      .filter(([, text]) => /(?:from\s+|import\()['"][^'"]*force-on-force['"/]/.test(text))
      .map(([path]) => path);
    expect(users).toEqual(['/src/app/main.ts']);
    const main = sources['/src/app/main.ts'] ?? '';
    expect(main).toMatch(/import\('#view3d\/force-on-force'\)/);
    expect(main).not.toMatch(/^import[^;]*force-on-force/m);
  });
});
