# Behavior Lab 05: test and benchmark plan

- Status: plan
- Date: 2026-10-14
- Part of: [Behavior Lab research](README.md)

**How to read the thresholds.** Every acceptance threshold below is labelled:

- **[D]** derived from doctrine;
- **[R]** from research (walking studies, published systems);
- **[E]** an **experimental assumption to be calibrated** in the lab.

Most are [E]. Doctrine gives principles, not tolerances (02 §6).

## 1. Test layers

| Layer                                                  | Runs                                                               | What it proves                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit tests (`src/sim/behavior/*.test.ts`)              | `npm test`                                                         | Route arc length, corner rounding, clearance field, bounded search, slot geometry, assignment, the anchor's pace law, the agent's speed law, latching, noise |
| Scenario tests (`src/exercise/behavior-lab/*.test.ts`) | `npm test` (fast subset under 10 s in total)                       | Each scenario meets its acceptance metrics at seed 1, rate 30                                                                                                |
| Determinism tests                                      | `npm test`                                                         | Repeatability, tick-rate equality, snapshot/restore, replay fidelity, no change to existing hashes                                                           |
| Seed sweeps                                            | `npm run lab -- --seeds 1..50` (opt-in)                            | Metrics hold across seeds (distribution, worst case)                                                                                                         |
| Benchmarks                                             | `AMBUSH_BEHAVIOR_BENCH=1 npm test` (opt-in, `describe.skipIf`)     | Cost per tick by soldier count; route and clearance costs                                                                                                    |
| Browser checks                                         | Playwright against the dev server (outside the repository, as now) | Lab renders; overlays agree with state; characters animate; replay exact in the browser                                                                      |

## 2. Scenario suite

**Notation.** `d` is the formation interval (default 10 m). "Squad" is the 13-Marine USMC squad. Every scenario runs on flat synthetic terrain unless stated otherwise.

