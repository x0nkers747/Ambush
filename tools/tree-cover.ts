// Tree cover from aerial imagery (docs/adr/0049): woods that OpenStreetMap
// does not map, found in USGS NAIP imagery (public domain, 1 m, natural colour
// and near infrared; the contiguous United States only) and written as rings
// the app can add to a battlefield (src/app/tree-cover.ts, switched off for
// now). Nothing here is bundled with the app.
//
//   npx tsx tools/tree-cover.ts imagery <battlefield-dir>
//   npx tsx tools/tree-cover.ts classify <battlefield-dir> [--level 1-4] [--review x,y,size;…]
//
// <battlefield-dir> is a recording (tools/record-battlefield.ts): its
// `package.json` gives the frame and the mapped features. `imagery` downloads
// the imagery over the battlefield in 1 km squares (`naip/`, reused when
// present). `classify` writes `tree-cover.json`, and with --review, images of
// the given squares (local metres: centre x, y and size) with the woods found
// tinted red, to judge the level by.
//
// The classifier is a naive Bayes over five per-pixel features (NDVI,
// brightness and its texture, near-infrared brightness and texture), trained
// on the mapped woods (trees) and mapped meadows, parks and fields (open
// ground). A level sets how much open ground may be taken for trees (the
// threshold, on held-out pixels), how the result is smoothed and the smallest
// wood kept; level 3 was judged right on Quantico. Pixels already in mapped
// vegetation (and 4 m round it), buildings, roads, water and paved ground are
// never trees. Each wood is traced along its pixel edges, simplified, and
// kept only as a simple polygon; clearings of 400 m² or more are its holes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isSimplePolygon, type EnvironmentFeatures, type Vec2 } from '#sim';
import { decodePng, encodePng } from './png';

const NAIP =
  'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage';
/** Imagery squares, metres (and pixels). */
const CHUNK = 1000;

/** How eager the classifier is: share of open ground taken for trees, smoothing, smallest wood. */
const LEVELS = [
  { fpr: 0.05, radius: 3, fraction: 0.55, minM2: 150 },
  { fpr: 0.1, radius: 2, fraction: 0.5, minM2: 80 },
  { fpr: 0.15, radius: 2, fraction: 0.45, minM2: 40 },
  { fpr: 0.2, radius: 1, fraction: 0.4, minM2: 25 },
] as const;
/** Clearings at least this big are kept as holes; smaller gaps are filled, m². */
const HOLE_M2 = 400;

interface Recording {
  readonly frame: {
    readonly epsg: number;
    readonly falseEasting: number;
    readonly falseNorthing: number;
  };
  readonly terrain: {
    readonly heightfield: {
      readonly originX: number;
      readonly originY: number;
      readonly cellSize: number;
      readonly columns: number;
      readonly rows: number;
    };
    readonly features: EnvironmentFeatures;
  };
}

/** The battlefield's 1 m grid: its south-west corner (local metres) and size, whole imagery squares. */
function gridOf(r: Recording) {
  const hf = r.terrain.heightfield;
  const nx = Math.ceil(((hf.columns - 1) * hf.cellSize) / CHUNK);
  const ny = Math.ceil(((hf.rows - 1) * hf.cellSize) / CHUNK);
  return { x0: hf.originX, y0: hf.originY, nx, ny, w: nx * CHUNK, h: ny * CHUNK };
}

async function download(url: string, file: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      const buf = Buffer.from(await response.arrayBuffer());
      if (!response.ok || buf.subarray(1, 4).toString() !== 'PNG')
        throw new Error(`${String(response.status)} ${buf.subarray(0, 80).toString()}`);
      writeFileSync(file, buf);
      return;
    } catch (error) {
      console.log(`retrying ${file}: ${String(error).slice(0, 120)}`);
      await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
    }
  }
  throw new Error(`could not download ${file}`);
}

