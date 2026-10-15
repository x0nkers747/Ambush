# Ambush!

A real-time, interactive and deterministic force-on-force constructive
simulation: any number of BLUEFOR and OPFOR squads, each following a plan of
typed orders (Move, Attack, Withdraw) and reacting to contact on its own, fight
on real-world or synthetic terrain. The user sets the scenario up, plans
BLUEFOR, commands either side live during combat, and reviews the whole battle
afterwards, replayed from its start and verified
([docs/constructive-simulation](docs/constructive-simulation/README.md)). A
deterministic, headless-capable simulation drives a 2D tactical view and a 3D
(Three.js) observer view.

Status: **real-world terrain** ([ADR 0014](docs/adr/0014-real-world-terrain-import.md)): any
5 × 5 km area between 80° S and 84° N can be generated from OpenStreetMap, Overture Maps
buildings ([ADR 0023](docs/adr/0023-overture-buildings.md)) and freely available elevation
data, saved in the browser and played offline. A
**3D view** ([ADR 0029](docs/adr/0029-3d-view-milestone-1.md),
[ADR 0030](docs/adr/0030-3d-geographic-features.md),
[ADR 0031](docs/adr/0031-3d-procedural-vegetation.md)) shows the same battlefield and soldiers
on the simulated terrain, with its roads, buildings, water, forests, tree lines and scrub, and
the ground coloured by land cover: switch with **2D | 3D** under the map; drag to pan, as in
2D, right-drag to orbit, use the wheel to zoom and double-click to focus. Soldiers hidden by trees or
buildings show through as dim silhouettes. The ground is a terrain field: the elevation data with
roads (level across, smoothed along, blended at junctions), bridge decks, building pads, ditches,
stream channels and water beds built in as constraints. The simulation samples it on a 1 m
lattice wherever it has detail, and the 3D view draws the same field, so the 2D map, the 3D view,
movement, line of sight and replay all use one ground
([ADR 0049](docs/adr/0049-terrain-field-ground-and-renderer.md)). Faulty elevation samples in the
source data (voids, spikes, no-data values) are found and repaired first, real cliffs and
ravines are left alone, and Battlefield Information reports what was found
([ADR 0033](docs/adr/0033-dem-quality-validation.md)). Buildings in 3D are procedural: gable,
hip, shed and flat roofs on rectangles and L/T plans, textured walls and roofs at real scale,
windows, and doors facing the nearest road, styled for the battlefield's region (North American
or central European) from the source's building tags where it has them. They are display only:
the simulated building heights, line of sight, the ground and movement are unchanged
([ADR 0035](docs/adr/0035-procedural-buildings.md)). Around them the 3D view draws paths and
driveways to front doors, street lamps in built-up streets, utility poles, fences, walls
and front-garden hedges, roadside and garden trees, and a few signs and mailboxes: mapped
OpenStreetMap details where they exist, inferred from context elsewhere, all decorative and never
part of the simulation ([ADR 0036](docs/adr/0036-procedural-environmental-detail.md)). Roads carry
painted markings where real roads would (centrelines, lane separators, edge lines, mapped crossings
and stop lines), in the region's conventions: yellow centrelines in North America, white in
Germany, and none on residential streets, service roads or tracks
([ADR 0037](docs/adr/0037-road-markings.md)). In 3D the ground is drawn in tiles down to
0.5 m near the camera, with physically based materials (CC0) chosen per pixel from the field:
asphalt, gravel and dirt roads with straight edges and shoulders, paved streets and yards in towns
([ADR 0048](docs/adr/0048-paved-ground-and-parks-from-osm.md)), grass in several kinds, forest
litter, mud and sand at shores, damp ditches and rock on steep slopes, with grass, weeds and
pebbles near the camera. Woods are drawn as trees of the Quantico area (oaks, maples, tulip
poplars, pines and others) in several sizes and shapes, with shrubs and ferns under them
([ADR 0049](docs/adr/0049-terrain-field-ground-and-renderer.md)). Every stage can be used in
either view, or switching between them at any moment: placing and turning squads, giving
orders, selecting and commanding squads in combat, and reviewing; the 3D view only projects the
same tools onto the ground ([ADR 0039](docs/adr/0039-2d-3d-functional-parity.md)). Open water is levelled into the
ground: the sea at 0 m, each lake, reservoir and pond at one exactly horizontal level from its
shoreline, and rivers and canals at least 8 m wide level across and falling smoothly downstream.
The ground under the water is a shallow bed, and the banks rise from the water's level; shores
get sand, shingle or mud by the kind of water
([ADR 0040](docs/adr/0040-water-grading-and-shorelines.md)). Every road mapped as a bridge has a
deck that continues the road, with parapets and abutments; the ground is kept clear under it, and
soldiers cross on the deck that is drawn
([ADR 0043](docs/adr/0043-bridge-and-road-navigation.md),
[ADR 0049](docs/adr/0049-terrain-field-ground-and-renderer.md)). In 3D the water is opaque and
dark, coloured by a visual profile (urban canal, river, lake, reservoir, ocean, pond) with a
restrained sky reflection ([ADR 0046](docs/adr/0046-water-visuals-and-shoreline-smoothing.md)).

