import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Regression tests for the Phase 0 layer boundaries (docs/adr/0001): the lint
// rules still fire, and the simulation sources import nothing outside `src/sim`.

const ROOT = join(import.meta.dirname, '..');
const eslint = new ESLint({ cwd: ROOT });

/**
 * Lints `code` in place of the existing file at `filePath` (typed linting only
 * accepts files in a project); returns the rule ids that fired. Nothing is written.
 */
async function ruleIds(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, filePath) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

describe('lint-enforced layer boundaries', { timeout: 60_000 }, () => {
  it.each([
    [
      'src/sim',
      `import { createFixedStepRunner } from '#exercise';\nexport const r = createFixedStepRunner;`,
    ],
    ['src/sim', `import * as THREE from 'three';\nexport const t = THREE;`],
    [
      'src/sim',
      `import { createFixedStepRunner } from '../exercise/runner';\nexport const r = createFixedStepRunner;`,
    ],
    ['src/exercise', `export * from '#view2d';`],
    ['src/view2d', `export * from '#view3d';`],
    ['src/view2d', `import * as THREE from 'three';\nexport const t = THREE;`],
    ['src/view3d', `export * from '#view2d';`],
  ])('forbids this import in %s: %s', async (layer, code) => {
    expect(await ruleIds(`${layer}/index.ts`, code)).toContain('no-restricted-imports');
  });

  it.each(['src/sim', 'src/exercise'])('bans nondeterminism in %s', async (layer) => {
    const ids = await ruleIds(
      `${layer}/index.ts`,
      'export const a = Math.random();\nexport const b = Date.now();\nexport const c = performance.now();\n',
    );
    expect(ids.filter((id) => id === 'no-restricted-properties')).toHaveLength(1);
    expect(ids.filter((id) => id === 'no-restricted-globals')).toHaveLength(2);
  });

  it('allows Three.js in the 3D view', async () => {
    expect(await ruleIds('src/view3d/index.ts', `export * from 'three';`)).not.toContain(
      'no-restricted-imports',
    );
  });
});

describe('simulation sources', () => {
  const simDir = join(ROOT, 'src', 'sim');
  const sources = readdirSync(simDir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({
      file: relative(ROOT, join(simDir, f)),
      text: readFileSync(join(simDir, f), 'utf8'),
    }));

  it('import only other simulation modules', () => {
    const IMPORT =
      /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g;
    const external = sources.flatMap(({ file, text }) =>
      [...text.matchAll(IMPORT)]
        .map((m) => m[1] ?? m[2] ?? '')
        // Relative imports of modules inside src/sim (subfolders such as terrain-lab included).
        .filter(
          (specifier) =>
            !(
              /^(\.\.?\/)+[\w-]+(\/[\w-]+)*$/.test(specifier) &&
              !relative(simDir, resolve(dirname(join(ROOT, file)), specifier)).startsWith('..')
            ),
        )
        .map((specifier) => `${file}: ${specifier}`),
    );
    expect(sources.length).toBeGreaterThan(5);
    expect(external).toEqual([]);
  });

  it('do not reference host globals the compiler would also reject', () => {
    const HOST =
      /\b(?:window|document|globalThis|process|require|structuredClone|TextEncoder|Buffer)\b/;
    const offenders = sources
      .filter(({ text }) => HOST.test(text.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '')))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
