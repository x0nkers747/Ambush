import type { IndividualIcon } from '#exercise';
import type { Azimuth, Vec2 } from '#sim';

// Individual soldier icons (docs/adr/0013): custom Ambush! symbols designed for
// legibility at small sizes, deliberately not APP-6 or MIL-STD-2525. Each icon
// is a filled circle coloured by affiliation, a black outline, an upright
// black role glyph in the middle, and a triangle outside the circle pointing
// the way the soldier faces. Reference: assets/reference/individual-soldier-icons.png.
//
// Every shape is defined once, as SVG path data in icon units: the circle's
// diameter is 100 units, centred on the origin, y pointing down (screen and
// SVG convention). The same data produces SVG markup (roster, examples, tests)
// and canvas drawing (the map), so the two cannot drift apart.

/** Fill colour family of an icon. */
export type Affiliation = 'friendly' | 'enemy' | 'neutral' | 'unknown' | 'friendly2';

/** Background colours, taken from the reference image. */
export const AFFILIATION_COLORS: Readonly<Record<Affiliation, string>> = {
  friendly: '#5ec8f7',
  enemy: '#f25c5c',
  neutral: '#f8cd4f',
  unknown: '#a3a3a3',
  friendly2: '#7cc56e',
};

/** Outline, glyph and triangle-edge colour. */
export const ICON_INK = '#111111';

/** What to draw: the role glyph (`null`: role unknown, plain circle), the colour and the facing. */
export interface SoldierIconSpec {
  readonly role: IndividualIcon | null;
  readonly affiliation: Affiliation;
  /** Direction the triangle points, or `null` for no facing indicator (e.g. in lists). */
  readonly facing: Azimuth | null;
}

/** Radius of the circle's fill, and the outline drawn centred on it (outer edge at 50). */
const FILL_RADIUS = 46;
const OUTLINE_WIDTH = 8;
/** The facing triangle, pointing up (north) before rotation. */
const TRIANGLE = 'M0 -80L14 -56L-14 -56Z';
const TRIANGLE_OUTLINE_WIDTH = 5;
/** Half the side of the square that holds every part of an icon, triangle included. */
const EXTENT = 84;
/** Half the side of the square that holds the circle alone. */
const CIRCLE_EXTENT = 52;

/** How far the facing triangle reaches from the centre, relative to the circle's diameter. */
export const FACING_REACH = (80 + TRIANGLE_OUTLINE_WIDTH / 2) / 100;
/** Size of the full icon box (triangle included) relative to the circle's diameter. */
export const ICON_BOX_SCALE = (2 * EXTENT) / 100;

/** One shape of a glyph: filled or stroked, in ink or in the background colour. */
export interface GlyphShape {
  readonly d: string;
  readonly paint: 'fill' | 'stroke';
  /** `background` paints in the affiliation colour, e.g. the grooves of the grenade body. */
  readonly color: 'ink' | 'background';
  readonly width?: number;
  readonly cap?: 'butt' | 'round';
}

const fill = (d: string): GlyphShape => ({ d, paint: 'fill', color: 'ink' });
const stroke = (d: string, width: number, cap: 'butt' | 'round' = 'butt'): GlyphShape => ({
  d,
  paint: 'stroke',
  color: 'ink',
  width,
  cap,
});
const r = (n: number) => String(Math.round(n * 100) / 100);
const circlePath = (cx: number, cy: number, radius: number) =>
  `M${r(cx - radius)} ${r(cy)}a${r(radius)} ${r(radius)} 0 1 0 ${r(2 * radius)} 0a${r(radius)} ${r(radius)} 0 1 0 ${r(-2 * radius)} 0Z`;
const polygon = (points: readonly (readonly [number, number])[]) =>
  `M${points.map(([x, y]) => `${r(x)} ${r(y)}`).join('L')}Z`;

/** A five-pointed star, point up, centred on its bounding box. */
function star(outer: number, inner: number): string {
  const points: [number, number][] = [];
  for (let k = 0; k < 10; k += 1) {
    const radius = k % 2 === 0 ? outer : inner;
    const angle = (k * Math.PI) / 5;
    points.push([radius * Math.sin(angle), -radius * Math.cos(angle)]);
  }
  // The points span -outer to outer·cos 36° vertically; centre that span.
  const shift = (outer - outer * Math.cos(Math.PI / 5)) / 2;
  return polygon(points.map(([x, y]) => [x, y + shift]));
}

