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
import { battlefieldInfoHtml, describePointFor, startBattlefieldSelection } from './start-screen';
import { DEMO_ID, parseStage, stageHash, type Stage } from './stages';
import { demoInfoHtml, startWorkspace } from './workspace';

// Composition root: the five-stage workflow (docs/adr/0025). Terrain
// selection (stage 1, docs/adr/0014) is one page; stages 2–5 of a battlefield
// (scenario editing, BLUEFOR planning, OPFOR and combat, and the After Action
// Review) share another (workspace.ts). Each page has its own address
// (stages.ts); moving between pages saves what matters first and reloads, so
// nothing from one page keeps running in the next.

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

function showFatal(root: HTMLElement, message: string): void {
  root.className = 'select';
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
  const stage = parseStage(window.location.hash);
  switch (stage.kind) {
    case 'select':
      startBattlefieldSelection(root, {
        config,
        configProblems: problems,
        store,
        persistent,
        ...(stage.selected === undefined ? {} : { selected: stage.selected }),
        openDemo: () => {
          go({ kind: 'demo' });
        },
        loadPreview: async (id) => {
          if (id === DEMO_ID)
            return { scenario: DEMO_SCENARIO, attribution: [], caption: 'Demo scenario (fixed)' };
          const pkg = await openBattlefield(store, id);
          const { definition } = await loadScenario(store, pkg);
          const waypoints = Math.max(0, definition.opfor.route.length - 1);
          return {
            scenario: buildScenario(pkg.terrain, definition),
            attribution: pkg.attribution,
            caption:
              definition.opfor.route.length === 0
                ? 'Saved scenario: ORP only, no OPFOR yet'
                : `Saved scenario: ORP, OPFOR and a route of ${String(waypoints)} waypoint${waypoints === 1 ? '' : 's'}`,
          };
        },
        openBattlefield: (pkg) => {
          go({ kind: 'edit', battlefieldId: pkg.id });
        },
      });
      return;

    case 'demo':
      startWorkspace(root, {
        title: 'Demo battlefield',
        terrain: DEMO_SCENARIO.terrain,
        scenario: { kind: 'fixed', scenario: DEMO_SCENARIO },
        attribution: [],
        infoHtml: demoInfoHtml(DEMO_SCENARIO),
        initialStage: stage.play === true ? 'bluefor' : 'scenario',
        leave: () => {
          go({ kind: 'select', selected: DEMO_ID });
        },
        setAddress: (s) => {
          setAddress({ kind: 'demo', play: s === 'bluefor' });
        },
      });
      return;

    case 'edit':
    case 'play': {
      const pkg = await openBattlefield(store, stage.battlefieldId);
      const { definition, notice } = await loadScenario(store, pkg);
      if (!definition.orp) {
        showFatal(
          root,
          'There is no open ground on this battlefield where the squad can assemble.',
        );
        return;
      }
      const save = (d: ScenarioDefinition) => store.putScenario(pkg.id, d.id, d);
      await save(definition);
      // Only a complete scenario is played; otherwise it opens for editing.
      const playable = scenarioProblems(pkg.terrain, definition).length === 0;
      startWorkspace(root, {
        title: pkg.name,
        terrain: pkg.terrain,
        scenario: { kind: 'editable', definition, save },
        attribution: pkg.attribution,
        describePoint: describePointFor(pkg),
        infoHtml: battlefieldInfoHtml(pkg),
        initialStage: stage.kind === 'play' && playable ? 'bluefor' : 'scenario',
        notice,
        leave: () => {
          go({ kind: 'select', selected: pkg.id });
        },
        setAddress: (s) => {
          setAddress({ kind: s === 'bluefor' ? 'play' : 'edit', battlefieldId: pkg.id });
        },
      });
      return;
    }
  }
}

main(app).catch((error: unknown) => {
  showFatal(app, error instanceof Error ? error.message : String(error));
});
