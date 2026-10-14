# ADR 0054: The Behavior Lab

- Status: Accepted (Behavior Lab milestone M3)
- Date: 2026-10-14
- Builds on:
  - [ADR 0053](0053-unit-tasks-and-formation-movement.md): unit tasks;
  - [ADR 0052](0052-animated-soldiers.md): animated soldiers.
- Design: [Behavior Lab 04](../behavior-lab/04-behavior-lab-design.md)
- Notes: [implementation](../behavior-lab/implementation.md#m3-the-behavior-lab-page)

## Context

Unit behaviours need a place to be developed, measured and judged by eye on the real simulation
and the real animated soldiers, without touching the game's workflow.

## Decision

1. **A page at `#behavior-lab`.**
   - The app's composition root imports it lazily, only at that address.
   - Its headless side (`#exercise/behavior-lab`: runs, scenarios, metrics, acceptance) and its page (`#view3d/behavior-lab`) are not re-exported from `#exercise` or `#view3d`.
   - An isolation test enforces it.
   - It ships in the production build as its own chunk.
2. **The real kernel.**
   - A run is a `LabRunSpec` (organization, formation, spacing, pace, start, waypoints, disturbances, seed, tick rate) plus its commands.
   - Orders and disturbances are simulation commands (`orderUnit`, `disturbAgent`). The page never changes state itself.
3. **Its own small scene.**
   - The game's renderer settings, lights, shadow configuration and tactical camera, with the game's character layer (Rocketbox soldiers, native animation), over flat ground.
   - The battlefield view is not reused: it needs a whole exercise and the terrain pipeline, which the lab's synthetic ground does not.
4. **Replay re-simulates**, unlike the game's review (ADR 0026):
   - every second's state hash is recorded;
   - replays and loaded files are checked against them;
   - scrubbing restores a keyframe and re-simulates to the tick shown;
   - playing from an earlier tick branches.
5. **Everything shown comes from the simulation**:
   - positions from the motion log, as the game's characters read them;
   - overlays and explanations from `behaviorDiagnostics`, which uses the laws the system steers with;
   - metrics from the state.

## Consequences

- Behaviours can be watched, measured, disturbed, replayed and compared in the browser, and the same scenarios run headless in the tests and the seed sweep.
- The game is unchanged: its review, views and workflow do not load the lab.
- Real terrain in the lab (M5) will need the battlefield view or its terrain renderer behind a narrower interface.
