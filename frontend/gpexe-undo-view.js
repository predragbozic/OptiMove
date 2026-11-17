// Imports: the undo of one imported session, as the review of an imported session shows it (J19-U5b).
// Data and rules: gpexe-undo-data.js. The server's sentences are shown as they are; the codes stay under Technical details.
import { isImportUndone } from "./gpexe-import-data.js";
import { UNDO_REASON_MAX, laterChangeCount, laterRosterWork, undoAdminViewer, undoBusy, undoFor, undoOffered } from "./gpexe-undo-data.js";
import { escapeAttr, escapeHtml, formatDate } from "./utils.js";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What the person recognises: the numbers of the removed records that mean something to a coach. The full list is the deletion log's.
export function removedSummary(counts) {
  const c = counts && typeof counts === "object" ? counts : {};
  const n = (key) => (Number.isInteger(c[key]) && c[key] > 0 ? c[key] : 0);
  const parts = [];
  // The session itself is named in the sentence ("removes the session from the calendar"), so its activity is not counted.
  if (n("metric_event_participants")) parts.push(plural(n("metric_event_participants"), "athlete", "athletes"));
  if (n("metric_values")) parts.push(plural(n("metric_values"), "value", "values"));
  if (n("metric_event_segments")) parts.push(plural(n("metric_event_segments"), "drill", "drills"));
  if (n("activity_athlete_decisions")) parts.push(plural(n("activity_athlete_decisions"), "attendance state", "attendance states"));
  return parts.join(", ");
}

const KIND_WORDS = Object.freeze({
  participated_no_values: "Participated · no device data",
  did_not_participate: "Did not participate",
  cleared: "State removed",
  complete: "marked complete",
  reopen: "reopened",
});

// Day and time on the person's clock, DD.MM.YYYY HH:MM.
function fmtWhen(value) {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) return "";
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

// The attendance states the import itself set: removed with it, no question of their own.
function importStatesHtml(rosterWork) {
  const n = Number(rosterWork?.importWritten?.decisions) || 0;
  if (n <= 0) return "";
  return `<p class="muted" role="note">${escapeHtml(`Deleting also removes the ${plural(n, "attendance state", "attendance states")} the import set.`)}</p>`;
}

// Later attendance changes (the Roster tab): listed, with their own confirmation.
function laterWorkHtml(u, { disabled }) {
  const later = laterRosterWork(u);
  if (!later) return "";
  const list = Array.isArray(later.list) ? later.list : [];
  const changes = laterChangeCount(later);
  const rows = list.map((i) => {
    const who = i.athleteId ? (i.athleteName || "An athlete") : "Session";
    const what = [KIND_WORDS[i.kind] || "Changed", i.reasonLabel || ""].filter(Boolean).join(" · ");
    const by = [i.byName ? `by ${i.byName}` : "", fmtWhen(i.at)].filter(Boolean).join(", ");
    return `<li><strong>${escapeHtml(who)}</strong>: ${escapeHtml(what)}${by ? ` <span class="muted">(${escapeHtml(by)})</span>` : ""}</li>`;
  }).join("");
  const more = changes > list.length ? `<p class="muted">${escapeHtml(`and ${changes - list.length} more.`)}</p>` : "";
  return `
    <div class="gpexe-warning gpexe-undo-later" role="note">
      ${u.laterNote ? `<p class="gpexe-error" role="alert">${escapeHtml(u.laterNote)}</p>` : ""}
      <p><strong>${escapeHtml(`Attendance was changed in the Roster tab after the import: ${plural(changes, "change", "changes")}.`)}</strong> They are removed too if you delete.</p>
      <ul class="gpexe-undo-later-list" tabindex="0" aria-label="${escapeAttr("Later attendance changes")}">${rows}</ul>
      ${more}
      <label class="gpexe-undo-later-confirm"><input type="checkbox" data-gpexe-undo-later-confirm ${u.laterConfirmed ? "checked" : ""} ${disabled ? "disabled" : ""}> Remove these later changes too</label>
      ${u.laterProblem ? `<p class="gpexe-error" role="alert">${escapeHtml(u.laterProblem)}</p>` : ""}
    </div>`;
}

