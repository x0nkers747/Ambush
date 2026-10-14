# Behavior Lab 03: architecture proposal

- Status: proposal (for approval; nothing implemented)
- Date: 2026-10-14
- Part of: [Behavior Lab research](README.md)
- Builds on: [01 existing architecture](01-existing-architecture.md), [02 research survey](02-research-survey.md)

## 1. Recommendation in one page

Build a small **unit-task engine inside the simulation kernel** (`src/sim/behavior/`). Its first
task is MOVE_IN_FORMATION, and it rests on five decisions:

1. **One task per ordered unit.** An order goes to an organisation of any echelon: fire team, squad or platoon.
   - That unit gets one task: a small explicit state machine (`forming → moving → settling → complete | failed`).
   - Subordinate echelons do **not** get controllers of their own. They are **nested frames** in the formation the task carries.
   - A subordinate gets its own task only when it must act independently: splitting at an obstacle, bounding (later milestones).
   - This is ModSAF's unit-task shape (02 §2.3), cut down to what is needed now.
2. **One shared route per task, and a virtual anchor on it.**
   - The route is planned once with the existing `planPath`, then rounded at its corners and measured by arc length.
   - An anchor advances along it at a pace moderated by the members' progress, so it never runs away from them.
   - Sources: Millington's anchor point, Jurney's speed control, Kamphuis & Overmars' "head waits for the tail".
3. **Route-relative slots, with the leader as a slot.**
   - Every slot is "Δs metres behind the anchor along the route, d metres to its side", with d clamped to the corridor's clearance.
   - Members follow the route through bends, the way infantry do ("follow me and do as I do"). Formations narrow into files where the ground is narrow.
   - Leaders hold slots defined by doctrine. The frame does not depend on any single Marine, so it does not lurch when a leader sidesteps or re-root when one falls.
4. **Members steer.** Each Marine steers toward the point his slot will occupy a short time ahead:
   - speed in proportion to his along-track error, within a band;
   - acceleration and turn-rate limits;
   - weak separation within his team, and anticipatory avoidance between teams;
   - a bounded local search when his direct way is blocked.

   The output is position and facing per tick, exactly what the motion log and the 3D characters already consume.

5. **Determinism by construction.**
   - All state is plain data in `SimState`; the route is frozen and shared by identity.
   - Integration runs at a fixed internal substep (120 Hz), so any tick rate that divides 120 gives bit-identical results.
   - Periodic decisions are keyed to simulation time and staggered by soldier index.
   - Cosmetic variation uses a hash of the task's seed, the soldier and the time, never the global random stream.

**Not adopted for this milestone:**

- behaviour-tree or HTN libraries;
- per-Marine A\*;
- leader-relative frames;
- ORCA within teams;
- flow fields;
- navmeshes.

Each is a deliberate omission with a stated trigger for revisiting it (§12).

## 2. Goals and non-goals

**Goals.**

- A commander gives one order to a fire team, squad or platoon: a destination, a formation and optional parameters.
- The organisation moves there believably, keeps cohesion, adapts to terrain and obstacles, recovers from disruption, and ends predictably.
- The result is deterministic, recorded and replayed exactly, and costs little.

**Non-goals now.**

- Combat behaviours, contact drills, bounding or halts on the march.
- New UI in the game; the lab is the only consumer.
- Natural-language orders or automated tactical planning.
- Moving vehicles, or behaviour for OPFOR in the game. The lab will drive OPFOR teams too, but the game's OPFOR stays as it is.

## 3. Placement and module boundaries

```
src/sim/behavior/           (new; headless; part of the sim layer)
  index.ts                  public surface, re-exported from #sim
  orders.ts                 UnitOrder types + validation (the orderUnit command's payload)
  formation-spec.ts         FormationSpec (nested slot tree, metres), validation, slot geometry
  route.ts                  GroupRoute: planPath → rounded corners → arc-length table; queries P(s), N(s)
  clearance.ts              per-terrain clearance field on the nav grid (distance transform), cached
  local-search.ts           bounded A* on the nav grid (a few hundred cells)
  task-move.ts              MOVE_IN_FORMATION state machine (anchor, pace, mode changes, completion)
  agent.ts                  per-Marine steering and integration (the "Marine controller")
  avoidance.ts              spatial hash (ordered), separation, time-to-collision avoidance
  noise.ts                  counter-based hash noise (stateless, seeded per task)
  system.ts                 updateBehavior(state, world, time, events): the system called by stepState
  diagnostics.ts            pure functions views call to explain state (slot targets, errors, cohesion)

src/exercise/formations/    (new data + builders; exercise layer)
  templates/*.json          doctrinal formation templates by role (USMC fire team wedge, squad column, …)
  build-spec.ts             template + roster → FormationSpec (resolves roles to soldier ids, spacing)
  platoon templates         organisation JSON for platoons (data only)

src/exercise/behavior-lab/  (new; lab scenarios, metrics; exercise layer)
src/view3d/behavior-lab/    (new; the lab page; see 04)
src/app/main.ts             one hash-guarded dynamic import, as the terrain lab did
```

