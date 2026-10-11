# ADR 0029: The 3D battlefield view, milestone 1

- Status: Accepted
- Date: 2026-10-11
- Implements milestone 1 (phases 0–1) of `docs/3d-terrain-architecture-research.md`. Builds on
  ADR 0002 (axes), ADR 0006 and ADR 0008 (one terrain triangulation), ADR 0025 (workspace) and
  ADR 0026 (replay through `Exercise.replayAt`).

## Context

Ambush! needs a 3D view of the battlefield next to the 2D tactical map. The first milestone covers
the terrain, an overhead tactical camera, daylight and the soldiers. Roads, buildings, vegetation
and textured ground are left to later milestones. The 3D view must show exactly the ground the
simulation uses, and must never change the exercise.

## Decision

### An extra view, chosen in the map bar

The map bar has a **2D | 3D** switch. 2D stays the default.

- The first time 3D is opened, the app loads `#view3d` with a dynamic `import()`. Three.js (r186.1,
  pinned) therefore stays out of the initial bundle: the main chunk grew by about 3 kB, and
  `view3d` is a separate chunk of about 577 kB (146 kB gzipped).
- The 3D canvas lies over the 2D map. The 2D canvas keeps its size, view and caches; it is simply
  not drawn while 3D is shown.
- The 3D view is kept until the page is left. Switching back and forth keeps its camera and never
  rebuilds its geometry.
- **Fit map** becomes **Reset view** in 3D. The F key does the same.

### No state of its own

`createBattlefieldView3d` takes three getters: the exercise to show, the session, and whether the
squad is hidden. The workspace passes the same `shown()` the 2D map draws. That means:

- the live exercise in stages 3 and 4;
- the scenario preview in stage 2;
- the replay frame (`Exercise.replayAt`) in the After Action Review.

The 3D view therefore follows live play, scrubbing and playback with no state of its own and no
second replay engine. It only reads; the exercise is changed only by the existing controls.

### Exactly the simulated ground

`terrainMesh` builds the mesh from the heightfield:

- **One vertex per elevation sample.** Each is placed at `(originX + c·cell, elevation,
−(originY + r·cell))`, unchanged: no smoothing and no vertical exaggeration.
- **The triangles are `terrainTriangleIndices`.** These are the same cells split along the same
  south-west to north-east diagonal that `heightAt` interpolates on.

Since the GPU interpolates linearly on those triangles, the drawn surface is the simulated surface.
Tests check it against `heightAt` to 1 cm, interpolating the mesh's own float32 vertices as the GPU
does. The points checked are every vertex, cell centres, diagonals, cell edges, the battlefield's
edges and corners, a 120 m cliff, 20,000 random points on rough terrain at 1,500–4,300 m elevation,
and the demo. The axis mapping `(x, y, z)` to `(x, z, −y)` lives in `axes.ts` and is a proper
rotation: north is −Z, east is +X, and nothing is mirrored.

The terrain is one mesh: 251,001 vertices and 500,000 triangles on a 5 km battlefield, drawn in a
single call.

- Building it on the main thread takes well under a second.
- Its first frame appeared in 0.4–0.6 s in testing (software WebGL).
- The builder is pure, with no Three.js, so it can move to a worker or be cut into tiles later.

### Shading only

Shading never moves a vertex:

- **Normals.** Smooth per-vertex normals come from central differences.
- **Colour.** Vertex colours are the 2D map's elevation tints (`elevationTints`, without its baked
  hillshade, since the 3D view is lit), converted to linear sRGB.
- **Typical range.** The tints span the battlefield's 1st–99th elevation percentiles
  (`typicalElevationRange`). One bad sample (Quantico has one at −782 m) would otherwise press all
  the real ground into a single tint.
- **The 2D map is unchanged.**

### Light, sky and surroundings

Three.js built-ins only, with no post-processing:

- a `Sky`, with the sun from the south-west at 38°;
- a directional sun and a hemisphere light;
- linear fog from 1.4 to 6 battlefield widths, matched to the horizon haze;
- ACES filmic tone mapping and sRGB output.

The battlefield stands on a plain apron, with walls from its edge down to the apron. Their top
vertices are the terrain's own edge vertices, so there are no cracks. A low camera then never
looks into empty space, and the battlefield's edges stay clear. The apron is decoration, not
ground the simulation knows.

### The tactical camera

`OrbitControls`:

- left-drag orbits;
- right-drag pans along the ground;
- the wheel zooms towards the cursor, with damping;
- double-click focuses on the ground clicked. The click is found by marching the camera ray against
  `heightAt` and bisecting to a centimetre. The camera then glides with its angle and distance kept.

The default view is centred on the battlefield, looks north at 40° down, and is far enough for the
battlefield's width and foreshortened depth to fit.

Constraints:

- The focus stays on the battlefield and follows the ground under it.
- The camera stays at least 2 m above the ground, or above the apron off the battlefield.
- It never passes 88° from straight down.
- Zoom runs from 15 m to 2.5 battlefield widths.
- The near plane follows the camera's height, which keeps depth precision without a logarithmic
  depth buffer.

`TacticalCamera` implements a small `CameraMode` interface, so later follow, ground-level, free and
cinematic cameras can sit beside it.

### Soldiers

`unitMarkers` and `destinationMarkers` are pure reads of the exercise, as the 2D map's
`buildScene` reads it: every soldier (OPFOR included, as in 2D), less the squad while it is hidden
for want of an ORP.

- **Placement.** A marker's feet are the soldier's simulated `position`, whose z is `heightAt`. The
  browser tests check every standing marker against the simulation to 1 cm, live and in replay.
- **Look.** A simple figure: blue for BLUEFOR, red for OPFOR, gold when selected, grey and lying
  when incapacitated. A nose points along the facing.
- **Size.** Markers are scaled so a distant one is about 26 px tall and a close one life size.
- **Planned destinations** that have not been reached show as translucent pins on the ground.

## Consequences

- **The 2D map, the simulation, planning and replay are unchanged.** Changes outside `view3d`:
  - the map-bar switch and its frame-loop branch in `workspace.ts`;
  - two pure exports added to `view2d` (`elevationTints`, `typicalElevationRange`);
  - styles;
  - the `three` and `@types/three` dependencies, pinned.
- **Verified in a browser** (Chromium with software WebGL), at 1600 × 1000 and 1280 × 720:
  - switching keeps the stage, the exercise, unit positions, the live simulation and the replay
    time;
  - orbit, pan, zoom, double-click and ground collision behave as specified;
  - the 3D camera is kept across switches;
  - fifteen switches leave the GPU geometry and texture counts unchanged;
  - leaving the page disposes the renderer.
- **Frame rate on real GPUs is not measured yet.** The test machine has no GPU, and software
  rendering gives 5–10 fps.
  - Draw calls on the demo: about 50, three per soldier (body, head, nose). Instancing them is a
    cheap later step.
  - Draw calls on Quantico: 2.
- **Data quality shows.** The view draws the simulated ground as it is, so data faults in the
  import show. Quantico's terrain has samples hundreds of metres below their neighbours (minimum
  −782 m), and they appear as spikes under the battlefield's edge. The simulation's `heightAt` uses
  them too, so they should be fixed in the import, not hidden by the view.
- **Not in milestone 1:** roads, buildings, vegetation, water and textured ground. Also missing:
  shadows, a worker for geometry, cached geometry, picking soldiers in 3D, and interpolation between
  simulation ticks.
