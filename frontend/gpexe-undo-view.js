// Imports: the undo of one imported session, as the review of an imported session shows it (J19-U5b).
// Data and rules: gpexe-undo-data.js. The server's sentences are shown as they are; the codes stay under Technical details.
import { isImportUndone } from "./gpexe-import-data.js";
import { UNDO_REASON_MAX, undoFor, undoOffered } from "./gpexe-undo-data.js";
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
  const work = error?.data?.rosterWork;
  const calendar = error?.data?.calendarLinks;
  const extra = [];
  if (work && typeof work === "object") {
    const bits = Object.entries(work).filter(([, v]) => Number.isInteger(v) && v > 0).map(([k, v]) => `${v} ${k.replace(/_/g, " ")}`);
    if (bits.length) extra.push(`Roster work found: ${bits.join(", ")}.`);
  }
  if (Number.isInteger(calendar) && calendar > 0) extra.push(`${plural(calendar, "calendar event is", "calendar events are")} attached.`);
  return `
    <div class="gpexe-refused" role="alert">
      <p><strong>Nothing was removed.</strong> ${escapeHtml(error?.message || "The undo was refused.")}</p>
      ${extra.length ? `<p class="muted">${escapeHtml(extra.join(" "))}</p>` : ""}
    </div>
    ${errorTech(error)}`;
}

function scopeHtml(u) {
  const p = u.preview || {};
  const summary = removedSummary(p.removedCounts);
  const versions = Array.isArray(p.undoneCandidateIds) ? p.undoneCandidateIds.length : 1;
  return `
    <p>Undoing removes what this import wrote to OptiMove for this session: ${summary ? escapeHtml(summary) : "its results and activity"} (${escapeHtml(plural(Number(p.removedTotal) || 0, "record", "records"))} in all). The deletion is recorded with your reason. It cannot be reversed here: importing again writes new data.</p>
    ${versions > 1 ? `<p class="gpexe-warning" role="note"><strong>This session was approved ${versions} times with different data.</strong> They share one import, so all ${versions} approved versions are undone together.</p>` : ""}
    <p class="muted">${p.wouldOfferAgain
      ? "The session is then offered again for review, so it can be imported under the corrected athlete links."
      : "The session is not offered again right away. Find new sessions to bring it back for review."}</p>`;
}

function sectionHtml(body) {
  return `<section class="gpexe-undo gpexe-panel" aria-label="Undo this import"><h4>Undo this import</h4>${body}</section>`;
}

// An undone import: history, never "Imported" (the server keeps the approval as a record).
export function renderUndoneNoteHtml(c, gx) {
  if (!isImportUndone(c)) return "";
  // The undo section above already says it right after the undo itself.
  const u = undoFor(c.id, gx);
  if (u && (u.step === "done" || u.step === "settled")) return "";
  return `<p class="gpexe-warning" role="note"><strong>This import was undone.</strong> Its data is no longer in OptiMove. If the session was offered again, it is listed again for review; otherwise find new sessions.</p>`;
}

// The undo section of a review. Nothing for anyone who may not undo, or for a session that is not imported.
export function renderUndoHtml(c, gx) {
  const u = undoFor(c?.id, gx);
  if (!u) {
    if (!undoOffered(c, gx)) return "";
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
      ? `<p>The session is offered again for review${r.previewReady ? "" : "; its review is not ready yet, so find new sessions to refresh it"}.</p>${r.newCandidateId ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(r.newCandidateId)}">Review the offered session</button>` : ""}`
      : `<p>The session is not offered again right away. Find new sessions to bring it back for review.</p>`;
    return sectionHtml(`
      <div class="gpexe-success" role="status">
        <p><strong>Import undone.</strong> ${summary ? escapeHtml(`Removed: ${summary}.`) : ""}${r.replayed ? " This was the answer saved for the same request." : ""}</p>
        ${again}
      </div>`);
  }
  if (u.step === "unknown") {
    return sectionHtml(`
      <div class="gpexe-unknown" role="alert">
        <p><strong>We can't tell yet whether the import was undone.</strong> Don't start another undo: check the result first. Checking repeats the same request, so it can never undo twice.</p>
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-undo-check">Check the result</button>
        ${u.checks >= 3 ? `<p><strong>Still not confirmed after ${u.checks} checks.</strong> Reload the page and look at the session; if it still shows as imported, contact the developer with the Technical details.</p>` : ""}
        ${errorTech(u.error)}
      </div>`);
  }
  // ready / sending: the scope, then the reason and the explicit button.
  const sending = u.step === "sending";
  return sectionHtml(`
    ${scopeHtml(u)}
    <label class="gpexe-undo-reason">Why is this import undone? (required)
      <textarea data-gpexe-undo-reason maxlength="${UNDO_REASON_MAX}" rows="3" ${sending ? "disabled" : ""}>${escapeHtml(u.reason || "")}</textarea>
    </label>
    ${u.reasonProblem ? `<p class="gpexe-error" role="alert">${escapeHtml(u.reasonProblem)}</p>` : ""}
    <div class="gpexe-undo-actions">
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-undo-confirm" ${sending ? "disabled" : ""}>${sending ? "Undoing..." : "Undo this import"}</button>
      <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-undo-cancel" ${sending ? "disabled" : ""}>Cancel</button>
    </div>`);
}
