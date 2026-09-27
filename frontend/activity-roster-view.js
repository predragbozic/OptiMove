// Phase 5a3a/5a3b: the Roster tab of a team session.
// Contract: docs/ai/phase5a3-roster-ux-draft.md — sections 0 (rules), 1
// (opening, header, filters, sticky bar), 2 (measured), 3 (no usable device
// record), 4 (Participated · no device data, Change, Remove), 5 (absent with
// a reason), 6 (one state for several athletes), 7 (outcomes, Two states,
// stale decisions) and 9 (recorded, but not on this session's roster).
//
// 5a3b adds the writes: a state per row, its change and removal, "Use
// measured values", the selection and the group decision, and the three
// outcomes of a write (saved / nothing saved / result not confirmed).
// Complete and Reopen (5a3c), manual values and estimates (5b) are absent.
//
// Source-neutral: prefer a display name from the roster answer. Until the
// contract supplies one, use neutral wording; raw ids and codes stay folded.
import { state } from "./state.js";
import { escapeAttr, escapeHtml } from "./utils.js";

export const ROSTER_GROUPS = Object.freeze([
  { id: "needs_state", label: "Needs a state" },
  { id: "needs_review", label: "Needs review" },
  { id: "done", label: "Done" },
]);

// The two states a coach sets in 5a3b (5a2 refuses every other kind).
export const DECISION_LABELS = Object.freeze({
  participated_no_values: "Participated · no device data",
  did_not_participate: "Did not participate",
});

export const MAX_BULK_ATHLETES = 60;

// Glyph + word: the state is never told by color alone.
const STATE_GLYPHS = Object.freeze({
  unknown: "○",
  no_usable_device_record: "◐",
  did_not_participate: "✕",
  participated_no_values: "▢",
  measured: "●",
  measured_change_waiting: "●",
});

const STATE_LABELS = Object.freeze({
  unknown: "Unknown",
  no_usable_device_record: "No usable device record",
  did_not_participate: "Did not participate",
  participated_no_values: "Participated · no device data",
  measured: "Measured",
  measured_change_waiting: "Measured · change waiting",
});

// Next step for a source reason the coach can act on outside OptiMove.
const SOURCE_REASON_NEXT_STEP = Object.freeze({
  needs_manual_review: "Fix it there, then find new sessions in Imports.",
});

const MAX_VALUE_COLUMNS = 3;

export function sourceName({ midSentence = false } = {}) {
  return midSentence ? "the device source" : "The device source";
}

export function isPhone() {
  try {
    return Boolean(window.matchMedia?.("(max-width: 760px)").matches);
  } catch {
    return false;
  }
}

function safeTimeZone(timeZone) {
  if (!timeZone) return undefined;
  try {
    Intl.DateTimeFormat("en-GB", { timeZone });
    return timeZone;
  } catch {
    return undefined;
  }
}

// "Fri 18 Sep, 17:00" in the session's own time zone; the date alone for
// a session without a start time.
export function sessionWhenLabel(activity) {
  if (!activity) return "";
  const timeZone = safeTimeZone(activity.timezone);
  if (activity.startedAt) {
    const at = new Date(activity.startedAt);
    const day = at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone }).replace(",", "");
    const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
    return `${day}, ${time}`;
  }
  if (activity.occurredLocalDate) {
    return new Date(`${activity.occurredLocalDate}T12:00:00Z`)
      .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
  }
  return "";
}

function sessionDateLabel(activity) {
  if (!activity?.occurredLocalDate) return "the session date";
  return new Date(`${activity.occurredLocalDate}T12:00:00Z`)
    .toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).replace(",", "");
}

function shortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function isMeasuredValue(v) {
  return v?.entryMethod === "api_import" || v?.entryMethod === "csv_import";
}

function displayValues(athlete) {
  return (athlete?.values || []).filter(isMeasuredValue);
}

function hasValue(v) {
  const value = v?.value ?? v?.valueText;
  return value !== null && value !== undefined && value !== "";
}

function metricLabel(v) {
  return v.shortLabel || v.label || "Value";
}

function metricKey(v) {
  return v.metricKey || metricLabel(v);
}

// A value as the coach reads it; a missing value is "—", never 0.
export function formatRosterValue(v) {
  if (!v || !hasValue(v)) return "—";
  const value = v.value ?? v.valueText;
  const unit = v.unit || "";
  if (typeof value === "number") {
    const n = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(value);
    return unit ? `${n} ${unit}` : n;
  }
  return String(value);
}

