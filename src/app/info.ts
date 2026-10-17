// The Info window (the header's INFO button, on every stage): what Ambush! is,
// what it can do, how it simulates combat, and what it does not do. A modal
// over everything; Escape, the close button or the backdrop close it. The
// header pauses a battle being fought or replayed while it is open, and
// resumes it after (`wireHeader`).

const INFO_HTML = `
<p class="info-lead">Ambush! is a real-time, deterministic force-on-force simulation of
small-unit infantry and armoured combat on real-world terrain. You build a battlefield,
set up and plan both sides, command either side live while the battle runs, then review
the whole battle afterwards.</p>

<h3>Key features</h3>
<ul>
  <li><b>Real-world battlefields.</b> Any 5 × 5 km area between 80° S and 84° N is generated
    from OpenStreetMap, Overture Maps buildings, open elevation data and a global tree
    canopy map. Battlefields are saved in the browser and play offline. Faulty elevation
    samples are found and repaired.</li>
  <li><b>One ground for everything.</b> A terrain field sampled down to 1 m, with roads,
    bridges, building pads, ditches, streams and levelled water built in. The 2D map, the
    3D view, movement, line of sight and replay all use the same ground.</li>
  <li><b>2D tactical map and 3D view.</b> Every stage works in either view, switching at any
    moment. The 3D view draws procedural buildings, trees, road markings and water,
    animated soldiers, vehicles, tracers and explosions.</li>
  <li><b>Five-stage workflow.</b> Terrain, Setup, Planning, Sim and After-Action Review.</li>
  <li><b>Forces.</b> BLUEFOR and OPFOR squads, fire teams and three-man elements in
    doctrinal formations. Vehicles: M1A1 Abrams, M113, T-72B and BMP-2. Anti-tank weapons:
    AT4, Javelin, RPG-7 and 9K111.</li>
  <li><b>Orders.</b> Move (optionally by the roads), Attack, Withdraw, Ambush (with a kill
    zone) and Defend (a sector, digging in over time). Each order says what the unit does on
    contact: Continue, Attack, Hold or Avoid.</li>
  <li><b>Viewsheds.</b> While planning, show what a squad can see from where it stands or
    from any of its waypoints.</li>
  <li><b>Live command.</b> Command either side during the battle, at ½× to 32×. Orders given
    while paused take effect when play resumes.</li>
  <li><b>After-Action Review.</b> The battle is replayed from its start by re-simulation and
    checked against the battle fought, every second. Jump to markers (contact, casualties,
    orders) and export a recording that reproduces the battle exactly.</li>
  <li><b>Scenarios.</b> Save, load, import and export scenarios (<code>.ambush.json</code>),
    or load the Quantico combined-arms demo from the Terrain screen.</li>
</ul>

<h3>How combat is simulated</h3>
<ul>
  <li><b>Clock and determinism.</b> The simulation advances in fixed steps (30 a second),
    with decisions every 0.1 s, and runs in a background worker. All chance comes from one
    seeded random stream, so the same scenario, seed and orders give the same battle,
    bit for bit.</li>
  <li><b>Individual soldiers.</b> Each soldier is simulated: position, posture (standing,
    kneeling, prone), weapon, ammunition and suppression. Squads move in formation on their
    orders.</li>
  <li><b>Seeing the enemy.</b> About once a second each soldier and vehicle crew looks over
    its field of view. Sight lines are traced through the ground and buildings to three
    heights on the target, and woods let only some light through. The chance of spotting
    follows a target-acquisition model from vision research (how many resolvable cycles
    the target presents): bigger, nearer and more exposed targets are found sooner. Movement
    and firing make a target more conspicuous; concealment and digging in make it less so.
    What a squad sees becomes its shared picture of the enemy, and confidence fades
    without new sightings.</li>
  <li><b>Reacting to contact.</b> A squad that meets the enemy halts and fights, assaults,
    holds or breaks contact, as its order says. Attacks advance by fire and movement, one
    element bounding while the others cover. Units pressing on under fire crawl. Ambushers
    lie concealed and open fire when the enemy is in the kill zone. Defenders are harder to
    hit, see and suppress the deeper they are dug in, but only from the front.</li>
  <li><b>Fire.</b> Soldiers fire aimed bursts at their weapons' doctrinal rates, with finite
    ammunition and reloads. Each round's chance to hit depends on range, the target's
    posture and exposure, and whether the shooter is moving or suppressed. Fire at a last
    known position suppresses but rarely hits. Rounds fly at their real speed (about
    900 m/s): a soldier hit falls, and those near are suppressed, when the burst arrives.
    Fire team leaders fire M203 grenades, which burst when they land (about 4 s at
    300 m).</li>
  <li><b>Suppression.</b> Rounds hitting or passing close build up suppression, which fades
    by half every 6 s. Suppressed soldiers fire less and less accurately; pinned soldiers
    go prone and stop firing.</li>
  <li><b>Effectiveness.</b> Each force's effectiveness combines its strength, ammunition,
    surviving leaders and suppression. A force that falls too far becomes combat
    ineffective or withdraws.</li>
  <li><b>Vehicles.</b> Routes are planned for the hull's width, by the roads or across
    country. Speed depends on the surface and slope, and vehicles brake for bends. They
    keep their interval in a column, pass oncoming vehicles and take crossings in turn.</li>
  <li><b>Combined arms.</b> Crews search out to 3 km through their optics (thermal sights
    see through more vegetation). Each weapon and target is weighed by the chance of a
    meaningful effect, the threat the target poses, its value and the ammunition's cost.
    Turrets slew and lay before firing. A hit is resolved against the armour of the face
    it strikes (front, side, rear or top), and damage behind the armour can destroy the
    vehicle or disable its mobility, weapons, sights or crew. Shells fly at their muzzle
    velocity and missiles at their flight speed, their hits landing when they arrive;
    wire-guided missiles need the gunner to keep the target in sight.</li>
</ul>

<h3>Known limitations</h3>
<ul>
  <li>Weapon, armour and detection values are representative approximations from open
    sources, not validated combat data.</li>
  <li>Ballistics are abstract: whether a shot hits is decided by its probability when it
    is fired (rounds, rockets and grenades then fly at a constant speed or on a simple arc,
    without drag or wind), and there are no ricochets.</li>
  <li>Soldiers do not seek cover, flank on their own or choose firing positions. Infantry
    does not mount or dismount vehicles.</li>
  <li>Rifles and machine guns never engage vehicles. Vehicles neither block sight lines nor
    give cover, and smoke does not block sight.</li>
  <li>Vehicles do not seek cover, reverse or withdraw on their own, and do not swim or
    ford. A vehicle can be held up by another one stopped in a street too narrow to pass.</li>
  <li>Armour is one figure per face: turret and hull are not distinguished, and reactive
    armour is not modelled.</li>
  <li>No indirect fire (artillery or mortars), aircraft or engineers. Battles are fought in
    clear daylight.</li>
  <li>Large battles cannot always keep up with high speeds. The speed actually achieved is
    shown in brackets next to the speed chosen.</li>
  <li>A battle in progress is not saved: reloading the page returns to Setup or Planning.</li>
  <li>Battlefield quality depends on the source map and elevation data. Desktop Chrome or
    Edge is required.</li>
</ul>
`;

/**
 * Opens the Info window over everything; `onClose` runs when it closes. Only
 * one is open at a time (a second call while one is open does nothing).
 */
export function openInfo(onClose: () => void = () => undefined): void {
  if (document.querySelector('.info-backdrop')) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'info-backdrop';
  backdrop.dataset['ui'] = 'info-window';
  backdrop.innerHTML = `<div class="info-window" role="dialog" aria-modal="true" aria-labelledby="info-title">
      <div class="info-head">
        <h2 id="info-title">About Ambush!</h2>
        <button class="info-close" data-ui="info-close" aria-label="Close" title="Close">×</button>
      </div>
      <div class="info-body">${INFO_HTML}</div>
    </div>`;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const close = () => {
    backdrop.remove();
    previous?.focus();
    onClose();
  };
  backdrop.addEventListener('keydown', (event) => {
    // The page's own keys (Escape cancels a tool, Delete deletes) never see it.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector('.info-close')?.addEventListener('click', close);
  document.body.append(backdrop);
  backdrop.querySelector<HTMLElement>('.info-close')?.focus();
}
