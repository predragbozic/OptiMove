// Imports P5 (manager, 2026-11-15): ONE place that explains Imports - "How importing works", a button in the Imports
// header. On a phone it is a full-screen sheet, on a computer a centred dialog; both are modal (Escape, the phone's
// Back and a wider layout close it like the period sheet, gpexe-period-data.js closePeriodSheet). It replaces the
// standing explanatory paragraphs of the page; the page keeps one sentence per action. Pure template strings.
import { escapeHtml } from "./utils.js";

// `ask` is the viewer's own "who to ask" sentence (a coach: the club administrator; a club admin: OptiMove support);
// empty for a platform admin, who is the one asked.
// `findBy` is what helps this viewer find a GPEXE athlete (code review: only what this viewer sees on Link athletes).
export function renderImportsHelpHtml({ ask = "", findBy = "the values of the last session" } = {}) {
  const item = (title, text) => `<li><strong>${escapeHtml(title)}</strong> ${escapeHtml(text)}</li>`;
  // A real backdrop (mobile review): a click outside closes the help, and the page behind takes no click.
  return `
    <div class="imports-help-backdrop" data-action="training-load-gpexe-help" aria-hidden="true"></div>
    <section class="gpexe-panel imports-help is-open" id="imports-help" role="dialog" aria-modal="true" aria-labelledby="imports-help-title">
      <div class="imports-help-head">
        <h3 id="imports-help-title">How importing works</h3>
        <button type="button" class="plain-button gpexe-button imports-help-close" data-action="training-load-gpexe-help" aria-label="Close">×</button>
      </div>
      <ul class="imports-help-list">
        ${item("GPEXE", "is your club's GPS system. OptiMove only reads the sessions it recorded and changes nothing there.")}
        ${item("Find new sessions", "reads GPEXE for the days you choose. It imports nothing; you choose what to import.")}
      </ul>
      <h4>The marks in the calendar</h4>
      <ul class="imports-help-marks">
        <li><i class="period-chip is-needs" aria-hidden="true">!</i> <strong>Needs you</strong> - one step is missing before it can be imported. The Needs you tab groups the sessions by that step; each group's button does it.</li>
        <li><i class="period-chip is-ready" aria-hidden="true">→</i> <strong>Ready</strong> - it can be imported as it is.</li>
        <li><i class="period-chip is-done" aria-hidden="true">✓</i> <strong>Imported</strong> - it is in OptiMove.</li>
        <li><i class="period-chip is-out" aria-hidden="true">–</i> <strong>Stays out</strong> - a session type OptiMove does not import. Nothing to do.</li>
      </ul>
      <p class="imports-help-fine">A day without a mark may not have been searched yet.</p>
      <ul class="imports-help-list">
        ${item("Linking athletes", `tells OptiMove which athlete of your team a GPEXE athlete is, for this and every later session. It is never guessed: ${findBy} only help you find them.`)}
        ${item("Later", "puts a Ready session aside on this device only. It stays Ready for everyone else; Show brings it back.")}
        ${item("A result", "is one athlete's values for the whole session or for one drill; a session with two drills gives each athlete three.")}
        ${item("After importing", "a session shows with ✓ in the calendar here, and its results are in Training Load → Activities.")}
        ${item("Import off", "importing is not turned on for this team yet. You can still find and review sessions.")}
      </ul>
      ${ask ? `<p class="imports-help-ask">${escapeHtml(ask)}</p>` : ""}
      <div class="imports-help-foot"><button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-help">Close</button></div>
    </section>
  `;
}
