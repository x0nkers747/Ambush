# Constructive simulation 04: Combat

- Status: implemented (Milestone C, 2026-10-15)
- Part of: [Constructive simulation](README.md)
- Code: `src/app/battle/session.ts` (the battle session), `combat.ts` (the
  stage without the page), `combat-editor.ts` (the map), `combat-panel.ts`
  (the side panel), `page.ts`

## 1. The stage

Continuing from BLUEFOR Planning (once nothing blocks the scenario) starts a
battle: `createBattle` with the scenario's squads, plans and seed, at 30 Hz.
The battle starts paused.

| Control                                 | Effect                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Play / Pause, Space                     | Runs or stops the clock                                                                                       |
| ½× to 32×, + and −                      | Speed                                                                                                         |
| Click a squad (map, 3D or roster)       | Select it, either side                                                                                        |
| M, A, W (or the buttons), then click    | Order the selected squad there: Move, Attack, Withdraw                                                        |
| Replace plan / Append, Shift            | Whether the order replaces the squad's orders or follows its pending ones; Shift does the other for one click |
| Click an enemy squad with an order tool | The order's destination is that point (an attack on it), not a new selection                                  |
| Hold, H                                 | Clear the squad's orders: it holds where it is                                                                |
| End combat (button or the primary)      | After asking: the battle ends for good and the review opens                                                   |

