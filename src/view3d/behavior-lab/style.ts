// The Behavior Lab page's styles: the game's dark theme (index.html's
// variables), a header, two side panels, the view, and a timeline below.

export const LAB_CSS = `
.blab { position: fixed; inset: 0; display: grid; grid-template-columns: 280px 1fr 320px;
  grid-template-rows: 46px 1fr 190px; background: var(--bg); color: var(--text); }
.blab header { grid-column: 1 / 4; display: flex; align-items: center; gap: 10px; padding: 0 12px;
  background: var(--panel); border-bottom: 1px solid var(--line); }
.blab header h1 { font-size: 14px; margin: 0 8px 0 0; font-weight: 700; letter-spacing: 0.02em; }
.blab header .grow { flex: 1; }
.blab header .time { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 150px; }
.blab .group { display: flex; gap: 4px; align-items: center; }
.blab .group > button.on { background: var(--blue-bg); border-color: var(--blue); }
.blab aside { background: var(--panel); overflow-y: auto; padding: 10px 12px; }
.blab aside.left { border-right: 1px solid var(--line); }
.blab aside.right { border-left: 1px solid var(--line); }
.blab section { margin-bottom: 14px; }
.blab label.row { display: grid; grid-template-columns: 96px 1fr 44px; align-items: center; gap: 6px;
  margin: 4px 0; }
.blab label.row output { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
.blab select, .blab input[type=number] { font: inherit; color: var(--text); background: var(--panel-2);
  border: 1px solid #3a424a; border-radius: 4px; padding: 3px 6px; width: 100%; }
.blab input[type=range] { width: 100%; }
.blab .checks label { display: flex; gap: 6px; align-items: center; margin: 3px 0; }
.blab .buttons { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.blab button.primary { background: var(--blue-bg); border-color: var(--blue); }
.blab button.armed { background: #5a4a14; border-color: var(--focus); }
.blab .hint { color: var(--muted); font-size: 12px; margin: 4px 0; }
.blab .stage { position: relative; overflow: hidden; }
.blab .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.blab .stage canvas.overlay { pointer-events: none; }
.blab .stage .loading { position: absolute; left: 12px; top: 10px; color: var(--muted); }
.blab footer { grid-column: 1 / 4; display: grid; grid-template-columns: 1fr 420px; border-top: 1px solid var(--line);
  background: var(--panel); min-height: 0; }
.blab footer .timeline { display: grid; grid-template-rows: 26px 1fr; padding: 6px 10px; min-height: 0; overflow: hidden; }
.blab footer .timeline input { width: 100%; }
.blab footer .graph-wrap { position: relative; min-height: 0; }
.blab footer canvas.graph { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.blab footer .metrics { border-left: 1px solid var(--line); padding: 6px 10px; overflow-y: auto;
  font-variant-numeric: tabular-nums; }
.blab table { border-collapse: collapse; width: 100%; font-size: 12px; }
.blab td, .blab th { padding: 2px 4px; text-align: left; border-bottom: 1px solid var(--line); }
.blab td.n, .blab th.n { text-align: right; }
.blab .tree div { cursor: pointer; padding: 1px 4px; border-radius: 3px; }
.blab .tree div:hover { background: var(--panel-2); }
.blab .tree div.sel { background: var(--blue-bg); }
.blab .tree .unit { font-weight: 600; margin-top: 4px; }
.blab .tree .member { padding-left: 14px; display: flex; gap: 6px; }
.blab .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-top: 4px; }
.blab dl { display: grid; grid-template-columns: 112px 1fr; gap: 2px 8px; margin: 6px 0; }
.blab dt { color: var(--muted); }
.blab dd { margin: 0; font-variant-numeric: tabular-nums; }
.blab .why { background: var(--panel-2); border-radius: 4px; padding: 6px 8px; line-height: 1.45; }
.blab .verify.ok { color: #7fcf8f; } .blab .verify.bad { color: #ff8a80; }
.blab .legend span { margin-right: 10px; font-size: 11px; }
`;
