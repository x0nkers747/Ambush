import type { DirectionalLight, HemisphereLight } from 'three';
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
  Sphere,
  Vector3,
  WebGLArrayRenderTarget,
  type DataArrayTexture,
  type Texture,
  type Material,
  type WebGLRenderer,
} from 'three';

// Distant trees as impostors (docs/adr/0051, phase 3): each species' near
// model photographed from IMPOSTOR_GRID² directions over the upper half of a
// sphere (a hemi-octahedral grid), lit as the game lights it (the sun does
// not move), and drawn far away as one quad facing the camera, blending the
// four nearest photographs. The far level's cards showed each leaf cluster
// four times its size, so a distant wood looked like giant leaves; the
// impostors look like the near trees. Lit colour is baked in linear light
// (half floats); the quads take fog, tone mapping and each tree's tint.

/** Photographs per side of the hemi-octahedral grid (frames at its vertices). */
export const IMPOSTOR_GRID = 6;
/** Pixels per photograph. A 20 m tree is under 50 px tall in the far band. */
export const IMPOSTOR_PX = 48;
/**
 * Most distant trees stand in woods, in their neighbours' shade: each model
 * is photographed among shadow-only copies of itself (invisible, casting
 * leaf-shaped shadows), NEIGHBOUR_SPACING_M apart out to NEIGHBOUR_REACH_M.
 * Alone in the sun, the impostors were about twice as bright as a near wood.
 */
const NEIGHBOUR_SPACING_M = 6.5;
const NEIGHBOUR_REACH_M = 30;
/** Each photograph is drawn this many times larger and averaged down (leaves cover partly, not in holes). */
const SUPERSAMPLE = 4;
/** Alpha below which an impostor's pixel is not drawn. */
const IMPOSTOR_CUT = 0.22;

/** The scene's lighting, as the 3D view sets it (view.ts). */
export interface ImpostorLighting {
  /** Unit vector towards the sun (Three.js axes). */
  readonly sunDirection: Vector3;
  readonly sun: DirectionalLight;
  readonly ambient: HemisphereLight;
}

/** The impostor of one model: its layer, and the sphere the photographs frame. */
export interface ImpostorModel {
  readonly layer: number;
  /** Centre (model space) and radius of the photographed sphere, metres. */
  readonly centre: Vector3;
  readonly radius: number;
}

export interface TreeImpostors {
  readonly texture: DataArrayTexture;
  readonly models: readonly ImpostorModel[];
  /** The quad every impostor is drawn with (−1…1 in x and y). */
  readonly geometry: BufferGeometry;
  /** A material for one model's impostors (their instance matrices give place, scale and tint). */
  material(model: ImpostorModel): Material;
  dispose(): void;
}

/** GLSL: the hemi-octahedral grid's coordinates (0…1) of a direction with y ≥ 0, and back. */
const HEMI_OCT = `
vec2 impEncode(vec3 d) {
  d.y = max(d.y, 0.0);
  d /= (abs(d.x) + abs(d.y) + abs(d.z));
  return vec2(d.x + d.z, d.x - d.z) * 0.5 + 0.5;
}
`;

/** The direction of the grid's point (u, v) (0…1), as `impEncode` inverts it. */
export function impostorDirection(u: number, v: number): Vector3 {
  const ex = u * 2 - 1;
  const ey = v * 2 - 1;
  const x = (ex + ey) / 2;
  const z = (ex - ey) / 2;
  const y = Math.max(0, 1 - Math.abs(x) - Math.abs(z));
  return new Vector3(x, y, z).normalize();
}

/** The photograph's up: world up across the view, or north looking straight down. */
function frameUp(dir: Vector3): Vector3 {
  const ref = Math.abs(dir.y) > 0.999 ? new Vector3(0, 0, -1) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(ref, dir).normalize();
  return new Vector3().crossVectors(dir, right).normalize();
}

/**
 * Photographs `geometries` (each a model at the origin, drawn with
 * `modelMaterial`) into a texture array, one layer each, lit as `lighting`.
 */
