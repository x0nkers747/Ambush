# ADR 0039: Complete 2D/3D functional parity

- Status: Accepted
- Date: 2026-10-11
- Builds on ADR 0004 (session state), 0019 (combat display), 0022 (fire-team formations), 0025
  (five-stage workflow), 0026 (AAR replay), 0029 (the 3D view), 0032 (authoritative graded
  terrain) and 0038 (the terrain material, which now also paints viewsheds).

## Context

Until now the 3D view was a window onto the exercise. It drew the same exercise and selection as
the 2D map, but it could only be orbited. Every gameplay interaction lived in the 2D map, so a
trainee had to switch back to 2D for anything beyond looking. That covered selecting a Marine on the
map, placing him, moving his destination, turning him, placing fire teams, drawing the kill zone,
seeing routes, viewsheds and engagement wedges, editing the scenario, watching the shots, and
following a Marine in the replay.

The goal is one tactical simulation with two interchangeable interfaces, so the 3D view needs the
same functions. It must not get a second gameplay model, second rules, a second line-of-sight
computation or a second replay engine.

## Audit of the 2D functions (before this change)

The 2D map's gameplay is three layers:

1. **`buildScene`** (`view2d/scene.ts`) is a pure description of what is on screen and where, with
   hit-testing in screen pixels.
2. **`createMapController`** (`interaction.ts`) is a state machine from pointer input to
   `MapActions`.
3. **`createMapActions`** (`actions.ts`) maps those actions onto the exercise's commands (plans,
   formations, kill zone) and the session (selection), with the exercise's own validation.

Everything else (roster, tools, time scale, Execute, Start OPFOR, Trigger, the AAR's replay
controls and scores) is in the sidebar and keyboard, and already acts on the shared exercise and
session.

| Function                                                               | 2D before                         | 3D before                                | Work                                         |
| ---------------------------------------------------------------------- | --------------------------------- | ---------------------------------------- | -------------------------------------------- |
| Select a Marine (click; repeated clicks cycle a cluster)               | map, roster                       | roster only (figures highlighted)        | 3D picking through the shared controller     |
| Select a fire team or squad; deselect (Esc)                            | roster, Esc                       | roster, Esc                              | formation handles in 3D                      |
| Set, move, clear a destination                                         | click, drag, right click, Delete  | Delete only                              | click, drag and right click on the 3D ground |
| Facing                                                                 | drag the arrow tip; bearing label | figure's heading only                    | arrow, handle and bearing in 3D              |
| Fire-team formation: place, move, turn, delete                         | map                               | none                                     | shared controller                            |
| Kill zone: add, insert, move, delete corners                           | map (K tool)                      | none                                     | shared controller                            |
| Engagement wedges                                                      | map                               | none                                     | drawn on the ground                          |
| Viewshed (Marine, fire-team union, coarse preview while dragging)      | purple overlay                    | none                                     | the same result painted on the 3D ground     |
| Routes: selected, others, impossible; OPFOR routes; ORP; observer ring | map                               | destination pins only                    | drawn on the ground                          |
| Labels, OPFOR status, casualties, trigger rings                        | map                               | figures and posture only                 | overlay                                      |
| Shots                                                                  | lines from the combat log         | none                                     | the same lines, at weapon height             |
| Scenario editing (stage 2: ORP, OPFOR start, route waypoints)          | map editor hooks                  | none                                     | the same hooks through the 3D projection     |
| Tools, time scale, pause, Execute, Start OPFOR, Trigger, scores        | sidebar and keys                  | sidebar and keys                         | none (verified)                              |
| AAR replay: play, pause, seek, speed, step                             | sidebar; map shows the frame      | sidebar; 3D showed the frame's positions | overlays and shots from the same frame       |
| Roster double-click "centre on"; replay "follow"                       | 2D map only                       | none                                     | centre whichever view is shown               |
| Pointer coordinates (E, N, elevation)                                  | map bar                           | none                                     | from the 3D ground under the pointer         |
| Place kept when switching views                                        | none                              | none                                     | the other view looks where this one did      |

## Decision

### 1. One gameplay, any projection

`MapScene` now carries a **`MapProjection`**. It answers four questions:

- where a map point is on screen (`toScreen`, optionally raised by `lift` metres);
- which map point is under a screen point (`toWorld`, or `null` for the sky);
- where a handle `px` pixels from a point toward a bearing sits (`along`);
- how a map polyline is drawn (`line`).

Every hit test (soldiers, destinations, facing and formation handles, kill-zone corners and sides)
and every tactical overlay now goes through it.

- **The 2D map** uses `cameraProjection`, which is exactly the old arithmetic. A test compares it
  point for point, and every existing test passes unchanged.
- **The 3D view** supplies `groundProjection` (`view3d/ground-projection.ts`). It projects
  battlefield points on the **authoritative ground** (`heightAt` of the graded terrain) through the
  3D camera. Screen points are picked by marching a ray to that same ground (`groundHit`), never to
  meshes, so buildings, trees and decorative props cannot intercept a click meant for the terrain.

