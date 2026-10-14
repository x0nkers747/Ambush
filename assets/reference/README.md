# Reference material

Design reference only. Nothing in this folder is loaded by the application, and nothing here
is an adopted decision until an ADR says so.

## `individual-soldier-icons.png`

The agreed set of simplified individual soldier icons (added 2026-10-08):

- one circular frame per soldier, coloured by side: blue friendly, red enemy, with optional
  green (second friendly), yellow (neutral) and grey (unknown);
- a role icon inside the frame: squad leader, fire team leader, rifleman, automatic rifleman,
  grenadier, marksman, medic and radio operator;
- a triangle above the frame showing the soldier's facing.

Adopted by [ADR 0013](../../docs/adr/0013-individual-soldier-icons.md) as the design
authority for individual soldier icons. They are implemented in `src/view2d/soldier-icons.ts`,
and every role and affiliation is shown on the development page `symbols.html`
(`npm run dev`, then open `/symbols.html`).

## `tactical-workflow-navigation-bar.png`

The workflow header: Previous and Next either side of the five stage segments, the current one
outlined in blue. The application leaves out the reference's "n / 5" counter. Adopted by
[ADR 0025](../../docs/adr/0025-five-stage-workflow.md) and implemented in `src/app/shell.ts`.

## Screenshots from the app

In development (`npm run dev`), the **Screenshot** button under the map on the terrain
selection page saves what the map shows (2D or 3D) here as
`<battlefield>-<2d|3d>-<date>-<time>.jpg`, with a `.json` beside it giving the battlefield and,
in 3D, the camera (`x`, `y`, `distance`, `pitch`, `azimuth`, as the automated captures use
them). The built site downloads the picture instead. Screenshots are working material: they
are not committed.
