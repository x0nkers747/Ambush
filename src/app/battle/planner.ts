import {
  addOrder,
  addSquad,
  addVehicle,
  addVehicleWaypoint,
  deleteVehicle,
  deleteVehicleWaypoint,
  faceVehicleToward,
  moveVehicle,
  moveVehicleWaypoint,
  vehiclesOf,
  type PlannedVehicle,
  battleSpecOf,
  createBattle,
  deleteOrder,
  deleteSquad,
  faceSquadToward,
  moveOrder,
  moveSquad,
  ORDER_LABELS,
  reorderOrder,
  resizeDefendArc,
  resizeKillZone,
  setDefendSector,
  setKillZone,
  scenarioIssues,
  soldierStarts,
  type BattleEdit,
  type BattleScenarioDefinition,
  type ScenarioIssue,
  type ScenarioSquad,
  type SquadOrganization,
} from '#exercise/battle';
import { createMotionRecorder } from '#exercise';
import {
  roadWaypoints,
  type Azimuth,
  type OrderKind,
  type Side,
  type SoldierId,
  type TerrainDataset,
  type Vec2,
} from '#sim';
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
  | { readonly kind: 'order'; readonly order: OrderKind }
  /** Set the kill zone of the selected ambush order: a click centres it. */
  | { readonly kind: 'killZone' }
  /** The next click sets the selected defend order's direction (its sector's facing). */
  | { readonly kind: 'sector' }
  /** Place a vehicle of a side (Scenario Setup; docs/vehicles.md). */
  | { readonly kind: 'placeVehicle'; readonly side: Side };

