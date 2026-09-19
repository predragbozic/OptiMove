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
// outcome is never shown as "not imported" (owner, F3a external review: a
// missing approval with a pending candidate only means "not visible yet";
// only a confirmed import is final, only an explicit refusal is "not
// imported"). Main messages are written for the coach; the API's codes are
// kept in a collapsed "Technical details" block.
import { state } from "./state.js";
import { escapeAttr, escapeHtml, formatDate, renderOption } from "./utils.js";
import { gpexeTeamOptions, reviewMadeBeforeLinkChange } from "./gpexe-import-data.js";

// Why a session can't be approved right now, in the coach's words (blocked
// and expired sessions explain themselves above the approve area).
const BLOCKER_TEXT = {
  import_switch_off: "Importing is switched off in this environment, so it can't be approved here.",
  superseded_by_newer_data: "GPEXE has newer data for this session. Open the newer version.",
  already_imported: "Already imported.",
  snapshot_expired_check_again: "The GPEXE data is too old. Check for new sessions, then review it again.",
  nothing_to_import: "Nothing new to import - no action needed.",
};

// One badge per group, the same in the list and in the review.
const GROUP_BADGE = {
  decision: ["pending", "Waiting for approval"],
  notyet: ["blocked", "Can't be imported yet"],
  excluded: ["excluded", "Not imported"],
  uptodate: ["uptodate", "Up to date"],
  imported: ["imported", "Imported"],
  replaced: ["superseded", "Replaced"],
};

const OUTCOME_TEXT = {
  created: "New",
  unchanged: "Unchanged",
  supplemented: "Values added",
  corrected: "Values replaced",
  needs_review: "Kept aside for review (differs from the current values)",
  stale_resend_ignored: "Older GPEXE version - current values kept",
  not_imported: "Not imported",
};

// Counts of results, with singular and plural.
const COUNT_TEXT = {
  created: ["new result", "new results"],
  unchanged: ["result unchanged", "results unchanged"],
  supplemented: ["result with values added", "results with values added"],
  corrected: ["result with values replaced", "results with values replaced"],
  needs_review: ["result kept aside for review", "results kept aside for review"],
  stale_resend_ignored: ["older GPEXE version ignored", "older GPEXE versions ignored"],
  needs_review_already_recorded: ["result already kept aside earlier", "results already kept aside earlier"],
  stale_resend_ignored_already_recorded: ["older GPEXE version already ignored earlier", "older GPEXE versions already ignored earlier"],
};

// Metric names for the coach, by metric key. GPEXE's own names (TotDist,
// SPEEDmax, ...) and the keys are only in Technical details.
const METRIC_TEXT = {
  gpexe_time_min: "Time",
  gpexe_total_distance: "Distance",
  gpexe_max_speed: "Top speed",
  gpexe_sprint_distance_7mps: "Sprint distance (above 25.2 km/h)",
  gpexe_acceleration_events: "Accelerations (above 2.5 m/s²)",
  gpexe_deceleration_events: "Decelerations (above 2.5 m/s²)",
  gpexe_power_zone_25_60_distance: "Distance at 25-60 W/kg",
  gpexe_power_zone_60_75_distance: "Distance at 60-75 W/kg",
  gpexe_power_zone_75_plus_distance: "Distance at 75 W/kg or more",
  gpexe_burst_events: "Bursts (GPEXE definition not confirmed yet)",
  gpexe_brake_events: "Brakes (GPEXE definition not confirmed yet)",
};

function metricName(v) {
  return METRIC_TEXT[v.metricKey] || "Other GPEXE value";
}

// Values in the order above (the most familiar first), unknown ones last.
const METRIC_ORDER = Object.keys(METRIC_TEXT);
function byMetricOrder(a, b) {
  const rank = (v) => (METRIC_ORDER.includes(v.metricKey) ? METRIC_ORDER.indexOf(v.metricKey) : METRIC_ORDER.length);
  return rank(a) - rank(b);
}

function plural(n, one, many) {
  return `${n} ${Number(n) === 1 ? one : many}`;
}

function countsText(counts) {
  return Object.entries(counts || {}).filter(([, n]) => n).map(([k, n]) => plural(n, ...(COUNT_TEXT[k] || ["other result", "other results"]))).join(", ");
}

const GPS_TEXT = {
  measured: "Measured",
  needs_manual_review: "Needs manual review",
  not_valid: "Not valid (per GPEXE)",
};

// What a refused approval means, and the one thing to do next. Every code
// here is a refusal BEFORE anything was written (the server says so).
const REFUSAL_TEXT = {
  import_switch_off: "Not imported: importing is switched off in this environment.",
  not_an_approver: "Not imported: you may not approve imports for this team. Ask a platform admin to approve it or to give you the right.",
  superseded_by_newer_data: "Not imported: GPEXE has newer data for this session. Open the newer version.",
  blocked: "Not imported: this session must be fixed first. See what to fix above.",
  snapshot_expired_check_again: "Not imported: the GPEXE data is too old. Check for new sessions, then review it again.",
  nothing_to_import: "Nothing to import: GPEXE has nothing new for this session.",
  changes_need_acceptance: "Not imported yet: this import changes results that were already imported. Tick the box to accept those changes, then approve.",
  preview_changed: "Not imported: the data changed since you opened this session. Review it again, then approve.",
  internal_error: "Not imported: the server failed before writing anything. Try again later.",
};

