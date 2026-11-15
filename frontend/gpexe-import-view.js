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
import { choiceValue, chosenStateCount, statesLockedOf, statesSummary } from "./gpexe-import-states-data.js";
import { guideFacts, renderGuideHtml } from "./gpexe-guide-view.js";
import { guideSteps } from "./gpexe-guide-steps.js";
import { ATTENTION_TEXT, attentionGroups, nextInGroup, reviewMustStay } from "./gpexe-attention-groups.js";
import { renderUndoHtml, renderUndoneNoteHtml } from "./gpexe-undo-view.js";
import { undoBusy } from "./gpexe-undo-data.js";
import { renderTeamSwitchLineHtml, renderTeamSwitchPanelHtml } from "./team-import-switch-view.js";
import { escapeAttr, escapeHtml, formatDate, renderOption } from "./utils.js";
import {
  BATCH_MAX,
  batchAllowed,
  batchSelectable,
  batchSelection,
  calendarDayKey,
  calendarFiltered,
  calendarMonthShown,
  calendarOpen,
  chooseOpen,
  candidateGroup,
  gpexeTeamOptions,
  inboxBucket,
  isUncertain,
  reviewMadeBeforeLinkChange,
  rowReasons,
  stagedTeamMapping,
  teamAthleteChoices,
  teamHasActiveAthletes,
  birthDateConflict,
  duplicateIdentityNames,
  identityBusy,
  identityLocked,
  identityNameKey,
  identityOf,
  gpexeAthleteLabel,
  gpexeAthleteSentence,
  gpexeAthleteOrdinal,
  notConfirmedForImport,
  withdrawnByCheck,
  isHiddenVersion,
  identityViewer,
  stageableSuggestedPairs,
  suggestedIdentity,
  SUGGESTION_MAX_PAIRS,
} from "./gpexe-import-data.js";

// The bucket rules live in the data module (the batch selection needs them
// there); they stay exported from here for the shell and the tests.
export { candidateGroup, inboxBucket };

// Why a session can't be approved right now, in the coach's words (blocked
// and expired sessions explain themselves above the approve area).
const BLOCKER_TEXT = {
  import_switch_off: "Importing is switched off in this environment, so it can't be imported here.",
  // U2 (v56): the team's own switch.
  team_import_switch_off: "Imports are switched off for this team, so it can't be imported here.",
  superseded_by_newer_data: "GPEXE has newer data for this session. Open the newer version.",
  // v33: the coach's sentence; an administrator reads notConfirmedText.
  not_confirmed_for_import: "Not confirmed for import yet. Find new sessions again, then review it.",
  already_imported: "Already imported.",
  import_undone: "The import of this session was undone. It can't be approved again; find new sessions to review it.",
  snapshot_expired_check_again: "The GPEXE data is too old. Find new sessions, then review it again.",
  nothing_to_import: "Nothing new to import - no action needed.",
};

// One badge per group, the same in the list and in the review.
const GROUP_BADGE = {
  decision: ["pending", "Not imported yet"],
  notyet: ["blocked", "Can't be imported yet"],
  excluded: ["excluded", "Stays out"],
  uptodate: ["uptodate", "Up to date"],
  imported: ["imported", "Imported"],
  replaced: ["superseded", "Replaced"],
  withdrawn: ["superseded", "No longer found"],
  undone: ["superseded", "Import undone"],
};

// v33: what "not confirmed for import" means, in the viewer's words, with the
// dates a new search needs (findAgainText). An administrator (the status's
// identityAdmin: only the server says so) reads the two possible causes; a
// coach reads the one step. Neither carries a code, a proof or an id. The
// row's step names the action only (its badge already says the status); the
// review's note is the whole sentence.
const lower = (text) => text.replace(/^F/, "f");
// The second cause is the server's not_observed: fewer than two of the
// session's drills carried data, so the drill results could not be confirmed
// (two drills with the same data fail the whole search and never become a row).
const ADMIN_CAUSES = "no successful search has confirmed this session yet, or GPEXE returned drill data for fewer than two of its drills, so OptiMove could not confirm its drill results";
// Two sentences: the one action now (nothing to wait for when the cause is the
// first one), then what to look at in GPEXE if it stays like this.
const adminStep = (c) => `${findAgainText([c])}. If it stays like this, check in GPEXE that the session's drills are set up and have data.`;
function notConfirmedText(c, gx = state.trainingLoad.gpexe) {
  return gx?.status?.viewer?.isPlatformAdmin === true
    ? `Not confirmed for import: ${ADMIN_CAUSES}. ${adminStep(c)}`
    : `Not confirmed for import yet. ${findAgainText([c])}, then review it.`;
}
// The row's step is the action alone for everyone (the badge says the
// status; the two causes wait in the review, where there is room).
function notConfirmedStep(c) {
  return `${findAgainText([c])}, then review it.`;
}
// v33: a session the last successful search no longer found in GPEXE.
const withdrawnText = (c) => `The last successful search no longer found this session in GPEXE, so it can't be imported. If it is back in GPEXE, ${lower(findAgainText([c]))}.`;

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

// Preview v3 (9-B, J17 section 4): every value comes through one of the
// team's mapping activations and names its canonical variable (label), its
// GPEXE field (sourceMetricKey) and the GPEXE value (sourceValue,
// sourceUnit), in the order the server gives. A preview stored before 9-B
// (version 2) keeps the rendering above (METRIC_TEXT, METRIC_ORDER) unchanged.
function isV3(preview) {
  return Number(preview?.version) >= 3;
}

// A v3 value's name: the variable's label as the server sends it (a viewer
// whom C99 does not admit to a club variable reads "Club variable"). The
// variable's key is never shown.
function variableName(v) {
  return typeof v?.label === "string" && v.label.trim() ? v.label : "Variable";
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
  import_undone: "Not imported: the import of this session was undone. Find new sessions to review it again.",
  import_switch_off: "Not imported: importing is switched off in this environment.",
  get team_import_switch_off() { return `Not imported: imports are switched off for this team. ${switchOnWho()}`; },
  get not_an_approver() { return platformViewer() ? "Not imported: you may not approve imports for this team. Ask a platform admin to approve it or to give you the right." : `Not imported: you can't import this session. ${AskWho()}.`; },
  superseded_by_newer_data: "Not imported: GPEXE has newer data for this session. Open the newer version.",
  blocked: "Not imported: this session must be fixed first. See what to fix above.",
  snapshot_expired_check_again: "Not imported: the GPEXE data is too old. Find new sessions, then review it again.",
  nothing_to_import: "Nothing to import: GPEXE has nothing new for this session.",
  changes_need_acceptance: "Not imported yet: this import changes results that were already imported. Tick the box to accept those changes, then approve.",
  preview_changed: "Not imported: the data changed since you opened this session. Review it again, then approve.",
  no_importable_athlete: "Not imported: leaving these athletes out would leave nobody to import.",
  invalid_exclusion: "Not imported: one of the athletes you left out can't be left out any more. Update the review and choose again.",
  invalid_excluded_athlete: "Not imported: one of the athletes you left out can't be left out any more. Update the review and choose again.",
  internal_error: "Not imported: the server failed before writing anything. Try again later.",
  // Switch condition 2: a bounded wait before the COMMIT (another check,
  // import or change of the team, or a busy server); nothing was written.
  try_again: "Not imported: another check, import or change of this team was running, or the server was busy. Nothing was written; try again in a moment.",
  // v33: refused because the last successful search did not confirm it, or it was withdrawn.
  candidate_not_actionable: "Not imported: this session is not confirmed for import. Find new sessions again, then review it.",
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
  // C110 form B (9-B): the two Left-out reasons of a mapped import. The code
  // reaches the two administrators; everyone else reads the server's plain
  // words (leftOutText).
  required_value_missing: "required value missing",
  canonical_value_out_of_range: "outside the variable's limits",
};

// The step that lifts a block, in the coach's words, built from the step's
// action; the server's own wording (with field names and the runbook path)
// stays in Technical details.
function coachStep(s, c) {
  const name = s.previousAthleteId ? athleteName(c, s.previousAthleteId, null) : "the athlete";
  const undo = platformViewer() ? "Or ask a platform admin to undo the earlier import." : `Or ${askWho()} to undo the earlier import.`;
  if (s.action === "relink_athlete") return `Link ${gpexeWho(s.gpexeAthleteId)} again to ${name} (the athlete their earlier results belong to), then find new sessions.`;
  if (s.action === "restore_team_membership") return `Make ${name} an active member of the team again, then find new sessions. ${undo}`;
  if (s.action === "fix_in_gpexe_or_undo") return `Fix this athlete's data in GPEXE (one track, valid statistics), then find new sessions. ${undo}`;
  if (s.action === "undo_earlier_import") return `GPEXE no longer lists some results that were imported earlier. ${platformViewer() ? "Ask a platform admin" : AskWho()} to undo the earlier import.`;
  return platformViewer() ? "Ask a platform admin what to do (see Technical details)." : `${AskWho()}.`;
}

// `extra` is markup that belongs to support, not to the coach's flow (the
// replaced-versions switch): it lives inside the same folded block.
function techHtml(entries, extra = "") {
  // P2 (owner 2026-11-13, O1): in Imports only the platform admin has Technical details; the coach and the club admin read
  // one plain sentence and one step instead. The server's codes stay in its answers; nothing of them is shown to them.
  if (!platformViewer()) return "";
  const rows = entries.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!rows.length && !extra) return "";
  return `<details class="gpexe-tech"><summary>Technical details</summary><dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>${extra}</details>`;
}

// J20-A2: GPEXE field names, raw values and ids are for the two administrators
// only. A coach's review of the athletes carries no Technical details at all.
function adminTechHtml(entries, extra = "") {
  return techHtml(entries, extra);
}

// The session review's technical lines: an administrator reads them; a coach
// reads one sentence instead and never a code, a server message or a step.
// P1: a coach reads no line about technical details at all (it gave them nothing to do).
function reviewTechHtml(entries, extra = "") {
  return techHtml(entries, extra);
}
// P1 (owner 2026-11-13, O1/O2/O3/O5): the coach and the club admin get the simple review; the platform admin keeps the full
// one. The status's own fact: viewer.isPlatformAdmin.
const platformViewer = () => state.trainingLoad.gpexe?.status?.viewer?.isPlatformAdmin === true;
// Who the reader asks when something is not theirs to do: a coach their club administrator, a club administrator OptiMove.
// Who turns a team's imports on, in the reader's words (the club admin can, in the team's own mode; the coach asks).
const switchOnWho = () => (platformViewer()
  ? "A platform administrator can turn them on (the club administrator too, in team mode)."
  : `${AskWho()}.`);
// The same, opening a sentence.
const AskWho = () => askWho().replace(/^./, (ch) => ch.toUpperCase());
const askWho = () => (platformViewer() ? "contact a platform administrator" : state.trainingLoad.gpexe?.status?.viewer?.identityAdmin === true ? "contact OptiMove support" : "ask your club administrator");
function reviewErrorTech(error) {
  if (!error) return "";
  return reviewTechHtml([["HTTP status", error.status || "no answer"], ["Code", error.code], ["Server message", error.message]]);
}
// "(give them the Technical details)" only where the reader has them.
const giveTech = () => (platformViewer() ? " (give them the Technical details)" : "");
// A connection fact the team's administrators act on in Settings > Source connections (F3c2g's precise reasons).
const CONNECTION_FACT = /^(binding_|connection_|team_setting_)|^(host_not_allowed|adapter_not_available|key_missing|credential_unreadable|source_auth_rejected|source_access_refused|source_team_mismatch)$/;
// P2: the sentence a coach or a club admin reads when the team's GPEXE connection can't be used. The club admin (the
// connection's owner, F3c2e) with a precise fact gets their own step; everyone else is told who to ask.
function connectionUnusableText(fact, extra = "") {
  const clubAdmin = state.trainingLoad.gpexe?.status?.viewer?.identityAdmin === true;
  if (clubAdmin && typeof fact === "string" && CONNECTION_FACT.test(fact)) return `The team's GPEXE connection can't be used right now.${extra} Check it in Settings > Source connections.`;
  return `The team's GPEXE connection can't be used right now.${extra} ${AskWho()}.`;
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
  // A non-zero value never reads as "0": below 0.005 it keeps 3 significant digits.
  const tiny = Number.isFinite(n) && n !== 0 && Math.abs(n) < 0.005;
  const text = Number.isFinite(n) ? n.toLocaleString("en-GB", tiny ? { maximumSignificantDigits: 3 } : { maximumFractionDigits: 2 }) : String(value);
  // "n" is a count: no unit after it.
  return unit && unit !== "n" ? `${text} ${unit}` : text;
}

// GPEXE's own names of the metrics shown, for Technical details. A v3 preview
// (9-B) names the GPEXE fields instead (sourceFieldsTech).
function metricNamesTech(values, v3 = false) {
  if (v3) return sourceFieldsTech(values);
  const seen = new Map();
  for (const v of values || []) if (v?.metricKey && !seen.has(v.metricKey)) seen.set(v.metricKey, `${metricName(v)} = ${v.label || v.metricKey} (${v.metricKey})`);
  return seen.size ? [["GPEXE metric names", [...seen.values()].join("; ")]] : [];
}

// v3: one line per GPEXE field and parameter fingerprint, with the activation
// and the mapping version only where the server sent them (the two
// administrators). The variable's key is never shown, not even here.
function sourceFieldsTech(values) {
  const seen = new Map();
  for (const v of values || []) {
    if (!v?.sourceMetricKey) continue;
    const fingerprint = v.sourceParameterFingerprint || "";
    const key = `${v.sourceMetricKey}|${fingerprint}`;
    if (seen.has(key)) continue;
    const parts = [`${variableName(v)} = ${v.sourceMetricKey}`];
    if (fingerprint) parts.push(`parameters ${fingerprint}`);
    if (v.activationId) parts.push(`activation ${v.activationId}`);
    if (v.mappingVersionId) parts.push(`mapping version ${v.mappingVersionId}`);
    seen.set(key, parts.join(" · "));
  }
  return seen.size ? [["GPEXE fields", [...seen.values()].join("; ")]] : [];
}

function resultLabel(result) {
  return result.level === "drill" ? `Drill ${Number(result.drillIndex) + 1}` : "Whole session";
}

