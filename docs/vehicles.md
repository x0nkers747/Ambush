# Vehicles (prototype)

A battle can have vehicles: M113 armoured personnel carriers, tracked, of
either side. A vehicle is placed in Scenario Setup with a route of waypoints.
It drives the route as a tracked vehicle does, and takes new Move orders in
combat. It only drives. It has no crew and no weapons, and nothing sees it,
shoots at it or is blocked by it. Its motion is recorded with the soldiers',
so the After-Action Review replays it.

## 1. Placing a vehicle and giving it a route

**Scenario Setup:**

1. Press **M113 APC** in the BLUEFOR or OPFOR row under **Place vehicles**.
2. Click the map. The vehicle is placed there, facing north (OPFOR's: south),
   and the Select tool is back: drag the vehicle to move it, its knob to turn it.

**Planning:** select the vehicle, pick **Move**, and click the map. Each click
adds a waypoint to its route, after the selected one, or at the end.

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

Each order's route is planned like a soldier's. It goes round buildings and
water, and through woods. It does not follow roads. The vehicle steers along
the route (`src/sim/vehicles.ts`):

- **Pivoting.** Nearly stopped and facing more than 50° away from where it must
  go, it turns on the spot at 35°/s.
- **Steering.** Otherwise it turns toward the way on. Its turn rate is limited
  to 2.5 m/s² of sideways acceleration, and to 40°/s.
- **Speed.** It speeds up to the speed the ground allows under it, and slows
  uphill. Accelerating is 1.2 m/s²; braking is 2.5 m/s².
- **Bends.** It brakes in time for the next bend. A bend of 60° or more is
  taken at 3 m/s (11 km/h); gentler ones faster.
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

The map draws a vehicle with its APP-6 symbol: an armoured personnel carrier,
the infantry cross over the oval of tracks. Its route is a dash-dot line. In
3D the symbol stands above the model on a leader line.

## 4. Limits of the prototype

- **Driving only.** No crew to mount or dismount, no weapons. It is not
  detected, shot at or hit, and it blocks nobody.
- **Routes.** The routes are soldiers' routes, widened by 3 m at each corner,
  so a vehicle clears buildings but may brush small obstacles. Fences and
  single trees are not obstacles. Roads are not followed.
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
  - `src/sim/vehicles.test.ts`: acceleration and braking, speeds by ground, uphill, pivoting, round a building, through a waypoint, orders, determinism;
  - `src/exercise/battle/vehicles.test.ts`: edits, saving, driving in a battle, orders in combat;
  - `src/app/battle/planner.test.ts`: placing and routing;
  - `src/view3d/vehicles.test.ts`: the track path, the hull's fit, the tracks' travel.
