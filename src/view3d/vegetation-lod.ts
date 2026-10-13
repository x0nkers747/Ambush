// The vegetation's levels of detail (docs/adr/0031): each plant is drawn
// near, medium or far by its distance from the camera, and not at all beyond
// the far band. In the far band plants are thinned progressively, so a
// distant forest keeps its cover as it thins and nothing pops in or out in
// bulk. forest.ts chooses what to draw by these.

export interface LodSettings {
  /** Ends of the near and medium bands, and the farthest plant drawn, metres. */
  readonly near: number;
  readonly medium: number;
  readonly far: number;
  /** Thinning starts here and keeps `minFraction` of the plants at `far`. */
  readonly thinStart: number;
  readonly minFraction: number;
}

/** The band a plant at `distance` is drawn in (0 near, 1 medium, 2 far), or −1 for none. */
export function lodBand(distance: number, s: LodSettings, lodScale = 1): number {
  if (distance < s.near * lodScale) return 0;
  if (distance < s.medium * lodScale) return 1;
  if (distance < s.far * lodScale) return 2;
  return -1;
}

/** The share of plants kept at `distance` in the far band: 1 up to `thinStart`, then falling to `minFraction`. */
export function keepFraction(distance: number, s: LodSettings, lodScale = 1): number {
  const start = s.thinStart * lodScale;
  const end = s.far * lodScale;
  if (distance <= start) return 1;
  if (distance >= end) return s.minFraction;
  return 1 - ((distance - start) / (end - start)) * (1 - s.minFraction);
}