// The session's name without a raw timestamp at its end; the date and time
// are shown next to it anyway.
// U6a-2 (D5): "Tue 03.11." - the day a session is listed under, in the viewer's time.
function sessionDayText(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${WEEKDAY_NAMES[(d.getDay() + 6) % 7]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.`;
}
function sessionTimeText(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// D5: the session's size beside its time - "18 athletes · 5 drills" (every GPEXE athlete the session recorded, linked or
// not; drills only when it has some). Nothing when the server has no count (an expired snapshot): never a guess.
function sessionSizeFacts(c) {
  const facts = [];
  if (Number.isInteger(c.athleteCount)) facts.push(plural(c.athleteCount, "athlete", "athletes"));
  if (Number.isInteger(c.drillsCount) && c.drillsCount > 0) facts.push(plural(c.drillsCount, "drill", "drills"));
  return facts;
}

function sessionTitle(c) {
  // No id outside Technical details: a label-less session is just "GPEXE session" (its date is shown beside it).
  const label = c.label || "GPEXE session";
  return label.replace(/\s+\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/, "");
}

// The session's name in plain words: "GPEXE FULL TRAINING" reads "Full training". IMP2: the one rule for every place a
// session is named (the review's heading, the Imports rows, the import dialog, Link athletes); a number in the name
// stays ("Full training 2"), and every place shows the day and the time beside it, so two sessions of one day never
// read the same. The raw GPEXE name stays under Technical details (the review's for an administrator, the import
// dialog's for everyone).
function niceSessionName(c) {
  let label = sessionTitle(c).replace(/^GPEXE\s+/i, "").replace(/\s+\d{1,2}\.\d{1,2}\.(?:\d{2,4})?$/, "").trim();
  if (!label || label === "session") label = "Session";
  if (label === label.toUpperCase()) label = label.toLowerCase();
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function athleteName(candidate, athleteId, gpexeAthleteId) {
  const name = athleteId ? candidate.athletes?.[athleteId]?.name : "";
  if (name) return name;
  return gpexeAthleteId ? gpexeAthleteLabel(gpexeAthleteId) : "Athlete";
}

// One athlete inside a sentence, from the data module's one helper: the GPEXE
// name, or "GPEXE athlete N (name not loaded)" and the like for an
// administrator; "GPEXE athlete 104" for a coach, as before.
function gpexeWho(gpexeAthleteId) {
  return gpexeAthleteSentence(gpexeAthleteId);
}

// The GPEXE side of a row: "GPEXE: <name>" when a name is loaded, otherwise
// the label alone (it already says "GPEXE athlete N"), never "GPEXE: GPEXE
// athlete N".
function gpexeSideText(gpexeAthleteId, gx) {
  const label = gpexeAthleteLabel(gpexeAthleteId, gx);
  return identityOf(gpexeAthleteId, gx)?.name ? `GPEXE: ${label}` : label;
}

// The id under Technical details, for an administrator only (a coach sees it
// in the text, as before).
function idTechHtml(gpexeAthleteId) {
  return gpexeAthleteId ? techHtml([["GPEXE athlete id", gpexeAthleteId]]) : "";
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

// U6a: the administrator's controls (switch, reason, mode, Record a date, history) in one folded card; the main screen shows only the state.
function renderImportSettingsHtml(gx) {
  const panel = renderTeamSwitchPanelHtml(gx);
  if (!panel) return "";
  // Kept across repaints the way the calendar is (app.js "toggle"): a search polls every 2 s and would fold it otherwise.
  const open = gx.settingsOpen === true || Boolean(gx.teamSwitch?.error || gx.teamSwitch?.notice || gx.teamSwitch?.busy);
  return `<details class="gpexe-panel imports-settings" data-rendered-open="${open ? "1" : "0"}" ${open ? "open" : ""}><summary>Import settings</summary>${panel}</details>`;
}

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
      ${status && setupOpen(gx, status) ? renderGuideHtml(gx, status) : ""}
      ${status ? renderSourceCardHtml(IMPORT_SOURCES[0], gx, status) : ""}
      ${status ? renderNextStepHtml(gx, status, IMPORT_SOURCES[0]) : ""}
      ${gx.notice && !gx.detail ? `<p class="gpexe-notice" role="status">${escapeHtml(gx.notice)}</p>` : ""}
      ${!gx.detail ? renderLastLinkHtml(gx) : ""}
      ${status ? renderImportsTabsHtml(gx, status) : ""}
      ${gx.detail ? renderCandidateDetailHtml(gx, status) : ""}
      ${!gx.detail && gx.mapping?.open ? renderTeamMappingHtml(gx, teams) : ""}
      ${!gx.detail && !gx.mapping?.open ? renderBatchOverlayHtml(gx) : ""}
    </div>
  `;
}

function renderTeamRowHtml(teams, teamId, gx = state.trainingLoad.gpexe) {
  if (teams.length === 1) {
    const team = teams[0];
    return `<div class="gpexe-team-row"><span class="gpexe-team-label">Team</span><strong>${escapeHtml(team.name)}</strong>${team.club_name ? `<span class="muted"> · ${escapeHtml(team.club_name)}</span>` : ""}</div>`;
  }
  return `
    <label class="gpexe-team-row">
      <span class="gpexe-team-label">Team</span>
      <select class="gpexe-select" data-action="training-load-gpexe-team" aria-label="Team" ${gx.batch?.sending || gx.guide?.write?.sending || gx.guide?.write?.unknown ? "disabled" : ""}>
        ${teams.map((team) => renderOption(team.id, team.club_name ? `${team.name} (${team.club_name})` : team.name, teamId)).join("")}
      </select>
    </label>
  `;
}

// IMP1 (the "GPS Import Flow" sketch): the banner on top - what the last search found and ONE main button. Dates stay a
// small fold beside it (the search reads them from there); every other fact of the source lives in the Search tab.
function shortWhen(value) {
  const day = sessionDayText(value);
  const time = sessionTimeText(value);
  return day ? `${day.replace(/^\S+\s/, "")} ${time}`.trim() : "";
}

function bannerText(gx, check) {
  const list = gx.candidates || [];
  const ready = list.filter((c) => inboxBucket(c, gx) === "ready").length;
  const needs = list.filter((c) => inboxBucket(c, gx) === "attention").length;
  const when = check?.finishedAt || check?.startedAt;
  // Honest: OptiMove does not look in GPEXE by itself yet, so the banner says what the last search found, not what waits.
  const head = when ? `Last search ${shortWhen(when) || fmtDateTime(when)}` : "No search yet";
  // IMP3 (the sketch's "Everything from GPEXE is imported."): only after a search that succeeded, with nothing ready,
  // nothing that needs the person and at least one session imported - never after a failed, stopped or unknown search,
  // and never from a list read before that search ended.
  const imported = list.filter((c) => inboxBucket(c, gx) === "imported").length;
  // The list must have been read after that search ended (a failed re-read keeps an older list).
  const searchOk = check?.status === "succeeded" && gx.candidatesCheckId === check.id && !gx.error
    && !gx.checkStarting && !gx.checkError && !gx.pollStopped;
  if (gx.candidates && searchOk && !ready && !needs && imported) return `Everything from GPEXE is imported · ${head}`;
  const parts = [head];
  if (gx.candidates) {
    parts.push(`${ready} ready`);
    if (needs) parts.push(`${needs} need${needs === 1 ? "s" : ""} you`);
  }
  return parts.join(" · ");
}

function renderSourceCardHtml(source, gx, status) {
  const connected = Boolean(status.settings);
  const check = gx.check || status.lastCheck;
  const running = Boolean(gx.checkStarting || check?.status === "running");
  const canFind = connected && !running;
  const list = gx.candidates || [];
  // A step that needs other dates (a stale review, an expired snapshot)
  // opens the dates and fills them in, so "find again" is one click.
  const dated = datesNeededFor(list, gx);
  return `
    <section class="gpexe-panel imports-source imports-banner" aria-label="Data source ${escapeAttr(source.name)}">
      <div class="imports-statusbar" role="group" aria-label="Import state">
        ${connected
          ? `<p class="imports-facts imports-lastsearch">${escapeHtml(bannerText(gx, check))}</p>
             <div class="imports-actions"><button type="button" class="${groupLeads(gx, status) ? "plain-button" : "primary-button"} gpexe-button" data-action="training-load-gpexe-check" ${canFind ? "" : "disabled"}>${running ? "Finding..." : "Find new sessions"}</button></div>`
          : `<p class="gpexe-warning">This team is not connected to a data source yet. A platform admin connects it in Settings &gt; Data sources.</p>`}
      </div>
      ${connected ? `
        <details class="imports-dates" ${dated ? "open" : ""}>
          <summary>Choose dates</summary>
          <div class="imports-dates-fields">
            <label class="gpexe-date"><span>From</span><input type="date" data-gpexe-field="from" value="${escapeAttr(dated?.from || "")}" ${running ? "disabled" : ""}></label>
            <label class="gpexe-date"><span>To</span><input type="date" data-gpexe-field="to" value="${escapeAttr(dated?.to || "")}" ${running ? "disabled" : ""}></label>
          </div>
          <p class="muted gpexe-hint">${dated ? escapeHtml(datedHintText(dated).trim()) : "Leave the dates empty to search the last 14 days."}</p>
        </details>
      ` : ""}
      ${gx.checkError ? `<div class="gpexe-error" role="alert"><p>${escapeHtml(checkErrorText(gx.checkError))}</p>${errorTech(gx.checkError)}</div>` : ""}
      ${check && check.status !== "succeeded" ? renderCheckSummaryHtml(check, source) : ""}
    </section>
  `;
}

// The Search tab ("Search & settings" for whoever has Import settings): what the source is, what the last search
// read, the environment's and the team's switch, Technical details, Import settings, and the setup guide once set up.
function renderSearchTabHtml(source, gx, status) {
  const sw = status.importSwitch || {};
  const viewer = status.viewer || {};
  const connected = Boolean(status.settings);
  const check = gx.check || status.lastCheck;
  const list = gx.candidates || [];
  const importOn = Boolean(sw.enabled) && status.teamImportSwitch?.enabled !== false;
  return `
    <section class="gpexe-panel imports-search" aria-label="Search details">
      <p class="imports-facts">
        <strong>${escapeHtml(source.name)}</strong>
        <span class="imports-state ${connected ? "is-on" : "is-off"}">${connected ? "Connected" : "Not connected"}</span>
        ${connected ? `<span class="imports-state ${importOn ? "is-on" : "is-off"}">${importOn ? "Import on" : "Import off"}</span>` : ""}
      </p>
      ${connected ? `<p class="muted imports-honest">Finding sessions does not import anything; you choose what to import.</p>` : ""}
      ${connected ? renderFoundHtml(check, list.filter((c) => !isHiddenVersion(c, gx)).length, source.name) : ""}
      ${sw.enabled ? "" : `<p class="gpexe-switch is-off"><strong>Importing is switched off in this environment.</strong></p>`}
      ${renderTeamSwitchLineHtml(status, Boolean(gx.teamSwitch?.data?.canManage), Boolean(gx.teamSwitch?.data?.canChangeMode || gx.teamSwitch?.data?.mode === "team"))}
      ${techHtml([
        ["Source", source.key],
        [`${source.name} team id`, status.settings?.gpexeTeamId],
        ["Approval basis", viewer.approvalBasis || (viewer.canApprove ? "yes" : "none")],
        ["Last check id", check?.id],
        ["Last check status", check?.status],
        // A failed check's own reason, beside its status (the code the
        // server shows this viewer: precise for an administrator, the stable
        // connection code for a coach). Never the switch sentence below.
        ["Last check code", check?.status === "failed" ? check.error?.code : undefined],
        ["Last check message", check?.status === "failed" ? check.error?.message : undefined],
        // The import switch's state, whatever the check did: a check never
        // depends on it (it only blocks approving).
        ["Import switch", sw.message],
      ])}
    </section>
    ${renderImportSettingsHtml(gx)}
    ${setupOpen(gx, status) ? "" : renderGuideHtml(gx, status)}
  `;
}

// The setup guide sits above the banner while setting up is not finished (connect and approve, the variables, the
// first search); after that it lives in the Search tab. A search in progress does not count as unfinished.
function setupOpen(gx, status) {
  if (!gx.guide || !status) return false;
  const g = gx.guide;
  if (g.confirm || g.write) return true;
  const { steps, variables } = guideSteps(guideFacts(gx, status));
  const early = steps.filter((st) => st.id <= 3 || st.merged);
  if (early.some((st) => st.state !== "done" && st.state !== "running")) return true;
  return Boolean(variables && variables.state !== "done" && variables.state !== "none");
}

// IMP1: one row of tabs under the banner, one tab at a time. The tab is kept in state (a search repaints every 2 s);
// until the person picks one it is "Needs you" when something needs them, otherwise "Ready" - fixed at the first paint
// with sessions, so a repaint never moves it. data-import-tab, never data-tab: that one is the app's main navigation.
const IMPORT_TABS = ["attention", "ready", "imported", "out", "athletes", "search"];

export function importsTab(gx) {
  if (IMPORT_TABS.includes(gx.tab)) return gx.tab;
  const needs = (gx.candidates || []).some((c) => inboxBucket(c, gx) === "attention");
  const tab = needs ? "attention" : "ready";
  // Fixed at the first paint that has sessions: an empty list (before the first search) decides nothing yet.
  if (gx.candidates?.length) gx.tab = tab;
  return tab;
}

function renderImportsTabsHtml(gx, status) {
  const all = gx.candidates || [];
  const count = (name) => all.filter((c) => inboxBucket(c, gx) === name).length;
  const unlinked = (gx.sourceAthletes || []).filter((a) => a.status === "unlinked").length;
  const tab = importsTab(gx);
  const tabs = [
    ["attention", `Needs you (${count("attention")})`],
    ["ready", `Ready (${count("ready")})`],
    ["imported", `Imported (${count("imported")})`],
    ["out", `Stays out (${count("out")})`],
    ["athletes", unlinked ? `Athletes (${unlinked} not linked)` : "Athletes"],
    ["search", renderTeamSwitchPanelHtml(gx) ? "Search & settings" : "Search"],
  ];
  return `
    <nav class="om-tabs imports-tabs" aria-label="Imports">
      ${tabs.map(([key, label]) => `<button type="button" class="om-tab${key === tab ? " is-active" : ""}"${key === tab ? ' aria-current="page"' : ""} data-action="training-load-gpexe-tab" data-import-tab="${key}">${escapeHtml(label)}</button>`).join("")}
    </nav>
    <div class="imports-tab-panel" data-imports-tab="${tab}">
      ${tab === "athletes" ? renderLinksHtml(gx) : tab === "search" ? renderSearchTabHtml(IMPORT_SOURCES[0], gx, status) : renderBucketsHtml(gx, status, tab)}
    </div>
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
    // U6a-2: a review made before a link change is updated in the review itself (J20-A1), not by a new search.
    return !c.snapshot?.available || notConfirmedForImport(c);
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
export function checkErrorText(error) {
  if (error.code === "check_already_running") return "Sessions are already being found for this team. Wait for it to finish.";
  // The team's source connection (F3c2g / F3c3): the server's own sentence
  // already says what a coach may know - contact an administrator.
  // P2: the server's sentence for the platform admin; the coach and the club admin read who to ask.
  if (error.code === "source_connection_unavailable") return platformViewer() ? error.message || "The team's source connection cannot be used right now; contact an administrator." : connectionUnusableText(error.data?.reason);
  if (error.code === "invalid_window") return "Check the dates: From must not be after To, To must not be in the future, and at most 31 days can be searched at once.";
  if (error.code === "gpexe_token_missing") return "OptiMove has no access to GPEXE set up yet. Ask a platform admin to set it up.";
  if (error.code === "gpexe_team_not_configured") return "This team is not connected to a GPEXE team yet. Ask a platform admin to connect it in Settings > Data sources.";
  return "Finding new sessions could not start. Try again in a moment.";
}

// "2:05": the time since a search started (a render reads the clock; the poll repaints it).
function elapsedText(startedAt) {
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just started";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} elapsed`;
}

export function renderCheckSummaryHtml(check, source = IMPORT_SOURCES[0]) {
  const counts = `${plural(check.sessionsSeen, "session", "sessions")} in ${source.name}: ${check.candidatesNew} not seen by OptiMove before, ${check.candidatesChanged} changed, ${check.candidatesUnchanged} unchanged`;
  if (check.status === "running") {
    const gx = state.trainingLoad.gpexe;
    // J19 U1: the total is not known before the end, so the bar is indeterminate;
    // what is known is shown beside it: the sessions read so far and the time.
    const stopped = Boolean(gx?.pollStopped);
    return `<div class="gpexe-check-progress"><p class="gpexe-check-state" role="status">Reading sessions from ${escapeHtml(source.name)}... ${escapeHtml(plural(check.sessionsSeen ?? 0, "session", "sessions"))} found so far.</p>${check.startedAt && !stopped ? `<p class="muted gpexe-elapsed" aria-hidden="true">${escapeHtml(elapsedText(check.startedAt))}</p>` : ""}<div class="gpexe-progress-bar${stopped ? " is-stopped" : ""}" role="progressbar" aria-label="Finding sessions" aria-busy="${stopped ? "false" : "true"}"><span></span></div>${stopped ? "" : `<p class="muted gpexe-leave-note">You can leave this page.</p>`}${gx?.pollNote ? `<p class="gpexe-notice" role="status">${escapeHtml(gx.pollNote)}</p>` : ""}${gx?.pollStopped ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-refresh-status">Refresh status</button>` : ""}</div>`;
  }
  // A finished search is rendered by renderFoundHtml.
  // A failed search through the team's source connection is not "try again":
  // a coach sees the stable code and contacts an administrator; an
  // administrator sees the precise code and acts under Settings > Source
  // connections (F3c3).
  const code = check.error?.code || "";
  const connection = code === "source_connection_unavailable";
  const connectionFact = CONNECTION_FACT.test(code);
  const next = connection
    ? (platformViewer() ? "The team's source connection cannot be used right now; contact an administrator." : connectionUnusableText(check.error?.reason))
    : connectionFact
      ? (platformViewer() ? "The team's source connection could not be used (the code is under Technical details); an administrator acts under Settings > Source connections."
        // The club admin's own step (O1 exception: Source connections keeps what its step needs); a coach never gets a precise code.
        : connectionUnusableText(code))
      : "Try again in a moment.";
  return `<div class="gpexe-error" role="alert"><p>The last search (${escapeHtml(fmtDateTime(check.startedAt))}) did not finish. ${next}</p>${techHtml([["Code", check.error?.code], ["Server message", check.error?.message]])}</div>`;
}

// ---------------------------------------------------------------------------
// The inbox: four buckets, from what the coach has to do
// ---------------------------------------------------------------------------

// The one step for a list reason, and the short fact the row shows for it.
function reasonStep(r) {
  const n = r.count || 0;
  switch (r.code) {
    case "no_linked_athlete": return "No linked athlete in this session yet - open it and link the athletes from their rows.";
    case "athletes_not_linked": return `${plural(n, "recorded athlete is", "recorded athletes are")} not linked yet - open it and link them from their rows.`;
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

function findAgainText(list) {
  const dates = list.map((c) => c.sessionStartedAt).filter(Boolean).sort();
  if (!dates.length) return "Find new sessions again";
  const from = formatDate(dates[0]);
  const to = formatDate(dates[dates.length - 1]);
  return `Find new sessions again${from === to ? ` (with dates that include ${from})` : ` (with dates from ${from} to ${to})`}`;
}

// Why the Ready sessions cannot be imported right now, or "" when they can.
// U6a: said once, under the state bar's main button, so the coach never reads an
// import instruction that the next screen refuses.
function reviewOnlyText(status) {
  const sw = status.importSwitch || {};
  const viewer = status.viewer || {};
  if (!sw.enabled) return "Review only - importing waits until it is turned on in this environment.";
  // U2 (v56): the team's own switch comes before the person's right.
  if (status.teamImportSwitch && status.teamImportSwitch.enabled !== true) return "Review only - imports are switched off for this team.";
  if (!viewer.canApprove) return status.teamImportSwitch?.mode === "team"
    ? "Review only - an approver imports these (the club administrator, a coach of this team, or a platform admin)."
    : "Review only - an approver imports these (a platform admin, or a coach with approval rights for this team).";
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
  let text;
  if (!status.settings) text = "A platform admin needs to connect this team to a data source (Settings > Data sources).";
  else if (gx.checkStarting || check?.status === "running") text = "Finding new sessions...";
  // U6a / U6a-2: what the state bar and the attention groups below already say is not repeated here.
  else if (stale.length || unlinkedAthletes || attention) text = "";
  // The review-only reason is said once, under the main button (renderDailyStripHtml).
  else if (ready.length) text = "";
  else if (!list.length && check?.status === "succeeded") text = `No sessions in ${source.name} for ${formatDate(check.window?.from)} - ${formatDate(check.window?.to)}. Choose other dates and find again.`;
  // A failed search is not "nothing found": its reason is in the box above.
  else if (!list.length && check?.status === "failed") text = "The last search did not finish - its reason is in the box above.";
  else if (!list.length) text = "Nothing found yet. Find new sessions to see what the source has.";
  else text = "Nothing needs attention. Find new sessions to see what's new.";
  return text ? `<p class="gpexe-next" role="status">${escapeHtml(text)}</p>` : "";
}

// One sentence per attention row: what is in the way and the one step.
function attentionText(c, status, gx = state.trainingLoad.gpexe) {
  if (isUncertain(c, gx)) return "Import result not confirmed yet - open it to check the result.";
  if (!c.snapshot?.available) return `Needs a fresh search - find new sessions${c.sessionStartedAt ? ` with dates that include ${formatDate(c.sessionStartedAt)}` : ""}.`;
  if (c.status === "blocked") return c.blockedCode ? blockedCoachText(c).step : "Open it to see what is in the way.";
  if (notConfirmedForImport(c)) return notConfirmedStep(c);
  if (reviewMadeBeforeLinkChange(c, gx)) return "Athlete links changed after this review was made - open it and update the review.";
  // The first reason is the coach's own step (linking comes first); the
  // row's facts name every reason.
  const [first] = rowReasons(c);
  return first ? reasonStep(first) : "Open it to see what to do.";
}

// IMP1: one tab's sessions. A light list (1 px lines); a Ready row carries a "Ready" pill, a row that needs the person
// the one step of its group. "Pick a day" (the calendar) sits above the list of Needs you, Ready and Imported.
function renderBucketsHtml(gx, status, tab = "ready") {
  const all = gx.candidates || [];
  const day = gx.calendar?.day || "";
  const list = calendarFiltered(all, gx);
  const of = (name) => list.filter((c) => inboxBucket(c, gx) === name);
  const rows = (items, kind, group = "", pick = false) => `<ul class="gpexe-candidate-list">${items.map((c) => renderSessionRowHtml(c, status, kind, pick, group)).join("")}</ul>`;
  if (tab === "attention") {
    // U6a-2: the groups cover the whole list, like the counts; the day filter narrows the other tabs only.
    const allAttention = all.filter((c) => inboxBucket(c, gx) === "attention");
    const groups = attentionGroups(allAttention, gx);
    // IMP1: what is ready waits a tab away - one quiet line says so and opens it (local, nothing is sent).
    const readyCount = all.filter((c) => inboxBucket(c, gx) === "ready").length;
    const readyHint = readyCount ? `<p class="imports-ready-hint">${escapeHtml(plural(readyCount, "session is", "sessions are"))} ready to import. <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-tab" data-import-tab="ready">Show ready</button></p>` : "";
    return `
      ${readyHint}
      ${renderCalendarHtml(gx)}
      ${allAttention.length ? `
        <section class="gpexe-panel gpexe-group is-decision imports-bucket" aria-label="Needs attention">
          <div class="gpexe-panel-head imports-tab-title"><h3>Needs you (${allAttention.length})</h3></div>
          ${day ? `<p class="muted">These cover every date, not only the day you picked.</p>` : ""}
          ${groups.map((grp, i) => renderAttentionGroupHtml(grp, gx, status, rows, i === 0 && groupLeads(gx, status))).join("")}
        </section>
      ` : `<section class="gpexe-panel imports-bucket-empty"><p class="muted">Nothing needs you.</p></section>`}
    `;
  }
  if (tab === "ready") {
    const ready = of("ready");
    const pickable = batchAllowed(gx);
    const daily = dailyImportState(gx, status);
    const choosing = pickable && chooseOpen(gx);
    return `
      ${renderCalendarHtml(gx)}
      <section class="gpexe-panel gpexe-group imports-bucket" aria-label="Ready to import">
        <div class="gpexe-panel-head imports-tab-title"><h3>Ready to import (${ready.length})</h3></div>
        ${gx.batch?.dropped ? `<p class="gpexe-notice" role="status">${escapeHtml(gx.batch.dropped)}</p>` : ""}
        ${gx.batch?.error && !gx.batch.confirming ? `<div class="gpexe-refused" role="alert"><p>${escapeHtml(batchRefusalText(gx.batch.error))}</p>${errorTech(gx.batch.error)}</div>` : ""}
        ${ready.length ? rows(ready, "ready", "", choosing) : `<p class="muted">${day ? "No session of this day is ready to import." : "Nothing is ready to import."}</p>`}
        ${daily.n ? `<div class="imports-import-row"><button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-import-ready" ${gx.batch?.sending ? "disabled" : ""}>${escapeHtml(daily.label)}</button></div>` : ""}
        ${renderDailyStripHtml(gx, daily.ready, status)}
        ${pickable && (ready.some((c) => batchSelectable(c, gx)) || Object.keys(gx.batch?.selected || {}).length > 0) ? `
          <details class="imports-choose" data-rendered-open="${choosing ? "1" : "0"}" ${choosing ? "open" : ""}>
            <summary>Choose sessions</summary>
            ${renderSelectBarHtml(gx, ready)}
          </details>
        ` : ""}
      </section>
    `;
  }
  if (tab === "imported") {
    const imported = of("imported");
    return `
      ${renderCalendarHtml(gx)}
      <section class="gpexe-panel gpexe-group imports-bucket" aria-label="Imported">
        <div class="gpexe-panel-head imports-tab-title"><h3>Imported (${imported.length})</h3></div>
        ${imported.length ? rows(imported, "imported") : `<p class="muted">${day ? "No session of this day is imported." : "Nothing is imported yet."}</p>`}
      </section>
    `;
  }
  const out = all.filter((c) => inboxBucket(c, gx) === "out");
  // v33: a withdrawn session is listed only under "Show replaced or no longer found versions" - while the versions are
  // folded away the server lists no superseded row at all, so the default view cannot count or name it.
  const replaced = all.filter((c) => isHiddenVersion(c, gx));
  return `
    <section class="gpexe-panel gpexe-group imports-bucket" aria-label="Stays out">
      <div class="gpexe-panel-head imports-tab-title"><h3>Stays out (${out.length})</h3></div>
      <p class="muted">Session types OptiMove does not import. Nothing to do.</p>
      ${out.length ? rows(out, "out") : `<p class="muted">No session stays out.</p>`}
      <div class="gpexe-replaced-toggle"><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-superseded" aria-pressed="${gx.includeSuperseded ? "true" : "false"}">${gx.includeSuperseded ? "Hide replaced or no longer found versions" : "Show replaced or no longer found versions"}</button></div>
      ${gx.includeSuperseded && replaced.length ? `<h4>Replaced or no longer found versions (${replaced.length})</h4>${rows(replaced, "hidden")}` : ""}
    </section>
  `;
}

// U6a-2: one group of sessions that need a person - the kind of problem, one sentence, how many, and ONE button.
// The sessions are folded inside; a group of one shows its session. The button opens the group's first session, and
// the review steps through the group (J20 section 8); "Needs a new search" finds new sessions for the dates it names,
// and sends exactly those dates.
function renderAttentionGroupHtml(grp, gx, status, rows, lead = false) {
  const cls = lead ? "primary-button" : "plain-button";
  let button;
  if (grp.key === "fresh") {
    const dated = datesNeededFor(gx.candidates || [], gx);
    const range = dated ? (dated.from === dated.to ? formatDate(dated.from) : `${formatDate(dated.from)} - ${formatDate(dated.to)}`) : "";
    const running = Boolean(gx.checkStarting || (gx.check || status.lastCheck)?.status === "running");
    button = `<button type="button" class="${cls} gpexe-button" data-action="training-load-gpexe-check"${dated ? ` data-from="${escapeAttr(dated.from)}" data-to="${escapeAttr(dated.to)}"` : ""} ${status.settings && !running ? "" : "disabled"}>${escapeHtml(range ? `Find again for ${range}` : "Find again")}</button>`;
  } else {
    button = `<button type="button" class="${cls} gpexe-button" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(grp.first.id)}" data-group="${escapeAttr(grp.key)}">${escapeHtml(grp.button)}</button>`;
  }
  const sessions = grp.count > 1
    ? `<details class="imports-attn-sessions"><summary>Show the ${escapeHtml(plural(grp.count, "session", "sessions"))}</summary>${rows(grp.items, "attention", grp.key)}</details>`
    : rows(grp.items, "attention", grp.key);
  return `
    <div class="imports-attn-group" data-attention-group="${escapeAttr(grp.key)}">
      <div class="imports-attn-head"><h4>${escapeHtml(grp.title)}</h4><span class="imports-attn-count">${escapeHtml(plural(grp.count, "session", "sessions"))}</span></div>
      <p>${escapeHtml(grp.sentence)}</p>
      <div class="imports-attn-actions">${button}</div>
      ${sessions}
    </div>`;
}

