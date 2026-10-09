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
import { startExerciseUi } from './exercise-ui';
import { startScenarioEditor } from './scenario-editor';
import { parseStage, stageHash, type Stage } from './stages';
import { battlefieldExercise, describePointFor, startBattlefieldSelection } from './start-screen';

// Composition root: the three stages (docs/adr/0015). 1. terrain selection
// (docs/adr/0014), 2. scenario editing, 3. BLUEFOR planning and execution.
// Each stage has its own address (stages.ts); moving between stages saves what
// matters first and reloads, so nothing from one stage keeps running in the next.

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
  root.classList.add('start');
  root.innerHTML = `<div class="start-screen"><div class="start-card"><h2>Something went wrong</h2>
    <p>${message.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`)}</p>
    <div class="bf-row"><button class="primary" data-action="home">Back to terrain selection</button></div></div></div>`;
  root.querySelector('[data-action="home"]')?.addEventListener('click', () => {
    go({ kind: 'select' });
  });
}

async function main(root: HTMLElement): Promise<void> {
  const { config, problems } = loadServiceConfig(localStorageOrNull());
  const { store, persistent } = await openStore();
  const stage = parseStage(window.location.hash);
  const home = () => {
    go({ kind: 'select' });
  };

  switch (stage.kind) {
    case 'select':
      startBattlefieldSelection(root, {
        config,
        configProblems: problems,
        store,
        persistent,
        openDemo: () => {
          go({ kind: 'demo' });
        },
        openBattlefield: (pkg) => {
          go({ kind: 'edit', battlefieldId: pkg.id });
        },
      });
      return;

    case 'demo':
      startExerciseUi(root, {
        scenario: DEMO_SCENARIO,
        title: 'Demo battlefield',
        attribution: [],
        onLeave: home,
      });
      return;

    case 'edit': {
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
      startScenarioEditor(root, {
        terrain: pkg.terrain,
        battlefieldName: pkg.name,
        definition,
        attribution: pkg.attribution,
        describePoint: describePointFor(pkg),
        save,
        onBack: home,
        onContinue: () => {
          go({ kind: 'play', battlefieldId: pkg.id });
        },
      });
      if (notice) root.querySelector('[data-ui="toast"]')?.replaceChildren(notice);
      return;
    }

    case 'play': {
      const pkg = await openBattlefield(store, stage.battlefieldId);
      const { definition } = await loadScenario(store, pkg);
      // Only a complete scenario is played; otherwise back to editing it.
      if (scenarioProblems(pkg.terrain, definition).length > 0) {
        go({ kind: 'edit', battlefieldId: pkg.id });
        return;
      }
      const scenario = buildScenario(pkg.terrain, definition);
      startExerciseUi(root, {
        ...battlefieldExercise(pkg, scenario),
        onLeave: home,
        onEditScenario: () => {
          go({ kind: 'edit', battlefieldId: pkg.id });
        },
      });
      return;
    }
  }
}

main(app).catch((error: unknown) => {
  showFatal(app, error instanceof Error ? error.message : String(error));
});