/** An upward chevron with its apex at (0, top). */
function chevron(top: number): string {
  const halfWidth = 26;
  const drop = 20;
  const thickness = 12;
  return polygon([
    [-halfWidth, top + drop],
    [0, top],
    [halfWidth, top + drop],
    [halfWidth, top + drop + thickness],
    [0, top + thickness],
    [-halfWidth, top + drop + thickness],
  ]);
}

/** An arc around (cx, cy) from angle a0 to a1 (radians, clockwise from +x in screen axes). */
function arc(cx: number, cy: number, radius: number, a0: number, a1: number): string {
  const x0 = cx + radius * Math.cos(a0);
  const y0 = cy + radius * Math.sin(a0);
  const x1 = cx + radius * Math.cos(a1);
  const y1 = cy + radius * Math.sin(a1);
  return `M${r(x0)} ${r(y0)}A${r(radius)} ${r(radius)} 0 0 1 ${r(x1)} ${r(y1)}`;
}

/**
 * The rifle grenade of the reference image: a segmented oval body, a short
 * neck with the lever curving down its left side, and a small ring at the
 * upper right. The grooves are painted in the background colour and stop at
 * the body's edge.
 */
function grenade(): GlyphShape[] {
  /** Scale and horizontal shift of the drawing below, which centre it in the circle. */
  const k = 1.2;
  const dx = 3;
  const x = (v: number) => r(k * (v + dx));
  const y = (v: number) => r(k * v);
  const cx = -3;
  const cy = 8;
  const rx = 17;
  const ry = 20;
  const across = (v: number) => rx * Math.sqrt(Math.max(0, 1 - ((v - cy) / ry) ** 2));
  const down = (u: number) => ry * Math.sqrt(Math.max(0, 1 - ((u - cx) / rx) ** 2));
  const grooves = [
    ...[-8.5, 0, 8.5].map((ox) => {
      const u = cx + ox;
      return `M${x(u)} ${y(cy - down(u))}L${x(u)} ${y(cy + down(u))}`;
    }),
    ...[-10, 0, 10].map((oy) => {
      const v = cy + oy;
      return `M${x(cx - across(v))} ${y(v)}L${x(cx + across(v))} ${y(v)}`;
    }),
  ];
  return [
    fill(
      `M${x(cx - rx)} ${y(cy)}A${r(k * rx)} ${r(k * ry)} 0 1 0 ${x(cx + rx)} ${y(cy)}A${r(k * rx)} ${r(k * ry)} 0 1 0 ${x(cx - rx)} ${y(cy)}Z`,
    ),
    { d: grooves.join(''), paint: 'stroke', color: 'background', width: 3 },
    fill(`M${x(-10)} ${y(-21)}L${x(2)} ${y(-21)}L${x(2)} ${y(-9)}L${x(-10)} ${y(-9)}Z`),
    stroke(
      `M${x(-10)} ${y(-17)}C${x(-20)} ${y(-17)} ${x(-24)} ${y(-8)} ${x(-23)} ${y(4)}`,
      5,
      'round',
    ),
    stroke(circlePath(k * (13 + dx), k * -21, k * 5.5), 3.5),
  ];
}

/** The black glyph of each role, upright, inside the circle (within about 34 units of the centre). */
const GLYPHS: Readonly<Record<IndividualIcon, readonly GlyphShape[]>> = {
  squadLeader: [fill(star(31, 12.5))],
  fireTeamLeader: [fill(chevron(-25.5)), fill(chevron(-6.5))],
  rifleman: [stroke('M0 -26L0 26', 6.5)],
  automaticRifleman: [stroke('M-11 -26L-11 26M11 -26L11 26', 6.5)],
  grenadier: grenade(),
  marksman: [stroke('M-31 0L31 0M0 -31L0 31', 5), fill(circlePath(0, 0, 10))],
  medic: [fill('M-9 -28H9V-9H28V9H9V28H-9V9H-28V-9H-9Z')],
  radioOperator: [
    fill(
      polygon([
        [-3, -10],
        [3, -10],
        [7, 28],
        [-7, 28],
      ]),
    ),
    fill(circlePath(0, -12, 6)),
    stroke(
      [14, 24]
        .flatMap((radius) => [
          arc(0, -12, radius, (-40 * Math.PI) / 180, (40 * Math.PI) / 180),
          arc(0, -12, radius, (140 * Math.PI) / 180, (220 * Math.PI) / 180),
        ])
        .join(''),
      5,
      'round',
    ),
  ],
};

