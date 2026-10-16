# Constructive simulation 05: After-Action Review, verification and benchmarks

- Status: implemented (Milestone D, 2026-10-15)
- Part of: [Constructive simulation](README.md)
- Code: `src/app/battle/review.ts` (the review without the page),
  `review-panel.ts`, `status.ts`, `page.ts`; tests `review.test.ts`,
  `reference.test.ts`, `benchmark.test.ts`

## 1. Replayed from tick 0, and verified

End Combat hands the battle's recording to the review. The recording holds:

- the spec: squads, plans, seed and tick rate;
- every command, with its origin;
- the state hash of every second (of every keyframe, every 5 s, in a battle
  of more than 100 soldiers).

Nothing of the live run is taken on trust. The review steps the real
simulation again, from tick 0, with the recorded commands (the replay). It
compares each second's state hash with the recording's as the replay
reaches it.

The panel says how far the replay has got. Then it says either "Replayed
from its start and verified: all N seconds match the battle fought", or,
should a second differ, from when, in red.

The replay runs in the background, at most 10 ms (3D) or 16 ms (2D) of each
frame. Everything replayed so far can already be reviewed. On Quantico, a
400-second battle of 12 squads is replayed and verified in about 50 s of
real time.

## 2. The playhead

- **What is drawn.** The review shows the battle at the playhead:
  - the soldiers from the replay's motion log, interpolated, as in Combat;
  - the squads from a second battle (the view), brought to the playhead's
    tick. It steps on from where it is, or restores the replay's last
    keyframe before the tick and re-simulates from there. Keyframes are
    every 5 s, so a seek costs at most 5 s of simulation.
- **Moving the playhead:**
  - play and pause, at ¼× to 16×;
  - ±5 s, the start and the end;
  - the previous or next marker;
  - dragging or clicking the timeline;
  - clicking a marker, a key moment, a phase or an event.
- **Exactness, tested:** at any second, forward or back, the view's state
  hash is the recording's for that second.

## 3. The timeline and inspection

