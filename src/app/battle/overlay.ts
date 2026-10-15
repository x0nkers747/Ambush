import type { BattleScenarioDefinition } from '#exercise/battle';
import type { TerrainDataset } from '#sim';
import type { MapEditor } from '#view2d';
import { createBattleMapEditor } from './map-editor';
import { createPlanner } from './planner';

// A battle scenario drawn over a map that does not edit it (the terrain
// selection's preview): the planner's drawing, with clicks ignored.

export function battleOverlay(
  terrain: TerrainDataset,
  definition: BattleScenarioDefinition,
): MapEditor {
  const planner = createPlanner({
    terrain,
    definition,
    stage: 'combat',
    save: () => Promise.resolve(),
    notify: () => undefined,
  });
  const editor = createBattleMapEditor(planner);
  return {
    click: () => undefined,
    draw: (ctx, toScreen) => {
      editor.draw?.(ctx, toScreen);
    },
  };
}
