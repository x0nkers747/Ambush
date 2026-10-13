import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  type Texture,
} from 'three';
import {
  DECK_END_M,
  DECK_SEAT_M,
  DECK_THICKNESS_M,
  deckHalfWidth,
  levelAt,
  RoadSurface,
  type RoadStamp,
  type TerrainField,
} from '#sim/terrain-field';
import { srgbToLinear } from './srgb';
import { MATERIAL_TILE_M, MATERIALS, textureUrl, type MaterialName } from './ground-textures';

// Bridges (docs/adr/0049, research §5.6), drawn from the field's own bridge roads
// instead of the game's plan: the deck's top is the bridge road's profile,
// which meets its roads' levels exactly, and the field keeps the ground under
// it below its underside (decks.ts). Each deck has its slab, a parapet (road
// bridges) or railings (footbridges), abutments at its ends and piers where
// it stands high. The deck's top is surfaced as its road is.

const COLOURS = {
  concrete: 0x9d9a93,
  underside: 0x6f6d68,
  parapet: 0xa7a49c,
  post: 0x7e8183,
  railing: 0x5b5f61,
} as const;
/** Samples along a deck, metres. */
const STEP_M = 1;
const PARAPET_H = 0.85;
const PARAPET_W = 0.3;
const RAIL_HEIGHTS = [0.5, 1.05] as const;
const RAIL_W = 0.05;
const POST_W = 0.07;
const POST_STEP_M = 1.6;
/** Piers stand at most this far apart, where the deck is this high over the ground, metres. */
const PIER_STEP_M = 14;
const PIER_FROM_M = 1.2;
/** Abutments reach at most this far below the deck's underside (then into the ground), metres. */
const ABUTMENT_MAX_M = 1.5;

type Top = 'asphalt' | 'paving' | 'concrete';

interface Station {
  x: number;
  y: number;
  /** Unit normal to the left of the direction of travel. */
  nx: number;
  ny: number;
  z: number;
  s: number;
}

function stations(road: RoadStamp): Station[] {
  const total = road.cum[road.cum.length - 1] ?? 0;
  const n = Math.max(1, Math.ceil(total / STEP_M));
  const at = (s: number): [number, number] => {
    const cum = road.cum;
    let i = 0;
    while (i < cum.length - 2 && (cum[i + 1] ?? 0) < s) i += 1;
    const l = (cum[i + 1] ?? 0) - (cum[i] ?? 0);
    const t = l > 0 ? (s - (cum[i] ?? 0)) / l : 0;
    const xy = road.xy;
    const ax = xy[2 * i] ?? 0;
    const ay = xy[2 * i + 1] ?? 0;
    return [ax + t * ((xy[2 * i + 2] ?? 0) - ax), ay + t * ((xy[2 * i + 3] ?? 0) - ay)];
  };
  const out: Station[] = [];
  for (let k = 0; k <= n; k += 1) {
    const s = (total * k) / n;
    const [x, y] = at(s);
    const [x0, y0] = at(Math.max(0, s - 0.5));
    const [x1, y1] = at(Math.min(total, s + 0.5));
    const l = Math.hypot(x1 - x0, y1 - y0) || 1;
    out.push({ x, y, nx: -(y1 - y0) / l, ny: (x1 - x0) / l, z: levelAt(road, s), s });
  }
  return out;
}