async function imagery(dir: string, r: Recording): Promise<void> {
  const g = gridOf(r);
  mkdirSync(`${dir}/naip`, { recursive: true });
  let fetched = 0;
  for (let j = 0; j < g.ny; j += 1)
    for (let i = 0; i < g.nx; i += 1) {
      const e = r.frame.falseEasting + g.x0 + i * CHUNK;
      const n = r.frame.falseNorthing + g.y0 + j * CHUNK;
      for (const [name, bands] of [
        ['rgb', '0,1,2'],
        ['nir', '3,3,3'],
      ] as const) {
        const file = `${dir}/naip/${name}_${String(i)}_${String(j)}.png`;
        if (existsSync(file)) continue;
        const params = new URLSearchParams({
          bbox: `${String(e)},${String(n)},${String(e + CHUNK)},${String(n + CHUNK)}`,
          bboxSR: String(r.frame.epsg),
          imageSR: String(r.frame.epsg),
          size: `${String(CHUNK)},${String(CHUNK)}`,
          format: 'png24',
          pixelType: 'U8',
          bandIds: bands,
          renderingRule: JSON.stringify({ rasterFunction: 'None' }),
          interpolation: 'RSP_BilinearInterpolation',
          f: 'image',
        });
        await download(`${NAIP}?${params.toString()}`, file);
        fetched += 1;
      }
    }
  console.log(`${String(fetched)} imagery squares downloaded to ${dir}/naip`);
}

type Point = [number, number];

