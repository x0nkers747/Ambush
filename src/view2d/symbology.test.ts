import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIO } from '#exercise';
import {
  describeSymbol,
  displaySymbolCode,
  FRIENDLY_DISMOUNTED_INFANTRY_SIDC,
  symbolSvg,
} from './symbology';

describe('symbology', () => {
  it('draws every Marine as a friendly dismounted individual (APP-6 D symbol set 27)', () => {
    expect(describeSymbol(FRIENDLY_DISMOUNTED_INFANTRY_SIDC)).toEqual({
      valid: true,
      affiliation: 'Friend',
      dimension: 'LandDismountedIndividual',
    });
  });

  it('accepts every symbol code in the default organization template', () => {
    const { template } = DEMO_SCENARIO.organization;
    const codes = [
      ...template.roles.map((r) => r.symbology.sidc),
      ...template.units.flatMap((u) => (u.symbology ? [u.symbology.sidc] : [])),
    ];
    for (const sidc of codes) expect(describeSymbol(sidc).valid).toBe(true);
    // Units are unit symbols (land unit, with an echelon), not individuals.
    for (const unit of template.units) {
      expect(describeSymbol(unit.symbology?.sidc ?? '').dimension).toBe('Ground');
    }
  });

  it('renders SVG with milsymbol, without a DOM', () => {
    const svg = symbolSvg(FRIENDLY_DISMOUNTED_INFANTRY_SIDC, 20);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toBe(symbolSvg(FRIENDLY_DISMOUNTED_INFANTRY_SIDC, 20));
  });

  it('falls back to a plain frame, not a guessed role, for codes it cannot draw', () => {
    expect(displaySymbolCode(FRIENDLY_DISMOUNTED_INFANTRY_SIDC)).toEqual({
      sidc: FRIENDLY_DISMOUNTED_INFANTRY_SIDC,
      fallback: false,
    });
    // An entity milsymbol does not know: same affiliation and symbol set, no icon.
    expect(displaySymbolCode('10032700009999990000')).toEqual({
      sidc: '10032700000000000000',
      fallback: true,
    });
    expect(displaySymbolCode('10062700009999990000').sidc).toBe('10062700000000000000');
    expect(displaySymbolCode('not a code')).toEqual({
      sidc: '10032700000000000000',
      fallback: true,
    });
    expect(symbolSvg('10032700009999990000', 20)).toBe(symbolSvg('10032700000000000000', 20));
  });
});
