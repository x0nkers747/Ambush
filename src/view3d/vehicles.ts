import * as THREE from 'three';
import {
  emptyArticulation,
  emptyMotionSample,
  type ArticulationSample,
  type MotionLog,
} from '#exercise';
import { builtInCatalog, platformOf, type CombatCatalog, type PlatformSpec } from '#sim';
import { addTravel, alongLoop, fitHull, loopLengths, trackPath, turn, type Travel } from './tracks';
import { buildVehicleModel, CHARRED, CHARRED_DARK, type VehicleModel } from './vehicle-models';
import type { Wreck } from './heavy-effects';

export { addTravel, alongLoop, fitHull, loopLengths, M113, trackPath } from './tracks';
export type { ProfilePoint } from './tracks';

// Vehicles in 3D (docs/vehicles.md, docs/combined-arms.md §11): each platform
// built from its visual definition (`vehicle-models.ts`), posed from the
// battle's motion log. It sits on the ground as a tracked vehicle does: each
// road wheel rides the ground under it on its own suspension, the hull
// pitching and rolling to the plane that fits them, nosing up as it
// accelerates and down as it brakes. Its tracks are shoes running round the
// sprocket, the road wheels and the idler, moving as far as the vehicle has
// driven on each side (the outer track faster in a turn, the two in opposite
// ways as it pivots), and the wheels turn with them. Its mounts turn and lift
// as the log's articulation says (interpolated between ticks); destroyed, it
// is charred, and a catastrophic kill may throw its turret.

/** A vehicle to show: its motion is the motion log's (its id there); `kind` its platform. */
export interface ViewVehicle {
  readonly id: string;
  readonly side: 'BLUEFOR' | 'OPFOR';
  readonly kind?: string;
}

export interface VehicleLayer {
  readonly group: THREE.Group;
  /**
   * Poses the vehicles at `seconds` of `log` (interpolated between ticks), on
   * the ground `surfaceAt` gives (NaN off the terrain).
   */
  update(
    vehicles: readonly ViewVehicle[],
    log: MotionLog,
    seconds: number,
    surfaceAt: (x: number, y: number) => number,
  ): void;
  /** The destroyed vehicles at the last update: where their fire and smoke rise, and whether they burn. */
  readonly wrecks: readonly Wreck[];
  /** Where a vehicle's weapon's muzzle is now (map metres east, north, up), or `false` if not shown. */
  muzzleOf(vehicleId: string, slot: string, out: THREE.Vector3): boolean;
  dispose(): void;
}

/** Pitch per m/s² of acceleration (rad): the nose lifts as it accelerates, dips as it brakes. */
const SQUAT_RAD = 0.009;

/** A small whole number from an id (the same every time): which way a wreck's turret was thrown. */
function idHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface Entry {
  model: VehicleModel;
  platform: PlatformSpec;
  side: ViewVehicle['side'];
  kind: string;
  travel: Travel;
  epoch: number;
  charred: boolean;
  /** What its track shoes were last laid for (its wheels and how far each track has run). */
  shoesFor: string;
}

