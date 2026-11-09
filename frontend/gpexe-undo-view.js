// Imports: the undo of one imported session, as the review of an imported session shows it (J19-U5b).
// Data and rules: gpexe-undo-data.js. The server's sentences are shown as they are; the codes stay under Technical details.
import { isImportUndone } from "./gpexe-import-data.js";
import { UNDO_REASON_MAX, laterRosterCount, undoBusy, undoFor, undoOffered } from "./gpexe-undo-data.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What the person recognises: the numbers of the removed records that mean something to a coach. The full list is the deletion log's.
export function removedSummary(counts) {
  const c = counts && typeof counts === "object" ? counts : {};
  const n = (key) => (Number.isInteger(c[key]) && c[key] > 0 ? c[key] : 0);
  const parts = [];
  if (n("metric_event_participants")) parts.push(plural(n("metric_event_participants"), "athlete's record", "athletes' records"));
  if (n("metric_values")) parts.push(plural(n("metric_values"), "imported value", "imported values"));
  if (n("metric_event_segments")) parts.push(plural(n("metric_event_segments"), "drill", "drills"));
  if (n("activities")) parts.push(plural(n("activities"), "activity", "activities"));
  return parts.join(", ");
}

function techHtml(entries) {
  const rows = entries.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!rows.length) return "";
  return `<details class="gpexe-tech"><summary>Technical details</summary><dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl></details>`;
}

function errorTech(error) {
  if (!error) return "";
  return techHtml([["HTTP status", error.status || "no answer"], ["Code", error.code], ["Server message", error.message]]);
}

// A refusal the function raised for a reason the person can act on: its own sentence, plus the counts it carries (never the records themselves).
function refusalHtml(error) {
  if (error?.status === 404) return `<p class="gpexe-refused" role="alert">This session is not available for an undo.</p>${errorTech(error)}`;
  const calendar = error?.data?.calendarLinks;
  const extra = [];
  if (Number.isInteger(calendar) && calendar > 0) extra.push(`${plural(calendar, "calendar event is", "calendar events are")} attached.`);
  return `
    <div class="gpexe-refused" role="alert">
      <p><strong>Nothing was removed.</strong> ${escapeHtml(error?.message || "The undo was refused.")}</p>
      ${extra.length ? `<p class="muted">${escapeHtml(extra.join(" "))}</p>` : ""}
      ${error?.data?.error === "roster_work_changed" || error?.data?.error === "roster_work_needs_confirmation"
        ? `<p class="muted">Your reason is kept. You will need to tick again.</p>
           <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-undo-reopen">Show the list again</button>` : ""}
    </div>
    ${errorTech(error)}`;
}

const KIND_LABEL = { did_not_participate: "Did not participate", participated_no_values: "Participated, no device data", manual_values: "Manual values", estimated: "Estimated values", cleared: "A state was removed earlier" };

// v60 (O1): what the roster holds. What the import flow wrote goes with the session; a coach's later work is listed and
// needs its own tick. Names and codes only: a note a coach wrote is never shown here.
function rosterHtml(u) {
  const w = u.preview?.rosterWork;
  if (!w) return "";
  const imp = w.importWritten?.decisions || 0;
  const later = laterRosterCount(u.preview);
  const list = Array.isArray(w.laterDecisions) ? w.laterDecisions : [];
  const decisions = w.later?.decisions || 0;
  const total = Number.isInteger(w.laterDecisionsTotal) ? w.laterDecisionsTotal : list.length;
  const cut = total > list.length;
  const rows = list.map((d) => `<li>${escapeHtml(d.athleteName || "An athlete")}: ${escapeHtml(KIND_LABEL[d.kind] || d.kind)}${d.reasonCode ? ` (${escapeHtml(String(d.reasonCode).replace(/_/g, " "))})` : ""}</li>`).join("");
  // What is removed, from the counts: decisions and/or the session's completion (a completion alone has no list).
  const what = [decisions > 0 ? `${plural(decisions, "decision", "decisions")} from the Roster tab` : "", w.later?.completions ? "the session's completion (marked complete)" : ""].filter(Boolean).join(" and ") || "other roster records";
  const done = w.later?.completions ? ", and so is its completion" : "";
  const tick = cut ? `I understand all ${total} decisions, including those not listed, are removed with the session${done}.` : "I understand this work by the coach is removed with the session.";
  return `
    ${imp > 0 ? `<p>${escapeHtml(plural(imp, "attendance state set at import", "attendance states set at import"))} will be removed.</p>` : ""}
    ${later > 0 ? `
      <div class="gpexe-warning" role="note">
        <p><strong>A coach has also worked on this session since the import.</strong> ${escapeHtml(what.charAt(0).toUpperCase() + what.slice(1))} will be removed too.${rows ? (cut ? ` First ${list.length} of ${total} shown:` : " The decisions:") : ""}</p>
        ${rows ? `<ul class="gpexe-undo-later" role="region" tabindex="0" aria-label="Decisions that will be removed">${rows}</ul>` : ""}
        ${list.length > 6 ? `<p class="muted">Scroll the list to see all ${list.length}.</p>` : ""}
        ${cut ? `<p class="muted">And ${total - list.length} more, not listed here. They are removed too and recorded in the log.</p>` : ""}
        <label class="gpexe-undo-confirm"><input type="checkbox" data-gpexe-undo-confirm-later ${u.confirmLater ? "checked" : ""} ${u.tickProblem ? 'aria-invalid="true" aria-describedby="gpexe-undo-tick-problem"' : ""} ${u.step === "sending" ? "disabled" : ""}> ${escapeHtml(tick)}</label>
        ${u.tickProblem ? `<p class="gpexe-error" id="gpexe-undo-tick-problem" role="alert">${escapeHtml(u.tickProblem)}</p>` : ""}
      </div>` : ""}`;
}

function laterRemovedSentence(work) {
  const n = work?.later?.decisions || 0;
  return n > 0 ? `The coach's ${plural(n, "later decision", "later decisions")} on the roster ${n === 1 ? "was" : "were"} removed too.` : "The coach's later roster work on this session was removed too.";
}

