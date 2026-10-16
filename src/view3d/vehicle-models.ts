import * as THREE from 'three';
import type { MountSpec, PlatformSpec } from '#sim';
import { loopLengths, M113, trackPath, type RunningGear } from './tracks';

export { M113, type RunningGear } from './tracks';

// Vehicle models (docs/combined-arms.md §11): every platform built from simple
// shapes by its visual definition (`PlatformSpec.visual`): its hull, running
// gear and turret, with a node per mount (turning, then lifting) placed at the
// mount's pivot, so the simulation's mount angles pose it. Geometry is built
// once per platform and shared by every vehicle of it; each vehicle has its
// own materials (a destroyed one is charred).
//
// The model's frame: x right, y up, −z forward (the hull's centre on the
// ground at the origin).

const gears = new WeakMap<PlatformSpec, RunningGear>();

/** A platform's running gear: the M113's own, or laid out from its visual definition. */
export function gearOf(platform: PlatformSpec): RunningGear {
  if (platform.visual.hull === 'm113') return M113;
  let gear = gears.get(platform);
  if (gear) return gear;
  const v = platform.visual;
  const { lengthM, widthM } = platform.dimensions;
  const r = v.wheelRadiusM;
  const n = v.roadWheels;
  const wheelsAlong = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * v.wheelSpacingM);
  const span = ((n - 1) / 2) * v.wheelSpacingM;
  const wheelUp = r + 0.07;
  const end = Math.min(lengthM / 2 - 0.3, span + r + 0.45);
  const drive = { along: end, up: wheelUp + 0.32, radius: r * 0.82 };
  const idle = { along: -end, up: wheelUp + 0.22, radius: r * 0.8 };
  const front = v.sprocket === 'front';
  const rollers = v.returnRollers;
  gear = {
    length: lengthM,
    width: widthM,
    trackGauge: Math.min(widthM - v.trackWidthM - 0.05, widthM * 0.8),
    trackWidth: v.trackWidthM,
    shoeThickness: 0.075,
    shoePitch: 0.16,
    wheelRadius: r,
    wheelsAlong,
    wheelUp,
    bump: 0.2,
    rebound: 0.14,
    sprocket: front ? drive : { ...drive, along: -drive.along },
    idler: front ? idle : { ...idle, along: -idle.along },
    rollersAlong: Array.from(
      { length: rollers },
      (_, i) => (i - (rollers - 1) / 2) * ((2 * span) / Math.max(1, rollers)),
    ),
    sag: 0.03,
  };
  gears.set(platform, gear);
  return gear;
}

/** A mount's nodes: `yaw` turns it (about up), `pitch` (its child) lifts its weapons. */
export interface MountNode {
  readonly yaw: THREE.Group;
  readonly pitch: THREE.Group;
}

export interface VehicleModel {
  readonly root: THREE.Group;
  readonly hull: THREE.Group;
  readonly gear: RunningGear;
  /** Road wheels, sprockets and idlers, by side (0 left, 1 right). */
  readonly wheels: THREE.Object3D[][];
  readonly sprockets: THREE.Object3D[];
  readonly idlers: THREE.Object3D[];
  readonly shoes: THREE.InstancedMesh;
  readonly shoesPerTrack: number;
  /** Each mount's nodes, by mount id, in platform order. */
  readonly mounts: ReadonlyMap<string, MountNode>;
  /** Each weapon's muzzle (a node on its mount's pitch), by slot. */
  readonly muzzles: ReadonlyMap<string, THREE.Object3D>;
  /** The paint and the dark fittings: darkened when it is destroyed. */
  readonly paint: THREE.MeshStandardMaterial;
  readonly dark: THREE.MeshStandardMaterial;
  readonly materials: THREE.Material[];
}

// --- Shared geometry ---------------------------------------------------------------

const sharedGeometry = new Map<string, THREE.BufferGeometry>();

/** A geometry made once by `make` and shared under `key` (never disposed: a handful per platform). */
function shared(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = sharedGeometry.get(key);
  if (!g) {
    g = make();
    sharedGeometry.set(key, g);
  }
  return g;
}

