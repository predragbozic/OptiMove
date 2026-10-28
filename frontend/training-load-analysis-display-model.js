import { normalizeDashboardDisplayConfig } from "./training-load-analysis-display-config.js";

const GROUP_BY = new Set(["day", "week", "session", "component", "athlete", "cohort"]);
const SOURCE_FIELDS = ["source", "sourceId", "sourceConnectionId", "source_connection_id", "sourceIdentityId", "source_identity_id", "sourceSystem", "source_system", "entryMethod", "entry_method", "sourceMetricId", "sourceMetricDefinitionId", "sourceMetricMappingVersionId", "sourceProvenance", "provenance"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const copy = value => value === undefined ? null : structuredClone(value);

function validDisplayValue(value) {
  if (Array.isArray(value)) return value.every(validDisplayValue);
  return value === null || (typeof value === "number" ? Number.isFinite(value) : ["string", "boolean"].includes(typeof value));
}

function identityKey(value) {
  if (Array.isArray(value)) return `[${value.map(identityKey).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${identityKey(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sourceIdentity(row) {
  return Object.fromEntries(SOURCE_FIELDS.filter(key => Object.hasOwn(row, key)).map(key => [key, copy(row[key])]));
}

function normalizeRow(original, index, series, groupBy) {
  const raw = copy(original);
  const row = object(original) ? original : {};
  const reasons = [];
  let status = "value";
  if (!object(original) || !Object.hasOwn(row, "value")) reasons.push("invalidResult");
  for (const key of ["athleteId", "bucketKey", "unit"]) {
    if (row[key] !== undefined && row[key] !== null && typeof row[key] !== "string") reasons.push("invalidResult");
  }
  for (const flag of ["conflict", "unitConflict", "typeConflict", "semanticConflict"]) {
    if (row[flag] === true) reasons.push(flag);
    else if (row[flag] !== undefined && typeof row[flag] !== "boolean") reasons.push("invalidResult");
  }
  if (row.error !== undefined && row.error !== null) reasons.push("rowError");
  const rawValue = copy(row.value);
  const valueType = Array.isArray(row.value) ? "array" : typeof row.value;
  if (reasons.includes("invalidResult") || reasons.includes("rowError")) status = "error";
  else if (reasons.length) status = "conflict";
  else if (row.value === null) status = "missing";
  else if (!validDisplayValue(row.value)) {
    status = "error";
    reasons.push("invalidValue");
  }
  const source = {
    policy: copy(series.source_policy),
    configuredConnectionId: copy(series.source_connection_id),
    reported: sourceIdentity(row),
  };
  const identity = {
    seriesId: series.id,
    metricDefinitionId: copy(series.metric_definition_id),
    builtInSeriesKey: copy(series.built_in_series_key),
    athleteId: row.athleteId ?? null,
    bucketKey: row.bucketKey ?? null,
    unit: row.unit ?? null,
    groupBy,
    source,
  };
  return {
    rowIndex: index, identity, status, reasons, valueType: row.value === null ? "null" : valueType,
    value: status === "value" ? rawValue : null, rawValue, rawCount: copy(row.rawCount), raw,
    chartStatus: status === "value" && valueType !== "number" ? "unsupported" : status,
  };
}

function chartGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const { bucketKey, ...identity } = row.identity;
    const key = identityKey(identity);
    if (!groups.has(key)) groups.set(key, { key, identity: copy(identity), rows: [] });
    groups.get(key).rows.push(row);
  }
  for (const group of groups.values()) {
    const counts = new Map();
    for (const row of group.rows) counts.set(row.identity.bucketKey, (counts.get(row.identity.bucketKey) || 0) + 1);
    for (const row of group.rows) {
      if (row.identity.bucketKey === null || counts.get(row.identity.bucketKey) > 1) {
        row.chartStatus = "error";
        row.reasons.push(row.identity.bucketKey === null ? "missingBucket" : "duplicateBucket");
      }
    }
  }
  return [...groups.values()];
}

function buildSeries(definition, results, groupBy, loading, querySkipped) {
  const series = {
    id: definition.id, definition: copy(definition), status: "ready", reasons: [],
    current: [], comparison: [], comparisonRange: null, chartGroups: [], comparisonGroups: [],
  };
  const resolution = definition.resolution_status ?? "resolved";
  if (["unresolved", "ambiguous"].includes(resolution)) {
    series.status = resolution;
    return series;
  }
  if (resolution !== "resolved") {
    series.status = "error";
    series.reasons.push("invalidResult");
    return series;
  }
  if (loading) {
    series.status = "loading";
    return series;
  }
  if (querySkipped) return series;
  if (results.length !== 1 || !object(results[0])) {
    series.status = "error";
    series.reasons.push("invalidResult");
    return series;
  }
  const result = results[0];
  if (result.status === "error") {
    series.status = "error";
    series.reasons.push("seriesQueryFailed");
    return series;
  }
  if (result.status !== "ok" || !object(result.data) || !Array.isArray(result.data.current)) {
    series.status = "error";
    series.reasons.push("invalidResult");
    return series;
  }
  series.current = result.data.current.map((row, index) => normalizeRow(row, index, definition, groupBy));
  series.chartGroups = chartGroups(series.current);
  series.comparisonRange = copy(result.data.comparisonRange);
  if (result.data.comparison !== undefined && result.data.comparison !== null && !Array.isArray(result.data.comparison)) {
    series.reasons.push("invalidComparison");
  } else {
    series.comparison = (result.data.comparison || []).map((row, index) => normalizeRow(row, index, definition, groupBy));
    series.comparisonGroups = chartGroups(series.comparison);
  }
  return series;
}

function dateNumber(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value ? instant : null;
}

function matchingComparison(current, comparison, series, period) {
  const left = current.identity;
  const right = comparison.identity;
  if (current.valueType !== comparison.valueType || left.athleteId !== right.athleteId || left.unit !== right.unit || identityKey(left.source) !== identityKey(right.source)) return false;
  if (!Object.hasOwn(current.raw, "athleteId") || !Object.hasOwn(comparison.raw, "athleteId")) return false;
  if (left.bucketKey === null || right.bucketKey === null) return false;
  if (!["day", "week"].includes(left.groupBy)) return left.bucketKey === right.bucketKey;
  const currentDate = dateNumber(left.bucketKey);
  const comparisonDate = dateNumber(right.bucketKey);
  const currentFrom = dateNumber(period?.dateFrom);
  const currentTo = dateNumber(period?.dateTo);
  const comparisonFrom = dateNumber(series.comparisonRange?.dateFrom);
  const comparisonTo = dateNumber(series.comparisonRange?.dateTo);
  if ([currentDate, comparisonDate, currentFrom, currentTo, comparisonFrom, comparisonTo].includes(null)) return false;
  return currentDate >= currentFrom && currentDate <= currentTo && comparisonDate >= comparisonFrom && comparisonDate <= comparisonTo && currentDate - currentFrom === comparisonDate - comparisonFrom;
}

function kpiModel(series, period) {
  const comparison = { status: "none", row: null, range: copy(series[0]?.comparisonRange) };
  const model = { status: "empty", row: null, groupCount: 0, comparison };
  if (!series.length) return model;
  if (series.length !== 1) return { ...model, status: "error", reasons: ["invalidKpiSeries"] };
  const selected = series[0];
  if (selected.status !== "ready") return { ...model, status: selected.status, reasons: [...selected.reasons] };
  model.groupCount = selected.current.length;
  if (selected.current.length > 1) return { ...model, status: "multipleGroups" };
  if (!selected.current.length) return model;
  const row = selected.current[0];
  model.status = row.status === "value" && row.valueType === "array" ? "unsupported" : row.status;
  model.row = row;
  if (selected.reasons.includes("invalidComparison")) comparison.status = "error";
  else if (selected.comparison.length) {
    comparison.status = "incompatible";
    if (model.status === "value" && selected.comparison.length === 1) {
      const other = selected.comparison[0];
      if (other.status === "value" && matchingComparison(row, other, selected, period)) {
        comparison.status = "value";
        comparison.row = other;
      }
    }
  }
  return model;
}

export function buildDashboardWidgetDisplayModel(widget, queryResult, { loading = false, error = null, period = null, querySkipped = false } = {}) {
  const config = normalizeDashboardDisplayConfig(widget);
  const groupBy = widget?.group_by ?? "day";
  const model = {
    widgetId: copy(widget?.id), widgetType: copy(widget?.widget_type), title: copy(widget?.title ?? ""),
    groupBy: copy(groupBy), period: copy(period), config, status: "ready", reasons: [], series: [], kpi: null,
  };
  if (config.status !== "ready") {
    model.status = config.status === "unsupported" ? "unsupported" : "error";
    model.reasons = config.issues.map(issue => issue.code);
    return model;
  }
  if (!GROUP_BY.has(groupBy) || !Array.isArray(widget?.series) || widget.series.some(definition => !object(definition) || typeof definition.id !== "string" || !definition.id)) {
    model.status = "error";
    model.reasons.push("invalidResult");
    return model;
  }
  const ids = widget.series.map(definition => definition.id);
  if (new Set(ids).size !== ids.length) {
    model.status = "error";
    model.reasons.push("duplicateSeries");
    return model;
  }
  if (error) {
    model.status = "error";
    model.reasons.push("queryFailed");
    return model;
  }
  if (loading) model.status = "loading";
  else if (!querySkipped && widget.series.some(definition => !["unresolved", "ambiguous"].includes(definition.resolution_status)) && (!object(queryResult) || (queryResult.widgetId !== undefined && queryResult.widgetId !== widget.id) || !Array.isArray(queryResult.series) || queryResult.series.some(result => !object(result) || !ids.includes(result.seriesId)))) {
    model.status = "error";
    model.reasons.push("invalidResult");
    return model;
  }
  const resultSeries = Array.isArray(queryResult?.series) ? queryResult.series.filter(object) : [];
  model.series = widget.series.map(definition => buildSeries(definition, resultSeries.filter(result => result.seriesId === definition.id), groupBy, loading, querySkipped));
  if (widget.widget_type === "kpi") model.kpi = kpiModel(model.series, period);
  return model;
}
