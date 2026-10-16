# Constructive simulation

Ambush! as a general-purpose, real-time, interactive and deterministic
force-on-force constructive simulation. Any number of BLUEFOR and OPFOR squads
fight on the project's terrain. Each squad follows a plan of typed orders and
reacts to contact on its own. The workflow is Terrain → Scenario Setup → BLUEFOR
Planning → Combat → After-Action Review.

| Document                                                            | Contents                                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [01 Architecture assessment](01-architecture-assessment.md)         | What existed, the decisions, the modules, the risks                                                                       |
| [02 Orders and plans](02-orders-and-plans.md)                       | Order kinds, the lifecycle, the `orderSquad` command, completion rules, the battle builder                                |
| [03 Scenario Setup and Planning](03-scenario-setup-and-planning.md) | The workflow, the version 2 scenario and its migration, editing in 2D and 3D, checks                                      |
| [04 Combat](04-combat.md)                                           | The Combat stage: clock, live orders to either side, End Combat, the battle session, performance on real ground           |
| [05 After-Action Review](05-after-action-review.md)                 | The review replayed from tick 0 and verified, the playhead, timeline and inspection, the reference 3v3 battle, benchmarks |
| [Progress](progress.md)                                             | Milestones, what each delivered, how it was validated, its commit                                                         |
