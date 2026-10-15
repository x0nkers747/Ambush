# Constructive simulation: progress

- Part of: [Constructive simulation](README.md)

| Milestone | Scope                                                                         | State | Commit  |
| --------- | ----------------------------------------------------------------------------- | ----- | ------- |
| A         | Generalized forces, orders and plans, battle builder, architecture            | Done  | e6957eb |
| B         | Scenario Setup and BLUEFOR Planning UI, schema v2 and v1 migration, save/load | Done  | acae397 |
| C         | Interactive Combat stage: live orders, pause and speed, End Combat            | Done  | 0d1c567 |
| D         | Full AAR: replay from tick 0, timeline, markers, inspection; benchmarks       | Done  | cdac6f5 |

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

## Milestone D: the After-Action Review, verification and benchmarks

Delivered ([05](05-after-action-review.md)):

- **The After-Action Review:**
  - The battle is replayed from tick 0 by re-simulation from its
    recording, and each second's state hash is checked against the
    recording's as the replay reaches it. The panel says it is verified, or
    from when it differs.
  - The replay runs in the background; whatever has been replayed can
    already be reviewed.
- **The playhead:**
  - play and pause at ¼× to 16×;
  - ±5 s, the start and the end, the previous or next marker;
  - a timeline to drag or click;
  - every marker, key moment, phase and event is a seek.
  - The squads' states come from a view battle brought to the playhead
    from the replay's keyframes; the soldiers in 2D and 3D come from the
    replay's motion.
- **The timeline's markers:** contact, casualties, squads combat
  ineffective or withdrawn, and the user's orders, coloured by side.
- **Inspection** of a squad at the playhead: its state, its orders with
  their statuses and reasons, and its phases with their reasons. Also the
  roster at the playhead, the event log up to it, the result, and Export
  recording.
- **The reference 3v3 battle,** made, fought and reviewed end to end
  through the page's own planner, combat and review
  (`reference.test.ts`).
- **Benchmarks at 2, 6 and 12 squads** on open and urban ground
  (`benchmark.test.ts`, opt-in), and in the browser on Quantico.
- **Performance on real ground:**
  - A clear-radius field for obstacle tests, and a nearest-in-area search
    bounded per grid cell with precomputed rings. Both change no answer.
  - The battle and the replay step for at most part of each frame, so the
    view keeps drawing smoothly, and the panel gives the speed achieved
    when it is less than the speed asked.
  - 12 squads on Quantico: about 20× in 2D and 10× in 3D, at 50–60 fps.

Validation:

- Unit tests:
  - `src/app/battle/review.test.ts`:
    - every second of a replay matches;
    - a tampered recording is noticed;
    - the replay progresses on a budget;
    - the playhead's state hash equals the recording's at any second,
      forward or back;
    - playback at speed stops at the end;
    - the squads' orders and phases at a moment are right;
    - the markers are right.
  - `src/app/battle/reference.test.ts`: the reference 3v3 (see 05 §4).
  - `src/sim/polygon-bands.test.ts`: the clear radius changes no answer of
    `pointProblem` or `isSegmentWalkable` on 20,000 points and segments.
  - `src/sim/behavior/nearest-in-area.test.ts`: still equal to the full
    search.
- The benchmarks: every replay verified. Casualty and burst counts are the
  same before and after the optimizations.
- The browser, on Quantico:
  - a 2v2 battle fought, ended and reviewed: 736 seconds replayed and
    verified, the result equal to the live battle's;
  - key moments, the next and previous markers, ±5 s, the timeline,
    playback, a squad's phases, and 3D at the playhead;
  - a 12-squad battle fought at 32× and reviewed: 402 seconds verified, and
    the timeline seeks.
- `npm run check` and `npm run build` pass.

### Not done

- **The legacy ambush exercise** was still reachable at the end of
  Milestone D. It has since been retired (see below).
- **The simulation ran on the page's thread.** It has since moved to a
  background worker (see below).

## After Milestone D

### The ambush exercise retired

The five-stage battle workflow replaces the ambush exercise.

- **Deleted:**
  - the exercise's page (`src/app/workspace.ts`) with its stage
    controllers: `scenario-stage.ts`, `exercise-stage.ts`, `roster.ts`,
    `carry-plans.ts`;
  - the AAR scoring (`src/exercise/scoring.ts`);
  - their tests, and the page's styles.
- **Old addresses:**
  - `#edit/<id>` now leads to Scenario Setup;
  - `#play/<id>` leads to BLUEFOR Planning;
  - `#demo` leads to terrain selection.
- **Old scenarios:** a battlefield's ambush scenario (version 1) is still
  read, and converted to a battle when first opened.
- **Simplified:** the workflow's gates are the pages' rules alone
  (`WorkflowRules`).
- **What remains, and why:** the exercise engine
  (`src/exercise/exercise.ts` and its scenario, ORP, kill-zone and combat
  v1 modules). The 2D map and the 3D view still draw the terrain through an
  exercise (`terrainOnlyExercise`), and the terrain preview builds one too.
  Removing it means giving both renderers another source for the terrain
  and their soldiers.

### The battle in a worker

Combat and the review's replay are simulated in a background worker
([04 §5](04-combat.md#5-the-battle-worker)).

- **How:**
  - The page reads a battle through a driver: here, or the worker's mirror.
  - The worker posts compact per-tick frames, the events, the hashes, the
    keyframes, the squads, and the commands it has applied.
- **Tested:**
  - a battle fought through the worker (host and driver wired through a
    cloning queue) equals the battle fought on the page: commands, ticks,
    per-second hashes, events, squads and every soldier's motion;
  - orders show queued until applied;
  - the review replays and verifies through it, and seeks with its
    keyframes.
- **In the browser, on Quantico with 12 squads:**
  - 60 fps in 2D and 3D at every speed (before: 27–58);
  - the battle runs at the one-core limit, about 10–13×;
  - a 405-second battle replayed and verified in the worker, with no
    mismatch.
