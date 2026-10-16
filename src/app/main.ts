import { authoritativeTerrain } from './terrain-grading';
import { busy, whileBusy, type BusyTask } from './busy';
import { localSeedMemory, seedBundledBattlefields } from './bundled-battlefields';
import {
  createMemoryStore,
  decodePngInBrowser,
  generateBattlefield,
  loadServiceConfig,
  openIndexedDbStore,
  type BattlefieldStore,
} from '#acquire';
import {
  battleScenarioId,
  newBattleScenario,
  scenarioIssues,
  parseBattleScenario,
  scenarioSummary,
  type BattleScenarioDefinition,
} from '#exercise/battle';
import type { BattlefieldPackage } from '#geo';
import { demQualitySummary, shareTerrain, terrainModelId, type DemQualityReport } from '#sim';
import type { TacticalMap } from '#view2d';
import type { HandedView, PreviewData } from './battlefield-preview';
import { installFeedbackButton } from './feedback';
import { battlefieldInfoHtml, describePointFor, startBattlefieldSelection } from './start-screen';
import { parseStage, stageHash, type Stage } from './stages';
import { battleNextBlocker } from './battle/planner';
import { startBattlePage, type PageScenario, type ScenarioMenu } from './battle/page';
import type { BattlefieldSelection } from './start-screen';
import { createScenarioLibrary } from './scenarios/library';
import { createScenarioManager, type LeaveDecision, type OpenScenario } from './scenarios/manager';
import type { TerrainSources } from './scenarios/terrain';
import {
  browserDialogs,
  downloadText,
  openLibraryDialog,
  pickScenarioFile,
  windowToast,
} from './scenarios/ui';

// Composition root: the five-stage workflow (docs/adr/0025). Terrain
// selection (stage 1, docs/adr/0014) is one page; stages 2–5 of a
// battlefield's battle (Scenario Setup, Planning, Combat and the
// After-Action Review, docs/constructive-simulation/03) share another
// (battle/page.ts). Each page has its own address
// (stages.ts). Moving between the two happens in place, without a reload:
// the page being left stops what it started, and the tactical map of the
// battlefield is handed over, so it is never rebuilt. The browser's Back and
// Forward reload at the address they reach.

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app element');

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function openStore(): Promise<{ store: BattlefieldStore; persistent: boolean }> {
  try {
    return { store: await openIndexedDbStore(), persistent: true };
  } catch {
    return { store: createMemoryStore(), persistent: false };
  }
}

/** Records an in-page stage change in the address without reloading, so a reload stays there. */
function setAddress(stage: Stage): void {
  window.history.replaceState(null, '', stageHash(stage) || window.location.pathname);
}

/** Records a move to the other page as a new history entry (Back returns to it). */
function pushAddress(stage: Stage): void {
  window.history.pushState(null, '', stageHash(stage) || window.location.pathname);
}

/** Goes to a stage: a new address and a fresh page. */
function go(stage: Stage): void {
  const hash = stageHash(stage);
  if (window.location.hash === hash || (hash === '' && window.location.hash === '')) {
    window.location.reload();
    return;
  }
  window.location.hash = hash;
  window.location.reload();
}

/**
 * The battlefield's battle scenario: the saved one; else its ambush scenario
 * migrated (docs/constructive-simulation/03); else a new one with no squads.
 * One that cannot be read is reported and replaced, never silently.
 */
