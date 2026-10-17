# Vehicles

A battle can have vehicles of either side: the M113 armoured personnel
carrier, the M1A1 Abrams, the BMP-2 and the T-72B. A vehicle is placed in
Scenario Setup with a route of waypoints. It drives the route as its
platform does, and takes new Move orders in combat. Since combined arms
([combined-arms.md](combined-arms.md)) vehicles have crews, weapons and
armour: they see and are seen, fight soldiers and other vehicles, and are
damaged and destroyed; that document is the reference for all of it. This
one covers placing and driving them. Nothing is blocked by a vehicle. Its
motion, mount angles and damage are recorded with the soldiers', so the
After-Action Review replays it.

## 1. Placing a vehicle and giving it a route

**Scenario Setup:**

1. Press **M113**, **Abrams**, **BMP-2** or **T-72** in the BLUEFOR or OPFOR row
   under **Place vehicles**.
2. Click the map. The vehicle is placed there, facing north (OPFOR's: south),
   and the Select tool is back: drag the vehicle to move it, its knob to turn it.

**Planning:** select the vehicle, pick **Move**, and click the map. Each click
adds a waypoint to its route, after the selected one, or at the end. Each
waypoint's road button (**Prefer roads**) takes the vehicle there by the roads
when they help.

With a vehicle selected:

| Action                       | What it does         |
| ---------------------------- | -------------------- |
| Drag it (Setup only)         | Moves it             |
| Drag its knob (Select tool)  | Turns it             |
| Drag a waypoint (Planning)   | Moves the waypoint   |
| Right-click a waypoint, or ✕ | Deletes the waypoint |

The panel has its name, facing, start and route, with **Clear route** and
**Delete vehicle**. The roster lists vehicles under **Vehicles**.

A vehicle placed in water or a building is moved to the nearest clear ground. A
waypoint there is moved out of it, as a squad's destination is. A waypoint the
vehicle cannot reach (planned as a soldier's route would be) blocks the
scenario.

In Planning, either side's vehicle can be routed, but not moved from where it
starts.

**Sim:**

1. Select the vehicle (on the map or in the roster).
2. Pick **Move** and click the map.

**Replace plan** drops its route for the new destination. **Append** adds the
destination after the route. Shift-click swaps the two for one click. **Hold**
stops it. Other order kinds are refused: a vehicle only takes Move orders.

The scenario file stores vehicles as
`vehicles: [{ id, name, side, kind: "m113", position, facingDeg, route }]`. A
scenario without vehicles has no `vehicles` key, so files saved before vehicles
are unchanged.

## 2. How it drives

Each order's route is planned like a soldier's, then fitted to the hull
(Routes, below). It goes round buildings and water, and through woods. With
Prefer roads, by the roads when they help. The vehicle steers along the
route (`src/sim/vehicles.ts`):

- **Pivoting.** Nearly stopped and facing more than 50° away from where it must
  go, it turns on the spot at 35°/s.
- **Steering.** Otherwise it turns toward the way on. Its turn rate is limited
  to 2.5 m/s² of sideways acceleration, and to 40°/s.
- **Speed.** It speeds up to the speed the ground allows under it, and slows
  uphill. Accelerating is 1.2 m/s²; braking is 2.5 m/s².
- **Bends.** It brakes in time for every bend ahead within its braking
  distance, not only the next: a hairpin just beyond a gentle turn is
  braked for before the gentle one. A bend of 60° or more is taken at 3 m/s
  (11 km/h); gentler ones faster. (Braking only for the next, an Abrams
  reached a hairpin 13 m beyond a gentle turn at 17 m/s and ran wide into
  the river.)
- **Waypoints.** It drives through a waypoint that has another after it,
  slowing only for the bend. It brakes in time to stop on its last waypoint.

Speeds by ground:

| Ground                      | Top speed                     |
| --------------------------- | ----------------------------- |
| Paved road (major or paved) | 14 m/s (50 km/h)              |
| Unpaved road, track or path | 10.2 m/s (37 km/h)            |
| Open ground                 | 8.5 m/s (31 km/h)             |
| Woodland                    | 2.8 m/s (10 km/h)             |
| Uphill (grade g)            | × (1 − 2.5 g), at least × 0.3 |
| Downhill (grade g)          | × (1 − g), at least × 0.6     |

The ground is classified in 6 m cells, remembered per terrain. Grades are
measured 5 m ahead.

The vehicle is part of the simulation state (`SimState.vehicles`, absent when
there are none, so states without vehicles hash as before), and moves after the
soldiers each tick. It is deterministic like the rest. The `orderVehicle`
command gives it orders: `replace` or `append`, with a list of destinations.

## 3. In 3D

The M113 is built from simple shapes (`src/view3d/vehicles.ts`):

- a hull with its sloped glacis and trim vane;
- the driver's hatch, and the commander's cupola with its machine gun;
- the rear ramp and the cargo hatch;
- five road wheels per side, a drive sprocket at the front and an idler at the
  rear;
- tracks of about 62 shoes per side.

It is posed from the motion log at the time drawn, between ticks, so it is the
same live and in the review:

- **Suspension.** Each road wheel rides the ground under it, rising up to
  16 cm and dropping up to 12 cm from rest.
- **Hull.** The hull sits on the plane that best fits the ground under the ten
  wheels (pitch and roll). It noses up a little as it accelerates and dips as
  it brakes (0.5° per m/s²).
- **Tracks.** Each track runs round the idler, under the wheels at their
  heights, and round the sprocket. Its shoes move back along that path as far
  as that side has driven. In a turn the outer track runs faster, and pivoting
  runs the two tracks opposite ways. The wheels, sprocket and idler turn with
  their track.

The map draws a vehicle with its APP-6 symbol: a tank the oval of tracks, a
carrier the infantry cross over it (combined-arms.md §11). Its route is a dash-dot line. In
3D the symbol stands above the model on a leader line.

## 4. Limits

- **No passengers.** No crew or infantry mount or dismount. Soldiers keep out of its way and it out of theirs (Soldiers, above); vehicles: Traffic, above.
  Its combat: combined-arms.md §16.
- **Steering.** It steers for a point a little way along its route (its
  speed × 0.7 s, 3–12 m ahead), not for the next turn itself: a road's jogs
  through a junction are driven smoothly, and a turn just missed is passed
  (it is passed once beyond it along the leg to it), not driven back to.
  (Steering for each turn, a T-72 cut inside one 6 m from the last, missed
  it, turned about and pivoted twice: ten seconds stopped in a junction.)
- **Traffic.** A vehicle keeps a 25 m interval (rear to front) behind the
  vehicle ahead in its lane that is moving or under orders, closing up to
  it and then going at its speed; it waits behind one that has stopped on
  its way (pivoting, firing). Two coming head on do not wait; two each with
  the other ahead (crossing at a junction) let the lower id go first. One
  stopped for good in its way (a wreck, one immobilized, one parked) it
  drives round at 4 m/s, 2 m clear, on the side away from it, from the leg
  of its route it is on: of a pass to either side, then wider (off the
  road), the first clear of every stopped vehicle and of buildings and
  water; with none, it stops short. One beyond its destination is not in
  its way. (Without this a column bunched up, and drove through wrecks.)
  Two coming head on along its way (heading more than 120° apart, within
  40 m, or 4 s at their closing speed) each ease to their right, keeping
  1 m between them, and pass (the path shift of Soldiers, below, to the
  right first). Two whose ways cross take the crossing in turn: each works
  out when it and the other would be where the ways cross (straight on as
  they head); the one there first, or already in it, goes on (equal: the
  lower id), and the other, if they would be in it together, stops short
  of it. Whatever else, it brakes to stop 2 m short of another vehicle in
  its way before it could stop. Two stopped nose to side, each in the
  other's way, are untangled: the one to give way (the higher id) drives
  round the other as round a wreck. (Before, head on they drove through
  each other, and crossing they met side on: in 1,000 vehicles over 15
  minutes on Quantico, 1,250 pairs overlapped; now about a tenth as many,
  mostly brushing for a second.)
- **Soldiers.** A vehicle does not drive over soldiers (either side's).
  The strip its hull sweeps along its way, up to 35 m ahead, is kept 1.5 m
  clear of every soldier up: with one in it, its path is shifted sideways
  (1.5 m steps, up to 9 m either way), the shift that clears them nearest
  to where it is (so it holds one while it passes a column on the road,
  and comes back once past), steered through a point 12 m ahead on the
  shifted line, so it eases over smoothly; never across a building or
  water. Near soldiers it goes at most 5 m/s; with no clear path it stops
  short and waits, and soldiers of its side standing in its way (not
  walking with their unit) make way: they step aside, out of its path, at
  1.2 m/s (never into a building or water), as do those it has stopped for
  close in front. (An Abrams waited for good behind a squad halted across a
  street.) And whatever its path, it brakes to stop a metre short
  of a soldier in the ground it would cover before it could stop, where he
  is or where he is walking to within 1.5 s (turning, it sweeps ground off
  its path). The soldiers step aside too (`behavior/system.ts`): one in a
  vehicle's way, or about to be within 1.5 s, steps out of it, away from
  its centreline, at up to 2.5 m/s.
- **Routes.** A route is a soldier's route, widened by 3 m at each corner,
  then fitted to the hull: every leg must keep its centre half its width
  and 0.25 m from buildings and half its width from water
  (`isSegmentClear`). A leg that does not, from the last turn the hull
  fits at to the next, is planned again for the hull (`planHullPath`: the
  navigation grid with the obstacles grown by that clearance, cached per
  terrain and width, string-pulled with it). A destination the hull does
  not fit at (against a wall, between two) is moved to the nearest place
  it does within 15 m. With Prefer roads it goes by the roads, else not;
  failing that, the other way. (Soldiers' routes hug buildings 0.75 m off:
  a fifth of the orders in a stress test of 1,000 vehicles on Quantico
  were refused, "no way there wide enough for the vehicle"; now 2.5 %, where
  there is none.) Steering off its route (round a wreck, past soldiers),
  it keeps the hull's clearance too. A vehicle clears buildings but may
  brush small obstacles. A road's gentle bends (a
  turn on its centreline bending less than 25°) are not corners: they are
  driven as they are. (Each was pushed out 3 m, to alternate sides, and a
  vehicle on a road zig-zagged along it.) Fences and
  single trees are not obstacles. Roads are followed only with Prefer roads.
- **Parked.** Another vehicle parked where it is going: it stops beside it,
  clear of it, and has arrived. One parked in a street too narrow to pass it
  stops those behind for good: they do not plan another way round it.
- **Speed.** Only the ground directly under the vehicle sets its speed.

## 5. Code and tests

- `src/sim/vehicles.ts`: the vehicle state, the `orderVehicle` command, driving and ground speeds.
- `src/exercise/battle/vehicles.ts`: the scenario's vehicles: the edits, the issues, the file format.
- `src/exercise/motion-log.ts`: `motionMovers`, which records vehicles after the soldiers.
  `frame-log.ts` and `battle-host.ts` do the same for the battle worker.
- The app:
  - `planner.ts`: the place tool, routes and selection;
  - `map-editor.ts`: drawing and editing on the map;
  - `combat.ts`, `combat-editor.ts`, `combat-panel.ts`: orders and panels in Sim;
  - `status.ts`: `vehicleStatuses`;
  - `page.ts`: the tools, panel and roster.
- `src/view3d/vehicles.ts`: the model, its pose, suspension and tracks.
- Tests:
  - `src/sim/vehicles.test.ts`: acceleration and braking, speeds by ground, uphill, pivoting, round a building, through a waypoint, the interval, round a wreck, passing head on, a crossing, a gap too narrow for the hull, orders, determinism;
  - `src/exercise/battle/combined-arms.test.ts`: soldiers in its way, a squad making way in a narrow street;
  - `src/exercise/battle/vehicles.test.ts`: edits, saving, driving in a battle, orders in combat;
  - `src/app/battle/planner.test.ts`: placing and routing;
  - `src/view3d/vehicles.test.ts`: the track path, the hull's fit, the tracks' travel.
