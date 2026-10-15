# Force-on-Force 02: human visual detection — evidence and the model

- Status: done (F1)
- Date: 2026-10-14
- Part of: [Force-on-Force Lab](README.md)

**What this is.** An experimental detection model for a constructive simulation
prototype. It is built from the structure of published target-acquisition models.
**It is not a calibrated or validated prediction of when soldiers see each other.**
Every number applied to the naked eye is labelled below:

- **[L]** taken from the literature;
- **[L→E]** a literature value applied outside the conditions it was established for;
- **[E]** an experimental choice.

## 1. Terms

| Term                       | Meaning here                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Visibility** (geometric) | A clear sight line from the observer's eye to some part of the target (terrain, buildings; vegetation obscures gradually). Necessary, never sufficient. |
| **Detection**              | The observer notices something that may be a person: a _possible contact_.                                                                              |
| **Confirmed detection**    | Repeated looks make the force sure there is someone: _detected_.                                                                                        |
| **Recognition**            | Seeing that it is a person. Not a separate state: confirmation implies it.                                                                              |
| **Identification**         | Seeing that the person is an opponent: _identified_.                                                                                                    |
| **Tracking**               | Keeping a confirmed contact: easier than finding him (the observer knows where to look).                                                                |
| **Contact lost**           | Confidence has fallen below the loss threshold; the last known position is kept.                                                                        |

A force's picture is the union of its soldiers' observations, shared at once; there is no
reporting delay (a limitation, §6). A force acts only on its own tracks, never on where
enemies really are.

## 2. Evidence

### 2.1 How much of the target the eye resolves

- **Acuity.** Normal (20/20 Snellen) acuity resolves detail of about 1 arc minute: a
  line pair, one _cycle_, is about 2′. **[L]** This is foveal acuity for a high-contrast
  target under good light.
  - A soldier on the move searching a wide field uses peripheral vision, and the target
    is seldom high-contrast. Effective search acuity is worse.
  - The model uses a **3′ cycle**. **[E]**
