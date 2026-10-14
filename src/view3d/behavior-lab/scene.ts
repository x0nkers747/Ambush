import {
  ACESFilmicToneMapping,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFShadowMap,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { GroundAt } from '../camera-math';
import { SUN_DEPTH_BIAS_M, SUN_NORMAL_BIAS } from '../characters/shadow';
import { createTacticalCamera, type TacticalCamera } from '../tactical-camera';

// The Behavior Lab's 3D scene (docs/behavior-lab/04 §5): the game's renderer
// settings, sun and sky light, soldier shadows and tactical camera, over the
// lab's flat ground (a grass texture with a 10 m grid). The soldiers are the
// game's character layer, added by the lab.

/** The sun: as the game's (from the south-west, 38° up). */
const SUN_AZIMUTH_DEG = 225;
const SUN_ELEVATION_DEG = 38;
const HAZE = new Color(0xc9d4dc);
/** The shadowed square round the camera's focus (m) and its map size. */
const SHADOW_EXTENT_M = 240;
const SHADOW_MAP = 2048;

export interface LabScene {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: TacticalCamera;
  readonly groundAt: GroundAt;
  readonly elevation: number;
  resize(width: number, height: number): void;
  render(): void;
  dispose(): void;
}

/** A scene over flat ground at `elevation` m within ±`half` m of the origin. */
export function createLabScene(
  canvas: HTMLCanvasElement,
  half: number,
  elevation: number,
): LabScene {
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  scene.background = HAZE;
  scene.fog = new Fog(HAZE, 900, 3000);
  const az = (SUN_AZIMUTH_DEG * Math.PI) / 180;
  const el = (SUN_ELEVATION_DEG * Math.PI) / 180;
  const sunDirection = new Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el),
  ).normalize();
  const sun = new DirectionalLight(0xfff7ea, 2.6);
  sun.castShadow = true;
  sun.shadow.normalBias = SUN_NORMAL_BIAS;
  sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  const cam = sun.shadow.camera;
  cam.left = -SHADOW_EXTENT_M / 2;
  cam.right = SHADOW_EXTENT_M / 2;
  cam.top = SHADOW_EXTENT_M / 2;
  cam.bottom = -SHADOW_EXTENT_M / 2;
  cam.near = 1;
  cam.far = 4 * SHADOW_EXTENT_M + 2000;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -SUN_DEPTH_BIAS_M / (cam.far - cam.near);
  scene.add(sun, sun.target, new HemisphereLight(0xd6e4f0, 0x6f7062, 1.0));

  const ground = new Mesh(
    new PlaneGeometry(2 * half, 2 * half).rotateX(-Math.PI / 2),
    new MeshStandardMaterial({ map: groundTexture(half), roughness: 0.95, metalness: 0 }),
  );
  ground.position.y = elevation;
  ground.receiveShadow = true;
  scene.add(ground);

  const groundAt: GroundAt = (x, z) =>
    Math.abs(x) <= half && Math.abs(z) <= half ? elevation : null;
  const camera = createTacticalCamera(
    canvas,
    { minX: -half, maxX: half, minY: -half, maxY: half },
    groundAt,
    elevation,
  );

  return {
    renderer,
    scene,
    camera,
    groundAt,
    elevation,
    resize(width, height) {
      renderer.setSize(width, height, false);
      camera.resize(width, height);
    },
    render() {
      camera.update();
      // The shadowed square follows the focus, in whole texels (no shimmering edges).
      const { target } = camera.pose();
      const texel = SHADOW_EXTENT_M / SHADOW_MAP;
      const fx = Math.round(target.x / texel) * texel;
      const fz = Math.round(target.z / texel) * texel;
      sun.target.position.set(fx, elevation, fz);
      sun.position.set(fx, elevation, fz).addScaledVector(sunDirection, 2 * SHADOW_EXTENT_M + 1000);
      renderer.render(scene, camera.camera);
    },
    dispose() {
      camera.dispose();
      ground.geometry.dispose();
      (ground.material.map as CanvasTexture | null)?.dispose();
      ground.material.dispose();
      sun.shadow.dispose();
      renderer.dispose();
    },
  };
}

/** Grass with a 10 m grid (1 m minor lines), repeated over the ground. */
function groundTexture(half: number): CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (g) {
    g.fillStyle = '#5d6b3c';
    g.fillRect(0, 0, size, size);
    // Mottled grass: deterministic speckle.
    let seed = 7;
    const rand = () => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed / 0x1_0000_0000;
    };
    for (let i = 0; i < 9000; i += 1) {
      const l = 30 + rand() * 18;
      g.fillStyle = `hsl(${String(68 + rand() * 18)} ${String(22 + rand() * 14)}% ${String(l)}%)`;
      g.fillRect(rand() * size, rand() * size, 1 + rand() * 3, 1 + rand() * 3);
    }
    // One texture tile = 10 m: a grid line at its edge, faint metre lines inside.
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    for (let m = 1; m < 10; m += 1) {
      const p = (m / 10) * size;
      g.beginPath();
      g.moveTo(p, 0);
      g.lineTo(p, size);
      g.moveTo(0, p);
      g.lineTo(size, p);
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.22)';
    g.lineWidth = 3;
    g.strokeRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set((2 * half) / 10, (2 * half) / 10);
  texture.anisotropy = 8;
  return texture;
}
