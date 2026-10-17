import { deepFreeze } from '../shared-terrain';
import type {
  AmmoSpec,
  CombatWeaponSpec,
  InfantryEffect,
  PlatformSpec,
  TargetingConfig,
} from './types';

// The catalog (docs/combined-arms.md §2–§4, "Reference values"): four
// platforms (M113A3, M1A1, BMP-2, T-72B), their weapons and ammunition, and
// the infantry anti-tank weapons (M136 AT4, FGM-148 Javelin, RPG-7V with
// PG-7VL, 9K111 Fagot). Values are representative approximations from open
// sources, rounded, for a credible and measurable model, not authoritative
// figures: protection is RHA-equivalent millimetres per face (an average of
// the face's turret and hull, angled), penetration nominal at 0° by range.

// --- Effects on soldiers --------------------------------------------------------

/** A heavy machine gun's burst at soldiers (M2HB). */
const HMG_VS_INFANTRY: InfantryEffect = {
  hitProbabilityByRange: [
    { rangeM: 0, probability: 0.45 },
    { rangeM: 100, probability: 0.28 },
    { rangeM: 300, probability: 0.12 },
    { rangeM: 600, probability: 0.05 },
    { rangeM: 1000, probability: 0.02 },
    { rangeM: 1500, probability: 0.008 },
  ],
  burstRoundWeight: 0.5,
  incapacitationProbabilityOnHit: 0.85,
  suppressionPerBurst: 0.3,
  suppressionRadiusM: 7,
  area: null,
};

/** A vehicle's medium machine gun's burst at soldiers (M240C, PKT), fired from a steady mount. */
const MMG_VS_INFANTRY: InfantryEffect = {
  hitProbabilityByRange: [
    { rangeM: 0, probability: 0.5 },
    { rangeM: 100, probability: 0.3 },
    { rangeM: 300, probability: 0.1 },
    { rangeM: 600, probability: 0.04 },
    { rangeM: 900, probability: 0.015 },
    { rangeM: 1100, probability: 0.007 },
  ],
  burstRoundWeight: 0.45,
  incapacitationProbabilityOnHit: 0.6,
  suppressionPerBurst: 0.22,
  suppressionRadiusM: 5,
  area: null,
};

/** A blast at soldiers: `centre` at the burst, `casualtyM`, gone by `maxM` (`AreaEffect`'s shape). */
function blast(
  centre: number,
  casualtyM: number,
  atCasualty: number,
  maxM: number,
  dispersionPer100M: number,
): InfantryEffect {
  return {
    hitProbabilityByRange: [],
    burstRoundWeight: 1,
    incapacitationProbabilityOnHit: 0,
    suppressionPerBurst: 0.45,
    suppressionRadiusM: maxM * 1.5,
    area: {
      minRangeM: 0,
      dispersionM: { atZeroM: 1, per100M: dispersionPer100M },
      incapacitationAtCentre: centre,
      casualtyRadiusM: casualtyM,
      incapacitationAtCasualtyRadius: atCasualty,
      maxEffectRadiusM: maxM,
      proneFactor: 0.5,
      friendlyClearanceM: maxM * 2,
      employProbability: { aimed: 1, area: 1 },
      minSecondsBetweenShots: 0,
    },
  };
}

// --- Ammunition -----------------------------------------------------------------

const ammo = (a: AmmoSpec): AmmoSpec => a;
const flat = (mm: number) => [{ rangeM: 0, mm }];

const M2_AP = ammo({
  id: 'm2-ap',
  label: '12.7×99 mm M2 AP / M8 API',
  kind: 'ap',
  energy: 'ke',
  // About 25 mm at the muzzle, 20 at 500 m, 13 at 1 000 m.
  penetrationByRange: [
    { rangeM: 0, mm: 25 },
    { rangeM: 500, mm: 20 },
    { rangeM: 1000, mm: 13 },
    { rangeM: 1500, mm: 8 },
  ],
  lethality: 0.3,
  nonPenetratingDamage: 0.02,
  vsInfantry: HMG_VS_INFANTRY,
});