function techHtml(entries, admin) {
  if (!admin) return "";
  const rows = entries.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!rows.length) return "";
  return `<details class="gpexe-tech"><summary>Technical details</summary><dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl></details>`;
}

function errorTech(error, admin) {
  if (!error) return "";
  return techHtml([["HTTP status", error.status || "no answer"], ["Code", error.code], ["Server message", error.message]], admin);
}

// The success sentence (the manager, 2026-11-17): no re-import button; what is true now. When the server offered the session
// again with its review ready it is already in Imports; otherwise a new search for the session's own day brings it back.
export function undoDoneSentence(result, day) {
  if (result?.offeredAgain && result?.previewReady) return "The imported data is deleted. The session is back in Imports: correct the athlete links if they were wrong, then import it again there.";
  return `The imported data is deleted. To import it again, find new sessions in Imports${day ? ` with dates that include ${formatDate(day)}` : ""}.`;
}

// A refusal the server explains: its own sentence (v76 gives a coach one sentence and one next step), never a code.
function refusalHtml(error, admin) {
  if (error?.status === 404) return `<p class="gpexe-refused" role="alert">This session's imported data can no longer be deleted here. It may have been deleted already.</p>${errorTech(error, admin)}`;
  const calendar = error?.data?.calendarLinks;
  const extra = [];
  if (admin && Number.isInteger(calendar) && calendar > 0) extra.push(`${plural(calendar, "calendar event is", "calendar events are")} attached.`);
  const known = error?.status >= 400 && error?.status < 500 && error?.message;
  return `
    <div class="gpexe-refused" role="alert">
      <p><strong>Nothing was removed.</strong> ${escapeHtml(known ? error.message : "The delete was refused. Try again in a moment.")}</p>
      ${extra.length ? `<p class="muted">${escapeHtml(extra.join(" "))}</p>` : ""}
    </div>
    ${errorTech(error, admin)}`;
}

function scopeHtml(u, { disabled = false } = {}) {
  const p = u.preview || {};
  const summary = removedSummary(p.removedCounts);
  const versions = Array.isArray(p.undoneCandidateIds) ? p.undoneCandidateIds.length : 1;
  return `
    <p>This removes the session from the calendar and deletes its imported data${summary ? `: ${escapeHtml(summary)}` : ""}.</p>
    <p><strong>Deleted data can't be restored.</strong> To get it back, import the session again from Imports.</p>
    ${versions > 1 ? `<p class="gpexe-warning" role="note"><strong>This session was imported more than once with different data.</strong> All ${versions} imports are deleted together.</p>` : ""}
    ${importStatesHtml(p.rosterWork)}
    ${laterWorkHtml(u, { disabled })}`;
}

function sectionHtml(body) {
  return `<section class="gpexe-undo" aria-label="Delete imported data"><h4>Delete imported data</h4>${body}</section>`;
}

// A deleted import: history, never "Imported" (the server keeps the approval as a record).
export function renderUndoneNoteHtml(c, gx) {
  if (!isImportUndone(c)) return "";
  // The section above already says it right after the delete itself.
  const u = undoFor(c.id, gx);
  if (u && (u.step === "done" || u.step === "settled" || u.step === "unknown")) return "";
  return `<p class="gpexe-warning" role="note"><strong>This session's imported data was deleted.</strong> To import it again, find new sessions${c?.sessionStartedAt ? ` with dates that include ${formatDate(c.sessionStartedAt)}` : ""}.</p>`;
}

