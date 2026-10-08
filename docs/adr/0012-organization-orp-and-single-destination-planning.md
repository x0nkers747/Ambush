# ADR 0012: Doctrinal organization, ORP and single-destination deployment

- Status: Accepted; §5 is superseded for individual soldiers by ADR 0013 (custom role icons,
  organization template schema version 2, in which a role's loadout and icon are separate
  properties a slot may override, and version 1 templates are converted). APP-6 unit symbols
  are unchanged.
- Date: 2026-10-08
- Supersedes in part: ADR 0009 (trainee waypoint chains, `SoldierPlan`, waypoint
  identity) and the trainee-route parts of ADR 0011. OPFOR scenario routes are
  unchanged.

## Context

Up to Phase 3.6 the trainee's force was a hand-written squad of nine, and each
soldier's plan was a chain of waypoints. Phase 3.7 makes the organization
doctrinal and data-driven, starts the force at an objective rally point (ORP),
and reduces planning to what a squad leader actually decides for each Marine:
**where to go and which way to face**. Combat (Phase 4) is not started.

## Decision

### 1. Organization templates (versioned JSON)

An organization is described by an **organization template**: a JSON file,
validated when loaded (`validateOrganizationTemplate`, `exercise/organization.ts`).

| Field                   | Meaning                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `schema`                | Always `"ambush.organization-template"`                                                |
| `schemaVersion`         | Schema version, `1`. Other versions are refused, not guessed at                        |
| `id`, `version`, `name` | Stable id, the template's own semantic version, display name                           |
| `source`                | `doctrine` (designation, title, publisher, date, references, status) or `synthetic`    |
| `conventions`           | Ambush!-specific choices that are **not** from the source                              |
| `roles[]`               | id, name, abbreviation, optional grade, optional weapon-profile refs, symbology (SIDC) |
| `units[]`               | id, name, abbreviation, echelon label, parent id, leader slot id, optional symbology   |
| `slots[]`               | id, unit id, role id, short label: one per person                                      |

Validation refuses unknown fields (typos cannot pass silently), repeated ids or
labels, references to unknown units, roles or slots, more or fewer than one root
unit, parent cycles, a leader slot outside its unit, units with nobody in them
or below them, malformed symbol codes, and doctrinal sources without a date,
references or currency statement. Errors name the JSON path.

Nothing in the code assumes a size or shape: array order is display order only;
**identities are always explicit ids**. The simulation's `Echelon` became a free
label (`string`) supplied by the template. A synthetic test template
(`exercise/test-data/synthetic-patrol.template.json`: six people, three levels,
no fire teams) runs through validation, instantiation, the roster and a full
Execute-to-Ready exercise in the tests.

### 2. The default organization and its source

`exercise/organizations/usmc-rifle-squad-mcwp-3-11-2.json` represents exactly
one organization:

- **Source:** MCWP 3-11.2 (formerly FMFM 6-5), _Marine Rifle Squad_,
  Headquarters U.S. Marine Corps / MCCDC, foreword dated **2 December 1991**,
  PCN 143 000112 00; Change 1 of 24 July 1997 (mine-warfare pages only); erratum
  of 27 November 2002 re-identifying FMFM 6-5 as MCWP 3-11.2.
- **Taken from:** para 1002 (three fire teams, each built round an automatic
  weapon and led by a fire team leader), para 1003 (13 men: a sergeant squad
  leader and three fire teams of four: corporal fire team leader/grenadier, two
  lance corporals as automatic rifleman and assistant automatic rifleman, a
  private or private first class rifleman), Figure 1-1, and para 1004a (organic
  weapons). The text was read from the scanned manual itself.
- **Currency:** the manual is superseded. Later publications (MCIP 3-10A.4i,
  2019; MCRP 3-10A.4, 2020) are **not** represented. The template's `status`
  field says so, and nothing in the application presents it as current USMC
  organization.
