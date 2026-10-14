import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { createMotionRecorder, type CombatEvent, type MotionRecorder } from '#exercise';
import type { SimState } from '#sim';
import type { UnitMarker } from '../unit-markers';
import { FALL_SECONDS } from './animator';
import {
  type BakedCharacter,
  type CharacterAsset,
  clipsFromBaked,
  skeletonFromBaked,
} from './asset';
import { AFTERMATH_SECONDS, createAftermath, createCharacterLayer } from './layer';
import type { SoldierAssets } from './load';
import { locomotionBlend, slotSpeed } from './locomotion';
import { AIM_HOLD_S, POSTURE_SECONDS, SoldierMotion } from './motion';
import { Puppet } from './puppet';
import { makeWeapon, weaponKindOf } from './weapon-map';

// The soldiers' animation from the simulation's state (docs/character-animation.md):
// weapons, movement, posture, firing, incapacitation, placement, the layer.

let asset: CharacterAsset;
const box = () => {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, 1)));
  return g;
};
const models = { rifle: box(), ak: box() };

beforeAll(async () => {
  const path = '../../../public/characters/rocketbox/clips.json';
  const baked = ((await import(/* @vite-ignore */ path)) as { default: BakedCharacter }).default;
  asset = {
    id: baked.id,
    rig: 'rocketbox',
    template: skeletonFromBaked(baked),
    clips: clipsFromBaked(baked),
    sighting: true,
  };
});

interface Step {
  x: number;
  y: number;
  z?: number;
  azimuth?: number;
  posture?: 'standing' | 'kneeling' | 'prone';
  status?: 'active' | 'incapacitated';
  behavior?: 'engaging' | 'fleeing';
}

/** A motion log of one soldier ("S1"), one entry per tick. */
function logOf(steps: readonly Step[]): MotionRecorder {
  const log = createMotionRecorder(30);
  steps.forEach((s, tick) => {
    log.record({
      tick,
      soldiers: [
        {
          id: 'S1',
          side: 'BLUEFOR',
          position: { x: s.x, y: s.y, z: s.z ?? 0 },
          azimuth: s.azimuth ?? 0,
          posture: s.posture ?? 'standing',
          status: s.status ?? 'active',
        },
      ],
      engagement: s.behavior
        ? { combatants: [{ soldierId: 'S1', behavior: s.behavior }] }
        : undefined,
    } as unknown as SimState);
  });
  return log;
}

/** Standing `still` ticks, then walking north at `speed` m/s for `moving` ticks. */
const walk = (still: number, moving: number, speed = 1.5, extra: Partial<Step> = {}) =>
  Array.from({ length: still + moving }, (_, t) => ({
    x: 0,
    y: Math.max(0, t - still) * (speed / 30),
    ...extra,
  }));

describe('weapons', () => {
  it('map the simulation weapons to models', () => {
    expect(weaponKindOf('m16-rifle')).toBe('m16');
    expect(weaponKindOf('squad-automatic-weapon')).toBe('m249');
    expect(weaponKindOf('ak-assault-rifle')).toBe('ak');
    expect(weaponKindOf('bayonet-knife')).toBeNull();
    expect(weaponKindOf(null)).toBeNull();
    expect(makeWeapon('m16', models)?.profile.kind).toBe('m16');
    expect(makeWeapon('ak', models)?.profile.kind).toBe('ak');
    const saw = makeWeapon('m249', models);
    expect(saw?.profile.placeholder).toBe(true);
    expect(makeWeapon(null, models)).toBeNull();
  });
});

