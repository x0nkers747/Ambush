# Constructive simulation: progress

- Part of: [Constructive simulation](README.md)

| Milestone | Scope                                                                         | State | Commit                                         |
| --------- | ----------------------------------------------------------------------------- | ----- | ---------------------------------------------- |
| A         | Generalized forces, orders and plans, battle builder, architecture            | Done  | e6957eb                                        |
| B         | Scenario Setup and BLUEFOR Planning UI, schema v2 and v1 migration, save/load | Done  | acae397                                        |
| C         | Interactive Combat stage: live orders, pause and speed, End Combat            | Done  | see git log: `feat(constructive): milestone C` |
| D         | Full AAR: replay from tick 0, timeline, markers, inspection; benchmarks       | Next  | —                                              |

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

### After Milestone B

- `fbafab8`, `a60e842`: a soldier whose start would be in water or a
  building stands on the nearest clear ground. The rest of the squad stays in
  formation, and the squad where it was put. This holds when a squad is
  placed, dragged, turned or reorganized.

## Milestone C: the Combat stage

Delivered ([04](04-combat.md)):

- **The Combat stage:**
  - The battle the plans make, started paused.
  - Play, pause, and speeds from ½× to 32×.
  - Live orders to the squads of either side: Move, Attack and Withdraw,
    replacing or appending (with Shift for one click), or Hold.
  - Orders given while paused are queued and apply in turn.
  - Clicking an enemy squad with an order tool targets it.
  - End Combat, after asking; the battle never ends by itself.
- **Shown in 2D and 3D through one editor:**
  - soldiers interpolated between ticks, and casualties;
  - squad symbols with their strength and state;
  - active, pending and queued orders;
  - bursts of fire;
  - in 3D, the soldiers as characters posed from the battle.
- **The side panel:**
  - the selected squad's state, orders and order history;
  - the roster by force with each squad's state;
  - the event log in words.
- **The After-Action Review's summary:** casualties, ineffective squads and
  orders by side. The replay is Milestone D.
- **The battle session:** commands with origins, keyframes every 5 s, a
  state hash every second, motion and events recorded. A recording replays
  the battle exactly.
- **Movement on real ground, 20 times faster**, with exactly the same
  results: banded tests for large polygons, and a shorter nearest-in-area
  search. On Quantico, 0.5 ms per tick for 52 soldiers (from 10); 32× keeps
  up.

Validation:

- Unit tests:
  - `src/app/battle/combat.test.ts`: the clock; orders to either side,
    replace and append, while paused, hold, refused destinations; ending;
    the session's recording replayed to the same hashes;
  - `src/sim/polygon-bands.test.ts`: banded and whole-scan answers equal on
    10,000+ points and 3,000 segments;
  - `src/sim/behavior/nearest-in-area.test.ts`: equal to the full search
    on 3,000 points.
- The full suite, including the Behavior and Force-on-Force Labs' scenario
  expectations, passes unchanged.
- The browser, on Quantico with 2 BLUEFOR and 2 OPFOR squads (Chrome, 2D and
  3D):
  - plans made, then fought;
  - play at 8× and 32×;
  - an OPFOR squad ordered onto a BLUEFOR squad by clicking it;
  - orders queued while paused, then applied (replace then append);
  - contact at 8:10, with an assault on both sides and casualties logged;
  - an OPFOR squad selected in 3D and given a Withdraw, which superseded its
    attack;
  - 60 fps in 3D during the battle;
  - End Combat and the summary;
  - the header blocked going back into the ended battle.
- `npm run check` and `npm run build` pass.