// U6a-2: with nothing ready to import, the first group's button is the screen's one main action when it is a step the
// person can take now (check a result, link athletes, update a review); a new search would not fix those. Otherwise the
// state bar's button stays the main one.
const LEADING_GROUPS = new Set(["unknown", "unlinked", "stale"]);
const STEP_IN_GROUP = new Set(["unknown", "unlinked", "stale", "fresh"]);
function groupLeads(gx, status) {
  // IMP1: on the Needs you tab the Import button is a tab away, so the first group's step leads there either way.
  if (dailyImportState(gx, status).n && importsTab(gx) !== "attention") return false;
  const first = attentionGroups((gx.candidates || []).filter((c) => inboxBucket(c, gx) === "attention"), gx)[0];
  return Boolean(first && LEADING_GROUPS.has(first.key));
}

// One line per session: what it is, when, and - only where the coach has to
// do something - the one step. No ids, no hashes, no internal statuses. A
// Ready row that can go into a batch gets a checkbox beside the row (the
// row itself still opens the review); choosing only stages it.
function renderSessionRowHtml(c, status, kind, pick = false, group = "") {
  const counts = c.counts || {};
  const facts = [];
  if (kind === "ready" || kind === "attention") {
    if (counts.created) facts.push(plural(counts.created, "new result", "new results"));
    if (kind === "ready" && counts.unchanged) facts.push(plural(counts.unchanged, "result unchanged", "results unchanged"));
    // D32: values left out are named before an approval, never imported silently.
    if (kind === "ready" && Number(counts.skippedValues) > 0) facts.push(plural(counts.skippedValues, "value left out", "values left out"));
    // Every reason stays visible even though the step sentence names one.
    if (kind === "attention") for (const r of rowReasons(c)) if (reasonFact(r)) facts.push(reasonFact(r));
  }
  if (kind === "imported") {
    if (c.importedAt) facts.push(`imported ${fmtDateTime(c.importedAt)}`);
    else facts.push("nothing new");
  }
  const gx = state.trainingLoad.gpexe;
  // P3: one problem is said once. In a group whose sentence and button already give the step, the row gives only its
  // facts; a group whose sessions differ ("Needs a look", "Problem in the GPEXE data") keeps each row's own step.
  let step = kind === "attention" && !STEP_IN_GROUP.has(group) ? attentionText(c, status) : "";
  if (kind === "hidden" && withdrawnByCheck(c)) step = withdrawnText(c);
  // A hidden version says which kind it is (replaced, or no longer found);
  // a session the last successful search did not confirm says so too (v33).
  const badge = isUncertain(c, gx)
    ? `<span class="gpexe-badge is-unknown">Result not confirmed</span>`
    : (kind === "hidden" || (kind === "attention" && notConfirmedForImport(c))) ? badgeHtml(c, gx) : "";
  // IMP1: a Ready row ends with a "Ready" pill, as in the sketch. A row that needs the person carries no label of its
  // own: its group already has the one button and the row its step (a label would say the step a third time, and the
  // "fresh" group's button starts a search, which the row does not).
  const rowEnd = kind === "ready" && !badge ? `<span class="imports-row-pill is-ready">Ready</span>` : "";
  let box = "";
  if (pick && batchSelectable(c, gx)) {
    const checked = Object.hasOwn(gx.batch.selected, c.id);
    const full = !checked && Object.keys(gx.batch.selected).length >= BATCH_MAX;
    box = `<label class="imports-pick"><input type="checkbox" data-action="training-load-gpexe-pick" data-candidate-id="${escapeAttr(c.id)}" aria-label="Select ${escapeAttr(niceSessionName(c))} ${escapeAttr(fmtDateTime(c.sessionStartedAt))}" ${checked ? "checked" : ""} ${full || gx.batch.sending ? "disabled" : ""}></label>`;
  }
  return `
    <li class="${box ? "imports-pick-row" : ""}">
      ${box}
      <button type="button" class="gpexe-candidate" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(c.id)}"${group ? ` data-group="${escapeAttr(group)}"` : ""}>
        <span class="gpexe-candidate-main">
          <strong>${escapeHtml([sessionDayText(c.sessionStartedAt), niceSessionName(c)].filter(Boolean).join(" · "))}</strong>
          <span class="muted">${escapeHtml([sessionTimeText(c.sessionStartedAt) || fmtDateTime(c.sessionStartedAt), ...sessionSizeFacts(c)].filter(Boolean).join(" · "))}</span>
        </span>
        ${badge}
        ${rowEnd}
        ${facts.length ? `<span class="gpexe-candidate-facts">${escapeHtml(facts.join(" · "))}</span>` : ""}
        ${step ? `<span class="gpexe-candidate-next">${escapeHtml(step)}</span>` : ""}
      </button>
    </li>
  `;
}

// ---------------------------------------------------------------------------
// Batch import (Imports phase 4b): choosing Ready sessions, the confirmation,
// the result. Nothing is sent before "Import N sessions"; then exactly one
// request for the whole selection.
// ---------------------------------------------------------------------------

// The selection summary and its controls, above the Ready rows. "Select
// all" when every visible session fits; "Select first N" when they don't -
// the list's order decides which, never a hidden one.
// J19 U1: the daily line - what is ready, what needs the coach, and one button
// for the ready ones (the existing review and confirmation, up to BATCH_MAX).
// U6a: what the one main button does. "Import N ready" when clean Ready sessions can go in one batch, otherwise nothing
// (the button of the state bar is then "Find new sessions"). Shared by the state bar and the notes under it.
function dailyImportState(gx, status = gx.status) {
  const ready = (gx.candidates || []).filter((c) => inboxBucket(c, gx) === "ready");
  const allowed = batchAllowed(gx);
  const pickable = allowed ? ready.filter((c) => batchSelectable(c, gx)) : [];
  const n = Math.min(pickable.length, BATCH_MAX);
  const label = pickable.length > BATCH_MAX ? `Import the first ${BATCH_MAX} ready sessions` : `Import ${plural(n, "ready session", "ready sessions")}`;
  return { ready, allowed, pickable, n, label, reviewOnly: !allowed && ready.length ? reviewOnlyText(status) : "" };
}

// The notes that belong to the main button: sessions that stay for the next batch, ones that must be opened, why importing is not offered.
function renderDailyStripHtml(gx, ready, status = gx.status) {
  if (!ready.length) return "";
  const d = dailyImportState(gx, status);
  const notes = [];
  if (d.pickable.length > BATCH_MAX) notes.push(`${plural(d.pickable.length - BATCH_MAX, "more session stays", "more sessions stay")} for the next batch.`);
  if (d.allowed && d.pickable.length < ready.length) notes.push(`${plural(ready.length - d.pickable.length, "ready session has", "ready sessions have")} to be opened and reviewed on ${ready.length - d.pickable.length === 1 ? "its" : "their"} own.`);
  if (gx.calendar?.day && d.n) notes.push(`${d.label} takes ready sessions of every date, not only of the day you picked.`);
  // U6a: the one place the review-only reason is said, from the whole list (a day filter never hides it).
  if (d.reviewOnly) notes.push(d.reviewOnly);
  if (!notes.length) return "";
  return `<div class="imports-daily" role="group" aria-label="Import summary">${notes.map((t) => `<p class="muted">${escapeHtml(t)}</p>`).join("")}</div>`;
}

function renderSelectBarHtml(gx, visibleReady) {
  if (!batchAllowed(gx)) return "";
  const selectable = visibleReady.filter((c) => batchSelectable(c, gx));
  const total = Object.keys(gx.batch.selected).length;
  if (!selectable.length && !total) return "";
  const visibleSelected = visibleReady.filter((c) => Object.hasOwn(gx.batch.selected, c.id)).length;
  const hidden = total - visibleSelected;
  const room = Math.max(0, BATCH_MAX - total);
  const unselected = selectable.filter((c) => !Object.hasOwn(gx.batch.selected, c.id));
  const all = room === 0 || unselected.length <= room;
  const left = all ? 0 : unselected.length - room;
  const busy = gx.batch.sending ? "disabled" : "";
  return `
    <div class="imports-select-bar" role="group" aria-label="Import several sessions">
      <p class="imports-select-summary" role="status"><strong>${total} selected</strong> · maximum ${BATCH_MAX}${hidden ? ` · ${plural(hidden, "selected session is", "selected sessions are")} hidden by the date filter` : ""}${room === 0 ? " · maximum reached, import these first" : ""}</p>
      <div class="imports-select-actions">
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-batch-select" ${unselected.length && room ? "" : "disabled"} ${busy}>${all ? "Select all" : `Select first ${room}`}</button>
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-batch-clear" ${total ? "" : "disabled"} ${busy}>Clear selection</button>
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-batch-review" ${total ? "" : "disabled"} ${busy}>Review ${total ? plural(total, "session", "sessions") : "sessions"}</button>
      </div>
      ${left ? `<p class="muted imports-select-left">${plural(left, "more session stays", "more sessions stay")} for the next batch.</p>` : ""}
    </div>
  `;
}

// What the batch answer means for one session, in the coach's words, and
// the one thing to do next. Every code is the server's stable one.
function batchOutcomeText(r) {
  const o = r.outcome;
  if (o === "imported") return { cls: "is-imported", text: r.commitConfirmation === "verified_after_commit_error" ? "Imported (the confirmation arrived late, but the import is in OptiMove)." : "Imported." };
  if (o === "already_imported") return { cls: "is-imported", text: "Already imported, nothing more was written." };
  if (o === "import_outcome_unknown") return { cls: "is-unknown", text: "Import result not confirmed - check it before doing anything else. Don't enter the data by hand and don't assume either way.", check: true };
  if (o === "not_attempted" && r.code === "batch_time_budget") {
    const b = state.trainingLoad.gpexe?.batch || {};
    // U6a-3: while the import goes on, every such row belongs to the request in flight: never "not saved" before its answer.
    if (b.sending) return { cls: "is-skipped", text: b.stopRequested ? "Being imported now - the result follows." : "Waiting: it will be imported automatically." };
    const why = b.stopReason === "stop" ? "Not imported: you stopped the import."
      : b.stopReason === "person" ? "Not imported: the import stopped at a session that needs you."
      : b.stopReason === "left" ? "Not imported: the import stopped when you left Imports."
      : b.stopReason === "cap" ? "Not imported yet: the import stops after 30 rounds."
      : "Not imported yet: time ran out.";
    return { cls: "is-skipped", text: `${why} Nothing was saved for this session - import it again from the Ready list.` };
  }
  if (o === "not_attempted") return { cls: "is-skipped", text: "Not imported: the import stopped before this session. Nothing was saved - import it again from the Ready list." };
  const code = r.code;
  if (code === "preview_changed") return { cls: "is-refused", text: "Session changed - review it again.", open: r.reviewAgain?.candidateId || r.candidateId, openLabel: "Review again" };
  if (code === "changes_need_acceptance") return { cls: "is-refused", text: "Open and review the changes individually.", open: r.candidateId, openLabel: "Open" };
  if (code === "superseded_by_newer_data") return { cls: "is-refused", text: "Not imported: GPEXE has newer data for this session - open the newer version.", open: r.reviewAgain?.candidateId, openLabel: "Open the newer version" };
  if (code === "candidate_not_actionable") return { cls: "is-refused", text: "Not imported: this session is not confirmed for import - find new sessions again, then review it.", open: r.candidateId, openLabel: "Open" };
  if (code === "not_ready") return { cls: "is-refused", text: "Not imported: it is not ready any more - see its row under Needs attention.", open: r.candidateId, openLabel: "Open" };
  if (code === "blocked") return { cls: "is-refused", text: "Not imported: this session must be fixed first - open it to see what.", open: r.candidateId, openLabel: "Open" };
  if (code === "snapshot_expired_check_again") return { cls: "is-refused", text: "Not imported: the GPEXE data is too old. Find new sessions, then import it." };
  if (code === "nothing_to_import") return { cls: "is-refused", text: "Nothing to import: GPEXE has nothing new for this session." };
  if (code === "import_switch_off") return { cls: "is-refused", text: "Not imported: importing was switched off in this environment." };
  if (code === "team_import_switch_off") return { cls: "is-refused", text: `Not imported: imports were switched off for this team. ${switchOnWho()}` };
  if (code === "not_an_approver") return { cls: "is-refused", text: platformViewer() ? "Not imported: you may not approve imports for this team any more. Ask a platform admin." : `Not imported: you can't import for this team any more. ${AskWho()}.` };
  if (code === "internal_error") return { cls: "is-refused", text: "Not imported: the server failed before writing anything. Try again later." };
  if (code === "try_again") return { cls: "is-refused", text: "Not imported: another check, import or change of this team was running, or the server was busy. Try again in a moment." };
  if (code === "notFound") return { cls: "is-refused", text: "Not imported: this session is not available." };
  return { cls: "is-refused", text: "Not imported: the server refused it. Open the session to see what to do.", open: r.candidateId, openLabel: "Open" };
}

// U6a-3: a whole request refused after earlier requests of the same import already wrote: why it stopped, never "nothing
// was imported" (the rows above say what was).
function batchStoppedText(error) {
  const code = error?.code;
  const why = code === "import_switch_off" ? "importing was switched off in this environment"
    : code === "team_import_switch_off" ? "imports were switched off for this team"
    : code === "not_an_approver" ? "you may not approve imports for this team any more"
    : error?.status === 404 ? "one of the sessions is not available in this team any more"
    : error?.status === 400 ? "the selection is out of date"
    : code === "internal_error" ? "the server failed"
    : "the server refused the next sessions";
  return `The import stopped before the rest of the sessions: ${why}. The sessions marked Imported below are in OptiMove; the others were not imported and stay under Ready.`;
}

// The sentence of the whole refusal (nothing was tried), by the server's code.
function batchRefusalText(error) {
  const code = error?.code;
  if (code === "import_switch_off") return "Not imported: importing is switched off in this environment.";
  if (code === "team_import_switch_off") return `Not imported: imports are switched off for this team. ${switchOnWho()}`;
  if (code === "not_an_approver") return platformViewer() ? "Not imported: you may not approve imports for this team. Ask a platform admin to approve them or to give you the right." : `Not imported: you can't import for this team. ${AskWho()}.`;
  if (error?.status === 404) return "Not imported: one of the sessions is not available in this team any more. Find new sessions, then choose again.";
  if (code === "internal_error") return "Not imported: the server failed before writing anything. Try again later.";
  if (error?.status === 400) return "Not imported: the selection is out of date. Choose the sessions again.";
  return "Not imported: the server refused the request. Nothing was imported.";
}

function batchSummaryText(summary) {
  if (!summary) return "";
  const parts = [];
  if (summary.imported) parts.push(plural(summary.imported, "imported", "imported"));
  if (summary.alreadyImported) parts.push(`${summary.alreadyImported} already imported`);
  if (summary.refused) parts.push(`${summary.refused} not imported`);
  if (summary.unknown) parts.push(`${summary.unknown} not confirmed`);
  if (summary.notAttempted) parts.push(`${summary.notAttempted} not tried`);
  return parts.join(" · ");
}

// What the confirmation says of one session: its new results and, before the
// approval, the values it leaves out (D32), so a gap is never imported
// silently.
function batchFacts(c) {
  const facts = [];
  if (c?.counts?.created) facts.push(plural(c.counts.created, "new result", "new results"));
  if (Number(c?.counts?.skippedValues) > 0) facts.push(plural(c.counts.skippedValues, "value left out", "values left out"));
  return facts.join(" · ");
}

function batchSessionLine(c, candidateId) {
  if (!c) return `<strong>Session</strong> <span class="muted">(no longer in the list)</span>`;
  return `<strong>${escapeHtml(niceSessionName(c))}</strong> <span class="muted">${escapeHtml(fmtDateTime(c.sessionStartedAt))}</span>`;
}

function renderBatchOverlayHtml(gx) {
  const b = gx.batch;
  if (!b.confirming && !b.results && !b.unknown) return "";
  const busy = b.sending || b.checking ? "disabled" : "";
  let title;
  let body;
  if (b.results || b.unknown) {
    title = b.sending ? "Importing sessions" : b.unknown ? "Import result not confirmed" : "Import result";
    body = renderBatchResultsHtml(gx);
  } else {
    const items = batchSelection(gx);
    title = `Import ${plural(items.length, "session", "sessions")}`;
    body = renderBatchReviewHtml(gx, items);
  }
  const close = b.results || b.unknown ? "training-load-gpexe-batch-done" : "training-load-gpexe-batch-back";
  return `
    <div class="builder-athlete-overlay gpexe-detail-overlay">
      <button type="button" class="builder-athlete-backdrop" data-action="${close}" aria-label="Close" ${busy}></button>
      <section class="panel builder-athlete-picker gpexe-detail imports-batch" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="builder-section-panel-head">
          <h3>${escapeHtml(title)}</h3>
          <button type="button" class="plain-button icon-button builder-athlete-picker-cancel" data-action="${close}" aria-label="Close" ${busy}>&times;</button>
        </div>
        ${renderBatchProgressHtml(b)}
        <div class="gpexe-detail-body">${body}</div>
      </section>
    </div>
  `;
}

// U6a-3: while a long selection goes on in several requests: how far it is, that it goes on by itself, and Stop. It sits between
// the dialog's head and its scrolling body (outside the scroller), so it stays in sight on a long list without sticking.
function renderBatchProgressHtml(b) {
  if (!b.sending || !b.progress || b.progress.total < 2) return "";
  const { total, done, imported = 0 } = b.progress;
  const line = done ? `${done} of ${total} sessions handled - ${imported} imported so far.` : `Working on the first sessions of ${total}...`;
  return `
    <div class="imports-progress" role="group" aria-label="Import progress">
      <p role="status"><strong>${escapeHtml(line)}</strong>${b.stopRequested ? " Stopping - the sessions being imported right now finish first (up to a minute); the rest won't be imported." : ""}</p>
      <div class="imports-progress-bar" role="progressbar" aria-label="Sessions handled" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}"><i style="width:${Math.round((done / total) * 100)}%"></i></div>
      <p class="muted imports-progress-note">It continues automatically until every session is done or one needs you. If you leave Imports, the sessions being imported right now finish and the rest stay under Ready.</p>
      <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-batch-stop" ${b.stopRequested ? "disabled" : ""}>Stop after the current sessions</button>
    </div>`;
}

// The confirmation: every chosen session by name and time, what happens,
// and the one button. No id, hash or code in the open; the ids only under
// Technical details, the hashes nowhere.
function batchTeamName(gx) {
  const team = gpexeTeamOptions().find((t) => String(t.id) === String(gx.teamId));
  return team?.name || "";
}

function renderBatchReviewHtml(gx, items) {
  const b = gx.batch;
  const busy = b.sending ? "disabled" : "";
  // IMP2 (the sketch's one-line confirmation): the question first, the sessions as one light list; the one lasting
  // consequence (a wrong athlete link) stays in sight, how the import runs is folded.
  return `
    <p class="imports-batch-question"><strong>Import ${escapeHtml(plural(items.length, "session", "sessions"))}${batchTeamName(gx) ? ` into ${escapeHtml(batchTeamName(gx))}` : ""}? Their values appear in Training Load right away.</strong></p>
    <ul class="imports-batch-list">
      ${items.map(({ candidate: c }) => `<li>${batchSessionLine(c)}${batchFacts(c) ? `<span class="gpexe-candidate-facts">${escapeHtml(batchFacts(c))}</span>` : ""}</li>`).join("")}
    </ul>
    <p class="muted imports-batch-warning">Results imported under the wrong athlete can't be changed here — contact a platform administrator.</p>
    <details class="imports-batch-more"><summary>What happens</summary><p class="muted">Each session is imported on its own, exactly as found in the last search, so one that can't be imported does not stop the others.</p></details>
    ${b.error ? `<div class="gpexe-refused" role="alert"><p>${escapeHtml(batchRefusalText(b.error))}</p>${errorTech(b.error)}</div>` : ""}
    ${techHtml([["Candidate ids", items.map((i) => i.candidateId).join(", ")], ["GPEXE session names", items.map((i) => i.candidate?.label).filter(Boolean).join("; ")]])}
    <div class="gpexe-link-actions imports-batch-actions">
      <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-batch-back" ${busy}>Cancel</button>
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-batch-send" ${busy || b.error ? "disabled" : ""}>${b.sending ? "Importing..." : `Import ${plural(items.length, "session", "sessions")}`}</button>
    </div>
  `;
}