**Why the kernel, not a new layer.**

- The engine changes authoritative positions inside the tick, so it must run inside `stepState`, under the kernel's determinism rules (lint bans clocks and `Math.random` there).
- Its state must be hashed, snapshotted and recorded like any other.
- A separate layer would either duplicate the kernel or call into it out of band. 01 §13 rejects both.

**Why formation _templates_ live in `exercise`.**

- Doctrine, roles and organisation templates are data that `exercise` already owns (`organization.ts`, `formation.ts`).
- The kernel receives a resolved, role-free `FormationSpec` in metres and soldier ids, and stays generic: echelons remain free strings with no behaviour attached.
- The same split already exists: the exercise turns plans into `setOrders`.

**What is not changed.**

- `moveSoldiers` keeps its exact waypoint movement for every soldier the engine does not control.
- Every existing scenario, test and pinned hash stays identical, because the behaviour state is absent until a unit order is given (the same rule as `engagement`, 01 §2).
- Views, the motion log and the characters are unchanged.

## 4. State, commands and data flow

### 4.1 State (plain data, in `SimState`)

```ts
interface SimState {
  // …existing fields…
  /** Unit tasks and the agents they drive. Absent until the first unit order. */
  behavior?: BehaviorState;
}

interface BehaviorState {
  readonly tasks: UnitTask[]; // in order of issue; finished tasks stay until replaced
  readonly agents: AgentState[]; // one per controlled soldier, in soldier order
  nextTaskSeq: number;
}

interface UnitTask {
  readonly id: string; // `${unitId}.${seq}`
  readonly unitId: string;
  readonly order: UnitOrder; // intent, as given (never mutated)
  readonly route: GroupRoute; // frozen; shared by identity across ticks and frames
  readonly spec: FormationSpec; // frozen; resolved slots in metres
  readonly seed: number; // one draw from state.rng when the order applies
  phase: 'forming' | 'moving' | 'settling' | 'complete' | 'failed';
  anchorS: number; // arc length along the route (m)
  anchorSpeed: number; // m/s, acceleration-limited
  mode: 'open' | 'compressed' | 'file';
  modeSince: number; // seconds; hysteresis
  startedAt: number;
  endedAt: number | null;
  outcome: null | 'arrived' | 'arrivedIncomplete' | 'noRoute' | 'cancelled';
}

interface AgentState {
  readonly soldierId: string;
  readonly taskId: string;
  slotId: string; // current slot in the spec (stable; see §6.3)
  vx: number;
  vy: number; // velocity (m/s), map axes
  latched: boolean; // in position and stopped (completion hysteresis)
  progressS: number; // best along-route progress seen (stuck detection)
  sinceProgress: number; // seconds without progress
  detour: readonly PathPoint[] | null; // bounded local path, frozen; null when the way is clear
  detourIndex: number;
}
```

**Notes on the state.**

- `GroupRoute` and `FormationSpec` are created once per order and frozen. The replay recorder shares them by identity, as it shares `legPaths` (01 §10), so recording stays per-tick small.
- Velocity is kept on the agent, not on `Soldier`. Soldiers outside the engine are untouched, and their hashes do not change.
- Everything the AAR or the debug overlays need is either in this state or recomputed from it by pure functions in `diagnostics.ts`.

### 4.2 Commands and orders

```ts
type SimCommand = … | { type: 'orderUnit'; tick: number; unitId: string; order: UnitOrder | null };

interface UnitOrder {
  readonly kind: 'moveInFormation';
  readonly destination: Vec2;
  readonly formation: FormationSpec;   // built by the exercise from a template + roster
  readonly finalFacing?: Azimuth;      // default: the route's last heading
  readonly pace?: number;              // preferred speed (m/s); default world.movement.speed
  readonly followRoads?: boolean;      // as setOrders
}
```

**Applying an order** (at the start of its tick, like every command):

1. Validate the order: unknown unit, a soldier not in the unit's subtree, destination problems (the same reasons as `setOrders`, plus `noRoute`).
2. Cancel any previous task of that unit or of any unit inside it. Their agents are released.
3. Clear the members' individual `orders`.
4. Plan the route from the formation's current centre to the destination.
5. Draw `seed` from `state.rng`: one draw per order, tied to an event, as ADR 0007 requires.
6. Create the task in phase `forming`, and one agent per active member.
7. Emit `unitOrdered`. `null` cancels the task.

