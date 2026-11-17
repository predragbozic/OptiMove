// "My training" (owner, 2026-11-16): her own recorded sessions and values, read-only, in plain words. The list of her
// sessions; one session with the whole session's values first, then each drill. Only values that were really measured
// (owner, 2026-11-16): an estimate is never shown to her - the server leaves them out, and this screen does too.
import { state } from "./state.js";
import { escapeAttr, escapeHtml, formatDate, formatWeekday } from "./utils.js";

// How her values were recorded, one plain sentence (never the source's name).
const RECORDED_BY = Object.freeze({ device: "Recorded by a device", coach: "Entered by your coach" });
const ATTENDANCE = Object.freeze({
  participated_no_device_data: "You took part; no device data was recorded for you.",
  did_not_participate: "Your coach marked that you did not take part.",
});
// A unit that only says "a number" is not shown after the number.
const SILENT_UNITS = new Set(["count", "number", "n", "#"]);

const dayText = (date) => (date ? `${formatWeekday(date)} ${formatDate(date)}` : "");
const sessionName = (name) => (String(name || "").trim() || "Training session");

export function renderMyTrainingHtml() {
  const mt = state.myTraining;
  return `<section class="content-section my-training">${mt.openId ? renderSessionHtml(mt.detail) : renderListHtml(mt.list)}</section>`;
}

function renderListHtml(list) {
  const heading = `<h3 class="my-training-title" tabindex="-1">My training</h3>`;
  // The server says she has no recorded session (one was deleted while she is here): the empty sentence, never an
  // older list, and she is not sent away.
  const none = state.myTraining.available === false;
  if (!none && !list.loaded && list.error) return errorHtml(list.error, "my-training-retry");
  if (!none && !list.loaded) return `<div class="empty">Loading your sessions...</div>`;
  if (none || !list.rows.length) return `${heading}<div class="panel my-training-empty"><p>No recorded sessions in the last 12 months.</p><p class="muted">Sessions appear here after a device or your coach records them.</p></div>`;
  return `
    ${heading}
    <p class="my-training-intro muted">Your last 12 months, newest first.</p>
    <ul class="panel my-training-list">
      ${list.rows.map(renderListRowHtml).join("")}
    </ul>
    ${list.error ? `<p class="builder-error">${escapeHtml(list.error)}</p>` : ""}
    ${list.nextCursor ? `<button type="button" class="plain-button my-training-more" data-action="my-training-more" ${list.loading ? "disabled" : ""}>${list.loading ? "Loading..." : "Show older sessions"}</button>` : ""}
  `;
}

function renderListRowHtml(row) {
  const recorded = RECORDED_BY[row.recordedBy] || "No values recorded";
  return `
    <li>
      <button type="button" class="my-training-row" data-action="my-training-open" data-activity-id="${escapeAttr(row.activityId)}">
        <span class="my-training-row-date">${escapeHtml(dayText(row.localDate))}</span>
        <span class="my-training-row-main">
          <span class="my-training-row-name">${escapeHtml(sessionName(row.name))}</span>
          <span class="my-training-row-sub muted">${escapeHtml(recorded)}</span>
        </span>
        <span class="my-training-row-go" aria-hidden="true">&rsaquo;</span>
      </button>
    </li>
  `;
}

function renderSessionHtml(detail) {
  const back = `<button type="button" class="plain-button my-training-back" data-action="my-training-back">&lsaquo; My training</button>`;
  if (detail.loading) return `${back}<div class="empty">Loading the session...</div>`;
  if (detail.error) return `${back}${errorHtml(detail.error, "my-training-open", detail.activityId)}`;
  const data = detail.data || {};
  const row = state.myTraining.list.rows.find((r) => String(r.activityId) === String(detail.activityId)) || {};
  const facts = Array.isArray(data.facts) ? data.facts : [];
  const names = data.variableNamesById || {};
  const values = facts.filter((f) => f.factKind === "metric_value" && !isEstimate(f));
  const rpe = facts.find((f) => f.factKind === "rpe")?.detail;
  const whole = values.filter((f) => f.detail?.level !== "drill");
  const drills = drillGroups(values.filter((f) => f.detail?.level === "drill"), data.components || []);
  const attendance = ATTENDANCE[data.myAttendance] || "";
  return `
    ${back}
    <header class="my-training-head">
      <h3>${escapeHtml(sessionName(row.name))}</h3>
      ${row.localDate ? `<p class="muted">${escapeHtml(dayText(row.localDate))}${RECORDED_BY[data.recordedBy] ? ` · ${escapeHtml(RECORDED_BY[data.recordedBy])}` : ""}</p>` : ""}
    </header>
    ${attendance ? `<p class="panel my-training-note">${escapeHtml(attendance)}</p>` : ""}
    ${rpe ? `<p class="panel my-training-note">How hard it felt: ${escapeHtml(String(rpe.rpe ?? ""))} of 10 (RPE)${rpe.durationMinutes ? ` · ${escapeHtml(String(rpe.durationMinutes))} min` : ""}</p>` : ""}
    ${whole.length ? valuesSectionHtml("Whole session", whole, names) : ""}
    ${drills.map((d) => drillSectionHtml(d, names)).join("")}
    ${!values.length && !rpe && !attendance ? `<p class="panel my-training-note">No values were recorded for you in this session.</p>` : ""}
  `;
}

