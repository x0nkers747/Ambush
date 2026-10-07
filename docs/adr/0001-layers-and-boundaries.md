# ADR 0001: Layers and boundary enforcement

- Status: Accepted
- Date: 2026-10-07

## Context

Ambush! must run its simulation independently of rendering (headless tests,
faster-than-real-time execution, replay), and offer two views (2D tactical,
3D Three.js) over one shared model. Boundaries that rely on convention erode;
they must be enforced by tooling.

## Decision

One npm package, split into layer folders. Each layer has its own `tsconfig.json`
(TypeScript project references) and a public entry point `index.ts`, aliased
through the `package.json` `"imports"` field.

| Layer          | Alias       | Purpose                                       | May depend on                   |
| -------------- | ----------- | --------------------------------------------- | ------------------------------- |
| `src/sim`      | `#sim`      | Simulation state, commands, systems, terrain  | nothing                         |
| `src/exercise` | `#exercise` | Plan, phases, runner, recording/playback      | `#sim`                          |
| `src/session`  | `#session`  | Ephemeral UI state (selection, time scale, …) | `#sim`, `#exercise`             |
| `src/view2d`   | `#view2d`   | 2D tactical view (Canvas2D)                   | `#sim`, `#exercise`, `#session` |
| `src/view3d`   | `#view3d`   | 3D observer view (Three.js)                   | the above + `three`             |
| `src/app`      | —           | Composition root, frame loop, UI shell        | everything                      |
| `tools`        | —           | Node command-line tools                       | `#sim`, `#exercise`             |

Enforcement:

- **Compiler.** `sim`, `exercise` and `session` compile with `lib: ["ES2022"]`
  and `types: []`, so DOM and Node globals do not exist there. A layer can only
  import layers listed in its `references`; otherwise `tsc -b` fails.
- **ESLint.** `no-restricted-imports` forbids disallowed `#layer` aliases,
  `three` outside `view3d` and `app`, and relative imports that reach into
  another layer's folder (bypassing its public `index.ts`).
  `no-restricted-globals` and `no-restricted-properties` ban clocks, timers,
  `Math.random` and host globals in `sim` and `exercise` (ADR 0003, ADR 0004).
- `view2d` and `view3d` never depend on each other.

## Consequences

- Moving a layer into its own package later is mechanical.
- Rendering consumes simulation state through read APIs; it never owns it.
- One `node_modules`, one Vite and one Vitest configuration; no workspace tooling.
