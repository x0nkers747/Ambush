# Constructive simulation: progress

- Part of: [Constructive simulation](README.md)

| Milestone | Scope                                                                         | State | Commit                                         |
| --------- | ----------------------------------------------------------------------------- | ----- | ---------------------------------------------- |
| A         | Generalized forces, orders and plans, battle builder, architecture            | Done  | see git log: `feat(constructive): milestone A` |
| B         | Scenario Setup and BLUEFOR Planning UI, schema v2 and v1 migration, save/load | Next  | —                                              |
| C         | Interactive Combat stage: live orders, pause and speed, End Combat            | —     | —                                              |
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
