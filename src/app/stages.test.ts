import { describe, expect, it } from 'vitest';
import { parseStage, stageHash, type Stage } from './stages';

describe('stage addresses', () => {
  it('round-trip every stage', () => {
    const stages: Stage[] = [
      { kind: 'select' },
      { kind: 'select', selected: 'a1b2c3d4e5f60718' },
      { kind: 'select', selected: 'demo' },
      { kind: 'setup', battlefieldId: 'a1b2c3d4e5f60718' },
      { kind: 'setup', battlefieldId: 'odd/id with spaces' },
      { kind: 'plan', battlefieldId: 'odd/id with spaces' },
    ];
    for (const s of stages) expect(parseStage(stageHash(s))).toEqual(s);
  });

  it('lead the retired ambush exercise’s addresses into the battle workflow', () => {
    expect(parseStage('#edit/a1b2')).toEqual({ kind: 'setup', battlefieldId: 'a1b2' });
    expect(parseStage('#play/a1b2')).toEqual({ kind: 'plan', battlefieldId: 'a1b2' });
    expect(parseStage('#demo')).toEqual({ kind: 'select' });
    expect(parseStage('#demo/play')).toEqual({ kind: 'select' });
  });

  it('treat anything unknown as terrain selection', () => {
    expect(parseStage('')).toEqual({ kind: 'select' });
    expect(parseStage('#nonsense')).toEqual({ kind: 'select' });
    expect(parseStage('#edit/')).toEqual({ kind: 'select' });
    expect(parseStage('#setup/')).toEqual({ kind: 'select' });
    expect(parseStage('#select/')).toEqual({ kind: 'select' });
  });
});
