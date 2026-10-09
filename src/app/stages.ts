// The three stages (docs/adr/0015) and their addresses. Each stage is a URL
// hash, and moving between stages reloads the page: every stage starts from
// saved data with nothing left running from the previous one, and a reload
// stays on the same stage.
//
//   ''                 1. Terrain selection
//   '#edit/<id>'       2. Scenario editing for battlefield <id>
//   '#play/<id>'       3. BLUEFOR planning and execution on its scenario
//   '#demo'            The demo, straight to planning (it has its own scenario)

export type Stage =
  | { readonly kind: 'select' }
  | { readonly kind: 'edit'; readonly battlefieldId: string }
  | { readonly kind: 'play'; readonly battlefieldId: string }
  | { readonly kind: 'demo' };

export function parseStage(hash: string): Stage {
  const h = hash.replace(/^#/, '');
  if (h === 'demo') return { kind: 'demo' };
  const m = /^(edit|play)\/(.+)$/.exec(h);
  if (m?.[1] && m[2]) {
    const battlefieldId = decodeURIComponent(m[2]);
    return m[1] === 'edit' ? { kind: 'edit', battlefieldId } : { kind: 'play', battlefieldId };
  }
  return { kind: 'select' };
}

export function stageHash(stage: Stage): string {
  switch (stage.kind) {
    case 'select':
      return '';
    case 'demo':
      return '#demo';
    case 'edit':
    case 'play':
      return `#${stage.kind}/${encodeURIComponent(stage.battlefieldId)}`;
  }
}
