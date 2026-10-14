# Behavior Lab 01: the existing architecture and its integration points

- Status: research (no code changed)
- Date: 2026-10-14, at commit `bf56227`
- Part of: [Behavior Lab research](README.md)

This is what Ambush! already has that a hierarchical movement system must work with, and where it
would plug in. File references are `path:line` at `bf56227`.

## 1. Summary

| Concern           | What exists                                                                                                                                                               | Consequence for the behaviour engine                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Simulation kernel | Fixed timestep, plain-data `SimState`, commands only from outside, systems as free functions in a fixed order, seeded xoshiro128\*\*, FNV-1a state hash, snapshot/restore | A behaviour system is one more system in `stepState` with its state in `SimState`. Nothing new is needed for determinism.      |
| Organisation      | `OrgUnit {id, echelon, parentId, leaderId}`; `Soldier.unitId`; versioned JSON templates (13-Marine squad)                                                                 | The hierarchy already exists in the simulation. Echelons are free strings with no behaviour attached.                          |
| Formations        | Planning-time only: a line of slots, written out as one destination per Marine (ADR 0022)                                                                                 | There is no runtime formation. The new engine replaces nothing; the planning formations stay as they are.                      |
| Movement          | Per soldier: straight legs at a constant speed through precomputed turn points, exact arrival splitting, facing turns toward travel                                       | The new engine must supply a different way to move: steered, variable speed, but still tick-rate independent where it matters. |
| Pathfinding       | 2 m grid A\* (8-connected, octile, deterministic ties) plus string pulling; bridges as portal links; roads for OPFOR; LRU cache                                           | Reuse it as is for one route per group. It is too slow to run for every Marine at every tick.                                  |
| Behaviour logic   | One small hard-coded state machine: OPFOR react/flee/prone in `combat.ts`                                                                                                 | No behaviour framework exists, so there is nothing to compete with.                                                            |
| Replay            | The AAR plays recorded per-tick full states; the motion log feeds the 3D characters; replay never re-simulates                                                            | Any behaviour state worth seeing in the AAR must be in `SimState`.                                                             |
| Rendering         | 2D draws the latest state; 3D characters read the motion log at `renderSeconds` (one tick behind plus alpha)                                                              | Animation already derives speed, direction and turning from positions alone. The engine supplies nothing extra.                |
| Testing           | Vitest; pinned state hashes; tick-rate tests; replay tests at tolerance 0; opt-in CLI benchmarks                                                                          | The test patterns needed for the engine already exist.                                                                         |
| Layers            | `sim` imports nothing; `exercise` → sim; views → sim, exercise, session; `app` → all. ESLint bans clocks, timers and `Math.random` in headless layers.                    | The engine's runtime belongs in `sim`; the lab page in `view3d` plus `app`.                                                    |

## 2. The simulation kernel (`src/sim`)

**Entry points.** `src/sim/index.ts` (alias `#sim`) exports:

- the simulation itself: `createSimulation`, `createInitialState`, `createWorld`;
- navigation: `planPath`, `planOffRoad`, `stringPull`, `pointProblem`, `isSegmentWalkable`, `nearestClearPoint`, `NAV_CELL_M`, `OBSTACLE_CLEARANCE_M`;
- hashing and copying: `hashSimState`, `fingerprintWorld`, `fingerprintPlainData`, `clonePlainData`;
- azimuths: `azimuthOf`, `azimuthDelta`, `normalizeAzimuth`;
- terrain: `surfaceHeightAt`, `heightAt`, `lineOfSight`, `planRoadPath`.

**Not exported:** `turnToward`, the random-number functions (`nextUint32`, `nextFloat`), and `moveSoldiers`.

**Configuration.** `SimConfig {tickRateHz, seed}`. `DEFAULT_TICK_RATE_HZ = 30`, documented as provisional ("nothing may depend on this value"); the allowed range is 1–240 Hz. The seed is run configuration, not scenario content (ADR 0007); the app reads `?seed=N`.

**World.** `SimWorld {terrain, movement: {speed, maxTurnRate}, combat?}` is immutable, deep-frozen and fingerprinted. It is never in the state or in snapshots. Movement parameters are scenario-wide, so every soldier walks at 1.5 m/s and turns at π/2 rad/s (`DEFAULT_MOVEMENT`, `src/exercise/squad.ts:34`).

**State** (`src/sim/state.ts`):