// The value columns come from the metrics in the roster answer, never from
// a fixed list tied to one kind of device: at most MAX_VALUE_COLUMNS in
// the order supplied by the read model (or first seen when it supplies no
// order). Every other value remains available in the row's details.
export function rosterValueColumns(athletes) {
  const byKey = new Map();
  for (const athlete of athletes) {
    for (const v of displayValues(athlete)) {
      const key = metricKey(v);
      if (!key || !hasValue(v)) continue;
      const entry = byKey.get(key) ?? {
        metricKey: key,
        label: metricLabel(v),
        count: 0,
      };
      entry.count += 1;
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => String(a.label).localeCompare(String(b.label)) || String(a.metricKey).localeCompare(String(b.metricKey)))
    .slice(0, MAX_VALUE_COLUMNS);
}

export function rosterCounts(data) {
  const counts = data?.counts ?? {};
  const athletes = Array.isArray(data?.athletes) ? data.athletes : [];
  const total = counts.total ?? athletes.length;
  const needsState = counts.needsState ?? athletes.filter((athlete) => athleteGroup(athlete) === "needs_state").length;
  const needsReview = counts.needsReview ?? athletes.filter((athlete) => athleteGroup(athlete) === "needs_review").length;
  return {
    total,
    needsState,
    needsReview,
    done: Math.max(0, total - needsState - needsReview),
    outside: counts.recordedOutsideRoster ?? (data?.recordedOutsideRoster?.length || 0),
  };
}

// The chip shown when the coach has not picked one: All on desktop; on a
// phone Needs a state when anybody needs one, otherwise All.
export function effectiveRosterFilter(roster) {
  if (roster.filter) return roster.filter;
  if (isPhone() && rosterCounts(roster.data).needsState > 0) return "needs_state";
  return "all";
}

// The Roster tab's label, with what is known once the roster is read.
export function rosterTabLabel(roster, { accessible = false } = {}) {
  if (!roster?.data || roster.error) return "Roster";
  const { needsState } = rosterCounts(roster.data);
  if (needsState > 0) {
    if (!accessible && isPhone()) return `Roster · ${needsState}`;
    return `Roster · ${needsState} need${needsState === 1 ? "s" : ""} a state`;
  }
  const status = roster.data.completion?.status;
  if (status === "complete") return "Roster · Complete";
  if (status === "needs_review") return "Roster · Needs review";
  return "Roster";
}

// ---------------------------------------------------------------------------
// Row facts the actions share with the view (pure, from the roster answer).
// ---------------------------------------------------------------------------
export function findRosterAthlete(data, athleteId) {
  return (Array.isArray(data?.athletes) ? data.athletes : []).find((a) => String(a.athleteId) === String(athleteId)) ?? null;
}

export function athleteName(athlete) {
  return athlete?.name || "This athlete";
}

export function isTwoStates(athlete) {
  return Boolean(athlete?.flags?.includes("decisions_disagree"));
}

export function measuredAfterDecision(athlete) {
  return Boolean(athlete?.flags?.includes("measured_after_decision") && athlete?.decision);
}

// The source has a record for this athlete (◐): a bulk absence leaves the
// athlete out; a single absence asks first (section 3).
export function hasSourceRecord(athlete) {
  return athlete?.state === "no_usable_device_record" || Boolean(athlete?.sourceReason);
}

// A row without a saved state: the only rows a group decision may take
// (section 6). Two states rows are resolved on their own row.
export function bulkEligible(athlete) {
  if (!athlete || isTwoStates(athlete) || athlete.decision) return false;
  return athlete.state === "unknown" || athlete.state === "no_usable_device_record";
}

// The decision id a write expects: the current decision, one of the two
// current ones after a merge (either matches), or null for none.
export function expectedDecisionIdOf(athlete) {
  if (athlete?.decision?.id) return athlete.decision.id;
  const conflicting = athlete?.conflictingDecisions ?? [];
  return conflicting.length ? conflicting[0].id : null;
}

export function stateWord(stateKey) {
  return STATE_LABELS[stateKey] || "Unknown";
}

function reasonLabel(reasons, key) {
  if (!key) return "";
  return reasons.find((r) => r.key === key)?.label ?? "";
}

// "Did not participate · Illness" / "Measured" / "Two states": the state as
// the row shows it, for a current state the server answered with or for a
// roster athlete.
export function currentStateText(current, reasons = []) {
  if (!current) return "Unknown";
  if (isTwoStates(current) || (current.state === "unknown" && (current.currentDecisionIds?.length ?? 0) > 1 && !current.decision)) return "Two states";
  const decision = current.decision;
  if (decision && decision.kind !== "cleared") {
    const reason = reasonLabel(reasons, decision.reasonKey);
    return `${decision.label || stateWord(decision.kind)}${reason ? ` · ${reason}` : ""}`;
  }
  return current.stateLabel || stateWord(current.state);
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
function isOpen(roster, key) {
  return (roster.openDisclosures || []).includes(key);
}

function disclosureAttrs(roster, key) {
  const open = isOpen(roster, key);
  return `data-roster-disclosure="${escapeAttr(key)}" data-rendered-open="${open ? "1" : "0"}"${open ? " open" : ""}`;
}

function stateView(athlete) {
  if (isTwoStates(athlete)) return { glyph: "○", label: "Two states" };
  return { glyph: STATE_GLYPHS[athlete.state] ?? "○", label: athlete.stateLabel ?? "Unknown" };
}

function decisionLine(decision, reasons) {
  if (!decision) return "";
  const reason = reasonLabel(reasons, decision.reasonKey);
  const who = decision.decidedBy?.name ? `${decision.decidedBy.name}, ${shortDate(decision.decidedAt)}` : shortDate(decision.decidedAt);
  const label = decision.label || stateWord(decision.kind);
  return `${label}${reason ? ` · ${reason}` : ""}${who ? ` — ${who}` : ""}`;
}

// What the row says under its state, in the coach's words.
function rowNotes(athlete, reasons) {
  const notes = [];
  if (isTwoStates(athlete)) {
    const both = (athlete.conflictingDecisions ?? []).map((d) => `${d.label || stateWord(d.kind)}${reasonLabel(reasons, d.reasonKey) ? ` · ${reasonLabel(reasons, d.reasonKey)}` : ""}${d.decidedBy?.name ? ` (${d.decidedBy.name})` : ""}`);
    notes.push(`Two states after sessions were merged: ${both.join(" / ")}. One choice below replaces both.`);
  } else if (athlete.decision) {
    notes.push(decisionLine(athlete.decision, reasons));
    if (athlete.decision.note) notes.push(`Note: ${athlete.decision.note}`);
  }
  if (athlete.sourceReason) {
    const name = sourceName();
    const label = athlete.sourceReason.label || athlete.sourceReason.reasonLabel;
    const code = athlete.sourceReason.code || athlete.sourceReason.reasonCode;
    const said = label ? `${name} ${label}.` : `${name} could not give a usable record for this athlete.`;
    const next = SOURCE_REASON_NEXT_STEP[code];
    notes.push(next ? `${said} ${next}` : said);
  }
  if (athlete.state === "measured_change_waiting") notes.push("A newer version of these values is waiting for review in Imports.");
  if (measuredAfterDecision(athlete)) {
    notes.push(`Measured values arrived after ${athlete.decision.decidedBy?.name ?? "a coach"} set "${athlete.decision.label ?? ""}" (${shortDate(athlete.decision.decidedAt)}).`);
  }
  return notes.filter(Boolean);
}

function allValuesHtml(athlete) {
  const values = displayValues(athlete);
  if (!values.length) return `<p class="muted tl-roster-no-values">No measured values for this session.</p>`;
  return `
    <dl class="tl-roster-all-values">
      ${values.map((value) => `
        <div>
          <dt>${escapeHtml(metricLabel(value))}</dt>
          <dd>${escapeHtml(formatRosterValue(value))}</dd>
        </div>
      `).join("")}
    </dl>
  `;
}

function athleteGroup(athlete) {
  if (ROSTER_GROUPS.some((group) => group.id === athlete.group)) return athlete.group;
  if (isTwoStates(athlete)) return "needs_state";
  if (athlete.state === "unknown" || athlete.state === "no_usable_device_record") return "needs_state";
  if (athlete.state === "measured_change_waiting" || athlete.flags?.includes("measured_after_decision")) return "needs_review";
  return "done";
}

function normalizedAthletes(data) {
  return Array.isArray(data?.athletes) ? data.athletes : [];
}

function outsideAthletes(data) {
  return Array.isArray(data?.recordedOutsideRoster) ? data.recordedOutsideRoster : [];
}

function stateLabel(athlete) {
  return athlete.stateLabel || STATE_LABELS[athlete.state] || "Unknown";
}

// Whether this viewer may decide (the read always comes with a basis; a
// future read without one renders without actions — contract L7).
export function viewerCanDecide(data) {
  return Boolean(data?.viewer?.basis);
}

function technicalDetailsHtml(roster, athlete, outside = false) {
  const key = `tech:${athlete.athleteId}`;
  const source = athlete.sourceReason;
  const items = [
    ["Athlete ID", athlete.athleteId],
    ["Roster state", athlete.state],
    ["Source", source?.sourceSystem],
    ["Source reason", source?.code || source?.reasonCode],
    ["Flags", (athlete.flags ?? []).join(", ")],
    ["Recorded outside roster", outside ? "true" : ""],
  ].filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!items.length) return "";
  return `
    <details class="tl-roster-technical" ${disclosureAttrs(roster, key)}>
      <summary>Technical details</summary>
      <dl>
        ${items.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}
      </dl>
    </details>
  `;
}

// --- locks and busy states (shared with the actions through the state) ---
// One command at a time: while a write is in flight or a result is not
// confirmed, every row and the group controls are locked (section 7); the
// only live control is Check result.
export function anyWriteInFlight(roster) {
  return Object.keys(roster.busy || {}).length > 0;
}

export function rowLocked(roster, athleteId) {
  if (roster.writeLock || roster.unconfirmed || anyWriteInFlight(roster)) return true;
  return Boolean(roster.busy?.[athleteId]);
}

export function bulkLocked(roster) {
  return Boolean(roster.writeLock || roster.unconfirmed || anyWriteInFlight(roster));
}

function button(label, action, attrs = "", cls = "plain-button tl-roster-button") {
  return `<button type="button" class="${cls}" data-action="${escapeAttr(action)}" ${attrs}>${escapeHtml(label)}</button>`;
}

const WRITE_NOTICE_ACTIONS = new Set(["training-load-roster-try-again", "training-load-roster-bulk-retry"]);

// A notice's action that starts a command obeys the same "one command at a
// time" lock as every row control.
function noticeActionHtml(notice, roster) {
  const a = notice?.action;
  if (!a) return "";
  const extra = a.activityId ? ` data-activity-id="${escapeAttr(a.activityId)}"` : "";
  const athlete = a.athleteId ? ` data-athlete-id="${escapeAttr(a.athleteId)}"` : "";
  const locked = roster && WRITE_NOTICE_ACTIONS.has(a.action) && bulkLocked(roster) ? " disabled" : "";
  return button(a.label, a.action, `${extra}${athlete}${locked}`, `${a.primary ? "primary-button" : "plain-button"} tl-roster-button`);
}

function noticeHtml(notice, { cls = "", roster = null } = {}) {
  if (!notice) return "";
  const lines = Array.isArray(notice.lines) ? notice.lines : [];
  return `
    <div class="tl-roster-notice is-${escapeAttr(notice.tone || "info")} ${cls}" role="${notice.tone === "saved" ? "status" : "alert"}">
      <p>${escapeHtml(notice.text)}</p>
      ${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
      ${noticeActionHtml(notice, roster)}
      ${notice.code ? `<details class="tl-roster-technical"><summary>Technical details</summary><dl><div><dt>Error code</dt><dd>${escapeHtml(notice.code)}</dd></div></dl></details>` : ""}
    </div>
  `;
}

function confirmHtml(roster, athlete) {
  const c = roster.confirm;
  if (!c || c.athleteId !== athlete.athleteId) return "";
  const busy = rowLocked(roster, athlete.athleteId) ? "disabled" : "";
  return `
    <div class="tl-roster-confirm" role="group" aria-label="Confirm">
      <p>${escapeHtml(c.text)}</p>
      <div class="tl-roster-actions">
        ${button(c.proceedLabel, "training-load-roster-confirm-proceed", `data-athlete-id="${escapeAttr(athlete.athleteId)}" ${busy}`, "primary-button tl-roster-button")}
        ${button("Cancel", "training-load-roster-confirm-cancel", "")}
      </div>
    </div>
  `;
}

// The reason list (section 5): a popover under the row on desktop, one
// bottom sheet on a phone (rendered by pickerSheetHtml). Tapping a reason
// saves for a single athlete; a bulk absence takes the reason and applies
// from the same panel.
function reasonListHtml(roster, picker, reasons, { forTwoStates = false } = {}) {
  const disabled = picker.sending ? "disabled" : "";
  return `
    <p class="tl-roster-picker-hint">${forTwoStates ? "Choose a reason, then confirm that it replaces both states." : picker.scope === "bulk" ? "Choose a reason and apply it below:" : "Choose a reason to save:"}</p>
    <ul class="tl-roster-reasons" role="list">
      ${reasons.map((r) => `
        <li>
          <button type="button" class="plain-button tl-roster-reason ${picker.reasonKey === r.key ? "is-chosen" : ""}" data-action="training-load-roster-reason" data-reason-key="${escapeAttr(r.key)}" aria-pressed="${picker.reasonKey === r.key ? "true" : "false"}" ${disabled}>${escapeHtml(r.label)}</button>
        </li>
      `).join("")}
    </ul>
    ${reasons.length ? "" : `<p class="muted">No reasons are available right now.</p>`}
  `;
}

function noteFieldHtml(picker) {
  const note = picker.note || "";
  return `
    <label class="tl-roster-note">
      <span>Note (optional) <small data-roster-note-count>${note.length}/500</small></span>
      <textarea data-action="training-load-roster-note" data-roster-note maxlength="500" rows="2" ${picker.sending ? "disabled" : ""}>${escapeHtml(note)}</textarea>
    </label>
  `;
}

function pickerErrorHtml(picker) {
  return picker.error ? `<p class="tl-roster-picker-error" role="alert">${escapeHtml(picker.error)}</p>` : "";
}

function rowPickerBodyHtml(roster, athlete, reasons) {
  const picker = roster.picker;
  const name = athleteName(athlete);
  const two = isTwoStates(athlete);
  if (picker.step === "confirm_two") {
    const reason = reasonLabel(reasons, picker.reasonKey);
    return `
      <p class="tl-roster-picker-title">Replace both states of ${escapeHtml(name)} with "Did not participate${reason ? ` · ${reason}` : ""}"?</p>
      ${pickerErrorHtml(picker)}
      <div class="tl-roster-actions">
        ${button("Replace both states", "training-load-roster-picker-confirm", picker.sending ? "disabled" : "", "primary-button tl-roster-button")}
        ${button("Back", "training-load-roster-picker-back", picker.sending ? "disabled" : "")}
        ${button("Cancel", "training-load-roster-picker-cancel", picker.sending ? "disabled" : "")}
      </div>
    `;
  }
  return `
    <p class="tl-roster-picker-title">Why did ${escapeHtml(name)} not participate?</p>
    ${noteFieldHtml(picker)}
    ${pickerErrorHtml(picker)}
    ${reasonListHtml(roster, picker, reasons, { forTwoStates: two })}
    ${picker.sending ? `<p class="muted" aria-live="polite">Saving…</p>` : ""}
    <div class="tl-roster-actions">${button("Cancel", "training-load-roster-picker-cancel", picker.sending ? "disabled" : "")}</div>
  `;
}

// Who a group decision would change: names in roster order, each hidden by
// the current chip filter marked, and for an absence the athletes with a
// source record left out and named (section 6).
export function bulkPlan(roster, kind = roster.picker?.kind) {
  const data = roster.data;
  const filter = effectiveRosterFilter(roster);
  const selected = new Set(roster.selected || []);
  const included = [];
  const excluded = [];
  let hidden = 0;
  for (const athlete of normalizedAthletes(data)) {
    if (!selected.has(athlete.athleteId)) continue;
    const visible = filter === "all" || athleteGroup(athlete) === filter;
    if (!visible) hidden += 1;
    if (kind === "did_not_participate" && hasSourceRecord(athlete)) {
      excluded.push(athlete);
      continue;
    }
    included.push({ athlete, visible });
  }
  return { included, excluded, hidden, total: selected.size };
}

function bulkPickerBodyHtml(roster, reasons) {
  const picker = roster.picker;
  const disabled = picker.sending ? "disabled" : "";
  if (!picker.kind) {
    return `
      <p class="tl-roster-picker-title">Set one state for ${escapeHtml(plural(roster.selected.length, "athlete", "athletes"))}</p>
      <div class="tl-roster-actions is-stacked">
        ${button(DECISION_LABELS.participated_no_values, "training-load-roster-bulk-kind", `data-kind="participated_no_values" ${disabled}`, "primary-button tl-roster-button")}
        ${button(DECISION_LABELS.did_not_participate, "training-load-roster-bulk-kind", `data-kind="did_not_participate" ${disabled}`)}
        ${button("Cancel", "training-load-roster-picker-cancel", disabled)}
      </div>
    `;
  }
  const plan = bulkPlan(roster, picker.kind);
  const names = plan.included.map(({ athlete, visible }) => `${athleteName(athlete)}${visible ? "" : " (not shown in this filter)"}`);
  const n = plan.included.length;
  const applyLabel = `Apply to ${plural(n, "athlete", "athletes")}`;
  const canApply = n > 0 && !picker.sending && (picker.kind !== "did_not_participate" || Boolean(picker.reasonKey));
  const excludedLines = plan.excluded.map((athlete) => `${athleteName(athlete)} is left out: ${sourceName({ midSentence: true })} has a record for ${athleteName(athlete)}. Set this state on the row.`);
  return `
    <p class="tl-roster-picker-title">${picker.kind === "did_not_participate"
      ? `Why did ${escapeHtml(plural(n, "athlete", "athletes"))} not participate?`
      : `Set "${escapeHtml(DECISION_LABELS.participated_no_values)}" for ${escapeHtml(plural(n, "athlete", "athletes"))}?`}</p>
    ${n ? `<p class="tl-roster-picker-names">${escapeHtml(names.join(", "))}.</p>` : `<p class="muted">Nobody in the selection can take this state here. Set it on each row.</p>`}
    ${excludedLines.map((line) => `<p class="tl-roster-picker-excluded">${escapeHtml(line)}</p>`).join("")}
    ${picker.kind === "did_not_participate" ? `${noteFieldHtml(picker)}${reasonListHtml(roster, picker, reasons)}` : ""}
    ${pickerErrorHtml(picker)}
    ${picker.sending ? `<p class="muted" aria-live="polite">Saving…</p>` : ""}
    <div class="tl-roster-actions">
      ${button(applyLabel, "training-load-roster-bulk-apply", canApply ? "" : "disabled", "primary-button tl-roster-button")}
      ${isPhone() && !picker.sending ? button("Back", "training-load-roster-bulk-kind", `data-kind=""`) : ""}
      ${button("Cancel", "training-load-roster-picker-cancel", disabled)}
    </div>
  `;
}

function pickerBodyHtml(roster, reasons) {
  const picker = roster.picker;
  if (!picker) return "";
  if (picker.scope === "bulk") return bulkPickerBodyHtml(roster, reasons);
  const athlete = findRosterAthlete(roster.data, picker.athleteId);
  if (!athlete) return "";
  return rowPickerBodyHtml(roster, athlete, reasons);
}

// The one bottom sheet on a phone (never two).
function pickerSheetHtml(roster, reasons) {
  if (!roster.picker || !isPhone()) return "";
  return `
    <div class="tl-roster-sheet-backdrop" data-action="training-load-roster-picker-cancel"></div>
    <section class="tl-roster-sheet" role="dialog" aria-modal="true" aria-label="${roster.picker.scope === "bulk" ? "Set a state for the selected athletes" : "Choose a reason"}">
      ${pickerBodyHtml(roster, reasons)}
    </section>
  `;
}

function rowPickerHtml(roster, athlete, reasons) {
  const picker = roster.picker;
  if (!picker || picker.scope !== "row" || picker.athleteId !== athlete.athleteId || isPhone()) return "";
  return `<div class="tl-roster-picker" role="group" aria-label="Choose a reason">${rowPickerBodyHtml(roster, athlete, reasons)}</div>`;
}

function rowActionsHtml(roster, athlete) {
  const id = athlete.athleteId;
  const locked = rowLocked(roster, id);
  const dis = locked ? "disabled" : "";
  const attrs = (kind) => `data-athlete-id="${escapeAttr(id)}"${kind ? ` data-kind="${kind}"` : ""} ${dis}`;
  const busyLine = roster.busy?.[id] ? `<span class="muted tl-roster-busy" aria-live="polite">Saving…</span>` : "";
  const unconfirmedTag = roster.unconfirmed?.athleteIds?.includes(id) ? `<span class="tl-roster-tag is-unconfirmed">Result not confirmed</span>` : "";
  const notice = roster.notices?.rows?.[id];
  const savedTag = notice?.tone === "saved" ? `<span class="tl-roster-tag is-saved">Saved</span>` : "";
  let buttons = "";
  if (measuredAfterDecision(athlete)) {
    buttons = button("Use measured values", "training-load-roster-use-measured", attrs(), "primary-button tl-roster-button");
  } else if (athlete.state === "measured" || athlete.state === "measured_change_waiting") {
    buttons = "";
  } else if (athlete.decision && !isTwoStates(athlete)) {
    if (roster.changing === id) {
      // The current state is not offered again; the other one, a new
      // reason for an absence, and the removal are (section 4).
      const current = athlete.decision.kind;
      buttons = [
        current === "participated_no_values" ? "" : button(DECISION_LABELS.participated_no_values, "training-load-roster-set", attrs("participated_no_values"), "primary-button tl-roster-button"),
        current === "did_not_participate" ? "" : button(DECISION_LABELS.did_not_participate, "training-load-roster-absent", attrs(), "primary-button tl-roster-button"),
        current === "did_not_participate" ? button("Change the reason", "training-load-roster-absent", attrs()) : "",
        button("Remove this state", "training-load-roster-remove", attrs()),
        button("Cancel", "training-load-roster-change", attrs()),
      ].join("");
    } else {
      buttons = button("Change", "training-load-roster-change", attrs(), "plain-button tl-roster-button tl-roster-change");
    }
  } else {
    buttons = [
      button(DECISION_LABELS.participated_no_values, "training-load-roster-set", attrs("participated_no_values"), "primary-button tl-roster-button"),
      button(DECISION_LABELS.did_not_participate, "training-load-roster-absent", attrs()),
    ].join("");
  }
  if (!buttons && !busyLine && !unconfirmedTag && !savedTag) return "";
  return `<div class="tl-roster-actions tl-roster-row-actions">${buttons}${busyLine}${unconfirmedTag}${savedTag}</div>`;
}

function pickBoxHtml(roster, athlete, canDecide) {
  if (!canDecide || !bulkEligible(athlete)) return `<span class="tl-roster-pick" aria-hidden="true"></span>`;
  const checked = (roster.selected || []).includes(athlete.athleteId);
  const full = !checked && (roster.selected || []).length >= MAX_BULK_ATHLETES;
  const disabled = rowLocked(roster, athlete.athleteId) || bulkLocked(roster) || full ? "disabled" : "";
  return `<label class="tl-roster-pick"><input type="checkbox" data-action="training-load-roster-pick" data-athlete-id="${escapeAttr(athlete.athleteId)}" aria-label="Select ${escapeAttr(athleteName(athlete))}" ${checked ? "checked" : ""} ${disabled}></label>`;
}

function athleteRowHtml(roster, athlete, columns, reasons, { outside = false, canDecide = false } = {}) {
  const view = outside ? { glyph: STATE_GLYPHS.measured, label: "Measured" } : { ...stateView(athlete), label: stateLabel(athlete) };
  if (isTwoStates(athlete)) view.label = "Two states";
  const notes = outside ? [] : rowNotes(athlete, reasons);
  const rowKey = `row:${athlete.athleteId}`;
  const selected = !outside && (roster.selected || []).includes(athlete.athleteId);
  const changed = !outside && (roster.changedRows || []).includes(athlete.athleteId);
  const notice = outside ? null : roster.notices?.rows?.[athlete.athleteId];
  const classes = [
    "tl-roster-row",
    columns.length ? "" : "has-no-metrics",
    outside ? "is-outside" : `is-${athleteGroup(athlete)}`,
    selected ? "is-selected" : "",
    changed ? "is-changed" : "",
    !outside && rowLocked(roster, athlete.athleteId) ? "is-locked" : "",
    notice?.tone === "saved" ? "is-saved" : "",
  ].filter(Boolean).join(" ");
  return `
    <div class="${classes}" style="--tl-roster-metrics:${columns.length}" data-roster-row="${escapeAttr(athlete.athleteId)}">
      <div class="tl-roster-row-summary">
        ${outside ? `<span class="tl-roster-pick" aria-hidden="true"></span>` : pickBoxHtml(roster, athlete, canDecide)}
        <span class="tl-roster-athlete-name">${escapeHtml(athlete.name || "Athlete")}${changed ? `<small class="tl-roster-changed">Changed since you last looked</small>` : ""}</span>
        <span class="tl-roster-state"><span aria-hidden="true">${view.glyph}</span> ${escapeHtml(view.label)}</span>
        ${columns.map((column) => {
          const value = displayValues(athlete).find((item) => metricKey(item) === column.metricKey);
          return `<span class="tl-roster-cell" data-label="${escapeAttr(column.label)}">${escapeHtml(formatRosterValue(value))}</span>`;
        }).join("")}
      </div>
      ${notes.length ? `<div class="tl-roster-row-notes">${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}</div>` : ""}
      ${outside || !canDecide ? "" : rowActionsHtml(roster, athlete)}
      ${outside ? "" : noticeHtml(notice, { cls: "tl-roster-row-notice", roster })}
      ${outside || !canDecide ? "" : confirmHtml(roster, athlete)}
      ${outside || !canDecide ? "" : rowPickerHtml(roster, athlete, reasons)}
      <details class="tl-roster-row-more" ${disclosureAttrs(roster, rowKey)}>
        <summary>Details</summary>
        <div class="tl-roster-row-body">
          ${allValuesHtml(athlete)}
          ${technicalDetailsHtml(roster, athlete, outside)}
        </div>
      </details>
    </div>
  `;
}

function filterChipHtml(filter, id, label, count) {
  const active = filter === id;
  return `
    <button type="button" class="tl-roster-filter ${active ? "is-active" : ""}"
      data-action="training-load-roster-filter" data-roster-filter="${escapeAttr(id)}"
      aria-pressed="${active ? "true" : "false"}">${escapeHtml(label)} <span>${count}</span></button>
  `;
}

function rosterHeaderHtml(roster, data, activitySummary, canDecide) {
  const activity = { ...(activitySummary ?? {}), ...(data.activity ?? {}) };
  const counts = rosterCounts(data);
  const completion = data.completion?.status;
  const status = completion === "complete" ? "Complete" : completion === "needs_review" ? "Needs review" : "";
  const summary = [
    counts.total ? `${counts.total} on the roster` : "No athletes on this session's roster",
    counts.total && counts.needsState ? `${counts.needsState} need${counts.needsState === 1 ? "s" : ""} a state` : counts.total ? "Everybody has a state" : "",
    counts.needsReview ? `${counts.needsReview} need${counts.needsReview === 1 ? "s" : ""} review` : "",
  ].filter(Boolean).join(" · ");
  return `
    <header class="tl-roster-header">
      <div>
        <h4>${escapeHtml(activity.name || "Team session")}${sessionWhenLabel(activity) ? ` <span class="muted">· ${escapeHtml(sessionWhenLabel(activity))}</span>` : ""}</h4>
        <p>${escapeHtml(summary)}</p>
        <p class="muted">${canDecide ? "Each state is saved as soon as you choose it." : "Review the roster and the data recorded for this session."}</p>
      </div>
      ${status ? `<span class="tl-roster-status is-${completion}">${escapeHtml(status)}</span>` : ""}
    </header>
  `;
}

// Rows a "Select the N that need a state" would tick right now: without a
// saved state, not Two states, not locked.
export function selectableAthletes(roster) {
  return normalizedAthletes(roster.data).filter((athlete) => bulkEligible(athlete) && !rowLocked(roster, athlete.athleteId));
}

// The selection bar above the table (desktop) and the select button (both
// sizes). On a phone the selected count and Set state… live in the sticky
// bar; the bar here only offers Select the N.
function selectionBarHtml(roster, canDecide) {
  if (!canDecide) return "";
  const selected = roster.selected || [];
  const selectable = selectableAthletes(roster);
  const unselected = selectable.filter((athlete) => !selected.includes(athlete.athleteId));
  const disabled = bulkLocked(roster) ? "disabled" : "";
  const notes = roster.notices?.selection ?? [];
  if (!selected.length && !unselected.length && !notes.length) return "";
  const plan = bulkPlan(roster, null);
  const phone = isPhone();
  const summary = selected.length
    ? `${selected.length} selected${plan.hidden ? ` · ${plan.hidden} not in this filter` : ""}`
    : "";
  return `
    <div class="tl-roster-select-bar" role="group" aria-label="One state for several athletes">
      ${unselected.length ? button(`Select the ${unselected.length} that ${unselected.length === 1 ? "needs" : "need"} a state`, "training-load-roster-select-needing", disabled) : ""}
      ${selected.length ? `<p class="tl-roster-select-summary" role="status"><strong>${escapeHtml(summary)}</strong></p>` : ""}
      ${!selected.length && notes.length ? button("Dismiss", "training-load-roster-clear-selection", "") : ""}
      ${selected.length && !phone ? `
        <div class="tl-roster-actions">
          ${button(DECISION_LABELS.participated_no_values, "training-load-roster-bulk", `data-kind="participated_no_values" ${disabled}`, "primary-button tl-roster-button")}
          ${button(DECISION_LABELS.did_not_participate, "training-load-roster-bulk", `data-kind="did_not_participate" ${disabled}`)}
          ${button("Clear selection", "training-load-roster-clear-selection", disabled)}
        </div>
      ` : ""}
      ${notes.map((line) => `<p class="muted tl-roster-select-note">${escapeHtml(line)}</p>`).join("")}
      ${roster.picker?.scope === "bulk" && !phone ? `<div class="tl-roster-picker is-bulk" role="group" aria-label="Set a state for the selected athletes">${bulkPickerBodyHtml(roster, roster.data.reasons ?? [])}</div>` : ""}
    </div>
  `;
}

// One message and one action at a time on a phone (section 1). 5a3b covers
// priorities 1–3; Needs review / Complete arrive in 5a3c.
function stickyBarHtml(roster, canDecide) {
  if (!isPhone() || !canDecide) return "";
  const u = roster.unconfirmed;
  if (u) {
    return `
      <div class="tl-roster-sticky" role="status">
        <span>1 result is not confirmed</span>
        ${button("Check result", "training-load-roster-check-result", u.checking ? "disabled" : "", "primary-button tl-roster-button")}
      </div>
    `;
  }
  const selected = roster.selected || [];
  if (selected.length) {
    const disabled = bulkLocked(roster) ? "disabled" : "";
    const plan = bulkPlan(roster, null);
    return `
      <div class="tl-roster-sticky" role="group" aria-label="Selected athletes">
        <span>${selected.length} selected${plan.hidden ? ` · ${plan.hidden} not in this filter` : ""}</span>
        ${button("Set state…", "training-load-roster-set-state", disabled, "primary-button tl-roster-button")}
        ${button("Clear", "training-load-roster-clear-selection", disabled)}
      </div>
    `;
  }
  const counts = rosterCounts(roster.data);
  if (counts.needsState > 0 && effectiveRosterFilter(roster) !== "needs_state") {
    return `
      <div class="tl-roster-sticky" role="status">
        <span>${escapeHtml(plural(counts.needsState, "athlete needs", "athletes need"))} a state</span>
        ${button("Show them", "training-load-roster-filter", `data-roster-filter="needs_state"`)}
      </div>
    `;
  }
  return "";
}

function topNoticesHtml(roster) {
  const parts = [];
  const u = roster.unconfirmed;
  if (u) {
    parts.push(noticeHtml({
      tone: "unconfirmed",
      text: "Result not confirmed. Do not choose another state until this result is checked.",
      lines: [
        u.label ? `Waiting for: ${u.label}.` : "",
        u.names?.length ? `Athletes in this change: ${u.names.join(", ")}.` : "",
        u.checks ? `Checked ${plural(u.checks, "time", "times")}, still not confirmed.` : "",
        u.checks >= 3 ? "If it stays unconfirmed, leave this session and open it again later: the roster will show whether the state was saved. The change is never sent twice." : "",
      ].filter(Boolean),
      action: { label: u.checking ? "Checking…" : "Check result", action: "training-load-roster-check-result", primary: true },
      code: u.code || "",
    }));
  }
  if (roster.notices?.top) parts.push(noticeHtml(roster.notices.top, { roster }));
  if (roster.refreshFailed) {
    parts.push(noticeHtml({ tone: "info", text: "Saved, but the roster could not be refreshed.", action: { label: "Try again", action: "training-load-roster-refresh" } }));
  }
  if (roster.writeLock) {
    const lock = roster.writeLock;
    const text = lock.kind === "forbidden"
      ? "Your access changed before this choice was saved. Nothing was saved."
      : lock.kind === "superseded"
        ? "This session was merged into another. Nothing was saved."
        : "This session is not available any more. Nothing was saved.";
    const action = lock.kind === "superseded" && lock.canonicalActivityId
      ? { label: "Open the current session", action: "training-load-calendar-select-activity", activityId: lock.canonicalActivityId, primary: true }
      : { label: "Back to activities", action: "training-load-calendar-clear-activity", primary: true };
    parts.push(noticeHtml({ tone: "refused", text, action }));
  }
  return parts.join("");
}

function rosterTableHtml(roster, data, canDecide) {
  const athletes = normalizedAthletes(data);
  const reasons = data.reasons ?? [];
  const columns = rosterValueColumns([...athletes, ...outsideAthletes(data)]);
  const filter = effectiveRosterFilter(roster);
  const groups = ROSTER_GROUPS.map((group) => ({
    ...group,
    athletes: athletes
      .filter((athlete) => athleteGroup(athlete) === group.id)
      .sort((a, b) => String(a.name || a.athleteName || "").localeCompare(String(b.name || b.athleteName || ""))),
  }));
  // A row that carries a fresh outcome (Saved, a refusal, a result not
  // confirmed, a save in flight) stays where the coach's thumb is, whatever
  // the filter, until the filter changes (section 1); it is shown under its
  // own group name.
  const pinned = (athlete) => Boolean(roster.notices?.rows?.[athlete.athleteId]) || Boolean(roster.unconfirmed?.athleteIds?.includes(athlete.athleteId)) || Boolean(roster.busy?.[athlete.athleteId]);
  const visibleGroups = filter === "all"
    ? groups
    : groups.map((group) => ({ ...group, athletes: group.id === filter ? group.athletes : group.athletes.filter(pinned) }));
  const visibleCount = visibleGroups.reduce((sum, group) => sum + group.athletes.length, 0);
  return `
    <div class="tl-roster-table ${columns.length ? "" : "has-no-metrics"}" aria-label="Session roster" style="--tl-roster-metrics:${columns.length}">
      <div class="tl-roster-table-head">
        <span aria-hidden="true"></span><span>Athlete</span><span>State</span>
        ${columns.map((column) => `<span>${escapeHtml(column.label)}</span>`).join("")}
      </div>
      ${visibleGroups.map((group) => group.athletes.length ? `
        <section class="tl-roster-group" aria-labelledby="tl-roster-group-${group.id}">
          <h5 id="tl-roster-group-${group.id}">${escapeHtml(group.label)} <span>${group.athletes.length}</span></h5>
          ${group.athletes.map((athlete) => athleteRowHtml(roster, athlete, columns, reasons, { canDecide })).join("")}
        </section>
      ` : "").join("")}
      ${visibleCount ? "" : `<p class="muted tl-roster-empty-filter">No athletes in this group.</p>`}
    </div>
  `;
}

function recordedOutsideHtml(roster, data) {
  const athletes = outsideAthletes(data);
  if (!athletes.length) return "";
  const columns = rosterValueColumns(athletes);
  const key = "outside";
  const defaultOpen = normalizedAthletes(data).length === 0;
  const explicitlyClosed = (roster.closedDisclosures || []).includes(key);
  const open = isOpen(roster, key) || (defaultOpen && !explicitlyClosed);
  return `
    <details class="tl-roster-outside" data-roster-disclosure="outside" data-rendered-open="${open ? "1" : "0"}"${open ? " open" : ""}>
      <summary>Recorded, but not on this session's roster <span>${athletes.length}</span></summary>
      <div class="tl-roster-outside-body ${columns.length ? "" : "has-no-metrics"}" style="--tl-roster-metrics:${columns.length}">
        <p>These athletes have recorded values, but they are not part of this session's roster. They do not need a roster state and do not block completion.</p>
        <p class="muted">If this is unexpected, check the athlete's team membership. Historical membership cannot be changed here.</p>
        <div class="tl-roster-outside-head ${columns.length ? "" : "has-no-metrics"}">
          <span aria-hidden="true"></span><span>Athlete</span><span>State</span>
          ${columns.map((column) => `<span>${escapeHtml(column.label)}</span>`).join("")}
        </div>
        ${athletes.map((athlete) => athleteRowHtml(roster, athlete, columns, data.reasons ?? [], { outside: true })).join("")}
      </div>
    </details>
  `;
}

function rosterErrorHtml(roster) {
  const error = roster.error;
  if (error?.kind === "not_found") {
    return `<div class="tl-roster-message" role="status"><p>This session is not available any more.</p><button type="button" class="plain-button" data-action="training-load-calendar-clear-activity">Back to activities</button></div>`;
  }
  if (error?.kind === "superseded") {
    return `<div class="tl-roster-message" role="status"><p>This session was merged into another.</p>${error.canonicalActivityId ? `<button type="button" class="plain-button" data-action="training-load-calendar-select-activity" data-activity-id="${escapeAttr(error.canonicalActivityId)}">Open the current session</button>` : ""}</div>`;
  }
  return `<div class="tl-roster-message" role="alert"><p>The roster could not be loaded.</p><button type="button" class="plain-button" data-action="training-load-roster-retry">Try again</button></div>`;
}

export function renderActivityRosterHtml(roster = state.trainingLoad.calendar.roster, activitySummary = null) {
  if (roster.error) return rosterErrorHtml(roster);
  if (roster.loading && !roster.data) return `<p class="muted training-load-empty tl-roster-loading" aria-live="polite">Loading the roster&hellip;</p>`;
  const data = roster.data;
  if (!data) return "";
  const athletes = normalizedAthletes(data);
  const outside = outsideAthletes(data);
  const counts = rosterCounts(data);
  const filter = effectiveRosterFilter(roster);
  const canDecide = viewerCanDecide(data) && !roster.writeLock;
  return `
    <section class="tl-roster ${roster.picker && isPhone() ? "has-sheet" : ""}" aria-label="Activity roster">
      ${rosterHeaderHtml(roster, data, activitySummary, canDecide)}
      ${roster.loading ? `<p class="muted tl-roster-refreshing" aria-live="polite">Refreshing the roster&hellip;</p>` : ""}
      ${topNoticesHtml(roster)}
      <nav class="tl-roster-filters" aria-label="Filter roster">
        ${filterChipHtml(filter, "needs_state", "Needs a state", counts.needsState)}
        ${filterChipHtml(filter, "needs_review", "Needs review", counts.needsReview)}
        ${filterChipHtml(filter, "done", "Done", counts.done)}
        ${filterChipHtml(filter, "all", "All", counts.total)}
      </nav>
      ${athletes.length ? selectionBarHtml(roster, canDecide) : ""}
      ${athletes.length ? rosterTableHtml(roster, data, canDecide) : `<p class="muted tl-roster-empty">Nobody was a member of this team on ${escapeHtml(sessionDateLabel(data.activity ?? activitySummary))}. The roster lists the team's members on the session date.</p>`}
      ${recordedOutsideHtml(roster, data)}
      ${!athletes.length && !outside.length ? `<p class="muted">No recorded athletes sit outside this roster.</p>` : ""}
      ${stickyBarHtml(roster, canDecide)}
      ${canDecide ? pickerSheetHtml(roster, data.reasons ?? []) : ""}
    </section>
  `;
}