export interface PlannerSelection {
  readonly squadId: string | null;
  /** An order of the selected squad's plan (a waypoint of the selected vehicle's route), or `null`. */
  readonly orderIndex: number | null;
  /** The selected vehicle (then no squad is selected). */
  readonly vehicleId?: string;
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

/** A viewshed turned on: squad `squadId`'s, from where it starts (`orderIndex` null) or from waypoint `orderIndex`. */
export interface ViewshedPin {
  readonly squadId: string;
  readonly orderIndex: number | null;
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
  /** Selects a vehicle, and a waypoint of its route. */
  selectVehicle(id: string, waypointIndex?: number | null): void;
  vehicle(id: string | null | undefined): PlannedVehicle | undefined;
  readonly selectedVehicle: PlannedVehicle | undefined;
  /** Whether a vehicle's route can be edited now: in Scenario Setup, and BLUEFOR's in planning. */
  canRoute(vehicle: PlannedVehicle | undefined): boolean;
  moveVehicleTo(id: string, point: Vec2, saving: boolean): boolean;
  turnVehicleToward(id: string, point: Vec2, saving: boolean): boolean;
  moveVehicleWaypointTo(id: string, index: number, point: Vec2, saving: boolean): boolean;
  removeVehicleWaypoint(id: string, index: number): void;
  removeVehicle(id: string): void;
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
  /**
   * Arms the second click of the selected squad's ambush or defend order (the
   * selected order, else its last of them): an ambush's kill zone, a
   * defence's direction. Returns whether there is one.
   */
  armKillZone(): boolean;
  /** Widens or narrows a defend order's arc to its handle at `point`. */
  resizeDefendArcTo(id: string, index: number, point: Vec2, saving: boolean): boolean;
  /** Moves corner `corner` of an ambush order's kill zone to `point`. */
  resizeKillZoneTo(
    id: string,
    index: number,
    corner: number,
    point: Vec2,
    saving: boolean,
  ): boolean;
  removeOrder(id: string, index: number): void;
  /** Moves order `index` one place earlier (`-1`) or later (`+1`), selecting it there. */
  moveOrder(id: string, index: number, by: -1 | 1): boolean;
  removeSquad(id: string): void;
  /**
   * The viewsheds turned on, in the order they were: each a squad's from
   * where it starts, or from one of its waypoints. They follow their orders
   * when orders are added, moved or deleted, and go with them.
   */
  viewsheds(): readonly ViewshedPin[];
  hasViewshed(squadId: string, orderIndex: number | null): boolean;
  /** Turns a squad's (or a waypoint's) viewshed on or off; returns whether it is now on. */
  toggleViewshed(squadId: string, orderIndex: number | null): boolean;
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
  /** The vehicles where they start. */
  readonly vehicles: readonly StartVehicle[];
}

/** A vehicle at the start of the battle, for the 3D view. */
export interface StartVehicle {
  readonly id: string;
  readonly side: Side;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly heading: number;
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
  /** The viewsheds turned on (`viewsheds`). */
  let pins: ViewshedPin[] = [];
  /** Pins of squad `id`'s orders from `from` on, moved by `by` places. */
  const shiftPins = (id: string, from: number, by: number) => {
    pins = pins.map((p) =>
      p.squadId !== id || p.orderIndex === null || p.orderIndex < from
        ? p
        : { squadId: id, orderIndex: p.orderIndex + by },
    );
  };
  /** Drops pins whose squad or order no longer exists. */
  const prunePins = () => {
    const next = pins.filter((p) => {
      const s = definition.squads.find((x) => x.id === p.squadId);
      return s !== undefined && (p.orderIndex === null || p.orderIndex < s.plan.length);
    });
    if (next.length !== pins.length) pins = next;
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
  /**
   * The start figures, rebuilt only when the soldiers' starts change (the
   * squads, where they stand and face, their formations, the seed): never for
   * an edit of a plan, such as a waypoint being dragged.
   */
  let figuresKey = '';
  let figuresMade: StartFigures | null = null;
  const figures = (): StartFigures => {
    const key = JSON.stringify([
      definition.seed,
      definition.squads.map((s) => [
        s.id,
        s.side,
        s.organization,
        s.formation,
        s.position,
        s.facingDeg,
      ]),
      vehiclesOf(definition).map((v) => [v.id, v.side, v.position, v.facingDeg]),
    ]);
    if (figuresMade === null || key !== figuresKey) {
      figuresKey = key;
      figuresMade = startFigures(definition);
    }
    return figuresMade;
  };
  const startFigures = (d: BattleScenarioDefinition): StartFigures => {
    // No squads yet (a new battlefield): no figures; a battle needs a force.
    if (d.squads.length === 0)
      return {
        log: createMotionRecorder(BATTLE_TICK_RATE_HZ),
        weapons: {},
        soldiers: [],
        vehicles: [],
      };
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
      vehicles: (battle.sim.state.vehicles ?? []).map((v) => ({
        id: v.id,
        side: v.side,
        position: { x: v.position.x, y: v.position.y, z: v.position.z },
        heading: v.heading,
      })),
    };
  };

  const squad = (id: string | null) =>
    id === null ? undefined : definition.squads.find((s) => s.id === id);
  const canPlace = () => stage === 'scenario';
  const canPlan = (s: ScenarioSquad | undefined) =>
    s !== undefined &&
    ((stage === 'scenario' && s.side === 'OPFOR') || (stage === 'bluefor' && s.side === 'BLUEFOR'));
  const vehicle = (id: string | null | undefined) =>
    id === null || id === undefined ? undefined : vehiclesOf(definition).find((v) => v.id === id);
  const canRoute = (v: PlannedVehicle | undefined) =>
    v !== undefined && (stage === 'scenario' || (stage === 'bluefor' && v.side === 'BLUEFOR'));

