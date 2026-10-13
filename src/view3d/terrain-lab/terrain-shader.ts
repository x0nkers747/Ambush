import { MATERIAL_TILE_M, MATERIALS } from './ground-textures';

// GLSL for the lab terrain, spliced into three's MeshStandardMaterial so its
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
uniform vec3 labCam;
uniform vec4 labBounds;     // minX, minY, maxX, maxY
uniform vec3 labTint[${String(MATERIALS.length)}];
varying vec2 vLattice;
varying vec3 vMap;
varying vec3 vMapNormal;
flat varying float vLayer;
flat varying float vLevel;
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
  int surf = code & 7;
  int shoreKind = (code >> 3) & 3;
  bool urban = (code & 64) != 0;
  float roadE = mix(-4.0, 12.0, A.r);
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
  // Land cover, with patchy variation.
  w[3] = B.r * (0.75 + 0.5 * n2);
  w[2] = B.g * (0.7 + 0.6 * (1.0 - n2));
  w[7] = B.b;
  // Moderate slopes show earth; steep ones rock.
  float slope = 1.0 - n.z;
  w[2] += smoothstep(0.22, 0.4, slope + (n2 - 0.5) * 0.1) * 0.6;
  float rock = smoothstep(0.3, 0.45, slope + (n1 - 0.5) * 0.06);
  // Damp ground: ditches, banks.
  w[4] += B.a * B.a * 0.9;

  // Roads: carriageway, shoulder or pavement, worn verge.
  float road = 0.0;
  if (surf != 0) {
    float e = roadE + (n1 - 0.5) * 0.14 + (n2 - 0.5) * 0.1;
    road = 1.0 - smoothstep(-0.03, 0.03, e);
    float shW = urban ? 1.25 : (surf == 1 ? 0.85 : 0.45);
    float shoulder = (1.0 - road) * (1.0 - smoothstep(shW - 0.12, shW + 0.12, e + (n1 - 0.5) * 0.25));
    float verge = (1.0 - road - shoulder) * (1.0 - smoothstep(0.0, 1.6, e - shW + (n2 - 0.5) * 0.8));
    float keep = 1.0 - road - shoulder;
    for (int i = 0; i < ${String(MATERIALS.length)}; i++) w[i] *= keep;
    if (surf == 1) w[0] += road;
    else if (surf == 2) w[8] += road;
    else if (surf == 3) w[1] += road;
    else if (surf == 5) w[2] += road;
    else if (surf == 4) {
      // Track: grass down the middle, earth in the wheel ruts.
      float mid = 1.0 - smoothstep(-1.05, -0.8, roadE + (n1 - 0.5) * 0.2);
      w[3] += road * mid;
      w[2] += road * (1.0 - mid) * 0.8;
      w[1] += road * (1.0 - mid) * 0.2;
    }
    if (urban && surf != 4 && surf != 5) w[8] += shoulder;
    else if (surf == 1 || surf == 3) w[1] += shoulder;
    else w[2] += shoulder;
    w[2] += verge * 0.35;
    w[1] += verge * 0.1 * (surf == 1 ? 1.0 : 0.0);
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
  float trodden = (1.0 - smoothstep(0.5, 2.0, bld)) * (1.0 - drip) * 0.4;
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
  float far = smoothstep(120.0, 220.0, dist);
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
    bw = max(hh - top, 0.0);
    bw /= max(bw.x + bw.y + bw.z, 1e-4);
  }
  vec3 albedo = s0.albedo * bw.x + s1.albedo * bw.y + s2.albedo * bw.z;
  vec3 tn = (s0.normal * bw.x + s1.normal * bw.y + s2.normal * bw.z) * 2.0 - 1.0;
  vec3 hra = s0.hra * bw.x + s1.hra * bw.y + s2.hra * bw.z;
  // Grass and litter are too smooth in their maps: rough ground.
  float rough = hra.g;
  if (m0 == 3 || m0 == 7) rough = mix(rough, 0.92, 0.7);
  // Mud is wet: smoother, so it catches the light.
  rough = mix(rough, 0.42, bw.x * (m0 == 4 ? 1.0 : 0.0) + bw.y * (m1 == 4 ? 1.0 : 0.0) + bw.z * (m2 == 4 ? 1.0 : 0.0));
  // Tangent frame: map x east, y north, along the ground.
  vec3 T = normalize(vec3(1.0, 0.0, 0.0) - n * n.x);
  vec3 Bt = cross(n, T);
  float detail = labAdvanced == 1 ? (1.0 - smoothstep(60.0, 180.0, dist)) : 0.4;
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
  albedo *= mix(vec3(1.0), tint, clamp(w[3] / cover, 0.0, 1.0) * 0.9 + 0.1);
  albedo *= 0.9 + 0.2 * n2;
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

export const FRAGMENT_ALBEDO = /* glsl */ `
  diffuseColor.rgb = labAlbedoOut;
`;

export const FRAGMENT_ROUGHNESS = /* glsl */ `
  roughnessFactor = labRoughOut;
`;

export const FRAGMENT_NORMAL = /* glsl */ `
  normal = normalize((viewMatrix * vec4(labNormalOut.x, labNormalOut.z, -labNormalOut.y, 0.0)).xyz);
`;
