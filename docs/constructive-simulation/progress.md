# Constructive simulation: progress

- Part of: [Constructive simulation](README.md)

| Milestone | Scope                                                                         | State | Commit                                         |
| --------- | ----------------------------------------------------------------------------- | ----- | ---------------------------------------------- |
| A         | Generalized forces, orders and plans, battle builder, architecture            | Done  | e6957eb                                        |
| B         | Scenario Setup and BLUEFOR Planning UI, schema v2 and v1 migration, save/load | Done  | see git log: `feat(constructive): milestone B` |
| C         | Interactive Combat stage: live orders, pause and speed, End Combat            | Next  | —                                              |
| D         | Full AAR: replay from tick 0, timeline, markers, inspection; benchmarks       | —     | —                                              |

## Milestone A: generalized forces, orders and architecture

Delivered:

- [Architecture assessment](01-architecture-assessment.md).
- The force-on-force model generalized from two forces to any number of
  squads of either side:
  - side-based enemies, thresholds, area fire and suppression;
  - `termination: 'manual'` for battles.
- Orders and plans in the simulation state:
  - `FofOrder`, the order lifecycle and the `orderSquad` command
    (replace or append);
  - `orderChanged` events;
  - initial plans from the setup;
  - completion and failure rules ([02](02-orders-and-plans.md)).
- `#exercise/battle`: `createBattle` from a plain-data `BattleSpec`, with a
  command log, origins and replay.
- `src/exercise/forces`: the organizations a squad can be, force
  instantiation (`instantiateForce`), weapons, and the model's default
  configuration (`fof-v1.json`, moved from the lab). They are shared by
  battles and the labs, so the game does not import the labs (the isolation
  tests hold). The lab keeps its names as aliases and stays bit-identical.

Validation:

- Unit tests: `src/exercise/battle/orders.test.ts` covers setups, order
  shapes and command validation.
- Integration tests: `src/exercise/battle/battle.test.ts`, run on 3v3 battles,
  covers:
  - plans executing and completing;
  - three or more simultaneous engagements;
  - ineffective squads' plans failing;
  - replace, append and clear;
  - same-tick ordering;
  - rejections;
  - determinism by repetition, by replay from the log, and by snapshot and
    restore.
- `npm run check` (types, lint, the full test suite) and `npm run build` pass.
- The Force-on-Force Lab still runs and gives identical hashes.

## Milestone B: Scenario Setup, BLUEFOR Planning, save and load

Delivered ([03](03-scenario-setup-and-planning.md)):

- **The workflow, renamed:** Terrain, Scenario Setup, BLUEFOR Planning,
  Combat, After-Action Review.
  - The stage `opfor` is now `combat`.
  - The header takes each page's gates (`WorkflowRules`).
- **The scenario, version 2:** any number of squads per side, each with its
  organization, formation, start, facing and plan, plus the battle's seed.
  - It is parsed and checked (`parseBattleScenario`).
  - Version 1 (the ambush) is migrated: the ORP becomes BLUEFOR's squad, and
    the patrol becomes an OPFOR element with Move orders along its route.
  - Edits are validated, and `scenarioIssues` reports soldiers standing in
    obstacles and unreachable destinations.
  - `battleSpecOf` makes the battle the scenario describes.
- **The battle page** (`#setup/<id>`, `#plan/<id>`):
  - Squads are placed by side and organization.
  - Orders are entered rapidly: M, A or W, then one click per order.
  - Squads and waypoints are dragged, squads turned with a knob, and orders
    deleted with a right-click.
  - Plans are drawn with numbered, typed waypoints.
  - The side panel has the selected squad and its plan list (kinds,
    reordering, deletion), the roster by force, and the scenario's seed and
    problems.
  - Scenarios can be exported, imported, or started again.
- **2D and 3D parity:**
  - One map editor, through the map's surface in 3D.
  - In 3D, the soldiers stand as characters at the battle's start (the
    view's new `figures`).
- **Save and load:** the battle is saved in IndexedDB after every edit,
  beside the legacy version 1 scenario, which the ambush exercise (still at
  `#edit/<id>`) keeps using.
- **Terrain selection** opens battlefields in Scenario Setup. Its preview
  draws the battle's squads and plans, and its caption gives the forces.

Validation:

- Unit tests:
  - `src/exercise/battle/scenario.test.ts`: migration, parsing, squad and
    plan edits, checks, and the battle a scenario makes;
  - `src/app/battle/planner.test.ts`: the stages' rules, tools, drags and
    gates, and the views' soldiers and figures;
  - the stage-address tests and the workflow tests, with the new names.
- The browser, on a real battlefield (Quantico; Chrome, 2D and 3D):
  - the ambush scenario was migrated;
  - squads of both sides were placed and dragged;
  - OPFOR plans were made in Setup, and a BLUEFOR order was refused there;
  - BLUEFOR plans were made in Planning, and an OPFOR order was refused
    there;
  - order kinds were changed in the plan list;
  - in 3D, a squad was selected, given an order, had a waypoint dragged and
    was turned, with characters standing at the start;
  - Show OPFOR worked;
  - leaving for Terrain showed the battle in the preview;
  - the legacy ambush exercise opened with its own scenario.
- `npm run check` and `npm run build` pass.
