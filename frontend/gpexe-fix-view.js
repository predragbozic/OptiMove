// Imports "Fix" flow, slice 1: the sheet. One problem per screen - "Step x of y", one sentence, ONE button, "Skip for
// now" and × - then "This session is ready" and the next session of the group. A full-screen sheet on a phone, a 560 px
// centred dialog over a real backdrop on a computer; modal like the P5 help (Escape, Back and Tab: app.js and
// gpexe-period-drag.js). Pure template strings: the import view hands in the helpers it owns (wording per viewer, the
// link chooser, the counts), so the review and the sheet say the same thing the same way.
import { escapeAttr, escapeHtml, formatDate } from "./utils.js";
import { fixScreen, fixMustStay } from "./gpexe-fix-data.js";

const GIVE_UP_AFTER_CHECKS = 3;

function button(cls, action, label, { disabled = false, attrs = "" } = {}) {
  return `<button type="button" class="${cls} gpexe-button" data-action="${escapeAttr(action)}" ${attrs} ${disabled ? "disabled" : ""}>${escapeHtml(label)}</button>`;
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
    const skipped = (detail.fix.skipped || []).length;
    const base = skipped === 1 ? "This session can be imported without the athlete you skipped; their results are not imported until linked."
      : skipped ? `This session can be imported without the ${skipped} athletes you skipped; their results are not imported until linked.` : "This session is ready.";
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
      </div>
      ${counter}
      <div class="imports-fix-body">${body}</div>
      ${actions ? `<div class="imports-fix-actions">${actions}</div>` : ""}
    </section>
  `;
}
