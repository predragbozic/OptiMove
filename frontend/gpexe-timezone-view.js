// Imports: the team's session time zone in the review of a session whose GPS units report more than one time zone.
// Data and rules: gpexe-timezone-data.js. Plain sentences only; a code stays under a platform admin's Technical details.
import { timezoneOptions } from "./data-sources-data.js";
import { TIMEZONE_REASON_MAX, timezoneAdmin, timezoneFor } from "./gpexe-timezone-data.js";
import { escapeAttr, escapeHtml, formatDate } from "./utils.js";

function errorSentence(error, tz) {
  if (!error) return "";
  if (error.code === "not_saved_after_check") return `It was not saved: the team's time zone is ${tz.current ? `still ${tz.current}` : "still not set"}. Save it again.`;
  if (error.code === "reason_required") return "Write why, for the record. Nothing was saved.";
  if (error.code === "invalid_timezone") return "Choose a time zone from the list. Nothing was saved.";
  if (error.code === "gpexe_change_busy") return "A search or an import is running for this team. Try again when it has finished. Nothing was saved.";
  // The 403 names who may (PR #587); its own sentence is shown as it is.
  if (error.status === 403) return error.message || "Your account can no longer set this team's time zone. Nothing was saved.";
  if (error.status === 404) return "This team is no longer available in this workspace. Nothing was saved.";
  if (error.code === "database_busy") return "OptiMove is busy right now. Try again in a moment. Nothing was saved.";
  return "That did not work. Nothing was saved.";
}

// Who a viewer without the right asks: one sentence, never a place they can't open.
export function timezoneAskSentence(day) {
  return `It is not imported until the team has a time zone. Ask your club's admin to set the team's time zone (they can do it in this session's review), then find new sessions again${day}.`;
}

// The search after a save: the session's own day, so the next search reads it in the new zone.
function searchButtonHtml(day) {
  return `<button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-check"${day ? ` data-from="${escapeAttr(day)}" data-to="${escapeAttr(day)}"` : ""}>${escapeHtml(day ? `Find new sessions for ${formatDate(day)}` : "Find new sessions")}</button>`;
}

export function renderTimezoneFixHtml(gx, day) {
  if (!timezoneAdmin(gx)) return "";
  const tz = timezoneFor(gx);
  if (!tz) {
    return `<div class="gpexe-tz"><button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-tz-open">Set the team's time zone</button></div>`;
  }
  if (tz.step === "loading") return `<div class="gpexe-tz"><p class="muted" role="status">Reading the team's time zone...</p></div>`;
  if (tz.step === "readFailed") {
    return `<div class="gpexe-tz"><p class="gpexe-error" role="alert">The team's time zone could not be read. Nothing was changed.</p><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-tz-open">Try again</button></div>`;
  }
  if (tz.step === "saved" || tz.step === "known") {
    const lead = tz.step === "saved"
      ? `<strong>Saved. The team's time zone is ${escapeHtml(tz.current)}.</strong> Find new sessions for this session's day; then you can import it.`
      : `<strong>The team's time zone is ${escapeHtml(tz.current)}.</strong> You only need a new search for this session's day; then you can import it. Change the zone only if it is wrong.`;
    return `
      <div class="gpexe-tz" role="status">
        <p>${lead}</p>
        ${searchButtonHtml(day)}
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-tz-change">Change the time zone</button>
      </div>`;
  }
  if (tz.step === "unknown" || tz.step === "checking") {
    const busy = tz.step === "checking";
    return `
      <div class="gpexe-tz">
        <p class="gpexe-warning" role="alert">We can't tell whether the time zone was saved. Check before saving it again.</p>
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-tz-check"${busy ? " disabled" : ""}>${busy ? "Checking..." : "Check whether it was saved"}</button>
      </div>`;
  }
  const saving = tz.step === "saving";
  const listed = timezoneOptions();
  const zones = [tz.current, tz.timezone].filter((z) => z && !listed.includes(z)).concat(listed);
  const options = [`<option value=""${tz.timezone ? "" : " selected"}>Choose a time zone</option>`]
    .concat([...new Set(zones)].map((z) => `<option value="${escapeAttr(z)}"${z === tz.timezone ? " selected" : ""}>${escapeHtml(z)}</option>`));
  const problem = tz.problem || errorSentence(tz.error, tz);
  return `
    <div class="gpexe-tz">
      <p class="gpexe-tz-title"><strong>The team's time zone</strong>: ${tz.current ? escapeHtml(tz.current) : "not set"}</p>
      <p>It is used only for a session whose GPS units report different time zones: its date and time are read in this zone. Sessions already imported keep their date and time.</p>
      <label class="gpexe-tz-field"><span>Time zone</span>
        <select data-gpexe-tz-zone class="gpexe-tz-select"${saving ? " disabled" : ""}>${options.join("")}</select>
      </label>
      <label class="gpexe-tz-field"><span>Why? (required)</span>
        <textarea data-gpexe-tz-reason rows="2" maxlength="${TIMEZONE_REASON_MAX}" placeholder="For example: the team trains in Sarajevo"${saving ? " disabled" : ""}>${escapeHtml(tz.reason)}</textarea>
      </label>
      ${problem ? `<p class="gpexe-error" role="alert">${escapeHtml(problem)}</p>` : ""}
      <div class="gpexe-tz-actions">
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-tz-save"${saving ? " disabled" : ""}>${saving ? "Saving..." : "Save the time zone"}</button>
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-tz-cancel"${saving ? " disabled" : ""}>Cancel</button>
      </div>
    </div>`;
}
