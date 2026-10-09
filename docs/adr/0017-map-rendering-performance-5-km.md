# ADR 0017: Tactical map rendering on 5 km battlefields (phase 2)

- Status: Accepted
- Date: 2026-10-09
- Builds on ADR 0009 (the 2D planning view), ADR 0011 (environment features), ADR 0014
  (generated battlefields, contour intervals) and ADR 0016 (navigation, phase 1).

## Context

On a 5 × 5 km battlefield the Canvas 2D map took 80–160 ms per frame. That gave 6–7 fps with the
whole map in view and about 12 fps zoomed in, whether anything moved or not. Profiling in Chrome
on the recorded Quantico and Grafenwöhr battlefields (ADR 0016) found that the map did every
geographic drawing operation on every animation frame. Drawing each part with the rest left out
gave these costs per frame:

| Part                                                    | Whole map | ~1 km    | ~300 m   |
| ------------------------------------------------------- | --------- | -------- | -------- |
| Terrain shading (a 501 × 501 image, high-quality scale) | 25–27 ms  | 38–39 ms | 37–48 ms |
| Contours (one path, 63,000 segments at Grafenwöhr)      | 15–37 ms  | 8 ms     | 7–8 ms   |
| Roads (1,211 roads, casing and fill strokes)            | 28–36 ms  | 10–25 ms | 4–7 ms   |
| Buildings (3,567 at Grafenwöhr)                         | 7–16 ms   | 7–12 ms  | 1–5 ms   |
| Vegetation, land use, water                             | 5–12 ms   | 4–11 ms  | 2–8 ms   |
| Scene, grid and every tactical overlay                  | 2–3 ms    | 1–2 ms   | 2–3 ms   |

Nothing outside the view was skipped, and nothing was reused between frames: a frame in which
only a Marine's facing changed cost as much as the first. Building the terrain layer took
0.8–1.3 s, mostly contour tracing, which made one pass over the 500,000 terrain triangles for each
contour level.

## Decision

Keep the Canvas 2D renderer, its drawing code, its order of layers and its appearance. Draw the
geographic map less often, and only the part that is needed.

### Layers

`drawMap` is split into the passes it always made, in the same order:

1. `drawGround`: background and terrain shading.
2. `drawVisibility`: the visibility overlay.
3. `drawFeatures`: contours, then land use, vegetation, water and waterways, then roads, then
   buildings and labels (`FEATURE_PHASES`).
4. `drawOverlays`: grid and everything tactical.

Every feature, and every contour tile (250 m squares), carries its bounds. Each pass skips what
lies outside the area being drawn, with margins for line widths. The visible contour tiles are
joined into one path per line weight. Overlapping translucent contours therefore blend as in one
stroke, as before.

### Cache (`geo-cache.ts`)

Passes 1 and 3 are cached in offscreen canvases of the map canvas's size and pixel ratio. Each
frame copies them onto the map canvas, draws pass 2 between them, and draws pass 4 on top. When
nothing goes between, the usual case, ground and features share one canvas. That is one copy per
frame, and exactly what drawing them directly gives.

- **Same view** (selection, plans, playback, hover): the cache is copied, and the map is not
  redrawn.
- **Pan:** every camera is snapped to whole device pixels (`snapCamera`, a shift of less than half
  a device pixel). A pan is then a whole-pixel move, so the cached pixels are moved and only the
  exposed strips are drawn.
- **Zoom:** the cache is drawn scaled into place for the moment. A whole-map image underneath it
  covers what it does not reach; that image is copied when the map is drawn at the fit view, or
  drawn once.
- **Still for 150 ms after a pan or zoom:** the cache is drawn again exactly into spare canvases,
  one phase per frame (ground, contours, areas, roads, buildings). The new cache replaces the old
  one when complete. A change of view meanwhile abandons it. No frame stalls on a full redraw, and
  any blur or strip seams are gone within about 0.25 s.
- **Another canvas size or pixel ratio:** drawn anew at once.

Chrome rasterizes some strokes and fills slightly differently where a clip cuts them. While
panning, the edges of the strips therefore show faint seams: a few antialiased pixels, up to about
0.9 % of the frame, which the settled redraw removes. Settled views match direct drawing to within
5 of 255 levels.

### Contours

`contourLines` makes one pass over the triangles and visits each triangle only for the levels
between its lowest and highest corner. Each level's segments come out in the same order, with the
same values. It is tested against the per-level pass.

