// ST-4: manual values on the Roster tab (docs/ai/session-type-plan.md section 7).
// GET  /api/training-activity/:activityId/manual-values?athleteId=…           the form: entry or correction, the variables
// POST /api/training-activity/:activityId/manual-values { requestKey, athleteId, expectedOccasionId, values[], note? }
// POST /api/training-activity/:activityId/manual-values/restore { requestKey, athleteId, expectedOccasionId, note? }
// POST /api/training-activity/:activityId/manual-values/remove  { requestKey, athleteId, expectedOccasionId } (ST-4 PR2: ends an
//   entry; the values stay in the history and the athlete needs a state again)
//
// An athlete without a device record gets "Enter values…"; a measured athlete gets "Correct values…". A manual value is
// always shown as manual (who and when); a corrected value also names the measured value it replaced. The server offers the
// action (roster.data.viewer.manualValues) and decides again on every request.
import { api } from "./api.js";
import { currentRosterResetGeneration, newRosterRequestKey, refreshActivityRoster, sendRosterCommand } from "./activity-roster-data.js";
import { variableName } from "./activity-estimate.js";
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

const MAX_NOTE = 500;

// A save's refusal, in the coach's words. Nothing was written.
const REFUSALS = {
  athlete_not_on_roster: "This athlete is no longer on this session's roster.",
  manual_not_available: "Values cannot be entered for this session.",
  roster_not_applicable: "Values cannot be entered for this session.",
  values_changed: "This athlete's values changed since you opened them. Nothing was saved. Fields you changed keep what you typed; the others now show the current values.",
  nothing_changed: "These are the values already shown. Change a value first.",
  variable_not_in_record: "A value is not part of this athlete's record. Nothing was saved. The values below are the current ones now.",
  variable_not_in_session: "A value is not measured in this session. Nothing was saved. The values below are the current ones now.",
  record_ambiguous: "This athlete has more than one device record in this session. Fix it in GPEXE first.",
  changed_elsewhere: "This athlete's values were changed outside the roster, so they can't be changed here. Ask an administrator to look at them.",
  nothing_to_restore: "These are already the measured values.",
  nothing_to_remove: "There are no entered values to remove.",
  activity_superseded: "This session was merged into another one. Open the other session.",
  request_key_reused: "Something changed while saving. Nothing was saved. The values below are the current ones now.",
  try_again: "The server was busy and saved nothing. Try again.",
  not_a_team_coach: "You can no longer decide on this roster.",
  invalid_value: "Each value must be a number.",
  invalid_values: "Each value must be a number.",
  invalid_note: "Keep the note to one line of at most 500 characters.",
};
// After these refusals the form is read again at once (the next step is already on screen).
const REREAD = new Set(["values_changed", "variable_not_in_record", "variable_not_in_session", "request_key_reused"]);

function roster() {
  return state.trainingLoad.calendar.roster;
}

// No thousands separator anywhere in this panel: a number shown here can be typed back exactly ("3900", never "3,900").
function num(n) {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 3, useGrouping: false }).format(n);
}

// A typed number: digits with one optional decimal point or comma ("4100.5", "4100,5"), an optional minus. "3,900" is
// refused: it may mean 3900 or 3.9. Returns { value } or { problem }.
export function parseTypedNumber(raw) {
  const text = String(raw ?? "").trim();
  if (/^-?\d{1,3},\d{3}$/.test(text)) return { problem: "write it without a comma for thousands (3900), or with a point for a decimal (3.9)." };
  if (!/^-?\d+([.,]\d+)?$/.test(text)) return { problem: "enter a number." };
  return { value: Number(text.replace(",", ".")) };
}

function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x) => String(x).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export function isManualValue(v) {
  return v?.entryMethod === "manual";
}

// The row's line about its manual values: "Values entered by Ana Coach on 15.11.2026".
export function manualLineText(manual) {
  if (!manual) return "";
  const what = manual.kind === "correction" ? "Values corrected" : manual.kind === "restore" ? "Measured values restored" : "Values entered";
  const who = manual.enteredBy?.name ? ` by ${manual.enteredBy.name}` : "";
  const when = manual.enteredAt ? ` on ${localDay(manual.enteredAt)}` : "";
  return `${what}${who}${when}.`;
}

