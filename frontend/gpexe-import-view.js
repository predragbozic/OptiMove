// Imports (Training Load -> Data & Analysis), phase 2 shell: a source-neutral
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
import { gpexeTeamOptions, reviewMadeBeforeLinkChange, stagedTeamMapping, teamAthleteChoices, teamHasActiveAthletes } from "./gpexe-import-data.js";

// Why a session can't be approved right now, in the coach's words (blocked
// and expired sessions explain themselves above the approve area).
const BLOCKER_TEXT = {
  import_switch_off: "Importing is switched off in this environment, so it can't be approved here.",
  superseded_by_newer_data: "GPEXE has newer data for this session. Open the newer version.",
  already_imported: "Already imported.",
  snapshot_expired_check_again: "The GPEXE data is too old. Find new sessions, then review it again.",
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
  snapshot_expired_check_again: "Not imported: the GPEXE data is too old. Find new sessions, then review it again.",
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
  if (s.action === "relink_athlete") return `Link GPEXE athlete ${s.gpexeAthleteId} again to ${name} (the athlete their earlier results belong to), then find new sessions.`;
  if (s.action === "restore_team_membership") return `Make ${name} an active member of the team again, then find new sessions. ${undo}`;
  if (s.action === "fix_in_gpexe_or_undo") return `Fix this athlete's data in GPEXE (one track, valid statistics), then find new sessions. ${undo}`;
  if (s.action === "undo_earlier_import") return "GPEXE no longer lists some results that were imported earlier. Ask a platform admin to undo the earlier import.";
  return "Ask a platform admin what to do (see Technical details).";
}

// `extra` is markup that belongs to support, not to the coach's flow (the
// replaced-versions switch): it lives inside the same folded block.
function techHtml(entries, extra = "") {
  const rows = entries.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!rows.length && !extra) return "";
  return `<details class="gpexe-tech"><summary>Technical details</summary><dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>${extra}</details>`;
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

// A data source as this screen knows it. GPEXE is the first; a later source
// (Garmin, Catapult, Polar, Kinexon, ...) is another card on the same screen
// with its own routes and state - never another top-level screen.
export const IMPORT_SOURCES = [{ key: "gpexe", name: "GPEXE" }];

