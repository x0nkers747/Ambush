import { PAVED_AREA_SURFACE, SAND_FLAG } from '#sim/terrain-field';
import { MATERIAL_TILE_M, MATERIALS } from './ground-textures';

/** Shoulder or pavement widths beside a carriageway, metres: urban, rural asphalt, other surfaces. */
export const SHOULDER_M = { urban: 1.25, asphalt: 0.85, other: 0.45 } as const;
/** Slope (1 − the normal's up component) from which steep ground starts to show rock. */
export const ROCK_FROM = 0.3;
/** Where the ground's fine detail starts to fade by default, metres (`labDetail`). */
export const DETAIL_DEFAULT_M = 60;

// GLSL for the terrain (docs/adr/0049), spliced into three's MeshStandardMaterial so its
// lighting, shadows, fog and tone mapping are the game's own.
//
// Vertex: each instance is one CDLOD node (research §5.4): a 32 × 32 grid
// whose heights are read from the tile atlas (exact lattice samples, the
// simulation's own at level 0) and morphed towards the next coarser level
// near the node's range, so levels meet without cracks or popping.
//
// Fragment: the ground's material is composed per pixel from the tile's
// material fields (distances to road edges, shores and walls; land cover
// weights; wetness), so road edges and shores stay crisp at any distance from
// 0.25–1 m samples. Up to three materials are blended by height; each is
// sampled with hex tiling (Heitz & Neyret 2018 style) to hide repetition.

const tileScales = MATERIALS.map((m) => (1 / MATERIAL_TILE_M[m]).toFixed(5)).join(', ');

export const VERTEX_HEAD = /* glsl */ `
precision highp sampler2DArray;
attribute vec4 iNode;   // origin x, origin y (map frame), spacing, level
attribute vec4 iTile;   // atlas layer, cell offset x, cell offset y, range
uniform sampler2DArray labHeight;
uniform vec3 labCam;     // camera, map frame (x east, y north, z up)
uniform float labMorph;  // 1: morph, 0: off (debug)
varying vec2 vLattice;
varying vec3 vMap;
varying vec3 vMapNormal;
flat varying float vLayer;
flat varying float vLevel;
flat varying float vSpacing;
varying float vMorph;

float labH(vec2 p, int layer) {
  vec2 ip = floor(p);
  vec2 f = p - ip;
  ivec2 i = ivec2(ip) + 1;
  float sw = texelFetch(labHeight, ivec3(i, layer), 0).r;
  float se = texelFetch(labHeight, ivec3(i + ivec2(1, 0), layer), 0).r;
  float nw = texelFetch(labHeight, ivec3(i + ivec2(0, 1), layer), 0).r;
  float ne = texelFetch(labHeight, ivec3(i + ivec2(1, 1), layer), 0).r;
  return f.x >= f.y ? sw + f.x * (se - sw) + f.y * (ne - se) : sw + f.y * (nw - sw) + f.x * (ne - nw);
}
vec3 labN(vec2 p, int layer, float sp) {
  ivec2 i = ivec2(floor(p + 0.5)) + 1;
  float l = texelFetch(labHeight, ivec3(i - ivec2(1, 0), layer), 0).r;
  float r = texelFetch(labHeight, ivec3(i + ivec2(1, 0), layer), 0).r;
  float d = texelFetch(labHeight, ivec3(i - ivec2(0, 1), layer), 0).r;
  float u = texelFetch(labHeight, ivec3(i + ivec2(0, 1), layer), 0).r;
  return normalize(vec3((l - r) / (2.0 * sp), (d - u) / (2.0 * sp), 1.0));
}
`;

export const VERTEX_BODY = /* glsl */ `
  int layer = int(iTile.x + 0.5);
  float sp = iNode.z;
  vec2 g = position.xy;
  vec2 cell = iTile.yz;
  vec2 wxy = iNode.xy + g * sp;
  float h0 = labH(g + cell, layer);
  float dist = distance(labCam, vec3(wxy, h0));
  float range = iTile.w;
  float k = labMorph * clamp((dist - range * 0.7) / (range * 0.25), 0.0, 1.0);
  vec2 fr = fract(g * 0.5) * 2.0;
  vec2 gm = g - fr * k;
  float h = labH(gm + cell, layer);
  vec2 mxy = iNode.xy + gm * sp;
  vec3 n = normalize(mix(labN(g + cell, layer, sp), labN(g - fr + cell, layer, sp), k));
  vLattice = gm + cell;
  vMap = vec3(mxy, h);
  vMapNormal = n;
  vLayer = iTile.x;
  vLevel = iNode.w;
  vSpacing = sp;
  vMorph = k;
  transformed = vec3(mxy.x, h, -mxy.y);
`;