// The small mark beside a manual value in a cell, and its title.
export function manualMark(value, manual) {
  if (!isManualValue(value)) return null;
  const corrected = manual?.kind === "correction";
  const measured = corrected && value.measuredValue !== undefined
    ? ` (measured: ${Number.isFinite(value.measuredValue) ? num(value.measuredValue) : "none"})` : "";
  // Whole words (a title never shows on a touch screen): "manual" for an entered value, "corrected" for a corrected one.
  return { short: corrected ? "corrected" : manual?.kind === "restore" ? "" : "manual", title: `${manualLineText(manual)}${measured}`.trim() };
}

// Offered: the server says the routes are on, and the athlete is one whose values a coach may enter or correct here.
export function manualOffered(data, athlete) {
  if (data?.viewer?.manualValues !== true || !athlete) return null;
  if (athlete.state === "measured") return "correct";
  if (["unknown", "no_usable_device_record", "participated_no_values", "manual_values"].includes(athlete.state)) return "enter";
  return null;
}

export function manualBusy(r = roster()) {
  return Boolean(r?.manual?.sending || r?.manual?.unconfirmed);
}

function rosterWriteBusy(r) {
  return Boolean(r?.writeLock || r?.unconfirmed || Object.keys(r?.busy || {}).length || r?.estimate?.sending || r?.estimate?.unconfirmed);
}

