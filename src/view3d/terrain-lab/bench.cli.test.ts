import { describe, expect, it } from 'vitest';
import {
  authoritativeGround,
  cleanTerrain,
  heightAt,
  lineOfSight,
  waterLevels,
  type SourceCorrections,
  type TerrainDataset,
  type Vec3,
} from '#sim';
import { compileField, createSurface, TERRAIN_FIELD_VERSION, tileHash } from '#sim/terrain-lab';

// Terrain lab benchmarks (stage 2 prototype): field compilation, tile
// generation, elevation and sight-line queries on the 0.5 m and 1 m
// surfaces, cache behaviour and repeatability, for a recorded battlefield,
// with the current terrain's queries for comparison. Skipped unless asked for:
//
//   AMBUSH_TERRAIN_LAB=<package.json> [AMBUSH_TERRAIN_LAB_AT=x,y] [AMBUSH_TERRAIN_LAB_AREA=metres]
//   [AMBUSH_TERRAIN_LAB_OUT=report.json] npx vitest run src/view3d/terrain-lab/bench.cli.test.ts
//
// Timings use this machine's clock (performance.now), in Node.

interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
}
const env =
  (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process
    ?.env ?? {};
const file = env['AMBUSH_TERRAIN_LAB'];
const clock = () => (globalThis as unknown as { performance: { now(): number } }).performance.now();

const stats = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / Math.max(1, s.length);
  return {
    mean: +mean.toFixed(3),
    p50: +(s[Math.floor(s.length / 2)] ?? 0).toFixed(3),
    p95: +(s[Math.floor(s.length * 0.95)] ?? 0).toFixed(3),
    max: +(s[s.length - 1] ?? 0).toFixed(3),
  };
};