The same controller, the same `MapActions` and the same exercise commands therefore serve both
views. A click is selection first (a soldier under the pointer), then a destination, a formation
or a kill-zone corner, exactly as in 2D. Edits the exercise refuses (inside a building,
unreachable, a kill zone crossing itself) are refused in 3D for the same reasons, with the same
message. The renderer never decides what is allowed.

**Bearings** come from `facingToward(anchor, groundPoint)`, the same function in map metres, so
090° is east in both views. No screen-space angle is involved.

### 2. The layers stay apart

`view3d` may not import `view2d` (the boundary checks enforce it). So:

- **`view3d`** offers primitives:
  - the ground projection;
  - a pointer handler slot;
  - a transparent overlay canvas;
  - a ground overlay (the viewshed);
  - camera focus;
  - the pointer's ground point.
- **`view2d`**'s `TacticalMap` offers a **`MapSurface`**: its gameplay on another view's surface.
  The surface has its own gesture state and the same controller, actions, scenario-editor hooks,
  visibility and overlay drawing.
- **The app** (`workspace.ts`) connects the two.

### 3. Pointer gestures in 3D

The 3D view listens in the capture phase, before OrbitControls:

| Gesture                                                               | 2D                                       | 3D                               |
| --------------------------------------------------------------------- | ---------------------------------------- | -------------------------------- |
| Left click on a soldier                                               | select (cycle a cluster)                 | the same                         |
| Left click on the ground                                              | destination, formation, kill-zone corner | the same                         |
| Left drag on a handle (destination, arrow, formation, corner, editor) | drag it                                  | the same; the camera stays still |
| Left drag elsewhere                                                   | pan                                      | orbit (the 3D camera)            |
| Right click on a handle                                               | delete it                                | the same                         |
| Right drag                                                            | —                                        | pan along the ground             |
| Wheel                                                                 | zoom                                     | zoom toward the cursor           |
| Double-click                                                          | —                                        | focus the camera there           |

A press becomes a drag after 4 px, as on the 2D map. A press on a handle is claimed and stopped
before OrbitControls sees it. A press anywhere else belongs to the camera, and becomes a click only
if the pointer comes up without moving. Camera moves and edits can therefore never trigger each
other. The hover cursor (pointer, move, crosshair) is the 2D controller's.

### 4. Tactical overlays on the ground

`drawOverlays` draws through the projection. In perspective:

- Routes, the kill zone, the ORP and OPFOR routes get a point every 4 m (`line`), so they lie on
  the terrain.
- Engagement wedges are laid out in map metres and projected, instead of plan-view circles.
- The 3D figures replace the 2D icons. The overlay adds the selection ring, role labels, the
  casualty cross and OPFOR status pills at the soldier's middle.
- The map grid, north arrow and scale bar are plan-view only and are left out.

The overlay is a 2D canvas over the 3D canvas, drawn after each frame. Lines sit 5 cm above the
ground and are never hidden by it, nor by trees or buildings, like tactical symbology on a map:
they cannot z-fight or disappear. The colours, dashes, handles and labels are the 2D map's own,
because they come from the same code.

### 5. Viewsheds painted on the ground

The 2D map still owns the visibility overlay, `createViewshedService` with its cache and worker
pool, and computes it whichever view is shown: `TacticalMap.update()` runs it without drawing.

The 3D view receives the very same `Viewshed` and its pixels (`viewshedPixels`: the same purple,
alpha and edge). The terrain material (ADR 0038) samples them by world position and blends them in
output colour space, as the canvas does, before fog. The result:

- the overlay follows hills, valleys and graded ground exactly;
- it is hidden where the terrain hides it;
- it cannot z-fight;
- its cells are the 2D map's cells.

No line of sight is computed for the 3D view. Moving a Marine, turning him, choosing another or
toggling V updates both views, because there is one result. A fire team's union and the coarse
preview while dragging work the same way.

### 6. Shots, combat and the AAR

The overlay draws `CombatView` from the scene, which is built from the exercise's recorded combat
log at the exercise's time. Live, that is the simulation. In the AAR it is `Exercise.replayAt(frame)`:
the same frames, the same log, and the same shots for their 0.6 s display time.

In 3D a shot runs from 1.2 m above the shooter's ground to 1.2 m above the target's (`SHOT_LIFT_M`),
in the side's colour, with a dot on a hit. The simulation records shooter, target and hit, not a
trajectory, so no impact point is invented.

Switching views only changes which view draws. It does not restart, advance, re-run or re-seed
anything. Replay time, play or pause, speed, scores and recommendations live in the workspace and
the exercise. Seeking always lands on `frameAt(seconds)`.

### 7. Switching views keeps the place

When the view changes, the other one looks at the same map point, at a matching scale. The 3D
distance is chosen so that it shows about as much ground as the 2D map's metres per pixel. The
roster's double-click and the replay's "Follow the selected Marine" centre whichever view is shown.

### 8. Testing hooks

