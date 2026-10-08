import { describe, expect, it } from 'vitest';
import { DEMO_SCENARIO } from '#exercise';
import { describeSymbol, displaySymbolCode, symbolSvg } from './symbology';

/** The template's squad symbol: friendly land unit, infantry, squad echelon. */
const SQUAD_SIDC = '10031000121211000000';

describe('unit symbology (APP-6, milsymbol)', () => {
  it('accepts every unit symbol code in the default organization template', () => {
    const { template } = DEMO_SCENARIO.organization;
    const codes = template.units.flatMap((u) => (u.symbology ? [u.symbology.sidc] : []));
    expect(codes).toHaveLength(template.units.length);
    for (const sidc of codes) {
      // Units are unit symbols (land unit, with an echelon), not individuals.
      expect(describeSymbol(sidc)).toMatchObject({
        valid: true,
        affiliation: 'Friend',
        dimension: 'Ground',
      });
    }
  });

  it('renders SVG with milsymbol, without a DOM', () => {
    const svg = symbolSvg(SQUAD_SIDC, 20);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toBe(symbolSvg(SQUAD_SIDC, 20));
  });

  it('falls back to a plain frame, not a guessed function, for codes it cannot draw', () => {
    expect(displaySymbolCode(SQUAD_SIDC)).toEqual({ sidc: SQUAD_SIDC, fallback: false });
    // An entity milsymbol does not know: same affiliation and symbol set, no icon.
    expect(displaySymbolCode('10031000129999990000')).toEqual({
      sidc: '10031000120000000000',
      fallback: true,
    });
    expect(displaySymbolCode('10061000129999990000').sidc).toBe('10061000120000000000');
    expect(displaySymbolCode('not a code')).toEqual({
      sidc: '10031000000000000000',
      fallback: true,
    });
    expect(symbolSvg('10031000129999990000', 20)).toBe(symbolSvg('10031000120000000000', 20));
  });
});
