// Phase 5a3a: the Roster tab of a team session, read-only.
// Contract: docs/ai/phase5a3-roster-ux-draft.md — sections 0 (rules), 1
// (opening, header, filters, states), 2 (measured, values from the
// response's metrics), 3 (no usable device record) and 9 (recorded, but
// not on this session's roster).
//
// Nothing here writes: setting, changing or removing a state, bulk
// decisions and Complete arrive in 5a3b/5a3c. The screen therefore shows no
// such button, only a short note in the header.
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

// Glyph + word: the state is never told by color alone.
const STATE_GLYPHS = Object.freeze({
  unknown: "○",
  no_usable_device_record: "◐",
  did_not_participate: "✕",
  participated_no_values: "▢",
  measured: "●",
  measured_change_waiting: "●",
});

// Next step for a source reason the coach can act on outside OptiMove.
const SOURCE_REASON_NEXT_STEP = Object.freeze({
  needs_manual_review: "Fix it there, then find new sessions in Imports.",
});

const MAX_VALUE_COLUMNS = 3;

function sourceName() {
  return "The device source";
}

function isPhone() {
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

function isOpen(roster, key) {
  return roster.openDisclosures.includes(key);
}

function disclosureAttrs(roster, key) {
  const open = isOpen(roster, key);
  return `data-roster-disclosure="${escapeAttr(key)}" data-rendered-open="${open ? "1" : "0"}"${open ? " open" : ""}`;
}

function stateView(athlete) {
  if (athlete.flags?.includes("decisions_disagree")) return { glyph: "○", label: "Two states" };
  return { glyph: STATE_GLYPHS[athlete.state] ?? "○", label: athlete.stateLabel ?? "Unknown" };
}

function reasonLabel(reasons, key) {
  if (!key) return "";
  return reasons.find((r) => r.key === key)?.label ?? "";
}

function decisionLine(decision, reasons) {
  if (!decision) return "";
  const reason = reasonLabel(reasons, decision.reasonKey);
  const who = decision.decidedBy?.name ? `${decision.decidedBy.name}, ${shortDate(decision.decidedAt)}` : shortDate(decision.decidedAt);
  const label = decision.label || stateLabel({ state: decision.kind });
  return `${label}${reason ? ` · ${reason}` : ""}${who ? ` — ${who}` : ""}`;
}

// What the row says under its state, in the coach's words.
function rowNotes(athlete, reasons) {
  const notes = [];
  if (athlete.flags?.includes("decisions_disagree")) {
    const both = (athlete.conflictingDecisions ?? []).map((d) => `${d.label || stateLabel({ state: d.kind })}${reasonLabel(reasons, d.reasonKey) ? ` · ${reasonLabel(reasons, d.reasonKey)}` : ""}${d.decidedBy?.name ? ` (${d.decidedBy.name})` : ""}`);
    notes.push(`Two states after sessions were merged: ${both.join(" / ")}.`);
  } else if (athlete.decision) {
    notes.push(decisionLine(athlete.decision, reasons));
    if (athlete.decision.note) notes.push(`Note: ${athlete.decision.note}`);
  }
  if (athlete.sourceReason && (athlete.state === "no_usable_device_record" || athlete.state === "unknown")) {
    const name = sourceName(athlete.sourceReason);
    const label = athlete.sourceReason.label || athlete.sourceReason.reasonLabel;
    const code = athlete.sourceReason.code || athlete.sourceReason.reasonCode;
    const said = label ? `${name} ${label}.` : `${name} could not give a usable record for this athlete.`;
    const next = SOURCE_REASON_NEXT_STEP[code];
    notes.push(next ? `${said} ${next}` : said);
  }
  if (athlete.state === "measured_change_waiting") notes.push("A newer version of these values is waiting for review in Imports.");
  if (athlete.flags?.includes("measured_after_decision") && athlete.decision) {
    notes.push(`Measured values arrived after ${athlete.decision.decidedBy?.name ?? "a coach"} set "${athlete.decision.label ?? ""}" (${shortDate(athlete.decision.decidedAt)}).`);
  }
  return notes.filter(Boolean);
}

function valuesDl(columns, athlete, cls) {
  return `
    <dl class="${cls}">
      ${columns.map((c) => {
        const v = displayValues(athlete).find((x) => metricKey(x) === c.metricKey);
        return `<div><dt>${escapeHtml(c.label)}</dt><dd>${escapeHtml(formatRosterValue(v))}</dd></div>`;
      }).join("")}
    </dl>
  `;
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
  if (athlete.flags?.includes("decisions_disagree")) return "needs_state";
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
  const labels = {
    unknown: "Unknown",
    no_usable_device_record: "No usable device record",
    did_not_participate: "Did not participate",
    participated_no_values: "Participated · no device data",
    measured: "Measured",
    measured_change_waiting: "Measured · change waiting",
  };
  return athlete.stateLabel || labels[athlete.state] || "Unknown";
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

function athleteRowHtml(roster, athlete, columns, reasons, outside = false) {
  const view = outside ? { glyph: STATE_GLYPHS.measured, label: "Measured" } : { ...stateView(athlete), label: stateLabel(athlete) };
  if (athlete.flags?.includes("decisions_disagree")) view.label = "Two states";
  const notes = outside ? [] : rowNotes(athlete, reasons);
  const rowKey = `row:${athlete.athleteId}`;
  const collapsedDecision = !outside && athlete.state === "did_not_participate" && athlete.decision
    ? decisionLine(athlete.decision, reasons)
    : "";
  return `
    <details class="tl-roster-row ${columns.length ? "" : "has-no-metrics"} ${outside ? "is-outside" : `is-${athleteGroup(athlete)}`}" style="--tl-roster-metrics:${columns.length}" ${disclosureAttrs(roster, rowKey)}>
      <summary class="tl-roster-row-summary">
        <span class="tl-roster-athlete-name">${escapeHtml(athlete.name || "Athlete")}${collapsedDecision ? `<small>${escapeHtml(collapsedDecision)}</small>` : ""}</span>
        <span class="tl-roster-state"><span aria-hidden="true">${view.glyph}</span> ${escapeHtml(view.label)}</span>
        ${columns.map((column) => {
          const value = displayValues(athlete).find((item) => metricKey(item) === column.metricKey);
          return `<span class="tl-roster-cell" data-label="${escapeAttr(column.label)}">${escapeHtml(formatRosterValue(value))}</span>`;
        }).join("")}
      </summary>
      <div class="tl-roster-row-body">
        ${notes.map((note) => `<p>${escapeHtml(note)}</p>`).join("")}
        ${allValuesHtml(athlete)}
        ${technicalDetailsHtml(roster, athlete, outside)}
      </div>
    </details>
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

function rosterHeaderHtml(roster, data, activitySummary) {
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
        <p class="muted">Review the roster and the data recorded for this session.</p>
      </div>
      ${status ? `<span class="tl-roster-status is-${completion}">${escapeHtml(status)}</span>` : ""}
    </header>
  `;
}

function rosterTableHtml(roster, data) {
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
  const visibleGroups = filter === "all" ? groups : groups.filter((group) => group.id === filter);
  const visibleCount = visibleGroups.reduce((sum, group) => sum + group.athletes.length, 0);
  return `
    <div class="tl-roster-table ${columns.length ? "" : "has-no-metrics"}" aria-label="Session roster" style="--tl-roster-metrics:${columns.length}">
      <div class="tl-roster-table-head">
        <span>Athlete</span><span>State</span>
        ${columns.map((column) => `<span>${escapeHtml(column.label)}</span>`).join("")}
      </div>
      ${visibleGroups.map((group) => group.athletes.length ? `
        <section class="tl-roster-group" aria-labelledby="tl-roster-group-${group.id}">
          <h5 id="tl-roster-group-${group.id}">${escapeHtml(group.label)} <span>${group.athletes.length}</span></h5>
          ${group.athletes.map((athlete) => athleteRowHtml(roster, athlete, columns, reasons)).join("")}
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
          <span>Athlete</span><span>State</span>
          ${columns.map((column) => `<span>${escapeHtml(column.label)}</span>`).join("")}
        </div>
        ${athletes.map((athlete) => athleteRowHtml(roster, athlete, columns, data.reasons ?? [], true)).join("")}
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
  return `
    <section class="tl-roster" aria-label="Activity roster">
      ${rosterHeaderHtml(roster, data, activitySummary)}
      ${roster.loading ? `<p class="muted tl-roster-refreshing" aria-live="polite">Refreshing the roster&hellip;</p>` : ""}
      <nav class="tl-roster-filters" aria-label="Filter roster">
        ${filterChipHtml(filter, "needs_state", "Needs a state", counts.needsState)}
        ${filterChipHtml(filter, "needs_review", "Needs review", counts.needsReview)}
        ${filterChipHtml(filter, "done", "Done", counts.done)}
        ${filterChipHtml(filter, "all", "All", counts.total)}
      </nav>
      ${athletes.length ? rosterTableHtml(roster, data) : `<p class="muted tl-roster-empty">Nobody was a member of this team on ${escapeHtml(sessionDateLabel(data.activity ?? activitySummary))}. The roster lists the team's members on the session date.</p>`}
      ${recordedOutsideHtml(roster, data)}
      ${!athletes.length && !outside.length ? `<p class="muted">No recorded athletes sit outside this roster.</p>` : ""}
    </section>
  `;
}
