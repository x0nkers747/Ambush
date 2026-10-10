# ADR 0024: Spot heights on the tactical map

- Status: Accepted
- Date: 2026-10-10

## Context

The tactical map shows relief with hillshade and contours, but reading a hilltop's height means
counting contours. Paper military maps mark summits with a spot height: a dot at the top with
the elevation written next to it. Trainees choosing ambush and support-by-fire positions want to
see at a glance which hill is highest and by how much.

## Decision

The map marks summits with a dot and their elevation in whole metres, to the right of the dot.
There is no toggle, and no spot heights at road junctions or low points.

**Which summits.** Summits are found once per terrain, when the terrain layer is created, by
topographic prominence: how far a summit stands above the highest col connecting it to higher
ground. Samples are flooded from the highest down, joining 8-connected neighbours with
union–find; when two regions meet, the lower region's summit gets prominence = its elevation −
the meeting sample's elevation. The highest summit's prominence is its height above the lowest
sample. A summit is kept when:

- its prominence is at least 2 m (smaller bumps are noise in the elevation data);
- it is at least 50 m from the terrain's edge (a summit at the edge may be a slope that rises
  beyond it);
- it is not a spike more than 15 m above all eight neighbours (a data error, or a tower or tree
  in a surface model).

A flat top (several samples at the same height) is marked at its middle sample.

**Which are shown.** At each zoom only summits with prominence ≥ max(2 m, 2 × metres per pixel)
are candidates, so the whole-map view shows the major hills and zooming in reveals the knolls.
Candidates are placed greedily from the most prominent; one whose dot and label box (in metres,
with 4 px padding) would overlap one already placed is skipped. Placement covers the whole map
and is then filtered to the area being drawn, so strips redrawn during a pan (ADR 0017) agree
with the full redraw.

**Drawing.** Spot heights are drawn in the last feature phase, after feature labels: a 2.5 px dark
brown dot with a white halo, and a bold 10 px label with the same halo as other map labels.

## Consequences

- Measured on real battlefields: Quantico has 112 summits, found in 252 ms; Grafenwöhr has 46,
  found in 241 ms. The whole-map view (about 5.7 m/px) shows 12 at Quantico and 6 at
  Grafenwöhr; at 2 m/px Quantico shows 52.
- Heights are as accurate as the elevation data, typically a few metres. Where the data is a
  surface model, a wood or building on flat ground can appear as a low summit. A summit is placed
  on a sample, so its dot can be off by up to about 7 m (half a sample diagonal).
- Placement is recomputed on every redraw, including pan strips. With about a hundred summits it
  costs little next to drawing the map.