export function bakeTreeImpostors(
  renderer: WebGLRenderer,
  geometries: readonly BufferGeometry[],
  modelMaterial: Material,
  lighting: ImpostorLighting,
): TreeImpostors {
  const side = IMPOSTOR_GRID * IMPOSTOR_PX;
  const target = new WebGLArrayRenderTarget(side, side, Math.max(1, geometries.length), {
    type: HalfFloatType,
    depthBuffer: true,
  });
  const texture = target.texture;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  // Storage with room for mipmaps, then mipmaps once, at the end (not after every photograph).
  texture.generateMipmaps = true;
  renderer.initRenderTarget(target);
  texture.generateMipmaps = false;

  // Photographs are taken at SUPERSAMPLE × the size, then averaged into the layer.
  const big = new WebGLRenderTarget(side * SUPERSAMPLE, side * SUPERSAMPLE, {
    type: HalfFloatType,
    depthBuffer: true,
  });
  const down = new ShaderMaterial({
    uniforms: { src: { value: big.texture } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `precision highp float;
uniform sampler2D src;
void main() {
  // Premultiplied average of the photograph's SUPERSAMPLE² pixels under this one.
  ivec2 o = ivec2(gl_FragCoord.xy) * ${String(SUPERSAMPLE)};
  vec4 sum = vec4(0.0);
  for (int j = 0; j < ${String(SUPERSAMPLE)}; j++)
    for (int i = 0; i < ${String(SUPERSAMPLE)}; i++) {
      vec4 c = texelFetch(src, o + ivec2(i, j), 0);
      sum += vec4(c.rgb * c.a, c.a);
    }
  gl_FragColor = sum / ${String(SUPERSAMPLE * SUPERSAMPLE)}.0;
}`,
    depthTest: false,
    depthWrite: false,
  });
  const downScene = new Scene();
  const downQuad = new Mesh(new PlaneGeometry(2, 2), down);
  downQuad.frustumCulled = false;
  downScene.add(downQuad);

  const scene = new Scene();
  const sun = lighting.sun.clone();
  const ambient = lighting.ambient.clone();
  scene.add(sun, sun.target, ambient);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const mesh = new Mesh(geometries[0], modelMaterial);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
  // The wood round it: copies that only cast shadows (cut out by the leaves' alpha).
  const leafMap = 'map' in modelMaterial ? (modelMaterial.map as Texture | null) : null;
  const shadowOnly = new MeshBasicMaterial({
    map: leafMap,
    alphaTest: 0.5,
    colorWrite: false,
    depthWrite: false,
  });
  const neighbours: Mesh[] = [];
  let seed = 0x2545f491;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296;
  };
  for (let gz = -NEIGHBOUR_REACH_M; gz <= NEIGHBOUR_REACH_M; gz += NEIGHBOUR_SPACING_M)
    for (let gx = -NEIGHBOUR_REACH_M; gx <= NEIGHBOUR_REACH_M; gx += NEIGHBOUR_SPACING_M) {
      const x = gx + (rnd() - 0.5) * NEIGHBOUR_SPACING_M * 0.6;
      const z = gz + (rnd() - 0.5) * NEIGHBOUR_SPACING_M * 0.6;
      const d = Math.hypot(x, z);
      if (d < NEIGHBOUR_SPACING_M * 0.6 || d > NEIGHBOUR_REACH_M) continue;
      const n = new Mesh(geometries[0], shadowOnly);
      n.position.set(x, 0, z);
      n.rotation.y = rnd() * Math.PI * 2;
      n.scale.setScalar(0.85 + 0.3 * rnd());
      n.castShadow = true;
      n.frustumCulled = false;
      neighbours.push(n);
      scene.add(n);
    }

  const saved = {
    target: renderer.getRenderTarget(),
    autoClear: renderer.autoClear,
    clearAlpha: renderer.getClearAlpha(),
    clearColor: renderer.getClearColor(new Color()),
  };
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);

  const models: ImpostorModel[] = [];
  const sphere = new Sphere();
  geometries.forEach((geometry, layer) => {
    geometry.computeBoundingSphere();
    sphere.copy(geometry.boundingSphere ?? new Sphere(new Vector3(), 1));
    const radius = sphere.radius * 1.02;
    const centre = sphere.center.clone();
    models.push({ layer, centre, radius });
    mesh.geometry = geometry;
    for (const n of neighbours) n.geometry = geometry;
    // The sun's shadow over the model and the wood round it.
    const reach = radius + NEIGHBOUR_REACH_M;
    sun.position.copy(centre).addScaledVector(lighting.sunDirection, reach * 2);
    sun.target.position.copy(centre);
    sun.target.updateMatrixWorld();
    const sc = sun.shadow.camera;
    sc.left = -reach;
    sc.right = reach;
    sc.top = reach;
    sc.bottom = -reach;
    sc.near = 1;
    sc.far = reach * 4;
    sc.updateProjectionMatrix();
    sun.shadow.needsUpdate = true;
    camera.left = -radius;
    camera.right = radius;
    camera.top = radius;
    camera.bottom = -radius;
    camera.near = radius * 0.5;
    camera.far = radius * 6;
    camera.updateProjectionMatrix();
    big.scissorTest = true;
    for (let j = 0; j < IMPOSTOR_GRID; j += 1)
      for (let i = 0; i < IMPOSTOR_GRID; i += 1) {
        const dir = impostorDirection(i / (IMPOSTOR_GRID - 1), j / (IMPOSTOR_GRID - 1));
        camera.position.copy(centre).addScaledVector(dir, radius * 3);
        camera.up.copy(frameUp(dir));
        camera.lookAt(centre);
        camera.updateMatrixWorld();
        const px = IMPOSTOR_PX * SUPERSAMPLE;
        big.viewport.set(i * px, j * px, px, px);
        big.scissor.copy(big.viewport);
        renderer.setRenderTarget(big);
        renderer.clear();
        renderer.render(scene, camera);
      }
    big.scissorTest = false;
    renderer.setRenderTarget(target, layer);
    renderer.render(downScene, camera);
  });
  big.dispose();
  down.dispose();
  downQuad.geometry.dispose();
  // Mipmaps: one more (empty) render with them on generates them for every layer.
  texture.generateMipmaps = true;
  target.scissorTest = true;
  target.scissor.set(0, 0, 1, 1);
  renderer.setRenderTarget(target, 0);
  renderer.render(new Scene(), camera);
  target.scissorTest = false;
  renderer.setRenderTarget(saved.target);
  renderer.autoClear = saved.autoClear;
  renderer.setClearColor(saved.clearColor, saved.clearAlpha);
  sun.shadow.dispose();
  shadowOnly.dispose();
  mesh.geometry = new BufferGeometry();

  const geometry = new PlaneGeometry(2, 2);
  // Only positions are read.
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  geometry.setAttribute('normal', new Float32BufferAttribute(new Float32Array(12), 3));

  const shared = { impAtlas: { value: texture } };
  const materials: MeshBasicMaterial[] = [];
  const material = (model: ImpostorModel): Material => {
    const m = new MeshBasicMaterial({ alphaTest: IMPOSTOR_CUT, alphaToCoverage: true });
    m.onBeforeCompile = (shader) => {
      shader.uniforms['impAtlas'] = shared.impAtlas;
      shader.uniforms['impLayer'] = { value: model.layer };
      shader.uniforms['impCentre'] = { value: model.centre };
      shader.uniforms['impRadius'] = { value: model.radius };
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform vec3 impCentre;
uniform float impRadius;
varying vec3 vImpDir;
varying vec2 vImpUv;`,
        )
        .replace(
          '#include <project_vertex>',
          `// A quad facing the camera, round the model's photographed sphere,
  // scaled as the instance (its yaw is not used: the photographs are lit for one).
  float impSH = length(instanceMatrix[0].xyz);
  float impSV = length(instanceMatrix[1].xyz);
  vec3 impAt = (modelMatrix * vec4(instanceMatrix[3].xyz
    + vec3(impCentre.x * impSH, impCentre.y * impSV, impCentre.z * impSH), 1.0)).xyz;
  vec3 impTo = normalize(cameraPosition - impAt);
  vec3 impRef = abs(impTo.y) > 0.999 ? vec3(0.0, 0.0, -1.0) : vec3(0.0, 1.0, 0.0);
  vec3 impRight = normalize(cross(impRef, impTo));
  vec3 impUp = cross(impTo, impRight);
  vec3 impWorld = impAt + (impRight * position.x * impSH + impUp * position.y * impSV) * impRadius;
  vImpDir = impTo;
  vImpUv = position.xy * 0.5 + 0.5;
  vec4 mvPosition = viewMatrix * vec4(impWorld, 1.0);
  gl_Position = projectionMatrix * mvPosition;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray impAtlas;
uniform float impLayer;
varying vec3 vImpDir;
varying vec2 vImpUv;
${HEMI_OCT}`,
        )
        .replace(
          '#include <map_fragment>',
          `{
    // The four photographs round this view, blended.
    vec2 g = impEncode(normalize(vImpDir)) * ${String(IMPOSTOR_GRID - 1)}.0;
    vec2 g0 = min(floor(g), vec2(${String(IMPOSTOR_GRID - 2)}.0));
    vec2 t = clamp(g - g0, 0.0, 1.0);
    vec2 uv = clamp(vImpUv, 0.01, 0.99);
    float n = ${String(IMPOSTOR_GRID)}.0;
    vec4 a = texture(impAtlas, vec3((g0 + uv) / n, impLayer));
    vec4 b = texture(impAtlas, vec3((g0 + vec2(1.0, 0.0) + uv) / n, impLayer));
    vec4 c = texture(impAtlas, vec3((g0 + vec2(0.0, 1.0) + uv) / n, impLayer));
    vec4 d = texture(impAtlas, vec3((g0 + vec2(1.0) + uv) / n, impLayer));
    vec4 s = mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
    // Colour where there is leaf (the photographs' clear pixels are black).
    diffuseColor = vec4(s.rgb / max(s.a, 0.001), s.a);
  }`,
        );
    };
    m.customProgramCacheKey = () => 'tree-impostor';
    materials.push(m);
    return m;
  };

  return {
    texture,
    models,
    geometry,
    material,
    dispose() {
      target.dispose();
      geometry.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
