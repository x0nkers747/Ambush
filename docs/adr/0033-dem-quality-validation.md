# ADR 0033: DEM quality validation and repair

- Status: Accepted
- Date: 2026-10-11
- Builds on ADR 0006 and ADR 0008 (the terrain dataset), ADR 0014 (real-world terrain import) and
  ADR 0032 (the authoritative graded terrain), which now starts from the cleaned DEM.

## Context

The recorded Quantico battlefield has a sample of −782.48 m at (230, 1240), among neighbours of
0.2–17.6 m: a hole 800 m deep on the bank of the Potomac. The 3D view drew it, and movement, line of
sight, viewsheds and grading all used it. It was there before milestone 4.

### Where it comes from

The import pipeline (ADR 0014) runs:

1. Fetch AWS Terrain Tiles (Terrarium PNGs, zoom 15 at 10 m).
2. Decode each pixel as R·256 + G + B/256 − 32768.
3. Resample bilinearly at the 10 m grid's points; fill samples whose pixels are all missing (NaN,
   from missing tiles) from their neighbours.
4. Round to the centimetre and store the grid in the battlefield package (IndexedDB).
5. On opening: grade (ADR 0032), share, and use everywhere.

Faults can enter at the source (bad pixels), at decoding (a no-data encoding taken as a height), at
resampling (a bad pixel mixed into good samples), at tile edges (stitching faults), or through
missing tiles. Tracing the Quantico sample through each step:

- Re-resampling the recorded tiles reproduces the stored grid exactly (all 251,001 samples), so
  storage did not change it.
- The sample's four source pixels are in tile 15/9348/12577, in the tile's interior (pixels
  202–203, 180–181), not at an edge. Pixel (202, 180) is RGB (123, 218, 106), which decodes
  correctly to **−1061.59 m**; the pixel below it is **−397.7 m**. Their neighbours are 13–23 m.
  Bilinear weights mixed the first into the sample: −782.48 m.