- **Johnson criteria.** Johnson's 1958 work related the cycles across a target's
  critical dimension to the task done at 50 % probability. Commonly cited values are:
  - about 1.0 cycle for detection;
  - 1.4 for orientation;
  - 4 for recognition;
  - 6.4 for identification.

  Per-target values vary (e.g. 6.0 to 8.0 for identifying different vehicles)
  ([Johnson's criteria](https://en.wikipedia.org/wiki/Johnson%27s_criteria);
  [SPIE 1999, night vision modeling history](https://www.spiedigitallibrary.org/conference-proceedings-of-spie/3701/1/Night-vision-modeling-historical-perspective/10.1117/12.352982.pdf)).
  **[L]** They were established for **sensor images of vehicles**, not for the naked
  eye looking at people. **[L→E]**

- **Critical dimension.** For a person, this is √(height × width) of the
  silhouette. **[L]** (the usual definition)
  - Values: standing 0.95 m (1.8 × 0.5), kneeling 0.71 m, prone 0.46 m (seen
    head-on). **[E]**
- **From cycles to probability.** The target transfer probability function (TTPF) gives
  the probability at N cycles:

  `P∞ = x^E / (1 + x^E)`, where `x = N / N50` and `E = 2.7 + 0.7·x`.

  - This is the form used by the US Army night-vision models before the Targeting
    Task Performance metric replaced the Johnson criteria. **[L]**
  - The later TTP metric reports a recognition-cycle conversion of about 1:2.7
    ([Hixson et al., 2004](https://digitalcommons.memphis.edu/facpubs/14310)). The
    TTPF form above was not re-verified against a primary source in this work, so the
    exact constants are a documented assumption.

- **Identification as an opponent** is treated as a recognition-level task
  (**N50 = 4 cycles**). **[L→E]**
  - Telling friend from foe depends on context the model does not have: uniforms,
    weapons, the direction someone comes from, expectation.
  - 6.4 cycles (identifying a vehicle's type) would put identification of a prone
    person at a few tens of metres.

### 2.2 Time

- **Search time.** Target-acquisition search models give the probability of finding a
  target within time t as `P(t) = P∞ (1 − exp(−t · P∞ / τ0))`. The mean time to find a
  detectable target is `τ0 / P∞`, with `τ0` about 3.4 s for a target in the field of
  view (the ACQUIRE / NVESD search model). **[L]**
  - These assume an observer actively searching a sensor field of view.
  - A walking squad is not doing that. The model scales the rate by attention:
    - unalerted 0.3, alerted 1.0; **[E]**
    - outside central vision 0.3. **[E]**
- **The asymptote matters.** `P∞` is the probability the observer _ever_ finds the
  target under those conditions, not a rate.
  - A first draft treated it as a rate. The result was that 169 observer–target pairs
    found each other at 1.4 km within seconds.
  - The model now draws, once per observer–target pair, a threshold `u ~ U(0, 1)`. The
    target is detectable to that observer only while `P∞ > u` (so the long-run share of
    pairs that detect is `P∞`), and then is found at rate `P∞ / τ0`. The thresholds are
    part of the state (drawn from the simulation's random numbers at the start).

### 2.3 What changes the probability

| Factor                 | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Model                                                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Distance, angular size | Cycles fall as 1 / range (geometry). **[L]**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `N = dimension / (range × cycle angle)`                                                                                                   |
| Contrast, clutter      | Detection needs contrast against the background; clutter (woods, buildings) lowers it. The TTP metric is contrast-dependent. **[L]** Values here are guesses. **[E]**                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A multiplier on N per visibility class: open 0.25, wooded 0.20, urban 0.25, restricted 0.30 **[E]**                                       |
| Haze, mist, dusk       | Apparent contrast falls as `exp(−σ r)`. Koschmieder's 2 % threshold gives visibility `V = 3.912 / σ`, so contrast × `exp(−3.912 r / V)` ([Koschmieder, in Visibility](https://en.wikipedia.org/wiki/Visibility); [CIE e-ILV 17-31-020](https://cie.co.at/eilvterm/17-31-020); [WMO CIMO guide](https://old.wmo.int/extranet/pages/prog/www/IMOP/publications/CIMO-Guide/Prelim_2018_ed/8_I_9_en_MR_tc.pdf)). **[L]** It is derived for distant objects against the horizon sky; it fits badly for detecting objects at hundreds of metres ([Lee & Shang 2016](https://cocc.xmu.edu.cn/Lee_2016_Visibility.pdf)). **[L→E]** | `exp(−3.912 r / V)` on N; V per class: 20 km clear, 10 km urban haze, 600 m restricted **[E]**                                            |
| Movement               | Motion draws the eye, especially in peripheral vision (a general psychophysical finding). **[L]** No usable value for this setting. **[E]**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | × 1.5 on N while the target moves > 0.3 m/s **[E]**                                                                                       |
| Firing                 | Muzzle flash, sound and dust give a shooter away. No value. **[E]**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | × 3 on N for 3 s after a burst; a force under fire gets a possible contact on the shooter (confidence 0.45) **[E]**                       |
| Posture                | A smaller silhouette means fewer cycles (geometry). **[L]**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Critical dimension by posture **[E]**                                                                                                     |
| Partial occlusion      | Only the visible part of the target counts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Sight lines to 3 heights on the target (posture-dependent); N × the share in sight; vegetation along the line × (1 − depth / see-through) |
| Attention              | Search is slower outside central vision and when not expecting contact. **[L]** Values are guesses. **[E]**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Central ±60°, field of regard ±110° (nothing behind); rate × 0.3 peripheral, × 0.3 unalerted **[E]**                                      |
| Observation time       | Exponential search-time law (§2.2). **[L]**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Looks every 1 s (staggered); chance `1 − exp(−rate × 1 s)`                                                                                |
| Illumination           | Night requires a different (scotopic / sensor) model. **[L]**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Not modelled beyond the _restricted_ class (dusk, mist): low V, 400 m limit **[E]**                                                       |

There is **no universal naked-eye detection range**: it emerges from the factors above
and differs by terrain, posture, movement, time and seed.

### 2.4 Confidence, levels and hysteresis

- Each glimpse adds 0.4 to the force's confidence in that soldier (at most 1).
  Confidence halves every 15 s without one. **[E]**
- **Levels:**
  - _possible_ from a first glimpse;
  - _detected_ once confidence reaches 0.7 (two glimpses close together);
  - _identified_ by a further draw at the identification cycles, once detected;
  - _lost_ below 0.3;
  - forgotten below 0.03;
  - an unconfirmed track below 0.1 is dropped. **[E]**
- The gap between 0.7 (confirm) and 0.3 (lose) is the hysteresis: a contact does not
  flicker between detected and lost while glimpses come and go.
- A confirmed contact still in view is kept at 4× the rate (the observer knows where to
  look). **[E]**
- Detection records the target's true position at the glimpse (no localisation error;
  a limitation).

## 3. What the model gives (measured, F1)

Two squads in wedge, 1.4 km apart, walking at each other at 1.4 m/s. First report and
range, 8 seeds each:

| Terrain | First possible contact | First confirmed | First identified | Notes                                                                           |
| ------- | ---------------------- | --------------- | ---------------- | ------------------------------------------------------------------------------- |
| Open    | 980–1190 m             | 750–1030 m      | 290–380 m        | Every seed                                                                      |
| Wooded  | 270–630 m              | 250–640 m       | 260–410 m        | Depends on the woods between                                                    |
| Urban   | 570–750 m              | 500–640 m       | (later)          | Only where a street gives a sight line; 4 of 8 seeds had no sight line in 400 s |

These are model outputs, not claims about the real world. They are plausible in order
of magnitude:

- a group of upright people walking in the open is noticed far off;
- identification comes at a few hundred metres;
- woods and buildings cut detection to what the ground allows.

## 4. Parameters and their status

All parameters are in `src/exercise/forces/fof-v2.json` (`detection`,
`visibility`).

| Parameter                                            | Value                        | Status |
| ---------------------------------------------------- | ---------------------------- | ------ |
| TTPF form, E = 2.7 + 0.7 x                           | —                            | [L]    |
| Detection N50                                        | 1 cycle                      | [L→E]  |
| Identification N50                                   | 4 cycles (recognition level) | [L→E]  |
| Search time constant τ0                              | 3.4 s                        | [L→E]  |
| Haze law, 3.912 / V                                  | —                            | [L→E]  |
| Cycle angle                                          | 3′                           | [E]    |
| Critical dimensions, eye and target heights          | see file                     | [E]    |
| Contrast and visibility by class, observation limits | see file                     | [E]    |
| Attention, movement and firing factors               | see file                     | [E]    |
| Confidence gain, thresholds, half-life, tracking     | see file                     | [E]    |

## 5. Determinism

- **Draws come in a fixed order, from the simulation's random numbers:**
  - the pair thresholds, once at the start;
  - then per decision, in soldier order, each observer's look at each enemy (one draw,
    plus one for identification once confirmed).
- **Looks happen on the decision grid** (every 1 s per observer, staggered by soldier),
  so tick rates whose ticks end on the grid give bit-identical runs (10, 30, 60 and
  120 Hz tested).

## 6. Limitations

- No reporting delay inside a force, and no localisation error.
- No night or sensor model; no camouflage or individual observer skill beyond the pair
  thresholds.
- No sound beyond the under-fire cue; no deliberate sectors of observation beyond the
  field of regard of each soldier's facing.
- Visibility classes are broad conditions set for the experiment; the ground's own
  features (buildings, woods) act through the sight lines whatever the class.
