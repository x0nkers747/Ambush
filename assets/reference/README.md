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
