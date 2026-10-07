# ADR 0010: Ambush exercise flow, kill zone and trigger

- Status: Accepted
- Date: 2026-10-07

## Context

The administrator authors the tactical problem; the trainee solves it. The
trainee positions BLUEFOR and defines a kill zone, then declares the ambush
ready. OPFOR then follows an administrator-defined route, and the ambush
triggers when OPFOR enters the kill zone. Combat (a later phase) starts from
that moment.

## Decision

### Who defines what

| Administrator (scenario, immutable)     | Trainee (exercise input)          |
| --------------------------------------- | --------------------------------- |
| Terrain, movement parameters            | BLUEFOR routes from their start   |
| BLUEFOR and OPFOR soldiers and starts   | Final positions and facings       |
| OPFOR routes, and whether they're shown | The kill zone                     |
|                                         | When to start OPFOR (START OPFOR) |

`AmbushScenario` (exercise layer) extends the simulation's `Scenario` with
`opforRoutes`. Each `OpforRoute` has:

- a stable route id and waypoint ids;
- the OPFOR soldier that follows it from its scenario start;
- a final facing;
- `shownToTrainee`, the scenario setting for route visibility.

OPFOR routes are deliberately not `SoldierPlan`s: they are part of the problem,
not trainee input, and nothing can edit them. Several OPFOR soldiers may follow
copies of a common route. There is no formation movement.

**World fingerprint.** OPFOR routes and the kill zone reach the simulation only
as commands (`setOrders`, `setEngagementArea`), so the simulation's result
after a restore never depends on them through `SimWorld`. The world fingerprint
(ADR 0008) therefore still covers exactly terrain and movement parameters. A
future exercise-level save/resume format should fingerprint the whole
`AmbushScenario`, routes included, as it will re-issue them.

### Exercise phases

```
BLUEFOR Planning ─Execute─▶ BLUEFOR Occupation ─all in position─▶ BLUEFOR Ready ─START OPFOR─▶ OPFOR Approach ─entry─▶ Ambush Triggered
                              ⇅ Pause / Resume (re-plan)            │ edit + Resume ─▶ Occupation      ⇅ Pause / Resume
```

- The simulation runs only during Occupation and Approach, and only while not
  paused. Pause is a flag on those two phases. Plans and the kill zone can be
  edited during Planning, while Occupation is paused, and during Ready.
- **Movement complete vs. trainee declaration.** These are separate concepts:
  - `bluforMovementComplete` is computed from simulation state: no commit is
    waiting for its tick, and every active BLUEFOR soldier either has no orders
    or is `inPosition`. Soldiers given no plan count as in position.
  - When movement is complete during Occupation, the exercise moves to Ready at
    the end of that tick and freezes. It never starts OPFOR by itself.
  - START OPFOR is the trainee's declaration that the ambush is ready. It is
    recorded as an `OpforStart`.
- In Ready the trainee may still edit plans; Resume then commits them and
  returns to Occupation.
- Phase changes (Ready, Triggered) stop the simulation at the end of the tick
  in which they happen, even if the frame asked for more ticks.

### START OPFOR validation

START OPFOR is refused, with reasons shown to the trainee, unless:

- the exercise is in Ready (otherwise: plan not executed, BLUEFOR still moving,
  or occupation paused);
- no draft differs from the committed plans;
- the kill zone is valid (see below), and no OPFOR soldier is already inside it;
- the scenario defines at least one OPFOR route.

On START OPFOR, at the current tick:

1. the kill zone is set as a simulation engagement area monitoring OPFOR;
2. each route is sent as `setOrders` to its OPFOR soldier;
3. an immutable `OpforStart` is recorded: tick, time, kill zone, active plan
   revision, and route ids.

BLUEFOR receives no new orders and stays where it is.

### Kill zone (`EngagementArea`)

The trainee-facing **KILL ZONE** is, internally, a generic engagement area: a
polygon in map East/North metres with a stable id (`KZ-1`, `KZ-2` after a
clear). It is an exercise trigger, not a weapon effect.