- **The timeline** shows the battle's length, how much of it has been
  replayed, and its markers, coloured by side:
  - contact (a squad's phase becoming `contact`);
  - casualties;
  - squads becoming combat ineffective or withdrawn;
  - the user's orders: every `orderSquad` with origin `user`, replacing,
    appending or holding.
- **Key moments** lists the markers, other than single casualties, in time
  order, each a seek.
- **Inspection** of a squad (click it on the map, in 3D or in the roster),
  at the playhead:
  - its phase, soldiers active and effectiveness;
  - its active order and what follows;
  - every order it was given, with its status and reason then;
  - its phases so far, each with its reason and a seek to it.
- **The roster** shows every squad's strength and phase at the playhead.
  The event log shows the events up to it, each a seek.
- **Result:** each side's squads, soldiers, casualties and ineffective
  squads at the end; the orders given, completed and failed.
- **Export recording** downloads the recording (JSON). It reproduces the
  battle exactly: a test replays a recording after a JSON round trip, and
  every hash matches.

## 4. The reference battle (3 v 3)

`src/app/battle/reference.test.ts` makes, fights and reviews a battle end
to end through the same planner, combat and review as the page:

- **Setup.** Three OPFOR squads round a hamlet of four houses, placed with
  the place tool, two of them with plans. Three BLUEFOR squads to the south.
- **Planning.** B1 attacks the hamlet; B2 moves up, then attacks; B3 has no
  plan.
- **Combat.** Fought for 15 minutes at 32×:
  - O2 is ordered south-east at 1:00;
  - at 2:00, while paused, B3 is sent up the east with an attack appended,
    and B1's attack is replaced;
  - O3 is told to hold at 6:40;
  - the user ends the battle at 15:00.
- **Checked:**
  - the squads meet and engage, more than 50 bursts are fired and soldiers
    fall;
  - orders are superseded, canceled, failed and still active;
  - combat-ineffective squads have no orders left;
  - five user orders are recorded, and none is refused;
  - the battle did not end by itself;
  - the replay, from the recording as exported, verifies all 901 seconds,
    and gives the same result;
  - the view's hash equals the recording's at the start, at each order, at
    first contact and at the end;
  - B3's orders at 2:10 are the player's move and attack;
  - O3's last order ends canceled.

## 5. Benchmarks

`AMBUSH_BATTLE_BENCH=1 npx vitest run src/app/battle/benchmark.test.ts --silent=false`
runs battles of 2, 6 and 12 rifle squads (half a side, 800 m apart, each
attacking across) on the lab's open ground and in its urban district.

Each battle is fought for 600 s through the battle session, as Combat
fights it: keyframes, state hashes, motion and events recorded.
Then it is replayed from its recording and verified, as the review does.

Results on the development machine (Node, one core, 2026-10-15):

| Squads | Ground | Soldiers | ms/tick | p95   | × real time | Casualties | Bursts | Snapshot | Hash ms | Replay & verify |
| ------ | ------ | -------- | ------- | ----- | ----------- | ---------- | ------ | -------- | ------- | --------------- |
| 2      | open   | 26       | 0.106   | 0.235 | 316×        | 13         | 1060   | 39 KB    | 0.50    | 1.7 s (353×)    |
| 6      | open   | 78       | 0.295   | 0.536 | 113×        | 43         | 3039   | 153 KB   | 1.77    | 5.3 s (113×)    |
| 12     | open   | 156      | 0.756   | 1.517 | 44×         | 86         | 7014   | 463 KB   | 7.25    | 14.0 s (43×)    |
| 2      | urban  | 26       | 0.109   | 0.280 | 307×        | 8          | 298    | 35 KB    | 0.64    | 2.0 s (298×)    |
| 6      | urban  | 78       | 0.451   | 1.086 | 74×         | 36         | 2084   | 148 KB   | 1.77    | 8.6 s (70×)     |
| 12     | urban  | 156      | 0.957   | 2.225 | 35×         | 77         | 3922   | 396 KB   | 5.11    | 18.2 s (33×)    |

Every replay verified with no mismatch.

**In the browser on real ground** (Quantico, 5 × 5 km: 1,271 buildings, the
Potomac's shorelines), 12 squads cost about 2.5 ms per tick. Detection's
sight lines over buildings and vegetation are the largest part, about 45%.

| View | Speed asked | Frame rate | Speed achieved |
| ---- | ----------- | ---------- | -------------- |
| 2D   | 32×         | 52 fps     | about 20×      |
| 3D   | 32×         | 58 fps     | about 10×      |
| 3D   | 8×          | 60 fps     | 8×             |

The battle steps for at most part of each frame (10 ms in 3D, 16 ms in 2D),
so the view keeps drawing smoothly. When the speed asked is more than the
battle can be simulated at, the panel says so and gives the speed achieved.
Two squads on Quantico keep up at 32×.

**Optimizations made for real ground**, in Milestones C and D:

1. **Edge bands for large polygons.**
2. **A shorter nearest-in-area search.**
   - Milestone C made it skip rings nearer than the area's nearest cell.
   - Milestone D measures that distance once per grid cell, as a lower
     bound, instead of per point.
   - The rings' points are precomputed with the very same expressions.
3. **A clear-radius field for obstacle tests.**
   - Per 4 m cell, measured exactly the first time it is needed, it records
     how far every point is clear of buildings (with their clearance) and
     of water.
   - A point, or a short segment, strictly within it needs no obstacle test.

All three change no answer: they skip only work whose result is known.
Equivalence tests compare them with the full tests on tens of thousands of
points and segments (`src/sim/polygon-bands.test.ts`,
`src/sim/behavior/nearest-in-area.test.ts`). The benchmarks' casualty and
burst counts are the same before and after them.
