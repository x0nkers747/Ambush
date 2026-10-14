# ADR 0051: Realistic trees

- Status: Accepted (phase 1, shading; phase 2, photographic textures; phase 3, structure, to do)
- Date: 2026-10-13
- Builds on: [ADR 0049](0049-terrain-field-ground-and-renderer.md) (the procedural trees and
  their foliage atlas)

## Context

The 3D view's trees (`view3d/tree-models.ts`, `forest.ts`, `foliage-atlas.ts`) looked flat and
plain at close range. Captures of Quantico showed three causes:

1. **Shading.** No light passed through the leaves, so a wood seen towards the sun was nearly
   black. Each crown was lit as one smooth ball (every card took the crown's outward normal).
   Crowns were barely darker inside, and the exposure crushed the shadows.
2. **Art.** The leaf clusters and barks are drawn in the browser at start-up: flat-coloured
   vector leaves with hard cut-out edges, no surface detail, one dark bark.
3. **Structure.** Sparse crowns of cards on thin limbs, an open canopy from above, straight
   uniform trunks.

They are taken in that order: shading first (no assets), then photographic textures, then
structure (denser crowns, impostors for distant trees).

## Decision: phase 1, shading

All in the foliage material (`forest.ts`) and the leaf colours (`tree-models.ts`), so the
cost is a few shader instructions per leaf pixel.

1. **Card normals.** Each leaf pixel's normal mixes the crown's outward normal with its card's
   own facing (from screen-space derivatives, turned to the crown's side):
   `CARD_NORMAL_SHARE` = 0.45. At 0 the crown is one smooth mass; much above 0.5 the cards'
   facets show.
2. **Sunlight through leaves.** Added after the sun's light in Three.js's light loop
   (`foliageLights()`), with the sun's shadow already applied, so shadowed leaves get none:
   `through` (looking towards the sun, a cubed lobe) 2.6, `back` (the crown's shaded side)
   0.5, `tint` (linear, × the leaf's colour) (1.1, 1.25, 0.45), yellow-green. At 1.1 / 0.35 it
   was too faint.
3. **Sheen.** Foliage roughness 0.74 (was 0.85). At 0.62 the pale sky's reflection turned
   distant crowns milky grey.
4. **Darker crowns.** A card's colour is scaled by
   `0.42 + 0.58 × min(1, 0.55 × inner + 0.45 × t)^1.3` (`leafColour`; was `0.64 + 0.36 × …`),
   darker into the crown and towards its foot.
5. **Exposure.** `renderer.toneMappingExposure` 0.8 (was 0.6), ACES filmic, in `view.ts`. This
   affects the whole 3D view. 0.85 made towns and fields slightly bright from the air. AgX
   tone mapping at 1.0 washed everything grey.

### Not done

- **Ambient occlusion** (`GTAOPass`, `SSAOPass`). Both redraw the scene with an override
  material for depth and normals: leaf cards would lose their alpha cut (dark squares), and
  the terrain's vertex shader (CDLOD morphing) would not run, so its depth would not match.
  It needs our own depth/normal prepass.
- **Image-based lighting** (an environment map of the sky). The hemisphere light stays.

### Tuning later

The constants above are the knobs; before/after captures used `scratchpad/pw/shoot.mjs` with
cameras at Quantico (local metres: name x y distance pitch azimuth):

```
t1-edge-eye     188 420  25  6  90
t2-edge-near    250 934  45 18   0
t3-inside-eye  -784   0  15  5   0
t4-edge-mid     188 420  80 25  90
t5-canopy-above -784 50 150 45   0
t6-backlit      188 420  25  6 270
q2-river        230 -416 600 45  0   (exposure check on the town)
```

Ideas not yet tried: a per-species translucency (thin leaves such as maple and beech glow more
than oak; needles little), a wrap term on the sunlit side, and a slight blue shift for
shadowed leaves (sky fill).

## Decision: phase 2, photographic textures

The atlas keeps its layout and its procedural clusters; photographs replace what is drawn in
them (`foliage-atlas.ts`; sources in `view3d/textures/foliage/CREDITS.md`, prepared by
`tools/foliage-textures.mjs`).

1. **Leaves.** A sprite sheet of single photographed leaves (CC0, ambientCG), cut out by their
   opacity maps, turned stalk-first, colour-matched per leaf to the species' colour. Each
   cluster is laid out as before (twigs, leaves along them, back ones darker), stamping a
   random leaf of its species. Each leaf is pre-shaded in five steps,
   `SPRITE_SHADES` = 0.72–1.22, back to front. At 0.66–1.14 the woods were darker than the
   drawn leaves and glowed less when backlit. The cedar's sprays are laid out the same way
   (`CEDAR_SPRAYS`). Pine needles, holly, ferns and twigs stay drawn: no suitable CC0
   photographs.
2. **Barks.** Tiling photographs with OpenGL normal maps, `BARK_REPEATS` = 2 per cell. Each
   bark cell's margins continue the tiling, so the texture wraps without a seam. The drawn
   barks did not tile: every 3 m trunk segment showed a joint.
3. **Normal map.** A second atlas (1024 px) of the barks' normals, flat on the leaves, as the
   foliage material's `normalMap`. The tangent frame is rebuilt round the chosen normal
   (Three.js builds it before the crown/card normal replaces it). Bark cells take neither the
   card normals nor light through leaves (`barkUvTest`).
4. **Loading.** The drawn atlas is shown at once. The photographs (about 1.7 MB) replace it
   when decoded, updating the same textures in place. If they cannot be loaded, the drawn
   atlas stays and a warning is logged.

### Phase 2: what it changed

- **Trunks:** much better. Furrowed bark with relief, and no joints.
- **Leaves:** more natural shapes and colour within each cluster, mostly visible within about
  20 m.
- **Mid-distance and overhead:** almost unchanged. There a crown's shape and density dominate,
  not its leaves: that is phase 3.

### Tuning later (phase 2)

- Leaf sets, colours, sprite length (160 px): `LEAVES` and `SPRITE_LEN` in
  `tools/foliage-textures.mjs`, then rerun it (ambientCG 2K-JPG zips unzipped per asset).
- Brightness of leaves in a cluster: `SPRITE_SHADES`.
- Bark scale: `BARK_REPEATS` (and the trunk's own texture coordinates in `tree-models.ts`,
  which map one cell round the trunk and down each segment whatever its girth).
- Not yet tried: leaf normal maps (they would need rotating with each stamped leaf), and a
  per-species bark (only three barks for all the species now).

## Decision: phase 3, structure (in progress)

**EZ-Tree evaluated, not adopted.** `@dgreenheck/ez-tree` 1.1.0 (MIT, Three.js ≥ 0.167) grows
convincing branch structures, but its trees are 14,000–23,000 triangles against our 300–700, and
the near band holds thousands of trees (the high preset drew about 3.5 million triangles in a
Quantico wood). Its leaf textures have no stated source. Its approach (limbs forking towards
the crown, leaves at the branch ends) is used in our own models instead.

**Step 1: broadleaf crowns held by their limbs** (`tree-models.ts`, forms `round`, `oval`,
`column`). Before, each clump's cards were scattered over a sphere about half the crown's radius
across, so some floated free of any branch, and each clump was sparse. Now:

1. Each clump's limb (from the trunk, bending up) and 3–4 forks are worked out at every level
   (drawn at the near one only), and the cards grow round the limb's end and the forks' tips,
   a little back along each twig.
2. Forks spread outwards and fairly level (`outward` 0.6, rise −0.1 to 0.35), 0.75–1.25 of the
   clump's radius long, so open-grown crowns are broad. Clumps reach lower (8–90% of the crown).
3. More cards: `LODS` near 1.1 × the species' cards (was 0.65), card scale 1.1 (was 1.22);
   medium 0.5 (was 0.34), scale 1.6 (was 1.8).

Cost: a near broadleaf tree is 760–990 triangles (was 570–720), a medium one 190–240 (was
140–190). A Quantico wood view drew 3.72 million triangles (was 3.55), with the same draw calls.

**Step 2: impostors for the far level** (`tree-impostors.ts`). The far level's few cards showed
each leaf cluster at four times its size, so a distant wood looked like giant yellow-green
leaves (the speckled woods seen from a kilometre or more). Near and medium levels looked alike at
400 m and 1,000 m; only the far level differed.

1. **Photographs.** Each species present (variant 0, near level) is photographed from
   `IMPOSTOR_GRID`² = 36 directions over the upper half-sphere (a hemi-octahedral grid), at
   `IMPOSTOR_PX` = 48 px, into one layer of a half-float texture array (linear light, before
   tone mapping). About 0.9 MB of video memory per species, with mipmaps (17 MB for all 19).
2. **Lit as in the game.** The sun does not move, so the photographs are lit by the scene's sun
   and sky with the foliage material (light through leaves included) and its own shadows.
   Each tree is photographed among invisible copies of itself that only cast shadows
   (`NEIGHBOUR_SPACING_M` 6.5 m out to `NEIGHBOUR_REACH_M` 30 m): alone in the sun, the
   impostors were about twice as bright as a near wood.
3. **No holes.** Each photograph is drawn `SUPERSAMPLE` = 4 times larger and averaged down
   (premultiplied), so leaves give partial coverage. Point-sampled, a crown came out as
   scattered dots.
4. **Drawn** as one quad per tree facing the camera, scaled by the tree's height and (widened)
   width, blending the four nearest photographs; fog, tone mapping and the tree's tint apply.
   Pixels under `IMPOSTOR_CUT` = 0.22 coverage are not drawn (0.32 left woods thin; 0.18
   brightened crown edges). Far trees keep one orientation (their photographs are lit for it),
   and cast no shadow, as before.
5. **When.** Baked once the leaves' photographs are in (about 20 ms per species). If the bake
   fails, the far level's cards stay. The view passes its renderer and lights to the forest.

At about a kilometre the impostors are near the full models' tone, a little greener and
smoother (a tuning knob: a colour correction in the impostor shader). Draw calls and
triangles are unchanged or lower (two triangles a tree instead of about twenty).

**Step 3: pines** (forms `pine`, `scrubPine`). A loblolly was a bare pole with a few tufts on
sticks at the top. Now its branches grow in 8 whorls of 3 (a Virginia pine's, 26, at random
heights), lower ones level or drooping and upper ones rising, each with two side branches; the
needle tufts grow along the outer 60% of every branch, worked out at every level as for the
broadleaves. Cards: loblolly 190 (was 120), Virginia pine 170 (was 120); near models 976 and 884
triangles. The red cedar (`cone`), already a dense cone, is unchanged.

**Step 4: closer woods and flared trunks.**

- Woodland trees are spaced 1.25 × their crown radius (conifers 1.45; were 1.4 and 1.6), still
  at least 4.2 m apart (`vegetation-placement.ts`, `PLACEMENT_VERSION` 3). Many trees were
  already at the minimum, so a Quantico wood view drew 7–10% more trees and 2% more triangles;
  the canopy from above is a little more closed. Placement changed, so existing battlefields
  grow slightly different woods.
- Trunks of trees (radius 0.2 m or more, taller than 4 m) flare at the ground: 1.45 × their
  radius at the foot, narrowing over about a metre (`tree-models.ts`).

### Phase 3: still to do

- A bark per species (three barks serve all the species now).
- Forest density matched to a closed canopy where the woods are mapped as closed.

### Tuning later (phase 3)

A throwaway lab page was used: each species alone and a mixed stand, lit as the game, rendered
in Chrome. To rebuild it: a page that calls `createFoliageMaterial()` (`forest.ts`) and builds a
mesh per `treeModels()` level, as the forest does.

## Consequences

- Woods seen towards the sun glow where the sun reaches; crowns show their clusters and depth.
- Trunks show photographed bark. The game downloads about 1.7 MB more, once, and draws the
  atlas a second time at start-up when the photographs arrive.
- The brighter exposure changes every 3D picture a little (ground, water, buildings).
- A change in Three.js's light loop chunk makes `foliageLights()` throw at shader compile,
  rather than silently dropping the translucency.
