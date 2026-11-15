// Imports P5 (manager, 2026-11-15): ONE place that explains Imports - "How importing works", a button in the Imports
// header. On a phone it is a full-screen sheet, on a computer a centred dialog; both are modal (Escape, the phone's
// Back and a wider layout close it like the period sheet, gpexe-period-data.js closePeriodSheet). It replaces the
// standing explanatory paragraphs of the page; the page keeps one sentence per action. Pure template strings.
import { escapeHtml } from "./utils.js";

// `ask` is the viewer's own "who to ask" sentence (a coach: the club administrator; a club admin: OptiMove support);
// empty for a platform admin, who is the one asked.
export function renderImportsHelpHtml({ ask = "" } = {}) {
  const item = (title, text) => `<li><strong>${escapeHtml(title)}</strong> ${escapeHtml(text)}</li>`;
  return `
    <section class="gpexe-panel imports-help is-open" id="imports-help" role="dialog" aria-modal="true" aria-labelledby="imports-help-title">
      <div class="imports-help-head">
        <h3 id="imports-help-title">How importing works</h3>
        <button type="button" class="plain-button gpexe-button imports-help-close" data-action="training-load-gpexe-help" aria-label="Close">×</button>
      </div>
      <ul class="imports-help-list">
        ${item("Find new sessions", "reads GPEXE for the days you choose. It imports nothing; you choose what to import.")}
      </ul>
      <h4>The marks in the calendar</h4>
      <ul class="imports-help-marks">
        <li><i class="period-chip is-needs" aria-hidden="true">!</i> <strong>Needs you</strong> - one step is missing before it can be imported. Open it to see which.</li>
        <li><i class="period-chip is-ready" aria-hidden="true">→</i> <strong>Ready</strong> - it can be imported as it is.</li>
        <li><i class="period-chip is-done" aria-hidden="true">✓</i> <strong>Imported</strong> - it is in OptiMove.</li>
        <li><i class="period-chip is-out" aria-hidden="true">–</i> <strong>Stays out</strong> - a session type OptiMove does not import. Nothing to do.</li>
      </ul>
      <p class="imports-help-fine">A day without a mark may not have been searched yet.</p>
      <ul class="imports-help-list">
        ${item("Needs you", "groups the sessions by what they ask, usually to link athletes or to find a session again. Each group's button does that step.")}
        ${item("Linking athletes", "tells OptiMove which athlete of your team a GPEXE athlete is, for this and every later session. It is never guessed: the name, date of birth and values only help you find them.")}
        ${item("Later", "puts a Ready session aside on this device only. It stays Ready for everyone else; Show brings it back.")}
        ${item("After importing", "a session shows with ✓ in the calendar here, and its results are in Training Load → Activities.")}
      </ul>
      ${ask ? `<p class="imports-help-ask">${escapeHtml(ask)}</p>` : ""}
      <div class="imports-help-foot"><button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-help">Close</button></div>
    </section>
  `;
}
