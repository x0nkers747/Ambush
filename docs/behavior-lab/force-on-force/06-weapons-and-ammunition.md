# Weapons, ammunition and grenade launchers (force-on-force model v2)

The force-on-force model (`src/sim/fof`) resolves fire as abstract, probabilistic
events: a burst is one event, not a bullet (03 §5). Version 2 keeps that engine
and makes the weapons behave like weapons: finite ammunition carried in
magazines, belts or single rounds; reloads that interrupt fire; firing rates and
burst lengths by weapon and fire mode; and the fire team leader's underslung
grenade launcher, employed by decision and resolved as an abstract area effect.
Every weapon number is configuration (`src/exercise/forces/fof-v2.json`,
`FofWeapon`), never code.

## 1. What the engine already had, and what changes

| Before (v1)                                                              | After (v2)                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| One weapon category per soldier (`rifle`, `automaticRifle`)              | A primary weapon, and a secondary (`grenadeLauncher`) for the fire team leader, from his loadout            |
| One pool of rounds (`rounds`), no magazines                              | Per weapon: rounds loaded (magazine, belt, launcher) and in reserve; reloads move rounds between them       |
| A fixed burst (`roundsPerBurst`) every `secondsBetweenBursts` × a jitter | Fire modes (sustained, rapid), each a burst length range and a burst-to-burst interval range, by weapon     |
| Burst hit chance `1 − (1 − p)^n` over its `n` rounds                     | Over its _effective_ rounds `1 + (n − 1) × burstRoundWeight`: rounds of one burst are not independent shots |
| —                                                                        | Reloads (empty; or tactical, in a lull), out of ammunition, grenade employment and area effects as events   |

Unchanged: detection, tracks, target selection (nearest engageable contact in
sight, else area fire at a recent last known position), rules of engagement,
the posture, exposure, suppression and moving-shooter factors, simultaneous
resolution of a decision's fire (the volley), suppression and its recovery, the
force lifecycle, orders and termination. Everything still runs at the model's
decision rate (10 Hz) on simulation time, from the simulation's seeded random
numbers; all new state is plain data in `SimState.fof`, so snapshots, hashes and
replays carry it unchanged.

## 2. Reference data

Variants: the organizations are the USMC rifle squad and fire team of MCWP
3-11.2 (riflemen and leaders with the M16A4, automatic riflemen with the M249,
fire team leaders with the M16A4 and M203). OPFOR uses the same organizations;
its display models differ, its weapons in the simulation do not (parity).

| Weapon                 | Feed                          | Sustained                                    | Rapid                                         | Cyclic (mechanical) | Effective range                    | Sources                                |
| ---------------------- | ----------------------------- | -------------------------------------------- | --------------------------------------------- | ------------------- | ---------------------------------- | -------------------------------------- |
| M16A4 rifle (M4 alike) | 30-round magazine             | 12–15 rounds/min                             | 45 rounds/min semiautomatic                   | 700–950 rounds/min  | 550 m point, 800 m area (M16A4)    | FM 3-22.9 (2008) Table 2-1; MCRP 3-01A |
| M249 SAW               | 200-round belt (box)          | 50 rounds/min, 6–9-round bursts, 4–5 s apart | 100 rounds/min, 6–9-round bursts, 2–3 s apart | 650–850 rounds/min  | 600 m point, 800 m area (bipod)    | FM 3-22.68 (2006) Table 4-1 / ch. 4    |
| M203 grenade launcher  | single round (40 mm, M406 HE) | —                                            | 5–7 rounds/min (maximum effective rate)       | —                   | 150 m point, 350 m area; max 400 m | FM 3-22.31 (2003) ch. 1                |

- **Cyclic rate is not a firing rate.** It is how fast the mechanism cycles; no
  weapon is modelled firing at it. Sustained and rapid rates are doctrinal
  rates a gunner keeps up (sustained for long periods; rapid for short ones,
  typically while gaining fire superiority or supporting an assault).
