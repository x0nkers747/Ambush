import { describe, expect, it } from 'vitest';
import { authoritativeGround, type TerrainDataset } from '#sim';
import { diagnoseGeometry, type GeometryWarning } from './geometry-diagnostics';

// Road and bridge geometry diagnostics for a recorded battlefield (docs/adr/0044).
// Skipped unless asked for:
//
//   AMBUSH_DIAGNOSE=<package.json> [AMBUSH_DIAGNOSE_OUT=report.json]
//   [AMBUSH_DIAGNOSE_WITHIN=minX,minY,maxX,maxY] [AMBUSH_DIAGNOSE_CHECKS=roads,bridges,meshes]
//   npx vitest run src/view3d/diagnose.cli.test.ts
//
// <package.json> is a battlefield package, e.g. one written by
// tools/record-battlefield.ts. The terrain is graded as the app grades it,
// the roads and bridges are built as the 3D view builds them, and every check
// of `diagnoseGeometry` is run. Prints a summary and the first warnings of
// each kind, with coordinates (degrees approximated from the battlefield's
// centre, to a few metres); writes the full report as JSON when asked.

/** The parts of Node this runner uses (this layer is built without Node's types). */
interface NodeFs {
  readFileSync(path: string, encoding: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
}
const env =
  (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process
    ?.env ?? {};
const file = env['AMBUSH_DIAGNOSE'];

describe.skipIf(file === undefined)('geometry diagnostics of a recorded battlefield', () => {
  it('reports', { timeout: 3_600_000 }, async () => {
    const nodeFs = 'node:fs';
    const fs = (await import(/* @vite-ignore */ nodeFs)) as unknown as NodeFs;
    const pkg = JSON.parse(fs.readFileSync(file ?? '', 'utf8')) as {
      readonly request: { readonly name?: string; readonly centre: { lat: number; lon: number } };
      readonly terrain: TerrainDataset;
      readonly elevation: { readonly cleaning: Parameters<typeof authoritativeGround>[1] };
    };
    const box = env['AMBUSH_DIAGNOSE_WITHIN']?.split(',').map(Number);
    const within =
      box?.length === 4
        ? { minX: box[0] ?? 0, minY: box[1] ?? 0, maxX: box[2] ?? 0, maxY: box[3] ?? 0 }
        : undefined;
    const started = performance.now();
    const terrain = authoritativeGround(pkg.terrain, pkg.elevation.cleaning).terrain;
    const { lat, lon } = pkg.request.centre;
    const toLatLon = (x: number, y: number) => ({
      lat: lat + y / 111_320,
      lon: lon + x / (111_320 * Math.cos((lat * Math.PI) / 180)),
    });
    const checks = env['AMBUSH_DIAGNOSE_CHECKS']?.split(',') as
      ('roads' | 'bridges' | 'meshes')[] | undefined;
    const report = diagnoseGeometry(terrain, {
      toLatLon,
      ...(within ? { within } : {}),
      ...(checks ? { checks } : {}),
    });
    const lines = [
      `${pkg.request.name ?? 'battlefield'}: diagnosed in ${((performance.now() - started) / 1000).toFixed(1)} s`,
      `warnings by kind: ${JSON.stringify(report.counts)}`,
      `expected (not reported): ${JSON.stringify(report.expected)}`,
    ];
    const byKind = new Map<string, GeometryWarning[]>();
    for (const w of report.warnings) byKind.set(w.kind, [...(byKind.get(w.kind) ?? []), w]);
    for (const [kind, list] of byKind) {
      lines.push(`${kind} (${String(list.length)}):`);
      for (const w of list.slice(0, 5))
        lines.push(
          `  ${w.ids.join(' / ')} at (${w.x.toFixed(1)}, ${w.y.toFixed(1)})${
            w.lat !== undefined && w.lon !== undefined
              ? ` ${w.lat.toFixed(6)}, ${w.lon.toFixed(6)}`
              : ''
          }: ${w.reason}`,
        );
    }
    console.log(lines.join('\n'));
    const out = env['AMBUSH_DIAGNOSE_OUT'];
    if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1));
    expect(report.warnings.every((w) => Number.isFinite(w.x) && Number.isFinite(w.y))).toBe(true);
  });
});
