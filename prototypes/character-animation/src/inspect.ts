/**
 * Clip inspector: the three characters side by side playing one canonical
 * clip slot (or their rest pose), to judge retargeting and clip coverage.
 * `window.inspect(slot, time)` drives it from scripts.
 */

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { boneOf, type CharacterId, loadAssets } from './assets';
import { type BoneKey, CLIP_SLOTS, type ClipSlot } from './rigs';
import { retargetSettings, type RetargetMethod } from './retarget';
import { createStage } from './scene';

const params = new URLSearchParams(location.search);
retargetSettings.method = (params.get('retarget') as RetargetMethod | null) ?? 'rest-aligned';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const bar = document.getElementById('bar') as HTMLDivElement;
const stage = createStage(canvas);
stage.camera.position.set(0, 1.6, 6.5);
stage.controls.target.set(0, 0.95, 0);
stage.controls.update();

const assets = await loadAssets((m) => (bar.textContent = m));
(window as unknown as Record<string, unknown>)['assets'] = assets;
const ids: CharacterId[] = ['rocketbox', 'mannequin', 'quaternius', 'kaykit'];
const insts = ids.map((id, i) => {
  const a = assets.characters[id];
  if (!a) throw new Error(id);
  const o = SkeletonUtils.clone(a.template);
  o.position.x = (i - 1.5) * 1.5;
  stage.scene.add(o);
  const helper = new THREE.SkeletonHelper(o);
  helper.visible = params.has('bones');
  stage.scene.add(helper);
  return { a, o, mixer: new THREE.AnimationMixer(o) };
});

let slot: ClipSlot | 'rest' = 'rest';
let playing = !params.has('paused');
const select = document.createElement('select');
for (const s of ['rest', ...CLIP_SLOTS]) select.add(new Option(s, s));
select.onchange = () => {
  apply(select.value as ClipSlot | 'rest', 0);
};
const label = document.createElement('span');
bar.textContent = '';
bar.append(select, ' ', label);

function apply(s: ClipSlot | 'rest', t: number) {
  slot = s;

  select.value = s;
  const parts: string[] = [];
  for (const { a, mixer } of insts) {
    mixer.stopAllAction();
    const src = s === 'rest' ? undefined : a.clips[s];
    if (src) {
      mixer.clipAction(src.clip).play();
      mixer.setTime(t % src.clip.duration);
    } else {
      mixer.setTime(0);
    }
    parts.push(`${a.id}: ${s === 'rest' ? 'rest' : src ? src.origin : 'MISSING'}`);
  }
  label.textContent = parts.join(' | ');
}

(window as unknown as Record<string, unknown>)['inspect'] = (s: ClipSlot | 'rest', t: number) => {
  playing = false;
  apply(s, t);
  stage.renderer.render(stage.scene, stage.camera);
  return label.textContent;
};
apply((params.get('slot') as ClipSlot | null) ?? 'rest', 0);

let last = performance.now();
stage.renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  stage.resize();
  if (playing && slot !== 'rest') {
    for (const { mixer } of insts) mixer.update(dt);
  }
  stage.renderer.render(stage.scene, stage.camera);
});
(window as unknown as Record<string, unknown>)['inspectReady'] = true;

// Debug: world directions of limb bones (bone → child) per character, to compare retargets.
(window as unknown as Record<string, unknown>)['limbDirs'] = (s: ClipSlot, t: number) => {
  apply(s, t);
  const out: Record<string, string> = {};
  const pairs: [string, string][] = [
    ['upperArmR', 'lowerArmR'],
    ['lowerArmR', 'handR'],
    ['upperArmL', 'lowerArmL'],
    ['lowerArmL', 'handL'],
    ['spine1', 'head'],
    ['upperLegL', 'lowerLegL'],
  ];
  for (const { a, o } of insts) {
    o.updateMatrixWorld(true);
    const parts: string[] = [];
    for (const [p, c] of pairs) {
      const bp = boneOf(o, a.rig, p as BoneKey);
      const bc = boneOf(o, a.rig, c as BoneKey);
      if (!bp || !bc) continue;
      const d = bc
        .getWorldPosition(new THREE.Vector3())
        .sub(bp.getWorldPosition(new THREE.Vector3()))
        .normalize();
      parts.push(`${p}:${d.x.toFixed(2)},${d.y.toFixed(2)},${d.z.toFixed(2)}`);
    }
    out[a.id] = parts.join(' ');
  }
  return out;
};

// Debug: foot and toe trajectories of a slot over one loop.
(window as unknown as Record<string, unknown>)['footTrack'] = (id: CharacterId, s: ClipSlot) => {
  const inst = insts.find((i) => i.a.id === id);
  const src = inst?.a.clips[s];
  if (!inst || !src) return 'missing';
  const rows: string[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = (src.clip.duration * i) / 24;
    apply(s, t);
    inst.o.updateMatrixWorld(true);
    const f = (k: BoneKey) => {
      const b = boneOf(inst.o, inst.a.rig, k);
      const p = b ? b.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
      return `${p.y.toFixed(3)}/${p.z.toFixed(3)}`;
    };
    rows.push(`${t.toFixed(2)} L ${f('footL')} ${f('toesL')}  R ${f('footR')} ${f('toesR')}`);
  }
  return rows.join('\n');
};