- **The M249 discrepancy.** FM 3-22.68 states 50 rounds/min sustained in 6–9
  round bursts 4–5 s apart, but 7.5 rounds every 4.5 s is about 100 rounds/min:
  its burst figures and its rates disagree (the rapid figures likewise). The
  "about 100 rounds/min" in the milestone brief is the rapid rate. **Model:**
  the doctrinal burst length (6–9 rounds) and the doctrinal _rates_; the
  interval between bursts follows from them (sustained ≈ 9 s, rapid ≈ 4.5 s),
  since ammunition consumption, which drives the battle, follows the rates.
- **Rifle "bursts".** The M16A4 has three-round burst, but doctrine and
  practice fire aimed semiautomatic shots. A rifle "burst" here is a firing
  opportunity of 1–2 aimed rounds (sustained) or 1–3 (rapid).
- **M203 range.** Minimum arming distance of the M406 is 14–27 m (FM 3-22.31);
  the combat minimum safe distance stated there is 31 m. **Model:** not fired
  below 31 m, nor beyond 350 m (area targets).
- **M406 HE effect.** FM 3-22.31 gives an effective casualty radius of 5 m: the
  radius within which half of exposed personnel become casualties. **Model:**
  incapacitation probability falling linearly from 0.75 at the burst to 0.5 at
  5 m and to 0 at 10 m, halved for prone soldiers (`area.*`). Suppression to
  15 m. These are modelling assumptions anchored on the casualty-radius
  definition, not validated lethality data.
- **Reload times** are not doctrinal standards. **Assumptions:** magazine
  change 3–5 s (a deliberate change under stress; speed reloads in training are
  faster); M249 belt change 7–11 s (open cover, clear, new belt, close); M203
  reload 4–6 s (open the barrel, load, close), consistent with 5–7 rounds/min.
- **Basic loads.** Rifle 7 magazines = 210 rounds (MCWP 3-11.2; the v1 value).
  M249 600 rounds (3 boxes; the v1 value; MCWP lists more for a deliberate
  attack). M203: 18 rounds is an assumption (grenadier vests carry 18–24).
- **Malfunctions** are not modelled: no credible, testable model was in scope.

## 3. Firing

At a soldier's firing opportunity (`nextFireAt`), as before, he picks his
target; then his weapon and its fire mode decide what he fires:

- **Fire mode.** Rapid for the first `rapidFire.afterOpeningSeconds` (45 s)
  after his force opened fire, at targets within `rapidFire.withinRangeM`
  (100 m), and while his force assaults (`rapidFire.whenAssaulting`); sustained
  otherwise.
- **The burst.** Its length is drawn from the mode's range (integer rounds),
  cut short by the rounds loaded. The next opportunity is the mode's interval
  (drawn from its range), slower for leaders, suppressed soldiers and area fire
  as before.
- **Hit chance.** `1 − (1 − p)^(1 + (n − 1) w)`, with `p` the per-round chance
  as before and `w = burstRoundWeight` (rifle 0.8: aimed shots, nearly
  independent; M249 0.35: dispersed burst). A 9-round burst is worth about 3.8
  aimed rounds, not 9.
- **Empty feed.** The burst that empties the magazine or belt starts a reload
  if there is ammunition in reserve: `reloadSeconds` drawn from its range,
  during which the soldier fires nothing (the reload is his hands). Rounds move
  from reserve to the feed, `min(capacity, reserve)`: a last, partial magazine
  is loaded as it is.
- **Tactical reload.** A soldier who has not fired for `lullReloadSeconds` and
  whose magazine is below `tacticalReloadBelow` of its capacity changes it: the
  partial magazine returns to his reserve (magazines are consolidated in a
  lull; rounds are counted, not magazines) and a full one is loaded. Belts and
  single-round launchers have no tactical reload.
- **Out of ammunition.** No rounds loaded or in reserve: he stops firing (an
  `ammunitionExhausted` event, once per weapon), keeps moving and observing.
