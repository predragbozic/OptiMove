import { escapeHtml, formatDate } from "./utils.js";
import { sortAthletes } from "./athlete-list-tools.js";

const uuid = /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i;
const dateKey = /^\d{4}-\d{2}-\d{2}$/;
const conflictLabels = { conflict: "Conflict", unitConflict: "Unit conflict", typeConflict: "Type conflict", semanticConflict: "Semantic conflict" };

// Shared with the dashboard KPI. The table caps configured precision at two places.
export function formatDashboardValue(value, model) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(model.config.effective.numberFormat.maximumFractionDigits);
  return String(value);
}

function tableNumberFormat(model) {
  const maximumFractionDigits = Math.min(2, model.config.effective.numberFormat.maximumFractionDigits);
  return { config: { effective: { numberFormat: { maximumFractionDigits } } } };
}

function metricCellText(row, mixed, format) {
  if (row?.status === "conflict") return row.reasons.map(reason => conflictLabels[reason]).filter(Boolean).join(" / ") || "Conflict";
  if (row?.status === "error") return "Unavailable";
  if (row?.status !== "value") return "—";
  if (mixed) return "Unit conflict";
  if (typeof row.value === "object" || uuid.test(String(row.value))) return "Unavailable";
  return formatDashboardValue(row.value, format);
}

export function renderDashboardPivotTable(model, athletes, describeSeries) {
  if (!["day", "athlete"].includes(model.groupBy) || model.series.length < 2) return null;
  const names = new Map(athletes.map(({ id, name }) => [String(id).toLowerCase(), name]));
  const rows = new Map();
  const columns = [];
  for (const [index, series] of model.series.entries()) {
    if (series.status !== "ready" || series.definition.analytical_aggregation === "none") return null;
    const units = new Set();
    for (const row of series.current) {
      const { athleteId, bucketKey, unit } = row.identity;
      const isDay = model.groupBy === "day";
      const id = athleteId ?? (!isDay && uuid.test(bucketKey ?? "") ? bucketKey : null);
      const date = isDay ? bucketKey : "";
      if ((isDay && !dateKey.test(date ?? "")) || (!isDay && !id)
        || (row.status === "value" && typeof row.value === "object")) return null;
      const normalizedId = id ? String(id).toLowerCase() : "";
      const key = JSON.stringify([normalizedId, date]);
      if (!rows.has(key)) {
        const name = names.get(normalizedId);
        rows.set(key, { id, name: id ? (name && !uuid.test(name) ? name : "Athlete name unavailable") : "", date, cells: [] });
      }
      const entry = rows.get(key);
      if (entry.cells[index]) return null;
      entry.cells[index] = row;
      if (row.status === "value") units.add(unit || null);
    }
    const { label, icon = "", unit = null } = describeSeries(series.definition);
    columns.push({ label: uuid.test(label) ? "Metric" : label, icon, unit: units.size === 1 ? [...units][0] : units.size === 0 ? unit : null, mixed: units.size > 1 });
  }

  if (!rows.size) return '<p class="muted">No data for this period.</p>';
  const sorted = sortAthletes([...rows.values()].sort((a, b) => a.date.localeCompare(b.date)));
  const showAthlete = sorted.some(row => row.id);
  const showDate = model.groupBy === "day";
  const format = tableNumberFormat(model);
  return `<div class="tl-analysis-table-wrap" role="region" aria-label="Metric values" tabindex="0">
    ${columns.some(column => column.mixed) ? '<p role="status">Values use different or unknown units. Choose one unit to compare them.</p>' : ''}
    <table class="tl-analysis-table tl-analysis-pivot-table"><caption>Current period values</caption>
      <thead><tr>${showAthlete ? '<th scope="col" class="tl-editor-athlete-cell">Athlete</th>' : ''}${showDate ? '<th scope="col">Date</th>' : ''}${columns.map(({ label, icon, unit }) => `<th scope="col" class="tl-dashboard-value-cell">${icon}${escapeHtml(label)}${unit && !uuid.test(unit) ? ` (${escapeHtml(unit)})` : ''}</th>`).join("")}</tr></thead>
      <tbody>${sorted.map(({ name, date, cells }) => `<tr>${showAthlete ? `<td class="tl-editor-athlete-cell">${escapeHtml(name || "—")}</td>` : ''}${showDate ? `<td>${escapeHtml(formatDate(date))}</td>` : ''}${columns.map((column, index) => `<td class="tl-dashboard-value-cell">${escapeHtml(metricCellText(cells[index], column.mixed, format))}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>
  </div>`;
}

export function renderDashboardMetricTable(model, athletes = [], label = "Metric") {
  const series = model.series[0];
  if (!series || series.status !== "ready" || !series.current.length) return '<p class="muted">No data for this period.</p>';
  const names = new Map(athletes.map(({ id, name }) => [String(id).toLowerCase(), name]));
  const rowsByBucket = new Map();
  for (const row of series.current) {
    const { athleteId, bucketKey } = row.identity;
    const id = athleteId ?? (uuid.test(bucketKey ?? "") && model.groupBy === "athlete" ? bucketKey : null);
    const name = names.get(String(id).toLowerCase());
    const date = dateKey.test(bucketKey ?? "") ? bucketKey : "";
    const key = JSON.stringify([id, date, ...(series.definition.analytical_aggregation === "none" ? [row.rowIndex] : [])]);
    const existing = rowsByBucket.get(key);
    if (existing) {
      const reason = existing.row.identity.unit !== row.identity.unit ? "unitConflict" : "conflict";
      existing.row = { ...existing.row, status: "conflict", reasons: [...new Set([...existing.row.reasons, ...row.reasons, reason])] };
    } else {
      rowsByBucket.set(key, { row, id, name: id ? (name && !uuid.test(name) ? name : "Athlete name unavailable") : "", date });
    }
  }
  const rows = [...rowsByBucket.values()];
  // Preorder dates because the roster sort is stable for the same athlete.
  const sorted = sortAthletes(rows.sort((a, b) => a.date.localeCompare(b.date)));
  const showAthlete = sorted.some(({ id }) => id);
  const showDate = sorted.some(({ date }) => date);
  const units = new Set(series.current.filter(row => row.status === "value").map(row => row.identity.unit || null));
  const unit = units.size === 1 ? [...units][0] : null;
  const mixed = units.size > 1;
  const format = tableNumberFormat(model);
  const safeLabel = uuid.test(label) ? "Metric" : label;
  return `<div class="tl-analysis-table-wrap" role="region" aria-label="Metric values" tabindex="0">
    ${mixed ? '<p role="status">Values use different or unknown units. Choose one unit to compare them.</p>' : ''}
    <table class="tl-analysis-table"><caption>Current period values</caption>
      <thead><tr>${showAthlete ? '<th scope="col">Athlete</th>' : ''}${showDate ? '<th scope="col">Date</th>' : ''}<th scope="col">${escapeHtml(safeLabel)}${unit && !uuid.test(unit) ? ` (${escapeHtml(unit)})` : ''}</th></tr></thead>
      <tbody>${sorted.map(({ row, name, date }) => `<tr>${showAthlete ? `<td>${escapeHtml(name || "—")}</td>` : ''}${showDate ? `<td>${date ? escapeHtml(formatDate(date)) : "—"}</td>` : ''}<td>${escapeHtml(metricCellText(row, mixed, format))}</td></tr>`).join("")}</tbody>
    </table>
  </div>`;
}
