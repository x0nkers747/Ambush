/**
 * The three test characters and how their skeletons map onto one canonical
 * set of humanoid bones (VRM-like names), which is what retargeting, layer
 * masks and IK are written against.
 */

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

export const BONE_KEYS: readonly BoneKey[] = [
  'hips',
  'spine1',
  'spine2',
  'spine3',
  'neck',
  'head',
  'shoulderL',
  'upperArmL',
  'lowerArmL',
  'handL',
  'shoulderR',
  'upperArmR',
  'lowerArmR',
  'handR',
  'upperLegL',
  'lowerLegL',
  'footL',
  'toesL',
  'upperLegR',
  'lowerLegR',
  'footR',
  'toesR',
];

/** Bones above the hips that the upper-body layer owns (spine, arms, head). */
export const UPPER_BODY_ROOT: BoneKey = 'spine1';

export type RigId = 'm2m' | 'quaternius' | 'rocketbox' | 'kaykit';

/** Canonical bone → bone name in the rig (after three.js name sanitising). */
export const RIG_BONES: Record<RigId, Partial<Record<BoneKey, string>>> = {
  // Mesh2Motion human rig (Unreal-mannequin naming).
  m2m: {
    hips: 'pelvis',
    spine1: 'spine_01',
    spine2: 'spine_02',
    spine3: 'spine_03',
    neck: 'neck_01',
    head: 'head',
    shoulderL: 'clavicle_l',
    upperArmL: 'upperarm_l',
    lowerArmL: 'lowerarm_l',
    handL: 'hand_l',
    shoulderR: 'clavicle_r',
    upperArmR: 'upperarm_r',
    lowerArmR: 'lowerarm_r',
    handR: 'hand_r',
    upperLegL: 'thigh_l',
    lowerLegL: 'calf_l',
    footL: 'foot_l',
    toesL: 'ball_l',
    upperLegR: 'thigh_r',
    lowerLegR: 'calf_r',
    footR: 'foot_r',
    toesR: 'ball_r',
  },
  // Quaternius "CharacterArmature" (Blender names with ".L"/".R"; three.js drops the dot).
  quaternius: {
    hips: 'Hips',
    spine1: 'Abdomen',
    spine2: 'Torso',
    spine3: 'Chest',
    neck: 'Neck',
    head: 'Head',
    shoulderL: 'ShoulderL',
    upperArmL: 'UpperArmL',
    lowerArmL: 'LowerArmL',
    handL: 'WristL',
    shoulderR: 'ShoulderR',
    upperArmR: 'UpperArmR',
    lowerArmR: 'LowerArmR',
    handR: 'WristR',
    upperLegL: 'UpperLegL',
    lowerLegL: 'LowerLegL',
    footL: 'FootL',
    upperLegR: 'UpperLegR',
    lowerLegR: 'LowerLegR',
    footR: 'FootR',
  },
  // KayKit Character Animations "Rig_Medium" (two spine bones, no neck, clavicles or fingers).
  kaykit: {
    hips: 'hips',
    spine1: 'spine',
    spine2: 'chest',
    head: 'head',
    upperArmL: 'upperarml',
    lowerArmL: 'lowerarml',
    handL: 'wristl',
    upperArmR: 'upperarmr',
    lowerArmR: 'lowerarmr',
    handR: 'wristr',
    upperLegL: 'upperlegl',
    lowerLegL: 'lowerlegl',
    footL: 'footl',
    toesL: 'toesl',
    upperLegR: 'upperlegr',
    lowerLegR: 'lowerlegr',
    footR: 'footr',
    toesR: 'toesr',
  },
  // 3ds Max Biped (Rocketbox); FBXLoader turns spaces into underscores.
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

/**
 * The canonical clip slots the animators use. A character fills the slots
 * its clips cover; a missing slot is reported, never faked.
 */
export type ClipSlot =
  | 'idle'
  | 'idleReady'
  | 'aim'
  | 'aimUp'
  | 'aimDown'
  | 'walk'
  | 'walkBack'
  | 'walkLeft'
  | 'walkRight'
  | 'run'
  | 'runRifle'
  | 'runBack'
  | 'runLeft'
  | 'runRight'
  | 'sprint'
  | 'kneelIdle'
  | 'kneelWalk'
  | 'toProne'
  | 'proneIdle'
  | 'crawl'
  | 'getUp'
  | 'fire'
  | 'reload'
  | 'hit'
  | 'death'
  | 'turnLeft'
  | 'turnRight';

export const CLIP_SLOTS: readonly ClipSlot[] = [
  'idle',
  'idleReady',
  'aim',
  'aimUp',
  'aimDown',
  'walk',
  'walkBack',
  'walkLeft',
  'walkRight',
  'run',
  'runRifle',
  'runBack',
  'runLeft',
  'runRight',
  'sprint',
  'kneelIdle',
  'kneelWalk',
  'toProne',
  'proneIdle',
  'crawl',
  'getUp',
  'fire',
  'reload',
  'hit',
  'death',
  'turnLeft',
  'turnRight',
];