function classify(dir: string, r: Recording, level: number, reviews: number[][]): void {
  const g = gridOf(r);
  const W = g.w;
  const H = g.h;
  const N = W * H;
  const at = (gx: number, gy: number) => gy * W + gx;

  // The imagery mosaic, row 0 the southernmost.
  const R = new Uint8Array(N);
  const G = new Uint8Array(N);
  const B = new Uint8Array(N);
  const NIR = new Uint8Array(N);
  for (let j = 0; j < g.ny; j += 1)
    for (let i = 0; i < g.nx; i += 1) {
      const rgb = decodePng(readFileSync(`${dir}/naip/rgb_${String(i)}_${String(j)}.png`));
      const nir = decodePng(readFileSync(`${dir}/naip/nir_${String(i)}_${String(j)}.png`));
      for (let row = 0; row < CHUNK; row += 1)
        for (let c = 0; c < CHUNK; c += 1) {
          const k = at(i * CHUNK + c, j * CHUNK + (CHUNK - 1 - row));
          const s = (row * CHUNK + c) * 4;
          R[k] = rgb.data[s] ?? 0;
          G[k] = rgb.data[s + 1] ?? 0;
          B[k] = rgb.data[s + 2] ?? 0;
          NIR[k] = nir.data[s] ?? 0;
        }
    }

  // The mapped features, rasterised.
  const gx = (x: number) => x - g.x0;
  const gy = (y: number) => y - g.y0;
  const fillPolygon = (rings: readonly (readonly Vec2[])[], mask: Uint8Array, value: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const ring of rings)
      for (const p of ring) {
        lo = Math.min(lo, gy(p.y));
        hi = Math.max(hi, gy(p.y));
      }
    for (let y = Math.max(0, Math.floor(lo)); y <= Math.min(H - 1, Math.ceil(hi)); y += 1) {
      const yc = y + 0.5;
      const xs: number[] = [];
      for (const ring of rings)
        ring.forEach((a, k) => {
          const b = ring[(k + 1) % ring.length] ?? a;
          const ay = gy(a.y);
          const by = gy(b.y);
          if (ay <= yc !== by <= yc)
            xs.push(gx(a.x) + ((yc - ay) / (by - ay)) * (gx(b.x) - gx(a.x)));
        });
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.ceil((xs[k] ?? 0) - 0.5));
        const xb = Math.min(W - 1, Math.floor((xs[k + 1] ?? 0) - 0.5));
        for (let x = xa; x <= xb; x += 1) mask[at(x, y)] = value;
      }
    }
  };
  const strokeLine = (line: readonly Vec2[], half: number, mask: Uint8Array, value: number) => {
    for (let k = 0; k + 1 < line.length; k += 1) {
      const a = line[k];
      const b = line[k + 1];
      if (!a || !b) continue;
      const [ax, ay, bx, by] = [gx(a.x), gy(a.y), gx(b.x), gy(b.y)];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy || 1;
      for (
        let y = Math.max(0, Math.floor(Math.min(ay, by) - half));
        y <= Math.min(H - 1, Math.ceil(Math.max(ay, by) + half));
        y += 1
      )
        for (
          let x = Math.max(0, Math.floor(Math.min(ax, bx) - half));
          x <= Math.min(W - 1, Math.ceil(Math.max(ax, bx) + half));
          x += 1
        ) {
          const t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / l2));
          const px = ax + t * dx - x - 0.5;
          const py = ay + t * dy - y - 0.5;
          if (px * px + py * py <= half * half) mask[at(x, y)] = value;
        }
    }
  };
  const dilate = (mask: Uint8Array, radius: number) => {
    const tmp = new Uint8Array(N);
    const out = new Uint8Array(N);
    for (let y = 0; y < H; y += 1)
      for (let x = 0; x < W; x += 1)
        if (mask[at(x, y)])
          for (let k = Math.max(0, x - radius); k <= Math.min(W - 1, x + radius); k += 1)
            tmp[at(k, y)] = 1;
    for (let x = 0; x < W; x += 1)
      for (let y = 0; y < H; y += 1)
        if (tmp[at(x, y)])
          for (let k = Math.max(0, y - radius); k <= Math.min(H - 1, y + radius); k += 1)
            out[at(x, k)] = 1;
    return out;
  };
  const f = r.terrain.features;
  // Training labels: 1 trees (mapped woods), 2 open ground.
  const label = new Uint8Array(N);
  for (const l of f.landUse ?? [])
    if (['meadow', 'recreation', 'cemetery', 'farmland'].includes(l.kind))
      fillPolygon([l.boundary, ...(l.holes ?? [])], label, 2);
  for (const v of f.vegetation)
    if (v.kind === 'woodland') fillPolygon([v.boundary, ...(v.holes ?? [])], label, 1);
  const mapped = new Uint8Array(N);
  for (const v of f.vegetation) {
    if (v.kind === 'treeLine') strokeLine(v.boundary, 4, mapped, 1);
    fillPolygon([v.boundary], mapped, 1);
  }
  const nearMapped = dilate(mapped, 4);
  const blocked = new Uint8Array(N);
  for (const b of f.buildings) fillPolygon([b.footprint], blocked, 1);
  for (const road of f.roads) strokeLine(road.centerline, road.widthMeters / 2 + 1, blocked, 1);
  for (const w of f.water ?? []) fillPolygon([w.boundary], blocked, 1);
  for (const w of f.waterways ?? []) strokeLine(w.centerline, w.widthMeters / 2 + 1, blocked, 1);
  for (const l of f.landUse ?? []) if (l.kind === 'paved') fillPolygon([l.boundary], blocked, 1);

  // Features.
  const boxMean = (v: Float32Array, radius: number) => {
    const tmp = new Float32Array(N);
    const out = new Float32Array(N);
    const n = 2 * radius + 1;
    for (let y = 0; y < H; y += 1) {
      let s = 0;
      for (let x = -radius; x <= radius; x += 1)
        s += v[at(Math.min(W - 1, Math.max(0, x)), y)] ?? 0;
      for (let x = 0; x < W; x += 1) {
        tmp[at(x, y)] = s / n;
        s +=
          (v[at(Math.min(W - 1, x + radius + 1), y)] ?? 0) -
          (v[at(Math.max(0, x - radius), y)] ?? 0);
      }
    }
    for (let x = 0; x < W; x += 1) {
      let s = 0;
      for (let y = -radius; y <= radius; y += 1)
        s += tmp[at(x, Math.min(H - 1, Math.max(0, y)))] ?? 0;
      for (let y = 0; y < H; y += 1) {
        out[at(x, y)] = s / n;
        s +=
          (tmp[at(x, Math.min(H - 1, y + radius + 1))] ?? 0) -
          (tmp[at(x, Math.max(0, y - radius))] ?? 0);
      }
    }
    return out;
  };
  const deviation = (v: Float32Array, radius: number) => {
    const m1 = boxMean(v, radius);
    const sq = v.map((x) => x * x);
    const m2 = boxMean(sq, radius);
    return { mean: m1, sd: m2.map((x, k) => Math.sqrt(Math.max(0, x - (m1[k] ?? 0) ** 2))) };
  };
  const ndvi = new Float32Array(N);
  const bright = new Float32Array(N);
  for (let k = 0; k < N; k += 1) {
    const red = R[k] ?? 0;
    const nir = NIR[k] ?? 0;
    ndvi[k] = (nir - red) / (nir + red + 1);
    bright[k] = (red + (G[k] ?? 0) + (B[k] ?? 0)) / 3;
  }
  const nirTexture = deviation(Float32Array.from(NIR), 2);
  // Canopy is a mosaic of lit crowns and shadow; lawn is even.
  const brightTexture = deviation(bright, 3);
  const ndviS = boxMean(ndvi, 1);
  const features = [
    { v: ndviS, lo: -0.3, hi: 0.8 },
    { v: boxMean(bright, 1), lo: 0, hi: 200 },
    { v: nirTexture.mean, lo: 0, hi: 255 },
    { v: brightTexture.sd, lo: 0, hi: 40 },
    { v: nirTexture.sd, lo: 0, hi: 40 },
  ];

  // Naive Bayes on binned features, trained on every other labelled sample.
  const BINS = 32;
  const bin = (feature: { lo: number; hi: number }, x: number) =>
    Math.max(
      0,
      Math.min(BINS - 1, Math.floor(((x - feature.lo) / (feature.hi - feature.lo)) * BINS)),
    );
  const counts = features.map(() => [new Float64Array(BINS), new Float64Array(BINS)] as const);
  const train: number[] = [];
  const test: number[] = [];
  for (let k = 0; k < N; k += 53) {
    const l = label[k];
    if (l !== 1 && l !== 2) continue;
    ((train.length + test.length) % 2 === 0 ? train : test).push(k);
  }
  for (const k of train)
    features.forEach((feature, i) => {
      const h = counts[i]?.[label[k] === 1 ? 0 : 1];
      const b = bin(feature, feature.v[k] ?? 0);
      if (h) h[b] = (h[b] ?? 0) + 1;
    });
  const logRatio = counts.map(([trees, open]) => {
    const st = trees.reduce((a, b) => a + b, 0) + BINS;
    const so = open.reduce((a, b) => a + b, 0) + BINS;
    return Array.from(
      { length: BINS },
      (_, b) => Math.log(((trees[b] ?? 0) + 1) / st) - Math.log(((open[b] ?? 0) + 1) / so),
    );
  });
  const score = (k: number) =>
    features.reduce(
      (s, feature, i) => s + (logRatio[i]?.[bin(feature, feature.v[k] ?? 0)] ?? 0),
      0,
    );
  const openScores = test
    .filter((k) => label[k] === 2)
    .map(score)
    .sort((a, b) => a - b);
  const treeScores = test.filter((k) => label[k] === 1).map(score);
  if (openScores.length === 0 || treeScores.length === 0)
    throw new Error('the battlefield maps too few woods or open areas to learn from');

  const L = LEVELS[level - 1];
  if (!L) throw new Error(`level must be 1 to ${String(LEVELS.length)}`);
  const threshold = openScores[Math.floor(openScores.length * (1 - L.fpr))] ?? 0;
  const recall = treeScores.filter((s) => s > threshold).length / treeScores.length;
  const tree = new Float32Array(N);
  for (let k = 0; k < N; k += 1) tree[k] = (ndviS[k] ?? 0) > 0.05 && score(k) > threshold ? 1 : 0;
  const smooth = boxMean(tree, L.radius);
  const keep = new Uint8Array(N);
  for (let k = 0; k < N; k += 1)
    keep[k] = (smooth[k] ?? 0) > L.fraction && !nearMapped[k] && !blocked[k] ? 1 : 0;

  const areas = woods(keep, W, H, L.minM2);
  const total = areas.reduce((s, a) => s + a.areaM2, 0);
  console.log(
    `level ${String(level)}: open ground taken for trees ${String(L.fpr)}, mapped woods found ${recall.toFixed(2)}; ${String(areas.length)} woods, ${(total / 1e6).toFixed(2)} km²`,
  );
  const toUtm = (ring: readonly Point[]) =>
    ring.map(([x, y]) => [x + g.x0 + r.frame.falseEasting, y + g.y0 + r.frame.falseNorthing]);
  writeFileSync(
    `${dir}/tree-cover.json`,
    JSON.stringify({
      source: 'USGS NAIP imagery (public domain), classified by tools/tree-cover.ts',
      epsg: r.frame.epsg,
      level,
      calibration: { method: 'naive-bayes', threshold, recall, ...L },
      areas: areas.map((a, i) => ({
        id: `naip-${String(i + 1)}`,
        areaM2: a.areaM2,
        ring: toUtm(a.ring),
        ...(a.holes.length > 0 ? { holes: a.holes.map(toUtm) } : {}),
      })),
    }),
  );
  console.log(`written ${dir}/tree-cover.json`);

  // Review images: the imagery, the woods found tinted red.
  const drawn = new Uint8Array(N);
  for (const a of areas)
    fillPolygon(
      [a.ring, ...a.holes].map((ring) => ring.map(([x, y]) => ({ x: x + g.x0, y: y + g.y0 }))),
      drawn,
      1,
    );
  for (const [cx = 0, cy = 0, size = 800] of reviews) {
    const img = new Uint8Array(size * size * 3);
    for (let row = 0; row < size; row += 1)
      for (let col = 0; col < size; col += 1) {
        const x = Math.round(cx - size / 2 + col - g.x0);
        const y = Math.round(cy + size / 2 - row - g.y0);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const k = at(x, y);
        const o = (row * size + col) * 3;
        const red = drawn[k] ? 0.55 : 0;
        img[o] = (R[k] ?? 0) * (1 - red) + 255 * red;
        img[o + 1] = (G[k] ?? 0) * (1 - red);
        img[o + 2] = (B[k] ?? 0) * (1 - red);
      }
    const file = `${dir}/tree-cover-review_${String(cx)}_${String(cy)}.png`;
    writeFileSync(file, encodePng(img, size, size));
    console.log(`review ${file}`);
  }
}

