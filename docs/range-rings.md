# Range rings and the map bar

## 1. Range rings

Each squad's and vehicle's panel (Setup, Planning, Sim and the review) has a
rings button by its name, and one by each of its waypoints (Planning and Sim),
each beside the viewshed's eye. On, three rings are drawn round it (or round
that waypoint), in its side's colour, in 2D and draped on the ground in 3D,
each labelled at its north:

| Ring      | Line   | What it is                                                                                          |
| --------- | ------ | --------------------------------------------------------------------------------------------------- |
| Detection | dotted | The furthest it can see an enemy: open ground, a clear day (the simulation's own)                   |
| Max range | dashed | The furthest any of its weapons fires, as the simulation allows                                     |
| Effective | solid  | Its main weapon's maximum effective range (doctrine's): a squad's rifles, a vehicle's main armament |

Rings of the same range are drawn once, with one label (an Abrams' sights
and its gun: "Detection · Effective 3,000 m"). In Setup and Planning they are
round where it starts; in Sim and the review, round where it is now (a squad
with nobody left, or a destroyed vehicle, has none). A waypoint's are round
the waypoint; they follow it as orders are added, moved or deleted, and in Sim
as they are done (those turned on in Planning carry on into Sim).

| Unit                        | Detection | Effective | Max range                                                |
| --------------------------- | --------- | --------- | -------------------------------------------------------- |
| Squad, fire team or element | 1,200 m   | 550 m     | 800 m (automatic rifle); 2,500 m with a Javelin or 9K111 |
| M1A1 Abrams                 | 3,000 m   | 3,000 m   | 4,000 m (120 mm gun)                                     |
| T-72B                       | 2,400 m   | 2,100 m   | 4,000 m (125 mm gun)                                     |
| BMP-2                       | 1,920 m   | 1,500 m   | 4,000 m (9M113 Konkurs)                                  |
| M113                        | 1,200 m   | 1,500 m   | 1,800 m (M2HB)                                           |

Detection is the force-on-force model's furthest observation (1,200 m, open
ground, a clear day), a vehicle's × its sights' optics factor, at most
3,000 m (combined-arms.md). The furthest it fires is the simulation's
furthest engagement range of the weapons it carries (a squad's anti-tank
weapons included). The effective ranges are the manuals' (FM 3-22.9 for the
rifle, FM 3-20.12 for tank gunnery, open sources for the Soviet weapons):
nothing in the simulation uses them; they are there to plan with.

Code: `src/exercise/battle/range-rings.ts` (`squadRangeRings`,
`vehicleRangeRings`), drawn by `drawRangeRings` (`src/app/battle/map-editor.ts`).
Which units have their rings on is the page's, and which waypoints the
planner's (`waypointRings`) and, in a battle, the page's; neither is saved
with the scenario.

## 2. Why these three

The request was maximum detection range, maximum range and maximum effective
range. A rifle's maximum range in the physical sense (about 3.6 km) means
nothing in the game: no one fires that far. So "Max range" is the furthest
the simulation lets it fire, the ring a player plans with; the effective
range is doctrine's, where its fire tells.

## 3. The map bar

Under the map in every stage (Setup, Planning, Sim, the review), each box
right by its words:

- **Range rings**: shows or hides every range ring turned on (turning one on
  shows them again).
- **Viewsheds**: shows or hides every viewshed turned on (the eyes in Setup's
  and Planning's panels); in Sim and the review, those turned on before.
- **Show OPFOR**: OPFOR's squads, soldiers, vehicles, plans and viewsheds,
  in 2D and 3D; hidden, they cannot be picked.
- **Hide waypoints**: hides every waypoint and route, with defences' sectors
  and ambushes' kill zones, in 2D and 3D: only the units (symbols, soldiers,
  3D models) are shown, with the bursts and tracers. Hidden waypoints cannot
  be picked or dragged.