export const VERTEX_NORMAL = /* glsl */ `
  objectNormal = vec3(0.0, 1.0, 0.0);
`;

export const FRAGMENT_HEAD = /* glsl */ `
precision highp sampler2DArray;
uniform sampler2DArray labMatA;
uniform sampler2DArray labMatB;
uniform sampler2DArray labAlbedo;
uniform sampler2DArray labNormalMap;
uniform sampler2DArray labHra;
uniform float labStride;
uniform float labCells;
uniform int labDebug;       // 0 off, 1 LOD levels, 2 tile edges, 3 material fields
uniform int labAdvanced;    // 1: hex tiling, height blending, detail
uniform float labDetail;    // where fine detail starts to fade, metres (gone at 3×)
uniform vec3 labCam;
uniform vec4 labBounds;     // minX, minY, maxX, maxY
uniform vec3 labTint[${String(MATERIALS.length)}];
uniform sampler2D labOverlay;
uniform vec4 labOverlayXform;
uniform float labOverlayOn;
varying vec2 vLattice;
varying vec3 vMap;
varying vec3 vMapNormal;
flat varying float vLayer;
flat varying float vLevel;
flat varying float vSpacing;
varying float vMorph;

const float LAB_SCALE[${String(MATERIALS.length)}] = float[](${tileScales});
vec3 labAlbedoOut;
vec3 labNormalOut;   // map frame
float labRoughOut;

float labHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 labHash2(vec2 p) {
  return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}
float labNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(labHash(i), labHash(i + vec2(1, 0)), u.x), mix(labHash(i + vec2(0, 1)), labHash(i + vec2(1, 1)), u.x), u.y);
}

// Hex (triangle grid) tiling: three randomly offset samples blended.
void labTri(vec2 uv, out vec3 w, out vec2 o1, out vec2 o2, out vec2 o3) {
  vec2 sk = mat2(1.0, -0.57735027, 0.0, 1.15470054) * (uv * 3.4641016);
  vec2 b = floor(sk);
  vec3 t = vec3(fract(sk), 0.0);
  t.z = 1.0 - t.x - t.y;
  vec2 v1, v2, v3;
  if (t.z > 0.0) { w = vec3(t.z, t.y, t.x); v1 = b; v2 = b + vec2(0, 1); v3 = b + vec2(1, 0); }
  else { w = vec3(-t.z, 1.0 - t.y, 1.0 - t.x); v1 = b + vec2(1, 1); v2 = b + vec2(1, 0); v3 = b + vec2(0, 1); }
  o1 = labHash2(v1); o2 = labHash2(v2); o3 = labHash2(v3);
  w = pow(w, vec3(4.0));
  w /= (w.x + w.y + w.z);
}

struct LabSample { vec3 albedo; vec3 normal; vec3 hra; };

// Gradients are taken once, in uniform control flow, and passed in.
LabSample labSample(int m, vec2 xy, vec2 gx, vec2 gy, float far) {
  vec2 uv = xy * LAB_SCALE[m];
  vec2 dx = gx * LAB_SCALE[m], dy = gy * LAB_SCALE[m];
  float lm = float(m);
  LabSample s;
  vec3 tint = labTint[m];
  if (labAdvanced == 0 || far > 0.99) {
    s.albedo = textureGrad(labAlbedo, vec3(uv, lm), dx, dy).rgb;
    // Far away: a second, larger sample breaks the repeat.
    s.albedo = mix(s.albedo, textureGrad(labAlbedo, vec3(uv * 0.21 + 0.37, lm), dx * 0.21, dy * 0.21).rgb, 0.4 * far);
    s.normal = textureGrad(labNormalMap, vec3(uv, lm), dx, dy).rgb;
    s.hra = textureGrad(labHra, vec3(uv, lm), dx, dy).rgb;
  } else {
    vec3 w; vec2 o1, o2, o3;
    labTri(uv * 0.55, w, o1, o2, o3);
    vec3 a1 = textureGrad(labAlbedo, vec3(uv + o1, lm), dx, dy).rgb;
    vec3 a2 = textureGrad(labAlbedo, vec3(uv + o2, lm), dx, dy).rgb;
    vec3 a3 = textureGrad(labAlbedo, vec3(uv + o3, lm), dx, dy).rgb;
    vec3 mean = textureLod(labAlbedo, vec3(0.5, 0.5, lm), 10.0).rgb;
    vec3 blend = w.x * a1 + w.y * a2 + w.z * a3;
    // Variance-preserving blend: keeps the texture's contrast where samples mix.
    s.albedo = clamp((blend - mean) / sqrt(dot(w, w)) + mean, 0.0, 1.0);
    s.normal = w.x * textureGrad(labNormalMap, vec3(uv + o1, lm), dx, dy).rgb
      + w.y * textureGrad(labNormalMap, vec3(uv + o2, lm), dx, dy).rgb
      + w.z * textureGrad(labNormalMap, vec3(uv + o3, lm), dx, dy).rgb;
    s.hra = w.x * textureGrad(labHra, vec3(uv + o1, lm), dx, dy).rgb
      + w.y * textureGrad(labHra, vec3(uv + o2, lm), dx, dy).rgb
      + w.z * textureGrad(labHra, vec3(uv + o3, lm), dx, dy).rgb;
    s.albedo = mix(s.albedo, blend, far);
  }
  s.albedo *= tint;
  return s;
}

// Rock on steep ground: triplanar, so cliffs are not stretched.
LabSample labRock(vec3 p, vec3 n, vec3 px, vec3 py) {
  vec3 bw = pow(abs(n), vec3(4.0));
  bw /= (bw.x + bw.y + bw.z);
  float s = LAB_SCALE[5];
  LabSample r;
  vec3 ax = textureGrad(labAlbedo, vec3(p.yz * s, 5.0), px.yz * s, py.yz * s).rgb;
  vec3 ay = textureGrad(labAlbedo, vec3(p.xz * s, 5.0), px.xz * s, py.xz * s).rgb;
  vec3 az = textureGrad(labAlbedo, vec3(p.xy * s, 5.0), px.xy * s, py.xy * s).rgb;
  r.albedo = (ax * bw.x + ay * bw.y + az * bw.z) * labTint[5];
  vec3 nx = textureGrad(labNormalMap, vec3(p.yz * s, 5.0), px.yz * s, py.yz * s).rgb * 2.0 - 1.0;
  vec3 ny = textureGrad(labNormalMap, vec3(p.xz * s, 5.0), px.xz * s, py.xz * s).rgb * 2.0 - 1.0;
  vec3 nz = textureGrad(labNormalMap, vec3(p.xy * s, 5.0), px.xy * s, py.xy * s).rgb * 2.0 - 1.0;
  // Whiteout blend of each projection's normal into world space.
  vec3 tx = vec3(0.0, nx.x, nx.y) * sign(n.x);
  vec3 ty = vec3(ny.x, 0.0, ny.y) * sign(n.y);
  vec3 tz = vec3(nz.xy, 0.0);
  r.normal = normalize(n + tx * bw.x + ty * bw.y + tz * bw.z) * 0.5 + 0.5;
  r.hra = textureGrad(labHra, vec3(p.xy * s, 5.0), px.xy * s, py.xy * s).rgb;
  return r;
}

void labMaterial() {
  int layer = int(vLayer + 0.5);
  vec2 uvm = (vLattice + 1.5) / labStride;
  vec4 A = texture(labMatA, vec3(uvm, vLayer));
  vec4 B = texture(labMatB, vec3(uvm, vLayer));
  int code = int(texelFetch(labMatA, ivec3(ivec2(floor(vLattice + 0.5)) + 1, layer), 0).a * 255.0 + 0.5);
  int shoreKind = (code >> 3) & 3;
  bool urban = (code & 64) != 0;
  // The four samples round this point. Each holds a road edge's distance
  // (with that road's surface, 1–5), or, more than ROAD_KEEP_M from roads, a
  // mapped paved area's edge distance (surface ${String(PAVED_AREA_SURFACE)}), and the paved
  // flag (towns' frontage; paved areas' insides near roads). Roads and paved
  // ground are each blended from their own samples only: blending one kind's
  // distance with the other's drew a sliver of edge where they met.
  //
  // Roads where samples are 2 m apart or more: a distance changes by at most a
  // metre a metre, so each road sample bounds it from below by its own less
  // the way to it, and the largest bound is taken. The plain blend
  // overestimates it near a road's centreline, so a path narrower than the
  // samples' spacing showed only where a sample fell near it (dashes). A
  // sample at the encoding's limit (12 m) bounds nothing useful, so with any
  // such sample, or one that is not a road's, the blend is kept. Closer, the
  // blend is exact enough, and the bounds turned single samples just off a
  // road into discs of verge.
  float roadE = 0.0;
  float bound = -100.0;
  bool bounded = vSpacing >= 2.0;
  float areaE = 0.0;
  int surf = 0;
  float sw[8];
  for (int i = 0; i < 8; i++) sw[i] = 0.0;
  // Bare sand (beaches, dunes): the samples' flags, blended.
  float sandS = 0.0;
  {
    vec2 f = fract(vLattice);
    ivec2 c0 = ivec2(floor(vLattice)) + 1;
    float nearestE = 1e9;
    for (int j = 0; j < 2; j++)
      for (int i = 0; i < 2; i++) {
        vec4 t = texelFetch(labMatA, ivec3(c0 + ivec2(i, j), layer), 0);
        float wk = (i == 1 ? f.x : 1.0 - f.x) * (j == 1 ? f.y : 1.0 - f.y);
        float e = mix(-4.0, 12.0, t.r);
        int c = int(t.a * 255.0 + 0.5);
        int s = c & 7;
        if ((c & ${String(SAND_FLAG)}) != 0) sandS += wk;
        bool isArea = s == ${String(PAVED_AREA_SURFACE)};
        // A paved area's sample is at least ROAD_KEEP_M (2 m) from any road.
        roadE += wk * (isArea ? 2.0 : e);
        areaE += wk * (isArea ? e : ((c & 128) != 0 ? -4.0 : 12.0));
        if (isArea || e > 11.8) bounded = false;
        bound = max(bound, e - length(f - vec2(float(i), float(j))) * vSpacing);
        if (s != 0 && !isArea) {
          sw[s] += wk;
          if (e < nearestE) {
            nearestE = e;
            surf = s;
          }
        }
      }
  }
  if (bounded) roadE = bound;
  float shore = mix(-6.0, 10.0, A.g);
  float bld = mix(0.0, 8.0, A.b);
  vec3 n = normalize(vMapNormal);
  float dist = distance(labCam, vMap);
  vec3 gpx = dFdx(vMap);
  vec3 gpy = dFdy(vMap);
  float n1 = labNoise(vMap.xy * 1.7);
  float n2 = labNoise(vMap.xy * 0.37);
  float n3 = labNoise(vMap.xy * 0.045);

  float w[${String(MATERIALS.length)}];
  for (int i = 0; i < ${String(MATERIALS.length)}; i++) w[i] = 0.0;
  float cover = max(B.r + B.g + B.b, 0.001);
  // Land cover. Grass in three textures (grass, lush, dense), blended in
  // broad patches tens of metres across; bare soil only in large patches.
  float lush = smoothstep(0.25, 0.85, labNoise(vMap.xy * 0.03 + 17.0));
  float dense = smoothstep(0.3, 0.9, labNoise(vMap.xy * 0.05 + 41.0));
  // Where grass meets forest litter (a wood's edge), patches of each a metre
  // or two across reach into the other, rather than a smooth fade.
  float edge = clamp(4.0 * B.r * B.b / (cover * cover), 0.0, 1.0);
  float patches = labNoise(vMap.xy * 0.55 + 23.0) * 0.65 + labNoise(vMap.xy * 1.9 + 3.0) * 0.35;
  float shift = (patches - 0.5) * 2.2 * edge;
  float grassy = B.r * clamp(1.0 + shift, 0.0, 2.0);
  w[3] = grassy * (1.0 - lush) * (1.0 - dense);
  w[9] = grassy * lush;
  w[10] = grassy * (1.0 - lush) * dense;
  w[2] = B.g * smoothstep(0.35, 0.65, labNoise(vMap.xy * 0.06 + 5.0));
  w[7] = B.b * clamp(1.0 - shift, 0.0, 2.0);
  // Steeper slopes show some earth; steep ones rock.
  float slope = 1.0 - n.z;
  w[2] += smoothstep(0.28, 0.42, slope + (n2 - 0.5) * 0.1) * 0.35;
  float rock = smoothstep(${ROCK_FROM.toFixed(2)}, ${(ROCK_FROM + 0.15).toFixed(2)}, slope + (n1 - 0.5) * 0.06);
  // Beaches and dunes: sand all over (not the cover's grass and soil in
  // patches), its edge with the land behind ragged over a metre or two.
  float sand = smoothstep(0.3, 0.7, sandS + (n1 - 0.5) * 0.3 + (n2 - 0.5) * 0.3);
  if (sand > 0.0) {
    for (int i = 0; i < ${String(MATERIALS.length)}; i++) w[i] *= 1.0 - sand;
    w[6] += sand;
  }
  // Paved ground (docs/adr/0048): mapped paved areas to their outlines;
  // towns' pavements, forecourts and yards, and paved areas' insides near
  // roads, by the samples' paved flags.
  float paved = 1.0 - smoothstep(-0.02, 0.02, areaE);
  if (paved > 0.0) {
    for (int i = 0; i < ${String(MATERIALS.length)}; i++) w[i] *= 1.0 - paved;
    w[8] += paved;
  }
  // Damp ground (ditches, banks): a little mud; mostly darker grass (below).
  w[4] += B.a * B.a * 0.35;

  // Roads: carriageway and shoulder or pavement with exact, straight edges;
  // then a worn, ragged verge.
  float road = 0.0;
  float hard = 0.0;
  if (surf != 0) {
    float e = roadE;
    // Tracks and dirt paths: a slightly softer edge.
    float soft = surf == 4 || surf == 5 ? 0.12 : 0.02;
    road = 1.0 - smoothstep(-soft, soft, e);
    float shW = urban ? ${SHOULDER_M.urban.toFixed(2)} : (surf == 1 ? ${SHOULDER_M.asphalt.toFixed(2)} : ${SHOULDER_M.other.toFixed(2)});
    float shoulder = (1.0 - road) * (1.0 - smoothstep(shW - soft, shW + soft, e));
    hard = road + shoulder;
    // No worn verge on paved ground (a car park's aisles).
    float verge = (1.0 - paved) * (1.0 - road - shoulder) * (1.0 - smoothstep(0.0, 1.6, e - shW + (n2 - 0.5) * 0.8));
    float keep = 1.0 - road - shoulder;
    for (int i = 0; i < ${String(MATERIALS.length)}; i++) w[i] *= keep;
    float swSum = 0.0;
    for (int i = 1; i < 6; i++) {
      sw[i] = smoothstep(0.2, 0.8, sw[i]);
      swSum += sw[i];
    }
    for (int i = 1; i < 6; i++) sw[i] = swSum > 0.0 ? sw[i] / swSum : (i == surf ? 1.0 : 0.0);
    w[0] += road * sw[1];
    w[8] += road * sw[2];
    w[1] += road * sw[3];
    w[2] += road * sw[5];
    // Track: grass down the middle, earth in the wheel ruts.
    float mid = 1.0 - smoothstep(-1.05, -0.8, roadE + (n1 - 0.5) * 0.2);
    w[3] += road * sw[4] * mid;
    w[2] += road * sw[4] * (1.0 - mid) * 0.8;
    w[1] += road * sw[4] * (1.0 - mid) * 0.2;
    // Shoulders: paving in towns, gravel beside asphalt and gravel roads, earth otherwise.
    float paved = sw[1] + sw[2] + sw[3];
    // (Paved paths are edged with paving everywhere.)
    w[8] += shoulder * (urban ? paved : sw[2]);
    w[1] += shoulder * (urban ? 0.0 : sw[1] + sw[3]);
    w[2] += shoulder * (sw[4] + sw[5]);
    w[2] += verge * 0.2;
    w[1] += verge * 0.1 * sw[1];
  }
  // Shores: sand or mud at the water's edge.
  float bankW = shoreKind == 1 ? 1.4 : 0.6;
  float bank = 1.0 - smoothstep(bankW * 0.15, bankW, shore + (n1 - 0.5) * 0.3 * bankW + (n2 - 0.5) * 0.6 * bankW);
  bank *= (1.0 - road);
  if (shoreKind != 0) {
    for (int i = 0; i < ${String(MATERIALS.length)}; i++) w[i] *= (1.0 - bank);
    if (shoreKind == 1) { w[6] += bank * 0.8; w[1] += bank * 0.2; }
    else { w[4] += bank * 0.75; w[2] += bank * 0.25; }
  }
  float damp = shoreKind != 0 ? 1.0 - smoothstep(0.5, 3.5, shore) : 0.0;
  damp = max(damp, B.a * 0.8);
  // A strip of gravel or paving along walls.
  float drip = (1.0 - smoothstep(0.35, 0.65, bld + (n1 - 0.5) * 0.15)) * (1.0 - road);
  for (int i = 0; i < ${String(MATERIALS.length)}; i++) w[i] *= (1.0 - drip);
  if (urban) w[8] += drip; else w[1] += drip;
  float trodden = (1.0 - smoothstep(0.5, 2.0, bld)) * (1.0 - drip) * 0.2;
  w[2] += trodden;

  // The three strongest, blended by height.
  int m0 = 3, m1 = 2, m2 = 7;
  float b0 = -1.0, b1 = -1.0, b2 = -1.0;
  for (int i = 0; i < ${String(MATERIALS.length)}; i++) {
    float v = w[i];
    if (v > b0) { b2 = b1; m2 = m1; b1 = b0; m1 = m0; b0 = v; m0 = i; }
    else if (v > b1) { b2 = b1; m2 = m1; b1 = v; m1 = i; }
    else if (v > b2) { b2 = v; m2 = i; }
  }
  float far = smoothstep(labDetail * 2.0, labDetail * 3.7, dist);
  // Parallax near one's feet: the strongest material's height shifts where
  // all three are read, so stones and cobbles stand out of the ground.
  vec2 at = vMap.xy;
  if (labAdvanced == 1 && dist < 14.0) {
    vec3 V = normalize(labCam - vMap);
    vec3 Tp = normalize(vec3(1.0, 0.0, 0.0) - n * n.x);
    vec3 Bp = cross(n, Tp);
    vec2 uv0 = vMap.xy * LAB_SCALE[m0];
    float h0 = textureGrad(labHra, vec3(uv0, float(m0)), gpx.xy * LAB_SCALE[m0], gpy.xy * LAB_SCALE[m0]).r;
    vec2 shift = vec2(dot(V, Tp), dot(V, Bp)) / max(dot(V, n), 0.25) * (h0 - 0.5) * 0.035;
    at += shift * (1.0 - smoothstep(8.0, 14.0, dist));
  }
  LabSample s0 = labSample(m0, at, gpx.xy, gpy.xy, far);
  LabSample s1 = s0;
  LabSample s2 = s0;
  if (b1 > 0.02) s1 = labSample(m1, at, gpx.xy, gpy.xy, far);
  if (b2 > 0.02) s2 = labSample(m2, at, gpx.xy, gpy.xy, far);
  float sum = max(b0 + max(b1, 0.0) + max(b2, 0.0), 1e-4);
  vec3 bw = vec3(b0, max(b1, 0.0), max(b2, 0.0)) / sum;
  if (labAdvanced == 1) {
    vec3 hh = vec3(s0.hra.r, s1.hra.r, s2.hra.r) * 0.6 + bw;
    float top = max(hh.x, max(hh.y, hh.z)) - 0.18;
    vec3 byHeight = max(hh - top, 0.0);
    byHeight /= max(byHeight.x + byHeight.y + byHeight.z, 1e-4);
    // Not across a carriageway's or shoulder's edge: those stay straight.
    bw = mix(byHeight, bw, smoothstep(0.0, 0.05, hard));
  }
  vec3 albedo = s0.albedo * bw.x + s1.albedo * bw.y + s2.albedo * bw.z;
  vec3 tn = (s0.normal * bw.x + s1.normal * bw.y + s2.normal * bw.z) * 2.0 - 1.0;
  vec3 hra = s0.hra * bw.x + s1.hra * bw.y + s2.hra * bw.z;
  // Grass and litter are too smooth in their maps: rough ground.
  float rough = hra.g;
  if (m0 == 3 || m0 == 7 || m0 == 9 || m0 == 10) rough = mix(rough, 0.92, 0.7);
  // Mud is wet: smoother, so it catches the light.
  rough = mix(rough, 0.42, bw.x * (m0 == 4 ? 1.0 : 0.0) + bw.y * (m1 == 4 ? 1.0 : 0.0) + bw.z * (m2 == 4 ? 1.0 : 0.0));
  // Tangent frame: map x east, y north, along the ground.
  vec3 T = normalize(vec3(1.0, 0.0, 0.0) - n * n.x);
  vec3 Bt = cross(n, T);
  float detail = labAdvanced == 1 ? (1.0 - smoothstep(labDetail, labDetail * 3.0, dist)) : 0.4;
  vec3 nm = normalize(T * tn.x * detail + Bt * tn.y * detail + n * max(tn.z, 0.2));
  if (rock > 0.001) {
    LabSample r = labRock(vMap, n, gpx, gpy);
    albedo = mix(albedo, r.albedo, rock);
    nm = normalize(mix(nm, r.normal * 2.0 - 1.0, rock));
    rough = mix(rough, r.hra.g, rock);
    hra.b = mix(hra.b, r.hra.b, rock);
  }
  // Broad variation: drier and greener patches, tens of metres across.
  vec3 tint = mix(vec3(1.06, 1.02, 0.86), vec3(0.9, 1.0, 0.97), n3);
  albedo *= mix(vec3(1.0), tint, clamp(B.r / cover, 0.0, 1.0) * 0.9 + 0.1);
  albedo *= 0.95 + 0.1 * n2;
  // Damp: darker and smoother.
  albedo *= mix(1.0, 0.62, damp);
  rough = mix(rough, 0.45, damp * 0.8);
  albedo *= mix(1.0, hra.b, 0.6);
  if (labDebug == 1) {
    vec3 lv[6] = vec3[](vec3(0.9, 0.2, 0.2), vec3(0.95, 0.6, 0.1), vec3(0.9, 0.9, 0.2), vec3(0.3, 0.8, 0.3), vec3(0.2, 0.6, 0.9), vec3(0.6, 0.3, 0.9));
    albedo = mix(lv[int(vLevel) % 6], vec3(1.0), vMorph * 0.5) * (0.6 + 0.4 * albedo.g / max(albedo.g, 0.2));
  } else if (labDebug == 2) {
    vec2 c = vLattice / labCells;
    vec2 e = min(fract(c), 1.0 - fract(c)) * labCells;
    float line = 1.0 - smoothstep(0.0, 0.08 * pow(2.0, vLevel), min(e.x, e.y) * pow(2.0, vLevel) * 0.5);
    albedo = mix(albedo, vec3(1.0, 0.1, 0.1), line);
  } else if (labDebug == 3) {
    albedo = vec3(road, bank, drip) + vec3(0.0, 0.0, 0.0);
  }
  labAlbedoOut = albedo;
  labNormalOut = nm;
  labRoughOut = clamp(rough, 0.3, 1.0);
}
`;

