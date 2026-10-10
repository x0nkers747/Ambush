# ADR 0025: The five-stage workflow

- Status: Accepted
- Date: 2026-10-10
- Supersedes the stage layout and navigation of ADR 0015 (three-stage workflow). Its scenario model,
  editing rules and storage are unchanged.

## Context

The UI showed many unrelated controls at once. The header mixed workflow navigation ("◂ Scenario",
"◂ <battlefield>"), simulation controls, map tools and status readouts. The side panel was mostly
permanent help text and battlefield metadata. The three screens had been built separately and
looked it. A trainee could not easily tell what stage they were in, what they could do there, or
what was missing before moving on.

## Decision

### Five stages, one header

| #   | Stage               | What happens                                              |
| --- | ------------------- | --------------------------------------------------------- |
| 1   | Select Terrain      | Find, generate, select and open a battlefield             |
| 2   | Edit Scenario       | ORP, OPFOR and OPFOR route (the demo's is read-only)      |
| 3   | BLUEFOR Planning    | Positions, kill zone, visibility; Execute, pause, re-plan |
| 4   | OPFOR & Combat      | Start OPFOR, Trigger Ambush, the engagement               |
| 5   | After Action Review | Replay of the engagement from the trigger (ADR 0026)      |

Every stage has the same header (`shell.ts`), drawn after
`assets/reference/tactical-workflow-navigation-bar.png`: Previous and Next arrows either side of
five stage segments, each an icon and a short label (TERRAIN, EDIT SCENARIO, BLUEFOR, OPFOR, AAR;
`STAGE_LABELS`). The current segment is outlined in blue. Its icon is blue, or red
for OPFOR; the other icons are grey. There are no per-stage buttons. A segment opens any earlier stage, as Previous does, and the
next stage under Next's gate. A later stage is reached only through the next one
(`stageBlocker`), because entering a stage does work, such as building the exercise, that skipping
would miss. A blocked arrow or segment uses `aria-disabled` rather than `disabled`. It stays
focusable, its reason is in its tooltip and an `aria-describedby` text, and pressing it shows the
reason. Below 760 px only the current segment keeps its label.

### Workflow stage and exercise phase are separate

The workflow stage (`workflow.ts`: `'terrain' | 'scenario' | 'bluefor' | 'opfor' | 'aar'`) says
what the trainee is doing. The exercise phase (ADR 0009: `bluforPlanning` … `engagementComplete`,
plus `paused`) says where the simulation is. Executing, pausing and re-planning all happen within
stage 3; starting OPFOR and the engagement happen within stage 4. No stage change runs or stops the
simulation, with one exception: leaving for stage 2 pauses it, so nothing runs unseen.

What blocks Next is read from the existing rules, never copied: `nextBlocker(stage, facts)` takes
lazy facts:

- 1 → 2: a saved battlefield is selected. A new location must be generated first.
- 2 → 3: `scenarioProblems` is empty. These are the prerequisites of ADR 0015, unchanged.
- 3 → 4: `startOpforProblems` is empty (BLUEFOR executed and in position, changes executed, a
  valid kill zone), or OPFOR has already started. Advancing does not start OPFOR.
- 4 → 5: the engagement is complete (`engagementComplete`).

The stage's primary button in the side panel uses the same function as Next, and shows the same
reason in amber below it.

### Pages and addresses

Terrain selection is one page. Stages 2–5 of a battlefield share another (`workspace.ts`) with one
tactical map. The exercise therefore survives a step back to the scenario: it is not stored (ADR
0015), so a page reload would lose it.

Moving between the two pages happens in place, without a reload (this replaces ADR 0015's reload
between pages). Only the header and the side panel change; the tactical map stays on screen as it
is. Opening a battlefield hands the preview's map (`TacticalMap.attach`) and its canvas to the
workspace, and reuses the battlefield the preview loaded, so it is not read again. Leaving hands
the map back to the preview, with the scenario as edited. Without a reload to clear up, each page
stops what it started when it is left: the workspace its frame loop and its keyboard and
visibility listeners, terrain selection a generation in progress and late answers from search or
storage. The demo, which terrain selection does not list, disposes its map on leaving.

The move to the other page is a new history entry (`history.pushState`); stage changes within a
page update the address with `history.replaceState`. Back and Forward reload at the address they
reach, and a reload stays put:

| Address        | Stage                                                      |
| -------------- | ---------------------------------------------------------- |
| (none)         | 1                                                          |
| `#select/<id>` | 1, with that battlefield selected                          |
| `#edit/<id>`   | 2                                                          |
| `#play/<id>`   | 3; stages 4 and 5 reload as 3, since the exercise restarts |
| `#demo`        | 2 for the demo (terrain selection does not list it)        |
| `#demo/play`   | 3 for the demo                                             |

### Keeping work, invalidating stale results

Navigating keeps state. Changing data invalidates what depends on it. Restarting is explicit.

- **Back from 3–5 to 2** keeps the exercise as it is. While the trainee is in stage 2, the map
  shows the scenario preview.
- **A scenario edit before any execution:** on the return to stage 3 the exercise is rebuilt for
  the new scenario. `carryPlans` copies the kill zone, the fire-team formations (including detached
  Marines) and each Marine's destination and facing. It uses the new exercise's own edits, so
  nothing the new scenario forbids is carried. Anything refused is reported, in a message and in
  the stage-3 status.
- **After Execute** the scenario is locked: a result computed for one scenario is never shown
  against another. **Restart exercise to edit** asks first, then rebuilds the exercise with the
  plans carried over.
- **After Start OPFOR** there is no going back to stages 2 and 3 (`backBlocker`): Previous and
  their header segments are blocked with the reason. Terrain selection stays open, with its usual
  confirmation, and starting again means leaving the battlefield.
- **Leaving for terrain selection** resets the battlefield's scenario to a new one (no ORP, no
  OPFOR, no route), saved, so terrain selection previews the bare terrain and the battlefield
  opens empty next time. It asks first when there is a scenario, plans or an exercise to lose.

