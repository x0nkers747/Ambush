# Behavior Lab: implementation notes

What was built, how it departs from the proposal ([03](03-architecture-proposal.md)), its
parameters, measurements and limitations, milestone by milestone.

## M1: kernel foundations

**Code.** `src/sim/behavior/`:

| File                | Contents                                                                              |
| ------------------- | ------------------------------------------------------------------------------------- |
| `types.ts`          | `BehaviorState`, `UnitTask`, `AgentState`, `UnitOrder`, `FormationSpec`, `GroupRoute` |
| `orders.ts`         | The `orderUnit` command: validation, application, continuation, cancellation          |
| `route.ts`          | Group route: corner rounding, arc length, point/tangent/curvature queries             |
| `formation-spec.ts` | Spec checks and the flattened slot table                                              |
| `slots.ts`          | Slot targets: route-relative, with settling blend                                     |
| `system.ts`         | The per-tick system: substeps, task pace law, agent steering and integration, release |
| `diagnostics.ts`    | Pure explanations for views                                                           |
| `params.ts`         | Tuning parameters and their defaults                                                  |

**Kernel changes.**

- `SimState.behavior?`, `SimWorld.behavior?` and `Scenario.behavior?`.
- The `orderUnit` command and four events: `unitOrdered`, `unitPhaseChanged`, `unitTaskEnded`, `memberReleased`.
- New rejection reasons.
- `stepState` calls `updateBehavior` before `moveSoldiers`.
- `setOrders` releases a Marine from his task.

### Departures from the proposal

| Proposal                                                           | Built                                                                                                                                                                   | Why                                                                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target = slot 1.5 s ahead (look-ahead)                             | Slot velocity as feed-forward + correction toward the current slot                                                                                                      | Same effect (corrections lead instead of lag), without a tunable horizon. A Marine on station moves exactly with his slot.                              |
| No correction inside the dead band                                 | Soft dead band: correction K·e²/(2·band) inside, K·(e − band/2) beyond                                                                                                  | A hard band left every Marine trailing his slot by exactly the band (1.5 m) for good. The soft band corrects small errors slowly, without chasing them. |
| `mode` (open/compressed/file), clearance field, detours, avoidance | Not built                                                                                                                                                               | M4 (approved scope).                                                                                                                                    |
| `AgentState.progressS`, `sinceProgress`, `detour`                  | Not built                                                                                                                                                               | Stuck detection is M2; detours are M4.                                                                                                                  |
| Trace sink                                                         | Not built                                                                                                                                                               | Diagnostics recompute everything the lab needs from the state. Revisit if a value only exists inside a substep.                                         |
| One destination per order                                          | Plus optional `via` route points                                                                                                                                        | Scenario 4 (a 90° turn with one order) needs a route with a corner on open ground.                                                                      |
| Consecutive waypoints as successive orders                         | Successive orders **continue** a moving task (same formation): the route keeps the occupied stretch; anchor and agents keep their speed; the old task ends `superseded` | Issued as fresh tasks, each waypoint stopped and re-formed the squad.                                                                                   |

### Parameters (defaults, `params.ts`)

All of these are tuning values, not doctrine.

| Parameter                                    | Value              | Meaning                                 |
| -------------------------------------------- | ------------------ | --------------------------------------- |
| `substepHz`                                  | 120                | Internal integration rate               |
| `anchorAccel`                                | 0.5 m/s²           | Anchor acceleration                     |
| `anchorDecel`                                | 1.0 m/s²           | Anchor braking                          |
| `anchorArriveDecel`                          | 0.4 m/s²           | Anchor arrival braking                  |
| `lagStart`, `lagStop`                        | 0.5, 2.0 intervals | Pace law: full pace below, stop at      |
| `bendSpeedFactor`                            | 1.15               | Outermost slot's speed on bends, × pace |
| `maxSpeedFactor`                             | 1.3                | Catch-up limit, × pace                  |
| `trackingGain`                               | 0.3 /s             | Correction speed per metre              |
| `deadBand`                                   | 0.15 interval      | Soft dead band                          |
| `accel`                                      | 1.0 m/s²           | Marine acceleration                     |
| `decel`                                      | 2.0 m/s²           | Marine braking                          |
| `lateralAccel`                               | 1.5 m/s²           | Marine sideways (turning) acceleration  |
| `formingBand`                                | 0.5 interval       | Forming ends when all are within this…  |
| `formingTimeout`                             | 20 s               | …or after this long                     |
| `settleBlend`                                | 3 s                | Blend into the final layout             |
| `latchRadius`, `latchSpeed`, `unlatchRadius` | 1 m, 0.2 m/s, 2 m  | In-position latch and release           |
| `settleTimeout`                              | 60 s               | Settling gives up waiting               |
| `cornerMargin`                               | 2 m                | Added to half-width for corner radius   |
| `facingSpeed`                                | 0.3 m/s            | Facing follows travel above this speed  |

### Results

**Squad, 300 m north on flat ground (`behavior.test.ts`):**

- forming takes 14.8 s from a loose cluster;
- steady formation error is about 5 cm;
- the top speed is 1.82 m/s (1.3 × 1.4);
- every Marine latches within 1 m and stops;
- the task ends `arrived`.

**Rule tests.** Rejections, release on individual orders and on incapacitation, a fire team
re-ordered out of the squad task, continuation (`superseded`, speed kept), and cancellation.

**Determinism tests:**

- repeatability;
- **bit-identical results at 10, 30, 60 and 120 Hz** (canonical encoding of soldiers and behaviour state after 90 s, with a turn);
- 50 Hz against 60 Hz within 5 cm;
- snapshot and restore mid-move, giving an identical hash;
- existing pinned hashes unchanged.

**Benchmark** (`AMBUSH_BEHAVIOR_BENCH=1 npx vitest run tools/behavior-bench.test.ts --silent=false`; Node 24, this machine; squads of 13 on open ground, 30 Hz, after forming):

| Soldiers | Unit movement tick p50 |     p95 | Kernel, same soldiers on individual orders, p50 | Order (all squads) | State hash |
| -------: | ---------------------: | ------: | ----------------------------------------------: | -----------------: | ---------: |
|       13 |                20.5 µs | 27.8 µs |                                          2.7 µs |             2.7 ms |    0.33 ms |
|       39 |                56.9 µs | 61.3 µs |                                          6.6 µs |             1.3 ms |    0.45 ms |
|      104 |                 149 µs |  199 µs |                                         17.4 µs |             1.1 ms |    0.83 ms |
|    1,001 |                1.68 ms | 4.56 ms |                                         0.42 ms |              22 ms |      20 ms |

- Route creation on open ground with one corner costs 0.02 ms.
- The first version scanned every agent for every task: 12 ms per tick at 1,001 soldiers. Agents are now gathered per task once a tick.

**Substep rate** (one squad, 200 s, against 960 Hz):

|    Substep |   Cost | Largest position difference |
| ---------: | -----: | --------------------------: |
|      60 Hz | 108 ms |                      2.1 cm |
| **120 Hz** | 242 ms |                  **3.6 mm** |
|     240 Hz | 429 ms |                      0.7 mm |

**Conclusion:** 120 Hz is kept. It costs half as much as 240 Hz for a difference far below
anything visible, and it divides the game's 30 Hz.
