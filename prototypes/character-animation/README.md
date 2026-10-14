# Character animation runtime comparison (prototype)

A standalone browser prototype that compares animation runtimes for Ambush!'s soldiers on the
same characters, clips, weapon, lighting, camera and simulated movement. It is **not part of the
game**: it has its own `package.json`, is not in the game's `tsc -b` solution or Vite build, and
changes nothing in `src/` (it reads two `src/view3d` modules for the benchmark trees).

Results and recommendation: [`docs/character-animation-framework-evaluation.md`](../../docs/character-animation-framework-evaluation.md),
[`docs/character-animation-prototype-results.md`](../../docs/character-animation-prototype-results.md).

## Run it

```sh
cd prototypes/character-animation
npm install          # animouse, @three.ez/instanced-mesh (three comes from the repository)
npm run assets       # downloads the openly licensed assets into public/assets/ (see ASSETS.md); needs ffmpeg for the Rocketbox textures
npm run dev          # http://localhost:5199/  (inspect.html: clip inspector)
```

`npm run typecheck`, `npm test` (node), `npm run build`.

## Baking the soldier for the game

The game's soldier (`public/characters/`, `docs/character-animation.md`) comes from here:
with `npm run dev` running, `PLAYWRIGHT=<path to playwright/index.mjs> npm run bake` writes the
Rocketbox soldier's clips as the page plays them (`src/bake.ts`) to
`public/characters/rocketbox/clips.json` and copies the model, textures and rifles next to it.

## What is on the page

- **Runtime**: A (three.js `AnimationMixer` sampled at explicit times, stateless), B (animouse 0.8.0
  state machine and blend trees), or both side by side.
- **Character**: Rocketbox `Military_Male_01` (realistic, MIT; every clip retargeted), the
  Mesh2Motion mannequin (CC0; UAL clips native), the Quaternius soldier and the KayKit mannequin
  (stylised references).
- **Weapon**: M16A2 stand-in (CC0 AR-15 model), M249 placeholder, AK.
- **Movement**: the scripted 47-second test sequence (walk, run, sprint, stop, turn, strafe and back
  while aiming, fire, kneel, prone, crawl, stand, diagonal, reload, incapacitation), or live control
  (state buttons, speed and direction, posture, carry, fire, reload). Everything runs through a
  30 Hz deterministic mini-simulation (`src/sim.ts`) that records a frame per tick, like Ambush!.
- **Timeline**: pause, step a tick, scrub, playback speed 0.1–16×; "2D map view" stops the 3D
  updates (the 2D/3D switch test).
- **Post-processing** (shared by both runtimes): weapon hold, analytic two-bone or three.js
  `CCDIKSolver` arm IK, spine aim and head look, foot IK on the uneven ground.
- **Panels**: frame/animation/render timings, draw calls, triangles, heap; the animator's layers and
  weights; the simulation input; clip coverage; the determinism test.
- **Screenshot** (bottom bar, with an optional note; Enter in the note saves): with `npm run dev`
  the view is saved in `screenshots/` (git-ignored) as a JPEG with a JSON beside it: the note,
  every setting, the time, the camera, the simulation input, the animators' state and a URL that
  reopens the same moment, paused, from the same camera (scripted sequence only).

## Measurements

- Determinism: the "Run test" button (or `proto.determinism()` in the console).
- Foot sliding: `proto.footSlide()`.
- Hand placement: `proto.holdReport([…times])`.
- Benchmarks: `PLAYWRIGHT=<path to playwright/index.mjs> node tools/bench.mjs` with the dev server
  running (headed Chrome, vsync off; writes `results/bench-*.json` and `.md`).
