import { createExercise, DEMO_SCENARIO, INDIVIDUAL_ICONS, type IndividualIcon } from '#exercise';
import { createSession, selectSoldier, type Session } from '#session';
import { azimuthFromDegrees, DEFAULT_TICK_RATE_HZ, soldierId, type Vec2 } from '#sim';
import {
  createTacticalMap,
  drawSoldierIcon,
  ICON_BOX_SCALE,
  SOLDIER_ICON_PX,
  soldierIconSvg,
  type Affiliation,
  type SoldierIconSpec,
} from '#view2d';

// Development page (symbols.html), kept as a permanent tool: every individual
// soldier icon in every affiliation, at the sizes the design must stay legible
// at, drawn both as SVG and with the canvas code the tactical map uses
// (docs/adr/0013); and live tactical maps of the demo exercise, drawn by the
// production map widget itself (decluttering, labels, badges, selection).
// Nothing here draws icons its own way: it only calls the code the app uses.

const ROLE_NAMES: Record<IndividualIcon, string> = {
  squadLeader: 'Squad leader',
  fireTeamLeader: 'Fire team leader',
  rifleman: 'Rifleman',
  automaticRifleman: 'Automatic rifleman',
  grenadier: 'Grenadier',
  marksman: 'Marksman',
  medic: 'Medic',
  radioOperator: 'Radio operator',
};
const AFFILIATIONS: readonly [Affiliation, string][] = [
  ['friendly', 'Friendly'],
  ['enemy', 'Enemy'],
  ['friendly2', 'Friendly 2'],
  ['neutral', 'Neutral'],
  ['unknown', 'Unknown'],
];
const ROLES: readonly (IndividualIcon | null)[] = [...INDIVIDUAL_ICONS, null];
const roleName = (role: IndividualIcon | null) =>
  role === null ? 'Role unknown (e.g. OPFOR)' : ROLE_NAMES[role];

/** A canvas with the icon drawn by the map's own code, at the device pixel ratio. */
function iconCanvas(spec: SoldierIconSpec, sizePx: number, background?: string): HTMLCanvasElement {
  const box = Math.ceil(sizePx * ICON_BOX_SCALE);
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = box * dpr;
  canvas.height = box * dpr;
  canvas.style.width = `${String(box)}px`;
  canvas.style.height = `${String(box)}px`;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.scale(dpr, dpr);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, box, box);
    }
    drawSoldierIcon(ctx, spec, { x: box / 2, y: box / 2 }, sizePx);
  }
  return canvas;
}

function section(title: string, note: string): HTMLElement {
  const root = document.querySelector('#gallery');
  const div = document.createElement('section');
  div.innerHTML = `<h2>${title}</h2><p>${note}</p>`;
  root?.append(div);
  return div;
}

function table(head: readonly string[]): {
  table: HTMLTableElement;
  body: HTMLTableSectionElement;
} {
  const t = document.createElement('table');
  t.innerHTML = `<thead><tr>${head.map((h, i) => `<th class="${i === 0 ? 'row' : ''}">${h}</th>`).join('')}</tr></thead>`;
  const body = document.createElement('tbody');
  t.append(body);
  return { table: t, body };
}

// 1. Every role in every affiliation (SVG, 32 px, facing north).
{
  const s = section(
    'Roles and affiliations',
    'SVG at 32 px, facing north (000°). The last row is the plain circle used when a soldier’s role is unknown.',
  );
  const { table: t, body } = table(['Role', ...AFFILIATIONS.map(([, name]) => name)]);
  for (const role of ROLES) {
    const row = document.createElement('tr');
    row.innerHTML =
      `<th class="row">${roleName(role)}</th>` +
      AFFILIATIONS.map(
        ([affiliation]) => `<td>${soldierIconSvg({ role, affiliation, facing: 0 }, 32)}</td>`,
      ).join('');
    body.append(row);
  }
  s.append(t);
}

// 2. Legibility at 16, 24 and 32 px, SVG beside canvas.
{
  const s = section(
    'Sizes: 16, 24 and 32 px',
    `Each cell shows the SVG (left) and the canvas drawing the map uses (right). The map draws icons at ${String(SOLDIER_ICON_PX)} px.`,
  );
  const sizes = [16, 24, 32];
  const { table: t, body } = table(['Role', ...sizes.map((px) => `${String(px)} px`)]);
  for (const role of ROLES) {
    for (const affiliation of ['friendly', 'enemy'] as const) {
      const row = document.createElement('tr');
      row.innerHTML = `<th class="row">${roleName(role)} · ${affiliation}</th>`;
      for (const px of sizes) {
        const cell = document.createElement('td');
        const pair = document.createElement('span');
        pair.className = 'pair';
        pair.innerHTML = soldierIconSvg({ role, affiliation, facing: azimuthFromDegrees(45) }, px);
        pair.append(iconCanvas({ role, affiliation, facing: azimuthFromDegrees(45) }, px));
        cell.append(pair);
        row.append(cell);
      }
      body.append(row);
    }
  }
  s.append(t);
}