```ts
interface SimState {
  tick;
  rng: RngState;
  units: OrgUnit[];
  soldiers: Soldier[];
  engagementAreas: EngagementArea[];
  engagement?: EngagementState;
}
interface Soldier {
  id;
  side;
  unitId;
  position: Vec3;
  azimuth;
  posture;
  status;
  orders: ActiveOrders | null;
}
interface Orders {
  waypoints: Waypoint[];
  finalFacing: Azimuth;
  followRoads?: boolean;
} // intent
interface ActiveOrders {
  orders;
  nextWaypointIndex;
  behavior: 'moving' | 'facing' | 'inPosition';
  legPaths: PathPoint[][];
  nextTurnIndex;
  speed?: number;
} // execution
```

- Arrays are in scenario order, which makes iteration deterministic.
- Optional parts are absent until used (`engagement`). This keeps older states hashing as before; the behaviour state should follow the same rule.
- `ActiveOrders.speed` already overrides the world speed (OPFOR flee at 4.5 m/s). It is the existing seam for per-soldier speed.

**Commands** (`src/sim/commands.ts`):

- There are three: `setOrders`, `setEngagementArea` and `beginEngagement`.
- Each is validated, cloned and queued, then applied at the _start_ of its tick in submission order.
- A command that cannot apply produces a `commandRejected` event with a reason.
- `applySetOrders` (`commands.ts:287-334`) plans every leg immediately with `planPath`, inside the tick.

**Update order** (`src/sim/step.ts:126-153`):

```ts
applyCommands(state, world, commands, time.startSeconds, events);
const path = moveSoldiers(state, world, time, events);
monitorEngagementAreas(state, path, time, events);
resolveCombat(state, world, time, events);
state.tick += 1;
```

- Time is `tick / rate`, derived from the tick count and never accumulated.
- Systems mutate state directly inside the tick; for example, `combat.ts` rewrites OPFOR orders when they flee. "Commands only" applies to _external_ input.
- `step()` returns the tick's events (`ordersChanged`, `waypointReached`, `soldierInPosition`, `shotFired`, …). There is no event bus.

**Randomness.**

- There is a single global xoshiro128\*\* stream in `SimState.rng`, seeded through SplitMix32.
- ADR 0007's rule is that draws are tied to _events_ (one per shot), never taken per tick, so that results do not depend on the tick rate.
- Combat draws all reaction randomness up front, in soldier order (`combat.ts:62-143`).

**Hash, snapshot and restore.**

- `hashSimState` is FNV-1a 64 over a canonical encoding: sorted keys, `-0` kept distinct, and NaN, Infinity and `undefined` rejected.
- `snapshot()` is `{tickRateHz, worldFingerprint, state: clone}`. `restore()` checks the rate and the world, replaces the state, and drops pending commands.
- The hashes are pinned in `src/sim/determinism.test.ts:256-258`. Any change to the state shape changes them, deliberately.

**Floating point.**

