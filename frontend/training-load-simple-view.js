import { renderDashboardMetricTable } from "./training-load-dashboard-table.js";
import { buildDashboardWidgetDisplayModel } from "./training-load-analysis-display-model.js";
import { escapeHtml, escapeAttr } from "./utils.js";

const action = (name) => `data-action="training-load-simple-${name}"`;
const disabled = (value) => value ? " disabled" : "";
const text = (value) => value === null ? "null" : typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
const button = (name, label, locked = false, attrs = "") => `<button type="button" ${action(name)}${disabled(locked)} ${attrs}>${escapeHtml(label)}</button>`;
const option = (value, label, selected) => `<option value="${escapeAttr(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
const message = (value, role = "status") => value == null || value === "" ? "" : `<p role="${role}" class="tl-simple-message">${escapeHtml(text(value))}</p>`;
const fieldLabels = {
  athleteId: "Athlete", athleteName: "Athlete name", bucketKey: "Period / group", bucketStart: "Period start", bucketEnd: "Period end",
  value: "Value", unit: "Unit", conflict: "Conflicting observations", unitConflict: "Conflicting units", missing: "Missing data",
  missingKind: "Missing data reason", missing_kind: "Missing data reason", coverage: "Data coverage", coverageStatus: "Coverage status",
  status: "Status", date: "Date", dateFrom: "From", dateTo: "To", timeZone: "Time zone", count: "Observation count",
  sampleCount: "Sample count", activityId: "Activity", componentId: "Component", sessionId: "Session", note: "Note",
  current: "Current period", comparison: "Comparison period",
};
const statusLabels = { ok: "Ready", valid: "Ready", invalid: "Needs attention", error: "Could not load", problem: "Needs attention", advancedRequired: "Advanced editor required", no_data: "No data", noData: "No data", partial: "Partly recorded", complete: "Complete coverage", noObservation: "No data", no_observation: "No data" };
const lookup = (labels, value) => Object.hasOwn(labels, value) ? labels[value] : text(value);
const friendlyStatus = (value) => statusLabels[value] ?? "Needs attention";

function issueText(issue) {
  if (!issue || typeof issue !== "object") return "Review your settings and preview again.";
  const known = {
    conflict: "Some measurements disagree. Try a different selection.", unitConflict: "Returned observations have conflicting units.",
    requiresChoice: "Choose the required setting before previewing again.", notFound: "The selected metric or filter is no longer available.",
    advancedRequired: "These settings require the advanced editor.", unsupportedDisplay: "This display configuration requires the advanced editor.",
    unsupportedComposition: "This grouping cannot be used with the chart settings. Open advanced settings.",
    unsupportedCapability: "This setting is currently unavailable.", inactiveWidgetType: "This display type is currently unavailable.",
    periodRequired: "Choose a valid start date, end date and time zone.", invalidCatalogMetadata: "Metric details are incomplete. Reload the metric or open advanced settings.",
    unitMismatch: "The rule unit does not match the metric unit.", referenceUnitMismatch: "The reference unit does not match the metric unit.",
    sourceConnectionRequired: "Choose a data source in Advanced settings.", previewQueryFailed: "Preview data could not be loaded. Try previewing again.",
    incompatiblePresentation: "The widget settings do not match this display. Open advanced settings.",
  };
  if (issue.reason === "maxChartAthletes") return "Choose up to 20 athletes for this chart.";
  if (issue.code === "widgetSizeBounds") return "This display needs a different widget size. Use the current display or add a new widget.";
  const choice = ["requiresChoice", "required"].includes(issue.code) ? issue.path?.includes("analyticalAggregation") ? "Choose how to combine measurements." : issue.path?.includes("dataScopeLevel") ? "Choose which measurements to use." : null : null;
  return choice ?? (Object.hasOwn(known, issue.code) ? known[issue.code] : "Review your settings and preview again.");
}

function athleteName(id, athletes) {
  if (id == null) return "Whole group";
  return athletes.find((athlete) => String(athlete.id).toLowerCase() === String(id).toLowerCase())?.name || "Athlete name unavailable";
}

function inheritedAthletes(model) {
  const athletes = model.athletes ?? [];
  const context = model.context ?? {};
  const hasEffectiveIds = Object.hasOwn(context, "effectiveInheritedAthleteIds");
  const hasRuntimeIds = Object.hasOwn(context.runtimeFilter ?? {}, "athleteIds");
  const ids = hasEffectiveIds ? context.effectiveInheritedAthleteIds : context.runtimeFilter?.athleteIds;
  if (model.rosterLoading) return message("Loading dashboard athletes…");
  if (model.rosterError) return message("Dashboard athletes could not be loaded.");
  if (Array.isArray(ids)) {
    const names = [...new Set(ids.map((id) => String(id).toLowerCase()))].map((id) => athleteName(id, athletes));
    return names.length > 1 ? `<details><summary>${names.length} athletes</summary>${message(names.join(", "))}</details>` : message(`Dashboard athletes: ${names.length} ${names.length === 1 ? "athlete" : "athletes"}${names.length ? ` — ${names[0]}` : "."}`);
  }
  const selection = (hasEffectiveIds || hasRuntimeIds) && ids === null ? "All my athletes." : "Uses the dashboard’s athlete selection.";
  if (!athletes.length && model.rosterLoading !== false) return message(`${selection} Athletes could not be loaded.`);
  const names = athletes.map((athlete) => athlete.name || "Athlete name unavailable");
  if (!names.length) return message(`${selection} 0 athletes.`);
  return `<details><summary>${names.length} ${names.length === 1 ? "athlete" : "athletes"}</summary>${message(names.join(", "))}</details>`;
}

function metricCards(model, locked) {
  const ref = model.draft?.metricRef;
  const entries = [
    ...(model.capabilities?.builtins ?? []).map((metric) => ({ metric, kind: "builtin", id: metric.key })),
    ...(model.metrics ?? []).map((metric) => ({ metric, kind: "metric", id: metric.id })),
  ];
  return `<label class="tl-simple-field">Search metrics<input type="search" ${action("search")} value="${escapeAttr(model.search ?? "")}"${disabled(locked)}></label>
    ${model.error ? button("reload", "Reload metrics", locked || model.loading) : ""}
    ${model.loading ? message(entries.length ? "Loading more metrics…" : "Loading metrics…") : ""}
    ${!entries.length && !model.loading && !model.error ? message(model.search ? "No metrics match your search." : "No metrics available.") : ""}
    <div class="tl-simple-metrics" aria-label="Available metrics">${entries.map(({ metric, kind, id }) => {
      const selected = ref?.kind === kind && (kind === "builtin" ? ref.key : ref.metricDefinitionId) === id;
      return `<button type="button" class="tl-simple-metric" ${action("metric")} data-kind="${kind}" data-id="${escapeAttr(id)}" aria-pressed="${selected}"${disabled(locked)}>
        <strong>${escapeHtml(metric.label ?? metric.name ?? metric.key ?? id)}</strong>
        <span>${escapeHtml(metric.unit ?? "no unit specified")}</span>
        ${metric.description ? `<span>${escapeHtml(metric.description)}</span>` : ""}
      </button>`;
    }).join("")}</div>
    ${!ref ? message("Choose a metric to continue.") : ""}
    ${model.nextCursor != null ? `<div class="tl-simple-pagination">${message("More metrics are available.")}${button("more", "Load more metrics", locked || model.loading)}</div>` : ""}`;
}

function athletesAndPeriod(model, locked) {
  const selection = model.draft?.athleteSelection ?? { mode: "inherit" };
  const ids = new Set(selection.athleteIds ?? []);
  const athletes = model.athletes ?? [];
  return `<fieldset${disabled(locked)}><legend>Athletes</legend>
    ${[["inherit", "Use dashboard athletes"], ["allAuthorized", "All my athletes"], ["selected", "Choose athletes"]].map(([value, label]) => `<label class="tl-simple-choice"><input type="radio" name="training-load-simple-athlete-mode" ${action("athlete-mode")} value="${value}"${selection.mode === value ? " checked" : ""}>${label}</label>`).join("")}
    ${selection.mode === "inherit" ? inheritedAthletes(model) : ""}
    ${selection.mode === "inherit" ? "" : model.rosterLoading ? message("Loading athletes…") : model.rosterError ? message(`Athletes could not be loaded.`, "alert") : ""}
    ${selection.mode === "selected" ? `<div class="tl-simple-athletes" aria-busy="${Boolean(model.rosterLoading)}">${athletes.map((athlete) => `<label class="tl-simple-choice"><input type="checkbox" ${action("athlete")} data-id="${escapeAttr(athlete.id)}" value="${escapeAttr(athlete.id)}"${ids.has(athlete.id) ? " checked" : ""}${disabled(model.rosterLoading || model.rosterError)}> ${escapeHtml(athlete.name ?? "Athlete name unavailable")}</label>`).join("")}${!athletes.length && !model.rosterLoading && !model.rosterError ? message("No athletes to show.") : ""}${!model.rosterLoading && !model.rosterError ? [...ids].filter((id) => !athletes.some((athlete) => athlete.id === id)).map(() => message("Selected athlete unavailable.")).join("") : ""}</div>` : ""}
    </fieldset>
    <p>Uses the dashboard period.</p>`;
}

function selectField(name, label, choices, selected, locked, placeholder = "Choose an option") {
  const available = choices.some(([value]) => value === selected);
  return `<label class="tl-simple-field">${escapeHtml(label)}<select ${action(name)}${disabled(locked)}>${!available ? `<option value="${escapeAttr(selected ?? "")}" selected disabled>${escapeHtml(selected ? "Unavailable choice" : placeholder)}</option>` : ""}${choices.map(([value, title]) => option(value, title, selected)).join("")}</select></label>`;
}

function displayChoices(model, locked) {
  const view = model.draft?.view ?? {};
  const metric = model.selectedMetric ?? {};
  const types = model.capabilities?.widgetTypes ?? [];
  const views = [["table", "Table"], ["line_chart", "Line chart"], ["bar_chart", "Bar chart"], ["kpi", "KPI"]];
  const custom = model.draft?.metricRef?.kind === "metric";
  const scopes = metric.scope_capabilities?.length ? metric.scope_capabilities.map((scope) => typeof scope === "string" ? scope : scope.scope_level) : ["day", "session", "component"];
  return `<label class="tl-simple-field">Title<input type="text" ${action("title")} maxlength="200" value="${escapeAttr(model.draft?.title ?? "")}"${disabled(locked)}></label>
    <fieldset${disabled(locked)}><legend>Display</legend>${views.map(([value, label]) => {
      if (model.widgetId && value !== view.type) return "";
      const supported = types.some((type) => (typeof type === "string" ? type : type.key) === value && type.is_active !== false);
      return `<label class="tl-simple-choice"><input type="radio" name="training-load-simple-view" ${action("view")} value="${value}"${(view.type ?? "table") === value ? " checked" : ""}${disabled(!supported)}>${label}${!supported ? " (unavailable)" : ""}</label>`;
    }).join("")}</fieldset>
    ${model.widgetId ? message("To use a different display type, add a new widget.") : ""}
    ${selectField("group", "Group results by", [["day", "Day"], ["week", "Week"], ["athlete", "Athlete"], ["session", "Session"], ["component", "Component"], ["cohort", "Whole group"]], view.groupBy ?? "day", locked)}
    ${custom ? selectField("aggregation", "How to combine measurements", (metric.allowed_aggregations ?? []).map((value) => [value, ({ sum: "Total (sum)", avg: "Average", max: "Maximum", last: "Latest value", none: "Each measurement" })[value]]).filter(([, label]) => label), view.analyticalAggregation, locked, "Choose how to combine measurements") : ""}
    ${custom && scopes.length > 1 ? selectField("scope", "Use measurements from", scopes.map((value) => [value, ({ day: "Day", session: "Session", component: "Component" })[value]]).filter(([, label]) => label), view.dataScopeLevel, locked, "Choose which measurements to use") : ""}`;
}

function resultTable(rows, caption, athletes, technical) {
  const records = rows.map((row) => row !== null && typeof row === "object" && !Array.isArray(row) ? row : { value: row });
  const internalFields = ["activityId", "componentId", "sessionId", "count", "sampleCount", "conflict", "unitConflict"];
  const keys = [...new Set(records.flatMap(Object.keys))].filter(key => technical || (Object.hasOwn(fieldLabels, key) && !internalFields.includes(key)));
  if (!records.length) return message("No data for this period.");
  if (!keys.length) keys.push("value");
  function cell(key, value) {
    if (!technical && key === "bucketKey" && typeof value === "string" && /^[a-f0-9]{8}-/i.test(value)) return athleteName(value, athletes);
    if (!technical && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value.split("-").reverse().join(".");
    if (!technical && typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) && key !== "athleteId") return "Unavailable";
    if (key === "athleteId") return athleteName(value, athletes);
    if (key === "unit" && value == null) return technical ? "no unit specified" : "";
    if (["conflict", "unitConflict", "missing"].includes(key) && typeof value === "boolean") return value ? "Yes" : "No";
    if (["status", "coverageStatus", "missingKind", "missing_kind"].includes(key) && typeof value === "string") return friendlyStatus(value);
    return !technical && value && typeof value === 'object' ? '—' : text(value);
  }
  return `<div class="tl-simple-table-scroll" role="region" aria-label="${escapeAttr(caption)}" tabindex="0"><table><caption>${escapeHtml(caption)}</caption><thead><tr>${keys.map((key) => `<th scope="col">${escapeHtml(lookup(fieldLabels, key))}</th>`).join("")}</tr></thead><tbody>${records.map((row) => `<tr>${keys.map((key) => `<td${typeof row[key] === "number" ? ' class="tl-simple-number"' : ""}>${Object.hasOwn(row, key) ? escapeHtml(cell(key, row[key])) : "—"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function previewHtml(model, technical) {
  const preview = model.preview ?? model.previousPreview;
  if (!preview) return message(model.previewLoading ? "Loading preview…" : "Preview shows the numbers; the chart appears on the dashboard after saving.");
  const result = preview.widgetResult;
  const tables = [];
  const sharedTable = preview.normalizedWidget?.widget_type === "table" && ["day", "athlete"].includes(preview.normalizedWidget.group_by) && result?.series?.length === 1;
  if (sharedTable) {
    const display = buildDashboardWidgetDisplayModel(preview.normalizedWidget, result, { period: preview.resolvedPeriod });
    tables.push(renderDashboardMetricTable(display, model.athletes, preview.normalizedWidget.series?.[0]?.display_label || model.selectedMetric?.label || model.selectedMetric?.name || "Metric"));
  }
  function visit(value, path) {
    if (Array.isArray(value)) tables.push(resultTable(value, path, model.athletes ?? [], technical));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => visit(child, `${path} / ${(technical ? lookup(fieldLabels, key) : fieldLabels[key] ?? "Results")}`));
  }
  for (const [index, series] of (sharedTable ? [] : result?.series ?? []).entries()) {
    const label = model.selectedMetric?.label ?? model.selectedMetric?.name ?? series.label ?? series.displayLabel ?? (technical ? `Series ${index + 1}` : "Metric");
    tables.push(message(`${label}: ${friendlyStatus(series.status ?? "status not specified")}`));
    visit(series.data, label);
  }
  if (result && !result.series?.length) visit(result, "Result");
  return `${model.previewLoading ? message("Loading preview… Previous results are shown below.") : ""}
    <p class="tl-simple-preview-status" data-ready="${preview.status === "valid"}"><span aria-hidden="true">${preview.status === "valid" ? "✓" : "!"}</span> ${escapeHtml(friendlyStatus(preview.status ?? "not specified"))}${technical ? ` · ${(preview.issues ?? []).length} issues` : ""}</p>
    ${technical && result?.status ? message(`Result status: ${friendlyStatus(result.status)}`) : ""}
    ${preview.resolvedPeriod ? message(`Showing: ${[preview.resolvedPeriod.dateFrom, preview.resolvedPeriod.dateTo].map(date => date?.split("-").reverse().join(".")).join(" – ")}`) : ""}
    ${(technical ? preview.issues ?? [] : (preview.issues ?? []).slice(0, 1)).map((issue) => message(issueText(issue), "alert")).join("")}
    ${(technical ? preview.warnings ?? [] : []).map((warning) => message(issueText(warning))).join("")}
    ${message("Preview shows the numbers; the chart appears on the dashboard after saving.")}
    ${(preview.issues ?? []).some(issue => issue.reason === "maxChartAthletes") ? button("choose-athletes", "Choose athletes") : ""}
    ${tables.join("")}
    ${!result ? message("No preview results returned.") : ""}
    ${technical ? `<details class="tl-simple-raw"><summary>Complete preview result and problem details</summary><pre>${escapeHtml(JSON.stringify(preview, null, 2))}</pre></details>` : ""}`;
}

function saveFeedback(model) {
  return `${model.saveState === "unknown" ? `${message("We could not confirm that your widget was saved.", "alert")}${button("status", "Check again", model.checkingStatus, 'data-primary="true"')}${button("retry", "Try saving again", model.checkingStatus)}` : ""}
    ${model.saveState === "saving" ? message("Saving…") : ""}
    ${model.saveError ? message(model.saveError, "alert") : ""}`;
}

export function renderSimpleEditorHtml(model = {}, technical = false) {
  if (!model?.open) return "";
  const step = [1, 2, 3].includes(model.step) ? model.step : 1;
  const locked = ["unknown", "saving", "recorded"].includes(model.saveState);
  const supported = model.capabilities?.capabilities ?? {};
  const advanced = Boolean(model.advancedRequired || model.preview?.status === "advancedRequired");
  if (model.saveState === "recorded" && model.saveError) {
    return `<div class="tl-simple-backdrop"><section class="tl-simple-editor" role="dialog" aria-modal="true" aria-label="Widget saved" tabindex="-1">${message("Saved. Reload the page to see it.")}${button("close", "Close")}</section></div>`;
  }
  if (((advanced && !model.draft) || model.stale) && !locked) {
    return `<div class="tl-simple-backdrop"><section class="tl-simple-editor" role="dialog" aria-modal="true" aria-label="Widget settings" tabindex="-1">
      ${message(model.stale ? "Someone else changed this widget. Close and open it again to see the latest version." : "This widget uses settings the simple editor can’t show.")}
      ${model.stale ? button("close", "Close") : button("advanced", "Open Advanced settings", false, 'data-primary="true"') + button("close", "Cancel")}
    </section></div>`;
  }
  return `<div class="tl-simple-backdrop"><section class="tl-simple-editor" role="dialog" aria-modal="true" aria-labelledby="tl-simple-heading" aria-describedby="tl-simple-step" tabindex="-1">
    <header><h2 id="tl-simple-heading">${model.widgetId ? "Edit widget" : "Add widget"}</h2>${button("close", "Cancel", model.saveState === "saving" || model.checkingStatus)}</header>
    <p id="tl-simple-step">Step ${step} of 3: ${["Metric", "Athletes and period", "Display"][step - 1]}</p>
    <ol class="tl-simple-steps" aria-label="Editor steps">${["Metric", "Athletes and period", "Display"].map((label, index) => `<li${index + 1 === step ? ' aria-current="step"' : ""}>${label}</li>`).join("")}</ol>
    ${saveFeedback(model)}
    ${model.error ? message(model.error, "alert") : ""}
    ${advanced ? message("This combination needs Advanced settings. Change the display or grouping, or open Advanced settings.") : ""}
    <div class="tl-simple-content"><fieldset class="tl-simple-editable"${disabled(locked)}><legend class="tl-simple-sr-only">Step ${step} settings</legend>${step === 1 ? metricCards(model, locked) : step === 2 ? athletesAndPeriod(model, locked) : displayChoices(model, locked)}</fieldset>
    ${step === 3 ? `<section class="tl-simple-preview" aria-label="Result preview" aria-busy="${Boolean(model.previewLoading)}">${button("preview", "Preview", locked || model.previewLoading || !supported.preview || advanced)}${!supported.preview ? message("Live preview is temporarily unavailable.") : ""}${previewHtml(model, technical)}</section>` : ""}</div>
    <footer>${button("advanced", "Advanced settings", locked)}
    <div class="tl-simple-navigation">${step > 1 ? button("back", "Back", locked) : ""}${step < 3 ? button("next", "Next", locked || (step === 1 && !model.draft?.metricRef) || advanced, 'data-primary="true"') : button("save", "Save", locked || !model.canSave || !supported.atomicSave || advanced || model.previewLoading, 'data-primary="true"')}${step === 3 && !locked && (model.previewLoading || !model.canSave || !supported.atomicSave) ? message(supported.preview && !supported.atomicSave ? "Preview is on. Ask an administrator to enable saving." : !supported.preview ? "Preview is unavailable. Try again later." : model.previewLoading ? "Wait for the preview to finish." : model.preview?.status === "invalid" || model.preview?.status === "requiresChoice" ? "Fix the setting above and preview again." : "Run Preview before saving.") : ""}</div></footer>
  </section></div>`;
}