const BALL_762 = (id: string, label: string) =>
  ammo({
    id,
    label,
    kind: 'ball',
    energy: 'ke',
    penetrationByRange: [
      { rangeM: 0, mm: 8 },
      { rangeM: 500, mm: 5 },
    ],
    lethality: 0.1,
    nonPenetratingDamage: 0.005,
    vsInfantry: MMG_VS_INFANTRY,
  });

const M829A1 = ammo({
  id: 'm829a1',
  label: '120 mm M829A1 APFSDS-T',
  kind: 'apfsds',
  energy: 'ke',
  // About 700 mm at 2 km is often quoted; 620–700 over the battle's ranges.
  penetrationByRange: [
    { rangeM: 0, mm: 720 },
    { rangeM: 2000, mm: 670 },
    { rangeM: 4000, mm: 610 },
  ],
  lethality: 0.9,
  nonPenetratingDamage: 0.2,
  vsInfantry: null,
  velocityMps: 1575,
});

const M830 = ammo({
  id: 'm830',
  label: '120 mm M830 HEAT-MP-T',
  kind: 'heat',
  energy: 'ce',
  penetrationByRange: flat(480),
  lethality: 0.7,
  nonPenetratingDamage: 0.35,
  vsInfantry: blast(0.9, 8, 0.5, 20, 0.6),
  velocityMps: 1140,
});

const BM42 = ammo({
  id: '3bm42',
  label: '125 mm 3BM42 Mango APFSDS-T',
  kind: 'apfsds',
  energy: 'ke',
  penetrationByRange: [
    { rangeM: 0, mm: 540 },
    { rangeM: 2000, mm: 480 },
    { rangeM: 4000, mm: 420 },
  ],
  lethality: 0.88,
  nonPenetratingDamage: 0.2,
  vsInfantry: null,
  velocityMps: 1700,
});

const OF26 = ammo({
  id: '3of26',
  label: '125 mm 3OF26 HE-FRAG',
  kind: 'heFrag',
  energy: 'ce',
  penetrationByRange: flat(40),
  lethality: 0.5,
  nonPenetratingDamage: 0.4,
  vsInfantry: blast(0.95, 10, 0.5, 25, 0.7),
  velocityMps: 850,
});

const UBR6 = ammo({
  id: '3ubr6',
  label: '30 mm 3UBR6 AP-T',
  kind: 'ap',
  energy: 'ke',
  penetrationByRange: [
    { rangeM: 0, mm: 55 },
    { rangeM: 1000, mm: 40 },
    { rangeM: 1500, mm: 33 },
    { rangeM: 2500, mm: 20 },
  ],
  lethality: 0.4,
  nonPenetratingDamage: 0.1,
  vsInfantry: HMG_VS_INFANTRY,
});

const UOF8 = ammo({
  id: '3uof8',
  label: '30 mm 3UOF8 HE-I',
  kind: 'he',
  energy: 'ce',
  penetrationByRange: flat(10),
  lethality: 0.2,
  nonPenetratingDamage: 0.15,
  vsInfantry: blast(0.6, 3, 0.35, 8, 1.2),
});

const M9M113 = ammo({
  id: '9m113',
  label: '9M113 Konkurs HEAT',
  kind: 'heat',
  energy: 'ce',
  penetrationByRange: flat(600),
  lethality: 0.85,
  nonPenetratingDamage: 0.3,
  vsInfantry: null,
});

const AT4_HEAT = ammo({
  id: 'at4-heat',
  label: '84 mm M136 AT4 HEAT',
  kind: 'heat',
  energy: 'ce',
  penetrationByRange: flat(420),
  lethality: 0.6,
  nonPenetratingDamage: 0.15,
  vsInfantry: null,
});

const PG7VL = ammo({
  id: 'pg7vl',
  label: '93 mm PG-7VL HEAT',
  kind: 'heat',
  energy: 'ce',
  penetrationByRange: flat(500),
  lethality: 0.6,
  nonPenetratingDamage: 0.15,
  vsInfantry: null,
});