- **Ambush! conventions** (recorded in the template's `conventions`, not
  presented as doctrine):
  - fire-team numbering (1st/2nd/3rd) and the ids SQD, FT1–FT3;
  - role abbreviations (SL, FTL, AR, AAR, R) and map labels (`1-AR`, …);
  - the choice of symbol codes;
  - weapon profile references (`m16-rifle`, `squad-automatic-weapon`, …),
    which are names for later phases, not modelled weapons.

### 3. Template versus scenario instance

A scenario never edits a template; it **instantiates** it
(`instantiateOrganization`, `deployInOrp`):

- `OrganizationInstance` names the template by id **and version** (a mismatch is
  refused), the side, a unit-id prefix, default facing and posture, and the
  members: `{ soldierId, slotId, start?, facingDeg? }`.
- Every slot must be filled exactly once by a distinct soldier. Vacant slots
  are refused for now (see Future work).
- Soldier ids are scenario data (`M01`…`M13` in the demo) and deliberately
  differ from slot ids, so neither can stand in for the other. Listing the
  members in another order changes nothing.
- The resulting `AmbushScenario` carries `organization` (template plus who fills
  which slot) and `orp`. `createExercise` re-validates them
  (`validateTraineeSetup`): every trainee soldier fills one slot and stands in
  that slot's unit.

### 4. The objective rally point

`AmbushScenario.orp`: `{ id, name, centre: { east, north }, shape }`, where the
shape is `{ kind: 'circle', radiusM }` or `{ kind: 'ellipse', majorAxisM,
minorAxisM, orientationDeg }` (full axis lengths; orientation of the major axis
clockwise from grid north).

- **Placement:** a member's explicit `start` wins. Otherwise the members take
  the ORP's deterministic layout in member order: points of a 3 m grid aligned
  with grid north, kept 0.5 m inside the boundary, where a soldier may stand
  (`pointProblem`), nearest the centre first, ties broken northernmost then
  westernmost. The ordering uses integer grid coordinates, so no floating-point
  or platform difference can change it. No randomness is involved.
- **Validation:** the ORP must lie on the terrain and have a valid shape; every
  trainee soldier must start inside it, where a soldier can stand (not in or
  against a building), at least 1 m from every other.
- **Not an obstacle:** the simulation never sees the ORP. Navigation, LOS and
  movement are unchanged; a test plans a straight path across it.
- **Rendering:** a dashed outline with a faint fill, labelled with the ORP's
  name just outside its northern edge, drawn beneath kill zone, paths and
  symbols. It stays after everyone has left and is never hit-tested, so it
  cannot intercept selection or destination clicks.

### 5. Symbology: milsymbol, and what is standard

> Individual soldiers now use Ambush!'s own role icons, not APP-6 (ADR 0013). This section still
> describes the milsymbol library and the unit symbols.

**Library: milsymbol 3.0.4** (npm `milsymbol`, MIT licence, by Måns Beckman).

| Criterion   | Finding                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licence     | MIT                                                                                                                                                                                                        |
| Standards   | MIL-STD-2525 B/C/D/E, STANAG APP-6 B/D/E, FM 1-02.2. Since 3.0 renders to APP-6 E / 2525 E style                                                                                                           |
| Browsers    | Pure JavaScript; SVG strings and Canvas. Works in Chrome and Edge (smoke-tested) and in Node for SVG                                                                                                       |
| Size        | ≈ 198 KB gzipped (862 KB minified) for the full library. Importing only the APP-6 D tables saves just 29 KB and needs a deep import the package's export map does not allow, so the default import is used |
| Maintenance | Active: 3.0.0 February 2025, 3.0.4 March 2026; long-established project, single maintainer                                                                                                                 |

Hand-drawing symbols was rejected: it would mean re-implementing part of a
large standard. The commercial or closed alternatives were not needed.

**What each Marine shows, and where it comes from:**

