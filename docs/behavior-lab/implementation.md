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

## M2: formation templates and movement laws

**Code.**

| File                                                         | Contents                                                                    |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `src/exercise/formations/templates.json`                     | Doctrinal movement formations, as data                                      |
| `src/exercise/formations/formations.ts`                      | Template validation and the builder (template + roster → `FormationSpec`)   |
| `src/exercise/organizations/usmc-fire-team-mcwp-3-11-2.json` | The 4-Marine fire team, as an organization template                         |
| `src/exercise/organizations/three-marine-element.json`       | The 3-Marine element (synthetic), as an organization template               |
| `src/exercise/behavior-lab/run.ts`                           | `LabRun`: the reproducible run (spec, simulation, commands)                 |
| `src/exercise/behavior-lab/scenarios.ts`                     | Scenarios 1–5                                                               |
| `src/exercise/behavior-lab/metrics.ts`                       | Metrics from simulation state                                               |
| `src/exercise/behavior-lab/acceptance.ts`                    | Acceptance thresholds                                                       |
| `src/exercise/behavior-lab/index.ts`                         | The entry point, `#exercise/behavior-lab`, not re-exported from `#exercise` |

**Kernel additions.**

| File or change         | Contents                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `noise.ts`             | Seeded smooth noise for each Marine's personal drift                                      |
| `crowd.ts`             | Personal space: an ordered neighbour grid over start-of-substep positions                 |
| `disturbAgent` command | Hold, go to a point, or release a Marine; rejected as `notSteered` if no task steers him  |
| Agent fields           | Straggling (out of contact for 10 s), stuck (no progress over 10 s), disturbance override |

### Formations

| Organization            | Templates                        | Doctrine                                                            |
| ----------------------- | -------------------------------- | ------------------------------------------------------------------- |
| 3-Marine element        | wedge, file                      | After the fire-team wedge (leader at the point)                     |
| 4-Marine USMC fire team | wedge, column, file, skirmishers | MCRP 3-10A.4 Figs 1-11 to 1-14 (rifleman at the point of the wedge) |
| 13-Marine USMC squad    | wedge, column, line, file        | MCRP 3-10A.4 Figs 1-15 to 1-18                                      |
| US Army fire team       | wedge (alternative)              | ATP 3-21.8 Fig 3-2 (team leader at the point)                       |

**How templates work.**

- Templates place **roles**, not soldiers. The builder fills slots from the roster by role. Members without a slot follow in file.
- Child units are placed by **elements**, each in its own formation.
- A unit left of its parent's line is **mirrored**, so team leaders are on the side nearest the squad leader, as the figures show.
- Distances: a unit's own slots are measured in intervals d (default 10 m). Elements are measured in element spacings D (default 2d).
- Geometry beyond the figures' relative positions is tuning, not doctrine: stagger 0.15d, column spacing 0.8d, element offsets.

### Movement laws added

- **Personal drift.** Each slot wanders within 0.1d (a smooth seeded walk that changes course every 8 s). Formations are never rigid. The drift fades out while settling. Steady error is about 0.4 m at d = 10 m: the drift, followed closely.
- **Personal space.** Marines closer than 1.2 m ease apart at up to 0.8 m/s.
- **Stragglers and stuck Marines.** Neither holds the anchor back:
  - a straggler has been out of contact (beyond 3d, at least 30 m) for 10 s;
  - a stuck Marine made under 0.5 m of progress over 10 s.
- **Disturbances.** A held Marine counts in the pace law, so the unit slows for him. It stops only if he falls 2 intervals behind.

### Departures and calibration (with evidence)

| Change                                                                                                                                      | Evidence                                                                                                                                               | Kind                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `formingBand` 0.5 → 0.25 intervals                                                                                                          | At d = 5 m, movement began with Marines 2.5 m off their slots, above the 0.4d (2 m) error threshold. Doctrine has no number; forming now ends tighter. | Parameter                               |
| Latching waits for the 3 s settling blend                                                                                                   | Marines latched before the final layout was reached, then stood a little off it.                                                                       | Behaviour                               |
| A continuing order keeps the old route to the old destination and turns there                                                               | Turning at the anchor swung the leading Marine's slot round the corner (a 28 m error).                                                                 | Behaviour                               |
| The lab orders the next waypoint while the corner is still ahead of the leading Marine (formation reach + half-width + 12 m before the end) | Ordered 12 m before the end, the corner's rounded arc began behind the leading Marine.                                                                 | Lab policy                              |
| Squad leader 0.6 D (was 0.5 D) behind the lead team                                                                                         | At d = 5 m he started 1.5 m from the lead team's automatic rifleman: a contact at the start.                                                           | Template                                |
| Start offsets limited to 0.15 d                                                                                                             | ±2 m at d = 5 m put two Marines 0.59 m apart at the start.                                                                                             | Lab scenario                            |
| Speed reversals counted only while moving                                                                                                   | Starting, stopping and settling counted as "oscillation": 3 reversals on a 3-minute run, the same for every seed.                                      | Metric definition (threshold unchanged) |

