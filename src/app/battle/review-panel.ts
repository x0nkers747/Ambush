import { escapeHtml } from '../shell';
import { PHASE_LABELS } from './combat';
import { clockText } from './combat-panel';
import { REVIEW_SPEEDS, type MarkerKind, type Review } from './review';

// The After-Action Review's side panel (docs/constructive-simulation/05):
// the replay's verification, the playhead and its controls, the timeline
// with its markers, the battle's key moments and a squad's phases. The
// controls are drawn once (`reviewToolsHtml`) and kept current by
// `updateReviewTools`, so a drag on the timeline is never interrupted by a
// redraw.

export const MARKER_LABELS: Readonly<Record<MarkerKind, string>> = {
  contact: 'Contact',
  casualty: 'Casualty',
  order: 'Order',
  ineffective: 'Combat ineffective',
  withdrawn: 'Withdrawn',
};

/** The review's controls (static: `updateReviewTools` fills them in). */
export function reviewToolsHtml(): string {
  const speeds = REVIEW_SPEEDS.map(
    (s) =>
      `<button class="small" data-rspeed="${String(s)}">${s === 0.25 ? '¼' : s === 0.5 ? '½' : String(s)}×</button>`,
  ).join('');
  return `<p class="review-verify" data-ui="review-verify"></p>
    <div class="combat-clock">
      <span class="clock" data-ui="review-clock"></span>
      <span class="muted" data-ui="review-end"></span>
    </div>
    <div class="timeline" data-ui="timeline">
      <div class="timeline-replayed" data-ui="timeline-replayed"></div>
      <div class="timeline-markers" data-ui="timeline-markers"></div>
      <input type="range" class="replay-scrub" data-ui="review-scrub" min="0" max="1" step="0.1" value="0" aria-label="Playhead: time in the battle">
    </div>
    <div class="replay-buttons" role="group" aria-label="Replay">
      <button data-ract="start" title="To the start (Home)" aria-label="To the start">⏮</button>
      <button data-ract="prev" title="The previous marker (,)" aria-label="The previous marker">◆◀</button>
      <button data-ract="back" title="Back 5 s (←)" aria-label="Back five seconds">◀ 5 s</button>
      <button class="action" data-ract="play" data-ui="review-play" title="Play or pause (Space)">Play</button>
      <button data-ract="forward" title="Forward 5 s (→)" aria-label="Forward five seconds">5 s ▶</button>
      <button data-ract="next" title="The next marker (.)" aria-label="The next marker">▶◆</button>
      <button data-ract="end" title="To the end (End)" aria-label="To the end">⏭</button>
    </div>
    <div class="speed" role="group" aria-label="Replay speed" data-ui="review-speeds">${speeds}</div>
    <h3>Result</h3>
    <div data-ui="review-summary"></div>
    <h3>Key moments</h3>
    <ol class="moments" data-ui="review-moments"></ol>
    <p class="buttons"><button class="small" data-ract="export" title="Download the battle's recording (spec, commands, hashes): it reproduces the battle exactly">Export recording</button></p>`;
}

/** The verification line. */
export function verificationText(review: Review): { text: string; kind: 'ok' | 'warn' | 'alert' } {
  const v = review.verification;
  if (v.mismatches > 0)
    return {
      text: `The replay differs from the battle from ${clockText(v.firstMismatch ?? 0)} (${String(v.mismatches)} second${v.mismatches === 1 ? '' : 's'}): the review is not the battle fought.`,
      kind: 'alert',
    };
  if (!v.complete) {
    const pct = Math.floor((100 * review.replayedSeconds) / Math.max(review.endSeconds, 1e-9));
    return {
      text: `Replaying the battle from its start… ${String(pct)} % (${String(v.checked)} seconds checked, all matching)`,
      kind: 'warn',
    };
  }
  return {
    text: `Replayed from its start and verified: all ${String(v.checked)} seconds match the battle fought.`,
    kind: 'ok',
  };
}

/** The markers on the timeline, positioned by time. */
export function timelineMarkersHtml(review: Review): string {
  const end = Math.max(review.endSeconds, 1e-9);
  return review
    .markers()
    .map(
      (m) =>
        `<button class="mk mk-${m.kind} ${m.side === 'BLUEFOR' ? 'blue' : 'red'}" style="left:${((100 * m.seconds) / end).toFixed(3)}%" data-seek="${String(m.seconds)}" title="${escapeHtml(`${clockText(m.seconds)} · ${MARKER_LABELS[m.kind]}: ${m.text}`)}" aria-label="${escapeHtml(`${clockText(m.seconds)}, ${m.text}`)}"></button>`,
    )
    .join('');
}

/** The key moments (every marker but single casualties, which the timeline shows), each a seek. */
export function momentsHtml(review: Review, limit = 80): string {
  const items = review
    .markers()
    .filter((m) => m.kind !== 'casualty')
    .slice(0, limit)
    .map(
      (m) =>
        `<li class="seek mk-row mk-${m.kind}${m.seconds <= review.seconds ? ' past' : ''}" data-seek="${String(m.seconds)}"><span class="clock">${clockText(m.seconds)}</span> <span class="mk-kind">${MARKER_LABELS[m.kind]}</span> ${escapeHtml(m.text)}</li>`,
    )
    .join('');
  return items || '<li class="muted">None yet.</li>';
}

/** A squad's phases up to the playhead, each a seek. */
export function phasesHtml(review: Review, squadId: string | null): string {
  if (squadId === null) return '';
  const phases = review.phases(squadId);
  if (phases.length === 0) return '';
  return `<h3>Its phases</h3><ol class="phases">${phases
    .map(
      (p) =>
        `<li class="seek" data-seek="${String(p.seconds)}"><span class="clock">${clockText(p.seconds)}</span> ${escapeHtml(PHASE_LABELS[p.phase as keyof typeof PHASE_LABELS])}<span class="muted"> · ${escapeHtml(p.reason)}</span></li>`,
    )
    .join('')}</ol>`;
}
