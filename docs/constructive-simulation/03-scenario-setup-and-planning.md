# Constructive simulation 03: Scenario Setup and BLUEFOR Planning

- Status: implemented (Milestone B, 2026-10-15)
- Part of: [Constructive simulation](README.md)
- Code: `src/exercise/battle/scenario.ts` (the scenario: schema, migration,
  edits, checks); `src/app/battle` (planner, map editor, page, preview
  overlay); `src/app/main.ts`, `stages.ts`, `workflow.ts`

## 1. The workflow

| Stage                  | Address        | What happens                                                                            |
| ---------------------- | -------------- | --------------------------------------------------------------------------------------- |
| 1. Terrain             | `#select/<id>` | Choose or generate a battlefield. The preview draws its battle's squads and plans.      |
| 2. Scenario Setup      | `#setup/<id>`  | Place both sides' squads, and give OPFOR its plans.                                     |
| 3. BLUEFOR Planning    | `#plan/<id>`   | Give BLUEFOR's squads their plans. OPFOR is shown read-only, or hidden with Show OPFOR. |
| 4. Combat              | —              | Milestone C. The stage opens once the plans are valid, and says what comes next.        |
| 5. After-Action Review | —              | Milestone D.                                                                            |

The header's stages are renamed: Setup, BLUEFOR, Combat and AAR. Their
gates come from the page (`WorkflowRules`):

- Setup → Planning needs at least one squad per side, every squad standing
  clear, and every OPFOR order reachable.
- Planning → Combat also needs every BLUEFOR order reachable.
- Earlier stages are always open.

**The legacy ambush exercise** keeps its own page at `#edit/<id>` and
`#play/<id>`, with its own version 1 scenario. It is reached from Battlefield
Information on the battle page, and through `#demo`. It is retired once
Combat replaces it (decision 6 of [01](01-architecture-assessment.md)).

## 2. The scenario (schema version 2)

```ts
{
  schema: 'ambush.scenario', schemaVersion: 2,
  id: '<battlefield>/battle', battlefieldId, name, terrainModel?, seed,
  squads: [{ id: 'B1', name, side, organization, formation?,
             position: { east, north }, facingDeg,
             plan: [{ kind: 'move' | 'attack' | 'withdraw', destination: { east, north } }] }]
}
```

- **Ids.** A squad's id is the first free `B<n>` or `O<n>`. Its soldiers are
  `<id>-01` and so on, in the battle the scenario makes (`battleSpecOf` →
  `createBattle`).
- **Names.** BLUEFOR squads are "1st Squad", "2nd Fire team" and so on; OPFOR
  squads are "Enemy squad 1" and so on. Both can be renamed.
- **Organizations.** A squad is a USMC squad (13), a fire team (4) or a
  three-man element (3). Its formation is any of the organization's
  templates.
- **Saving.** The scenario is saved in the browser's IndexedDB store, with
  the battlefield, after every edit.
- **Export and Import.** Export writes the scenario as a JSON file. Import
  reads a file of either version, asks before replacing the current
  scenario, and adopts the file for this battlefield.
- **New scenario** (in Setup) starts again with no squads, after asking.

### Migration from version 1

A battlefield whose only scenario is the ambush (version 1) has it converted
when the battle page first opens it (`migrateAmbushScenario`), and a notice
says so:

- The ORP becomes BLUEFOR's "1st Squad", a squad standing at the ORP and
  facing the patrol's start. It has no plan.
- The OPFOR patrol becomes "Enemy patrol", a three-man element where its
  route starts, facing along the route. Every later point of the route
  becomes a Move order.

The version 1 document is left as it was, so the legacy exercise still reads
it. The battle is saved beside it under its own id.

## 3. Editing

Every edit goes through one planner (`createPlanner`). The planner holds the
scenario, the selection and the tool. It saves accepted edits, reports
refused ones and changes nothing for them. The map editor (`MapEditor`) and
the side panel only call the planner.

The 3D view hands its pointer to the 2D map's surface, which calls the same
editor (docs/adr/0039), and draws the same overlay through its own
projection. So everything below works the same in 2D and 3D.

| Input                     | Effect                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| P, or a Place button      | Place squads of the chosen side and organization: one per click.                                                                 |
| M, A or W                 | Move, Attack or Withdraw orders for the selected squad: each click adds one after the selected order, or at the end of the plan. |
| S or Esc                  | The Select tool. Esc again clears the selection.                                                                                 |
| Click a squad or waypoint | Select it.                                                                                                                       |
| Drag a squad              | Move it (Setup only).                                                                                                            |
| Drag a waypoint           | Move its destination.                                                                                                            |
| Drag the white knob       | Turn the selected squad: its facing at the start.                                                                                |
| Right-click a waypoint    | Delete its order.                                                                                                                |
| Delete                    | Delete the selected order, or else the selected squad (Setup only).                                                              |

**Who may change what:**

- In Setup:
  - squads of either side can be placed, moved, renamed, reorganized and
    deleted;
  - OPFOR plans can be edited.
- In Planning:
  - BLUEFOR plans can be edited;
  - BLUEFOR squads can be turned and their formation changed;
  - squads cannot be moved;
  - OPFOR is read-only.

**The side panel** shows:

- The selected squad: its name, organization, formation, facing and start,
  and its plan as a list. Each order's kind can be changed there, and orders
  can be reordered or deleted.
- The roster by force: each force's squads and soldiers, and each squad's
  plan length and problems. A double click centres the map on the squad.
- The scenario: its seed and what still blocks it.

**On the map:**

- A squad is drawn as a unit symbol:
  - a rectangle for BLUEFOR and a diamond for OPFOR, each with the infantry
    cross;
  - the echelon above it (● for a squad, Ø for a team or element);
  - its name below it.
- Its soldiers are drawn as dots where they start.
- A plan is a line through its waypoints, with a chevron on each leg. OPFOR's
  lines are dashed.
- A waypoint shows its kind by its shape and initial (● M Move, ◆ A Attack,
  ■ W Withdraw), followed by its number and kind.
- Problems are ringed in amber.

In 3D, the soldiers stand as characters where the battle starts them. This
is the battle's own starting state, recorded once and given to the view as
`figures`.

## 4. Checks

`scenarioIssues` lists what stops a scenario from being played:

- a side with no squad;
- a squad whose centre, or any of whose soldiers' starting spots (as the
  battle lays them out), is off the map, in water or in a building;
- a destination that cannot be stood on, or cannot be walked to from the
  previous point of the plan (`planPath`, memoized between edits).

**Placing and moving squads.** A squad placed or dragged where it, or any
of its soldiers, would stand in water or in a building is moved to the
nearest clear ground instead (`clearSquadPosition`). The search goes outward
in rings of 4 m, up to 200 m, until the centre and every soldier's start are
clear. A message says how far the squad moved and what from, for example
"1st Squad was moved 28 m, clear of the buildings". During a drag, the
message appears once the squad is dropped.

**Placing and moving destinations.** A destination placed in water or in a
building is moved out of it in the same way (`nearestClearPoint`, up to
200 m), with a message.

**What is still refused:**

- a point off the map;
- a point with no clear ground within 200 m.

**What is saved and reported instead:**

- a squad turned or reorganized so that its soldiers reach into a building;
- a scenario saved before this change, or imported;
- an unreachable destination.

Work in progress is never lost.
