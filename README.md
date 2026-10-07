# Ambush!

Interactive training simulation for planning, executing and reviewing
squad-level military ambushes. A deterministic, headless-capable simulation
drives a 2D tactical view and a 3D (Three.js) observer view.

Status: **Phase 3**: interactive 2D planning slice. Plan BLUEFOR routes and final facings on
a tactical map, Execute, Pause, re-plan and Resume. No 3D, perception or combat yet.

## Requirements

- Node 24 (see `.nvmrc`) and npm
- Chrome or Edge on a Windows desktop

## Getting started

```sh
npm install
npm run dev
```

## Using the planning map

Run `npm run dev` and open the printed URL (http://localhost:5173) in Chrome or Edge.

| Action                       | Effect                                    |
| ---------------------------- | ----------------------------------------- |
| Click a blue soldier         | Select it (OPFOR cannot be selected)      |
| Click the map                | Add a waypoint at the end of the route    |
| Click a route leg            | Insert a waypoint into that leg           |
| Drag a waypoint              | Move it                                   |
| Right-click a waypoint       | Delete it                                 |
| Drag the yellow arrow handle | Set the final facing (shown as 000°–359°) |
| Backspace / Delete           | Delete the last waypoint                  |
| Drag the map / middle-drag   | Pan                                       |
| Mouse wheel                  | Zoom at the cursor                        |
| F                            | Fit the whole map                         |
| Space                        | Pause / Resume                            |
| 1 · 2 · 4                    | Time scale                                |
| Esc                          | Clear the selection                       |

Routes can be edited while Planning or Paused. Execute and Resume commit the
plans; while executing they are read-only.

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
