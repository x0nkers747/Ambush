# Ambush!

Interactive training simulation for planning, executing and reviewing
squad-level military ambushes. A deterministic, headless-capable simulation
drives a 2D tactical view and a 3D (Three.js) observer view.

Status: **real-world terrain** ([ADR 0014](docs/adr/0014-real-world-terrain-import.md)): besides
the synthetic demo, any 5 × 5 km area between 80° S and 84° N can be generated from
OpenStreetMap and freely available elevation data, saved in the browser and played offline. The
trainee commands the 13-Marine rifle squad of MCWP 3-11.2 (1991; a historical organization, see
[ADR 0012](docs/adr/0012-organization-orp-and-single-destination-planning.md)), starting at an
objective rally point, and gives each Marine one destination and one facing. Marines are shown
with Ambush!'s own role icons (not APP-6, see
[ADR 0013](docs/adr/0013-individual-soldier-icons.md)) and listed in a roster. The ambush flow
runs through AMBUSH TRIGGERED into a probabilistic two-sided engagement of up to 60 simulated
seconds ([ADR 0019](docs/adr/0019-probabilistic-engagements.md)), on the demo or on any
battlefield once its scenario (ORP, OPFOR and route) is set up in the scenario editor. No 3D yet.

## Requirements

- Node 24 (see `.nvmrc`) and npm
- Chrome or Edge on a Windows desktop

## Getting started

```sh
npm install
npm run dev
```

## Choosing a battlefield, setting up the scenario, playing it

Run `npm run dev` and open the printed URL (http://localhost:5173) in Chrome or Edge. Ambush! has
three stages ([ADR 0015](docs/adr/0015-three-stage-workflow-and-scenario-editing.md)):

1. **Terrain selection.** Open the **demo** (it goes straight to planning, with its own scenario),
   **generate a new battlefield** (enter a latitude and longitude in decimal degrees, e.g.
   `38.5223`, `-77.2934`, or search for a place; check the location, press **Generate
   battlefield**; **Cancel** stops it; if OpenStreetMap is unavailable you can retry or continue
   with terrain only), or open a **saved battlefield** (no network needed). Opening or generating
   a battlefield goes to its scenario.
2. **Scenario editing.** On the tactical map:
   - **Place ORP**: click where the squad assembles (or drag the ORP).
   - **Place OPFOR**: click where the OPFOR patrol (three soldiers) starts (or drag it).
   - **Edit OPFOR route**: click to add waypoints in order; drag a waypoint to move it; right-click
     to delete it. The patrol walks straight between waypoints, round buildings where needed.
   - **Clear route** keeps the OPFOR where it starts; **Reset scenario** (two clicks) starts over.
   - **Continue to BLUEFOR planning** once the panel says the scenario is ready. Changes are saved
     as you make them; **◂ Terrain** goes back.
3. **BLUEFOR planning and execution**: the exercise below, with the squad in your ORP and the OPFOR
   at the start of your route. **◂ Scenario** returns to editing and **◂ <battlefield>** to terrain
   selection; once a plan has been executed, both ask you to confirm discarding the exercise.

Each battlefield's panel lists its sources, their resolution and accuracy, and the credits their
licences require. Service endpoints can be changed per browser: see
[ADR 0014](docs/adr/0014-real-world-terrain-import.md#data-sources-and-services).

## Running an ambush exercise

1. **BLUEFOR planning.** The squad starts in the ORP (dashed circle). Choose a Marine in the
   roster or on the map and click the map to give them a destination; drag the yellow handle to
   set their facing. Marines you leave alone stay in the ORP. Press **K** to switch to the kill
   zone and draw it across the expected enemy route (the dark-red dashed line).
   Press **V** (Visibility) to shade green everything the selected Marine can see from their
   destination, with the share of the kill zone that is visible; drag the destination to compare
   positions. The selected Marine also shows a faint blue 35° wedge around the way he faces now,
   out to his weapon's maximum engagement range (rifle 550 m, SAW 600 m; a planning aid, see
   [ADR 0018](docs/adr/0018-weapon-engagement-wedge.md); it does not limit where he can fire). Paths bend around buildings automatically; destinations cannot be placed in or
   against a building.
2. **Execute.** BLUEFOR moves into position while OPFOR waits. Pause (Space) to change
   destinations or facings, then Resume.
3. **BLUEFOR ready.** When every Marine with a destination or facing has arrived and turned, the
   exercise stops and waits.
4. **START OPFOR.** Declares the ambush ready; OPFOR follows its scenario route.
5. **Ambush triggered.** The moment an OPFOR soldier enters the kill zone the engagement begins
   ([ADR 0019](docs/adr/0019-probabilistic-engagements.md)). Every Marine with a weapon fires at
   the nearest enemy he can see within his weapon's range; the chance of a hit falls with range and
   halves against a prone target. Each OPFOR soldier, after a short delay, either drops prone and
   returns fire or flees. Shots show as fading lines; incapacitated soldiers are crossed out.
6. **Engagement complete.** After 60 simulated seconds, or earlier when every OPFOR soldier is
   incapacitated or has escaped, every Marine is incapacitated or nobody can fire any more. The
   side panel shows the results: casualties, escapes, shots and hits by side and by soldier, and
   the seed. Add `?seed=N` to the page address (before the `#`) to replay an engagement exactly or
   try another roll of the dice; all combat values are in
   [`src/exercise/combat/combat-v1.json`](src/exercise/combat/combat-v1.json)
   ([reference](docs/combat-configuration.md)).

| Action                          | Effect                                              |
| ------------------------------- | --------------------------------------------------- |
| Roster row / blue symbol        | Select a Marine; click a cluster again for the next |
| Click the map                   | Set or move the destination (with K: add a corner)  |
| Click a kill-zone side          | Insert a corner there                               |
| Drag the destination / a corner | Move it                                             |
| Right-click destination/corner  | Clear the destination / delete the corner           |
| Drag the yellow arrow handle    | Set the facing (000°–359°; dashed arrow = default)  |
| K                               | Switch between editing positions and the kill zone  |
| V                               | Visibility: show what the selected Marine sees      |
| Backspace / Delete              | Clear the selected Marine's destination             |
| Drag the map / middle-drag      | Pan                                                 |
| Mouse wheel                     | Zoom at the cursor                                  |
| F                               | Fit the whole map                                   |
| Space                           | Pause / Resume                                      |
| 1 · 4 · 8                       | Time scale 1× · 4× · 8×                             |
| + / −                           | Faster / slower through 1× · 4× · 8× · 16×          |
| Esc                             | Clear the selection                                 |

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