const JAVELIN_HEAT = ammo({
  id: 'javelin-heat',
  label: 'FGM-148 Javelin tandem HEAT (top attack)',
  kind: 'tandemHeat',
  energy: 'ce',
  penetrationByRange: flat(750),
  topAttack: true,
  lethality: 0.85,
  nonPenetratingDamage: 0.3,
  vsInfantry: null,
});

const M9M111 = ammo({
  id: '9m111m',
  label: '9M111M Faktoriya HEAT',
  kind: 'heat',
  energy: 'ce',
  penetrationByRange: flat(460),
  lethality: 0.75,
  nonPenetratingDamage: 0.25,
  vsInfantry: null,
});

// --- Weapons --------------------------------------------------------------------

const weapon = (w: CombatWeaponSpec): CombatWeaponSpec => w;

export const COMBAT_WEAPONS: readonly CombatWeaponSpec[] = [
  weapon({
    id: 'm2hb',
    label: '12.7 mm M2HB heavy machine gun',
    kind: 'machineGun',
    ammo: [M2_AP],
    roundsPerShot: { min: 5, max: 9 },
    secondsBetweenShots: { minSeconds: 2, maxSeconds: 4 },
    readyCapacity: 100,
    reloadSeconds: { minSeconds: 8, maxSeconds: 12 },
    minRangeM: 0,
    maxRangeM: 1800,
    hitVsVehicleByRange: [
      { rangeM: 0, probability: 0.6 },
      { rangeM: 300, probability: 0.4 },
      { rangeM: 800, probability: 0.15 },
      { rangeM: 1500, probability: 0.05 },
    ],
    guided: null,
    requiresHalt: false,
    costPerShot: 1,
    aimSeconds: 0,
    firingSignature: 4,
  }),
  weapon({
    id: 'm240c',
    label: '7.62 mm M240C coaxial machine gun',
    kind: 'machineGun',
    ammo: [BALL_762('m80', '7.62×51 mm M80 ball / M62 tracer')],
    roundsPerShot: { min: 6, max: 12 },
    secondsBetweenShots: { minSeconds: 2, maxSeconds: 3.5 },
    readyCapacity: 200,
    reloadSeconds: { minSeconds: 6, maxSeconds: 9 },
    minRangeM: 0,
    maxRangeM: 1100,
    hitVsVehicleByRange: [
      { rangeM: 0, probability: 0.55 },
      { rangeM: 500, probability: 0.2 },
      { rangeM: 1100, probability: 0.05 },
    ],
    guided: null,
    requiresHalt: false,
    costPerShot: 0.6,
    aimSeconds: 0,
    firingSignature: 3,
  }),
  weapon({
    id: 'pkt',
    label: '7.62 mm PKT coaxial machine gun',
    kind: 'machineGun',
    ammo: [BALL_762('57n323s', '7.62×54R mm 57-N-323S ball / tracer')],
    roundsPerShot: { min: 6, max: 12 },
    secondsBetweenShots: { minSeconds: 2, maxSeconds: 3.5 },
    readyCapacity: 250,
    reloadSeconds: { minSeconds: 7, maxSeconds: 10 },
    minRangeM: 0,
    maxRangeM: 1100,
    hitVsVehicleByRange: [
      { rangeM: 0, probability: 0.55 },
      { rangeM: 500, probability: 0.2 },
      { rangeM: 1100, probability: 0.05 },
    ],
    guided: null,
    requiresHalt: false,
    costPerShot: 0.6,
    aimSeconds: 0,
    firingSignature: 3,
  }),
  weapon({
    id: 'm256',
    label: '120 mm M256 smoothbore gun',
    kind: 'cannon',
    ammo: [M829A1, M830],
    roundsPerShot: { min: 1, max: 1 },
    // A loader's cycle from the ready rack.
    secondsBetweenShots: { minSeconds: 6, maxSeconds: 8 },
    readyCapacity: 1,
    // A round brought from hull stowage to the ready rack.
    reloadSeconds: { minSeconds: 20, maxSeconds: 30 },
    minRangeM: 0,
    maxRangeM: 4000,
    hitVsVehicleByRange: [
      { rangeM: 0, probability: 0.98 },
      { rangeM: 1000, probability: 0.95 },
      { rangeM: 2000, probability: 0.85 },
      { rangeM: 3000, probability: 0.65 },
      { rangeM: 4000, probability: 0.4 },
    ],
    guided: null,
    requiresHalt: false,
    costPerShot: 8,
    aimSeconds: 2,
    firingSignature: 8,
  }),
  weapon({
    id: '2a46m',
    label: '125 mm 2A46M smoothbore gun',
    kind: 'cannon',
    ammo: [BM42, OF26],
    roundsPerShot: { min: 1, max: 1 },
    // The autoloader's cycle.
    secondsBetweenShots: { minSeconds: 7, maxSeconds: 8 },
    readyCapacity: 1,
    // A round loaded by hand into the carousel from hull stowage.
    reloadSeconds: { minSeconds: 25, maxSeconds: 35 },
    minRangeM: 0,
    maxRangeM: 4000,
    hitVsVehicleByRange: [
      { rangeM: 0, probability: 0.95 },
      { rangeM: 1000, probability: 0.9 },
      { rangeM: 2000, probability: 0.72 },
      { rangeM: 3000, probability: 0.45 },
      { rangeM: 4000, probability: 0.25 },
    ],
    guided: null,
    requiresHalt: false,
    costPerShot: 8,
    aimSeconds: 3,
    firingSignature: 8,
  }),
  weapon({
    id: '2a42',
    label: '30 mm 2A42 autocannon',
    kind: 'autocannon',
    ammo: [UBR6, UOF8],
    roundsPerShot: { min: 3, max: 6 },
    secondsBetweenShots: { minSeconds: 2, maxSeconds: 4 },
    // Both belts are on the dual feed: what is loaded is all there is.
    readyCapacity: 500,
    reloadSeconds: { minSeconds: 30, maxSeconds: 40 },
    minRangeM: 0,
    maxRangeM: 2500,
    hitVsVehicleByRange: [
      { rangeM: 0, probability: 0.7 },
      { rangeM: 500, probability: 0.55 },
      { rangeM: 1000, probability: 0.4 },
      { rangeM: 1500, probability: 0.25 },
      { rangeM: 2000, probability: 0.15 },
      { rangeM: 2500, probability: 0.08 },
    ],
    guided: null,
    requiresHalt: false,
    costPerShot: 2,
    aimSeconds: 0,
    firingSignature: 5,
  }),
  weapon({
    id: '9p135m',
    label: '9P135M launcher, 9M113 Konkurs (SACLOS, wire)',
    kind: 'atgm',
    ammo: [M9M113],
    roundsPerShot: { min: 1, max: 1 },
    secondsBetweenShots: { minSeconds: 1, maxSeconds: 1 },
    readyCapacity: 1,
    // A missile fitted to the launcher by the gunner from the hatch.
    reloadSeconds: { minSeconds: 30, maxSeconds: 40 },
    minRangeM: 75,
    maxRangeM: 4000,
    hitVsVehicleByRange: [
      { rangeM: 75, probability: 0.6 },
      { rangeM: 500, probability: 0.85 },
      { rangeM: 3000, probability: 0.8 },
      { rangeM: 4000, probability: 0.7 },
    ],
    guided: { flightSpeedMps: 208, guidedToImpact: true },
    requiresHalt: true,
    costPerShot: 20,
    aimSeconds: 4,
    firingSignature: 6,
  }),
  weapon({
    id: 'at4',
    label: '84 mm M136 AT4 (disposable)',
    kind: 'atRocket',
    ammo: [AT4_HEAT],
    roundsPerShot: { min: 1, max: 1 },
    secondsBetweenShots: { minSeconds: 1, maxSeconds: 1 },
    readyCapacity: 1,
    carriedRounds: 2,
    // The next one unslung and readied.
    reloadSeconds: { minSeconds: 4, maxSeconds: 6 },
    minRangeM: 10,
    maxRangeM: 300,
    hitVsVehicleByRange: [
      { rangeM: 10, probability: 0.9 },
      { rangeM: 100, probability: 0.75 },
      { rangeM: 200, probability: 0.5 },
      { rangeM: 300, probability: 0.3 },
    ],
    guided: null,
    requiresHalt: false,
    costPerShot: 10,
    aimSeconds: 5,
    firingSignature: 6,
  }),
  weapon({
    id: 'rpg7',
    label: 'RPG-7V, PG-7VL',
    kind: 'atRocket',
    ammo: [PG7VL],
    roundsPerShot: { min: 1, max: 1 },
    secondsBetweenShots: { minSeconds: 1, maxSeconds: 1 },
    readyCapacity: 1,
    carriedRounds: 3,
    reloadSeconds: { minSeconds: 6, maxSeconds: 9 },
    minRangeM: 10,
    maxRangeM: 400,
    hitVsVehicleByRange: [
      { rangeM: 10, probability: 0.85 },
      { rangeM: 100, probability: 0.65 },
      { rangeM: 200, probability: 0.4 },
      { rangeM: 300, probability: 0.2 },
      { rangeM: 400, probability: 0.1 },
    ],
    guided: null,
    requiresHalt: false,
    costPerShot: 8,
    aimSeconds: 4,
    firingSignature: 6,
  }),
  weapon({
    id: 'javelin',
    label: 'FGM-148 Javelin (fire and forget, top attack)',
    kind: 'atgm',
    ammo: [JAVELIN_HEAT],
    roundsPerShot: { min: 1, max: 1 },
    secondsBetweenShots: { minSeconds: 1, maxSeconds: 1 },
    readyCapacity: 1,
    carriedRounds: 2,
    // A new round fitted to the command launch unit.
    reloadSeconds: { minSeconds: 18, maxSeconds: 25 },
    minRangeM: 65,
    maxRangeM: 2500,
    hitVsVehicleByRange: [
      { rangeM: 65, probability: 0.85 },
      { rangeM: 2500, probability: 0.9 },
    ],
    guided: { flightSpeedMps: 170, guidedToImpact: false },
    requiresHalt: true,
    costPerShot: 20,
    // Seeker cool-down and lock-on.
    aimSeconds: 12,
    firingSignature: 5,
  }),
  weapon({
    id: '9k111',
    label: '9K111 Fagot, 9M111M (SACLOS, wire)',
    kind: 'atgm',
    ammo: [M9M111],
    roundsPerShot: { min: 1, max: 1 },
    secondsBetweenShots: { minSeconds: 1, maxSeconds: 1 },
    readyCapacity: 1,
    carriedRounds: 3,
    reloadSeconds: { minSeconds: 20, maxSeconds: 30 },
    minRangeM: 70,
    maxRangeM: 2500,
    hitVsVehicleByRange: [
      { rangeM: 70, probability: 0.6 },
      { rangeM: 500, probability: 0.8 },
      { rangeM: 2000, probability: 0.8 },
      { rangeM: 2500, probability: 0.7 },
    ],
    guided: { flightSpeedMps: 186, guidedToImpact: true },
    requiresHalt: true,
    costPerShot: 20,
    aimSeconds: 6,
    firingSignature: 5,
  }),
];

