// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/**
 * Layer boundary rules (docs/adr/0001). `tsc -b` already rejects DOM/Node
 * globals in the headless layers and imports of unreferenced layers; these
 * rules add what the compiler cannot see.
 */
const LAYERS = ['sim', 'exercise', 'geo', 'acquire', 'view2d', 'view3d', 'app'];

/** Relative imports that reach into another layer's folder instead of its `#alias`. */
const CROSS_LAYER_RELATIVE_IMPORT = {
  regex: `^(\\.\\./)+(src/)?(${LAYERS.join('|')})(/|$)`,
  message: 'Import other layers only through their public alias (#sim, #exercise, …).',
};

/**
 * @param {object} rules
 * @param {string[]} rules.forbiddenLayers layers this layer must not import
 * @param {boolean} rules.allowThree whether `three` may be imported
 * @returns {import('eslint').Linter.RuleEntry}
 */
function importRestrictions({ forbiddenLayers, allowThree }) {
  return [
    'error',
    {
      paths: forbiddenLayers.map((layer) => ({
        name: `#${layer}`,
        message: `This layer must not depend on #${layer} (docs/adr/0001).`,
      })),
      patterns: [
        CROSS_LAYER_RELATIVE_IMPORT,
        ...(allowThree
          ? []
          : [{ regex: '^three(/|$)', message: 'Only the 3D view may import Three.js.' }]),
      ],
    },
  ];
}

/** Sources of nondeterminism and host coupling banned in headless layers (docs/adr/0003, 0004). */
const DETERMINISM_GLOBALS = [
  'window',
  'document',
  'self',
  'process',
  'Date',
  'performance',
  'crypto',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'requestAnimationFrame',
  'cancelAnimationFrame',
].map((name) => ({
  name,
  message: 'Headless layers must not read clocks, timers, randomness or host globals.',
}));

export default defineConfig(
  // tools/*.mjs: asset preparation scripts run outside the game (with Playwright, not a dependency).
  // Prototypes are linted with the same rules through their own tsconfig; their
  // downloaded assets, builds and Node scripts are not.
  {
    ignores: [
      'dist/',
      '.tsbuild/',
      'node_modules/',
      'tools/*.mjs',
      'prototypes/*/dist/',
      'prototypes/*/public/',
      'prototypes/*/tools/*.mjs',
    ],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  {
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': importRestrictions({
        forbiddenLayers: ['exercise', 'geo', 'acquire', 'view2d', 'view3d', 'app'],
        allowThree: false,
      }),
    },
  },
  {
    files: ['src/exercise/**/*.ts'],
    rules: {
      'no-restricted-imports': importRestrictions({
        forbiddenLayers: ['geo', 'acquire', 'view2d', 'view3d', 'app'],
        allowThree: false,
      }),
    },
  },
  {
    files: ['src/geo/**/*.ts'],
    rules: {
      'no-restricted-imports': importRestrictions({
        forbiddenLayers: ['exercise', 'acquire', 'view2d', 'view3d', 'app'],
        allowThree: false,
      }),
    },
  },
  {
    files: ['src/acquire/**/*.ts'],
    rules: {
      'no-restricted-imports': importRestrictions({
        forbiddenLayers: ['exercise', 'view2d', 'view3d', 'app'],
        allowThree: false,
      }),
    },
  },
  {
    files: ['src/view2d/**/*.ts'],
    rules: {
      'no-restricted-imports': importRestrictions({
        forbiddenLayers: ['geo', 'acquire', 'view3d', 'app'],
        allowThree: false,
      }),
    },
  },
  {
    files: ['src/view3d/**/*.ts'],
    rules: {
      'no-restricted-imports': importRestrictions({
        forbiddenLayers: ['acquire', 'view2d', 'app'],
        allowThree: true,
      }),
    },
  },
  {
    files: ['src/app/**/*.ts'],
    rules: {
      'no-restricted-imports': importRestrictions({ forbiddenLayers: [], allowThree: true }),
    },
  },
  {
    files: ['tools/**/*.ts'],
    rules: {
      'no-restricted-imports': importRestrictions({
        forbiddenLayers: ['acquire', 'view2d', 'view3d', 'app'],
        allowThree: false,
      }),
    },
  },

  {
    files: ['src/sim/**/*.ts', 'src/exercise/**/*.ts', 'src/geo/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...DETERMINISM_GLOBALS],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use the seeded simulation PRNG (src/sim/rng.ts), never Math.random.',
        },
      ],
    },
  },
);