| Element                   | Standard or Ambush!?                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Frame shape and colour    | **Standard** (milsymbol): friendly affiliation                                                                                 |
| Icon                      | **Standard**: symbol set 27 _Dismounted Individual_, entity 11 01 01 (infantry), SIDC `10032700001101010000`                   |
| Role label (`1-AR`)       | **Ambush!** text beside the symbol (it sits where a unique-designation field would, but it is not drawn as one)                |
| Facing indicator          | **Ambush!**: a short dark stroke outside the frame. Not the standard's direction-of-movement arrow, which means something else |
| Selection ring            | **Ambush!**: yellow ring                                                                                                       |
| Compact dot (decluttered) | **Ambush!**: small blue dot at the true position                                                                               |
| OPFOR red diamond         | **Ambush!**: unchanged from Phase 3; not a standard symbol                                                                     |

- **Same symbol for every role.** Every role uses the same individual-infantry
  code. Ambush! does not invent per-role codes, and it does not use the
  _unit_ infantry symbol, which stands for a formation, not a person. The
  template's units do carry unit symbols (land unit, infantry, with the squad
  and team echelon amplifiers), and the roster shows them as headings.
- **Unverified entity naming.** The individual-symbol code is milsymbol's
  implementation of symbol set 27. The published APP-6 E entity table was not
  available to check the exact entity naming against, so the code is recorded
  as template data that a later revision can change without touching code.

**Decluttering** (`symbolLayout`, pure and tested) never moves a symbol: the
selected Marine is placed first, then the others in roster order. A Marine whose
full symbol would overlap one already placed is drawn as a compact dot at its
true position. Labels are shown only where they overlap nothing placed before
them, and always for the selected Marine. The roster gives direct access to
everyone in a cluster.

### 6. Roster

The side panel lists the organization from the template tree: unit headings
(with unit symbols), then each slot's role abbreviation, role name (full name,
leader role and map label in the tooltip), soldier id and status. Selection is
shared with the map in both directions via the session. Choosing a Marine who
is off screen centres the map on them.

Statuses (`Exercise.deploymentStatus`) are neutral descriptions of state:

- **At ORP**
- **Destination assigned** (including edits not yet executed)
- **Moving** (walking, or turning to the facing)
- **In position** (at the destination with the facing applied)
- **Holding** (no destination, standing outside the ORP, e.g. after the
  destination was cleared on the way)

The panel is generated from the tree, so another organization needs no code
change.

### 7. Single-destination deployment plans

The trainee's intent per Marine is a `SoldierDeploymentPlan`:

```ts
{ soldierId; destination: { east, north } | null; facingDegrees: number | null }
```

- **Destination:**
  - clicking the map sets the selected Marine's destination;
  - clicking again, or dragging the marker, moves it;
  - right-click on the marker, Backspace, or **Clear destination** removes it.
- **Facing:**
  - dragging the arrow handle sets `facingDegrees`, a bearing in [0, 360);
  - it is kept when the destination moves or is cleared;
  - **Default facing** returns it to `null`.
- **Default facing:** applies only while `facingDegrees` is `null`:
  - with a destination, the direction of the last piece of the generated path
    (the Marine keeps facing the way it walked);
  - without one, its current facing.

  The map shows the default arrow dashed and labelled "(default)". It is a
  placeholder, not a tactical recommendation.

- **Reset** discards uncommitted edits for that Marine: back to the last
  executed plan.
- **Validation:** destinations are checked when set (on the map, not in or
  against a building, reachable from where the Marine stands) and again at
  Execute/Resume. A refused edit changes nothing and says why.
- **Drafts and commits:**
  - before Execute every plan is empty;
  - each commit records the plans in a `PlanRevision`, and only Marines whose
    plan changed are re-ordered;
  - pausing or reaching Ready offers the committed plans for editing.

### 8. Relationship to navigation and the simulation

The single destination is carried out with the existing machinery, kept
encapsulated in the exercise layer:

- A changed plan becomes ordinary simulation `Orders`:
  - one waypoint (`<soldierId>.dest.<revision>`) at the destination, or none;
  - a final facing, which is the explicit facing or the default resolved at
    commit time.