/** A prism of a side profile (along, up), `width` across, in the model's frame. */
function profilePrism(profile: readonly (readonly [number, number])[], width: number) {
  const shape = new THREE.Shape(profile.map(([a, u]) => new THREE.Vector2(a, u)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  g.translate(0, 0, -width / 2);
  g.rotateY(Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

/** A prism of a plan (across, along: forward positive), from `base` up `height`, in the model's frame. */
function planPrism(plan: readonly (readonly [number, number])[], base: number, height: number) {
  const shape = new THREE.Shape(plan.map(([x, a]) => new THREE.Vector2(x, a)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  // Shape (x, y=along) in the xy plane, extruded along +z: turn so along → −z and extrusion → +y.
  g.rotateX(-Math.PI / 2);
  g.translate(0, base, 0);
  g.computeVertexNormals();
  return g;
}

const box = (w: number, h: number, l: number) => new THREE.BoxGeometry(w, h, l);
const cylinderAlong = (r0: number, r1: number, length: number, segments = 12) => {
  // Along −z (forward), from 0 to −length.
  const g = new THREE.CylinderGeometry(r1, r0, length, segments);
  g.rotateX(-Math.PI / 2);
  g.translate(0, 0, -length / 2);
  return g;
};
const cylinderAcross = (r: number, length: number, segments = 16) => {
  const g = new THREE.CylinderGeometry(r, r, length, segments);
  g.rotateZ(Math.PI / 2);
  return g;
};

// --- Building ----------------------------------------------------------------------

interface Builder {
  readonly key: string;
  readonly paint: THREE.MeshStandardMaterial;
  readonly dark: THREE.MeshStandardMaterial;
  readonly rubber: THREE.MeshStandardMaterial;
  readonly glass: THREE.MeshStandardMaterial;
  /** A mesh of a shared geometry (made by `make` once under `name`), at (across, up, along). */
  part(
    parent: THREE.Object3D,
    name: string,
    make: () => THREE.BufferGeometry,
    material: THREE.Material,
    across?: number,
    up?: number,
    along?: number,
  ): THREE.Mesh;
}

function meshOf(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Builds a vehicle of `platform`: hull, running gear, mounts with their weapons. */
export function buildVehicleModel(platform: PlatformSpec): VehicleModel {
  const visual = platform.visual;
  const paint = new THREE.MeshStandardMaterial({
    color: visual.color,
    roughness: 0.82,
    metalness: 0.08,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: visual.darkColor,
    roughness: 0.7,
    metalness: 0.3,
  });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1a1a19, roughness: 0.95 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fb2b8, roughness: 0.2, metalness: 0.5 });
  const steel = new THREE.MeshStandardMaterial({
    color: 0x2c2d28,
    roughness: 0.7,
    metalness: 0.35,
  });
  const materials = [paint, dark, rubber, glass, steel];
  const b: Builder = {
    key: platform.id,
    paint,
    dark,
    rubber,
    glass,
    part(parent, name, make, material, across = 0, up = 0, along = 0) {
      const m = meshOf(shared(`${platform.id}:${name}`, make), material);
      m.position.set(across, up, -along);
      parent.add(m);
      return m;
    },
  };
  const root = new THREE.Group();
  const hull = new THREE.Group();
  root.add(hull);
  const gear = gearOf(platform);
  buildHull(b, hull, platform, steel);

  // Mounts: a yaw node at the pivot (on the hull, or on its parent's yaw), a pitch node in it.
  const mounts = new Map<string, MountNode>();
  for (const spec of platform.mounts) {
    const yaw = new THREE.Group();
    yaw.name = `mount:${spec.id}`;
    const pitch = new THREE.Group();
    yaw.add(pitch);
    yaw.position.set(spec.pivot.right, spec.pivot.up, -spec.pivot.forward);
    const parent = spec.parent ? mounts.get(spec.parent)?.yaw : hull;
    (parent ?? hull).add(yaw);
    mounts.set(spec.id, { yaw, pitch });
  }
  for (const spec of platform.mounts) {
    const node = mounts.get(spec.id);
    if (node) buildMount(b, node, platform, spec, steel);
  }
  const muzzles = new Map<string, THREE.Object3D>();
  for (const w of platform.weapons) {
    const node = mounts.get(w.mount);
    if (!node) continue;
    const muzzle = new THREE.Object3D();
    muzzle.position.set(w.muzzle.right, w.muzzle.up, -w.muzzle.forward);
    node.pitch.add(muzzle);
    muzzles.set(w.id, muzzle);
  }

  // Running gear: road wheels, sprockets and idlers, return rollers; shoes laid each frame.
  const { wheelRadius: r, trackGauge, trackWidth } = gear;
  const wheelG = () => cylinderAcross(r, trackWidth * 0.8, 20);
  const hubG = () => cylinderAcross(r * 0.55, trackWidth * 0.86, 10);
  const spokeG = () => box(trackWidth * 0.9, 0.05, r * 1.7);
  const wheels: THREE.Object3D[][] = [[], []];
  const sprockets: THREE.Object3D[] = [];
  const idlers: THREE.Object3D[] = [];
  for (const s of [0, 1]) {
    const across = (s === 0 ? -1 : 1) * (trackGauge / 2);
    for (const along of gear.wheelsAlong) {
      const wheel = new THREE.Group();
      b.part(wheel, 'wheel', wheelG, rubber);
      b.part(wheel, 'hub', hubG, paint);
      b.part(wheel, 'spoke', spokeG, steel);
      wheel.position.set(across, gear.wheelUp, -along);
      root.add(wheel);
      wheels[s]?.push(wheel);
    }
    for (const [c, list, name] of [
      [gear.sprocket, sprockets, 'sprocket'],
      [gear.idler, idlers, 'idler'],
    ] as const) {
      const w = new THREE.Group();
      b.part(w, name, () => cylinderAcross(c.radius, trackWidth * 0.5, 12), steel);
      b.part(w, `${name}-spoke`, () => box(trackWidth * 0.9, 0.05, c.radius * 1.7), paint);
      w.position.set(across, c.up, -c.along);
      root.add(w);
      list.push(w);
    }
    const top = Math.max(
      gear.sprocket.up + gear.sprocket.radius,
      gear.idler.up + gear.idler.radius,
    );
    for (const along of gear.rollersAlong)
      b.part(
        root,
        'roller',
        () => cylinderAcross(0.11, trackWidth * 0.5, 10),
        steel,
        across,
        top - 0.12,
        along,
      );
  }
  const shoeGeometry = shared(`${platform.id}:shoe`, () =>
    box(trackWidth, gear.shoeThickness, gear.shoePitch * 0.92),
  );
  const shoesPerTrack = shoesFor(gear);
  const shoes = new THREE.InstancedMesh(shoeGeometry, steel, 2 * shoesPerTrack);
  shoes.castShadow = true;
  shoes.receiveShadow = true;
  shoes.frustumCulled = false;
  root.add(shoes);
  return {
    root,
    hull,
    gear,
    wheels,
    sprockets,
    idlers,
    shoes,
    shoesPerTrack,
    mounts,
    muzzles,
    paint,
    dark,
    materials,
  };
}

/** Shoes per track: its loop at rest over the shoe pitch. */
function shoesFor(gear: RunningGear): number {
  const lengths = loopLengths(
    trackPath(
      gear.wheelsAlong.map(() => gear.wheelUp),
      gear,
    ),
  );
  return Math.round((lengths[lengths.length - 1] ?? 10) / gear.shoePitch);
}

// --- Hulls -------------------------------------------------------------------------

function buildHull(b: Builder, hull: THREE.Group, p: PlatformSpec, steel: THREE.Material): void {
  switch (p.visual.hull) {
    case 'm113':
      m113Hull(b, hull, steel);
      return;
    case 'abrams':
      abramsHull(b, hull, steel);
      return;
    case 't72':
      t72Hull(b, hull, steel);
      return;
    case 'bmp2':
      bmp2Hull(b, hull, steel);
      return;
    case 'box': {
      const { lengthM: l, widthM: w, heightM: h } = p.dimensions;
      b.part(hull, 'box-hull', () => box(w * 0.85, h * 0.45, l), b.paint, 0, 0.45 + h * 0.225, 0);
    }
  }
}

function m113Hull(b: Builder, hull: THREE.Group, steel: THREE.Material): void {
  const HULL: readonly [number, number][] = [
    [-2.33, 0.45],
    [2.2, 0.45],
    [2.43, 1.05],
    [1.28, 1.83],
    [-2.43, 1.83],
    [-2.43, 0.58],
  ];
  const UPPER: readonly [number, number][] = [
    [-2.43, 1.0],
    [2.41, 1.0],
    [2.43, 1.05],
    [1.28, 1.83],
    [-2.43, 1.83],
  ];
  b.part(hull, 'lower', () => profilePrism(HULL, 1.84), b.paint);
  b.part(hull, 'upper', () => profilePrism(UPPER, 2.54), b.paint);
  const glacis = Math.atan2(1.83 - 1.05, 2.43 - 1.28);
  const vane = b.part(hull, 'vane', () => box(2.2, 0.035, 0.95), b.paint);
  vane.position.set(0, (1.05 + 1.83) / 2 + 0.05, -((1.28 + 2.43) / 2 + 0.03));
  vane.rotation.x = -glacis;
  for (const s of [-1, 1]) {
    b.part(hull, 'light-guard', () => box(0.2, 0.16, 0.12), b.paint, s * 1.0, 1.22, 2.4);
    b.part(hull, 'lamp', () => box(0.12, 0.09, 0.03), b.glass, s * 1.0, 1.22, 2.47);
    b.part(hull, 'fender-lip', () => box(0.06, 0.05, 4.7), steel, s * 1.29, 1.0, 0);
    b.part(hull, 'rail', () => box(0.03, 0.03, 1.6), steel, s * 1.29, 1.6, -0.6);
  }
  b.part(hull, 'exhaust', () => box(0.16, 0.5, 0.12), steel, 0.95, 1.5, 1.9);
  const hatch = b.part(
    hull,
    'driver-hatch',
    () => new THREE.CylinderGeometry(0.3, 0.32, 0.12, 16),
    b.paint,
  );
  hatch.position.set(-0.62, 1.89, -1.0);
  b.part(hull, 'periscopes', () => box(0.36, 0.06, 0.06), b.glass, -0.62, 1.93, 1.27);
  b.part(hull, 'cargo-hatch', () => box(1.5, 0.04, 1.45), b.paint, 0, 1.85, -1.4);
  b.part(hull, 'ramp', () => box(1.7, 1.15, 0.05), b.paint, 0, 1.08, -2.45);
  b.part(hull, 'ramp-door', () => box(0.5, 0.9, 0.03), b.paint, 0.35, 1.2, -2.48);
}

function abramsHull(b: Builder, hull: THREE.Group, steel: THREE.Material): void {
  const LOWER: readonly [number, number][] = [
    [-3.85, 0.5],
    [3.2, 0.5],
    [3.95, 0.95],
    [3.95, 1.08],
    [2.2, 1.45],
    [-3.9, 1.45],
    [-3.9, 0.72],
  ];
  b.part(hull, 'lower', () => profilePrism(LOWER, 2.36), b.paint);
  // The fender deck over the tracks, and the side skirts down to the road wheels' hubs.
  b.part(hull, 'deck', () => box(3.56, 0.1, 7.5), b.paint, 0, 1.4, -0.15);
  for (const s of [-1, 1]) {
    b.part(hull, 'skirt', () => box(0.07, 0.62, 6.9), b.paint, s * 1.8, 1.06, 0.2);
    b.part(hull, 'skirt-front', () => box(0.07, 0.5, 0.7), b.paint, s * 1.8, 1.12, 3.6);
    b.part(hull, 'tail-light', () => box(0.14, 0.1, 0.05), b.glass, s * 1.45, 1.25, -3.92);
    b.part(hull, 'head-light', () => box(0.16, 0.12, 0.08), b.glass, s * 1.25, 1.2, 3.9);
  }
  // The glacis' driver's hatch and periscopes; the engine deck's grilles and the exhaust.
  b.part(hull, 'driver-hatch', () => box(0.7, 0.06, 0.5), b.paint, 0, 1.48, 2.3);
  b.part(hull, 'periscopes', () => box(0.5, 0.06, 0.05), b.glass, 0, 1.52, 2.55);
  for (const k of [0, 1, 2, 3])
    b.part(hull, 'grille', () => box(2.0, 0.03, 0.18), steel, 0, 1.47, -1.6 - k * 0.42);
  b.part(hull, 'exhaust', () => box(1.6, 0.4, 0.06), steel, 0, 1.12, -3.93);
  b.part(hull, 'tow', () => box(0.12, 0.12, 0.25), steel, -0.9, 0.75, 4.0);
}

function t72Hull(b: Builder, hull: THREE.Group, steel: THREE.Material): void {
  const LOWER: readonly [number, number][] = [
    [-3.35, 0.45],
    [2.95, 0.45],
    [3.45, 0.88],
    [2.2, 1.42],
    [-3.35, 1.42],
    [-3.43, 0.8],
  ];
  b.part(hull, 'lower', () => profilePrism(LOWER, 2.3), b.paint);
  b.part(hull, 'fender', () => box(3.45, 0.04, 6.6), b.paint, 0, 1.03, 0.05);
  for (const s of [-1, 1]) {
    // The rubber skirts (flaps) along the front of the fenders, and the stowage boxes on them.
    b.part(hull, 'flap', () => box(0.04, 0.42, 2.6), b.rubber, s * 1.72, 0.84, 1.6);
    b.part(hull, 'stowage', () => box(0.55, 0.32, 2.2), b.paint, s * 1.42, 1.2, -1.2);
    b.part(
      hull,
      'head-light',
      () => new THREE.CylinderGeometry(0.08, 0.08, 0.1, 10),
      b.glass,
      s * 0.95,
      1.3,
      2.75,
    );
  }
  // The splash guard across the glacis, the V-shaped trim board.
  const guard = b.part(hull, 'splash', () => box(2.2, 0.05, 0.25), b.paint);
  guard.position.set(0, 1.18, -2.9);
  guard.rotation.x = -0.4;
  b.part(
    hull,
    'driver-hatch',
    () => new THREE.CylinderGeometry(0.28, 0.28, 0.07, 14),
    b.paint,
    0,
    1.44,
    2.05,
  );
  // At the back: two fuel drums and the unditching log.
  for (const s of [-1, 1])
    b.part(hull, 'drum', () => cylinderAcross(0.29, 0.95, 14), steel, s * 0.6, 1.62, -3.15);
  b.part(hull, 'log', () => cylinderAcross(0.13, 3.2, 10), b.dark, 0, 1.98, -3.15);
  b.part(hull, 'exhaust', () => box(0.4, 0.2, 0.1), steel, -1.45, 1.15, -2.3);
}

function bmp2Hull(b: Builder, hull: THREE.Group, steel: THREE.Material): void {
  const LOWER: readonly [number, number][] = [
    [-3.3, 0.42],
    [2.85, 0.42],
    [3.37, 0.92],
    [3.3, 1.0],
    [0.9, 1.62],
    [-3.3, 1.75],
    [-3.37, 0.65],
  ];
  b.part(hull, 'lower', () => profilePrism(LOWER, 2.94), b.paint);
  // The ribbed glacis: the corrugations across its front.
  const slope = Math.atan2(1.62 - 1.0, 3.3 - 0.9);
  for (let k = 0; k < 5; k += 1) {
    const along = 3.15 - k * 0.42;
    const up = 1.0 + (3.3 - along) * Math.tan(slope) + 0.03;
    const rib = b.part(hull, 'rib', () => box(2.7, 0.05, 0.06), b.paint);
    rib.position.set(0, up, -along);
    rib.rotation.x = -slope;
  }
  for (const s of [-1, 1]) {
    b.part(hull, 'head-light', () => box(0.15, 0.1, 0.06), b.glass, s * 1.1, 1.15, 3.2);
    b.part(hull, 'fender', () => box(0.12, 0.04, 6.2), b.paint, s * 1.52, 1.0, 0);
    // The rear doors (with their fuel tanks) and the roof hatches over the troops.
    b.part(hull, 'door', () => box(0.7, 0.9, 0.08), b.paint, s * 0.5, 1.1, -3.38);
    b.part(hull, 'roof-hatch', () => box(0.6, 0.05, 1.6), b.paint, s * 0.55, 1.75, -1.9);
    b.part(
      hull,
      'port',
      () => new THREE.CylinderGeometry(0.06, 0.06, 0.05, 8),
      steel,
      s * 1.47,
      1.45,
      -0.6,
    );
  }
  b.part(hull, 'driver-hatch', () => box(0.55, 0.05, 0.55), b.paint, -0.75, 1.68, 1.25);
  b.part(hull, 'snorkel', () => box(0.18, 0.12, 1.0), steel, 1.1, 1.68, 0.9);
}

// --- Mounts ------------------------------------------------------------------------

/** The mount's shell (in its yaw node) and its weapons' barrels (in its pitch node). */
function buildMount(
  b: Builder,
  node: MountNode,
  p: PlatformSpec,
  spec: MountSpec,
  steel: THREE.Material,
): void {
  const { yaw, pitch } = node;
  const turret = p.visual.turret;
  const barrel = (slot: string) => p.weapons.find((w) => w.mount === spec.id && w.id === slot);
  if (spec.kind === 'cupola') {
    // A ring and its hatch, the gun on a cradle.
    b.part(
      yaw,
      'cupola-ring',
      () => new THREE.CylinderGeometry(0.38, 0.42, 0.3, 18),
      b.paint,
      0,
      0,
      0,
    );
    const lid = b.part(
      yaw,
      'cupola-lid',
      () => new THREE.CylinderGeometry(0.3, 0.3, 0.05, 14),
      b.paint,
    );
    lid.position.set(0, 0.2, 0.32);
    lid.rotation.x = -1.2;
    b.part(pitch, 'hmg-body', () => box(0.12, 0.14, 0.55), steel, 0, 0.3, 0.25);
    const hmg = p.weapons.find((w) => w.mount === spec.id);
    const length = Math.max(0.8, (hmg?.muzzle.forward ?? 1.1) - 0.45);
    b.part(
      pitch,
      `hmg-barrel-${spec.id}`,
      () => cylinderAlong(0.028, 0.028, length, 8),
      steel,
      0,
      0.3,
      0.5,
    );
    return;
  }
  if (spec.kind === 'launcher') {
    // A missile tube on its cradle (the BMP-2's 9P135M on the turret roof).
    b.part(
      pitch,
      'launcher-tube',
      () => cylinderAlong(0.085, 0.085, 1.15, 12),
      b.dark,
      0,
      0.1,
      0.55,
    );
    b.part(yaw, 'launcher-post', () => box(0.12, 0.2, 0.2), steel, 0, 0, 0);
    return;
  }
  if (turret === 'abrams') {
    // The flat, faceted turret: wide cheeks, a long bustle.
    const PLAN: readonly [number, number][] = [
      [-1.0, 2.05],
      [1.0, 2.05],
      [1.78, 0.95],
      [1.78, -1.75],
      [1.35, -2.55],
      [-1.35, -2.55],
      [-1.78, -1.75],
      [-1.78, 0.95],
    ];
    b.part(yaw, 'turret', () => planPrism(PLAN, -0.5, 0.74), b.paint);
    b.part(yaw, 'bustle-rack', () => box(3.2, 0.35, 0.7), steel, 0, 0.05, -2.75);
    b.part(yaw, 'gps', () => box(0.45, 0.32, 0.5), b.paint, 0.75, 0.38, 1.0);
    b.part(yaw, 'gps-glass', () => box(0.36, 0.2, 0.03), b.glass, 0.75, 0.38, 1.26);
    b.part(yaw, 'loader-hatch', () => box(0.65, 0.06, 0.65), b.paint, -0.75, 0.27, -0.4);
    b.part(
      yaw,
      'wind-sensor',
      () => new THREE.CylinderGeometry(0.02, 0.02, 0.6, 6),
      steel,
      0,
      0.55,
      -1.9,
    );
    for (const s of [-1, 1])
      b.part(yaw, 'smoke-launchers', () => box(0.25, 0.22, 0.35), steel, s * 1.55, 0.15, 1.2);
    // The mantlet and the gun, its bore evacuator part-way.
    b.part(pitch, 'mantlet', () => box(0.9, 0.6, 0.5), b.paint, 0, 0.0, 2.15);
    const main = barrel('main');
    const length = (main?.muzzle.forward ?? 6.3) - 2.35;
    b.part(pitch, 'gun', () => cylinderAlong(0.11, 0.085, length, 16), b.paint, 0, 0.05, 2.35);
    b.part(
      pitch,
      'evacuator',
      () => cylinderAlong(0.14, 0.14, 0.6, 16),
      b.paint,
      0,
      0.05,
      2.35 + length * 0.45,
    );
    b.part(pitch, 'coax', () => cylinderAlong(0.03, 0.03, 0.3, 6), steel, 0.55, 0.05, 2.35);
    return;
  }
  if (turret === 't72') {
    // The cast dome, thicker at the front (the B's composite cheeks).
    b.part(
      yaw,
      'dome',
      () => {
        const g = new THREE.SphereGeometry(1.15, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
        g.scale(1.0, 0.5, 1.1);
        g.translate(0, -0.4, -0.05);
        return g;
      },
      b.paint,
    );
    b.part(yaw, 'cheeks', () => box(2.0, 0.42, 0.55), b.paint, 0, -0.2, 0.95);
    b.part(
      yaw,
      'cupola',
      () => new THREE.CylinderGeometry(0.32, 0.35, 0.18, 16),
      b.paint,
      0.45,
      0.2,
      -0.15,
    );
    b.part(yaw, 'nsvt', () => cylinderAlong(0.025, 0.025, 1.2, 6), steel, 0.45, 0.38, 0.1);
    b.part(yaw, 'sight', () => box(0.25, 0.25, 0.3), b.paint, -0.55, 0.12, 0.45);
    b.part(yaw, 'snorkel', () => cylinderAcross(0.07, 1.6, 8), steel, 0, -0.1, -1.2);
    for (const k of [0, 1, 2, 3])
      for (const s of [-1, 1])
        b.part(
          yaw,
          'smoke-tube',
          () => cylinderAlong(0.04, 0.04, 0.2, 6),
          steel,
          s * (0.6 + k * 0.13),
          -0.05,
          0.85 - k * 0.12,
        );
    // The searchlight beside the gun, and the gun with its thermal sleeve and fume extractor.
    b.part(
      pitch,
      'searchlight',
      () => cylinderAlong(0.16, 0.16, 0.25, 12),
      steel,
      0.55,
      0.15,
      1.25,
    );
    b.part(pitch, 'mantlet', () => box(0.55, 0.42, 0.35), b.paint, 0, 0.0, 1.15);
    const main = barrel('main');
    const length = (main?.muzzle.forward ?? 6.0) - 1.3;
    b.part(pitch, 'gun', () => cylinderAlong(0.1, 0.075, length, 14), b.paint, 0, 0.05, 1.3);
    b.part(
      pitch,
      'extractor',
      () => cylinderAlong(0.13, 0.13, 0.45, 14),
      b.paint,
      0,
      0.05,
      1.3 + length * 0.42,
    );
    for (const k of [0, 1, 2])
      b.part(
        pitch,
        'sleeve-band',
        () => cylinderAlong(0.115, 0.115, 0.04, 14),
        steel,
        0,
        0.05,
        1.5 + k * (length / 4),
      );
    return;
  }
  if (turret === 'bmp2') {
    // A low, faceted turret; the long, thin 30 mm gun.
    b.part(
      yaw,
      'turret',
      () => new THREE.CylinderGeometry(0.78, 1.02, 0.55, 8),
      b.paint,
      0,
      0.05,
      0,
    );
    b.part(
      yaw,
      'commander-hatch',
      () => new THREE.CylinderGeometry(0.28, 0.28, 0.06, 12),
      b.paint,
      0.4,
      0.35,
      -0.2,
    );
    b.part(
      yaw,
      'gunner-hatch',
      () => new THREE.CylinderGeometry(0.26, 0.26, 0.06, 12),
      b.paint,
      -0.4,
      0.35,
      -0.25,
    );
    b.part(yaw, 'sight', () => box(0.22, 0.25, 0.25), b.paint, -0.4, 0.42, 0.25);
    for (const s of [-1, 1])
      for (const k of [0, 1, 2])
        b.part(
          yaw,
          'smoke-tube',
          () => cylinderAlong(0.04, 0.04, 0.18, 6),
          steel,
          s * (0.7 + k * 0.08),
          0.1,
          -0.3 - k * 0.15,
        );
    b.part(pitch, 'mantlet', () => box(0.4, 0.3, 0.3), b.paint, 0, 0.05, 0.9);
    const main = barrel('main');
    const length = (main?.muzzle.forward ?? 3.1) - 1.0;
    b.part(pitch, 'gun', () => cylinderAlong(0.05, 0.04, length, 10), steel, 0, 0.05, 1.0);
    b.part(
      pitch,
      'flash-hider',
      () => cylinderAlong(0.06, 0.06, 0.2, 10),
      steel,
      0,
      0.05,
      1.0 + length - 0.2,
    );
    return;
  }
  // A plain box turret and a gun for any other platform.
  b.part(yaw, 'box-turret', () => box(1.6, 0.6, 2.0), b.paint, 0, 0, 0);
  for (const w of p.weapons.filter((x) => x.mount === spec.id))
    b.part(
      pitch,
      `box-gun-${w.id}`,
      () => cylinderAlong(0.05, 0.05, Math.max(0.3, w.muzzle.forward - 0.8), 8),
      steel,
      w.muzzle.right,
      w.muzzle.up,
      0.8,
    );
}

/** Charred colours of a destroyed vehicle. */
export const CHARRED = 0x2b2622;
export const CHARRED_DARK = 0x1c1917;
