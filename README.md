# Ambush!

Interactive training simulation for planning, executing and reviewing
squad-level military ambushes. A deterministic, headless-capable simulation
drives a 2D tactical view and a 3D (Three.js) observer view.

Status: **Phase 3.6**: tactical environment and planning tools. The demo map has relief, roads,
buildings and vegetation; routes bend around buildings; CHECK LOS shows what a planned position
can see. The ambush flow runs through AMBUSH TRIGGERED. No combat, 3D or GIS import yet.

## Requirements

- Node 24 (see `.nvmrc`) and npm
- Chrome or Edge on a Windows desktop

## Getting started

```sh
npm install
npm run dev
```

## Running an ambush exercise

Run `npm run dev` and open the printed URL (http://localhost:5173) in Chrome or Edge.

1. **BLUEFOR planning.** Select soldiers and plan their routes and final facings. Press **K** to
   switch to the kill zone and draw it across the expected enemy route (the dark-red dashed
   line).
   Press **V** (Visibility) to shade green everything the selected soldier can see from their
   planned final position, with the share of the kill zone that is visible; drag the last
   waypoint to compare positions. Routes bend around buildings automatically; waypoints cannot be
   placed in or against a building.
2. **Execute.** BLUEFOR moves into position while OPFOR waits. Pause (Space) to change the
   remaining routes, then Resume.
3. **BLUEFOR ready.** When every soldier is in position the exercise stops and waits.
4. **START OPFOR.** Declares the ambush ready; OPFOR follows its scenario route.
5. **Ambush triggered.** The moment an OPFOR soldier enters the kill zone, the simulation stops
   and shows who entered and when.

| Action                        | Effect                                          |
| ----------------------------- | ----------------------------------------------- |
| Click a blue soldier          | Select it (OPFOR cannot be selected)            |
| Click the map                 | Add a waypoint (or, with K, a kill-zone corner) |
| Click a route leg / zone side | Insert a waypoint / corner there                |
| Drag a waypoint / corner      | Move it                                         |
| Right-click waypoint/corner   | Delete it                                       |
| Drag the yellow arrow handle  | Set the final facing (shown as 000°–359°)       |
| K                             | Switch between editing routes and the kill zone |
| V                             | Visibility: show what the selected soldier sees |
| Backspace / Delete            | Delete the last waypoint                        |
| Drag the map / middle-drag    | Pan                                             |
| Mouse wheel                   | Zoom at the cursor                              |
| F                             | Fit the whole map                               |
| Space                         | Pause / Resume                                  |
| 1 · 8                         | Time scale 1× · 8×                              |
| + / −                         | Faster / slower through 1× · 8× · 16×           |
| Esc                           | Clear the selection                             |

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

## Architecture

The code is split into layers whose boundaries are enforced by the compiler and
ESLint. Other layers are imported only through their alias (`#sim`, `#exercise`,
…), never by relative path.

```
src/sim       simulation (no DOM, no Node, no Three.js, deterministic)
src/exercise  phases, plans, revisions, runner, demo scenario -> sim
src/session   ephemeral UI state                           -> sim, exercise
src/view2d    2D tactical view                             -> sim, exercise, session
src/view3d    3D observer view (Three.js)                  -> sim, exercise, session
src/app       composition root                             -> all
tools         Node command-line tools                      -> sim, exercise
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