// One line per session with what happened to it. After a lost answer:
// only what the list shows as imported is confirmed; the rest is "not
// confirmed", never "failed".
function renderBatchResultsHtml(gx) {
  const b = gx.batch;
  const byId = new Map((gx.candidates || []).map((c) => [c.id, c]));
  const busy = b.checking ? "disabled" : "";
  if (b.unknown) {
    const u = b.unknown;
    // U6a-3: what earlier requests of the same import already answered stays in sight above the lost one.
    const earlier = (b.results || []).filter((r) => !u.candidateIds.includes(r.candidateId)).map((r) => {
      const t = batchOutcomeText(r);
      return `<li class="${t.cls}">${batchSessionLine(byId.get(r.candidateId), r.candidateId)}<span class="imports-batch-outcome">${escapeHtml(t.text)}</span></li>`;
    });
    const rows = u.candidateIds.map((id) => {
      const c = byId.get(id);
      const imported = c?.status === "imported";
      return `<li class="${imported ? "is-imported" : "is-unknown"}">${batchSessionLine(c, id)}<span class="imports-batch-outcome">${imported ? "Imported - confirmed by the list." : "Not confirmed yet."}</span></li>`;
    });
    const confirmed = u.candidateIds.filter((id) => byId.get(id)?.status === "imported").length;
    return `
      <div class="gpexe-unknown" role="alert">
        <p><strong>The answer to the import did not arrive${earlier.length ? ` for the last ${plural(u.candidateIds.length, "session", "sessions")}` : ""}.</strong> Some of these sessions may already be imported. Don't enter their data by hand and don't assume either way - check the result.</p>
        <p>${confirmed} of ${u.candidateIds.length} confirmed as imported so far. The rest are not confirmed; nothing is sent again by itself. Sessions that stay unconfirmed keep the mark "Result not confirmed" in the list; open one to check it.</p>
        ${(u.checks || 0) >= GIVE_UP_AFTER_CHECKS ? `<p><strong>Still not confirmed after ${u.checks} checks.</strong> ${platformViewer() ? "Ask a platform admin to check these imports (give them the Technical details)." : `${AskWho()} to check these imports.`} Until then, don't enter the data by hand.</p>` : ""}
        ${techHtml([["HTTP status", u.error?.status || "no answer"], ["Code", u.error?.code], ["Server message", u.error?.message], ["Candidate ids", u.candidateIds.join(", ")]])}
      </div>
      <ul class="imports-batch-list imports-batch-results">${rows.join("")}</ul>
      ${earlier.length ? `<p class="muted">Answered before the answer was lost:</p><ul class="imports-batch-list imports-batch-results imports-batch-earlier">${earlier.join("")}</ul>` : ""}
      <div class="gpexe-link-actions imports-batch-actions">
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-batch-check" ${busy}>${b.checking ? "Checking..." : "Check again"}</button>
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-batch-done" ${busy}>Done</button>
      </div>
    `;
  }
  const rows = (b.results || []).map((r) => {
    const t = batchOutcomeText(r);
    const c = byId.get(r.candidateId);
    const button = t.check
      ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-batch-open" data-candidate-id="${escapeAttr(r.candidateId)}">Check result</button>`
      : t.open ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-batch-open" data-candidate-id="${escapeAttr(t.open)}">${escapeHtml(t.openLabel)}</button>` : "";
    return `<li class="${t.cls}">${batchSessionLine(c, r.candidateId)}<span class="imports-batch-outcome">${escapeHtml(t.text)}</span>${button}</li>`;
  });
  // IMP2: every session's ids and codes in ONE Technical details at the end, not one per row.
  const rowsTech = (b.results || []).map((r) => [`Session ${r.candidateId}`, [byId.get(r.candidateId)?.label, r.outcome, r.code, r.approvalId ? `approval ${r.approvalId}` : ""].filter(Boolean).join(" · ")]);
  // While the import goes on, the sessions not reached yet are "waiting", not "not tried"; the progress block counts.
  const summary = b.sending ? "" : batchSummaryText(b.summary);
  const stopped = b.error ? `<div class="gpexe-refused" role="alert"><p><strong>${escapeHtml(batchStoppedText(b.error))}</strong></p>${errorTech(b.error)}</div>` : "";
  const still = b.sending ? 0 : batchSelection(gx).length;
  // IMP2 (the sketch): "Imported N sessions. You can see them in Training Load → Activities." first, in one line.
  // A mixed result names only the imported ones (the refused ones are not in Activities).
  const seen = !b.sending && (b.summary?.imported || b.summary?.alreadyImported)
    ? ` You can see ${onlyImported(b.summary) ? "them" : "the imported ones"} in Training Load → Activities and in the Imported tab.` : "";
  return `
    ${summary ? `<p class="imports-batch-summary" role="status">${escapeHtml(`${onlyImported(b.summary) ? `Imported ${plural(b.summary.imported, "session", "sessions")}` : summary}.${seen}`)}</p>` : ""}
    ${stopped}
    <ul class="imports-batch-list imports-batch-results">${rows.join("")}</ul>
    ${rowsTech.length ? techHtml(rowsTech) : ""}
    ${still ? `<p class="muted">${escapeHtml(plural(still, "session that was not imported is", "sessions that were not imported are"))} still ticked. After Done, Review ${escapeHtml(plural(still, "session", "sessions"))} opens the confirmation to import ${still === 1 ? "it" : "them"} again.</p>` : ""}
    <div class="gpexe-link-actions imports-batch-actions">
      ${!b.sending && (b.summary?.imported || b.summary?.alreadyImported) ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-section" data-section="today">Open Activities</button>` : ""}
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-batch-done" ${b.sending ? "disabled" : ""}>Done</button>
    </div>
  `;
}

const onlyImported = (s) => Boolean(s?.imported) && !s.alreadyImported && !s.refused && !s.unknown && !s.notAttempted;

// ---------------------------------------------------------------------------
// The local sessions calendar (Imports phase 4b)
// ---------------------------------------------------------------------------

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// A month of the sessions OptiMove has already found, from the list alone
// (every session whatever its bucket, replaced versions aside). A marked
// day filters the list to that day; Prev/Next only turn the page. The
// From/To dates of "Find new sessions" are a different thing and stay as
// they are.
function renderCalendarHtml(gx) {
  const list = (gx.candidates || []).filter((c) => !isHiddenVersion(c, gx));
  const counts = new Map();
  for (const c of list) {
    const key = calendarDayKey(c.sessionStartedAt);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  const listed = (gx.candidates || []).filter((c) => inboxBucket(c, gx) !== "hidden");
  const shown = calendarFiltered(listed, gx);
  const month = calendarMonthShown(gx);
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const today = calendarDayKey(new Date());
  const selected = gx.calendar?.day || "";
  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push(`<span class="imports-cal-day is-blank" aria-hidden="true"></span>`);
  for (let d = 1; d <= daysInMonth; d += 1) {
    const key = `${month}-${String(d).padStart(2, "0")}`;
    const n = counts.get(key) || 0;
    const name = `${d} ${MONTH_NAMES[m - 1]}`;
    const isToday = key === today;
    const isSelected = key === selected;
    const flags = [isToday ? "today" : "", isSelected ? "showing this day" : ""].filter(Boolean);
    if (n) {
      const label = `${name}, ${plural(n, "session", "sessions")} found${flags.length ? `, ${flags.join(", ")}` : ""}`;
      cells.push(`<button type="button" class="imports-cal-day is-marked${isToday ? " is-today" : ""}${isSelected ? " is-selected" : ""}" data-action="training-load-gpexe-cal-day" data-day="${key}" aria-label="${escapeAttr(label)}" aria-pressed="${isSelected ? "true" : "false"}"><span class="imports-cal-num">${d}</span><span class="imports-cal-mark" aria-hidden="true">${n > 1 ? `<span class="imports-cal-count">${n}</span>` : `<span class="imports-cal-dot"></span>`}</span></button>`);
    } else {
      cells.push(`<span class="imports-cal-day${isToday ? " is-today" : ""}" aria-label="${escapeAttr(`${name}, nothing found yet${isToday ? ", today" : ""}`)}"><span class="imports-cal-num">${d}</span></span>`);
    }
  }
  // The folded summary says the month and how much it holds, so a phone
  // coach knows without opening; opening sends nothing and changes nothing.
  const inMonth = listed.filter((c) => calendarDayKey(c.sessionStartedAt).startsWith(`${month}-`));
  const daysInUse = new Set(inMonth.map((c) => calendarDayKey(c.sessionStartedAt))).size;
  const brief = inMonth.length ? `${plural(inMonth.length, "session", "sessions")} on ${plural(daysInUse, "day", "days")}` : "nothing found yet";
  const open = calendarOpen(gx);
  // The day filter's line sits under the panel, so it stays in sight when
  // the calendar is folded.
  return `
    <details class="gpexe-panel imports-calendar" data-rendered-open="${open ? "1" : "0"}" ${open ? "open" : ""}>
      <summary class="imports-cal-summary"><span class="imports-cal-title">Pick a day</span><span class="muted imports-cal-brief"> · ${escapeHtml(MONTH_NAMES[m - 1])} · ${escapeHtml(brief)}</span></summary>
      <div class="imports-cal-nav">
        <button type="button" class="plain-button gpexe-button imports-cal-turn" data-action="training-load-gpexe-cal-prev" aria-label="Previous month">&lsaquo;</button>
        <strong class="imports-cal-month" aria-live="polite">${escapeHtml(`${MONTH_NAMES[m - 1]} ${y}`)}</strong>
        <button type="button" class="plain-button gpexe-button imports-cal-turn" data-action="training-load-gpexe-cal-next" aria-label="Next month">&rsaquo;</button>
      </div>
      <p class="muted imports-cal-note">A dot or a number marks the sessions found so far on a day.</p>
      <div class="imports-cal-grid" role="group" aria-label="${escapeAttr(`${MONTH_NAMES[m - 1]} ${y}`)}">
        ${WEEKDAY_NAMES.map((w) => `<span class="imports-cal-weekday" aria-hidden="true">${w}</span>`).join("")}
        ${cells.join("")}
      </div>
    </details>
    ${selected ? `<p class="imports-cal-filter" role="status">Showing the sessions of ${escapeHtml(formatDate(selected))} only (${shown.length} of ${listed.length}). <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-cal-all">Show all dates</button></p>` : ""}
  `;
}

function badgeHtml(c, gx = state.trainingLoad.gpexe) {
  if (isUncertain(c, gx)) return `<span class="gpexe-badge is-unknown">Result not confirmed</span>`;
  const group = candidateGroup(c, gx);
  // v33: a pending or "up to date" row the last successful search did not confirm is neither.
  if ((group === "decision" || group === "uptodate") && notConfirmedForImport(c)) return `<span class="gpexe-badge is-pending">Not confirmed for import</span>`;
  // A session with an open reason (no linked athlete, athletes left out) is never "Up to date": it needs a step.
  if (group === "uptodate" && rowReasons(c).length) return `<span class="gpexe-badge is-blocked">Needs attention</span>`;
  const [cls, text] = GROUP_BADGE[group] || [c.status, c.status];
  return `<span class="gpexe-badge is-${escapeAttr(cls)}">${escapeHtml(text)}</span>`;
}

// "Try again" for the source-athletes list, busy while it runs.
function retryButtonHtml(gx) {
  return `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-sources-retry" ${gx.sourceAthletesRetrying ? "disabled" : ""}>${gx.sourceAthletesRetrying ? "Trying again..." : "Try again"}</button>`;
}

// U6a: the daily screen has no list of linked athletes - it lives on the Link athletes screen. What stays here is the way in to that
// screen, the one fact that needs a word, and the failure of the athletes read (with its retry) or of a link change. While Link athletes
// is off (the athletes read failed or has not arrived), the links are listed here with Unlink, as before U6a: a wrong link can always go.
function renderLinksHtml(gx) {
  const links = gx.links || [];
  const usable = Boolean(gx.sourceAthletes && !gx.sourceAthletesError);
  const unlinked = (gx.sourceAthletes || []).filter((a) => a.status === "unlinked").length;
  const inactive = (gx.sourceAthletes || []).filter((a) => a.status === "linked_inactive").length;
  const facts = [];
  if (inactive) facts.push(plural(inactive, "link points", "links point") + " to an athlete no longer in the team");
  return `
    <section class="gpexe-panel" aria-label="Athlete links">
      <div class="gpexe-panel-head imports-links-head">
        <h3>GPEXE athletes</h3>
        <button type="button" class="${unlinked ? "primary-button" : "plain-button"} gpexe-button" data-action="training-load-gpexe-map-open" ${usable ? "" : "disabled"}>Link athletes${unlinked ? ` (${unlinked})` : ""}</button>
      </div>
      ${facts.length ? `<p class="imports-links-facts">${escapeHtml(facts.join(" · "))}.</p>` : ""}
      ${gx.sourceAthletesError ? `
        <div class="gpexe-warning imports-links-unavailable" role="status">
          <p>${gx.sourceAthletes
            ? "The list of GPEXE athletes could not be refreshed, so it may be out of date. Link athletes is off until it is read again; the sessions and the search still work."
            : "The list of GPEXE athletes is not available right now, so Link athletes is off. The sessions, the search and the links below still work."}</p>
          ${retryButtonHtml(gx)}
          ${errorTech(gx.sourceAthletesError)}
        </div>
      ` : ""}
      ${gx.linkError && !gx.detail ? `<p class="gpexe-error" role="alert">${escapeHtml(errorText(gx.linkError, "The link could not be changed."))}</p>` : ""}
      ${!usable && links.length ? `
        <ul class="gpexe-link-list">
          ${links.map((l) => `
            <li>
              <div><strong>${escapeHtml(l.athleteName)}</strong> <span class="muted">${escapeHtml(gpexeSideText(l.gpexeAthleteId))}</span>${idTechHtml(l.gpexeAthleteId)}</div>
              <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-unlink" data-link-id="${escapeAttr(l.id)}" ${gx.linkBusy ? "disabled" : ""}>Unlink</button>
            </li>
          `).join("")}
        </ul>
      ` : ""}
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
  const title = niceSessionName({ label: s.sessionLabel, gpexeTeamSessionId: s.gpexeTeamSessionId });
  const raw = s.evidence === "raw_snapshot" ? " · this session can't be imported, so it gives no values" : "";
  return `Last seen ${[when, title].filter(Boolean).join(" · ")}${raw}`;
}

// The GPEXE name and date of birth of a row (administrators only, once
// loaded): "Born DD.MM.YYYY" from the stored YYYY-MM-DD, never shifted.
export function bornText(birthDate) {
  const m = typeof birthDate === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate) : null;
  return m ? `Born ${m[3]}.${m[2]}.${m[1]}` : "Date of birth not provided";
}

// The GPEXE side of a row or a pair: the GPEXE name when it is loaded (the
// id then lives in Technical details only), otherwise the id as before.
function gpexeLabel(id, gx) {
  return gpexeAthleteLabel(id, gx);
}

function identityLinesHtml(id, gx, duplicates) {
  const who = identityOf(id, gx);
  if (!who) return "";
  const duplicate = who.name && duplicates.has(identityNameKey(who.name));
  return `
    <span class="gpexe-map-born">${escapeHtml(bornText(who.birthDate))}</span>
    ${duplicate ? `<span class="gpexe-map-caution" role="note">Check: another GPEXE athlete has the same name. Compare the date of birth and the session values before you choose.</span>` : ""}
  `;
}

function conflictHtml(id, athleteId, gx) {
  return birthDateConflict(id, athleteId, gx)
    ? `<span class="gpexe-map-caution" role="note">Check: the date of birth in GPEXE differs from the one in this athlete's OptiMove profile. Link them only if you are sure they are the same person.</span>`
    : "";
}

function renderMapRowHtml(a, gx, choices, duplicates = new Set()) {
  const id = a.gpexeAthleteId;
  const chosen = gx.mapping.choices[id] || "";
  const named = Boolean(identityOf(id, gx));
  const writeOff = gx.mapping.sending || gx.sourceAthletesError || identityBusy(gx);
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
          <strong>${escapeHtml(gpexeLabel(id, gx))}</strong>
          ${identityLinesHtml(id, gx, duplicates)}
          <span class="muted">${escapeHtml(mapLastSeenText(a))}</span>
          <span class="gpexe-map-values">${escapeHtml(mapValuesText(a))}</span>
          ${conflictHtml(id, chosen, gx)}
        </div>
        ${choices.length ? `<label class="gpexe-map-choice"><span>Link to</span>
          <select class="gpexe-select" data-action="training-load-gpexe-map-choose" data-gpexe-athlete-id="${escapeAttr(id)}" aria-label="Link ${escapeAttr(`${gpexeAthleteSentence(id, gx)}${named ? `, ${bornText(identityOf(id, gx).birthDate)}` : ""}${!identityOf(id, gx)?.name ? `, ${mapLastSeenText(a)}` : ""}`)} to" ${writeOff ? "disabled" : ""}>
            <option value="" ${chosen ? "" : "selected"}>Not now</option>
            ${choices.map((o) => `<option value="${escapeAttr(o.id)}" ${chosen === o.id ? "selected" : ""} ${o.duplicate ? "disabled" : ""}>${escapeHtml(o.name)}${o.duplicate ? " (same name as another athlete)" : ""}</option>`).join("")}
          </select>
        </label>` : `<p class="muted gpexe-map-choice">No athlete to choose.</p>`}
        ${tech}
      </li>
    `;
  }
  const inactive = a.status === "linked_inactive";
  const who = identityOf(id, gx);
  const gpexeSide = who ? `${gpexeSideText(id, gx)} · ${bornText(who.birthDate)}` : gpexeSideText(id, gx);
  return `
    <li class="gpexe-map-row ${inactive ? "is-inactive" : "is-linked"}">
      <div class="gpexe-map-main">
        <strong>${escapeHtml(a.link?.athleteName || "Athlete")}</strong>
        <span class="muted">${escapeHtml(gpexeSide)}${inactive ? " · no longer in the team" : ""} · ${escapeHtml(mapLastSeenText(a))}</span>
        <span class="gpexe-map-values">${escapeHtml(mapValuesText(a))}</span>
      </div>
      <div class="gpexe-map-choice">
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-unlink" data-link-id="${escapeAttr(a.link?.id || "")}" ${gx.linkBusy || writeOff ? "disabled" : ""}>Unlink</button>
      </div>
      ${tech}
    </li>
  `;
}

// The administrator's explicit, read-only GPEXE name load. The sentences say
// before anything is sent how many athletes at most, that it only reads, and
// how long OptiMove keeps the answer. The result names counts only.
function identityResultText(r) {
  const parts = [r.loaded === 1 ? "Read 1 athlete from GPEXE." : `Read ${r.loaded} athletes from GPEXE.`];
  if (r.loaded) parts.push("Where GPEXE gives no name or date of birth, the athlete's row says so.");
  if (r.notFound) parts.push(r.notFound === 1 ? "GPEXE has no record for 1 athlete; it stays without a name and can be loaded again after 24 hours." : `GPEXE has no record for ${r.notFound} athletes; they stay without a name and can be loaded again after 24 hours.`);
  if (r.stopped) parts.push("GPEXE stopped answering before every athlete was read.");
  if (r.notRead) parts.push(r.notRead === 1 ? "1 athlete is still without a name - load again to read it." : `${r.notRead} athletes are still without a name - load again to read them.`);
  if (r.unrecognised) parts.push(r.unrecognised === 1 ? "1 date of birth was in a form OptiMove does not accept and is shown as not provided." : `${r.unrecognised} dates of birth were in a form OptiMove does not accept and are shown as not provided.`);
  return parts.join(" ");
}

function identityErrorText(error) {
  const code = error?.data?.error || error?.code;
  const reason = error?.data?.reason;
  if (error?.status === 404) return "GPEXE names are not available for this team any more (the team is no longer bound, or your access changed). Nothing was saved.";
  if (code === "source_connection_unavailable") return reason === "connection_not_usable" || reason === "connection_credential_changed"
    ? "The team's GPEXE connection needs attention first: test or reconnect it in Settings > Source connections. Nothing was read."
    : platformViewer() ? "The team's GPEXE connection cannot be used right now (the code is under Technical details). Nothing was read." : connectionUnusableText(reason, " Nothing was read.");
  if (code === "identity_load_abandoned") return "The last load did not finish and saved nothing. You can load the names again.";
  if (code === "identity_load_running") return "Another load of GPEXE names is running for this team, possibly started by another administrator. Nothing was started. Load again when it has finished.";
  if (code === "source_auth_rejected") return "GPEXE refused the connection's credential, so nothing was saved. Until it is reconnected in Settings > Source connections, no search or load can run for this team.";
  if (code === "try_again") return "OptiMove is busy right now (another change of this team's GPEXE connection, or the server itself). Nothing was saved; try again in a moment.";
  return errorText(error, "The names could not be loaded; nothing was saved.");
}

// A Check result the server refused for a reason other than the original
// load's saved outcome: the load is still not confirmed, so these never say
// that nothing was saved.
function identityCheckRefusalText(refusal) {
  const busy = refusal.code === "try_again" || refusal.code === "database_busy" || refusal.code === "roster_busy";
  if (refusal.code === "source_connection_unavailable") {
    return "Check result could not run: the team's GPEXE connection needs attention (test or reconnect it in Settings > Source connections). The result is still not confirmed.";
  }
  if (busy) return "Check result could not run because OptiMove or the server is busy. The result is still not confirmed; try Check result again in a moment.";
  return platformViewer() ? "Check result could not run (the code is under Technical details). The result is still not confirmed; try Check result again in a moment." : "Check result could not run. The result is still not confirmed; try Check result again in a moment.";
}

function renderIdentityPanelHtml(gx) {
  const id = gx.identity;
  if (!id || (!id.available && !id.loading && !id.error && !id.unconfirmed && !id.readError)) return "";
  const list = id.list;
  const max = list?.maxPerLoad || 50;
  const days = list?.retentionDays || 14;
  const pending = list?.pendingCount || 0;
  const retryLater = list?.retryLaterCount || 0;
  const retryLaterHtml = retryLater ? `<p class="muted">${retryLater === 1 ? "1 athlete GPEXE had no record for is" : `${retryLater} athletes GPEXE had no record for are`} left out of loads for 24 hours, then can be loaded again.</p>` : "";
  const locked = identityLocked(gx) || identityBusy(gx);
  const head = `<h4>GPEXE names and dates of birth</h4>`;
  let body = "";
  if (id.loading && !list) body = `<p class="muted">Loading...</p>`;
  else if (id.sending) body = `<p class="muted" role="status">Loading names from GPEXE...</p>`;
  else if (id.unconfirmed) {
    body = `
      <div class="gpexe-unknown" role="status">
        <p><strong>Result not confirmed.</strong> ${id.unconfirmed.running ? "The load is still running, or its result is not settled yet." : "The answer was lost, so we can't tell yet what was saved."} Check result asks OptiMove what happened; GPEXE is never read twice for this request.</p>
        <p class="muted">Linking is off until the result is confirmed. Closing Link athletes does not start over.</p>
        ${id.unconfirmed.lastRefusal ? `<p class="gpexe-error" role="alert">${escapeHtml(identityCheckRefusalText(id.unconfirmed.lastRefusal))}</p>${techHtml([["HTTP status", id.unconfirmed.lastRefusal.status || "no answer"], ["Code", id.unconfirmed.lastRefusal.code], ["Reason", id.unconfirmed.lastRefusal.reason]])}` : ""}
        <div class="gpexe-link-actions"><button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-identity-check">Check result</button></div>
      </div>`;
  } else if (id.confirming) {
    const n = Math.min(pending, max);
    body = `
      <div class="gpexe-link-confirm" role="group" aria-label="Load GPEXE names and dates of birth">
        <p><strong>Load the names and dates of birth of ${n === 1 ? "1 athlete" : `${n} athletes`} from GPEXE?</strong></p>
        <p>OptiMove reads at most ${max} athletes per load${pending > max ? ` (${pending - max} more stay for a later load)` : ""}. This only reads from GPEXE: nothing is changed there, and no athlete is linked.</p>
        <p>OptiMove deletes the names and dates of birth from its database after at most ${days} days (a database backup taken meanwhile can keep them longer), shows them only to administrators on this screen, and never copies them into an athlete's profile.</p>
        <div class="gpexe-link-actions">
          <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-identity-cancel">Cancel</button>
          <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-identity-send">Load names and dates of birth</button>
        </div>
      </div>`;
  } else if (list) {
    body = pending
      ? `<p class="muted">${pending === 1 ? "1 GPEXE athlete has" : `${pending} GPEXE athletes have`} no name loaded yet. The names help you recognise athletes; they never link anyone by themselves.</p>
         <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-identity-open" ${locked ? "disabled" : ""}>Load names and dates of birth</button>`
      : `<p class="muted">No more GPEXE names to load right now. An athlete whose name is not loaded was seen only in a session OptiMove cannot read names for${retryLater ? ", or GPEXE had no record for it in the last 24 hours" : ""}.</p>`;
    body += retryLaterHtml;
  }
  return `
    <section class="gpexe-identity" aria-label="GPEXE names and dates of birth">
      ${head}
      ${body}
      ${id.result ? `<p class="gpexe-notice" role="status">${escapeHtml(identityResultText(id.result))}</p>` : ""}
      ${id.readError ? `<p class="gpexe-error" role="alert">The stored GPEXE names could not be read right now; nothing was read from GPEXE.</p><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-identity-reload" ${id.loading ? "disabled" : ""}>Try again</button>${techHtml([["HTTP status", id.readError.status || "no answer"], ["Code", id.readError.code]])}` : ""}
      ${id.error ? `<p class="gpexe-error" role="alert">${escapeHtml(identityErrorText(id.error))}</p>${techHtml([["HTTP status", id.error.status || "no answer"], ["Code", id.error.code], ["Reason", id.error.data?.reason]])}` : ""}
    </section>`;
}

function mapOutcomeText(r, label = gpexeAthleteLabel(r.gpexeAthleteId)) {
  if (r.outcome === "linked") return "linked";
  if (r.outcome === "unknown") return `not confirmed - the answer was lost, so we can't tell whether the link was made. Press Done: if ${label} now appears under Linked, it was.`;
  const code = r.error?.code;
  if (code === "already_linked") return "not linked: this GPEXE athlete, or the athlete you chose, is already linked. Press Done to see the current list, then choose another athlete or Not now.";
  if (code === "athlete_not_in_team") return "not linked: the athlete is no longer an active member of the team";
  if (code === "invalid_gpexe_athlete_id") return "not linked: this is not a valid GPEXE athlete id";
  if (code === "gpexe_team_not_configured") return "not linked: the team is not connected to GPEXE";
  if (r.error?.status === 404) return "not linked: the team is not available in your current workspace";
  return "not linked: the server refused it";
}

