// Prepares the foliage textures (docs/adr/0051, src/view3d/textures/foliage/CREDITS.md)
// from ambientCG 2K-JPG downloads (each set unzipped into <dir>/<AssetId>/), in Chrome
// (for JPEG decoding). Playwright is not a dependency of the game: run it with one installed,
//   node tools/foliage-textures.mjs <ambientCG dir> src/view3d/textures/foliage
// then format the JSON: npx prettier --write src/view3d/textures/foliage/leaves.json
// Leaves: each set's leaves cut out by its opacity map, turned with the long axis along +x
// (stalk at x = 0), colour-matched to the species' colour, packed into one sprite sheet
// (leaves.png + leaves.json). Barks: colour and OpenGL normal maps at 512 px.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const [src, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

// Species cell → [ambientCG set, target colour (HSL of the current procedural look), max leaves].
const LEAVES = {
  oakWhite: ['LeafSet016', [95, 32, 40], 6],
  oakRed: ['LeafSet030', [98, 38, 35], 8],
  maple: ['LeafSet010', [92, 40, 41], 4],
  poplar: ['LeafSet029', [86, 44, 44], 8],
  sweetgum: ['LeafSet021', [100, 38, 37], 8],
  beech: ['LeafSet014', [84, 42, 45], 6],
  hickory: ['LeafSet020', [88, 38, 41], 6],
  laurel: ['LeafSet022', [105, 34, 31], 6],
  cedar: ['LeafSet019', [110, 30, 27], 3],
};
const BARKS = { rough: 'Bark001', smooth: 'Bark004', pine: 'Bark014' };
const SPRITE_LEN = 160;

const b64 = (f) => readFileSync(f).toString('base64');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));

