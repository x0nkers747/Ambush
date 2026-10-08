# ADR 0013: Custom individual soldier icons

- Status: Accepted
- Date: 2026-10-08
- Supersedes in part: ADR 0012 §5 (symbology) for individual soldiers. APP-6 unit symbols
  (squad, fire teams) are unchanged.

## Context

Since Phase 3.7 every Marine was drawn with the same APP-6 friendly dismounted individual symbol
(milsymbol). The role was shown only as a text label, and OPFOR was a red diamond. At map
scale the APP-6 frame carried no role information and was hard to tell apart in a cluster. A
custom design was agreed, recorded in `assets/reference/individual-soldier-icons.png`, which is
the design authority for these icons.

## Decision

### The icon

Individual soldiers are drawn with **Ambush!'s own icons, deliberately not APP-6 or
MIL-STD-2525 symbols**. Each icon has:

- a filled circle coloured by affiliation;
- a black outline;
- a black role glyph in the centre, which always stays upright;
- a triangle outside the circle that turns about the centre to point in the soldier's facing.

| Role (icon id)                           | Glyph                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Squad leader (`squadLeader`)             | Solid five-pointed star                                                                        |
| Fire team leader (`fireTeamLeader`)      | Two stacked upward chevrons                                                                    |
| Rifleman (`rifleman`)                    | One thin vertical dash                                                                         |
| Automatic rifleman (`automaticRifleman`) | Two equal, evenly spaced vertical dashes                                                       |
| Grenadier (`grenadier`)                  | The reference image's rifle grenade: grooved oval body, short neck and lever, ring upper right |
| Marksman (`marksman`)                    | Crosshair with a solid centre dot                                                              |
| Medic (`medic`)                          | Solid cross                                                                                    |
| Radio operator (`radioOperator`)         | Antenna mast with two curved waves on each side                                                |

A soldier whose role is unknown is drawn as the plain circle and triangle, with no glyph. This
currently applies to OPFOR, which has no organization template and so no roles, and to slots
whose template defines no icon. The map does not invent a role it does not know.

**Affiliation colours**, taken from the reference image:

| Affiliation | Colour    |
| ----------- | --------- |
| Friendly    | `#5ec8f7` |
| Enemy       | `#f25c5c` |
| Friendly 2  | `#7cc56e` |
| Neutral     | `#f8cd4f` |
| Unknown     | `#a3a3a3` |

The trainee's side is friendly and the other side enemy. Friendly 2, neutral and unknown are
part of the palette for later use; no scenario uses them yet.

### Implementation

- **One definition, two outputs.** `src/view2d/soldier-icons.ts` defines every shape once as SVG
  path data in icon units (a circle 100 units across, centred on the origin). It produces:
  - SVG markup (`soldierIconSvg`), for the roster, the examples page and tests;
  - canvas drawing (`drawSoldierIcon`, via `Path2D`), for the map.

  The two outputs cannot drift apart. The size is a parameter: the circle's diameter in pixels.

- **Size.** The map draws icons at `SOLDIER_ICON_PX` = 22 px. The design was checked for
  legibility at 16, 24 and 32 px.
- **Map integration.** Icons replace the milsymbol bitmap in the existing soldier rendering:
  - positions, hit-testing, the planned-facing arrow and labels are unchanged;
  - the selection ring now sits beneath the icon so the facing triangle stays visible;
  - a label moves out to clear a triangle that points toward it.
- **Roster.** Each roster row shows its member's icon without a triangle. Unit headings keep
  their APP-6 unit symbols.

### Decluttering every soldier, of every affiliation

`symbolLayout` lays out **all** soldiers by the same rules, OPFOR included. OPFOR used to be
drawn separately, on top of everything, with no decluttering.

- **Order.** The selected soldier goes first, then the others in scene order. Each soldier gets
  its full icon unless its icon box would overlap a full icon already placed; then it is drawn
  compact, as a small dot in its affiliation's colour with a facing tick.
- **True positions.** No symbol is ever moved to make room, so every symbol stays at its
  soldier's real position.
- **Hidden soldiers.** A compact soldier whose position lies under a full icon cannot be seen.
  It is listed on that icon (`hidden`) and shown as a "+n" badge, with **one badge per
  affiliation, in that affiliation's colour**. An enemy hidden under a Marine is therefore never
  counted as friendly.
- **Labels.** A label is shown where it overlaps no symbol or label placed earlier; the selected
  soldier's label always shows. A trainee soldier's label is its slot label; any other soldier
  is labelled with its soldier id.

### Selecting soldiers in a cluster

`selectableSoldiersAt` lists the trainee soldiers whose icon box contains the click point,
nearest first. The list depends only on positions, never on the current selection or on who is
drawn in full.

