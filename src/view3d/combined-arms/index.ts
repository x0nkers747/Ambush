import { Vector3 } from 'three';
import type { CombatEvent, MotionLog } from '#exercise';
import { COMBAT_WEAPONS } from '#sim';
import { createLabScene } from '../behavior-lab/scene';
import { createCharacterLayer } from '../characters/layer';
import { createHeavyEffectsLayer } from '../heavy-effects';
import { createImpactLayer } from '../impacts';
import { createTracerLayer } from '../tracers';
import type { UnitMarker } from '../unit-markers';
import { createVehicleLayer, type ViewVehicle } from '../vehicles';

// The combined-arms range's 3D scene (docs/combined-arms.md §14): the lab's
// flat ground with the game's own layers (vehicles, soldiers, tracers,
// impacts, heavy effects), posed from a battle's motion and combat logs: the
// very layers of the battle page, on the range's ground. Reached through the
// range page (`#combined-arms`); loaded only there.

export interface RangeFrame {
  readonly log: MotionLog;
  readonly combatLog: readonly CombatEvent[];
  readonly seconds: number;
  readonly units: readonly UnitMarker[];
  readonly vehicles: readonly ViewVehicle[];
  /** The weapon each soldier fires, by id. */
  readonly weapons: Readonly<Record<string, string | null>>;
  /** The run's speed (simulated seconds per real second; default 1): rounds fly at one speed on screen. */
  readonly timeScale?: number;
}

export interface RangeScene {
  readonly canvas: HTMLCanvasElement;
  resize(width: number, height: number): void;
  render(frame: RangeFrame): void;
  /** Looks at map point (x, y) from `distance` m, `pitchDeg` down, from bearing `bearingDeg`. */
  look(x: number, y: number, distance: number, pitchDeg: number, bearingDeg: number): void;
  /** A map point's place on the canvas (px), or `null` behind the camera. */
  project(x: number, y: number, z: number): { x: number; y: number } | null;
  /** Points drawn by the effects at the last frame, and whether the soldiers' models are in. */
  stats(): { effects: number; charactersReady: boolean };
  dispose(): void;
}

/** The range's ground: the lab terrain's half-size (m) and its flat elevation. */
const HALF_M = 1200;
const ELEVATION_M = 10;

export function createRangeScene(canvas: HTMLCanvasElement): RangeScene {
  const lab = createLabScene(canvas, HALF_M, ELEVATION_M);
  const vehicles = createVehicleLayer();
  const characters = createCharacterLayer(new URL('characters/', document.baseURI).href);
  const kinds = new Map(COMBAT_WEAPONS.map((w) => [w.id, w.kind as string]));
  const kindOf = (w: string) => kinds.get(w) ?? 'machineGun';
  const tracers = createTracerLayer(kindOf);
  const impacts = createImpactLayer();
  const heavy = createHeavyEffectsLayer(kindOf);
  lab.scene.add(vehicles.group, characters.group, tracers.group, impacts.group, heavy.group);
  const surfaceAt = (x: number, y: number) =>
    Math.abs(x) <= HALF_M && Math.abs(y) <= HALF_M ? ELEVATION_M : Number.NaN;
  let height = canvas.clientHeight || 800;
  const v = new Vector3();
  return {
    canvas,
    resize(width, h) {
      height = h;
      lab.resize(width, h);
    },
    render(frame) {
      const eye = lab.camera.camera.position;
      vehicles.update(frame.vehicles, frame.log, frame.seconds, surfaceAt);
      if (characters.ready) {
        characters.update({
          units: frame.units,
          clock: { log: frame.log, combatLog: frame.combatLog, seconds: frame.seconds },
          weapons: frame.weapons,
          surfaceAt,
          camera: lab.camera.camera,
          viewportHeightPx: height,
        });
      }
      tracers.update(frame.log, frame.combatLog, frame.seconds, surfaceAt, eye, frame.timeScale);
      impacts.update(frame.combatLog, frame.seconds, surfaceAt, eye);
      heavy.update(frame.combatLog, frame.seconds, vehicles.wrecks, surfaceAt, frame.timeScale);
      lab.render();
    },
    look(x, y, distance, pitchDeg, bearingDeg) {
      const pitch = (pitchDeg * Math.PI) / 180;
      const bearing = (bearingDeg * Math.PI) / 180;
      const target = new Vector3(x, ELEVATION_M, -y);
      // From the bearing: the camera stands back toward it, raised by the pitch.
      const position = new Vector3(
        x + Math.sin(bearing) * Math.cos(pitch) * distance,
        ELEVATION_M + Math.sin(pitch) * distance,
        -(y + Math.cos(bearing) * Math.cos(pitch) * distance),
      );
      lab.camera.setPose(target, position);
    },
    project(x, y, z) {
      v.set(x, z, -y).project(lab.camera.camera);
      if (v.z > 1) return null;
      return {
        x: ((v.x + 1) / 2) * canvas.clientWidth,
        y: ((1 - v.y) / 2) * canvas.clientHeight,
      };
    },
    stats() {
      return { effects: heavy.drawn + tracers.inFlight, charactersReady: characters.ready };
    },
    dispose() {
      vehicles.dispose();
      characters.dispose();
      tracers.dispose();
      impacts.dispose();
      heavy.dispose();
      lab.dispose();
    },
  };
}
