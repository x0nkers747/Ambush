import { describe, expect, it } from 'vitest';
import { parseStage, stageHash, type Stage } from './stages';

describe('stage addresses', () => {
  it('round-trip every stage', () => {
    const stages: Stage[] = [
      { kind: 'select' },
      { kind: 'select', selected: 'a1b2c3d4e5f60718' },
      { kind: 'select', selected: 'demo' },
      { kind: 'demo' },
      { kind: 'demo', play: true },
      { kind: 'edit', battlefieldId: 'a1b2c3d4e5f60718' },
      { kind: 'play', battlefieldId: 'a1b2c3d4e5f60718' },
      { kind: 'edit', battlefieldId: 'odd/id with spaces' },
    ];
    for (const s of stages) expect(parseStage(stageHash(s))).toEqual(s);
  });

  it('treat anything unknown as terrain selection', () => {
    expect(parseStage('')).toEqual({ kind: 'select' });
    expect(parseStage('#nonsense')).toEqual({ kind: 'select' });
    expect(parseStage('#edit/')).toEqual({ kind: 'select' });
    expect(parseStage('#select/')).toEqual({ kind: 'select' });
  });
});
