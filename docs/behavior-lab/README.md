# Ambush! Behavior Lab: research and architecture

This initiative moves Ambush! from controlling individual soldiers to giving orders to organisations (fire team, squad, platoon) that the simulation carries out autonomously.

Its first behaviour is **MOVE_IN_FORMATION**: noncombat movement in formation to a single waypoint.

These documents are the research and the proposal (approved at `2da3386`).

**Status:** milestones M1–M3 are implemented ([ADR 0053](../adr/0053-unit-tasks-and-formation-movement.md), [ADR 0054](../adr/0054-behavior-lab.md); [implementation notes](implementation.md): departures, parameters, measurements, validation).

**Open the lab:** run `npm run dev` and go to **http://localhost:5173/#behavior-lab** (or `#behavior-lab` on the published site). Pick a scenario or _Free_, then _Set destination_ and click the ground.

| Document                                                    | Contents                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [01 Existing architecture](01-existing-architecture.md)     | What Ambush! has today (kernel, organisation, movement, navigation, replay, rendering, tests) and where a behaviour engine plugs in                |
| [02 Research survey](02-research-survey.md)                 | HTN, behaviour trees, military simulations, formation control, steering, group navigation, libraries, doctrine, with sources                       |
| [03 Architecture proposal](03-architecture-proposal.md)     | The recommended design: unit tasks in the kernel, a shared route with an anchor, route-relative slots, steering Marines, and the determinism rules |
| [04 Behavior Lab design](04-behavior-lab-design.md)         | The permanent experimental harness: page, controls, overlays, record and replay                                                                    |
| [05 Test and benchmark plan](05-test-and-benchmark-plan.md) | Scenarios 1–12, metrics, acceptance thresholds, determinism tests, benchmarks                                                                      |
| [06 Implementation roadmap](06-implementation-roadmap.md)   | Milestones M1–M7, each independently testable                                                                                                      |
| [07 Open questions](07-open-questions.md)                   | Decisions needed, each with a recommendation                                                                                                       |

## The recommendation in brief

**Where it lives.** A small unit-task engine inside the simulation kernel (`src/sim/behavior/`). Each ordered unit gets one task, a three-phase state machine. Subordinate echelons are nested frames of the formation, not separate controllers.

**How the group moves.** The task plans one route with the existing A\*, rounds its corners and measures it by arc length. A virtual anchor advances along it at a pace that waits for the slowest member.

**Where each Marine goes.** Slots are defined _along the route_: so many metres behind the anchor and so many to the side. They narrow to the corridor's clearance, so wedges become files at gaps and on bridges.

**How each Marine moves.** Each Marine steers to his slot a moment ahead. His speed rises or falls with how far behind or ahead he is, within a band, and his acceleration and turning are limited. He keeps clear of teammates and of other teams, and searches a short way round when his direct way is blocked.

**Determinism.** All state is plain data in `SimState`. Motion uses fixed 120 Hz substeps, and per-member variation comes from seeded hashes, not per-tick random draws. Replay is exact.

**What is not used.** No behaviour-tree or HTN library. No per-Marine pathfinding. No leader-relative frames. Each is reconsidered at a stated trigger.