**Orders** are `orderSquad` commands
([02](02-orders-and-plans.md#4-the-ordersquad-command)):

- Each is given now and applied at the next tick, in the order given.
- Orders given while paused are shown queued (dashed white on the map,
  "queued" in the squad's list), and apply in turn when play resumes.
- A destination in water or a building is moved clear, with a message. One
  off the map is refused.
- A combat-ineffective squad can still be ordered, while it has soldiers
  left: it carries out the order, and stays counted as ineffective (its
  reason says so). One with nobody left refuses it, and the page says so.

**No automatic end.** The battle runs until the user ends it. While it
runs, the header's Previous arrow and earlier stages still work: the battle
is paused and the user asked whether to discard it ("Discard battle"), and
leaves only if they agree. After
it ends, the review cannot go back into the ended battle; going back to
BLUEFOR Planning fights a new one.

## 2. What is shown

- **Map, 2D and 3D, through the same editor:**
  - Every soldier where the battle has him at the time drawn, interpolated
    between ticks from the motion log; casualties are grey crosses.
  - Each squad's symbol at its active soldiers' centre, with its name and
    its active and total soldiers, ringed while in contact.
  - Each squad's active and pending orders as numbered, typed waypoints;
    queued ones dashed white.
  - The bursts of the last 0.6 s, from shooter to aim point (aimed fire
    solid, area fire dotted).
- **In 3D,** the soldiers are characters posed from the battle's motion and
  combat logs (`ViewFigures`).
- **The selected squad:**
  - its state: what it is doing, in a word, and why (below); soldiers
    active; effectiveness;
  - its active order and what follows;
  - every order it was given, with each one's status and reason.
- **The roster by force:** each squad's active soldiers and what it is doing
  (the reason in its tooltip).
- **What a squad is doing:** a word after its name and count, on the map
  ("Enemy squad 1 · 8/13 · Regrouping"), in the roster and in the squad
  panel, with the reason in the panel. It comes from the squad's phase,
  refined by its order, its actions on contact and its state
  (`activityOf`, `src/app/battle/status.ts`):

  | Word                   | When                                                                                       |
  | ---------------------- | ------------------------------------------------------------------------------------------ |
  | Moving, Advancing      | On a Move (or to an ambush position), on an Attack order                                   |
  | Pressing on            | On Continue, nothing to engage where it halted: moving on, firing as it goes               |
  | Observing              | Halted to look at a possible enemy                                                         |
  | Reacting, Engaging     | In contact, taking cover; exchanging fire                                                  |
  | Attacking              | Assaulting by fire and movement                                                            |
  | Withdrawing            | Breaking contact (spent, or avoiding contact), or on a Withdraw order                      |
  | Regrouping             | Contact lost and recovered: it resumes its order shortly                                   |
  | Recovering             | Contact lost or broken, still suppressed: it resumes once that wears off                   |
  | Spent                  | Its losses leave it too weak to go on (lasting effectiveness under 50 %): waits for orders |
  | Holding                | On Hold, after an ambush, on its objective, or with no more orders                         |
  | Deploying, Waiting     | Occupying its ambush position; concealed, watching its kill zone                           |
  | Withdrawn, Ineffective | Out of the fight                                                                           |

- **The event log:**
  - orders started, completed, failed and superseded;
  - phase changes, with their reasons (contact, under fire, assaulting…);
  - casualties;
  - refused orders.
- **The After-Action Review:** the battle replayed from tick 0 and
  verified ([05](05-after-action-review.md)).

## 3. The session

`createBattleSession` steps the battle on the page's thread. It records:

- every command, with its origin (setup or user);
- a snapshot every 5 s (keyframes);
- `hashSimState` every second; in a battle of more than 100 soldiers, only
  at each keyframe (the hash takes over 100 ms at 988 soldiers), the seconds
  between recorded as `null` and not checked on replay;
- every soldier's motion;
- the events shown.

A battle's movement is integrated at 30 Hz (`BATTLE_SUBSTEP_HZ`, in the spec
`battleSpecOf` makes), as in the Force-on-Force Lab's large runs: the same
results in distribution, a quarter of the movement engine's work. Battles
recorded before it keep their own rate (120 Hz, the default) when replayed.

`recording()` gives the spec, the commands and the hashes. The same spec,
terrain and commands give the same battle tick for tick (tested: a battle
with a mid-battle order, replayed from its recording, gives every
per-second hash again). The After-Action Review replays the battle this way
from tick 0 ([05](05-after-action-review.md)).

The clock moves by real time × speed while playing, never by more than
0.25 s of real time per frame (a hidden tab is not caught up). The battle
steps whole ticks up to the clock, for at most 30 ms per frame. The time
drawn is never ahead of the battle.

## 4. Performance on real ground

On a real battlefield, movement first cost about 10 ms per tick for four
squads (52 soldiers): Quantico, with 1,271 buildings and the Potomac's
shoreline polygons. Two hot spots were taken out. Both give the same
answers as before, so every run is unchanged:

1. **Large polygons**, such as a river or shoreline with thousands of
   vertices, are tested on horizontal bands of their edges
   (`polygonBands`). The tests are point-in-polygon, and a segment's
   clearance of a polygon. Only edges that reach the point's height, or
   the segment's reach, can change the answer.
   - Tested against the whole scan on 10,000+ points (vertices, edge points,
     band boundaries, horizontal edges) and 3,000 segments.
2. **A formation slot in an obstacle** looked for the nearest point of its
   navigation area on rings 0.5 m apart, up to 30 m, point by point
   (`nearestInArea`). Rings nearer than the area's nearest cell are now
   skipped, and the search stops at once when no cell of the area is within
   30 m.
   - Tested against the full search on 3,000 points round buildings, a pond
     and a walled yard.

Result: **0.5 ms per tick** (from 10), and 32× real time keeps up with
about a fifth of the page idle. The 3D view draws at 60 fps while the battle
runs at 8×. Benchmarks at 2, 6 and 12 squads, and the further optimizations of Milestone D, are in [05](05-after-action-review.md#5-benchmarks).

## 5. The battle worker

Battles are simulated in a background worker (`battle.worker.ts`,
`battle-host.ts`), so the page draws at full frame rate whatever a battle
costs.

**The two sides.** Combat and the review read a battle through a driver
(`driver.ts`): the battle simulated here (`createLocalDriver`, used by the
tests and where workers are not available), or in the worker
(`createWorkerDriver`, `worker-combat.ts`).

**Sending.** The page sends the worker the battlefield's terrain once, when
the first battle starts; it is plain data, cloned. The worker steps the
battle toward the tick of the page's clock, in slices of 16 ms. After each
slice it posts:

- the soldiers' frames: per tick and soldier, position, facing, posture and
  status;
- the events;
- the per-second state hashes;
- the keyframes;
- the squads' states;
- the commands it has applied, with their ticks.

**The page's side.** The page keeps a mirror of the battle: the frames as a
motion log (`frame-log.ts`), and the events, hashes, keyframes and squads
as last posted. It draws whatever has arrived and never waits. Orders show
queued until the worker says it has applied them.

**Exactness.** The worker's battle is the page's, tick for tick. A test
fights the same battle both ways, with orders given live (some while
paused). The commands, ticks, per-second hashes, events, squads and every
soldier's motion are equal.

**The review.** Its replay runs in the worker too. Its seeking restores the
worker's keyframes in a battle on the page, which is possible because the
world is the same in both (same terrain, same fingerprint).

**On Quantico, with 12 squads:** 60 fps in 2D and 3D at every speed. The
battle runs as fast as one core can simulate it, about 10–13× real time
(2.9 ms per tick, most of it detection's sight lines). The panel gives the
speed achieved when it is less than the speed asked. A 400-second battle is
replayed and verified in the worker in about 50 s.