**Membership rules.**

- A `setOrders` for a soldier who has an agent releases him from his task, the same rule as editing a Marine detaches him from a planning formation (ADR 0022).
- Systems that write orders (OPFOR flee) do the same.
- An incapacitated soldier is released.
- On any release, the task recomputes its occupied-slot centre (Millington's drift offset, 02 §3.2), so the formation does not shift toward missing members.

### 4.3 The tick

```
applyCommands          (orderUnit applies here; routes planned here)
updateBehavior         NEW: tasks, then agents; moves controlled soldiers; returns PathSegment[]
moveSoldiers           unchanged; skips soldiers that have an agent
monitorEngagementAreas receives both segment lists (entry times stay exact)
resolveCombat          unchanged
tick += 1
```

Inside `updateBehavior`, for each of the tick's `n = 120 / tickRateHz` substeps of `h = 1/120 s`:

1. **Tasks, in issue order.** Read the members' positions at the start of the substep. Update the anchor's pace and position, the mode and the phase.
2. **Agents, in soldier order.** Compute each agent's desired velocity from the task's (just-updated) anchor and the _start-of-substep_ positions of the other soldiers, held in a snapshot array. The result does not depend on the order agents are processed (Mars & Chanut's previous-state rule, 02 §3.6).
3. **Integration, in soldier order.** Apply acceleration limits, integrate, resolve contact with static obstacles, set z from `surfaceHeightAt`, and turn the facing.
4. **Bookkeeping.** Emit path segments, `waypointReached`-style events (`unitPhaseChanged`, `unitTaskEnded`), and progress for stuck detection.

**Periodic decisions** run at fixed simulation times and are spread across soldiers by index, so the cost of a decision tick stays flat:

- line-of-way checks and local searches, every 0.5 s per agent (staggered);
- mode changes, every 0.25 s per task.

### 4.4 Data flow

```
 exercise / lab                       sim kernel                                    views
 ────────────────                     ──────────                                    ─────
 template + roster ─▶ FormationSpec ┐
 destination, pace ────────────────┴▶ orderUnit command ─▶ applyCommands ─▶ UnitTask (route, spec, seed)
                                                          updateBehavior ─▶ Soldier.position/azimuth
                                                          (agents: vx, vy, slot, latched)
                                       SimState ─────────────────────────▶ motion log ─▶ 3D characters
                                       SimState ─▶ diagnostics.ts (pure) ─▶ lab overlays (2D/3D)
                                       SimState ─▶ replay recorder ─▶ AAR frames (exact)
```

**The renderer is never authoritative.**

- Positions, facing, speed and behaviour come only from `SimState`.
- The characters derive animation from the motion log as today (01 §9).
- Overlays recompute explanations from state with the same functions the simulation uses (§9), so what is drawn is what was decided.

## 5. Hierarchy and who decides what

| Level                                                            | Owns state?                              | Decides                                                                                            | Does not decide                                  |
| ---------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Ordered unit's task** (any echelon)                            | Yes: `UnitTask`                          | Route; pace (anchor speed); formation mode (open, compressed, file); phase and completion; failure | Individual paths; who stands where within a role |
| **Subordinate elements** (squads in a platoon, teams in a squad) | No (v1): nested nodes of `FormationSpec` | Nothing: their anchor is a point of the parent's formation, computed each substep                  | —                                                |
| **Individual Marine**                                            | Yes: `AgentState`                        | Speed within the band; steering; avoidance; local detours; facing; when he is in position          | The route; where his slot is                     |

**Why subordinate elements have no controller yet.**

- Doctrine: the squad leader controls the squad through the _base team_; other teams guide on it without rigid positions (02 §6.3). That is a _geometric_ relation: a team is where its slot of the squad formation is, and its members are where their slots of the team formation are. Geometry needs no state.
- Each extra controller level would add state, interactions and failure modes, with nothing to decide yet.

**What will make them controllers.** Splitting at an obstacle, a team taking a different side of a building, bounding overwatch, and a team leader's own decision to change his team's formation ("each fire team leader typically determines the formation for their own units", 02 §6.3).

- At that point a task may create **child tasks** for subordinate units: the ModSAF pattern of unit frames editing subordinate frames.
- The child task gets its own route segment and anchor, and the parent waits on the child's completion or progress.
- The data model already allows it: tasks are per unit, and agents point at the task that drives them. Nothing in the first milestone has to change.

**Leaders.**

- Squad and team leaders are slots placed by doctrine (behind the lead team; on the team's inner shoulder). They follow the same steering as everyone else.
- Their _authority_ is expressed by the task, which acts for the unit's commander. Their _position_ is a slot.
- A leader who falls does not break the formation. Who takes command is a later question (07, Q9).

## 6. Formations: slots and templates

### 6.1 Templates (data, `src/exercise/formations/templates`)

A template places the **roles** of one unit, and the **child units** of a parent, in units of the formation interval. Example: the USMC fire-team wedge (MCRP 3-10A.4 Fig 1-12; the rifleman at the point, the team leader and the grenadier/AAR on the shoulders, the AR at the rear):

```json
{
  "id": "usmc.fireTeam.wedge",
  "echelon": "fireTeam",
  "doctrine": "MCRP 3-10A.4 Fig 1-12",
  "slots": [
    { "role": "rifleman", "forward": 1.0, "right": 0.0 },
    { "role": "fireTeamLeader", "forward": 0.0, "right": -0.7, "mirrorable": true },
    {
      "role": ["assistantAutomaticRifleman", "grenadier"],
      "forward": 0.0,
      "right": 0.7,
      "mirrorable": true
    },
    { "role": "automaticRifleman", "forward": -0.7, "right": 0.0 }
  ],
  "file": [
    "rifleman",
    "fireTeamLeader",
    "automaticRifleman",
    "assistantAutomaticRifleman|grenadier"
  ]
}
```

**Squad and platoon templates** place child units and the unit's own leader in the same way. Example: the squad wedge, with `[1]` at the point, the SL behind it, and `[2]` and `[3]` behind on either side (Fig 1-16).

**Every template also defines:**

- its **file order**, used when the corridor is too narrow;
- its **compressed** spacing factor.

**`build-spec.ts` turns a template and a roster into a `FormationSpec`:**

- it resolves roles to soldier ids;
- it multiplies by the interval (individual, team and squad spacing are separate parameters: 06 §6.4);
- it applies mirroring, so each team leader is on the side nearest the squad leader, as the figures show;
- it nests the children.

**Templates to ship first.**

- Fire team: wedge, column, file.
- Squad: column, wedge, line, file.
- Platoon: column.
- The Army wedge (team leader at the point) as a second fire-team template, which proves a template is data and not code.

### 6.2 FormationSpec (what the kernel sees)

```ts
interface FormationSpec {
  readonly root: FormationNode;
  readonly interval: number; // m, for diagnostics and tolerances
}
interface FormationNode {
  readonly unitId: string;
  readonly back: number; // m behind the parent's anchor point (Δs); negative = ahead
  readonly right: number; // m to the right of the route
  readonly slots: readonly { id: string; soldierId: string; back: number; right: number }[];
  readonly children: readonly FormationNode[];
  readonly file: readonly string[]; // slot ids in file order (whole subtree), for 'file' mode
}
```

### 6.3 From slot to target point

For a slot whose nested offsets add up to `(back, right)` (the node offsets plus the slot's own):

```
s_slot  = anchorS − back · k_depth(mode)
target  = P(s_slot) + clampLateral(right · k_width(mode), s_slot) · N(s_slot)
```

- `P` and `N` are the route's point and its right normal at arc length `s`. Before the start or past the end of the route, the route is extended straight along its first or last heading.
- `clampLateral` limits `|right|` to the corridor clearance at `s_slot`, minus a margin of 1 m: buildings 0.75 m plus a body. Wide formations therefore narrow smoothly where the ground narrows (Kamphuis & Overmars' corridor, 02 §5).
- In `file` mode, slots are re-laid at `right = 0` in the template's file order, at file spacing.
- **Mode changes blend over about 3 s.** Targets move continuously from the old layout to the new, so nobody jumps. Doctrine's "by the shortest practical route" is what members' steering then does.

**Assignment is stable by construction.**

- Slots are bound to roles, so most of the assignment is fixed.
- The free choices (mirroring a team's shoulders; which team takes which flank) are resolved once when the order applies. They are re-examined only on a membership change or a reversal of the route of more than 120°.
- Each re-examination is an exhaustive search over at most 24 permutations per node, on integer squared distances plus a stickiness bonus, with ties broken by soldier index (02 §3.8).
- No member ever crosses the formation to take another's slot.

### 6.4 Elasticity and tolerances

Elasticity means members are allowed to be away from their slots, and are corrected softly:

| Band           | Distance from slot target    | Response                                                             |
| -------------- | ---------------------------- | -------------------------------------------------------------------- |
| On station     | ≤ 0.15 d (1.5 m at d = 10 m) | No along-track correction; noise only                                |
| Drifting       | ≤ 0.5 d                      | Proportional speed correction                                        |
| Displaced      | > 0.5 d                      | Full catch-up band; anchor pace starts to give way                   |
| Out of contact | > max(3 d, 30 m) for 10 s    | Counts as straggling (a metric); the task's pace yields to its limit |

**Notes on the bands.**

- `d` is the template's interval.
- All thresholds are **experimental**, to be calibrated in the lab (05). Doctrine sets only the principle: sight or voice contact, not fixed distances (02 §6.3).
- **Personal variation.** Each member's slot point carries a slow, bounded drift: at most 0.1 d, with a correlation time of about 10 s. It is computed from `noise(task.seed, soldier, t)`, a counter-based hash smoothly interpolated between knots. Jurney uses this against robotic precision (02 §3.1).
- The drift draws nothing from `state.rng`. It is the same at every tick rate and in every replay.

## 7. Routes, corridors and obstacles

### 7.1 The group route

- **Planning.** `planPath(terrain, start, destination, {followRoads})` runs once, from the formation's centre (the slot-weighted centroid of active members) to the destination. It is the same planner, with the same caching, bridges and roads, that the game's display and simulation use.
- **Corner rounding.** Each corner is replaced by a circular arc of radius `r = max(2 m, half-width of the formation in its current mode)`, bounded by the adjacent segment lengths.
  - An arc is accepted only if the clearance along it is at least 1 m. Otherwise the corner stays sharp and the formation narrows there.
  - Rounding is what lets route-relative slots turn without bunching.
- **Arc-length table.** The route is resampled every 1 m into frozen arrays (x, y, tangent, clearance), so `P(s)` and `N(s)` are an index and one interpolation.
- **Cost.** The route is a few kilobytes even for a 2 km order. Planning costs what `planPath` costs today (01 §6): a few to 30 ms for typical legs, up to about 0.9 s across a 5 km map.

### 7.2 The clearance field

- **What it is.** A chamfer (3-4) distance transform over the existing 2 m navigation grid: distance to the nearest blocked cell, quantised to 0.25 m in a `Uint16Array`. It is built once per terrain and cached in a WeakMap, like the grid.
- **Cost.** About 12.5 MB and an estimated 50–150 ms for a 5 km × 5 km battlefield. This estimate must be measured in milestone 1; the field could be built lazily per tile if it is too slow (07, Q5).
- **What it gives:**
  - corridor half-width along the route (§6.3);
  - a cheap "is this point clear for a body?" test for steering;
  - automatic files on bridges, since a deck's clearance is its half-width;
  - later, a group-width cost term for A\* (02 §5).

### 7.3 Obstacles, narrow passages, bridges, water

**Buildings, water and narrow streets.** Lateral clamping narrows the formation. Where clearance falls below the formation's compressed half-width, the task switches to `file`. The decision uses clearance over the next 30 m of route, with hysteresis: it leaves `file` only after 15 m of clearance above 1.5× the open half-width.

**Displaced members.**

- If a member's straight way to his target is blocked (`isSegmentWalkable`, checked every 0.5 s, staggered), he runs a **bounded local A\***: at most 400 cells (about 0.4 ms).
- The search runs from his position to the target, or to the nearest reached cell (Jurney's "softening", 02 §3.1).
- He follows that detour until the straight way is open again.

**Contact with obstacles.** After integration, a member whose clearance falls below his body radius is pushed out along the clearance gradient, keeping the tangential part of his velocity: he slides along walls. Nobody enters a building or deep water.

**Bridges.** The route already crosses bridges as decks with z (ADR 0043). Deck clearance forces `file`. z follows the deck profile, as `place()` does now.

**Steep slopes.** Slope is not a navigation cost today (01 §6). The engine does not change that in the first milestone. A slope speed factor is an open question (07, Q7), because ADR 0008 warns it affects tick-rate independence; with fixed substeps this concern goes away.

**Other soldiers.**

- Within a fire team: weak separation (personal space 1.0 m).
- Between elements and other units: time-to-collision avoidance (Karamouzas et al., 02 §4) over a 3 s horizon.
- At head-on deadlocks in passages: priority yielding (Pottinger). Priority is task issue order, then the slot's Δs, then soldier index, which is a total order.
- Neighbours come from a uniform 4 m spatial hash rebuilt each substep, iterated in soldier order.

## 8. Movement control

### 8.1 The anchor (the task's pace)

```
lag_i     = (s_slot_i − s_member_i)    along-route deficit of member i (projection on the route)
lag_max   = max over active, unlatched members, excluding stragglers flagged out of contact
v_target  = pace · clamp(1 − (lag_max − L0) / (L1 − L0), 0, 1)       L0 ≈ 0.5 d, L1 ≈ 2 d
anchorSpeed → v_target, at most 0.5 m/s² (accelerating) and 1.0 m/s² (braking)
```

**Properties.**

- The anchor slows _smoothly_ as the worst member falls behind and stops before losing him: the "head waits for the tail".
- It never jumps, so members never see a step change.
- The anchor's pace is at most 90% of the members' maximum cruising speed. This leaves catch-up headroom without anyone running (Pottinger; Millington's "anchor slower than members", 02 §3).
- **Forming.** At the start (`forming`) the anchor waits at s = 0 until members are within the drifting band, or 20 s pass. Members then walk to their slots by the shortest way.
- **Arrival.** Near the end, the anchor follows _arrive_: it decelerates to stop at the route's end, and the phase becomes `settling`.

### 8.2 The Marine (agent)

```
p_ahead   = slot target at time t + τ          τ ≈ 1.5 s (anchor extrapolated at its speed)
e_along   = (slot target − position) · route tangent at the slot
v_pref    = pace · clamp(1 + k·e_along / d, 0.6, 1.3)                   k ≈ 1.0
heading   = toward p_ahead (or the next detour point)
v_desired = heading · v_pref  (+ separation + avoidance)  (speed capped at v_max = 1.3 · pace, or 2.2 m/s)
v         → v_desired, at most a_max = 1.5 m/s², decelerating at most 2.5 m/s²
facing    → direction of travel when speed > 0.3 m/s; otherwise the route heading or final facing
            at most maxTurnRate (world.movement)
```

**Why this produces natural movement.**

- **No oscillation.** Speed corrections are proportional with a dead band (on station: none). They are filtered by acceleration limits, and the target is extrapolated 1.5 s ahead, so corrections lead instead of lag.
- **Turns.** On a bend, the route-relative target moves round the bend. Members walk forward along curved paths at slightly different speeds: inside members slower, outside faster, within the band. No one slides sideways or pivots as part of a rigid body.
  - The anchor's speed on arcs is also capped so that the outermost slot's required speed stays within the band. This is Mars & Chanut's group turn-rate limit, `ω ≤ v_max_member / half-width` (02 §3.6).
- **Catch-up.** A member who fell behind walks faster (up to 1.3× pace) without running. If he is far behind, the anchor gives way. Jogging is not modelled in milestone 1; the 3D walk/run blend shows faster walking as it does now.
- **Arrival.**
  - In `settling`, slots are the final layout at the destination, oriented to `finalFacing`.
  - A member _latches_ when he is within 1.0 m of his slot and slower than 0.2 m/s. He then stops, turns to the final facing, and stays.
  - He unlatches only if his slot moves more than 2 m, which happens only on a membership change.
  - This hysteresis ends the task without endless small corrections.

**Facing.**

- Facing turns toward travel at the existing `maxTurnRate`.
- The engine does not yet assign sectors of observation. A later "scanning" behaviour can make facing differ from travel; the characters already show sidestepping and walking backward (01 §9).

### 8.3 Completion and failure

| Outcome             | Condition                                                                          |
| ------------------- | ---------------------------------------------------------------------------------- |
| `arrived`           | Anchor at the route's end, and every active member latched                         |
| `arrivedIncomplete` | Anchor at the end; members not latched after 60 s are stuck, or were released      |
| `failed: noRoute`   | `planPath` fails when the order applies (rejected with a reason, like `setOrders`) |
| `cancelled`         | A new order to the unit or a parent, or `orderUnit null`                           |

**Stuck detection.** A member making less than 0.5 m of progress toward his target in 10 s, while not latched, is _stuck_.

- He gets one fresh local search with a larger budget (2,000 cells).
- If that fails, he is flagged; the task stops waiting for him, and he counts in the metrics.

When a task ends, it emits `unitTaskEnded {taskId, unitId, outcome, atSeconds}`. The members then stand in position, holding their final facing. The finished task stays in state until replaced, so the AAR can show it.

## 9. Diagnostics: explaining decisions without owning them

`src/sim/behavior/diagnostics.ts` exports pure functions over `(state, world)`:

- `slotTargets(taskId)`;
- `formationError(taskId)`: per member, along and across track;
- `cohesion(taskId)`: centroid spread, worst lag, contact pairs;
- `corridor(taskId)`: clearance along the route;
- `explain(soldierId)`: band, current target, detour, latched, stuck.

These are the same functions the system calls, so overlays cannot disagree with the simulation.

**Values that exist only inside a substep** (avoidance vectors, which neighbours were considered, rejected candidate cells):

- `updateBehavior` takes an optional `trace` sink. It is null in the game; the lab sets it.
- The trace receives plain records per tick. It is never stored in `SimState`, never hashed, never recorded.
- A test asserts that the state hash is identical with and without the trace.

## 10. Determinism and replay

| Concern               | How it is handled                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed timestep        | Kernel ticks unchanged. The engine integrates in 120 Hz substeps, so every tick rate dividing 120 (1–6, 8, 10, 12, 15, 20, 24, 30, 40, 60, 120) gives **bit-identical** results. Other rates use `ceil(120/rate)` equal substeps of `1/(rate·n)` s: deterministic but not identical across rates (tests compare them within a tolerance). See 07, Q2. |
| Update order          | Tasks in issue order; agents in soldier order; substep reads a snapshot of positions, so agent order does not change results; spatial-hash neighbours sorted by soldier index.                                                                                                                                                                        |
| Random numbers        | One `state.rng` draw per order (the task seed). Per-member variation is a stateless hash of (seed, soldier index, time knot), so no per-tick draws and no dependence on tick rate (ADR 0007).                                                                                                                                                         |
| Stable iteration      | Arrays only; no iteration over `Map` or `Set` in decisions; ties in assignment, A\* and priority broken by index.                                                                                                                                                                                                                                     |
| Floating point        | Same policy as the kernel (ADR 0005): deterministic within one engine and build. Per-substep loops use vector arithmetic and `sqrt`, not `atan2` and `hypot`. Azimuth is computed once per substep at the end, for the soldier's facing. Cross-browser equality is a measured property (05), not a promise.                                           |
| Pathfinding           | Existing A\* with deterministic ties; bounded local A\* reuses the same heap and tie rule. Routes are planned inside `applyCommands`, never on another thread.                                                                                                                                                                                        |
| Serialization         | All behaviour state is plain data in `SimState` and passes `clonePlainData` and `canonicalEncode`. Routes and specs are frozen and shared by identity.                                                                                                                                                                                                |
| Snapshot and restore  | Unchanged mechanism; behaviour state travels with the state. `restore` mid-task continues identically (tested).                                                                                                                                                                                                                                       |
| State hash            | `behavior` is absent until used, so existing pinned hashes do not change. New pinned hashes are added for behaviour scenarios.                                                                                                                                                                                                                        |
| Exact replay          | The AAR records full states per tick (ADR 0026), now including `behavior`. The motion log records positions and facing as now. The 3D characters replay exactly as they do today (tolerance 0).                                                                                                                                                       |
| Renderer independence | Views read state; the engine never reads views. The lab's diagnostics are pure functions of state. The trace is write-only.                                                                                                                                                                                                                           |

**As behaviours grow, the same rules keep them deterministic.**

- Every new task type is a state machine over plain data.
- Every decision is keyed to simulation time.
- Every random choice is either a single event-tied draw or a counter-based hash.
- Every interaction iterates in index order.
- The rules are enforced, not merely documented:
  - lint already bans clocks and `Math.random` in `sim`;
  - the determinism tests (05) run every behaviour scenario twice, across tick rates and through snapshot/restore.

## 11. Extensibility: future orders

Later orders compose the same pieces: a task state machine per unit, child tasks for subordinates, the formation engine for movement, and a frame stack for interruption.

| Order            | Composition                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOVE             | MOVE_IN_FORMATION with the unit's default formation and mode chosen by terrain                                                                                                                          |
| HALT             | Task: each member takes the nearest cigar-perimeter point off the route, facing outward (02 §6.5); kneel after 2 s, prone after 10 min. No route.                                                       |
| FOLLOW           | MOVE_IN_FORMATION whose route is re-derived from another unit's route plus a distance behind                                                                                                            |
| PATROL           | Sequence of MOVE legs through route points, with HALTs, and a rally-point list. The first use of a sequence/selector, so the point to introduce a small in-house ticked behaviour tree over task states |
| REGROUP          | Task: choose a rally point (last designated, or the leader's position); members converge by local search; complete when cohesive                                                                        |
| DEFEND           | Position assignment (utility scoring of cover points, sectors), then hold; child tasks per team                                                                                                         |
| ASSAULT / AMBUSH | Child tasks per team (support, assault; security), coordinated by phase; contingent choices are where an HTN (ported Fluid HTN) earns its place                                                         |

**Interruption** (contact, a casualty) uses ModSAF's **frame stack**:

- a reactive task is pushed on a unit's stack and suspends the task below it;
- popping resumes it;
- the state is `tasks[]` plus a per-unit stack of task ids, still plain data.

This is added with the first reactive behaviour, not before.

## 12. Trade-offs and rejected alternatives

| Alternative                                                      | Why not now                                                                                 | Revisit when                                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Behaviour-tree library (mistreevous, behavior3, BehaviorTree.js) | Hidden `Math.random`/`Date`; runtime state not serialisable; nothing to select in this task | PATROL or reactive behaviours need sequences, and then as an in-house tree over `SimState` |
| HTN (port of Fluid HTN)                                          | Decomposes to one method here; costs a planner and its replanning pitfalls                  | Contingent tactics (assault, react to contact)                                             |
| A controller per echelon                                         | State and interaction with nothing to decide                                                | Splitting, bounding, team-leader formation choice (child tasks)                            |
| Leader-relative frame                                            | Lurches when the leader sidesteps; leader loss re-roots; worse in trials                    | —                                                                                          |
| Rigid rotated frame everywhere                                   | Pivots and sideways sliding at turns; wedges sweep flanks through buildings                 | Final line-up at a halt (the settling phase already uses it)                               |
| Per-Marine A\* to the destination                                | 13–50× the planning; members take unrelated routes and the group splits                     | — (bounded local searches cover displacement)                                              |
| ORCA within teams                                                | Safety margins fight close formations; deadlocks in passages                                | Inter-group avoidance at 500+ soldiers, if time-to-collision proves weak                   |
| Flow fields                                                      | One field per goal; slots are different goals                                               | Mass single-destination moves of hundreds                                                  |
| Navmesh (recast-navigation-js, navcat)                           | Ambush! already has a deterministic grid planner with roads and bridges                     | Vehicles, or multi-storey interiors                                                        |
| Hungarian assignment                                             | Roles fix most slots; ≤ 24 permutations per node is exact and cheaper                       | Role-free templates with many members                                                      |
| Velocity on `Soldier`                                            | Changes every soldier's hash and the existing movement                                      | If all movement moves to the engine                                                        |

**Risks of the chosen design.**

1. **Route-relative slots at sharp corners.** Wide formations bunch on the inside of the turn when corners cannot be rounded, for example in a town. Mitigation: the switch to compressed or file mode is driven by clearance. Validated in scenario 4 and in obstacle scenarios (05).
2. **Anchor pace held back by one straggler.** Mitigation: the out-of-contact rule removes him from the pace calculation and flags him.
3. **Tuning.** About ten parameters (k, τ, L0, L1, bands, limits). Mitigation: all are in one versioned, fingerprinted configuration (like `combat-v1.json`), labelled doctrine or tuning, and swept by the lab's batch metrics.
4. **Tick-rate independence for rates not dividing 120.** See 07, Q2.
5. **The clearance field's cost on 5 km maps.** It must be measured in milestone 1, with lazy tiles as the fallback.

## 13. Cost estimate

| Soldiers | Steering, avoidance, integration (measured stand-in at 30 Hz, ×4 for 120 Hz substeps) |                              Decisions (periodic) |                                        Routes (per order) |
| -------: | ------------------------------------------------------------------------------------: | ------------------------------------------------: | --------------------------------------------------------: |
|        3 |                                                                          ≈ 15 µs/tick |                                        negligible |                                            one `planPath` |
|       13 |                                                                          ≈ 30 µs/tick | ≤ 2 local searches per tick worst case (≈ 0.8 ms) |                                            one `planPath` |
|       40 |                                                                          ≈ 60 µs/tick |                                 ≈ 1 ms worst case |                                      one per ordered unit |
|      100 |                                                                         ≈ 100 µs/tick |                                 ≈ 2 ms worst case |                                                         — |
|      500 |                                                                         ≈ 0.5 ms/tick |                      staggered; ≈ 3 ms worst case |                                                         — |
|    1,000 |                                                                         ≈ 1.1 ms/tick |                      staggered; ≈ 5 ms worst case | 20–80 plans if all ordered at once (seconds on 5 km maps) |

**How the estimate was made.** The stand-in kernel's figures (02 §4) are multiplied by four for 120 Hz substeps. The estimate excludes clearance sampling and lateral clamping, which add an array lookup per member per substep.

**Bottlenecks.**

- The dominant cost at scale is **route planning when many units are ordered at once**. It is mitigated by spreading orders over ticks and, if needed, by HPA\* (02 §5).
- At 30 Hz the tick budget is 33 ms, so the engine stays below 5% of it up to 1,000 soldiers on the expected path.
- The 3D view is the real limit (about 50 animated soldiers at 60 fps on an integrated GPU, ADR 0052), and it is independent of the simulation.
