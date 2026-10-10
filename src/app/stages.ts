// Page addresses of the five-stage workflow (docs/adr/0015, docs/adr/0025).
// Each address is a URL hash and a page: terrain selection is one page, and
// stages 2–5 of one battlefield share another, so the exercise (stages 3–5)
// survives a step back to the scenario. Moving between pages reloads, so
// nothing from one page keeps running in the next, and a reload stays on the
// same stage (stages 4 and 5 reload as stage 3: the exercise is not stored).
//
//   ''                 1. Terrain selection
//   '#select/<id>'     1. Terrain selection with battlefield <id> (or `demo`) selected
//   '#edit/<id>'       2. Scenario editing for battlefield <id>
//   '#play/<id>'       3. BLUEFOR planning and execution on its scenario
//   '#demo'            2. The demo's scenario (fixed, shown read-only)
//   '#demo/play'       3. BLUEFOR planning on the demo

/** What terrain selection can have selected: the demo or a saved battlefield. */
export const DEMO_ID = 'demo';

export type Stage =
  | { readonly kind: 'select'; readonly selected?: string }
  | { readonly kind: 'edit'; readonly battlefieldId: string }
  | { readonly kind: 'play'; readonly battlefieldId: string }
  | { readonly kind: 'demo'; readonly play?: boolean };

export function parseStage(hash: string): Stage {
  const h = hash.replace(/^#/, '');
  if (h === 'demo') return { kind: 'demo' };
  if (h === 'demo/play') return { kind: 'demo', play: true };
  const m = /^(edit|play|select)\/(.+)$/.exec(h);
  if (m?.[1] && m[2]) {
    const id = decodeURIComponent(m[2]);
    if (m[1] === 'select') return { kind: 'select', selected: id };
    return m[1] === 'edit'
      ? { kind: 'edit', battlefieldId: id }
      : { kind: 'play', battlefieldId: id };
  }
  return { kind: 'select' };
}

export function stageHash(stage: Stage): string {
  switch (stage.kind) {
    case 'select':
      return stage.selected === undefined ? '' : `#select/${encodeURIComponent(stage.selected)}`;
    case 'demo':
      return stage.play === true ? '#demo/play' : '#demo';
    case 'edit':
    case 'play':
      return `#${stage.kind}/${encodeURIComponent(stage.battlefieldId)}`;
  }
}
