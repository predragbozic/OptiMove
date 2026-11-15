// 6b-C1: estimated values on the Roster tab (contract docs/ai/phase5b-estimates-contract.md, rule 10 and section 8).
// GET  /api/training-activity/:activityId/estimates/proposal?athleteId=…[&minutes=…][&sourceAthleteId=…]
// POST /api/training-activity/:activityId/estimates { requestKey, athleteId, method, minutes?, sourceAthleteId?, note? }
//
// The action is offered only on a "Participated · no device data" row, to a viewer who may decide on the roster, while
// the server says the save is on (roster.data.viewer.estimates). Every estimated value is shown with its label; a coach
// never sees an estimate unlabelled.
import { api } from "./api.js";
import { currentRosterResetGeneration, newRosterRequestKey, refreshActivityRoster, sendRosterCommand } from "./activity-roster-data.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export const ESTIMATE_METHODS = ["proportional", "team_average", "copy_athlete", "scale_recording"];
const MAX_NOTE = 500;
const MAX_MINUTES = 600;

const METHOD_TITLES = {
  proportional: "Own average, scaled to minutes",
  team_average: "Team average",
  copy_athlete: "Copy from an athlete",
  scale_recording: "Scale the recorded part",
};
const METHOD_HINTS = {
  proportional: "This athlete's own rate per minute in their recent sessions, times the minutes below.",
  team_average: "The average of the athletes measured in this session.",
  copy_athlete: "Another athlete's values from this session. The weakest estimate: use it only if they trained the same way.",
  scale_recording: "The recorded part of this athlete's session, scaled to the minutes chosen before the import.",
};
// Why a method cannot run, in the coach's words.
const REASONS = {
  too_few_athletes: "Fewer than 3 athletes have a measured value in this session.",
  too_few_sessions: "Fewer than 3 of this athlete's sessions in the last 90 days have measured values.",
  minutes_required: "Enter the minutes.",
  duration_not_available: "This session's duration is not known.",
  method_not_for_variable: "Only totals can be scaled to minutes.",
  source_has_no_value: "That athlete has no measured value for these variables.",
  invalid_history: "This athlete's earlier values cannot be used.",
  nothing_to_estimate: "Nothing can be estimated this way.",
  choose_source: "Choose an athlete to copy from.",
  no_source: "No other athlete has a measured value in this session.",
  copy_source_not_usable: "That athlete cannot be copied from.",
  scale_not_chosen: "No scale was chosen for this athlete before the import.",
  scale_not_possible: "The recorded part cannot be scaled.",
  scale_basis_expired: "The recording this scale rests on is no longer kept.",
  not_estimable: "This variable cannot be estimated.",
  measured_exists: "This athlete already has a measured value.",
};
// A save's refusal, in the coach's words. Nothing was written.
const REFUSALS = {
  athlete_not_on_roster: "This athlete is no longer on this session's roster.",
  estimate_not_available: "Estimates are not available for this session.",
  copy_source_not_usable: "That athlete cannot be copied from any more.",
  minutes_required: "Enter the minutes first.",
  nothing_to_estimate: "Nothing can be estimated this way.",
  measured_exists: "A measured value arrived meanwhile, so no estimate is needed.",
  activity_superseded: "This session was merged into another one. Open the other session.",
  roster_not_applicable: "Estimates are not available for this session.",
  request_key_reused: "That save was already used for something else. Start again.",
  try_again: "The server was busy and saved nothing. Try again.",
  not_a_team_coach: "You can no longer decide on this roster.",
  scale_not_chosen: REASONS.scale_not_chosen,
  scale_not_possible: REASONS.scale_not_possible,
  scale_basis_expired: REASONS.scale_basis_expired,
};

function roster() {
  return state.trainingLoad.calendar.roster;
}

function num(n, digits = 1) {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: digits }).format(n);
}

function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// "Estimate · own average × 40 min (3 sessions) · Ana Coach, 15.11.2026". Built from the closed fields the reads give.
export function estimateLabelText(e) {
  if (!e) return "Estimate";
  let how;
  if (e.method === "proportional") how = `own average × ${Number.isFinite(e.minutes) ? num(e.minutes, 2) : "?"} min${Number.isFinite(e.sessionCount) ? ` (${e.sessionCount} sessions)` : ""}`;
  else if (e.method === "team_average") how = `team average${Number.isFinite(e.athleteCount) ? ` (${e.athleteCount} athletes)` : ""}`;
  else if (e.method === "copy_athlete") how = e.sourceAthleteName ? `copied from ${e.sourceAthleteName}` : "copied from another athlete";
  else if (e.method === "scale_recording") how = `recorded ${Number.isFinite(e.recordedMinutes) ? num(e.recordedMinutes, 2) : "?"} of ${Number.isFinite(e.targetMinutes) ? num(e.targetMinutes, 2) : "?"} min, scaled`;
  else how = "estimate";
  const who = [e.estimatedBy, e.estimatedAt ? localDay(e.estimatedAt) : ""].filter(Boolean).join(", ");
  return `Estimate · ${how}${who ? ` · ${who}` : ""}`;
}

