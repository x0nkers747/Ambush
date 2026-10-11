import {
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
  type Camera,
} from 'three';
import { toThree, yawOf } from './axes';
import type { DestinationMarker, UnitMarker } from './unit-markers';

// Soldier markers (docs/adr/0029): simple figures, blue for BLUEFOR and red for
// OPFOR, with a nose pointing the way the soldier faces. A marker's origin is
// the soldier's feet, on the simulated ground. Far away it is drawn larger, so
// it stays about `MARKER_PX` pixels tall on screen; close up it is life size.

/** On-screen height of a marker seen from afar, in CSS pixels. */
const MARKER_PX = 26;
/** Life-size marker height, in metres. */
const MARKER_HEIGHT_M = 1.9;

const COLORS = {
  friendly: 0x2f6fd0,
  enemy: 0xc8372d,
  down: 0x6e737a,
  selected: 0xf2c230,
} as const;

const material = (color: number, opacity = 1) =>
  new MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.25,
    roughness: 0.6,
    metalness: 0,
    // Markers stay readable across the battlefield: no fog.
    fog: false,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });

export interface MarkerLayer {
  readonly group: Group;
  /** Matches the markers to the soldiers and destinations shown now. */
  update(
    units: readonly UnitMarker[],
    destinations: readonly DestinationMarker[],
    camera: Camera & { fov: number },
    viewportHeightPx: number,
  ): void;
  /** Where each soldier's marker stands (Three.js axes; the feet, or the body's base when lying). */
  positions(): Map<string, { x: number; y: number; z: number; lying: boolean }>;
  dispose(): void;
}

export function createMarkerLayer(): MarkerLayer {
  const group = new Group();
  group.name = 'units';
  // Body, head and facing nose; the nose points along −Z, the marker's
  // forward (north at yaw 0, see axes.ts). A destination is a downward pin.
  const body = new CylinderGeometry(0.32, 0.38, 1.35, 12).translate(0, 0.675, 0);
  const head = new SphereGeometry(0.3, 16, 12).translate(0, 1.6, 0);
  const nose = new ConeGeometry(0.22, 0.7, 10).rotateX(-Math.PI / 2).translate(0, 1.15, -0.55);
  const pin = new ConeGeometry(0.35, 0.9, 12).rotateX(Math.PI).translate(0, 0.45, 0);
  const materials = {
    friendly: material(COLORS.friendly),
    enemy: material(COLORS.enemy),
    down: material(COLORS.down),
    selected: material(COLORS.selected),
    destinationFriendly: material(COLORS.friendly, 0.45),
    destinationSelected: material(COLORS.selected, 0.6),
  };
  const soldiers = new Map<string, { root: Group; parts: Mesh[] }>();
  const pins = new Map<string, Mesh>();

  /** Scale so the marker is MARKER_PX tall on screen, but never smaller than life size. */
  const scaleAt = (
    x: number,
    y: number,
    z: number,
    camera: Camera & { fov: number },
    viewportHeightPx: number,
  ) => {
    const c = camera.position;
    const distance = Math.hypot(c.x - x, c.y - y, c.z - z);
    const metresPerPx =
      (2 * distance * Math.tan(((camera.fov / 2) * Math.PI) / 180)) / viewportHeightPx;
    return Math.max(1, (MARKER_PX * metresPerPx) / MARKER_HEIGHT_M);
  };

  return {
    group,
    update(units, destinations, camera, viewportHeightPx) {
      const seen = new Set<string>();
      for (const u of units) {
        seen.add(u.id);
        let entry = soldiers.get(u.id);
        if (!entry) {
          const parts = [new Mesh(body), new Mesh(head), new Mesh(nose)];
          const root = new Group();
          root.name = `soldier ${u.id}`;
          root.add(...parts);
          group.add(root);
          entry = { root, parts };
          soldiers.set(u.id, entry);
        }
        const down = u.status !== 'active';
        const look = down
          ? materials.down
          : u.selected
            ? materials.selected
            : u.affiliation === 'friendly'
              ? materials.friendly
              : materials.enemy;
        for (const part of entry.parts) part.material = look;
        const lying = down || u.posture === 'prone';
        const [, , noseMesh] = entry.parts;
        if (noseMesh) noseMesh.visible = !lying;
        const p = toThree(u.position.x, u.position.y, u.position.z);
        const s = scaleAt(p.x, p.y, p.z, camera, viewportHeightPx);
        // Yaw, then (when lying) tip forward onto the ground, head first.
        entry.root.rotation.order = 'YXZ';
        entry.root.rotation.set(lying ? -Math.PI / 2 : 0, yawOf(u.azimuth), 0);
        if (lying) {
          entry.root.position.set(p.x, p.y + 0.3 * s, p.z);
          entry.root.scale.set(s, s, s * 0.6);
        } else {
          entry.root.position.set(p.x, p.y, p.z);
          entry.root.scale.set(s, u.posture === 'kneeling' ? s * 0.7 : s, s);
        }
      }
      for (const [id, entry] of soldiers) {
        if (seen.has(id)) continue;
        group.remove(entry.root);
        soldiers.delete(id);
      }
      const planned = new Set<string>();
      for (const d of destinations) {
        planned.add(d.id);
        let mesh = pins.get(d.id);
        if (!mesh) {
          mesh = new Mesh(pin);
          mesh.name = `destination ${d.id}`;
          mesh.renderOrder = 1;
          group.add(mesh);
          pins.set(d.id, mesh);
        }
        mesh.material = d.selected ? materials.destinationSelected : materials.destinationFriendly;
        const p = toThree(d.position.x, d.position.y, d.position.z);
        mesh.position.set(p.x, p.y, p.z);
        mesh.scale.setScalar(scaleAt(p.x, p.y, p.z, camera, viewportHeightPx) * 0.7);
      }
      for (const [id, mesh] of pins) {
        if (planned.has(id)) continue;
        group.remove(mesh);
        pins.delete(id);
      }
    },
    positions() {
      const out = new Map<string, { x: number; y: number; z: number; lying: boolean }>();
      for (const [id, { root }] of soldiers) {
        out.set(id, {
          x: root.position.x,
          y: root.position.y,
          z: root.position.z,
          lying: root.rotation.x !== 0,
        });
      }
      return out;
    },
    dispose() {
      for (const m of Object.values(materials)) m.dispose();
      for (const g of [body, head, nose, pin]) g.dispose();
      group.clear();
      soldiers.clear();
      pins.clear();
    },
  };
}
