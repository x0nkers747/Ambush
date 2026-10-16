# ADR 0055: Squad viewsheds for planning

- Status: Accepted
- Date: 2026-10-16
- Brings back the viewsheds of ADR 0011, 0020, 0022 and 0042, removed with the old exercise
  engine (commit 63d514a), for the battle planner. Uses the ground overlay of ADR 0039.

## Context

Planners need to see what a squad will be able to see. They need it where the squad stands, and
where it will stand at each waypoint of its plan. The answer must come in a second or two.

A squad is 13 soldiers. The exact union of their viewsheds, all round to 1,200 m on a 4 m grid,
is about 280,000 cells per soldier. On Quantico, with 4 workers, it took 6–10 s. Most of that
time went on two things:

- cells hidden from every soldier, which each soldier had to prove hidden;
- distant visible cells, each needing a full trace of up to 1.2 km.

## Decision

**What is shown.** The selected squad's viewshed is the union of its soldiers' viewsheds. It is
drawn light purple, see-through, with a deeper purple edge. In 2D it is drawn over the map; in 3D
it is draped on the ground (`setGroundOverlay`).

- **Range:** all round, out to 1,200 m. That is the detection model's longest observation range
  (open, clear air): nothing further can be detected.
- **From the start:** the soldiers where the battle starts them (`squadSoldierStarts`, moved clear
  of water and buildings).
- **From a selected waypoint:** where the formation will put them on arriving there, facing the
  way they came. At an ambush position it is the firing line, facing the kill zone
  (`viewshedObservers`, `src/app/battle/squad-viewshed.ts`).
- **Eye height:** standing (1.7 m), with a standing target (1.5 m).

It is shown in Scenario Setup and BLUEFOR Planning. The **Viewshed** check box on the map bar
(or **V**) turns it off.

**Coarse to fine.**

1. The union is first computed exactly on a 32 m grid.
2. Each finer grid is then refined from the one before: 16 m, 8 m, then 4 m
   (`refinementOf`, `ViewshedService.requestRefined`).

A fine cell is settled from its coarse cell, and not decided again, when its coarse cell and the
eight around it agree and it is more than 40 m from every soldier. How it is settled depends on
the coarse value:

- **Hidden:** settled as hidden.
- **Visible:** settled as visible only when it is also more than 50 coarse cells away (400 m at
  8 m, 800 m at 16 m). Nearer visible ground is always decided again.

Every edge between visible and hidden ground is decided at full detail. The ground within 40 m is
decided at full detail. So is the visible ground near the squad, out to 400 m. Further out, the
detail of visible ground falls off with distance, as it does to the eye: about 1.15° across.

The rest of the machinery is the same as before:

- **Settled cells:** `computeViewshedRows` and `computeUnionRows` take an optional `settled` mask.
  The worker protocol carries it as it carries `known`.
- **Bands:** refinement uses 16-row bands, so its work, concentrated where the ground is visible,
  is shared among the workers.
- **More workers:** on a light battlefield (under 60,000 feature points) the pool uses up to half
  the cores, at most 8. Otherwise it is 4 at most, as before (ADR 0045).
- **Warm-up:** the pool starts when a planning stage opens, so the first viewshed does not wait for
  the workers to prepare the terrain.

## Consequences

Measured on Quantico (5 km, 48,000 feature points, 8 workers, warm), for a 13-soldier squad:

- the first look (32 m) in about 0.25–0.3 s;
- 8 m detail by about 0.8 s;
- full 4 m detail in 1.7–1.9 s.

Exact, the 4 m union took 6–10 s.

Against the exact union, 0.1–0.8% fewer cells are visible. The refinement never shows hidden
ground as visible within 400 m (tested). It differs only where the coarse grid missed something
smaller than its cells, away from any edge: a glimpse deep inside hidden ground, or a small shadow
far out in visible ground.

Each result is cached by the soldiers' exact positions. Selecting a squad or waypoint again shows
its viewshed at once.

## Amendment (2026-10-16): any number of viewsheds, by side, while dragging

**Turned on one by one.** Viewsheds no longer follow the selection. Each squad's start, and each
of its waypoints, has an eye in the squad panel that turns its viewshed on or off. **V** does the
same for the selected squad or waypoint. Any number can be on, of either side.

- **Following their orders.** The planner keeps them (`viewsheds`, `toggleViewshed`). They follow
  their orders when orders are added before them, moved or deleted. They go when their order or
  squad does.
- **On the map.** Each viewshed that is on is ringed on the map.
- **Show or hide all.** The **Viewsheds** box on the map bar shows or hides them all, keeping them
  on.
- **OPFOR hidden.** In BLUEFOR Planning, OPFOR's are hidden with OPFOR.

**By side.** `composeViewsheds` puts them all on one 4 m grid:

- BLUEFOR's are light blue and OPFOR's light red. Ground both sides see is purple.
- Each side's viewsheds are joined, and each side's has a deeper edge.
- Coarser results are read at each cell's centre. Only the area within range of the observers is
  composed.
- The same pixels are drawn over the 2D map and draped on the 3D ground.

**One at a time.** The workers compute one job at a time, and a new request cancels a large job.
So each frame only one viewshed asks for work:

- the selected one (being dragged) first, then the latest turned on;
- the others show what the cache already holds (`cachedUnion`, `cachedRefined`).

**While dragging.** Jobs up to 30,000 cells (a 5 km battlefield's 32 m grid) now finish before the
next request starts. A dragged waypoint's viewshed keeps its last few positions. Until its own is
in, it shows the latest finished from them. A drag therefore shows a stream of first looks, one
every 0.1–0.2 s, trailing the pointer slightly. Full detail follows about 2 s after the drop.