// One pair of the final confirmation. With a GPEXE name loaded, the id stays
// in Technical details; when the name cannot tell two athletes apart (a
// duplicate, or no name) the last session is named too.
function renderPairHtml(p, gx, list, duplicates) {
  const who = identityOf(p.gpexeAthleteId, gx);
  const sug = who ? null : suggestedIdentity(p.gpexeAthleteId, p.athleteId, gx);
  const unclear = (!who || !who.name || duplicates.has(identityNameKey(who.name)));
  const a = unclear ? list.find((x) => x.gpexeAthleteId === p.gpexeAthleteId) : null;
  return `<li class="gpexe-link-pair"><strong>${escapeHtml(sug ? (sug.name || "Name not provided") : gpexeLabel(p.gpexeAthleteId, gx))}</strong>${who ? ` <span class="muted">(${escapeHtml(bornText(who.birthDate))})</span>` : sug ? ` <span class="muted">(${escapeHtml(bornText(sug.birthDate))})</span>` : ""} → <strong>${escapeHtml(p.athleteName)}</strong>${who && who.name && duplicates.has(identityNameKey(who.name)) ? `<span class="gpexe-map-caution" role="note">Check: another GPEXE athlete has the same name.</span>` : ""}${a ? `<span class="muted gpexe-map-born">${escapeHtml(mapLastSeenText(a))} · ${escapeHtml(mapValuesText(a))}</span>` : ""}${conflictHtml(p.gpexeAthleteId, p.athleteId, gx)}${idTechHtml(p.gpexeAthleteId)}</li>`;
}

// U3: suggested pairs on the Link athletes screen (the team's coach and the
// administrators; the server decides who reads). Only EXACT pairs (same name,
// same date of birth, one on each side) can be staged, all together, into the
// ordinary review; everything else is listed as "Needs your choice" and is
// never staged. Every name is escaped; the GPEXE id is never shown.
export function renderSuggestionsHtml(gx, off) {
  const sg = gx.suggestions;
  if (!sg || sg.status === "idle" || sg.status === "unavailable") return "";
  if (sg.status === "loading") return `<p class="muted gpexe-suggest-note" role="status">Looking for suggested pairs...</p>`;
  if (sg.status === "error") return `<p class="muted gpexe-suggest-note" role="status">Suggested pairs could not be read. You can still choose athletes below.</p>`;
  const d = sg.data;
  if (!d) return "";
  if (d.state !== "ok") {
    return `<p class="muted gpexe-suggest-note" role="status">${identityViewer(gx)
      ? "Load the GPEXE names and dates of birth above to get suggested pairs."
      : "Suggested pairs need the GPEXE names and dates of birth. Ask an administrator to load the GPEXE names and dates of birth."}</p>`;
  }
  const stageable = stageableSuggestedPairs(gx);
  const shown = stageable.slice(0, SUGGESTION_MAX_PAIRS);
  const name = (n) => escapeHtml(n || "Name not provided");
  const exactRows = shown.map((p) => `<li class="gpexe-suggest-row"><span class="gpexe-suggest-gpexe"><span class="gpexe-suggest-tag muted">In GPEXE</span><strong>${name(p.gpexeName)}</strong> <span class="muted">${escapeHtml(bornText(p.birthDate))}</span></span><span class="gpexe-suggest-arrow"><span aria-hidden="true">&rarr;</span><span class="visually-hidden"> will be linked to </span></span><span class="gpexe-suggest-athlete"><span class="gpexe-suggest-tag muted">In your team</span>${name(p.athleteName)}</span></li>`).join("");
  const names = (cs) => cs.map((c) => c.athleteName || "Athlete").join(" and ");
  const choice = [
    ...d.ambiguous.map((p) => ({ p, text: p.candidates.length > 1
      ? `The name matches ${names(p.candidates)}, so it is not clear which one it is.`
      : `The name matches ${names(p.candidates)}, but a date of birth is missing or the name is shared, so we can't be sure.` })),
    ...d.dateConflicts.map((p) => ({ p, text: `The name matches ${p.athleteName || "an athlete"}, but the dates of birth differ.` })),
  ];
  const choiceRows = choice.map(({ p, text }) => `<li class="gpexe-suggest-row"><span class="gpexe-suggest-gpexe"><span class="gpexe-suggest-tag muted">In GPEXE</span><strong>${name(p.gpexeName)}</strong> <span class="muted">${escapeHtml(bornText(p.birthDate))}</span></span><span class="gpexe-suggest-why muted">${escapeHtml(text)}</span></li>`).join("");
  if (!shown.length && !choice.length) return `<p class="muted gpexe-suggest-note" role="status">No suggested pairs. Choose athletes below.</p>`;
  return `
    <section class="gpexe-suggest" aria-label="Suggested pairs">
      ${shown.length ? `
        <h4>Suggested pairs (${shown.length})</h4>
        <p class="muted">GPEXE athlete (name, date of birth) &rarr; athlete in your team: same name and same date of birth. Nothing is linked yet - the button below only opens a summary that you confirm.</p>
        <ul class="gpexe-suggest-list">${exactRows}</ul>
        ${stageable.length > shown.length ? `<p class="muted">The first ${SUGGESTION_MAX_PAIRS} are listed; the rest appear after these are linked.</p>` : ""}
        <div class="gpexe-link-actions"><button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-map-suggest-all" ${off ? "disabled" : ""}>Review all ${shown.length} suggested ${shown.length === 1 ? "pair" : "pairs"}</button></div>
      ` : ""}
      ${choice.length ? `
        <h4>Needs your choice (${choice.length})</h4>
        <p class="muted">These are never selected for you. Choose the athlete below if you are sure.</p>
        <ul class="gpexe-suggest-list">${choiceRows}</ul>
      ` : ""}
    </section>
  `;
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
  const busy = m.sending || gx.identity?.sending ? "disabled" : "";
  // The list may be out of date (a re-read failed after a change): it stays
  // as context, marked, and every new link/unlink/review/send is off until
  // Try again succeeds. Close, Back and Done still work.
  const stale = Boolean(gx.sourceAthletesError);
  const off = m.sending || stale || identityBusy(gx) || gx.identity?.confirming ? "disabled" : "";
  const staleHtml = stale ? `
      <div class="gpexe-warning imports-links-unavailable" role="status">
        <p>This list could not be refreshed after the last change, so it may be out of date: an athlete you just linked may still show as not linked. Linking and unlinking are off until it is read again.</p>
        ${retryButtonHtml(gx)}
        ${errorTech(gx.sourceAthletesError)}
      </div>
  ` : "";
  const staged = m.confirming ? stagedTeamMapping(gx) : null;
  const duplicates = duplicateIdentityNames(gx);
  const rows = (items) => `<ul class="gpexe-map-list">${items.map((a) => renderMapRowHtml(a, gx, choices, duplicates)).join("")}</ul>`;
  let body;
  if (m.results) {
    body = `
      <section class="gpexe-map-results" aria-label="Result">
        <h4>Result</h4>
        <ul>
          ${m.results.map((r) => `<li><strong>${escapeHtml(gpexeLabel(r.gpexeAthleteId, gx))} → ${escapeHtml(r.athleteName)}</strong>: ${escapeHtml(mapOutcomeText(r, gpexeLabel(r.gpexeAthleteId, gx)))}${r.error ? errorTech(r.error) : ""}${idTechHtml(r.gpexeAthleteId)}</li>`).join("")}
        </ul>
        ${m.results.some((r) => r.outcome !== "refused") ? `<p>Find new sessions to update the reviews - approving waits until then. A wrong link can be removed with Unlink before an import is approved.</p>` : ""}
        ${staleHtml}
        <div class="gpexe-link-actions"><button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-map-done">Done</button></div>
      </section>
    `;
  } else if (m.confirming && staged?.pairs) {
    body = `
      <section class="gpexe-link-confirm gpexe-map-confirm" role="group" aria-label="Confirm the links">
        <p><strong>Link ${plural(staged.pairs.length, "athlete", "athletes")}?</strong></p>
        <ul>${staged.pairs.map((p) => renderPairHtml(p, gx, list, duplicates)).join("")}</ul>
        ${gx.identity?.list ? `<p class="muted">OptiMove warns only when both dates of birth are known and differ. No warning does not mean they match.</p>` : ""}
        ${unlinked.length > staged.pairs.length ? `<p class="muted">${escapeHtml(plural(unlinked.length - staged.pairs.length, "other GPEXE athlete stays", "other GPEXE athletes stay"))} not linked (Not now); their sessions keep needing attention until they are linked.</p>` : ""}
        <p>Once you find new sessions and approve an import, each GPEXE athlete's results are imported as the athlete chosen here — in the sessions already found and in every session found later.</p>
        <p>You can unlink before an import is approved. Unlinking doesn't change results that are already imported: if a link turns out wrong after an import, those results can't be changed here — contact a platform administrator.</p>
        <div class="gpexe-link-actions">
          <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-map-back" ${busy}>Back</button>
          <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-map-send" ${off}>${m.sending ? "Linking..." : `Link ${plural(staged.pairs.length, "athlete", "athletes")}`}</button>
        </div>
      </section>
    `;
  } else {
    body = `
      <p class="muted gpexe-hint">${gx.identity?.list ? "A link is never guessed. The GPEXE name, date of birth and last-session values help you find an athlete in GPEXE; none of them proves who it is." : "A link is never guessed. Choose an athlete only when you are sure who a GPEXE athlete is - the values of the last session help you find them in GPEXE and prove nothing."} Choosing sends nothing: the links are made only when you press Link on the next step.</p>
      ${!gx.sourceAthletes ? `<p class="muted">Loading...</p>` : ""}
      ${gx.sourceAthletes && !list.length ? `<p class="muted">No GPEXE athlete has been seen yet. Find new sessions first.</p>` : ""}
      ${renderIdentityPanelHtml(gx)}
      ${renderSuggestionsHtml(gx, off)}
      ${staleHtml}
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
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-map-confirm" ${stagedCount && !off ? "" : "disabled"}>Review ${stagedCount ? plural(stagedCount, "link", "links") : "links"}</button>
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
          <p class="muted">The number in "GPEXE athlete 1", "GPEXE athlete 2" and so on is the athlete's place in this list, not the GPEXE id${platformViewer() ? "; the id is under Technical details" : ""}.</p>
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
  const current = Boolean(gx.detail?.id && gx.recomputedAtLinkSeq?.[gx.detail.id] === gx.linkSeq);
  const dates = l.sessionDate ? ` (with dates that include ${formatDate(l.sessionDate)})` : "";
  return `
    <div class="gpexe-notice gpexe-last-link" role="status">
      <p><strong>${escapeHtml(gpexeWho(l.gpexeAthleteId).replace(/^(the|a) /, (w) => w[0].toUpperCase() + w.slice(1)))} is now linked to ${escapeHtml(l.athleteName)}.</strong>${current ? " The review is updated." : ` Find new sessions${escapeHtml(dates)} to update the review - approving waits until then.`}</p>
      <p>Wrong athlete? Unlink it before an import is approved.
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-unlink" data-link-id="${escapeAttr(l.linkId)}" ${gx.linkBusy ? "disabled" : ""}>Unlink ${escapeHtml(l.athleteName)}</button>
      </p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Candidate detail
// ---------------------------------------------------------------------------

// U6a-2 (J20 section 8): a review opened from an attention group says where it is in the group and offers the next
// session of the group as it was when it was opened (a link may move the others to "Review out of date"). Off while
// something of this review must still be seen. Nothing for a group of one, or outside a group.
function renderGroupNavHtml(gx, detail) {
  const ids = Array.isArray(detail?.groupIds) ? detail.groupIds : [];
  const at = ids.indexOf(detail?.id);
  const title = ATTENTION_TEXT[detail?.group]?.title || "";
  if (!title || at < 0 || ids.length < 2) return "";
  const next = nextInGroup(detail, gx.candidates || [], gx);
  const busy = reviewMustStay(gx, detail);
  // Back to Imports is the dialog's Close: it waits for exactly what Close waits for.
  const closeBusy = detail.approving || detail.verifying || undoBusy(gx);
  if (!next) return `<div class="imports-group-nav"><span class="muted">${escapeHtml(`This is the last session in "${title}".`)}</span><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-close" ${closeBusy ? "disabled" : ""}>Back to Imports</button></div>`;
  return `<div class="imports-group-nav"><span class="muted">${escapeHtml(`Session ${at + 1} of ${ids.length} in "${title}"`)}</span><button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-group-next" ${busy ? "disabled" : ""}>Next session</button></div>`;
}

function renderCandidateDetailHtml(gx, status) {
  const detail = gx.detail;
  const c = detail.candidate;
  // Not closable while an approval runs: its answer must be seen.
  const busy = detail.approving || detail.verifying || undoBusy(gx) ? "disabled" : "";
  const title = c ? `${niceSessionName(c)}${c.sessionStartedAt ? ` · ${fmtDateTime(c.sessionStartedAt)}` : ""}` : "Session";
  return `
    <div class="builder-athlete-overlay gpexe-detail-overlay">
      <button type="button" class="builder-athlete-backdrop" data-action="training-load-gpexe-close" aria-label="Close" ${busy}></button>
      <section class="panel builder-athlete-picker gpexe-detail" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <div class="builder-section-panel-head">
          <h3>${escapeHtml(title)}</h3>
          <button type="button" class="plain-button icon-button builder-athlete-picker-cancel" data-action="training-load-gpexe-close" aria-label="Close" ${busy}>&times;</button>
        </div>
        <div class="gpexe-detail-body">
          ${renderGroupNavHtml(gx, detail)}
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

// v62 (mixed_timezones (b)): a session whose GPS units report several zones is read in the team's zone; say which and why.
function renderTeamZoneNoteHtml(preview) {
  const s = preview?.session;
  if (s?.timezoneSource !== "team" || !s.timezone) return "";
  const reported = (Array.isArray(s.trackTimezones) ? s.trackTimezones : []).join(" and ");
  return `<p class="gpexe-zone-note">This session's GPS units report different time zones${reported ? ` (${escapeHtml(reported)})` : ""}, so OptiMove uses the team's time zone, ${escapeHtml(s.timezone)}, for its date and time.</p>`;
}

function renderCandidateBodyHtml(c, detail, status) {
  const preview = c.preview;
  return `
    <p class="gpexe-detail-meta">
      ${badgeHtml(c)}
      <span class="muted">${escapeHtml(fmtDateTime(c.sessionStartedAt))}</span>
      ${c.snapshot?.available && platformViewer() ? `<span class="muted">GPEXE data kept until ${escapeHtml(formatDate(c.snapshot.expiresAt))}</span>` : ""}
    </p>
    ${renderTeamZoneNoteHtml(preview)}
    ${adminTechHtml([["GPEXE session name", c.label]])}
    ${renderApprovalRecordHtml(c)}
    ${renderUndoneNoteHtml(c, state.trainingLoad.gpexe)}
    ${!preview ? `<p class="muted">${c.snapshot?.available === false ? "The GPEXE data is too old. Find new sessions to see it again." : "No preview."}</p>` : `
      ${renderBlockedHtml(preview, c)}
      ${renderChangesHtml(preview, c)}
      ${renderReviewTableHtml(preview, c)}
      ${renderAthletesHtml(preview, c)}
      ${renderSourceFieldsNoteHtml(preview)}
    `}
    ${renderOutcomeHtml(detail)}
    ${renderApproveHtml(c, detail, status)}
    ${renderUndoHtml(c, state.trainingLoad.gpexe)}
  `;
}

// Section F row 2 (J17 section 4): the GPEXE fields with no mapping switched
// on for this team, whose values are not imported. The two administrators'
// answer names them; everyone else's carries only their count. Nothing on a
// preview without either (one stored before 9-B).
function renderSourceFieldsNoteHtml(preview) {
  const labels = Array.isArray(preview?.unactivatedSourceMetrics) ? preview.unactivatedSourceMetrics.filter((l) => typeof l === "string" && l.trim()) : [];
  const count = labels.length || (Number.isInteger(preview?.unactivatedSourceMetricCount) ? preview.unactivatedSourceMetricCount : 0);
  if (count <= 0) return "";
  if (!labels.length) return `<p class="muted gpexe-source-fields">${escapeHtml(`${plural(count, "more GPEXE field is", "more GPEXE fields are")} not set up for import for this team; ${count === 1 ? "its values are" : "their values are"} not imported.`)}</p>`;
  const head = `${plural(count, "GPEXE field is", "GPEXE fields are")} not switched on for this team, so ${count === 1 ? "its values are" : "their values are"} not imported`;
  return `<p class="muted gpexe-source-fields">${escapeHtml(`${head}: ${labels.join(", ")}. To import one, set up its mapping and switch it on for this team under Training Load > Data configuration > Mappings.`)}</p>`;
}

function renderApprovalRecordHtml(c) {
  if (!c.approval) return "";
  const a = c.approval;
  const counts = countsText(a.import?.counts);
  return `<p class="${c.importUndoneAt ? "muted" : "gpexe-success"}">${c.importUndoneAt ? "Was imported" : "Imported"} ${escapeHtml(fmtDateTime(a.approvedAt))} (${a.basis === "platform_admin" ? "platform admin" : "approver grant"})${counts ? `: ${escapeHtml(counts)}` : ""}.</p>`;
}

// The coach's reason and step for a blocked session, from the list's neutral
// blockedCode (phase 2b); the adapter's own code and the server's sentence
// stay in Technical details. `c` is a list row or the review's candidate.
// `excluded` marks a session that stays out of OptiMove for good - nothing
// to fix, no decision.
// Phase 9 (9-B, J17 section 6.1): the eight codes of a mapped import that
// block a whole session. Everyone but the two administrators reads the one
// code data_setup_incomplete with the coach's sentence; an administrator
// reads the precise code's sentence (the server's own when the review carries
// it) and its step. None of them ever reads as a conflict with data already
// in OptiMove.
const SETUP_COACH_TEXT = Object.freeze({
  reason: "This session can't be imported until an administrator finishes its data setup.",
  // P1 (O5): a coach asks the club administrator (who may finish the club's own setup or pass it on).
  get step() { return platformViewer() || state.trainingLoad.gpexe?.status?.viewer?.identityAdmin === true ? "Ask a club or platform administrator to finish the data setup of this team, then find new sessions." : "Ask your club administrator to finish the data setup of this team, then find new sessions."; },
});
// 7h-F (decision 1 at 7h-B's GO): the ux-design-reviewer's wording, for the
// club's admin who usually reads it.
const SETUP_MAPPINGS_STEP = "Check the mappings switched on for this team (Training Load > Data configuration > Mappings) and the team's GPEXE binding (Settings > Source connections), then find new sessions. The club's admin changes the club's own mappings there. If both look right, ask a platform administrator, who handles system mappings and field confirmations{TECH}.";
const SETUP_CONNECTION_STEP = "Check this team's GPEXE binding and the binding of the team that holds this GPEXE team (Settings > Source connections). Ending a held source instance is a platform administrator's step (docs/runbooks/source-instance-end-v50.md); then find new sessions.";
const SETUP_ADMIN_TEXT = Object.freeze({
  mapping_not_usable: { reason: "This session can't be imported through the team's mappings and GPEXE binding as they stand.", step: SETUP_MAPPINGS_STEP },
  source_threshold_contract_mismatch: { reason: "GPEXE's team thresholds or zones for this session are not the ones a mapping is defined for.", step: "Check the team's thresholds and zones in GPEXE against the mapping, then find new sessions." },
  source_unit_mismatch: { reason: "A mapping's source unit is not the proven unit of its GPEXE field.", step: "Check the mapping's source unit (Training Load > Data configuration > Mappings), then find new sessions." },
  source_shape_mismatch: { reason: "GPEXE sent a mapped value in another shape than its field has.", step: "Find new sessions again later. If it stays like this, ask a platform administrator to check that GPEXE field{TECH}." },
  no_mapped_values: { reason: "No value of this session can be imported: either no mapping switched on for this team gives a value for this session, or every mapped value was left out (see Left out under each athlete).", step: "Check which mappings are switched on for this team and the levels they cover (Training Load > Data configuration > Mappings), and any reasons under Left out; then find new sessions." },
  source_instance_held: { reason: "Another team's GPEXE source instance holds this GPEXE team.", step: SETUP_CONNECTION_STEP },
  source_instance_changed: { reason: "This team's GPEXE source instance names another GPEXE team.", step: "Check that this team's GPEXE binding names the right GPEXE team (Settings > Source connections). If it does, ending this team's earlier source instance is a platform administrator's step (an ended instance stays ended; docs/runbooks/source-instance-end-v50.md); then find new sessions." },
  session_imported_under_another_instance: { reason: "This session was imported earlier under another GPEXE source instance.", step: "The earlier import stays as it is. OptiMove never imports one GPEXE session twice, so this session stays out; ending or changing a source instance does not change that." },
});

// The precise mapping code an administrator's answer carries (the list's
// blockedSourceCode, or the review's own block), or null.
function setupBlockCode(c) {
  for (const code of [c?.blockedSourceCode, c?.preview?.blocked?.code]) {
    if (typeof code === "string" && Object.hasOwn(SETUP_ADMIN_TEXT, code)) return code;
  }
  return null;
}

export function blockedCoachText(c) {
  const code = c.blockedCode;
  // U6a-2 (D8): GPS units of one session report different time zones (mixed_timezones). The code stays in an
  // administrator's Technical details.
  if (c.blockedSourceCode === "mixed_timezones" || c.preview?.blocked?.code === "mixed_timezones") {
    const day = c.sessionStartedAt ? ` with dates that include ${formatDate(c.sessionStartedAt)}` : "";
    return { reason: "GPEXE reports this session's GPS units in more than one time zone, so OptiMove can't tell when it took place.", step: platformViewer() ? `It is not imported until the team has a time zone. Ask a platform administrator to set it in Settings > Data sources, then find new sessions again${day}.` : `It is not imported until the team has a time zone. ${AskWho()}, then find new sessions again${day}.` };
  }
  const precise = setupBlockCode(c);
  if (precise) {
    const own = c.preview?.blocked?.code === precise ? c.preview.blocked.message : null;
    const step = SETUP_ADMIN_TEXT[precise].step.replace("{TECH}", giveTech());
    return { reason: typeof own === "string" && own.trim() ? own : SETUP_ADMIN_TEXT[precise].reason, step };
  }
  if (code === "data_setup_incomplete" || c.blockedSourceCode === "data_setup_incomplete" || c.preview?.blocked?.code === "data_setup_incomplete") {
    return { ...SETUP_COACH_TEXT };
  }
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
    return { reason: "GPEXE sent incomplete or inconsistent data for this session.", step: `Find new sessions again later. If it stays like this, ${platformViewer() ? "ask a platform admin" : askWho()}${giveTech()}.` };
  }
  // conflicts_with_existing_data, other, or no code at all.
  return { reason: "This session conflicts with data already in OptiMove and can't be imported automatically.", step: `${platformViewer() ? "Ask a platform admin" : AskWho()} to look at it${giveTech()}.` };
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
      ${reviewTechHtml([["Code", preview.blocked.code], ["Server message", preview.blocked.message], ...steps.map((s, i) => [`Step ${i + 1} (server)`, `${s.action}: ${s.step}`])])}
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
            ${ch.athleteId ? "" : idTechHtml(ch.gpexeAthleteId)}
            ${renderValueTableHtml(ch.values, true, isV3(preview))}
          </li>
        `).join("")}
      </ul>
      ${adminTechHtml(metricNamesTech(changes.flatMap((ch) => ch.values || []), isV3(preview)))}
    </section>
  `;
}

function renderValueTableHtml(values, withPrevious, v3 = false) {
  if (!values?.length) return "";
  if (v3) return renderVariableTableHtml(values, withPrevious);
  return `
    <div class="gpexe-values-wrap"><table class="gpexe-values">
      <thead><tr><th scope="col">Metric</th>${withPrevious ? `<th scope="col">Before</th>` : ""}<th scope="col">GPEXE</th></tr></thead>
      <tbody>
        ${[...values].sort(byMetricOrder).map((v) => `<tr><td>${escapeHtml(metricName(v))}</td>${withPrevious ? `<td>${escapeHtml(fmtValue(v.previous, v.unit))}</td>` : ""}<td>${escapeHtml(fmtValue(v.value, v.unit))}</td></tr>`).join("")}
      </tbody>
    </table></div>
  `;
}

// v3: Variable | OptiMove value | GPEXE value, or Variable | Before | New
// value | GPEXE value for a result already imported, in the server's order. A
// value the result had that this import does not write says why, never a zero.
const EMPTY_CHANGE_TEXT = { left_out: "Left out", not_mapped: "No longer imported for this team", missing_in_gpexe: "Not in GPEXE" };
function renderVariableTableHtml(values, withPrevious) {
  return `
    <div class="gpexe-values-wrap"><table class="gpexe-values">
      <thead><tr><th scope="col">Variable</th>${withPrevious ? `<th scope="col">Before</th><th scope="col">New value</th>` : `<th scope="col">OptiMove value</th>`}<th scope="col">GPEXE value</th></tr></thead>
      <tbody>
        ${values.map((v) => `<tr><td>${escapeHtml(variableName(v))}</td>${withPrevious ? `<td>${escapeHtml(fmtValue(v.previous, v.unit))}</td>` : ""}<td>${escapeHtml(v.value === null || v.value === undefined ? (EMPTY_CHANGE_TEXT[v.change] || "-") : fmtValue(v.value, v.unit))}</td><td>${escapeHtml(fmtValue(v.sourceValue, v.sourceUnit))}</td></tr>`).join("")}
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
  if (!platformViewer()) {
    // P1 (owner 2026-11-13, O3): the coach and the club admin don't get a second list of the table's athletes. What only this
    // list holds - each athlete's values and the values left out with their reasons (D32) - stays, folded, for the athletes
    // that have any; an athlete waiting for a link has nothing here that the table doesn't say.
    const withValues = athletes.filter((a) => (a.skippedValues || []).length || (a.athleteId && !a.notImported && (a.results || []).length));
    if (!withValues.length) return "";
    return `
    <details class="gpexe-fine imports-values-fold gpexe-athletes">
      <summary>Values by athlete (${withValues.length})${(() => { const n = withValues.reduce((k, a) => k + (a.skippedValues || []).length, 0); return n ? ` · ${n} left out` : ""; })()}</summary>
      ${withValues.map((a) => renderAthleteHtml(a, c, unlinkedChoices)).join("")}
    </details>
  `;
  }
  return `
    <section class="gpexe-athletes" aria-label="Athletes in this session">
      <h4>Details by athlete (${athletes.length})</h4>
      ${athletes.map((a) => renderAthleteHtml(a, c, unlinkedChoices)).join("")}
    </section>
  `;
}

