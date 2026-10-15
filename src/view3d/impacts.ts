import { Group, Mesh, MeshBasicMaterial, RingGeometry, SphereGeometry, DoubleSide } from 'three';
import type { CombatEvent } from '#exercise';

// Grenade explosions in the 3D view (docs/behavior-lab/force-on-force/06 §5):
// a fireball flash, a ring of dust spreading to the effect radius and a puff
// of smoke rising and thinning, from the burst's time on the battle's clock
// (so the review shows them where it is, seeking or not). A small fixed
// pool: never more objects than explosions at once.

/** How long an explosion shows (s: the smoke's), the flash's and the ring's, and the ring's reach (m; the M203's effect radius). */
const SHOW_SECONDS = 3.5;
const FLASH_SECONDS = 0.5;
const RING_SECONDS = 1.2;
/** Radians a pixel spans, roughly (the views' 45° field over about 900 pixels): far off, an explosion keeps a size on screen. */
const PIXEL_RAD = 0.00087;
const RING_REACH_M = 10;
const POOL = 8;

export interface ImpactLayer {
  readonly group: Group;
  /** Shows the bursts of `combatLog` around `seconds`; `surfaceAt` gives the ground's height. */
  update(
    combatLog: readonly CombatEvent[],
    seconds: number,
    surfaceAt: (x: number, y: number) => number,
    /** The camera's position (Three.js coordinates). */
    eye: { readonly x: number; readonly y: number; readonly z: number },
  ): void;
  /** Explosions shown at the last update. */
  readonly active: number;
  dispose(): void;
}

export function createImpactLayer(): ImpactLayer {
  const group = new Group();
  group.name = 'grenade-impacts';
  const flashGeometry = new SphereGeometry(1, 12, 8);
  const ringGeometry = new RingGeometry(0.85, 1, 32);
  ringGeometry.rotateX(-Math.PI / 2);
  const pool = Array.from({ length: POOL }, () => {
    const flash = new Mesh(
      flashGeometry,
      new MeshBasicMaterial({ color: 0xffa630, transparent: true, depthWrite: false }),
    );
    const smoke = new Mesh(
      flashGeometry,
      new MeshBasicMaterial({ color: 0x3b3733, transparent: true, depthWrite: false }),
    );
    smoke.visible = false;
    smoke.renderOrder = 1;
    group.add(smoke);
    const ring = new Mesh(
      ringGeometry,
      new MeshBasicMaterial({
        color: 0x6b5a46,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      }),
    );
    flash.visible = false;
    ring.visible = false;
    flash.renderOrder = 2;
    ring.renderOrder = 2;
    group.add(flash, ring);
    return { flash, ring, smoke };
  });
  const opacity = (m: Mesh, value: number) => {
    (m.material as MeshBasicMaterial).opacity = value;
  };

  let active = 0;
  return {
    group,
    get active() {
      return active;
    },
    update(combatLog, seconds, surfaceAt, eye) {
      // The log is in time order: the last burst at or before `seconds`, then back.
      let lo = 0;
      let hi = combatLog.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((combatLog[mid]?.atSeconds ?? Infinity) <= seconds + 1e-9) lo = mid + 1;
        else hi = mid;
      }
      let used = 0;
      for (let i = lo - 1; i >= 0 && used < POOL; i -= 1) {
        const e = combatLog[i];
        if (!e) continue;
        const age = seconds - e.atSeconds;
        if (age > SHOW_SECONDS) break;
        if (e.type !== 'grenadeImpact') continue;
        const slot = pool[used];
        if (!slot) break;
        used += 1;
        const ground = surfaceAt(e.impact.x, e.impact.y);
        const h = Number.isFinite(ground) ? ground : 0;
        const t = Math.max(0, age);
        // Seen from far, it grows so it stays some 30 pixels across.
        const far = Math.hypot(e.impact.x - eye.x, h - eye.y, -e.impact.y - eye.z);
        const boost = Math.max(1, (far * PIXEL_RAD * 15) / 4);
        // Fireball: a quick, bright bloom.
        const f = Math.min(1, t / FLASH_SECONDS);
        slot.flash.visible = f < 1;
        slot.flash.position.set(e.impact.x, h + 1.2 * boost, -e.impact.y);
        slot.flash.scale.setScalar((1.5 + 2.5 * Math.sqrt(f)) * boost);
        opacity(slot.flash, 1 - f * f);
        // Dust ring: out to the effect radius, fading.
        const k = Math.min(1, t / RING_SECONDS);
        slot.ring.visible = k < 1;
        slot.ring.position.set(e.impact.x, h + 0.15, -e.impact.y);
        slot.ring.scale.setScalar((1 + (RING_REACH_M - 1) * Math.sqrt(k)) * Math.max(1, boost / 2));
        opacity(slot.ring, 0.8 * (1 - k));
        // Smoke: a dark cloud growing, rising and thinning.
        const m = t / SHOW_SECONDS;
        slot.smoke.visible = true;
        slot.smoke.position.set(e.impact.x, h + (2 + 5 * m) * boost, -e.impact.y);
        slot.smoke.scale.setScalar((2.5 + 5 * Math.sqrt(m)) * boost);
        opacity(slot.smoke, 0.8 * (1 - m) * Math.min(1, t / 0.2));
      }
      active = used;
      for (let i = used; i < POOL; i += 1) {
        const slot = pool[i];
        if (!slot) continue;
        slot.flash.visible = false;
        slot.ring.visible = false;
        slot.smoke.visible = false;
      }
    },
    dispose() {
      flashGeometry.dispose();
      ringGeometry.dispose();
      for (const { flash, ring, smoke } of pool) {
        flash.material.dispose();
        ring.material.dispose();
        smoke.material.dispose();
      }
    },
  };
}