// A resend refused before the server looked the key up proves nothing about the first send.
function refusedBeforeReplay(result) {
  return result.status === 403 || result.status === 404 || result.code === "try_again" || result.code === "roster_busy";
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
// `keepTyped`: after a refusal the form is read again, and what the coach typed stays in the fields that still exist.
async function readForm(render, { keepTyped = false } = {}) {
  const r = roster();
  const m = r.manual;
  if (!m) return;
  const typed = keepTyped ? { ...m.inputs } : null;
  const shown = keepTyped ? Object.fromEntries((m.form?.variables || []).map((v) => [v.metricDefinitionId, Number.isFinite(v.value) ? String(v.value) : ""])) : null;
  const generation = currentRosterResetGeneration();
  const ticket = (m.readTicket ?? 0) + 1;
  m.readTicket = ticket;
  m.loading = true;
  m.error = null;
  render();
  try {
    const answer = await api(`/api/training-activity/${encodeURIComponent(r.activityId)}/manual-values?${new URLSearchParams({ athleteId: m.athleteId })}`);
    if (roster() !== r || r.manual !== m || m.readTicket !== ticket || generation !== currentRosterResetGeneration()) return;
    m.form = answer;
    // The fields kept as typed while the saved value is another one: each names what is saved now.
    m.keptIds = {};
    m.inputs = Object.fromEntries((answer.variables || []).filter((v) => v.editable).map((v) => {
      const current = Number.isFinite(v.value) ? String(v.value) : "";
      // A field the coach changed keeps the change; an untouched one shows the current value.
      const kept = typed && Object.hasOwn(typed, v.metricDefinitionId) && typed[v.metricDefinitionId] !== shown[v.metricDefinitionId];
      if (kept && typed[v.metricDefinitionId].trim() !== current) m.keptIds[v.metricDefinitionId] = true;
      return [v.metricDefinitionId, kept ? typed[v.metricDefinitionId] : current];
    }));
  } catch (error) {
    if (roster() !== r || r.manual !== m || m.readTicket !== ticket || generation !== currentRosterResetGeneration()) return;
    m.error = error?.status === 404 ? "Values cannot be entered for this session." : REFUSALS[error?.data?.error] ?? "The values could not be read. Try again.";
  } finally {
    if (roster() === r && r.manual === m && m.readTicket === ticket) m.loading = false;
  }
  render();
}

// A variable's name in the form: the full label (a coach needs the whole name here), else the short one.
export function fieldName(v) {
  return variableName({ ...v, shortLabel: v?.label || v?.shortLabel });
}

// What a Save sends: the typed values. A correction sends only the values that differ from the current ones; an entry sends
// the filled values that changed or are new, and the server keeps the others (it carries the earlier entry's values over).
// A value cannot be removed here: a field that held a value and is now empty is refused, never silently kept.
// Returns { values, problem }.
export function valuesToSend(m) {
  const variables = (m?.form?.variables || []).filter((v) => v.editable);
  const values = [];
  for (const v of variables) {
    const raw = String(m.inputs?.[v.metricDefinitionId] ?? "").trim();
    if (raw === "") {
      if (Number.isFinite(v.value)) return { values: [], problem: `${fieldName(v)}: a saved value can't be removed here. Type a value, or Cancel.` };
      continue;
    }
    const parsed = parseTypedNumber(raw);
    if (parsed.problem) return { values: [], problem: `${fieldName(v)}: ${parsed.problem}` };
    const n = parsed.value;
    if (Number.isFinite(v.value) && n === v.value) continue;
    values.push({ metricDefinitionId: v.metricDefinitionId, value: n });
  }
  // Nothing new to send: with a saved value in any field the coach has to change one; with none, to enter one.
  if (!values.length) return { values, problem: variables.some((v) => Number.isFinite(v.value)) ? "Change a value first." : "Enter at least one value." };
  return { values, problem: "" };
}

function saveCommand(activityId, m, values) {
  const body = { requestKey: m.requestKey, athleteId: m.athleteId, expectedOccasionId: m.form.expectedOccasionId ?? null, values };
  // One line, as the server keeps it (a textarea gives a person Enter): a line break or tab is a space.
  const note = String(m.note ?? "").replace(/[\r\n\t]+/g, " ").trim();
  if (note) body.note = note;
  return { method: "POST", path: `/api/training-activity/${encodeURIComponent(activityId)}/manual-values`, body };
}

// "Remove these values" is offered for values entered on the roster (an entry), never for a correction (that is the restore).
export function canRemove(form) {
  return form?.mode === "entry" && form.manual?.kind === "entry" && typeof form.expectedOccasionId === "string";
}

function removeCommand(activityId, m) {
  return {
    method: "POST",
    path: `/api/training-activity/${encodeURIComponent(activityId)}/manual-values/remove`,
    body: { requestKey: m.requestKey, athleteId: m.athleteId, expectedOccasionId: m.form.expectedOccasionId },
  };
}

function restoreCommand(activityId, m) {
  return {
    method: "POST",
    path: `/api/training-activity/${encodeURIComponent(activityId)}/manual-values/restore`,
    body: { requestKey: m.requestKey, athleteId: m.athleteId, expectedOccasionId: m.form.expectedOccasionId },
  };
}

// ---------------------------------------------------------------------------
// Actions (training-load-roster-manual-*)
// ---------------------------------------------------------------------------
export async function handleManualAction(action, { render }) {
  const type = action.dataset.action;
  const r = roster();
  const m = r.manual;

  if (type === "training-load-roster-manual-open") {
    if (manualBusy(r) || rosterWriteBusy(r)) return true;
    const athleteId = action.dataset.athleteId;
    const athlete = (r.data?.athletes || []).find((a) => a.athleteId === athleteId);
    if (!athlete || !manualOffered(r.data, athlete)) return true;
    // One panel at a time: an open estimate closes (it has nothing in flight, rosterWriteBusy said so).
    r.estimate = null;
    r.manual = { athleteId, form: null, inputs: {}, note: "", loading: false, error: null, sending: false, requestKey: null, refusal: null, problem: "", unconfirmed: null };
    await readForm(render);
    return true;
  }
  if (!m) return true;
  if (type === "training-load-roster-manual-cancel") {
    if (m.sending || m.unconfirmed) return true;
    r.manual = null;
    render();
    return true;
  }
  if (m.sending || m.unconfirmed) {
    if (type === "training-load-roster-manual-check") {
      // One Check result at a time (the same key; the button is off meanwhile, this guards a second tap too).
      if (!m.unconfirmed || m.sending) return true;
      m.unconfirmed.checks += 1;
      return send(r, m, m.unconfirmed.command, render);
    }
    return true;
  }
  if (type === "training-load-roster-manual-input") {
    // Kept while typing, without a re-render (the field keeps its focus).
    const id = action.dataset.metricId;
    if (id && Object.hasOwn(m.inputs, id)) m.inputs[id] = String(action.value ?? "").slice(0, 32);
    return true;
  }
  if (type === "training-load-roster-manual-note") {
    m.note = String(action.value ?? "").slice(0, MAX_NOTE);
    return true;
  }
  if (type === "training-load-roster-manual-save") {
    if (!m.form || m.loading || rosterWriteBusy(r)) return true;
    const { values, problem } = valuesToSend(m);
    m.problem = problem;
    m.refusal = null;
    if (problem) { render(); return true; }
    // One key per attempt; a refusal frees it, a lost answer keeps it for Check result.
    m.requestKey = newRosterRequestKey();
    return send(r, m, saveCommand(r.activityId, m, values), render);
  }
  // The restore asks first, inline (the roster's own pattern, never a modal): Restore → the question with two buttons.
  if (type === "training-load-roster-manual-restore-ask") {
    if (!m.form?.canRestore || m.loading || rosterWriteBusy(r)) return true;
    m.confirmRestore = true;
    render();
    return true;
  }
  // The removal asks first too, inline: Remove → the question with two buttons.
  if (type === "training-load-roster-manual-remove-ask") {
    if (!canRemove(m.form) || m.loading || rosterWriteBusy(r)) return true;
    m.confirmRemove = true;
    m.confirmRestore = false;
    render();
    return true;
  }
  if (type === "training-load-roster-manual-remove-keep") {
    m.confirmRemove = false;
    render();
    return true;
  }
  if (type === "training-load-roster-manual-remove") {
    if (!m.confirmRemove || !canRemove(m.form) || m.loading || rosterWriteBusy(r)) return true;
    m.confirmRemove = false;
    m.problem = "";
    m.refusal = null;
    m.requestKey = newRosterRequestKey();
    return send(r, m, removeCommand(r.activityId, m), render);
  }
  if (type === "training-load-roster-manual-restore-keep") {
    m.confirmRestore = false;
    render();
    return true;
  }
  if (type === "training-load-roster-manual-restore") {
    if (!m.confirmRestore || !m.form?.canRestore || m.loading || rosterWriteBusy(r)) return true;
    m.confirmRestore = false;
    m.problem = "";
    m.refusal = null;
    m.requestKey = newRosterRequestKey();
    return send(r, m, restoreCommand(r.activityId, m), render);
  }
  return true;
}

async function send(r, m, command, render) {
  const generation = currentRosterResetGeneration();
  const activityId = r.activityId;
  m.sending = true;
  render();
  let result = await sendRosterCommand(command);
  // A 503 try_again wrote nothing (the server's own refusal), unlike a lost answer.
  if (result.outcome === "unconfirmed" && result.status === 503 && result.code === "try_again") result = { ...result, outcome: "refused" };
  if (roster() !== r || r.manual !== m || r.activityId !== activityId || generation !== currentRosterResetGeneration()) return true;
  m.sending = false;
  if (result.outcome === "unconfirmed") {
    m.unconfirmed = { command, checks: m.unconfirmed?.checks ?? 0 };
    render();
    return true;
  }
  if (result.outcome === "saved") {
    const name = (r.data?.athletes || []).find((a) => a.athleteId === m.athleteId)?.name || "this athlete";
    const restored = command.path.endsWith("/restore");
    const removed = command.path.endsWith("/remove");
    r.manual = null;
    const corrected = m.form?.mode === "correction";
    r.notices.rows[m.athleteId] = {
      tone: "saved",
      text: removed ? `Values removed for ${name}. They stay in the history; set a state for ${name} in the roster.`
        : restored ? `Measured values restored for ${name}.`
        : corrected ? `Corrected values saved for ${name}. The measured values are kept.`
        : `Values saved for ${name}. They are shown as entered by hand, never as measured.`,
    };
    render();
    await refreshActivityRoster(activityId, render, { exclude: [m.athleteId] });
    render();
    return true;
  }
  if (m.unconfirmed && refusedBeforeReplay(result)) {
    m.unconfirmed = { ...m.unconfirmed, stillUnknown: result.status === 403 || result.status === 404 ? "gone" : "busy" };
    render();
    return true;
  }
  // Refused: nothing was written; the key is free again.
  m.unconfirmed = null;
  m.requestKey = null;
  m.refusal = REFUSALS[result.code] ?? (result.status === 404 ? "This session is not available here any more. Nothing was saved." : result.status === 403 ? REFUSALS.not_a_team_coach : "It could not be saved. Nothing was saved.");
  render();
  await refreshActivityRoster(activityId, render, { exclude: [m.athleteId] });
  // The values changed under the coach: the form is read again at once, keeping what was typed.
  if (REREAD.has(result.code) && roster() === r && r.manual === m) await readForm(render, { keepTyped: true });
  render();
  return true;
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------
function fieldHtml(m, v) {
  const id = `tl-manual-${escapeAttr(v.metricDefinitionId)}`;
  const name = fieldName(v);
  const hints = [];
  if (m.form.mode === "correction" && v.measuredValue !== undefined && v.measuredValue !== v.value) {
    hints.push(`Measured: ${Number.isFinite(v.measuredValue) ? num(v.measuredValue) : "none"}`);
  }
  if (Number.isFinite(v.estimatedValue)) hints.push(`Estimate now: ${num(v.estimatedValue)}`);
  if (m.keptIds?.[v.metricDefinitionId]) hints.push(`Now saved: ${Number.isFinite(v.value) ? num(v.value) : "none"}`);
  if (!v.editable) {
    return `<div class="tl-manual-field is-fixed"><span>${escapeHtml(name)}</span><span>${escapeHtml(v.value === null ? "—" : num(v.value))}</span></div>`;
  }
  return `
    <div class="tl-manual-field">
      <label for="${id}">${escapeHtml(name)}${v.unit ? ` <small>(${escapeHtml(v.unit)})</small>` : ""}</label>
      <input id="${id}" type="text" inputmode="decimal" autocomplete="off" value="${escapeAttr(m.inputs[v.metricDefinitionId] ?? "")}" data-action="training-load-roster-manual-input" data-metric-id="${escapeAttr(v.metricDefinitionId)}" ${m.sending ? "disabled" : ""}>
      ${hints.length ? `<small class="muted">${escapeHtml(hints.join(" · "))}</small>` : ""}
    </div>`;
}

export function renderManualPanelHtml(r, athlete) {
  const m = r.manual;
  if (!m || m.athleteId !== athlete.athleteId) return "";
  const name = athlete.name || "this athlete";
  if (m.unconfirmed) {
    return `
      <section class="tl-estimate-panel tl-manual-panel" aria-label="Values for ${escapeAttr(name)}">
        <p class="tl-roster-tag is-unconfirmed">Result not confirmed</p>
        <p>The answer was lost, so we can't tell whether the values were saved. Check result asks again without saving twice.</p>
        ${m.unconfirmed.stillUnknown === "gone" ? `<p class="muted" aria-live="polite">You can't check this here any more: this session is no longer available to you. The values may have been saved; ask an administrator to look at the roster.</p>` : m.unconfirmed.stillUnknown ? `<p class="muted" aria-live="polite">The server could not answer yet, so it is still not confirmed. Try Check result again in a moment.</p>` : ""}
        <div class="tl-roster-actions">
          <button type="button" class="primary-button tl-roster-button" data-action="training-load-roster-manual-check" ${m.sending ? "disabled" : ""}>${m.sending ? "Checking…" : "Check result"}</button>
        </div>
      </section>`;
  }
  const f = m.form;
  const correction = f?.mode === "correction";
  const title = correction ? `Correct values for ${name}` : `Enter values for ${name}`;
  const intro = correction
    ? "The measured values are kept. Your values count instead and are shown as corrected by you."
    : "Typed by you for an athlete without usable device data. Shown as entered by hand, never as measured.";
  const fields = f ? (f.variables || []).map((v) => fieldHtml(m, v)).join("") : "";
  const canSave = Boolean(f) && !m.sending && !m.loading && !rosterWriteBusy(r);
  return `
    <section class="tl-estimate-panel tl-manual-panel" aria-label="${escapeAttr(title)}">
      <h4>${escapeHtml(title)}</h4>
      <p class="muted">${escapeHtml(intro)}</p>
      ${f?.manual ? `<p class="muted">${escapeHtml(manualLineText(f.manual))}</p>` : ""}
      ${m.loading && !f ? `<p class="muted" aria-live="polite">Reading the values…</p>` : ""}
      ${m.error ? `<p class="tl-estimate-error" role="alert">${escapeHtml(m.error)}</p>` : ""}
      ${f && !fields ? `<p class="muted">This session has no values that can be entered here.</p>` : ""}
      ${fields ? `<div class="tl-manual-fields">${fields}</div>` : ""}
      ${f ? `
        <label class="tl-estimate-note" for="tl-manual-note">Note (optional)</label>
        <textarea id="tl-manual-note" rows="2" maxlength="${MAX_NOTE}" data-action="training-load-roster-manual-note" ${m.sending ? "disabled" : ""}>${escapeHtml(m.note)}</textarea>` : ""}
      ${m.problem ? `<p class="tl-estimate-error" role="alert">${escapeHtml(m.problem)}</p>` : ""}
      ${m.refusal ? `<p class="tl-estimate-error" role="alert">${escapeHtml(m.refusal)}</p>` : ""}
      ${m.confirmRestore ? `
        <div class="tl-roster-confirm" role="group" aria-label="Restore the measured values">
          <p>Use the measured values again for ${escapeHtml(name)}? Your corrected values stop counting.</p>
          <div class="tl-roster-actions">
            <button type="button" class="primary-button tl-roster-button" data-action="training-load-roster-manual-restore" ${canSave ? "" : "disabled"}>Restore measured values</button>
            <button type="button" class="plain-button tl-roster-button" data-action="training-load-roster-manual-restore-keep">Keep my correction</button>
          </div>
        </div>` : m.confirmRemove ? `
        <div class="tl-roster-confirm" role="group" aria-label="Remove the values entered">
          <p>Remove the values entered for ${escapeHtml(name)}? They stay in the history, and ${escapeHtml(name)} needs a state again.</p>
          <div class="tl-roster-actions">
            <button type="button" class="primary-button tl-roster-button" data-action="training-load-roster-manual-remove" ${canSave ? "" : "disabled"}>Remove values</button>
            <button type="button" class="plain-button tl-roster-button" data-action="training-load-roster-manual-remove-keep">Keep them</button>
          </div>
        </div>` : `
      <div class="tl-roster-actions">
        <button type="button" class="primary-button tl-roster-button" data-action="training-load-roster-manual-save" ${canSave && fields ? "" : "disabled"}>${m.sending ? "Saving…" : "Save values"}</button>
        ${f?.canRestore ? `<button type="button" class="plain-button tl-roster-button" data-action="training-load-roster-manual-restore-ask" ${canSave ? "" : "disabled"}>Restore measured values…</button>` : ""}
        ${canRemove(f) ? `<button type="button" class="plain-button tl-roster-button" data-action="training-load-roster-manual-remove-ask" ${canSave ? "" : "disabled"}>Remove these values…</button>` : ""}
        <button type="button" class="plain-button tl-roster-button" data-action="training-load-roster-manual-cancel" ${m.sending ? "disabled" : ""}>Cancel</button>
      </div>`}
    </section>`;
}
