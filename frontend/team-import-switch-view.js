// U2 (v56): the Imports screen's "Imports for this team" line and panel.
// Everyone who sees the team gets the one-sentence state; a platform
// administrator and the club's administrator get the panel with the
// conditions, the reason and the buttons. Every text is escaped.
import { escapeAttr, escapeHtml, formatDate } from "./utils.js";
import { teamSwitchErrorText } from "./team-import-switch-data.js";

const KIND_LABEL = {
  backup: "Database backup",
  restore_probe: "Restore probe",
  wrong_link_procedure: "Procedure for a wrongly linked athlete",
  archived_team_check_stop: "Archived team stops a running search",
};

function modeSentence(mode) {
  return mode === "team"
    ? "Team mode: the club administrator and the team's coaches import."
    : "Pilot mode: a platform administrator, and coaches given the right to approve, import.";
}

// The line under the source card, for every viewer.
export function renderTeamSwitchLineHtml(status, manager, canTurnOn = manager) {
  const sw = status?.teamImportSwitch;
  if (!sw) return "";
  if (!sw.enabled) {
    const who = manager
      ? (canTurnOn ? "You can turn them on below." : "While the team is in pilot mode, a platform administrator turns them on.")
      : (sw.mode === "team" ? "A platform administrator or the club administrator turns them on." : "A platform administrator turns them on.");
    return `<p class="gpexe-switch is-off"><strong>Imports are switched off for this team.</strong> ${who}</p>`;
  }
  return `<p class="muted gpexe-hint">Imports are on for this team. ${escapeHtml(modeSentence(sw.mode))}</p>`;
}

function conditionRow(c, platform) {
  const label = KIND_LABEL[c.kind] || c.kind;
  const when = c.recordedOn ? ` · ${escapeHtml(formatDate(c.recordedOn))}` : "";
  const rule = c.maxAgeDays ? ` (at most ${c.maxAgeDays} days old)` : c.required === "team" ? " (needed for team mode)" : "";
  const next = c.met ? "" : platform ? " - record the date below" : " - a platform administrator records this";
  return `<li class="imports-condition ${c.met ? "is-met" : "is-unmet"}"><span aria-hidden="true">${c.met ? "&#10003;" : "&#10007;"}</span> <span class="visually-hidden">${c.met ? "Met: " : "Not met: "}</span>${escapeHtml(label)}${escapeHtml(rule)}${when}${escapeHtml(next)}</li>`;
}

function historyRows(history) {
  if (!history?.length) return `<p class="muted">No change yet.</p>`;
  return `<ul class="imports-switch-history">${history.map((h) => `<li>${escapeHtml(formatDate(h.changedAt))} · ${h.enabled ? "On" : "Off"} · ${h.mode === "team" ? "Team mode" : "Pilot mode"} · ${h.basis === "club_admin" ? "club administrator" : "platform administrator"}${h.reason ? ` · ${escapeHtml(h.reason)}` : ""}</li>`).join("")}</ul>`;
}

export function renderTeamSwitchPanelHtml(gx) {
  const ts = gx.teamSwitch;
  const d = ts?.data;
  if (!d || !d.canManage) return "";
  const busy = ts.busy ? "disabled" : "";
  const team = d.mode === "team";
  // A club administrator may turn a team on only once it is in team mode.
  const clubCannotOn = !d.canChangeMode && !d.enabled && !team;
  const today = new Date().toISOString().slice(0, 10);
  const buttons = d.enabled
    ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-switch-off" ${busy}>Turn imports off</button>`
    : `<button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-switch-on" ${clubCannotOn ? `aria-describedby="gpexe-switch-why"` : ""} ${busy || clubCannotOn ? "disabled" : ""}>Turn imports on</button>`;
  const modeButtons = d.canChangeMode
    ? (team
      ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-switch-mode-pilot" ${busy}>Back to pilot mode</button>`
      : `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-switch-mode-team" ${busy}>Move to team mode and turn on</button>`)
    : "";
  return `
    <section class="gpexe-panel imports-team-switch" aria-label="Imports for this team">
      <h3>Imports for this team</h3>
      <p>${d.enabled ? "Imports are <strong>on</strong>." : "Imports are <strong>off</strong>."} ${escapeHtml(modeSentence(d.mode))}</p>
      ${clubCannotOn ? `<p class="muted" id="gpexe-switch-why">While the team is in pilot mode, a platform administrator turns imports on.</p>` : ""}
      <ul class="imports-conditions">${(d.conditions || []).map((c) => conditionRow(c, d.canRecordPrerequisites)).join("")}</ul>
      <label class="gpexe-date"><span>Reason (shown in the history)</span><input type="text" maxlength="500" data-gpexe-switch-reason autocomplete="off" value="${escapeAttr(ts.draft || "")}" ${busy}></label>
      <div class="gpexe-check-row">${buttons}${modeButtons}</div>
      ${d.canRecordPrerequisites ? `
        <details class="imports-dates" ${(d.conditions || []).some((c) => !c.met) ? "open" : ""}>
          <summary>Record a date</summary>
          <p class="muted">OptiMove can't read the backup status; record the date you checked it. These dates apply to every team.</p>
          <div class="imports-dates-fields">
            <label class="gpexe-date"><span>What</span><select class="gpexe-select" data-gpexe-switch-kind ${busy}>${Object.entries(KIND_LABEL).map(([k, v]) => `<option value="${escapeAttr(k)}">${escapeHtml(v)}</option>`).join("")}</select></label>
            <label class="gpexe-date"><span>Date</span><input type="date" max="${escapeAttr(today)}" data-gpexe-switch-date value="${escapeAttr(today)}" ${busy}></label>
            <label class="gpexe-date"><span>Note (optional)</span><input type="text" maxlength="300" data-gpexe-switch-note autocomplete="off" ${busy}></label>
          </div>
          <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-switch-record" ${busy}>Record</button>
        </details>` : ""}
      ${ts.error ? `<p class="gpexe-error" role="alert">${escapeHtml(teamSwitchErrorText(ts.error))}</p>` : ""}
      ${ts.notice ? `<p class="gpexe-notice" role="status">${escapeHtml(ts.notice)}</p>` : ""}
      <details class="gpexe-tech"><summary>History</summary>${historyRows(d.history)}</details>
    </section>`;
}