export function renderGpexeImportsHtml() {
  const gx = state.trainingLoad.gpexe;
  const teams = gpexeTeamOptions();
  if (!state.trainingLoad.orgPickerData && gx.loading) return `<div class="gpexe-imports"><p class="muted">Loading...</p></div>`;
  if (!teams.length && !gx.loading) {
    // One message, and the workspace menu that already exists - never a
    // second team picker. The button is offered only under the same
    // condition the header menu opens at all (more than one workspace,
    // renderWorkspaceSwitcher) AND when one of the others is a team or club;
    // otherwise it would do nothing. A club or team workspace with no team
    // in it is a different case: nothing to switch to, a team is missing.
    const active = state.currentUser?.activeWorkspace || null;
    const available = state.currentUser?.availableWorkspaces || [];
    const elsewhere = available.filter((w) => (w.type === "team" || w.type === "club") && !(active && w.type === active.type && String(w.scopeId ?? "") === String(active.scopeId ?? "")));
    const canSwitch = available.length > 1 && elsewhere.length > 0;
    let text;
    if (active?.type === "club") text = "This club has no team yet. Add one in Settings > Teams, then come back here.";
    else if (active?.type === "team") text = "This team is not available right now. Reload the page or switch workspace from the workspace menu.";
    else if (canSwitch) text = "Imports work in a team or club workspace. Switch to one from the workspace menu.";
    else text = "Imports work in a team or club workspace. This account has no team or club workspace yet - ask your club or platform admin to add you to a team.";
    return `
      <div class="gpexe-imports">
        <section class="gpexe-panel imports-empty" aria-label="Imports">
          <p>${escapeHtml(text)}</p>
          ${canSwitch && !(active && (active.type === "club" || active.type === "team")) ? `<button type="button" class="plain-button gpexe-button" data-action="workspace-toggle">Choose a workspace</button>` : ""}
        </section>
      </div>
    `;
  }
  const status = gx.status;
  return `
    <div class="gpexe-imports">
      ${renderTeamRowHtml(teams, gx.teamId)}
      ${gx.error ? `<p class="gpexe-error" role="alert">${escapeHtml(errorText(gx.error, "Could not load the imports."))}</p>` : ""}
      ${gx.loading && !status ? `<p class="muted">Loading...</p>` : ""}
      ${status ? renderSourceCardHtml(IMPORT_SOURCES[0], gx, status) : ""}
      ${status ? renderNextStepHtml(gx, status, IMPORT_SOURCES[0]) : ""}
      ${gx.notice && !gx.detail ? `<p class="gpexe-notice" role="status">${escapeHtml(gx.notice)}</p>` : ""}
      ${!gx.detail ? renderLastLinkHtml(gx) : ""}
      ${status ? renderBucketsHtml(gx, status) : ""}
      ${status ? renderLinksHtml(gx) : ""}
      ${gx.detail ? renderCandidateDetailHtml(gx, status) : ""}
      ${!gx.detail && gx.mapping?.open ? renderTeamMappingHtml(gx, teams) : ""}
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

// The source card: what the team reads from, when sessions were last found,
// and the one button that finds them. Dates are there for the coach who
// needs them, folded away for everyone else. Every id and code of the
// source stays under Technical details.
function renderSourceCardHtml(source, gx, status) {
  const sw = status.importSwitch || {};
  const viewer = status.viewer || {};
  const connected = Boolean(status.settings);
  const check = gx.check || status.lastCheck;
  const running = Boolean(gx.checkStarting || check?.status === "running");
  const canFind = connected && !running;
  const list = gx.candidates || [];
  // A step that needs other dates (a stale review, an expired snapshot)
  // opens the dates and fills them in, so "find again" is one click.
  const dated = datesNeededFor(list, gx);
  return `
    <section class="gpexe-panel imports-source" aria-label="Data source ${escapeAttr(source.name)}">
      <div class="imports-source-head">
        <h3>${escapeHtml(source.name)}</h3>
        <span class="imports-state ${connected ? "is-on" : "is-off"}">${connected ? "Connected" : "Not connected"}</span>
      </div>
      ${connected ? renderFoundHtml(check, list.length, source.name) : `<p class="gpexe-warning">This team is not connected to a data source yet. A platform admin connects it in Settings &gt; Data sources.</p>`}
      ${connected ? `
        <div class="gpexe-check-row imports-find-row">
          <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-check" ${canFind ? "" : "disabled"}>${running ? "Finding..." : "Find new sessions"}</button>
          <details class="imports-dates" ${dated ? "open" : ""}>
            <summary>Choose dates</summary>
            <div class="imports-dates-fields">
              <label class="gpexe-date"><span>From</span><input type="date" data-gpexe-field="from" value="${escapeAttr(dated?.from || "")}" ${running ? "disabled" : ""}></label>
              <label class="gpexe-date"><span>To</span><input type="date" data-gpexe-field="to" value="${escapeAttr(dated?.to || "")}" ${running ? "disabled" : ""}></label>
            </div>
          </details>
        </div>
        <p class="muted gpexe-hint">${dated ? escapeHtml(datedHintText(dated)) : "Without dates, the last 14 days are searched (at most 31). "}Nothing is imported until you import it.</p>
      ` : ""}
      ${gx.checkError ? `<div class="gpexe-error" role="alert"><p>${escapeHtml(checkErrorText(gx.checkError))}</p>${errorTech(gx.checkError)}</div>` : ""}
      ${check && check.status !== "succeeded" ? renderCheckSummaryHtml(check, source) : ""}
      ${sw.enabled ? "" : `<p class="gpexe-switch is-off"><strong>Importing is switched off in this environment.</strong></p>`}
      ${techHtml([
        ["Source", source.key],
        [`${source.name} team id`, status.settings?.gpexeTeamId],
        ["Approval basis", viewer.approvalBasis || (viewer.canApprove ? "yes" : "none")],
        ["Last check id", check?.id],
        ["Last check status", check?.status],
        ["Server message", sw.message],
      ], `<div class="gpexe-replaced-toggle"><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-superseded" aria-pressed="${gx.includeSuperseded ? "true" : "false"}">${gx.includeSuperseded ? "Hide replaced versions" : "Show replaced versions"}</button></div>`)}
    </section>
  `;
}

// "Sessions found 21.09.2026 14:02 · 07.09.2026 - 21.09.2026 · 12": when the
// source was last read, for which days, and how many sessions it listed.
// Never "sync" - nothing is pulled into OptiMove by finding.
function renderFoundHtml(check, listed = 0, sourceName = "the source") {
  if (!check || check.status !== "succeeded") {
    // A search that is running or failed does not undo what an earlier one
    // found: the sessions below are still there.
    return listed ? `<p class="muted imports-found">Sessions from the last successful search are listed below.</p>` : `<p class="muted imports-found">No sessions found yet.</p>`;
  }
  const when = fmtDateTime(check.finishedAt || check.startedAt);
  const days = check.window ? `${formatDate(check.window.from)} - ${formatDate(check.window.to)}` : "";
  const counts = `${plural(check.sessionsSeen ?? 0, "session", "sessions")} in ${sourceName}: ${check.candidatesNew ?? 0} not seen by OptiMove before, ${check.candidatesChanged ?? 0} changed, ${check.candidatesUnchanged ?? 0} unchanged`;
  return `<p class="imports-found">Sessions found ${escapeHtml(when)}${days ? ` · ${escapeHtml(days)}` : ""} · ${escapeHtml(counts)}</p>`;
}

// The sessions whose review is stale after a link change, or whose source
// data expired: finding them again needs dates that include them.
function sessionsNeedingDates(list, gx) {
  return list.filter((c) => {
    const bucket = inboxBucket(c, gx);
    if (bucket !== "ready" && bucket !== "attention") return false;
    return !c.snapshot?.available || reviewMadeBeforeLinkChange(c, gx);
  });
}

function isoDay(value) {
  // new Date(null) is 1970, not "no date".
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

// At most 31 days can be searched at once: the latest 31 are set, and the
// hint says the earlier ones need another search.
const FIND_WINDOW_MAX_DAYS = 31;

function datesNeededFor(list, gx) {
  const days = sessionsNeedingDates(list, gx).map((c) => isoDay(c.sessionStartedAt)).filter(Boolean).sort();
  if (!days.length) return null;
  const to = days[days.length - 1];
  let from = days[0];
  const span = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  let clipped = false;
  if (span > FIND_WINDOW_MAX_DAYS) {
    from = new Date(new Date(`${to}T00:00:00Z`).getTime() - (FIND_WINDOW_MAX_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    clipped = true;
  }
  return { from, to, clipped };
}

function datedHintText(dated) {
  const range = dated.from === dated.to ? formatDate(dated.from) : `${formatDate(dated.from)} - ${formatDate(dated.to)}`;
  return dated.clipped
    ? `The dates are set to the latest 31 days of the sessions that need finding again (${range}); search the earlier ones afterwards. `
    : `The dates are set to include the sessions that need finding again (${range}). `;
}

// Why finding could not start, and the one thing to do.
function checkErrorText(error) {
  if (error.code === "check_already_running") return "Sessions are already being found for this team. Wait for it to finish.";
  if (error.code === "invalid_window") return "Check the dates: From must not be after To, To must not be in the future, and at most 31 days can be searched at once.";
  if (error.code === "gpexe_token_missing") return "OptiMove has no access to GPEXE set up yet. Ask a platform admin to set it up.";
  if (error.code === "gpexe_team_not_configured") return "This team is not connected to a GPEXE team yet. Ask a platform admin to connect it in Settings > Data sources.";
  return "Finding new sessions could not start. Try again in a moment.";
}

function renderCheckSummaryHtml(check, source = IMPORT_SOURCES[0]) {
  const counts = `${plural(check.sessionsSeen, "session", "sessions")} in ${source.name}: ${check.candidatesNew} not seen by OptiMove before, ${check.candidatesChanged} changed, ${check.candidatesUnchanged} unchanged`;
  if (check.status === "running") return `<p class="gpexe-check-state" role="status">Finding sessions ${escapeHtml(formatDate(check.window?.from))} - ${escapeHtml(formatDate(check.window?.to))}... ${escapeHtml(counts)} so far.</p>`;
  // A finished search is rendered by renderFoundHtml.
  return `<div class="gpexe-error" role="alert"><p>The last search (${escapeHtml(fmtDateTime(check.startedAt))}) did not finish. Try again in a moment.</p>${techHtml([["Code", check.error?.code], ["Server message", check.error?.message]])}</div>`;
}

// ---------------------------------------------------------------------------
// The inbox: four buckets, from what the coach has to do
// ---------------------------------------------------------------------------

// Which bucket a session is in. Built on candidateGroup (which the review
// still uses) plus the two facts the list already carries: athletes left
// out and changes to imported results.
//   ready     - nothing to decide; importable as found (from its review
//               today; in a batch later);
//   attention - the coach has one step to take, named on the row;
//   out       - stays out of OptiMove for good; nothing to do;
//   imported  - in OptiMove, or nothing new for it;
//   hidden    - a replaced version (listed only with the switch under the
//               source's Technical details).
export function inboxBucket(c, gx = state.trainingLoad.gpexe) {
  const group = candidateGroup(c, gx);
  if (group === "replaced") return "hidden";
  if (group === "imported") return "imported";
  if (group === "excluded") return "out";
  if (isUncertain(c, gx)) return "attention";
  if (group === "notyet") return "attention";
  // What keeps a session out of Ready comes with the list (reasons). "Nothing
  // new" is true only when somebody was imported; a session in which no
  // athlete is linked yet writes nothing and must not read as done.
  if (group === "uptodate") return rowReasons(c).length ? "attention" : "imported";
  if (rowReasons(c).length) return "attention";
  return "ready";
}

// The list's reasons (one per kind, with a count). A summary without them
// (an answer from before phase 2b) falls back to the counts it does carry.
function rowReasons(c) {
  if (Array.isArray(c.reasons)) return c.reasons;
  const out = [];
  if (c.counts?.athletesNotImported) out.push({ code: "athletes_left_out", count: c.counts.athletesNotImported });
  if (c.changesToImported) out.push({ code: "changes_to_imported_results", count: c.changesToImported });
  return out;
}

// The one step for a list reason, and the short fact the row shows for it.
function reasonStep(r) {
  const n = r.count || 0;
  switch (r.code) {
    case "no_linked_athlete": return "No linked athlete in this session yet - link the athletes under Link athletes (below), then find new sessions.";
    case "athletes_not_linked": return `${plural(n, "recorded athlete is", "recorded athletes are")} not linked yet - link them under Link athletes (below), then find new sessions.`;
    case "athletes_not_in_team": return `${plural(n, "linked athlete is", "linked athletes are")} no longer in the team - open it to see who.`;
    case "athletes_need_manual_review": return `${plural(n, "athlete needs", "athletes need")} manual review - open it to see who and why.`;
    case "athletes_marked_invalid_by_source": return `${plural(n, "athlete's statistics are", "athletes' statistics are")} marked not valid in the source data - open it to see who.`;
    case "changes_to_imported_results": return `${plural(n, "change", "changes")} to results already imported - review and accept them, then import.`;
    case "athletes_left_out": return `${plural(n, "recorded athlete is", "recorded athletes are")} left out - open it to see who and why.`;
    default: return "Open it to see what to do.";
  }
}

function reasonFact(r) {
  const n = r.count || 0;
  switch (r.code) {
    case "no_linked_athlete": return "no linked athlete";
    case "athletes_not_linked": return `${plural(n, "athlete", "athletes")} not linked`;
    case "athletes_not_in_team": return `${plural(n, "athlete", "athletes")} not in the team`;
    case "athletes_need_manual_review": return `${plural(n, "athlete needs", "athletes need")} manual review`;
    case "athletes_marked_invalid_by_source": return `${plural(n, "athlete", "athletes")} marked not valid`;
    case "changes_to_imported_results": return `${plural(n, "change", "changes")} to imported results`;
    case "athletes_left_out": return `${plural(n, "athlete", "athletes")} left out`;
    default: return "";
  }
}

// Ready sessions are not importable as they are while the links changed
// after their review: the bucket is locked as a whole, with one line.
function readyLocked(list, gx) {
  return list.some((c) => inboxBucket(c, gx) === "ready" && reviewMadeBeforeLinkChange(c, gx));
}

function findAgainText(list) {
  const dates = list.map((c) => c.sessionStartedAt).filter(Boolean).sort();
  if (!dates.length) return "Find new sessions again";
  const from = formatDate(dates[0]);
  const to = formatDate(dates[dates.length - 1]);
  return `Find new sessions again${from === to ? ` (with dates that include ${from})` : ` (with dates from ${from} to ${to})`}`;
}

// Why the Ready sessions cannot be imported right now, or "" when they can.
// The same sentence heads the Ready bucket, so the coach never reads an
// import instruction that the next screen refuses.
function reviewOnlyText(status) {
  const sw = status.importSwitch || {};
  const viewer = status.viewer || {};
  if (!sw.enabled) return "Review only - importing waits until it is turned on in this environment.";
  if (!viewer.canApprove) return "Review only - an approver imports these (a platform admin, or a coach with approval rights for this team).";
  return "";
}

function renderNextStepHtml(gx, status, source = IMPORT_SOURCES[0]) {
  const check = gx.check || status.lastCheck;
  const list = gx.candidates || [];
  const ready = list.filter((c) => inboxBucket(c, gx) === "ready");
  const attention = list.filter((c) => inboxBucket(c, gx) === "attention").length;
  const stale = list.filter((c) => (inboxBucket(c, gx) === "ready" || inboxBucket(c, gx) === "attention") && reviewMadeBeforeLinkChange(c, gx));
  const unlinkedAthletes = (gx.sourceAthletes || []).filter((a) => a.status === "unlinked").length;
  const reviewOnly = reviewOnlyText(status);
  const readyText = reviewOnly ? plural(ready.length, "session is", "sessions are") + " ready for review" : plural(ready.length, "session is", "sessions are") + " ready to import";
  let text;
  if (!status.settings) text = "A platform admin needs to connect this team to a data source (Settings > Data sources).";
  else if (gx.checkStarting || check?.status === "running") text = "Finding new sessions...";
  else if (stale.length) text = `${findAgainText(stale)}: athlete links changed after these reviews were made.${datesNeededFor(list, gx) ? " The dates are set above." : ""}`;
  else if (unlinkedAthletes) text = `Next step: ${plural(unlinkedAthletes, "GPEXE athlete is", "GPEXE athletes are")} not linked - use Link athletes (below), then find new sessions.`;
  else if (attention && ready.length) text = `Next step: ${plural(attention, "item needs", "items need")} attention · ${readyText}.`;
  else if (attention) text = `Next step: ${plural(attention, "item needs", "items need")} attention - see below.`;
  else if (ready.length && reviewOnly) text = `Next step: ${plural(ready.length, "session can", "sessions can")} be reviewed. ${reviewOnly.replace(/^Review only - /, "").replace(/^\w/, (ch) => ch.toUpperCase())}`;
  else if (ready.length) text = `Next step: ${readyText} - open one to import it.`;
  else if (!list.length && check?.status === "succeeded") text = `No sessions in ${source.name} for ${formatDate(check.window?.from)} - ${formatDate(check.window?.to)}. Choose other dates and find again.`;
  else if (!list.length) text = "Nothing found yet. Find new sessions to see what the source has.";
  else text = "Nothing needs attention. Find new sessions to see what's new.";
  return `<p class="gpexe-next" role="status">${escapeHtml(text)}</p>`;
}

// One sentence per attention row: what is in the way and the one step.
function attentionText(c, status, gx = state.trainingLoad.gpexe) {
  if (isUncertain(c, gx)) return "Import result not confirmed yet - open it to check the result.";
  if (!c.snapshot?.available) return `Needs a fresh search - find new sessions${c.sessionStartedAt ? ` with dates that include ${formatDate(c.sessionStartedAt)}` : ""}.`;
  if (c.status === "blocked") return c.blockedCode ? blockedCoachText(c).step : "Open it to see what is in the way.";
  if (reviewMadeBeforeLinkChange(c, gx)) return `Athlete links changed after this review - find new sessions${c.sessionStartedAt ? ` with dates that include ${formatDate(c.sessionStartedAt)}` : ""} to see it again.`;
  // The first reason is the coach's own step (linking comes first); the
  // row's facts name every reason.
  const [first] = rowReasons(c);
  return first ? reasonStep(first) : "Open it to see what to do.";
}

function renderBucketsHtml(gx, status) {
  const list = gx.candidates || [];
  const of = (name) => list.filter((c) => inboxBucket(c, gx) === name);
  const ready = of("ready");
  const attention = of("attention");
  const out = of("out");
  const imported = of("imported");
  const replaced = list.filter((c) => candidateGroup(c, gx) === "replaced");
  let readyNote = "";
  if (readyLocked(ready, gx)) readyNote = `${findAgainText(ready.filter((c) => reviewMadeBeforeLinkChange(c, gx)))} first - athlete links changed after these reviews were made.`;
  else readyNote = reviewOnlyText(status);
  const rows = (items, kind) => `<ul class="gpexe-candidate-list">${items.map((c) => renderSessionRowHtml(c, status, kind)).join("")}</ul>`;
  return `
    ${attention.length ? `
      <section class="gpexe-panel gpexe-group is-decision imports-bucket" aria-label="Needs attention">
        <div class="gpexe-panel-head"><h3>Needs attention (${attention.length})</h3></div>
        ${rows(attention, "attention")}
      </section>
    ` : ""}
    <section class="gpexe-panel gpexe-group imports-bucket" aria-label="Ready to import">
      <div class="gpexe-panel-head"><h3>Ready to import (${ready.length})</h3></div>
      ${readyNote && ready.length ? `<p class="imports-bucket-note">${escapeHtml(readyNote)}</p>` : ""}
      ${ready.length ? rows(ready, "ready") : `<p class="muted">Nothing is ready to import.</p>`}
    </section>
    ${out.length ? `
      <details class="gpexe-panel gpexe-group imports-bucket">
        <summary>Stays out (${out.length})</summary>
        <p class="muted">Session types OptiMove does not import. Nothing to do.</p>
        ${rows(out, "out")}
      </details>
    ` : ""}
    ${imported.length ? `
      <details class="gpexe-panel gpexe-group imports-bucket">
        <summary>Imported (${imported.length})</summary>
        ${rows(imported, "imported")}
      </details>
    ` : ""}
    ${gx.includeSuperseded && replaced.length ? `
      <details class="gpexe-panel gpexe-group imports-bucket">
        <summary>Replaced versions (${replaced.length})</summary>
        ${rows(replaced, "hidden")}
      </details>
    ` : ""}
  `;
}

// One line per session: what it is, when, and - only where the coach has to
// do something - the one step. No ids, no hashes, no internal statuses.
function renderSessionRowHtml(c, status, kind) {
  const counts = c.counts || {};
  const facts = [];
  if (kind === "ready" || kind === "attention") {
    if (counts.created) facts.push(plural(counts.created, "new result", "new results"));
    if (kind === "ready" && counts.unchanged) facts.push(plural(counts.unchanged, "result unchanged", "results unchanged"));
    // Every reason stays visible even though the step sentence names one.
    if (kind === "attention") for (const r of rowReasons(c)) if (reasonFact(r)) facts.push(reasonFact(r));
  }
  if (kind === "imported") {
    if (c.importedAt) facts.push(`imported ${fmtDateTime(c.importedAt)}`);
    else facts.push("nothing new");
  }
  const step = kind === "attention" ? attentionText(c, status) : "";
  const badge = isUncertain(c, state.trainingLoad.gpexe) ? `<span class="gpexe-badge is-unknown">Result not confirmed</span>` : "";
  return `
    <li>
      <button type="button" class="gpexe-candidate" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(c.id)}">
        <span class="gpexe-candidate-main">
          <strong>${escapeHtml(sessionTitle(c))}</strong>
          <span class="muted">${escapeHtml(fmtDateTime(c.sessionStartedAt))}</span>
        </span>
        ${badge}
        ${facts.length ? `<span class="gpexe-candidate-facts">${escapeHtml(facts.join(" · "))}</span>` : ""}
        ${step ? `<span class="gpexe-candidate-next">${escapeHtml(step)}</span>` : ""}
      </button>
    </li>
  `;
}

// Which group a session belongs in, from what the coach actually has to do:
//   decision - it can be reviewed and approved;
//   notyet   - it can't be imported until a step is taken (the step is the
//              same one the detail shows);
//   excluded - it stays out of OptiMove for good (e.g. a match): no action;
//   uptodate / imported / replaced.
// A blocked session's reason comes with the list (blockedCode, phase 2b), so
// the list is sorted without reading any session's detail.
export function candidateGroup(c, gx = state.trainingLoad.gpexe) {
  if (c.status === "imported") return "imported";
  if (c.status === "superseded") return "replaced";
  if (!c.snapshot?.available) return "notyet";
  if (c.status === "blocked") return blockedCoachText(c).excluded ? "excluded" : "notyet";
  if (c.previewStatus === "no_changes" || c.preview?.status === "no_changes") return "uptodate";
  return "decision";
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

function renderLinksHtml(gx) {
  const links = gx.links || [];
  const unlinked = (gx.sourceAthletes || []).filter((a) => a.status === "unlinked").length;
  const inactive = (gx.sourceAthletes || []).filter((a) => a.status === "linked_inactive").length;
  // The count of athletes to link is on the button; only the other fact is a line.
  const facts = [];
  if (inactive) facts.push(plural(inactive, "link points", "links point") + " to an athlete no longer in the team");
  return `
    <section class="gpexe-panel" aria-label="Athlete links">
      <div class="gpexe-panel-head imports-links-head">
        <h3>GPEXE athletes linked to this team</h3>
        <button type="button" class="${unlinked ? "primary-button" : "plain-button"} gpexe-button" data-action="training-load-gpexe-map-open" ${gx.sourceAthletes ? "" : "disabled"}>Link athletes${unlinked ? ` (${unlinked})` : ""}</button>
      </div>
      ${facts.length ? `<p class="imports-links-facts">${escapeHtml(facts.join(" · "))}.</p>` : ""}
      ${gx.sourceAthletesError && !gx.sourceAthletes ? `
        <div class="gpexe-warning imports-links-unavailable" role="status">
          <p>The list of GPEXE athletes is not available right now, so Link athletes is off. The sessions, the search and the links below still work.</p>
          <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-sources-retry" ${gx.sourceAthletesRetrying ? "disabled" : ""}>${gx.sourceAthletesRetrying ? "Trying again..." : "Try again"}</button>
          ${errorTech(gx.sourceAthletesError)}
        </div>
      ` : ""}
      <p class="muted gpexe-hint">A link is never guessed: find the athlete in GPEXE first, then link the whole team under Link athletes or one athlete from a session's review. A wrong link can be removed here before an import is approved. Unlinking doesn't change results that are already imported: those can't be changed here — contact a platform administrator.</p>
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

