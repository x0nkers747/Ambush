import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  combatEventOf,
  createMotionRecorder,
  type CombatEvent,
  type MotionRecorder,
} from '#exercise';
import { labTerrain } from '#exercise/behavior-lab';
import { createBattle } from '#exercise/battle';
import { surfaceHeightAt, type TerrainDataset } from '#sim';
import {
  type BakedCharacter,
  type CharacterAsset,
  clipsFromBaked,
  skeletonFromBaked,
} from './asset';
import { fingerprint, fingerprintDistance, type PoseFingerprint } from './fingerprint';
import { Puppet } from './puppet';
import { makeWeapon, weaponKindOf } from './weapon-map';

// Exact animation replay (docs/character-animation.md): a soldier's pose at a
// simulation time is the same live and in the After Action Review, at any
// playback speed, whether the time is reached by playing, pausing or seeking
// in any order. The real soldier's skeleton and clips (the baked file),
// posed by the game's animation code, over a fought battle.

/** Exact: bit-for-bit the same numbers (positions, rotations, weights, times). */
const TOLERANCE = 0;

/** What the characters are posed from: a battle's logs, its soldiers' weapons and its ground. */
interface Fight {
  readonly motionLog: MotionRecorder;
  readonly combatLog: CombatEvent[];
  readonly combatWeapons: Readonly<Record<string, string | null>>;
  readonly simulation: { readonly world: { readonly terrain: TerrainDataset } };
}

let asset: CharacterAsset;
const models = (() => {
  const rifle = new THREE.Group();
  rifle.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 1)));
  return { rifle, ak: rifle };
})();

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

function puppets(fight: Fight, ids: readonly string[]): Puppet[] {
  return ids.map(
    (id) =>
      new Puppet(
        asset,
        id,
        makeWeapon(weaponKindOf(fight.combatWeapons[id]), models),
        fight.motionLog,
      ),
  );
}

function poseAll(fight: Fight, ps: readonly Puppet[], seconds: number): PoseFingerprint[] {
  const terrain = fight.simulation.world.terrain;
  const surface = (x: number, y: number) => surfaceHeightAt(terrain, x, y);
  return ps.map((p) => {
    p.pose(fight.motionLog, fight.combatLog, seconds, surface);
    return fingerprint(p);
  });
}

interface Played {
  fight: Fight;
  ids: string[];
  /** Live poses: (render time, fingerprints) taken while the battle was fought. */
  live: { seconds: number; poses: PoseFingerprint[] }[];
}

/**
 * A battle fought until soldiers have fallen (two squads attacking each
 * other across open ground), with soldiers posed live every frame at
 * irregular frame times, as the page does.
 */
function play(): Played {
  const battle = createBattle(
    {
      seed: 7,
      tickRateHz: 30,
      squads: [
        {
          id: 'B1',
          name: 'B1',
          side: 'BLUEFOR',
          organization: 'squad',
          position: { x: 0, y: -250 },
          facingDeg: 0,
          plan: [{ kind: 'attack', destination: { x: 0, y: 250 } }],
        },
        {
          id: 'O1',
          name: 'O1',
          side: 'OPFOR',
          organization: 'squad',
          position: { x: 0, y: 250 },
          facingDeg: 180,
          plan: [{ kind: 'attack', destination: { x: 0, y: -250 } }],
        },
      ],
    },
    labTerrain(),
  );
  const rate = battle.spec.tickRateHz;
  const motionLog = createMotionRecorder(rate);
  motionLog.record(battle.sim.state);
  const combatWeapons: Record<string, string | null> = {};
  for (const squad of battle.squads) Object.assign(combatWeapons, squad.displayWeapons);
  const fight: Fight = {
    motionLog,
    combatLog: [],
    combatWeapons,
    simulation: { world: battle.sim.world },
  };
  const soldiers = battle.sim.state.soldiers;
  // Two Marines (one with the SAW) and two of the enemy.
  const saw = soldiers.find((s) => combatWeapons[s.id] === 'squad-automatic-weapon');
  const blufor = soldiers.filter((s) => s.side === 'BLUEFOR');
  const opfor = soldiers.filter((s) => s.side === 'OPFOR');
  const ids = [...new Set([saw ?? blufor[0], blufor[1], opfor[0], opfor[1]])]
    .filter((s) => s !== undefined)
    .map((s) => s.id);
  const ps = puppets(fight, ids);
  const live: Played['live'] = [];
  let frame = 0;
  let clock = 0;
  // Irregular frames (6 to 37 ms) at 8×, posing every frame; keep every 25th.
  const step = () => {
    frame += 1;
    clock += (8 * (6 + ((frame * 7919) % 31))) / 1000;
    // The battle a tick ahead of the time posed, as Combat keeps it (the
    // pose at a time may read the tick after it).
    while (battle.sim.tick < Math.ceil(clock * rate) + 1) {
      for (const e of battle.step()) {
        const c = combatEventOf(e);
        if (c) fight.combatLog.push(c);
      }
      motionLog.record(battle.sim.state);
    }
    const poses = poseAll(fight, ps, clock);
    if (frame % 25 === 0) live.push({ seconds: clock, poses });
  };
  const fallen = () => battle.sim.state.soldiers.filter((s) => s.status !== 'active').length;
  while (clock < 900 && fallen() < 4) step();
  if (fallen() < 4) throw new Error('nobody fell');
  // A little more: the falls run their course.
  for (let i = 0; i < 100; i += 1) step();
  return { fight, ids, live };
}