function scopeHtml(u) {
  const p = u.preview || {};
  const summary = removedSummary(p.removedCounts);
  const versions = Array.isArray(p.undoneCandidateIds) ? p.undoneCandidateIds.length : 1;
  return `
    <p>This removes from OptiMove: ${summary ? escapeHtml(summary) : "this session's results and activity"}.</p>
    <p><strong>This can't be undone here.</strong> To get the data back, import the session again.</p>
    ${rosterHtml(u)}
    ${versions > 1 ? `<p class="gpexe-warning" role="note"><strong>This session was imported more than once with different data.</strong> Undoing removes all ${versions} imports together.</p>` : ""}
    <p class="muted">${p.wouldOfferAgain
      ? "Afterwards the session is offered again for review, so you can import it under the corrected athlete links."
      : "Afterwards the session is not offered again right away. Find new sessions to bring it back for review."}</p>`;
}

function sectionHtml(body) {
  return `<section class="gpexe-undo" aria-label="Undo this import"><h4>Undo this import</h4>${body}</section>`;
}

// An undone import: history, never "Imported" (the server keeps the approval as a record).
export function renderUndoneNoteHtml(c, gx) {
  if (!isImportUndone(c)) return "";
  // The undo section above already says it right after the undo itself.
  const u = undoFor(c.id, gx);
  if (u && (u.step === "done" || u.step === "settled" || u.step === "unknown")) return "";
  return `<p class="gpexe-warning" role="note"><strong>This import was undone.</strong> Its data is no longer in OptiMove. If the session was offered again, it is listed again for review; otherwise find new sessions.</p>`;
}