- **Valid for START OPFOR:** at least 3 corners, a simple polygon (no
  self-intersection or repeated corners), and an area of at least 25 m².
- **While editing:** an edit that would leave the map, put a corner within 1 m
  of another, or make the polygon cross itself is refused, and a drag stops at
  the last valid position. Polygon tests are exact floating-point predicates
  with no geometry dependency (`src/sim/polygon.ts`).
- **Interaction (Kill zone tool, key K):**
  - click the map to add a corner after the last one;
  - click a side to insert a corner;
  - drag a corner to move it;
  - right-click a corner to delete it;
  - Clear kill zone in the side panel.

  Soldiers can't be selected with this tool, so corners can be placed anywhere.

### Entry detection and the trigger

- **Movement reports its path.** Each tick, the movement system returns the
  straight pieces every soldier travelled, with exact start and end times
  (speed is constant on each piece).
- **Monitoring.** A new system, `monitorEngagementAreas`, runs after movement
  and tests each piece of a soldier of the monitored side against each area.
  Entries are found along the path, not by sampling tick end positions, so a
  soldier crossing an area within a single tick is detected.
- **Closed-polygon semantics.** The boundary belongs to the area. **Entry is
  the first contact with the boundary from outside.** For a path piece from
  `a` to `b`:
  1. collect every parameter s ∈ [0, 1] where it meets a polygon edge (a
     crossing, a touch, or both ends of a collinear overlap);
  2. merge parameters closer than 1e-12;
  3. walk them in order, tracking whether the path is outside: it starts as
     `!pointInPolygon(a)`, and after each parameter it is tested at the
     midpoint to the next one;
  4. every parameter reached while outside is an entry, at time
     `t0 + s·(t1 − t0)` and point `a + s·(b − a)`.
- **Boundary cases:**
  - Grazing a corner or running along an edge counts as entering.
  - Arriving exactly on the boundary is an entry at that moment, reported once.
  - A path that starts on the boundary or inside has not entered.
  - A soldier inside an area when it is set has not entered; it must leave and
    come back. START OPFOR refuses a kill zone that already contains OPFOR, so
    in practice the approach always starts with OPFOR outside.
- **Event order.** Entries are emitted as `engagementAreaEntered` events, in
  time order within the tick (soldier order for exact ties). Each carries the
  area id, soldier, exact `atSeconds` and `point`.
- **The trigger.** During the approach, the first entry into the kill zone
  triggers the ambush:
  - the exercise records an immutable `AmbushTrigger` (tick, exact time,
    soldier, kill zone id, point) and an `ambushTriggered` milestone;
  - the phase becomes Ambush Triggered and the simulation stops at the end of
    that tick;
  - the trigger happens once.
- **Tick rate.** Entry times and points are tick-rate independent within 1e-6
  at 10–120 Hz. The final frozen state can differ by at most one tick of
  movement after the entry.

### Records for the future AAR

All in simulation ticks and seconds:

| Question                                   | Record                                                        |
| ------------------------------------------ | ------------------------------------------------------------- |
| What kill zone did the trainee define?     | `PlanRevision.killZone` at each commit; `OpforStart.killZone` |
| Which plan revision was active?            | `revisions`; `OpforStart.planRevision`                        |
| When did the trainee start OPFOR?          | `OpforStart.tick` / `timeSeconds`                             |
| Which OPFOR route did the scenario define? | `AmbushScenario.opforRoutes`; `OpforStart.routeIds`           |
| Who entered first, and exactly when?       | `AmbushTrigger`                                               |

There is also a tick-stamped `timeline` of exercise milestones: plan committed,
paused, resumed, BLUEFOR in position, OPFOR started, ambush triggered.

## Consequences

- Combat can start from Ambush Triggered with the triggering soldier, time and
  place known.
- Line of sight, weapon range and engagement criteria are not part of the
  trigger. A different trigger rule would be a change to the exercise layer
  only.
- Route visibility is per route. Fog of war and information classification
  are not implemented.