### Results: 50-seed sweep (`AMBUSH_BEHAVIOR_SWEEP=50 npx vitest run tools/behavior-sweep.test.ts --silent=false`)

All 600 runs accepted: 2 organizations, 6 scenario variants and 50 seeds, against [05 §2](05-test-and-benchmark-plan.md#2-scenario-suite).

| Organization | Scenario         | Accepted | Mean error p50 / p95 (m) | Max error p95 / worst (m) | Completion p50 (s) | Reversals/min, worst | Recovery, worst (s) | Collisions | Stuck |
| ------------ | ---------------- | -------: | -----------------------: | ------------------------: | -----------------: | -------------------: | ------------------: | ---------: | ----: |
| squad        | 1 straight       |    50/50 |              0.41 / 0.43 |               2.30 / 2.31 |                220 |                 0.28 |                   — |          0 |     0 |
| squad        | 2 pace 1.0, d 5  |    50/50 |              0.20 / 0.21 |               1.15 / 1.16 |                305 |                 0.20 |                   — |          0 |     0 |
| squad        | 2 pace 1.8, d 15 |    50/50 |              0.62 / 0.65 |               3.20 / 3.23 |                173 |                 0.35 |                   — |          0 |     0 |
| squad        | 3 straggler      |    50/50 |              0.42 / 0.44 |               5.93 / 6.03 |                224 |                 0.82 |                12.2 |          0 |     0 |
| squad        | 4 turn           |    50/50 |              0.42 / 0.43 |               2.30 / 2.31 |                244 |                 1.25 |                   — |          0 |     0 |
| squad        | 5 waypoints      |    50/50 |              0.42 / 0.42 |               2.30 / 2.31 |                505 |                 1.43 |                   — |          0 |     0 |
| element3     | 1 straight       |    50/50 |              0.41 / 0.43 |               1.78 / 2.18 |                220 |                 0.28 |                   — |          0 |     0 |
| element3     | 2 pace 1.0, d 5  |    50/50 |              0.20 / 0.21 |               0.89 / 1.09 |                305 |                 0.20 |                   — |          0 |     0 |
| element3     | 2 pace 1.8, d 15 |    50/50 |              0.61 / 0.66 |               2.44 / 3.05 |                173 |                 0.35 |                   — |          0 |     0 |
| element3     | 3 straggler      |    50/50 |              0.46 / 0.49 |               5.76 / 5.81 |                224 |                 0.82 |                12.3 |          0 |     0 |
| element3     | 4 turn           |    50/50 |              0.41 / 0.45 |               1.77 / 2.18 |                226 |                 1.35 |                   — |          0 |     0 |
| element3     | 5 waypoints      |    50/50 |              0.42 / 0.44 |               1.77 / 2.18 |                453 |                 1.47 |                   — |          0 |     0 |

**Notes on the sweep.**

- The worst error in scenario 3 is the held Marine himself, released 14 m behind. The others stay within 2.5 m.
- The squad's maximum error, 2.3 m (0.23d), occurs as forming hands over to moving.
- The automated scenario tests (`src/exercise/behavior-lab/behavior-lab.test.ts`) run seed 1, with the same thresholds:
  - scenarios 1–5 for the squad and the element, scenario 2 at four pace and spacing combinations;
  - the squad's team order through the turn;
  - tick-rate equality (10, 30, 60, 120 Hz);
  - snapshot/restore;
  - a clean end: nothing moves once the unit is in position.

### Performance after M2

`AMBUSH_BEHAVIOR_BENCH=1`, 30 Hz, squads after forming, now with drift and personal space:

| Soldiers | Unit movement tick p50 |    p95 | Kernel, individual orders p50 |
| -------: | ---------------------: | -----: | ----------------------------: |
|       13 |                  29 µs |  39 µs |                        2.7 µs |
|       39 |                  82 µs |  88 µs |                        6.7 µs |
|      104 |                 221 µs | 306 µs |                       17.7 µs |
|    1,001 |                 4.6 ms | 6.8 ms |                       0.33 ms |

**Why the 1,001-soldier figure is pessimistic.** Under Vitest, every call between modules goes through the test runner's import rewriting. The same 1,001-soldier workload measured **2.2 ms per tick** when Node loads the modules directly (`node --import tsx`), and the browser build bundles the modules the same way.

**What fixed the hot path.** A closure created in `desire` on every call cost 27% (the dev toolchain's name-keeping wrapper). Hoisting it took 1,001 soldiers from 6.4 to 2.2 ms per tick (direct Node).

**Substep rate re-checked:**

- 120 Hz stays within 4 cm of 960 Hz after 200 s, with personal space in play;
- 60 Hz is within 7 cm and 240 Hz within 2 cm;
- 120 Hz is kept.

### Limitations after M2

- Open ground only: no clearance field, obstacle detours or automatic file compression (M4).
- Facing always follows travel: no observation sectors.
- The pace law waits for a held Marine until he is 2 intervals behind (by design: scenario 3).
- Speed reversals in turns reach 1.25–1.47 per minute for the squad. These are the inner and outer Marines slowing and speeding up through the bends. The 1-per-minute threshold applies to straight-line movement only (scenario 1).
