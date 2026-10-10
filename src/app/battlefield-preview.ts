import { createExercise, type AmbushScenario } from '#exercise';
import { createSession, setTool, type Session } from '#session';
import { DEFAULT_TICK_RATE_HZ } from '#sim';
import { createTacticalMap, type MapView, type TacticalMap } from '#view2d';

// The terrain-selection preview (docs/adr/0025): the selected battlefield on
// the tactical map, with its scenario as saved (ORP, OPFOR and route). It is
// for looking only: the map pans and zooms, and clicks select but never edit
// (the `view` tool). Opening the battlefield loads it again on its own page.

export interface PreviewData {
  /** The battlefield's scenario as it would be played (its terrain is the battlefield's). */
  readonly scenario: AmbushScenario;
  /** Source credits shown on the map. */
  readonly attribution: readonly string[];
  /** A short line about the scenario, e.g. "No OPFOR yet". */
  readonly caption: string;
}

export interface BattlefieldPreview {
  /**
   * Loads and shows a battlefield, at `view` when given (otherwise the whole
   * map); a newer `show` or `hide` wins over a slower load.
   */
  show(load: () => Promise<PreviewData>, view?: MapView | null): void;
  hide(): void;
  /** What the preview map shows, or `null` while there is no map. */
  view(): MapView | null;
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
  /** Each show or hide; a load that finishes after a newer one is dropped. */
  let generation = 0;
  let frame: number | null = null;

  const stopMap = () => {
    map?.dispose();
    map = null;
    el('preview-map').replaceChildren();
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
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

  return {
    show(load, view = null) {
      const mine = (generation += 1);
      container.hidden = false;
      status('Loading the preview…');
      load()
        .then((data) => {
          if (mine !== generation) return;
          stopMap();
          const canvas = document.createElement('canvas');
          canvas.className = 'preview-canvas';
          canvas.setAttribute('aria-label', 'Battlefield preview');
          el('preview-map').append(canvas);
          session = setTool(createSession(), 'view');
          map = createTacticalMap({
            canvas,
            exercise: createExercise({
              config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
              scenario: data.scenario,
            }),
            getSession: () => session,
            setSession: (next) => {
              session = next;
            },
          });
          if (view) map.setView(view.centre, view.metersPerPixel);
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
    hide() {
      generation += 1;
      stopMap();
      container.hidden = true;
    },
    view() {
      return map?.view ?? null;
    },
  };
}
