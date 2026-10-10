import {
  decodePngInBrowser,
  generateBattlefield,
  isCancelled,
  NOMINATIM,
  OsmUnavailableError,
  searchPlaces,
  ServiceError,
  type BattlefieldStore,
  type BattlefieldSummary,
  type GenerationStep,
  type PlaceResult,
  type ServiceConfig,
} from '#acquire';
import type { Vec2 } from '#sim';
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
import { createToast, escapeHtml, headerHtml, wireHeader } from './shell';
import { DEMO_ID } from './stages';
import type { WorkflowFacts } from './workflow';

// Stage 1, terrain selection (docs/adr/0014, docs/adr/0025): find a place or
// enter a position and generate a new 5 km battlefield, or select the demo or
// a saved battlefield and open it. The left panel chooses; the main area
// describes the choice and holds its one primary action.

export interface SelectionOptions {
  readonly config: ServiceConfig;
  readonly configProblems: readonly string[];
  readonly store: BattlefieldStore;
  /** Whether saved battlefields survive a reload (IndexedDB available). */
  readonly persistent: boolean;
  /** The demo or a saved battlefield's id to select on arrival (e.g. coming back from stage 2). */
  readonly selected?: string;
  readonly openDemo: () => void;
  /** Opens a battlefield; throws when no scenario can be made on it. */
  readonly openBattlefield: (pkg: BattlefieldPackage) => void;
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

/** A battlefield's description (sources, accuracy, credits) for Battlefield Information. */
export function battlefieldInfoHtml(pkg: BattlefieldPackage): string {
  const e = pkg.elevation;
  const datasets = e.datasets.filter((d) => d.resolutionM < 200).map((d) => d.name);
  const resolution =
    e.finestResolutionM === null
      ? 'unknown resolution'
      : e.coarsestResolutionM !== null && e.coarsestResolutionM !== e.finestResolutionM
        ? `about ${String(e.finestResolutionM)}–${String(e.coarsestResolutionM)} m source data`
        : `about ${String(e.finestResolutionM)} m source data`;
  const c = pkg.processing.counts;
  return `
    <dl class="kv">
      <dt>Location</dt><dd>${escapeHtml(formatCoordinates(pkg.request.centre))}</dd>
      <dt>Size</dt><dd>${pkg.request.widthM.toLocaleString('en')} × ${pkg.request.heightM.toLocaleString('en')} m</dd>
      <dt>Coordinates</dt><dd>UTM ${String(pkg.frame.zone)}${pkg.frame.hemisphere} (EPSG:${String(pkg.frame.epsg)})</dd>
      <dt>Elevation</dt><dd>${String(pkg.request.cellSizeM)} m grid from ${escapeHtml(datasets.join(', ') || 'unrecognised sources')} (${resolution}; ${escapeHtml(SURFACE_LABEL[e.surfaceModel] ?? e.surfaceModel)}). ${String(Math.round(e.minM))}–${String(Math.round(e.maxM))} m.</dd>
      <dt>Buildings</dt><dd>${buildingsLine(pkg)}</dd>
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
  ['processing', 'Building the battlefield'],
  ['saving', 'Saving'],
];

/** What is selected: the demo, a saved battlefield, or a new location to generate. */
type Selection =
  | { readonly kind: 'none' }
  | { readonly kind: 'demo' }
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

export function startBattlefieldSelection(app: HTMLElement, o: SelectionOptions): void {
  app.className = 'select';
  app.innerHTML = `
    ${headerHtml('')}
    <div class="sel">
      <aside class="sel-panel" aria-label="Choose a battlefield">
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
            <button type="submit">Use position</button>
          </form>
          <p><button class="link" data-ui="here">Use my current position</button></p>
          <p class="hint" data-ui="position-message" hidden></p>
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
          <h2>Demo</h2>
          <ul class="bf-saved"><li><button class="bf-item" data-select="${DEMO_ID}" aria-pressed="false">
            <b>Demo battlefield</b><span class="muted">800 × 600 m of synthetic terrain</span>
          </button></li></ul>
        </section>
        <footer class="sel-credits muted">
          Map data © OpenStreetMap contributors (ODbL). Buildings: Overture Maps Foundation (ODbL).
          Elevation: AWS Terrain Tiles (USGS, SRTM, Copernicus EU-DEM and national sources; credits
          are listed with each battlefield). Place search: Nominatim.
          ${o.configProblems.length > 0 ? `<br><span class="warn">Service settings ignored: ${escapeHtml(o.configProblems.join('; '))}</span>` : ''}
        </footer>
      </aside>
      <main class="sel-main">
        <div class="sel-card" data-ui="preview"></div>
        <div class="sel-card" data-ui="progress" hidden>
          <ol class="bf-steps" data-ui="steps"></ol>
          <div class="hint" data-ui="message" hidden></div>
          <div class="bf-row"><button data-ui="cancel">Cancel</button></div>
        </div>
        <div class="sel-card bf-error" data-ui="error" role="alert" hidden></div>
        <div class="toast" data-ui="toast" role="status" hidden></div>
      </main>
    </div>`;

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

  let selection: Selection = { kind: 'none' };
  let saved: readonly BattlefieldSummary[] = [];
  let generating: AbortController | null = null;
  let opening = false;

  const facts: WorkflowFacts = {
    battlefieldSelected: () => selection.kind === 'demo' || selection.kind === 'saved',
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

  const previewHtml = (): string => {
    switch (selection.kind) {
      case 'none':
        return `<h2>Choose a battlefield</h2>
          <p class="muted">Search for a place or enter a position to generate a new
          ${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} × ${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} m battlefield
          anywhere from 80° S to 84° N, from OpenStreetMap, Overture Maps buildings and freely
          available elevation data. Or select a saved battlefield or the demo.</p>`;
      case 'demo':
        return `<h2>Demo battlefield</h2>
          <p>800 × 600 m of synthetic terrain: a valley road through a hamlet, woods, a ridge, and
          an OPFOR patrol to ambush. Its scenario is fixed.</p>
          <div class="bf-row"><button class="primary-btn" data-action="open">Open demo battlefield →</button></div>`;
      case 'saved': {
        const b = selection.summary;
        return `<h2>${escapeHtml(b.name)}</h2>
          <dl class="kv">
            <dt>Location</dt><dd>${escapeHtml(formatCoordinates(b.centre, 4))}</dd>
            <dt>Size</dt><dd>${summaryLine(b)}</dd>
            <dt>Elevation</dt><dd>${b.elevationResolutionM === null ? 'resolution unknown' : `~${String(b.elevationResolutionM)} m source data`}</dd>
            <dt>Generated</dt><dd>${escapeHtml(new Date(b.createdAt).toLocaleString())}</dd>
          </dl>
          <div class="bf-row"><button class="primary-btn" data-action="open">Open battlefield →</button>
          <button class="small" data-action="delete" data-id="${escapeHtml(b.id)}">Delete…</button></div>`;
      }
      case 'location': {
        const { position, name } = selection;
        const frame = createFrame(position, DEFAULT_BATTLEFIELD_SIZE_M);
        const lat = position.lat.toFixed(5);
        const lon = position.lon.toFixed(5);
        return `<h2>${escapeHtml(name ?? 'New battlefield')}</h2>
          <dl class="kv">
            <dt>Centre</dt><dd>${escapeHtml(formatCoordinates(position))}</dd>
            <dt>Size</dt><dd>${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} × ${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} m · UTM ${String(frame.zone)}${frame.hemisphere}</dd>
            <dt>Elevation</dt><dd>${String(DEFAULT_CELL_SIZE_M)} m grid</dd>
          </dl>
          <p class="muted">Your squad starts on open ground near the centre; there is no OPFOR yet.
          <a href="https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lon}#map=16/${lat}/${lon}" target="_blank" rel="noopener">View on OpenStreetMap</a></p>
          <div class="bf-row"><button class="primary-btn" data-action="generate" ${generating ? 'disabled' : ''}>Generate battlefield</button></div>`;
      }
    }
  };

  const markSelected = () => {
    const id =
      selection.kind === 'demo'
        ? DEMO_ID
        : selection.kind === 'saved'
          ? selection.summary.id
          : null;
    for (const b of app.querySelectorAll<HTMLElement>('[data-select]'))
      b.setAttribute('aria-pressed', String(b.dataset['select'] === id));
  };

  const select = (next: Selection) => {
    selection = next;
    show('preview', previewHtml());
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
        input('bf-lat').value = p.coords.latitude.toFixed(6);
        input('bf-lon').value = p.coords.longitude.toFixed(6);
        setLocation({ lat: p.coords.latitude, lon: p.coords.longitude }, 'Current position');
      },
      (error) => {
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
        if (results.length === 0) {
          show('results', '<li class="muted">No places found.</li>');
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
        show(
          'results',
          `<li class="warn">${escapeHtml(error instanceof ServiceError ? error.message : `${NOMINATIM} failed.`)} You can still enter coordinates.</li>`,
        );
      })
      .finally(() => {
        button.disabled = false;
      });
  });

  // --- Generation ----------------------------------------------------------

  const renderSteps = (current: GenerationStep | null, failed = false) => {
    const index = STEPS.findIndex(([s]) => s === current);
    show(
      'steps',
      STEPS.map(([step, label], i) => {
        const state = i < index ? 'done' : i === index ? (failed ? 'failed' : 'active') : 'waiting';
        return `<li data-state="${state}" data-step="${step}">${escapeHtml(label)}</li>`;
      }).join(''),
    );
  };
  let lastStep: GenerationStep | null = null;

  const generate = (allowMissingOsm: boolean) => {
    if (selection.kind !== 'location' || generating) return;
    const controller = new AbortController();
    generating = controller;
    show('preview', previewHtml());
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
      config: o.config,
      store: o.store,
      fetch: (u, i) => window.fetch(u, i),
      decodePng: decodePngInBrowser,
      signal: controller.signal,
      allowMissingOsm,
      onProgress: (p) => {
        lastStep = p.step;
        renderSteps(p.step);
        show('message', escapeHtml(p.message));
      },
    })
      .then((pkg) => {
        generating = null;
        show('message', null);
        open(pkg);
      })
      .catch((error: unknown) => {
        generating = null;
        ui('cancel').hidden = true;
        show('preview', previewHtml());
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

  const open = (pkg: BattlefieldPackage) => {
    try {
      o.openBattlefield(pkg);
    } catch (error) {
      opening = false;
      show('error', `<p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`);
    }
  };
  /** Opens the demo or the selected saved battlefield (stage 2). */
  const openSelection = () => {
    if (opening) return;
    if (selection.kind === 'demo') {
      opening = true;
      o.openDemo();
      return;
    }
    if (selection.kind !== 'saved') return;
    const id = selection.summary.id;
    opening = true;
    o.store
      .get(id)
      .then(open)
      .catch((error: unknown) => {
        opening = false;
        show(
          'error',
          `<p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p><p class="muted">You can delete it and generate it again.</p>`,
        );
      });
  };

  ui('preview').addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    const action = target?.dataset['action'];
    if (action === 'open') openSelection();
    if (action === 'generate') generate(false);
    if (action === 'delete' && target && selection.kind === 'saved') {
      // Two clicks: the first asks for confirmation.
      if (target.dataset['confirm'] !== 'yes') {
        target.dataset['confirm'] = 'yes';
        target.textContent = `Confirm: delete ${selection.summary.name} and its scenario`;
        target.classList.add('danger');
        return;
      }
      const id = selection.summary.id;
      target.disabled = true;
      void o.store.delete(id).then(() => {
        select({ kind: 'none' });
        refresh();
      });
    }
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
          ) => `<li><button class="bf-item" data-select="${escapeHtml(b.id)}" aria-pressed="false">
            <b>${escapeHtml(b.name)}</b>
            <span class="muted">${escapeHtml(formatCoordinates(b.centre, 4))} · ${escapeHtml(new Date(b.createdAt).toLocaleDateString())}</span>
          </button></li>`,
        )
        .join(''),
    );
    markSelected();
  };
  const refresh = (preselect?: string) => {
    o.store
      .list()
      .then((list) => {
        renderSaved(list);
        const summary = list.find((b) => b.id === preselect);
        if (summary) select({ kind: 'saved', summary });
      })
      .catch((error: unknown) => {
        show(
          'saved',
          `<li class="warn">Saved battlefields could not be read: ${escapeHtml(error instanceof Error ? error.message : String(error))}</li>`,
        );
      });
  };
  const choose = (id: string | undefined) => {
    if (id === DEMO_ID) select({ kind: 'demo' });
    else {
      const summary = saved.find((b) => b.id === id);
      if (summary) select({ kind: 'saved', summary });
    }
  };
  app.querySelector('.sel-panel')?.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-select]');
    if (item) choose(item.dataset['select']);
  });
  app.querySelector('.sel-panel')?.addEventListener('dblclick', (event) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>('[data-select]');
    if (!item) return;
    choose(item.dataset['select']);
    openSelection();
  });

  select(o.selected === DEMO_ID ? { kind: 'demo' } : { kind: 'none' });
  refresh(o.selected);
}