Confirmations are a small in-page dialog (`createConfirm`) used only for these discarding actions
and for Reset scenario. Routine navigation is never confirmed.

### Contextual side panel

The side panel is a fixed sequence of sections, shown or hidden by stage:

1. Primary action (always first, and kept at the top while the panel scrolls, so the way on to
   the next stage is always in the same place)
2. Stage tools
3. Stage status
4. Squad roster, in stage 3 only (changed 2026-10-10: the other stages do not need it for now). It
   comes before the status, right after the tools, with the selection hint above the roster and
   the selected unit's details and visibility below it.
5. Event log (stages 3–5, collapsed)
6. Help (collapsed)
7. Battlefield Information (collapsed)

The simulation controls (clock, state, **Move**, Pause, Resume and the time acceleration, 16× by
default) float in the map's top-right corner in stages 3–5, so they never need scrolling to; the
north arrow is in the top-left corner of every map. The map's banner is then centred between the
two.

Stage tools and status by stage:

- **Stage 2:** the three scenario tools, Clear route and Reset scenario. Status shows ORP, OPFOR
  and route, with one actionable message.
- **Stage 3:** Waypoints, Kill zone and Visibility (Visibility appears only here), plus the
  selection panel. Status shows destinations, Marines in position, the plan's state and readiness.
- **Stage 4:** Start OPFOR and Trigger Ambush, each with its reason, plus the kill-zone count and
  approach time. Status shows BLUEFOR, OPFOR, the ambush and combat, plus the engagement table when
  there is one.
- **Stage 5:** the replay controls (ADR 0026) and the selected Marine's state at the replay's
  moment; the floating simulation panel is hidden. Status shows the engagement result as at that
  moment. The primary action is **Try again** (back to BLUEFOR planning, with the Waypoints tool).

The roster (`roster.ts`) is shown in stage 3, with its selection, fire-team and squad selection
and map sync; elsewhere Marines are selected on the map. Stage 1 has no squad yet. Help text that used to be permanent is now
under Help.

### Tools that do not belong to a stage are switched off

- The session gains a `view` map tool: clicks select, but never edit plans or the kill zone. It is
  set on entering stages 2, 4 and 5. Stage 3 restores its last planning tool and Visibility
  setting.
- The scenario editor's map hooks (`MapEditor.active`) are live only in stage 2. While the scenario
  is locked they label the route but do not edit it.
- Keyboard shortcuts follow the same rules. K, V and Delete work only in stage 3; Space and the
  speed keys only in stages 3 and 4; F and Esc everywhere.

## Consequences

- One stylesheet in `index.html` serves every stage. The colours mean:
  - blue: BLUEFOR and the selected tool;
  - red: OPFOR and combat;
  - green: readiness and progress;
  - amber: warnings and unmet prerequisites;
  - grey: metadata.

  Every coloured status also has a text label or a ✓/⚠ mark.

- `exercise-ui.ts` and `scenario-editor.ts` are replaced by `workspace.ts`, `exercise-stage.ts`,
  `scenario-stage.ts`, `roster.ts` and `shell.ts`. The exercise, scenario, terrain and simulation
  layers are unchanged. view2d gains only `MapEditor.active`, and the session gains the `view` tool.
- Terrain selection has the same layout as the other stages: the map area on the left, and on the
  right the side panel (first the one primary action, Open or Generate, as in every stage; then
  find a place, position, saved battlefields, and the selection's details and generation
  progress). The map area
  previews the selected saved battlefield on the tactical map (`battlefield-preview.ts`), with its saved scenario (ORP, OPFOR and route). The preview pans and
  zooms but never edits (the `view` tool). It loads the whole battlefield, so it shows "Loading the
  preview…" until it is ready; a slower load is dropped when another selection follows, and the
  map is disposed when the selection changes. Opening the battlefield hands this map to the
  workspace and leaving hands it back (see Pages and addresses), so the view and the drawn terrain
  never change between the two.
- A reload in stages 3–5 restarts the exercise. Storing plans (`deploymentPlans` already serializes
  them) would remove that and is a candidate for later.
- The After Action Review replays the engagement (ADR 0026); scoring and analysis can be added
  later without changing the workflow.