A new battlefield also gets the woods,
tree lines and garden trees OpenStreetMap does not map, from the Meta / World Resources Institute
global canopy height map (about 1 m, CC BY 4.0). The map is lined up with the mapped woods first,
and the woods added are listed in Battlefield Information
([ADR 0050](docs/adr/0050-tree-cover-from-canopy-heights.md)). `tools/tree-cover.ts` finds woods in
USGS NAIP aerial imagery instead (United States only), for comparison.

## Requirements

- Node 24 (see `.nvmrc`) and npm
- Chrome or Edge on a Windows desktop

## Getting started

```sh
npm install
npm run dev
```

**Behavior Lab:** http://localhost:5173/#behavior-lab, a page for watching and measuring
organizations moving in formation on their own orders, through a seeded urban district (or open ground,
`?ground=open`) ([docs/behavior-lab](docs/behavior-lab/README.md)).

**Force-on-Force Lab:** http://localhost:5173/#force-on-force, an experimental constructive
simulation of two organizations that move, detect each other, engage and reach an adjudicated
outcome (press **Run the default demonstration**;
[docs/behavior-lab/force-on-force](docs/behavior-lab/force-on-force/README.md)). Not part of the
game: its parameters are experimental, not validated combat data.

It is also published to GitHub Pages, at https://x0nkers747.github.io/Ambush/, on every push to
`main`: see [docs/GITHUB_PAGES_DEPLOYMENT.md](docs/GITHUB_PAGES_DEPLOYMENT.md).

## The workflow: Terrain, Setup, BLUEFOR, Combat, AAR

