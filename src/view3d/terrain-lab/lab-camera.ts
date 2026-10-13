import { PerspectiveCamera, Vector3 } from 'three';

// The lab's cameras: walking at eye height (WASD, mouse look), free flight,
// and a tactical orbit. One camera state in the map frame (x east, y north,
// z up); heading clockwise from north, pitch above the horizon.

export type CameraMode = 'walk' | 'fly' | 'tactical';

export const EYE_HEIGHT_M = 1.7;

export interface LabCameraState {
  mode: CameraMode;
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
  /** Tactical: distance from the eye to the point looked at. */
  distance: number;
  /** Metres per second (walk and fly). */
  speed: number;
}

export interface LabCamera {
  readonly camera: PerspectiveCamera;
  readonly state: LabCameraState;
  /** Applies input for dt seconds and updates the three camera. */
  update(dt: number): void;
  set(next: Partial<LabCameraState>): void;
  /** Places the camera looking at (x, y) in tactical mode, or standing there in walk mode. */
  view(
    mode: CameraMode,
    x: number,
    y: number,
    headingDeg: number,
    pitchDeg: number,
    distance?: number,
  ): void;
  dispose(): void;
}

export function createLabCamera(
  canvas: HTMLCanvasElement,
  ground: (x: number, y: number) => number,
): LabCamera {
  const camera = new PerspectiveCamera(60, 1, 0.05, 30000);
  const state: LabCameraState = {
    mode: 'walk',
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    pitch: 0,
    distance: 300,
    speed: 1.4,
  };
  const keys = new Set<string>();
  let dragging: { x: number; y: number; button: number } | null = null;

  const onKey = (down: boolean) => (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const k = e.key.toLowerCase();
    if (
      [
        'w',
        'a',
        's',
        'd',
        'q',
        'e',
        'shift',
        'arrowup',
        'arrowdown',
        'arrowleft',
        'arrowright',
      ].includes(k)
    ) {
      if (down) keys.add(k);
      else keys.delete(k);
      e.preventDefault();
    }
  };
  const keyDown = onKey(true);
  const keyUp = onKey(false);
  const look = (dx: number, dy: number) => {
    state.heading = (state.heading + dx * 0.0025 + Math.PI * 2) % (Math.PI * 2);
    state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch - dy * 0.0025));
  };
  const onMove = (e: PointerEvent) => {
    if (document.pointerLockElement === canvas) {
      look(e.movementX, e.movementY);
      return;
    }
    if (!dragging) return;
    const dx = e.clientX - dragging.x;
    const dy = e.clientY - dragging.y;
    dragging.x = e.clientX;
    dragging.y = e.clientY;
    if (state.mode === 'tactical' && dragging.button === 2) {
      // Pan the point looked at.
      const k = state.distance / 800;
      const sh = Math.sin(state.heading);
      const ch = Math.cos(state.heading);
      const tx = targetOf();
      const nx = tx.x - (dx * ch + dy * sh) * k;
      const ny = tx.y - (-dx * sh + dy * ch) * k;
      setTarget(nx, ny, ground(nx, ny));
      return;
    }
    if (state.mode === 'tactical') {
      const t = targetOf();
      look(dx, dy);
      state.pitch = Math.min(-0.05, state.pitch);
      setTarget(t.x, t.y, t.z);
    } else look(dx, dy);
  };
  const onDown = (e: PointerEvent) => {
    if (e.button === 0 && state.mode !== 'tactical' && e.detail >= 2) {
      void canvas.requestPointerLock();
      return;
    }
    dragging = { x: e.clientX, y: e.clientY, button: e.button };
    canvas.setPointerCapture(e.pointerId);
  };
  const onUp = () => {
    dragging = null;
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (state.mode === 'tactical') {
      const t = targetOf();
      state.distance = Math.max(20, Math.min(12000, state.distance * Math.exp(e.deltaY * 0.0012)));
      setTarget(t.x, t.y, t.z);
    } else state.speed = Math.max(0.5, Math.min(400, state.speed * Math.exp(-e.deltaY * 0.0015)));
  };
  const onContext = (e: Event) => {
    e.preventDefault();
  };
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);

  const forward = () => ({
    x: Math.sin(state.heading) * Math.cos(state.pitch),
    y: Math.cos(state.heading) * Math.cos(state.pitch),
    z: Math.sin(state.pitch),
  });
  const targetOf = () => {
    const f = forward();
    return {
      x: state.x + f.x * state.distance,
      y: state.y + f.y * state.distance,
      z: state.z + f.z * state.distance,
    };
  };
  const setTarget = (x: number, y: number, z: number) => {
    const f = forward();
    state.x = x - f.x * state.distance;
    state.y = y - f.y * state.distance;
    state.z = z - f.z * state.distance;
  };
  const target = new Vector3();

  return {
    camera,
    state,
    update(dt) {
      const sh = Math.sin(state.heading);
      const ch = Math.cos(state.heading);
      let mx = 0;
      let my = 0;
      let mz = 0;
      if (keys.has('w') || keys.has('arrowup')) my += 1;
      if (keys.has('s') || keys.has('arrowdown')) my -= 1;
      if (keys.has('d') || keys.has('arrowright')) mx += 1;
      if (keys.has('a') || keys.has('arrowleft')) mx -= 1;
      if (keys.has('e')) mz += 1;
      if (keys.has('q')) mz -= 1;
      const speed = state.speed * (keys.has('shift') ? 4 : 1) * dt;
      if (state.mode === 'tactical') {
        const k = state.distance * 0.8 * dt;
        state.x += (sh * my + ch * mx) * k;
        state.y += (ch * my - sh * mx) * k;
      } else if (state.mode === 'walk') {
        state.x += (sh * my + ch * mx) * speed;
        state.y += (ch * my - sh * mx) * speed;
        state.z = ground(state.x, state.y) + EYE_HEIGHT_M;
      } else {
        const f = forward();
        state.x += (f.x * my + ch * mx) * speed;
        state.y += (f.y * my - sh * mx) * speed;
        state.z += (f.z * my + mz) * speed;
        state.z = Math.max(state.z, ground(state.x, state.y) + 0.3);
      }
      const f = forward();
      camera.position.set(state.x, state.z, -state.y);
      target.set(state.x + f.x, state.z + f.z, -(state.y + f.y));
      camera.lookAt(target);
      // Near plane close enough for the ground at one's feet.
      const above = state.z - ground(state.x, state.y);
      camera.near = Math.max(0.03, Math.min(5, above * 0.03));
      camera.far = Math.max(8000, above * 20);
      camera.updateProjectionMatrix();
    },
    set(next) {
      Object.assign(state, next);
    },
    view(mode, x, y, headingDeg, pitchDeg, distance) {
      state.mode = mode;
      state.heading = (headingDeg * Math.PI) / 180;
      state.pitch = (pitchDeg * Math.PI) / 180;
      if (mode === 'tactical') {
        state.distance = distance ?? 300;
        setTarget(x, y, ground(x, y));
      } else {
        state.x = x;
        state.y = y;
        state.z = ground(x, y) + EYE_HEIGHT_M;
        state.speed = mode === 'walk' ? 1.4 : Math.max(state.speed, 8);
      }
    },
    dispose() {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContext);
    },
  };
}
