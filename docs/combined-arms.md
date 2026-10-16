# Combined arms

Infantry and armoured vehicles fight in one battle, through one combat
framework: the force-on-force system (`src/sim/fof`,
[docs/behavior-lab/force-on-force](behavior-lab/force-on-force/03-model.md)),
extended with vehicle platforms. There is no second combat engine: vehicles are
seen, tracked, chosen as targets and shot at by the same decision, with the same
random numbers, in the same simultaneous volley as soldiers.

This document is the architecture and the reference. The sections follow the
work: what was there and what is reused (§1), the data (§2–§4), the decisions
(§5–§7), damage (§8–§9), mobility (§10), the views (§11), determinism and the
review (§12), scenarios (§13), testing (§14), adding a vehicle (§15) and the
limits (§16).

## 1. What was there, and what is reused

| Existing system                                                  | Where                                                            | Use for combined arms                                                                                                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed-tick simulation, commands, events, snapshots, state hashes | `src/sim/step.ts`, `commands.ts`, `hash.ts`                      | Unchanged. Vehicle combat state is plain data in `SimState.vehicles`, so it is hashed, snapshotted and replayed with the rest.                                                                      |
| Seeded random numbers                                            | `src/sim/rng.ts`                                                 | Every combat draw for vehicles comes from `SimState.rng`, inside the force-on-force decision, in a fixed order. A battle without vehicles makes no new draws: its results and hashes are unchanged. |
| Force-on-force decision (10 Hz grid)                             | `src/sim/fof/system.ts`                                          | Vehicles take part in `scan` (detection), the force decisions and `resolveFire` (one volley).                                                                                                       |
| Detection model (cycles on target, P∞, thresholds, tracks)       | `fof/detection.ts`, `system.ts`                                  | Shared: a vehicle is a large target (its own critical dimension and signature); a vehicle observer has its own sensors (optics, thermal, eye height). Tracks on vehicles are ordinary `FofTrack`s.  |
| Sight lines (terrain, buildings, vegetation)                     | `sight-tracer.ts`, `fof/detection.ts` (`vegetationTransmission`) | Shared, with vehicle eye and target heights.                                                                                                                                                        |
| Infantry fire (abstract bursts, hit tables, suppression)         | `fof/fire.ts`, `hit-probability.ts`                              | Unchanged for rifles and machine guns at soldiers. Vehicle machine guns at soldiers use the same model (the weapon's infantry table).                                                               |
| Infantry weapons, ammunition, reloads                            | `fof/weapons.ts`, `fof-v2.json`                                  | Anti-tank weapons are soldiers' arms like the M203 (loaded, reserve, reload).                                                                                                                       |
| Squad behaviour (contact, withdrawal, effectiveness)             | `fof/force.ts`, `lifecycle.ts`                                   | Unchanged; vehicles in a squad's picture put it in contact, and their fire suppresses and strikes down its soldiers like any other.                                                                 |
| Vehicle movement                                                 | `src/sim/vehicles.ts`                                            | Extended: platform mobility (tracked, wheeled), a route feasible for the hull, mobility damage, halting to fire.                                                                                    |
| Motion log, worker frames                                        | `exercise/motion-log.ts`, `app/battle/frame-log.ts`              | Extended with each vehicle's mount angles and damage, per tick.                                                                                                                                     |
| 3D M113                                                          | `src/view3d/vehicles.ts`                                         | Generalized: every platform is built from its visual definition, with articulated mounts.                                                                                                           |

## 2. Platforms

A vehicle is a **platform** carrying **mounts** carrying **weapons**. Nothing in
the combat code knows a vehicle by name: everything it needs is in the platform
definition (`PlatformSpec`, `src/sim/combat/types.ts`):

- identity: `id` (stable, e.g. `t72b`), `name`, the representative `variant`;
- `targetClass`: `infantry` (never a platform), `unarmored`, `lightArmor`, `heavyArmor`;
- `dimensions` (m) and `mobility` (tracked or wheeled, speeds, acceleration, turning, climbing);
- `armor`: RHA-equivalent protection (mm) per zone (front, side, rear, top), against kinetic (`ke`) and chemical-energy (`ce`) attack;
- `crew`: stations (driver, gunner, commander, loader);
- `sensors`: optics, thermal sights, eye height, field of regard;
- `mounts`: a hierarchy (turret → gun mantlet; cupola; pintle; launcher on a turret);
- `weapons`: each on a mount, with its ammunition (ready and stowed);
- `vulnerability`: how likely a perforation is to destroy it outright (ammunition stowage);
- `visual`: procedural model parameters (§11).

The side is not part of a platform: a scenario places a `t72b` for BLUEFOR as
readily as for OPFOR.

## 3. Mounts

A mount turns (traverse) and lifts (elevation) the weapons on it:

- `parent`: another mount (a launcher on a turret turns with it) or the hull;
- `traverse`: limits left and right of its parent's forward (`null`: all round), and a rate;
- `elevation`: limits and a rate;
- `stabilized`: whether its weapons may fire accurately on the move;
- `operator` (and an `alternate`): the crew role that lays and fires it.

Its orientation is state: `azimuth` (relative to its parent) and `elevation`,
moved each tick toward the orientation its target needs, never faster than its
rates and never beyond its limits (`src/sim/combat/mounts.ts`). Weapons on one
mount share its orientation: the Abrams' coaxial machine gun points where the
gun does.

## 4. Weapons and ammunition

`CombatWeaponSpec` (`src/sim/combat/types.ts`) holds every weapon that can harm
a vehicle or be carried by one: vehicle cannons, autocannons, machine guns, and
infantry anti-tank weapons. A weapon has its ammunition (`AmmoSpec`): its
penetration (by range, kinetic or chemical), top attack, its effect behind the
armour, and its effect on soldiers (direct, or an area blast). Rates of fire,
ready capacity, reloads and ranges are the weapon's; guided weapons have a
flight speed and whether the launcher must be still.

Soldiers' anti-tank weapons are also arms in the infantry model (`fof-v2.json`:
capacity, basic load, reload), carried by particular soldiers (§9).

