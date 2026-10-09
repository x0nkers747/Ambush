import type { Vec2, Viewshed, ViewshedGrid } from '#sim';
import type { ViewshedService } from './viewshed-service';

// A fire team's visible area (docs/adr/0022): the union of its Marines'
// viewsheds. A cell is visible to the team when at least one Marine sees it.
// Every cell is decided exactly as for a single Marine (viewshed-service.ts).

export function sameGrid(a: ViewshedGrid, b: ViewshedGrid): boolean {
  return (
    a.originX === b.originX &&
    a.originY === b.originY &&
    a.cellSize === b.cellSize &&
    a.columns === b.columns &&
    a.rows === b.rows
  );
}

/**
 * The union of viewsheds on one grid: visible (1) where any of them is. Its
 * observer is the first viewshed's. Viewsheds of one terrain at one cell size
 * share a grid (`viewshedGrid`), so no resampling is ever needed; other grids
 * are refused.
 */
export function unionViewsheds(viewsheds: readonly Viewshed[]): Viewshed {
  const [first, ...rest] = viewsheds;
  if (!first) throw new RangeError('no viewsheds to combine');
  const visible = first.visible.slice();
  for (const viewshed of rest) {
    if (!sameGrid(viewshed.grid, first.grid)) {
      throw new RangeError('viewsheds on different grids cannot be combined');
    }
    const other = viewshed.visible;
    for (let i = 0; i < visible.length; i += 1) visible[i] = (visible[i] ?? 0) | (other[i] ?? 0);
  }
  return { grid: first.grid, observer: first.observer, visible };
}

/** A fire team's visible area as far as it is ready. */
export interface TeamVisibility {
  /**
   * The union of every Marine's viewshed once ready; meanwhile its half-way
   * preview (every other row), or until then `previous`.
   */
  readonly viewshed: Viewshed | null;
  /** Whether the union is still being computed. */
  readonly pending: boolean;
  /** Whether `viewshed` is the union's half-way preview. */
  readonly preview: boolean;
  /** Whether viewsheds cannot be computed (every worker failed). */
  readonly failed: boolean;
}

/**
 * A fire team's visible area from the viewshed service (`requestUnion`):
 * computed in the background as one job, Marines whose own viewsheds are
 * cached reused as they are, the result cached by the Marines' exact
 * positions. The service drops results of superseded work, so moving or
 * turning a formation never shows an outdated union as current: until the
 * new one is half-way, `previous` (the team's last union, never another
 * team's or a single Marine's) is shown, marked pending.
 */
export function createTeamVisibility(
  service: Pick<ViewshedService, 'requestUnion'>,
): (observers: readonly Vec2[], cellSize: number, previous: Viewshed | null) => TeamVisibility {
  return (observers, cellSize, previous) => {
    const request = service.requestUnion(observers, cellSize);
    if (request.failed) return { viewshed: previous, pending: false, preview: false, failed: true };
    if (!request.pending)
      return { viewshed: request.viewshed, pending: false, preview: false, failed: false };
    return request.preview
      ? { viewshed: request.viewshed, pending: true, preview: true, failed: false }
      : { viewshed: previous, pending: true, preview: false, failed: false };
  };
}
