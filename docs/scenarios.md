# Saved scenarios

Users manage scenarios; Ambush! manages their terrain. A scenario is saved
in the browser (the **scenario library**) or as a portable file
(`*.ambush.json`), and refers to the battlefield it was made on without
containing it. Loading a scenario finds that battlefield — open, saved in
the browser, or generated again — and never puts the scenario on another
battlefield without saying so.

Code: `src/app/scenarios/` (format `document.ts`, library `library.ts`,
battlefield resolution `terrain.ts`, the user interface `ui.ts` and
`manager.ts`); storage `src/acquire/store.ts`.

## Where scenario management appears

| Stage                       | Save | Save As | Load | Import | Export |
| --------------------------- | ---- | ------- | ---- | ------ | ------ |
| Select Terrain              | –    | –       | yes  | yes    | –      |
| Scenario Setup (OPFOR)      | yes  | yes     | yes  | yes    | yes    |
| BLUEFOR Planning            | yes  | yes     | yes  | yes    | yes    |
| Combat, After-Action Review | –    | –       | –    | –      | –      |

Scenario management is a planning activity: Combat and the review have no
scenario controls at all.

## Storage

IndexedDB database `ambush` (version 3), alongside the battlefields:

| Object store     | Key            | Value                                                     |
| ---------------- | -------------- | --------------------------------------------------------- |
| `savedScenarios` | scenario id    | a saved-scenario document (below)                         |
| `scenarioLinks`  | battlefield id | `{ libraryId, fingerprint }`: the working scenario's link |
| `scenarios`      | `<bf>/battle`  | each battlefield's working scenario (as before)           |
| `battlefield*`   | battlefield id | battlefields (as before)                                  |

- **Working scenario.** Each battlefield keeps the scenario its planning
  pages edit, saved as it is edited (so a reload loses nothing).
- **Saved scenarios** are the user's: named, any number per battlefield,
  independent of the battlefields. Deleting a saved scenario never deletes a
  battlefield; deleting a battlefield keeps the saved scenarios that refer
  to it (loading one generates the battlefield again).
- **Link.** A working scenario loaded from, or saved as, a saved scenario is
  linked to it, with the `editableFingerprint` of what was saved: the
  fingerprint of its name, seed and squads (positions, facings,
  organizations, formations, plans). It has **unsaved changes** when its
  fingerprint differs; one never saved has unsaved changes when it holds any
  work (a squad, or a seed other than 1). Moving the camera, selecting or
  changing the stage changes nothing.

## The document

One format for the library and for files: schema `ambush.saved-scenario`,
version 1. Plain JSON; nothing in it is executed.

```jsonc
{
  "schema": "ambush.saved-scenario",
  "schemaVersion": 1,
  "id": "0f6b5a2e-…",                 // stable identity (UUID)
  "name": "Woodland encounter",
  "createdAt": "2026-10-15T10:00:00.000Z",
  "modifiedAt": "2026-10-15T11:00:00.000Z",
  "application": {                    // what made it
    "name": "Ambush!",
    "scenarioSchemaVersion": 2,       // of "scenario" below
    "importerVersion": "1.10.0"       // the battlefield importer of the Ambush! that saved it
  },
  "stage": "bluefor",                 // planning stage to return to: "scenario" | "bluefor"
  "terrain": {                        // the battlefield it was made on
    "battlefieldId": "7c1e…",         // content fingerprint of the battlefield's request and terrain
    "name": "Quantico, Prince William County, Virginia",
    "request": { "centre": { "lat": 38.5219, "lon": -77.2911 },
                 "widthM": 5000, "heightM": 5000, "cellSizeM": 10, "name": "…" },
    "crs": { "epsg": 32618, "zone": 18, "hemisphere": "N" },  // local metres east and north of the centre
    "geographicBounds": [ { "south": …, "west": …, "north": …, "east": … } ],
    "terrainModel": "…",              // the ground model the simulation ran on (terrainModelId)
    "generation": {
      "importerVersion": "1.10.0",
      "createdAt": "2026-10-13T21:02:15.000Z",
      "buildingSource": "overture",   // "overture" | "openstreetmap" | "none"
      "overtureRelease": "2026-09-23.1",
      "treeCover": "canopy",          // "canopy" | "off"
      "osmAvailable": true,
      "osmTimestamp": "2026-10-13T20:59:00Z",
      "elevation": { "provider": "aws-terrain-tiles-terrarium", "zoom": 14, "finestResolutionM": 3 }
    }
  },
  "scenario": {                       // ambush.scenario version 2: what the planning stages edit
    "schema": "ambush.scenario", "schemaVersion": 2,
    "id": "7c1e…/battle", "battlefieldId": "7c1e…", "name": "Woodland encounter",
    "terrainModel": "…",
    "seed": 4242,                     // the battle's random seed
    "squads": [
      { "id": "B1", "name": "1st Squad", "side": "BLUEFOR",
        "organization": "squad",      // squad | fireTeam | element3: soldiers, roles, weapons
        "formation": "usmc.squad.line",
        "position": { "east": -200, "north": -300 },   // its centre at the start
        "facingDeg": 0,
        "plan": [ { "kind": "move", "destination": { "east": -150, "north": -100 } },
                  { "kind": "attack", "destination": { "east": 0, "north": 280 } } ] }
    ]
  }
}
```

