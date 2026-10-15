import {
  addOrder,
  addSquad,
  battleSpecOf,
  createBattle,
  deleteOrder,
  deleteSquad,
  faceSquadToward,
  moveOrder,
  moveSquad,
  ORDER_LABELS,
  scenarioIssues,
  soldierStarts,
  type BattleEdit,
  type BattleScenarioDefinition,
  type ScenarioIssue,
  type ScenarioSquad,
  type SquadOrganization,
} from '#exercise/battle';
import { createMotionRecorder } from '#exercise';
import type { Azimuth, OrderKind, Side, SoldierId, TerrainDataset, Vec2 } from '#sim';
import type { WorkflowRules, WorkflowStage } from '../workflow';

// The battle planner (docs/constructive-simulation/03): what Scenario Setup
// and BLUEFOR Planning edit, and the rules of both stages, without the page.
// It holds the scenario, the selection and the tool; every accepted edit is
// saved; a refused one is reported and changes nothing. The map editor
// (map-editor.ts) and the side panel (page.ts) only call it, so the 2D map
// and the 3D view edit through the same rules.

/** The stages of a battle's page (stage 1, terrain, is another page). */
export type BattleStage = Exclude<WorkflowStage, 'terrain'>;

/** What a click on the map does. */
export type PlannerTool =
  /** Select and drag squads and waypoints. */
  | { readonly kind: 'select' }
  /** Place squads of a side and organization (Scenario Setup). */
  | { readonly kind: 'place'; readonly side: Side; readonly organization: SquadOrganization }
  /** Give the selected squad orders of a kind, one per click. */
  | { readonly kind: 'order'; readonly order: OrderKind };

export interface PlannerSelection {
  readonly squadId: string | null;
  /** An order of the selected squad's plan, or `null`. */
  readonly orderIndex: number | null;
}

export interface PlannerOptions {
  readonly terrain: TerrainDataset;
  readonly definition: BattleScenarioDefinition;
  readonly stage: BattleStage;
  /** Saves the scenario (after every accepted edit). */
  readonly save: (definition: BattleScenarioDefinition) => Promise<void>;
  /** Tells the user why something was refused. */
  readonly notify: (message: string) => void;
}

/** A soldier where it starts, for the map (and the 3D view's figures). */
export interface PlannedSoldier {
  readonly id: string;
  readonly squadId: string;
  readonly side: Side;
  readonly position: Vec2;
}

export interface Planner {
  readonly terrain: TerrainDataset;
  readonly definition: BattleScenarioDefinition;
  readonly stage: BattleStage;
  readonly selection: PlannerSelection;
  readonly tool: PlannerTool;
  /** Changes each time the scenario, selection, tool or stage does (for redrawing). */
  readonly version: number;
  setStage(stage: BattleStage): void;
  setTool(tool: PlannerTool): void;
  select(squadId: string | null, orderIndex?: number | null): void;
  squad(id: string | null): ScenarioSquad | undefined;
  readonly selectedSquad: ScenarioSquad | undefined;
  /** Whether a squad can be placed, moved, turned or deleted now (Scenario Setup). */
  canPlace(): boolean;
  /** Whether a squad's plan can be edited now: OPFOR's in Scenario Setup, BLUEFOR's in planning. */
  canPlan(squad: ScenarioSquad | undefined): boolean;
  /**
   * Applies an edit of the scenario: saved and `true` when accepted;
   * otherwise the reason is shown and `false` returned.
   */
  edit(change: (d: BattleScenarioDefinition) => BattleEdit): boolean;
  /** Applies an edit without saving it (while dragging); `commit` saves the last one. */
  preview(change: (d: BattleScenarioDefinition) => BattleEdit): boolean;
  commit(): void;
  /** The map's click at a point with the current tool. */
  click(point: Vec2): void;
  moveSquadTo(id: string, point: Vec2, saving: boolean): boolean;
  turnSquadToward(id: string, point: Vec2, saving: boolean): boolean;
  moveOrderTo(id: string, index: number, point: Vec2, saving: boolean): boolean;
  removeOrder(id: string, index: number): void;
  removeSquad(id: string): void;
  /** What still stops the scenario from being played (memoized per scenario). */
  issues(): readonly ScenarioIssue[];
  /** Each squad's soldiers where they start (memoized per scenario). */
  soldiers(): readonly PlannedSoldier[];
  /** The battle's starting state for the 3D view's figures (memoized per scenario). */
  figures(): StartFigures;
  /** The workflow gates of this page. */
  readonly rules: WorkflowRules;
}