- −1061.59 is not a no-data value (Terrarium's is −32768, black), and the RGB values are not
  corrupt: the tile holds that height.
- The live tile on AWS today is byte-identical to the recorded one (last modified 2017-11-12). It
  lists NED 1/9 arc-second (Virginia 2011, Washington DC 2008), NED 1/3 arc-second, SRTM and
  GMTED as sources.

**Root cause: a fault in the source data.** It is not a no-data sentinel, a tile-boundary
artifact, a decoding or interpolation error, or a datum problem. Ambush! resampled it faithfully.

Checking every source tile shows how common this is. The 42 Quantico tiles hold **43 such pixels**
(−108 to −1,103 m, all pits, all in low ground near water, in 8 tiles). Every one lies on a
straight line where the values step by a few metres: a join between the source rasters merged into
the tile mosaic (for example 1.2 m against 3.9 m at (−1660, −2360)). They look like voids left
along those joins. They reach **18** grid samples, by different amounts: a pixel weighted 2% into a
sample leaves a dip of only 20 m. Grafenwöhr's 56 tiles hold none. At both sites the steps across
tile edges are the same as the steps just inside them (99th percentile 1.36 m against 1.28 m at
Quantico, 0.95 m against 0.57 m at Grafenwöhr): there are no tile-seam faults.

### The earliest reliable point

Faults are clearest in the decoded tiles, where a void is one or two pixels hundreds of metres off.
Resampling smears it into several samples, some only partly wrong. Of Quantico's 18 affected
samples, checking the 10 m grid alone finds 9. The rest are partial dips (up to 23 m) that cannot be
told from real ground at 10 m. So faults are found **in the tiles, at import**.

Packages already stored have no tiles, though, and the grid is the provenance record (it must stay
as imported). So the grid is checked again **on opening**, before grading, which also covers old
packages. Both stages use the same detector.

## Decision

The terrain pipeline is now:

**source tiles → decode → check pixels (import) → resample → raw grid, stored, with the pixel
corrections beside it → apply the corrections, check the grid (open) → clean DEM → grade →
authoritative terrain**

### The detector (`src/sim/dem-quality.ts`, `cleanElevations`)

It works on any regular grid: the 10 m heightfield, or a tile's pixels at their true size (3.74 m at
Quantico, in Web Mercator at the tile's middle).

**Definite faults (invalid data).** These are always wrong:

- not finite (NaN, ±∞);
- a recognised no-data value (−32768, −32767, −9999, −3.4·10³⁸, or the source's own);
- beyond the Earth's surface (below −11,000 m or above 9,000 m).

Negative heights are not faults: ground below sea level is real. Each invalid region (8-connected)
is rebuilt if it has at most 400 samples and at least 3 valid samples round it. Larger regions are
**unresolved**: they are filled so the terrain stays finite, but reported and shown to the user. If
more than 25% of the DEM is invalid, it is rejected (`DemQualityError`), as before for missing tiles.

**Pits and spikes.** Several local tests are used together; there is no global height threshold.

1. **Candidates.** Compare each sample with the median of the 8 samples three cells away (a
   neighbourhood median, robust to the fault itself). A **core** candidate differs from it by at
   least 20 m; a **weak** one by at least 10 m. A bound (the median lies between the lowest and
   highest of the 8) rules out most samples without sorting.
2. **Regions.** Core candidates of one sign form 8-connected regions (connected-component
   analysis). Each may take in its weak neighbours, a fault's fainter edges, but only if the
   larger region still passes every test below. Regions of more than 1,000 samples (bands along
   cliffs and banks) are not examined.
3. **Isolation.** Ring 1 is the valid, non-candidate samples next to the region; ring 2 is those
   next to ring 1. The region must lie entirely beyond ring 1: every sample below its lowest (a
   pit) or above its highest (a spike). The **excursion** is by how much. A real feature continues
   into its surroundings, so some sample round it is at its height; a fault does not.
4. **Gradient consistency.** The **step** is the steepest difference between 4-adjacent samples in
   rings 1 and 2. A real summit, gorge or cliff is reached by slopes that show there; a fault is
   not. The excursion must be at least 4 × the step (the step taken as at least 1 m) and at least
   20 m.
5. **Size and shape.** To be repaired, a region must have at most 16 samples, span at most 5, and
   be steep beyond anything natural at that size: its deepest (or highest) point at least
   2 × span × width beyond the ring. A single 10 m sample needs 20 m, 2 samples across need 80 m,
   3 across need 180 m. Larger regions need ever stronger evidence.

**Classification:**

| Class              | Rule                                                                         | Action                                    |
| ------------------ | ---------------------------------------------------------------------------- | ----------------------------------------- |
| A. Definite        | Invalid data                                                                 | Rebuilt; unresolved if too large          |
| B. High-confidence | Isolated (3, 4) and small and steep (5)                                      | Repaired                                  |
| B'. Unresolved     | Isolated, at least 100 m off, but too large or too wide                      | Left as it is; reported; the user is told |
| C. Suspicious      | Excursion ≥ 20 m and at least 2 × the step, or isolated but not steep enough | Preserved; listed in the details only     |
| Real terrain       | Anything else                                                                | Untouched                                 |

**Repair: harmonic interpolation.** All repaired samples (faults and invalid samples together, so
neighbouring faults never use each other's values) are rebuilt per connected region. Each becomes
the mean of its up to 8 neighbours, solved by Gauss–Seidel in index order until no value changes by
1e-7 m, then rounded to the centimetre. A discrete harmonic surface:

- has no maximum or minimum inside the region, so it adds no new peak or pit;
- meets its surroundings without a step;
- reproduces a plane exactly (bilinear-like).

It uses only nearby ground, never a global average.

**False-positive protections.** These are tested on synthetic terrain:

- 3 : 1 mountains with a single-sample summit 1,500 m high;
- straight, diagonal and sea cliffs of 120–150 m;
- one-sample gorges and ridges 45–60 m deep or high;
- quarries 3 × 3 and 4 × 4 samples, 40–45 m deep with vertical walls;
- an 80 m bowl, 15 m terraces;
- Dead Sea and polder ground below sea level;
- a 2 × 2 sea stack 40 m high (kept; listed as suspicious);
- rough ground with ±25 m noise per sample, and badlands.

None is changed by a single centimetre. Each of these is protected by one of the rules:

- A cliff, gorge or ridge continues, so ring 1 always holds samples at its height.
- A mountain's slopes make the step as large as the summit's excursion.
- Quarries and stacks are too wide for their depth.
- Noise makes the step large.

### At import (`src/geo/terrarium.ts`, `cleanElevationTiles`; importer 1.2.0)

1. **Tile edges.** Each edge line is checked against the tile across it (or, without one, against
   the line carried on from two pixels in).
   - **Broken edge:** a line at least 90% of whose pixels are ≥ 20 m off both sides, the same way,
     and at least 4 × the step between the sides. This is a stitching fault; it is marked invalid
     and rebuilt.
   - **Seam offset:** a steady step of 2–20 m along at least 80% of an edge, beyond the step just
     inside it. This is two sources that disagree. It is reported and **not** smoothed: nothing
     says which side is right.
2. **Each tile** is checked by the detector on its own, at its pixel size. The result does not
   depend on which other tiles were fetched.
3. The grid is resampled twice, from the raw and from the checked tiles. The **raw** grid is
   stored as the terrain, unchanged. The samples that differ by at least 1 cm are stored with
   their corrected values as `elevation.cleaning`, along with the counts (faulty and invalid
   pixels, broken edges, seam offsets, unresolved regions) and the cleaning version. For Quantico
   that is 18 entries.

The package id still fingerprints the raw terrain. `parseBattlefieldPackage` refuses corrections
that are not samples of the grid.

### On opening (`cleanTerrain`, `authoritativeGround`)

The worker (`src/app/grading.worker.ts`) receives the raw terrain and the corrections. It:

1. applies the corrections, if they were made with the current cleaning version (otherwise they are
   ignored);
2. checks the grid;
3. stamps the terrain `cleaning: { version: 'dem-clean-v1' }`;
4. grades it (ADR 0032).

It posts the terrain, the quality report, and the cleaning and grading times, which appear as
`performance.measure` entries `terrain: DEM cleaning` and `terrain: grading`. The demo uses
`authoritativeGround` too. There is no other elevation model: the 2D map, the 3D view, movement,
line of sight, viewsheds, the simulation, replay and the AAR all use this terrain.

### Versioning

- `DEM_CLEANING_VERSION = 'dem-clean-v1'` names the rules and the parameters (`DEM_CLEANING`). A
  test pins the parameters' fingerprint, so changing one without a new version fails.
- `terrainModelId` combines the steps a terrain went through: `dem-clean-v1+graded-v1`
  (`TERRAIN_MODEL`).
  - Scenarios saved on `graded-v1` are flagged on opening, with the existing notice, now worded
    for both steps.
  - World fingerprints cover the elevations, so snapshots and plans from uncleaned ground are
    refused (ADR 0032).
- The in-page cache of prepared terrains is keyed by battlefield id **and** `TERRAIN_MODEL`. It
  cannot hand out a surface prepared by other rules. There is no persistent cache.
- Import corrections carry their version and are ignored by another. The source elevation (the raw
  grid, and the tiles' sources listed in the package) is part of the package id.

### Reporting

`DemQualityReport` gives:

- samples examined, invalid samples, high-confidence anomalies, repaired samples and regions,
  unresolved and suspicious regions;
- the largest correction, the methods, and the version;
- the import stage's counts;
- up to 100 findings. Each has its place, original and cleaned value, the range round it, the
  excursion and step, the method and the largest change.

Battlefield Information shows one line ("Terrain validation complete. 43 elevation anomalies
corrected (largest change 799.3 m).", or "… No elevation errors found."), with the findings folded
under Details. Only unresolved regions add a notice when the battlefield opens; clean terrain
produces no warning. Import warnings list unresolved source regions and seam offsets.

## Results

**Quantico (230, 1240)**, west–east (x = 180 … 280 m) and south–north (y = 1190 … 1290 m) through
the fault:

| Profile                        | Values (m)                                                |
| ------------------------------ | --------------------------------------------------------- |
| West–east, raw (and M4 ground) | 13.7 12.3 9.9 5.0 0.2 **−782.5** 12.8 11.3 10.0 8.7 7.6   |
| West–east, grid check only     | 13.7 12.3 9.9 5.0 0.2 **9.1** 12.8 11.3 10.0 8.7 7.6      |
| West–east, now (pixels + grid) | 13.7 12.3 9.9 5.0 0.2 **16.8** 12.8 11.3 10.0 8.7 7.6     |
| South–north, raw               | 2.7 0.7 1.7 12.2 17.6 **−782.5** 14.9 15.0 14.8 14.4 13.9 |
| South–north, now               | 2.7 0.7 1.7 12.2 17.6 **16.8** 14.9 15.0 14.8 14.4 13.9   |

Details of that sample:

- **Neighbours:** 0.21–17.57 m (the river's edge on one side, the bluff on the other).
- **Classification:** a single-sample pit, high confidence. Excursion 782.69 m against a steepest
  step round it of 16.97 m: 46 times it.
- **Repair:**
  - With the import's corrections: from the source pixels, giving **16.78 m**, which lies on the
    bluff.
  - Packages without them: the grid check, by harmonic interpolation, giving **9.13 m**.
- **Largest change:** 799.26 m (791.61 m with the grid check alone).
- **Origin:** in the source data, not introduced by processing.

Every other sample is unchanged.

All of Quantico:

- **New import:** 43 faulty pixels, 18 samples corrected, and the grid check finds nothing more.
- **Old package (grid check only):** 9 samples repaired, from −20.0 to −782.5 m to between 0.9 and
  11.0 m. None of them is unresolved or suspicious.
- **A second pass** changes nothing.

Grafenwöhr: no faults, no changes, no warnings.

**Performance** (Node, one core; per 501 × 501 grid):

| Step                                    | Quantico  | Grafenwöhr |
| --------------------------------------- | --------- | ---------- |
| Grid check on opening (worker)          | 50–100 ms | 50–85 ms   |
| Grading on opening (worker, ADR 0032)   | ~2.4 s    | ~3 s       |
| Pixel check at import, all tiles (page) | 0.6–0.9 s | 0.6–0.8 s  |
| Whole package build at import (page)    | ~2.3 s    | ~1.7 s     |

- Every pass is linear and bounded: fixed neighbourhoods, connected components by breadth-first
  search, and rings only round candidate regions. Nothing is quadratic.
- The pixel check is about 11–14 ms per 256 × 256 tile. It adds 0.6–0.9 s to the import's existing
  main-thread package build. That is not a new multi-second freeze, but it is not off the main
  thread either.

**In the browser** (headless Chromium, recorded Quantico and Grafenwöhr data, importer 1.2.0):

- **Quantico.**
  - Battlefield Information reads "Terrain validation complete. 43 elevation anomalies corrected
    (largest change 799.3 m)", with the findings under Details.
  - The elevation range reads −5–68 m (it was −782–68 m).
  - The 3D terrain's lowest point is −5.23 m (it was −782.48 m).
  - A close-up at (230, 1240) showed, before, the camera inside the 782 m hole looking up at the
    river's surface; now it shows the wooded bank.
  - No notice is shown.
- **Grafenwöhr:** "Terrain validation complete. No elevation errors found."
- **Worker timings:** DEM cleaning 90–113 ms and grading 1.7–2.2 s, both in the worker.
- **The main thread on opening** is unchanged: a profile shows 2.40 s before and 2.48 s after.
- **The demo** passes the milestone 1 workflow test. Soldiers stand exactly on the terrain, the
  live simulation runs, and AAR scrubbing works in 2D and 3D. The one failure is the existing
  first-frame timing under software rendering (3.13 s against a 3 s limit), on the demo's
  unchanged terrain.

## Consequences and limitations

- **Old packages get the grid check only.** A fault that reached a grid sample only partly (a dip
  under 20 m) stays until the battlefield is generated again. At Quantico, 9 of 18 samples remain
  partly wrong, the worst by 23 m at index 220782.
- **Features one sample wide** and more than twice as deep (or high) as the spacing cannot be told
  from faults. At 10 m that means a 10 m-wide shaft or pinnacle at least 20 m deep or high. The
  10 m grid does not resolve such features anyway.
- **Source raster joins** (steps of a few metres along straight lines) are real disagreements
  between datasets. They are kept: at tile edges they are reported, elsewhere they are not detected.
- **Unresolved invalid regions** are filled by harmonic interpolation so the terrain stays usable.
  They are reported and shown, but not trusted.
- **The import check runs on the page.** Moving the package build into a worker would remove the
  0.6–0.9 s it adds.
- **−0 elevations.** Found while testing, unrelated to this change: Quantico's raw grid has 6,248
  samples of −0 (rounding of tiny negative heights). The package id distinguishes −0 from 0, so a
  JSON round trip (which writes −0 as 0) makes the package fail its id check. IndexedDB keeps −0,
  so stored packages are unaffected. Exporting packages as JSON would need the rounding fixed.

## Deviations from the brief

- **Tile seams** are detected at import, where tile geometry is known. Broken edge lines are
  rebuilt; steady offsets are reported but not corrected, since Terrarium tiles do not overlap and
  nothing says which side is right. Neither occurs at Quantico or Grafenwöhr.
- **The import check** stores corrections beside the raw grid, rather than a second, cleaned grid.
  That keeps the raw grid as provenance and the package small (18 pairs for Quantico).
