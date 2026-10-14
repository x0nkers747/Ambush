# Behavior Lab 04: design of the permanent test harness

- Status: design (nothing implemented)
- Date: 2026-10-14
- Part of: [Behavior Lab research](README.md)

The Behavior Lab is a page of the Ambush! app for developing and judging unit behaviours on the
real simulation, the real soldiers and the real renderer, without touching the game's workflow.

## 1. Principles

1. **The real simulation, not a model of it.**
   - The lab runs `createSimulation`, sends `orderUnit` commands, and steps with `createFixedStepRunner`.
   - Whatever behaves well in the lab behaves the same in the game, because it _is_ the game's kernel.
2. **Isolated.**
   - Its own route (`#behavior-lab`), loaded by one hash-guarded dynamic import, as the terrain lab was (01 §12).
   - An isolation test proves nothing else in the app imports it.
   - Removing the lab removes one line from `main.ts`.
3. **Reproducible.** A lab run is a scenario plus a seed plus a tick rate plus a command list. Running the same run twice gives the same state hash at every tick. Every run can be saved, reloaded and replayed exactly.
4. **Explains itself.** Every overlay comes from `SimState` through `#sim` diagnostics or the write-only trace (03 §9). Nothing on screen is decided by the renderer.
5. **Measures, not just shows.** Every scenario produces metrics (05) live on screen and in headless batch runs from the command line.

## 2. Where it lives

```
src/exercise/behavior-lab/        headless (exercise layer; no DOM)
  scenarios.ts                    scenario builders (organisation, terrain, obstacles, orders, disturbances)
  run.ts                          LabRun: sim + runner + command list + motion log + keyframes + metrics
  metrics.ts                      per-tick metric accumulators (05 §3) from SimState + diagnostics
  record.ts                       save/load runs (plain JSON: scenario id, params, seed, rate, commands)
  *.test.ts                       scenario suite, determinism, metrics (05)

src/view3d/behavior-lab/          the page (view3d layer; three.js allowed)
  lab.ts                          startBehaviorLab(root, source): layout, controls, frame loop
  scene.ts                        ground, buildings, obstacles; reuses the terrain renderer
  overlays.ts                     debug drawing (2D overlay canvas + 3D lines)
  inspector.ts                    hierarchy tree, selected unit/soldier panels, timeline graphs

src/app/main.ts                   if (location.hash.startsWith('#behavior-lab')) → dynamic import
src/app/behavior-lab-isolation.test.ts
```

**Layer rules.**

- view3d may import `#sim`, `#exercise` and `#session`. Terrain from the store (`#acquire`, `#geo`) is supplied by the app through a small source interface, as `LabSource` did for the terrain lab.

**The 3D view needs a narrow source.**

- `createBattlefieldView3d` takes a whole `Exercise` (01 §9). The lab has a simulation, not an exercise.
- Two options:
  - **(a)** Give the lab an adapter that presents a `LabRun` as the subset of `Exercise` the view reads: simulation, motion log, render seconds, combat log.
  - **(b)** Narrow the view's option type to that subset.
- We recommend **(b)**. It is a small type-only change, and the game passes its `Exercise` as before (07, Q6).

## 3. Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Behavior Lab  [scenario ▼] [seed 1] [rate 30 ▼]  ▶ ❚❚ ⟲  speed [¼ ½ 1 2 4 8 16]  T+ 00:42.3 │
├───────────────┬──────────────────────────────────────────────┬───────────────┤
│ ORGANISATION  │                                              │ INSPECTOR     │
│ ▾ 1st Plt     │                                              │ SQD (task)    │
│   ▾ 1st Sqd ● │            3D view (or 2D map)               │ phase moving  │
│     ▸ FT1     │                                              │ mode open     │
│     ▸ FT2     │   overlays: slots, routes, errors, …          │ pace 1.31 m/s │
│     ▸ FT3     │                                              │ lag max 4.2 m │
│ ORDER         │                                              │ ─────────────  │
│ formation [▼] │                                              │ M07 (agent)   │
│ spacing  10 m │                                              │ band drifting │
│ pace 1.4 m/s  │                                              │ err  2.1/0.4 m│
│ [Set dest] [Go]│                                             │ v 1.52 m/s    │
│ OBSTACLES     │                                              │ detour none   │
│ [box] [wall]  │                                              │               │
│ [water] [clear]│                                             │               │
│ DISTURB       │                                              │               │
│ [delay M07]   │                                              │               │
│ [push FT2]    │                                              │               │
├───────────────┴──────────────────────────────────────────────┴───────────────┤
│ timeline ▁▂▃▅▆▇ (scrub)   graphs: formation error, cohesion, speeds, CPU/tick           │
│ metrics: mean err 1.1 m · max 3.8 m · out-of-band 2.1 % · collisions 0 · stuck 0 · 34 µs/tick │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 4. Capabilities