// After this many checks without a confirmed result the coach is sent to a
// platform admin instead of checking forever.
const GIVE_UP_AFTER_CHECKS = 3;

// Why a value was left out, in the coach's words. An unknown code is shown
// as "other reason" and listed under Technical details.
const SKIP_TEXT = {
  details_not_fetched: "drill details not in GPEXE yet",
  team_threshold_missing: "team thresholds missing in GPEXE",
  team_threshold_split: "team thresholds changed during the session",
  threshold_mismatch: "thresholds do not match the team's",
  zones_missing: "zones missing in GPEXE",
  zones_not_ready: "zones not ready in GPEXE",
  zone_boundary_missing: "zone limits missing",
  zone_boundary_ambiguous: "zone limits unclear",
  zone_distance_missing: "zone distance missing",
  events_missing: "events missing in GPEXE",
  count_missing: "count missing",
  duration_mismatch: "durations do not add up",
  field_missing: "value missing in GPEXE",
  value_missing: "value missing in GPEXE",
  max_v_missing: "top speed missing in GPEXE",
  total_distance_missing: "total distance missing in GPEXE",
  total_time_missing: "total time missing in GPEXE",
  unexpected_unit: "unexpected unit in GPEXE",
};

// The step that lifts a block, in the coach's words, built from the step's
// action; the server's own wording (with field names and the runbook path)
// stays in Technical details.
function coachStep(s, c) {
  const name = s.previousAthleteId ? athleteName(c, s.previousAthleteId, null) : "the athlete";
  const undo = "Or ask a platform admin to undo the earlier import.";
  if (s.action === "relink_athlete") return `Link GPEXE athlete ${s.gpexeAthleteId} again to ${name} (the athlete their earlier results belong to), then check for new sessions.`;
  if (s.action === "restore_team_membership") return `Make ${name} an active member of the team again, then check for new sessions. ${undo}`;
  if (s.action === "fix_in_gpexe_or_undo") return `Fix this athlete's data in GPEXE (one track, valid statistics), then check for new sessions. ${undo}`;
  if (s.action === "undo_earlier_import") return "GPEXE no longer lists some results that were imported earlier. Ask a platform admin to undo the earlier import.";
  return "Ask a platform admin what to do (see Technical details).";
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
  // "n" is a count: no unit after it.
  return unit && unit !== "n" ? `${text} ${unit}` : text;
}

// GPEXE's own names of the metrics shown, for Technical details.
function metricNamesTech(values) {
  const seen = new Map();
  for (const v of values || []) if (v?.metricKey && !seen.has(v.metricKey)) seen.set(v.metricKey, `${metricName(v)} = ${v.label || v.metricKey} (${v.metricKey})`);
  return seen.size ? [["GPEXE metric names", [...seen.values()].join("; ")]] : [];
}

function resultLabel(result) {
  return result.level === "drill" ? `Drill ${Number(result.drillIndex) + 1}` : "Whole session";
}

