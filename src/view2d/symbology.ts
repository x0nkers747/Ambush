import ms from 'milsymbol';

// Military symbols for the tactical map (docs/adr/0012). The standard part of
// each symbol (frame, affiliation colour and icon) is drawn by milsymbol from
// the symbol identification code (SIDC) in the organization template; Ambush!
// adds its own role label, facing indicator and selection halo around it.

/**
 * APP-6 D / MIL-STD-2525 D symbol identification code of a friendly
 * dismounted individual whose function is infantry (symbol set 27, entity
 * 11 01 01): the code the MCWP 3-11.2 template gives every Marine. The role
 * is not encoded in the symbol; the map shows it as a label.
 */
export const FRIENDLY_DISMOUNTED_INFANTRY_SIDC = '10032700001101010000';

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

/** Frame of a friendly dismounted individual with no icon: function unknown. */
const FRIENDLY_INDIVIDUAL_FRAME_SIDC = '10032700000000000000';

/**
 * The code actually drawn for `sidc`. A code milsymbol cannot draw (e.g. an
 * entity it does not know) falls back to the same frame with no icon, keeping
 * affiliation and symbol set but claiming no function; failing that, to a
 * friendly dismounted individual frame. Never to a guessed role symbol.
 */
export function displaySymbolCode(sidc: string): {
  readonly sidc: string;
  readonly fallback: boolean;
} {
  if (describeSymbol(sidc).valid) return { sidc, fallback: false };
  const frameOnly = /^\d{20}$/.test(sidc) ? `${sidc.slice(0, 10)}0000000000` : '';
  return {
    sidc:
      frameOnly !== '' && describeSymbol(frameOnly).valid
        ? frameOnly
        : FRIENDLY_INDIVIDUAL_FRAME_SIDC,
    fallback: true,
  };
}

/** The symbol as SVG markup (e.g. for the roster), `sizePx` being milsymbol's base size. */
export function symbolSvg(sidc: string, sizePx: number): string {
  return new ms.Symbol(displaySymbolCode(sidc).sidc, { size: sizePx, standard: STANDARD }).asSVG();
}

/** A rendered symbol: a bitmap at the device pixel ratio and where its centre is. */
export interface SymbolImage {
  readonly image: HTMLCanvasElement;
  /** Size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** The symbol's anchor (frame centre) in CSS pixels from the top left. */
  readonly anchor: { readonly x: number; readonly y: number };
}

const images = new Map<string, SymbolImage>();

/**
 * The symbol rendered once for the canvas and cached by code, size and pixel
 * ratio. A white outline keeps it legible over terrain shading.
 */
export function symbolImage(sidc: string, sizePx: number, dpr: number): SymbolImage {
  const key = `${sidc}|${String(sizePx)}|${String(dpr)}`;
  let cached = images.get(key);
  if (!cached) {
    const symbol = new ms.Symbol(displaySymbolCode(sidc).sidc, {
      size: sizePx,
      standard: STANDARD,
      outlineWidth: 2,
      outlineColor: 'rgba(255, 255, 255, 0.85)',
    });
    const { width, height } = symbol.getSize();
    cached = { image: symbol.asCanvas(dpr), width, height, anchor: symbol.getAnchor() };
    images.set(key, cached);
  }
  return cached;
}
