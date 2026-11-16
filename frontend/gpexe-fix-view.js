// Imports "Fix" flow, slice 1: the sheet. One problem per screen - "Step x of y", one sentence, ONE button, "Skip for
// now" and × - then "This session is ready" and the next session of the group. A full-screen sheet on a phone, a 560 px
// centred dialog over a real backdrop on a computer; modal like the P5 help (Escape, Back and Tab: app.js and
// gpexe-period-drag.js). Pure template strings: the import view hands in the helpers it owns (wording per viewer, the
// link chooser, the counts), so the review and the sheet say the same thing the same way.
import { escapeAttr, escapeHtml, formatDate } from "./utils.js";
import { fixScreen, fixMustStay, openMultiTrackIds } from "./gpexe-fix-data.js";
import { trackEntry } from "./gpexe-fix-tracks-data.js";

const GIVE_UP_AFTER_CHECKS = 3;

function button(cls, action, label, { disabled = false, attrs = "" } = {}) {
  return `<button type="button" class="${cls} gpexe-button" data-action="${escapeAttr(action)}" ${attrs} ${disabled ? "disabled" : ""}>${escapeHtml(label)}</button>`;
}

const two = (n) => String(n).padStart(2, "0");
// A recording as a coach can tell it apart: when it started, how long, how far. Never its GPEXE id.
function recordingText(t, i) {
  const parts = [];
  const at = t?.startedAt ? new Date(t.startedAt) : null;
  // A number first: two recordings can start in the same minute.
  parts.push(`Recording ${i + 1}`);
  if (at && !Number.isNaN(at.getTime())) parts.push(`started ${two(at.getHours())}:${two(at.getMinutes())}`);
  if (Number.isFinite(t?.wholeSessionSeconds)) parts.push(`${Math.round(t.wholeSessionSeconds / 60)} min`);
  if (Number.isFinite(t?.wholeSessionDistance)) parts.push(`${Math.round(t.wholeSessionDistance).toLocaleString("en-US")} m`);
  // The drills a recording covers help tell two of the same start apart.
  if (Array.isArray(t?.drillIndexes)) parts.push(t.drillIndexes.length ? (t.drillIndexes.length === 1 ? "1 drill" : `${t.drillIndexes.length} drills`) : "no drills");
  return parts.join(" · ");
}

