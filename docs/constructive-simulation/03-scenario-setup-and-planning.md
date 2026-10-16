# Constructive simulation 03: Scenario Setup and Planning

- Status: implemented (Milestone B, 2026-10-15)
- Part of: [Constructive simulation](README.md)
- Code: `src/exercise/battle/scenario.ts` (the scenario: schema, migration,
  edits, checks); `src/app/battle` (planner, map editor, page, preview
  overlay); `src/app/main.ts`, `stages.ts`, `workflow.ts`

## 1. The workflow

| Stage                  | Address        | What happens                                                                                                                                 |
| ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Terrain             | `#select/<id>` | Choose or generate a battlefield. The preview shows the terrain alone (no squads or markers). A scenario loaded here opens at once in Setup. |
| 2. Scenario Setup      | `#setup/<id>`  | Place and turn both sides' squads and vehicles. No orders.                                                                                   |
| 3. Planning            | `#plan/<id>`   | Give both sides' squads, and the vehicles, their orders. OPFOR can be hidden with Show OPFOR.                                                |
| 4. Combat              | —              | Milestone C. The stage opens once the plans are valid, and says what comes next.                                                             |
| 5. After-Action Review | —              | Milestone D.                                                                                                                                 |

The header labels the stages Terrain, Setup, Planning, Sim and AAR. Their
gates come from the page (`WorkflowRules`):

- Setup → Planning needs at least one squad per side, and every squad and
  vehicle standing clear.
- Planning → Combat also needs every order valid and reachable.
- Earlier stages are always open. Going back to Terrain unloads the scenario
  (the battlefield's working scenario is emptied), after a warning that says
  whether it has unsaved changes.
- Opening a battlefield from Terrain in 3D keeps the same 3D view: the 2D map
  never shows meanwhile.

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

| Input                      | Effect                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Place button (Setup)     | Place squads (or vehicles) of the chosen side and organization: one per click.                                                                                                              |
| An order button (Planning) | Orders of that kind for the selected squad: each click adds one after the selected order, or at the end of the plan. An OPFOR Move clicked on a road becomes Moves along the roads (below). |
| Esc                        | The Select tool. Esc again clears the selection.                                                                                                                                            |
| Click a squad or waypoint  | Select it.                                                                                                                                                                                  |
| Drag a squad               | Move it (Setup only).                                                                                                                                                                       |
| Drag a waypoint            | Move its destination.                                                                                                                                                                       |
| Drag the white knob        | Turn the selected squad: its facing at the start.                                                                                                                                           |
| Right-click a waypoint     | Delete its order.                                                                                                                                                                           |

**Who may change what:**

- In Setup:
  - squads and vehicles of either side can be placed, moved, turned, renamed,
    reorganized and deleted;
  - no orders are given.
- In Planning:
  - either side's orders, and the vehicles' routes, can be edited;
  - squads can be turned and their formation changed;
  - squads and vehicles cannot be moved.

There are no shortcut keys: Esc cancels (a tool, a selection, a dialog), and
Shift-click in Combat appends orders instead of replacing them.

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

**Soldiers in water or a building.** A soldier whose start would be in
water or in a building stands on the nearest clear ground instead
(`clearStarts`, using `nearestClearPoint` up to 200 m, kept 1.5 m from the
squad's others). Every other soldier stays exactly where the formation puts
him, and the squad's own position is unchanged.

The battle lays its squads out this way. So this holds however the squad
got there:

- placed or dragged;
- turned with the knob or the facing field;
- given another organization or formation;
- saved earlier, or imported.

Each edit that moves soldiers says how many were moved and what from, for
example "4 of 1st Squad's soldiers were moved clear of the buildings". During
a drag, the message appears when the squad is dropped.

**Destinations.** A destination placed or dragged into water or a building is
moved out of it to the nearest clear ground, with a message.

**What is still refused:**

- a squad or destination placed off the map;
- a squad placed where some of its soldiers would have no clear ground
  within 200 m (for example, the middle of a lake).

**What is reported instead:** a squad that ends up in that state some other
way, and an unreachable destination. They are listed as problems and saved.

Work in progress is never lost.

## OPFOR moves along roads

A Move order for an OPFOR squad clicked on a road (within the road's
half-width plus 2 m) is laid along the roads (`roadWaypoints`,
`src/sim/road-network.ts`; the road network of [ADR 0043](../adr/0043-bridge-and-road-navigation.md)).
From the squad's start, or the order before the new one:

- a Move to where it joins the nearest road leading there that it can walk
  to (left out when it is already on the road);
- a Move to each turn of the road route, simplified to within 3 m of the
  road and no closer than 25 m to one another;
- a Move to the point clicked.

They are ordinary Move orders, inserted where the one Move would have been,
and can be moved or deleted like any other. A message says how many were
added. A Move clicked off the roads, any other order, and BLUEFOR's orders
go straight to the point clicked.

## Viewsheds

Each squad's start, and each of its waypoints, has an eye in the squad panel that turns its
viewshed on or off (the start's eye is beside the squad's name). Any number can be on,
of either side, in Scenario Setup and Planning.

- **What it shows:** what the squad's soldiers can see, all round, out to 1,200 m (the detection
  model's longest observation range). It is seen from where they start; for a waypoint, from where
  the formation will put them on arriving there, facing the way they came. At an ambush position it
  is the firing line, facing the kill zone.
- **Colours:** BLUEFOR's are light blue and OPFOR's light red; ground both sides see is purple. They
  are drawn over the 2D map and on the 3D ground. Each one that is on is ringed on the map.
- **Speed:** a coarse look comes first and is refined to 4 m detail in about two seconds (ADR 0055).
  While a squad or waypoint is dragged its viewsheds are hidden; they are
  worked out again when it is dropped.
- **Following orders:** they follow their orders when orders are added, moved or deleted.
- **Show or hide:** the **Viewsheds** box on the map bar shows or hides them all. In BLUEFOR
  Planning, OPFOR's are hidden with OPFOR.
