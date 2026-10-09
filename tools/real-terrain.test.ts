import { describe, expect, it } from 'vitest';
import { createExercise, scenarioForTerrain } from '#exercise';
import {
  battlefieldRequest,
  buildBattlefield,
  parseBattlefieldPackage,
  planBattlefield,
  TILE_SIZE,
  type ElevationTile,
} from '#geo';
import { heightAt, lineOfSight, pointProblem } from '#sim';
import { GRAFENWOEHR_OSM as grafenwoehr, QUANTICO_OSM as quantico } from '#geo/fixtures';

// End to end without the network (docs/adr/0014): recorded OpenStreetMap data
// for two real places, synthetic elevation tiles, a battlefield package, the
// minimal scenario and an exercise that runs to the ready state.

/** Gently rolling synthetic elevation: real tiles are checked in the browser. */
function tilesFor(
  request: ReturnType<typeof battlefieldRequest>,
): (ElevationTile & { sources: string })[] {
  return planBattlefield(request).tiles.map((t) => {
    const e = new Float32Array(TILE_SIZE * TILE_SIZE);
    for (let j = 0; j < TILE_SIZE; j += 1) {
      for (let i = 0; i < TILE_SIZE; i += 1) {
        const gx = t.x * TILE_SIZE + i;
        const gy = t.y * TILE_SIZE + j;
        e[j * TILE_SIZE + i] = 100 + 8 * Math.sin(gx / 40) + 6 * Math.cos(gy / 55);
      }
    }
    return { ...t, elevations: e, sources: 'srtm/test.tif' };
  });
}

describe.each([
  ['Quantico, Virginia (US)', { lat: 38.5223, lon: -77.2934 }, quantico],
  ['Grafenwöhr, Bavaria (DE)', { lat: 49.717, lon: 11.906 }, grafenwoehr],
])('a real-world battlefield: %s', (name, centre, osm) => {
  // The recorded OSM covers 1 km.
  const request = battlefieldRequest(centre, { name, widthM: 1000 });
  const pkg = buildBattlefield({
    request,
    tiles: tilesFor(request),
    elevationUrlTemplate: 'https://example.test/{z}/{x}/{y}.png',
    osm,
    osmEndpoint: 'https://example.test/interpreter',
    createdAt: '2026-10-08T00:00:00Z',
  });

  it('round-trips through JSON as a saved package would', () => {
    expect(parseBattlefieldPackage(JSON.parse(JSON.stringify(pkg)))).toEqual(pkg);
  });

  it('places the squad off buildings and water, and plays to the ready state', () => {
    const scenario = scenarioForTerrain(pkg.terrain, `battlefield-${pkg.id}`);
    for (const s of scenario.soldiers) expect(pointProblem(pkg.terrain, s.position)).toBeNull();
    const exercise = createExercise({ config: { tickRateHz: 30, seed: 1 }, scenario });
    // Send three Marines 150 m in different directions where they can stand.
    const soldiers = exercise.simulation.state.soldiers.slice(0, 3);
    const { east, north } = scenario.orp.centre;
    soldiers.forEach((s, k) => {
      for (let r = 150; r < 450; r += 10) {
        const a = (k * 2 * Math.PI) / 3;
        const p = { x: east + r * Math.sin(a), y: north + r * Math.cos(a) };
        if (Math.abs(p.x) > 490 || Math.abs(p.y) > 490 || pointProblem(pkg.terrain, p)) continue;
        try {
          exercise.setDestination(s.id, p);
          return;
        } catch {
          // Unreachable from here: try further out.
        }
      }
    });
    expect(exercise.execute().ok).toBe(true);
    for (let i = 0; i < 4000 && exercise.phase === 'bluforOccupation'; i += 1)
      exercise.advance(1, 16);
    expect(exercise.phase).toBe('bluforReady');
    // Terrain analysis works on it as on the demo.
    const a = exercise.simulation.state.soldiers[0]?.position;
    if (!a) throw new Error('no soldier');
    expect(Number.isFinite(heightAt(pkg.terrain, a.x, a.y))).toBe(true);
    expect(typeof lineOfSight(pkg.terrain, a, { x: 0, y: 400 }).clear).toBe('boolean');
  });
});