let played: Played;
beforeAll(() => {
  played = play();
}, 120000);

/** Check times: moving, firing, recoil, incapacitation, posture changes, the end. */
function checkTimes(fight: Fight): number[] {
  const rate = fight.motionLog.tickRateHz;
  const times = new Set<number>();
  const firstShot = fight.combatLog.find((e) => e.type === 'shotFired')?.atSeconds ?? 0;
  for (const dt of [-20, -6.4, -1.03, 0, 0.5]) times.add(firstShot + dt);
  for (const e of fight.combatLog.slice(0, 40)) {
    if (e.type === 'shotFired') {
      times.add(e.atSeconds);
      times.add(e.atSeconds + 0.017);
      times.add(e.atSeconds + 0.21);
    }
    if (e.type === 'soldierIncapacitated') {
      times.add(e.atSeconds + 0.1);
      times.add(e.atSeconds + 0.7);
    }
  }
  times.add(fight.motionLog.lastTick / rate);
  return [...times].filter((t) => t >= 0).sort((a, b) => a - b);
}

function compare(
  name: string,
  reference: Map<number, PoseFingerprint[]>,
  other: Map<number, PoseFingerprint[]>,
): number {
  let worst = 0;
  for (const [t, ref] of reference) {
    const got = other.get(t);
    expect(got, `${name}: no pose at ${String(t)}`).toBeDefined();
    ref.forEach((r, i) => {
      const g = got?.[i];
      if (!g) throw new Error(`${name}: missing soldier ${String(i)} at ${String(t)}`);
      expect(g.state, `${name} at t=${String(t)}`).toBe(r.state);
      const d = fingerprintDistance(r, g);
      worst = Math.max(worst, d);
    });
  }
  return worst;
}

describe('animation replay', () => {
  it('poses the soldiers live, and the review reproduces every live pose exactly', () => {
    const { fight, ids, live } = played;
    expect(live.length).toBeGreaterThan(20);
    const ps = puppets(fight, ids);
    let worst = 0;
    // Reconstructed backwards, on fresh soldiers: no history from playing.
    for (const { seconds, poses } of [...live].reverse()) {
      const again = poseAll(fight, ps, seconds);
      poses.forEach((p, i) => {
        const a = again[i];
        if (!a) throw new Error('missing');
        expect(a.state).toBe(p.state);
        worst = Math.max(worst, fingerprintDistance(p, a));
      });
    }
    expect(worst).toBeLessThanOrEqual(TOLERANCE);
  });

  it('gives the same pose at a time however the time is reached', () => {
    const { fight, ids } = played;
    const times = checkTimes(fight);
    expect(times.length).toBeGreaterThan(10);
    const start = Math.max(0, (times[0] ?? 0) - 1);
    const end = times[times.length - 1] ?? 0;

    /** Continuous playback at `step` seconds per frame, from `start`, keeping the check times. */
    const playback = (step: (frame: number) => number) => {
      const ps = puppets(fight, ids);
      const out = new Map<number, PoseFingerprint[]>();
      const pending = [...times];
      let t = start;
      for (let frame = 0; pending.length > 0; frame += 1) {
        const next = pending[0] ?? end;
        const target = Math.min(t + step(frame), next);
        t = target;
        const poses = poseAll(fight, ps, t);
        if (t === next) out.set(pending.shift() ?? next, poses);
      }
      return out;
    };
    const seeks = (order: readonly number[], ps = puppets(fight, ids)) => {
      const out = new Map<number, PoseFingerprint[]>();
      for (const t of order) out.set(t, poseAll(fight, ps, t));
      return out;
    };

    const reference = playback(() => 1 / 60);
    const shuffled = [...times].sort((a, b) => Math.sin(a * 977) - Math.sin(b * 977));
    const results: Record<string, number> = {
      '144 Hz': compare(
        '144 Hz',
        reference,
        playback(() => 1 / 144),
      ),
      'irregular frames': compare(
        'irregular',
        reference,
        playback((f) => (4 + ((f * 7919) % 33)) / 1000),
      ),
      'slow motion 0.25×': compare(
        '0.25×',
        reference,
        playback(() => 0.25 / 60),
      ),
      'fast forward 16×': compare(
        '16×',
        reference,
        playback(() => 16 / 60),
      ),
      'seek forward': compare('seek forward', reference, seeks(times)),
      'seek backward': compare('seek backward', reference, seeks([...times].reverse())),
      'seek shuffled': compare('seek shuffled', reference, seeks(shuffled)),
      'repeated seeks': compare(
        'repeated',
        reference,
        (() => {
          const ps = puppets(fight, ids);
          seeks(shuffled, ps);
          seeks(times, ps);
          return seeks([...times].reverse(), ps);
        })(),
      ),
    };
    for (const [name, d] of Object.entries(results)) expect(d, name).toBeLessThanOrEqual(TOLERANCE);
  }, 120000);
});