/** The woods in `keep` (W × H, 1 m pixels from the grid's corner): rings and holes in grid metres. */
function woods(keep: Uint8Array, W: number, H: number, minM2: number) {
  const at = (x: number, y: number) => y * W + x;
  const comp = new Int32Array(W * H).fill(-1);
  const out: { ring: Point[]; holes: Point[][]; areaM2: number }[] = [];
  const stack: number[] = [];
  let id = 0;
  for (let s = 0; s < W * H; s += 1) {
    if (!keep[s] || comp[s] !== -1) continue;
    id += 1;
    const cells: number[] = [];
    stack.push(s);
    comp[s] = id;
    let [x0, y0, x1, y1] = [W, H, 0, 0];
    while (stack.length > 0) {
      const k = stack.pop() ?? 0;
      cells.push(k);
      const x = k % W;
      const y = (k - x) / W;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nk = at(nx, ny);
        if (keep[nk] && comp[nk] === -1) {
          comp[nk] = id;
          stack.push(nk);
        }
      }
    }
    if (cells.length < minM2) continue;
    // The wood in its own box, with a pixel of margin.
    const w = x1 - x0 + 3;
    const h = y1 - y0 + 3;
    const m = new Uint8Array(w * h);
    for (const k of cells) {
      const x = k % W;
      m[((k - x) / W - y0 + 1) * w + (x - x0 + 1)] = 1;
    }
    // Background regions: the one at the border is outside; the rest are gaps.
    const region = new Int32Array(w * h).fill(-1);
    const gaps: number[] = [];
    for (let s2 = 0; s2 < w * h; s2 += 1) {
      if (m[s2] || region[s2] !== -1) continue;
      const rid = s2 === 0 ? 0 : gaps.length + 1;
      const queue = [s2];
      region[s2] = rid;
      let size = 0;
      while (queue.length > 0) {
        const k = queue.pop() ?? 0;
        size += 1;
        const x = k % w;
        const y = (k - x) / w;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nk = ny * w + nx;
          if (!m[nk] && region[nk] === -1) {
            region[nk] = rid;
            queue.push(nk);
          }
        }
      }
      if (rid !== 0) gaps.push(size);
    }
    const holeRegions: number[] = [];
    gaps.forEach((size, gi) => {
      if (size < HOLE_M2) {
        for (let k = 0; k < w * h; k += 1) if (region[k] === gi + 1) m[k] = 1;
      } else holeRegions.push(gi + 1);
    });
    const toGrid = (ring: Point[]): Point[] => ring.map(([x, y]) => [x + x0 - 1, y + y0 - 1]);
    const first = (test: (k: number) => boolean): Point | null => {
      for (let k = 0; k < w * h; k += 1) if (test(k)) return [k % w, Math.floor(k / w)];
      return null;
    };
    const inWood = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
    const start = first((k) => m[k] === 1);
    const outer = start && simpleRing(toGrid(traceRing(inWood, start, 8 * w * h)));
    if (!outer) continue;
    const holes: Point[][] = [];
    for (const rid of holeRegions) {
      const inHole = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < w && y < h && region[y * w + x] === rid;
      const hs = first((k) => region[k] === rid);
      // A hole joined only diagonally can trace badly: such holes are left out.
      const traced = hs ? traceRing(inHole, hs, 8 * w * h) : [];
      const hole = traced.length > 0 ? simpleRing(toGrid(traced)) : null;
      if (hole) holes.push(hole);
    }
    out.push({ ring: outer, holes, areaM2: cells.length });
  }
  return out;
}

