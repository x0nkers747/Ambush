/**
 * The shared comparison scene: identical renderer settings, sun, sky, fog,
 * camera and ground for every runtime. Two grounds: a flat test plane, and an
 * uneven one (hills and a 15° slope) for foot placement.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type GroundKind = 'flat' | 'uneven';

/** Ground height (m) at map (x east, y north) for the uneven ground. */
export function unevenHeight(x: number, y: number): number {
  // A 15° ramp along +x between x = 4 and x = 14, plus gentle bumps.
  const ramp = Math.max(0, Math.min(10, x - 4)) * Math.tan((15 * Math.PI) / 180);
  const bumps = 0.18 * Math.sin(x * 0.9) * Math.cos(y * 0.7) + 0.1 * Math.sin(x * 2.1 + y * 1.3);
  return ramp + bumps;
}

export interface Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly sun: THREE.DirectionalLight;
  ground: GroundKind;
  heightAt: (x: number, y: number) => number;
  setGround(kind: GroundKind): void;
  setShadows(on: boolean): void;
  resize(): void;
}

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb9cde0);
  scene.fog = new THREE.Fog(0xb9cde0, 80, 400);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 1000);
  camera.position.set(3.2, 1.9, 4.2);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1, 0);
  controls.enableDamping = false;
  controls.update();

  scene.add(new THREE.HemisphereLight(0xdfe9f5, 0x5b5140, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
  sun.position.set(6, 10, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 12;
  sun.shadow.camera.bottom = -12;
  sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
  const gridTex = makeGridTexture();
  groundMat.map = gridTex;
  let groundMesh: THREE.Mesh | null = null;

  const stage: Stage = {
    renderer,
    scene,
    camera,
    controls,
    sun,
    ground: 'flat',
    heightAt: (x, y) => {
      return stage.ground === 'flat' ? 0 : unevenHeight(x, y);
    },
    setGround(kind) {
      stage.ground = kind;
      if (groundMesh) {
        scene.remove(groundMesh);
        groundMesh.geometry.dispose();
      }
      const size = 200;
      const seg = kind === 'flat' ? 1 : 400;
      const g = new THREE.PlaneGeometry(size, size, seg, seg);
      g.rotateX(-Math.PI / 2);
      const pos = g.attributes['position'] as THREE.BufferAttribute;
      const uv = g.attributes['uv'] as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        if (kind === 'uneven') pos.setY(i, unevenHeight(x, -z));
        uv.setXY(i, x, z);
      }
      g.computeVertexNormals();
      groundMesh = new THREE.Mesh(g, groundMat);
      groundMesh.receiveShadow = true;
      scene.add(groundMesh);
    },
    setShadows(on) {
      sun.castShadow = on;
    },
    resize() {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w || canvas.height !== h) renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    },
  };
  stage.setGround('flat');
  return stage;
}

/** A 1 m grid texture (foot sliding is easiest to see against a grid). */
function makeGridTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d');
  g.fillStyle = '#a3ab88';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#4d543c';
  g.lineWidth = 6;
  g.strokeRect(0, 0, 256, 256);
  g.strokeStyle = '#7f8766';
  g.lineWidth = 1;
  for (let i = 64; i < 256; i += 64) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 256);
    g.moveTo(0, i);
    g.lineTo(256, i);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Map (x east, y north, azimuth clockwise from north) → three.js (Y up, -Z north). */
export function placeOnMap(o: THREE.Object3D, x: number, y: number, z: number, azimuth: number) {
  o.position.set(x, z, -y);
  o.rotation.set(0, Math.PI - azimuth, 0);
}
