import { Group, Mesh, MeshBasicMaterial, RingGeometry, SphereGeometry, DoubleSide } from 'three';
import type { CombatEvent } from '#exercise';

// Grenade bursts in the 3D view (docs/behavior-lab/force-on-force/06 §5): a
// brief flash and a ring of dust spreading to the effect radius, for about a
// second from the burst's time on the battle's clock (so the review shows
// them where it is, seeking or not). A small fixed pool: never more objects
// than bursts at once.

/** How long a burst shows (s), and the ring's reach (m; the M203's effect radius). */
const SHOW_SECONDS = 1.2;
const RING_REACH_M = 10;
const POOL = 8;

export interface ImpactLayer {
  readonly group: Group;
  /** Shows the bursts of `combatLog` around `seconds`; `surfaceAt` gives the ground's height. */
  update(
    combatLog: readonly CombatEvent[],
    seconds: number,
    surfaceAt: (x: number, y: number) => number,
  ): void;
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
      new MeshBasicMaterial({ color: 0xffd27a, transparent: true, depthWrite: false }),
    );
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
    return { flash, ring };
  });
  const opacity = (m: Mesh, value: number) => {
    (m.material as MeshBasicMaterial).opacity = value;
  };

  return {
    group,
    update(combatLog, seconds, surfaceAt) {
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
        const k = Math.max(0, age) / SHOW_SECONDS;
        // Flash: a quick bloom over the first quarter.
        const f = Math.min(1, k * 4);
        slot.flash.visible = f < 1;
        slot.flash.position.set(e.impact.x, h + 0.8, -e.impact.y);
        slot.flash.scale.setScalar(0.8 + 2.2 * f);
        opacity(slot.flash, 0.9 * (1 - f));
        // Dust ring: out to the effect radius, fading.
        slot.ring.visible = true;
        slot.ring.position.set(e.impact.x, h + 0.15, -e.impact.y);
        slot.ring.scale.setScalar(1 + (RING_REACH_M - 1) * Math.sqrt(k));
        opacity(slot.ring, 0.65 * (1 - k));
      }
      for (let i = used; i < POOL; i += 1) {
        const slot = pool[i];
        if (!slot) continue;
        slot.flash.visible = false;
        slot.ring.visible = false;
      }
    },
    dispose() {
      flashGeometry.dispose();
      ringGeometry.dispose();
      for (const { flash, ring } of pool) {
        flash.material.dispose();
        ring.material.dispose();
      }
    },
  };
}
