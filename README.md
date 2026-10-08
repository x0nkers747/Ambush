# Ambush!

Interactive training simulation for planning, executing and reviewing
squad-level military ambushes. A deterministic, headless-capable simulation
drives a 2D tactical view and a 3D (Three.js) observer view.

Status: **Phase 3.7**: doctrinal squad organization and simplified deployment. The trainee
commands the 13-Marine rifle squad of MCWP 3-11.2 (1991; a historical organization, see
[ADR 0012](docs/adr/0012-organization-orp-and-single-destination-planning.md)), starting at an
objective rally point, and gives each Marine one destination and one facing. Marines are shown
with APP-6 symbols (milsymbol) and listed in a roster. The ambush flow runs through AMBUSH
TRIGGERED. No combat, 3D or GIS import yet.

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

1. **BLUEFOR planning.** The squad starts in the ORP (dashed circle). Choose a Marine in the
   roster or on the map and click the map to give them a destination; drag the yellow handle to
   set their facing. Marines you leave alone stay in the ORP. Press **K** to switch to the kill
   zone and draw it across the expected enemy route (the dark-red dashed line).
   Press **V** (Visibility) to shade green everything the selected Marine can see from their
   destination, with the share of the kill zone that is visible; drag the destination to compare
   positions. Paths bend around buildings automatically; destinations cannot be placed in or
   against a building.
2. **Execute.** BLUEFOR moves into position while OPFOR waits. Pause (Space) to change
   destinations or facings, then Resume.
3. **BLUEFOR ready.** When every Marine with a destination or facing has arrived and turned, the
   exercise stops and waits.
4. **START OPFOR.** Declares the ambush ready; OPFOR follows its scenario route.
5. **Ambush triggered.** The moment an OPFOR soldier enters the kill zone, the simulation stops
   and shows who entered and when.

| Action                          | Effect                                             |
| ------------------------------- | -------------------------------------------------- |
| Roster row / blue symbol        | Select a Marine (OPFOR cannot be selected)         |
| Click the map                   | Set or move the destination (with K: add a corner) |
| Click a kill-zone side          | Insert a corner there                              |
| Drag the destination / a corner | Move it                                            |
| Right-click destination/corner  | Clear the destination / delete the corner          |
| Drag the yellow arrow handle    | Set the facing (000°–359°; dashed arrow = default) |
| K                               | Switch between editing positions and the kill zone |
| V                               | Visibility: show what the selected Marine sees     |
| Backspace / Delete              | Clear the selected Marine's destination            |
| Drag the map / middle-drag      | Pan                                                |
| Mouse wheel                     | Zoom at the cursor                                 |
| F                               | Fit the whole map                                  |
| Space                           | Pause / Resume                                     |
| 1 · 8                           | Time scale 1× · 8×                                 |
| + / −                           | Faster / slower through 1× · 8× · 16×              |
| Esc                             | Clear the selection                                |

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
12. [Doctrinal organization, ORP and single-destination deployment](docs/adr/0012-organization-orp-and-single-destination-planning.md)
