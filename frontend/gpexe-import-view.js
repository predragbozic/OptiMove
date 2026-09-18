// GPEXE import from the app, phase F3a: the "GPEXE imports" view in Training
// Load -> Data & Analysis. It shows what the F1/F2 API returns and nothing
// more: the server decides what an import would write, who may approve, and
// whether writing is on. This view never claims a backup was checked; it only
// repeats the server's own sentence about the import switch.
//
// Owner decisions carried into the screens (2026-09-18): participation and
// the GPS measurement are shown separately; a missing value is never shown as
// a zero; the approval covers the whole candidate; every change to an already
// imported result is listed and must be accepted explicitly; an uncertain
// outcome is never shown as "not imported".
import { state } from "./state.js";
import { escapeAttr, escapeHtml, formatDate, renderOption } from "./utils.js";
import { gpexeTeamOptions } from "./gpexe-import-data.js";

const BLOCKER_TEXT = {
  import_switch_off: "Import writing is off in this environment",
  superseded_by_newer_data: "Replaced by newer GPEXE data",
  already_imported: "Already imported",
  blocked: "Blocked - open it for the reason",
  snapshot_expired_check_again: "GPEXE data expired - check again",
  nothing_to_import: "Nothing new to import",
};

const STATUS_TEXT = {
  pending: "Waiting for approval",
  blocked: "Blocked",
  superseded: "Replaced",
  imported: "Imported",
};

const OUTCOME_TEXT = {
  created: "New",
  unchanged: "Unchanged",
  supplemented: "Values added",
  corrected: "Values replaced",
  needs_review: "Conflicting version (for review)",
  stale_resend_ignored: "Older or manual values kept",
  not_imported: "Not imported",
};

const GPS_TEXT = {
  measured: "Measured",
  needs_manual_review: "Needs manual review",
  not_valid: "Not valid (per GPEXE)",
};

// What a refused approval means, and the one thing to do next. Every code
// here is a refusal BEFORE anything was written (the server says so).
const REFUSAL_TEXT = {
  import_switch_off: "Import writing is off in this environment. Nothing was imported.",
  not_an_approver: "You may not approve GPEXE imports for this team. A platform admin can grant you the right, or approve it.",
  already_imported: "This session was already imported, perhaps by another approval at the same time. Nothing more was written.",
  superseded_by_newer_data: "GPEXE has newer data for this session. Nothing was imported; review the newer candidate.",
  blocked: "This session is blocked. Nothing was imported; see the reason and the step that lifts it.",
  snapshot_expired_check_again: "The GPEXE data of this candidate expired. Nothing was imported; press \"Check now\" again.",
  nothing_to_import: "This candidate would write nothing.",
  changes_need_acceptance: "This import changes results that were already imported. Nothing was imported; tick the box to accept those changes, then approve again.",
  preview_changed: "What this import would do changed since you opened it. Nothing was imported; review it again.",
  internal_error: "The approval failed on the server before anything was written. Nothing was imported.",
};

