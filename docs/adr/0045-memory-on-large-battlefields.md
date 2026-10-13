# ADR 0045: Memory on large battlefields

- Status: Accepted
- Date: 2026-10-12
- Amends ADR 0020 (viewshed workers) and ADR 0031 (3D generation off the main thread). Keeps ADR
  0032 (the terrain surface): the surface and every height are unchanged.

## Context

Opening central Amsterdam (the recording of ADR 0044: 15,646 roads, 53,377 buildings, about 600,000
feature points) crashed the page in Google Chrome every time, a few seconds after the 3D view
started building its features. The main thread's JavaScript heap was 1.3 GB of its 4.2 GB limit at
the time, so the main thread alone was not out of memory. The same page opened in Playwright's
Chromium, and in Chrome when V8 was given a much larger heap; both still crashed now and then.

The page's JavaScript runs in several isolates, each with its own heap: the main thread and its
workers. Measured on Amsterdam (Node, the graded terrain as a worker receives it):

| Holder                             | Heap                                        |
| ---------------------------------- | ------------------------------------------- |
| Main thread, battlefield open      | about 1.0–1.3 GB                            |
| One copy of the graded terrain     | 209–279 MB                                  |
| A viewshed worker (copy and index) | about 0.45 GB, four of them (ADR 0020)      |
| The 3D feature worker at its peak  | 1.0–1.5 GB                                  |
| The ground-map worker              | under 0.5 GB                                |
| Main thread starting the 3D view   | a further 1.1 GB of short-lived allocations |

Together, while the 3D view was being built, that is about 4.8 GB. Chrome gives a page's isolates
one 4 GB region for all their heaps (V8's shared pointer-compression cage), which fits the crash:
the total, not any one heap, ran out. The viewshed workers were the largest single cost, and they
were started as soon as a battlefield opened, whether or not a viewshed was ever shown.

The main thread's extra 1.1 GB at the start of the 3D view was garbage: a sampling heap profile
showed the surface triangulation (`surfaceMesh`) built twice (once more for the terrain's edge
walls) in growing JavaScript arrays, a closure allocated on every `sampleSurface` call, and, when
the features arrived, Three.js's `computeBoundingSphere` boxing numbers over 14 million triangles.

## Decision

- **Viewshed workers start on demand.** The pool is started by the first viewshed that must be
  computed (`createViewshedService`), not when the battlefield opens. Only the Visibility tool asks
  for viewsheds, so a battlefield opened and looked at in 3D starts none.
- **Fewer viewshed workers on a heavy battlefield.** Each worker holds its own terrain and index, so
  the pool is one worker per spare core up to 4 as before, but at most 2 above 100,000 feature
  points and 1 above 300,000 (`defaultWorkerCount`, `featurePoints`, `HEAVY_TERRAIN_POINTS`).
  Amsterdam gets one; Quantico and Grafenwöhr (about 25,000 points) are unchanged.
- **The surface triangulation is built once per terrain** (`surfaceMesh`, cached by terrain; the
  terrain is immutable, ADR 0006) and into growable typed buffers rather than JavaScript arrays.
  The 2D map's terrain layer, the 3D terrain mesh and its edge walls share it. The triangulation is
  unchanged.
- **`sampleSurface` allocates nothing**: its four sample reads are inlined, with the same
  arithmetic, so every height is unchanged.
- **Bounding spheres** of the terrain and feature meshes are computed in one pass over the typed
  array (`boundingSphereOf`), the same sphere Three.js computes.

## Measurements

Google Chrome, its default memory limits, Amsterdam (AMD Radeon 880M integrated graphics, Windows 11):

|                                              | Before           | After           |
| -------------------------------------------- | ---------------- | --------------- |
| Opening Amsterdam in 3D                      | crashed (3 of 3) | opened (3 of 3) |
| Viewshed workers started on opening          | 4                | 0               |
| Main heap while the 3D features are built    | 2.1–2.2 GB       | 1.2 GB          |
| Main thread allocations starting the 3D view | 2.1 GB           | 0.66 GB         |
| Main heap, highest (features arriving)       | 2.0 GB           | 2.1 GB          |

The highest main heap is reached once the features have arrived, when the generation workers have
finished. The Visibility tool still computes viewsheds (checked on the demo: no viewshed worker
before it is switched on, the pool after, the viewshed computed).

## Limitations

- **The limit is shared, not removed.** A battlefield much larger than central Amsterdam, or one
  opened with the Visibility tool showing while the 3D view is still being built, can still come
  close to it. The terrain is still copied into each worker; sharing it (`SharedArrayBuffer`) needs
  cross-origin isolation, which GitHub Pages cannot serve.
- **Viewsheds are slower on a heavy battlefield**, with one worker instead of up to four.
- **The thresholds are measured on one city** (feature points as a proxy for a worker's heap). They
  are deliberately conservative.