// ---------------------------------------------------------------------------
// Whole-team linking ("Link athletes", phase 3b)
// ---------------------------------------------------------------------------

const MAP_VALUE_LABELS = [["duration", "Time", "min"], ["distance", "Distance", "m"], ["maxSpeed", "Top speed", "km/h"]];

// The helper values of the athlete's last sighting, "—" where the source
// gave none; they help to find the athlete in GPEXE and prove nothing.
function mapValuesText(a) {
  const parts = MAP_VALUE_LABELS.map(([key, label, unit]) => `${label} ${a.values?.[key] === null || a.values?.[key] === undefined ? "—" : fmtValue(a.values[key], unit)}`);
  const drills = a.lastSeen?.sessionDrillsCount;
  parts.push(`Drills ${drills === null || drills === undefined ? "—" : drills}`);
  return parts.join(" · ");
}

// The same title and date-time as the inbox row of that session, so the
// coach can match them; the session type stays in Technical details.
function mapLastSeenText(a) {
  const s = a.lastSeen;
  if (!s) return "Not seen in any session that is still available.";
  const when = s.sessionStartedAt ? fmtDateTime(s.sessionStartedAt) : "";
  const title = sessionTitle({ label: s.sessionLabel, gpexeTeamSessionId: s.gpexeTeamSessionId });
  const raw = s.evidence === "raw_snapshot" ? " · this session can't be imported, so it gives no values" : "";
  return `Last seen ${[when, title].filter(Boolean).join(" · ")}${raw}`;
}

