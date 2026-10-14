# Behavior Lab 02: research survey

- Status: research
- Date: 2026-10-14
- Part of: [Behavior Lab research](README.md)

This surveys behaviour architectures, formation control, steering, group navigation, JavaScript and
TypeScript libraries, and military movement doctrine, with a verdict for Ambush! on each.

**How sure we are of each claim:**

- **[V]** verified in this research from the primary text, source code, the npm registry or the GitHub API (dates checked 2026-10-14);
- **[S]** secondary source or summary only;
- **[I]** our inference or engineering judgement.

Doctrine claims are labelled differently in §6.

## 1. Conclusions first

1. **Neither a behaviour tree nor an HTN is needed for MOVE_IN_FORMATION.**
   - The two closest precedents both treat "move as a group" as a _unit task_ that turns into orders for subordinates, executed by steering. A planner adds nothing to it:
     - ModSAF's task frames (§2.3) [V];
     - Killzone 2's layered bots (§2.1) [V].
   - Planners pay off later, for contingent tactics such as bounding overwatch and reacting to contact.
2. **The best formation model for infantry is a virtual anchor on a shared route, with slots defined along the route, moderated by the members' progress, and members steering to their slots.**
   - It combines four verified sources: Millington's anchor-point formations, Mars & Chanut's hierarchical groups, Jurney's Company of Heroes squads, and Kamphuis & Overmars' clearance corridors.
   - The leader is a slot, not the frame. Balch & Arkin found unit-centre references better than leader references [V].
3. **One route per group, not per Marine.**
   - Every source that moves coherent groups uses a shared path with local steering: Pottinger, Jurney, Mars & Chanut, Kamphuis & Overmars.
   - Followers need only bounded local searches, and only when blocked.
4. **No JavaScript library is mature, deterministic and suitable enough to own the movement.**
   - Every behaviour-tree library we checked uses `Math.random` or `Date` by default [V].
   - Yuka is unmaintained and unseeded [V].
   - recast-navigation-js and navcat are good, but solve a navmesh problem Ambush! does not have; Ambush! already has a deterministic grid A\*.
   - The algorithms are small and well documented. They should be implemented in-house, in `src/sim`, with the libraries as references.
5. **Doctrine is deliberately imprecise, and the simulation should be too.**
   - Marine doctrine: "It is not important that exact distances and intervals be maintained … as long as control is not lost" (MCRP 3-10A.4, p. 1-17).
   - The one hard rule is visual contact: each Marine can see his team leader, and each team leader the squad leader.
   - Perfect geometric formations would be _less_ realistic.

## 2. Behaviour architectures

### 2.1 Hierarchical Task Networks (HTN)

**What it is.** HTN planning decomposes compound tasks into subtasks through methods with preconditions until only primitive tasks remain. The SHOP family plans tasks in the order they will be executed.

- SHOP2: Nau et al., _JAIR_ 20, 2003, https://www.jair.org/index.php/jair/article/view/10362 [V].
- SHOP3 (Common Lisp, MPL, 4.2, March 2026): https://github.com/shop-planner/shop3 [V].

**In games.**