// The open delete, wherever it was opened (the Imports review or a session of Activities): its whole state.
export function renderUndoBodyHtml(u) {
  const admin = u.admin === true;
  if (u.step === "previewing") return sectionHtml(`<p class="muted" role="status">Checking what would be deleted...</p>`);
  if (u.step === "refused") {
    return sectionHtml(`${refusalHtml(u.error, admin)}<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-undo-cancel">Close</button>`);
  }
  if (u.step === "settled") {
    return sectionHtml(`<p class="gpexe-success" role="status"><strong>This session's imported data was already deleted.</strong> To import it again, find new sessions in Imports.</p>${errorTech(u.error, admin)}`);
  }
  if (u.step === "done") {
    const r = u.result || {};
    const summary = removedSummary(r.removedCounts);
    return sectionHtml(`
      <div class="gpexe-success" role="status">
        <p><strong>${escapeHtml(undoDoneSentence(r, u.day))}</strong></p>
        ${summary ? `<p class="muted">${escapeHtml(`Deleted: ${summary}.`)}</p>` : ""}
        ${admin && r.replayed ? `<p class="muted">This was the answer saved for the same request.</p>` : ""}
      </div>`);
  }
  if (u.step === "unknown") {
    return sectionHtml(`
      <div class="gpexe-unknown" role="alert">
        <p><strong>We can't tell yet whether the imported data was deleted.</strong> Press Check the result. It is safe to press again: it never deletes twice.</p>
        ${u.stillUnknown ? `<p class="muted">Still not confirmed: the server was busy. Check again in a moment.</p>` : ""}
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-undo-check">Check the result</button>
        ${u.checks >= 3 ? `<p><strong>Still not confirmed after ${u.checks} checks.</strong> ${admin ? "Reload the page and look at the session. If it still shows as imported and the problem stays, report it with the Technical details." : "Reload the page and look at the session. If it is still there, contact OptiMove support (a platform administrator)."}</p>` : ""}
        ${errorTech(u.error, admin)}
      </div>`);
  }
  // ready / sending: the scope, then the reason and the explicit button.
  const sending = u.step === "sending";
  return sectionHtml(`
    ${scopeHtml(u, { disabled: sending })}
    ${u.refusalNote ? `<p class="gpexe-error" role="alert"><strong>Nothing was removed.</strong> ${escapeHtml(u.refusalNote)}</p>` : ""}
    <label class="gpexe-undo-reason">Why are you deleting it? (required)
      <span class="muted">It is saved with the deletion.</span>
      <textarea data-gpexe-undo-reason maxlength="${UNDO_REASON_MAX}" rows="3" placeholder="For example: imported with the wrong athletes" ${sending ? "disabled" : ""}>${escapeHtml(u.reason || "")}</textarea>
    </label>
    ${u.reasonProblem ? `<p class="gpexe-error" role="alert">${escapeHtml(u.reasonProblem)}</p>` : ""}
    <div class="gpexe-undo-actions">
      <button type="button" class="primary-button gpexe-button gpexe-danger" data-action="training-load-gpexe-undo-confirm" ${sending ? "disabled" : ""}>${sending ? "Deleting..." : "Delete imported data"}</button>
      <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-undo-cancel" ${sending ? "disabled" : ""}>Cancel</button>
    </div>`);
}

// The delete section of an Imports review. Nothing for anyone who may not delete, or for a session that is not imported.
export function renderUndoHtml(c, gx) {
  const u = undoFor(c?.id, gx);
  if (!u) {
    if (!undoOffered(c, gx)) return "";
    // Another session's delete is still not confirmed: say so instead of offering a button that cannot work.
    if (undoBusy(gx)) return sectionHtml(`<p class="muted">${escapeHtml(undoBusyNote(gx))}</p>`);
    return sectionHtml(`
      <p class="muted">${escapeHtml(UNDO_OFFER_SENTENCE)}</p>
      <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-undo-open">Delete imported data...</button>`);
  }
  return renderUndoBodyHtml(u);
}

export { undoAdminViewer };

export const UNDO_OFFER_SENTENCE = "Imported with the wrong athletes or values? Delete this session's imported data, correct the athlete links in Imports, then import it again.";

// Another session's delete is not finished: name it, so the step can be taken.
export function undoBusyNote(gx) {
  const label = gx?.undo?.label;
  return label
    ? `Deleting the imported data of ${label} is not confirmed yet. Open that session and press Check the result first.`
    : "Deleting another session's imported data is not confirmed yet. Open that session and press Check the result first.";
}