export function createVehicleLayer(catalog: CombatCatalog = builtInCatalog()): VehicleLayer {
  const group = new THREE.Group();
  group.name = 'vehicles';
  const models = new Map<string, Entry>();
  const a = emptyMotionSample();
  const b = emptyMotionSample();
  const c = emptyMotionSample();
  const d = emptyMotionSample();
  const artA: ArticulationSample = emptyArticulation();
  const artB: ArticulationSample = emptyArticulation();
  const shoeMatrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const pos = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const shoeQ = new THREE.Quaternion();
  const xAxis = new THREE.Vector3(1, 0, 0);
  const at = { along: 0, up: 0, dx: 0, dy: 0 };
  let wrecks: Wreck[] = [];

  const drop = (id: string) => {
    const m = models.get(id);
    if (!m) return;
    group.remove(m.model.root);
    m.model.shoes.dispose();
    for (const x of m.model.materials) x.dispose();
    models.delete(id);
  };

  const platformFor = (kind: string): PlatformSpec => {
    try {
      return platformOf(catalog, kind);
    } catch {
      return platformOf(catalog, 'm113');
    }
  };

  /** The pose at `tick + f`: position, heading, and speeds (for the squat), from the log. */
  const pose = (index: number, log: MotionLog, tick: number, f: number) => {
    log.read(index, tick, a);
    log.read(index, tick + 1, b);
    const x = a.x + (b.x - a.x) * f;
    const y = a.y + (b.y - a.y) * f;
    const heading = a.azimuth + turn(a.azimuth, b.azimuth) * f;
    // Acceleration over the last second (forward speed now less a second ago).
    const rate = log.tickRateHz;
    log.read(index, tick - rate, c);
    const speed = (p: typeof a, q2: typeof a, ticks: number) =>
      ((q2.x - p.x) * Math.sin(heading) + (q2.y - p.y) * Math.cos(heading)) * (rate / ticks);
    const now = speed(a, b, 1);
    log.read(index, tick - rate + 1, d);
    const before = speed(c, d, 1);
    const accel = log.firstTick <= tick - rate ? Math.max(-3, Math.min(3, now - before)) : 0;
    return { x, y, heading, accel };
  };

  /** Charred (destroyed) or in its paint. */
  const char = (entry: Entry, charred: boolean) => {
    if (entry.charred === charred) return;
    entry.charred = charred;
    entry.model.paint.color.setHex(charred ? CHARRED : entry.platform.visual.color);
    entry.model.dark.color.setHex(charred ? CHARRED_DARK : entry.platform.visual.darkColor);
    entry.model.paint.roughness = charred ? 1 : 0.82;
  };

  /** The mounts as the articulation says (between two ticks); a destroyed one's turret maybe thrown. */
  const articulate = (entry: Entry, id: string, f: number, destroyed: boolean) => {
    const { model, platform } = entry;
    platform.mounts.forEach((spec, m) => {
      const node = model.mounts.get(spec.id);
      if (!node) return;
      const az0 = artA.mounts[m * 2] ?? 0;
      const az1 = artB.mounts[m * 2] ?? 0;
      const el0 = artA.mounts[m * 2 + 1] ?? 0;
      const el1 = artB.mounts[m * 2 + 1] ?? 0;
      node.yaw.rotation.set(0, -(az0 + turn(az0, az1) * f), 0);
      node.pitch.rotation.x = el0 + (el1 - el0) * f;
      node.yaw.position.set(spec.pivot.right, spec.pivot.up, -spec.pivot.forward);
      // A catastrophic kill of a vulnerable tank: its turret lifted off and thrown aside.
      if (destroyed && spec.parent === null && spec.kind === 'turret') {
        const h = idHash(id);
        if (platform.catastrophicVulnerability >= 0.6 && h % 3 !== 0) {
          const side = h % 2 === 0 ? 1 : -1;
          node.yaw.position.x += side * 2.6;
          node.yaw.position.y -= 1.0;
          node.yaw.rotation.z = side * 0.5;
          node.pitch.rotation.x = -0.1;
        } else {
          node.yaw.position.y += 0.05;
          node.yaw.rotation.z = (h % 2 === 0 ? 1 : -1) * 0.06;
          node.pitch.rotation.x = -0.12;
        }
      }
    });
  };

  return {
    group,
    get wrecks() {
      return wrecks;
    },
    update(vehicles, log, seconds, surfaceAt) {
      wrecks = [];
      const wanted = new Set(vehicles.map((v) => v.id));
      for (const id of [...models.keys()]) if (!wanted.has(id)) drop(id);
      const exact = seconds * log.tickRateHz;
      const tick = Math.max(log.firstTick, Math.min(log.lastTick, Math.floor(exact)));
      const f = Math.max(0, Math.min(1, exact - tick));
      for (const v of vehicles) {
        const index = log.indexOf(v.id);
        const kind = v.kind ?? 'm113';
        let entry = models.get(v.id);
        if (entry && (entry.side !== v.side || entry.kind !== kind)) {
          drop(v.id);
          entry = undefined;
        }
        if (index < 0 || log.lastTick < log.firstTick) {
          if (entry) entry.model.root.visible = false;
          continue;
        }
        if (!entry) {
          const platform = platformFor(kind);
          const model = buildVehicleModel(platform);
          group.add(model.root);
          entry = {
            model,
            platform,
            side: v.side,
            kind,
            travel: { tick: log.firstTick, left: 0, right: 0 },
            epoch: log.epoch,
            charred: false,
            shoesFor: '',
          };
          models.set(v.id, entry);
        }
        const { model, travel } = entry;
        const gear = model.gear;
        model.root.visible = true;
        // The tracks' travel to this tick: carried on, or counted again from the start.
        if (entry.epoch !== log.epoch || tick < travel.tick || travel.tick < log.firstTick) {
          travel.tick = log.firstTick;
          travel.left = 0;
          travel.right = 0;
          entry.epoch = log.epoch;
        }
        if (tick > travel.tick) addTravel(log, index, travel.tick, tick, travel, gear.trackGauge);
        // And on, within the tick.
        log.read(index, tick, a);
        log.read(index, tick + 1, b);
        const mid = a.azimuth + turn(a.azimuth, b.azimuth) / 2;
        const ds = ((b.x - a.x) * Math.sin(mid) + (b.y - a.y) * Math.cos(mid)) * f;
        const dt = turn(a.azimuth, b.azimuth) * f * (gear.trackGauge / 2);
        const left = travel.left + ds + dt;
        const right = travel.right + ds - dt;

        log.readArticulation(index, tick, artA);
        log.readArticulation(index, tick + 1, artB);
        const destroyed = artA.condition === 'destroyed';
        char(entry, destroyed);
        articulate(entry, v.id, f, destroyed);

        const p = pose(index, log, tick, f);
        const sin = Math.sin(p.heading);
        const cos = Math.cos(p.heading);
        // The ground under each road wheel.
        const ground = [0, 1].map((s) => {
          const across = (s === 0 ? -1 : 1) * (gear.trackGauge / 2);
          return gear.wheelsAlong.map((along) => {
            const gx = p.x + sin * along + cos * across;
            const gy = p.y + cos * along - sin * across;
            const h = surfaceAt(gx, gy);
            return Number.isFinite(h) ? h : surfaceAt(p.x, p.y);
          });
        });
        const fit = fitHull(ground, gear);
        const pitch = Math.atan(fit.slopeAlong) + p.accel * SQUAT_RAD;
        const roll = Math.atan(fit.slopeAcross);
        pos.set(p.x, fit.height, -p.y);
        // Heading about up, then pitch (nose up positive about the right axis), then roll.
        euler.set(pitch, -p.heading, roll, 'YXZ');
        q.setFromEuler(euler);
        model.root.position.copy(pos);
        model.root.quaternion.copy(q);
        model.root.updateMatrixWorld(true);
        if (destroyed || artA.burning)
          wrecks.push({
            id: v.id,
            x: p.x,
            y: p.y,
            z: fit.height + entry.platform.dimensions.heightM * 0.75,
            burning: artA.burning,
          });

        // Each road wheel on its own suspension: down to its ground, within its travel.
        const wheelUp: number[][] = [[], []];
        for (const s of [0, 1]) {
          const across = (s === 0 ? -1 : 1) * (gear.trackGauge / 2);
          const run = s === 0 ? left : right;
          gear.wheelsAlong.forEach((along, i) => {
            const plane = fit.height + fit.slopeAlong * along + fit.slopeAcross * across;
            const offset = Math.max(
              -gear.rebound,
              Math.min(gear.bump, (ground[s]?.[i] ?? plane) - plane),
            );
            const up = gear.wheelUp + offset;
            wheelUp[s]?.push(up);
            const w = model.wheels[s]?.[i];
            if (w) {
              w.position.set(across, up, -along);
              w.rotation.x = -run / gear.wheelRadius;
            }
          });
          const sp = model.sprockets[s];
          if (sp) sp.rotation.x = -run / gear.sprocket.radius;
          const idl = model.idlers[s];
          if (idl) idl.rotation.x = -run / gear.idler.radius;
        }

        // The shoes, laid round each track's path, moved back along it as far as it has run
        // (only when that has changed: a vehicle standing still is not laid again every frame).
        const shoesFor = `${String(left)},${String(right)},${wheelUp.flat().join(',')}`;
        const relay = shoesFor !== entry.shoesFor;
        entry.shoesFor = shoesFor;
        for (const s of relay ? [0, 1] : []) {
          const across = (s === 0 ? -1 : 1) * (gear.trackGauge / 2);
          const path = trackPath(wheelUp[s] ?? [], gear);
          const lengths = loopLengths(path);
          const perimeter = lengths[lengths.length - 1] ?? 0;
          const n = model.shoesPerTrack;
          const pitchM = perimeter / n;
          const run = s === 0 ? left : right;
          for (let k = 0; k < n; k += 1) {
            alongLoop(path, lengths, k * pitchM - run, at);
            const angle = Math.atan2(at.dy, at.dx);
            shoeQ.setFromAxisAngle(xAxis, angle);
            pos.set(across, at.up, -at.along);
            shoeMatrix.compose(pos, shoeQ, one);
            model.shoes.setMatrixAt(s * n + k, shoeMatrix);
          }
        }
        if (relay) model.shoes.instanceMatrix.needsUpdate = true;
      }
    },
    muzzleOf(vehicleId, slot, out) {
      const entry = models.get(vehicleId);
      const muzzle = entry?.model.muzzles.get(slot);
      if (!entry || !muzzle || !entry.model.root.visible) return false;
      muzzle.getWorldPosition(out);
      // Scene (x east, y up, −z north) → map (east, north, up).
      out.set(out.x, -out.z, out.y);
      return true;
    },
    dispose() {
      for (const id of [...models.keys()]) drop(id);
    },
  };
}