// What GPEXE recorded for an unlinked athlete in this session: only a help
// to find the athlete in GPEXE. Values never prove who an athlete is. A v2
// preview (stored before 9-B) reads them from its own results by these keys;
// a v3 preview from the candidate's helperValues (R12), whatever the team's
// mappings are.
const LINK_CONTEXT_KEYS = ["gpexe_total_distance", "gpexe_max_speed", "gpexe_time_min"];

function renderLinkContextHtml(a, c) {
  if (isV3(c?.preview)) return renderHelperContextHtml(a, c);
  const whole = (a.results || []).find((r) => r.level !== "drill");
  const values = LINK_CONTEXT_KEYS.map((key) => whole?.values?.find((v) => v.metricKey === key)).filter((v) => v && v.value !== null && v.value !== undefined);
  const drills = new Set((a.results || []).filter((r) => r.level === "drill").map((r) => r.drillIndex)).size;
  if (!values.length && !drills) return `<p class="muted">GPEXE sent no values for this athlete that could help you find them.</p>`;
  return `
    <p class="muted">Recorded by GPEXE for ${escapeHtml(gpexeWho(a.gpexeAthleteId))} in this session - to help you find them in GPEXE. The values do not prove who it is.</p>
    <ul class="gpexe-link-context">
      ${values.map((v) => `<li><span>${escapeHtml(metricName(v))}</span> <strong>${escapeHtml(fmtValue(v.value, v.unit))}</strong></li>`).join("")}
      ${drills ? `<li><span>Drills</span> <strong>${drills}</strong></li>` : ""}
    </ul>
  `;
}

// v3 (R12): the helper values the server read from the session's own
// snapshot for this GPEXE athlete (duration in min, distance in m, top speed
// in km/h, and its drill rows), never the mapped values. A value the source
// did not give is null and is not shown.
function renderHelperContextHtml(a, c) {
  const h = c?.helperValues?.[a.gpexeAthleteId] || {};
  const values = MAP_VALUE_LABELS.filter(([key]) => h[key] !== null && h[key] !== undefined);
  const drills = Number.isInteger(h.drillRows) && h.drillRows > 0 ? h.drillRows : 0;
  if (!values.length && !drills) return `<p class="muted">GPEXE sent no values for this athlete that could help you find them.</p>`;
  return `
    <p class="muted">Recorded by GPEXE for ${escapeHtml(gpexeWho(a.gpexeAthleteId))} in this session - to help you find them in GPEXE. The values do not prove who it is.</p>
    <ul class="gpexe-link-context">
      ${values.map(([key, label, unit]) => `<li><span>${escapeHtml(label)}</span> <strong>${escapeHtml(fmtValue(h[key], unit))}</strong></li>`).join("")}
      ${drills ? `<li><span>Drills</span> <strong>${drills}</strong></li>` : ""}
    </ul>
  `;
}

// Linking is two steps: choose the athlete (nothing is sent), then confirm
// with both sides of the link shown together. No athlete is preselected.
// U3's exact suggestion for this GPEXE athlete, when the server gave one and that
// athlete can still be chosen here. Never preselected.
function suggestedChoice(id, unlinkedChoices) {
  const gx = state.trainingLoad.gpexe;
  const data = gx.suggestions?.status === "ready" ? gx.suggestions.data : null;
  const p = data?.exact?.find((x) => x.gpexeAthleteId === String(id));
  return p ? unlinkedChoices.find((o) => String(o.id) === String(p.athleteId) && !o.duplicate) || null : null;
}

// The row shows the helper values in its cells; the box says so only when there is something to show.
function compactHasValues(a, c) {
  const h = c?.helperValues?.[a.gpexeAthleteId] || {};
  return ["duration", "distance", "maxSpeed"].some((k) => h[k] !== null && h[k] !== undefined);
}

function renderLinkHtml(a, c, unlinkedChoices, { compact = false } = {}) {
  const gx = state.trainingLoad.gpexe;
  const id = a.gpexeAthleteId;
  const pending = gx.linkConfirm && gx.linkConfirm.gpexeAthleteId === id ? gx.linkConfirm : null;
  if (pending) {
    return `
      <div class="gpexe-link-confirm" role="group" aria-label="Confirm the link">
        <p class="gpexe-link-pair"><strong>${escapeHtml(gpexeAthleteLabel(id))}</strong> → <strong>${escapeHtml(pending.athleteName)}</strong></p>
        <p>Link ${escapeHtml(gpexeWho(id))} to ${escapeHtml(pending.athleteName)}? The review updates right away. When this session is imported, ${escapeHtml("this GPEXE athlete")}'s results in this session, and in every GPEXE session imported later, will be imported as ${escapeHtml(pending.athleteName)}.</p>
        ${idTechHtml(id)}
        ${(() => { const wrong = `<p>You can unlink it before the session is imported. Unlinking doesn't change results that are already imported: if the link turns out wrong after an import, those results can't be changed here — ${askWho()}.</p>`; return compact ? `<details class="gpexe-fine"><summary>What if the link is wrong?</summary>${wrong}</details>` : wrong; })()}
        <div class="gpexe-link-actions">
          <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-link-cancel" ${gx.linkBusy ? "disabled" : ""}>Cancel</button>
          <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-link-confirm" ${gx.linkBusy || gx.detail?.updating ? "disabled" : ""}>${gx.linkBusy ? "Linking..." : "Confirm link"}</button>
        </div>
      </div>
    `;
  }
  if (!unlinkedChoices.length) {
    return `<p class="muted">Every athlete of the team without a GPEXE record here is already linked. If ${escapeHtml("this GPEXE athlete")} is one of them, close this review and check the linked athletes under Link athletes.</p>${idTechHtml(id)}`;
  }
  return `
    <div class="gpexe-link">
      ${compact ? "" : `<p><strong>Find ${escapeHtml(gpexeWho(id))} in GPEXE first. Link only if you are sure.</strong></p>`}
      ${duplicateIdentityNames().has(identityNameKey(identityOf(id)?.name || "")) ? `<p class="gpexe-map-caution" role="note">Check: another GPEXE athlete has the same name. Compare the session values below, and the date of birth on Link athletes, before you choose.</p>` : ""}
      ${!identityOf(id)?.name ? `<p class="muted">The number in "${escapeHtml(`GPEXE athlete ${gpexeAthleteOrdinal(id)}`)}" is this athlete's place in OptiMove's list, not the GPEXE id${platformViewer() ? "; the id is under Technical details" : ""}.</p>` : ""}
      ${compact ? (compactHasValues(a, c) ? "" : `<p class="muted">GPEXE sent no values for this athlete that could help you find them.</p>`) : renderLinkContextHtml(a, c)}
      <div class="gpexe-link-row">
        <label><span>Link ${escapeHtml(gpexeWho(id))} to</span>
          <select class="gpexe-select" data-gpexe-link-select="${escapeAttr(id)}">
            <option value="" selected>Choose an athlete of the team</option>
            ${(() => { const sg = suggestedChoice(id, unlinkedChoices); return sg ? `<option value="${escapeAttr(sg.id)}">Suggested: ${escapeHtml(sg.name)}</option>` : ""; })()}
            ${unlinkedChoices.filter((o) => String(o.id) !== String(suggestedChoice(id, unlinkedChoices)?.id)).map((o) => `<option value="${escapeAttr(o.id)}">${escapeHtml(o.name)}${o.duplicate ? " (same name as another athlete)" : ""}</option>`).join("")}
          </select>
        </label>
        <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-link" data-gpexe-athlete-id="${escapeAttr(id)}" ${gx.linkBusy || gx.detail?.updating ? "disabled" : ""}>Link...</button>
      </div>
      ${idTechHtml(id)}
    </div>
  `;
}

// v3: a Left-out entry's reason in the screen's words - an administrator's
// C110 code or an extractor's code - else the server's plain words (a
// coach's answer carries no C110 code), never a code.
function leftOutText(s) {
  if (typeof s?.reason === "string" && Object.hasOwn(SKIP_TEXT, s.reason)) return SKIP_TEXT[s.reason];
  if (typeof s?.message === "string" && s.message.trim()) return s.message.trim().replace(/\.$/, "");
  return (platformViewer() ? "other reason (see Technical details)" : "other reason");
}

// One Technical details line of codes, each once; a missing code (a coach's
// answer carries no C110 code and no source reason) is left out, and so is
// the line when nothing is left.
function codesTech(label, codes) {
  const list = [...new Set(codes.filter((code) => typeof code === "string" && code))];
  return list.length ? [[label, list.join(", ")]] : [];
}

