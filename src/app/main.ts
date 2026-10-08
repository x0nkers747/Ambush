import {
  createMemoryStore,
  loadServiceConfig,
  openIndexedDbStore,
  type BattlefieldStore,
} from '#acquire';
import { DEMO_SCENARIO } from '#exercise';
import { startExerciseUi } from './exercise-ui';
import { battlefieldExercise, startBattlefieldSelection } from './start-screen';

// Composition root: the battlefield selection screen (docs/adr/0014), then the
// exercise screen for the chosen battlefield. Leaving the exercise reloads the
// page, which returns to the selection with a clean slate.

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

const leave = () => {
  window.location.reload();
};

async function main(root: HTMLElement): Promise<void> {
  const { config, problems } = loadServiceConfig(localStorageOrNull());
  const { store, persistent } = await openStore();
  startBattlefieldSelection(root, {
    config,
    configProblems: problems,
    store,
    persistent,
    openDemo: () => {
      startExerciseUi(root, {
        scenario: DEMO_SCENARIO,
        title: 'Demo battlefield',
        attribution: [],
        onLeave: leave,
      });
    },
    openBattlefield: (pkg) => {
      const exercise = battlefieldExercise(pkg);
      startExerciseUi(root, { ...exercise, onLeave: leave });
    },
  });
}

void main(app);
