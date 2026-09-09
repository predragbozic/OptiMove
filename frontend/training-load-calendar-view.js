import { state } from "./state.js";
import { escapeAttr, escapeHtml, formatDate, formatWeekday, monthLabel } from "./utils.js";
import { buildWeeklyCalendarMonth } from "./weekly-plan.js";
import { formatSrpe } from "./training-load-view.js";

// Training Load Frontend 3A — Calendar → Activity → Results. Deliberately
// its own module, imported by training-load-view.js's own coach root
// (renderTrainingLoadCoachHtml) in place of the old renderTrainingLoadTodayHtml
// — same neutral white/gray visual language as the rest of Training Load
// (see that file's own header), teal reserved for the active selection
// only, never a green block. Not yet the configurable Analysis dashboard —
// this is a fixed Calendar → Activity Detail → Results layout.

function calendarTodayIso() {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function formatWeekRangeLabel(weekStart, weekEnd) {
  return `${formatDate(weekStart)} - ${formatDate(weekEnd)}`;
}

// A short, per-item label for a summarized (month-cell / strip-badge)
// context — never a made-up/heuristic name, always the item's OWN real
// field.
function itemShortLabel(item) {
  if (item.kind === "activity") return item.name || "Activity";
  if (item.kind === "planned") return item.athleteName || item.sessionName || "Session";
  return item.athleteName || item.eventName || "Session";
}
function itemTime(item) {
  if (item.kind === "activity") return item.startedAt ? new Date(item.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (item.kind === "planned") return (item.sessionTime || "").slice(0, 5);
  return item.opensAt ? new Date(item.opensAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}
function itemKey(item) {
  return item.kind === "activity" ? `a:${item.activityId}` : item.kind === "planned" ? `p:${item.logicalSessionId}` : `e:${item.externalAssignmentId}`;
}

// ------------------------------------------------------------
// Week strip / month grid nav (item 4).
// ------------------------------------------------------------

function renderCalendarNavHeaderHtml(nav) {
  const monthLabelText = nav.monthMode ? monthLabel(nav.monthCursor || nav.weekStart) : formatWeekRangeLabel(nav.weekStart, nav.data ? nav.data.dateTo : nav.weekStart);
  return `
    <div class="training-load-weekly-nav tl-calendar-nav">
      <button type="button" class="plain-button icon-button training-load-weekly-arrow" data-action="training-load-calendar-prev" aria-label="${nav.monthMode ? "Previous month" : "Previous week"}">&larr;</button>
      <div class="training-load-weekly-range">
        <strong>${escapeHtml(monthLabelText)}</strong>
        <button type="button" class="plain-button compact-button training-load-weekly-today-button" data-action="training-load-calendar-today">Today</button>
      </div>
      <button type="button" class="plain-button icon-button training-load-weekly-arrow" data-action="training-load-calendar-next" aria-label="${nav.monthMode ? "Next month" : "Next week"}">&rarr;</button>
      <button type="button" class="plain-button compact-button tl-calendar-expand-toggle" data-action="training-load-calendar-toggle-month" aria-expanded="${nav.monthMode ? "true" : "false"}" aria-label="${nav.monthMode ? "Collapse to week view" : "Expand to month view"}">
        ${nav.monthMode ? "Week view" : "Month view"}
      </button>
    </div>
  `;
}

function dayItemCount(data, date) {
  if (!data) return 0;
  const bucket = data.days.find((d) => d.date === date);
  return bucket ? bucket.items.length : 0;
}

function renderCalendarStripHtml(nav) {
  const todayIso = calendarTodayIso();
  const days = nav.data ? nav.data.days : [];
  return `
    <div class="training-load-weekly-strip" role="tablist" aria-label="Select a day">
      ${days.map((day) => {
        const isSelected = day.date === nav.selectedDate;
        const isToday = day.date === todayIso;
        const dayNumber = Number(day.date.slice(8, 10));
        const count = day.items.length;
        return `
          <button type="button" class="training-load-weekly-day ${isSelected ? "is-selected" : ""} ${isToday ? "is-today" : ""}" role="tab" aria-selected="${isSelected ? "true" : "false"}" data-action="training-load-calendar-select-day" data-date="${escapeAttr(day.date)}" aria-label="${escapeAttr(formatWeekday(day.date))} ${dayNumber}${count ? `, ${count} activit${count === 1 ? "y" : "ies"}` : ""}">
            <span class="training-load-weekly-day-name">${escapeHtml(formatWeekday(day.date))}</span>
            <span class="training-load-weekly-day-number">${dayNumber}</span>
            ${count ? `<span class="training-load-weekly-day-count" aria-hidden="true">${count}</span>` : ""}
          </button>
        `;
      }).join("")}
    </div>
  `;
}

// Month grid (item 4) — reuses buildWeeklyCalendarMonth's own pure date-
// math (the SAME local-date grid logic the Weekly plan's own month picker
// already relies on, never re-implemented here) with a dayMap built from
// the calendar's own already-loaded items, not a separate fetch per cell.
function renderCalendarMonthGridHtml(nav) {
  const dayMap = new Map();
  if (nav.monthData) {
    for (const day of nav.monthData.days) {
      dayMap.set(day.date, { itemCount: day.items.length, hasItems: day.items.length > 0, items: day.items });
    }
  }
  const monthCursor = nav.monthCursor || nav.weekStart;
  const month = buildWeeklyCalendarMonth(monthCursor, dayMap);
  const todayIso = calendarTodayIso();
  return `
    <div class="tl-calendar-month-grid" role="tablist" aria-label="Select a day">
      <div class="tl-calendar-month-weekday-row" aria-hidden="true">
        ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<span>${d}</span>`).join("")}
      </div>
      <div class="tl-calendar-month-days">
        ${month.days.map((day) => {
          const isSelected = day.date === nav.selectedDate;
          const isToday = day.date === todayIso;
          const meta = dayMap.get(day.date);
          const items = meta?.items || [];
          const visible = items.slice(0, 2);
          const extra = items.length - visible.length;
          return `
            <button type="button" class="tl-calendar-month-day ${day.isOutside ? "is-outside" : ""} ${isSelected ? "is-selected" : ""} ${isToday ? "is-today" : ""}" role="tab" aria-selected="${isSelected ? "true" : "false"}" data-action="training-load-calendar-select-day" data-date="${escapeAttr(day.date)}" aria-label="${escapeAttr(formatWeekday(day.date))} ${day.dayNumber}${items.length ? `, ${items.length} activit${items.length === 1 ? "y" : "ies"}` : ""}">
              <span class="tl-calendar-month-day-number">${day.dayNumber}</span>
              <span class="tl-calendar-month-day-badges">
                ${visible.map((item) => `<span class="tl-calendar-month-badge tl-calendar-month-badge-${item.kind}">${escapeHtml(itemShortLabel(item))}</span>`).join("")}
                ${extra > 0 ? `<span class="tl-calendar-month-badge-more">+${extra}</span>` : ""}
              </span>
              ${items.length && !visible.length ? `<span class="tl-calendar-month-day-dot" aria-hidden="true"></span>` : ""}
            </button>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

// ------------------------------------------------------------
// Context bar (item 6) — "9 Sep 2026 › Morning Training › Whole session".
// Always canonical ids, never a name, for the underlying selection state —
// the breadcrumb TEXT is the only place a name is shown.
// ------------------------------------------------------------

function renderContextBarHtml(nav, selectedActivity) {
  const parts = [`<span class="tl-context-part">${escapeHtml(formatDate(nav.selectedDate))}</span>`];
  if (selectedActivity) {
    parts.push(`<span class="tl-context-sep">&rsaquo;</span>`);
    parts.push(`<span class="tl-context-part">${escapeHtml(selectedActivity.name || "Activity")}</span>`);
    const component = nav.selectedComponentId ? findComponentById(state.trainingLoad.calendar.activityDetail.data, nav.selectedComponentId) : null;
    parts.push(`<span class="tl-context-sep">&rsaquo;</span>`);
    parts.push(`<span class="tl-context-part">${component ? escapeHtml(component.name) : "Whole session"}</span>`);
  }
  return `
    <div class="tl-context-bar">
      <div class="tl-context-breadcrumb">${parts.join("")}</div>
      ${nav.selectedActivityId ? `<button type="button" class="plain-button compact-button" data-action="training-load-calendar-clear-activity">All activities that day</button>` : ""}
    </div>
  `;
}

function findComponentById(detail, componentId) {
  if (!detail) return null;
  return (detail.components || []).find((c) => c.id === componentId) || null;
}

// ------------------------------------------------------------
// Agenda (item 5) — cards for the selected day, sorted by time. Only
// facts we actually know; "No data yet" only for a TRACKED session with
// nothing yet — never a fabricated "GPS missing" without an explicit
// expectation configured.
// ------------------------------------------------------------

function renderAgendaCardHtml(item) {
  const time = itemTime(item);
  if (item.kind === "activity") {
    const badges = [];
    if (item.rpe) badges.push(`<span class="tl-agenda-badge">RPE ${item.rpe.rated}/${item.rpe.requested}</span>`);
    if (item.metrics) badges.push(`<span class="tl-agenda-badge">Metrics ${item.metrics.withData}/${item.metrics.total}</span>`);
    if (item.conflictCount > 0) badges.push(`<span class="tl-agenda-badge tl-agenda-badge-warn">${item.conflictCount} conflict${item.conflictCount === 1 ? "" : "s"}</span>`);
    if (item.openSuggestionCount > 0) badges.push(`<span class="tl-agenda-badge tl-agenda-badge-warn">${item.openSuggestionCount} to review</span>`);
    if (!badges.length) badges.push(`<span class="tl-agenda-badge tl-agenda-badge-muted">No data yet</span>`);
    return `
      <button type="button" class="tl-agenda-card" data-action="training-load-calendar-select-activity" data-activity-id="${escapeAttr(item.activityId)}">
        <span class="tl-agenda-time">${escapeHtml(time)}</span>
        <span class="tl-agenda-main">
          <span class="tl-agenda-name">${escapeHtml(item.name || "Activity")}${item.lifecycleState === "provisional" ? ` <span class="tl-agenda-provisional-tag">Needs review</span>` : ""}</span>
          <span class="tl-agenda-subtitle">${item.participantCount} athlete${item.participantCount === 1 ? "" : "s"}${item.activityTypeKey ? ` &middot; ${escapeHtml(item.activityTypeKey.replace(/_/g, " "))}` : ""}</span>
        </span>
        <span class="tl-agenda-badges">${badges.join("")}</span>
      </button>
    `;
  }
  if (item.kind === "planned") {
    return `
      <div class="tl-agenda-card tl-agenda-card-static">
        <span class="tl-agenda-time">${escapeHtml(time)}</span>
        <span class="tl-agenda-main">
          <span class="tl-agenda-name">${escapeHtml(item.athleteName)}</span>
          <span class="tl-agenda-subtitle">${escapeHtml(item.sessionName || "Training session")}${item.rpeEnabled ? " &middot; RPE requested" : ""}</span>
        </span>
        <span class="tl-agenda-badges"><span class="tl-agenda-badge tl-agenda-badge-muted">No data yet</span></span>
      </div>
    `;
  }
  return `
    <div class="tl-agenda-card tl-agenda-card-static">
      <span class="tl-agenda-time">${escapeHtml(time)}</span>
      <span class="tl-agenda-main">
        <span class="tl-agenda-name">${escapeHtml(item.athleteName)}</span>
        <span class="tl-agenda-subtitle">${escapeHtml(item.eventName || "Outside plan")}${item.scheduleStatus !== "active" ? ` &middot; ${escapeHtml(item.scheduleStatus)}` : ""}</span>
      </span>
      <span class="tl-agenda-badges"><span class="tl-agenda-badge tl-agenda-badge-muted">No data yet</span></span>
    </div>
  `;
}

// ------------------------------------------------------------
// Day summary (item 9) — no activity selected. Lists each activity's OWN
// separate summary; never sums metrics across activities/sources that
// aren't safe to sum (no ad-hoc daily aggregate in this phase — see this
// function's own header in the backend route).
// ------------------------------------------------------------

function renderDaySummaryHtml(nav) {
  const bucket = nav.data ? nav.data.days.find((d) => d.date === nav.selectedDate) : null;
  const items = bucket ? bucket.items : [];
  if (!items.length) return `<p class="muted training-load-empty">No training activity this day.</p>`;
  return `
    <div class="tl-agenda-list">
      ${items.map((item) => `<div key="${escapeAttr(itemKey(item))}">${renderAgendaCardHtml(item)}</div>`).join("")}
    </div>
  `;
}

// ------------------------------------------------------------
// Activity Detail (item 7) — Overview / Athletes / Components / Sources.
// Derived entirely from the canonical read contract
// (GET /api/training-activity/:activityId) — never re-derived by name.
// ------------------------------------------------------------

function activityFactsByKind(detail) {
  const byKind = { rpe: [], metric_value: [], component_performance: [], metric_event_link: [], component_metric_segment_link: [] };
  for (const f of detail.facts) (byKind[f.factKind] || (byKind[f.factKind] = [])).push(f);
  return byKind;
}

function renderOverviewTabHtml(nav, activitySummary, detail) {
  const facts = activityFactsByKind(detail);
  const athleteIds = new Set();
  for (const f of facts.rpe) if (f.athleteId) athleteIds.add(f.athleteId);
  for (const f of facts.metric_value) if (f.athleteId) athleteIds.add(f.athleteId);
  for (const f of facts.component_performance) if (f.athleteId) athleteIds.add(f.athleteId);
  const originLabel = activitySummary.origin === "planned_session" ? "Planned session"
    : activitySummary.origin === "external_assignment" ? "External / outside plan"
    : activitySummary.origin === "manual" ? "Manual entry"
    : "Source import";
  const stateLabel = activitySummary.lifecycleState === "confirmed" ? "Confirmed"
    : activitySummary.lifecycleState === "provisional" ? "Needs review" : activitySummary.lifecycleState;
  return `
    <div class="tl-activity-overview">
      <div class="tl-overview-grid">
        <div class="tl-overview-tile"><span class="tl-overview-label">Type</span><span class="tl-overview-value">${escapeHtml((activitySummary.activityTypeKey || "-").replace(/_/g, " "))}</span></div>
        <div class="tl-overview-tile"><span class="tl-overview-label">Date &amp; time</span><span class="tl-overview-value">${escapeHtml(formatDate(activitySummary.occurredLocalDate))}${activitySummary.startedAt ? ` &middot; ${escapeHtml(new Date(activitySummary.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}` : ""}</span></div>
        <div class="tl-overview-tile"><span class="tl-overview-label">Athletes</span><span class="tl-overview-value">${activitySummary.participantCount}</span></div>
        <div class="tl-overview-tile"><span class="tl-overview-label">Origin</span><span class="tl-overview-value">${escapeHtml(originLabel)}</span></div>
        <div class="tl-overview-tile"><span class="tl-overview-label">Status</span><span class="tl-overview-value tl-status-${activitySummary.lifecycleState}">${escapeHtml(stateLabel)}</span></div>
        <div class="tl-overview-tile"><span class="tl-overview-label">RPE coverage</span><span class="tl-overview-value">${activitySummary.rpe ? `${activitySummary.rpe.rated}/${activitySummary.rpe.requested}` : "Not requested"}</span></div>
        <div class="tl-overview-tile"><span class="tl-overview-label">Metric coverage</span><span class="tl-overview-value">${activitySummary.metrics ? `${activitySummary.metrics.withData}/${activitySummary.metrics.total}` : "No metrics linked"}</span></div>
      </div>
      ${activitySummary.openSuggestionCount > 0 ? `<p class="tl-overview-suggestion-note">${activitySummary.openSuggestionCount} candidate match${activitySummary.openSuggestionCount === 1 ? "" : "es"} still need${activitySummary.openSuggestionCount === 1 ? "s" : ""} review.</p>` : ""}
    </div>
  `;
}

function renderAthletesTabHtml(detail, athleteNamesById) {
  const ids = new Set();
  for (const f of detail.facts) if (f.athleteId) ids.add(f.athleteId);
  if (!ids.size) return `<p class="muted training-load-empty">No athletes linked yet.</p>`;
  return `
    <div class="tl-athletes-list">
      ${[...ids].map((id) => `
        <button type="button" class="tl-athlete-row" data-action="training-load-calendar-select-athlete" data-athlete-id="${escapeAttr(id)}">
          <span>${escapeHtml(athleteNamesById.get(id) || "Athlete")}</span>
          <span class="muted">View details</span>
        </button>
      `).join("")}
    </div>
  `;
}

function buildComponentTree(detail) {
  // The activity's own component hierarchy (name/order/duration) comes
  // straight from `detail.components` (training.activity_components,
  // fetched regardless of performance/link facts — see the backend
  // comment in trainingActivityResults.js). Performance/segment-link facts
  // only annotate an existing component; they never invent one.
  const linkedIds = new Set(detail.facts.filter((f) => f.factKind === "component_metric_segment_link").map((f) => f.detail.componentId));
  return (detail.components || []).map((c) => ({ ...c, linked: linkedIds.has(c.id) }));
}

function renderComponentsTabHtml(nav, detail) {
  const components = buildComponentTree(detail);
  return `
    <div class="tl-components-list">
      <button type="button" class="tl-component-row ${!nav.selectedComponentId ? "is-selected" : ""}" data-action="training-load-calendar-select-component" data-component-id="">
        <span>Whole session</span>
      </button>
      ${components.map((c) => {
        const durationSeconds = c.actualDurationSeconds ?? c.plannedDurationSeconds;
        const durationLabel = durationSeconds ? `${Math.round(durationSeconds / 60)} min` : null;
        return `
        <button type="button" class="tl-component-row ${nav.selectedComponentId === c.id ? "is-selected" : ""}" data-action="training-load-calendar-select-component" data-component-id="${escapeAttr(c.id)}">
          <span>${escapeHtml(c.name || "Component")}</span>
          <span class="muted">${[c.componentTypeKey ? escapeHtml(c.componentTypeKey.replace(/_/g, " ")) : "", durationLabel].filter(Boolean).join(" &middot; ")}</span>
        </button>
      `;
      }).join("")}
      ${!components.length ? `<p class="muted training-load-empty">No components recorded for this activity.</p>` : ""}
    </div>
  `;
}

function renderSourcesTabHtml(detail) {
  const values = detail.facts.filter((f) => f.factKind === "metric_value");
  const rpeFacts = detail.facts.filter((f) => f.factKind === "rpe");
  if (!values.length && !rpeFacts.length) return `<p class="muted training-load-empty">No source data recorded yet.</p>`;
  return `
    <div class="tl-sources-list">
      ${rpeFacts.map((f) => `
        <div class="tl-source-row">
          <span class="tl-source-kind tl-source-kind-rpe">RPE</span>
          <span class="tl-source-detail">${escapeHtml(f.detail.source || "planned")}</span>
        </div>
      `).join("")}
      ${values.map((f) => `
        <div class="tl-source-row">
          <span class="tl-source-kind tl-source-kind-${escapeAttr(f.detail.entryMethod || "manual")}">${escapeHtml((f.detail.entryMethod || "manual").replace(/_/g, " "))}</span>
          <span class="tl-source-detail">${f.detail.isDerived ? "Derived" : f.detail.sourceIdentityId ? "Imported" : "Direct"}${f.detail.aggregationRole && f.detail.aggregationRole !== "standalone" ? ` &middot; ${escapeHtml(f.detail.aggregationRole.replace(/_/g, " "))}` : ""}</span>
        </div>
      `).join("")}
    </div>
  `;
}

const ACTIVITY_DETAIL_TABS = [
  { id: "overview", label: "Overview" },
  { id: "athletes", label: "Athletes" },
  { id: "components", label: "Components" },
  { id: "sources", label: "Sources" },
];

function renderActivityDetailTabsHtml(nav) {
  return `
    <div class="tl-activity-detail-tabs" role="tablist">
      ${ACTIVITY_DETAIL_TABS.map((t) => `
        <button type="button" class="tl-activity-detail-tab ${nav.activityDetailTab === t.id ? "is-active" : ""}" role="tab" aria-selected="${nav.activityDetailTab === t.id ? "true" : "false"}" data-action="training-load-calendar-select-detail-tab" data-tl-calendar-detail-tab="${t.id}">${t.label}</button>
      `).join("")}
    </div>
  `;
}

// ------------------------------------------------------------
// Results table (item 8) — desktop/tablet: rows = athletes, columns =
// RPE/sRPE/duration + picked metrics; sticky athlete column; conflict
// never silently collapsed to one value.
// ------------------------------------------------------------

function collectResultsRows(detail, nav) {
  const facts = detail.facts.filter((f) => {
    if (nav.selectedComponentId) {
      if (f.factKind === "metric_value") return f.detail.segmentId && findSegmentComponent(detail, f.detail.segmentId) === nav.selectedComponentId;
      return false; // RPE/component-performance facts are session-level or a different shape — component view shows metrics only
    }
    return f.factKind === "rpe" || f.factKind === "metric_value";
  });

  const byAthlete = new Map();
  for (const f of facts) {
    const id = f.athleteId;
    if (!id) continue;
    if (!byAthlete.has(id)) byAthlete.set(id, { athleteId: id, rpe: null, srpe: null, duration: null, metrics: new Map() });
    const row = byAthlete.get(id);
    if (f.factKind === "rpe") {
      row.rpe = f.detail.rpe;
      row.srpe = f.detail.srpe;
      row.duration = f.detail.durationMinutes;
    } else if (f.factKind === "metric_value") {
      const key = f.detail.metricDefinitionId;
      if (!row.metrics.has(key)) row.metrics.set(key, []);
      row.metrics.get(key).push(f.detail);
    }
  }
  return byAthlete;
}
function findSegmentComponent(detail, segmentId) {
  const link = detail.facts.find((f) => f.factKind === "component_metric_segment_link" && f.detail.metricEventSegmentId === segmentId);
  return link ? link.detail.componentId : null;
}

function metricColumnsFromRows(rows, definitions) {
  const ids = new Set();
  for (const row of rows.values()) for (const id of row.metrics.keys()) ids.add(id);
  const known = definitions ? new Map(definitions.map((d) => [d.id, d])) : new Map();
  return [...ids].map((id) => known.get(id) || { id, label: "Metric", unit: "" });
}

function pickedMetricColumns(nav, rows, definitions) {
  const all = metricColumnsFromRows(rows, definitions);
  if (nav.metricPicker.selectedIds === null) {
    // Smart default (item 8): every available activity metric when there
    // are only a few; otherwise the picker starts empty and the coach
    // narrows explicitly — never a hardcoded provider-specific name.
    return all.length <= 4 ? all : [];
  }
  const selected = new Set(nav.metricPicker.selectedIds);
  return all.filter((c) => selected.has(c.id));
}

function formatMetricCell(values) {
  if (!values || !values.length) return `<span class="tl-cell-empty" aria-label="No data">&ndash;</span>`;
  const shown = values[0];
  const value = shown.valueNumeric ?? (shown.valueBoolean != null ? (shown.valueBoolean ? "Yes" : "No") : shown.valueText);
  if (value === null || value === undefined) return `<span class="tl-cell-empty" aria-label="No data">&ndash;</span>`;
  const conflict = values.length > 1;
  const formatted = typeof value === "number" ? (Number.isInteger(value) ? String(value) : value.toFixed(1)) : String(value);
  if (!conflict) return `<span class="tl-cell-value">${escapeHtml(formatted)}${shown.unitAtCapture ? ` <span class="tl-cell-unit">${escapeHtml(shown.unitAtCapture)}</span>` : ""}</span>`;
  return `
    <button type="button" class="tl-cell-conflict" data-action="training-load-calendar-view-conflict" data-values='${escapeAttr(JSON.stringify(values))}'>
      <span class="tl-conflict-dot" aria-hidden="true"></span>${values.length} values
    </button>
  `;
}

function sortRows(rowsArray, sort, athleteNamesById) {
  const dir = sort.direction === "desc" ? -1 : 1;
  return [...rowsArray].sort((a, b) => {
    if (sort.column === "athlete") return dir * (athleteNamesById.get(a.athleteId) || "").localeCompare(athleteNamesById.get(b.athleteId) || "");
    if (sort.column === "rpe") return dir * ((a.rpe ?? -1) - (b.rpe ?? -1));
    if (sort.column === "srpe") return dir * ((a.srpe ?? -1) - (b.srpe ?? -1));
    if (sort.column === "duration") return dir * ((a.duration ?? -1) - (b.duration ?? -1));
    const av = a.metrics.get(sort.column)?.[0]?.valueNumeric ?? -Infinity;
    const bv = b.metrics.get(sort.column)?.[0]?.valueNumeric ?? -Infinity;
    return dir * (av - bv);
  });
}

function sortIndicator(nav, column) {
  if (nav.resultsSort.column !== column) return "";
  return nav.resultsSort.direction === "asc" ? " &uarr;" : " &darr;";
}

function renderResultsTableHtml(nav, detail, athleteNamesById) {
  const rowsMap = collectResultsRows(detail, nav);
  if (!rowsMap.size) return `<p class="muted training-load-empty">No results recorded yet for this ${nav.selectedComponentId ? "component" : "activity"}.</p>`;
  const columns = pickedMetricColumns(nav, rowsMap, nav.metricPicker.definitions);
  const rows = sortRows([...rowsMap.values()], nav.resultsSort, athleteNamesById);
  const showRpe = !nav.selectedComponentId; // session-level RPE never falsely attributed to a component
  return `
    <div class="tl-results-table-wrap">
      <table class="tl-results-table">
        <thead>
          <tr>
            <th class="tl-sticky-col" scope="col"><button type="button" class="tl-sort-button" data-action="training-load-calendar-sort" data-column="athlete">Athlete${sortIndicator(nav, "athlete")}</button></th>
            ${showRpe ? `<th scope="col"><button type="button" class="tl-sort-button" data-action="training-load-calendar-sort" data-column="rpe">RPE${sortIndicator(nav, "rpe")}</button></th>` : ""}
            ${showRpe ? `<th scope="col"><button type="button" class="tl-sort-button" data-action="training-load-calendar-sort" data-column="srpe">sRPE${sortIndicator(nav, "srpe")}</button></th>` : ""}
            ${showRpe ? `<th scope="col"><button type="button" class="tl-sort-button" data-action="training-load-calendar-sort" data-column="duration">Duration${sortIndicator(nav, "duration")}</button></th>` : ""}
            ${columns.map((c) => `<th scope="col"><button type="button" class="tl-sort-button" data-action="training-load-calendar-sort" data-column="${escapeAttr(c.id)}">${c.iconUrl ? `<img src="${escapeAttr(c.iconUrl)}" alt="" class="tl-metric-icon" />` : ""}${escapeHtml(c.shortLabel || c.label)}${c.unit ? ` <span class="tl-col-unit">(${escapeHtml(c.unit)})</span>` : ""}${sortIndicator(nav, c.id)}</button></th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <th class="tl-sticky-col" scope="row">${escapeHtml(athleteNamesById.get(row.athleteId) || "Athlete")}</th>
              ${showRpe ? `<td>${row.rpe != null ? row.rpe : `<span class="tl-cell-empty" aria-label="No data">&ndash;</span>`}</td>` : ""}
              ${showRpe ? `<td>${row.srpe != null ? escapeHtml(formatSrpe(row.srpe)) : `<span class="tl-cell-empty" aria-label="No data">&ndash;</span>`}</td>` : ""}
              ${showRpe ? `<td>${row.duration != null ? `${row.duration} min` : `<span class="tl-cell-empty" aria-label="No data">&ndash;</span>`}</td>` : ""}
              ${columns.map((c) => `<td>${formatMetricCell(row.metrics.get(c.id))}</td>`).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ------------------------------------------------------------
// Metric picker (item 8).
// ------------------------------------------------------------

function groupDefinitions(definitions, search) {
  const q = search.trim().toLowerCase();
  const filtered = q ? definitions.filter((d) => (d.label || "").toLowerCase().includes(q) || (d.shortLabel || "").toLowerCase().includes(q)) : definitions;
  const groups = new Map();
  for (const d of filtered) {
    const key = d.domainLabel || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  return groups;
}

function renderMetricPickerHtml(nav) {
  const picker = nav.metricPicker;
  if (!picker.open) return "";
  const definitions = picker.definitions || [];
  const groups = groupDefinitions(definitions, picker.search);
  const selected = new Set(picker.selectedIds || []);
  return `
    <div class="builder-athlete-overlay tl-metric-picker-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="training-load-calendar-metric-picker-close" aria-label="Close metric picker"></button>
      <section class="panel builder-athlete-picker tl-metric-picker" role="dialog" aria-modal="true" aria-label="Choose metrics">
        <div class="tl-metric-picker-header">
          <input type="text" class="tl-metric-picker-search" placeholder="Search metrics&hellip;" value="${escapeAttr(picker.search)}" data-tl-calendar-metric-search aria-label="Search metrics">
          <button type="button" class="plain-button icon-button builder-athlete-picker-continue" data-action="training-load-calendar-metric-picker-close" aria-label="Done" title="Done">&#10003;</button>
        </div>
        <div class="tl-metric-picker-body">
          ${picker.loading ? `<p class="muted">Loading metrics&hellip;</p>` : ""}
          ${!picker.loading && !definitions.length ? `<p class="muted">No metrics available.</p>` : ""}
          ${[...groups.entries()].map(([group, defs]) => `
            <div class="tl-metric-picker-group">
              <h4 class="tl-metric-picker-group-label">${escapeHtml(group)}</h4>
              ${defs.map((d) => `
                <label class="tl-metric-picker-option">
                  <input type="checkbox" data-action="training-load-calendar-metric-toggle" data-metric-id="${escapeAttr(d.id)}" ${selected.has(d.id) ? "checked" : ""}>
                  ${d.iconUrl ? `<img src="${escapeAttr(d.iconUrl)}" alt="" class="tl-metric-icon" />` : `<span class="tl-metric-icon-fallback" aria-hidden="true">&#9679;</span>`}
                  <span class="tl-metric-picker-option-label">${escapeHtml(d.label)}</span>
                  ${d.unit ? `<span class="tl-metric-picker-option-unit">${escapeHtml(d.unit)}</span>` : ""}
                </label>
              `).join("")}
            </div>
          `).join("")}
        </div>
      </section>
    </div>
  `;
}

// ------------------------------------------------------------
// Conflict detail (a lightweight inline panel, opened from a conflict
// cell — never auto-picks a winner).
// ------------------------------------------------------------

function renderConflictPanelHtml() {
  const values = state.trainingLoad.calendar.conflictValues;
  if (!values) return "";
  return `
    <div class="builder-athlete-overlay tl-conflict-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="training-load-calendar-conflict-close" aria-label="Close"></button>
      <section class="panel tl-conflict-panel" role="dialog" aria-modal="true" aria-label="Conflicting values">
        <h4>Conflicting values</h4>
        <p class="muted">More than one source reported this metric. Nothing is chosen automatically.</p>
        ${values.map((v) => `
          <div class="tl-conflict-row">
            <span class="tl-source-kind tl-source-kind-${escapeAttr(v.entryMethod || "manual")}">${escapeHtml((v.entryMethod || "manual").replace(/_/g, " "))}</span>
            <span class="tl-cell-value">${escapeHtml(String(v.valueNumeric ?? v.valueText ?? (v.valueBoolean ? "Yes" : "No")))}${v.unitAtCapture ? ` ${escapeHtml(v.unitAtCapture)}` : ""}</span>
          </div>
        `).join("")}
        <button type="button" class="plain-button compact-button" data-action="training-load-calendar-conflict-close">Close</button>
      </section>
    </div>
  `;
}

// ------------------------------------------------------------
// Athlete drawer (item 6, "izabran sportista") — opened from Athletes tab;
// never loses the current date/activity/component context (it's an
// overlay on top of it, not a navigation away). Reads facts already
// present in the loaded activity detail — no second fetch.
// ------------------------------------------------------------

function renderAthleteDrawerHtml(nav, detail, athleteNamesById) {
  const athleteId = nav.selectedResultsAthleteId;
  if (!athleteId || !detail) return "";
  const facts = detail.facts.filter((f) => f.athleteId === athleteId);
  const rpe = facts.find((f) => f.factKind === "rpe");
  const metrics = facts.filter((f) => f.factKind === "metric_value");
  return `
    <div class="builder-athlete-overlay tl-athlete-drawer-overlay">
      <button class="builder-athlete-backdrop" type="button" data-action="training-load-calendar-close-athlete" aria-label="Close"></button>
      <section class="panel builder-athlete-picker tl-athlete-drawer" role="dialog" aria-modal="true" aria-label="Athlete details">
        <div class="builder-section-panel-head">
          <strong>${escapeHtml(athleteNamesById.get(athleteId) || "Athlete")}</strong>
          <button class="plain-button icon-button builder-athlete-picker-cancel" type="button" data-action="training-load-calendar-close-athlete" aria-label="Close" title="Close">&times;</button>
        </div>
        ${rpe ? `<p>RPE ${rpe.detail.rpe} &middot; sRPE ${escapeHtml(formatSrpe(rpe.detail.srpe))} &middot; ${rpe.detail.durationMinutes} min</p>` : `<p class="muted">No RPE recorded.</p>`}
        ${metrics.length ? `
          <ul class="tl-athlete-drawer-metrics">
            ${metrics.map((m) => `<li>${escapeHtml(String(m.detail.valueNumeric ?? m.detail.valueText ?? ""))}${m.detail.unitAtCapture ? ` ${escapeHtml(m.detail.unitAtCapture)}` : ""}</li>`).join("")}
          </ul>
        ` : `<p class="muted">No metric values recorded.</p>`}
      </section>
    </div>
  `;
}

// ------------------------------------------------------------
// Top-level entry point.
// ------------------------------------------------------------

export function renderTrainingLoadCalendarHtml() {
  const nav = state.trainingLoad.calendar;
  if (nav.loading && !nav.data) return `<p class="muted training-load-empty">Loading calendar&hellip;</p>`;
  if (nav.error) return `<p class="builder-error">${escapeHtml(nav.error)}</p>`;
  if (!nav.data) return "";

  const bucket = nav.data.days.find((d) => d.date === nav.selectedDate);
  const selectedActivityItem = nav.selectedActivityId
    ? (bucket?.items.find((i) => i.kind === "activity" && i.activityId === nav.selectedActivityId) || (nav.activityDetail.data ? { activityId: nav.selectedActivityId, name: null } : null))
    : null;
  const detail = nav.selectedActivityId && nav.activityDetail.activityId === nav.selectedActivityId ? nav.activityDetail.data : null;
  const athleteNamesById = buildAthleteNameMap(nav, bucket);

  return `
    <div class="tl-calendar">
      ${renderCalendarNavHeaderHtml(nav)}
      ${nav.monthMode ? renderCalendarMonthGridHtml(nav) : renderCalendarStripHtml(nav)}
      ${nav.monthMode && nav.monthLoading ? `<p class="muted training-load-stale-banner" role="status">Loading month&hellip;</p>` : ""}
      ${renderContextBarHtml(nav, selectedActivityItem)}
      <div class="tl-calendar-body">
        ${!nav.selectedActivityId ? renderDaySummaryHtml(nav) : renderActivitySectionHtml(nav, detail, athleteNamesById)}
      </div>
      ${renderMetricPickerHtml(nav)}
      ${renderConflictPanelHtml()}
      ${renderAthleteDrawerHtml(nav, detail, athleteNamesById)}
    </div>
  `;
}

// Athlete display names come from the canonical read contract's own
// additive athleteNamesById (GET /api/training-activity/:activityId — see
// trainingActivityResults.js's own header for why this is a real, backend-
// resolved name, never guessed/derived client-side) for anyone WITH a fact
// on the open activity; the calendar's own already-loaded agenda item
// covers a not-yet-opened activity's participants (e.g. the "planned, no
// data yet" case, which has no activity detail to read from at all).
function buildAthleteNameMap(nav, bucket) {
  const map = new Map();
  for (const item of bucket?.items || []) {
    if (item.athleteId && item.athleteName) map.set(item.athleteId, item.athleteName);
  }
  const detail = nav.activityDetail.data;
  if (detail?.athleteNamesById) {
    for (const [id, name] of Object.entries(detail.athleteNamesById)) map.set(id, name);
  }
  return map;
}

function renderActivitySectionHtml(nav, detail, athleteNamesById) {
  if (nav.activityDetail.loading && !detail) return `<p class="muted training-load-empty">Loading activity&hellip;</p>`;
  if (nav.activityDetail.error) return `<p class="builder-error">${escapeHtml(nav.activityDetail.error)}</p>`;
  if (!detail) return "";
  const activitySummary = findActivitySummary(nav) || { origin: "manual", lifecycleState: "confirmed", participantCount: 0, activityTypeKey: "", occurredLocalDate: nav.selectedDate, startedAt: null, rpe: null, metrics: null, openSuggestionCount: 0 };
  return `
    <div class="tl-activity-detail">
      ${renderActivityDetailTabsHtml(nav)}
      <div class="tl-activity-detail-panel">
        ${nav.activityDetailTab === "overview" ? renderOverviewTabHtml(nav, activitySummary, detail) : ""}
        ${nav.activityDetailTab === "athletes" ? renderAthletesTabHtml(detail, athleteNamesById) : ""}
        ${nav.activityDetailTab === "components" ? renderComponentsTabHtml(nav, detail) : ""}
        ${nav.activityDetailTab === "sources" ? renderSourcesTabHtml(detail) : ""}
      </div>
      <div class="tl-results-section">
        <div class="tl-results-header">
          <h4>${nav.selectedComponentId ? "Component results" : "Session results"}</h4>
          <button type="button" class="plain-button compact-button" data-action="training-load-calendar-metric-picker-open">Choose metrics</button>
        </div>
        ${renderResultsTableHtml(nav, detail, athleteNamesById)}
      </div>
    </div>
  `;
}

function findActivitySummary(nav) {
  const bucket = nav.data?.days.find((d) => d.date === nav.selectedDate);
  return bucket?.items.find((i) => i.kind === "activity" && i.activityId === nav.selectedActivityId) || null;
}
