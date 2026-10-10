import {
  createMemoryStore,
  loadServiceConfig,
  openIndexedDbStore,
  type BattlefieldStore,
} from '#acquire';
import {
  buildScenario,
  DEMO_SCENARIO,
  defaultScenarioDefinition,
  parseScenarioDefinition,
  scenarioProblems,
  type ScenarioDefinition,
} from '#exercise';
import type { BattlefieldPackage } from '#geo';
import { shareTerrain } from '#sim';
import type { TacticalMap } from '#view2d';
import type { PreviewData } from './battlefield-preview';
import { battlefieldInfoHtml, describePointFor, startBattlefieldSelection } from './start-screen';
import { parseStage, stageHash, type Stage } from './stages';
import { demoInfoHtml, startWorkspace } from './workspace';

// Composition root: the five-stage workflow (docs/adr/0025). Terrain
// selection (stage 1, docs/adr/0014) is one page; stages 2–5 of a battlefield
// (scenario editing, BLUEFOR planning, OPFOR and combat, and the After Action
// Review) share another (workspace.ts). Each page has its own address
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
 * The battlefield's scenario: the saved one when valid, otherwise a new
 * default (an invalid saved scenario is reported, not silently replaced).
 */
async function loadScenario(
  store: BattlefieldStore,
  pkg: BattlefieldPackage,
): Promise<{ definition: ScenarioDefinition; notice: string | null }> {
  const saved = await store.listScenarios(pkg.id);
  for (const data of saved) {
    try {
      const definition = parseScenarioDefinition(data);
      if (definition.battlefieldId === pkg.id) return { definition, notice: null };
    } catch (error) {
      return {
        definition: defaultScenarioDefinition(pkg.terrain, pkg.id),
        notice: `The saved scenario could not be read and was replaced by a new one: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { definition: defaultScenarioDefinition(pkg.terrain, pkg.id), notice: null };
}

/**
 * A saved battlefield, with its terrain shared (`shareTerrain`): everything
 * on the page (scenario edits, previews, the exercise) then uses one frozen
 * terrain, so its navigation grid and other per-terrain data are built once.
 */
async function openBattlefield(store: BattlefieldStore, id: string): Promise<BattlefieldPackage> {
  const pkg = await store.get(id);
  return { ...pkg, terrain: shareTerrain(pkg.terrain) };
}

/** What the terrain-selection preview shows of a battlefield and its scenario. */
function previewData(pkg: BattlefieldPackage, definition: ScenarioDefinition): PreviewData {
  const waypoints = Math.max(0, definition.opfor.route.length - 1);
  return {
    scenario: buildScenario(pkg.terrain, definition),
    attribution: pkg.attribution,
    caption:
      definition.opfor.route.length === 0
        ? 'Saved scenario: ORP only, no OPFOR yet'
        : `Saved scenario: ORP, OPFOR and a route of ${String(waypoints)} waypoint${waypoints === 1 ? '' : 's'}`,
  };
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

  /**
   * The battlefield last loaded for the preview or left in the workspace, with
   * its scenario. Opening it again reuses it, so the preview's map (built on
   * its terrain) can be handed over as it is.
   */
  let loaded: { pkg: BattlefieldPackage; definition: ScenarioDefinition } | null = null;
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
      loadPreview: async (id) => {
        const mine = (previewLoads += 1);
        const pkg = await openBattlefield(store, id);
        const { definition } = await loadScenario(store, pkg);
        if (mine === previewLoads) loaded = { pkg, definition };
        return previewData(pkg, definition);
      },
      openBattlefield: (id, map) => {
        void showBattlefield(id, 'edit', map, page);
      },
    });
  };

  /** Stages 2–5 of a saved battlefield, replacing `previous` (terrain selection) once it is ready. */
  const showBattlefield = async (
    id: string,
    kind: 'edit' | 'play',
    handed: TacticalMap | null,
    previous: { dispose(): void } | null,
  ): Promise<void> => {
    let map = handed;
    try {
      let pkg: BattlefieldPackage;
      let definition: ScenarioDefinition;
      let notice: string | null = null;
      if (loaded?.pkg.id === id) ({ pkg, definition } = loaded);
      else {
        pkg = await openBattlefield(store, id);
        ({ definition, notice } = await loadScenario(store, pkg));
        // A map of another load of this battlefield shows another terrain object.
        map?.dispose();
        map = null;
      }
      if (!definition.orp) {
        previous?.dispose();
        map?.dispose();
        showFatal(
          root,
          'There is no open ground on this battlefield where the squad can assemble.',
        );
        return;
      }
      let latest = definition;
      const save = (d: ScenarioDefinition) => {
        latest = d;
        loaded = { pkg, definition: d };
        return store.putScenario(pkg.id, d.id, d);
      };
      await save(definition);
      // Only a complete scenario is played; otherwise it opens for editing.
      const playable = scenarioProblems(pkg.terrain, definition).length === 0;
      const initialStage = kind === 'play' && playable ? 'bluefor' : 'scenario';
      if (handed || previous)
        pushAddress({ kind: initialStage === 'bluefor' ? 'play' : 'edit', battlefieldId: id });
      // Terrain selection stays on screen until now, so the handed-over map is never blank.
      previous?.dispose();
      startWorkspace(root, {
        title: pkg.name,
        terrain: pkg.terrain,
        scenario: { kind: 'editable', definition, save },
        attribution: pkg.attribution,
        describePoint: describePointFor(pkg),
        infoHtml: battlefieldInfoHtml(pkg),
        initialStage,
        notice,
        map,
        leave: (m) => {
          pushAddress({ kind: 'select', selected: pkg.id });
          showSelection({ adopt: { id: pkg.id, map: m, data: previewData(pkg, latest) } });
        },
        setAddress: (s) => {
          setAddress({ kind: s === 'bluefor' ? 'play' : 'edit', battlefieldId: pkg.id });
        },
      });
    } catch (error) {
      previous?.dispose();
      map?.dispose();
      showFatal(root, error instanceof Error ? error.message : String(error));
    }
  };

  const stage = parseStage(window.location.hash);
  switch (stage.kind) {
    case 'select':
      showSelection(stage.selected === undefined ? {} : { selected: stage.selected });
      return;

    case 'demo':
      startWorkspace(root, {
        title: 'Demo battlefield',
        terrain: DEMO_SCENARIO.terrain,
        scenario: { kind: 'fixed', scenario: DEMO_SCENARIO },
        attribution: [],
        infoHtml: demoInfoHtml(DEMO_SCENARIO),
        initialStage: stage.play === true ? 'bluefor' : 'scenario',
        // Terrain selection does not list the demo (it is reached only by its
        // address), so its map is not handed on.
        leave: (map) => {
          map.dispose();
          pushAddress({ kind: 'select' });
          showSelection({});
        },
        setAddress: (s) => {
          setAddress({ kind: 'demo', play: s === 'bluefor' });
        },
      });
      return;

    case 'edit':
    case 'play':
      await showBattlefield(stage.battlefieldId, stage.kind, null, null);
      return;
  }
}

main(app).catch((error: unknown) => {
  showFatal(app, error instanceof Error ? error.message : String(error));
});
