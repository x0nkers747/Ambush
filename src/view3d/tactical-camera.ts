import { MOUSE, PerspectiveCamera, Raycaster, TOUCH, Vector2, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  clampToExtent,
  defaultView,
  groundHit,
  keepAboveGround,
  MAX_POLAR_DEG,
  maxDistance,
  MIN_DISTANCE_M,
  type BattlefieldExtent,
  type GroundAt,
} from './camera-math';

// The overhead tactical camera (docs/adr/0029): Three.js's OrbitControls with
// left-drag to pan along the ground (as the 2D map drags), right-drag to orbit,
// the wheel to zoom (towards the cursor), and a double-click to focus on the
// ground clicked. On touch screens one finger pans and two zoom and rotate.
// The focus stays on the ground and on the battlefield; the camera never goes
// below the ground or past straight down. Later camera modes (follow a
// soldier, ground level, free flight, AAR) implement `CameraMode` alongside.

/** A way of driving the camera; only the orbiting tactical view exists yet. */
export interface CameraMode {
  readonly name: 'tactical';
  /** Called once per frame before rendering. */
  update(): void;
  dispose(): void;
}

export interface TacticalCamera extends CameraMode {
  readonly camera: PerspectiveCamera;
  /** Back to the default overhead view. */
  reset(): void;
  /** Focus on the ground under a canvas point (CSS pixels); `false` if it is not on the battlefield. */
  focusAt(clientX: number, clientY: number): boolean;
  /** The focus point and camera position, in Three.js axes (for tests and persistence). */
  pose(): { target: Vector3; position: Vector3 };
  /** Moves to a pose (Three.js axes), within the usual limits. */
  setPose(target: Vector3, position: Vector3): void;
  /** Fits the camera to the canvas size. */
  resize(width: number, height: number): void;
}

/** Field of view, vertical. */
const FOV_DEG = 45;
/** The mouse wheel's zoom speed (three.js's default is 1). */
const WHEEL_ZOOM_SPEED = 2;
/** Time for a double-click refocus, in milliseconds. */
const FOCUS_MS = 450;

export function createTacticalCamera(
  canvas: HTMLCanvasElement,
  extent: BattlefieldExtent,
  groundAt: GroundAt,
  /** The ground off the battlefield (the apron's elevation): the camera stays above it too. */
  floor: number,
): TacticalCamera {
  const camera = new PerspectiveCamera(FOV_DEG, 1, 1, 10_000);
  const controls = new OrbitControls(camera, canvas);
  // Left: pan, as on the 2D map; right: orbit; wheel: zoom. Panning moves
  // along the ground rather than the screen, so dragging the map moves across
  // the battlefield.
  controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
  controls.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE };
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  // The wheel zooms twice as fast as three.js's default (each notch's zoom
  // squared); dragging with the middle button and pinching keep the default.
  // The controls read `zoomSpeed` as they handle each event, so it is set by
  // the kind of event, before they see it.
  canvas.addEventListener(
    'wheel',
    () => {
      controls.zoomSpeed = WHEEL_ZOOM_SPEED;
    },
    { capture: true, passive: true },
  );
  canvas.addEventListener(
    'pointerdown',
    () => {
      controls.zoomSpeed = 1;
    },
    { capture: true },
  );
  controls.enableDamping = true;
  controls.dampingFactor = 0.15;
  controls.minDistance = MIN_DISTANCE_M;
  controls.maxDistance = maxDistance(extent);
  controls.maxPolarAngle = (MAX_POLAR_DEG * Math.PI) / 180;
  controls.minPolarAngle = 0;
  const span = Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY);
  /** Far enough to see the whole battlefield from the farthest zoom. */
  camera.far = maxDistance(extent) + 2 * span;

  let aspect = 1;
  let focus: {
    start: number;
    fromTarget: Vector3;
    toTarget: Vector3;
    fromPosition: Vector3;
    toPosition: Vector3;
  } | null = null;

  const reset = () => {
    focus = null;
    const view = defaultView(extent, groundAt, FOV_DEG, aspect);
    controls.target.set(view.target.x, view.target.y, view.target.z);
    camera.position.set(view.position.x, view.position.y, view.position.z);
    camera.lookAt(controls.target);
    controls.update();
  };

  const raycaster = new Raycaster();
  const focusAt = (clientX: number, clientY: number): boolean => {
    const rect = canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = groundHit(raycaster.ray.origin, raycaster.ray.direction, groundAt, camera.far);
    if (!hit) return false;
    // Move the focus to the point and the camera with it: same angle and distance.
    const toTarget = new Vector3(hit.x, hit.y, hit.z);
    const shift = toTarget.clone().sub(controls.target);
    focus = {
      start: performance.now(),
      fromTarget: controls.target.clone(),
      toTarget,
      fromPosition: camera.position.clone(),
      toPosition: camera.position.clone().add(shift),
    };
    return true;
  };
  const onDoubleClick = (event: MouseEvent) => {
    event.preventDefault();
    focusAt(event.clientX, event.clientY);
  };
  canvas.addEventListener('dblclick', onDoubleClick);

  /** Keeps the focus on the battlefield and on the ground, and the camera above the ground. */
  const constrain = () => {
    const t = clampToExtent(controls.target, extent);
    const ground = groundAt(t.x, t.z) ?? t.y;
    // Follow the ground under the focus: camera and focus rise and fall together.
    const dy = ground - controls.target.y;
    camera.position.x += t.x - controls.target.x;
    camera.position.z += t.z - controls.target.z;
    camera.position.y += dy;
    controls.target.set(t.x, ground, t.z);
    const above = keepAboveGround(camera.position, groundAt, floor);
    camera.position.y = above.y;
  };

  /** Near plane: as far as the ground allows, so depth precision is spent where it is seen. */
  const fitClipping = () => {
    const height = camera.position.y - (groundAt(camera.position.x, camera.position.z) ?? floor);
    const near = Math.min(Math.max(height * 0.2, 0.1), 50);
    if (Math.abs(near - camera.near) > camera.near * 0.05) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
  };

  reset();
  return {
    name: 'tactical',
    camera,
    reset,
    focusAt,
    update() {
      if (focus) {
        const k = Math.min((performance.now() - focus.start) / FOCUS_MS, 1);
        const e = k * k * (3 - 2 * k);
        controls.target.lerpVectors(focus.fromTarget, focus.toTarget, e);
        camera.position.lerpVectors(focus.fromPosition, focus.toPosition, e);
        if (k >= 1) focus = null;
      }
      controls.update();
      constrain();
      fitClipping();
    },
    pose: () => ({ target: controls.target.clone(), position: camera.position.clone() }),
    setPose(target, position) {
      focus = null;
      controls.target.copy(target);
      camera.position.copy(position);
      camera.lookAt(controls.target);
      controls.update();
      constrain();
    },
    resize(width, height) {
      aspect = width / Math.max(height, 1);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },
    dispose() {
      canvas.removeEventListener('dblclick', onDoubleClick);
      controls.dispose();
    },
  };
}
