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

| Existing system                                                  | Where                                                            | Use for combined arms                                                                                                                                                                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed-tick simulation, commands, events, snapshots, state hashes | `src/sim/step.ts`, `commands.ts`, `hash.ts`                      | Unchanged. Vehicle combat state is plain data in `SimState.vehicles`, so it is hashed, snapshotted and replayed with the rest.                                                                                      |
| Seeded random numbers                                            | `src/sim/rng.ts`                                                 | Every combat draw for vehicles comes from `SimState.rng`, inside the force-on-force decision, in a fixed order. A battle without vehicles makes no new draws: its results and hashes are unchanged.                 |
| Force-on-force decision (10 Hz grid)                             | `src/sim/fof/system.ts`                                          | Vehicles take part in `scan` (detection), the force decisions and `resolveFire` (one volley).                                                                                                                       |
| Detection model (cycles on target, P∞, thresholds, tracks)       | `fof/detection.ts`, `system.ts`                                  | Shared: a vehicle is a large target (its own critical dimension and signature); a vehicle observer has its own sensors (optics, thermal, eye height). Tracks on vehicles are ordinary `FofTrack`s.                  |
| Sight lines (terrain, buildings, vegetation)                     | `sight-tracer.ts`, `fof/detection.ts` (`vegetationTransmission`) | Shared, with vehicle eye and target heights.                                                                                                                                                                        |
| Infantry fire (abstract bursts, hit tables, suppression)         | `fof/fire.ts`, `hit-probability.ts`                              | Unchanged for rifles and machine guns at soldiers. Vehicle machine guns at soldiers use the same model (the weapon's infantry table).                                                                               |
| Infantry weapons, ammunition, reloads                            | `fof/weapons.ts`, `fof-v2.json`                                  | Unchanged. Anti-tank weapons are combat weapons (`src/sim/combat/catalog.ts`) carried by particular soldiers (`FofForceSetup.antiTank`), their rounds in `SimState.combat.antiTank` (loaded, reserve, reload, aim). |
| Squad behaviour (contact, withdrawal, effectiveness)             | `fof/force.ts`, `lifecycle.ts`                                   | Unchanged; vehicles in a squad's picture put it in contact, and their fire suppresses and strikes down its soldiers like any other.                                                                                 |
| Vehicle movement                                                 | `src/sim/vehicles.ts`                                            | Extended: platform mobility (tracked, wheeled), a route feasible for the hull, mobility damage, halting to fire.                                                                                                    |
| Motion log, worker frames                                        | `exercise/motion-log.ts`, `app/battle/frame-log.ts`              | Extended with each vehicle's mount angles and damage, per tick.                                                                                                                                                     |
| 3D M113                                                          | `src/view3d/vehicles.ts`                                         | Generalized: every platform is built from its visual definition, with articulated mounts.                                                                                                                           |

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

Soldiers' anti-tank weapons are combat weapons too (`at4`, `rpg7`, `javelin`,
`9k111`), with the rounds a soldier and his team carry (`carriedRounds`). A
squad's loadout (`SquadSpec.antiTank`): `none`; `rockets` (each fire team's
rifleman an AT4 or an RPG-7, by side); `rocketsAndMissile` (and the first
team's assistant automatic rifleman a Javelin or a 9K111). By default a squad
carries rockets; they are carried only in a battle with vehicles.

## 5. Target classification and detection

Every combatant is a target of a class: a soldier is `infantry`; a vehicle, its
platform's class. Detection is the force-on-force model's (`src/sim/combat/system.ts`,
`scanCombat`, after the soldiers' `scan` in each decision):

- **soldiers look at enemy vehicles** on their own look schedule: a vehicle's
  critical dimension is √(height × width), three sample heights (85, 55, 20 %
  of its height) for the sight line, more conspicuous moving (× 1.6, and heard
  all round within 350 m) and firing (the firing signature). What a soldier
  finds goes into his **squad's tracks** (`FofTrack`, its target a vehicle's
  id), so a squad in sight of armour is in contact as with soldiers;
- **vehicle crews look at enemy soldiers and vehicles** through their sensors:
  optics multiply the cycles on target and the observation range (up to
  3 km), thermal sights see through more vegetation; the commander (else the
  gunner, slower) observes, and damaged sights see less. Concealed ambushers
  and dug-in soldiers are as hard to see as in the infantry model. What a
  crew finds goes into its **vehicle's tracks** (`VehicleCombat.tracks`).

Search is faster the more plainly a target stands out (`conspicuity`): its
resolvable cycles over 2 (at most × 10), so a tank in the open at a few
hundred metres is found in a look or two, and a glimpse that plain adds more
confidence (up to × 2.5: it is confirmed at once), while a target barely
detectable (a prone soldier far off, a tank at 2 km in haze) is searched for
as before. Infantry looking at infantry is the force-on-force model's own,
unchanged.

Each pair's detectability threshold is drawn from `SimState.rng` at the
first decision, in a fixed order (`drawThresholds`: each vehicle's crew at
enemy soldiers, then at enemy vehicles; then each soldier at enemy
vehicles), as the soldiers' are (`SimState.combat.thresholds`). No one
engages what it has not detected; a crew keeps following a confirmed target
while it stays in sight (tracking, `COMBAT_TUNING.trackingSeconds`; checked
once it was last seen half a second ago, inside the 1.5 s it stays in sight
for), and a target that fires on it is detected at once (the flash, the
impact).

**Cost.** Sight lines are most of a battle's time; three things leave out the
ones that cannot change anything:

- a pair that could not detect its target in full view (its P∞ wholly in
  view below its threshold) is not traced (`beyondDetection`): most far
  targets of a crew searching out to 3 km;
- a pair's answer is reused while the eye, the target's place and heights
  and the sights are the same (`exposureFrom`, as the soldiers' `sight-cache`):
  exactly what tracing again gives;
- tracking checks each target every half-second, not every decision.

On the Quantico combined-arms demo (300 soldiers, 19 vehicles) the heaviest
fighting cost 26 ms a tick before, about 8 ms after.

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
when the target is gone, out of sight or no longer worth it. It keeps its weapon on
the same target likewise (the Abrams does not turn to its main gun while its
coaxial gun reloads). A vehicle seen knocked out (still and silent, unable to
move or fight) is no longer engaged.

## 7. Engagement

Each mount (a turret, a cupola; a launcher fixed on a turret is laid with
it) chooses its engagement among the weapons it lays, slews toward its
target every tick (`updateVehicles` → `slewMounts`), and fires (in the volley,
`fireCombat`) when its weapon is laid within a tolerance, loaded (ready
rounds of the chosen ammunition), ready (its cycle, or a reload from stowage
done, slower without a loader), aimed long enough (`aimSeconds`), the target
in sight now and in range, and, for a weapon fired from a halt (a missile),
the vehicle stopped (it halts to fire, and drives on after). Changing
ammunition costs a loading cycle. A guided missile flies for its range over
its speed (`SimState.combat.missiles`); a wire-guided one keeps its vehicle
halted and needs the gunner alive and the target in sight when it arrives.
A main gun's round flies too, for its range over its muzzle velocity
(`AmmoSpec.velocityMps`: M829A1 1,575 m/s, M830 1,140 m/s, 3BM42 1,700 m/s,
3OF26 850 m/s; about 1.3 s at 2 km for a sabot round) in
`SimState.combat.shells`: whether it hits a vehicle, or where a blast lands,
is drawn when it is fired; what it does (a hit resolved against the armour,
a blast striking and suppressing the soldiers round where it lands, the
target's crew or force cued) when it arrives, at the first decision after
(`arriveShells`, after the missiles'). A target destroyed meanwhile is not
struck again. Machine guns' and autocannon's bursts fly likewise (12.7 mm
890 m/s, 7.62 mm 840 m/s, 30 mm 960–970 m/s): a burst at a soldier strikes
him down (if drawn) and suppresses round him when it arrives, as the
soldiers' own bursts do (force-on-force 06 §3). Anti-tank rockets fly
likewise: an AT4's at 285 m/s, an RPG-7's PG-7VL at 250 (launched at about
112 m/s, its motor takes it to about 295), striking when they arrive (about
1.1–1.2 s at 300 m).
Anti-tank gunners choose among the vehicles their squad has confirmed, aim
(an AT4 5 s, a Javelin's lock-on 12 s), fire when their squad is fighting
and they see the target, and reload from what they carry.

Each shot is one event (`vehicleFire`, with its muzzle, aim point, impact and
hit chance); hits on vehicles are resolved together after the whole volley
(`vehicleHit`), so fire within a decision is simultaneous. Machine-gun bursts
and high explosive at soldiers use the infantry model's hit tables, blasts,
cover and suppression, and their casualties fall with the volley's.

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

Crew members are operational, degraded or incapacitated. The driver drives
(degraded: 70 % speed; out: the vehicle stops). The gunner lays and fires
the turret's weapons; the commander observes and may take over the gun
(`alternate`: slower, less accurate); the loader serves the main gun (without
one, `reloadWithoutFactor` slower; the T-72's autoloader needs none). A mount
whose operator and alternate are both out is still and silent; a crew all
out is a mission kill.

## 10. Mobility

Vehicles drive their routes as before (`src/sim/vehicles.ts`), with their
platform's mobility (`vehicleTypeOf`): road, off-road and woods speeds,
acceleration and braking, turning by speed and lateral grip, climbing losses.
They steer straight for each point of their route and stop on their
waypoint: never faster than lets them turn onto the point ahead (the arc
through it, tangent to their heading, must be one they can drive), so they
slow for bends and never circle a point inside their turning circle; a
tracked vehicle facing well away from its point brakes and pivots on the spot.
Wheeled vehicles cannot pivot, and turn no tighter than their radius. A
route's kinks (a road's little jog, a junction's corner: a sharp turn on a
leg under 12 m) are cut straight across where the hull fits.

A route must be clear for the hull (`hullClear`): every leg, and both its
sides at half the vehicle's width, clear of buildings and water; when the
planned route is too narrow somewhere, the roads are tried; when neither is,
the order fails ("no way there wide enough for the vehicle"). An
immobilized, destroyed or driverless vehicle stops where it is and its orders
fail (`immobilized`, `destroyed`). Vehicles do not swim or ford.

A vehicle at rest (arrived, or without orders) turns its front, its strongest
armour, toward the enemy: the nearest vehicle its crew has confirmed, else the
nearest soldier. On the move its front is where it drives.

## 11. Views

**3D** (`src/view3d/vehicle-models.ts`, `vehicles.ts`): every platform is built
procedurally from its visual definition (hull profile, running gear, turret
shape, gun, fittings) with a node per mount (turn, then lift) at the mount's
pivot, the parent's node holding the child's (the Abrams' cupola turns with
its turret). Geometry is shared by every vehicle of a platform. The mount
angles, condition, immobilization and fire come from the motion log's
articulation (per tick, interpolated), so a vehicle is posed the same live and
in the review. Destroyed, it is charred, and a catastrophic kill of a
vulnerable tank may throw its turret. Effects (`heavy-effects.ts`): muzzle
flashes and blast smoke, rockets' and missiles' smoke trails, impacts
(dust, flashes, sparks off armour), burning wrecks (flames, a column of
smoke) and smouldering ones: all a function of the combat log, the clock and
the articulation, in two pools of points (no objects per effect).

**Tracers** (`tracers.ts`): a vehicle's machine guns and autocannon fire the
soldiers' tracers, a glowing streak 11 m long, red for BLUEFOR and green for
OPFOR. Every round flies at its speed in the battle's time, as the battle has
it, from firing until it arrives (§7): at 1× a burst at 300 m is seen for a
third of a second; faster, for as much less. As many are in the air whatever
the speed: at 32× the battle fires 32 times as many bursts a second, so one
burst in 32 is drawn (`tracerShown`: a hash of the burst under 1/speed;
every one up to 1×). A gun's impact (dust, sparks off armour) comes when its
rounds arrive. The review draws the same tracers at the same moments,
seeking or not. (A recording from before rounds had a time of flight flies
its tracers at 640 m/s on screen, whatever the speed, as they used to.)

**Main guns' rounds, rockets and missiles** are the streak, red or green,
with a glowing head four times the size (20 px, not 5); rockets' and
missiles' smoke trails are the effects'. They fly at their own speed in the
battle's time, as the simulation has them: a main gun's round and a missile
from firing until they arrive (§7: a sabot round at 2 km about 1.3 s; a
missile, its range over its flight speed, 9M113 208 m/s, 9K111 186 m/s,
Javelin 170 m/s, about 10 s at 2 km), a rocket at 260 m/s. At 1× each is seen
in flight as long as it would be; faster, it keeps up with the battle, and
its impact (dust, sparks off armour) comes when it lands, as its hit does.
Every one is drawn, whatever the speed. The 2D map draws them as a dot
along a dashed line until they arrive.

**2D** (`src/app/battle/map-editor.ts`, `combat-editor.ts`): the APP-6 symbol
of its role (armour: the oval of tracks; mechanized infantry: the cross over
it), its condition (damaged: an orange mark; a mission kill struck through;
destroyed: crossed out and greyed); zoomed in, its hull to scale turned to its
heading with its gun's bearing; heavy fire as lines from muzzle to impact,
missiles in flight, hits as bursts. Both views read the same log: switching
views changes nothing.

The event log describes guns, rockets and missiles fired, missiles' outcomes,
hits (face, penetration against protection, perforated or not, the damage)
and condition changes; the selected vehicle's panel shows its diagnostics
(`vehicleDiagnosticsHtml`).

## 12. Determinism and the review

All combat state is plain data in `SimState` (`vehicles[i].combat`,
`combat`, the squads' `fof.tracks`), so it is hashed, snapshotted and replayed
with the rest; all draws come from `SimState.rng` in a fixed order (soldiers'
scan, `scanCombat`, the soldiers' bursts, then `fireCombat`: missiles
arriving, main guns' rounds arriving, vehicles in order, anti-tank gunners in order, the hits); nothing
in the views decides anything. The review re-simulates the battle from its
commands and checks every second's state hash. A battle without vehicles or
anti-tank weapons makes no new draws and has no new state: it runs and hashes
exactly as before. Recordings of battles with vehicles made before combined
arms re-simulate under the new rules (the M113 now fights), so their hashes
differ; so do those made before the thresholds were drawn at the start
(§5).

## 13. Scenarios

A scenario's vehicles (`PlannedVehicle.kind`) are platforms of the catalog,
placed in Setup and saved with the scenario: BLUEFOR places M113s and
Abrams, OPFOR BMP-2s and T-72s (`SIDE_VEHICLE_KINDS`; a file may give either
side any platform). Its squads choose their anti-tank weapons in Setup
("Anti-tank": None, AT4 or AT4 + Javelin for BLUEFOR; None, RPG-7 or
RPG-7 + 9K111 for OPFOR); by default rockets (AT4, RPG-7), carried only in a
battle with vehicles. One unit of either side, a squad or a vehicle, is
enough to play a scenario. Both fields are optional and validated when a file loads: files
from before load unchanged (an M113 stays an M113; a squad without a loadout
carries the default). An unknown platform is refused with its name.

## 14. Testing

- `src/sim/combat/combat.test.ts`: the catalog valid and faction-free, invalid
  platforms refused, a scenario's own platform beside the catalog's;
  penetration by range, faces by bearing, perforation chances, a hit's damage
  reproducible from its seed and persistent, mission kills; mounts' rates,
  limits, crew, parent hierarchy, elevation limits; suitability by effect (a
  machine gun ineffective against a tank, an RPG-7 against an Abrams' front
  but not its rear, a Javelin by the roof, the coax preferred at soldiers),
  commitment to targets.
- `src/exercise/battle/combined-arms.test.ts`: Abrams against T-72 (main guns,
  armour-piercing, a kill), Abrams against infantry (machine guns only,
  soldiers fall), rifles never at vehicles and an M113's .50 never at a T-72,
  M113 against BMP-2, anti-tank infantry, default loadouts, immobilization,
  a mixed battle run twice to identical hashes and events, snapshot and
  resume, and a fifth (wheeled) vehicle fighting from its definition alone.
- `src/exercise/battle/combined-arms-scenario.test.ts`: the four vehicles for
  both sides saved and loaded, loadouts saved, unknown values refused; the
  motion log's articulation equal to the state's; each range scenario fights,
  never with rifles at vehicles, and runs the same twice.
- **The range** (`#combined-arms`, `src/app/range/range.ts`): the six
  scenarios of `src/exercise/battle/range-scenarios.ts` (Abrams vs T-72,
  Abrams vs infantry, M113 vs BMP-2, anti-tank infantry vs armour, mixed
  forces, several vehicles) played by the real simulation on open ground, in
  3D (the game's layers) or on the map (the game's symbols), with each
  vehicle's targets, weapons, ammunition, readiness, mount bearings, crew and
  damage, the anti-tank gunners, and the events. Moving back in time runs the
  battle again from its start and checks each second's hash against the first
  run.

Performance (this machine, Node, 30 Hz): the range scenarios take 0.01–0.07
ms of simulation per tick; 208 soldiers and 16 vehicles fighting, 0.5 ms per
tick, against a 33 ms tick.

## 15. Adding a vehicle

A fifth vehicle needs data only, no change to the combat code:

1. Its weapons and ammunition, if new: `CombatWeaponSpec` and `AmmoSpec`
   entries (penetration by range, energy, lethality, effect on soldiers, hit
   table, rates, ranges, cost) in `COMBAT_WEAPONS`.
2. Its `PlatformSpec` in `VEHICLE_PLATFORMS` (`src/sim/combat/catalog.ts`):
   id, class, dimensions, mobility (tracked or wheeled), armour by face and
   energy, crew, sensors, mounts (pivots, parents, limits, rates, operators),
   weapons on them with their loads, catastrophic vulnerability, and its
   visual definition (`hull` and `turret` may be `box` for a plain model, or a
   builder added in `vehicle-models.ts`).
3. Optionally a short name in `exercise/battle/vehicles.ts`
   (`vehicleShortName`); the Setup tools list every catalog platform.

A scenario may also carry platforms and weapons of its own
(`Scenario.platforms`, `Scenario.combatWeapons`), validated when it loads;
`combined-arms.test.ts` fights a wheeled BTR-80 defined only in its test.

## 16. Assumptions and limitations

- **Values** are representative approximations from open sources, rounded:
  protection is one RHA-equivalent figure per face and energy (turret and
  hull averaged, angled), penetration nominal by range; hit tables are for a
  stationary, vehicle-sized target. Explosive reactive armour, depleted
  uranium, the T-72B's Kontakt-1 and the Abrams' later packages are not
  modelled.
- **Ballistics** are abstract: a shot hits or misses by its probability,
  drawn when fired; a main gun's round flies at its muzzle velocity (no
  drag), as do machine guns', autocannon's, soldiers' and anti-tank rockets'
  (each at one mean speed), and grenades on their low arc; there is no
  superelevation or lead, no ricochet; a miss lands just beyond its target
  for the views.
- **Faces** are front, side, rear (by the attacker's bearing from the hull,
  ±45°, scattered ±15°) and top (top attack only); turret and hull are not
  distinguished, nor hull-down positions beyond what the sight line hides.
- **Damage** behind the armour is drawn independently (catastrophic,
  mobility, firepower, sights, each crew member) from the round's lethality
  and the residual penetration; nothing is repaired; crews never bail out or
  surrender.
- **Detection** of vehicles uses the soldiers' model with a vehicle's size
  and signature; vehicles do not block sight lines or fire, and soldiers do
  not take cover behind them.
- **Behaviour**: vehicles keep to their orders and fight on the move; they do
  not seek cover, reverse, withdraw or pop smoke on their own; they halt only
  to fire missiles. Infantry rifles and machine guns never engage vehicles
  (no unarmoured platform is in the catalog: `unarmored` targets would need
  the infantry model to fire at vehicles). Infantry does not mount or
  dismount the carriers.
- **Mobility**: vehicles do not swim or ford, do not collide with each other
  or with soldiers, and plan routes on the soldiers' navigation grid checked
  for the hull's width (with the roads as the fallback), not on a grid for
  each vehicle size.
- **Views**: models are procedural approximations; the 3D vehicle effects are
  points, not volumetric smoke; smoke does not block sight lines.
