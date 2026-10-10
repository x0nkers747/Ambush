import { describe, expect, it } from 'vitest';
import { encodeMvt, QUANTICO_OVERTURE_TILES } from '#geo/fixtures';
import { decodeMvt, MvtError, ringArea, utf8 } from './mvt';

// Vector tile decoding (docs/adr/0023).

describe('decodeMvt', () => {
  it('reads layers, ids, properties of every value type, and geometry', () => {
    const bytes = encodeMvt([
      {
        name: 'building',
        extent: 4096,
        features: [
          {
            id: 7,
            type: 3,
            properties: {
              id: '08b2a1-ü-🏠',
              height: 12.5,
              num_floors: 3,
              is_underground: false,
              level: -1.25,
            },
            geometry: [
              [
                [10, 10],
                [110, 10],
                [110, 60],
                [10, 60],
              ],
              [
                [20, 20],
                [20, 30],
                [30, 30],
              ],
            ],
          },
          {
            type: 2,
            geometry: [
              [
                [0, 0],
                [5, -3],
                [-7, 9],
              ],
            ],
          },
          { type: 1, geometry: [[[4095, 4096]]] },
        ],
      },
      { name: 'other', extent: 512, features: [] },
    ]);
    const layers = decodeMvt(bytes);
    expect(layers.map((l) => [l.name, l.extent, l.features.length])).toEqual([
      ['building', 4096, 3],
      ['other', 512, 0],
    ]);
    const [polygon, line, point] = layers[0]?.features ?? [];
    expect(polygon).toEqual({
      id: 7,
      type: 3,
      properties: {
        id: '08b2a1-ü-🏠',
        height: 12.5,
        num_floors: 3,
        is_underground: false,
        level: -1.25,
      },
      geometry: [
        [
          [10, 10],
          [110, 10],
          [110, 60],
          [10, 60],
        ],
        [
          [20, 20],
          [20, 30],
          [30, 30],
        ],
      ],
    });
    // Exterior rings have a positive area (y runs south), holes a negative one.
    expect(ringArea(polygon?.geometry[0] ?? [])).toBe(5000);
    expect(ringArea(polygon?.geometry[1] ?? [])).toBe(-50);
    expect(line).toMatchObject({
      id: undefined,
      type: 2,
      geometry: [
        [
          [0, 0],
          [5, -3],
          [-7, 9],
        ],
      ],
    });
    expect(point?.geometry).toEqual([[[4095, 4096]]]);
  });

  it('refuses malformed data with an MvtError', () => {
    expect(() => decodeMvt(new Uint8Array([0x1a, 0x05, 0x0a]))).toThrow(MvtError);
    expect(() => decodeMvt(new Uint8Array([0x1a]))).toThrow(MvtError);
    // A geometry with a MoveTo that lacks its coordinates.
    const bad = new Uint8Array([0x1a, 0x08, 0x12, 0x06, 0x18, 0x03, 0x22, 0x02, 0x09, 0x02]);
    expect(() => decodeMvt(bad)).toThrow(MvtError);
  });

  it('reads real Overture building tiles', () => {
    for (const tile of QUANTICO_OVERTURE_TILES) {
      const layers = decodeMvt(tile.data ?? new Uint8Array());
      const building = layers.find((l) => l.name === 'building');
      expect(building?.extent).toBe(4096);
      expect(building?.features.length).toBeGreaterThan(10);
      for (const f of building?.features ?? []) {
        expect(f.type).toBe(3);
        expect(typeof f.properties['id']).toBe('string');
      }
    }
  });
});

describe('utf8', () => {
  it('decodes one- to four-byte sequences, and replaces invalid ones', () => {
    expect(utf8(new Uint8Array([0x41, 0xc3, 0xbc, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x8f, 0xa0]))).toBe(
      'Aü€🏠',
    );
    expect(utf8(new Uint8Array([0x41, 0xc3, 0x41, 0xff]))).toBe('A�A�');
  });
});
