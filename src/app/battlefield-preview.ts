import { createExercise, type AmbushScenario } from '#exercise';
import { createSession, setTool, type Session } from '#session';
import { DEFAULT_TICK_RATE_HZ } from '#sim';
import { createTacticalMap, type TacticalMap } from '#view2d';

// The terrain-selection preview (docs/adr/0025): the selected battlefield on
// the tactical map, with its scenario as saved (ORP, OPFOR and route). It is
// for looking only: the map pans and zooms, and clicks select but never edit
// (the `view` tool). Opening the battlefield hands this map to the
// workspace, and leaving the workspace hands it back, so the map is never
// rebuilt between the two.

export interface PreviewData {
  /** The battlefield's scenario as it would be played (its terrain is the battlefield's). */
  readonly scenario: AmbushScenario;
  /** Whether its ORP is placed; until then the squad and the ORP are not shown. */
  readonly squadPlaced: boolean;
  /** Source credits shown on the map. */
  readonly attribution: readonly string[];
  /** A short line about the scenario, e.g. "No OPFOR yet". */
  readonly caption: string;
}

export interface BattlefieldPreview {
  /**
   * Shows battlefield `id`, loading it unless it is already shown or
   * loading; a newer `show`, `adopt` or `hide` wins over a slower load.
   */
  show(id: string, load: () => Promise<PreviewData>): void;
  /** Shows battlefield `id` on a map handed back by its workspace, keeping the map's view. */
  adopt(id: string, map: TacticalMap, data: PreviewData): void;
  hide(): void;
  /**
   * Gives the map away (to the workspace) without disposing it, or `null`
   * when no map is shown yet. The preview is empty afterwards.
   */
  release(): TacticalMap | null;
}

export function createBattlefieldPreview(container: HTMLElement): BattlefieldPreview {
  container.innerHTML = `
    <div class="preview-map" data-ui="preview-map"></div>
    <div class="attribution" data-ui="preview-attribution" hidden></div>
    <div class="preview-status" data-ui="preview-status" role="status"></div>
    <div class="mapbar"><span class="pointer" data-ui="preview-pointer"></span><span class="spacer"></span>
      <span data-ui="preview-caption"></span>
      <button class="small" data-ui="preview-fit" title="Fit the whole map">Fit map</button></div>`;
  const el = (name: string) => {
    const e = container.querySelector<HTMLElement>(`[data-ui="${name}"]`);
    if (!e) throw new Error(`Missing UI element ${name}`);
    return e;
  };
  let map: TacticalMap | null = null;
  let session: Session = setTool(createSession(), 'view');
  /** The battlefield shown or loading, or `null`. */
  let shownId: string | null = null;
  /** Each show, adopt or hide; a load that finishes after a newer one is dropped. */
  let generation = 0;
  let frame: number | null = null;

  const stopLoop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  /** Disposes the preview's own map; a released map is no longer the preview's to remove. */
  const stopMap = () => {
    stopLoop();
    if (!map) return;
    map.dispose();
    map = null;
    el('preview-map').replaceChildren();
  };
  const loop = () => {
    map?.render();
    // The same pointer readout as the other stages' map bar.
    const p = map?.pointer;
    const text = p
      ? `E ${p.east.toFixed(1)} m   N ${p.north.toFixed(1)} m   Elev ${p.elevation.toFixed(1)} m`
      : '';
    const readout = el('preview-pointer');
    if (readout.textContent !== text) readout.textContent = text;
    frame = requestAnimationFrame(loop);
  };
  const status = (text: string | null) => {
    el('preview-status').hidden = text === null;
    el('preview-status').textContent = text ?? '';
  };
  el('preview-fit').addEventListener('click', () => {
    map?.fitView();
  });

  /** Shows `data` on `existing` (a handed-back map) or on a new map. */
  const present = (data: PreviewData, existing: TacticalMap | null) => {
    if (map !== existing) stopMap();
    stopLoop();
    session = setTool(createSession(), 'view');
    const binding = {
      exercise: createExercise({
        config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
        scenario: data.scenario,
      }),
      getSession: () => session,
      setSession: (next: Session) => {
        session = next;
      },
      hideTrainee: () => !data.squadPlaced,
    };
    const canvas = existing?.canvas ?? document.createElement('canvas');
    canvas.id = '';
    canvas.className = 'preview-canvas';
    canvas.setAttribute('aria-label', 'Battlefield preview');
    el('preview-map').replaceChildren(canvas);
    if (existing) existing.attach(binding);
    map = existing ?? createTacticalMap({ canvas, ...binding });
    const credits = el('preview-attribution');
    credits.hidden = data.attribution.length === 0;
    credits.textContent = data.attribution
      .map((line) => line.replace(/^Map data /, ''))
      .slice(0, 2)
      .join(' · ');
    credits.title = data.attribution.join('\n');
    el('preview-caption').textContent = data.caption;
    status(null);
    loop();
  };

  return {
    show(id, load) {
      if (id === shownId) return;
      shownId = id;
      const mine = (generation += 1);
      container.hidden = false;
      status('Loading the preview…');
      load()
        .then((data) => {
          if (mine !== generation) return;
          present(data, null);
        })
        .catch((error: unknown) => {
          if (mine !== generation) return;
          stopMap();
          el('preview-caption').textContent = '';
          status(
            `No preview: ${error instanceof Error ? error.message : String(error)}. The battlefield may still open.`,
          );
        });
    },
    adopt(id, handed, data) {
      generation += 1;
      shownId = id;
      container.hidden = false;
      present(data, handed);
    },
    hide() {
      generation += 1;
      shownId = null;
      stopMap();
      container.hidden = true;
    },
    release() {
      generation += 1;
      shownId = null;
      stopLoop();
      const given = map;
      map = null;
      return given;
    },
  };
}
