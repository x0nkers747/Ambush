import * as THREE from 'three';

// Fighting positions (docs/behavior-lab/force-on-force/09): what a defence
// has dug, drawn on the ground. Each soldier's position grows with his
// squad's dig-in: a shallow scrape the length of a man lying prone, then a
// fighting pit with a parapet of spoil in front, and at full dig-in a short
// stretch of trench, a parapet in front and a lower parados behind. The
// ground itself is not cut: the hole is a dark patch on it, and a soldier
// standing in it is drawn lower (the characters' `inTrench`), the ground
// hiding his legs.

/** A soldier's fighting position, as the battle reports it (map metres, radians, 0–1). */
export interface ViewEarthwork {
  readonly soldierId: string;
  readonly x: number;
  readonly y: number;
  readonly azimuth: number;
  readonly level: number;
  /** On hard ground (a paved road, paving): nothing is dug, nothing drawn, and he lies prone. */
  readonly hard?: boolean;
}

/** From this dig-in on, a soldier stands in his position, sunk into the ground. */
export const STANDING_FROM_LEVEL = 0.5;
/** How deep a soldier standing in his position is sunk (m), from `STANDING_FROM_LEVEL` to fully dug in. */
const SINK_M = [0.55, 1.15] as const;

/** How far a soldier standing in his fighting position is sunk below the ground (m); 0 when he is not. */
export function sinkDepth(level: number): number {
  if (level < STANDING_FROM_LEVEL) return 0;
  const t = Math.min(1, (level - STANDING_FROM_LEVEL) / (1 - STANDING_FROM_LEVEL));
  return SINK_M[0] + t * (SINK_M[1] - SINK_M[0]);
}

/**
 * A position's shape at a dig-in level: the hole (along the facing, across
 * it), and the parapet in front and parados behind (across, deep, high), m.
 */
export function earthworkShape(level: number): {
  readonly holeAlong: number;
  readonly holeAcross: number;
  readonly parapet: readonly [number, number, number];
  readonly parados: readonly [number, number, number];
} {
  const l = Math.max(0, Math.min(1, level));
  if (l < STANDING_FROM_LEVEL) {
    // A scrape: as long as a man lying prone, growing deeper (a darker patch) and its spoil higher.
    const t = l / STANDING_FROM_LEVEL;
    return {
      holeAlong: 1.9,
      holeAcross: 0.6 + 0.2 * t,
      parapet: [0.9 + 0.3 * t, 0.35 + 0.15 * t, 0.06 + 0.16 * t],
      parados: [0, 0, 0],
    };
  }
  // A pit, widening across into a stretch of trench.
  const t = (l - STANDING_FROM_LEVEL) / (1 - STANDING_FROM_LEVEL);
  return {
    holeAlong: 0.9,
    holeAcross: 1.1 + 1.9 * t,
    parapet: [1.6 + 2 * t, 0.6 + 0.2 * t, 0.28 + 0.17 * t],
    parados: [t > 0.6 ? 1.2 + 1.6 * t : 0, 0.45, 0.18 * t],
  };
}

/** A scrape's turned soil, and a deep position's shadowed floor. */
const SOIL = new THREE.Color(0x6a5236);
const DEEP = new THREE.Color(0x2b2117);

export interface EarthworksLayer {
  readonly group: THREE.Group;
  /** Draws `works` on the ground (`surfaceAt`: its height at a map point); rebuilt only when they change. */
  update(works: readonly ViewEarthwork[], surfaceAt: (x: number, y: number) => number): void;
  dispose(): void;
}

export function createEarthworksLayer(): EarthworksLayer {
  const group = new THREE.Group();
  group.name = 'earthworks';
  // The hole: a dark patch just above the ground, drawn over it.
  const holeGeometry = new THREE.PlaneGeometry(1, 1);
  holeGeometry.rotateX(-Math.PI / 2);
  // Coloured per position (`setColorAt`): turned soil in a scrape, darker the deeper it is.
  const holeMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  // Spoil: a flattened mound.
  const moundGeometry = new THREE.SphereGeometry(0.5, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const moundMaterial = new THREE.MeshStandardMaterial({ color: 0x6e5636, roughness: 0.95 });
  let holes: THREE.InstancedMesh | null = null;
  let mounds: THREE.InstancedMesh | null = null;
  let key = '';
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const colour = new THREE.Color();

  const clear = () => {
    for (const mesh of [holes, mounds]) {
      if (!mesh) continue;
      group.remove(mesh);
      mesh.dispose();
    }
    holes = null;
    mounds = null;
  };

  return {
    group,
    update(works, surfaceAt) {
      // Rebuilt when a position appears, moves or deepens (in steps of 1 %).
      const next = works
        .map(
          (w) =>
            `${w.soldierId}:${w.x.toFixed(1)},${w.y.toFixed(1)},${String(Math.round(w.level * 100))}`,
        )
        .join('|');
      if (next === key) return;
      key = next;
      clear();
      const shown = works.filter((w) => w.level > 0.005 && !w.hard);
      if (shown.length === 0) return;
      holes = new THREE.InstancedMesh(holeGeometry, holeMaterial, shown.length);
      mounds = new THREE.InstancedMesh(moundGeometry, moundMaterial, shown.length * 2);
      holes.receiveShadow = true;
      mounds.castShadow = true;
      mounds.receiveShadow = true;
      let nMounds = 0;
      shown.forEach((w, i) => {
        const s = earthworkShape(w.level);
        const ground = surfaceAt(w.x, w.y);
        const z = Number.isFinite(ground) ? ground : 0;
        // Three.js: x east, y up, z south; the map's azimuth is clockwise from north.
        q.setFromAxisAngle(up, -w.azimuth);
        const fx = Math.sin(w.azimuth);
        const fy = Math.cos(w.azimuth);
        pos.set(w.x, z + 0.02, -w.y);
        scale.set(s.holeAcross, 1, s.holeAlong);
        holes?.setMatrixAt(i, m.compose(pos, q, scale));
        holes?.setColorAt(
          i,
          colour.copy(SOIL).lerp(DEEP, Math.min(1, w.level / STANDING_FROM_LEVEL)),
        );
        const place = (dims: readonly [number, number, number], ahead: number) => {
          if (dims[0] <= 0 || dims[2] <= 0 || !mounds) return;
          const x = w.x + fx * ahead;
          const y = w.y + fy * ahead;
          const g = surfaceAt(x, y);
          pos.set(x, (Number.isFinite(g) ? g : z) - 0.02, -y);
          scale.set(dims[0], dims[2] * 2, dims[1]);
          mounds.setMatrixAt(nMounds, m.compose(pos, q, scale));
          nMounds += 1;
        };
        place(s.parapet, s.holeAlong / 2 + s.parapet[1] / 2);
        place(s.parados, -(s.holeAlong / 2 + s.parados[1] / 2));
      });
      mounds.count = nMounds;
      holes.instanceMatrix.needsUpdate = true;
      if (holes.instanceColor) holes.instanceColor.needsUpdate = true;
      mounds.instanceMatrix.needsUpdate = true;
      group.add(holes, mounds);
    },
    dispose() {
      clear();
      holeGeometry.dispose();
      holeMaterial.dispose();
      moundGeometry.dispose();
      moundMaterial.dispose();
    },
  };
}
