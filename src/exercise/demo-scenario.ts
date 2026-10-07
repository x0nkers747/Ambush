import {
  createSyntheticTerrain,
  rectangle,
  type Building,
  type Road,
  type ScenarioSoldier,
  type VegetationArea,
  type Vec2,
} from '#sim';
import type { AmbushScenario, OpforRoute } from './ambush-scenario';

// Development content for the interactive ambush slice (Phases 3–3.6), not the
// doctrinal ambush scenario. A BLUEFOR rifle squad in the south; a three-soldier
// OPFOR patrol in the north whose route follows the valley road south through
// a small hamlet. 800 m × 600 m of synthetic terrain designed so that planning
// choices matter (docs/adr/0011):
//
// - a low east–west ridge between the squad and the hamlet masks the road from
//   positions behind it;
// - a wooded ridge to the west gives height but its woods obscure the view;
// - a barn west of the road blocks the view from the south-west; a low shed
//   west of the hamlet does not;
// - a dense tree line east of the road screens the fields beyond it;
// - a cottage stands on the squad's direct line north, so routes bend round it.

/** Smooth bump of `height` metres centred on (cx, cy) with spread `sigma` metres. */
function bump(x: number, y: number, cx: number, cy: number, height: number, sigma: number): number {
  return height * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma ** 2));
}

/** Centre line of the valley (the draw the road follows). */
const drawCentreX = (y: number) => 40 * Math.sin(y / 110);

function demoElevation(x: number, y: number): number {
  // The draw: a shallow valley meandering north–south.
  const draw = -9 * Math.exp(-((x - drawCentreX(y)) ** 2) / (2 * 30 ** 2));
  // West ridge: a long north–south ridge, highest in the middle of the map.
  const westRidge =
    18 * Math.exp(-((x + 170) ** 2) / (2 * 45 ** 2)) * Math.exp(-((y - 20) ** 2) / (2 * 170 ** 2));
  // South ridge: a low east–west ridge at y = −130 with a saddle where the road crosses.
  const saddle = 1 - 0.75 * Math.exp(-((x + 20) ** 2) / (2 * 25 ** 2));
  const southRidge =
    7 * saddle * Math.exp(-((y + 130) ** 2) / (2 * 14 ** 2)) * Math.exp(-(x ** 2) / (2 * 170 ** 2));
  return (
    100 +
    0.025 * y +
    draw +
    westRidge +
    southRidge +
    bump(x, y, 250, 170, 22, 85) + // north-east hill
    bump(x, y, -270, -60, 10, 55) - // west knoll
    bump(x, y, 150, -40, 5, 25) // a hollow east of the tree line
  );
}

const roads: Road[] = [
  {
    id: 'R-1',
    roadClass: 'unpaved',
    widthMeters: 6,
    centerline: [300, 230, 160, 100, 40, -10, -60, -110]
      .map((y): Vec2 => ({ x: drawCentreX(y), y }))
      .concat([
        { x: -10, y: -150 },
        { x: 40, y: -170 },
        { x: 120, y: -185 },
        { x: 220, y: -195 },
        { x: 395, y: -205 },
      ]),
  },
  {
    id: 'R-2',
    roadClass: 'track',
    widthMeters: 3,
    centerline: [
      { x: -4, y: -10 },
      { x: -60, y: 5 },
      { x: -120, y: 30 },
      { x: -200, y: 40 },
    ],
  },
];

const buildings: Building[] = [
  { id: 'B-1', footprint: rectangle(35, 15, 14, 10, 20), heightMeters: 7 }, // farmhouse
  { id: 'B-2', footprint: rectangle(-45, -40, 22, 12, -10), heightMeters: 9 }, // barn
  { id: 'B-3', footprint: rectangle(-50, 25, 6, 5), heightMeters: 1.5 }, // low shed: most lines of sight pass over it
  { id: 'B-4', footprint: rectangle(55, 65, 12, 9, 15), heightMeters: 6 }, // house
  {
    id: 'B-5', // L-shaped workshop
    footprint: [
      { x: 64, y: -32 },
      { x: 88, y: -32 },
      { x: 88, y: -24 },
      { x: 72, y: -24 },
      { x: 72, y: -6 },
      { x: 64, y: -6 },
    ],
    heightMeters: 5,
  },
  { id: 'B-6', footprint: rectangle(-72, -185, 16, 10, 5), heightMeters: 6 }, // cottage
  { id: 'B-7', footprint: rectangle(72, 190, 12, 10), heightMeters: 7 }, // house
  { id: 'B-8', footprint: rectangle(-25, 100, 10, 18), heightMeters: 12 }, // chapel
];

