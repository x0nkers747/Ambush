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
| 5   | After Action Review | Placeholder: "Coming soon", plus the recorded result      |

Every stage has the same compact header (`shell.ts`): the stage name, "n / 5", and Previous and
Next arrows. There are no per-stage buttons. A blocked arrow uses `aria-disabled` rather than
`disabled`. It stays focusable, its reason is in its tooltip and an `aria-describedby` text, and
pressing it shows the reason.

### Workflow stage and exercise phase are separate

The workflow stage (`workflow.ts`: `'terrain' | 'scenario' | 'bluefor' | 'opfor' | 'aar'`) says
what the trainee is doing. The exercise phase (ADR 0009: `bluforPlanning` … `engagementComplete`,
plus `paused`) says where the simulation is. Executing, pausing and re-planning all happen within
stage 3; starting OPFOR and the engagement happen within stage 4. No stage change runs or stops the
simulation, with one exception: leaving for stage 2 pauses it, so nothing runs unseen.

What blocks Next is read from the existing rules, never copied: `nextBlocker(stage, facts)` takes
lazy facts:

- 1 → 2: the demo or a saved battlefield is selected. A new location must be generated first.
- 2 → 3: `scenarioProblems` is empty. These are the prerequisites of ADR 0015, unchanged.
- 3 → 4: `startOpforProblems` is empty (BLUEFOR executed and in position, changes executed, a
  valid kill zone), or OPFOR has already started. Advancing does not start OPFOR.
- 4 → 5: the engagement is complete (`engagementComplete`).

The stage's primary button in the side panel uses the same function as Next, and shows the same
reason in amber below it.

### Pages and addresses

Terrain selection is one page. Stages 2–5 of a battlefield share another (`workspace.ts`) with one
tactical map. The exercise therefore survives a step back to the scenario: it is not stored (ADR
0015), so a page reload would lose it. Moving between the two pages reloads, as before.
In-page stage changes update the address with `history.replaceState`, so a reload stays put:

| Address        | Stage                                                      |
| -------------- | ---------------------------------------------------------- |
| (none)         | 1                                                          |
| `#select/<id>` | 1, with that battlefield (or `demo`) selected              |
| `#edit/<id>`   | 2                                                          |
| `#play/<id>`   | 3; stages 4 and 5 reload as 3, since the exercise restarts |
| `#demo`        | 2 for the demo                                             |
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
- **After Start OPFOR** planning is locked in stage 3. **Restart exercise** asks first and does the
  same rebuild.
- **Leaving for terrain selection** asks first when there are plans or an exercise to lose. The
  scenario is always saved.

Confirmations are a small in-page dialog (`createConfirm`) used only for these discarding actions
and for Reset scenario. Routine navigation is never confirmed.

### Contextual side panel

The side panel is a fixed sequence of sections, shown or hidden by stage:

1. Stage tools
2. Simulation (stages 3–5)
3. Stage status
4. Primary action (sticky at the bottom on short screens)
5. Squad roster
6. Event log (stages 3–5, collapsed)
7. Help (collapsed)
8. Battlefield Information (collapsed)

Stage tools and status by stage:

- **Stage 2:** the three scenario tools, Clear route and Reset scenario. Status shows ORP, OPFOR
  and route, with one actionable message.
- **Stage 3:** Edit positions, Kill zone and Visibility (Visibility appears only here), plus the
  selection panel. Status shows destinations, Marines in position, the plan's state and readiness.
- **Stage 4:** Start OPFOR and Trigger Ambush, each with its reason, plus the kill-zone count and
  approach time. Status shows BLUEFOR, OPFOR, the ambush and combat, plus the engagement table when
  there is one.
- **Stage 5:** "Coming soon", with a description. The simulation controls are disabled, with a note
  that replay is not available. Status shows the recorded engagement result only. Nothing is
  invented.

The roster (`roster.ts`) is the same in stages 2–5, with the same selection, fire-team selection
and map sync. Stage 1 has no squad yet, so no roster. Help text that used to be permanent is now
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
- Terrain selection previews the selected demo or saved battlefield on the tactical map
  (`battlefield-preview.ts`), with its saved scenario (ORP, OPFOR and route). The preview pans and
  zooms but never edits (the `view` tool). It loads the whole battlefield, so it shows "Loading the
  preview…" until it is ready; a slower load is dropped when another selection follows, and the
  map is disposed when the selection changes. Opening loads the battlefield again on its own page.
- A reload in stages 3–5 restarts the exercise. Storing plans (`deploymentPlans` already serializes
  them) would remove that and is a candidate for later.
- The After Action Review is a placeholder. Its section, stage and navigation exist, so replay and
  analysis can be added later without changing the workflow.