// Day and time on the same (local) clock.
function fmtDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n) => String(n).padStart(2, "0");
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}.${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function fmtValue(value, unit) {
  if (value === null || value === undefined) return "-";
  const n = Number(value);
  const text = Number.isFinite(n) ? n.toLocaleString("en-GB", { maximumFractionDigits: 2 }) : String(value);
  return unit ? `${text} ${unit}` : text;
}

function resultLabel(result) {
  return result.level === "drill" ? `Drill ${Number(result.drillIndex) + 1}` : "Whole session";
}

function athleteName(candidate, athleteId, gpexeAthleteId) {
  const name = athleteId ? candidate.athletes?.[athleteId]?.name : "";
  if (name) return name;
  return gpexeAthleteId ? `GPEXE athlete ${gpexeAthleteId}` : "Athlete";
}

function errorText(error, fallback) {
  if (!error) return "";
  if (error.status === 404) return "This team is not available in your current workspace.";
  return error.message || fallback || "Something went wrong.";
}

// ---------------------------------------------------------------------------

export function renderGpexeImportsHtml() {
  const gx = state.trainingLoad.gpexe;
  const teams = gpexeTeamOptions();
  if (!state.trainingLoad.orgPickerData && gx.loading) return `<div class="gpexe-imports"><p class="muted">Loading...</p></div>`;
  if (!teams.length && !gx.loading) {
    return `<div class="gpexe-imports"><p class="muted">No team in this workspace. Switch to a team or club workspace to import GPEXE sessions.</p></div>`;
  }
  const status = gx.status;
  return `
    <div class="gpexe-imports">
      ${renderTeamRowHtml(teams, gx.teamId)}
      ${gx.error ? `<p class="gpexe-error" role="alert">${escapeHtml(errorText(gx.error, "Could not load GPEXE imports."))}</p>` : ""}
      ${gx.loading && !status ? `<p class="muted">Loading...</p>` : ""}
      ${status ? renderStatusHtml(status) : ""}
      ${status ? renderCheckHtml(gx, status) : ""}
      ${gx.notice ? `<p class="gpexe-notice" role="status">${escapeHtml(gx.notice)}</p>` : ""}
      ${status ? renderCandidatesHtml(gx) : ""}
      ${status ? renderLinksHtml(gx) : ""}
      ${gx.detail ? renderCandidateDetailHtml(gx, status) : ""}
    </div>
  `;
}

function renderTeamRowHtml(teams, teamId) {
  if (teams.length === 1) {
    const team = teams[0];
    return `<div class="gpexe-team-row"><span class="gpexe-team-label">Team</span><strong>${escapeHtml(team.name)}</strong>${team.club_name ? `<span class="muted"> · ${escapeHtml(team.club_name)}</span>` : ""}</div>`;
  }
  return `
    <label class="gpexe-team-row">
      <span class="gpexe-team-label">Team</span>
      <select class="gpexe-select" data-action="training-load-gpexe-team" aria-label="Team">
        ${teams.map((team) => renderOption(team.id, team.club_name ? `${team.name} (${team.club_name})` : team.name, teamId)).join("")}
      </select>
    </label>
  `;
}

function renderStatusHtml(status) {
  const sw = status.importSwitch || {};
  const viewer = status.viewer || {};
  return `
    <div class="gpexe-status">
      <p class="gpexe-switch ${sw.enabled ? "is-on" : "is-off"}"><strong>${sw.enabled ? "Import writing is on." : "Import writing is off."}</strong> ${escapeHtml(sw.message || "")}</p>
      ${status.settings
        ? `<p class="muted">Reads GPEXE team ${escapeHtml(status.settings.gpexeTeamId)}.</p>`
        : `<p class="gpexe-warning">No GPEXE team is connected to this team yet. A platform admin connects it in Settings &gt; Teams.</p>`}
      <p class="muted">${viewer.canApprove
        ? `You can approve imports for this team (${viewer.approvalBasis === "platform_admin" ? "platform admin" : "approver grant"}).`
        : "You can review candidates. Approving needs a platform admin or an explicit approver grant for this team."}</p>
    </div>
  `;
}

function renderCheckHtml(gx, status) {
  const check = gx.check || status.lastCheck;
  const running = Boolean(gx.checkStarting || check?.status === "running");
  const canCheck = Boolean(status.settings) && !running;
  return `
    <section class="gpexe-panel" aria-label="Check GPEXE">
      <div class="gpexe-check-row">
        <label class="gpexe-date"><span>From</span><input type="date" data-gpexe-field="from" ${running ? "disabled" : ""}></label>
        <label class="gpexe-date"><span>To</span><input type="date" data-gpexe-field="to" ${running ? "disabled" : ""}></label>
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-check" ${canCheck ? "" : "disabled"}>${running ? "Checking..." : "Check now"}</button>
      </div>
      <p class="muted gpexe-hint">Without dates, the last 14 days are checked (at most 31). A check saves what GPEXE shows as candidates; it imports nothing.</p>
      ${gx.checkError ? `<p class="gpexe-error" role="alert">${escapeHtml(errorText(gx.checkError, "The check could not start."))}</p>` : ""}
      ${check ? renderCheckSummaryHtml(check) : ""}
    </section>
  `;
}

function renderCheckSummaryHtml(check) {
  const counts = `${check.sessionsSeen} session(s): ${check.candidatesNew} new, ${check.candidatesChanged} changed, ${check.candidatesUnchanged} unchanged`;
  if (check.status === "running") return `<p class="gpexe-check-state" role="status">Checking GPEXE ${escapeHtml(formatDate(check.window?.from))} - ${escapeHtml(formatDate(check.window?.to))}... ${escapeHtml(counts)} so far.</p>`;
  if (check.status === "failed") {
    return `<p class="gpexe-error" role="alert">The last check (${escapeHtml(fmtDateTime(check.startedAt))}) failed: ${escapeHtml(check.error?.message || check.error?.code || "unknown error")}</p>`;
  }
  return `<p class="gpexe-check-state">Last check ${escapeHtml(fmtDateTime(check.finishedAt || check.startedAt))} (${escapeHtml(formatDate(check.window?.from))} - ${escapeHtml(formatDate(check.window?.to))}): ${escapeHtml(counts)}.</p>`;
}

function renderCandidatesHtml(gx) {
  const list = gx.candidates || [];
  return `
    <section class="gpexe-panel" aria-label="Import candidates">
      <div class="gpexe-panel-head">
        <h3>Sessions from GPEXE</h3>
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-superseded" aria-pressed="${gx.includeSuperseded ? "true" : "false"}">${gx.includeSuperseded ? "Hide replaced" : "Show replaced"}</button>
      </div>
      ${!list.length ? `<p class="muted">No sessions yet. Press "Check now".</p>` : `
        <ul class="gpexe-candidate-list">
          ${list.map((c) => renderCandidateRowHtml(c)).join("")}
        </ul>
      `}
    </section>
  `;
}

function renderCandidateRowHtml(c) {
  const counts = c.counts || {};
  const facts = [];
  if (c.status === "pending" || c.status === "blocked") {
    if (counts.created) facts.push(`${counts.created} new result(s)`);
    if (c.changesToImported) facts.push(`${c.changesToImported} change(s) to imported results`);
    if (counts.athletesNotImported) facts.push(`${counts.athletesNotImported} athlete(s) left out`);
  }
  const blockers = (c.approvalBlockers || []).filter((b) => b !== "import_switch_off" && b !== "already_imported");
  return `
    <li>
      <button type="button" class="gpexe-candidate" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(c.id)}">
        <span class="gpexe-candidate-main">
          <strong>${escapeHtml(c.label || `GPEXE session ${c.gpexeTeamSessionId}`)}</strong>
          <span class="muted">${escapeHtml(fmtDateTime(c.sessionStartedAt))}</span>
        </span>
        <span class="gpexe-badge is-${escapeAttr(c.status)}">${escapeHtml(STATUS_TEXT[c.status] || c.status)}</span>
        ${facts.length ? `<span class="gpexe-candidate-facts">${escapeHtml(facts.join(" · "))}</span>` : ""}
        ${blockers.length ? `<span class="gpexe-candidate-facts muted">${escapeHtml(blockers.map((b) => BLOCKER_TEXT[b] || b).join(" · "))}</span>` : ""}
      </button>
    </li>
  `;
}

function renderLinksHtml(gx) {
  const links = gx.links || [];
  return `
    <section class="gpexe-panel" aria-label="Athlete links">
      <div class="gpexe-panel-head"><h3>GPEXE athletes linked to this team</h3></div>
      <p class="muted gpexe-hint">A link is never guessed. Link a GPEXE athlete from a session's review, where GPEXE shows them.</p>
      ${gx.linkError ? `<p class="gpexe-error" role="alert">${escapeHtml(errorText(gx.linkError, "The link could not be changed."))}</p>` : ""}
      ${!links.length ? `<p class="muted">No athlete is linked yet.</p>` : `
        <ul class="gpexe-link-list">
          ${links.map((l) => `
            <li>
              <span><strong>${escapeHtml(l.athleteName)}</strong> <span class="muted">GPEXE ${escapeHtml(l.gpexeAthleteId)}</span></span>
              <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-unlink" data-link-id="${escapeAttr(l.id)}" ${gx.linkBusy ? "disabled" : ""}>Unlink</button>
            </li>
          `).join("")}
        </ul>
      `}
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Candidate detail
// ---------------------------------------------------------------------------

function renderCandidateDetailHtml(gx, status) {
  const detail = gx.detail;
  const c = detail.candidate;
  // Not closable while an approval runs: its answer must be seen.
  const busy = detail.approving || detail.verifying ? "disabled" : "";
  const title = c ? (c.label || `GPEXE session ${c.gpexeTeamSessionId}`) : "GPEXE session";
  return `
    <div class="builder-athlete-overlay gpexe-detail-overlay">
      <button type="button" class="builder-athlete-backdrop" data-action="training-load-gpexe-close" aria-label="Close" ${busy}></button>
      <section class="panel builder-athlete-picker gpexe-detail" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="builder-section-panel-head">
          <h3>${escapeHtml(title)}</h3>
          <button type="button" class="plain-button icon-button builder-athlete-picker-cancel" data-action="training-load-gpexe-close" aria-label="Close" ${busy}>&times;</button>
        </div>
        <div class="gpexe-detail-body">
          ${gx.notice ? `<p class="gpexe-notice" role="status">${escapeHtml(gx.notice)}</p>` : ""}
          ${gx.linkError ? `<p class="gpexe-error" role="alert">${escapeHtml(errorText(gx.linkError, "The link could not be changed."))}</p>` : ""}
          ${detail.loading ? `<p class="muted">Loading...</p>` : ""}
          ${detail.error ? `<p class="gpexe-error" role="alert">${escapeHtml(detail.error.status === 404 ? "This session is not available." : errorText(detail.error))}</p>` : ""}
          ${c ? renderCandidateBodyHtml(c, detail, status) : ""}
        </div>
      </section>
    </div>
  `;
}

function renderCandidateBodyHtml(c, detail, status) {
  const preview = c.preview;
  return `
    <p class="gpexe-detail-meta">
      <span class="gpexe-badge is-${escapeAttr(c.status)}">${escapeHtml(STATUS_TEXT[c.status] || c.status)}</span>
      <span class="muted">${escapeHtml(fmtDateTime(c.sessionStartedAt))}</span>
      ${c.snapshot?.available ? `<span class="muted">GPEXE data kept until ${escapeHtml(formatDate(c.snapshot.expiresAt))}</span>` : ""}
    </p>
    ${renderApprovalRecordHtml(c)}
    ${!preview ? `<p class="muted">${c.snapshot?.available === false ? "The GPEXE data of this candidate expired. Press \"Check now\" to see it again." : "No preview."}</p>` : `
      ${renderBlockedHtml(preview, c)}
      ${renderChangesHtml(preview, c)}
      ${renderAthletesHtml(preview, c)}
      ${renderNoRecordHtml(preview, c)}
    `}
    ${renderOutcomeHtml(detail)}
    ${renderApproveHtml(c, detail, status)}
  `;
}

function renderApprovalRecordHtml(c) {
  if (!c.approval) return "";
  const a = c.approval;
  const counts = Object.entries(a.import?.counts || {}).map(([k, n]) => `${n} ${OUTCOME_TEXT[k] ? OUTCOME_TEXT[k].toLowerCase() : k}`).join(", ");
  return `<p class="gpexe-success">Imported ${escapeHtml(fmtDateTime(a.approvedAt))} (${a.basis === "platform_admin" ? "platform admin" : "approver grant"})${counts ? `: ${escapeHtml(counts)}` : ""}.</p>`;
}

function renderBlockedHtml(preview, c) {
  if (!preview.blocked) return "";
  const steps = preview.blocked.resolution || [];
  return `
    <div class="gpexe-blocked" role="note">
      <p><strong>Blocked:</strong> ${escapeHtml(preview.blocked.message || preview.blocked.code)}</p>
      ${steps.length ? `<ol>${steps.map((s) => `<li>${escapeHtml(s.gpexeAthleteId ? `${athleteName(c, s.previousAthleteId, s.gpexeAthleteId)}: ` : "")}${escapeHtml(s.step)}</li>`).join("")}</ol>` : ""}
    </div>
  `;
}

function renderChangesHtml(preview, c) {
  const changes = preview.changesToImported || [];
  if (!changes.length) return "";
  return `
    <section class="gpexe-changes" aria-label="Changes to imported results">
      <h4>Changes to results that were already imported (${changes.length})</h4>
      <p class="muted">These must be accepted before approving.</p>
      <ul>
        ${changes.map((ch) => `
          <li>
            <p><strong>${escapeHtml(athleteName(c, ch.athleteId, ch.gpexeAthleteId))}</strong> · ${escapeHtml(resultLabel(ch))} · ${escapeHtml(OUTCOME_TEXT[ch.outcome] || ch.outcome)}</p>
            <p class="muted">${escapeHtml(ch.message || "")}${ch.manualCorrectionKept ? " A manual correction stays current." : ""}</p>
            ${renderValueTableHtml(ch.values, true)}
          </li>
        `).join("")}
      </ul>
    </section>
  `;
}

function renderValueTableHtml(values, withPrevious) {
  if (!values?.length) return "";
  return `
    <div class="gpexe-values-wrap"><table class="gpexe-values">
      <thead><tr><th scope="col">Metric</th>${withPrevious ? `<th scope="col">Before</th>` : ""}<th scope="col">GPEXE</th></tr></thead>
      <tbody>
        ${values.map((v) => `<tr><td>${escapeHtml(v.label)}</td>${withPrevious ? `<td>${escapeHtml(fmtValue(v.previous, v.unit))}</td>` : ""}<td>${escapeHtml(fmtValue(v.value, v.unit))}</td></tr>`).join("")}
      </tbody>
    </table></div>
  `;
}

function renderAthletesHtml(preview, c) {
  const athletes = preview.athletes || [];
  const unlinkedChoices = (preview.teamAthletesWithoutGpexeRecord || []).map((a) => ({ id: a.athleteId, name: athleteName(c, a.athleteId, null) }));
  return `
    <section class="gpexe-athletes" aria-label="Athletes in this session">
      <h4>Athletes in GPEXE (${athletes.length})</h4>
      ${athletes.map((a) => renderAthleteHtml(a, c, unlinkedChoices)).join("")}
    </section>
  `;
}

function renderAthleteHtml(a, c, unlinkedChoices) {
  const name = athleteName(c, a.athleteId, a.gpexeAthleteId);
  const gps = GPS_TEXT[a.gps?.status] || a.gps?.status || "";
  const outcomes = {};
  for (const r of a.results || []) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
  const outcomeText = Object.entries(outcomes).map(([k, n]) => `${n} ${(OUTCOME_TEXT[k] || k).toLowerCase()}`).join(", ");
  const canLink = a.notImported?.code === "athlete_not_linked" && unlinkedChoices.length;
  const shownResults = (a.results || []).filter((r) => r.outcome !== "not_imported" && r.outcome !== "unchanged");
  return `
    <details class="gpexe-athlete ${a.blocksSession ? "is-blocking" : ""}">
      <summary>
        <span><strong>${escapeHtml(name)}</strong>${a.blocksSession ? ` <span class="gpexe-badge is-blocked">Blocks the session</span>` : ""}</span>
        <span class="muted">Participation: recorded by GPEXE · GPS: ${escapeHtml(gps)}${a.notImported ? ` · Not imported: ${escapeHtml(a.notImported.message)}` : ` · ${escapeHtml(outcomeText)}`}</span>
      </summary>
      ${a.gps?.reason ? `<p class="muted">${escapeHtml(a.gps.reason.message)}</p>` : ""}
      ${canLink ? `
        <div class="gpexe-link-row">
          <label><span>Link GPEXE athlete ${escapeHtml(a.gpexeAthleteId)} to</span>
            <select class="gpexe-select" data-gpexe-link-select="${escapeAttr(a.gpexeAthleteId)}">
              <option value="">Choose an athlete of the team</option>
              ${unlinkedChoices.map((o) => `<option value="${escapeAttr(o.id)}">${escapeHtml(o.name)}</option>`).join("")}
            </select>
          </label>
          <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-link" data-gpexe-athlete-id="${escapeAttr(a.gpexeAthleteId)}" ${state.trainingLoad.gpexe.linkBusy ? "disabled" : ""}>Link</button>
        </div>
      ` : ""}
      ${shownResults.map((r) => `
        <div class="gpexe-result">
          <p>${escapeHtml(resultLabel(r))} · ${escapeHtml(OUTCOME_TEXT[r.outcome] || r.outcome)}</p>
          ${renderValueTableHtml(r.values.filter((v) => v.change !== "same" || r.outcome === "created"), r.outcome !== "created")}
        </div>
      `).join("")}
      ${(a.skippedValues || []).length ? `<p class="muted">${a.skippedValues.length} value(s) left out: ${escapeHtml([...new Set(a.skippedValues.map((s) => s.reason))].join(", "))}. A left-out value is not a zero.</p>` : ""}
    </details>
  `;
}

function renderNoRecordHtml(preview, c) {
  const list = preview.teamAthletesWithoutGpexeRecord || [];
  if (!list.length) return "";
  return `
    <section class="gpexe-norecord" aria-label="Team athletes without a GPEXE record">
      <h4>Team athletes without a GPEXE record (${list.length})</h4>
      <p class="muted">No GPS record in this session; participation is unknown. Nothing is written for them.</p>
      <p>${escapeHtml(list.map((a) => athleteName(c, a.athleteId, null)).join(", "))}</p>
    </section>
  `;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

function renderOutcomeHtml(detail) {
  const o = detail.outcome;
  if (!o) return "";
  if (o.kind === "imported") {
    const r = o.result || {};
    const counts = Object.entries(r.import?.counts || {}).map(([k, n]) => `${n} ${(OUTCOME_TEXT[k] || k).toLowerCase()}`).join(", ");
    return `
      <div class="gpexe-success" role="status">
        <p><strong>Imported.</strong>${counts ? ` ${escapeHtml(counts)}.` : ""}</p>
        ${r.commitConfirmation === "verified_after_commit_error" ? `<p>The database's confirmation did not arrive in time, but the server found the import committed.</p>` : ""}
        ${r.candidateReadError ? `<p>${escapeHtml(r.candidateReadError.message)}</p>` : ""}
      </div>
    `;
  }
  if (o.kind === "unknown") {
    const verified = o.verified;
    return `
      <div class="gpexe-unknown" role="alert">
        <p><strong>It is not known whether this session was imported.</strong> ${o.verify ? "The database did not confirm the import in time." : "The answer to the approval was lost or unclear."} Do not approve again or enter data by hand before checking.</p>
        ${verified === "imported" ? `<p class="gpexe-success">Checked: it was imported.</p>` : ""}
        ${verified === "not_imported" ? `<p>Checked: it was not imported. You can approve it again.</p>` : ""}
        ${verified === "not_visible_yet" ? `<p>No import is visible yet. The first approval may still be running on the server. Approving again is safe: if the first one finishes, the second is refused as already imported.</p>` : ""}
        ${verified === "still_unknown" ? `<p>Still not known. Try the check again in a moment.</p>` : ""}
        ${verified === "imported" || verified === "not_imported" ? "" : `<button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-verify" ${detail.verifying ? "disabled" : ""}>${detail.verifying ? "Checking..." : "Check the outcome"}</button>`}
      </div>
    `;
  }
  const code = o.error?.code;
  const reviewAgain = o.error?.data?.reviewAgain;
  return `
    <div class="gpexe-refused" role="alert">
      <p>${escapeHtml(REFUSAL_TEXT[code] || (o.error?.status === 404 ? "This session is not available." : "The approval was refused. Nothing was imported."))}</p>
      ${reviewAgain?.candidateId ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(reviewAgain.candidateId)}">Review again</button>` : ""}
    </div>
  `;
}

function renderApproveHtml(c, detail, status) {
  if (c.status === "imported" || detail.outcome?.kind === "imported" || detail.outcome?.verified === "imported") return "";
  if (detail.outcome?.kind === "unknown" && detail.outcome.verified !== "not_imported" && detail.outcome.verified !== "not_visible_yet") return "";
  const viewer = status?.viewer || {};
  const blockers = c.approvalBlockers || [];
  if (!viewer.canApprove) return `<p class="muted gpexe-approve-note">Approving needs a platform admin or an explicit approver grant for this team.</p>`;
  if (blockers.length) return `<p class="muted gpexe-approve-note">Cannot be approved: ${escapeHtml(blockers.map((b) => BLOCKER_TEXT[b] || b).join(" · "))}.</p>`;
  const changes = c.changesToImported || 0;
  return `
    <div class="gpexe-approve">
      ${changes ? `
        <label class="gpexe-accept">
          <input type="checkbox" data-gpexe-accept data-action="training-load-gpexe-accept" ${detail.acceptChanges ? "checked" : ""}>
          <span>I accept the ${changes} change(s) to results that were already imported.</span>
        </label>
      ` : ""}
      <p class="muted">Approving imports this whole session exactly as shown. Athletes left out stay out.</p>
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-approve" ${detail.approving ? "disabled" : ""}>${detail.approving ? "Importing..." : "Approve import"}</button>
    </div>
  `;
}
