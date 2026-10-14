# Behavior Lab 06: implementation roadmap

- Status: proposal (nothing starts without approval)
- Date: 2026-10-14
- Part of: [Behavior Lab research](README.md)

**How milestones are scoped.** Each milestone ends with something that can be tested on its own, a green `npm run check`, a commit, and, from M3, a lab scenario to look at.

**Complexity:**

- S is up to about 2 days of focused work;
- M is about 3–5 days;
- L is more than a week.

## Overview

| #                             | Milestone                                                               | Complexity | Depends on | Scenarios ([05 §2](05-test-and-benchmark-plan.md#2-scenario-suite)) |
| ----------------------------- | ----------------------------------------------------------------------- | ---------- | ---------- | ------------------------------------------------------------------- |
| M1                            | Kernel foundations: unit task, route, anchor, agents in the open        | M          | Approval   | 1 (headless)                                                        |
| M2                            | Formation templates and the movement laws                               | M          | M1         | 1, 2, 4, 5 (headless)                                               |
| M3                            | Behavior Lab page, first version                                        | M          | M2         | 1–5 visible; 3 with disturbances                                    |
| **First experiment complete** | Squad and 3-Marine element move believably, deterministically, measured |            | M1–M3      | Acceptance 05 §6                                                    |
| M4                            | Obstacles and narrow ground                                             | L          | M3         | 6, 7, 10                                                            |
| M5                            | Real terrain: bridges, slopes, battlefields                             | M          | M4         | 8, 9                                                                |
| M6                            | Platoons and scale                                                      | M          | M4         | 11, 12; benchmarks to 1,000                                         |
| M7                            | Game integration (separate approval)                                    | M          | M5, M6     | Exercise replay tests                                               |
| Later                         | HALT, PATROL, FOLLOW, REGROUP; frame stack; child tasks                 | —          | M7         | New scenarios                                                       |

## M1: kernel foundations

**Builds.**

- `src/sim/behavior/`:
  - `BehaviorState` and `UnitTask` / `AgentState` types;
  - the `orderUnit` command (validation, rejection reasons, `unitOrdered` event);
  - membership release rules;
  - `GroupRoute` (`planPath`, corner rounding without the clearance check, 1 m arc-length table);
  - the anchor with the pace law;
  - agents seeking their slot targets with acceleration and turn-rate limits, with no avoidance;
  - the 120 Hz substep loop;
  - `noise.ts`;
  - `diagnostics.slotTargets` and `formationError`.
- The `FormationSpec` is built by hand in tests (no templates yet).
- `stepState` calls `updateBehavior` before `moveSoldiers`; `moveSoldiers` skips agents.

**Validation.**

- Unit tests for the route, the pace law and the noise.
- Scenario 1 headless with a hand-made squad wedge.
- Determinism tests:
  - repeatability;
  - rates 10/30/60/120 bit-identical;
  - snapshot/restore mid-task;
  - existing pinned hashes unchanged;
  - `clonePlainData` and `canonicalEncode` accept every state.

**Risks.**

- Choosing where `behavior` sits in `SimState`, with hashes changing only when it is used. Mitigation: follow the `engagement` precedent.
- Substep cost. Mitigation: a benchmark in the same milestone.

## M2: formation templates and movement laws

**Builds.**

- `src/exercise/formations/`: JSON templates with doctrine references:
  - USMC fire team wedge, column, file;
  - squad column, wedge, line, file;
  - the Army fire team wedge;
  - a 3-soldier team wedge and file.
- `build-spec.ts`: roles to soldiers, intervals, mirroring, nesting.
- Organisation templates for a 3-Marine element (data).
- Agent laws: along-track speed band, look-ahead, latching, `settling` with final facing, completion and outcomes, stuck detection (without searches).
- Formation-type selection by command only (no automatic modes yet).
- Consecutive waypoints by queued orders in scenario scripts.

**Validation.**

- Scenarios 1, 2, 4 and 5 headless pass at seed 1, for the squad and the 3-Marine element.
- Metrics module (`metrics.ts`): error, oscillation, lateral slip, completion and collisions (soldier–soldier only).
- 50-seed sweep script.

**Risks.**

- Sharp corners without clearance-aware rounding (M4) may bunch the formation in scenario 4. On open ground rounding is always allowed, so scenario 4 is unaffected.
- Tuning: the first parameter calibration happens here. Parameters are recorded in a versioned, fingerprinted config (`behavior-v1.json`, like `combat-v1.json`).

## M3: the Behavior Lab page, first version

**Builds.**