function renderSkippedHtml(a, v3 = false) {
  const skipped = a.skippedValues || [];
  if (!skipped.length) return "";
  return `
    <div class="gpexe-skipped">
      <p class="muted">Left out (${skipped.length}) - a left-out value is not a zero:</p>
      <ul>
        ${skipped.map((s) => `<li>${escapeHtml(resultLabel(s))} · ${escapeHtml(v3 ? variableName(s) : metricName(s))} - ${escapeHtml(v3 ? leftOutText(s) : SKIP_TEXT[s.reason] || (platformViewer() ? "other reason (see Technical details)" : "other reason"))}</li>`).join("")}
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
  const leftOutCount = (a.skippedValues || []).length;
  const unlinked = a.notImported?.code === "athlete_not_linked";
  const v3 = isV3(c?.preview);
  // D29: an athlete the import keeps whose every mapped value was left out is
  // never shown as imported with data - only with its Left-out entries.
  const allLeftOut = v3 && a.allValuesLeftOut === true && !a.notImported;
  const shownResults = allLeftOut ? [] : (a.results || []).filter((r) => r.outcome !== "not_imported" && r.outcome !== "unchanged");
  // Kept open while the coach is linking this athlete (a re-render would
  // otherwise close it under them).
  const open = unlinked && gx.linkOpen === a.gpexeAthleteId;
  const tech = [
    ...(a.gpexeAthleteId ? [["GPEXE athlete id", a.gpexeAthleteId]] : []),
    ...metricNamesTech([...shownResults.flatMap((r) => r.values || []), ...(a.skippedValues || [])], v3),
    ...codesTech("Left-out codes", (a.skippedValues || []).map((s) => s.reason)),
    ...codesTech("Left-out source codes", (a.skippedValues || []).map((s) => s.sourceReason)),
  ];
  return `
    <details class="gpexe-athlete ${a.blocksSession ? "is-blocking" : ""}" ${open ? "open" : ""}>
      <summary>
        <span><strong>${escapeHtml(name)}</strong>${a.blocksSession ? ` <span class="gpexe-badge is-blocked">Blocks the session</span>` : ""}</span>
        <span class="muted">Participation: recorded by GPEXE · GPS: ${escapeHtml(gps)}${a.notImported ? ` · Not imported: ${escapeHtml(a.notImported.message)}` : allLeftOut ? " · All values left out" : outcomeText ? ` · ${escapeHtml(outcomeText)}${leftOutCount ? ` · ${escapeHtml(plural(leftOutCount, "value left out", "values left out"))}` : ""}` : ""}</span>
      </summary>
      ${a.gps?.reason ? `<p class="muted">${escapeHtml(a.gps.reason.message)}</p>` : ""}
      ${allLeftOut ? `<p class="muted">All values left out: participation is recorded, but no value is imported for this athlete. The reasons are listed under Left out.</p>` : ""}
      ${unlinked ? `<p class="muted">Link this athlete in the Session review above.</p>` : ""}
      ${shownResults.map((r) => `
        <div class="gpexe-result">
          <p>${escapeHtml(resultLabel(r))} · ${escapeHtml(OUTCOME_TEXT[r.outcome] || r.outcome)}${v3 && !(r.values || []).some((v) => v.value !== null && v.value !== undefined) ? " · no value imported (see Left out)" : ""}</p>
          ${renderValueTableHtml(r.values.filter((v) => v.change !== "same" || r.outcome === "created"), r.outcome !== "created", v3)}
        </div>
      `).join("")}
      ${renderSkippedHtml(a, v3)}
      ${adminTechHtml(tech)}
    </details>
  `;
}

// J20-A2: one table for the whole session. Every athlete of the review has a
// row and one status, so the coach sees at a glance who is imported, who needs
// a link and who has nothing to import. The details below the table keep the
// per-athlete values, the Left-out reasons and the link flow unchanged.
const ROW_STATUS = Object.freeze({
  importable: { label: "Importable", note: "Ready to import.", counts: true },
  participation: { label: "Participation only", note: "Present in this session; no value is imported.", counts: true },
  needs_link: { label: "Needs a link", note: "Not imported until linked.", counts: false },
  blocked: { label: "Blocks the session", note: "The whole session waits until this is fixed.", counts: false },
  not_imported: { label: "Not imported", note: "", counts: false },
  nothing_new: { label: "Nothing new", note: "Already in OptiMove; nothing new to import.", counts: false },
  no_record: { label: "No GPEXE record", note: "No GPS record in this session; nothing is written.", counts: false },
  // J20-B: a choice, not a problem. The roster is where the coach says whether the athlete took part.
  left_out: { label: "Left out by you", note: "You left this athlete out of the import. Nothing of them is stored from this session; open the session's Roster tab to say whether they took part.", counts: false },
});

// Only an outcome that writes counts: created, supplemented, corrected. An
// unchanged result, one kept aside for review and a stale resend write nothing.
const WRITING_OUTCOMES = new Set(["created", "supplemented", "corrected"]);
function valuesToImport(a) {
  return (a.results || []).filter((r) => WRITING_OUTCOMES.has(r.outcome)).reduce((n, r) => n + (r.values || []).filter((v) => v.value !== null && v.value !== undefined).length, 0);
}

function reviewRowStatus(a, preview) {
  if (a.blocksSession) return "blocked";
  if (a.notImported?.code === "athlete_not_linked") return "needs_link";
  if (a.notImported) return "not_imported";
  if (isV3(preview) && a.allValuesLeftOut === true) return "participation";
  if (valuesToImport(a) > 0) return "importable";
  // Results exist but none writes (already imported, kept aside, stale): nothing new.
  if ((a.results || []).some((r) => r.outcome !== "not_imported")) return "nothing_new";
  return "participation";
}

// The number Approve names: the athletes the approval imports (Importable and
// Participation only). A row that needs a link, blocks, is not imported or has
// no record is not part of it.
export function importableAthleteCount(preview) {
  return (preview?.athletes || []).filter((a) => ROW_STATUS[reviewRowStatus(a, preview)].counts).length;
}

function changesByAthlete(preview) {
  const m = new Map();
  for (const ch of preview?.changesToImported || []) {
    const key = ch.athleteId ? `a:${ch.athleteId}` : `g:${ch.gpexeAthleteId}`;
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
}

// The three values the team's mappings fill and a coach reads first; every
// other variable lives under Details by athlete. A source field's key (v3) or
// the old metric key (v2) tells which value is which.
const VALUE_COLUMNS = Object.freeze([
  { label: "Duration", keys: ["athlete_session.total_time", "gpexe_time_min"], helper: "duration", unit: "min" },
  { label: "Total distance", keys: ["athlete_session.total_distance", "gpexe_total_distance"], helper: "distance", unit: "m" },
  { label: "Max running speed", keys: ["athlete_session.max_v", "gpexe_max_speed"], helper: "maxSpeed", unit: "km/h" },
]);

// What the import would write for the whole session, or "-" (never a zero for
// a value that is missing). A GPEXE athlete not linked yet shows the helper
// values the server read from the session (they help to find the athlete).
function valueCellText(row, col, c) {
  const whole = (row.a?.results || []).filter((r) => r.level !== "drill" && WRITING_OUTCOMES.has(r.outcome));
  for (const r of whole) {
    const v = (r.values || []).find((x) => (col.keys.includes(x.sourceMetricKey) || col.keys.includes(x.metricKey)) && x.value !== null && x.value !== undefined);
    if (v) return fmtValue(v.value, v.unit || col.unit);
  }
  if (row.status === "needs_link") {
    const h = c?.helperValues?.[row.a.gpexeAthleteId];
    if (h && h[col.helper] !== null && h[col.helper] !== undefined) return fmtValue(h[col.helper], col.unit);
  }
  return "-";
}

const PROBLEM_KIND = { needs_link: "not_linked", no_record: "no_data", blocked: "review", not_imported: "review" };

// 6a: a GPS athlete whose recorded time is clearly shorter than the session's longest (below SHORT_SHARE of it) gets a yellow
// "Check": a hint only, never a decision (in a match a substitution is normal). The time is the Duration the import writes for
// the whole session (athlete_session.total_time, in minutes) - the value the Duration cell shows - or, for an athlete not
// linked yet, the helper value the server read from the session (shown in the same cell). A Duration in another unit is never
// compared.
export const SHORT_SHARE = 0.75;
const DURATION = VALUE_COLUMNS[0];
function durationMinutes(r, c) {
  if (!r.a) return null;
  if (r.a.allValuesLeftOut !== true) {
    for (const res of (r.a.results || []).filter((x) => x.level !== "drill" && WRITING_OUTCOMES.has(x.outcome))) {
      const v = (res.values || []).find((x) => (DURATION.keys.includes(x.sourceMetricKey) || DURATION.keys.includes(x.metricKey)) && x.value !== null && x.value !== undefined);
      if (!v) continue;
      const n = Number(v.value);
      return (v.unit || DURATION.unit) === DURATION.unit && Number.isFinite(n) ? n : null;
    }
  }
  if (r.status !== "needs_link") return null;
  const h = c?.helperValues?.[r.a.gpexeAthleteId]?.duration;
  return h === null || h === undefined || !Number.isFinite(Number(h)) ? null : Number(h);
}
// The rows' times, the session's longest (every recorded time, the athletes left out included, so the reference is the same
// before and after the import), and which rows are short. Only a row the import would write, and that the coach has not
// ticked to leave out, can be short.
function markShortRecordings(rows, c, chosen = new Set()) {
  for (const r of rows) r.minutes = durationMinutes(r, c);
  const longest = Math.max(0, ...rows.filter((r) => r.minutes !== null).map((r) => r.minutes));
  for (const r of rows) {
    r.longest = longest || null;
    r.ticked = Boolean(r.a?.gpexeAthleteId && chosen.has(String(r.a.gpexeAthleteId)));
    r.wasShort = Boolean(longest) && r.minutes !== null && (r.status === "importable" || r.status === "participation") && r.minutes < SHORT_SHARE * longest;
    r.short = r.wasShort && !r.ticked;
  }
}
// The athlete's time rounded down (74.9 of 100 reads "74 / 100", never "75 / 100" next to an unflagged 75), the longest rounded.
const minutesText = (n, down = false) => String(down ? Math.floor(n) : Math.round(n));
const REVIEW_ORDER = ["blocked", "needs_link", "not_imported", "no_record", "importable", "participation", "nothing_new", "left_out"];

function unlinkedChoicesFor(preview, c) {
  const linked = new Set((state.trainingLoad.gpexe.links || []).map((l) => String(l.athleteId)));
  const choices = (preview.teamAthletesWithoutGpexeRecord || [])
    .filter((a) => !linked.has(String(a.athleteId)))
    .map((a) => ({ id: a.athleteId, name: athleteName(c, a.athleteId, null) }));
  const allNames = Object.values(c.athletes || {}).map((a) => (a?.name || "").trim().toLowerCase());
  for (const o of choices) o.duplicate = allNames.filter((n) => n === o.name.trim().toLowerCase()).length > 1;
  return choices;
}

function reviewRowsOf(preview, c) {
  const changes = changesByAthlete(preview);
  // J20-B: an imported session was approved with some athletes left out by the coach; the stored preview is the whole
  // candidate's, so the recorded set (the approval) marks those rows.
  const leftOut = new Set(c?.approval?.excludedAthleteIds || []);
  const rows = (preview.athletes || []).map((a) => {
    if (leftOut.has(String(a.gpexeAthleteId))) {
      return { a, name: athleteName(c, a.athleteId, a.gpexeAthleteId), status: "left_out", label: ROW_STATUS.left_out.label, note: ROW_STATUS.left_out.note, changes: 0, leftOutByCoach: true };
    }
    const status = reviewRowStatus(a, preview);
    const info = ROW_STATUS[status];
    const n = changes.get(a.athleteId ? `a:${a.athleteId}` : `g:${a.gpexeAthleteId}`) || 0;
    const note = status === "not_imported" ? `Not imported: ${a.notImported?.message || (platformViewer() ? "open its row under Details by athlete" : "see why under Values by athlete")}` : info.note;
    return { a, name: athleteName(c, a.athleteId, a.gpexeAthleteId), status, label: info.label, note, changes: n };
  });
  for (const t of preview.teamAthletesWithoutGpexeRecord || []) rows.push({ a: null, athleteId: t.athleteId, name: athleteName(c, t.athleteId, null), status: "no_record", label: ROW_STATUS.no_record.label, note: ROW_STATUS.no_record.note, changes: 0 });
  rows.sort((x, y) => REVIEW_ORDER.indexOf(x.status) - REVIEW_ORDER.indexOf(y.status));
  return rows;
}

// J20-B: the athletes the coach has ticked as "Leave out" in this review (in memory only), and whether the checkbox is offered at all.
function leaveOutOf(detail) {
  return new Set(detail?.leaveOut || []);
}

// Offered only where the approval itself is offered: a pending, confirmed session, a viewer who may approve, no blocker, no
// link change waiting for an update, nothing in flight. The server decides again (the identical rules, step 12).
export function leaveOutOffered(c, detail = state.trainingLoad.gpexe.detail, status = state.trainingLoad.gpexe.status) {
  const gx = state.trainingLoad.gpexe;
  if (!c || c.status !== "pending" || c.preview?.status !== "ready") return false;
  if (status?.viewer?.canApprove !== true) return false;
  if ((c.approvalBlockers || []).filter((b) => b !== "blocked").length) return false;
  if (notConfirmedForImport(c) || withdrawnByCheck(c) || reviewMadeBeforeLinkChange(c, gx)) return false;
  if (detail?.approving || detail?.updating || detail?.outcome?.kind === "imported" || detail?.outcome?.kind === "unknown") return false;
  return true;
}

function reviewRowHtml(r, c, choices, lo = { offered: false, chosen: new Set() }) {
  const ready = r.status === "importable" || r.status === "participation";
  const badge = ready ? "is-ready" : r.status === "no_record" || r.status === "nothing_new" || r.status === "left_out" ? "" : "is-blocked";
  const cells = VALUE_COLUMNS.map((col) => {
    // "41 / 94 min" on a flagged row only; every other row shows its time as before.
    const text = col === DURATION && r.short ? `${minutesText(r.minutes, true)} / ${minutesText(r.longest)} min` : (r.a ? valueCellText(r, col, c) : "-");
    return `<td data-label="${escapeAttr(col.label)}" role="cell"${col === DURATION && r.short ? ` class="gpexe-short-cell"` : ""}>${escapeHtml(text)}</td>`;
  }).join("");
  // The choice is named only where it exists: the Leave out box on this very row, or (for a viewer who may not import) a
  // session still waiting for its import.
  const shortFact = r.short ? `Only ${minutesText(r.minutes, true)} of ${minutesText(r.longest)} min recorded (the longest in this session).` : "";
  const shortNote = !r.short ? ""
    : lo.offered && leaveOutAvailable(r) ? ` ${shortFact} Imported as is unless you tick Leave out and choose "Participated · no device data".`
      : !lo.offered && c?.status === "pending" && leaveOutAvailable(r) ? ` ${shortFact} Whoever imports can keep the values or leave them out as "Participated · no device data".`
        : ` ${shortFact}`;
  const link = r.status === "needs_link" ? renderLinkHtml(r.a, c, choices, { compact: !!c?.helperValues }) : "";
  return `
    <tr class="gpexe-review-row is-${r.status}" role="row">
      <th scope="row" data-label="Athlete" role="rowheader">${escapeHtml(r.name)}</th>
      <td data-label="Status" role="cell"><span class="gpexe-badge ${badge}">${escapeHtml(r.label)}</span>${r.short ? ` <span class="gpexe-badge is-check">Check</span>` : ""}${r.changes ? ` <span class="gpexe-badge is-unknown">${escapeHtml(`Changes ${plural(r.changes, "imported result", "imported results")}`)}</span>` : ""}</td>
      ${cells}
      <td data-label="What happens" role="cell">${escapeHtml(lo.states && r.status === "no_record" ? "No GPS record in this session. You can set their attendance here; it is saved after the import." : r.note)}${escapeHtml(shortNote)}${r.changes ? ` ${escapeHtml("The change must be accepted before the import.")}` : ""}${lo.states ? stateChooserHtml(r, lo) : ""}</td>
      ${lo.offered ? leaveOutCellHtml(r, lo) : ""}
    </tr>${link ? `
    <tr class="gpexe-review-link" role="presentation"><td colspan="${VALUE_COLUMNS.length + 3 + (lo.offered ? 1 : 0)}" role="presentation">${link}</td></tr>` : ""}`;
}

// J20-C: the athlete a row's attendance state is for, before the import - a team athlete without a GPEXE record, or one the coach
// ticks to leave out - or null. Everyone else gets their state from the import itself.
function stateAthleteOf(r, lo) {
  if (r.status === "no_record" && r.athleteId) return String(r.athleteId);
  if (r.a?.athleteId && r.a.gpexeAthleteId && lo.chosen.has(String(r.a.gpexeAthleteId))) return String(r.a.athleteId);
  return null;
}

// The ids that may get a state in this review (the same rule as the rows).
export function stateAthleteIds(c, detail) {
  if (!statesOffered(c, detail)) return [];
  const lo = { chosen: leaveOutOf(detail) };
  return reviewRowsOf(c.preview, c).map((r) => stateAthleteOf(r, lo)).filter(Boolean);
}

export function statesOffered(c, detail = state.trainingLoad.gpexe.detail) {
  return leaveOutOffered(c, detail);
}

// "Attendance" under the row's note: saved right after the import (optional).
function stateChooserHtml(r, lo) {
  const athleteId = stateAthleteOf(r, lo);
  if (!athleteId) return "";
  const value = choiceValue(lo.detail, athleteId);
  const reasons = lo.reasons || [];
  const options = [`<option value="">Not set</option>`, `<option value="participated_no_values"${value === "participated_no_values" ? " selected" : ""}>Participated · no device data</option>`]
    .concat(reasons.map((x) => `<option value="${escapeAttr(`did_not_participate:${x.key}`)}"${value === `did_not_participate:${x.key}` ? " selected" : ""}>${escapeHtml(`Did not participate · ${x.label}`)}</option>`));
  return `<label class="gpexe-state-choice"><span>Attendance</span><select class="gpexe-select gpexe-state-select" data-action="training-load-gpexe-state" data-athlete-id="${escapeAttr(athleteId)}" aria-label="${escapeAttr(`Attendance for ${r.name}`)}" ${lo.statesLocked ? "disabled" : ""}>${options.join("")}</select></label>`;
}

// Whether this row can be left out: a row the import would write, of an athlete whose results are all new. An athlete whose
// results were imported before (any result that is not new) cannot be left out: the server refuses it, so no box.
function leaveOutAvailable(r) {
  const newOnly = (r.a?.results || []).every((x) => !x.outcome || x.outcome === "created" || x.outcome === "not_imported");
  return Boolean(r.a && newOnly && (r.status === "importable" || r.status === "participation") && r.a.gpexeAthleteId);
}

// The "Leave out" cell of a row the import would write. The accessible name carries the athlete, so a screen reader hears who.
function leaveOutCellHtml(r, lo) {
  // A row the import would not write has nothing to leave out: an empty cell on a wide table, no line at all in the phone cards.
  if (!leaveOutAvailable(r)) return `<td role="cell" class="gpexe-leave-out-cell is-empty" aria-hidden="true"></td>`;
  const id = String(r.a.gpexeAthleteId);
  return `<td data-label="Leave out" role="cell" class="gpexe-leave-out-cell"><label class="gpexe-leave-out"><input type="checkbox" data-action="training-load-gpexe-leave-out" data-gpexe-athlete-id="${escapeAttr(id)}" ${lo.chosen.has(id) ? "checked" : ""} aria-label="${escapeAttr(`Leave out ${r.name}`)}"><span>Leave out</span></label></td>`;
}

function reviewTableOf(rows, c, choices, lo = { offered: false, chosen: new Set() }) {
  return `<div class="gpexe-values-wrap"><table class="gpexe-values gpexe-review-rows" role="table">
    <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Athlete</th><th scope="col" role="columnheader">Status</th>${VALUE_COLUMNS.map((col) => `<th scope="col" role="columnheader">${escapeHtml(col.label)}</th>`).join("")}<th scope="col" role="columnheader">What happens</th>${lo.offered ? `<th scope="col" role="columnheader">Leave out</th>` : ""}</tr></thead>
    <tbody role="rowgroup">${rows.map((r) => reviewRowHtml(r, c, choices, lo)).join("")}</tbody>
  </table></div>`;
}

const REVIEW_CHIPS = [["needs", "Needs you"], ["not_linked", "Not linked"], ["short", "Short recording"], ["no_data", "No GPS"], ["review", "Needs review"], ["all", "All"]];
// The chip a row belongs to: its problem, or "short" for a row the import would write whose time is short (6a).
// A flagged row the coach ticked to leave out loses its flag but stays shown until its attendance is chosen (the note's second step).
const rowKind = (r) => PROBLEM_KIND[r.status] || (r.short || r.awaitingState ? "short" : null);

function renderReviewTableHtml(preview, c, detail = state.trainingLoad.gpexe.detail) {
  const rows = reviewRowsOf(preview, c);
  if (!rows.length) return "";
  markShortRecordings(rows, c, leaveOutOf(detail));
  const choices = unlinkedChoicesFor(preview, c);
  const lo = { offered: leaveOutOffered(c, detail), chosen: leaveOutOf(detail) };
  // J20-C: the attendance chooser, on the same rows and under the same conditions as Leave out.
  lo.states = statesOffered(c, detail);
  lo.detail = detail;
  lo.reasons = detail?.participationReasons || [];
  // A choice is fixed once its keys are made (the import is in flight, imported, or its outcome unknown): never an enabled select
  // whose change would be ignored.
  lo.statesLocked = !!detail?.approving || statesLockedOf(detail);
  for (const r of rows) r.awaitingState = r.wasShort && r.ticked && lo.states && !choiceValue(detail, String(r.a?.athleteId));
  const problem = rows.filter((r) => rowKind(r));
  const fine = rows.filter((r) => !rowKind(r));
  const counts = { needs: 0, not_linked: 0, short: 0, no_data: 0, review: 0, all: rows.length };
  for (const r of problem) counts[rowKind(r)] += 1;
  // A team athlete without a GPEXE record is "a person to act on" where the attendance chooser is offered (J20-C); otherwise
  // they stay visible under their own chip and under All only.
  const noDataOpen = lo.states ? problem.filter((r) => r.status === "no_record" && !choiceValue(detail, String(r.athleteId))).length : 0;
  counts.needs = counts.not_linked + counts.review + counts.short + noDataOpen;
  const gx = state.trainingLoad.gpexe;
  let filter = REVIEW_CHIPS.some(([k]) => k === gx.reviewFilter) && (counts[gx.reviewFilter] > 0 || gx.reviewFilter === "all") ? gx.reviewFilter : (counts.needs ? "needs" : "all");
  const shown = filter === "all" ? problem : problem.filter((r) => (filter === "needs" ? (rowKind(r) !== "no_data" || (lo.states && !choiceValue(detail, String(r.athleteId)))) : rowKind(r) === filter));
  const n = importableAthleteCount(preview);
  const partOnly = rows.filter((r) => r.status === "participation").length;
  const needLink = counts.not_linked;
  const chips = REVIEW_CHIPS.filter(([k]) => k === "all" || counts[k] > 0).map(([k, label]) => `<button type="button" class="gpexe-chip${filter === k ? " is-active" : ""}" data-action="training-load-gpexe-review-filter" data-filter="${k}" aria-pressed="${filter === k}">${escapeHtml(label)} <span class="gpexe-chip-count">${counts[k]}</span></button>`).join("");
  const updating = detail?.updating ? `<p class="muted" role="status">Updating the review...</p>` : "";
  const updateError = detail?.updateError ? `
      <div class="gpexe-warning" role="alert"><p>${escapeHtml(detail.updateError.status === 429 || detail.updateError.code === "try_again" ? "The review could not be updated right now. Try again in a moment." : "The link was made, but the review could not be updated.")}</p>
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-review-update" ${detail.updating ? "disabled" : ""}>Update the review</button></div>` : "";
  return `
    <section class="gpexe-review-table" aria-label="Session review">
      <h4>Session review (${plural(rows.length, "athlete", "athletes")})</h4>
      <p class="muted">${n ? `${plural(n - Math.min(n, leaveOutIds(c, detail).length), "athlete is", "athletes are")} ready to import${partOnly ? ` (${partOnly} participation only)` : ""}${leaveOutIds(c, detail).length ? `, ${leaveOutIds(c, detail).length} left out` : ""}.` : "No athlete can be imported yet."}${needLink ? ` ${plural(needLink, "athlete needs", "athletes need")} a link first.` : ""}</p>
      ${updating}${updateError}
      ${lo.offered && rows.some((r) => r.status === "importable" || r.status === "participation") ? `<p class="muted">To import without someone, tick Leave out on their row${fine.length && shown.length && filter !== "all" ? ` (open "${escapeHtml(plural(fine.length, "athlete is fine", "athletes are fine"))}" below)` : ""}.</p>` : ""}
      ${lo.states && stateAthleteIds(c, detail).length ? `<p class="muted">Attendance you choose on a row is optional. It is saved right after the import, and you can change it later in the Roster tab.</p>` : ""}
      ${needLink ? `<p class="muted gpexe-review-howto">Link each GPEXE athlete to the right athlete of your team.${c?.helperValues ? " The values on the row help you find them in GPEXE; if you are not sure, check there first." : ""}</p>` : ""}
      <div class="gpexe-chips" role="group" aria-label="Show">${chips}</div>
      ${shown.length ? reviewTableOf(shown, c, choices, lo) : ""}
      ${fine.length ? `<details class="gpexe-fine"${filter === "all" || !shown.length ? " open" : ""}><summary>${escapeHtml(plural(fine.length, "athlete is fine", "athletes are fine"))}</summary>${reviewTableOf(fine, c, choices, lo)}</details>` : ""}
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
        ${r.approval?.excludedAthleteIds?.length ? `<p>${escapeHtml(`${plural(r.approval.excludedAthleteIds.length, "athlete was", "athletes were")} left out, as you chose.${statesSummary(detail) ? "" : " Open the session's Roster tab to say whether they took part."}`)}</p>` : ""}
        ${r.commitConfirmation === "verified_after_commit_error" ? `<p>The database's confirmation did not arrive in time, but the server found the import committed.</p>` : ""}
        ${r.candidateReadError ? `<p>${escapeHtml(r.candidateReadError.message)}</p>` : ""}
      </div>
      ${statesOutcomeHtml(detail)}
    `;
  }
  if (o.kind === "unknown") {
    const verified = o.verified;
    if (verified === "imported") {
      // J20-B: a lost answer is retried by checking, never by a second approval; the RECORDED set says what was really left out.
      const recorded = o.approval?.excludedAthleteIds;
      const chosen = o.chosenExcluded;
      const differs = Array.isArray(recorded) && Array.isArray(chosen) && !sameIds(recorded, chosen);
      return `<div class="gpexe-success" role="status"><p><strong>Imported.</strong> Checked: the import is in OptiMove.</p>
        ${Array.isArray(recorded) && recorded.length ? `<p>${escapeHtml(`${plural(recorded.length, "athlete was", "athletes were")} left out of this import.`)}</p>` : ""}
        ${differs ? `<p class="gpexe-warning" role="alert">${escapeHtml(recorded.length
    ? `Imported. Left out: ${leftOutNames(detail.candidate, recorded.map(String)).join(", ")}. This differs from your current ticks; what is shown is what was imported.`
    : `Imported with nobody left out, although you had ticked ${leftOutNames(detail.candidate, (chosen || []).map(String)).join(", ")}.`)}</p>` : ""}
        ${reviewErrorTech(o.error)}</div>${statesOutcomeHtml(detail)}`;
    }
    return `
      <div class="gpexe-unknown" role="alert">
        <p><strong>We can't tell yet whether this session was imported.</strong> Don't enter the data by hand and don't assume either way - check the result first.</p>
        ${verified === "not_visible_yet" ? `<p>The import is not visible yet; we are still checking the result. Check again in a moment. Importing again is safe: the server never imports the same session twice.</p>` : ""}
        ${verified === "still_unknown" ? `<p>Still not clear. Check again in a moment.</p>` : ""}
        ${(o.checks || 0) >= GIVE_UP_AFTER_CHECKS ? `<p><strong>Still not confirmed after ${o.checks} checks.</strong> ${platformViewer() ? "Ask a platform admin" : AskWho()} to check this import${giveTech()}. Until then, don't enter the data by hand.</p>` : ""}
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-verify" ${detail.verifying ? "disabled" : ""}>${detail.verifying ? "Checking..." : verified ? "Check again" : "Check the result"}</button>
        ${reviewTechHtml([["HTTP status", o.error?.status || "no answer"], ["Code", o.error?.code], ["Server message", o.error?.message], ["Approval id", o.verify?.approvalId], ["Check error", o.verifyError ? `${o.verifyError.status || "no answer"} ${o.verifyError.code || ""}`.trim() : undefined]])}
      </div>
    `;
  }
  const code = o.error?.code;
  // Another approval (or an earlier, unconfirmed one) got there first: the
  // session is in OptiMove - a final, successful outcome.
  if (code === "already_imported") {
    return `<div class="gpexe-success" role="status"><p><strong>Already imported.</strong> Nothing more was written.</p>${reviewErrorTech(o.error)}</div>`;
  }
  const reviewAgain = o.error?.data?.reviewAgain;
  return `
    <div class="gpexe-refused" role="alert">
      <p>${escapeHtml(REFUSAL_TEXT[code] || (o.error?.status === 404 ? "Not imported: this session is not available." : "Not imported: the server refused the approval."))}</p>
      ${reviewAgain?.candidateId ? `<button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-open" data-candidate-id="${escapeAttr(reviewAgain.candidateId)}">Review again</button>` : ""}
      ${reviewErrorTech(o.error)}
    </div>
  `;
}

// The session imports at least one athlete through a GPEXE link: a stable
// fact of the preview (athleteId comes only from the team's links), not of
// what was clicked in this browser. A linked athlete left out doesn't count.
export function importsLinkedAthletes(c) {
  return (c?.preview?.athletes || []).some((a) => a.athleteId && !a.notImported);
}

// D32 (9-B): the number of values left out is named before an approval.
function approveLeftOutText(c) {
  const left = Number(c?.preview?.counts?.skippedValues ?? c?.counts?.skippedValues);
  const some = Number.isInteger(left) && left > 0;
  if (!platformViewer()) {
    // P1: the coach's words; the count stays named before the import (D32), the list is under Values by athlete.
    return `Import adds this session to Training Load as shown.${some ? ` ${left === 1 ? "1 value is" : `${left} values are`} left out (see Values by athlete).` : ""} Athletes left out stay out.`;
  }
  if (some) {
    return `Approving imports this whole session exactly as shown. ${left === 1 ? "1 value is" : `${left} values are`} left out (listed under each athlete); ${left === 1 ? "it is" : "they are"} not imported and never stored as a zero. Athletes left out stay out.`;
  }
  return "Approving imports this whole session exactly as shown. Athletes and values left out stay out.";
}

// The ticked athletes that are still importable rows of this review (a stale tick from before an update is not counted).
export function leaveOutIds(c, detail) {
  const importable = new Set((c?.preview?.athletes || []).filter((a) => ROW_STATUS[reviewRowStatus(a, c.preview)].counts && a.gpexeAthleteId).map((a) => String(a.gpexeAthleteId)));
  return [...leaveOutOf(detail)].filter((id) => importable.has(id)).sort((a, b) => Number(a) - Number(b));
}

export function sameIds(a, b) {
  const x = [...(a || [])].map(String).sort();
  const y = [...(b || [])].map(String).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function leftOutNames(c, ids) {
  const byId = new Map((c.preview?.athletes || []).map((a) => [String(a.gpexeAthleteId), a]));
  return ids.map((id) => { const a = byId.get(id); return a ? athleteName(c, a.athleteId, a.gpexeAthleteId) : "an athlete"; });
}

// The set no longer fits the session: another review of the session is needed, not the same request again.
const STALE_SET_CODES = new Set(["invalid_exclusion", "invalid_excluded_athlete"]);
const SUBSET_ERROR_TEXT = {
  try_again: "The review without them could not be made right now. Try again in a moment.",
  no_importable_athlete: "Leaving these athletes out would leave nobody to import.",
  invalid_exclusion: "The session changed, and one of the athletes you left out is no longer part of it. Update the review, then choose again.",
  invalid_excluded_athlete: "The session changed, and one of the athletes you left out is no longer part of it. Update the review, then choose again.",
  nothing_to_import: "The athletes that remain have nothing new to import.",
  subset_blocked: "This session can't be imported right now. Update the review, then choose again.",
  not_an_approver: "You may not approve imports for this team.",
};

function renderSubsetApproveHtml(c, detail, leave, importN, changes) {
  const names = leftOutNames(c, leave);
  const sub = detail.subset && sameIds(detail.subset.ids, leave) ? detail.subset : null;
  const ready = sub?.status === "ready";
  const after = ready ? importableAthleteCount(sub.preview) : importN - leave.length;
  const loading = sub?.status === "loading";
  const failed = sub?.status === "error";
  return `
    <div class="gpexe-approve gpexe-approve-subset">
      <p><strong>${escapeHtml(`Leaving out ${plural(leave.length, "athlete", "athletes")}: ${names.join(", ")}.`)}</strong>
        <span class="muted">${leave.length === 1 ? `Nothing of ${escapeHtml(names[0])} is imported from this session.` : "Nothing of them is imported from this session."} If GPEXE later sends different data for it, you will review it again. You can set their attendance on their rows now, or later in the session's Roster tab.</span></p>
      ${failed ? `<p class="gpexe-warning" role="alert">${escapeHtml(SUBSET_ERROR_TEXT[sub.error?.code] || "The review without them could not be made. Nothing was imported.")}</p>` : ""}
      ${ready ? `<p class="muted" role="status">${escapeHtml(`Reviewed without them: ${plural(after, "athlete", "athletes")} will be imported.`)}</p>` : ""}
      ${statesLineHtml(c, detail)}
      ${!ready && !loading && !failed ? `<p class="muted">First we check the import without them. Nothing is saved yet.</p>` : ""}
      ${after <= 0 && !loading ? `<p class="muted gpexe-approve-note">Nobody would be left to import. Untick an athlete to continue.</p>` : ""}
      <div class="gpexe-approve-bar${after <= 0 ? " is-idle" : ""}">
      ${changes ? `
        <label class="gpexe-accept">
          <input type="checkbox" data-gpexe-accept data-action="training-load-gpexe-accept" ${detail.acceptChanges ? "checked" : ""}>
          <span>I accept the ${escapeHtml(plural(changes, "change", "changes"))} to results that were already imported.</span>
        </label>
      ` : ""}
        ${ready
    ? `<button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-approve" ${detail.approving || after <= 0 ? "disabled" : ""}>${detail.approving ? "Importing..." : `Import ${plural(after, "athlete", "athletes")}`}</button>`
    : failed && STALE_SET_CODES.has(sub.error?.code)
      ? `<button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-review-update" ${detail.updating ? "disabled" : ""}>${detail.updating ? "Updating..." : "Update the review"}</button>`
      : `<button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-subset-review" ${loading || after <= 0 ? "disabled" : ""}>${loading ? "Checking..." : failed ? "Try again" : "Review without them"}</button>`}
      </div>
    </div>
  `;
}

// J20-C: what the button does after the import.
function statesLineHtml(c, detail) {
  const n = chosenStateCount(detail, stateAthleteIds(c, detail));
  return n ? `<p class="muted gpexe-states-line">${escapeHtml(`After the import, OptiMove also saves ${plural(n, "attendance state", "attendance states")}.`)}</p>` : "";
}

// J20-C: the attendance states after a confirmed import, one sentence per case: saved; not saved yet (nothing sent); not confirmed
// (Check the result repeats the same request); not saved for certain (with what to do).
const n = (list) => list.reduce((k, x) => k + x.n, 0);
function statesFinalText(list) {
  const undone = list.filter((x) => x.code === "import_undone");
  const rest = list.filter((x) => x.code !== "import_undone");
  const out = [];
  if (undone.length) out.push("The import was undone, so its attendance states were not saved.");
  if (rest.length) {
    const k = n(rest);
    out.push(rest.every((x) => x.code === "import_states_window_closed" || x.code === "notFound")
      ? `${plural(k, "attendance state was", "attendance states were")} not saved with the import. Set ${k === 1 ? "it" : "them"} in the session's Roster tab.`
      : `${plural(k, "attendance state was", "attendance states were")} not saved. Nothing was written; set ${k === 1 ? "it" : "them"} in the session's Roster tab.`);
  }
  return out.join(" ");
}

