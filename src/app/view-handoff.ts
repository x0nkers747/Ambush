import type { MapView } from '#view2d';

// The map view handed from one page to the next (docs/adr/0025): terrain
// selection and the workspace are separate pages, so opening a battlefield
// from its preview, or leaving it for terrain selection, reloads. The view
// crosses in session storage and is taken once, by the page showing the same
// battlefield, so the trainee keeps looking at the same spot.

const KEY = 'ambush.mapView';

interface HandedOff extends MapView {
  readonly battlefieldId: string;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Leaves `view` of a battlefield (its id) for the next page. */
export function handOffView(battlefieldId: string, view: MapView | null): void {
  try {
    if (view === null) storage()?.removeItem(KEY);
    else storage()?.setItem(KEY, JSON.stringify({ battlefieldId, ...view }));
  } catch {
    // Without storage the next page fits the whole map, as before.
  }
}

/** The view handed off for this battlefield, or `null`; any handed-off view is used up. */
export function takeView(battlefieldId: string): MapView | null {
  let text: string | null;
  try {
    text = storage()?.getItem(KEY) ?? null;
    storage()?.removeItem(KEY);
  } catch {
    return null;
  }
  return text === null ? null : parseView(text, battlefieldId);
}

function parseView(text: string, battlefieldId: string): MapView | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const { battlefieldId: id, centre, metersPerPixel } = v as Partial<HandedOff>;
  // JSON may hold anything: `centre` can be null or a non-object.
  if (id !== battlefieldId || typeof centre !== 'object' || (centre as unknown) === null)
    return null;
  const { x, y } = centre;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (typeof metersPerPixel !== 'number' || !(metersPerPixel > 0)) return null;
  return { centre: { x, y }, metersPerPixel };
}