export const FRAGMENT_BEGIN = /* glsl */ `
  if (vMap.x < labBounds.x || vMap.y < labBounds.y || vMap.x > labBounds.z || vMap.y > labBounds.w) discard;
  labMaterial();
`;

// The visibility overlay (docs/adr/0039), in output colour space like the 2D
// map's canvas, before fog. Its pixels are premultiplied, so filtering leaves
// no dark fringe.
export const FRAGMENT_OVERLAY = /* glsl */ `
  if (labOverlayOn > 0.5) {
    vec2 ou = vMap.xy * labOverlayXform.xy + labOverlayXform.zw;
    if (all(greaterThanEqual(ou, vec2(0.0))) && all(lessThanEqual(ou, vec2(1.0)))) {
      vec4 o = texture(labOverlay, ou);
      gl_FragColor.rgb = gl_FragColor.rgb * (1.0 - o.a) + o.rgb;
    }
  }
`;

export const FRAGMENT_ALBEDO = /* glsl */ `
  diffuseColor.rgb = labAlbedoOut;
`;

export const FRAGMENT_ROUGHNESS = /* glsl */ `
  roughnessFactor = labRoughOut;
`;

export const FRAGMENT_NORMAL = /* glsl */ `
  normal = normalize((viewMatrix * vec4(labNormalOut.x, labNormalOut.z, -labNormalOut.y, 0.0)).xyz);
`;