// --- Platforms ------------------------------------------------------------------

const OLIVE = 0x66703f;
const OLIVE_DARK = 0x3d4228;
const TAN = 0xb59c6b;
const TAN_DARK = 0x6e5e3e;
const RUSSIAN_GREEN = 0x56613a;
const RUSSIAN_DARK = 0x353b22;

export const VEHICLE_PLATFORMS: readonly PlatformSpec[] = [
  {
    id: 'm113',
    name: 'M113 APC',
    variant:
      'M113A3 armoured personnel carrier (aluminium hull, spall liners), M2HB on the commander’s cupola',
    targetClass: 'lightArmor',
    dimensions: { lengthM: 4.86, widthM: 2.69, heightM: 2.5 },
    mobility: {
      kind: 'tracked',
      roadSpeedMps: 14,
      offRoadSpeedMps: 8.5,
      woodsSpeedMps: 2.8,
      accelMps2: 1.2,
      decelMps2: 2.5,
      turnRateDegS: 40,
      lateralAccelMps2: 2.5,
      pivotRateDegS: 35,
      minTurnRadiusM: 0,
      climbLoss: 2.5,
      maxClimbLoss: 0.7,
    },
    // 5083 aluminium, 32–44 mm: proof against rifle fire all round, and only
    // the front against 12.7 mm AP at range (RHA-equivalent ~⅓ of its thickness).
    armor: {
      ke: { front: 22, side: 15, rear: 13, top: 10 },
      ce: { front: 22, side: 15, rear: 13, top: 10 },
    },
    crew: ['driver', 'commander'],
    sensors: { opticsFactor: 1, thermal: false, eyeHeightM: 2.4, regardHalfAngleDeg: 180 },
    mounts: [
      {
        id: 'cupola',
        kind: 'cupola',
        parent: null,
        pivot: { forward: -0.15, right: 0.15, up: 2.0 },
        traverse: null,
        traverseRateDegS: 45,
        elevation: { minDeg: -10, maxDeg: 60 },
        elevationRateDegS: 40,
        stabilized: false,
        movingAccuracyFactor: 0.3,
        operator: 'commander',
      },
    ],
    weapons: [
      {
        id: 'hmg',
        weapon: 'm2hb',
        mount: 'cupola',
        muzzle: { forward: 1.15, right: 0, up: 0.3 },
        loads: [{ ammo: 'm2-ap', ready: 100, stowed: 1900 }],
      },
    ],
    catastrophicVulnerability: 0.4,
    visual: {
      hull: 'm113',
      turret: 'none',
      color: OLIVE,
      darkColor: OLIVE_DARK,
      roadWheels: 5,
      wheelRadiusM: 0.305,
      wheelSpacingM: 0.69,
      sprocket: 'front',
      returnRollers: 0,
      trackWidthM: 0.38,
    },
  },
  {
    id: 'm1a1',
    name: 'M1A1 Abrams',
    variant:
      'M1A1 main battle tank (120 mm M256, M240C coaxial, M2HB at the commander’s station), without depleted-uranium armour',
    targetClass: 'heavyArmor',
    dimensions: { lengthM: 7.92, widthM: 3.66, heightM: 2.44 },
    mobility: {
      kind: 'tracked',
      roadSpeedMps: 18,
      offRoadSpeedMps: 13,
      woodsSpeedMps: 3.5,
      accelMps2: 2.0,
      decelMps2: 3.0,
      turnRateDegS: 35,
      lateralAccelMps2: 3,
      pivotRateDegS: 30,
      minTurnRadiusM: 0,
      climbLoss: 2.0,
      maxClimbLoss: 0.6,
    },
    // Composite front of turret and hull; skirts on the sides; thin rear and roof.
    armor: {
      ke: { front: 560, side: 70, rear: 40, top: 40 },
      ce: { front: 850, side: 220, rear: 60, top: 50 },
    },
    crew: ['commander', 'gunner', 'loader', 'driver'],
    sensors: { opticsFactor: 2.5, thermal: true, eyeHeightM: 2.6, regardHalfAngleDeg: 180 },
    mounts: [
      {
        id: 'turret',
        kind: 'turret',
        parent: null,
        pivot: { forward: -0.4, right: 0, up: 1.95 },
        traverse: null,
        traverseRateDegS: 40,
        elevation: { minDeg: -10, maxDeg: 20 },
        elevationRateDegS: 25,
        stabilized: true,
        movingAccuracyFactor: 0.85,
        operator: 'gunner',
        alternate: 'commander',
      },
      {
        // The commander's weapon station: turns on the turret, on its own.
        id: 'cupola',
        kind: 'cupola',
        parent: 'turret',
        pivot: { forward: -0.55, right: 0.55, up: 0.45 },
        traverse: null,
        traverseRateDegS: 50,
        elevation: { minDeg: -10, maxDeg: 65 },
        elevationRateDegS: 40,
        stabilized: false,
        movingAccuracyFactor: 0.3,
        operator: 'commander',
      },
    ],
    weapons: [
      {
        id: 'main',
        weapon: 'm256',
        mount: 'turret',
        muzzle: { forward: 6.3, right: 0, up: 0.05 },
        loads: [
          { ammo: 'm829a1', ready: 18, stowed: 6 },
          { ammo: 'm830', ready: 16, stowed: 0 },
        ],
        loader: 'loader',
        reloadWithoutFactor: 3,
      },
      {
        id: 'coax',
        weapon: 'm240c',
        mount: 'turret',
        muzzle: { forward: 1.6, right: 0.55, up: 0.05 },
        loads: [{ ammo: 'm80', ready: 200, stowed: 10600 }],
      },
      {
        id: 'hmg',
        weapon: 'm2hb',
        mount: 'cupola',
        muzzle: { forward: 1.1, right: 0, up: 0.25 },
        loads: [{ ammo: 'm2-ap', ready: 100, stowed: 900 }],
      },
    ],
    catastrophicVulnerability: 0.25,
    visual: {
      hull: 'abrams',
      turret: 'abrams',
      color: TAN,
      darkColor: TAN_DARK,
      roadWheels: 7,
      wheelRadiusM: 0.32,
      wheelSpacingM: 0.78,
      sprocket: 'rear',
      returnRollers: 2,
      trackWidthM: 0.64,
    },
  },
  {
    id: 'bmp2',
    name: 'BMP-2',
    variant: 'BMP-2 infantry fighting vehicle (30 mm 2A42, PKT coaxial, 9P135M with 9M113 Konkurs)',
    targetClass: 'lightArmor',
    dimensions: { lengthM: 6.74, widthM: 3.15, heightM: 2.45 },
    mobility: {
      kind: 'tracked',
      roadSpeedMps: 18,
      offRoadSpeedMps: 11,
      woodsSpeedMps: 3.2,
      accelMps2: 1.5,
      decelMps2: 2.8,
      turnRateDegS: 40,
      lateralAccelMps2: 2.8,
      pivotRateDegS: 35,
      minTurnRadiusM: 0,
      climbLoss: 2.3,
      maxClimbLoss: 0.65,
    },
    // Welded steel: proof against 12.7 mm from the front only, rifle fire all round.
    armor: {
      ke: { front: 33, side: 18, rear: 16, top: 10 },
      ce: { front: 33, side: 18, rear: 16, top: 10 },
    },
    crew: ['driver', 'gunner', 'commander'],
    sensors: { opticsFactor: 1.6, thermal: false, eyeHeightM: 2.3, regardHalfAngleDeg: 180 },
    mounts: [
      {
        id: 'turret',
        kind: 'turret',
        parent: null,
        pivot: { forward: 0.35, right: 0, up: 2.0 },
        traverse: null,
        traverseRateDegS: 30,
        elevation: { minDeg: -5, maxDeg: 74 },
        elevationRateDegS: 35,
        stabilized: true,
        movingAccuracyFactor: 0.5,
        operator: 'gunner',
        alternate: 'commander',
      },
      {
        id: 'launcher',
        kind: 'launcher',
        parent: 'turret',
        pivot: { forward: -0.1, right: 0, up: 0.45 },
        traverse: { leftDeg: 0, rightDeg: 0 },
        traverseRateDegS: 1,
        elevation: { minDeg: -5, maxDeg: 10 },
        elevationRateDegS: 10,
        stabilized: false,
        movingAccuracyFactor: 0,
        operator: 'gunner',
      },
    ],
    weapons: [
      {
        id: 'main',
        weapon: '2a42',
        mount: 'turret',
        muzzle: { forward: 3.1, right: 0, up: 0 },
        loads: [
          { ammo: '3ubr6', ready: 160, stowed: 0 },
          { ammo: '3uof8', ready: 340, stowed: 0 },
        ],
      },
      {
        id: 'coax',
        weapon: 'pkt',
        mount: 'turret',
        muzzle: { forward: 1.1, right: 0.4, up: 0 },
        loads: [{ ammo: '57n323s', ready: 250, stowed: 1750 }],
      },
      {
        id: 'atgm',
        weapon: '9p135m',
        mount: 'launcher',
        muzzle: { forward: 0.7, right: 0, up: 0 },
        loads: [{ ammo: '9m113', ready: 1, stowed: 3 }],
      },
    ],
    catastrophicVulnerability: 0.55,
    visual: {
      hull: 'bmp2',
      turret: 'bmp2',
      color: RUSSIAN_GREEN,
      darkColor: RUSSIAN_DARK,
      roadWheels: 6,
      wheelRadiusM: 0.37,
      wheelSpacingM: 0.82,
      sprocket: 'front',
      returnRollers: 3,
      trackWidthM: 0.35,
    },
  },
  {
    id: 't72b',
    name: 'T-72B',
    variant:
      'T-72B main battle tank (125 mm 2A46M, autoloader, PKT coaxial; composite turret, without Kontakt-1)',
    targetClass: 'heavyArmor',
    dimensions: { lengthM: 6.86, widthM: 3.59, heightM: 2.23 },
    mobility: {
      kind: 'tracked',
      roadSpeedMps: 16.5,
      offRoadSpeedMps: 10,
      woodsSpeedMps: 3.0,
      accelMps2: 1.3,
      decelMps2: 2.8,
      turnRateDegS: 30,
      lateralAccelMps2: 2.5,
      pivotRateDegS: 25,
      minTurnRadiusM: 0,
      climbLoss: 2.2,
      maxClimbLoss: 0.65,
    },
    armor: {
      ke: { front: 500, side: 75, rear: 40, top: 40 },
      ce: { front: 750, side: 180, rear: 60, top: 45 },
    },
    crew: ['commander', 'gunner', 'driver'],
    sensors: { opticsFactor: 2, thermal: false, eyeHeightM: 2.4, regardHalfAngleDeg: 180 },
    mounts: [
      {
        id: 'turret',
        kind: 'turret',
        parent: null,
        pivot: { forward: -0.2, right: 0, up: 1.85 },
        traverse: null,
        traverseRateDegS: 24,
        elevation: { minDeg: -6, maxDeg: 14 },
        elevationRateDegS: 6,
        stabilized: true,
        movingAccuracyFactor: 0.6,
        operator: 'gunner',
        alternate: 'commander',
      },
    ],
    weapons: [
      {
        id: 'main',
        weapon: '2a46m',
        mount: 'turret',
        muzzle: { forward: 6.0, right: 0, up: 0.05 },
        loads: [
          { ammo: '3bm42', ready: 12, stowed: 8 },
          { ammo: '3of26', ready: 10, stowed: 15 },
        ],
      },
      {
        id: 'coax',
        weapon: 'pkt',
        mount: 'turret',
        muzzle: { forward: 1.3, right: 0.5, up: 0.05 },
        loads: [{ ammo: '57n323s', ready: 250, stowed: 1750 }],
      },
    ],
    // The carousel of rounds under the turret: a perforation there seldom leaves a tank.
    catastrophicVulnerability: 0.7,
    visual: {
      hull: 't72',
      turret: 't72',
      color: RUSSIAN_GREEN,
      darkColor: RUSSIAN_DARK,
      roadWheels: 6,
      wheelRadiusM: 0.375,
      wheelSpacingM: 0.82,
      sprocket: 'rear',
      returnRollers: 3,
      trackWidthM: 0.58,
    },
  },
];

/** Target selection (docs/combined-arms.md §6). */
export const TARGETING: TargetingConfig = {
  minimumEffect: 0.02,
  classValue: { infantry: 1, unarmored: 2, lightArmor: 4, heavyArmor: 6 },
  reassessSeconds: 4,
  switchFactor: 1.5,
  layToleranceDeg: 1,
  elevationToleranceDeg: 0.75,
};

/** The anti-tank weapons soldiers carry, by side (`src/exercise/forces/forces.ts`). */
export const INFANTRY_ANTI_TANK = {
  BLUEFOR: { rocket: 'at4', missile: 'javelin' },
  OPFOR: { rocket: 'rpg7', missile: '9k111' },
} as const;

deepFreeze(COMBAT_WEAPONS);
deepFreeze(VEHICLE_PLATFORMS);
deepFreeze(TARGETING);
