# ADR 0046: Water visuals and shoreline smoothing

- Status: Accepted
- Date: 2026-10-12
- Amends ADR 0040 (water grading and shorelines: how water and shores are drawn in 3D). Keeps ADR
  0032 (the terrain surface) and ADR 0040's grading: the ground, its heights and every simulation
  query are unchanged.

## Context

In 3D, Amsterdam's canals looked wrong (the screenshots in `assets/reference/water1.png` and
`water2.png`, and the "before" images in
[`docs/research/water-shorelines`](../research/water-shorelines/)):

1. The water was light and see-through (84 % opaque). The bed showed through it, and the lower
   storeys of canal houses showed through it as a tinted band.
2. Large triangles of dark gravel stood out of the water along the shore, mostly in a sawtooth
   along the walls of canal houses and houseboats.

### What the triangles are

A probe sampled every levelled water area of the recorded Amsterdam battlefield on a 1 m grid
(4.3 million samples) and compared the graded ground with the water's level:

| Ground inside the mapped water     | Share            |
| ---------------------------------- | ---------------- |
| Above the water's level            | 4.9 % (0.21 km²) |
| …of that, within 3 m of a building | 47 %             |
| …within 10 m of a road or path     | 37 %             |
| …in refined (2.5 m) cells          | 98 %             |
| …more than 0.5 m above the water   | 25 %, up to 4 m  |

The DEM is not at fault, and the water polygons are not either. The triangles are **graded
ground standing above the water inside the water's own outline**:

- **Grading conflicts.** Amsterdam's houses stand at the water's edge, and its houseboats are
  mapped as buildings in the water. A building's level pad, and a road's embankment, raise the
  ground (ADR 0032), while the water's bed lowers it (ADR 0040). Where the two overlap, the grading
  settles halfway, above the water. The pad's side slopes on the 2.5 m lattice are the sawtooth
  along the house walls.
- **The lattice at the shore.** Elsewhere the shore is wherever the lattice's triangles cross the
  level. Ground held exactly at the level, and ground at the 5 cm freeboard, showed through the
  water in flecks along the triangles' edges (the dark latticed strips between houseboats and the
  bank).
- **Steep banks.** The grading brings the shore down to the water and lets the bank rise at up
  to 1.5 in 1. Between a canal and a street 2–3 m above it, that bank is narrower than the
  lattice, so seen from the water it is a zigzag of triangles, not a quay.
- **Shore materials** only made it worse. The ground under levelled water is textured as bed
  (shingle and mud), and steep banks as rock, so the protruding triangles were dark gravel.

The water sheet itself had no seams. It is one polygon per area, at one level per standing water
(ADR 0040), and it never intersected the ground wrongly.

## Decision

All of this is display only, in the 3D view. Nothing the simulation reads changes.

### Opaque water, by visual profile

The water is drawn **opaque**. The bed under levelled water is never shown, so its colour is the
water's own, not the ground's seen through it. The colour comes from one of a few visual
profiles (`water-profiles.ts`):

| Profile     | Colour (sRGB) | Shores             | Used for                                                        |
| ----------- | ------------- | ------------------ | --------------------------------------------------------------- |
| Urban canal | `#34433b`     | quays, no shallows | canals, and plain water, ponds and basins with a built-up shore |
| River       | `#384b45`     | natural            | rivers, and canals in open country                              |
| Lake        | `#354a52`     | natural            | lakes, and plain water and basins in open country               |
| Reservoir   | `#334853`     | natural            | reservoirs                                                      |
| Ocean       | `#2d4b5a`     | natural            | the sea                                                         |
| Pond        | `#39473c`     | natural            | ponds; water too small to level                                 |