// 3. Facing: the triangle turns, the glyph stays upright.
{
  const s = section(
    'Facing',
    'Canvas at 32 px. The triangle turns about the circle’s centre; the role glyph never turns.',
  );
  const headings = [0, 45, 90, 135, 180, 225, 270, 315];
  const { table: t, body } = table([
    'Role',
    ...headings.map((d) => `${String(d).padStart(3, '0')}°`),
  ]);
  for (const role of ['grenadier', 'fireTeamLeader', 'radioOperator'] as const) {
    const row = document.createElement('tr');
    row.innerHTML = `<th class="row">${roleName(role)}</th>`;
    for (const d of headings) {
      const cell = document.createElement('td');
      cell.append(iconCanvas({ role, affiliation: 'friendly', facing: azimuthFromDegrees(d) }, 32));
      row.append(cell);
    }
    body.append(row);
  }
  s.append(t);
}

// 4. On map colours, at map size.
{
  const s = section(
    'On the map’s colours',
    `Canvas at ${String(SOLDIER_ICON_PX)} px over the tactical map’s terrain tints, woodland and road colours.`,
  );
  const wrap = document.createElement('div');
  wrap.className = 'terrain';
  for (const background of ['#b2c49c', '#d8c8a0', '#6f9a63', '#ecdfbf', '#9aa08c']) {
    const strip = document.createElement('canvas');
    const width = 8 * 40 + 20;
    const height = 50;
    const dpr = window.devicePixelRatio || 1;
    strip.width = width * dpr;
    strip.height = height * dpr;
    strip.style.width = `${String(width)}px`;
    strip.style.height = `${String(height)}px`;
    const ctx = strip.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
      INDIVIDUAL_ICONS.forEach((role, i) => {
        drawSoldierIcon(
          ctx,
          {
            role,
            affiliation: i % 2 === 0 ? 'friendly' : 'enemy',
            facing: azimuthFromDegrees(i * 45),
          },
          { x: 30 + i * 40, y: 27 },
          SOLDIER_ICON_PX,
        );
      });
    }
    wrap.append(strip);
  }
  s.append(wrap);
}

// 5. The production tactical map, live: the same widget, scene, decluttering and
//    renderer as the app, on the demo exercise.
{
  const s = section(
    'On the tactical map (production rendering)',
    'Live maps drawn by the app’s own map widget on the demo exercise. Pan with a drag, zoom with the wheel; click a cluster repeatedly to step through the Marines in it.',
  );
  const views: {
    title: string;
    centre: Vec2;
    metersPerPixel: number;
    selected?: string;
    /** Exercise set-up before the view is drawn, e.g. moving a Marine. */
    prepare?: (exercise: ReturnType<typeof createExercise>) => void;
  }[] = [
    {
      title: 'ORP at the fitted scale (0.6 m/px): decluttered, hidden Marines counted',
      centre: { x: -60, y: -236 },
      metersPerPixel: 0.6,
      selected: 'M07',
    },
    {
      title: 'ORP up close (0.12 m/px): every Marine in full, squad leader selected',
      centre: { x: -60, y: -236 },
      metersPerPixel: 0.12,
      selected: 'M01',
    },
    {
      title: 'OPFOR patrol on the road (0.15 m/px): enemy, role unknown',
      centre: { x: 30, y: 262 },
      metersPerPixel: 0.15,
    },
    {
      title: 'A Marine moved next to the OPFOR patrol (0.6 m/px): mixed affiliations decluttered',
      centre: { x: 30, y: 255 },
      metersPerPixel: 0.6,
      prepare: (exercise) => {
        exercise.setDestination(soldierId('M05'), { x: 24, y: 259 });
        const committed = exercise.execute();
        if (!committed.ok) throw new Error(JSON.stringify(committed.problems));
        for (let i = 0; i < 2000 && exercise.phase === 'bluforOccupation'; i += 1) {
          exercise.advance(1, 16);
        }
      },
    },
  ];
  const grid = document.createElement('div');
  grid.className = 'maps';
  s.append(grid);
  const maps: { render(): void }[] = [];
  for (const view of views) {
    const exercise = createExercise({
      config: { tickRateHz: DEFAULT_TICK_RATE_HZ, seed: 1 },
      scenario: DEMO_SCENARIO,
    });
    view.prepare?.(exercise);
    let session: Session = createSession();
    if (view.selected) session = selectSoldier(session, exercise, soldierId(view.selected));
    const figure = document.createElement('figure');
    const canvas = document.createElement('canvas');
    const caption = document.createElement('figcaption');
    caption.textContent = view.title;
    figure.append(canvas, caption);
    grid.append(figure);
    const map = createTacticalMap({
      canvas,
      exercise,
      getSession: () => session,
      setSession: (next) => {
        session = next;
      },
    });
    map.setView(view.centre, view.metersPerPixel);
    maps.push(map);
  }
  const frame = () => {
    for (const map of maps) map.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
