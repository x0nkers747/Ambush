# ADR 0047: Terrain lab: an isolated ground-level terrain prototype

- Status: Accepted (prototype only; integration into the game is not decided)
- Date: 2026-10-13
- Follows [`docs/ground-level-terrain-architecture-research.md`](../ground-level-terrain-architecture-research.md),
  stage 2. Results: [`docs/terrain-lab-prototype-report.md`](../terrain-lab-prototype-report.md).

## Context

The research recommends replacing the lattice-bound graded terrain (ADRs 0032 and 0040) with a
constraint-based terrain field, sampled into a tiled surface and rendered with CDLOD and
material fields (architecture A4★). Before changing anything the game uses, it was to be
proven on real data, at ground level, beside the current renderer.

## Decision

A **terrain lab** is added as an isolated prototype.

- **Code:**
  - `src/sim/terrain-lab`: the field and the surface. No DOM, no Three.js, no clock reads (the
    caller passes a clock for timings).
  - `src/view3d/terrain-lab`: the renderer, materials, clutter, water, cameras and the page.
- **Aliases:** `#sim/terrain-lab` and `#view3d/terrain-lab`. Neither is exported from `#sim` or
  `#view3d`.
- **Address:** `#terrain-lab`. The composition root (`src/app/main.ts`) imports the lab lazily
  for that address only. A test (`src/app/terrain-lab-isolation.test.ts`) fails if any other
  game module mentions it.
- **No change to anything the game uses.**
  - The lab reads the game's terrain packages and reuses, unchanged:
    - DEM cleaning;
    - the water levels and water query;
    - bridge planning (for viewpoints and markings; the lab draws its own decks);
    - the building, decor and vegetation generators (the lab draws its own trees and shrubs on
      the game's placement);
    - the water material.
  - The game's terrain model, grading, simulation, 2D map and 3D view are untouched.
- **Field version.** The field is versioned (`TERRAIN_FIELD_VERSION`). It is deterministic in
  its inputs and seed, and its tiles are hashed (`tileHash`).
- **Measurement tools.** These are opt-in CLI tests, like `diagnose.cli.test.ts`:
  - `bench.cli.test.ts`: field, tiles, queries and caches for a recorded battlefield;
  - `determinism.cli.test.ts`: Node tile hashes, to compare with the page's
    `window.terrainLabHash`.
- **Textures.** The lab's ground textures are CC0 (ambientCG), 1024 px, 14 MB, listed in
  `src/view3d/terrain-lab/textures/CREDITS.md`.

## Consequences

- **The production bundle.** The lab is a lazily loaded chunk. The game's start-up does not
  load it.
- **Results.** On the integrated GPU the lab renders the test areas faster than the current
  renderer, and clearly better at ground level. Its 0.5 m tiles cost more to generate and hold
  than the research budgets allow, and random `heightAt` is 2–3× slower. The report recommends
  a 1 m simulation lattice, compact storage and the other changes it lists before any
  integration.
- **Cross-engine determinism** is verified only between Node and Chrome (both V8).
- **Integration needs a separate decision.** Following the research roadmap (stages 1 and 3
  onward), it needs its own ADRs and explicit authorisation.