export function isEstimateValue(v) {
  return v?.entryMethod === "estimate";
}

// The row offers the action: a Participated · no device data athlete, the save on, a viewer who decides.
export function estimateOffered(data, athlete) {
  return data?.viewer?.estimates === true && athlete?.state === "participated_no_values";
}

export function estimateBusy(r = roster()) {
  return Boolean(r?.estimate?.sending || r?.estimate?.unconfirmed);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
function proposalPath(activityId, athleteId, { minutes, sourceAthleteId } = {}) {
  const q = new URLSearchParams({ athleteId });
  if (minutes !== null && minutes !== undefined && minutes !== "") q.set("minutes", String(minutes));
  if (sourceAthleteId) q.set("sourceAthleteId", sourceAthleteId);
  return `/api/training-activity/${encodeURIComponent(activityId)}/estimates/proposal?${q}`;
}

async function readProposal(render) {
  const r = roster();
  const e = r.estimate;
  if (!e) return;
  const generation = currentRosterResetGeneration();
  const ticket = (e.readTicket ?? 0) + 1;
  e.readTicket = ticket;
  e.loading = true;
  e.error = null;
  render();
  try {
    const minutes = e.method === "proportional" && e.minutesInput !== "" ? Number(e.minutesInput) : null;
    const answer = await api(proposalPath(r.activityId, e.athleteId, { minutes: Number.isFinite(minutes) ? minutes : null, sourceAthleteId: e.sourceAthleteId }));
    if (roster() !== r || r.estimate !== e || e.readTicket !== ticket || generation !== currentRosterResetGeneration()) return;
    e.proposal = answer;
    if (e.minutesInput === "" && Number.isFinite(answer?.minutes?.used)) e.minutesInput = String(answer.minutes.used);
    if (!e.method) e.method = firstAvailable(answer);
  } catch (error) {
    if (roster() !== r || r.estimate !== e || e.readTicket !== ticket) return;
    e.error = error?.status === 404 ? "Estimates are not available for this session." : "The proposal could not be read. Try again.";
  } finally {
    if (roster() === r && r.estimate === e && e.readTicket === ticket) e.loading = false;
  }
  render();
}

function firstAvailable(proposal) {
  return ESTIMATE_METHODS.find((m) => proposal?.methods?.[m]?.available) ?? null;
}

function saveCommand(activityId, e) {
  const body = { requestKey: e.requestKey, athleteId: e.athleteId, method: e.method };
  if (e.method === "proportional" && e.minutesInput !== "") body.minutes = Number(e.minutesInput);
  if (e.method === "copy_athlete") body.sourceAthleteId = e.sourceAthleteId;
  const note = String(e.note ?? "").trim();
  if (note) body.note = note;
  return { method: "POST", path: `/api/training-activity/${encodeURIComponent(activityId)}/estimates`, body };
}

// The save's answer: a 503 try_again wrote nothing (the server's own refusal), unlike a lost answer.
function classify(result) {
  if (result.outcome === "unconfirmed" && result.status === 503 && result.code === "try_again") return { ...result, outcome: "refused" };
  return result;
}

// ---------------------------------------------------------------------------
// Actions (training-load-roster-estimate-*)
// ---------------------------------------------------------------------------
export async function handleEstimateAction(action, { render }) {
  const type = action.dataset.action;
  const r = roster();
  const e = r.estimate;

  if (type === "training-load-roster-estimate-open") {
    if (estimateBusy(r)) return true;
    const athleteId = action.dataset.athleteId;
    const athlete = (r.data?.athletes || []).find((a) => a.athleteId === athleteId);
    if (!athlete || !estimateOffered(r.data, athlete)) return true;
    r.estimate = { athleteId, proposal: null, loading: false, error: null, method: null, minutesInput: "", sourceAthleteId: null, note: "", sending: false, requestKey: null, refusal: null, unconfirmed: null };
    await readProposal(render);
    return true;
  }
  if (!e) return true;
  if (type === "training-load-roster-estimate-cancel") {
    if (e.sending || e.unconfirmed) return true;
    r.estimate = null;
    render();
    return true;
  }
  if (e.sending || e.unconfirmed) {
    if (type === "training-load-roster-estimate-check") return checkResult(r, e, render);
    return true;
  }
  if (type === "training-load-roster-estimate-method") {
    const method = action.dataset.method || action.value;
    if (!ESTIMATE_METHODS.includes(method)) return true;
    e.method = method;
    e.refusal = null;
    render();
    return true;
  }
  if (type === "training-load-roster-estimate-minutes") {
    // Kept while typing, without a re-render; "Update" reads the numbers again.
    e.minutesInput = String(action.value ?? "").trim().slice(0, 8);
    return true;
  }
  if (type === "training-load-roster-estimate-update") {
    const minutes = Number(e.minutesInput);
    if (e.minutesInput !== "" && !(minutes > 0 && minutes <= MAX_MINUTES)) {
      e.error = `Enter the minutes, above 0 and at most ${MAX_MINUTES}.`;
      render();
      return true;
    }
    await readProposal(render);
    return true;
  }
  if (type === "training-load-roster-estimate-source") {
    e.sourceAthleteId = action.value || null;
    e.method = "copy_athlete";
    await readProposal(render);
    return true;
  }
  if (type === "training-load-roster-estimate-note") {
    e.note = String(action.value ?? "").slice(0, MAX_NOTE);
    return true;
  }
  if (type === "training-load-roster-estimate-save") {
    const view = e.proposal?.methods?.[e.method];
    if (!view?.available) return true;
    // One key per save attempt; a refusal frees it, a lost answer keeps it for Check result.
    e.requestKey = newRosterRequestKey();
    return send(r, e, render);
  }
  return true;
}

async function send(r, e, render) {
  const generation = currentRosterResetGeneration();
  const activityId = r.activityId;
  const command = e.unconfirmed?.command ?? saveCommand(activityId, e);
  e.sending = true;
  e.refusal = null;
  render();
  const result = classify(await sendRosterCommand(command));
  if (roster() !== r || r.estimate !== e || r.activityId !== activityId || generation !== currentRosterResetGeneration()) return true;
  e.sending = false;
  if (result.outcome === "unconfirmed") {
    e.unconfirmed = { command, checks: (e.unconfirmed?.checks ?? 0) };
    render();
    return true;
  }
  if (result.outcome === "saved") {
    const name = (r.data?.athletes || []).find((a) => a.athleteId === e.athleteId)?.name || "this athlete";
    r.estimate = null;
    r.notices.rows[e.athleteId] = { tone: "saved", text: `Estimate saved for ${name}. It is shown as an estimate, never as measured.` };
    render();
    await refreshActivityRoster(activityId, render, { exclude: [e.athleteId] });
    render();
    return true;
  }
  // Refused: nothing was written; the key is free again.
  e.unconfirmed = null;
  e.requestKey = null;
  e.refusal = REFUSALS[result.code] ?? "It could not be saved. Nothing was saved.";
  render();
  return true;
}

async function checkResult(r, e, render) {
  if (!e.unconfirmed || e.sending) return true;
  e.unconfirmed.checks += 1;
  // The same command and key: a save that happened answers again, one that did not is made once.
  return send(r, e, render);
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------
function valueText(value, unit) {
  if (!Number.isFinite(value)) return "—";
  return `${num(value)}${unit ? ` ${unit}` : ""}`;
}

function methodValuesText(proposal, view) {
  const byId = new Map((proposal?.variables || []).map((v) => [v.metricDefinitionId, v]));
  return (view?.values || [])
    .filter((x) => x.value !== null)
    .map((x) => {
      const v = byId.get(x.metricDefinitionId);
      return `${v?.shortLabel || v?.label || "Value"} ${valueText(x.value, v?.unit)}`;
    })
    .join(" · ");
}

function methodHtml(e, method) {
  const view = e.proposal?.methods?.[method];
  if (!view) return "";
  const id = `tl-estimate-${method}`;
  const disabled = !view.available || e.sending || e.loading;
  const chosen = e.method === method;
  const reason = !view.available ? (REASONS[view.reason] ?? REASONS.nothing_to_estimate) : "";
  const values = view.available ? methodValuesText(e.proposal, view) : "";
  let extra = "";
  if (method === "proportional" && chosen) {
    extra = `
      <div class="tl-estimate-inline">
        <label for="tl-estimate-minutes">Minutes</label>
        <input id="tl-estimate-minutes" type="number" inputmode="decimal" min="1" max="${MAX_MINUTES}" step="any" value="${escapeAttr(e.minutesInput)}" data-action="training-load-roster-estimate-minutes" ${e.sending ? "disabled" : ""}>
        <button type="button" class="plain-button tl-roster-button" data-action="training-load-roster-estimate-update" ${e.sending || e.loading ? "disabled" : ""}>Update</button>
      </div>`;
  }
  if (method === "copy_athlete") {
    const sources = view.sources || [];
    extra = sources.length ? `
      <div class="tl-estimate-inline">
        <label for="tl-estimate-source">Copy from</label>
        <select id="tl-estimate-source" data-action="training-load-roster-estimate-source" ${e.sending ? "disabled" : ""}>
          <option value="" ${e.sourceAthleteId ? "" : "selected"}>Choose an athlete</option>
          ${sources.map((s) => `<option value="${escapeAttr(s.athleteId)}" ${e.sourceAthleteId === s.athleteId ? "selected" : ""}>${escapeHtml(s.name || "Athlete")}</option>`).join("")}
        </select>
      </div>` : "";
  }
  return `
    <li class="tl-estimate-method ${chosen ? "is-chosen" : ""} ${view.available ? "" : "is-unavailable"}">
      <label class="tl-estimate-choice" for="${id}">
        <input type="radio" id="${id}" name="tl-estimate-method" value="${escapeAttr(method)}" data-action="training-load-roster-estimate-method" data-method="${escapeAttr(method)}" ${chosen ? "checked" : ""} ${disabled ? "disabled" : ""}>
        <span><strong>${escapeHtml(METHOD_TITLES[method])}</strong><small>${escapeHtml(METHOD_HINTS[method])}</small>
          ${values ? `<small class="tl-estimate-values">${escapeHtml(values)}</small>` : ""}
          ${reason ? `<small class="tl-estimate-reason">${escapeHtml(reason)}</small>` : ""}</span>
      </label>
      ${extra}
    </li>`;
}

export function renderEstimatePanelHtml(r, athlete) {
  const e = r.estimate;
  if (!e || e.athleteId !== athlete.athleteId) return "";
  const name = athlete.name || "this athlete";
  if (e.unconfirmed) {
    return `
      <section class="tl-estimate-panel" aria-label="Estimate for ${escapeAttr(name)}">
        <p class="tl-roster-tag is-unconfirmed">Result not confirmed</p>
        <p>The answer was lost, so we can't tell whether the estimate was saved. Check result asks again without saving twice.</p>
        <div class="tl-roster-actions">
          <button type="button" class="primary-button tl-roster-button" data-action="training-load-roster-estimate-check" ${e.sending ? "disabled" : ""}>${e.sending ? "Checking…" : "Check result"}</button>
        </div>
      </section>`;
  }
  const methods = e.proposal ? ESTIMATE_METHODS.map((m) => methodHtml(e, m)).join("") : "";
  const canSave = Boolean(e.proposal?.methods?.[e.method]?.available) && !e.sending && !e.loading;
  return `
    <section class="tl-estimate-panel" aria-label="Estimate for ${escapeAttr(name)}">
      <h4>Estimate values for ${escapeHtml(name)}</h4>
      <p class="muted">An estimate is always labelled and is never counted as measured. A measured value that arrives later replaces it.</p>
      ${e.loading && !e.proposal ? `<p class="muted" aria-live="polite">Reading the proposal…</p>` : ""}
      ${e.error ? `<p class="tl-estimate-error" role="alert">${escapeHtml(e.error)}</p>` : ""}
      ${methods ? `<ul class="tl-estimate-methods">${methods}</ul>` : ""}
      ${e.proposal ? `
        <label class="tl-estimate-note" for="tl-estimate-note">Note (optional)</label>
        <textarea id="tl-estimate-note" rows="2" maxlength="${MAX_NOTE}" data-action="training-load-roster-estimate-note" ${e.sending ? "disabled" : ""}>${escapeHtml(e.note)}</textarea>` : ""}
      ${e.refusal ? `<p class="tl-estimate-error" role="alert">${escapeHtml(e.refusal)}</p>` : ""}
      <div class="tl-roster-actions">
        <button type="button" class="primary-button tl-roster-button" data-action="training-load-roster-estimate-save" ${canSave ? "" : "disabled"}>${e.sending ? "Saving…" : "Save estimate"}</button>
        <button type="button" class="plain-button tl-roster-button" data-action="training-load-roster-estimate-cancel" ${e.sending ? "disabled" : ""}>Cancel</button>
      </div>
    </section>`;
}
