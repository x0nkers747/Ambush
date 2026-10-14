# ADR 0052: Animated soldiers in the 3D view

- Status: Accepted
- Date: 2026-10-14
- Builds on:
  - [ADR 0026](0026-aar-replay.md) (the review's recording);
  - [ADR 0029](0029-3d-view-milestone-1.md) (the 3D view's soldiers);
  - the [framework evaluation](../character-animation-framework-evaluation.md) and the
    [recommended architecture](../character-animation-recommended-architecture.md).

## Context

The 3D view drew each soldier as a coloured figure. The animation evaluation chose three.js's
own animation system, used as a sampler at explicit times. The prototype
(`prototypes/character-animation`) was approved: the Rocketbox soldier, its clips, the
procedural weapon hold, hands, prone and sighting. Animated soldiers must reproduce exactly in
the After Action Review, at any speed and in any seek order.

The review's recording starts at TRIGGER AMBUSH. The 3D view had no time of its own: it showed
the latest tick.

## Decision

1. **Motion log.** The exercise records every soldier's position, azimuth, posture, status and
   combat behaviour at every tick from its start. This is `MotionLog`, a compact append-only
   store. It is the characters' only input besides the combat log's shot and incapacitation
   times. The simulation and its recording are unchanged.
2. **Render time.** `Exercise.renderSeconds` is one tick behind the simulation plus the
   runner's `alpha` while it runs, so motion is interpolated between recorded ticks. The review
   gives its replay time (fractional) and the whole logs.
3. **pose = f(motion log, combat log, time, clips).**
   - Speed and direction come from the positions over a 0.3 s look-back; the gait phase comes
     from distance over cycle distance.
   - Posture and carry transitions start at the tick where they changed.
   - Recoil and falls are timed from the combat log's times.
   - Facts about settled ticks are memoised; nothing accumulates frame time.
4. **The prototype's native runtime and procedural layer are ported** to `src/view3d/characters/`.
   The animouse runtime is not. The clips are baked from the prototype (`clips.json`), so the
   game has no retargeting at run time and no 13 MB clip libraries.
5. **Exactness** means the same numbers, bit for bit: root, bones, weapon, clip weights and
   times. Tests compare complete pose fingerprints. Two three.js mixer details are handled to
   achieve it (`animator.ts`).
6. **Sides.**
   - OPFOR wear a tinted uniform.
   - Team colours move to a small indicator over each head.
   - Selection is unchanged: picking goes through the shared 2D controller.
7. **Aftermath.** After the timeline ends, the soldiers' animation runs on for up to 2 s, so a
   fall completes. This applies past the recorded timeline only, and positions stay put.

## Consequences

- The review and live play show the same poses at the same times. Seeking anywhere, at any
  speed, reconstructs the pose without replaying history.
- 16 soldiers cost about 3.4 ms of CPU per frame. 50 soldiers drop below 60 fps on an
  integrated GPU. Instancing and pose sharing can follow without changing the interface.
- The motion log grows by 35 bytes per soldier per tick: about 2 MB for 16 soldiers over an hour.
- Details, measurements and limitations: [character-animation.md](../character-animation.md).