// A session's drills, in their order, each its own group (two drills without a component are two groups).
export function drillGroups(facts, components) {
  const byKey = new Map();
  for (const fact of facts) {
    const key = fact.detail?.drillKey || `ordinal-${fact.detail?.drillOrdinal ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, { key, ordinal: Number(fact.detail?.drillOrdinal) || Number.MAX_SAFE_INTEGER, componentId: fact.detail?.componentId || null, facts: [] });
    byKey.get(key).facts.push(fact);
  }
  const nameOf = new Map((components || []).map((c) => [String(c.id), String(c.name || "").trim()]));
  return [...byKey.values()]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((group) => ({ ...group, title: (group.componentId && nameOf.get(String(group.componentId))) || (group.ordinal !== Number.MAX_SAFE_INTEGER ? `Drill ${group.ordinal}` : "Drill") }));
}

function valuesSectionHtml(title, facts, names) {
  const rows = [...facts].sort((a, b) => labelOf(a, names).localeCompare(labelOf(b, names)) || String(a.detail?.valueKey).localeCompare(String(b.detail?.valueKey)));
  return `
    <section class="panel my-training-values">
      <h4>${escapeHtml(title)}</h4>
      <dl>
        ${rows.map((fact) => valueRowHtml(fact, names)).join("")}
      </dl>
    </section>
  `;
}

// A drill folds under its name (UX review): the whole session reads first, and a drill opens on a tap.
function drillSectionHtml(drill, names) {
  const rows = [...drill.facts].sort((a, b) => labelOf(a, names).localeCompare(labelOf(b, names)) || String(a.detail?.valueKey).localeCompare(String(b.detail?.valueKey)));
  return `
    <details class="panel my-training-values my-training-drill">
      <summary><span class="my-training-drill-title">${escapeHtml(drill.title)}</span><span class="muted">${rows.length} ${rows.length === 1 ? "value" : "values"}</span></summary>
      <dl>
        ${rows.map((fact) => valueRowHtml(fact, names)).join("")}
      </dl>
    </details>
  `;
}

function labelOf(fact, names) {
  return String(names[fact.detail?.metricDefinitionId]?.label || "Value");
}

export function formatMyValue(detail, unit) {
  if (detail.valueNumeric !== null && detail.valueNumeric !== undefined && detail.valueNumeric !== "") {
    const n = Number(detail.valueNumeric);
    const text = Number.isFinite(n) ? new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 }).format(n) : String(detail.valueNumeric);
    const u = String(unit || "").trim();
    return u && !SILENT_UNITS.has(u.toLowerCase()) ? `${text} ${u}` : text;
  }
  if (typeof detail.valueBoolean === "boolean") return detail.valueBoolean ? "Yes" : "No";
  if (detail.valueText !== null && detail.valueText !== undefined) return String(detail.valueText);
  return "—";
}

// An estimated value (owner, 2026-11-16: "the athlete sees only data that was really measured"). The server stops
// sending them to her; until then, and whatever it sends, this screen never shows one.
export function isEstimate(fact) {
  return Boolean(fact?.estimate) || fact?.detail?.entryMethod === "estimate";
}

function valueRowHtml(fact, names) {
  const d = fact.detail || {};
  const name = names[d.metricDefinitionId] || {};
  const text = typeof d.valueText === "string" && d.valueNumeric == null;
  return `
    <div class="my-training-value${text ? " is-text" : ""}" data-value-key="${escapeAttr(d.valueKey || "")}">
      <dt>${escapeHtml(labelOf(fact, names))}</dt>
      <dd>${escapeHtml(formatMyValue(d, d.unitAtCapture || name.unit))}</dd>
    </div>
  `;
}

function errorHtml(message, action, activityId = "") {
  return `
    <div class="panel my-training-error">
      <p class="builder-error">${escapeHtml(message)}</p>
      <button type="button" class="plain-button" data-action="${escapeAttr(action)}"${activityId ? ` data-activity-id="${escapeAttr(activityId)}"` : ""}>Try again</button>
    </div>
  `;
}

// Athlete Home (plan item 1): one labelled way into her training, shown only once the server said she has a recorded
// session; the last session she has, when it is known, is named under it.
export function renderMyTrainingHomeEntryHtml() {
  const mt = state.myTraining;
  if (mt.available !== true) return "";
  const last = mt.list.rows[0];
  return `
    <button type="button" class="panel my-training-home" data-action="athlete-home-quick-tab" data-target-tab="my-training">
      <span class="my-training-home-body">
        <span class="my-training-home-title">My training</span>
        <span class="muted">${last ? `Last: ${escapeHtml(sessionName(last.name))} · ${escapeHtml(dayText(last.localDate))}` : "Your recorded sessions and values"}</span>
      </span>
      <span class="my-training-home-go" aria-hidden="true">&rsaquo;</span>
    </button>
  `;
}
