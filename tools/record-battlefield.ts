// Records a real battlefield's inputs for repeatable regression testing
// (docs/adr/0044): the elevation tiles and the Overpass response the app
// would download, and the battlefield package built from them with the same
// importer (`buildBattlefield`). Nothing here is bundled with the app.
//
//   npx tsx tools/record-battlefield.ts <site> <out-dir>
//   npx tsx tools/record-battlefield.ts --lat 52.37 --lon 4.89 --name "Somewhere" <out-dir>
//
// <out-dir> receives `tiles/<z>-<x>-<y>.png`, `overpass.json` and
// `package.json` (a `BattlefieldPackage`). Existing files are reused, so a
// recording is downloaded once. The raw inputs are large (tens of MB for a
// 5 km battlefield); keep them outside the repository.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { battlefieldRequest, buildBattlefield, decodeTerrarium, planBattlefield } from '#geo';
import { decodePng } from './png';

/** The recorded battlefields: centres and names. */
export const RECORDED_SITES = {
  quantico: { lat: 38.5223, lon: -77.2934, name: 'Quantico, VA' },
  grafenwoehr: { lat: 49.717, lon: 11.906, name: 'Grafenwoehr, DE' },
  woolgoolga: { lat: -30.11, lon: 153.199, name: 'Woolgoolga, NSW' },
  bled: { lat: 46.36, lon: 14.115, name: 'Bled, SI' },
  /** Central Amsterdam: canals, dense streets and many closely spaced bridges (docs/adr/0044). */
  amsterdam: { lat: 52.3702, lon: 4.8952, name: 'Amsterdam, NL' },
} as const;

const TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function overpass(query: string): Promise<string> {
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const endpoint = OVERPASS[attempt % OVERPASS.length] ?? '';
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'User-Agent': 'Ambush-battlefield-recorder/1.0',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${String(r.status)} ${text.slice(0, 200)}`);
      const json = JSON.parse(text) as { elements?: unknown; remark?: unknown };
      if (!Array.isArray(json.elements)) throw new Error('no elements');
      if (typeof json.remark === 'string' && /error/i.test(json.remark))
        throw new Error(json.remark);
      console.log(`Overpass: ${endpoint}, ${String(text.length)} bytes`);
      return text;
    } catch (error) {
      console.log(
        `Overpass attempt ${String(attempt + 1)} (${endpoint}): ${String(error).slice(0, 200)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  throw new Error('Overpass failed');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const lat = flag('lat');
  const lon = flag('lon');
  const name = flag('name');
  const [siteOrOut, maybeOut] = args;
  const site: { readonly lat: number; readonly lon: number; readonly name: string } | undefined =
    lat && lon
      ? { lat: Number(lat), lon: Number(lon), name: name ?? `${lat}, ${lon}` }
      : (RECORDED_SITES as Record<string, (typeof RECORDED_SITES)[keyof typeof RECORDED_SITES]>)[
          siteOrOut ?? ''
        ];
  const dir = lat && lon ? siteOrOut : maybeOut;
  if (!site || !dir) {
    console.log(
      `usage: record-battlefield.ts <${Object.keys(RECORDED_SITES).join('|')}> <out-dir>, or --lat --lon [--name] <out-dir>`,
    );
    process.exit(2);
  }
  const request = battlefieldRequest(
    { lat: site.lat, lon: site.lon },
    { name: site.name, widthM: 5000 },
  );
  const plan = planBattlefield(request);
  mkdirSync(`${dir}/tiles`, { recursive: true });
  const tiles = [];
  for (const t of plan.tiles) {
    const file = `${dir}/tiles/${String(t.z)}-${String(t.x)}-${String(t.y)}.png`;
    let png: Buffer;
    if (existsSync(file)) png = readFileSync(file);
    else {
      const url = TILE_URL.replace('{z}', String(t.z))
        .replace('{x}', String(t.x))
        .replace('{y}', String(t.y));
      const r = await fetch(url);
      if (!r.ok) throw new Error(`tile ${url}: ${String(r.status)}`);
      png = Buffer.from(await r.arrayBuffer());
      writeFileSync(file, png);
    }
    const px = decodePng(png);
    tiles.push({
      ...t,
      elevations: decodeTerrarium(px.data, px.width, px.height),
      sources: 'recorded',
    });
  }
  console.log(`${String(tiles.length)} elevation tiles`);
  const osmFile = `${dir}/overpass.json`;
  if (!existsSync(osmFile)) writeFileSync(osmFile, await overpass(plan.osmQuery));
  const osm = JSON.parse(readFileSync(osmFile, 'utf8')) as Parameters<
    typeof buildBattlefield
  >[0]['osm'];
  const pkg = buildBattlefield({
    request,
    tiles,
    elevationUrlTemplate: TILE_URL,
    osm,
    osmEndpoint: 'recorded',
    createdAt: new Date().toISOString(),
  });
  writeFileSync(`${dir}/package.json`, JSON.stringify(pkg));
  const f = pkg.terrain.features;
  console.log(
    `${site.name}: ${String(f.roads.length)} roads (${String(f.roads.filter((r) => r.crossing?.kind === 'bridge').length)} mapped bridges), ${String(f.buildings.length)} buildings, ${String((f.water ?? []).length)} water areas, ${String((f.waterways ?? []).length)} waterways`,
  );
}

await main();