- The simulation plans the walkable path when the orders arrive, with the same
  `planPath` the display uses, from the same position. **The path shown is the
  path walked** (tested). While a Marine carries out its plan, the display shows
  the path it is actually following.
- Generated turn points are drawn as a plain line, with no markers or handles:
  they are not intent and cannot be edited.
- The simulation kernel, movement, navigation and LOS code are unchanged, and
  so are their tests.

### 9. Visibility

The viewshed is computed from the selected Marine's destination, or from where
the Marine stands if it has none. It updates as soon as the selection or the
destination changes. While the destination is being dragged it shows the 8 m
preview; otherwise the full 4 m result. The overlay still takes no clicks.

### 10. Readiness

BLUEFOR is ready when every active Marine with committed orders has reached its
destination and turned to its facing. Marines without a destination or facing
have no orders and never hold up readiness. Nothing forces the trainee to
assign anyone; Execute with no plans at all is valid and reaches Ready on the
next tick. START OPFOR and the OPFOR approach are unchanged.

### 11. Compatibility and versions

- **No persisted data existed.** Up to Phase 3.6 nothing was saved: no
  localStorage, no files, no saved plans. Simulation snapshots (ADR 0008) hold
  simulation state only, never exercise plans. There is therefore nothing to
  migrate.
- **Simulation snapshots are unaffected.** The `Orders` format, `SimState`
  shape and world fingerprint are unchanged (`Echelon` widening to `string`
  changes no data). The pinned determinism hashes (`sim/determinism.test.ts`)
  did not change and were not touched.
- **Scenario fingerprint.** `Exercise.scenarioFingerprint` (FNV-1a 64 over the
  canonical encoding, like the world fingerprint) covers:
  - the scenario id and world fingerprint;
  - the organization template's id, version and content hash;
  - who fills which slot, the ORP, units, starting positions and OPFOR routes.
- **Deployment-plan exchange format.** `serializeDeploymentPlans` /
  `parseDeploymentPlans` (`ambush.deployment-plans`, schema version 1) are
  deterministic: fixed key order, roster order. Data is refused with a clear
  message:
  - if it is for another scenario fingerprint (so another template or template
    version is refused too);
  - if it has another schema or version, unknown or repeated soldiers, unknown
    fields, or invalid values.

  `Exercise.loadDeploymentPlans` applies a set all-or-nothing, after validating
  every destination against the current positions.

- **Old waypoint chains are rejected, never converted.** Data containing
  `waypoints` or `finalFacing` is refused with "waypoint-chain plans from
  before Phase 3.7 … plan each soldier again". Picking the last waypoint (or
  any other) as "the" destination would be guessing intent, so **no migration
  rule is defined**.
- **Template versions.** A change to a template's content must bump its
  `version`. Instances name the version they were written for, and the
  fingerprint changes with the content either way.

## Consequences

- Planning is simpler and closer to the decision being trained. Multi-leg
  routes (e.g. a covered approach via a chosen point) are no longer
  expressible by the trainee; the generated path takes the shortest walkable
  line. If routes matter again, they come back as a separate, explicit concept.
- The demo squad is now 13 Marines with ids M01–M13; tests and smoke scripts
  that used the old ids (SL, A-TL, …) were rewritten.
- milsymbol adds about 198 KB gzipped to the bundle.
- Echelon labels are free text; only the template gives them meaning.

## Future work

- Further doctrines and organizations as additional template files: other USMC
  publications, other services and nations, and attachments (e.g. a machine-gun
  team). These need no code change while they fit the schema.
- Vacancies (unfilled slots) and casualties replacing slot holders (Phase 4+).
- Group deployment, formations and recommendations: explicitly out of scope
  here.
- Weapon and equipment profiles behind `weaponProfileRefs` (with combat).
- Persisting plans (the versioned format exists; nothing writes it yet).
- If a published APP-6 E table becomes available, review the individual
  symbol's entity code and record the reference here.
