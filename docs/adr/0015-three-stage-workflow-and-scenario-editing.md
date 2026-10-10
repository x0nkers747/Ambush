# ADR 0015: Three-stage workflow and scenario editing

- Status: Accepted
- Date: 2026-10-08
- Builds on ADR 0010 (ambush scenarios and OPFOR routes), ADR 0012 (ORP) and ADR 0014 (generated
  battlefields, whose minimal scenario this replaces for play).
- Stages, navigation and screens superseded by ADR 0025 (five-stage workflow); the scenario model,
  editing rules and storage still hold.

## Context

A generated battlefield (ADR 0014) had terrain and a squad, but no OPFOR, so it could not be played
as an ambush. Scenarios were TypeScript modules (the demo). The trainee now needs to set up a
scenario on any battlefield, then plan and execute the ambush on it. The goal is a simple
workflow to test and iterate on, not a polished editor.

## Decision

### Three concepts, kept apart

| Concept         | What                                           | Where                                                    | Stored                                      |
| --------------- | ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| **Battlefield** | Terrain, elevation, OSM features               | `BattlefieldPackage` (`#geo`, ADR 0014)                  | IndexedDB, immutable                        |
| **Scenario**    | ORP, OPFOR force and route, on one battlefield | `ScenarioDefinition` (`exercise/scenario-definition.ts`) | IndexedDB `scenarios` store, by battlefield |
| **Exercise**    | BLUEFOR plans, execution, simulation state     | `Exercise` (unchanged)                                   | Not stored (as before)                      |

`ScenarioDefinition` (`ambush.scenario`, schema version 1) is plain, versioned JSON. It holds:

- `id` and `battlefieldId`;
- `name`;
- `orp`: the centre of a 14 m circle, or `null`. A new scenario has none: the trainee places it.
  Until then the squad and the ORP are not shown, in the scenario editor or the terrain-selection
  preview (`buildPreviewScenario` builds the squad at the suggested ORP, so the exercise has its
  organization, and marks it not placed; the map leaves it out);
- `opfor: { force, route }`: the force id and the route as local map points, whose **first point
  is where the OPFOR starts**.

`buildScenario(terrain, definition)` turns it into an ordinary `AmbushScenario`:

- **BLUEFOR:** the MCWP 3-11.2 squad, laid out in the ORP as before.
- **OPFOR:** the demo's force, `patrol-3`: EN-1, EN-2 and EN-3 in fire team EN-TM, led by EN-1.
  - EN-1 stands on the route's start and the others in file, 12 m apart, behind it, opposite the
    first leg. If those spots are blocked, the nearest usable spots nearby are used.
  - Each soldier follows the route's remaining points as its `OpforRoute`, as in the demo.
  - Each faces the first leg at the start and the last leg at the end.

The exercise, simulation and map need nothing new to play it. The schema allows several scenarios
per battlefield; the UI uses one, `<battlefieldId>/1`.

### Editing rules

Every edit is a pure function returning the new definition or the reason it was refused, so
nothing invalid is ever stored. The edits are `setOrp`, `setOpforStart`, `addRouteWaypoint`,
`moveRouteWaypoint`, `deleteRouteWaypoint` and `clearRoute`.

- **ORP:** the centre must be standable (not in a building or water), the circle must be on the
  map, and the 13 Marines must fit (`layoutOrp`).
- **OPFOR start and waypoints:** each point must be standable and each leg walkable (`planPath`,
  so legs bend round buildings as before). There is no road following.
- **Continue** (`scenarioProblems`) needs an ORP, an OPFOR start and at least one waypoint, all
  valid.

### Stages and navigation

Each stage has an address; moving between stages saves first and reloads the page. Every stage
then starts from saved data, and nothing from the previous one (frame loops, key handlers, a
running simulation) survives. Reloading stays on the same stage.

| Address      | Stage                                      |
| ------------ | ------------------------------------------ |
| (none)       | 1. Terrain selection (ADR 0014, unchanged) |
| `#edit/<id>` | 2. Scenario editing                        |
| `#play/<id>` | 3. BLUEFOR planning and execution          |
| `#demo`      | The demo, straight to planning             |

- **1 → 2:** opening or generating a battlefield.
- **2 → 3:** Continue, when the scenario is complete. A `#play` address with an incomplete
  scenario goes back to editing.
- **3 → 2 or 1:** the "◂ Scenario" and "◂ <battlefield>" buttons. Once a plan has been executed,
  the first click asks "Discard this exercise?" and the second leaves. The exercise is discarded,
  never changed while it runs. The scenario is kept, since it was saved.
- **2 → 1:** "◂ Terrain". Scenario edits are saved as they are made.

### The editor

The scenario editor is the tactical map with three tools (Place ORP, Place OPFOR, Edit OPFOR
route), Clear route, Reset scenario (two clicks), Fit map, and Continue. A side panel shows the
scenario, what Continue still needs, and the route's points (each deletable).

- **Click** with the Place ORP or Place OPFOR tool to place; **drag** the ORP or the OPFOR start
  to move it.
- With the route tool, **click** adds a waypoint at the end, **drag** moves one, and
  **right-click** deletes one.
- Panning and zooming work as in planning. Refused edits explain why in a toast.

The map shows a **preview exercise** built from the definition after every accepted edit, so the
ORP, squad, OPFOR and its walked route appear with the game's own symbols. The editor draws only
the waypoint handles and numbers.

Two additive changes to the map (`view2d`) support this:

- `TacticalMap.setExercise()` swaps the preview without rebuilding the terrain layer;
- optional `MapEditor` hooks (`press`, `drag`, `drop`, `click`, `draw`, `cursor`) take over clicks
  and drags while panning and zooming stay with the map.

Without hooks the map behaves exactly as before.

### Persistence

IndexedDB database version 2 adds the `scenarios` store; existing battlefields are kept. Scenarios
are kept apart from the battlefield package and deleted with their battlefield. The `acquire`
layer stores them as opaque data (it may not depend on the exercise layer); the app validates
them with `parseScenarioDefinition`. A damaged scenario is replaced by a new default, with a
notice. Saved battlefields and their scenarios open without internet access, as long as the app
itself is reachable (`npm run dev` or a local build).

## Consequences

- Any generated battlefield becomes a playable ambush in a few clicks. The demo is unchanged and
  still opens straight into planning.
- The exercise, simulation, determinism and map rendering are unchanged. The pinned hashes and the
  demo tests pass as before.
- Stage changes reload the page. That is simple and leak-free, but a hosted deployment would need
  a service worker for full offline use.
- Not yet: several scenarios per battlefield in the UI, other OPFOR forces, road-following routes,
  inserting waypoints mid-route, undo, and editing scenarios on the demo terrain.
