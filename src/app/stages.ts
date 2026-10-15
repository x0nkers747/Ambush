// Page addresses of the five-stage workflow (docs/constructive-simulation/03).
// Terrain selection is one page; stages 2–5 of one battlefield's battle
// share another (battle/page.ts). Moving between the two happens in place
// (main.ts) as a new history entry; Back, Forward and a reload load the page
// at the address reached (Combat and the review reload as BLUEFOR Planning:
// a battle is not stored).
//
//   ''                 1. Terrain selection
//   '#select/<id>'     1. Terrain selection with battlefield <id> selected
//   '#setup/<id>'      2. Scenario Setup of battlefield <id>'s battle
//   '#plan/<id>'       3. BLUEFOR Planning of that battle
//
// The retired ambush exercise's addresses still lead somewhere sensible:
// '#edit/<id>' to Scenario Setup, '#play/<id>' to BLUEFOR Planning, and
// '#demo' (and '#demo/play') to terrain selection.

export type Stage =
  | { readonly kind: 'select'; readonly selected?: string }
  | { readonly kind: 'setup'; readonly battlefieldId: string }
  | { readonly kind: 'plan'; readonly battlefieldId: string };

export function parseStage(hash: string): Stage {
  const h = hash.replace(/^#/, '');
  const m = /^(edit|play|setup|plan|select)\/(.+)$/.exec(h);
  if (m?.[1] && m[2]) {
    const id = decodeURIComponent(m[2]);
    const kind = m[1];
    if (kind === 'select') return { kind: 'select', selected: id };
    if (kind === 'setup' || kind === 'edit') return { kind: 'setup', battlefieldId: id };
    return { kind: 'plan', battlefieldId: id };
  }
  return { kind: 'select' };
}

export function stageHash(stage: Stage): string {
  switch (stage.kind) {
    case 'select':
      return stage.selected === undefined ? '' : `#select/${encodeURIComponent(stage.selected)}`;
    case 'setup':
    case 'plan':
      return `#${stage.kind}/${encodeURIComponent(stage.battlefieldId)}`;
  }
}