A shore is built-up when buildings stand within 20 m of it along at least half its length (a
quarter for canals). Amsterdam's canals are mapped as plain `natural=water`, so this is how they
become urban canals, while the same tag in open country (Grafenwöhr's ponds) stays a lake.

The material is still three's `MeshStandardMaterial`, so lighting, shadows, fog and tone mapping
are unchanged. It adds:

- **Restrained sky reflection.** Schlick's Fresnel term (F0 = 0.02, strength 0.75) mixes in the
  haze's colour. Looking down, the water is dark; at grazing angles it is the sky.
- **Rougher water** (0.5, was 0.3), so the sun's glint is a soft sheen, not a white patch.
- **Varied ripples.** Six small sine ripples in the shading normal, each waxing and waning over
  tens of metres so no pattern repeats in view. They fade with distance, as before.
- **Shallows along natural shores.** Within 3 m of a natural shore the water is up to 30 %
  lighter. There are none along quays.

There are no real reflections or refraction: each would cost a render of the scene per frame.

### The shore mask, and the cut

A **shore mask** is computed with the other features in the generation worker (`shoreline.ts`).
It is a grid of 1–2 m over the battlefield (2560 samples a side at most), and holds:

- the signed distance to the nearest shore of levelled water, negative in the water, within
  ±4 m;
- the water's level;
- whether the shore is natural (for the shallows).

The distance comes from the same water query the grading used, so joined water areas are one
water (no shore between them), and islands and holes are land. Where the 3D view already cuts
its water sheet away (under low bridge decks and over roads on a bank, ADR 0044), the water is
taken out of the mask too.

The **terrain's material discards** every pixel that is more than 30 cm inside the water and
stands more than 2 cm above its level. What is left of the water sheet covers the hole, and the
land ends exactly at the mapped shore. The distance is filtered, so straight shores stay
straight; the level is fetched exactly. Ground under the water, and all ground ashore, is drawn
as before.

### Shore walls: quays and banks

The cut is closed by walls along the mask's contour, 30 cm inside the water (marching squares).
They are generated as follows:

- **Chained and simplified.** Crossings are keyed by grid edge, chained into polylines and
  simplified (Douglas–Peucker, 5 cm), so a straight shore is one straight wall.
- **Quays on built-up shores.** A vertical brick wall reaches from the street behind it down to
  0.5 m below the water, with a darker damp band 0.3 m above the water. Its top is the highest
  ground within 2.5 m behind it (and a metre to either side), so it is level across the steep
  bank the lattice makes. A coping strip of paving runs from the top back to the ground, 2 m
  behind the wall. A built-up shore gets a quay wherever the street behind it stands at least
  25 cm above the water.
- **Banks elsewhere.** A short earth bank slopes into the water, only where the ground at the
  shore stands above it. Its top follows the ground exactly: each piece is split where it
  crosses the terrain's lattice rows, columns and diagonals.

All quays share one mesh and material, and all banks another (two draw calls). Both are textured
in world space (`wall-brick.jpg` and `ground-earth.jpg`, which are already in the repository) and
drawn double-sided, so a sliver at the top of a wall never shows through.

On land, the ground map no longer paints beach, shingle or rock bands, or the damp band, along
built-up shores. They end in a quay, not a beach.

### Buildings and bridges

- **Buildings in or at the edge of levelled water** take their walls down to 0.6 m below the
  water. A canal house or houseboat now rises out of the water instead of floating on the
  (now cut) pad or showing through the water. Its footprint, roof and height are unchanged.
- **Bridge piers and abutments** go down to the water where the ground under them is cut.
- **Roadside props** (fences, posts) standing on cut ground are left out.
- **Vegetation already avoided water.** The water stays under bridges as before (ADR 0044).

### Simulation isolation

The authoritative terrain, the DEM, the grading, `heightAt`, LOS, movement, pathfinding,
viewsheds and the 2D map are untouched. The cut is a fragment shader; the walls, mask and
profiles are display geometry in the feature worker; nothing in `src/sim` changed. A test builds
the 3D shoreline and features for a graded terrain and checks that the terrain's fingerprint, its
heights, a line of sight, a path and a viewshed are identical before and after.

Picking still uses the graded ground (`terrainGround`). Where ground is cut away above the water,
a click there picks the ground's height, as before, though the water is drawn.

## Measurements

The recorded central Amsterdam battlefield (5 km square), in Google Chrome with its default
memory limits, on an AMD Radeon 880M (integrated GPU, Direct3D 11 through ANGLE). This is real
GPU rendering, not software WebGL:

|                                             | Before  | After                                    |
| ------------------------------------------- | ------- | ---------------------------------------- |
| Draw calls (overview)                       | 36      | 38 (quays, banks)                        |
| Triangles drawn (overview)                  | 24.38 M | 24.75 M (+378 k shore walls, 1.5 %)      |
| Geometry                                    | 1586 MB | 1633 MB (+47 MB, 3 %)                    |
| Shore mask texture                          | —       | 25 MB (2560², RGBA8)                     |
| Wall textures                               | —       | 2 (already in the repository)            |
| Feature generation in the worker            | 24.4 s  | 26.6 s (+2.3 s: mask 1.1 s, walls 0.5 s) |
| First frame showing the features            | 412 ms  | 473 ms                                   |
| Highest main-thread heap                    | 2068 MB | 2144 MB                                  |
| Opened in Chrome without a crash (ADR 0045) | yes     | yes                                      |

The shoreline has 158 km of quays and 42 km of banks; the cut covers 0.12 km² (120,000 mask
samples). Frame times were not measured. Headless Chrome caps the frame rate at the display's
refresh, and the additions are two draw calls and two texture reads per terrain pixel.

Quantico (the Potomac, ponds, creeks), Grafenwöhr (natural ponds) and the demo were checked
before and after. Their natural shores have no quays and keep their soft shores, the lakes are
lake-coloured (not canal-coloured), small streams are only recoloured, and bridges are intact.
There were no console errors anywhere.

Screenshots are in [`docs/research/water-shorelines`](../research/water-shorelines/): before
and after from the same cameras.

- **v8, v9:** the houseboat triangles of `water2.png`.
- **v4:** a road beside a canal.
- **v3:** a steep embankment.
- **v5:** a bridge.
- **v6:** a canal intersection.
- **v7:** overhead.
- **v11:** a quay at water level. `interim-…-v11` shows the zigzag bank before quays were given
  level tops.
- **The regression battlefields.**

## Limitations

- **The grading conflicts remain in the authoritative ground.** A soldier standing on a cut
  houseboat pad is at the pad's height, a little above the water drawn there. Fixing it belongs
  in the grading (`sim/grading.ts`), which this milestone was not to change.
- **Mask resolution.** At about 2 m a sample on a 5 km battlefield, corners sharper than about
  90° are rounded by up to a sample, and water narrower than about 4 m is not cut. The 30 cm
  inset keeps the cut inside the water sheet.
- **Built-up is inferred from buildings alone.** A rural shore with a building on it gets a short
  quay; an urban shore with no building within 20 m (a park) gets earth banks. OSM's
  `man_made=quay` and `wall` tags are not used: they are not in the battlefield package.
- **Quays where the source data conflicts.** Where a road is mapped overlapping the water (not a
  bridge), its edge can hang over the cut, and the coping can cover a road's outer few
  centimetres along a canal.
- **Shadows on water.** Cut ground does not cast shadows (the terrain casts none), but buildings
  standing in water do. The water is not depth-tinted: being opaque, it has one colour per
  profile, lighter only in natural shallows.
- **Picking** on cut ground returns the ground's height, not the water's.
