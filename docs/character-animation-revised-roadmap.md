# Character animation: revised roadmap

- Status: **M0 and M1 done** (2026-10-14, with combat and the After Action Review; see
  [character-animation.md](character-animation.md) and [ADR 0052](adr/0052-animated-soldiers.md)).
  The rest is a plan. Supersedes [character-animation-roadmap.md](character-animation-roadmap.md).
  Based on the [framework evaluation](character-animation-framework-evaluation.md), the
  [prototype results](character-animation-prototype-results.md) and the
  [recommended architecture](character-animation-recommended-architecture.md). Date: 2026-10-14.
- Principle: **a visually convincing vertical slice in the real game first**, framework-free;
  generalise only what the slice proves necessary.
- Effort in engineer-weeks for one experienced TypeScript/three.js engineer [estimate]. Every
  milestone ends with `npm run check`, the production build, a browser check, and (from M1) the
  determinism test passing on real recordings.

The work is split into five tracks that can proceed in parallel where marked:

| Track               | Content                                                             |
| ------------------- | ------------------------------------------------------------------- |
| **A. Assets**       | licensing decision, clip set, soldier model pipeline                |
| **R. Runtime**      | the view3d character layer (sampling, weights, hold, IK)            |
| **I. Integration**  | Ambush! view, exercise and review wiring                            |
| **G. Gameplay**     | simulation features that change outcomes (posture, aim, ammunition) |
| **F. First person** | camera, player soldier, arms                                        |

---

## Decision gate (before M1)

1. **Clip licensing** for a public repository: (a) open assets only (Rocketbox + UAL/Mesh2Motion +
   procedural rifle handling; what the prototype shows), (b) Mixamo kept in a private asset store
   merged at build time, or (c) a purchased web-redistributable rifle/prone set or a capture
   session. Recommendation: start with (a) for M1–M2, decide (b)/(c) by M3.
2. **Budget** for clips (rifle, prone, M249) and a soldier model upgrade (uniform era).
3. **Gameplay changes** in track G (they alter combat outcomes and need their own ADRs).

---

## M0 — Render interpolation (track I, 1 week)

- **Deliverables:** `Exercise` exposes the previous and current tick and `alpha`; the review gains
  fractional frame times; today's markers move smoothly.
- **Acceptance:** at 1×–16× and in the review at 0.25×, marker positions equal the simulation's at
  α = 0 and α = 1 within 1 mm; state hashes unchanged; no allocation per frame in the interpolation
  path.

## M1 — Vertical slice: one squad of riflemen in the real 3D view (tracks R + I, 3 weeks)

- **Deliverables:** `src/view3d/characters/` ported from the prototype (pose input, gait clock,
  locomotion weights, native animator, canonical masks, weapon hold, two-bone IK, head look);
  Rocketbox soldier with M16 stand-in replacing markers within 60 m (markers beyond); a
  `GROUND_CONTACT`-aware offline retarget build step (`tools/characters/`) producing GLB clips;
  materials merged (13 → ≤ 2 draw groups); a `?characters=off` switch.
- **Uses only today's simulation state** (position, azimuth, posture, status, shots): no gameplay
  changes. Missing state (carry, aim pitch, reload) uses defaults derived from orders and shots.
- **Acceptance:**
  - Determinism: the prototype's 10-pass test on a recorded exercise — every bone exact (≤ 0.01°,
    ≤ 0.1 mm) at 15 times, live and in the review, at 1×, 16× and 0.25×, including scrubbing
    backward.
  - Quality: planted-foot slide ≤ 40 cm/s mean when walking and running (prototype: 28–36);
    both hands within 2 cm of the rifle sockets standing and kneeling.
  - Performance (integrated Radeon 880M, quality "high"): the 16-soldier scenario at ≥ 60 fps with
    vsync, animation CPU ≤ 2 ms per frame; no frame over 50 ms while soldiers appear.
  - Layering: no three.js or clock use outside `view3d`; lint and boundaries tests pass.

## M2 — Movement fidelity (tracks G + R, 3 weeks)

- **G:** simulation state from the earlier proposal §4 — velocity with acceleration, odometer,
  posture-change windows, weapon carry and its change window, aim azimuth/pitch, last-shot time,
  reload window; speed classes. All optional fields (hashes unchanged without them); ADR.
- **R:** posture transitions on the simulation windows; carry blends; spine aim; recoil and muzzle
  flash; death blend; turn-in-place stepping; foot IK on terrain and bridge decks.
- **Acceptance:** determinism as M1; prone and kneel transitions take exactly the simulation's
  durations (± one frame); foot IK keeps both feet within 3 cm of the ground on 15° slopes; starts
  and stops without visible snapping at 0.25× in the review [reviewed against screenshots].

## M3 — Clip set (track A, 2–6 weeks depending on the gate decision; can start at M1)

- **Deliverables:** the chosen rifle/prone set retargeted to the canonical skeleton offline; clip
  metadata (speed, foot contacts) generated; prone idle and stand↔kneel↔prone transitions on the
  stomach; one-knee kneel; rifle reload; 8-way rifle locomotion at walk and run; M249 handling if
  available (else the placeholder hold with M249 sockets, labelled).
- **Acceptance:** every clip slot of the prototype's coverage table filled or explicitly waived;
  licence record per file in `CREDITS.md`; strafe/diagonal slide ≤ 50 cm/s mean (prototype: 145).

## M4 — Scale (track R, 2 weeks)

- **Deliverables:** distance bands (near: full; mid: animation every 2nd–4th frame, no IK, no shadow
  casting; far: shared pose slots + `@three.ez/instanced-mesh`, or markers); progressive character
  creation; post-processing without per-frame allocation.
- **Acceptance (measured with the prototype's benchmark runner on the game scene):** 100 visible
  soldiers on the integrated GPU at ≥ 60 fps with vsync on the representative battlefield; ≤ 300
  draw calls for characters; animation CPU ≤ 4 ms per frame.

## M5 — Gameplay that uses posture and aim (track G, 2–3 weeks; independent ADRs)

Posture-dependent line of sight and target heights, aim and firing arcs, ammunition and reloads.
**Acceptance:** combat tests updated with new expected outcomes; determinism of the simulation
(state hashes per scenario) unchanged where the features are off.

## M6 — First person (track F, 3–4 weeks; after M2)

First-person camera mode on the player soldier's head/aim frame; a first-person arms rig driven by
the same weapon profiles and IK; sway, bob, aim-down-sights; full body for shadows. **Acceptance:**
weapon sight line within 0.5 mrad of the simulation's aim direction; no near-plane clipping of the
weapon; 60 fps on the integrated GPU.

---

## What changed from the previous roadmap

- No phase for a general animation framework, state machine or blend-tree library: the runtime is
  three.js plus Ambush!-specific weights (prototype: ~480 lines).
- The prototype already answers the earlier "phase 1 proof of concept"; the next step is
  integration (M1), not another standalone page.
- Assets are a separate track with their own decision, because clips — not code — now limit
  quality.
- Performance work (M4) is evidence-driven: the prototype measured where time goes.