describe('movement', () => {
  it('reads still, then the walking speed and direction from the positions', () => {
    const m = new SoldierMotion(logOf(walk(30, 90)), 'S1');
    const still = m.at(0.9);
    expect(still.speed).toBe(0);
    const moving = m.at(3);
    expect(moving.speed).toBeCloseTo(1.5, 9);
    expect(moving.moveAngle).toBeCloseTo(0, 9);
    // Facing south while moving north: walking backward.
    const back = new SoldierMotion(logOf(walk(0, 60, 1.5, { azimuth: Math.PI })), 'S1').at(1.5);
    expect(Math.abs(back.moveAngle)).toBeCloseTo(Math.PI, 9);
  });

  it('starts and stops over the look-back window, not at once', () => {
    const m = new SoldierMotion(logOf(walk(30, 90)), 'S1');
    const starting = m.at(1 + 0.15);
    expect(starting.speed).toBeGreaterThan(0.3);
    expect(starting.speed).toBeLessThan(1.2);
  });

  it('interpolates position and facing between ticks, exactly at ticks', () => {
    const steps = walk(0, 10).map((s, t) => ({ ...s, azimuth: t * 0.01 }));
    const m = new SoldierMotion(logOf(steps), 'S1');
    expect(m.at(4 / 30).y).toBe(steps[4]?.y);
    const half = m.at(4.5 / 30);
    expect(half.y).toBeCloseTo(((steps[4]?.y ?? 0) + (steps[5]?.y ?? 0)) / 2, 12);
    expect(half.azimuth).toBeCloseTo(0.045, 12);
  });

  it('chooses locomotion from the clips’ measured speeds', () => {
    const clips = asset.clips;
    const at = (speed: number) => locomotionBlend(clips, 'standing', speed, 0).weights;
    expect(at(0).get('idle')).toBe(1);
    const walkSpeed = slotSpeed(clips, 'walk');
    expect(at(walkSpeed).get('walk')).toBeCloseTo(1, 9);
    // The game's pace (1.5 m/s) and fleeing (4.5 m/s) blend continuously.
    const pace = at(1.5);
    expect((pace.get('walk') ?? 0) + (pace.get('run') ?? 0)).toBeCloseTo(1, 9);
    expect(at(4.5).get('run') ?? 0).toBeGreaterThan(0);
    for (const speed of [0, 0.7, 1.5, 3, 4.5, 7]) {
      const sum = [...at(speed).values()].reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 9);
    }
  });
});

describe('posture', () => {
  it('changes over a visual transition from the tick the simulation changed it', () => {
    const steps = walk(60, 0).map((s, t) => ({ ...s, posture: t >= 30 ? 'prone' : 'standing' }));
    const m = new SoldierMotion(logOf(steps as Step[]), 'S1');
    expect(m.at(0.5).posture).toBe('standing');
    const span = POSTURE_SECONDS.standing.prone;
    const mid = m.at((29 + 0.5 * span * 30) / 30);
    expect(mid.posture).toBe('prone');
    expect(mid.postureFrom).toBe('standing');
    expect(mid.postureT).toBeCloseTo(0.5, 6);
    expect(m.at((29 + span * 30) / 30 + 0.01).postureT).toBe(1);
  });
});

describe('weapon handling and combat', () => {
  const shot = (atSeconds: number): CombatEvent =>
    ({ type: 'shotFired', atSeconds, shooterId: 'S1' }) as unknown as CombatEvent;

  it('aims when engaging or after a shot, carries at patrol when moving, ready otherwise', () => {
    const idle = new SoldierMotion(logOf(walk(60, 0)), 'S1');
    expect(idle.at(1).carry).toBe('ready');
    const moving = new SoldierMotion(logOf(walk(0, 60)), 'S1');
    expect(moving.at(1).carry).toBe('lowered');
    const engaging = new SoldierMotion(logOf(walk(60, 0, 1.5, { behavior: 'engaging' })), 'S1');
    expect(engaging.at(1).carry).toBe('aimed');
    const firing = new SoldierMotion(logOf(walk(300, 0)), 'S1');
    firing.updateCombat([shot(2)]);
    expect(firing.at(1.9).carry).toBe('ready');
    expect(firing.at(2.1).carry).toBe('aimed');
    expect(firing.at(2.1).sinceShot).toBeCloseTo(0.1, 9);
    expect(firing.at(1.9).sinceShot).toBe(Infinity);
    expect(firing.at(2 + AIM_HOLD_S + 0.5).carry).toBe('ready');
  });

  it('shows a shot, recoil and flash from the shot’s exact time', () => {
    const steps = walk(120, 0);
    const p = new Puppet(asset, 'S1', makeWeapon('m16', models), logOf(steps));
    const surface = () => 0;
    p.pose(logOf(steps), [shot(2)], 2.01, surface);
    expect(p.view.weapon?.flash.visible).toBe(true);
    p.pose(logOf(steps), [shot(2)], 2.3, surface);
    expect(p.view.weapon?.flash.visible).toBe(false);
  });

  it('falls when incapacitated, and the fall finishes after the timeline ends', () => {
    const steps = walk(31, 0).map((s, t) => ({
      ...s,
      status: t >= 30 ? 'incapacitated' : 'active',
    })) as Step[];
    const log = logOf(steps);
    const m = new SoldierMotion(log, 'S1');
    m.updateCombat([
      { type: 'soldierIncapacitated', atSeconds: 0.98, soldierId: 'S1' } as unknown as CombatEvent,
    ]);
    expect(m.at(0.9).sinceDown).toBe(-1);
    expect(m.at(1).sinceDown).toBeCloseTo(0.02, 9);
    // Beyond the last tick (1 s): the position holds, the fall goes on.
    const after = m.at(1 + FALL_SECONDS);
    expect(after.sinceDown).toBeCloseTo(FALL_SECONDS + 0.02, 9);
    expect(after.y).toBe(0);
    const p = new Puppet(asset, 'S1', makeWeapon('m16', models), log);
    const head = (t: number) => {
      p.pose(log, [], t, () => 0);
      return p.view.bones.head?.getWorldPosition(new THREE.Vector3()).y ?? NaN;
    };
    expect(head(0.5)).toBeGreaterThan(1.3);
    // Without the combat log's event, the status change gives the time.
    expect(head(1 + FALL_SECONDS + 0.1)).toBeLessThan(0.4);
  });
});