- **Killzone 2 multiplayer bots** (Verweij's 2007 MSc thesis, Guerrilla) [V]. https://www.guerrilla-games.com/media/News/Files/VUA07_Verweij_Hierarchically-Layered-MP-Bot_System.pdf
  - Structure: one commander per faction, commanding group leaders, commanding individual bots.
  - Rates: individuals replan five times a second, squads twice.
  - Communication: orders flow down; "tactical updates" flow up and are summarised.
  - Planning: each layer has its own planner at its own rate. There is no single HTN spanning echelons.
- **Transformers: Fall of Cybertron.** Humphreys, "Exploring HTN Planners through Example", _Game AI Pro_ ch. 12, http://www.gameaipro.com/GameAIPro/GameAIPro_Chapter12_Exploring_HTN_Planners_through_Example.pdf [V].
  - A total-order forward-decomposition planner, "considerably faster than our GOAP system".
  - It replans when the plan ends or fails, or when a sensor changes the world state.
  - Documented pitfalls: spurious replans caused by the plan's own effects, and priority interruption needing careful world-state design.
- **Horizon Zero Dawn / Decima.** HTN plus utility, with in-game debugging of decompositions [V, talk summaries]. https://www.guerrilla-games.com/read/htn-planning-in-decima

**Libraries.**

- **Fluid HTN** (C#, MIT, active March 2026) [V]: partial plans, priority replanning through a "method traversal record", and pluggable sub-domains. https://github.com/ptrefall/fluid-hierarchical-task-network
- Its JavaScript port `gameplan-htn` (1.0.1, December 2022, untyped) is abandoned [V].
- `mahler` (TypeScript) is archived [V].
- **There is no maintained, typed JavaScript or TypeScript HTN.** Porting Fluid HTN's core is roughly 1–2k lines [I].

**Fit.**

- Determinism is good: depth-first search over a copied world state, with fixed method order.
- Interruption and replanning are where the work is (Humphreys).
- HTNs decompose _tasks_, not _organisations_. Killzone used separate planners per layer, which communicate by orders and reports.
- **For MOVE_IN_FORMATION an HTN would decompose into a single method.** Overkill now; useful later for tactics. Rejected for this milestone, with a place left for it (see [03 §11](03-architecture-proposal.md#11-extensibility-future-orders)).

### 2.2 Behaviour trees

**Foundations.**

- Isla's prioritised behaviour lists in Halo 2 (GDC 2005) [S].
- Colledanchise & Ögren, _Behavior Trees in Robotics and AI_ (CRC 2018, free at https://arxiv.org/abs/1709.00084) [V]. Behaviour trees are "modular and reactive" and generalise earlier switching structures.

**Ticked or event-driven.**

- Unreal's behaviour trees are event-driven, with blackboard-observing decorators that abort branches [V]. https://dev.epicgames.com/documentation/en-us/unreal-engine/behavior-tree-in-unreal-engine---overview
- In a fixed-step deterministic simulation, _ticked_ trees are simpler to make reproducible [I]. Ticking 50 trees at 30 Hz costs nothing [I].

**Libraries** [V, in source]:

| Library                           | Version and maintenance                    | Determinism hazards                                                                                                                                                 | Other                                                                                  |
| --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **mistreevous** (TypeScript, MIT) | 4.3.1, July 2025; repo active October 2026 | `Wait` uses `Date` unless `getDeltaTime` is given; Repeat, Retry, Wait and Lotto use `Math.random` unless `random` is given; internal UIDs always use `Math.random` | No documented serialisation of runtime state. https://github.com/nikkorn/mistreevous   |
| **behavior3js** (MIT)             | 0.2.2, 2017; last commit October 2018      | `Date` in Wait; `Math.random` UUIDs                                                                                                                                 | Untyped. Its editor's format is still useful. https://github.com/behavior3/behavior3js |
| **BehaviorTree.js** (MIT)         | 3.0.0-beta.1, January 2023                 | Random node uses non-injectable `Math.random`                                                                                                                       | https://github.com/Calamari/BehaviorTree.js                                            |

**Fit.**

- Behaviour trees are good at _selecting and sequencing_ behaviours and recovering from failure. They are easy to visualise.
- MOVE_IN_FORMATION has almost nothing to select between: move, wait for stragglers, settle. A small explicit state machine is clearer and serialises trivially.
- **Not adopted now.** A ticked tree of our own, with state kept in `SimState`, is the likely shape for later composite orders (PATROL, REACT TO CONTACT). A library would need its random numbers, clock and runtime state all wrapped; that costs more than the ~300 lines of a tree written for the purpose [I].

### 2.3 Military constructive simulations

**ModSAF** (Mohn, NPS thesis, 1994, summarising Calder et al. 1993 and Ceranowicz 1994) [V]: http://hdl.handle.net/10945/43003

- **Tasks** are augmented finite state machines of five kinds: unit, individual, reactive, enabling and arbitration.
- **Task frames** are mission phases ("Road March", "Occupy Assembly Area").
  - Unit task frames add, change and delete tasks in _subordinate_ units: orders flow down.
  - Each unit or entity has a **frame stack**. Reactive tasks push frames: opaque frames suspend those below, transparent ones overlay. Popping resumes.
- **Roles:** "a tank platoon leader is also the commander of his individual tank". This is exactly the squad-leader-is-also-a-rifleman problem.
- **Task manager:**
  - Each tick it collects tasks, **sorts them topologically by declared before/after lists**, suspends dropped tasks, and runs the rest in order.
  - Arbitrators run last and pick between competing actuator recommendations.
- It is **deterministic by construction**, and models interruption, resumption and organisational decomposition directly.

**OneSAF** [S; primary sources unreachable]:

- Behaviours are composed from coded "primitive behaviours" into XML "composite behaviours".
- Units are "organizations of entities".
- We could not verify whether composite control flow is a tree, a state machine or a flowchart.

**ArmA/VBS** [S]:

- Finite state machines coordinate the AI.
- Groups follow the leader's waypoints in formation.
- Danger reactions are a replaceable FSM (`danger.fsm`).

**Verdict.**

- The ModSAF model is the closest fit to Ambush!'s organisation: hierarchical tasks, each a small state machine, run in a deterministic order, with a stack for interruption.
- We adopt its _shape_, not its size: one task per ordered unit, and no stack until a second behaviour exists.

### 2.4 GOAP, utility AI, hierarchical state machines

- **GOAP** (Orkin, F.E.A.R., GDC 2006) [V] plans action sequences with A\*. https://pages.cs.wisc.edu/~dyer/cs540/handouts/gdc2006_orkin_jeff_fear.pdf
  - Humphreys reports HTN faster in practice.
  - Its regressive search must finish before the first step is known.
  - Not useful for movement.
- **Utility AI** (Dave Mark, IAUS) [S] is good for _choosing among options_: target, cover point, formation type, slot assignment costs. Deterministic if scores are pure and ties go by id [I]. https://gameai.com/iaus.php
  - **Adopted in miniature:** formation-type selection by terrain context is a scored choice with hysteresis.
- **Hierarchical state machines** are hard to extend [S], but at the size of one movement task a flat state machine is the simplest correct thing.

### 2.5 Architecture verdict

| Option                                   | For MOVE_IN_FORMATION                  | For later orders            | Verdict                                               |
| ---------------------------------------- | -------------------------------------- | --------------------------- | ----------------------------------------------------- |
| HTN                                      | One method; adds a planner for nothing | Good for contingent tactics | Defer; leave a seam                                   |
| Behaviour tree library                   | Little to select; library hazards      | Good for composite orders   | Reject the libraries; our own small ticked tree later |
| ModSAF-style unit tasks (state machines) | Exactly the shape                      | Extends with a frame stack  | **Adopt**                                             |
| Utility scoring                          | Formation choice, slot costs           | Target and cover choice     | Adopt as a utility, not an architecture               |
| GOAP                                     | No                                     | Weak                        | Reject                                                |

## 3. Formation control and steering

### 3.1 Leader following: Company of Heroes [V]

Source: Jurney, "Company of Heroes Squad Formations Explained", _AI Game Programming Wisdom 4_ (2008), §2.1. We read a forum copy: https://forum.arongranberg.com/uploads/short-url/rWod3K2KhNWcOEdjewnsLXQKU6A.pdf

**Structure.**

- A squad is three elements: core, left and right. Element leaders follow the squad leader; followers follow their element leader.
- Role changes are **stable (minimum swaps)**, because a soldier running from one side to the other "looks awkward".

**Follower targets and speed.**

- A follower's goal is the leader's position **about 2 s ahead along the leader's path**, plus the formation offset rotated by the leader's _future_ heading.
- **Speed:** along the direction of motion, a follower ahead of his current slot is slowed and one behind is sped up, in proportion to the distance. Lateral error is left to the steering.

**"Softening the shape".**

- A cheap A\* (**50–100 nodes**) runs from the leader's future position to the ideal slot. The follower uses the node nearest the slot that the search reached.
- The formation "squeeze[s] in organically at chokepoints", and goals never end up behind walls.

**Other features.**

- Each soldier has a bounded random-walk **drift** offset, against robotic precision.
- **Repath throttling:** a follower repaths only when the goal changes enough, in practice every 0.5–0.75 s.
- **Context formations:** wide wedge in the open, tight wedge in confined areas, staggered column on roads, chosen by the terrain under the leader.
- **Virtual leader:** used only while the real leader leapfrogs. A permanently virtual leader "can get significantly ahead of, or behind, the actual units" (Homeworld).

**Fit:** excellent for 3–50 soldiers. This is the most directly relevant source.

### 3.2 Anchor point (virtual structure) and drift offset: Millington [S, through a faithful implementation]

Millington & Funge, _AI for Games_, 2nd ed., ch. 3; the details below come from libGDX gdx-ai, which implements the design. https://github-wiki-see.page/m/libgdx/gdx-ai/wiki/Formation-Motion

**Two-level steering.**

- An invisible **anchor** is steered along the path, and each member steers to its slot (anchor pose + offset), avoiding obstacles on its own.
- The anchor must stay slower than its members; about half their speed is suggested.

**Keeping the anchor honest.**

- **Moderation:** the anchor can be reset to the members' centre of mass, pushed ahead by velocity. This stops it running away.
- **Drift offset:** the centre of mass of the _occupied_ slots is subtracted, so a formation with missing members does not drift or spin. It is recomputed only when membership changes.

**Patterns, roles and hierarchy.**

- Scalable patterns compute their slots from the member count.
- Hard and soft slot roles; members that are hardest to assign go first.
- **Hierarchical formations:** "each formation has its own anchor point whose steering is managed in turn by another formation". This is motivated explicitly by military organisation.

**Fit:** the backbone of our design, with Jurney's warning applied: the anchor is moderated by member progress.

### 3.3 Behaviour-based formations: Balch & Arkin 1998 [V]

_IEEE Transactions on Robotics and Automation_ 14(6), https://sites.cc.gatech.edu/ai/robot-lab/online-publications/formjour.pdf

- Motor schemas (move to goal, avoid obstacle, avoid robot, keep formation) are summed with weights.
- Three reference schemes: unit centre, leader, and neighbour.
- **The unit-centre reference performed better than the leader reference.** The motivating application was a military scout unit (DARPA's UGV programme).
- Weight tuning is fragile and suffers local minima.

**Fit:** supports a member-moderated anchor rather than a pure leader frame. Summed vectors suit the _member_ level only.

### 3.4 Reynolds steering [S]

- Boids (1987): https://www.red3d.com/cwr/boids/
- "Steering Behaviors for Autonomous Characters" (GDC 1999): https://www.red3d.com/cwr/papers/1999/gdc99steer.pdf

Seek, arrive, separation, path following and leader following, with movement split into action selection, steering and locomotion. A pure flock has no shape, roles or orientation, and stops being coherent in clutter (Kamphuis & Overmars) [V].

**Fit:** use the primitives (_arrive_ for slots, weak _separation_ within a team), not flocking.

### 3.5 Coordinated unit movement: Pottinger, Age of Empires II (1999) [V]

https://www.gamedeveloper.com/programming/coordinated-unit-movement and https://www.gamedeveloper.com/programming/implementing-coordinated-movement

- **Cohesion levels:** same speed, same path, arrive together. The group moves at its slowest member's speed; stragglers get a temporary boost.
- **Formation states:** broken, forming, formed. Slots are filled **from the centre outward**.
- **Turns:** lines _wheel_, which means stopping, rotating and re-forming.
- **Narrow passages:** scale the offsets, split into halves and rejoin.
- **Priorities** give a total order of who yields.
- **Path stack:** one high-level path shared by the formation, with local paths below it.

**Fit:**

- Adopt: the path stack, the cohesion levels, the forming/formed states and priority yielding.
- Avoid: stop-and-wheel while moving.

### 3.6 Hierarchical group navigation: Mars & Chanut (Game AI Pro 2, ch. 20) [V]

http://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter20_Hierarchical_Architecture_for_Group_Navigation_Behaviors.pdf

**The group as an entity.**

- A group is an entity whose members are entities: a composite.
- Its speed is limited by its slowest member. **Its turn rate is limited by member speed and group width.**

**Pipeline and update order.**

- Navigation is a pipeline: path following, then personality noise, then collision avoidance.
- **Members read the group's state from the previous tick.** Updates become order-independent; the lag is one tick per level.

**Splitting, paths and slots.**

- Splitting and merging belong to a higher control layer, not to the navigation behaviours.
- In group pathfinding, compressing to a narrower shape should cost about as much as an equivalent detour.
- **Slot assignment:**
  - greedy nearest-slot causes crossings and members circling the formation;
  - spatial sort-and-match works when slots have no roles.
- **Slot extrapolation:** slots are extrapolated along the group's velocity, and the horizon sets how tight the formation is.
- **Avoidance:** RVO's safety margins "might forbid close formations", so members inside a group need different avoidance rules.

**Fit:** very high. Together with §3.1 and §3.2, this is the proposed architecture.

### 3.7 Steering circles: Bjore (Game AI Pro, ch. 21) [V]

http://www.gameaipro.com/GameAIPro/GameAIPro_Chapter21_Techniques_for_Formation_Movement_Using_Steering_Circles.pdf

- Two turning circles give a Dubins-like approach that arrives at a pose and facing without turning sharper than allowed.
- Two following styles:
  - "column": each unit follows the unit ahead in its column;
  - "band": rows are preserved and the inside unit leads.
- Open terrain only.

**Fit:** the "column" style is the discrete form of route-relative slots (§3.9). Steering circles are a later option for a platoon line's final approach.

### 3.8 Slot assignment

| Method                                       | Source                                                                                                                                                                   | Verdict                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Greedy nearest                               | Mars & Chanut [V]                                                                                                                                                        | Reject: crossings, circling                                                 |
| Centre-outward filling                       | Pottinger [V]                                                                                                                                                            | Heuristic, at forming time                                                  |
| Spatial sort and match                       | Mars & Chanut [V]                                                                                                                                                        | No roles; fails for rotated shapes [I]                                      |
| Most-constrained first with soft roles       | Millington [S]                                                                                                                                                           | Handles roles, heuristic                                                    |
| Stable, minimum swaps                        | Jurney [V]                                                                                                                                                               | Essential                                                                   |
| Minimum sum of squared distances (Hungarian) | Turpin, Michael & Kumar, "CAPT", _IJRR_ 33(1) 2014 [S], https://www.ri.cmu.edu/publications/capt-concurrent-assignment-and-planning-of-trajectories-for-multiple-robots/ | For identical agents in straight lines, gives **non-crossing** trajectories |

**For Ambush!:** roles decide most slots. The template says where the team leader, automatic rifleman and others go, so assignment is almost fixed by role.

- Free choices are only mirroring (left/right shoulder, which team takes which flank) and swaps among same-role members.
- Solve them per hierarchy level (n ≤ 4 children, at most 24 permutations) by exhaustive search. Use integer-quantised squared distance plus role costs plus a stickiness bonus for the current assignment, and break ties by id.
- No general Hungarian solver is needed until slots stop being role-bound [I].

### 3.9 Turning

- **Wheeling** (stop, rotate, re-form) suits lines at the halt. It looks robotic on the move [V, Pottinger].
- **Rigid rotation** about the anchor demands speed ω·r from outer members. The group turn rate must be limited (Mars & Chanut [V]).
- **Route-relative slots** [I, built on Jurney's "future position along the leader's path" and Bjore's "column", both V]:
  - Each slot is (Δs metres behind the anchor along the route, d metres to its side).
  - Its target is P(s − Δs) + d·N(s − Δs), where P is the route point and N the route's normal.
  - Members therefore follow the route through bends as people do ("follow me and do as I do"), and nobody slides sideways round a pivot.
  - At a sharp corner, inner and outer members at the same Δs would bunch. Rounding route corners to a radius of at least the formation half-width prevents it.
- Doctrine gives **no geometric rule for turning** [D: absence noted in §6.4]. It rejects drill-field precision.

### 3.10 Compression, splitting and speed matching

**Compression.**

- Jurney: search-clamped slots and context formations [V].
- Kamphuis & Overmars [V]: the group occupies a bounded _area_ inside a clearance corridor. As the corridor narrows, the group lengthens into a column on its own.
  - "Finding paths for coherent groups using clearance", SCA 2004: https://diglib.eg.org/items/0537cb83-74d9-4a61-aea5-9331e525c28e/full
  - Members pass obstacles on the same side and wait for their mates.
- Pottinger: scaling and halving [V].

**Speed.**

- Pottinger: slowest member's speed, plus a straggler boost [V].
- Jurney: proportional along-track correction [V].
- gdx-ai: anchor moderated by members [S].
- Kamphuis & Overmars: the head waits for the tail [V].

**Proposed combination [I].** It avoids both stop-start movement and a runaway anchor:

- each member's speed is v_pref·(1 + k·along-track error), clamped to [0.6, 1.3]·v_pref, with an acceleration limit;
- the anchor's speed falls smoothly to zero as the worst member's lag approaches a limit.

## 4. Collision avoidance

| Method                       | Source                                                                                                          | Strengths                                            | Weaknesses                                                                                                                                                                                                                           | Fit                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **ORCA/RVO**                 | van den Berg et al. 2008, 2011, https://gamma.cs.unc.edu/ORCA/; RVO2 (Apache-2.0) https://github.com/snape/RVO2 | Smooth, O(n·k), well understood                      | Safety margins fight tight formations; deadlocks in passages; RVO's reciprocity fails for 3+ agents (Sunshine-Hill, GAP3 ch. 19 [V], http://www.gameaipro.com/GameAIPro3/GameAIPro3_Chapter19_RVO_and_ORCA_How_They_Really_Work.pdf) | Between groups, at scale; not within a team           |
| **Time-to-collision forces** | Karamouzas, Skinner & Guy, _PRL_ 113 (2014) [S], https://arxiv.org/abs/1412.1082; GAP2 ch. 19                   | Anticipatory, additive with formation forces, simple | Needs tuning                                                                                                                                                                                                                         | **Recommended** between members of different elements |
| Social force                 | Helbing & Molnár 1995 [S]                                                                                       | Realistic at crowd density                           | Reactive, oscillates, uses `exp()`                                                                                                                                                                                                   | Reject as primary                                     |
| Boids separation             | Reynolds [S]                                                                                                    | Cheapest                                             | Reactive                                                                                                                                                                                                                             | Within a fire team                                    |
| Priority yielding            | Pottinger [V]                                                                                                   | Deterministic total order; breaks deadlocks          | Not smooth on its own                                                                                                                                                                                                                | Adopt at chokepoints                                  |

**Determinism.**

- ORCA's linear program and the time-to-collision forces use only `+ − × ÷` and `sqrt`, which are exactly specified [I].
- Neighbour order must be canonical, sorted by soldier index, never hash-bucket order.

**Measured.** This research ran a stand-in formation kernel in plain TypeScript: route-relative slots, catch-up speed, and spatial-hash separation with 4 m cells, at 30 Hz in Node 24. Runs were repeated and gave identical hashes.

| Soldiers | Kernel µs per tick | Neighbour pairs per tick |
| -------: | -----------------: | -----------------------: |
|        3 |                3.7 |                        5 |
|       13 |                7.2 |                       53 |
|       40 |               14.8 |                      178 |
|      100 |               24.0 |                      611 |
|      500 |              128.6 |                    2,701 |
|    1,000 |              280.5 |                    5,459 |

Steering and avoidance are not a cost concern even at 1,000 soldiers: under 1% of a 33 ms tick.

## 5. Group navigation and pathfinding

**Shared route.**

- One query per group, with members steering locally (Pottinger, Mars & Chanut [V]).
- Ambush!'s `planPath` (deterministic A\*, string pulling, bridges, roads) is the right planner. One call per order costs a few to 30 ms on typical legs.

**Clearance.**

- Kamphuis & Overmars widen a backbone path into a corridor of clearance discs [V].
- The Explicit Corridor Map (van Toll et al., SoCG 2016 [S], https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.SoCG.2016.70) generalises this to any radius.
- **For our grid [I]:** a one-pass distance transform (chamfer 3-4, integers) over the navigation grid gives:
  1. the corridor half-width at every route point, used to clamp the formation's lateral offsets;
  2. a later group-width cost term for A\*;
  3. automatic files on bridges and narrow streets.

**Flow fields** (Emerson, Supreme Commander 2, GAP1 ch. 23 [V], http://www.gameaipro.com/GameAIPro/GameAIPro_Chapter23_Crowd_Pathfinding_and_Steering_Using_Flow_Field_Tiles.pdf).

- Cost independent of agent count, and deterministic with integer fields.
- But one field serves one goal, and formation slots are all different goals.
- **Defer;** possibly for a 1,000-soldier single-destination move.

**HPA\*** (Botea et al. 2004 [S], https://webdocs.cs.ualberta.ca/~mmueller/ps/hpastar.pdf).

- Reported up to 10× faster than A\*, with paths within 1% of optimal.
- **Defer** until route latency on 5 km maps (0.3–0.9 s per cross-map leg, ADR 0016) becomes a problem for platoon orders.

**Smoothing.**

- Theta\* (GAP2 ch. 16) and the funnel algorithm (Mononen 2010) [S].
- Ambush! already string-pulls. The group route additionally needs:
  - rounding of corners to a radius tied to formation width;
  - resampling by arc length, for route-relative slots [I].

**Dynamic obstacles and local replanning.**

- Jurney: bounded follower searches every 0.5–0.75 s [V].
- Emerson: invalidation of dirty sectors [V].
- Ambush!'s obstacles are static within an exercise, so only other soldiers are dynamic. Avoidance handles them.

**Narrow passages and bridges.**

- Clamping offsets to clearance gives files.
- Entry order follows Δs.
- The head waits for the tail (Kamphuis).
- Priority yielding handles head-on meetings (Pottinger).

## 6. Military movement doctrine

**Labels in this section:**

- **[D]** doctrine, quoted or closely paraphrased with a citation;
- **[P]** practice or press reporting;
- **[I]** our inference.

The marines.mil PDFs refuse scripted downloads. We read identical public copies on archive.org.

### 6.1 Publications

| Publication                | Title                                                 | Date            | Link                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MCRP 3-10A.4**           | _Marine Rifle Squad_ (current)                        | 7 Aug 2020      | https://www.marines.mil/News/Publications/MCPEL/Electronic-Library-Display/Article/2472229/mcrp-3-10a4/ · https://archive.org/details/mcrp-3-10-a.-4-marine-rifle-squad-2020 |
| **MCRP 3-10A.3**           | _Marine Infantry Platoon_                             | 31 Aug 2020     | https://archive.org/details/mcrp-3-10-a.-3-marine-infantry-platoon-2020                                                                                                      |
| MCRP 3-10A.2               | _Infantry Company Operations_                         | 25 Jul 2024     | https://www.marines.mil/News/Publications/MCPEL/Electronic-Library-Display/Article/1780135/mcrp-3-10a2/                                                                      |
| **MCTP 3-01A**             | _Scouting and Patrolling_ (formerly MCWP 3-11.3)      | 24 Jul 2020     | https://archive.org/details/mctp-3-01-a-scouting-and-patrolling-2020_202603                                                                                                  |
| MCWP 3-11.2                | _Marine Rifle Squad_ (historical; Ambush!'s template) | 1991, Ch 1 1997 | https://archive.org/details/MCWP_3-11.2_Marine_Rifle_Squad                                                                                                                   |
| **ATP 3-21.8**             | _Infantry Rifle Platoon and Squad_ (Army)             | 11 Jan 2024     | https://archive.org/details/atp-3-21.8-infantry-rifle-platoon-and-squad-2024                                                                                                 |
| FM 3-21.8                  | _The Infantry Rifle Platoon and Squad_ (Army)         | 28 Mar 2007     | https://www.globalsecurity.org/military/library/policy/army/fm/3-21-8/index.html                                                                                             |
| **ATP 3-21.18** / FM 21-18 | _Foot Marches_                                        | 2017 / 1990     | https://archive.org/details/atp-3-21.18-foot-marches-2017 · https://archive.org/details/fm-21-18-foot-marches-1990                                                           |

### 6.2 Organisation

**USMC, historical (Ambush!'s current template)** [D] MCWP 3-11.2 paras 1003–1004:

- 13 Marines: a sergeant squad leader and three fire teams of four.
- Each team is a corporal team leader (also the grenadier, M16/M203), an automatic rifleman, an assistant automatic rifleman and a rifleman.

**USMC, 2020.**

- [D] MCRP 3-10A.4 Fig 1-1:
  - Still 13 Marines in three teams of four, but the roles are **team leader, automatic rifleman, grenadier, rifleman**.
  - The senior team leader acts as assistant squad leader.
  - A designated marksman may be added.
- [D] MCRP 3-10A.3 Fig 1-1 (the same month) still lists an AAR.
- [I] The AAR (1991) and the grenadier (2020) occupy the **same position** in every formation drawing. The geometry is identical, and only the role label differs.

**USMC, Force Design 2030** [P]:

- **12-Marine squad (2018).** Three teams of three, plus an assistant squad leader and a squad systems operator. It was announced, then abandoned within months.
- **15-Marine squad (2019, experimental).**
- **13 again in IBX-30.** Marine Corps Times, 2019 and 2024.
  - https://www.marinecorpstimes.com/news/your-marine-corps/2019/08/09/15-marine-rifle-squad-an-exclusive-look-inside-the-future-infantry/
  - https://www.yahoo.com/news/2024-phase-2-marine-infantry-075928142.html
- **April 2025 (the Commandant).** 13 Marines in three teams of four with a corporal assistant squad leader, plus an "organic precision fires specialist". Task & Purpose, https://taskandpurpose.com/news/marine-rifle-squads-commandant/
  - The table of organisation is not published.

**US Army** [D] ATP 3-21.8 (2024) paras 1-8 to 1-11:

- Squad: 9 Soldiers, a squad leader and two teams of four (team leader, automatic rifleman, grenadier, rifleman).
- Platoon: 39, made up of a headquarters of 3, three rifle squads and a weapons squad of 9.

**Marine platoon** [D] MCRP 3-10A.3:

- Platoon commander and platoon sergeant.
- Typically a radio operator drawn from the squads, and 1–3 corpsmen.
- Three squads.
- The "platoon guide" of older manuals is not in the 2020 headquarters.

**[I] Consequence:** organisation and role must be data, and slot geometry must refer to _roles_, not to soldier indices. This settles "do not hard-code one squad structure".

### 6.3 Formations

**General principles.**

- [D] FM 3-21.8 3-25/3-27: "Every squad and Soldier has a standard position. Soldiers can see their team leaders. Fire team leaders can see their squad leaders." "Formations do not demand parade ground precision."
- [D] MCRP 3-10A.4 pp. 1-17 to 1-22:
  - "Each fire team leader typically determines the formation for their own units… a squad may contain a variety of fire team formations at any one time."
  - "It is not important that exact distances and intervals be maintained… as long as control is not lost. Sight or voice contact should be maintained."
  - "All movement for changes of formation is usually by the shortest practical route."

**Base unit.** [D] MCRP 3-10A.4 p. 1-16:

- "The base fire team is used by the squad leader to control the squad's direction, position, and rate of movement."
- The others "do not need to maintain rigid positions in relation to the base fire team… [it] is used as a general guide."
- "If another fire team can move forward more rapidly than the base fire team, it should do so."
- [D] FM 3-21.8: in the squad column, the lead team is the base team.

**Fire-team formations (USMC)** [D] MCRP 3-10A.4 Figs 1-11 to 1-14. Front is up. The rifleman is at the **point** of the Marine wedge; the team leader and grenadier (AAR) are on the shoulders and interchangeable; the AR is at the rear centre.

```
COLUMN           WEDGE                 SKIRMISHERS RIGHT     ECHELON LEFT
  R                  R                 R        AR                   R
    TL          G         TL              TL        G           AR
  AR                 AR                                             TL
    G                                                         G
```

**Fire-team formations (Army)** [D] ATP 3-21.8 (2024) 3-44 to 3-48:

- Wedge and file only, with the **team leader at the point**.
- "The interval between Soldiers in the wedge formation is normally 10 meters. The wedge expands and contracts depending on the terrain."
- "The sides of the wedge can contract to the point where the wedge resembles a single file."
- "Follow me and do as I do. When the leader moves to the right, the Soldiers should move to the right."

**Squad formations (USMC)** [D] MCRP 3-10A.4 Figs 1-15 to 1-20. `[n]` is fire team n.

```
COLUMN     WEDGE              VEE                LINE              ECHELON RIGHT
 [1]         [1]           [3]      [2]       [3]  [1]  [2]         [1]
 SL          SL                SL                   SL                SL
 [2]      [2]   [3]            [1]                                      [2]
 [3]                                                                      [3]
```

**Squad leader's position** [D] MCRP 3-10A.4 p. 3-5: "just to the rear of their lead fire team or the position from which they can best control their squad".

**Platoon formations** [D] MCRP 3-10A.3 App A:

- Column, line, wedge, vee and echelon. The platoon commander is drawn just behind the centre or lead squad.
- [D] FM 3-21.8: "The platoon sergeant's element should be wherever the platoon leader is not."

**On roads** [D] MCRP 3-10A.4 p. 3-4:

- In a wedge, "the lead fire team moves on the edges of the road or trail. The two fire teams in the rear march off the road or trail, with one team on either side."
- When the road is bounded or there is a need for haste, a column, with teams "along alternate sides of the road".

**Changing formation** [D] MCRP 3-10A.4 p. 1-22: "Formation changes in varying or rough terrain are frequent as the squad moves over or around… rivers, swamps, jungles, woods, and sharp ridges."

- The squad leader orders the change by hand-and-arm signal to the team leaders.
- MCWP 3-11.2 Figs 3-12ff draw the transitions.

### 6.4 Numbers

| Value                                                                                                | Kind     | Source                                                                            |
| ---------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------- |
| Wedge interval normally **10 m**; contracts toward a file in close terrain                           | [D]      | ATP 3-21.8 (2024) 3-46; FM 3-21.8 3-34                                            |
| Marine squad: **no numeric interval**; sight or voice contact                                        | [D]      | MCRP 3-10A.4 p. 1-17                                                              |
| Traveling overwatch: lead team **≥ 50 m** ahead                                                      | [D]      | FM 3-21.8 3-72; ATP 3-21.8 3-79                                                   |
| Advance guard: point team **50–100 m** ahead                                                         | [D]      | MCRP 3-10A.4 Fig 3-1                                                              |
| Platoon elements **≤ 300 m** apart                                                                   | [D]      | FM 3-21.8 3-81                                                                    |
| Foot march: road **4.0 km/h** day, 3.2 night; cross-country **2.4** day, 1.6 night (including halts) | [D]      | ATP 3-21.18 (2017) Fig 1-2, 3-22; FM 21-18 ch. 3                                  |
| Spacing on a march: **2–5 m** day, **1–3 m** night                                                   | [D]      | ATP 3-21.18 1-101                                                                 |
| Between platoons on a march: 50 m day, 25 m night                                                    | [D]      | ATP 3-21.18 1-101                                                                 |
| March halts: 15 min after the first 45, then 10 per 50                                               | [D]      | ATP 3-21.18 2-52                                                                  |
| Pace: about 130 steps per 100 m                                                                      | [D]      | MCWP 3-11.2 ch. 2                                                                 |
| Free walking speed of pedestrians: mean **1.34 m/s**                                                 | Research | Weidmann 1993, https://www.research-collection.ethz.ch/handle/20.500.11850/242008 |
| Instantaneous road march speed ≈ 1.33 m/s (4 km/h including 10 min halts per hour)                   | [I]      | Derived                                                                           |

**What doctrine does not give:**

- intervals between teams within a squad (other than the overwatch figures);
- any rule for how a formation turns;
- catch-up behaviour, beyond FM 21-18's instruction to avoid the accordion effect.

**These are simulation choices [I]**, and are labelled as such in [03](03-architecture-proposal.md) and [05](05-test-and-benchmark-plan.md).

### 6.5 Reforming, halts and danger areas (context for later tasks)

**Halts** [D] MCTP 3-01A p. 4-7; FM 3-21.8 3-161:

- A short halt (1–2 min) means take a knee in cover. A long halt (over 10 min) means go prone.
- The "cigar-shaped" perimeter: Soldiers step off the route and face out, without orders.

**Danger areas** [D] MCTP 3-01A pp. 4-13 to 4-16:

- The linear danger-area drill: halt, near- and far-side rally points, security, the far side cleared, crossing by teams.
- Cross roads "at or near a bend, a narrow spot, or on low ground".

**Rally points** [D] MCTP 3-01A p. 4-9: "If the patrol is dispersed… patrol members return to the last designated rally point."

**Limited visibility** [D]: leaders move closer to the front, intervals are reduced, and speed is reduced.

**[I] Consequence.** Reforming in doctrine is _convergence on a leader or rally point by the shortest practical route_, not geometric restoration. Formation recovery should be modelled the same way.

## 7. Challenging the brief's assumptions

| Assumption                                       | Finding                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behaviour trees are the right choice             | Not for this task. A unit task with a three-state machine is enough. Trees are a candidate for composite orders later, implemented in-house (§2.2).                                                                                                                                             |
| HTNs are needed for formation movement           | No. They decompose to one method (§2.1).                                                                                                                                                                                                                                                        |
| Every Marine needs his own pathfinding           | No. One route per ordered group, plus bounded local searches for displaced members (§5, §3.1).                                                                                                                                                                                                  |
| Every echelon needs its own controller           | No. One controller per _ordered_ unit. Subordinate echelons are nested frames in the formation template. They gain their own controller only when they act independently, such as splitting at an obstacle or bounding ([03 §5](03-architecture-proposal.md#5-hierarchy-and-who-decides-what)). |
| Slots should be leader-relative                  | No. Route-relative, with the leader as a slot. Leader frames lurch when the leader sidesteps, and did worse in trials (§3.3, §3.9).                                                                                                                                                             |
| Local steering alone solves formation navigation | No. Purely local rules break coherence in clutter (Kamphuis & Overmars). A shared route and clearance are needed (§5).                                                                                                                                                                          |
| Realistic formations need complex algorithms     | No. The proven systems are simple: anchor, offsets, proportional speed, bounded search (§3.1).                                                                                                                                                                                                  |
| Existing JavaScript libraries are mature enough  | Not to own movement. Their hazards are verified (§2.2, Appendix A).                                                                                                                                                                                                                             |
| Perfect geometric formations are desirable       | No. Doctrine explicitly rejects precision. Tolerance bands and per-Marine variation are more realistic (§6.3).                                                                                                                                                                                  |

## Appendix A. Libraries

| Library                                                                     | Licence           | Latest release               | Maintenance                 | Capabilities                                                                                 | Determinism concerns                                                                                                                     | Use for Ambush!                                                                                                              |
| --------------------------------------------------------------------------- | ----------------- | ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [Yuka](https://github.com/Mugen87/yuka)                                     | MIT               | 0.7.8, Sep 2022              | Last master commit Jan 2023 | 14 steering behaviours (incl. offset pursuit), FSM, goals, navmesh, graph search, perception | `Math.random` in wander, `getRandomRegion`, `choice`, UUIDs; `performance.now` (fixed-delta option); `requestIdleCallback` [V]           | Reference only                                                                                                               |
| [recast-navigation-js](https://github.com/isaac-mason/recast-navigation-js) | MIT (Recast zlib) | 0.43.1, 2026                 | Active                      | Recast/Detour WASM: navmesh, DetourCrowd, tile cache                                         | Deterministic with fixed `dt` (its README); no random or clock in DetourCrowd [V]; state hidden in the WASM heap (snapshots awkward) [I] | Not needed: Ambush! has a grid planner                                                                                       |
| [navcat](https://github.com/isaac-mason/navcat)                             | MIT               | 0.4.1, May 2026              | Very active, pre-1.0        | Pure TypeScript navmesh and DetourCrowd-like crowd; JSON-serialisable                        | Injectable `rand`; explicit `deltaTime`; JavaScript trig [V]                                                                             | Best candidate _if_ a navmesh is ever needed                                                                                 |
| [three-pathfinding](https://github.com/donmccurdy/three-pathfinding)        | MIT               | 1.3.0, May 2024              | Maintained                  | A\* and funnel on a prebuilt navmesh                                                         | Needs three.js types                                                                                                                     | Wrong layer (sim cannot import three)                                                                                        |
| [PathFinding.js](https://github.com/qiao/PathFinding.js)                    | MIT               | 0.4.18, 2016                 | Dormant                     | Grid A\*/JPS                                                                                 | Not checked                                                                                                                              | No: Ambush!'s A\* is better suited                                                                                           |
| [ngraph.path](https://github.com/anvaka/ngraph.path)                        | MIT               | 1.6.1, Nov 2025              | Maintained                  | A\*, NBA\* on graphs                                                                         | No `Math.random` in A\* [V]                                                                                                              | Possible for abstract graphs later                                                                                           |
| [RVO2](https://github.com/snape/RVO2)                                       | Apache-2.0        | C++ reference, active        | Active                      | ORCA                                                                                         | Fixed time step; deterministic algorithm                                                                                                 | Port the 2D core (~1k lines) if inter-group avoidance ever needs it; the npm `rvo2` is a native addon (browser-unusable) [V] |
| [mistreevous](https://github.com/nikkorn/mistreevous)                       | MIT               | 4.3.1, Jul 2025              | Active                      | Behaviour trees, MDSL, guards                                                                | `Date` and `Math.random` by default (injectable); UIDs via `Math.random` [V]                                                             | Reference                                                                                                                    |
| [behavior3js](https://github.com/behavior3/behavior3js)                     | MIT               | 0.2.2, 2017                  | Dead                        | Behaviour trees and editor                                                                   | `Date`, `Math.random` [V]                                                                                                                | No                                                                                                                           |
| [BehaviorTree.js](https://github.com/Calamari/BehaviorTree.js)              | MIT               | 3.0.0-beta.1, Jan 2023       | Light                       | Behaviour trees                                                                              | Non-injectable `Math.random` [V]                                                                                                         | No                                                                                                                           |
| [Fluid HTN](https://github.com/ptrefall/fluid-hierarchical-task-network)    | MIT               | No releases; active Mar 2026 | Active                      | HTN, partial plans, priority replanning                                                      | Pure                                                                                                                                     | Port its core later if HTN is adopted                                                                                        |
| [gameplan-htn](https://www.npmjs.com/package/gameplan-htn)                  | MIT               | 1.0.1, Dec 2022              | Dead                        | JavaScript port of Fluid HTN                                                                 | Not checked                                                                                                                              | No                                                                                                                           |

**Determinism of JavaScript maths.**

- ECMAScript leaves `Math.sin`, `cos`, `atan2`, `exp` and `pow` implementation-approximated. Engines have differed.
  - https://esdiscuss.org/topic/es6-accuracy-of-special-functions
  - A 2026 report of Node and Chrome diverging [S]: https://codeberg.org/perplexdotgg/bounce/issues/8
- `+ − × ÷` and `Math.sqrt` are correctly rounded.
- Ambush!'s kernel already uses the transcendentals. ADR 0005 accepts that results may differ across engines, because the AAR replays recordings.
- **[I] Policy for the engine:**
  - Keep the same policy as the kernel.
  - Prefer vector arithmetic and `sqrt` over `atan2` and `hypot` in per-tick loops, for both speed and portability.
  - Never use `Math.random` (it is already banned by lint).
