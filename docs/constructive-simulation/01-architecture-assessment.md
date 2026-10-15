# Constructive simulation 01: architecture assessment

- Status: accepted (2026-10-15)
- Part of: [Constructive simulation](README.md)

This assessment is of the repository as it is, before the change. It was made by
reading the code, not earlier descriptions.

## 1. What exists

| Capability                                                                                                                                                                                                                                                                       | Where                                                                                                                          | State                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Terrain: generation, OSM/DEM import, grading, roads, bridges, buildings, vegetation, water                                                                                                                                                                                       | `src/acquire`, `src/sim/terrain*`, `environment`, `bridges`, `road-network`, `water-grading`; 2D `src/view2d`, 3D `src/view3d` | Integrated in the game; general                                                                                                                        |
| Terrain queries: surface height, LOS (`los.ts` reference, `sight-tracer.ts` fast and exact), navigation (`navigation.ts`: nav areas, `planPath`, clearance)                                                                                                                      | `src/sim`                                                                                                                      | General                                                                                                                                                |
| Units: `OrgUnit` tree (echelon labels), `Soldier` (side, unit, position, posture, status)                                                                                                                                                                                        | `src/sim/state.ts`                                                                                                             | General: any number of organizations and soldiers; each root single-sided                                                                              |
| Organization templates (squad, fire team, element), instantiation with id prefixes                                                                                                                                                                                               | `src/exercise/organization.ts`, `organizations/*.json`                                                                         | General; the game instantiates one squad                                                                                                               |
| Individual orders (`setOrders`: waypoints, roads)                                                                                                                                                                                                                                | `src/sim/commands.ts`, `movement.ts`                                                                                           | Integrated; the game's only orders (one destination per Marine)                                                                                        |
| Unit orders: `orderUnit` / `moveInFormation` (formation movement, falling in, detours, obstacle clearance, crowd separation)                                                                                                                                                     | `src/sim/behavior` (ADR 0053)                                                                                                  | Built for the Behavior Lab and the Force-on-Force Lab; not used by the game                                                                            |
| Force-on-force model: per-force detection (TTPF, per-pair thresholds, confidence, levels), contact behaviour, actions on contact (attack with fire and movement, withdraw, continue), fire (aimed/area bursts, ammunition), suppression, effectiveness, withdrawal, adjudication | `src/sim/fof`                                                                                                                  | Built and validated for the lab; runs only when a world has a `fof` setup; **assumes exactly two forces** (setup validation, adjudicator, enemy lists) |
| Game combat model (combat v1): BLUEFOR engages, OPFOR reacts (prone or flee) or escapes; one global engagement with a 60 s limit; LOS at standing heights; no ammunition, detection or suppression                                                                               | `src/sim/combat.ts`, `combat-config.ts`                                                                                        | Integrated; **ambush-shaped**                                                                                                                          |
| Game exercise: one trainee squad, one OPFOR patrol, ORP, kill zone, START OPFOR, TRIGGER AMBUSH, phases, scoring                                                                                                                                                                 | `src/exercise/exercise.ts` and friends                                                                                         | Integrated; **ambush-shaped**                                                                                                                          |
| Determinism: seeded RNG in state, fixed tick, snapshot/restore, `hashSimState`                                                                                                                                                                                                   | `src/sim`                                                                                                                      | General                                                                                                                                                |
| Game recording: full state frames from 5 s before the trigger; motion log from tick 0; no command log; no replay verification                                                                                                                                                    | `src/exercise/replay.ts`, `motion-log.ts`                                                                                      | Ambush-shaped (anchored on the trigger)                                                                                                                |
| Lab session: run from the command log, keyframes, per-second hashes, replay & verify, scrubbing by re-simulation, worker with a page mirror                                                                                                                                      | `src/view3d/force-on-force/session*.ts`, `worker-session.ts`, `sim.worker.ts`                                                  | Built for the lab; general in design                                                                                                                   |
| Characters: Rocketbox models, clips, posing from the motion and combat logs, levels of detail                                                                                                                                                                                    | `src/view3d/characters`                                                                                                        | Integrated (game, labs)                                                                                                                                |
| Workflow: five stages (Terrain, Edit Scenario, BLUEFOR, OPFOR & Combat, AAR), sidebar, Previous/Next                                                                                                                                                                             | `src/app/workflow.ts`, `shell.ts`, `workspace.ts` (one 1,700-line closure)                                                     | Integrated; the stages' tools are ambush-specific                                                                                                      |
| Scenario file: `ambush.scenario` v1 — one ORP, one OPFOR force (`patrol-3`) with one route                                                                                                                                                                                       | `src/exercise/scenario-definition.ts`                                                                                          | Integrated; no migration code                                                                                                                          |
| 2D/3D parity: one controller and actions for both views (ADR 0039)                                                                                                                                                                                                               | `src/view2d/interaction.ts`, `actions.ts`, `workspace.ts` `connect3d`                                                          | Integrated; the actions are the exercise's                                                                                                             |
| Tests: Vitest in Node (no Playwright); browser checks by scripts through `ambush*` hooks                                                                                                                                                                                         | `vitest.config.ts`, `tools/`                                                                                                   | —                                                                                                                                                      |

