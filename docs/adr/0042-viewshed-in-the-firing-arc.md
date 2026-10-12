# ADR 0042: Viewsheds limited to the firing arc

- Status: Accepted
- Date: 2026-10-12
- Amends ADR 0011 and ADR 0020 (viewsheds and the viewshed service), ADR 0022 (fire-team visible
  areas) and ADR 0039 (viewsheds in 3D). Uses the engagement wedge of ADR 0018.

## Context

The visibility overlay showed everything a selected Marine (or fire team) could see on the whole
battlefield.

- **Cost.** On a 5 km battlefield at 4 m that is 1,562,500 cells, and a full viewshed took 30–45 s
  of computing time at Quantico and Grafenwöhr. Spread over the worker pool it was several seconds
  for every move or turn.
- **Usefulness.** Trainees plan what each Marine covers along the way he faces. That is the
  engagement wedge drawn in front of him: 35° wide, out to his primary weapon's maximum
  engagement range (400–600 m). Visibility far behind or beside him was noise.

## Decision

The overlay shows only the ground in each Marine's engagement wedge.

- **Sectors in the simulation's viewshed** (`sim/viewshed.ts`).
  - `ViewSector` is the arc: an azimuth, a half-width and a range.
  - `computeViewshedRows`, `computeUnionRows` and `computeViewshed` take an optional sector (one per
    observer for a union). Cells outside it are reported not visible without being decided. Cells
    inside are decided exactly as before, so a cell in the arc is visible exactly when the full
    viewshed says so (tested).
  - `inSector` is the test. It handles arcs across north and the observer's own cell.
- **The service** (`viewshed-service.ts`) passes each observer's sector to the workers and hands out
  only the bands of rows the sectors reach (`sectorRows`). The cache key includes the sector, so
  turning a Marine computes his new arc, which is quick, and turning back finds the old one cached.
- **The map** (`map.ts`) takes each Marine's sector from `engagementWedge`: his planned pose while
  plans can be edited, otherwise where he is and the way he faces. A fire team's visible area is
  the union of its Marines' arcs.
  - A Marine with no wedge (no known primary firearm) keeps the whole-battlefield viewshed.
- **Kill-zone coverage** is now the share of the kill zone visible in the firing arcs. The sidebar
  says so.
- **Unchanged.** The simulation's combat, line of sight, AAR and scoring never used these
  viewsheds, so they are unaffected. The overlay is drawn the same way in 2D and 3D.

## Measurements

Node, one thread, at 4 m cells, with a 35° arc out to 550 m. The full viewsheds were measured while
the test suite ran alongside.

| Site       | Full battlefield | Arc (three facings) | Faster   |
| ---------- | ---------------- | ------------------- | -------- |
| Quantico   | 45–46 s          | 110–240 ms          | 190–410× |
| Grafenwöhr | 31 s             | 70–120 ms           | 260–470× |

## Consequences

- Visibility now updates almost at once when a Marine is moved or turned. The coarse preview while
  dragging remains, but is rarely needed.
- Ground a Marine could see outside his arc is no longer shown. That is the intent: the overlay
  answers "what does he cover", not "what could he see if he turned".
