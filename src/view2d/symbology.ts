import ms from 'milsymbol';

// Standard military symbols for organizations (docs/adr/0012, docs/adr/0013).
// Units (squad, fire teams, …) are drawn by milsymbol from the APP-6 symbol
// identification code (SIDC) in the organization template, e.g. in the roster
// headings. Individual soldiers are not APP-6 symbols: they use Ambush!'s own
// icons (soldier-icons.ts).

/** The APP-6 rendering style milsymbol uses for every symbol here. */
const STANDARD = 'APP6';

/** What milsymbol understands of a SIDC: whether it is valid and how it will be drawn. */
export function describeSymbol(sidc: string): {
  readonly valid: boolean;
  readonly affiliation: string;
  readonly dimension: string;
} {
  const symbol = new ms.Symbol(sidc, { standard: STANDARD });
  const check = symbol.isValid(true) as {
    affiliation?: unknown;
    dimension?: unknown;
    icon?: unknown;
    drawInstructions?: unknown;
  };
  return {
    valid: symbol.isValid() === true,
    affiliation: typeof check.affiliation === 'string' ? check.affiliation : '',
    dimension: typeof check.dimension === 'string' ? check.dimension : '',
  };
}

/** Frame of a friendly land unit with no icon: function unknown. */
const FRIENDLY_UNIT_FRAME_SIDC = '10031000000000000000';

/**
 * The code actually drawn for `sidc`. A code milsymbol cannot draw (e.g. an
 * entity it does not know) falls back to the same frame with no icon, keeping
 * affiliation and symbol set but claiming no function; failing that, to a
 * friendly land unit frame. Never to a guessed function.
 */
export function displaySymbolCode(sidc: string): {
  readonly sidc: string;
  readonly fallback: boolean;
} {
  if (describeSymbol(sidc).valid) return { sidc, fallback: false };
  const frameOnly = /^\d{20}$/.test(sidc) ? `${sidc.slice(0, 10)}0000000000` : '';
  return {
    sidc:
      frameOnly !== '' && describeSymbol(frameOnly).valid ? frameOnly : FRIENDLY_UNIT_FRAME_SIDC,
    fallback: true,
  };
}

/** The symbol as SVG markup (e.g. for the roster), `sizePx` being milsymbol's base size. */
export function symbolSvg(sidc: string, sizePx: number): string {
  return new ms.Symbol(displaySymbolCode(sidc).sidc, { size: sizePx, standard: STANDARD }).asSVG();
}
