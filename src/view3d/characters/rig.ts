// The soldier's skeleton (docs/character-animation.md): canonical bone names
// (VRM-like) that the animator, layer masks, the weapon hold and IK are
// written against, mapped onto the rig's own bones; and the clip slots.

export type BoneKey =
  | 'hips'
  | 'spine1'
  | 'spine2'
  | 'spine3'
  | 'neck'
  | 'head'
  | 'shoulderL'
  | 'upperArmL'
  | 'lowerArmL'
  | 'handL'
  | 'shoulderR'
  | 'upperArmR'
  | 'lowerArmR'
  | 'handR'
  | 'upperLegL'
  | 'lowerLegL'
  | 'footL'
  | 'toesL'
  | 'upperLegR'
  | 'lowerLegR'
  | 'footR'
  | 'toesR';

export type RigId = 'rocketbox';

/** Rig bone names (three.js names: spaces become underscores). */
export const RIG_BONES: Record<RigId, Partial<Record<BoneKey, string>>> = {
  // Microsoft Rocketbox (3ds Max Biped).
  rocketbox: {
    hips: 'Bip01_Pelvis',
    spine1: 'Bip01_Spine',
    spine2: 'Bip01_Spine1',
    spine3: 'Bip01_Spine2',
    neck: 'Bip01_Neck',
    head: 'Bip01_Head',
    shoulderL: 'Bip01_L_Clavicle',
    upperArmL: 'Bip01_L_UpperArm',
    lowerArmL: 'Bip01_L_Forearm',
    handL: 'Bip01_L_Hand',
    shoulderR: 'Bip01_R_Clavicle',
    upperArmR: 'Bip01_R_UpperArm',
    lowerArmR: 'Bip01_R_Forearm',
    handR: 'Bip01_R_Hand',
    upperLegL: 'Bip01_L_Thigh',
    lowerLegL: 'Bip01_L_Calf',
    footL: 'Bip01_L_Foot',
    toesL: 'Bip01_L_Toe0',
    upperLegR: 'Bip01_R_Thigh',
    lowerLegR: 'Bip01_R_Calf',
    footR: 'Bip01_R_Foot',
    toesR: 'Bip01_R_Toe0',
  },
};

/** The upper-body layer's root bone (the legs are taken out: see clip-bank.ts). */
export const UPPER_BODY_ROOT: BoneKey = 'spine1';

/** The clips a soldier plays (prototypes/character-animation/src/bake.ts). */
export type ClipSlot =
  | 'idle'
  | 'walk'
  | 'walkBack'
  | 'walkLeft'
  | 'walkRight'
  | 'run'
  | 'runBack'
  | 'runLeft'
  | 'runRight'
  | 'sprint'
  | 'kneelIdle'
  | 'kneelWalk'
  | 'proneIdle'
  | 'crawl'
  | 'death';

export type Posture = 'standing' | 'kneeling' | 'prone';
/** How the weapon is carried: patrol (lowered), low ready, or aimed. */
export type Carry = 'lowered' | 'ready' | 'aimed';

const TAU = Math.PI * 2;
export const wrapAngle = (a: number) => ((a % TAU) + TAU) % TAU;
/** Signed shortest difference b − a in (−π, π]. */
export const angleDelta = (a: number, b: number) => {
  const d = wrapAngle(b - a);
  return d > Math.PI ? d - TAU : d;
};
