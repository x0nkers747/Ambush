import { describe, expect, it } from 'vitest';

// The Behavior Lab (docs/behavior-lab/04) is isolated from the game: no game
// module imports its page or its headless side. Only the composition root
// loads the page, lazily, at its own address (#behavior-lab).

const sources = import.meta.glob<string>(
  ['/src/**/*.ts', '!/src/**/behavior-lab/**', '!/src/**/*.test.ts'],
  { query: '?raw', import: 'default', eager: true },
);

describe('behavior lab isolation', () => {
  it('is imported by nothing in the game but the composition root, and only lazily', () => {
    const users = Object.entries(sources)
      .filter(([, text]) => /['"]#(view3d|exercise)\/behavior-lab['"]/.test(text))
      .map(([path]) => path);
    expect(users).toEqual(['/src/app/main.ts']);
    const main = sources['/src/app/main.ts'] ?? '';
    expect(main).toMatch(/import\('#view3d\/behavior-lab'\)/);
    expect(main).not.toMatch(/^import[^;]*behavior-lab/m);
  });
});