- **Time of flight.** A burst's rounds fly at `SMALL_ARMS_VELOCITY_MPS`
  (900 m/s: 5.56 and 7.62 mm leave the muzzle at 825–915 m/s), arriving its
  range over that later (`fofFire.arriveAt`; a third of a second at 300 m).
  Whether it hits, and whether it strikes its target down, are drawn when it
  is fired; what it does happens when it arrives (`FofState.inFlight`,
  `arriveRounds`, at the first decision after, before that decision's
  bursts): the suppression round where it lands, the soldier struck down
  (`soldierIncapacitated` then; unless he is down already), and the force
  it lands on coming under fire. A burst from a soldier struck down meanwhile
  still arrives. Grenades fly too (§4).

**Conservation.** For every weapon, at every moment:
`loaded + reserve + fired = basic load`, `0 ≤ loaded ≤ capacity`; checked by
the model's invariants (`lifecycle.ts`) and the tests.

**Lethality.** v1 fired a rifle at about 39 rounds/min for the whole
engagement, each round an independent aimed shot. v2 fires at the doctrinal
rates, and an automatic burst counts as fewer effective shots. Over the first
45 s (rapid) the fire is close to v1's; after it, sustained fire is about a
third of v1's: engagements last longer and ammunition decides more of them.
This is the intended recalibration, not a side effect (§6).

## 4. The grenade launcher

The fire team leader's M203 is a secondary weapon: his rifle works as usual.

**Decision.** At each of his firing opportunities, with his target chosen as
for his rifle, he fires a grenade instead when all of these hold:

- the launcher is loaded, he is not reloading, and
  `minSecondsBetweenShots` (9 s) have passed since his last grenade;
- the target (an aimed target, or an area-fire aim point) is within
  `minRangeM`–`maxEngagementRangeM` (31–350 m) and in his sight;
- no friendly soldier is within `friendlyClearanceM` (35 m) of the aim point;
- a draw from the simulation's random numbers is below `employProbability`
  (aimed 0.15; area 0.35: grenades are the better answer to an enemy out of
  sight). Never automatic merely because an enemy is in range.

**Resolution.** Where the round lands is drawn when it is fired: the aim point
displaced by a random error (radius drawn up to `dispersionM.atZeroM +
range/100 × dispersionM.per100M`, direction uniform; 1 m + 2.5 m per 100 m).
It flies there on the low arc that reaches it at `GRENADE_VELOCITY_MPS`
(76 m/s, the M203's and GP-25's), no drag: `grenadeFlightSeconds`, its range
over its speed along the ground, about 0.7 s at 50 m, 2.1 s at 150 m, 4.1 s
at 300 m (`fofGrenadeFired`, with `burstAt`; `FofState.grenades`). It bursts
at the first decision once there (`arriveGrenades`, before that decision's
bursts): every active soldier, of either side, within `maxEffectRadiusM` of
it, where they are then, draws incapacitation with the falloff of §2
(× `proneFactor` when prone); everyone within the suppression radius is
suppressed (`suppressionPerBurst`, fading with distance); the force it was
fired at comes under fire. Casualties join that decision's volley. One
`fofGrenade` event, at the burst, records the shooter, when it was fired
(`firedAt`), the aim and impact points, and every soldier struck down. The
launcher reloads (`reloadSeconds`) if he has rounds, from when it was fired.
A grenade from a grenadier struck down in its flight still bursts.

## 5. Events, review and views

New events: `fofReload` (`started`/`completed`, weapon, rounds),
`fofGrenadeFired` and `fofGrenade` (its burst),
`ammunitionExhausted`. `fofFire` gains the fire mode. They are kept in battle
and lab logs; a battle's review re-simulates from tick 0 with the same seed and
inputs, verified tick-second by second against the battle fought (hashes cover
all weapon state), so it shows the same bursts, reloads and grenades; nothing
is re-drawn differently. **The 2D map** draws each burst as a line from the shooter to his aim point
(solid aimed, dashed area fire), each grenade as a dashed arc to where it will
land with a dot flying along it, then its effect circle when it bursts. **The 3D view** shows the fight as it might look: every round
of every burst flies as a tracer from the shooter's muzzle (light blue
BLUEFOR, green OPFOR), at 900 m/s in the
battle's time, into its target when the burst hit (arriving as he falls),
otherwise scattered round the aim point and on past it;
grenades are not traced, their bursts show as a fireball, a ring of dust and a
cloud of smoke. Tracers and explosions are purely visual, derived from the
events and the battle's clock (`src/view3d/tracers.ts`, `impacts.ts`), so the
review shows the same ones at the same moments; the 3D view draws no fire
lines. The selected squad's panel lists its ammunition by weapon and who is
reloading.

