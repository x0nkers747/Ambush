// Downloads the prototype's characters, clips and props into public/assets/
// (git-ignored). Run once: `npm run assets` in prototypes/character-animation.
//
// Nothing downloaded here is committed. Every source below is openly licensed
// (CC0, CC BY or MIT); see ../ASSETS.md for authors, licences and conditions.
// Rocketbox textures are 2048² TGAs (~90 MB); when ffmpeg is on the PATH they
// are converted to 1024² JPEGs and the TGAs are deleted.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'public', 'assets');

const M2M = 'https://raw.githubusercontent.com/Mesh2Motion/mesh2motion-app/main/static';
const ROCKETBOX =
  'https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets/Avatars/Professions/Military_Male_01';

/** [destination relative to public/assets, source URL] */
const FILES = [
  // Mesh2Motion (CC0): animation libraries on its human rig, a SWAT model on the same rig, props.
  ['m2m/human-base-animations.glb', `${M2M}/animations/human-base-animations.glb`],
  ['m2m/human-addon-animations.glb', `${M2M}/animations/human-addon-animations.glb`],
  ['m2m/human-mocap-animations.glb', `${M2M}/animations/human-mocap-animations.glb`],
  ['m2m/swat_male.glb', `${M2M}/models-variation/human/swat_male.glb`],
  ['m2m/AK.glb', `${M2M}/props/AK.glb`],
  [
    'm2m/LICENSE-CC0.MD',
    'https://raw.githubusercontent.com/Mesh2Motion/mesh2motion-app/main/LICENSE-CC0.MD',
  ],
  // Quaternius "Soldier" (Ultimate Modular Men; CC0 at quaternius.com, CC BY 3.0 on Poly Pizza).
  ['quaternius/soldier.glb', 'https://static.poly.pizza/66a55d04-4286-44a3-b289-0d774c27db5b.glb'],
  // Microsoft Rocketbox Military_Male_01 (MIT).
  ['rocketbox/Military_Male_01.fbx', `${ROCKETBOX}/Export/Military_Male_01.fbx`],
  [
    'rocketbox/LICENSE.md',
    'https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/LICENSE.md',
  ],
  ...['body', 'head', 'helmet', 'equipment'].flatMap((part) => {
    const colour = part === 'head' ? 'color' : 'color_acu';
    return [
      [
        `rocketbox/sm002_${part}_${colour}.tga`,
        `${ROCKETBOX}/Textures/sm002_${part}_${colour}.tga`,
      ],
      [`rocketbox/sm002_${part}_normal.tga`, `${ROCKETBOX}/Textures/sm002_${part}_normal.tga`],
    ];
  }),
];

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const ffmpeg = hasFfmpeg();
for (const [dest, url] of FILES) {
  const file = join(ROOT, dest);
  const jpg = file.replace(/\.tga$/, '.jpg');
  if (existsSync(file) || (file.endsWith('.tga') && existsSync(jpg))) {
    console.log('have', dest);
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${String(response.status)}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  console.log('got ', dest);
  if (file.endsWith('.tga') && ffmpeg) {
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      file,
      '-vf',
      'scale=1024:-1',
      '-q:v',
      '3',
      jpg,
    ]);
    rmSync(file);
    console.log('  →', dest.replace(/\.tga$/, '.jpg'));
  }
}
if (!ffmpeg)
  console.log('ffmpeg not found: Rocketbox textures stay as TGA (loaded with TGALoader).');