The workspace element exposes `ambushState()`, a read-only snapshot of the shared state:

- stage, view, session;
- plans, formations and kill zone;
- visibility;
- combat log;
- replay clock;
- score.

The 3D canvas exposes `ambushProject(x, y, lift)`, which projects a map point. The browser checks
use both.

## Results

**Automated tests** (vitest):

- `view2d/projection.test.ts`:
  - The 2D projection is exactly the old camera arithmetic.
  - The same session of gestures (select, destination, drag, facing, kill zone with a moved and
    a deleted corner, fire-team placement and turn) gives the same plans through the plan view and
    through an oblique, rotated stand-in for the 3D projection.
  - Bearings are 090° and 180° in both.
  - A press on a handle holds it.
  - Points a view cannot draw hit nothing.
  - What the scene shows (plans, routes, combat, engagements) does not depend on the projection.
- `view3d/ground-projection.test.ts`:
  - Map point → screen → map point round-trips on the authoritative ground.
  - A click on a graded cutting lands on the cut road, not the ridge.
  - `lift` raises points, points behind the camera are not drawable, and the sky has no ground.
  - Lines lie on the terrain.
  - `along` points the bearing's way.
- `view3d/ground-material.test.ts`:
  - Each viewshed cell lands on the texel the 2D map draws for it (north-first rows).
  - The overlay is premultiplied, reused for the same viewshed and freed when cleared.
- `view3d/vegetation.test.ts`: software renderers are recognised.
- The existing replay, scoring, combat and display-attribute tests cover determinism, seeking and
  scores. They run on the exercise, which is the same whatever view is shown.

**Browser checks**: headless Chromium, SwiftShader, 1600 × 1000.

**Demo battlefield** (hills, a valley road, a hamlet, woods, 13 Marines, a moving OPFOR patrol).
The whole workflow in 3D passed 30 of 30 checks, with no page or console errors:

- A click on a Marine's figure selects him, and the sidebar shows him.
- A click on the ground sets his destination there (within 1.5 m of the pixel's ground point).
- Dragging the destination moves it, and the camera stays still.
- Dragging the facing arrow toward a point due east gives 090.0°.
- The viewshed is computed while in 3D (2,937 cells).
- Back in 2D:
  - identical plans, selection and tools;
  - the identical viewshed.
- In 3D again:
  - kill zone drawn, a corner dragged;
  - a fire-team formation placed by one click;
  - another Marine's destination set, then removed with a right click.
- Execute, Start OPFOR, Trigger: shots shown during the 3D engagement.
- Switching to 2D and back mid-engagement only lets the clock and log run on.
- AAR in 3D: replay plays and pauses, and seeking back and forward lands on the same frame.
- At 0.25×, switching to 2D during playback keeps it playing, and switching back keeps the paused
  frame.
- The score is identical in 2D and 3D, and the combat log is unchanged by replay and switches.

**Grafenwöhr** (real terrain, roads, buildings and woods, from recorded OSM and elevation data).
The whole workflow in 3D passed 16 of 16 checks, with no page or console errors:

- Stage 2 in 3D:
  - the ORP placed by a click;
  - the OPFOR start placed;
  - a route of two waypoints;
  - a waypoint dragged, another deleted with a right click.
- Stage 3 in 3D:
  - a fire team placed in a line on the graded ground;
  - a kill zone across the route;
  - a single Marine sent to a point, with his viewshed on.
- 2D shows identical plans, kill zone and viewshed (115,550 cells).
- The OPFOR watched into the kill zone in 3D; the ambush triggered; the engagement completed with
  shots.
- AAR in 3D: score, combat log and replay frame identical in 2D.

Earlier attempts placed the ORP among barracks, and later in a forest. There the exercise rightly
refused unreachable destinations, and nobody could see the kill zone (the sidebar showed "Kill zone
visible: 0%"). The 2D map would refuse and show the same.

**Performance.** All browser runs used software WebGL (SwiftShader): no GPU is available here, so
frame times are not representative. Shots cost one canvas line each, with no Three.js objects
created per shot. The overlay is redrawn once per frame, and the viewshed texture is uploaded once
per viewshed.

## Consequences and limitations

- **Left drag on empty ground.** It orbits in 3D but pans in 2D, because each view keeps its camera
  convention. Right drag pans in 3D. Everything else is the same gesture with the same meaning.
- **Overlays are never hidden.** The tactical overlay is drawn on top of the 3D scene, so a route
  behind a hill or through a wood stays visible. This is deliberate: symbology must not disappear.
  The viewshed, painted by the terrain shader, is occluded correctly.
- **Shots are straight lines from 1.2 m to 1.2 m.** The simulation records shooter, target and
  hit, not trajectories, posture-specific muzzle heights or impact points.
- **Double-click.** In 3D it focuses the camera and also counts as two clicks: on a cluster of
  soldiers, the selection may advance by two.
- **The 3D view's own markers remain.** Destination pins and figures sit under the overlay's rings
  and labels.