### Visual equivalence

The same scenes and cameras were drawn by the old renderer and by the new one, on both
battlefields, at four views and pixel ratios 1 and 2, with and without the visibility overlay:

- **Drawn directly, cached, settled after a pan, settled after a zoom:** within 3 of 255 levels of
  the old renderer per channel, except as noted below.
- **With the visibility overlay:** the features are composited from their own canvas, which rounds
  to within 4–5 levels on up to 1.2 % of pixels.
- **While panning, before the view settles:** faint seams on 0.1–2 % of pixels, at most 117
  levels on a few dozen pixels, along the strip edges.

### Memory

At a 1,240 × 900 map canvas and pixel ratio 1, each cache canvas holds 4.5 MB. The cache holds:

- 1 layer canvas, or 2 while the visibility overlay is shown;
- up to 2 spare canvases, used for panning and the settled redraw;
- the whole-map image.

That is at most 4–6 canvases: 18–27 MB at ratio 1 and 71–107 MB at ratio 2. Canvases are reused
from a small pool and released when the size changes, and `TacticalMap.dispose` releases them all.
Stage changes reload the page (ADR 0015), so nothing outlives a battlefield.

## Measurements

Measured in headless Chromium with software rendering: a 1,600 × 1,000 window and a 1,270 × 913
map canvas, on the recorded 5 km battlefields. Each entry is the average frame time, then the
95th-percentile frame time, from requestAnimationFrame intervals. "Before" is the phase 1 code.

| Pixel ratio 1                  | Grafenwöhr before | Grafenwöhr after | Quantico before | Quantico after |
| ------------------------------ | ----------------- | ---------------- | --------------- | -------------- |
| Idle, whole map                | 151 / 183 ms      | 16.7 / 16.7 ms   | 104 / 133 ms    | 16.7 / 16.8 ms |
| Pan, whole map                 | 149 / 200 ms      | 16.7 / 16.7 ms   | 103 / 133 ms    | 17.4 / 16.7 ms |
| Pan, ~1 km                     | 91 / 117 ms       | 16.8 / 16.7 ms   | 78 / 100 ms     | 16.7 / 16.7 ms |
| Pan, ~300 m                    | 82 / 100 ms       | 18.8 / 33.4 ms   | 71 / 83 ms      | 16.7 / 16.7 ms |
| Continuous zoom                | 98 / 150 ms       | 17.8 / 33.3 ms   | 83 / 117 ms     | 17.1 / 16.8 ms |
| OPFOR waypoint drag            | 149 / 183 ms      | 19.8 / 16.8 ms   | 111 / 133 ms    | 19.4 / 16.7 ms |
| ORP drag                       | 144 / 183 ms      | 16.9 / 16.7 ms   | 113 / 150 ms    | 16.7 / 16.8 ms |
| Soldier destination drag       | 91 / 117 ms       | 16.7 / 16.7 ms   | 78 / 100 ms     | 16.7 / 16.7 ms |
| Playback (8×, whole map)       | 149 / 200 ms      | 17.0 / 16.8 ms   | 115 / 150 ms    | 16.9 / 16.7 ms |
| Initial map rendering (layer + | 1.1–1.5 s         | 0.37–0.42 s      | 0.93–0.98 s     | 0.29–0.30 s    |
| first draw)                    |                   |                  |                 |                |

The worst frame of a waypoint drag (0.4–0.55 s) is the route check when the waypoint is dropped:
navigation, not rendering.

At pixel ratio 2, a 2,540 × 1,826 canvas, Grafenwöhr's frames fell from 0.3–0.5 s to an average
of 17.1–22.8 ms for idle, drags, selection and playback. Panning averages 20–28 ms. Single frames
of the settled redraw reach 83–133 ms. Continuous zoom averages 48 ms (21 fps), since each frame
scales a 4.6-megapixel canvas in software. A browser that rasterizes on the GPU does these copies
far faster.

## Consequences

- Idle, selection, drag and playback frames copy one cached image and draw the tactical layer. The
  map reaches 60 fps in those cases on both battlefields.
- Panning draws only the strips that come into view each frame. Zooming draws nothing until the
  view settles.
- Building the terrain layer takes 0.2–0.3 s instead of 0.8–1.3 s.
- The camera is snapped to whole device pixels: the map may sit up to half a device pixel from
  where it was before. That cannot be seen, and tactical symbols use the same camera.
- Simulation, navigation, data and symbols are unchanged.
