# ADR 0018: The selected Marine's weapon engagement wedge

- Status: Accepted
- Date: 2026-10-09
- Builds on ADR 0012 (organization and loadouts), ADR 0013 (individual soldier icons) and ADR 0017
  (map rendering: cached geographic map, tactical overlays drawn per frame).

## Context

When planning an ambush, the trainee needs to see how far, and in which direction, a Marine could
engage with his weapon. Weapons are not modelled yet. Organization templates name each role's
weapons by weapon profile reference (`Loadout.weaponProfileRefs`). The MCWP 3-11.2 squad has
`m16-rifle`, `m203-grenade-launcher`, `squad-automatic-weapon`, `bayonet-knife` and
`combat-knife`. Nothing defines a weapon's range, and there is no combat, so no range limit
exists anywhere.

## Decision

**Display ranges** (`exercise/weapon-display.ts`): a table of nominal effective ranges, keyed by
the existing weapon profile references and used only for display:

| Reference                | Weapon                | Range (point target) |
| ------------------------ | --------------------- | -------------------- |
| `m16-rifle`              | M16A2 rifle           | 550 m                |
| `squad-automatic-weapon` | M249 SAW              | 600 m                |
| `m203-grenade-launcher`  | M203 grenade launcher | 150 m                |

These are the nominal point-target ranges of the 1991 squad's weapons. Area-target ranges (M16A2
800 m, M249 800 m on its bipod, M203 350 m) are not shown. Knives have no range. The M4, M27 and
M320 are not in any template and are not listed. The simulation never reads the table. When
weapons are modelled, the weapon model should replace it rather than sit beside it.

**The wedge** (`view2d/engagement.ts`) is drawn for the selected trainee Marine only:

- It starts where he stands now and is centred on the way he faces now, both from simulation
  state.
- It is `ENGAGEMENT_WEDGE_WIDTH_DEG` (35°) wide, 17.5° either side of the facing. Azimuths keep
  the existing convention (clockwise from grid north, ADR 0002).
- It reaches his first loadout weapon that has a display range. Loadouts list the primary weapon
  first, so a fire team leader's wedge shows his rifle, not his grenade launcher.
- It is built with every scene. It therefore follows selection, movement, turning, panning and
  zooming, as the rest of the scene does.

It is drawn in the tactical overlays (`drawOverlays`), over the map and beneath the ORP, routes,
symbols and facing arrow. It is clipped to the map's edges and not to terrain or line of sight. It
has:

- three translucent BLUEFOR-blue distance bands, lighter outwards;
- thin edges and a thin arc at the range;
- a small label naming the weapon and range.

The bands suggest that effectiveness falls with distance; they are not hit probabilities.

The visibility overlay is unchanged and independent. It shows when it showed before. When both
show, the viewshed is green beneath the contours and features, and the wedge is blue above them.

## Consequences

- The cached geographic map (ADR 0017) does not depend on the wedge. Selecting, deselecting and
  turning only change the tactical layer, which is drawn every frame anyway.
- During planning, the wedge shows the Marine's current facing. The facing arrow shows the planned
  facing, which the wedge takes up once the Marine has turned during execution. The wedge could
  later follow the planned destination and facing instead, as the visibility overlay follows the
  planned destination.