| #   | Scenario                     | Setup                                                         | Pass criteria (first milestone thresholds)                                                                                                                                           |
| --- | ---------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Straight line                | Squad wedge, 300 m north, pace 1.4 m/s                        | After forming:<br>• mean slot error ≤ 0.15 d [E]<br>• max ≤ 0.4 d [E]<br>• completion ≤ (300 / 1.4) · 1.15 + 20 s [E]<br>• no collisions<br>• speed reversals ≤ 1/min per Marine [E] |
| 2   | Speeds                       | As 1 at pace 1.0, 1.4, 1.8 m/s and d = 5, 10, 15 m            | As 1 at each; max member speed ≤ 1.3 × pace [E]                                                                                                                                      |
| 3   | Straggler recovery           | As 1; M07 held 10 s at t = 30 s                               | Re-enters the drifting band ≤ 40 s after release [E]; squad never stops completely unless lag > 2 d; nobody else leaves the drifting band                                            |
| 4   | 90° turn                     | 150 m north then 150 m east (one order, route with a corner)  | During the turn:<br>• max slot error ≤ 0.5 d [E]<br>• lateral (sideways) speed ≤ 0.4 m/s per Marine [E]<br>• no Marine faster than 1.3 × pace<br>• order of teams preserved          |
| 5   | Consecutive waypoints        | Four legs (N, E, S, E) queued                                 | Each leg completes; no stop longer than 2 s between legs [E]; totals as 1                                                                                                            |
| 6   | Single obstacle              | 20 × 20 m building centred on the route                       | Nobody enters it; formation splits round it on the clearance clamp and re-forms within 50 m beyond it [E]; no stuck members                                                          |
| 7   | Narrow passage               | 4 m gap in a 200 m wall                                       | `file` mode enters before the gap and leaves after; no collisions; nobody stuck; completion within 1.5 × the open-ground time [E]                                                    |
| 8   | Bridge                       | Real or synthetic river with one bridge                       | File on the deck; z follows the deck; nobody in the water                                                                                                                            |
| 9   | Uneven terrain               | Ridge synthetic terrain; then a real battlefield excerpt      | Metrics as 1, with thresholds relaxed 1.5× [E]; z on the surface everywhere                                                                                                          |
| 10  | Compression and re-formation | Corridor narrowing from 60 m to 8 m and widening again        | Mode follows clearance with hysteresis (≤ 2 changes per narrowing) [E]; re-formed (mean error ≤ 0.15 d) within 60 m of widening                                                      |
| 11  | Squad of teams               | Squad column, then wedge: three fire teams as nested elements | Team cohesion (each team's spread ≤ 1.5 d) at ≥ 95 % of ticks [E]                                                                                                                    |
| 12  | Platoon                      | Marine platoon (3 squads + HQ), column, 600 m with one turn   | Inter-squad gap within template ± 50 % [E]; elements never more than 300 m apart [D: FM 3-21.8 3-81]                                                                                 |
| —   | 3-Marine element             | Every applicable scenario above with a 3-soldier team         | As above                                                                                                                                                                             |
| —   | Completion                   | All scenarios                                                 | Task ends with `arrived`; no member moves faster than 0.05 m/s after its latch until the next order (no endless corrections)                                                         |

Scenarios 1, 4, 5 and 6 also run through the lab's seeded urban district (`terrain: 'urban'`): see [implementation notes](implementation.md#after-review-the-urban-district-and-obstacles) for what is measured there and the tests (`urban.test.ts`).

**Priorities.**

- **The first implementation must pass 1–5** for the squad and the 3-Marine element.
- 6–12 are built as the corresponding features land ([06](06-implementation-roadmap.md)).

## 3. Metrics

All metrics are computed by pure functions over `SimState` sequences (the `LabRun` records the per-tick state, or accumulates as it steps). They are shown live in the lab and written by headless runs.

| Metric                           | Definition                                                                                                                                               | Visualisation                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Formation error (mean, max, p95) | Distance from each active member to his slot target, per tick; also split into along- and across-track                                                   | Timeline graph; per-soldier bars; halo |
| Formation error, steady          | As above, excluding forming and settling phases and the 10 s after each disturbance                                                                      | Summary table                          |
| Cohesion                         | Per element: RMS distance of members from the element's slot-weighted centroid ÷ the template's RMS                                                      | Graph; hull overlay                    |
| Time out of band                 | Share of member-ticks beyond 0.5 d from slot                                                                                                             | Summary; colour bands                  |
| Distance travelled per soldier   | Integral of speed; vs the route length + his lateral offset changes                                                                                      | Table; ratio > 1.15 flagged [E]        |
| Oscillation                      | Speed reversals (sign changes of acceleration beyond ±0.2 m/s² that persist ≥ 0.5 s) per minute; heading reversals ≥ 20° within 2 s                      | Count; trail overlay                   |
| Lateral slip                     | Component of velocity perpendicular to facing (what animation shows as strafing)                                                                         | Graph; max per scenario                |
| Recovery time                    | After a disturbance: time until the member is back in the drifting band and stays ≥ 5 s                                                                  | Event marker on the timeline           |
| Completion time                  | From order to `unitTaskEnded`; vs ideal (route length ÷ pace)                                                                                            | Summary                                |
| Collisions                       | Pairs closer than 0.6 m (body contact) [R: two shoulder radii ≈ 0.25 m each plus margin]; and any soldier inside a building or water cell                | Count; red flash at the location       |
| Navigation failures              | Orders rejected (`noRoute`), detours that fail, members flagged stuck                                                                                    | Count; list                            |
| Stuck agents                     | < 0.5 m progress toward target in 10 s while unlatched                                                                                                   | Count; marker                          |
| Leader contact                   | Share of ticks each member has line of sight to his team leader and each team leader to the squad leader (`lineOfSight`) [D: the doctrinal control rule] | Percentage; broken lines overlay       |
| CPU per tick                     | `updateBehavior` time per tick (lab only; measured outside the simulation; not in state)                                                                 | Graph; p50/p95                         |
| Determinism                      | Hash per tick; equality across repeats, rates, restore points                                                                                            | Pass/fail per run                      |

## 4. Benchmarks

**Where they run.** Headless Node, opt-in: an organisation of N soldiers in squads, ordered across open terrain and across the Quantico fixture town.

|     N | Composition         | Measured                                                                                       |
| ----: | ------------------- | ---------------------------------------------------------------------------------------------- |
|     3 | 1 team              | µs/tick p50/p95; order cost (route plan)                                                       |
|    13 | 1 squad             | as above                                                                                       |
|    40 | 1 platoon (approx.) | as above                                                                                       |
|   100 | 2 platoons +        | as above                                                                                       |
|   500 | 12 platoons         | as above + staggered decision cost                                                             |
| 1,000 | 24 platoons         | as above + total route planning time when all are ordered in one tick and when spread over 1 s |

**Additionally measured:**

- clearance field build time and memory on the 5 km fixtures;
- bounded local search cost (p95);
- recording size per minute for a squad and for 1,000 soldiers.

**Acceptance (first milestone) [E]:**

- `updateBehavior` p95 ≤ 0.2 ms/tick for 13, and ≤ 5 ms/tick for 1,000 (open terrain, at 30 Hz).
- A squad order on a 5 km battlefield takes no more than `planPath`'s own cost + 20 ms.
- The clearance field builds in ≤ 300 ms, using ≤ 16 MB for 5 km.

**Browser.**

- The lab shows sim CPU per tick and fps.
- Rendering is not a behaviour metric (it is governed by ADR 0052's figures); the benchmark only confirms that the simulation's cost does not depend on rendering (the same numbers with the view hidden).

## 5. Determinism and replay tests

| Test                         | Method                                                                                                                | Pass                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Repeatability                | Run each scenario twice, same seed and rate                                                                           | `hashSimState` equal at every tick                                                                                |
| Seed sensitivity             | Two seeds                                                                                                             | Hashes differ (noise is seeded); metrics within tolerance                                                         |
| Tick-rate equality           | Rates 10, 20, 30, 60, 120                                                                                             | Soldier positions **bit-identical** at common times (substeps dividing 120, 03 §10)                               |
| Other rates                  | Rate 50 vs 60                                                                                                         | Positions within 0.05 m at common times [E]                                                                       |
| Frame-rate independence      | Drive the runner with irregular real frame times (6–37 ms, as the character replay test does) and time scales 0.25–16 | Same hash per tick as a fixed-step run                                                                            |
| Snapshot/restore             | Snapshot mid-task (forming, moving, during a detour, settling), restore into a fresh simulation, continue             | Same hashes as the uninterrupted run                                                                              |
| No regression                | Existing determinism tests                                                                                            | Pinned hashes unchanged (behaviour state absent)                                                                  |
| Trace is inert               | Run with and without the lab trace                                                                                    | Same hashes                                                                                                       |
| Exercise replay              | Run a squad order inside an `Exercise` through to an AAR recording; seek frames in random order                       | Replay frames equal the live states; character poses equal at tolerance 0 (extending `characters/replay.test.ts`) |
| Lab replay                   | Save a run, reload, re-simulate                                                                                       | Stored per-second hashes match                                                                                    |
| Serialization                | `canonicalEncode` and `clonePlainData` over every behaviour state shape                                               | No rejection; clone equal                                                                                         |
| Cross-engine (informational) | Same run in Node and Chrome (Playwright), compare hashes                                                              | Reported, not required (ADR 0005)                                                                                 |

## 6. Acceptance for the first milestone

The first milestone (06, M1–M3) is accepted when all of the following hold:

1. Scenarios 1–5 pass for the 13-Marine squad and the 3-Marine element, at seed 1 and across a 50-seed sweep (p95 of each metric within its threshold).
2. Every determinism test in §5 passes.
3. The benchmark acceptance figures in §4 are met.
4. A reviewer watching scenarios 1–5 in the lab, in 3D, judges the movement believable. This is the one subjective check; it is recorded with screenshots through the Feedback button.