async function loadBattle(
  store: BattlefieldStore,
  pkg: BattlefieldPackage,
): Promise<{ definition: BattleScenarioDefinition; notice: string | null }> {
  const saved = (await store.listScenarios(pkg.id)).filter(
    (d): d is Record<string, unknown> => typeof d === 'object' && d !== null,
  );
  const fresh = () => newBattleScenario(pkg.terrain, pkg.id);
  const notices: string[] = [];
  const v2 = saved.find((d) => d['schemaVersion'] === 2 && d['id'] === battleScenarioId(pkg.id));
  const v1 = saved.find((d) => d['schemaVersion'] === 1);
  let definition: BattleScenarioDefinition;
  try {
    if (v2) definition = parseBattleScenario(v2);
    else if (v1) {
      definition = parseBattleScenario(v1);
      if (definition.squads.length > 0)
        notices.push(
          `This battlefield's ambush scenario was converted to a battle: ${scenarioSummary(definition)}. The OPFOR patrol keeps its route as Move orders; BLUEFOR's squad stands at the ORP, with no plan yet.`,
        );
    } else definition = fresh();
  } catch (error) {
    definition = fresh();
    notices.push(
      `The saved scenario could not be read and was replaced by a new one: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const model = terrainModelId(pkg.terrain);
  if (definition.terrainModel !== undefined && definition.terrainModel !== model)
    notices.push(
      'This scenario was made on an earlier model of the ground: check that its squads and destinations are still where you want them.',
    );
  if (definition.terrainModel !== model) definition = { ...definition, terrainModel: model };
  return { definition, notice: notices.join(' ') || null };
}

/**
 * A saved battlefield with its authoritative terrain: the stored raw terrain
 * with its DEM cleaned (docs/adr/0033), then the terrain field sampled from it
 * (docs/adr/0049), then shared (`shareTerrain`): everything on the page (scenario edits,
 * previews, the exercise, the 2D and 3D views) then uses one frozen terrain,
 * so its navigation grid and other per-terrain data are built once. The
 * stored package keeps the source terrain.
 */
async function openBattlefield(
  store: BattlefieldStore,
  id: string,
  task?: BusyTask,
): Promise<OpenedBattlefield> {
  const start = performance.now();
  const pkg = await store.get(id);
  const { terrain, quality } = await authoritativeTerrain(
    pkg.id,
    pkg.terrain,
    pkg.elevation.cleaning ?? null,
    {
      get: (model) => store.getPrepared(id, model),
      put: (model, prepared) => store.putPrepared(id, model, prepared),
    },
    // Prepared now (not read back): the first opening on this browser.
    (fraction) =>
      task?.update(fraction, `Preparing the terrain of ${pkg.name} (first opening only)…`),
  );
  const opened = { ...pkg, terrain: shareTerrain(terrain), quality };
  // For the browser's performance tools: how long opening it took (prepared, or read back).
  performance.measure('battlefield: opened', { start, duration: performance.now() - start });
  return opened;
}

/** An opened battlefield: its package with the authoritative terrain, and that terrain's DEM quality report. */
type OpenedBattlefield = BattlefieldPackage & { readonly quality: DemQualityReport };

/** A warning when the DEM check left regions it could not repair (docs/adr/0033); null otherwise. */
function unresolvedNotice(quality: DemQualityReport): string | null {
  return quality.unresolvedRegions > 0 ? demQualitySummary(quality) : null;
}

/** What the terrain-selection preview shows of a battlefield and its battle scenario. */
function previewData(pkg: BattlefieldPackage, battle: BattleScenarioDefinition): PreviewData {
  // The terrain alone: no squads or markers (a scenario is set up, and shown, from Setup on).
  return {
    name: pkg.name,
    centre: pkg.request.centre,
    terrain: pkg.terrain,
    attribution: pkg.attribution,
    caption:
      battle.squads.length === 0
        ? 'Open the battlefield to set up a scenario, or load one'
        : `Current scenario: ${scenarioSummary(battle)}`,
  };
}

/** The browser's local storage, or `null` where it is unavailable (private modes, tests). */
function storageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function showFatal(root: HTMLElement, message: string): void {
  root.className = '';
  root.innerHTML = `<div class="fatal"><div class="sel-card"><h2>Something went wrong</h2>
    <p>${message.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`)}</p>
    <div class="bf-row"><button class="primary-btn" data-action="home">Back to terrain selection</button></div></div></div>`;
  root.querySelector('[data-action="home"]')?.addEventListener('click', () => {
    go({ kind: 'select' });
  });
}

async function main(root: HTMLElement): Promise<void> {
  const { config, problems } = loadServiceConfig(localStorageOrNull());
  const { store, persistent } = await openStore();
  // Back and Forward cross pages that were switched in place: load the one reached afresh.
  window.addEventListener('popstate', () => {
    window.location.reload();
  });

  // --- Saved scenarios (docs/scenarios.md) ---------------------------------
  const library = createScenarioLibrary(store);
  const terrainSources: TerrainSources = {
    config,
    openId: () => loaded?.pkg.id ?? null,
    isSaved: async (id) => {
      if (!(await store.list()).some((b) => b.id === id)) return false;
      // A damaged or incompatible battlefield is generated again rather than used.
      return store.get(id).then(
        () => true,
        () => false,
      );
    },
    generate: (request, settings, allowMissingOsm, onProgress, signal) =>
      generateBattlefield(request, {
        config: settings,
        store,
        fetch: (u, i) => window.fetch(u, i),
        decodePng: decodePngInBrowser,
        allowMissingOsm,
        onProgress,
        ...(signal ? { signal } : {}),
      }),
  };
  const scenarios = createScenarioManager({
    store,
    library,
    dialogs: browserDialogs(windowToast()),
    terrain: terrainSources,
    // A scenario loaded opens at Setup, whatever stage it was saved at.
    open: (battlefieldId, _stage, notice) =>
      showBattle(battlefieldId, 'scenario', null, selection, notice),
  });
  /** The terrain-selection page while it is shown (a scenario loaded from it replaces it). */
  let selection: BattlefieldSelection | null = null;

  /** The scenario library, from terrain selection (after `decision` about the scenario left, if any). */
  const openLibrary = (decision?: LeaveDecision) => {
    openLibraryDialog({
      list: async () => {
        const { entries, damaged } = await library.list();
        const savedBattlefields = new Set((await store.list()).map((b) => b.id));
        return { entries, damaged: damaged.length, savedBattlefields };
      },
      load: (id) => {
        void scenarios.load(id, decision);
      },
      import: () => {
        void importScenario(decision);
      },
      rename: async (id, name) => {
        await library.rename(id, name);
      },
      duplicate: async (id) => {
        await library.duplicate(id);
      },
      remove: async (id) => {
        await library.remove(id);
      },
    });
  };
  /** Import: a file chosen, read and checked, then loaded (`before`: just before loading). */
  const importScenario = async (decision?: LeaveDecision, before?: () => void) => {
    const file = await pickScenarioFile();
    if (!file) return;
    const doc = await scenarios.read(file.text);
    if (!doc) return;
    before?.();
    await scenarios.importDocument(doc, decision);
  };

  /**
   * The battlefield last loaded for the preview or left on its battle page,
   * with its battle scenario. Opening it again reuses it, so the preview's
   * map (built on its terrain) can be handed over as it is.
   */
  let loaded: { pkg: OpenedBattlefield; battle: BattleScenarioDefinition } | null = null;
  /** Preview loads started; only the latest may set `loaded` (it is the one the preview shows). */
  let previewLoads = 0;

  const showSelection = (o: {
    readonly selected?: string;
    readonly adopt?: { readonly id: string; readonly map: TacticalMap; readonly data: PreviewData };
  }) => {
    const page = startBattlefieldSelection(root, {
      config,
      configProblems: problems,
      store,
      persistent,
      ...o,
      scenarios: {
        load: () => {
          openLibrary();
        },
        import: () => {
          void importScenario();
        },
      },
      loadPreview: async (id) => {
        lastBattlefield.set(id);
        const mine = (previewLoads += 1);
        const { pkg, definition } = await whileBusy('Opening the battlefield…', async (task) => {
          const opened = await openBattlefield(store, id, task);
          return { pkg: opened, definition: (await loadBattle(store, opened)).definition };
        });
        if (mine === previewLoads) loaded = { pkg, battle: definition };
        return previewData(pkg, definition);
      },
      openBattlefield: (id, map, view) => {
        void showBattle(id, 'scenario', map, page, null, view);
      },
    });
    selection = page;
  };

  /** Back to terrain selection from a battlefield's page, the map handed back to the preview. */
  const backToSelection = (
    pkg: OpenedBattlefield,
    battle: BattleScenarioDefinition,
    map: TacticalMap,
  ) => {
    pushAddress({ kind: 'select', selected: pkg.id });
    loaded = { pkg, battle };
    showSelection({ adopt: { id: pkg.id, map, data: previewData(pkg, battle) } });
  };

  /** Stages 2–5 of a battlefield's battle, replacing `previous` (terrain selection) once ready. */
  const showBattle = async (
    id: string,
    stage: 'scenario' | 'bluefor',
    handed: TacticalMap | null,
    previous: { dispose(): void } | null,
    loadNotice: string | null = null,
    view: HandedView | null = null,
  ): Promise<void> => {
    let map = handed;
    let shown = view;
    // Input is held until the battlefield's page is up (or it failed).
    const task = busy('Opening the battlefield…');
    try {
      let pkg: OpenedBattlefield;
      if (loaded?.pkg.id === id) pkg = loaded.pkg;
      else {
        pkg = await openBattlefield(store, id, task);
        // A map (or 3D view) of another load of this battlefield shows another terrain object.
        map?.dispose();
        map = null;
        if (shown?.view3d) {
          shown.view3d.canvas.remove();
          shown.view3d.overlay.remove();
          shown.view3d.dispose();
          shown = { mode: shown.mode, pose: shown.pose };
        }
      }
      // The working scenario as stored (a scenario just loaded has replaced it).
      const read = await loadBattle(store, pkg);
      const definition = read.definition;
      const notice = [loadNotice, read.notice].filter((n) => n !== null).join(' ') || null;
      await scenarios.attach(pkg.id);
      let latest = definition;
      const save = (d: BattleScenarioDefinition) => {
        latest = d;
        loaded = { pkg, battle: d };
        return store.putScenario(pkg.id, d.id, d);
      };
      await save(definition);
      // Planning opens only on a scenario that is set up; otherwise Scenario Setup.
      const ready = battleNextBlocker('scenario', scenarioIssues(pkg.terrain, definition)) === null;
      const initialStage = stage === 'bluefor' && ready ? 'bluefor' : 'scenario';
      const address = (s: 'scenario' | 'bluefor'): Stage => ({
        kind: s === 'bluefor' ? 'plan' : 'setup',
        battlefieldId: id,
      });
      if (handed || previous) pushAddress(address(initialStage));
      else setAddress(address(initialStage));
      previous?.dispose();
      if (previous === selection) selection = null;
      const open = (page: PageScenario): OpenScenario => ({
        battlefield: pkg,
        terrainModel: terrainModelId(pkg.terrain),
        definition: () => page.definition(),
        stage: () => page.stage(),
        rename: (name) => {
          page.rename(name);
        },
      });
      const menu: ScenarioMenu = {
        status: (d) => scenarios.status(pkg.id, d),
        detach: () => {
          void scenarios.detach(pkg.id);
        },
        run: async (action, page) => {
          switch (action) {
            case 'save':
              await scenarios.save(open(page));
              return;
            case 'saveAs':
              await scenarios.saveAs(open(page));
              return;
            case 'export': {
              const file = scenarios.exportFile(open(page));
              downloadText(file.name, file.text);
              return;
            }
            case 'load': {
              // Unsaved changes first; then terrain selection and the library.
              const decision = await scenarios.beforeLeaving(open(page));
              if (!decision) return;
              page.leave();
              openLibrary(decision);
              return;
            }
            case 'import': {
              const decision = await scenarios.beforeLeaving(open(page));
              if (!decision) return;
              await importScenario(decision, () => {
                page.leave();
              });
              return;
            }
          }
        },
      };
      startBattlePage(root, {
        title: pkg.name,
        terrain: pkg.terrain,
        definition,
        save,
        attribution: pkg.attribution,
        describePoint: describePointFor(pkg),
        infoHtml: battlefieldInfoHtml(pkg, pkg.quality),
        initialStage,
        notice: [notice, unresolvedNotice(pkg.quality)].filter((n) => n !== null).join(' ') || null,
        map,
        view: shown,
        leave: (m, unload) => {
          if (!unload) {
            backToSelection(pkg, latest, m);
            return;
          }
          // Unloaded: the battlefield's working scenario is empty again.
          const empty = {
            ...newBattleScenario(pkg.terrain, pkg.id, latest.name),
            seed: latest.seed,
          };
          void scenarios.detach(pkg.id);
          void save(empty);
          backToSelection(pkg, empty, m);
        },
        setAddress: (s) => {
          setAddress(address(s));
        },
        scenarios: menu,
      });
      task.done();
    } catch (error) {
      task.done();
      previous?.dispose();
      map?.dispose();
      shown?.view3d?.dispose();
      showFatal(root, error instanceof Error ? error.message : String(error));
    }
  };

  /** The battlefield last looked at in terrain selection (reopened there next time). */
  const lastBattlefield = {
    get: (): string | null => storageOrNull()?.getItem('ambush.lastBattlefield') ?? null,
    set: (id: string) => {
      try {
        storageOrNull()?.setItem('ambush.lastBattlefield', id);
      } catch {
        // Not remembered: harmless.
      }
    },
  };
  // The battlefields that come with the game, on a first visit (docs/bundled-battlefields.md).
  const seeded = await seedBundledBattlefields(
    store,
    // Without a lasting store nothing survives a reload: seeded on every visit.
    persistent ? localSeedMemory(storageOrNull()) : { has: () => false, add: () => undefined },
    (file) => window.fetch(new URL(file, document.baseURI)),
    (label) => busy(label, 0),
  );
  const stage = parseStage(window.location.hash);
  switch (stage.kind) {
    case 'select': {
      // A first visit opens on the battlefield just seeded (Quantico); later ones on
      // the battlefield last looked at, or else the newest saved.
      const saved = await store.list().catch(() => []);
      const last = lastBattlefield.get();
      const remembered = saved.find((b) => b.id === last)?.id;
      const selected = stage.selected ?? seeded[0] ?? remembered ?? saved[0]?.id;
      showSelection(selected === undefined ? {} : { selected });
      return;
    }

    case 'setup':
    case 'plan':
      await showBattle(
        stage.battlefieldId,
        stage.kind === 'plan' ? 'bluefor' : 'scenario',
        null,
        null,
      );
      return;
  }
}

// The Feedback button (a screenshot with a note) on every page.
installFeedbackButton();
// The Behavior Lab (docs/behavior-lab/04) has its own address and is loaded
// only there: nothing else in the game imports it.
// The Force-on-Force Lab (docs/behavior-lab/force-on-force) likewise, and the
// combined-arms range (docs/combined-arms.md §14).
const start = window.location.hash.startsWith('#behavior-lab')
  ? import('#view3d/behavior-lab').then(({ startBehaviorLab }) => {
      startBehaviorLab(app);
    })
  : window.location.hash.startsWith('#force-on-force')
    ? import('#view3d/force-on-force').then(({ startForceOnForceLab }) => {
        startForceOnForceLab(app);
      })
    : window.location.hash.startsWith('#combined-arms')
      ? import('./range/range').then(({ startCombinedArmsRange }) => startCombinedArmsRange(app))
      : main(app);
start.catch((error: unknown) => {
  showFatal(app, error instanceof Error ? error.message : String(error));
});