/** The soldiers at the start of the battle, as the 3D view poses them. */
export interface StartFigures {
  readonly log: ReturnType<typeof createMotionRecorder>;
  readonly soldiers: readonly {
    readonly id: SoldierId;
    readonly side: Side;
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly azimuth: Azimuth;
    readonly posture: 'standing' | 'kneeling' | 'prone';
  }[];
  readonly weapons: Readonly<Record<string, string | null>>;
}

/** The tick rate of battles (Hz). */
export const BATTLE_TICK_RATE_HZ = 30;

/** Why Next cannot leave `stage`, given the scenario's issues (`null` when it can). */
export function battleNextBlocker(
  stage: WorkflowStage,
  issues: readonly ScenarioIssue[],
  d: BattleScenarioDefinition,
): string | null {
  switch (stage) {
    case 'terrain':
      return null;
    case 'scenario': {
      const first = issues.find((i) => {
        const squad = d.squads.find((s) => s.id === i.squadId);
        // BLUEFOR plans are made in the next stage: their issues wait for it.
        return !(squad?.side === 'BLUEFOR' && i.orderIndex !== null);
      });
      return first?.message ?? null;
    }
    case 'bluefor':
      return issues[0]?.message ?? null;
    case 'combat':
      return 'End the combat first: the battle runs until you end it.';
    case 'aar':
      return 'This is the last stage.';
  }
}