const result = await page.evaluate(
  async ({ sets, barks, len }) => {
    const bitmap = async (data) =>
      createImageBitmap(await (await fetch(`data:image/jpeg;base64,${data}`)).blob());
    const pixels = (bmp, size) => {
      const c = new OffscreenCanvas(size, size);
      const x = c.getContext('2d');
      x.drawImage(bmp, 0, 0, size, size);
      return x.getImageData(0, 0, size, size).data;
    };
    const hslToRgb = (h, s, l) => {
      s /= 100;
      l /= 100;
      const k = (n) => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
      return [f(0) * 255, f(8) * 255, f(4) * 255];
    };
    const toB64 = async (canvas, type, quality) => {
      const blob = await canvas.convertToBlob({ type, quality });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    };

    const sprites = [];
    for (const [cell, set] of Object.entries(sets)) {
      const { color, opacity, target, max } = set;
      const N = 1024;
      const col = pixels(await bitmap(color), N);
      const op = pixels(await bitmap(opacity), N);
      // Connected components of the opaque pixels.
      const label = new Int32Array(N * N).fill(-1);
      const comps = [];
      for (let k = 0; k < N * N; k += 1) {
        if (label[k] >= 0 || op[k * 4] < 128) continue;
        const id = comps.length;
        const stack = [k];
        label[k] = id;
        const px = [];
        while (stack.length) {
          const p = stack.pop();
          px.push(p);
          const x = p % N;
          const y = (p - x) / N;
          for (const q of [
            x > 0 ? p - 1 : -1,
            x < N - 1 ? p + 1 : -1,
            y > 0 ? p - N : -1,
            y < N - 1 ? p + N : -1,
          ])
            if (q >= 0 && label[q] < 0 && op[q * 4] >= 128) {
              label[q] = id;
              stack.push(q);
            }
        }
        px.id = id;
        comps.push(px);
      }
      comps.sort((a, b) => b.length - a.length);
      // Each leaf's mean colour; leaves far from the set's typical chromaticity (blemished,
      // autumn-coloured, stained) are left out, and each is matched to the species' colour.
      const meanOf = (c) => {
        let r = 0,
          g = 0,
          bl = 0;
        for (const p of c) {
          r += col[p * 4];
          g += col[p * 4 + 1];
          bl += col[p * 4 + 2];
        }
        return [r / c.length, g / c.length, bl / c.length];
      };
      const chroma = ([r, g, bl]) => [r / (r + g + bl), g / (r + g + bl)];
      const candidates = comps.filter((c) => c.length > (comps[0]?.length ?? 0) * 0.25);
      const means = candidates.map(meanOf);
      const ch = means.map(chroma);
      const med = (k) => [...ch.map((v) => v[k])].sort((x, y) => x - y)[Math.floor(ch.length / 2)];
      const mc = [med(0), med(1)];
      const big = candidates
        .filter((c, i) => Math.hypot(ch[i][0] - mc[0], ch[i][1] - mc[1]) < 0.04)
        .slice(0, max);
      const [tr, tg, tb] = hslToRgb(...target);
      for (const c of big) {
        const m = meanOf(c);
        const gain = [tr / m[0], tg / m[1], tb / m[2]];
        let sx = 0,
          sy = 0;
        for (const p of c) {
          sx += p % N;
          sy += Math.floor(p / N);
        }
        const cx = sx / c.length,
          cy = sy / c.length;
        const inComp = (x, y) =>
          x >= 0 && y >= 0 && x < N && y < N && label[Math.round(y) * N + Math.round(x)] === c.id;
        // The stalk: of the farthest points from the centre, the one whose
        // neighbourhood a little inwards is thinnest (a stalk is a line, a lobe a wedge).
        const rad = Math.max(4, 0.07 * Math.sqrt(c.length));
        const far = c
          .map((p) => [p, Math.hypot((p % N) - cx, Math.floor(p / N) - cy)])
          .sort((p, q) => q[1] - p[1])
          .slice(0, Math.max(20, Math.floor(c.length * 0.01)));
        let stalk = null,
          thinnest = 1;
        for (const [p, d] of far) {
          const px = p % N,
            py = Math.floor(p / N);
          const ix = px + ((cx - px) / d) * rad * 2,
            iy = py + ((cy - py) / d) * rad * 2;
          let inside = 0,
            all = 0;
          for (let dy = -rad; dy <= rad; dy += 1)
            for (let dx = -rad; dx <= rad; dx += 1) {
              if (dx * dx + dy * dy > rad * rad) continue;
              all += 1;
              if (inComp(ix + dx, iy + dy)) inside += 1;
            }
          if (inside / all < thinnest) {
            thinnest = inside / all;
            stalk = [px, py];
          }
        }
        let ang;
        let flipHint = null;
        if (stalk && thinnest < 0.3) {
          // The axis runs from the stalk through the centre.
          ang = Math.atan2(cy - stalk[1], cx - stalk[0]);
          flipHint = false;
        } else {
          let xx = 0,
            yy = 0,
            xy = 0;
          for (const p of c) {
            const dx = (p % N) - cx,
              dy = Math.floor(p / N) - cy;
            xx += dx * dx;
            yy += dy * dy;
            xy += dx * dy;
          }
          ang = 0.5 * Math.atan2(2 * xy, xx - yy);
        }
        const ca = Math.cos(ang),
          sa = Math.sin(ang);
        let u0 = Infinity,
          u1 = -Infinity,
          v0 = Infinity,
          v1 = -Infinity;
        const uv = c.map((p) => {
          const dx = (p % N) - cx,
            dy = Math.floor(p / N) - cy;
          const u = dx * ca + dy * sa,
            v = -dx * sa + dy * ca;
          u0 = Math.min(u0, u);
          u1 = Math.max(u1, u);
          v0 = Math.min(v0, v);
          v1 = Math.max(v1, v);
          return [u, v];
        });
        const L = u1 - u0;
        const endWidth = (lo, hi) => {
          let a = Infinity,
            b = -Infinity;
          for (const [u, v] of uv)
            if (u >= lo && u <= hi) {
              a = Math.min(a, v);
              b = Math.max(b, v);
            }
          return b - a;
        };
        // Without a stalk found: the stalk end is the thinner one over its last eighth.
        const flip = flipHint ?? endWidth(u1 - L * 0.12, u1) < endWidth(u0, u0 + L * 0.12);
        const scale = len / L;
        const w = len;
        const h = Math.max(8, Math.ceil((v1 - v0) * scale) + 4);
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(w, h);
        // Inverse map each sprite pixel to the source (nearest neighbour on the 1024 copy; sprites are smaller).
        for (let y = 0; y < h; y += 1)
          for (let x = 0; x < w; x += 1) {
            let u = u0 + (x + 0.5) / scale;
            if (flip) u = u1 - (x + 0.5) / scale;
            const v = v0 + (y + 0.5 - 2) / scale;
            const sxp = Math.round(cx + u * ca - v * sa);
            const syp = Math.round(cy + u * sa + v * ca);
            if (sxp < 0 || syp < 0 || sxp >= N || syp >= N) continue;
            const p = syp * N + sxp;
            if (label[p] !== c.id) continue;
            const o = (y * w + x) * 4;
            img.data[o] = Math.min(255, col[p * 4] * gain[0]);
            img.data[o + 1] = Math.min(255, col[p * 4 + 1] * gain[1]);
            img.data[o + 2] = Math.min(255, col[p * 4 + 2] * gain[2]);
            img.data[o + 3] = op[p * 4];
          }
        ctx.putImageData(img, 0, 0);
        sprites.push({ cell, canvas, w, h });
      }
    }
    // Shelf packing into a sheet 1024 wide.
    const W = 1024;
    let x = 0,
      y = 0,
      row = 0;
    const placed = [];
    for (const s of sprites) {
      if (x + s.w > W) {
        x = 0;
        y += row;
        row = 0;
      }
      placed.push({ cell: s.cell, x, y, w: s.w, h: s.h, canvas: s.canvas });
      x += s.w;
      row = Math.max(row, s.h);
    }
    const H = Math.ceil((y + row) / 4) * 4;
    const sheet = new OffscreenCanvas(W, H);
    const sc = sheet.getContext('2d');
    for (const p of placed) sc.drawImage(p.canvas, p.x, p.y);
    const manifest = {};
    for (const p of placed) (manifest[p.cell] ??= []).push([p.x, p.y, p.w, p.h]);

    const barkOut = {};
    for (const [kind, { color, normal }] of Object.entries(barks)) {
      for (const [name, data, type] of [
        ['albedo', color, 'image/jpeg'],
        ['normal', normal, 'image/jpeg'],
      ]) {
        const c = new OffscreenCanvas(512, 512);
        c.getContext('2d').drawImage(await bitmap(data), 0, 0, 512, 512);
        barkOut[`bark-${kind}-${name}.jpg`] = await toB64(c, type, name === 'albedo' ? 0.88 : 0.92);
      }
    }
    return { sheet: await toB64(sheet, 'image/png'), manifest, size: [W, H], barkOut };
  },
  {
    sets: Object.fromEntries(
      Object.entries(LEAVES).map(([cell, [set, target, max]]) => [
        cell,
        {
          color: b64(`${src}/${set}/${set}_2K-JPG_Color.jpg`),
          opacity: b64(`${src}/${set}/${set}_2K-JPG_Opacity.jpg`),
          target,
          max,
        },
      ]),
    ),
    barks: Object.fromEntries(
      Object.entries(BARKS).map(([kind, set]) => [
        kind,
        {
          color: b64(`${src}/${set}/${set}_2K-JPG_Color.jpg`),
          normal: b64(`${src}/${set}/${set}_2K-JPG_NormalGL.jpg`),
        },
      ]),
    ),
    len: SPRITE_LEN,
  },
);
writeFileSync(`${out}/leaves.png`, Buffer.from(result.sheet, 'base64'));
writeFileSync(
  `${out}/leaves.json`,
  `${JSON.stringify({ size: result.size, sprites: result.manifest })}\n`,
);
for (const [f, d] of Object.entries(result.barkOut))
  writeFileSync(`${out}/${f}`, Buffer.from(d, 'base64'));
console.log(
  'sheet',
  result.size,
  Object.fromEntries(Object.entries(result.manifest).map(([k, v]) => [k, v.length])),
);
await browser.close();