## 6. Validation

**Tests.** `src/exercise/force-on-force/weapons.test.ts` (21) and
`src/app/battle/weapons-replay.test.ts` (3):

- the weapons and rounds of every role, alike on both sides, and the
  configured doctrinal rates;
- burst lengths by weapon, intervals never shorter than the mode allows, rapid
  fire when opening and close in, sustained fire later at range, different
  weapons at observably different rates;
- reloads: started on an empty feed or in a lull, no fire while reloading,
  durations in range, the pool loaded; partial last magazines; exhaustion
  (reported once, silent after); moving while reloading;
- conservation at every tick, and over random seeds and tick rates (20, 30,
  60 Hz), the rounds fired matching the bursts;
- the grenade launcher: only fire team leaders, 31–350 m, its least interval,
  never with a friend near the aim point, landing within its dispersion,
  striking only soldiers in its effect and not all of them, reloading after
  each round, never fired when its chance is zero; the falloff;
- determinism (same seed identical, another seed different), a snapshot taken
  with reloads pending restoring to identical events and hash, alike rates
  across tick rates;
- a battle's log keeping the new events, the review re-simulating exactly the
  same weapon events with every second verified, and the battle identical at
  1× in small frames and at 32×.

Existing tests changed only where the model changed what they read: the
soldier's `rounds` became his weapons' state; the "blind" helper (forces that
cannot hurt each other) also zeroes the grenade's effect; casualties may come
from a grenade; and the fire team bounding test runs three seeds (a fire team
can now break under grenades before it assaults), requiring assaults in at
least two.

**Performance** (`src/app/battle/benchmark.test.ts`, 300 s battles at 30 Hz,
the same machine, before → after; ms per tick, mean):

| Squads | Ground | Before | After | Hash ms (per second) |
| ------ | ------ | ------ | ----- | -------------------- |
| 2      | open   | 0.115  | 0.118 | 0.47 → 0.51          |
| 6      | open   | 0.357  | 0.363 | 1.89 → 2.46          |
| 12     | open   | 0.858  | 0.878 | 7.18 → 7.60          |
| 2      | urban  | 0.163  | 0.250 | 0.37 → 0.81          |
| 6      | urban  | 0.570  | 0.615 | 1.93 → 2.05          |
| 12     | urban  | 1.292  | 1.436 | 5.06 → 6.28          |

The urban rows differ more than the work does: the battles themselves differ
(other casualties, other movement). Stepping the same urban battles without
the session's recording, three runs each: 2 squads 0.124–0.138 ms before,
0.126–0.136 after; 6 squads 0.455–0.466 before, 0.460–0.467 after: no
measurable cost. The per-second hash grew with the state (each soldier's
weapons), about 0.01–0.02 ms per tick. Snapshots grew 5–10 %. Replay and
verification rates follow the simulation's.

## 7. Limitations

- Grenades have no flight time; they burst when fired.
- Cover against fragments is a sight line from the burst to the soldier's
  chest; posture is the only other protection.
- Rounds are counted, not magazines: a lull's tactical reload consolidates.
- No malfunctions, barrel changes, or ammunition redistribution between
  soldiers.
- Rates and burst lengths are doctrinal; the burst-round weight, reload times,
  the M203 basic load and its falloff are assumptions (§2).
- Recordings of battles and lab runs made before v2 replay under the new model
  and do not verify: their hashes are of the old one.