export function createPlanner(o: PlannerOptions): Planner {
  const { terrain } = o;
  let definition = o.definition;
  let stage = o.stage;
  let selection: PlannerSelection = { squadId: null, orderIndex: null };
  let tool: PlannerTool = { kind: 'select' };
  let version = 0;
  let unsaved = false;
  /** The note of the last edit of a drag, told when the drag ends. */
  let pendingNote: string | null = null;
  const paths = new Map<string, string | null>();
  const changed = () => {
    version += 1;
  };

  const memo = <T>(make: (d: BattleScenarioDefinition) => T) => {
    let made: { d: BattleScenarioDefinition; value: T } | null = null;
    return () => {
      if (made?.d !== definition) made = { d: definition, value: make(definition) };
      return made.value;
    };
  };
  const issues = memo((d) => scenarioIssues(terrain, d, paths));
  const soldiers = memo((d): PlannedSoldier[] => {
    const starts = soldierStarts(terrain, d);
    return d.squads.flatMap((s) =>
      (starts.get(s.id) ?? []).map((m) => ({
        id: m.id,
        squadId: s.id,
        side: s.side,
        position: m.position,
      })),
    );
  });
  const figures = memo((d): StartFigures => {
    const battle = createBattle(battleSpecOf(d, BATTLE_TICK_RATE_HZ), terrain);
    const log = createMotionRecorder(BATTLE_TICK_RATE_HZ);
    log.record(battle.sim.state);
    const weapons: Record<string, string | null> = {};
    for (const squad of battle.squads) Object.assign(weapons, squad.displayWeapons);
    return {
      log,
      weapons,
      soldiers: battle.sim.state.soldiers.map((s) => ({
        id: s.id,
        side: s.side,
        position: { x: s.position.x, y: s.position.y, z: s.position.z },
        azimuth: s.azimuth,
        posture: s.posture,
      })),
    };
  });

  const squad = (id: string | null) =>
    id === null ? undefined : definition.squads.find((s) => s.id === id);
  const canPlace = () => stage === 'scenario';
  const canPlan = (s: ScenarioSquad | undefined) =>
    s !== undefined &&
    ((stage === 'scenario' && s.side === 'OPFOR') || (stage === 'bluefor' && s.side === 'BLUEFOR'));

  const apply = (change: (d: BattleScenarioDefinition) => BattleEdit, saving: boolean) => {
    const result = change(definition);
    if (!result.ok) {
      o.notify(result.problem);
      return false;
    }
    if (result.definition !== definition) {
      definition = result.definition;
      // The selection follows what still exists.
      const selected = squad(selection.squadId);
      if (!selected) selection = { squadId: null, orderIndex: null };
      else if (selection.orderIndex !== null && selection.orderIndex >= selected.plan.length)
        selection = { ...selection, orderIndex: null };
      changed();
    }
    if (saving) {
      unsaved = false;
      pendingNote = null;
      void o.save(definition);
      if (result.note !== undefined) o.notify(result.note);
    } else {
      unsaved = true;
      pendingNote = result.note ?? null;
    }
    return true;
  };

  const planner: Planner = {
    terrain,
    get definition() {
      return definition;
    },
    get stage() {
      return stage;
    },
    get selection() {
      return selection;
    },
    get tool() {
      return tool;
    },
    get version() {
      return version;
    },
    setStage(next) {
      if (next === stage) return;
      stage = next;
      tool = { kind: 'select' };
      // Planning starts on a BLUEFOR squad; setup keeps what was selected.
      const selected = squad(selection.squadId);
      if (next === 'bluefor' && selected?.side !== 'BLUEFOR') {
        const first = definition.squads.find((s) => s.side === 'BLUEFOR');
        selection = { squadId: first?.id ?? null, orderIndex: null };
      }
      changed();
    },
    setTool(next) {
      if (next.kind === 'place' && stage !== 'scenario') return;
      tool = next;
      changed();
    },
    select(squadId, orderIndex = null) {
      const s = squad(squadId);
      const index = s && orderIndex !== null && orderIndex < s.plan.length ? orderIndex : null;
      selection = { squadId: s ? s.id : null, orderIndex: index };
      changed();
    },
    squad,
    get selectedSquad() {
      return squad(selection.squadId);
    },
    canPlace,
    canPlan,
    edit: (change) => apply(change, true),
    preview: (change) => apply(change, false),
    commit() {
      if (!unsaved) return;
      unsaved = false;
      void o.save(definition);
      if (pendingNote !== null) o.notify(pendingNote);
      pendingNote = null;
    },
    click(point) {
      if (tool.kind === 'place') {
        const { side, organization } = tool;
        let id: string | undefined;
        const placed = apply((d) => {
          const result = addSquad(terrain, d, side, organization, point);
          id = result.squadId;
          return result;
        }, true);
        if (placed && id !== undefined) planner.select(id);
        return;
      }
      if (tool.kind === 'order') {
        const selected = planner.selectedSquad;
        if (!selected) {
          o.notify('Select a squad first, then click where its order takes it.');
          return;
        }
        if (!canPlan(selected)) {
          o.notify(
            stage === 'bluefor'
              ? `${selected.name} is OPFOR: its plan is set in Scenario Setup.`
              : `${selected.name} is BLUEFOR: its plan is made in BLUEFOR Planning.`,
          );
          return;
        }
        const kind = tool.order;
        // After the selected order, or at the end of the plan.
        const at = selection.orderIndex === null ? selected.plan.length : selection.orderIndex + 1;
        if (apply((d) => addOrder(terrain, d, selected.id, kind, point, at), true))
          planner.select(selected.id, at);
        return;
      }
      planner.select(null);
    },
    moveSquadTo(id, point, saving) {
      if (!canPlace()) return false;
      return apply((d) => moveSquad(terrain, d, id, point), saving);
    },
    turnSquadToward(id, point, saving) {
      const s = squad(id);
      if (!canPlace() && !canPlan(s)) return false;
      return apply((d) => faceSquadToward(terrain, d, id, point), saving);
    },
    moveOrderTo(id, index, point, saving) {
      if (!canPlan(squad(id))) return false;
      return apply((d) => moveOrder(terrain, d, id, index, point), saving);
    },
    removeOrder(id, index) {
      const s = squad(id);
      if (!canPlan(s)) return;
      const order = s?.plan[index];
      if (apply((d) => deleteOrder(d, id, index), true) && order) {
        o.notify(`Removed order ${String(index + 1)} (${ORDER_LABELS[order.kind]}).`);
        planner.select(id, index > 0 ? index - 1 : null);
      }
    },
    removeSquad(id) {
      const s = squad(id);
      if (!s || !canPlace()) return;
      if (apply((d) => deleteSquad(d, id), true)) o.notify(`Removed ${s.name}.`);
    },
    issues,
    soldiers,
    figures,
    rules: {
      next: (s) => battleNextBlocker(s, issues(), definition),
      back: () => null,
    },
  };
  return planner;
}