- `#behavior-lab` route through a hash-guarded dynamic import, with an isolation test.
- The narrowed 3D view source type (07, Q6).
- `LabRun`: simulation, runner, command list, motion log, keyframes.
- Lab layout:
  - controls (scenario, seed, rate, play/pause/reset, speed, step, destination click, formation, spacing, pace);
  - hierarchy tree and inspector;
  - the first overlays: slots, actual vs desired, route and anchor, velocity and heading, behaviour badges, trails;
  - metrics bar and graphs (error, lag, speeds);
  - record, save and load, re-simulated replay with hash checks;
  - disturbances (hold, release, incapacitate).
- 3D characters through the real layer; 2D view with the same overlays.

**Validation.**

- Scenarios 1–5 in the browser, with Playwright checks: overlays match diagnostics, replay hashes match, characters posed.
- The reviewer's believability check (05 §6, item 4).
- **Milestone acceptance: 05 §6 in full.**

**Risks.**

- The 3D view's dependency on `Exercise`. Mitigation: the type narrowing is small and checked by `tsc -b`.
- The lab's UI size. Mitigation: plain DOM panels like the app's, with no framework.

## M4: obstacles and narrow ground

**Builds.**

- Clearance field (`clearance.ts`, measured on 5 km fixtures).
- Lateral clamping and corridor diagnostics.
- Corner rounding checked against clearance.
- Automatic modes (open, compressed, file) with hysteresis and blended transitions.
- Bounded local A\* (shared heap and tie rule with `planPath`).
- Detours.
- Obstacle contact (slide along walls).
- Stuck detection with retry.
- Avoidance: spatial hash, separation in teams, time-to-collision between elements, priority yielding.
- Lab obstacle tools (box, wall, water) feeding the terrain's environment features.
- Overlays: corridor, detours and avoidance (trace).

**Validation.**

- Scenarios 6, 7 and 10.
- Collision metrics including buildings and water.
- Benchmark for the clearance field.

**Risks.**

- Clearance build time and memory on 5 km maps. Fallback: lazily built tiles.
- Avoidance oscillation in passages. Mitigation: priority yielding, and the time-to-collision horizon tuned in the lab.

## M5: real terrain

**Builds.**

- Lab terrain sources: a stored battlefield through the app source, `lab-data/` in dev, `DEMO_SCENARIO`.
- Bridge decks in routes and z.
- `followRoads` for unit orders.
- Optional slope speed factor (07, Q7), if approved.
- Road-aware template choice: the lead team on the road edges, trailing teams either side (02 §6.3), offered as a template variant.

**Validation.** Scenarios 8 and 9 on synthetic and real terrain (the Quantico fixture), and seed sweeps.

**Risks.** Battlefield loading time in the lab (Amsterdam takes about 53 s). Mitigation: use smaller excerpts for routine work.

## M6: platoons and scale

**Builds.**

- Marine platoon organisation template (commander, sergeant, radio operator, corpsman, three squads).
- Platoon templates: column, wedge, line.
- Platoon-scale tolerances.
- Inter-element cohesion metrics.
- Leader-contact metric (line of sight).
- Benchmarks at 3, 13, 40, 100, 500 and 1,000 soldiers, including mass orders spread across ticks.

**Validation.** Scenarios 11 and 12, and benchmark acceptance (05 §4).

**Risks.**

- Route planning bursts when many units are ordered at once. Mitigation: spread planning across ticks within the order's first second (still deterministic), and HPA\* only if measured necessary.

## M7: game integration (requires its own approval)

**Candidate uses.**

- OPFOR `patrol-3` moves as a fire-team task, instead of copied waypoints (01 §3).
- BLUEFOR squad moves to the ORP or to positions as unit orders.
- Exercise replay and character replay tests extended to unit tasks.

**Also required.**

- ADR updates: 0008, 0022, 0026, and a new ADR for the engine.
- No change to combat rules.

## Later

Each follows the composition in [03 §11](03-architecture-proposal.md#11-extensibility-future-orders):

- HALT (cigar perimeter);
- PATROL (first in-house ticked behaviour tree over task states);
- FOLLOW;
- REGROUP and rally points;
- the frame stack for interruption;
- child tasks (team splits, bounding).

HTN only for contingent tactics, and only after these.

## Dependencies and sequencing notes

- M1–M3 change **no existing behaviour**. Every existing test and pinned hash must stay green throughout.
- Each milestone adds its own ADR or amends one:
  - M1: "Unit tasks and formation movement in the simulation kernel";
  - M3: "The Behavior Lab".
- The organisation and formation data (M2, M6) can proceed in parallel with kernel work once M1's `FormationSpec` type is fixed.