const vegetation: VegetationArea[] = [
  {
    id: 'V-1',
    kind: 'woodland',
    boundary: [
      { x: -165, y: -70 },
      { x: -115, y: -80 },
      { x: -95, y: -20 },
      { x: -100, y: 60 },
      { x: -140, y: 95 },
      { x: -180, y: 30 },
    ],
    canopyHeightMeters: 15,
    seeThroughMeters: 25,
  },
  {
    id: 'V-2',
    kind: 'treeLine',
    boundary: [
      { x: 100, y: -80 },
      { x: 108, y: -80 },
      { x: 112, y: 80 },
      { x: 104, y: 80 },
    ],
    canopyHeightMeters: 9,
    seeThroughMeters: 6,
  },
  {
    id: 'V-3',
    kind: 'scrub',
    boundary: rectangle(-95, -110, 40, 25),
    canopyHeightMeters: 4,
    seeThroughMeters: 60,
  },
  {
    id: 'V-4',
    kind: 'woodland',
    boundary: [0, 1, 2, 3, 4, 5].map((k) => ({
      x: 175 + 22 * Math.cos((k * Math.PI) / 3),
      y: 40 + 18 * Math.sin((k * Math.PI) / 3),
    })),
    canopyHeightMeters: 14,
    seeThroughMeters: 20,
  },
  {
    id: 'V-5',
    kind: 'woodland',
    boundary: [
      { x: -390, y: 160 },
      { x: -250, y: 170 },
      { x: -230, y: 240 },
      { x: -290, y: 295 },
      { x: -390, y: 295 },
    ],
    canopyHeightMeters: 16,
    seeThroughMeters: 25,
  },
  {
    id: 'V-6',
    kind: 'scrub',
    boundary: rectangle(130, -120, 50, 20, 10),
    canopyHeightMeters: 3,
    seeThroughMeters: 40,
  },
];

const blufor = (id: string, unitId: string, x: number, y: number): ScenarioSoldier => ({
  id,
  side: 'BLUEFOR',
  unitId,
  position: { x, y },
  azimuthDeg: 0,
  posture: 'standing',
});

const opfor = (id: string, x: number, y: number): ScenarioSoldier => ({
  id,
  side: 'OPFOR',
  unitId: 'EN-TM',
  position: { x, y },
  azimuthDeg: 180,
  posture: 'standing',
});

/** The OPFOR patrol follows the road south through the hamlet, then east. */
const PATROL_ROUTE: readonly Vec2[] = [
  ...[160, 100, 40, -10, -60, -110].map((y) => ({ x: drawCentreX(y), y })),
  { x: -10, y: -150 },
  { x: 40, y: -170 },
  { x: 120, y: -185 },
];

const patrolRoute = (soldierId: string): OpforRoute => ({
  id: `${soldierId}-patrol`,
  soldierId,
  waypoints: PATROL_ROUTE.map(({ x, y }, i) => ({
    id: `${soldierId}-patrol.${String(i + 1)}`,
    x,
    y,
  })),
  finalFacingDeg: 90,
  shownToTrainee: true,
});

export const DEMO_SCENARIO: AmbushScenario = {
  id: 'phase3-demo',
  terrain: createSyntheticTerrain(
    { originX: -400, originY: -300, cellSize: 5, columns: 161, rows: 121 },
    demoElevation,
    { roads, buildings, vegetation },
  ),
  movement: { speed: 1.5, maxTurnRate: Math.PI / 2 },
  units: [
    { id: 'SQD', echelon: 'squad', parentId: null, leaderId: 'SL' },
    { id: 'A-TM', echelon: 'fireTeam', parentId: 'SQD', leaderId: 'A-TL' },
    { id: 'B-TM', echelon: 'fireTeam', parentId: 'SQD', leaderId: 'B-TL' },
    { id: 'EN-TM', echelon: 'fireTeam', parentId: null, leaderId: 'EN-1' },
  ],
  soldiers: [
    blufor('SL', 'SQD', -60, -240),
    blufor('A-TL', 'A-TM', -80, -225),
    blufor('A-AR', 'A-TM', -88, -232),
    blufor('A-GR', 'A-TM', -74, -234),
    blufor('A-RFL', 'A-TM', -82, -241),
    blufor('B-TL', 'B-TM', -40, -225),
    blufor('B-AR', 'B-TM', -32, -232),
    blufor('B-GR', 'B-TM', -46, -234),
    blufor('B-RFL', 'B-TM', -38, -241),
    // A file 12 m apart on the road, heading south.
    opfor('EN-1', drawCentreX(250), 250),
    opfor('EN-2', drawCentreX(262), 262),
    opfor('EN-3', drawCentreX(274), 274),
  ],
  opforRoutes: [patrolRoute('EN-1'), patrolRoute('EN-2'), patrolRoute('EN-3')],
};