- The kernel already uses `Math.sin`, `cos`, `atan2` and `hypot` (`geometry.ts:33`, `combat.ts:335`, `environment.ts:463`, `los.ts`, `bridges.ts`).
- ADR 0005 accepts that results may differ between JavaScript engines: the AAR replays recordings and never re-simulates. Determinism is guaranteed within one engine and build.
- The behaviour engine inherits this policy (see [03 §10](03-architecture-proposal.md#10-determinism-and-replay)).

**Measured cost** (this research, Node 24, this machine; benchmark in the scratchpad, not committed):

- One tick of the existing kernel costs about 3.5 µs for 13 moving soldiers, 14 µs for 100, and 134 µs for 1,000.
- Issuing straight-line orders costs 0.2 ms for 13 soldiers and 7 ms for 1,000, because no A\* runs on open ground.
- Before this, no measurement of tick cost existed in the repository.

## 3. Organisation and hierarchy

**Templates.**

- `src/exercise/organization.ts` holds the versioned template schema (v2): roles, units (echelon, parent, leader slot) and slots (unit, role, label).
- `instantiateOrganization` turns a template into scenario units and soldiers.
- `src/exercise/organizations/usmc-rifle-squad-mcwp-3-11-2.json` is the 13-Marine squad: `SQD` (leader slot `SL`) and `FT1`–`FT3` (echelon `fireTeam`), each with `FTL`, `AR`, `AAR`, `R`. `squadInstance()` gives soldier ids `M01`–`M13` in slot order.

**In the simulation.**

- `OrgUnit {id, echelon, parentId, leaderId}` is structure only.
- A soldier belongs to his immediate unit (`Soldier.unitId`). The squad leader's unit is `SQD`; fire-team members are in `FTn`.
- Echelons are free strings, and nothing in the kernel depends on them.

**Other organisations.**

- `TEST_PAIR_TEMPLATE` (2 people), a synthetic six-person patrol (`test-data`).
- OPFOR `patrol-3`: three soldiers, unit `EN-TM`, echelon `fireTeam`, 12 m spacing.
  - OPFOR's "formation" is a file laid out at the start (`scenario-definition.ts:258-283`). Every OPFOR soldier then gets **its own copy of the same waypoints**. Spacing holds only because they walk at the same speed. This is the simplest possible group movement and the first thing the engine can replace in the lab.

**Consequence.**

- The hierarchy the engine needs (platoon → squad → fire team → individual) is already representable: `OrgUnit` with parents and leaders.
- No platoon template exists yet. Adding one is data, not code, provided the engine treats echelons generically.

## 4. Formations today (ADR 0022, `src/exercise/formation.ts`)

**What they are.**

- Formations exist only while planning. The only shape is a **line**: `lineSlotOffset(i, n, s) = (i − (n−1)/2)·s` metres to the right of the facing, with a default spacing of 10 m.
- `placeFormation` and `moveFormation` write one destination per Marine. Slots in buildings or water are nudged with `nearestClearPoint`; otherwise the whole placement is refused.
- Formation metadata is not saved and not simulated. On commit, each Marine becomes one `setOrders` with one waypoint and a final facing.

**Consequence.**

- These are _deployment_ formations: where to stand at the end. The engine adds _movement_ formations: how to travel.
- The two should share slot-geometry code. `lineSlotOffset` becomes one template among several (see [03 §6](03-architecture-proposal.md#6-formations-slots-and-templates)).

## 5. Individual movement (`src/sim/movement.ts`, ADR 0008)

**Per tick, for each soldier with orders** (`moveSoldiers`, in soldier order):

- While `moving`, the target is the next turn point or waypoint.
- The soldier moves in a straight line at `speed` and is placed **exactly** on the target when it can reach it within the tick. Only the time used is consumed, so several points can be passed in one tick. This "arrival splitting" is what makes movement tick-rate independent (ADR 0008: agreement to 5e-11 m across rates).
- Facing turns toward the direction of travel at `maxTurnRate`. It does not steer the path, so a soldier can briefly move sideways after a sharp turn.
- After the last waypoint the behaviour becomes `facing` (turn to `finalFacing`), then `inPosition`.
- Height: z comes from `surfaceHeightAt`, interpolated along bridge decks between deck points.

**Gaps that matter here:**

- No velocity state: only position and facing.
- No acceleration; speed is constant.
- No collision or separation between soldiers; overlap is allowed (ADR 0008, deferred).
- No slope-dependent speed (deferred, with a warning that it would need an analytic solution to stay tick-rate independent).
- No posture-dependent speed: crawling moves at walking pace in the simulation.

## 6. Navigation and pathfinding (`src/sim/navigation.ts`, ADR 0011, 0016, 0043)

**Obstacles.**

- Buildings (with 0.75 m clearance) and impassable standing water are hard obstacles.
- Vegetation does not block movement. Waterways mapped as lines are wadeable. Slope is not a cost.
- `pointProblem` reports `offTerrain`, `insideBuilding`, `tooCloseToBuilding` or `inWater`.

**Grid.** `NAV_CELL_M = 2`, built once per terrain and cached in a WeakMap. Connected areas are labelled once, so unreachable goals are reported in under 1 ms.

**A\*.**

- 8-connected with an octile heuristic and no corner cutting.
- A typed-array heap ordered by (f, h, cell index), so **ties are broken deterministically**.
- Bridges are portal links whose cost is at least the octile distance, so the heuristic stays admissible.
- Start and goal connect to the nearest free cell within 3 cells.

**Smoothing.** `stringPull` is greedy line-of-sight pulling. There is no curve smoothing; the result is a polyline of turn points.

**Roads.** `planRoadPath` (ADR 0043) runs Dijkstra on the OSM road graph, joining and leaving roads at the nearest edges. It is used only with `followRoads` (OPFOR).

**Caching.**

- `planPath` keeps an LRU of 256 paths per terrain.
- The straight segment is tried first: if `isSegmentWalkable`, no search runs.

**Cost** (ADR 0016, 0043):

- About 1 µs per expanded cell.
- Typical legs take a few to 30 ms. Long cross-map paths on 5 km battlefields take 0.3–0.9 s.
- Road routes take 16–60 ms.

**Consequences.**

- One route per _group_ is affordable when an order is given.
- Re-running full A\* for each of 13 Marines at every tick is not, and is unnecessary.
- A bounded or local search for followers (a few hundred cells) costs well under 1 ms.
- The grid has no **clearance (distance-to-obstacle) field**. A formation-aware route and corridor width need one. It is a one-pass distance transform over the existing grid (see [03 §7](03-architecture-proposal.md#7-routes-corridors-and-obstacles)).

## 7. Existing behaviour logic

**Movement.** `ActiveOrders.behavior` is `moving`, then `facing`, then `inPosition`.

**Combat** (`src/sim/combat.ts`, ADR 0019, 0028).

- `CombatBehavior` is one of `engaging`, `awaitingReaction`, `prone`, `fleeing`, `escaped` or `incapacitated`, stored in `engagement.combatants`.
- OPFOR not under fire flee. They search seven headings in order for a valid destination, then write their orders directly at 4.5 m/s. Under fire, they take a reaction drawn at the start.
- Actions are processed in exact time order within the tick, after movement.

**Consequences.**

- There is no behaviour framework, blackboard, behaviour tree or planner to integrate with or replace.
- The flee logic shows the pattern the engine should follow: a system that writes ordinary `Soldier` state inside the tick, using the seeded random numbers.

## 8. Coordinates (ADR 0002)

**Simulation.**

- Metres, X east, Y grid north, Z up. Plans use `MapPoint {east, north}`.
- Azimuth is radians clockwise from north, in [0, 2π). Direction is `(sin a, cos a)`; `azimuthOf(dx, dy) = atan2(dx, dy)`.

**three.js.**

- Only `src/view3d/axes.ts` knows Y-up: `toThree(x, y, z) = (x, z, −y)`, `yawOf(azimuth) = −azimuth`.
- Characters are placed with `root.position.set(x, z, −y)` and `rotation.y = π − azimuth` (`characters/character.ts:161`).

**For the engine.** Formation frames are (forward, right) in map metres. Forward is `(sin a, cos a)` and right is `(cos a, −sin a)`, as `formation.ts` already uses.

## 9. Rendering and animation

**2D view** (`src/view2d`).

- Draws `exercise.simulation.state` at the latest tick, without interpolation.
- Overlays are drawn in a fixed order (`render.ts:553`). `MapEditor.draw(ctx, toScreen)` is the hook for custom drawing.

**3D view** (`src/view3d/view.ts`).

- Takes an `Exercise`.
- Exposes a 2D overlay canvas (`setOverlayPainter`), a ground raster overlay (`setGroundOverlay`), picking through `groundProjection`, and debug hooks on the canvas: `ambushSetView`, `ambushProject`, `ambushDebug`, `ambushCharacters`, `ambushCapture`, `ambushBenchCharacters`.

**Characters** (ADR 0052, `src/view3d/characters`).

- The pose is a function of (motion log, combat log, time).
- The **motion log** (`src/exercise/motion-log.ts`) records x, y, z, azimuth, posture, status and combat behaviour per soldier per tick.
- `SoldierMotion` derives everything else:
  - interpolated position and facing;
  - speed and `moveAngle` (travel relative to facing, so strafing and walking backward appear when facing differs from travel) over a 0.3 s window;
  - turn rate;
  - posture and carry transitions.
- The locomotion blend covers idle, walk, run and sprint forward, walk back, left and right, kneel-walk and crawl. There are no running strafe or backward clips.
- Measured clip speeds: walk 0.74 m/s, run 4.4, sprint 6.5. The game's 1.5 m/s blends walk and run.

**Consequences.**

- **The engine needs no animation interface.** It produces positions, facings and postures per tick, as today. Speed variation, strafing, turns on the spot and stops all appear in the characters automatically.
- Smooth speed changes (no step changes at 30 Hz) matter more than before, because the 0.3 s window will show any stutter.
- `bench.ts` already builds a synthetic motion log (`createMotionRecorder(rate).record({tick, soldiers})`) and plays it through the real character layer. A lab can do the same with the real simulation's states.

## 10. Exercise, runner and replay

**Runner.** `createFixedStepRunner` (`src/exercise/runner.ts`) counts pending time in whole ticks.

- Its catch-up budget is 100 ms; anything beyond it is dropped and reported.
- It has `alpha` for interpolation, pause and resume, and never reads a clock.
- Headless code uses an infinite budget.

**Exercise** (`src/exercise/exercise.ts`).

- Owns the simulation, the phases, the motion log and the recording.
- Turns plans into `setOrders` commands.
- Exposes the simulation read-only.

**Replay** (ADR 0026).

- A full state is recorded per tick from 5 s before the trigger to the end of the engagement.
- The replay view is a proxy over recorded frames and never steps the simulation.

**Consequences.**

- The lab can reuse the runner as is.
- Behaviour state (formation, anchors, slot assignments, task status) must be in `SimState`, both to be recorded and to be hashed.
- The per-tick full-state recording copies everything. A large behaviour state (one route per group) must be shared by identity, as `legPaths` already is, so the recording stays small.

## 11. Testing and tooling

**Commands.** `npm run check` runs typecheck (`tsc -b`), lint, tests and the format check; `npm run build`; `npm run sim:headless` runs the simulation without a view.

**Determinism tests.**

- `src/sim/determinism.test.ts`: pinned hashes, same seed gives the same state, snapshot/restore round trip, world compatibility.
- `movement-tick-rate.test.ts`: the same motion at several rates.
- `runner.test.ts`, `replay.test.ts`, `motion-log.test.ts`.
- `src/view3d/characters/replay.test.ts`: live and replayed poses equal at tolerance 0.

**Conventions.**

- No global test timeout; heavy tests set their own.
- Opt-in benchmarks use `describe.skipIf(env var missing)` (precedent: the terrain-lab `bench.cli.test.ts`, `git show f236c21`).

**Visual checks.** Playwright scripts outside the repository drive the dev server through the canvas hooks. The Feedback button saves screenshots and state to `assets/reference/`.

## 12. Precedents for an isolated lab

**The terrain lab** (ADR 0047; commits `f236c21` and `1b3cffb`; removed in `2fb59eb` when it was adopted).

- Code in `src/sim/terrain-lab` (headless) and `src/view3d/terrain-lab` (page), behind their own aliases and not re-exported.
- Reached by `main.ts` through a hash guard and a dynamic import.
- Terrain supplied by the app through a small source interface.
- An **isolation test** (`src/app/terrain-lab-isolation.test.ts`) asserted that only `main.ts` mentions it, and only through the dynamic import.
- This is the pattern the Behavior Lab should follow ([04](04-behavior-lab-design.md)).

**The character prototype** (`prototypes/character-animation`).

- A separate Vite app with its own mini-simulation.
- Right for comparing third-party runtimes; wrong for this lab, which must run the real simulation.

## 13. Reuse, extend, refactor or replace

| Part                                                                 | Decision                                                                                                | Why                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Kernel, commands, events, hashing, snapshots, random numbers, runner | **Reuse**                                                                                               | They already give the guarantees the engine needs.                     |
| `OrgUnit` hierarchy and organisation templates                       | **Reuse**, extend with platoon templates (data)                                                         | Already generic.                                                       |
| `planPath`, grid, A\*, string pulling, bridges, roads                | **Reuse** for group routes                                                                              | Deterministic and tested. One query per group per order is affordable. |
| Navigation grid                                                      | **Extend** with a clearance field and a bounded local search                                            | Corridor width and follower targets need them.                         |
| `formation.ts` slot geometry                                         | **Refactor** into shared formation templates                                                            | Planning and movement should share shapes.                             |
| `moveSoldiers`                                                       | **Extend**: soldiers driven by the engine take a steered, velocity-based path; the others are unchanged | Existing waypoint movement stays exact and stays the default.          |
| `Soldier` state                                                      | **Extend** with optional velocity and behaviour fields                                                  | Steering needs velocity; the AAR needs the state.                      |
| Motion log, characters, both views                                   | **Reuse unchanged**                                                                                     | They consume positions and facings only.                               |
| OPFOR per-soldier copied waypoints                                   | **Replace later** with a fire-team order (not in the first milestone)                                   | It is the simplest real user of the engine, once proven.               |
| Combat react/flee                                                    | **Keep**                                                                                                | It is out of scope; it will later become a behaviour.                  |