/** The shapes of a role's glyph (none for an unknown role). Exposed for tests. */
export function glyphShapes(role: IndividualIcon | null): readonly GlyphShape[] {
  return role === null ? [] : GLYPHS[role];
}

const degrees = (azimuth: Azimuth) => r((azimuth * 180) / Math.PI);

function shapeSvg(shape: GlyphShape, background: string): string {
  const color = shape.color === 'ink' ? ICON_INK : background;
  return shape.paint === 'fill'
    ? `<path d="${shape.d}" fill="${color}"/>`
    : `<path d="${shape.d}" fill="none" stroke="${color}" stroke-width="${String(shape.width ?? 1)}" stroke-linecap="${shape.cap ?? 'butt'}" stroke-linejoin="round"/>`;
}

/**
 * The icon as standalone SVG markup. `sizePx` is the circle's diameter; with a
 * facing, the image is `ICON_BOX_SCALE` times that size so the triangle fits,
 * and the circle's centre is the image's centre.
 */
export function soldierIconSvg(spec: SoldierIconSpec, sizePx: number): string {
  const background = AFFILIATION_COLORS[spec.affiliation];
  const half = spec.facing === null ? CIRCLE_EXTENT : EXTENT;
  const pixels = r((sizePx * half) / 50);
  const triangle =
    spec.facing === null
      ? ''
      : `<g data-part="facing" transform="rotate(${degrees(spec.facing)})"><path d="${TRIANGLE}" fill="${background}" stroke="${ICON_INK}" stroke-width="${String(TRIANGLE_OUTLINE_WIDTH)}" stroke-linejoin="round"/></g>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels}" height="${pixels}" viewBox="${String(-half)} ${String(-half)} ${String(2 * half)} ${String(2 * half)}" data-role="${spec.role ?? 'none'}" data-affiliation="${spec.affiliation}">` +
    triangle +
    `<circle data-part="frame" r="${String(FILL_RADIUS)}" fill="${background}" stroke="${ICON_INK}" stroke-width="${String(OUTLINE_WIDTH)}"/>` +
    `<g data-part="glyph">${glyphShapes(spec.role)
      .map((s) => shapeSvg(s, background))
      .join('')}</g>` +
    '</svg>'
  );
}

/** Path2D objects, built once per path string (browser only). */
const paths = new Map<string, Path2D>();
function path2d(d: string): Path2D {
  let p = paths.get(d);
  if (!p) {
    p = new Path2D(d);
    paths.set(d, p);
  }
  return p;
}

/**
 * Draws the icon centred on `at` (canvas pixels), `sizePx` being the circle's
 * diameter. The triangle turns with the facing; the glyph stays upright.
 */
export function drawSoldierIcon(
  ctx: CanvasRenderingContext2D,
  spec: SoldierIconSpec,
  at: Vec2,
  sizePx: number,
): void {
  const background = AFFILIATION_COLORS[spec.affiliation];
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.scale(sizePx / 100, sizePx / 100);
  ctx.lineJoin = 'round';
  if (spec.facing !== null) {
    ctx.save();
    ctx.rotate(spec.facing);
    const triangle = path2d(TRIANGLE);
    ctx.fillStyle = background;
    ctx.fill(triangle);
    ctx.lineWidth = TRIANGLE_OUTLINE_WIDTH;
    ctx.strokeStyle = ICON_INK;
    ctx.stroke(triangle);
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(0, 0, FILL_RADIUS, 0, 2 * Math.PI);
  ctx.fillStyle = background;
  ctx.fill();
  ctx.lineWidth = OUTLINE_WIDTH;
  ctx.strokeStyle = ICON_INK;
  ctx.stroke();
  for (const shape of glyphShapes(spec.role)) {
    const color = shape.color === 'ink' ? ICON_INK : background;
    const p = path2d(shape.d);
    if (shape.paint === 'fill') {
      ctx.fillStyle = color;
      ctx.fill(p);
    } else {
      ctx.lineWidth = shape.width ?? 1;
      ctx.lineCap = shape.cap ?? 'butt';
      ctx.strokeStyle = color;
      ctx.stroke(p);
    }
  }
  ctx.restore();
}