Everything the battle is made from is in `scenario`: the squads, their
organizations (which fix their soldiers, roles, weapons and loadouts), their
formations, starting positions and facings, their plans (order kinds and
destinations), and the seed. Soldiers' starting spots, their ids
(`<squad>-01`…) and their organization within the squad follow from it, as
in the game. Movement speeds and behaviour are the simulation's, not the
scenario's.

The same scenario, terrain, simulation and seed give the same battle
(`battleSpecOf`, `createBattle`): loading a saved scenario restores
identical initial conditions.

### Reading

`parseScenarioDocument` checks a document completely before anything uses
it: JSON syntax, size (5 MB at most; 500 squads, 500 orders a squad), schema
and version, every field's kind, the terrain reference, squad ids (unique,
letters and digits), sides, organizations, formations, order kinds and map
points; the scenario must name the terrain reference's battlefield. Fields
it does not know are refused: a newer Ambush! may have meant something by
them, and dropping them silently could change the battle.

### Versions and migration

- A document of a newer version is refused, saying it comes from a newer
  Ambush!.
- A bare battle scenario (`ambush.scenario` version 2, as exported before
  the library) is migrated: it gets a new id and the time of import, and its
  battlefield is named by id only, so it loads only where that battlefield is
  saved.
- A version 1 scenario (the retired ambush exercise's) is migrated as well
  (`migrateAmbushScenario`).

A future version adds a reader for the previous one, rather than accepting
unknown fields.

## Finding the battlefield

`resolveTerrain` (Load and Import):

1. the battlefield open now, if its id is the reference's;
2. else the one saved in this browser with that id;
3. else the battlefield **generated again** from the reference's request,
   with its building source, Overture release and tree cover, and OSM
   allowed to be missing when it was. It is saved, like any generated
   battlefield.

A battlefield's id is the fingerprint of its request and terrain, so a
battlefield generated again is the same one only if it gets the same id.
When the source data has changed (OpenStreetMap edits, a newer elevation
or building release), it gets another id: the user is told that this is not
the ground the scenario was made on and chooses to load it there anyway or
not. A battlefield is never chosen by matching coordinates. When the
battlefield can be neither found nor generated (no network, or an old file
naming it by id only), loading stops with the reason and **Try again**; the
current scenario is unchanged.

The ground model (`terrainModel`) is compared too: a battlefield opened by a
newer Ambush! may grade its ground differently, and the user is told to
check the squads' positions.

## Loading is all or nothing

Loading or importing reads and checks the scenario, finds its battlefield,
and asks about unsaved changes, before anything is replaced. If any step
fails or is cancelled, the scenario being planned is as it was. Unsaved
changes are offered **Save**, **Discard** or **Cancel**; Discard takes
effect only when the new scenario is in place. A battle fought (Combat) or
reviewed belongs to the scenario it was fought from and is left with it.

## Import and export

- **Export** downloads the scenario being planned as
  `<name>.ambush.json`, saved or not. It does not save it in the browser.
- **Import** reads a file, checks it, finds its battlefield and loads it,
  adding it to the library. A file whose id is a saved scenario's is never
  silently written over: the user imports it as a new copy (new id) or
  replaces the saved one.