class Builder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly uv: number[] = [];
  /** A quad a-b-c-d (counter-clockwise seen from outside), in map coordinates. */
  quad(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
    colour: number,
    tile = 0,
  ) {
    const rgb = [
      srgbToLinear((colour >> 16) & 255),
      srgbToLinear((colour >> 8) & 255),
      srgbToLinear(colour & 255),
    ];
    for (const p of [a, b, c, a, c, d]) {
      this.pos.push(p[0], p[2], -p[1]);
      this.col.push(...rgb);
      if (tile > 0) this.uv.push(p[0] / tile, p[1] / tile);
    }
  }
  /** A box from four corners of its base (counter-clockwise from above) between two heights, without its base. */
  box(base: [number, number][], z0: number, z1: number, colour: number) {
    const lo = base.map(([x, y]) => [x, y, z0] as [number, number, number]);
    const hi = base.map(([x, y]) => [x, y, z1] as [number, number, number]);
    for (let i = 0; i < 4; i += 1) {
      const j = (i + 1) % 4;
      const [a, b, c, d] = [lo[i], lo[j], hi[j], hi[i]];
      if (a && b && c && d) this.quad(a, b, c, d, colour);
    }
    const [h0, h1, h2, h3] = hi;
    if (h0 && h1 && h2 && h3) this.quad(h0, h1, h2, h3, colour);
  }
  geometry(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    if (this.uv.length > 0) g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** A box `along` × `across` centred on a station, between two heights. */
function stationBox(
  b: Builder,
  st: Station,
  offset: number,
  along: number,
  across: number,
  z0: number,
  z1: number,
  colour: number,
) {
  const tx = st.ny;
  const ty = -st.nx;
  const cx = st.x + st.nx * offset;
  const cy = st.y + st.ny * offset;
  const a = along / 2;
  const w = across / 2;
  b.box(
    [
      [cx - tx * a - st.nx * w, cy - ty * a - st.ny * w],
      [cx + tx * a - st.nx * w, cy + ty * a - st.ny * w],
      [cx + tx * a + st.nx * w, cy + ty * a + st.ny * w],
      [cx - tx * a + st.nx * w, cy - ty * a + st.ny * w],
    ],
    z0,
    z1,
    colour,
  );
}

export interface BridgeDecks {
  readonly group: Group;
  /** The ground textures' tints (linear, per material), once they have loaded. */
  setTints(tints: readonly number[]): void;
  dispose(): void;
}

export function createBridgeDecks(field: TerrainField): BridgeDecks {
  const body = new Builder();
  const tops: Record<Top, Builder> = {
    asphalt: new Builder(),
    paving: new Builder(),
    concrete: new Builder(),
  };
  const T = DECK_THICKNESS_M;
  for (const road of field.roads) {
    if (!road.bridge) continue;
    const st = stations(road);
    const h = deckHalfWidth(road);
    const foot = road.rule.rank <= 2;
    const top: Top =
      road.surface === RoadSurface.Asphalt
        ? 'asphalt'
        : road.surface === RoadSurface.Paving
          ? 'paving'
          : 'concrete';
    const tile = top === 'concrete' ? 0 : MATERIAL_TILE_M[top];
    const p = (s: Station, off: number, dz: number): [number, number, number] => [
      s.x + s.nx * off,
      s.y + s.ny * off,
      s.z + dz,
    ];
    for (let i = 0; i + 1 < st.length; i += 1) {
      const a = st[i];
      const b = st[i + 1];
      if (!a || !b) continue;
      const inner = foot ? h : h - PARAPET_W;
      tops[top].quad(
        p(a, -inner, 0),
        p(b, -inner, 0),
        p(b, inner, 0),
        p(a, inner, 0),
        COLOURS.concrete,
        tile,
      );
      // Underside.
      body.quad(p(a, h, -T), p(b, h, -T), p(b, -h, -T), p(a, -h, -T), COLOURS.underside);
      if (foot) {
        // Slab edges; rails along both sides.
        body.quad(p(a, h, -T), p(a, h, 0), p(b, h, 0), p(b, h, -T), COLOURS.concrete);
        body.quad(p(a, -h, 0), p(a, -h, -T), p(b, -h, -T), p(b, -h, 0), COLOURS.concrete);
        for (const side of [1, -1]) {
          const off = side * (h - POST_W);
          for (const rz of RAIL_HEIGHTS) {
            const r = RAIL_W / 2;
            const quads: [number, number, number, number][] = [
              [off - r, rz + r, off + r, rz + r],
              [off + r, rz - r, off - r, rz - r],
              [off + r, rz + r, off + r, rz - r],
              [off - r, rz - r, off - r, rz + r],
            ];
            for (const [o0, z0, o1, z1] of quads)
              body.quad(p(a, o0, z0), p(a, o1, z1), p(b, o1, z1), p(b, o0, z0), COLOURS.railing);
          }
        }
      } else {
        // Parapets: outer face (down over the slab's edge), top and inner face.
        for (const side of [1, -1]) {
          const o = side * h;
          const n = side * (h - PARAPET_W);
          const [s0, s1] = side > 0 ? [a, b] : [b, a];
          body.quad(
            p(s0, o, -T),
            p(s0, o, PARAPET_H),
            p(s1, o, PARAPET_H),
            p(s1, o, -T),
            COLOURS.parapet,
          );
          body.quad(
            p(s0, n, PARAPET_H),
            p(s1, n, PARAPET_H),
            p(s1, o, PARAPET_H),
            p(s0, o, PARAPET_H),
            COLOURS.parapet,
          );
          body.quad(
            p(s1, n, 0),
            p(s1, n, PARAPET_H),
            p(s0, n, PARAPET_H),
            p(s0, n, 0),
            COLOURS.parapet,
          );
        }
      }
    }
    // Posts along footbridges.
    if (foot) {
      const total = road.cum[road.cum.length - 1] ?? 0;
      const posts = Math.max(1, Math.round(total / POST_STEP_M));
      for (let k = 0; k <= posts; k += 1) {
        const s = st[Math.round((k / posts) * (st.length - 1))];
        if (!s) continue;
        for (const side of [1, -1])
          stationBox(
            body,
            s,
            side * (h - POST_W),
            POST_W,
            POST_W,
            s.z - 0.05,
            s.z + RAIL_HEIGHTS[1] + 0.04,
            COLOURS.post,
          );
      }
    }
    // Ends: the slab's end faces and the parapets' ends; abutments under them.
    const first = st[0];
    const last = st[st.length - 1];
    for (const [end, inward] of [
      [first, 1],
      [last, -1],
    ] as const) {
      if (!end) continue;
      const out = inward > 0 ? [h, -h] : [-h, h];
      const [l, r] = out as [number, number];
      body.quad(p(end, l, -T), p(end, r, -T), p(end, r, 0), p(end, l, 0), COLOURS.concrete);
      if (!foot)
        for (const side of [1, -1]) {
          const o = side * h;
          const n = side * (h - PARAPET_W);
          const [e0, e1] = side * inward > 0 ? [o, n] : [n, o];
          body.quad(
            p(end, e0, 0),
            p(end, e1, 0),
            p(end, e1, PARAPET_H),
            p(end, e0, PARAPET_H),
            COLOURS.parapet,
          );
        }
      // Abutment: from the deck's underside down into the ground, a little way in from the end.
      const depth = DECK_SEAT_M + DECK_END_M + 0.3;
      let low = end.z;
      for (const f of [0, 0.5, 1])
        for (const off of [-h, 0, h]) {
          const sx = end.x + inward * end.ny * depth * f + end.nx * off;
          const sy = end.y - inward * end.nx * depth * f + end.ny * off;
          low = Math.min(low, field.height(sx, sy));
        }
      const mid: Station = {
        ...end,
        x: end.x + inward * end.ny * (depth / 2),
        y: end.y - inward * end.nx * (depth / 2),
      };
      const bottom = Math.max(low, end.z - T - ABUTMENT_MAX_M) - 0.3;
      stationBox(body, mid, 0, depth, 2 * h, bottom, end.z - T, COLOURS.concrete);
    }
    // Piers where the deck stands high.
    const total = road.cum[road.cum.length - 1] ?? 0;
    if (total > 2 * (DECK_END_M + 2)) {
      const piers = Math.max(1, Math.round(total / PIER_STEP_M) - 1);
      for (let k = 1; k <= piers; k += 1) {
        const s = st[Math.round((k / (piers + 1)) * (st.length - 1))];
        if (!s) continue;
        const g = field.height(s.x, s.y);
        if (s.z - T - g < PIER_FROM_M) continue;
        stationBox(body, s, 0, 0.8, 1.4 * h, g - 0.6, s.z - T, COLOURS.underside);
      }
    }
  }

  const group = new Group();
  group.name = 'bridges';
  const disposers: (() => void)[] = [];
  // Double-sided: rails and boxes are built without regard to winding.
  const bodyMaterial = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    side: DoubleSide,
  });
  const bodyMesh = new Mesh(body.geometry(), bodyMaterial);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(bodyMesh);
  disposers.push(() => {
    bodyMesh.geometry.dispose();
    bodyMaterial.dispose();
  });
  const loader = new TextureLoader();
  const textured: { material: MeshStandardMaterial; name: MaterialName }[] = [];
  for (const kind of ['asphalt', 'paving', 'concrete'] as const) {
    const b = tops[kind];
    if (b.pos.length === 0) continue;
    const material = new MeshStandardMaterial({
      vertexColors: kind === 'concrete',
      color: 0xffffff,
      roughness: kind === 'concrete' ? 0.85 : 0.92,
      metalness: 0,
      // Over the road where it meets the deck's end, at the same level.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    if (kind !== 'concrete') {
      const maps: Texture[] = [];
      for (const [slot, srgb] of [
        ['albedo', true],
        ['normal', false],
      ] as const) {
        const t = loader.load(textureUrl(kind, slot), () => {
          material.needsUpdate = true;
        });
        t.wrapS = RepeatWrapping;
        t.wrapT = RepeatWrapping;
        t.anisotropy = 8;
        if (srgb) {
          t.colorSpace = SRGBColorSpace;
          material.map = t;
        } else material.normalMap = t;
        maps.push(t);
      }
      textured.push({ material, name: kind });
      disposers.push(() => {
        for (const t of maps) t.dispose();
      });
    }
    const mesh = new Mesh(b.geometry(), material);
    mesh.receiveShadow = true;
    group.add(mesh);
    disposers.push(() => {
      mesh.geometry.dispose();
      material.dispose();
    });
  }
  return {
    group,
    setTints(tints) {
      for (const { material, name } of textured) {
        const i = MATERIALS.indexOf(name);
        material.color = new Color(tints[3 * i] ?? 1, tints[3 * i + 1] ?? 1, tints[3 * i + 2] ?? 1);
      }
    },
    dispose() {
      for (const d of disposers) d();
      group.clear();
    },
  };
}