Run `npm run dev` and open the printed URL (http://localhost:5173) in Chrome or Edge. Ambush! is
one five-stage workflow ([ADR 0025](docs/adr/0025-five-stage-workflow.md),
[docs/constructive-simulation](docs/constructive-simulation/README.md)). The header always shows
the current stage, its number out of five, and **‹ Previous** and **Next ›** arrows. A blocked
Next says what is missing, and the side panel says the same next to the stage's primary button.

1. **Terrain.** Search for a place, enter a latitude and longitude in decimal degrees (e.g.
   `38.5223`, `-77.2934`; pasting "lat, lon" into the first field works), or use your current
   position; then **Generate battlefield**. The new battlefield is then selected and previewed on
   the map, so you can check it before **Open battlefield**. **Cancel** stops it; buildings come
   from Overture Maps, or from OpenStreetMap when Overture cannot be reached; if OpenStreetMap is
   unavailable you can retry or continue without it. Or select a **saved battlefield** (no
   network needed; double-click to open it; the bin beside it deletes it, on a second click): it
   is previewed with its scenario's squads and plans, and opens with **Open battlefield**.
   **3D** on the preview's map bar shows the terrain in 3D.
2. **Scenario Setup** ([docs/constructive-simulation/03](docs/constructive-simulation/03-scenario-setup-and-planning.md)).
   Place BLUEFOR and OPFOR squads, fire teams and three-man elements (**P**, or the Place
   buttons), one per click. Drag a squad to move it and the white knob to turn it; rename it,
   change its organization or formation in the side panel. Soldiers that would stand in water or
   a building step out to the nearest clear ground. Give OPFOR its plans: select an OPFOR squad,
   press **M**, **A** or **W** (Move, Attack, Withdraw) and click the map once per order. The
   scenario (with its seed) is saved as you edit; **Export…** / **Import…** move it as a file,
   and an older ambush scenario is converted on opening.
3. **BLUEFOR Planning.** Give BLUEFOR's squads their plans the same way. OPFOR is shown read-only,
   or hidden with **Show OPFOR**. Drag a waypoint to move it, right-click it to delete it;
   change an order's kind, order and deletion in the plan list.
4. **Combat** ([docs/constructive-simulation/04](docs/constructive-simulation/04-combat.md)). The
   battle starts paused: **Space** plays and pauses, ½× to 32× sets the speed. Select any squad,
   of either side, and give it orders live: **M**, **A** or **W**, then click; **Replace plan**
   or **Append** (Shift for the other, for one click); **H** holds. With an order tool, clicking
   an enemy squad targets it. Orders given while paused apply when play resumes. The battle never
   ends by itself: **End combat** ends it.
5. **After-Action Review** ([docs/constructive-simulation/05](docs/constructive-simulation/05-after-action-review.md)).
   The battle is replayed from its start by re-simulation and every second verified against the
   battle fought. Play, pause, ±5 s, jump to markers (contact, casualties, squads combat
   ineffective or withdrawn, your orders), drag the timeline; select a squad to see its state,
   orders and phases at that moment. **Export recording** saves a file that reproduces the
   battle exactly. **Back to BLUEFOR Planning** fights it again.

Battles are simulated in a background worker, so the map keeps drawing at full frame rate
whatever a battle costs.
Reloading the page returns to Setup or Planning (a battle is not stored).

**Battlefield Information**, collapsed at the bottom of the side panel, lists each battlefield's
sources, their resolution and accuracy, and the credits their licences require. Service endpoints can be changed per browser: see
[ADR 0014](docs/adr/0014-real-world-terrain-import.md#data-sources-and-services).

## Scripts

| Script                 | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `npm run dev`          | Start the Vite dev server                               |
| `npm run build`        | Type-check all layers, then build for production        |
| `npm run typecheck`    | `tsc -b` across all layer projects                      |
| `npm run lint`         | ESLint, including the layer boundary rules              |
| `npm test`             | Run unit tests (Vitest, Node)                           |
| `npm run test:watch`   | Run tests in watch mode                                 |
| `npm run format`       | Format with Prettier                                    |
| `npm run format:check` | Check formatting                                        |
| `npm run check`        | typecheck + lint + test + format:check                  |
| `npm run sim:headless` | Run headless, e.g. `-- --rate 30 --seconds 10 --seed 0` |

Development tool: with `npm run dev` running, `/symbols.html` previews every individual soldier
icon (all roles, affiliations, sizes and facings) and live tactical maps drawn by the production
renderer, including crowded and mixed-affiliation decluttering
([ADR 0013](docs/adr/0013-individual-soldier-icons.md)).

## Architecture

The code is split into layers whose boundaries are enforced by the compiler and
ESLint. Other layers are imported only through their alias (`#sim`, `#exercise`,
…), never by relative path.

```
src/sim       simulation (no DOM, no Node, no Three.js, deterministic)
src/exercise  phases, plans, revisions, runner, scenarios  -> sim
src/geo       geographic processing (pure: UTM, DEM, OSM)  -> sim
src/acquire   geographic services, IndexedDB (browser)     -> sim, geo
src/session   ephemeral UI state                           -> sim, exercise
src/view2d    2D tactical view                             -> sim, exercise, session
src/view3d    3D observer view (Three.js)                  -> sim, exercise, session, geo
src/app       composition root                             -> all
tools         Node command-line tools                      -> sim, exercise, geo
```

Decisions are recorded in [`docs/adr`](docs/adr):

1. [Layers and boundary enforcement](docs/adr/0001-layers-and-boundaries.md)
2. [Coordinates, units and azimuth](docs/adr/0002-coordinates-units-azimuth.md)
3. [Fixed timestep with a configurable tick rate](docs/adr/0003-fixed-timestep-configurable-rate.md)
4. [State kinds and the command path](docs/adr/0004-state-kinds-and-command-path.md)
5. [Recording-based replay and AAR](docs/adr/0005-recording-based-aar.md)
6. [Terrain dataset and georeference](docs/adr/0006-terrain-dataset-and-georeference.md)
7. [Simulation kernel](docs/adr/0007-simulation-kernel.md)
8. [Terrain heightfield and waypoint movement](docs/adr/0008-terrain-and-movement.md)
9. [Exercise phases, plan revisions and the 2D planning view](docs/adr/0009-exercise-and-planning-view.md)
10. [Ambush exercise flow, kill zone and trigger](docs/adr/0010-ambush-exercise-flow.md)
11. [Tactical environment, path planning and line of sight](docs/adr/0011-tactical-environment.md)
12. [Doctrinal organization, ORP and single-destination deployment](docs/adr/0012-organization-orp-and-single-destination-planning.md)
13. [Custom individual soldier icons](docs/adr/0013-individual-soldier-icons.md)
14. [Real-world terrain import (1 km battlefields)](docs/adr/0014-real-world-terrain-import.md)
15. [Three-stage workflow and scenario editing](docs/adr/0015-three-stage-workflow-and-scenario-editing.md)
16. [Navigation performance on 5 km battlefields](docs/adr/0016-navigation-performance-5-km.md)
17. [Tactical map rendering on 5 km battlefields](docs/adr/0017-map-rendering-performance-5-km.md)
18. [The selected Marine's weapon engagement wedge](docs/adr/0018-weapon-engagement-wedge.md)
19. [Combat v1: probabilistic two-sided engagements](docs/adr/0019-probabilistic-engagements.md)
20. [Viewsheds on 5 km battlefields](docs/adr/0020-viewshed-performance-5-km.md)
21. [The trainee triggers the ambush](docs/adr/0021-manual-ambush-trigger.md)
22. [Fire-team formation planning](docs/adr/0022-fire-team-formation-planning.md)
23. [Buildings from Overture Maps](docs/adr/0023-overture-buildings.md)
24. [Spot heights on the tactical map](docs/adr/0024-spot-heights.md)
25. [The five-stage workflow](docs/adr/0025-five-stage-workflow.md)
26. [After Action Review replay](docs/adr/0026-aar-replay.md)
27. [After Action Review scoring and recommendations](docs/adr/0027-aar-scoring.md)
28. [OPFOR reactions under fire, and escape by distance run](docs/adr/0028-opfor-reactions-and-escape.md)
29. [The 3D battlefield view, milestone 1](docs/adr/0029-3d-view-milestone-1.md)
30. [Geographic features in the 3D view](docs/adr/0030-3d-geographic-features.md)
31. [Procedural vegetation in the 3D view](docs/adr/0031-3d-procedural-vegetation.md)
32. [One authoritative, graded terrain](docs/adr/0032-authoritative-graded-terrain.md)
33. [DEM quality validation and repair](docs/adr/0033-dem-quality-validation.md)
34. (Not used: the number planned for visual milestone A, recorded as ADR 0035.)
35. [Procedural buildings and richer OSM building data](docs/adr/0035-procedural-buildings.md)
36. [Procedural environmental detail](docs/adr/0036-procedural-environmental-detail.md)
37. [Road markings, and no overhead wires](docs/adr/0037-road-markings.md)
38. [Terrain materials and surface realism](docs/adr/0038-terrain-materials.md)
39. [Complete 2D/3D functional parity](docs/adr/0039-2d-3d-functional-parity.md)
40. [Water surface flattening, shorelines and beaches](docs/adr/0040-water-grading-and-shorelines.md)
41. [Procedural road bridges](docs/adr/0041-procedural-road-bridges.md)
42. [Viewsheds limited to the firing arc](docs/adr/0042-viewshed-in-the-firing-arc.md)
43. [Bridge crossing and OPFOR road following](docs/adr/0043-bridge-and-road-navigation.md)
44. [Road junctions, grade separation and bridge structures](docs/adr/0044-road-junction-and-bridge-topology.md)
45. [Memory on large battlefields](docs/adr/0045-memory-on-large-battlefields.md)
46. [Water visuals and shoreline smoothing](docs/adr/0046-water-visuals-and-shoreline-smoothing.md)
47. [Terrain lab: an isolated ground-level terrain prototype](docs/adr/0047-terrain-lab-prototype.md)
48. [Paved ground and parks from OpenStreetMap](docs/adr/0048-paved-ground-and-parks-from-osm.md)
49. [The terrain field is the game's ground and its 3D terrain](docs/adr/0049-terrain-field-ground-and-renderer.md)
50. [Tree cover from canopy heights](docs/adr/0050-tree-cover-from-canopy-heights.md)
51. [Realistic trees](docs/adr/0051-realistic-trees.md)
52. [Animated soldiers in the 3D view](docs/adr/0052-animated-soldiers.md) ([how it works](docs/character-animation.md))
53. [Unit tasks and formation movement in the simulation kernel](docs/adr/0053-unit-tasks-and-formation-movement.md) ([Behavior Lab](docs/behavior-lab/README.md))
54. [The Behavior Lab](docs/adr/0054-behavior-lab.md)

Animated 3D soldiers: background to ADR 0052 —
[framework evaluation](docs/character-animation-framework-evaluation.md) (recommendation),
[prototype results](docs/character-animation-prototype-results.md),
[recommended architecture](docs/character-animation-recommended-architecture.md),
[revised roadmap](docs/character-animation-revised-roadmap.md); earlier
[research](docs/character-animation-research.md),
[architecture](docs/character-animation-architecture.md),
[asset evaluation](docs/character-asset-evaluation.md) and
[roadmap](docs/character-animation-roadmap.md). The comparison prototype is in
[`prototypes/character-animation`](prototypes/character-animation/) (not part of the game build).

Behavior Lab (M1–M3 implemented, at `#behavior-lab`: [implementation notes](docs/behavior-lab/implementation.md)): research and architecture for hierarchical,
order-driven formation movement — [overview](docs/behavior-lab/README.md),
[existing architecture](docs/behavior-lab/01-existing-architecture.md),
[research survey](docs/behavior-lab/02-research-survey.md),
[architecture proposal](docs/behavior-lab/03-architecture-proposal.md),
[lab design](docs/behavior-lab/04-behavior-lab-design.md),
[test plan](docs/behavior-lab/05-test-and-benchmark-plan.md),
[roadmap](docs/behavior-lab/06-implementation-roadmap.md),
[open questions](docs/behavior-lab/07-open-questions.md).