function statesOutcomeHtml(detail) {
  const s = statesSummary(detail);
  if (!s) return "";
  if (s.saving) return `<p class="muted" role="status">Saving attendance states...</p>`;
  if (s.notTaken) return `<p class="gpexe-warning" role="note">${escapeHtml(`${plural(s.notTaken, "attendance state you chose was", "attendance states you chose were")} not saved with this import. Set ${s.notTaken === 1 ? "it" : "them"} in the session's Roster tab.`)}</p>`;
  const parts = [];
  if (s.saved) parts.push(`<p>${escapeHtml(`${plural(s.saved, "attendance state", "attendance states")} saved. You can change ${s.saved === 1 ? "it" : "them"} in the session's Roster tab.`)}</p>`);
  if (s.alreadySet) parts.push(`<p class="muted">${escapeHtml(`${plural(s.alreadySet, "athlete already had", "athletes already had")} a state from the Roster tab; it was kept.`)}</p>`);
  const unknownChecked = s.unknown.filter((x) => x.code);
  const unknownOpen = s.unknown.filter((x) => !x.code);
  if (unknownOpen.length) {
    parts.push(`<div class="gpexe-unknown" role="alert"><p>${escapeHtml(`We can't tell yet whether ${plural(n(unknownOpen), "attendance state was", "attendance states were")} saved. The import itself is done.`)}</p>
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-states-check">Check the result</button></div>`);
  }
  if (unknownChecked.length) {
    parts.push(`<div class="gpexe-unknown" role="alert"><p>${escapeHtml(`We can't tell whether ${plural(n(unknownChecked), "attendance state was", "attendance states were")} saved, and it can't be checked from here. Look at the session's Roster tab. The import itself is done.`)}</p></div>`);
  }
  const notSent = [...s.unread, ...s.pending];
  if (notSent.length) {
    const why = s.unread.length ? " The session's roster could not be read; nothing was sent." : "";
    parts.push(`<div class="gpexe-warning" role="note"><p>${escapeHtml(`${plural(n(notSent), "attendance state you chose is", "attendance states you chose are")} not saved yet.${why} The import itself is done.`)}</p>
      <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-states-again">Save them</button></div>`);
  }
  if (s.refused.length) {
    const busy = s.refused.every((x) => x.code === "try_again" || x.code === "roster_busy");
    const changed = s.refused.every((x) => x.code === "bulk_conflict" || x.code === "decision_changed");
    const why = busy ? ": the server was busy" : changed ? ": the attendance changed meanwhile" : " this time";
    parts.push(`<div class="gpexe-refused" role="alert"><p>${escapeHtml(`${plural(n(s.refused), "attendance state was", "attendance states were")} not saved${why}. Nothing was written; the import is done.`)}</p>
      <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-states-again">Save them again</button></div>`);
  }
  if (s.final.length) parts.push(`<p class="gpexe-warning" role="note">${escapeHtml(statesFinalText(s.final))}</p>`);
  return parts.length ? `<div class="gpexe-states-outcome">${parts.join("")}</div>` : "";
}

function renderApproveHtml(c, detail, status) {
  // J20-C: a reopened imported session whose attendance states are not settled yet shows them (the outcome panel does otherwise).
  if (c.status === "imported" || detail.outcome?.kind === "imported" || detail.outcome?.verified === "imported") return detail.outcome ? "" : statesOutcomeHtml(detail);
  if (detail.outcome?.error?.code === "already_imported") return "";
  if (detail.outcome?.kind === "unknown" && detail.outcome.verified !== "not_visible_yet") return "";
  const gx = state.trainingLoad.gpexe;
  const group = candidateGroup(c, gx);
  // A blocked or expired session already says what to do above.
  if (group === "excluded" || group === "notyet") return "";
  if (group === "withdrawn") return `<p class="muted gpexe-approve-note">${escapeHtml(withdrawnText(c))}</p>`;
  if (group === "replaced") return `<p class="muted gpexe-approve-note">${escapeHtml(BLOCKER_TEXT.superseded_by_newer_data)}</p>`;
  // v33: not confirmed by a successful search - no approval, whatever else the row says.
  if (notConfirmedForImport(c)) return `<p class="muted gpexe-approve-note">${escapeHtml(notConfirmedText(c, gx))}</p>`;
  if (group === "uptodate" && rowReasons(c).length) return `<p class="muted gpexe-approve-note">${escapeHtml(attentionText(c, status, gx))}</p>`;
  if (group === "uptodate") return `<p class="muted gpexe-approve-note">${escapeHtml(BLOCKER_TEXT.nothing_to_import)}</p>`;
  // This review was made with the athlete links as they were at the last
  // check; after a link change it must be made again before approving.
  if (reviewMadeBeforeLinkChange(c, gx)) {
    const day = c.sessionStartedAt ? formatDate(c.sessionStartedAt) : "";
    return `<p class="gpexe-warning gpexe-approve-note" role="note"><strong>Athlete links changed after this review was made.</strong> ${detail.updating ? "Updating the review..." : detail.updateError ? `Update the review again, or close it and find new sessions${day ? ` (with dates that include ${escapeHtml(day)})` : ""}; approving waits until then.` : "Approving waits until the review is updated."}${detail.updating ? "" : ` <button type="button" class="plain-button gpexe-button" data-action="training-load-gpexe-review-update">Update the review</button>`}</p>`;
  }
  const viewer = status?.viewer || {};
  const blockers = (c.approvalBlockers || []).filter((b) => b !== "blocked");
  // U2: the person may hold the right while the team's switch is off - say that, not "needs an approver".
  if (!viewer.canApprove && viewer.hasApprovalRight === true && status?.teamImportSwitch?.enabled !== true) return `<p class="muted gpexe-approve-note">${escapeHtml(BLOCKER_TEXT.team_import_switch_off)}</p>`;
  if (!viewer.canApprove) return `<p class="muted gpexe-approve-note">${platformViewer() ? "Approving needs a platform admin or an explicit approver grant for this team." : viewer.identityAdmin === true ? "You can't import this session. Contact OptiMove support." : "You can't import this session. Ask your club administrator."}</p>`;
  if (blockers.length) return `<p class="muted gpexe-approve-note">${escapeHtml(blockers.map((b) => BLOCKER_TEXT[b] || "It can't be imported right now.").join(" "))}</p>`;
  const changes = c.changesToImported || 0;
  const importN = importableAthleteCount(c.preview);
  // J20-B: with athletes ticked as "Leave out" the approval is the SUBSET's: it is reviewed first (one deliberate step that
  // asks the server for the preview without them) and the button imports exactly that review.
  const leave = leaveOutIds(c, detail);
  if (leave.length) return renderSubsetApproveHtml(c, detail, leave, importN, changes);
  return `
    <div class="gpexe-approve">
      <p class="muted">${escapeHtml(approveLeftOutText(c))}</p>
      ${importsLinkedAthletes(c) ? `<p class="muted gpexe-approve-names">${platformViewer() ? "Check that each athlete is the right person. Results imported under the wrong athlete can't be changed here — contact a platform administrator." : `Check that each athlete is the right person. If one is wrong after the import, ${askWho()}.`}</p>` : ""}
      ${importN === 0 ? `<p class="muted gpexe-approve-note">No athlete can be imported: every athlete needs a link, is blocked or has nothing to import.</p>` : ""}
      ${statesLineHtml(c, detail)}
      <div class="gpexe-approve-bar${importN === 0 ? " is-idle" : ""}">
      ${changes ? `
        <label class="gpexe-accept">
          <input type="checkbox" data-gpexe-accept data-action="training-load-gpexe-accept" ${detail.acceptChanges ? "checked" : ""}>
          <span>I accept the ${escapeHtml(plural(changes, "change", "changes"))} to results that were already imported.</span>
        </label>
      ` : ""}
        <button type="button" class="primary-button gpexe-button" data-action="training-load-gpexe-approve" ${detail.approving || importN === 0 ? "disabled" : ""}>${detail.approving ? "Importing..." : `Import ${plural(importN, "athlete", "athletes")}`}</button>
      </div>
    </div>
  `;
}
