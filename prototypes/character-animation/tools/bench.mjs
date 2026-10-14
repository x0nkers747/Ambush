// Benchmark runner: drives the prototype page in a real (headed) Chrome with
// vsync off, runs every benchmark configuration, and writes
// results/bench-<date>.json and a markdown summary.
//
// Usage (dev server running: `npm run dev`):
//   PLAYWRIGHT=<path to playwright/index.mjs> node tools/bench.mjs [--quick] [--vsync] [--only plane|terrain|ik] [--group plane/animouse]
// Playwright is not a dependency (like the repository's tools/*.mjs).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const quick = argv.includes('--quick');
const vsync = argv.includes('--vsync');
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const group = argv.includes('--group') ? argv[argv.indexOf('--group') + 1] : null;
const url = process.env.BENCH_URL ?? 'http://localhost:5199/';
const pw = process.env.PLAYWRIGHT;
const { chromium } = await import(pw ? pathToFileURL(pw).href : 'playwright');

const NS = quick ? [1, 25, 100] : [1, 10, 25, 50, 100, 250];
const MEASURE = quick ? 2000 : 4000;
const GROUPS = [
  // Minimal scene: soldiers only (no weapons), shadows on.
  ...['native', 'native-lod', 'native-shared', 'animouse', 'instanced', 'instanced-shared'].map(
    (mode) => ({
      key: `plane/${mode}`,
      kind: 'plane',
      configs: NS.map((n) => ({ n, mode, scene: 'plane', shadows: true, weapons: false })),
    }),
  ),
  // Ambush!-representative: uneven ground, 2,400 of the game's trees, shadows;
  // rifles, hand IK, spine aim and foot IK where the mode allows them.
  ...['native', 'native-lod', 'native-shared', 'instanced'].map((mode) => ({
    key: `terrain/${mode}`,
    kind: 'terrain',
    configs: NS.map((n) => ({
      n,
      mode,
      scene: 'terrain',
      shadows: true,
      weapons: mode === 'native' || mode === 'native-lod',
    })),
  })),
  // The cost of the shared post-processing (weapon hold, IK, aim) alone.
  {
    key: 'ik/native',
    kind: 'ik',
    configs: [25, 100].flatMap((n) => [
      { n, mode: 'native', scene: 'plane', shadows: true, weapons: false },
      { n, mode: 'native', scene: 'plane', shadows: true, weapons: true },
    ]),
  },
].filter((g) => (!only || g.kind === only) && (!group || g.key === group));

const args = [
  '--ignore-gpu-blocklist',
  '--enable-gpu',
  '--use-angle=d3d11',
  '--enable-precise-memory-info',
  '--window-size=1640,1000',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=CalculateNativeWinOcclusion',
];
if (!vsync) args.push('--disable-gpu-vsync', '--disable-frame-rate-limit');
const browser = await chromium.launch({ channel: 'chrome', headless: false, args });
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const out = {
  startedAt: new Date().toISOString(),
  browser: browser.version(),
  vsync,
  viewport: '1600x900 (canvas about 1000x860), devicePixelRatio 1',
  gpu: null,
  runs: [],
};
const f = (x) => (x == null ? '-' : x.toFixed(2));
for (const g of GROUPS) {
  await page.goto(url);
  await page.waitForFunction(() => window.protoReady === true, null, { timeout: 300000 });
  out.gpu ??= await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null;
  });
  // Unrecorded warm-up in the group's scene (shader compilation, texture uploads).
  const first = g.configs[0];
  await page.evaluate((cfg) => window.proto.bench(cfg), {
    ...first,
    n: 10,
    warmupMs: 500,
    measureMs: 1000,
  });
  for (const c of g.configs) {
    const r = await page.evaluate((cfg) => window.proto.bench(cfg), {
      ...c,
      warmupMs: 1500,
      measureMs: MEASURE,
    });
    r.group = g.key;
    out.runs.push(r);
    console.log(
      `${g.key.padEnd(24)} n=${String(c.n).padStart(3)}${c.weapons ? ' +rifle/IK' : '          '} frame ${f(r.frame.mean)}/${f(r.frame.p95)} anim ${f(r.anim.mean)} render ${f(r.render.mean)} gpu ${f(r.gpu?.mean)} calls ${r.calls} tris ${r.triangles}`,
    );
  }
}
await browser.close();

const dir = join(import.meta.dirname, '..', 'results');
mkdirSync(dir, { recursive: true });
const stamp = out.startedAt.slice(0, 16).replace(/[:T]/g, '-');
writeFileSync(join(dir, `bench-${stamp}.json`), `${JSON.stringify(out, null, 1)}\n`);

// Markdown summary: one table per group.
const lines = [
  `Chrome ${out.browser}, ${out.gpu ?? 'unknown GPU'}, ${out.viewport}, vsync ${vsync ? 'on' : 'off'}.`,
  '',
];
for (const g of GROUPS) {
  lines.push(
    `**${g.key}**`,
    '',
    '| Soldiers | IK | Frame ms (mean / p95) | Animation CPU ms | Render CPU ms | GPU ms | Draw calls | Triangles |',
    '| ---: | :-: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const r of out.runs.filter((x) => x.group === g.key)) {
    lines.push(
      `| ${r.config.n} | ${r.config.weapons ? 'yes' : 'no'} | ${f(r.frame.mean)} / ${f(r.frame.p95)} | ${f(r.anim.mean)} | ${f(r.render.mean)} | ${f(r.gpu?.mean)} | ${r.calls} | ${(r.triangles / 1000).toFixed(0)}k |`,
    );
  }
  lines.push('');
}
writeFileSync(join(dir, `bench-${stamp}.md`), lines.join('\n'));
console.log('wrote', join(dir, `bench-${stamp}.json`));