// The session's name without a raw timestamp at its end; the date and time
// are shown next to it anyway.
function sessionTitle(c) {
  const label = c.label || `GPEXE session ${c.gpexeTeamSessionId}`;
  return label.replace(/\s+\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/, "");
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
      ${status ? renderNextStepHtml(gx, status) : ""}
      ${status ? renderStatusHtml(status) : ""}
      ${status ? renderCheckHtml(gx, status) : ""}
      ${gx.notice && !gx.detail ? `<p class="gpexe-notice" role="status">${escapeHtml(gx.notice)}</p>` : ""}
      ${!gx.detail ? renderLastLinkHtml(gx) : ""}
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
      ${status.settings ? "" : `<p class="gpexe-warning">No GPEXE team is connected to this team yet. A platform admin connects it in Settings &gt; Teams.</p>`}
      <p class="muted">${viewer.canApprove
        ? `You can approve imports for this team (${viewer.approvalBasis === "platform_admin" ? "platform admin" : "approver grant"}).`
        : "You can review sessions. Approving needs a platform admin or an explicit approver grant for this team."}</p>
      ${status.settings ? techHtml([["GPEXE team id", status.settings.gpexeTeamId]]) : ""}
    </div>
  `;
}

// Which group a session belongs in, from what the coach actually has to do:
//   decision - it can be reviewed and approved;
//   notyet   - it can't be imported until a step is taken (the step is the
//              same one the detail shows);
//   excluded - it stays out of OptiMove for good (e.g. a match): no action;
//   uptodate / imported / replaced.
// A blocked session's reason is not in the list answer; it comes from the
// session's own detail (gx.blockedReasons, loaded by the data module).
export function candidateGroup(c, gx = state.trainingLoad.gpexe) {
  if (c.status === "imported") return "imported";
  if (c.status === "superseded") return "replaced";
  if (!c.snapshot?.available) return "notyet";
  if (c.status === "blocked") {
    const reason = blockedReasonFor(c, gx);
    return reason && blockedCoachText(reason).excluded ? "excluded" : "notyet";
  }
  if (c.previewStatus === "no_changes" || c.preview?.status === "no_changes") return "uptodate";
  return "decision";
}

// The review carries its own reason; the list uses the one loaded for it.
function blockedReasonFor(c, gx) {
  if (c.preview?.blocked?.code) return { code: c.preview.blocked.code, categoryName: c.preview.session?.categoryName || null };
  return gx?.blockedReasons?.[blockedReasonKey(c)] || null;
}

// An approval whose result is not confirmed yet stays marked until a check
// (or a later answer) confirms it - also after the review is closed.
function isUncertain(c, gx) {
  return Boolean(gx?.uncertain?.[c.id]) && c.status !== "imported";
}

function badgeHtml(c, gx = state.trainingLoad.gpexe) {
  if (isUncertain(c, gx)) return `<span class="gpexe-badge is-unknown">Result not confirmed</span>`;
  const [cls, text] = GROUP_BADGE[candidateGroup(c, gx)] || [c.status, c.status];
  return `<span class="gpexe-badge is-${escapeAttr(cls)}">${escapeHtml(text)}</span>`;
}

export function blockedReasonKey(c) {
  return `${c.id}|${c.lastSeenAt || ""}`;
}

// The one next step for a session, from what the list already says.
function nextStepText(c, status, gx = state.trainingLoad.gpexe) {
  const viewer = status?.viewer || {};
  if (c.status === "imported") return "";
  if (isUncertain(c, gx)) return "Import result not confirmed yet - open it to check the result.";
  if (c.status === "superseded") return "Replaced by newer GPEXE data. Nothing to do.";
  if (!c.snapshot?.available) return "Next: check for new sessions again (the GPEXE data is too old).";
  if (c.status === "blocked") {
    const reason = blockedReasonFor(c, gx);
    if (!reason) return reason === null && gx?.blockedReasonErrors?.[blockedReasonKey(c)] ? "Next: open it to see why it can't be imported yet." : "Loading why it can't be imported yet...";
    const text = blockedCoachText(reason);
    return text.excluded ? text.step : `Next: ${text.step.charAt(0).toLowerCase()}${text.step.slice(1)}`;
  }
  if (c.previewStatus === "no_changes") return "Nothing new to import - no action needed.";
  if (reviewMadeBeforeLinkChange(c, gx)) return `Next: check for new sessions${c.sessionStartedAt ? ` (with dates that include ${formatDate(c.sessionStartedAt)})` : ""} - athlete links changed after this review was made.`;
  if (!status?.importSwitch?.enabled) return "Next: review it. Importing is switched off in this environment.";
  if (!viewer.canApprove) return "Next: review it. An approver must approve the import.";
  if (c.changesToImported) return `Next: review ${plural(c.changesToImported, "change", "changes")} to results already imported, then approve.`;
  return "Next: review it and approve the import.";
}

function renderNextStepHtml(gx, status) {
  const check = gx.check || status.lastCheck;
  const list = gx.candidates || [];
  const uncertain = list.filter((c) => isUncertain(c, gx)).length;
  const decisions = list.filter((c) => candidateGroup(c, gx) === "decision").length;
  const notYet = list.filter((c) => candidateGroup(c, gx) === "notyet").length;
  let text;
  if (!status.settings) text = "A platform admin needs to connect this team to its GPEXE team (Settings > Teams).";
  else if (gx.checkStarting || check?.status === "running") text = "Checking GPEXE for new sessions...";
  else if (uncertain) text = `Next step: check the result of ${plural(uncertain, "import", "imports")} that could not be confirmed - open it below.`;
  else if (list.some((c) => candidateGroup(c, gx) === "decision" && reviewMadeBeforeLinkChange(c, gx))) text = "Next step: check for new sessions - athlete links changed after a review was made.";
  else if (decisions) text = `Next step: ${plural(decisions, "session needs", "sessions need")} a decision - open one below.`;
  else if (notYet) text = `Next step: ${plural(notYet, "session", "sessions")} can't be imported yet - see what to do below.`;
  else text = "Next step: check for new sessions.";
  return `<p class="gpexe-next" role="status">${escapeHtml(text)}</p>`;
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
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-check" ${canCheck ? "" : "disabled"}>${running ? "Checking..." : "Check for new sessions"}</button>
      </div>
      <p class="muted gpexe-hint">Without dates, the last 14 days are checked (at most 31). Checking only shows what GPEXE has; nothing is imported until you approve.</p>
      ${gx.checkError ? `<div class="gpexe-error" role="alert"><p>${escapeHtml(checkErrorText(gx.checkError))}</p>${errorTech(gx.checkError)}</div>` : ""}
      ${check ? renderCheckSummaryHtml(check) : ""}
    </section>
  `;
}

// Why a check could not start, and the one thing to do.
function checkErrorText(error) {
  if (error.code === "check_already_running") return "A check is already running for this team. Wait for it to finish.";
  if (error.code === "invalid_window") return "Check the dates: From must not be after To, To must not be in the future, and at most 31 days can be checked at once.";
  if (error.code === "gpexe_token_missing") return "OptiMove has no access to GPEXE set up yet. Ask a platform admin to set it up.";
  if (error.code === "gpexe_team_not_configured") return "This team is not connected to a GPEXE team yet. Ask a platform admin to connect it in Settings > Teams.";
  return "The check could not start. Try again in a moment.";
}

function renderCheckSummaryHtml(check) {
  const counts = `${plural(check.sessionsSeen, "session", "sessions")} in GPEXE: ${check.candidatesNew} new, ${check.candidatesChanged} changed, ${check.candidatesUnchanged} unchanged`;
  if (check.status === "running") return `<p class="gpexe-check-state" role="status">Checking GPEXE ${escapeHtml(formatDate(check.window?.from))} - ${escapeHtml(formatDate(check.window?.to))}... ${escapeHtml(counts)} so far.</p>`;
  if (check.status === "failed") {
    return `<div class="gpexe-error" role="alert"><p>The last check (${escapeHtml(fmtDateTime(check.startedAt))}) did not finish. Try again in a moment.</p>${techHtml([["Code", check.error?.code], ["Server message", check.error?.message]])}</div>`;
  }
  return `<p class="gpexe-check-state">Last check ${escapeHtml(fmtDateTime(check.finishedAt || check.startedAt))} (${escapeHtml(formatDate(check.window?.from))} - ${escapeHtml(formatDate(check.window?.to))}): ${escapeHtml(counts)}.</p>`;
}

function renderCandidatesHtml(gx) {
  const list = gx.candidates || [];
  const status = gx.status;
  const group = (name) => list.filter((c) => candidateGroup(c, gx) === name);
  const decision = group("decision");
  const notYet = group("notyet");
  const excluded = group("excluded");
  const imported = group("imported");
  const uptodate = group("uptodate");
  const replaced = group("replaced");
  const rows = (items) => `<ul class="gpexe-candidate-list">${items.map((c) => renderCandidateRowHtml(c, status)).join("")}</ul>`;
  return `
    <section class="gpexe-panel gpexe-group is-decision" aria-label="Needs a decision">
      <div class="gpexe-panel-head"><h3>Needs a decision (${decision.length})</h3></div>
      ${decision.length ? rows(decision) : `<p class="muted">Nothing needs a decision.${list.length ? "" : " Check for new sessions."}</p>`}
    </section>
    ${notYet.length ? `
      <section class="gpexe-panel gpexe-group is-notyet" aria-label="Can't be imported yet">
        <div class="gpexe-panel-head"><h3>Can't be imported yet (${notYet.length})</h3></div>
        ${rows(notYet)}
      </section>
    ` : ""}
    <section class="gpexe-panel gpexe-group is-imported" aria-label="Imported">
      <div class="gpexe-panel-head"><h3>Imported (${imported.length})</h3></div>
      ${imported.length ? rows(imported) : `<p class="muted">Nothing imported yet.</p>`}
    </section>
    ${uptodate.length ? `
      <details class="gpexe-panel gpexe-group">
        <summary>Up to date - nothing new (${uptodate.length})</summary>
        ${rows(uptodate)}
      </details>
    ` : ""}
    ${excluded.length ? `
      <details class="gpexe-panel gpexe-group">
        <summary>Stays out of OptiMove (${excluded.length})</summary>
        ${rows(excluded)}
      </details>
    ` : ""}
    <div class="gpexe-replaced-toggle">
      <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-superseded" aria-pressed="${gx.includeSuperseded ? "true" : "false"}">${gx.includeSuperseded ? "Hide replaced versions" : "Show replaced versions"}</button>
    </div>
    ${gx.includeSuperseded && replaced.length ? `
      <section class="gpexe-panel gpexe-group" aria-label="Replaced versions">
        <div class="gpexe-panel-head"><h3>Replaced versions (${replaced.length})</h3></div>
        ${rows(replaced)}
      </section>
    ` : ""}
  `;
}

function renderCandidateRowHtml(c, status) {
  const counts = c.counts || {};
  const facts = [];
  const group = candidateGroup(c);
  const upToDate = group === "uptodate";
  const excluded = group === "excluded";
  if (!upToDate && !excluded && (c.status === "pending" || c.status === "blocked")) {
    if (counts.created) facts.push(plural(counts.created, "new result", "new results"));
    if (c.changesToImported) facts.push(`${plural(c.changesToImported, "change", "changes")} to imported results`);
    if (counts.athletesNotImported) facts.push(`${plural(counts.athletesNotImported, "athlete", "athletes")} left out`);
  }
  const next = nextStepText(c, status);
  return `
    <li>
      <button type="button" class="gpexe-candidate" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(c.id)}">
        <span class="gpexe-candidate-main">
          <strong>${escapeHtml(sessionTitle(c))}</strong>
          <span class="muted">${escapeHtml(fmtDateTime(c.sessionStartedAt))}</span>
        </span>
        ${badgeHtml(c)}
        ${facts.length ? `<span class="gpexe-candidate-facts">${escapeHtml(facts.join(" · "))}</span>` : ""}
        ${next ? `<span class="gpexe-candidate-next">${escapeHtml(next)}</span>` : ""}
      </button>
    </li>
  `;
}

function renderLinksHtml(gx) {
  const links = gx.links || [];
  return `
    <section class="gpexe-panel" aria-label="Athlete links">
      <div class="gpexe-panel-head"><h3>GPEXE athletes linked to this team</h3></div>
      <p class="muted gpexe-hint">A link is never guessed. Link a GPEXE athlete from a session's review, after finding them in GPEXE. A wrong link can be removed here before an import is approved; results already imported stay where they are.</p>
      ${gx.linkError && !gx.detail ? `<p class="gpexe-error" role="alert">${escapeHtml(errorText(gx.linkError, "The link could not be changed."))}</p>` : ""}
      ${!links.length ? `<p class="muted">No athlete is linked yet.</p>` : `
        <ul class="gpexe-link-list">
          ${links.map((l) => `
            <li>
              <span><strong>${escapeHtml(l.athleteName)}</strong> <span class="muted">GPEXE athlete ${escapeHtml(l.gpexeAthleteId)}</span></span>
              <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-unlink" data-link-id="${escapeAttr(l.id)}" ${gx.linkBusy ? "disabled" : ""}>Unlink</button>
            </li>
          `).join("")}
        </ul>
      `}
    </section>
  `;
}

// The link just made, with the way back: a wrong link is removed with the
// existing Unlink before any import is approved.
function renderLastLinkHtml(gx) {
  const l = gx.lastLink;
  if (!l) return "";
  const dates = l.sessionDate ? ` (with dates that include ${formatDate(l.sessionDate)})` : "";
  return `
    <div class="gpexe-notice gpexe-last-link" role="status">
      <p><strong>GPEXE athlete ${escapeHtml(l.gpexeAthleteId)} is now linked to ${escapeHtml(l.athleteName)}.</strong> Check for new sessions${escapeHtml(dates)} to update the review - approving waits until then.</p>
      <p>Wrong athlete? Unlink it before an import is approved.
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-unlink" data-link-id="${escapeAttr(l.linkId)}" ${gx.linkBusy ? "disabled" : ""}>Unlink ${escapeHtml(l.athleteName)}</button>
      </p>
    </div>
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
  const title = c ? sessionTitle(c) : "GPEXE session";
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
          ${renderLastLinkHtml(gx)}
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
      ${badgeHtml(c)}
      <span class="muted">${escapeHtml(fmtDateTime(c.sessionStartedAt))}</span>
      ${c.snapshot?.available ? `<span class="muted">GPEXE data kept until ${escapeHtml(formatDate(c.snapshot.expiresAt))}</span>` : ""}
    </p>
    ${renderApprovalRecordHtml(c)}
    ${!preview ? `<p class="muted">${c.snapshot?.available === false ? "The GPEXE data is too old. Check for new sessions to see it again." : "No preview."}</p>` : `
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
  const counts = countsText(a.import?.counts);
  return `<p class="gpexe-success">Imported ${escapeHtml(fmtDateTime(a.approvedAt))} (${a.basis === "platform_admin" ? "platform admin" : "approver grant"})${counts ? `: ${escapeHtml(counts)}` : ""}.</p>`;
}

// Why a session is blocked, in the coach's words, with the one step to take.
// The server's own message (which can carry GPEXE ids and field names) is
// only in Technical details.
const DATA_PROBLEM = new Set([
  "session_missing", "invalid_timestamp", "timestamp_semantics_changed", "invalid_timezone", "mixed_timezones",
  "invalid_drills_count", "drill_index_out_of_range", "duplicate_drill_row", "track_missing", "track_athlete_mismatch", "more_missing",
]);
const THRESHOLDS = new Set(["thresholds_missing", "thresholds_wrong_team", "thresholds_not_valid_for_session", "thresholds_payload_incomplete"]);

// `reason` is { code, categoryName }. `excluded` marks a session that stays
// out of OptiMove for good - nothing to fix, no decision.
function blockedCoachText(reason) {
  const code = reason.code;
  if (code === "identities_missing_from_source") {
    return { reason: "Some athletes' results from this session were imported before, but would now be left out.", step: "Do the step below for each athlete, then check for new sessions." };
  }
  if (code === "unsupported_category") {
    const category = reason.categoryName;
    return { excluded: true, reason: `${category ? `"${category}" sessions are` : "This type of session is"} not imported from GPEXE.`, step: "No action needed - it stays out of OptiMove." };
  }
  if (THRESHOLDS.has(code)) {
    return { reason: "The team's GPEXE thresholds (speed and power zones) are missing or don't cover this session's date.", step: "Check the team thresholds in GPEXE, then check for new sessions." };
  }
  if (code === "session_stats_invalid") {
    return { reason: "GPEXE marks this session's statistics as not valid.", step: "Fix the session in GPEXE, then check for new sessions." };
  }
  if (code === "no_importable_participants") {
    return { reason: "No athlete in this session can be imported.", step: "Link the athletes to OptiMove athletes or fix their data in GPEXE, then check for new sessions." };
  }
  if (DATA_PROBLEM.has(code)) {
    return { reason: "GPEXE sent incomplete or inconsistent data for this session.", step: "Check for new sessions again later. If it stays like this, ask a platform admin (give them the Technical details)." };
  }
  return { reason: "This session conflicts with data already in OptiMove and can't be imported automatically.", step: "Ask a platform admin to look at it (give them the Technical details)." };
}

function renderBlockedHtml(preview, c) {
  if (!preview.blocked) return "";
  const steps = preview.blocked.resolution || [];
  const text = blockedCoachText({ code: preview.blocked.code, categoryName: preview.session?.categoryName });
  return `
    <div class="gpexe-blocked" role="note">
      <p><strong>${text.excluded ? "Not imported." : "Can't be imported yet."}</strong> ${escapeHtml(text.reason)}</p>
      <p><strong>What to do:</strong> ${escapeHtml(text.step)}</p>
      ${steps.length ? `<ol>${steps.map((s) => `<li>${escapeHtml(coachStep(s, c))}</li>`).join("")}</ol>` : ""}
      ${techHtml([["Code", preview.blocked.code], ["Server message", preview.blocked.message], ...steps.map((s, i) => [`Step ${i + 1} (server)`, `${s.action}: ${s.step}`])])}
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
      ${techHtml(metricNamesTech(changes.flatMap((ch) => ch.values || [])))}
    </section>
  `;
}

function renderValueTableHtml(values, withPrevious) {
  if (!values?.length) return "";
  return `
    <div class="gpexe-values-wrap"><table class="gpexe-values">
      <thead><tr><th scope="col">Metric</th>${withPrevious ? `<th scope="col">Before</th>` : ""}<th scope="col">GPEXE</th></tr></thead>
      <tbody>
        ${[...values].sort(byMetricOrder).map((v) => `<tr><td>${escapeHtml(metricName(v))}</td>${withPrevious ? `<td>${escapeHtml(fmtValue(v.previous, v.unit))}</td>` : ""}<td>${escapeHtml(fmtValue(v.value, v.unit))}</td></tr>`).join("")}
      </tbody>
    </table></div>
  `;
}

function renderAthletesHtml(preview, c) {
  const athletes = preview.athletes || [];
  if (!athletes.length) return "";
  // Only team athletes without a GPEXE record here AND without a link yet can
  // be chosen: an athlete who is already linked would be refused anyway.
  const linked = new Set((state.trainingLoad.gpexe.links || []).map((l) => String(l.athleteId)));
  const unlinkedChoices = (preview.teamAthletesWithoutGpexeRecord || [])
    .filter((a) => !linked.has(String(a.athleteId)))
    .map((a) => ({ id: a.athleteId, name: athleteName(c, a.athleteId, null) }));
  // Two team athletes with the same name can't be told apart here.
  const allNames = Object.values(c.athletes || {}).map((a) => (a?.name || "").trim().toLowerCase());
  for (const o of unlinkedChoices) o.duplicate = allNames.filter((n) => n === o.name.trim().toLowerCase()).length > 1;
  return `
    <section class="gpexe-athletes" aria-label="Athletes in this session">
      <h4>Athletes in GPEXE (${athletes.length})</h4>
      ${athletes.map((a) => renderAthleteHtml(a, c, unlinkedChoices)).join("")}
    </section>
  `;
}

// What GPEXE recorded for an unlinked athlete in this session: only a help
// to find the athlete in GPEXE. Values never prove who an athlete is.
const LINK_CONTEXT_KEYS = ["gpexe_total_distance", "gpexe_max_speed", "gpexe_time_min"];

function renderLinkContextHtml(a) {
  const whole = (a.results || []).find((r) => r.level !== "drill");
  const values = LINK_CONTEXT_KEYS.map((key) => whole?.values?.find((v) => v.metricKey === key)).filter((v) => v && v.value !== null && v.value !== undefined);
  const drills = new Set((a.results || []).filter((r) => r.level === "drill").map((r) => r.drillIndex)).size;
  if (!values.length && !drills) return `<p class="muted">GPEXE sent no values for this athlete that could help you find them.</p>`;
  return `
    <p class="muted">Recorded by GPEXE for athlete ${escapeHtml(a.gpexeAthleteId)} in this session - to help you find them in GPEXE. The values do not prove who it is.</p>
    <ul class="gpexe-link-context">
      ${values.map((v) => `<li><span>${escapeHtml(metricName(v))}</span> <strong>${escapeHtml(fmtValue(v.value, v.unit))}</strong></li>`).join("")}
      ${drills ? `<li><span>Drills</span> <strong>${drills}</strong></li>` : ""}
    </ul>
  `;
}

// Linking is two steps: choose the athlete (nothing is sent), then confirm
// with both sides of the link shown together. No athlete is preselected.
function renderLinkHtml(a, c, unlinkedChoices) {
  const gx = state.trainingLoad.gpexe;
  const id = a.gpexeAthleteId;
  const pending = gx.linkConfirm && gx.linkConfirm.gpexeAthleteId === id ? gx.linkConfirm : null;
  if (pending) {
    return `
      <div class="gpexe-link-confirm" role="group" aria-label="Confirm the link">
        <p class="gpexe-link-pair"><strong>GPEXE athlete ${escapeHtml(id)}</strong> → <strong>${escapeHtml(pending.athleteName)}</strong></p>
        <p>Link GPEXE athlete ${escapeHtml(id)} to ${escapeHtml(pending.athleteName)}? Future GPEXE sessions for athlete ${escapeHtml(id)} will be imported as ${escapeHtml(pending.athleteName)}.</p>
        <p class="muted">If it turns out wrong, unlink it before an import is approved. Results already imported stay where they are.</p>
        <div class="gpexe-link-actions">
          <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-link-cancel" ${gx.linkBusy ? "disabled" : ""}>Cancel</button>
          <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-link-confirm" ${gx.linkBusy ? "disabled" : ""}>${gx.linkBusy ? "Linking..." : "Confirm link"}</button>
        </div>
      </div>
    `;
  }
  if (!unlinkedChoices.length) {
    return `<p class="muted">Every athlete of the team without a GPEXE record here is already linked. If athlete ${escapeHtml(id)} is one of them, check the links below.</p>`;
  }
  return `
    <div class="gpexe-link">
      <p><strong>Find athlete ${escapeHtml(id)} in GPEXE first. Link only if you are sure.</strong></p>
      ${renderLinkContextHtml(a)}
      <div class="gpexe-link-row">
        <label><span>Link GPEXE athlete ${escapeHtml(id)} to</span>
          <select class="gpexe-select" data-gpexe-link-select="${escapeAttr(id)}">
            <option value="" selected>Choose an athlete of the team</option>
            ${unlinkedChoices.map((o) => `<option value="${escapeAttr(o.id)}">${escapeHtml(o.name)}${o.duplicate ? " (same name as another athlete)" : ""}</option>`).join("")}
          </select>
        </label>
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-link" data-gpexe-athlete-id="${escapeAttr(id)}" ${gx.linkBusy ? "disabled" : ""}>Link...</button>
      </div>
    </div>
  `;
}

function renderSkippedHtml(a) {
  const skipped = a.skippedValues || [];
  if (!skipped.length) return "";
  return `
    <div class="gpexe-skipped">
      <p class="muted">Left out (${skipped.length}) - a left-out value is not a zero:</p>
      <ul>
        ${skipped.map((s) => `<li>${escapeHtml(resultLabel(s))} · ${escapeHtml(metricName(s))} - ${escapeHtml(SKIP_TEXT[s.reason] || "other reason (see Technical details)")}</li>`).join("")}
      </ul>
    </div>
  `;
}

function renderAthleteHtml(a, c, unlinkedChoices) {
  const gx = state.trainingLoad.gpexe;
  const name = athleteName(c, a.athleteId, a.gpexeAthleteId);
  const gps = GPS_TEXT[a.gps?.status] || a.gps?.status || "";
  const outcomes = {};
  for (const r of a.results || []) outcomes[r.outcome] = (outcomes[r.outcome] || 0) + 1;
  const outcomeText = countsText(outcomes);
  const unlinked = a.notImported?.code === "athlete_not_linked";
  const shownResults = (a.results || []).filter((r) => r.outcome !== "not_imported" && r.outcome !== "unchanged");
  // Kept open while the coach is linking this athlete (a re-render would
  // otherwise close it under them).
  const open = unlinked && gx.linkOpen === a.gpexeAthleteId;
  const tech = [
    ...metricNamesTech([...shownResults.flatMap((r) => r.values || []), ...(a.skippedValues || [])]),
    ...((a.skippedValues || []).length ? [["Left-out codes", [...new Set(a.skippedValues.map((s) => s.reason))].join(", ")]] : []),
  ];
  return `
    <details class="gpexe-athlete ${a.blocksSession ? "is-blocking" : ""}" ${open ? "open" : ""}>
      <summary>
        <span><strong>${escapeHtml(name)}</strong>${a.blocksSession ? ` <span class="gpexe-badge is-blocked">Blocks the session</span>` : ""}</span>
        <span class="muted">Participation: recorded by GPEXE · GPS: ${escapeHtml(gps)}${a.notImported ? ` · Not imported: ${escapeHtml(a.notImported.message)}` : outcomeText ? ` · ${escapeHtml(outcomeText)}` : ""}</span>
      </summary>
      ${a.gps?.reason ? `<p class="muted">${escapeHtml(a.gps.reason.message)}</p>` : ""}
      ${unlinked ? renderLinkHtml(a, c, unlinkedChoices) : ""}
      ${shownResults.map((r) => `
        <div class="gpexe-result">
          <p>${escapeHtml(resultLabel(r))} · ${escapeHtml(OUTCOME_TEXT[r.outcome] || r.outcome)}</p>
          ${renderValueTableHtml(r.values.filter((v) => v.change !== "same" || r.outcome === "created"), r.outcome !== "created")}
        </div>
      `).join("")}
      ${renderSkippedHtml(a)}
      ${techHtml(tech)}
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
    const counts = countsText(r.import?.counts);
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
    if (verified === "imported") {
      return `<div class="gpexe-success" role="status"><p><strong>Imported.</strong> Checked: the import is in OptiMove.</p>${errorTech(o.error)}</div>`;
    }
    return `
      <div class="gpexe-unknown" role="alert">
        <p><strong>We can't tell yet whether this session was imported.</strong> Don't enter the data by hand and don't assume either way - check the result first.</p>
        ${verified === "not_visible_yet" ? `<p>The import is not visible yet; we are still checking the result. Check again in a moment. Approving again is safe: the server never imports the same session twice.</p>` : ""}
        ${verified === "still_unknown" ? `<p>Still not clear. Check again in a moment.</p>` : ""}
        ${(o.checks || 0) >= GIVE_UP_AFTER_CHECKS ? `<p><strong>Still not confirmed after ${o.checks} checks.</strong> Ask a platform admin to check this import (give them the Technical details). Until then, don't enter the data by hand.</p>` : ""}
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-verify" ${detail.verifying ? "disabled" : ""}>${detail.verifying ? "Checking..." : verified ? "Check again" : "Check the result"}</button>
        ${techHtml([["HTTP status", o.error?.status || "no answer"], ["Code", o.error?.code], ["Server message", o.error?.message], ["Approval id", o.verify?.approvalId], ["Check error", o.verifyError ? `${o.verifyError.status || "no answer"} ${o.verifyError.code || ""}`.trim() : undefined]])}
      </div>
    `;
  }
  const code = o.error?.code;
  // Another approval (or an earlier, unconfirmed one) got there first: the
  // session is in OptiMove - a final, successful outcome.
  if (code === "already_imported") {
    return `<div class="gpexe-success" role="status"><p><strong>Already imported.</strong> Nothing more was written.</p>${errorTech(o.error)}</div>`;
  }
  const reviewAgain = o.error?.data?.reviewAgain;
  return `
    <div class="gpexe-refused" role="alert">
      <p>${escapeHtml(REFUSAL_TEXT[code] || (o.error?.status === 404 ? "Not imported: this session is not available." : "Not imported: the server refused the approval."))}</p>
      ${reviewAgain?.candidateId ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(reviewAgain.candidateId)}">Review again</button>` : ""}
      ${errorTech(o.error)}
    </div>
  `;
}

function renderApproveHtml(c, detail, status) {
  if (c.status === "imported" || detail.outcome?.kind === "imported" || detail.outcome?.verified === "imported") return "";
  if (detail.outcome?.error?.code === "already_imported") return "";
  if (detail.outcome?.kind === "unknown" && detail.outcome.verified !== "not_visible_yet") return "";
  const gx = state.trainingLoad.gpexe;
  const group = candidateGroup(c, gx);
  // A blocked or expired session already says what to do above.
  if (group === "excluded" || group === "notyet") return "";
  if (group === "replaced") return `<p class="muted gpexe-approve-note">${escapeHtml(BLOCKER_TEXT.superseded_by_newer_data)}</p>`;
  if (group === "uptodate") return `<p class="muted gpexe-approve-note">${escapeHtml(BLOCKER_TEXT.nothing_to_import)}</p>`;
  // This review was made with the athlete links as they were at the last
  // check; after a link change it must be made again before approving.
  if (reviewMadeBeforeLinkChange(c, gx)) {
    const day = c.sessionStartedAt ? formatDate(c.sessionStartedAt) : "";
    return `<p class="gpexe-warning gpexe-approve-note" role="note"><strong>Athlete links changed after this review was made.</strong> Close it and check for new sessions${day ? ` (with dates that include ${escapeHtml(day)})` : ""}; approving waits until then.</p>`;
  }
  const viewer = status?.viewer || {};
  const blockers = (c.approvalBlockers || []).filter((b) => b !== "blocked");
  if (!viewer.canApprove) return `<p class="muted gpexe-approve-note">Approving needs a platform admin or an explicit approver grant for this team.</p>`;
  if (blockers.length) return `<p class="muted gpexe-approve-note">${escapeHtml(blockers.map((b) => BLOCKER_TEXT[b] || "It can't be approved right now.").join(" "))}</p>`;
  const changes = c.changesToImported || 0;
  return `
    <div class="gpexe-approve">
      ${changes ? `
        <label class="gpexe-accept">
          <input type="checkbox" data-gpexe-accept data-action="training-load-gpexe-accept" ${detail.acceptChanges ? "checked" : ""}>
          <span>I accept the ${escapeHtml(plural(changes, "change", "changes"))} to results that were already imported.</span>
        </label>
      ` : ""}
      <p class="muted">Approving imports this whole session exactly as shown. Athletes left out stay out.</p>
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-approve" ${detail.approving ? "disabled" : ""}>${detail.approving ? "Importing..." : "Approve import"}</button>
    </div>
  `;
}
