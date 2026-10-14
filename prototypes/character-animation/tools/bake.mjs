// Bakes the approved soldier for the game (src/bake.ts): with the dev server
// running (`npm run dev`), `npm run bake` writes the Rocketbox soldier's clips
// and skeleton to the game's public/characters/rocketbox/clips.json and copies
// the model, its textures and the weapon models next to it.
//
//   PLAYWRIGHT=<path to playwright/index.mjs> node tools/bake.mjs

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const pw = process.env.PLAYWRIGHT;
const { chromium } = await import(pw ? pathToFileURL(pw).href : 'playwright');

const HERE = join(import.meta.dirname, '..');
const ASSETS = join(HERE, 'public', 'assets');
const OUT = join(HERE, '..', '..', 'public', 'characters');

const browser = await chromium.launch({ channel: 'chrome', headless: false });
const page = await browser.newPage();
await page.goto('http://localhost:5199/?runtime=native&paused=1');
await page.waitForFunction(() => !document.getElementById('loading'), null, { timeout: 180000 });
const baked = await page.evaluate(() => window.proto.bake());
await browser.close();

mkdirSync(join(OUT, 'rocketbox'), { recursive: true });
mkdirSync(join(OUT, 'weapons'), { recursive: true });
writeFileSync(join(OUT, 'rocketbox', 'clips.json'), JSON.stringify(baked));
const rocketbox = [
  'Military_Male_01.fbx',
  'LICENSE.md',
  ...['body', 'head', 'helmet', 'equipment'].flatMap((part) => [
    `sm002_${part}_${part === 'head' ? 'color' : 'color_acu'}.jpg`,
    `sm002_${part}_normal.jpg`,
  ]),
];
for (const f of rocketbox) copyFileSync(join(ASSETS, 'rocketbox', f), join(OUT, 'rocketbox', f));
copyFileSync(join(ASSETS, 'weapons', 'rifle-west.glb'), join(OUT, 'weapons', 'rifle-west.glb'));
copyFileSync(join(ASSETS, 'm2m', 'AK.glb'), join(OUT, 'weapons', 'ak.glb'));
console.log(
  `baked ${String(Object.keys(baked.clips).length)} clips, ${String(baked.skeleton.length)} bones`,
);