describe.skipIf(file === undefined)('terrain lab benchmark of a recorded battlefield', () => {
  it('measures', { timeout: 3_600_000 }, async () => {
    const nodeFs = 'node:fs';
    const fs = (await import(/* @vite-ignore */ nodeFs)) as unknown as NodeFs;
    const pkg = JSON.parse(fs.readFileSync(file ?? '', 'utf8')) as {
      readonly name?: string;
      readonly terrain: TerrainDataset;
      readonly elevation: { readonly cleaning: SourceCorrections | null };
    };
    const [cx = 0, cy = 0] = (env['AMBUSH_TERRAIN_LAB_AT'] ?? '0,0').split(',').map(Number);
    const half = Number(env['AMBUSH_TERRAIN_LAB_AREA'] ?? '1000') / 2;
    const report: Record<string, unknown> = {
      battlefield: pkg.name,
      fieldVersion: TERRAIN_FIELD_VERSION,
      centre: [cx, cy],
      areaM: 2 * half,
    };
    let t = clock();
    const clean = cleanTerrain(pkg.terrain, pkg.elevation.cleaning).terrain;
    report['cleanMs'] = +(clock() - t).toFixed(1);
    t = clock();
    const water = waterLevels(clean);
    report['waterLevelsMs'] = +(clock() - t).toFixed(1);
    const f = clean.features;
    report['features'] = {
      roads: f.roads.length,
      buildings: f.buildings.length,
      vegetation: f.vegetation.length,
      water: f.water?.length ?? 0,
      waterways: f.waterways?.length ?? 0,
      landUse: f.landUse?.length ?? 0,
    };
    t = clock();
    const input = { heightfield: clean.heightfield, features: clean.features, water };
    const field = compileField(input, { seed: 1, relief: 1 }, clock);
    report['compileMs'] = +(clock() - t).toFixed(1);
    report['field'] = field.stats;

    // Random points and sight lines in the area (fixed seed).
    let seed = 12345;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pts: [number, number][] = [];
    for (let i = 0; i < 1_000_000; i += 1)
      pts.push([cx - half + rnd() * 2 * half, cy - half + rnd() * 2 * half]);
    const lines: [number, number, number, number][] = [];
    for (let i = 0; i < 2000; i += 1) {
      const ax = cx - half + 300 + rnd() * (2 * half - 600);
      const ay = cy - half + 300 + rnd() * (2 * half - 600);
      const a = rnd() * 2 * Math.PI;
      const l = 50 + rnd() * 250;
      lines.push([ax, ay, ax + l * Math.cos(a), ay + l * Math.sin(a)]);
    }

    for (const spacing of [0.5, 1]) {
      const r: Record<string, unknown> = {};
      const surface = createSurface(field, { spacing, capacity: 4096, clock });
      // Cold: tiles over the whole area, generated on first touch.
      const tiles = Math.ceil((2 * half) / 64);
      const tx0 = Math.floor((cx - half - surface.originX) / 64);
      const ty0 = Math.floor((cy - half - surface.originY) / 64);
      t = clock();
      const per: number[] = [];
      for (let i = 0; i < tiles; i += 1)
        for (let j = 0; j < tiles; j += 1) per.push(surface.tile(0, tx0 + i, ty0 + j).ms);
      const genMs = clock() - t;
      const samples = (surface.cells + 3) ** 2;
      r['tiles'] = tiles * tiles;
      r['tileMs'] = stats(per);
      r['areaGenerationMs'] = +genMs.toFixed(0);
      r['samplesPerSecond'] = Math.round((samples * tiles * tiles) / (genMs / 1000));
      r['bytesPerTile'] = Math.round(surface.cachedBytes() / surface.cachedCount());
      r['areaCacheMB'] = +(surface.cachedBytes() / 1e6).toFixed(1);
      const b = field.bounds;
      const full = Math.ceil((b.maxX - b.minX) / 64) * Math.ceil((b.maxY - b.minY) / 64);
      r['wholeBattlefieldMB'] = +(
        (full * surface.cachedBytes()) /
        surface.cachedCount() /
        1e6
      ).toFixed(0);
      r['wholeBattlefieldHeightsOnlyMB'] = +((full * (surface.cells + 3) ** 2 * 4) / 1e6).toFixed(
        0,
      );
      // Warm elevation queries.
      let acc = 0;
      t = clock();
      for (const [x, y] of pts) acc += surface.heightAt(x, y);
      r['heightAtWarmNs'] = +(((clock() - t) * 1e6) / pts.length).toFixed(0);
      // Cold queries: a fresh surface, each query may generate its tile.
      const cold = createSurface(field, { spacing, capacity: 4096 });
      t = clock();
      for (let i = 0; i < 20_000; i += 1) {
        const p = pts[i * 37];
        if (p) acc += cold.heightAt(p[0], p[1]);
      }
      r['heightAtColdUs'] = +(((clock() - t) * 1000) / 20_000).toFixed(1);
      r['coldTilesGenerated'] = cold.stats.generated;
      // Sight lines: pruned (min/max blocks) against the reference.
      const tp: number[] = [];
      const tr: number[] = [];
      let mismatches = 0;
      let blocked = 0;
      for (const [ax, ay, bx, by] of lines) {
        const a: Vec3 = { x: ax, y: ay, z: surface.heightAt(ax, ay) + 1.7 };
        const bb: Vec3 = { x: bx, y: by, z: surface.heightAt(bx, by) + 1.5 };
        let s0 = clock();
        const hp = surface.traceSight(a, bb);
        tp.push((clock() - s0) * 1000);
        s0 = clock();
        const hr = surface.traceSightReference(a, bb);
        tr.push((clock() - s0) * 1000);
        if (hp !== hr) mismatches += 1;
        if (hp !== null) blocked += 1;
      }
      r['losUs'] = stats(tp);
      r['losReferenceUs'] = stats(tr);
      r['losMismatches'] = mismatches;
      r['losBlockedShare'] = +(blocked / lines.length).toFixed(3);
      // A small cache (64 tiles) on a walk: 1 m steps wandering over the area.
      const small = createSurface(field, { spacing, capacity: 64 });
      let wx = cx;
      let wy = cy;
      let heading = 0;
      const walkStart = clock();
      for (let i = 0; i < 20_000; i += 1) {
        heading += (rnd() - 0.5) * 0.3;
        wx = Math.max(cx - half, Math.min(cx + half, wx + Math.sin(heading)));
        wy = Math.max(cy - half, Math.min(cy + half, wy + Math.cos(heading)));
        small.heightAt(wx, wy);
      }
      r['walk20kmCache64'] = {
        ms: +(clock() - walkStart).toFixed(0),
        generated: small.stats.generated,
        evicted: small.stats.evicted,
        hits: small.stats.hits,
      };
      // Repeatability: the same tiles from a freshly compiled field.
      const again = createSurface(compileField(input, { seed: 1, relief: 1 }), { spacing });
      const hashes: string[] = [];
      let same = true;
      for (let i = 0; i < 3; i += 1)
        for (let j = 0; j < 3; j += 1) {
          const h = tileHash(surface.tile(0, tx0 + i, ty0 + j));
          hashes.push(`${String(tx0 + i)},${String(ty0 + j)}:${h}`);
          if (tileHash(again.tile(0, tx0 + i, ty0 + j)) !== h) same = false;
        }
      r['repeatable'] = same;
      r['hashes'] = hashes;
      r['checksum'] = acc > 0;
      report[`s${String(spacing)}`] = r;
      expect(mismatches).toBe(0);
      expect(same).toBe(true);
    }

    // The current terrain on the same points and lines, for comparison.
    if (env['AMBUSH_TERRAIN_LAB_CURRENT'] !== '0') {
      t = clock();
      const graded = authoritativeGround(pkg.terrain, pkg.elevation.cleaning).terrain;
      const current: Record<string, unknown> = { gradeMs: +(clock() - t).toFixed(0) };
      let acc = 0;
      t = clock();
      for (const [x, y] of pts) acc += heightAt(graded, x, y);
      current['heightAtNs'] = +(((clock() - t) * 1e6) / pts.length).toFixed(0);
      const tl: number[] = [];
      for (const [ax, ay, bx, by] of lines) {
        const s0 = clock();
        lineOfSight(graded, { x: ax, y: ay }, { x: bx, y: by });
        tl.push((clock() - s0) * 1000);
      }
      current['lineOfSightUs'] = stats(tl);
      current['checksum'] = acc > 0;
      report['current'] = current;
    }
    const text = JSON.stringify(report, null, 1);
    console.log(text);
    const out = env['AMBUSH_TERRAIN_LAB_OUT'];
    if (out) fs.writeFileSync(out, text);
  });
});