function renderMapRowHtml(a, gx, choices) {
  const id = a.gpexeAthleteId;
  const chosen = gx.mapping.choices[id] || "";
  const tech = techHtml([
    ["GPEXE athlete id", id],
    ["Status", a.status],
    ["Session type", a.lastSeen?.sessionType],
    ["Evidence", a.lastSeen?.evidence],
    ["Session id", a.lastSeen?.gpexeTeamSessionId],
    ["Candidate id", a.lastSeen?.candidateId],
    ["Candidate status", a.lastSeen?.candidateStatus],
    ["Link id", a.link?.id],
  ]);
  if (a.status === "unlinked") {
    return `
      <li class="gpexe-map-row is-unlinked">
        <div class="gpexe-map-main">
          <strong>GPEXE athlete ${escapeHtml(id)}</strong>
          <span class="muted">${escapeHtml(mapLastSeenText(a))}</span>
          <span class="gpexe-map-values">${escapeHtml(mapValuesText(a))}</span>
        </div>
        ${choices.length ? `<label class="gpexe-map-choice"><span>Link to</span>
          <select class="gpexe-select" data-action="training-load-gpexe-map-choose" data-gpexe-athlete-id="${escapeAttr(id)}" aria-label="Link GPEXE athlete ${escapeAttr(id)} to" ${gx.mapping.sending ? "disabled" : ""}>
            <option value="" ${chosen ? "" : "selected"}>Not now</option>
            ${choices.map((o) => `<option value="${escapeAttr(o.id)}" ${chosen === o.id ? "selected" : ""} ${o.duplicate ? "disabled" : ""}>${escapeHtml(o.name)}${o.duplicate ? " (same name as another athlete)" : ""}</option>`).join("")}
          </select>
        </label>` : `<p class="muted gpexe-map-choice">No athlete to choose.</p>`}
        ${tech}
      </li>
    `;
  }
  const inactive = a.status === "linked_inactive";
  return `
    <li class="gpexe-map-row ${inactive ? "is-inactive" : "is-linked"}">
      <div class="gpexe-map-main">
        <strong>${escapeHtml(a.link?.athleteName || "Athlete")}</strong>
        <span class="muted">GPEXE athlete ${escapeHtml(id)}${inactive ? " · no longer in the team" : ""} · ${escapeHtml(mapLastSeenText(a))}</span>
        <span class="gpexe-map-values">${escapeHtml(mapValuesText(a))}</span>
      </div>
      <div class="gpexe-map-choice">
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-unlink" data-link-id="${escapeAttr(a.link?.id || "")}" ${gx.linkBusy || gx.mapping.sending ? "disabled" : ""}>Unlink</button>
      </div>
      ${tech}
    </li>
  `;
}