A click selects the nearest of them, or, when the selected soldier is already among them, the
next one, wrapping round. Repeated clicks on a cluster therefore step through **every** Marine in
it, including compact and hidden ones; in the demo ORP at the fitted scale, 13 clicks reach all
13 Marines.

OPFOR is never selected. A click on an OPFOR symbol alone selects nothing and sets no
destination, as before. The roster still gives direct access to everyone.

### Role, loadout and icon are separate properties

What a position in the organization **is** (its role), what its holder **carries** (loadout) and
how it is **drawn** (icon) are three properties. Today the template determines all three, but
they are kept apart so that one can change without the others: for example a fire team leader
drawn as a grenadier, or a rifleman issued a different weapon.

- `TemplateRole`: the organizational role, meaning id, name, abbreviation and grade. It also
  gives two defaults:
  - `defaultLoadout`: `{ "weaponProfileRefs": […] }`;
  - `defaultIcon`: one of `INDIVIDUAL_ICONS`.
- `TemplateSlot` may override either default with its own `loadout` or `icon`.
- `resolveSlot(template, slot)` returns `{ role, loadout, icon }`, using the slot's value if it
  has one, else the role's default:
  - a missing loadout resolves to the empty loadout;
  - a missing icon resolves to `null`, drawn as the plain circle of an unknown role.
- The roster (`RosterMember`) carries the resolved properties. The map and the roster read
  `member.icon`, and later phases read `member.loadout`. Neither looks inside the role for them.

The existing icon assignments are unchanged:

- squad leader → star;
- fire team leader → chevrons;
- automatic rifleman → two dashes;
- assistant automatic rifleman → **rifleman**: he carries a rifle (para 1004a) and there is no
  assistant automatic rifleman icon;
- rifleman → rifleman.

The fire team leader is also the team's grenadier (para 1003); the leader icon is shown. These
choices are recorded in the template's `conventions` as Ambush! conventions. The simulation is
not involved: soldiers there still carry only their unit.

### Organization template schema version 2, and converting version 1

- Version 2 shapes:
  - role: `id`, `name`, `abbreviation`, optional `grade`, `defaultLoadout`, `defaultIcon`;
  - slot: optional `loadout` and `icon`;
  - unit `symbology`: `{ "sidc": … }`, unchanged.
- Validation:
  - only listed icon ids are accepted;
  - unknown fields are refused, including a role's old `symbology` or `weaponProfileRefs`.
- The USMC rifle squad template is now version **2.0.0**.
- **Version 1 templates are converted automatically** by `readOrganizationTemplate`, which
  calls `migrateOrganizationTemplate` and then validates the result:
  - a role's `weaponProfileRefs` become its `defaultLoadout`;
  - a role's APP-6 `symbology` code is dropped. Version 1 gave every role the same individual
    code, so it names no role icon. The converted role therefore has no `defaultIcon`, and its
    holders are drawn as unknown roles until a maintainer adds one. **Nothing is guessed.**
  - Units, slots, source, conventions and the template's own `version` are kept;
  - the result carries `migratedFrom: 1` and a note for every change, for whoever maintains
    the template.

  The converted original 1.0.0 USMC template (kept as a test fixture) instantiates and runs like
  any other.

- `validateOrganizationTemplate` stays strict and reads only version 2. Its error message points
  to `readOrganizationTemplate`.
- The scenario fingerprint changes with the template content, as ADR 0012 §11 describes. No
  persisted data exists.

### Symbol preview (`symbols.html`)

`/symbols.html` (with `npm run dev`) is a **permanent development tool**. It is typechecked and
linted with the app, but it is not part of the production build. It shows:

- every role in every affiliation, as SVG;
- the 16, 24 and 32 px sizes, SVG beside canvas;
- a sweep of facings;
- the icons over the map's colours;
- **live tactical maps** of the demo exercise drawn by the production map widget itself
  (`createTacticalMap`, `buildScene`, `symbolLayout`, `drawMap`):
  - the ORP at the fitted and close scales;
  - the OPFOR patrol;
  - a Marine moved next to the patrol, showing mixed-affiliation decluttering.

The page only calls the code the app uses, so it cannot drift from production rendering.

## Consequences

- Roles can be told apart on the map without reading labels. Crowds of any affiliation
  declutter, and every Marine in a crowd stays selectable from the map.
- Icons are no longer standard symbology. Anyone expecting APP-6 individual symbols should be
  told they are an Ambush! convention. The preview page and this ADR say so.
- milsymbol is still needed, for unit symbols only.
- Grenadier, marksman, medic and radio operator are not used by the current template. They are
  available to future templates, per role or per slot, without code changes.
- OPFOR shows no role until scenarios give OPFOR an organization: a template plus icons.
- A converted version 1 template draws its soldiers without role glyphs until icons are added.
