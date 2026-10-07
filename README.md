# Ambush!

Interactive training simulation for planning, executing and reviewing
squad-level military ambushes. A deterministic, headless-capable simulation
drives a 2D tactical view and a 3D (Three.js) observer view.

Status: **Phase 0**: project scaffold and enforced layer boundaries. No gameplay yet.

## Requirements

- Node 24 (see `.nvmrc`) and npm
- Chrome or Edge on a Windows desktop

## Getting started

```sh
npm install
npm run dev
```

## Scripts

| Script                 | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `npm run dev`          | Start the Vite dev server                                     |
| `npm run build`        | Type-check all layers, then build for production              |
| `npm run typecheck`    | `tsc -b` across all layer projects                            |
| `npm run lint`         | ESLint, including the layer boundary rules                    |
| `npm test`             | Run unit tests (Vitest, Node)                                 |
| `npm run test:watch`   | Run tests in watch mode                                       |
| `npm run format`       | Format with Prettier                                          |
| `npm run format:check` | Check formatting                                              |
| `npm run check`        | typecheck + lint + test + format:check                        |
| `npm run sim:headless` | Run the simulation headless, e.g. `-- --rate 30 --seconds 10` |

## Architecture

The code is split into layers whose boundaries are enforced by the compiler and
ESLint. Other layers are imported only through their alias (`#sim`, `#exercise`,
…), never by relative path.

```
src/sim       simulation (no DOM, no Node, no Three.js, deterministic)
src/exercise  plan, phases, fixed-step runner, recording   -> sim
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