// helpers: { title, day, linkHtml(id), athleteLabel(id), AskWho(), importCount, canImport, switchOff, next, errorTech(error),
//            checkErrorText(error), linkErrorText }
export function renderFixSheetHtml(gx, status, h) {
  const detail = gx.detail;
  const view = fixScreen(detail, gx);
  if (!view) return "";
  const busy = fixMustStay(gx, detail);
  const skip = (attrs = "") => button("plain-button imports-fix-skip", "training-load-gpexe-fix-skip", "Skip for now", { disabled: busy || gx.linkBusy, attrs });
  const nextOrBack = (primary = true) => h.next
    ? button(primary ? "primary-button" : "plain-button", "training-load-gpexe-fix-next", "Next session in the group", { disabled: busy })
    : button(primary ? "primary-button" : "plain-button", "training-load-gpexe-fix-close", "Back to Imports", { disabled: busy });
  let counter = "";
  // Everything the review offers (values, Leave out, attendance states) stays one quiet link away, for every viewer; never a
  // second main button. Not on the screen whose main button already is See why.
  const fullReviewLink = detail.candidate && view.screen !== "other" && view.screen !== "loading"
    ? `<p class="imports-fix-full">${button("plain-button imports-fix-full-link", "training-load-gpexe-fix-full", "Open the full review", { disabled: busy })}</p>`
    : "";
  let body = "";
  let actions = "";
  if (view.screen === "loading") {
    body = `<p class="muted" role="status">Loading...</p>`;
  } else if (view.screen === "error") {
    body = `<p class="gpexe-error" role="alert">${escapeHtml(detail.error?.status === 404 ? "This session is not available." : "This session could not be read. Close this and try again.")}</p>${h.errorTech(detail.error)}`;
    actions = button("primary-button", "training-load-gpexe-fix-close", "Back to Imports");
  } else if (view.screen === "step") {
    counter = `<p class="imports-fix-count">${escapeHtml(`Step ${view.index} of ${view.total}`)}</p>`;
    const s = view.step;
    if (s.kind === "unknown") {
      const o = detail.outcome || {};
      const more = o.verified === "not_visible_yet" ? " The import is not visible yet; check again in a moment."
        : o.verified === "still_unknown" ? " Still not clear; check again in a moment." : "";
      const giveUp = (o.checks || 0) >= GIVE_UP_AFTER_CHECKS ? ` ${h.AskWho()} to check this import.` : "";
      body = `<p class="imports-fix-sentence" role="alert">${escapeHtml(`The answer to this session's import did not arrive. Check the result before doing anything else.${more}${giveUp}`)}</p>`;
      // No Skip here: the sentence says check first, and nothing else is offered until the result is known.
      actions = button("primary-button", "training-load-gpexe-verify", detail.verifying ? "Checking..." : "Check the result", { disabled: detail.verifying });
    } else if (s.kind === "link") {
      // The chooser is the review's own (U3's suggested athlete first, then the team; nothing preselected; a name two team
      // athletes share can't be confirmed); "Link..." asks, "Confirm link" sends, and the review is updated once.
      // The error belongs to the athlete whose link was asked (a lost answer for one is never shown on the next).
      body = `${gx.linkError && String(gx.linkOpen) === String(s.id) ? `<p class="gpexe-error" role="alert">${escapeHtml(h.linkErrorText)}</p>` : ""}${h.linkHtml(s.id)}`;
      actions = skip(`data-gpexe-athlete-id="${escapeAttr(s.id)}"`);
    } else if (s.kind === "track") {
      // Slice 2: one athlete GPEXE recorded on more than one track. The choice is local until Save; one PUT, then the review's
      // recompute. A lost answer is "Check the result" with the same key, never sent again by itself.
      const entry = trackEntry(detail, s.id) || { tracks: [] };
      const name = h.athleteName(s.id);
      const pick = detail.fix.trackPick?.gpexeAthleteId === String(s.id) ? detail.fix.trackPick.value : "";
      const w = detail.fix.trackWrite?.gpexeAthleteId === String(s.id) ? detail.fix.trackWrite : null;
      const err = detail.fix.trackError;
      const locked = Boolean(w?.sending || w?.unknown);
      const radio = (value, label) => `<label class="imports-fix-choice"><input type="radio" id="fix-track-${escapeAttr(s.id)}-${escapeAttr(value)}" name="fix-track-${escapeAttr(s.id)}" value="${escapeAttr(value)}" data-action="training-load-gpexe-fix-track-pick" data-gpexe-athlete-id="${escapeAttr(s.id)}" ${pick === value ? "checked" : ""} ${locked ? "disabled" : ""}><span>${escapeHtml(label)}</span></label>`;
      body = `
        <p class="imports-fix-sentence">${escapeHtml(`GPEXE has ${entry.tracks.length} recordings of ${name} in this session. Which one should be imported?`)}</p>
        ${entry.currentChoice?.stale ? `<p class="muted">GPEXE changed these recordings after the last choice; choose again.</p>` : ""}
        <fieldset class="imports-fix-choices"><legend class="imports-fix-legend">${escapeHtml(`Recording for ${name}`)}</legend>
          ${entry.tracks.map((t, i) => radio(String(t.trackId), recordingText(t, i))).join("")}
          ${radio("none", `None of them: leave ${name} out of this import`)}
        </fieldset>
        ${w?.unknown ? `<p class="gpexe-unknown" role="alert">We can't tell whether the choice was saved. Check the result before choosing again.</p>` : ""}
        ${err ? `<p class="gpexe-error" role="alert">${escapeHtml(err.status === 409 ? "The recordings or the choice changed meanwhile. Nothing was saved; choose again." : "The choice was not saved. Choose again.")}</p>${h.errorTech(err)}` : ""}`;
      actions = w?.unknown
        ? button("primary-button", "training-load-gpexe-fix-track-check", w.sending ? "Checking..." : "Check the result", { disabled: w.sending })
        : skip(`data-gpexe-athlete-id="${escapeAttr(s.id)}"`) + button("primary-button", "training-load-gpexe-fix-track-save", w?.sending ? "Saving..." : "Save the choice", { disabled: !pick || locked });
    } else if (s.kind === "tracksError") {
      body = `<p class="imports-fix-sentence" role="alert">The recordings of this session could not be read. Try again.</p>${h.errorTech(detail.fix.tracks?.error)}`;
      actions = skip() + button("primary-button", "training-load-gpexe-fix-tracks-reload", "Try again");
    } else if (s.kind === "changes") {
      // Slice 2: whoever imports accepts the changes to results already in OptiMove; the approval sends acceptChanges.
      const n = Number(h.changeCount) || 0;
      body = `
        <p class="imports-fix-sentence">${escapeHtml(`Importing this session changes ${n === 1 ? "1 result that is" : `${n} results that are`} already in OptiMove.`)}</p>
        ${h.changeLines.length ? `<ul class="imports-fix-changes">${h.changeLines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>` : ""}
        <p class="muted">Open the full review below to see each value before you accept. Nothing changes until you import.</p>`;
      actions = skip() + button("primary-button", "training-load-gpexe-fix-accept", "Accept and continue");
    } else if (s.kind === "applyChoice") {
      body = `<p class="imports-fix-sentence">${escapeHtml(detail.updateError
        ? "The review could not be updated this time. Update it again before importing."
        : "A recording is chosen, but the review does not show it yet. Update the review before importing.")}</p>${detail.updateError ? h.errorTech(detail.updateError) : ""}`;
      actions = skip() + button("primary-button", "training-load-gpexe-review-update", "Update the review", { disabled: gx.linkBusy });
    } else if (s.kind === "stale") {
      body = `<p class="imports-fix-sentence">${escapeHtml(detail.updateError
        ? "The review could not be updated this time. Update it again before importing."
        : "Athlete links changed after this review was made. Update it before importing.")}</p>${detail.updateError ? h.errorTech(detail.updateError) : ""}`;
      actions = skip() + button("primary-button", "training-load-gpexe-review-update", "Update the review", { disabled: gx.linkBusy });
    } else {
      const err = detail.fix.searchError;
      const day = h.day ? formatDate(h.day) : "";
      body = `<p class="imports-fix-sentence"${err ? ` role="alert"` : ""}>${escapeHtml(err
        ? (err.code === "check_failed" ? "The search did not finish. Try again in a moment."
          : err.code === "poll_stopped" ? "We could not follow the search; it may still be running. Close this and look at the list in a moment."
            : h.checkErrorText(err))
        : `Search GPEXE again${day ? ` for ${day}` : ""} to read this session before importing.`)}</p>${err ? h.errorTech(err) : ""}`;
      const running = Boolean(gx.checkStarting || gx.check?.status === "running");
      actions = skip() + button("primary-button", "training-load-gpexe-fix-search", err ? "Search again" : day ? `Search ${day}` : "Search this day", { disabled: running || !h.day });
    }
  } else if (view.screen === "updating") {
    body = `<p class="imports-fix-sentence" role="status">Updating the review...</p>`;
  } else if (view.screen === "searching") {
    body = `<p class="imports-fix-sentence" role="status">${escapeHtml(`Searching GPEXE${h.day ? ` for ${formatDate(h.day)}` : ""}... This can take a few minutes.`)}</p>`;
  } else if (view.screen === "imported") {
    body = `<p class="imports-fix-sentence gpexe-success" role="status">This session is imported.</p>`;
    actions = nextOrBack();
  } else if (view.screen === "ready" && h.importCount > 0) {
    // A skipped athlete: the session can be imported without them - never "ready" as if nothing was left.
    const skippedIds = detail.fix.skipped || [];
    const skipped = skippedIds.length;
    const multi = new Set(openMultiTrackIds(detail));
    // A link skipped stays "until linked"; a recording skipped stays out until one is chosen.
    const until = skippedIds.every((id) => !multi.has(String(id))) ? " until linked" : "";
    const waiting = !h.canImport ? openMultiTrackIds(detail).length : 0;
    let base = skipped === 1 ? `This session can be imported without the athlete you skipped; their results are not imported${until}.`
      : skipped ? `This session can be imported without the ${skipped} athletes you skipped; their results are not imported${until}.` : "This session is ready.";
    // Someone who may not import can't choose a recording: whoever imports does.
    if (waiting) {
      // A skipped link stays said; the recording is added to it (code review).
      const who = waiting === 1 ? "one athlete" : `${waiting} athletes`;
      base = skipped
        ? `${base} ${waiting === 1 ? "One athlete has" : `${waiting} athletes have`} more than one GPEXE recording: whoever imports chooses which one to use.`
        : `This session is ready except for ${who} with more than one GPEXE recording: whoever imports chooses which one to use.`;
    }
    // Accepted changes are said again beside the Import button.
    else if (h.canImport && detail.acceptChanges && h.changeCount) base += ` Importing also changes ${h.changeCount === 1 ? "1 result" : `${h.changeCount} results`} already in OptiMove.`;
    if (h.switchOff) {
      body = `<p class="imports-fix-sentence">${escapeHtml(`${base} Importing is switched off${h.teamSwitchOff ? " for this team" : ""}; ${h.AskWho().replace(/^./, (ch) => ch.toLowerCase())} to turn it on.`)}</p>`;
      actions = nextOrBack();
    } else if (!h.canImport) {
      body = `<p class="imports-fix-sentence">${escapeHtml(`${base} ${h.AskWho()} to import it.`)}</p>`;
      actions = nextOrBack();
    } else {
      body = `<p class="imports-fix-sentence">${escapeHtml(base)}</p>`;
      actions = (h.next ? button("plain-button", "training-load-gpexe-fix-next", "Next session in the group", { disabled: busy }) : "")
        + button("primary-button", "training-load-gpexe-approve", detail.approving ? "Importing..." : `Import ${h.importCount === 1 ? "1 athlete" : `${h.importCount} athletes`}`, { disabled: busy });
    }
  } else {
    // A kind outside slice 1, a refusal, or nothing to import: the full review says why.
    body = `${h.refusalText ? `<p class="gpexe-refused" role="alert">${escapeHtml(h.refusalText)}</p>` : ""}<p class="imports-fix-sentence">This session needs a look in its full review.</p>`;
    actions = (h.next ? button("plain-button", "training-load-gpexe-fix-next", "Next session in the group", { disabled: busy }) : "")
      + button("primary-button", "training-load-gpexe-fix-full", "See why", { disabled: busy });
  }
  return `
    <div class="imports-fix-backdrop" data-action="training-load-gpexe-fix-close" aria-hidden="true"></div>
    <section class="gpexe-panel imports-fix is-open" id="imports-fix" role="dialog" aria-modal="true" aria-labelledby="imports-fix-title">
      <div class="imports-fix-head">
        <h3 id="imports-fix-title">${escapeHtml(h.title)}</h3>
        ${button("plain-button imports-fix-close", "training-load-gpexe-fix-close", "×", { disabled: busy, attrs: `aria-label="Close"` })}
        ${counter}
      </div>
      <div class="imports-fix-body">${body}</div>
      ${actions ? `<div class="imports-fix-actions">${actions}</div>` : ""}
      ${fullReviewLink}
    </section>
  `;
}