function mapOutcomeText(r) {
  if (r.outcome === "linked") return "linked";
  if (r.outcome === "unknown") return `not confirmed - the answer was lost, so we can't tell whether the link was made. Press Done: if GPEXE athlete ${r.gpexeAthleteId} now appears under Linked, it was.`;
  const code = r.error?.code;
  if (code === "already_linked") return "not linked: this GPEXE athlete, or the athlete you chose, is already linked. Press Done to see the current list, then choose another athlete or Not now.";
  if (code === "athlete_not_in_team") return "not linked: the athlete is no longer an active member of the team";
  if (code === "invalid_gpexe_athlete_id") return "not linked: this is not a valid GPEXE athlete id";
  if (code === "gpexe_team_not_configured") return "not linked: the team is not connected to GPEXE";
  if (r.error?.status === 404) return "not linked: the team is not available in your current workspace";
  return "not linked: the server refused it";
}

function renderTeamMappingHtml(gx, teams) {
  const m = gx.mapping;
  const team = teams.find((t) => String(t.id) === String(gx.teamId));
  const title = `Link GPEXE athletes${team ? ` - ${team.name}` : ""}`;
  const list = gx.sourceAthletes || [];
  const unlinked = list.filter((a) => a.status === "unlinked");
  const linked = list.filter((a) => a.status === "linked");
  const inactive = list.filter((a) => a.status === "linked_inactive");
  const choices = teamAthleteChoices(gx);
  const stagedCount = Object.keys(m.choices).length;
  const busy = m.sending ? "disabled" : "";
  const staged = m.confirming ? stagedTeamMapping(gx) : null;
  const rows = (items) => `<ul class="gpexe-map-list">${items.map((a) => renderMapRowHtml(a, gx, choices)).join("")}</ul>`;
  let body;
  if (m.results) {
    body = `
      <section class="gpexe-map-results" aria-label="Result">
        <h4>Result</h4>
        <ul>
          ${m.results.map((r) => `<li><strong>GPEXE athlete ${escapeHtml(r.gpexeAthleteId)} → ${escapeHtml(r.athleteName)}</strong>: ${escapeHtml(mapOutcomeText(r))}${r.error ? errorTech(r.error) : ""}</li>`).join("")}
        </ul>
        ${m.results.some((r) => r.outcome !== "refused") ? `<p>Find new sessions to update the reviews - approving waits until then. A wrong link can be removed with Unlink before an import is approved.</p>` : ""}
        <div class="gpexe-link-actions"><button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-map-done">Done</button></div>
      </section>
    `;
  } else if (m.confirming && staged?.pairs) {
    body = `
      <section class="gpexe-link-confirm gpexe-map-confirm" role="group" aria-label="Confirm the links">
        <p><strong>Link ${plural(staged.pairs.length, "athlete", "athletes")}?</strong></p>
        <ul>${staged.pairs.map((p) => `<li class="gpexe-link-pair"><strong>GPEXE athlete ${escapeHtml(p.gpexeAthleteId)}</strong> → <strong>${escapeHtml(p.athleteName)}</strong></li>`).join("")}</ul>
        ${unlinked.length > staged.pairs.length ? `<p class="muted">${escapeHtml(plural(unlinked.length - staged.pairs.length, "other GPEXE athlete stays", "other GPEXE athletes stay"))} not linked (Not now); their sessions keep needing attention until they are linked.</p>` : ""}
        <p>Once you find new sessions and approve an import, each GPEXE athlete's results are imported as the athlete chosen here — in the sessions already found and in every session found later.</p>
        <p>You can unlink before an import is approved. Unlinking doesn't change results that are already imported: if a link turns out wrong after an import, those results can't be changed here — contact a platform administrator.</p>
        <div class="gpexe-link-actions">
          <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-map-back" ${busy}>Back</button>
          <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-map-send" ${busy}>${m.sending ? "Linking..." : `Link ${plural(staged.pairs.length, "athlete", "athletes")}`}</button>
        </div>
      </section>
    `;
  } else {
    body = `
      <p class="muted gpexe-hint">A link is never guessed. Choose an athlete only when you are sure who a GPEXE athlete is - the values of the last session help you find them in GPEXE and prove nothing. Choosing sends nothing: the links are made only when you press Link on the next step.</p>
      ${!gx.sourceAthletes ? `<p class="muted">Loading...</p>` : ""}
      ${gx.sourceAthletes && !list.length ? `<p class="muted">No GPEXE athlete has been seen yet. Find new sessions first.</p>` : ""}
      ${m.error ? `<p class="gpexe-error" role="alert">${escapeHtml(m.error)}</p>` : ""}
      ${gx.linkError ? `<p class="gpexe-error" role="alert">${escapeHtml(errorText(gx.linkError, "The link could not be changed."))}</p>` : ""}
      ${unlinked.length ? `
        <section class="gpexe-map-group" aria-label="Not linked">
          <h4>Not linked (${unlinked.length})</h4>
          ${!choices.length ? `<p class="muted">${teamHasActiveAthletes(gx) ? "Every active athlete of the team is already linked. Add the athlete to the team in Settings &gt; Athletes first, or unlink the wrong one below." : "This team has no active athletes yet. Add them in Settings &gt; Athletes, then come back to link."}</p>` : ""}
          ${rows(unlinked)}
        </section>
      ` : ""}
      ${inactive.length ? `
        <section class="gpexe-map-group" aria-label="No longer in the team">
          <h4>Linked to an athlete no longer in the team (${inactive.length})</h4>
          <p class="muted">Nothing to do if the athlete has left the team. Unlink only if the link was wrong; results already imported stay as they are.</p>
          ${rows(inactive)}
        </section>
      ` : ""}
      ${linked.length ? `
        <section class="gpexe-map-group" aria-label="Linked">
          <h4>Linked (${linked.length})</h4>
          ${rows(linked)}
        </section>
      ` : ""}
    `;
  }
  const footer = !m.results && !m.confirming ? `
    <div class="gpexe-link-actions gpexe-map-actions">
      <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-map-close" ${busy}>Close</button>
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-map-confirm" ${stagedCount && !busy ? "" : "disabled"}>Review ${stagedCount ? plural(stagedCount, "link", "links") : "links"}</button>
    </div>
  ` : "";
  return `
    <div class="builder-athlete-overlay gpexe-detail-overlay">
      <button type="button" class="builder-athlete-backdrop" data-action="training-load-gpexe-map-close" aria-label="Close" ${busy}></button>
      <section class="panel builder-athlete-picker gpexe-detail gpexe-map" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="builder-section-panel-head">
          <h3>${escapeHtml(title)}</h3>
          <button type="button" class="plain-button icon-button builder-athlete-picker-cancel" data-action="training-load-gpexe-map-close" aria-label="Close" ${busy}>&times;</button>
        </div>
        <div class="gpexe-detail-body">
          <p class="gpexe-map-summary">${escapeHtml([`${linked.length} linked`, `${unlinked.length} not linked`, ...(inactive.length ? [`${inactive.length} no longer in the team`] : [])].join(" · "))}</p>
          ${body}
          ${footer}
        </div>
      </section>
    </div>
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
      <p><strong>GPEXE athlete ${escapeHtml(l.gpexeAthleteId)} is now linked to ${escapeHtml(l.athleteName)}.</strong> Find new sessions${escapeHtml(dates)} to update the review - approving waits until then.</p>
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
    ${!preview ? `<p class="muted">${c.snapshot?.available === false ? "The GPEXE data is too old. Find new sessions to see it again." : "No preview."}</p>` : `
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

// The coach's reason and step for a blocked session, from the list's neutral
// blockedCode (phase 2b); the adapter's own code and the server's sentence
// stay in Technical details. `c` is a list row or the review's candidate.
// `excluded` marks a session that stays out of OptiMove for good - nothing
// to fix, no decision.
function blockedCoachText(c) {
  const code = c.blockedCode;
  if (code === "earlier_import_left_behind") {
    return { reason: "Some athletes' results from this session were imported before, but would now be left out.", step: "Do the step below for each athlete, then find new sessions." };
  }
  if (code === "unsupported_session_type") {
    const category = c.sessionType;
    return { excluded: true, reason: `${category ? `"${category}" sessions are` : "This type of session is"} not imported from GPEXE.`, step: "No action needed - it stays out of OptiMove." };
  }
  if (code === "source_thresholds_unavailable") {
    return { reason: "The team's GPEXE thresholds (speed and power zones) are missing or don't cover this session's date.", step: "Check the team thresholds in GPEXE, then find new sessions." };
  }
  if (code === "source_marks_session_invalid") {
    return { reason: "GPEXE marks this session's statistics as not valid.", step: "Fix the session in GPEXE, then find new sessions." };
  }
  if (code === "no_importable_athlete") {
    return { reason: "No athlete in this session can be imported.", step: "Link the athletes to OptiMove athletes or fix their data in GPEXE, then find new sessions." };
  }
  if (code === "source_data_inconsistent") {
    return { reason: "GPEXE sent incomplete or inconsistent data for this session.", step: "Find new sessions again later. If it stays like this, ask a platform admin (give them the Technical details)." };
  }
  // conflicts_with_existing_data, other, or no code at all.
  return { reason: "This session conflicts with data already in OptiMove and can't be imported automatically.", step: "Ask a platform admin to look at it (give them the Technical details)." };
}

function renderBlockedHtml(preview, c) {
  if (!preview.blocked) return "";
  const steps = preview.blocked.resolution || [];
  const text = blockedCoachText(c);
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
        <p>Link GPEXE athlete ${escapeHtml(id)} to ${escapeHtml(pending.athleteName)}? After you find new sessions and approve the import, athlete ${escapeHtml(id)}'s results in this session, and in every GPEXE session imported later, will be imported as ${escapeHtml(pending.athleteName)}.</p>
        <p>You can unlink it before an import is approved. Unlinking doesn't change results that are already imported: if the link turns out wrong after an import, those results can't be changed here — contact a platform administrator.</p>
        <div class="gpexe-link-actions">
          <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-link-cancel" ${gx.linkBusy ? "disabled" : ""}>Cancel</button>
          <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-link-confirm" ${gx.linkBusy ? "disabled" : ""}>${gx.linkBusy ? "Linking..." : "Confirm link"}</button>
        </div>
      </div>
    `;
  }
  if (!unlinkedChoices.length) {
    return `<p class="muted">Every athlete of the team without a GPEXE record here is already linked. If athlete ${escapeHtml(id)} is one of them, close this review and check "GPEXE athletes linked to this team".</p>`;
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

// The session imports at least one athlete through a GPEXE link: a stable
// fact of the preview (athleteId comes only from the team's links), not of
// what was clicked in this browser. A linked athlete left out doesn't count.
export function importsLinkedAthletes(c) {
  return (c?.preview?.athletes || []).some((a) => a.athleteId && !a.notImported);
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
    return `<p class="gpexe-warning gpexe-approve-note" role="note"><strong>Athlete links changed after this review was made.</strong> Close it and find new sessions${day ? ` (with dates that include ${escapeHtml(day)})` : ""}; approving waits until then.</p>`;
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
      ${importsLinkedAthletes(c) ? `<p class="muted gpexe-approve-names">Check that each athlete is the right person. Results imported under the wrong athlete can't be changed here — contact a platform administrator.</p>` : ""}
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-approve" ${detail.approving ? "disabled" : ""}>${detail.approving ? "Importing..." : "Approve import"}</button>
    </div>
  `;
}
