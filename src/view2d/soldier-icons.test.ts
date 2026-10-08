import { describe, expect, it } from 'vitest';
import { INDIVIDUAL_ICONS, type IndividualIcon } from '#exercise';
import { azimuthFromDegrees } from '#sim';
import {
  AFFILIATION_COLORS,
  FACING_REACH,
  glyphShapes,
  ICON_BOX_SCALE,
  ICON_INK,
  soldierIconSvg,
  type Affiliation,
} from './soldier-icons';

const AFFILIATIONS: readonly Affiliation[] = [
  'friendly',
  'enemy',
  'neutral',
  'unknown',
  'friendly2',
];

/** The markup of one `data-part` group or element of an icon. */
function part(svg: string, name: string): string {
  const match = new RegExp(`<(g|circle) data-part="${name}"[^>]*>(.*?)(</g>|$)`).exec(svg);
  return match ? match[0] : '';
}

const glyph = (svg: string) => part(svg, 'glyph');

describe('individual soldier icons', () => {
  it('draw every role in every affiliation: coloured circle, black outline, black glyph', () => {
    for (const role of INDIVIDUAL_ICONS) {
      for (const affiliation of AFFILIATIONS) {
        const svg = soldierIconSvg({ role, affiliation, facing: 0 }, 24);
        const colour = AFFILIATION_COLORS[affiliation];
        expect(part(svg, 'frame')).toContain(`fill="${colour}" stroke="${ICON_INK}"`);
        // Filled shapes and strokes alike are in ink.
        expect(glyph(svg)).toMatch(new RegExp(`(fill|stroke)="${ICON_INK}"`));
        expect(svg).toContain(`data-role="${role}"`);
      }
    }
  });

  it('use the reference palette: light blue friendly, light red enemy', () => {
    expect(AFFILIATION_COLORS).toEqual({
      friendly: '#5ec8f7',
      enemy: '#f25c5c',
      neutral: '#f8cd4f',
      unknown: '#a3a3a3',
      friendly2: '#7cc56e',
    });
  });

  it('give the eight roles eight different glyphs', () => {
    const glyphs = INDIVIDUAL_ICONS.map((role) =>
      glyph(soldierIconSvg({ role, affiliation: 'friendly', facing: null }, 24)),
    );
    expect(new Set(glyphs).size).toBe(8);
  });

  it('draw the dashes as described: one for a rifleman, two equal and evenly spaced for an automatic rifleman', () => {
    const [rifleman] = glyphShapes('rifleman');
    expect(rifleman?.d).toBe('M0 -26L0 26');
    const [ar] = glyphShapes('automaticRifleman');
    expect(ar?.d).toBe('M-11 -26L-11 26M11 -26L11 26');
    expect(ar?.width).toBe(rifleman?.width);
  });

  it('draw the grenadier as the reference rifle grenade: grooved body, neck, lever and ring', () => {
    const shapes = glyphShapes('grenadier');
    // Body, grooves (in the background colour), neck, lever, ring.
    expect(shapes.map((s) => [s.paint, s.color])).toEqual([
      ['fill', 'ink'],
      ['stroke', 'background'],
      ['fill', 'ink'],
      ['stroke', 'ink'],
      ['stroke', 'ink'],
    ]);
    const svg = soldierIconSvg({ role: 'grenadier', affiliation: 'enemy', facing: null }, 32);
    // The grooves show the circle's colour through the body.
    expect(glyph(svg)).toContain(`stroke="${AFFILIATION_COLORS.enemy}"`);
  });

  it('turn only the facing triangle; the glyph and circle stay upright', () => {
    for (const degrees of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const svg = soldierIconSvg(
        { role: 'grenadier', affiliation: 'friendly', facing: azimuthFromDegrees(degrees) },
        24,
      );
      expect(part(svg, 'facing')).toContain(`transform="rotate(${String(degrees)})"`);
      expect(glyph(svg)).not.toContain('transform');
      expect(part(svg, 'frame')).not.toContain('transform');
    }
  });

  it('point the triangle north (up the screen) at facing 0', () => {
    const svg = soldierIconSvg({ role: 'rifleman', affiliation: 'friendly', facing: 0 }, 24);
    expect(part(svg, 'facing')).toContain('d="M0 -80L14 -56L-14 -56Z"');
  });

  it('leave out the triangle without a facing, and the glyph without a role', () => {
    const plain = soldierIconSvg({ role: 'medic', affiliation: 'friendly', facing: null }, 24);
    expect(part(plain, 'facing')).toBe('');
    const unknownRole = soldierIconSvg({ role: null, affiliation: 'enemy', facing: 0 }, 24);
    expect(glyph(unknownRole)).toBe('<g data-part="glyph"></g>');
  });

  it('scale to any size: the circle is sizePx across, the box holds the triangle', () => {
    for (const size of [16, 24, 32]) {
      const svg = soldierIconSvg({ role: 'squadLeader', affiliation: 'friendly', facing: 0 }, size);
      const box = Math.round(size * ICON_BOX_SCALE * 100) / 100;
      expect(svg).toContain(`width="${String(box)}" height="${String(box)}"`);
      expect(svg).toContain('viewBox="-84 -84 168 168"');
    }
    // The triangle (outline included) stays inside the box.
    expect(FACING_REACH * 100).toBeLessThanOrEqual((ICON_BOX_SCALE * 100) / 2);
    const listed = soldierIconSvg(
      { role: 'squadLeader', affiliation: 'friendly', facing: null },
      16,
    );
    expect(listed).toContain('viewBox="-52 -52 104 104"');
  });

  it('keep every glyph well inside the circle', () => {
    // Coordinates of path data, excluding arc radii, flags and the like: a rough
    // but sufficient check that nothing reaches the outline (inner edge at 42).
    for (const role of INDIVIDUAL_ICONS as readonly IndividualIcon[]) {
      for (const shape of glyphShapes(role)) {
        const numbers = (shape.d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
        for (const n of numbers) expect(Math.abs(n), `${role}: ${shape.d}`).toBeLessThan(36);
      }
    }
  });

  it('produce identical markup for identical input', () => {
    const spec = { role: 'radioOperator', affiliation: 'neutral', facing: 1 } as const;
    expect(soldierIconSvg(spec, 24)).toBe(soldierIconSvg(spec, 24));
  });
});
