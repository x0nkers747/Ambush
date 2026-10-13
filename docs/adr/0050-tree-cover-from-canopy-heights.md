# ADR 0050: Tree cover from canopy heights

- Status: Accepted (off by default: a switch on the terrain selection page)
- Date: 2026-10-13
- Supersedes: the dormant tree cover file hook of [ADR 0049](0049-terrain-field-ground-and-renderer.md),
  section 9. The NAIP imagery classifier (`tools/tree-cover.ts`) stays, as a research tool.

## Context

OpenStreetMap maps most large woods but few small ones, tree lines, garden and street trees. Those
matter to an ambush: they hide soldiers and block sight. A NAIP imagery classifier found them on
Quantico (ADR 0049), but NAIP covers only the United States, and the free high-resolution imagery
elsewhere is a patchwork of national programmes with different bands, licences and access.

Meta and the World Resources Institute publish a global canopy height map (CHMv2: about 1.2 m,
from satellite imagery, CC BY 4.0) as one Cloud Optimized GeoTIFF per zoom-10 Web Mercator tile.
A copy on Source Cooperative (`data.source.coop/tge-labs/meta-chm-v2/chm/`) allows cross-origin
range requests, so a browser can read the part of a tile it needs. The original AWS bucket does
not allow cross-origin requests. On Quantico, cells 4 m or taller covered 95–97% of the mapped
woods and only 3.4% of mapped open ground, against NAIP level 3's 15% by design. The extra woods
it found were nearly all also found by NAIP (93%), with tighter crowns. Its imagery was about
8 m south and 4 m west of NAIP and of the mapped woods, which is typical of oblique satellite
imagery.

## Decision

1. **Where.** With tree cover on (`ServiceConfig.treeCover: 'canopy'`, a checkbox remembered in
   the service settings), generating a battlefield adds a step after OpenStreetMap. The step reads
   the canopy map over the battlefield: each tile's header (about 120 kB) and the 512-pixel
   blocks under the battlefield, about 8 MB for 5 km (`acquire/canopy.ts`). A failure only
   leaves the woods out, with a warning.
2. **How** (`geo/canopy.ts`, pure and deterministic).
   - The heights are put on the battlefield's 1 m grid.
   - They are lined up with the mapped woods: the shift up to 16 m that best overlaps them.
     Without 2 ha of mapped woods, the map is used as published.
   - Cells 4 m or taller are trees. Lines one or two cells wide (masts, wires) are removed.
   - Trees within 4 m of mapped vegetation, or on buildings, roads, water or paved ground, are
     left out.
   - The rest are traced into woods (`geo/woods.ts`, shared with the NAIP tool): at least
     40 m², with clearings of 400 m² or more.
   - Each wood's canopy height is the upper quartile of its cells'. Its see-through depth is
     25 m, an estimate for a mixed broadleaf wood.
3. **What is kept.** The woods join the terrain's vegetation, so the simulation and both views
   use them like mapped woods. The package records how they were made (`treeCover`: tiles, shift,
   agreement, woods and area) and credits the map. The canopy windows are stored, compressed, with
   the battlefield's sources for reprocessing. Importer 1.10.
4. **Where it is shown.** Battlefield Information gives a line saying how many woods were added,
   how far the map was moved and how much of the mapped woods it found.

## Consequences

- **Cost.** About 8 MB more to download and a few seconds of work when generating a battlefield.
  Opening a battlefield costs nothing more.
- **Coverage.** The map is global. Its imagery is a few years old: 2019–2020 for Quantico.
  Per-tile dates are published in a Parquet index this version does not read. A wood felled since
  is still shown; one planted since is not.
- **Errors.** Masts, cranes or tall buildings missing from the map data could be taken for trees.
  Thin lines are removed, but a solitary mast block is not. Battlefields far from any mapped
  wood are not lined up, and their added woods may be several metres out (a warning says so).
- **Off by default** until it has been checked on more places. Existing battlefields keep their
  woods. Regenerating one with tree cover on adds them.
