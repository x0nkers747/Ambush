import {
  decodePngInBrowser,
  generateBattlefield,
  isCancelled,
  NOMINATIM,
  OsmUnavailableError,
  searchPlaces,
  ServiceError,
  storeServiceSetting,
  type BattlefieldStore,
  type BattlefieldSummary,
  type GenerationStep,
  type PlaceResult,
  type ServiceConfig,
} from '#acquire';
import { demQualitySummary, type DemFinding, type DemQualityReport, type Vec2 } from '#sim';
import type { TacticalMap } from '#view2d';
import {
  battlefieldRequest,
  createFrame,
  DEFAULT_BATTLEFIELD_SIZE_M,
  DEFAULT_CELL_SIZE_M,
  formatCoordinates,
  toGeo,
  validateLatLon,
  type BattlefieldPackage,
  type LatLon,
} from '#geo';
import { createBattlefieldPreview, type PreviewData } from './battlefield-preview';
import { createToast, escapeHtml, headerHtml, TRASH_ICON, wireHeader } from './shell';
import type { WorkflowFacts } from './workflow';

// Stage 1, terrain selection (docs/adr/0014, docs/adr/0025): find a place or
// enter a position and generate a new 5 km battlefield, or select a saved
// battlefield and open it. The layout is the other stages': the map area
// previews the selected saved battlefield on the tactical map, and the
// side panel on the right chooses, describes the choice and holds its one
// primary action. Opening a battlefield hands the preview's map to the
// workspace in the same page (docs/adr/0025).

export interface SelectionOptions {
  readonly config: ServiceConfig;
  readonly configProblems: readonly string[];
  readonly store: BattlefieldStore;
  /** Whether saved battlefields survive a reload (IndexedDB available). */
  readonly persistent: boolean;
  /** A saved battlefield's id to select on arrival (e.g. coming back from stage 2). */
  readonly selected?: string;
  /** Loads a saved battlefield for the preview map. */
  readonly loadPreview: (id: string) => Promise<PreviewData>;
  /**
   * Opens battlefield `id` (stage 2), on `map` when the preview showed it
   * (otherwise `null`). Terrain selection is disposed by then.
   */
  readonly openBattlefield: (id: string, map: TacticalMap | null) => void;
  /** A map handed back by battlefield `id`'s workspace: the preview keeps showing it. */
  readonly adopt?: { readonly id: string; readonly map: TacticalMap; readonly data: PreviewData };
}

export interface BattlefieldSelection {
  /** Stops everything terrain selection started (generation, the preview map). */
  dispose(): void;
}

const SURFACE_LABEL: Record<string, string> = {
  DTM: 'bare earth (terrain model)',
  DSM: 'surface model: includes tree canopy and buildings',
  mixed: 'mixed bare-earth and surface models',
  unknown: 'unknown source type',
};

/** Lat/lon readout for a battlefield's local metres. */
export function describePointFor(pkg: BattlefieldPackage): (p: Vec2) => string {
  const frame = createFrame(pkg.request.centre, pkg.request.widthM, pkg.request.heightM);
  return (p) => formatCoordinates(toGeo(frame, p));
}

/**
 * A battlefield's description (sources, accuracy, credits) for Battlefield
 * Information, with its DEM quality report when the terrain has been prepared.
 */
