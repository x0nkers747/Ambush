// Page addresses of the five-stage workflow (docs/adr/0015, docs/adr/0025).
// Each address is a URL hash and a page: terrain selection is one page, and
// stages 2–5 of one battlefield share another, so the exercise (stages 3–5)
// survives a step back to the scenario. Moving between pages happens in place
// (main.ts) as a new history entry; Back, Forward and a reload load the page
// at the address reached, on the same stage (stages 4 and 5 reload as stage
// 3: the exercise is not stored).
//
//   ''                 1. Terrain selection
//   '#select/<id>'     1. Terrain selection with battlefield <id> selected
//   '#setup/<id>'      2. Scenario Setup of battlefield <id>'s battle
//                         (docs/constructive-simulation/03)
//   '#plan/<id>'       3. BLUEFOR Planning of that battle
//   '#edit/<id>'       2. The legacy ambush exercise's scenario editing
//   '#play/<id>'       3. The legacy ambush exercise's planning and execution
//   '#demo'            2. The demo's scenario (fixed, shown read-only); terrain
//                         selection does not list the demo, so only this address opens it
//   '#demo/play'       3. BLUEFOR planning on the demo

export type Stage =
  | { readonly kind: 'select'; readonly selected?: string }
  | { readonly kind: 'edit'; readonly battlefieldId: string }
  | { readonly kind: 'play'; readonly battlefieldId: string }
  | { readonly kind: 'setup'; readonly battlefieldId: string }
  | { readonly kind: 'plan'; readonly battlefieldId: string }
  | { readonly kind: 'demo'; readonly play?: boolean };

export function parseStage(hash: string): Stage {
  const h = hash.replace(/^#/, '');
  if (h === 'demo') return { kind: 'demo' };
  if (h === 'demo/play') return { kind: 'demo', play: true };
  const m = /^(edit|play|setup|plan|select)\/(.+)$/.exec(h);
  if (m?.[1] && m[2]) {
    const id = decodeURIComponent(m[2]);
    const kind = m[1];
    if (kind === 'select') return { kind: 'select', selected: id };
    if (kind === 'edit' || kind === 'play' || kind === 'setup' || kind === 'plan')
      return { kind, battlefieldId: id };
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
    case 'setup':
    case 'plan':
      return `#${stage.kind}/${encodeURIComponent(stage.battlefieldId)}`;
  }
}