| Capability                  | How                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn organisations         | Built from organisation templates (`#exercise` organisation data):<br>• 3-Marine element (`TEST` team of 3: the Army-style or OPFOR-style team)<br>• 4-Marine fire team<br>• 13-Marine USMC squad<br>• Army 9-soldier squad<br>• Marine platoon (3 squads + HQ, about 43)<br>• "N × squad" stress groups<br>Placed in a chosen formation or scattered (seeded). |
| Formation types             | Template list for the selected unit's echelon (03 §6). Spacing, team spacing and pace sliders feed `build-spec`.                                                                                                                                                                                                                                                |
| Destination                 | Click on the ground (3D `groundProjection` or 2D map), or the scenario's scripted orders. Multiple waypoints are queued as successive orders, each issued on the previous task's end.                                                                                                                                                                           |
| Start, pause, resume, reset | The runner's pause and resume. Reset rebuilds the simulation from scenario and seed.                                                                                                                                                                                                                                                                            |
| Speed                       | Time scale ¼ to 16 (the runner's `timeScale`), plus single-tick stepping.                                                                                                                                                                                                                                                                                       |
| Tick rate                   | 10, 20, 30, 60 or 120 Hz (divisors of 120) for comparisons.                                                                                                                                                                                                                                                                                                     |
| Static obstacles            | Boxes (buildings), walls and water polygons, placed before the run. They become part of the lab terrain's `EnvironmentFeatures`, so the navigation grid and clearance field include them: real obstacles, not overlays. Changing obstacles resets the run.                                                                                                      |
| Terrain                     | **Synthetic:** flat, slope, ridge, `DEMO_SCENARIO`'s valley.<br>**Representative:** a stored battlefield from IndexedDB via the app's source, or in dev a `lab-data/` package (01 §12).<br>**Fixtures:** for headless tests.                                                                                                                                    |
| Disturbances                | Scripted or clicked:<br>• hold a Marine for N s (a `setOrders` to stand still, then he rejoins by `orderUnit` membership)<br>• push a team sideways<br>• release a member<br>• incapacitate one (status change)<br>All are ordinary commands, so they are recorded and replayable.                                                                              |
| Fixed seeds                 | Seed field; "re-run" repeats exactly; "seed sweep" runs N seeds headless and summarises.                                                                                                                                                                                                                                                                        |
| Record and replay           | A run is `{scenario, params, seed, rate, commands}`. Replay re-simulates, which is exact by determinism and checked by per-tick hashes stored every second. Scrubbing uses keyframe snapshots every 5 s, re-simulating forward from the nearest one (fast: ~30 µs a tick for a squad). Runs save to JSON and load back.                                         |
| Inspection                  | Click a soldier or unit (3D picking or the tree):<br>• task state<br>• agent state<br>• band<br>• errors<br>• detour<br>• the trace for the current tick<br>Hover shows a tooltip.                                                                                                                                                                              |
| Compare                     | Two seeds, rates or parameter sets side by side as ghost overlays (one solid, one outlined), with a divergence readout.                                                                                                                                                                                                                                         |

**Why replay re-simulates in the lab, not like the game's AAR.**

- The game's AAR stores full frames because the game must never re-simulate (ADR 0026).
- The lab instead _tests_ determinism by re-simulating and comparing hashes. Storing only commands keeps long batch runs small.
- The game's AAR path is tested separately (05 §5).

## 5. Rendering

**3D.**

- The lab feeds the real character layer from the run's motion log, so soldiers walk, turn and stop with the real animation.
- It uses the terrain renderer for real battlefields and simple meshes for synthetic obstacles.

**2D.** The same overlays drawn on the 2D map projection, for top-down inspection (`MapProjection` is shared by both views, ADR 0039).

**Render time.** One tick behind plus alpha, as in the game (01 §10). Overlays read the same render time, interpolating state from the two recorded ticks around it, so overlays and soldiers agree.

## 6. Visual debugging

Each overlay can be toggled, and is drawn for the selected unit (or all units).

| Overlay              | Shows                                                                                                                                           | Source                          |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Hierarchy            | Lines from each element's anchor point to its parent's; units colour-coded; leaders ringed                                                      | `FormationSpec` + `slotTargets` |
| Leaders              | SL, team leaders, platoon commander: ring and label                                                                                             | template roles                  |
| Slots                | Each slot target (cross), labelled by role; lateral clamp shown when active (bar to the corridor edge)                                          | `slotTargets`                   |
| Actual vs desired    | Line from each soldier to his slot target, coloured by band (green on station, yellow drifting, orange displaced, red out of contact)           | `formationError`                |
| Route                | The group route: corners, rounded arcs, arc-length ticks every 10 m, anchor marker with speed                                                   | `UnitTask.route`, `anchorS`     |
| Corridor             | Clearance band along the route (shaded width), mode switch points (open, compressed, file)                                                      | `corridor`                      |
| Individual targets   | Look-ahead point (`p_ahead`) and the active detour polyline                                                                                     | `explain`                       |
| Heading and velocity | Facing arrow and velocity vector per soldier (length proportional to speed)                                                                     | state (`azimuth`, `vx, vy`)     |
| Formation error      | Per soldier along- and across-track error as small bars; per unit the RMS as a halo                                                             | `formationError`                |
| Cohesion             | Convex hull of each element; worst-lag member highlighted; contact (sight) lines between leaders, with lines broken where buildings block sight | `cohesion` + `lineOfSight`      |
| Behaviour states     | Text badges: task phase and mode, agent band, `latched`, `stuck`                                                                                | state                           |
| Recovery             | Pulsing marker on members in catch-up; anchor "waiting" indicator when pace is reduced; arrow for a detour                                      | state + `explain`               |
| Avoidance            | Neighbours considered (thin lines), avoidance force (arrow), yield decisions (who gave way), rejected search cells                              | trace (write-only)              |
| Trails               | Last 20 s of each soldier's path (from the motion log), for spotting oscillation and sliding                                                    | motion log                      |

**Graphs** (timeline panel) run over the whole run, with a cursor at the current time:

- formation error (mean and max);
- worst lag;
- anchor pace;
- per-member speed (spaghetti);
- the count of members in each band;
- CPU per tick.

**"Why" panel.** For the selected soldier, one line per decision this tick. For example:

> "target = slot FT2.AR at s=184.2 (back 17 m, right 6.9→4.0 m clamped by clearance 5.0 m); e_along −3.1 m → v_pref 1.58 m/s; avoidance −0.12 m/s from M06; facing turning 12°/tick."

## 7. Scenario controls

Scenarios are data in `src/exercise/behavior-lab/scenarios.ts`. Each has:

- a terrain kind;
- obstacles;
- an organisation;
- an initial formation;
- scripted orders and disturbances with times;
- the metrics to assert in tests ([05 §2](05-test-and-benchmark-plan.md#2-scenario-suite)).

The lab's scenario menu lists them. Any scenario can be edited live (parameters, obstacles) and saved as a new run.

## 8. Headless use

`npm run lab -- --scenario s04-turn-90 --seeds 1..20 --rate 30` runs scenarios without a browser, through the same `LabRun`, and prints or writes the metrics (JSON and a Markdown table).

- Benchmarks (05 §4) use it with `--count`.
- CI runs the fast subset as ordinary Vitest tests.

## 9. What the lab is not

- **Not a scenario editor for the game.**
- **Not a second simulation.** It owns no movement code; everything it shows is computed by `#sim`.
- **Not part of the game's build path for players.** It ships in the build (lazily loaded) so that the deployed site can demonstrate behaviours. Whether it should be dev-only is 07, Q8.