## 5. Target classification and detection

Every combatant is a target of a class: a soldier is `infantry`; a vehicle, its
platform's class. Detection is the force-on-force model's: a squad's soldiers
look at vehicles as at soldiers (a vehicle is larger, louder and, firing, far
more conspicuous), and a vehicle's crew look through its sensors at soldiers and
vehicles. What they find goes into tracks: a squad's picture, or the vehicle's
own. No one engages what it has not detected.

## 6. Target and weapon selection

For a shooter (a vehicle mount, or a soldier with an anti-tank weapon), each
candidate pair (target, weapon) is valued (`src/sim/combat/targeting.ts`):

- **effect**: the chance that one engagement of the weapon, with its best
  ammunition, harms the target meaningfully: hit chance at the range × chance to
  defeat the armour on the face it presents (or, at soldiers, to strike one down);
- **threat**: what the target can do to the shooter (the same effect, its
  weapons at the shooter), more when it is close or firing;
- **value**: by class;
- **cost**: the ammunition (a main-gun round is costlier than a burst).

A weapon is **ineffective** when its effect is below `minimumEffect`, **suitable**
otherwise, and the **preferred** one is the suitable one of the highest utility
(effect × (threat + value) / cost). A shooter **commits** to its target: it
reassesses every few seconds, and switches only to a markedly better one, or
when the target is gone, out of sight or no longer worth it.

## 7. Engagement

A mount slews to its target; its weapon fires when laid (within a tolerance),
loaded, ready, with its operator able, the target in sight and in range, and,
unstabilized, the vehicle still. A guided missile flies for its range over its
speed; the launcher (and, for wire-guided missiles, the vehicle) waits. Each shot
is one event (`vehicleFire`) with its hit chance and outcome, resolved in the
same volley as soldiers' bursts.

## 8. Armour and damage

A hit strikes a zone: front, side or rear by the attacker's bearing from the
target's hull; top for top-attack weapons. Penetration is drawn: the chance is
a logistic of (penetration − protection) over a spread proportional to the
protection. A perforation is resolved behind the armour by the ammunition's
lethality and the platform's vulnerability, in independent draws:

- catastrophic (destroyed: burning, then a wreck);
- mobility (cannot move);
- firepower (one weapon or its mount disabled);
- sensors (detection and aiming degraded);
- crew (each member struck down, or only shaken).

Hits that do not perforate may still damage sights or running gear (autocannon,
HE). The states are not exclusive, persist, and are never repaired. A vehicle is
**mission killed** when it can neither fight nor move, or its crew is gone.

## 9. Crew

Crew members are operational, degraded or incapacitated. The driver drives; the
gunner lays and fires the turret's weapons; the commander observes (sensors)
and may take over the gun; the loader loads the main gun (without one, an
autoloader). A weapon whose operator and alternate are both incapacitated is
silent; a degraded or alternate operator is slower and less accurate.

## 10. Mobility

Vehicles drive their routes as before (`src/sim/vehicles.ts`), with the
platform's mobility: tracked vehicles pivot on the spot; wheeled vehicles turn
with a radius, faster on roads and slower in woods. A route must be feasible for
the hull: every leg clear of buildings and water by half the vehicle's width;
otherwise a route is searched on the navigation grid widened by the vehicle's
size (footbridges too narrow are then closed to it). A mobility kill stops it
where it is and its orders fail. A vehicle halts to fire a weapon that needs it
still (an anti-tank missile), and drives on after.

## 11. Views

3D: every platform is built procedurally from its visual definition (hull
profile, running gear, turret shape, gun, fittings), with a node per mount; the
mount angles and the damage come from the motion log, so the model is posed the
same live and in the review. Firing, missiles, impacts, smoke, fire and wrecks
are effects of the events. 2D: the APP-6 symbol of its class (armour, mechanized
infantry), a hull heading tick, a turret line, the fire, and damage marks.

## 12. Determinism and the review

All combat state is in `SimState.vehicles` and `SimState.fof`; all draws come
from `SimState.rng` in a fixed order; nothing in the views decides anything. The
review re-simulates the battle from its commands and checks every second's state
hash; the motion log carries mount angles and damage per tick.

## 13. Scenarios

A scenario's vehicles have a `kind` (a platform id) and a side; the four are
placed in Setup like the M113 before. Files from before keep loading (`m113`).

## 14. Testing

See `src/sim/combat/*.test.ts`, `src/exercise/battle/combined-arms.test.ts` and
the browser checks in §17 of the report.

## 15. Adding a vehicle

See §15 of this document's end: a new `PlatformSpec` (and any new weapons and
ammunition) in the catalog, and nothing else.

## 16. Known limitations

Recorded at the end of the implementation.