## 2. Decisions

1. **One combat and behaviour model: the force-on-force model, generalized.** It is
   the developed one (detection, suppression, ammunition, actions on contact, fire and
   movement, withdrawal), measured and documented. It is generalized from two forces
   to any number of squads, each a force with a side. Combat v1 stays only for the
   legacy ambush exercise until that is retired. The new workflow does not use it.
2. **Squad = force.** Each squad (an organization instance, a root unit) is one
   force-on-force force with its own picture, contact behaviour and plan. Enemies are
   the soldiers of forces of the other side.
3. **Orders and plans in simulation state.** A typed, serializable order
   (`move`/`attack`/`withdraw`, destination, status, ticks, reasons, source) and a
   plan per squad live in `SimState.fof`. Orders enter through one command
   (`orderSquad`: replace or append) applied at a tick boundary, in submission order.
   The order says the intent; the force's phase is its behaviour. Both are recorded.
4. **Execution reuses the movement engine.** An active order becomes the force's unit
   movement order (`moveInFormation`). Contact behaviour interrupts it and resumes it,
   as the lab does. The order's kind selects the actions on contact:
   - `move` continues (halts to fight, resumes);
   - `attack` assaults the enemy;
   - `withdraw` breaks contact toward its destination.
5. **No automatic end in the general workflow.** The adjudicator is kept for the lab
   (`termination: 'experiment'`). The game runs with `'manual'`: the player ends
   Combat.
6. **Record commands, replay by re-simulation.** The authoritative record is the
   initial scenario, seed, simulation versions and the command stream, with keyframes
   and state hashes. The lab's session is generalized and reused for the game: run,
   scrub, replay and verify. The game's frame recorder and trigger anchoring are retired
   from the new workflow.
7. **Renderers read a narrow battle interface.** The 2D map and the 3D view draw a
   battle from what they need (world, state, motion and combat logs, render time,
   weapons, squads, plans, selection) rather than from the ambush `Exercise`. Selection
   and commands go through one shared controller for both views.
8. **Scenario v2.** It holds lists of squads per side (template, name, position,
   facing, formation; OPFOR's initial plan). v1 files migrate: the ORP becomes the
   BLUEFOR squad's position; the patrol becomes an OPFOR element with Move orders along
   its route.

## 3. Modules

| Keep                                   | Generalize                                               | Retire from the workflow                                                       | New                                                                                  |
| -------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Terrain, navigation, LOS, sight tracer | `src/sim/fof` (N forces, plans, manual termination)      | Combat v1 (kept for the legacy exercise and its tests until removed)           | Orders and plans (`src/sim/fof/orders.ts`, `plans.ts`)                               |
| Movement engine (`src/sim/behavior`)   | Lab session into a general battle session                | Ambush exercise: ORP, kill zone, START OPFOR, TRIGGER, scoring, frame recorder | Battle model (`src/exercise/battle`): scenario v2 → simulation, squads, plan editing |
| Characters, motion log                 | Renderers' input (from `Exercise` to a battle interface) | The trigger-anchored AAR                                                       | Workflow stages Scenario Setup / Combat                                              |
| Organization templates                 | Workflow (five stages, new names and tools)              |                                                                                | Roster by force, order tools, plan overlays                                          |

## 4. Risks

- **Determinism.**
  - Orders applied at tick boundaries in command order.
  - Random draws only in the simulation.
  - Plans in state, so hashed and snapshotted.
  - The recorded command stream must be complete: setup orders included, UI timing
    excluded.
  - Cross-engine identity is not established (04 §4 of the lab); replay is exact within
    one engine build.
- **Migration.**
  - v1 scenarios migrate; deployment plans (per-Marine destinations) have no equivalent
    and are not carried.
  - The legacy exercise's tests stay meaningful only while it exists.
- **Performance.** Game terrains are larger (up to 5 km) and have features, so sight
  lines walk more. The lab's per-pair caches are n²: fine for squads (dozens to a few
  hundred soldiers), measured at 988.
- **Scope.**
  - `workspace.ts` holds stages 2–5 in one closure.
  - The renderers' ambush overlays (kill zone, per-Marine destinations, engagement
    wedges) are replaced, not ported.
- **Roads.** Formation moves do not follow roads (individual orders could). OPFOR
  routes from v1 lose road following.

## 5. Boundaries

- **`src/sim/fof`:** forces, perception, behaviour, fire, orders and plans, and the
  `orderSquad` command (in `src/sim/commands.ts`).
- **`src/exercise/battle`:** scenario v2 (types, validation, migration from v1), the
  scenario to simulation `Scenario`, the squads' setup, and plan editing (pure
  functions).
- **`src/view3d/force-on-force` session** (moved where both the game and the lab use
  it): the run, recording, keyframes, hashes, the worker.
- **`src/app`:** stages, roster, order tools, Combat controls, AAR timeline. 2D and 3D
  share the controller.
