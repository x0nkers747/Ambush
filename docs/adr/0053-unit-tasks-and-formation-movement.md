# ADR 0053: Unit tasks and formation movement in the simulation kernel

- Status: Accepted (Behavior Lab milestone M1)
- Date: 2026-10-14
- Builds on:
  - [ADR 0007](0007-simulation-kernel.md): the kernel;
  - [ADR 0008](0008-terrain-and-movement.md): movement;
  - [ADR 0011](0011-tactical-environment.md): navigation.
- Design: [Behavior Lab 03](../behavior-lab/03-architecture-proposal.md)
- Implementation notes: [Behavior Lab implementation](../behavior-lab/implementation.md)

## Context

Soldiers move only by individual orders: straight legs at a constant speed. Organizations
(fire teams, squads) exist in the state but never act. The Behavior Lab initiative needs an
organization to receive one order and move as a group, autonomously, deterministically and
replayably.

## Decision

1. **Unit tasks live in the kernel** (`src/sim/behavior/`). `SimState.behavior` holds the tasks
   and the agents they steer, as plain data.
   - It is absent until the first unit order, so every existing state, hash and pinned value is
     unchanged.
   - `SimWorld.behavior` optionally overrides the tuning parameters. It too is absent by
     default, so world fingerprints are unchanged.
2. **The `orderUnit` command** gives an organization one task (`moveInFormation`: destination,
   optional route points, formation, pace, final facing), or cancels its task (`null`).
   - Rejections:
     - `unknownUnit`;
     - `formationMismatch`, when a slot is held by a soldier outside the unit;
     - `noActiveMembers`;
     - `destinationOffTerrain`, `destinationBlocked` or `destinationUnreachable`.
   - One task per unit at a time. A soldier is steered by at most one task.
   - A Marine leaves a task when he is ordered with another unit (`reordered`), given individual
     orders, or incapacitated. The rest carry on, and the formation does not lean toward the
     missing slots.
   - A new order to a moving unit in the same formation **continues** it: the old task ends
     `superseded`, and the new route begins with the stretch of the old one the Marines occupy.
     The anchor and the Marines keep their speeds, so consecutive waypoints do not stop the squad.
3. **One route per task.**
   - The route is `planPath`'s path through the route points, with each corner rounded to the
     formation's half-width plus 2 m where the arc is walkable (else sharp), measured by arc
     length.
   - A virtual **anchor** advances along it. Its pace waits for the Marines: full pace while the
     worst one is within 0.5 intervals of his slot, falling smoothly to a stop at 2 intervals.
     It also slows before bends and brakes to stop at the end.
4. **Slots are route-relative**: `back` metres behind the anchor along the route and `right`
   metres to its side.
   - Leaders hold doctrinal slots; no Marine is the frame.
   - At the destination the slots blend over 3 s into the final layout, faced to the final
     facing.
5. **Each Marine steers**:
   - his wanted velocity is the slot's own velocity plus a correction toward it (soft dead
     band), capped at 1.3 × pace;
   - velocity changes only within acceleration, braking and sideways-acceleration limits;
   - facing turns at the world's turn rate.

   Positions and facings are the only output. The motion log and the 3D characters read them as
   before.

6. **Phases:** `forming`, then `moving`, then `settling`, then `complete` (or `failed`). Settling
   latches each Marine within 1 m of his slot at under 0.2 m/s (out again beyond 2 m). The task
   completes when all are latched and stopped, or after 60 s (`arrivedIncomplete`).
7. **Determinism.**
   - Integration runs in fixed 120 Hz substeps with times from whole substep counts. Every tick
     rate dividing 120 gives bit-identical results; others agree within millimetres.
   - Tasks run in issue order and agents in soldier order.
   - The task's seed is one draw per order.
   - Diagnostics are pure functions over the state, using the same laws the system steers with.

## Amendment (after the M3 review)

- **No forming up before moving off.** The route starts at the ordered unit's leader, who steps off at once; the others fall in on the move.
  - Until all have fallen in, the unit keeps 0.75 × pace, and Marines still falling in do not hold it back.
- **The formation is arranged** (which team leads, mirrored or not) to ask the least walking from where the Marines stand.
- **Personal space is anticipated** (time to collision).
- The phases are `moving`, `settling`, then `complete` or `failed`.
- Details and evidence: [implementation notes](../behavior-lab/implementation.md#after-review-the-leader-steps-off-the-others-fall-in-on-the-move).

## Consequences

- An organization of any echelon can be moved by one command. Formations are data the kernel
  does not interpret: templates and roles stay in `#exercise`.
- **Measured** (Node 24, open ground, 30 Hz):

  | Soldiers | Unit movement per tick | Same soldiers, individual orders |
  | -------: | ---------------------: | -------------------------------: |
  |       13 |            about 20 µs |                           2.7 µs |
  |    1,001 |           about 1.7 ms |                           0.4 ms |

  120 Hz substeps are within 4 mm of a 960 Hz reference, and 60 Hz within 2 cm.

- Not yet:
  - obstacles inside the formation's corridor (clearance field, detours);
  - collision avoidance;
  - automatic file compression;
  - slope effects.

  These belong to later milestones (Behavior Lab 06, M4–M5).