/** The outline of a 4-connected region, by following its pixel edges from its first pixel's corner. */
function traceRing(
  inside: (x: number, y: number) => boolean,
  [sx, sy]: Point,
  limit: number,
): Point[] {
  const pts: Point[] = [];
  let [px, py] = [sx, sy];
  let dir = 0;
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const left = (x: number, y: number, d: number) =>
    d === 0
      ? inside(x, y)
      : d === 1
        ? inside(x - 1, y)
        : d === 2
          ? inside(x - 1, y - 1)
          : inside(x, y - 1);
  const right = (x: number, y: number, d: number) =>
    d === 0
      ? inside(x, y - 1)
      : d === 1
        ? inside(x, y)
        : d === 2
          ? inside(x - 1, y)
          : inside(x - 1, y - 1);
  for (let guard = 0; guard < limit; guard += 1) {
    pts.push([px, py]);
    px += DX[dir] ?? 0;
    py += DY[dir] ?? 0;
    if (px === sx && py === sy) return pts;
    if (right(px, py, dir)) dir = (dir + 3) % 4;
    else if (!left(px, py, dir)) dir = (dir + 1) % 4;
  }
  return [];
}

/** Douglas–Peucker simplification of a ring's points. */
function simplify(p: readonly Point[], tolerance: number): Point[] {
  if (p.length < 4) return [...p];
  const keep = new Uint8Array(p.length);
  keep[0] = 1;
  keep[p.length - 1] = 1;
  const stack: Point[] = [[0, p.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() ?? [0, 0];
    const [ax, ay] = p[a] ?? [0, 0];
    const [bx, by] = p[b] ?? [0, 0];
    const l = Math.hypot(bx - ax, by - ay) || 1;
    let worst = 0;
    let at = -1;
    for (let i = a + 1; i < b; i += 1) {
      const [qx, qy] = p[i] ?? [0, 0];
      const d = Math.abs((by - ay) * (qx - ax) - (bx - ax) * (qy - ay)) / l;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance && at > 0) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return p.filter((_, i) => keep[i]);
}

/** The ring simplified as much as it stays a simple polygon, or null. */
function simpleRing(ring: readonly Point[]): Point[] | null {
  for (const tolerance of [1.2, 2, 3]) {
    const s = simplify(ring, tolerance);
    if (s.length >= 4 && isSimplePolygon(s.map(([x, y]) => ({ x, y })))) return s;
  }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const level = Number(flag('level') ?? '3');
  const reviews = (flag('review') ?? '')
    .split(';')
    .filter((s) => s !== '')
    .map((s) => s.split(',').map(Number));
  const [command, dir] = args;
  if ((command !== 'imagery' && command !== 'classify') || !dir) {
    console.log(
      'usage: tree-cover.ts imagery <battlefield-dir> | classify <battlefield-dir> [--level 1-4] [--review x,y,size;…]',
    );
    process.exit(2);
  }
  const recording = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as Recording;
  if (command === 'imagery') await imagery(dir, recording);
  else classify(dir, recording, level, reviews);
}

await main();