export function battlefieldInfoHtml(
  pkg: BattlefieldPackage,
  quality: DemQualityReport | null = null,
): string {
  const e = pkg.elevation;
  const datasets = e.datasets.filter((d) => d.resolutionM < 200).map((d) => d.name);
  const resolution =
    e.finestResolutionM === null
      ? 'unknown resolution'
      : e.coarsestResolutionM !== null && e.coarsestResolutionM !== e.finestResolutionM
        ? `about ${String(e.finestResolutionM)}–${String(e.coarsestResolutionM)} m source data`
        : `about ${String(e.finestResolutionM)} m source data`;
  const c = pkg.processing.counts;
  // The range of the ground in use: once prepared, the cleaned and graded
  // terrain (docs/adr/0033), not the raw import's, which keeps any faults.
  let [lowM, highM] = [e.minM, e.maxM];
  if (quality) {
    [lowM, highM] = [Infinity, -Infinity];
    for (const v of pkg.terrain.heightfield.elevations) {
      lowM = Math.min(lowM, v);
      highM = Math.max(highM, v);
    }
  }
  return `
    <dl class="kv">
      <dt>Location</dt><dd>${escapeHtml(formatCoordinates(pkg.request.centre))}</dd>
      <dt>Size</dt><dd>${pkg.request.widthM.toLocaleString('en')} × ${pkg.request.heightM.toLocaleString('en')} m</dd>
      <dt>Coordinates</dt><dd>UTM ${String(pkg.frame.zone)}${pkg.frame.hemisphere} (EPSG:${String(pkg.frame.epsg)})</dd>
      <dt>Elevation</dt><dd>${String(pkg.request.cellSizeM)} m grid from ${escapeHtml(datasets.join(', ') || 'unrecognised sources')} (${resolution}; ${escapeHtml(SURFACE_LABEL[e.surfaceModel] ?? e.surfaceModel)}). ${String(Math.round(lowM))}–${String(Math.round(highM))} m.</dd>
      ${quality ? `<dt>Terrain check</dt><dd>${terrainCheckHtml(quality)}</dd>` : ''}
      <dt>Buildings</dt><dd>${buildingsLine(pkg)}</dd>
      ${pkg.treeCover ? `<dt>Tree cover</dt><dd>${treeCoverLine(pkg.treeCover)}</dd>` : ''}
      <dt>Map data</dt><dd>${
        pkg.osm.available
          ? `OpenStreetMap as of ${escapeHtml(pkg.osm.timestampOsmBase ?? 'unknown')}: ${String(c.roads)} roads and paths, ${String(c.vegetation)} vegetation, ${String(c.water)} water, ${String(c.waterways)} waterways, ${String(c.landUse)} land use`
          : 'none (OpenStreetMap could not be fetched)'
      }</dd>
      <dt>Generated</dt><dd>${escapeHtml(new Date(pkg.createdAt).toLocaleString())} · importer ${escapeHtml(pkg.processing.importerVersion)}</dd>
    </dl>
    ${
      pkg.processing.warnings.length > 0
        ? `<ul class="bf-warnings">${pkg.processing.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
        : ''
    }
    <p class="muted">The ${String(pkg.request.cellSizeM)} m grid is resampled from the source; it adds no detail the source does not have. Ditches, banks and walls narrower than the source resolution are not in the terrain.</p>
    <details class="sub"><summary>Sources and credits</summary><ul class="credits">${pkg.attribution
      .map((a) => `<li>${escapeHtml(a)}</li>`)
      .join('')}</ul></details>`;
}

/** Woods added from canopy heights (docs/adr/0050): how many, and how well the map lined up. */
function treeCoverLine(t: NonNullable<BattlefieldPackage['treeCover']>): string {
  const ha = (t.areaM2 / 10_000).toFixed(1);
  const [dx, dy] = t.shiftM;
  const lined = t.aligned
    ? `lined up with the mapped woods (moved ${String(Math.abs(dx))} m ${dx < 0 ? 'west' : 'east'}, ${String(Math.abs(dy))} m ${dy < 0 ? 'south' : 'north'}; it has trees in ${String(Math.round(t.mappedWoodsFound * 100))}% of them)`
    : 'not lined up (too few mapped woods)';
  return `${String(t.woods)} woods (${ha} ha) OpenStreetMap does not map, from the Meta / WRI canopy height map: trees ${String(t.thresholdM)} m or taller, ${lined}.`;
}

/** The DEM quality check (docs/adr/0033): one line, with the details folded away. */
function terrainCheckHtml(q: DemQualityReport): string {
  const line = demQualitySummary(q) ?? 'Terrain validation complete. No elevation errors found.';
  const shown = q.findings.slice(0, 12);
  const place = (f: DemFinding) => `${String(Math.round(f.x))}, ${String(Math.round(f.y))}`;
  const value = (v: number | null) => (v === null ? 'no data' : `${v.toFixed(1)} m`);
  const describe = (f: DemFinding) => {
    const what =
      f.kind === 'source'
        ? 'faulty source pixel'
        : f.kind === 'invalid'
          ? `${String(f.samples)} invalid sample(s)`
          : `${f.samples === 1 ? 'isolated' : `${String(f.samples)}-sample`} ${f.kind}`;
    const outcome =
      f.action === 'repaired'
        ? `${value(f.original)} → ${value(f.cleaned)}`
        : f.action === 'unresolved'
          ? `${value(f.original)}, not repaired`
          : `${value(f.original)}, kept`;
    return `<li>${escapeHtml(`${what} at ${place(f)}: ${outcome}`)}</li>`;
  };
  return `${escapeHtml(line)} <span class="muted">(${escapeHtml(q.version)}, ${q.samples.toLocaleString('en')} samples)</span>${
    shown.length > 0
      ? `<details class="sub"><summary>Details</summary><ul class="credits">${shown.map(describe).join('')}${
          q.findings.length > shown.length
            ? `<li>${escapeHtml(`and ${String(q.findings.length - shown.length)} more`)}</li>`
            : ''
        }</ul></details>`
      : ''
  }`;
}

/** Where a battlefield's buildings came from (docs/adr/0023), with their count. */
function buildingsLine(pkg: BattlefieldPackage): string {
  const count = pkg.processing.counts.buildings;
  const b = pkg.buildings;
  if (b?.source === 'overture' && b.overture) {
    const sources = Object.entries(b.overture.bySource)
      .sort(([, x], [, y]) => y - x)
      .map(([name, n]) => `${String(n)} ${escapeHtml(name)}`)
      .join(', ');
    return `${String(count)} from Overture Maps (release ${escapeHtml(b.overture.release)}; outlines from ${sources})`;
  }
  if (b?.source === 'none') return 'none';
  return `${String(count)} from OpenStreetMap`;
}

const STEPS: readonly [GenerationStep, string][] = [
  ['elevation', 'Elevation tiles'],
  ['buildings', 'Buildings (Overture Maps)'],
  ['osm', 'Map features (OpenStreetMap)'],
  ['trees', 'Tree cover (canopy heights)'],
  ['processing', 'Building the battlefield'],
  ['saving', 'Saving'],
];

/** What is selected: a saved battlefield, or a new location to generate. */
type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'saved'; readonly summary: BattlefieldSummary }
  | { readonly kind: 'location'; readonly position: LatLon; readonly name: string | null };

const summaryLine = (b: BattlefieldSummary): string => {
  const c = b.counts;
  return `${b.widthM.toLocaleString('en')} × ${b.heightM.toLocaleString('en')} m · ${
    b.osmAvailable
      ? `${String(c.buildings)} buildings, ${String(c.roads)} roads`
      : c.buildings > 0
        ? `${String(c.buildings)} buildings, no OpenStreetMap features`
        : 'terrain only'
  }`;
};

export function startBattlefieldSelection(
  app: HTMLElement,
  o: SelectionOptions,
): BattlefieldSelection {
  app.className = 'select';
  app.innerHTML = `
    ${headerHtml('')}
    <main class="ws-map">
      <div class="ws-canvas">
        <div class="sel-preview" data-ui="preview-panel" hidden></div>
        <div class="sel-placeholder" data-ui="placeholder"></div>
        <div class="toast" data-ui="toast" role="status" hidden></div>
      </div>
    </main>
    <aside class="side" aria-label="Choose a battlefield">
      <div class="primary-action">
        <button class="primary-btn" data-ui="primary" aria-describedby="primary-reason"></button>
        <p class="reason warn" id="primary-reason" data-ui="primary-reason"></p>
        <!-- Generation's progress and outcome, under its button so they stay in view. -->
        <div data-ui="progress" hidden>
          <ol class="bf-steps" data-ui="steps"></ol>
          <div class="hint" data-ui="message" hidden></div>
          <div class="bf-row"><button class="small" data-ui="cancel">Cancel</button></div>
        </div>
        <div class="bf-error" data-ui="error" role="alert" hidden></div>
      </div>
      <section class="sec">
        <h2>Find a place</h2>
        <form class="bf-row" data-ui="search-form">
          <label class="grow"><span class="sr-only">Place name</span><input id="bf-search" placeholder="e.g. Quantico, Virginia" autocomplete="off"></label>
          <button type="submit" data-ui="search-button">Search</button>
        </form>
        <ul class="bf-results" data-ui="results" hidden></ul>
      </section>
      <section class="sec">
        <h2>Position</h2>
        <form class="bf-row" data-ui="coords-form">
          <label>Latitude <input id="bf-lat" inputmode="decimal" placeholder="38.5223" autocomplete="off"></label>
          <label>Longitude <input id="bf-lon" inputmode="decimal" placeholder="-77.2934" autocomplete="off"></label>
          <button type="submit">Use</button>
        </form>
        <p><button class="link" data-ui="here">Use my current position</button></p>
        <p class="hint" data-ui="position-message" hidden></p>
      </section>
      <section class="sec">
        <h2>Tree cover</h2>
        <label class="check-row"><input type="checkbox" data-ui="tree-cover"> Add woods OpenStreetMap does not map, from satellite canopy heights</label>
        <p class="hint">For new battlefields: about 10 MB more to download, and a few seconds. From the Meta / World Resources Institute canopy height map (about 1 m; imagery from recent years).</p>
      </section>
      <section class="sec">
        <h2>Saved battlefields</h2>
        <ul class="bf-saved" data-ui="saved"><li class="muted">Loading…</li></ul>
        ${
          o.persistent
            ? '<p class="hint">Saved in this browser: they open without a network connection.</p>'
            : '<p class="hint warn">This browser cannot store battlefields (storage is unavailable): generated battlefields are lost when the page is closed.</p>'
        }
      </section>
      <section class="sec">
        <h2>Selected</h2>
        <div class="sel-details" data-ui="preview"></div>
      </section>
      <footer class="sel-credits muted">
        Map data © OpenStreetMap contributors (ODbL). Buildings: Overture Maps Foundation (ODbL).
        Elevation: AWS Terrain Tiles (USGS, SRTM, Copernicus EU-DEM and national sources; credits
        are listed with each battlefield). Place search: Nominatim.
        ${o.configProblems.length > 0 ? `<br><span class="warn">Service settings ignored: ${escapeHtml(o.configProblems.join('; '))}</span>` : ''}
      </footer>
    </aside>`;

  const ui = (name: string): HTMLElement => {
    const el = app.querySelector<HTMLElement>(`[data-ui="${name}"]`);
    if (!el) throw new Error(`Missing UI element ${name}`);
    return el;
  };
  const input = (id: string) => {
    const el = app.querySelector<HTMLInputElement>(`#${id}`);
    if (!el) throw new Error(`Missing input ${id}`);
    return el;
  };
  const show = (name: string, html: string | null) => {
    const el = ui(name);
    el.hidden = html === null;
    el.innerHTML = html ?? '';
  };
  const notify = createToast(ui('toast'));
  const preview = createBattlefieldPreview(ui('preview-panel'));

  let selection: Selection = { kind: 'none' };
  let saved: readonly BattlefieldSummary[] = [];
  let generating: AbortController | null = null;
  let opening = false;
  /** Set once the page has moved on: late answers (search, generation, storage) are ignored. */
  let disposed = false;
  /** Whether the page is still shown (read after an `await`, when `disposed` may have changed). */
  const live = () => !disposed;
  /** The battlefield whose map was handed back, until the saved list confirms the selection. */
  let adopting = o.adopt?.id ?? null;

  const facts: WorkflowFacts = {
    battlefieldSelected: () => selection.kind === 'saved',
    scenarioProblems: () => [],
    startOpforProblems: () => [],
    opforStarted: () => false,
    engagementComplete: () => false,
  };
  const header = wireHeader(app, {
    go: () => {
      openSelection();
    },
    blocked: (reason) => {
      notify(
        selection.kind === 'location'
          ? 'Generate the battlefield first: a new location has no terrain yet.'
          : reason,
      );
    },
  });

  // --- The selection and its details -------------------------------------

  /** The selection's details, in the side panel. */
  const previewHtml = (): string => {
    switch (selection.kind) {
      case 'none':
        return `<p class="muted">Nothing selected. Find a place or enter a position to generate a new
          ${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} × ${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} m battlefield
          anywhere from 80° S to 84° N, or select a saved battlefield.</p>`;
      case 'saved': {
        const b = selection.summary;
        return `<p class="sel-name">${escapeHtml(b.name)}</p>
          <dl class="kv">
            <dt>Location</dt><dd>${escapeHtml(formatCoordinates(b.centre, 4))}</dd>
            <dt>Size</dt><dd>${summaryLine(b)}</dd>
            <dt>Elevation</dt><dd>${b.elevationResolutionM === null ? 'resolution unknown' : `~${String(b.elevationResolutionM)} m source data`}</dd>
            <dt>Generated</dt><dd>${escapeHtml(new Date(b.createdAt).toLocaleString())}</dd>
          </dl>`;
      }
      case 'location': {
        const { position, name } = selection;
        const frame = createFrame(position, DEFAULT_BATTLEFIELD_SIZE_M);
        const lat = position.lat.toFixed(5);
        const lon = position.lon.toFixed(5);
        return `<p class="sel-name">${escapeHtml(name ?? 'New battlefield')}</p>
          <dl class="kv">
            <dt>Centre</dt><dd>${escapeHtml(formatCoordinates(position))}</dd>
            <dt>Size</dt><dd>${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} × ${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} m · UTM ${String(frame.zone)}${frame.hemisphere}</dd>
            <dt>Elevation</dt><dd>${String(DEFAULT_CELL_SIZE_M)} m grid</dd>
          </dl>
          <p class="muted">You place the squad's ORP and the OPFOR in Edit Scenario.
          <a href="https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lon}#map=16/${lat}/${lon}" target="_blank" rel="noopener">View on OpenStreetMap</a></p>`;
      }
    }
  };

  /** What the map area says when there is nothing to preview. */
  const placeholderText = (): string =>
    selection.kind === 'location'
      ? generating
        ? 'Generating the battlefield…'
        : 'A new battlefield can be previewed once it is generated.'
      : 'Select a saved battlefield to preview it here.';

  /** The one primary action: open the selection, or generate a new location. */
  const updatePrimary = () => {
    const button = ui('primary');
    const label = selection.kind === 'location' ? 'Generate battlefield' : 'Open battlefield →';
    const reason =
      selection.kind === 'none'
        ? 'Select a battlefield first: a saved one, or generate a new one.'
        : selection.kind === 'location' && generating
          ? 'Generating…'
          : null;
    button.textContent = label;
    button.setAttribute('aria-disabled', String(reason !== null));
    ui('primary-reason').textContent = reason ?? '';
    ui('primary-reason').hidden = reason === null;
    ui('placeholder').textContent = placeholderText();
  };

  const markSelected = () => {
    const id = selection.kind === 'saved' ? selection.summary.id : null;
    for (const b of app.querySelectorAll<HTMLElement>('[data-select]')) {
      const on = b.dataset['select'] === id;
      b.setAttribute('aria-pressed', String(on));
      if (on) keepInView(b);
    }
  };
  /** Scrolls the saved list (only the list) so a battlefield's row is in view. */
  const keepInView = (item: HTMLElement) => {
    const list = ui('saved');
    const row = item.closest<HTMLElement>('li') ?? item;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  };

  const select = (next: Selection) => {
    const id = next.kind === 'saved' ? next.summary.id : null;
    adopting = null;
    // A battlefield already shown (e.g. handed back by its workspace) is kept as it is.
    if (id === null) preview.hide();
    else preview.show(id, () => o.loadPreview(id));
    selection = next;
    show('preview', previewHtml());
    updatePrimary();
    ui('placeholder').hidden = id !== null;
    if (next.kind !== 'location') show('error', null);
    markSelected();
    header.update('terrain', facts);
  };

  const setLocation = (position: LatLon, name: string | null) => {
    try {
      validateLatLon(position);
    } catch (error) {
      positionMessage(`${error instanceof Error ? error.message : String(error)}.`);
      return;
    }
    positionMessage(null);
    select({ kind: 'location', position, name });
  };
  const positionMessage = (text: string | null) => {
    ui('position-message').hidden = text === null;
    ui('position-message').textContent = text ?? '';
    ui('position-message').classList.toggle('warn', text !== null);
  };

  // --- Position, search, current position ---------------------------------

  // Coordinates: decimal degrees; "lat, lon" pasted into the first field is split.
  input('bf-lat').addEventListener('input', () => {
    const parts = input('bf-lat')
      .value.split(/[,;\s]+/)
      .filter((p) => p !== '');
    if (parts.length === 2 && parts[0] !== undefined && parts[1] !== undefined) {
      input('bf-lat').value = parts[0];
      input('bf-lon').value = parts[1];
    }
  });
  ui('coords-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const lat = Number(input('bf-lat').value.trim());
    const lon = Number(input('bf-lon').value.trim());
    if (
      input('bf-lat').value.trim() === '' ||
      input('bf-lon').value.trim() === '' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      positionMessage(
        'Enter latitude and longitude in decimal degrees, e.g. 38.5223 and -77.2934.',
      );
      return;
    }
    show('results', null);
    setLocation({ lat, lon }, null);
  });
  ui('here').addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      positionMessage('This browser cannot tell its position. Enter coordinates instead.');
      return;
    }
    positionMessage('Finding your position…');
    ui('position-message').classList.remove('warn');
    navigator.geolocation.getCurrentPosition(
      (p) => {
        if (disposed) return;
        input('bf-lat').value = p.coords.latitude.toFixed(6);
        input('bf-lon').value = p.coords.longitude.toFixed(6);
        setLocation({ lat: p.coords.latitude, lon: p.coords.longitude }, 'Current position');
      },
      (error) => {
        if (disposed) return;
        positionMessage(
          `Your position is not available (${error.message || 'permission denied'}). Enter coordinates instead.`,
        );
      },
      { enableHighAccuracy: false, timeout: 15000 },
    );
  });

  // Place search: only on request (Nominatim forbids search-as-you-type).
  ui('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const query = input('bf-search').value;
    if (query.trim() === '') return;
    const button = ui('search-button') as HTMLButtonElement;
    button.disabled = true;
    show('results', '<li class="muted">Searching…</li>');
    searchPlaces(query, o.config, { fetch: (u, i) => window.fetch(u, i) })
      .then((results: PlaceResult[]) => {
        if (disposed) return;
        if (results.length === 0) {
          // Nominatim knows only what OpenStreetMap maps: say why, and what to do instead.
          show(
            'results',
            `<li class="no-results"><p><b>No places found for “${escapeHtml(query.trim())}”.</b></p>
            <p class="muted">Search only finds places mapped in OpenStreetMap, and many street
            addresses are missing, especially house numbers outside towns.</p>
            <p class="muted">Try the road, town or postcode instead, or
            <button class="link" data-action="enter-coordinates">enter coordinates</button>
            from another map: paste “lat, lon” into Latitude. In Google Maps, right-click the spot
            and click the coordinates to copy them.</p></li>`,
          );
          ui('results')
            .querySelector('[data-action="enter-coordinates"]')
            ?.addEventListener('click', () => {
              input('bf-lat').focus();
              input('bf-lat').select();
            });
          return;
        }
        show(
          'results',
          results
            .map(
              (r, i) =>
                `<li><button class="link" data-result="${String(i)}">${escapeHtml(r.name)}</button> <span class="muted">${escapeHtml(formatCoordinates(r.position, 4))}</span></li>`,
            )
            .join(''),
        );
        ui('results')
          .querySelectorAll<HTMLButtonElement>('[data-result]')
          .forEach((b) => {
            b.addEventListener('click', () => {
              const r = results[Number(b.dataset['result'])];
              if (!r) return;
              input('bf-lat').value = r.position.lat.toFixed(6);
              input('bf-lon').value = r.position.lon.toFixed(6);
              show('results', null);
              setLocation(r.position, r.name.split(',').slice(0, 3).join(',').trim());
            });
          });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        show(
          'results',
          `<li class="warn">${escapeHtml(error instanceof ServiceError ? error.message : `${NOMINATIM} failed.`)} You can still enter coordinates.</li>`,
        );
      })
      .finally(() => {
        if (!disposed) button.disabled = false;
      });
  });

  // --- Generation ----------------------------------------------------------

  const renderSteps = (current: GenerationStep | null, failed = false) => {
    // The tree cover step only when it is on.
    const steps = STEPS.filter(([s]) => s !== 'trees' || treeCover === 'canopy');
    const index = steps.findIndex(([s]) => s === current);
    show(
      'steps',
      steps
        .map(([step, label], i) => {
          const state =
            i < index ? 'done' : i === index ? (failed ? 'failed' : 'active') : 'waiting';
          return `<li data-state="${state}" data-step="${step}">${escapeHtml(label)}</li>`;
        })
        .join(''),
    );
  };
  let lastStep: GenerationStep | null = null;

  // Tree cover from canopy heights (docs/adr/0050): remembered in the service settings.
  let treeCover = o.config.treeCover;
  const treeCoverBox = ui('tree-cover') as HTMLInputElement;
  treeCoverBox.checked = treeCover === 'canopy';
  treeCoverBox.addEventListener('change', () => {
    treeCover = treeCoverBox.checked ? 'canopy' : 'off';
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      // Unavailable: the choice lasts for this page.
    }
    storeServiceSetting(storage, 'treeCover', treeCover);
  });

  const generate = (allowMissingOsm: boolean) => {
    if (selection.kind !== 'location' || generating) return;
    const controller = new AbortController();
    generating = controller;
    updatePrimary();
    ui('progress').hidden = false;
    ui('cancel').hidden = false;
    show('error', null);
    lastStep = 'elevation';
    renderSteps('elevation');
    const request = battlefieldRequest(
      selection.position,
      selection.name !== null ? { name: selection.name } : {},
    );
    generateBattlefield(request, {
      config: { ...o.config, treeCover },
      store: o.store,
      fetch: (u, i) => window.fetch(u, i),
      decodePng: decodePngInBrowser,
      signal: controller.signal,
      allowMissingOsm,
      onProgress: (p) => {
        if (disposed) return;
        lastStep = p.step;
        renderSteps(p.step);
        show('message', escapeHtml(p.message));
      },
    })
      .then(async (pkg) => {
        if (disposed) return;
        // Stay here: the new battlefield is selected and previewed, so the
        // trainee can check the terrain before choosing Open battlefield.
        // Generate stays blocked until it is selected.
        show('message', null);
        ui('progress').hidden = true;
        ui('cancel').hidden = true;
        notify(`${pkg.name} is ready. Check it on the map, then choose Open battlefield.`);
        await refresh(pkg.id);
        generating = null;
        if (live()) updatePrimary();
      })
      .catch((error: unknown) => {
        generating = null;
        if (disposed) return;
        ui('cancel').hidden = true;
        updatePrimary();
        show('message', null);
        if (isCancelled(error)) {
          ui('progress').hidden = true;
          show('error', '<p class="muted">Generation cancelled. Nothing was saved.</p>');
          return;
        }
        renderSteps(lastStep, true);
        const message = error instanceof Error ? error.message : String(error);
        const osm = error instanceof OsmUnavailableError;
        show(
          'error',
          `<p>${escapeHtml(message)}</p>
           <p class="muted">${osm ? 'The OpenStreetMap service may be busy. Try again in a minute, or continue without OpenStreetMap: no roads, vegetation or water, and buildings only if Overture Maps can be reached.' : error instanceof ServiceError ? 'The service may be busy or unreachable. Check your connection and try again.' : ''}</p>
           <div class="bf-row"><button data-action="retry">Try again</button>${osm ? '<button data-action="terrain-only">Continue without OpenStreetMap</button>' : ''}</div>`,
        );
      });
  };
  ui('cancel').addEventListener('click', () => {
    generating?.abort();
  });
  ui('error').addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset[
      'action'
    ];
    if (action === 'retry') generate(false);
    if (action === 'terrain-only') generate(true);
  });

  // --- Opening and deleting ------------------------------------------------

  /** Opens the selected saved battlefield (stage 2), on the preview's map. */
  const openSelection = () => {
    if (opening || selection.kind !== 'saved') return;
    opening = true;
    o.openBattlefield(selection.summary.id, preview.release());
  };

  // Each saved battlefield's bin. Two clicks: the first arms it (red), the
  // second deletes; an armed bin disarms itself after a few seconds.
  let armed: { button: HTMLButtonElement; timer: ReturnType<typeof setTimeout> } | null = null;
  const disarm = () => {
    if (!armed) return;
    clearTimeout(armed.timer);
    delete armed.button.dataset['confirm'];
    armed.button.title = armed.button.getAttribute('aria-label') ?? '';
    armed = null;
  };
  ui('saved').addEventListener('click', (event) => {
    const bin = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-delete]');
    const summary = saved.find((b) => b.id === bin?.dataset['delete']);
    if (!bin || !summary) return;
    if (armed?.button !== bin) {
      disarm();
      bin.dataset['confirm'] = 'yes';
      const ask = `Click the bin again to delete ${summary.name} and its scenario.`;
      bin.title = ask;
      notify(ask);
      armed = { button: bin, timer: setTimeout(disarm, 4000) };
      return;
    }
    disarm();
    bin.disabled = true;
    const wasSelected = selection.kind === 'saved' && selection.summary.id === summary.id;
    void o.store.delete(summary.id).then(() => {
      if (disposed) return;
      notify(`Deleted ${summary.name}.`);
      if (wasSelected) select({ kind: 'none' });
      void refresh(selection.kind === 'saved' ? selection.summary.id : undefined);
    });
  });

  ui('primary').addEventListener('click', () => {
    if (selection.kind === 'location') generate(false);
    else if (selection.kind === 'none') notify(ui('primary-reason').textContent);
    else openSelection();
  });

  // Saved battlefields: a click selects, a double click opens.
  const renderSaved = (list: readonly BattlefieldSummary[]) => {
    saved = list;
    if (list.length === 0) {
      show('saved', '<li class="muted">None yet. Generated battlefields appear here.</li>');
      return;
    }
    show(
      'saved',
      list
        .map(
          (
            b,
          ) => `<li class="bf-saved-row"><button class="bf-item" data-select="${escapeHtml(b.id)}" aria-pressed="false" title="${escapeHtml(b.name)}">
            <b>${escapeHtml(b.name)}</b>
            <span class="muted">${escapeHtml(formatCoordinates(b.centre, 4))} · ${escapeHtml(new Date(b.createdAt).toLocaleDateString())}</span>
          </button><button class="trash-btn" data-delete="${escapeHtml(b.id)}" aria-label="Delete ${escapeHtml(b.name)}" title="Delete ${escapeHtml(b.name)}">${TRASH_ICON}</button></li>`,
        )
        .join(''),
    );
    markSelected();
  };
  const refresh = (preselect?: string): Promise<void> =>
    o.store
      .list()
      .then((list) => {
        if (disposed) return;
        renderSaved(list);
        const summary = list.find((b) => b.id === preselect);
        if (summary) select({ kind: 'saved', summary });
        // A handed-back map whose battlefield is no longer saved.
        else if (adopting !== null) select({ kind: 'none' });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        show(
          'saved',
          `<li class="warn">Saved battlefields could not be read: ${escapeHtml(error instanceof Error ? error.message : String(error))}</li>`,
        );
      });
  const choose = (id: string | undefined) => {
    const summary = saved.find((b) => b.id === id);
    if (summary) select({ kind: 'saved', summary });
  };
  app.querySelector('.side')?.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-select]');
    if (item) choose(item.dataset['select']);
  });
  app.querySelector('.side')?.addEventListener('dblclick', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-select]');
    if (!item) return;
    choose(item.dataset['select']);
    openSelection();
  });

  if (o.adopt) {
    // Back from the battlefield's workspace: its map stays as it was, and the
    // battlefield is selected once the saved list is read.
    preview.adopt(o.adopt.id, o.adopt.map, o.adopt.data);
    show('preview', previewHtml());
    updatePrimary();
    ui('placeholder').hidden = true;
    header.update('terrain', facts);
  } else select({ kind: 'none' });
  void refresh(o.adopt?.id ?? o.selected);

  return {
    dispose() {
      disposed = true;
      generating?.abort();
      preview.hide();
    },
  };
}