describe('placement', () => {
  it('stands on the recorded surface (a bridge deck too), facing the simulation’s azimuth', () => {
    const steps = [{ x: 12, y: 34, z: 7.25, azimuth: Math.PI / 2 }];
    const p = new Puppet(asset, 'S1', null, logOf(steps));
    // The terrain under a bridge is lower: the root keeps the recorded deck height.
    p.pose(logOf(steps), [], 0, () => 2);
    const r = p.view.root;
    expect([r.position.x, r.position.y, r.position.z]).toEqual([12, 7.25, -34]);
    // Facing east (+x in three.js): the model's +Z turned to +X.
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(r.quaternion);
    expect(forward.x).toBeCloseTo(1, 9);
    expect(forward.z).toBeCloseTo(0, 9);
  });
});

describe('aftermath', () => {
  it('runs on only while the timeline has ended at the same moment', () => {
    const after = createAftermath();
    const log = logOf(walk(2, 0));
    const ended = { log, combatLog: [], seconds: 5, ended: true };
    expect(after(ended, 1000)).toBe(0);
    expect(after(ended, 1500)).toBeCloseTo(0.5, 9);
    expect(after(ended, 9000)).toBe(AFTERMATH_SECONDS);
    expect(after({ ...ended, seconds: 4 }, 9100)).toBe(0);
    expect(after({ ...ended, ended: false }, 9200)).toBe(0);
  });
});

describe('the character layer', () => {
  const unit = (id: string, affiliation: UnitMarker['affiliation']): UnitMarker =>
    ({
      id,
      affiliation,
      position: { x: 0, y: 0, z: 0 },
      azimuth: 0,
      posture: 'standing',
      status: 'active',
      selected: false,
    }) as UnitMarker;

  it('creates, updates and removes a soldier for each soldier shown', async () => {
    const assets: SoldierAssets = {
      soldier: asset,
      rifle: models.rifle,
      ak: models.ak,
      materials: { friendly: new Map(), enemy: new Map() },
      loadMs: 0,
    };
    const layer = createCharacterLayer(Promise.resolve(assets));
    await Promise.resolve();
    await Promise.resolve();
    expect(layer.ready).toBe(true);
    const log = createMotionRecorder(30);
    log.record({
      tick: 0,
      soldiers: ['M01', 'EN-1'].map((id) => ({
        id,
        side: id === 'M01' ? 'BLUEFOR' : 'OPFOR',
        position: { x: 0, y: 0, z: 0 },
        azimuth: 0,
        posture: 'standing',
        status: 'active',
      })),
    } as unknown as SimState);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
    camera.position.set(0, 2, 6);
    camera.lookAt(0, 1, 0);
    const frame = (units: UnitMarker[], weapons: Record<string, string>) => ({
      units,
      clock: { log, combatLog: [], seconds: 0 },
      weapons,
      surfaceAt: () => 0,
      camera,
      viewportHeightPx: 800,
    });
    layer.update(
      frame([unit('M01', 'friendly'), unit('EN-1', 'enemy')], {
        M01: 'm16-rifle',
        'EN-1': 'ak-assault-rifle',
      }),
    );
    expect(layer.stats().soldiers).toBe(2);
    expect(layer.stats().posed).toBe(2);
    expect([...layer.positions().keys()].sort()).toEqual(['EN-1', 'M01']);
    expect(layer.group.getObjectByName('soldier M01')).toBeDefined();
    // A soldier no longer shown is removed, with everything that was added for it.
    const before = layer.group.children.length;
    layer.update(frame([unit('M01', 'friendly')], { M01: 'm16-rifle' }));
    expect(layer.stats().soldiers).toBe(1);
    expect(layer.group.getObjectByName('soldier EN-1')).toBeUndefined();
    expect(layer.group.children.length).toBeLessThan(before);
    // A soldier not in the motion log is not drawn.
    layer.update(frame([unit('M01', 'friendly'), unit('X9', 'enemy')], { M01: 'm16-rifle' }));
    expect(layer.stats().soldiers).toBe(1);
    layer.dispose();
    expect(layer.group.children.length).toBe(0);
  });
});