  const apply = (change: (d: BattleScenarioDefinition) => BattleEdit, saving: boolean) => {
    const result = change(definition);
    if (!result.ok) {
      o.notify(result.problem);
      return false;
    }
    if (result.definition !== definition) {
      definition = result.definition;
      prunePins();
      // The selection follows what still exists.
      const selected = squad(selection.squadId);
      const car = vehicle(selection.vehicleId);
      if (car) {
        if (selection.orderIndex !== null && selection.orderIndex >= car.route.length)
          selection = { ...selection, orderIndex: null };
      } else if (!selected) selection = { squadId: null, orderIndex: null };
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
      if ((next.kind === 'place' || next.kind === 'placeVehicle') && stage !== 'scenario') return;
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
    selectVehicle(id, waypointIndex = null) {
      const v = vehicle(id);
      if (!v) {
        planner.select(null);
        return;
      }
      const index = waypointIndex !== null && waypointIndex < v.route.length ? waypointIndex : null;
      selection = { squadId: null, orderIndex: index, vehicleId: v.id };
      changed();
    },
    vehicle,
    get selectedVehicle() {
      return vehicle(selection.vehicleId);
    },
    canRoute,
    moveVehicleTo(id, point, saving) {
      if (!canPlace()) return false;
      return apply((d) => moveVehicle(terrain, d, id, point), saving);
    },
    turnVehicleToward(id, point, saving) {
      if (!canPlace() && !canRoute(vehicle(id))) return false;
      return apply((d) => faceVehicleToward(d, id, point), saving);
    },
    moveVehicleWaypointTo(id, index, point, saving) {
      if (!canRoute(vehicle(id))) return false;
      return apply((d) => moveVehicleWaypoint(terrain, d, id, index, point), saving);
    },
    removeVehicleWaypoint(id, index) {
      if (!canRoute(vehicle(id))) return;
      if (apply((d) => deleteVehicleWaypoint(d, id, index), true)) {
        o.notify(`Removed waypoint ${String(index + 1)}.`);
        planner.selectVehicle(id, index > 0 ? index - 1 : null);
      }
    },
    removeVehicle(id) {
      const v = vehicle(id);
      if (!v || !canPlace()) return;
      if (apply((d) => deleteVehicle(d, id), true)) {
        o.notify(`Removed ${v.name}.`);
        planner.select(null);
      }
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
      if (tool.kind === 'placeVehicle') {
        const { side } = tool;
        let id: string | undefined;
        const placed = apply((d) => {
          const result = addVehicle(terrain, d, side, point);
          id = result.vehicleId;
          return result;
        }, true);
        if (placed && id !== undefined) {
          planner.selectVehicle(id);
          // Placed: the next clicks give it its route.
          tool = { kind: 'order', order: 'move' };
          changed();
        }
        return;
      }
      const car = planner.selectedVehicle;
      if (tool.kind === 'order' && car) {
        if (!canRoute(car)) {
          o.notify(`${car.name} is OPFOR: its route is set in Scenario Setup.`);
          return;
        }
        if (tool.order !== 'move') {
          o.notify(`${car.name} is a vehicle: it only takes Move orders.`);
          return;
        }
        const at = selection.orderIndex === null ? car.route.length : selection.orderIndex + 1;
        if (apply((d) => addVehicleWaypoint(terrain, d, car.id, point, at), true))
          planner.selectVehicle(car.id, at);
        return;
      }
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
        // OPFOR moving to a point on a road goes along the roads: a move to
        // where it joins the nearest road, then one to each turn of the road.
        const before = at > 0 ? selected.plan[at - 1]?.destination : undefined;
        const from = before ?? selected.position;
        const route =
          kind === 'move' && selected.side === 'OPFOR'
            ? roadWaypoints(terrain, { x: from.east, y: from.north }, point)
            : null;
        const points = route && route.length > 1 ? route : [point];
        // Viewsheds of later orders move down with them.
        const pinsBefore = pins;
        shiftPins(selected.id, at, points.length);
        const added = apply((d) => {
          let edit: BattleEdit = { ok: true, definition: d };
          for (const [k, p] of points.entries()) {
            if (!edit.ok) return edit;
            edit = addOrder(terrain, edit.definition, selected.id, kind, p, at + k);
          }
          return edit;
        }, true);
        if (!added) pins = pinsBefore;
        if (added && points.length > 1)
          o.notify(
            `Along the road: ${String(points.length)} move orders, to where it joins the road and along it.`,
          );
        if (added) {
          planner.select(selected.id, at + points.length - 1);
          // An ambush needs its kill zone, a defence its direction: the next click sets it.
          if (kind === 'ambush' || kind === 'defend') {
            tool = { kind: kind === 'ambush' ? 'killZone' : 'sector' };
            changed();
          }
        }
        return;
      }
      if (tool.kind === 'sector') {
        const selected = planner.selectedSquad;
        const index = selection.orderIndex;
        if (!selected || index === null || selected.plan[index]?.kind !== 'defend') {
          o.notify('Select a defend order first, then click the direction it defends toward.');
          return;
        }
        if (!canPlan(selected)) return;
        if (apply((d) => setDefendSector(d, selected.id, index, point), true)) {
          tool = { kind: 'select' };
          changed();
        }
        return;
      }
      if (tool.kind === 'killZone') {
        const selected = planner.selectedSquad;
        const index = selection.orderIndex;
        if (!selected || index === null || selected.plan[index]?.kind !== 'ambush') {
          o.notify('Select an ambush order first, then click its kill zone.');
          return;
        }
        if (!canPlan(selected)) return;
        if (apply((d) => setKillZone(terrain, d, selected.id, index, point), true)) {
          tool = { kind: 'select' };
          changed();
        }
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
    armKillZone() {
      const s = planner.selectedSquad;
      if (!s || !canPlan(s)) return false;
      // The selected order if it is an ambush or a defence, else the squad's last of them.
      const chosen = selection.orderIndex;
      const second = (k: number) => s.plan[k]?.kind === 'ambush' || s.plan[k]?.kind === 'defend';
      let index = chosen !== null && second(chosen) ? chosen : -1;
      if (index < 0)
        for (let k = s.plan.length - 1; k >= 0 && index < 0; k -= 1) if (second(k)) index = k;
      if (index < 0) return false;
      selection = { squadId: s.id, orderIndex: index };
      tool = { kind: s.plan[index]?.kind === 'defend' ? 'sector' : 'killZone' };
      changed();
      return true;
    },
    resizeDefendArcTo(id, index, point, saving) {
      if (!canPlan(squad(id))) return false;
      return apply((d) => resizeDefendArc(d, id, index, point), saving);
    },
    resizeKillZoneTo(id, index, corner, point, saving) {
      if (!canPlan(squad(id))) return false;
      return apply((d) => resizeKillZone(terrain, d, id, index, corner, point), saving);
    },
    removeOrder(id, index) {
      const s = squad(id);
      if (!canPlan(s)) return;
      const order = s?.plan[index];
      // Its viewshed goes with it; later orders' move up a place.
      const before = pins;
      pins = pins.filter((p) => p.squadId !== id || p.orderIndex !== index);
      shiftPins(id, index + 1, -1);
      if (!apply((d) => deleteOrder(d, id, index), true)) {
        pins = before;
        return;
      }
      if (order) {
        o.notify(`Removed order ${String(index + 1)} (${ORDER_LABELS[order.kind]}).`);
        planner.select(id, index > 0 ? index - 1 : null);
      }
    },
    moveOrder(id, index, by) {
      const s = squad(id);
      const to = index + by;
      if (!s || !canPlan(s) || to < 0 || to >= s.plan.length) return false;
      const before = pins;
      // The two orders' viewsheds change places with them.
      pins = pins.map((p) =>
        p.squadId !== id || p.orderIndex === null
          ? p
          : p.orderIndex === index
            ? { squadId: id, orderIndex: to }
            : p.orderIndex === to
              ? { squadId: id, orderIndex: index }
              : p,
      );
      if (!apply((d) => reorderOrder(d, id, index, by), true)) {
        pins = before;
        return false;
      }
      planner.select(id, to);
      return true;
    },
    viewsheds: () => pins,
    hasViewshed: (id, index) => pins.some((p) => p.squadId === id && p.orderIndex === index),
    toggleViewshed(id, index) {
      const s = squad(id);
      if (!s || (index !== null && !s.plan[index])) return false;
      const on = !planner.hasViewshed(id, index);
      pins = on
        ? [...pins, { squadId: id, orderIndex: index }]
        : pins.filter((p) => p.squadId !== id || p.orderIndex !== index);
      changed();
      return on;
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
