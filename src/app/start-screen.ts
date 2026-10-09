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
import type { AmbushScenario } from '#exercise';
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
import type { ExerciseUiOptions } from './exercise-ui';

// The battlefield selection screen (docs/adr/0014): open the demo, generate a
// new 1 km battlefield from a position or a place name, or open a saved one.

export interface SelectionOptions {
  readonly config: ServiceConfig;
  readonly configProblems: readonly string[];
  readonly store: BattlefieldStore;
  /** Whether saved battlefields survive a reload (IndexedDB available). */
  readonly persistent: boolean;
  readonly openDemo: () => void;
  /** Opens a battlefield; throws when no scenario can be made on it. */
  readonly openBattlefield: (pkg: BattlefieldPackage) => void;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`);

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

/** The exercise screen's options for a battlefield and its scenario: credits, readout and description. */
export function battlefieldExercise(
  pkg: BattlefieldPackage,
  scenario: AmbushScenario,
): Omit<ExerciseUiOptions, 'onLeave'> {
  const e = pkg.elevation;
  const datasets = e.datasets.filter((d) => d.resolutionM < 200).map((d) => d.name);
  const resolution =
    e.finestResolutionM === null
      ? 'unknown resolution'
      : e.coarsestResolutionM !== null && e.coarsestResolutionM !== e.finestResolutionM
        ? `about ${String(e.finestResolutionM)}–${String(e.coarsestResolutionM)} m source data`
        : `about ${String(e.finestResolutionM)} m source data`;
  const c = pkg.processing.counts;
  const info = `
    <h2>Battlefield</h2>
    <dl class="status">
      <dt>Location</dt><dd>${escapeHtml(formatCoordinates(pkg.request.centre))}</dd>
      <dt>Size</dt><dd>${pkg.request.widthM.toLocaleString('en')} × ${pkg.request.heightM.toLocaleString('en')} m · UTM ${String(pkg.frame.zone)}${pkg.frame.hemisphere} (EPSG:${String(pkg.frame.epsg)})</dd>
      <dt>Elevation</dt><dd>${String(pkg.request.cellSizeM)} m grid from ${escapeHtml(datasets.join(', ') || 'unrecognised sources')} (${resolution}; ${escapeHtml(SURFACE_LABEL[e.surfaceModel] ?? e.surfaceModel)}). ${String(Math.round(e.minM))}–${String(Math.round(e.maxM))} m.</dd>
      <dt>Map data</dt><dd>${
        pkg.osm.available
          ? `OpenStreetMap as of ${escapeHtml(pkg.osm.timestampOsmBase ?? 'unknown')}: ${String(c.roads)} roads and paths, ${String(c.buildings)} buildings, ${String(c.vegetation)} vegetation, ${String(c.water)} water, ${String(c.waterways)} waterways, ${String(c.landUse)} land use`
          : 'none (terrain only)'
      }</dd>
      <dt>Generated</dt><dd>${escapeHtml(new Date(pkg.createdAt).toLocaleString())} · importer ${escapeHtml(pkg.processing.importerVersion)}</dd>
    </dl>
    ${
      pkg.processing.warnings.length > 0
        ? `<ul class="bf-warnings">${pkg.processing.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
        : ''
    }
    <p class="muted">The ${String(pkg.request.cellSizeM)} m grid is resampled from the source; it adds no detail the source does not have. Ditches, banks and walls narrower than the source resolution are not in the terrain.</p>
    <details class="bf-credits"><summary>Sources and credits</summary><ul>${pkg.attribution
      .map((a) => `<li>${escapeHtml(a)}</li>`)
      .join('')}</ul></details>`;
  return {
    scenario,
    title: pkg.name,
    attribution: pkg.attribution,
    describePoint: describePointFor(pkg),
    infoHtml: info,
  };
}

const STEPS: readonly [GenerationStep, string][] = [
  ['elevation', 'Elevation tiles'],
  ['osm', 'Map features (OpenStreetMap)'],
  ['processing', 'Building the battlefield'],
  ['saving', 'Saving'],
];

export function startBattlefieldSelection(app: HTMLElement, o: SelectionOptions): void {
  app.classList.add('start');
  app.innerHTML = `
    <div class="start-screen">
      <header class="start-header">
        <h1>AMBUSH!</h1>
        <span class="muted">Choose a battlefield</span>
      </header>
      <div class="start-cards">
        <section class="start-card">
          <h2>Demo battlefield</h2>
          <p>800 × 600 m of synthetic terrain: a valley road through a hamlet, woods, a ridge, and an
          OPFOR patrol to ambush. The full exercise, from planning to the ambush.</p>
          <button class="primary" data-action="demo">Open the demo</button>
        </section>

        <section class="start-card">
          <h2>New battlefield</h2>
          <p class="muted">A ${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} × ${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} m area anywhere from 80° S to 84° N, generated
          from OpenStreetMap and freely available elevation data. Your squad starts on open ground
          near the centre; there is no OPFOR yet.</p>
          <form class="bf-row" data-ui="coords-form">
            <label>Latitude <input id="bf-lat" inputmode="decimal" placeholder="38.5223" autocomplete="off"></label>
            <label>Longitude <input id="bf-lon" inputmode="decimal" placeholder="-77.2934" autocomplete="off"></label>
            <button type="submit">Use position</button>
          </form>
          <form class="bf-row" data-ui="search-form">
            <label class="grow">or a place <input id="bf-search" placeholder="e.g. Quantico, Virginia" autocomplete="off"></label>
            <button type="submit" data-ui="search-button">Search</button>
          </form>
          <ul class="bf-results" data-ui="results" hidden></ul>
          <div class="bf-location" data-ui="location">No location chosen yet.</div>
          <div class="bf-row">
            <button class="primary" data-ui="generate" disabled>Generate battlefield</button>
            <button data-ui="cancel" hidden>Cancel</button>
          </div>
          <ol class="bf-steps" data-ui="steps" hidden></ol>
          <div class="bf-message" data-ui="message" hidden></div>
          <div class="bf-error" data-ui="error" hidden></div>
        </section>

        <section class="start-card">
          <h2>Saved battlefields</h2>
          <ul class="bf-saved" data-ui="saved"><li class="muted">Loading…</li></ul>
          ${
            o.persistent
              ? '<p class="muted">Saved in this browser: they open without a network connection.</p>'
              : '<p class="bf-warn">This browser cannot store battlefields (storage is unavailable): generated battlefields are lost when the page is closed.</p>'
          }
        </section>
      </div>
      <footer class="start-footer muted">
        Map data © OpenStreetMap contributors (ODbL). Elevation: AWS Terrain Tiles (USGS, SRTM,
        Copernicus EU-DEM and national sources; credits are listed with each battlefield). Place
        search: Nominatim.
        ${o.configProblems.length > 0 ? `<br><span class="bf-warn">Service settings ignored: ${escapeHtml(o.configProblems.join('; '))}</span>` : ''}
      </footer>
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

  let location: { position: LatLon; name: string | null } | null = null;
  let generating: AbortController | null = null;

  const setLocation = (position: LatLon, name: string | null) => {
    try {
      validateLatLon(position);
    } catch (error) {
      location = null;
      (ui('generate') as HTMLButtonElement).disabled = true;
      show('location', null);
      ui('location').hidden = false;
      ui('location').innerHTML =
        `<span class="bf-warn">${escapeHtml(error instanceof Error ? error.message : String(error))}.</span>`;
      return;
    }
    location = { position, name };
    const frame = createFrame(position, DEFAULT_BATTLEFIELD_SIZE_M);
    const lat = position.lat.toFixed(5);
    const lon = position.lon.toFixed(5);
    ui('location').innerHTML = `
      <div><b>${escapeHtml(name ?? formatCoordinates(position))}</b></div>
      <div class="muted">${escapeHtml(formatCoordinates(position))} · UTM ${String(frame.zone)}${frame.hemisphere} ·
      ${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} × ${DEFAULT_BATTLEFIELD_SIZE_M.toLocaleString('en')} m · ${String(DEFAULT_CELL_SIZE_M)} m elevation grid ·
      <a href="https://www.openstreetmap.org/?mlat=${lat}&amp;mlon=${lon}#map=16/${lat}/${lon}" target="_blank" rel="noopener">view on OpenStreetMap</a></div>`;
    (ui('generate') as HTMLButtonElement).disabled = generating !== null;
  };

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
      ui('location').innerHTML =
        '<span class="bf-warn">Enter latitude and longitude in decimal degrees, e.g. 38.5223 and -77.2934.</span>';
      return;
    }
    show('results', null);
    setLocation({ lat, lon }, null);
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
          `<li class="bf-warn">${escapeHtml(error instanceof ServiceError ? error.message : `${NOMINATIM} failed.`)} You can still enter coordinates.</li>`,
        );
      })
      .finally(() => {
        button.disabled = false;
      });
  });

  // Generation.
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
    if (!location || generating) return;
    const controller = new AbortController();
    generating = controller;
    (ui('generate') as HTMLButtonElement).disabled = true;
    ui('cancel').hidden = false;
    show('error', null);
    lastStep = 'elevation';
    renderSteps('elevation');
    const request = battlefieldRequest(
      location.position,
      location.name !== null ? { name: location.name } : {},
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
        (ui('generate') as HTMLButtonElement).disabled = location === null;
        show('message', null);
        if (isCancelled(error)) {
          renderSteps(null);
          show('steps', null);
          show('error', '<span class="muted">Generation cancelled. Nothing was saved.</span>');
          return;
        }
        renderSteps(lastStep, true);
        const message = error instanceof Error ? error.message : String(error);
        const osm = error instanceof OsmUnavailableError;
        show(
          'error',
          `<p>${escapeHtml(message)}</p>
           <p class="muted">${osm ? 'The OpenStreetMap service may be busy. Try again in a minute, or continue with terrain only (no roads, buildings, vegetation or water).' : error instanceof ServiceError ? 'The service may be busy or unreachable. Check your connection and try again.' : ''}</p>
           <div class="bf-row"><button data-action="retry">Try again</button>${osm ? '<button data-action="terrain-only">Continue with terrain only</button>' : ''}</div>`,
        );
      });
  };
  ui('generate').addEventListener('click', () => {
    generate(false);
  });
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

  // Opening.
  const open = (pkg: BattlefieldPackage) => {
    try {
      o.openBattlefield(pkg);
    } catch (error) {
      show('error', `<p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`);
    }
  };
  app.querySelector('[data-action="demo"]')?.addEventListener('click', () => {
    o.openDemo();
  });

  // Saved battlefields.
  const renderSaved = (list: readonly BattlefieldSummary[]) => {
    if (list.length === 0) {
      show('saved', '<li class="muted">None yet. Generated battlefields appear here.</li>');
      return;
    }
    show(
      'saved',
      list
        .map((b) => {
          const c = b.counts;
          return `<li class="bf-saved-item">
            <div class="grow"><b>${escapeHtml(b.name)}</b>
              <div class="muted">${escapeHtml(formatCoordinates(b.centre, 4))} · ${b.widthM.toLocaleString('en')} × ${b.heightM.toLocaleString('en')} m ·
              ${b.elevationResolutionM === null ? 'elevation resolution unknown' : `~${String(b.elevationResolutionM)} m elevation`} ·
              ${b.osmAvailable ? `${String(c.buildings)} buildings, ${String(c.roads)} roads` : 'terrain only'} ·
              ${escapeHtml(new Date(b.createdAt).toLocaleDateString())}</div>
            </div>
            <button class="primary" data-open="${escapeHtml(b.id)}">Open</button>
            <button data-delete="${escapeHtml(b.id)}">Delete</button>
          </li>`;
        })
        .join(''),
    );
  };
  const refresh = () => {
    o.store
      .list()
      .then(renderSaved)
      .catch((error: unknown) => {
        show(
          'saved',
          `<li class="bf-warn">Saved battlefields could not be read: ${escapeHtml(error instanceof Error ? error.message : String(error))}</li>`,
        );
      });
  };
  ui('saved').addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!target) return;
    const openId = target.dataset['open'];
    const deleteId = target.dataset['delete'];
    if (openId !== undefined) {
      target.disabled = true;
      o.store
        .get(openId)
        .then(open)
        .catch((error: unknown) => {
          target.disabled = false;
          const item = target.closest('li');
          item?.insertAdjacentHTML(
            'beforeend',
            `<div class="bf-warn bf-full">${escapeHtml(error instanceof Error ? error.message : String(error))} You can delete it and generate it again.</div>`,
          );
        });
    } else if (deleteId !== undefined) {
      // Two clicks: the first asks for confirmation.
      if (target.dataset['confirm'] !== 'yes') {
        target.dataset['confirm'] = 'yes';
        target.textContent = 'Confirm delete';
        target.classList.add('danger');
        return;
      }
      void o.store.delete(deleteId).then(refresh);
    }
  });
  refresh();
}