// The undo section of a review. Nothing for anyone who may not undo, or for a session that is not imported.
export function renderUndoHtml(c, gx) {
  const u = undoFor(c?.id, gx);
  if (!u) {
    if (!undoOffered(c, gx)) return "";
    // Another session's undo is still not confirmed: say so instead of offering a button that cannot work.
    if (undoBusy(gx)) return sectionHtml(`<p class="muted">An undo for another session is not finished or not confirmed yet. Open that session and check its result first.</p>`);
    return sectionHtml(`
      <p class="muted">Imported under a wrong athlete link? Undo removes this session's imported data so it can be imported again once the links are right.</p>
      <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-undo-open">Undo this import...</button>`);
  }
  if (u.step === "previewing") return sectionHtml(`<p class="muted" role="status">Checking what would be removed...</p>`);
  if (u.step === "refused") {
    return sectionHtml(`${refusalHtml(u.error)}<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-undo-cancel">Close</button>`);
  }
  if (u.step === "settled") {
    return sectionHtml(`<p class="gpexe-success" role="status"><strong>This import was already undone.</strong> The review below shows it as it is now.</p>${errorTech(u.error)}`);
  }
  if (u.step === "done") {
    const r = u.result || {};
    const summary = removedSummary(r.removedCounts);
    const again = r.offeredAgain
      ? `<p>Fix the athlete links, then review the session again: it is offered again${r.previewReady ? "" : "; its review is not ready yet, so find new sessions to refresh it"}.</p>${r.newCandidateId ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(r.newCandidateId)}">Review the offered session</button>` : ""}`
      : `<p>The session is not offered again right away. Find new sessions to bring it back for review.</p>`;
    // The next step is the point of the undo.
    return sectionHtml(`
      <div class="gpexe-success" role="status">
        <p><strong>Import undone.</strong> ${summary ? escapeHtml(`Removed: ${summary}.`) : ""}${laterRosterCount({ rosterWork: r.rosterWork }) > 0 ? ` ${escapeHtml(laterRemovedSentence(r.rosterWork))}` : ""}${r.replayed ? " This was the answer saved for the same request." : ""}</p>
        ${again}
      </div>`);
  }
  if (u.step === "unknown") {
    return sectionHtml(`
      <div class="gpexe-unknown" role="alert">
        <p><strong>We can't tell yet whether the import was undone.</strong> Press Check the result. It is safe to press again: it never undoes twice.</p>
        ${u.stillUnknown ? `<p class="muted">Still not confirmed: the server was busy. Check again in a moment.</p>` : ""}
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-undo-check">Check the result</button>
        ${u.checks >= 3 ? `<p><strong>Still not confirmed after ${u.checks} checks.</strong> Reload the page and look at the session. If it still shows as imported and the problem stays, report it with the Technical details.</p>` : ""}
        ${errorTech(u.error)}
      </div>`);
  }
  // ready / sending: the scope, then the reason and the explicit button.
  const sending = u.step === "sending";
  return sectionHtml(`
    ${scopeHtml(u)}
    ${u.refusalNote ? `<p class="gpexe-error" role="alert"><strong>Nothing was removed.</strong> ${escapeHtml(u.refusalNote)}</p>` : ""}
    <label class="gpexe-undo-reason">Why is this import undone? (required)
      <textarea data-gpexe-undo-reason maxlength="${UNDO_REASON_MAX}" rows="3" ${sending ? "disabled" : ""}>${escapeHtml(u.reason || "")}</textarea>
    </label>
    ${u.reasonProblem ? `<p class="gpexe-error" role="alert">${escapeHtml(u.reasonProblem)}</p>` : ""}
    <div class="gpexe-undo-actions">
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-undo-confirm" ${sending ? "disabled" : ""}>${sending ? "Undoing..." : "Undo this import"}</button>
      <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-undo-cancel" ${sending ? "disabled" : ""}>Cancel</button>
    </div>`);
}
