import { escapeHtml, escapeAttr } from "./utils.js";
import { buildDashboardWidgetDisplayModel } from './training-load-analysis-display-model.js';
import { renderDashboardChartPlots } from './training-load-analysis-echarts-options.js';

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
const statusLabels = { ok: "Ready", valid: "Ready", invalid: "Needs attention", error: "Could not load", problem: "Needs attention", advancedRequired: "Advanced editor required", no_data: "No data", noData: "No data", partial: "Partial coverage", complete: "Complete coverage", noObservation: "No observation", no_observation: "No observation" };
const lookup = (labels, value) => Object.hasOwn(labels, value) ? labels[value] : text(value);
const friendlyStatus = (value) => lookup(statusLabels, value);
const valueType = (value) => value == null ? "Not specified" : lookup({ numeric: "Numeric", text: "Text", boolean: "Boolean" }, value);

function issueText(issue) {
  if (!issue || typeof issue !== "object") return text(issue);
  const known = {
    conflict: "Conflicting observations were returned. Review the affected rows.", unitConflict: "Returned observations have conflicting units.",
    requiresChoice: "Choose the required setting before previewing again.", notFound: "The selected metric or filter is no longer available.",
    advancedRequired: "These settings require the advanced editor.", unsupportedDisplay: "This display configuration requires the advanced editor.",
    unsupportedComposition: "This grouping cannot be used with the saved chart composition. Open advanced settings.",
    unsupportedCapability: "This setting is currently unavailable.", inactiveWidgetType: "This display type is currently unavailable.",
    periodRequired: "Choose a valid start date, end date and time zone.", invalidCatalogMetadata: "Metric details are incomplete. Reload the metric or open advanced settings.",
    unitMismatch: "The rule unit does not match the metric unit.", referenceUnitMismatch: "The reference unit does not match the metric unit.",
    sourceConnectionRequired: "Choose a source connection in advanced settings.", previewQueryFailed: "Preview data could not be loaded. Try previewing again.",
    incompatiblePresentation: "The saved presentation settings do not match this display. Open advanced settings.",
  };
  const choice = issue.code === "requiresChoice" ? issue.path?.includes("analyticalAggregation") ? "Choose how to combine measurements." : issue.path?.includes("dataScopeLevel") ? "Choose which measurements to use." : null : null;
  return choice ?? (Object.hasOwn(known, issue.code) ? known[issue.code] : issue.message ?? text(issue));
}

function athleteName(id, athletes) {
  if (id == null) return "Whole group";
  return athletes.find((athlete) => String(athlete.id).toLowerCase() === String(id).toLowerCase())?.name || String(id);
}

function inheritedAthletes(model) {
  const athletes = model.athletes ?? [];
  const context = model.context ?? {};
  const hasEffectiveIds = Object.hasOwn(context, "effectiveInheritedAthleteIds");
  const hasRuntimeIds = Object.hasOwn(context.runtimeFilter ?? {}, "athleteIds");
  const ids = hasEffectiveIds ? context.effectiveInheritedAthleteIds : context.runtimeFilter?.athleteIds;
  if (model.rosterLoading) return message("Loading dashboard athletes…");
  if (model.rosterError) return message("Dashboard athletes could not be loaded. The inherited dashboard selection is unchanged.");
  if (Array.isArray(ids)) {
    const names = [...new Set(ids.map((id) => String(id).toLowerCase()))].map((id) => athleteName(id, athletes));
    return message(`Dashboard athletes: ${names.length} ${names.length === 1 ? "athlete" : "athletes"}${names.length ? ` — ${names.join(", ")}` : "."}`);
  }
  const selection = (hasEffectiveIds || hasRuntimeIds) && ids === null ? "Dashboard athletes: all, subject to dashboard access." : "Dashboard athlete selection will be resolved from dashboard defaults.";
  if (!athletes.length && model.rosterLoading !== false) return message(`${selection} Athlete roster has not loaded.`);
  const names = athletes.map((athlete) => athlete.name || athlete.id);
  return message(`${selection} Loaded roster: ${names.length} ${names.length === 1 ? "athlete" : "athletes"}${names.length ? ` — ${names.join(", ")}` : "."}`);
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
        <span class="tl-simple-category">${kind === "builtin" ? "Built-in" : "Metric"}</span>
        <strong>${escapeHtml(metric.label ?? metric.name ?? metric.key ?? id)}</strong>
        <span>${escapeHtml(metric.unit ?? "no unit specified")}</span>
        <span>Value type: ${escapeHtml(valueType(metric.value_type))}</span>
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
  const period = model.periodDraft ?? model.draft?.periodIntent?.periodConfig ?? model.context?.period ?? {};
  const fixed = model.draft?.periodIntent?.mode === "replacePageRuntime";
  return `<fieldset${disabled(locked)}><legend>Athletes</legend>
    ${[["inherit", "Use dashboard athletes"], ["allAuthorized", "All authorized athletes"], ["selected", "Choose athletes"]].map(([value, label]) => `<label class="tl-simple-choice"><input type="radio" name="training-load-simple-athlete-mode" ${action("athlete-mode")} value="${value}"${selection.mode === value ? " checked" : ""}>${label}</label>`).join("")}
    ${selection.mode === "inherit" ? inheritedAthletes(model) : ""}
    ${model.rosterLoading ? message("Loading athletes…") : model.rosterError ? message(`Athletes could not be loaded. ${typeof model.rosterError === "string" ? model.rosterError : "Please try again."}`, "alert") : ""}
    ${selection.mode === "selected" ? `<div class="tl-simple-athletes" aria-busy="${Boolean(model.rosterLoading)}">${athletes.map((athlete) => `<label class="tl-simple-choice"><input type="checkbox" ${action("athlete")} data-id="${escapeAttr(athlete.id)}" value="${escapeAttr(athlete.id)}"${ids.has(athlete.id) ? " checked" : ""}${disabled(model.rosterLoading || model.rosterError)}> ${escapeHtml(athlete.name ?? athlete.id)}</label>`).join("")}${!athletes.length && !model.rosterLoading && !model.rosterError ? message("No authorized athletes available.") : ""}${!model.rosterLoading && !model.rosterError ? [...ids].filter((id) => !athletes.some((athlete) => athlete.id === id)).map((id) => message(`Selected athlete unavailable: ${id}`)).join("") : ""}</div>` : ""}
    </fieldset>
    <fieldset${disabled(locked)}><legend>Period</legend>
    <label class="tl-simple-choice"><input type="radio" name="training-load-simple-period-mode" ${action("period-mode")} value="inherit"${!fixed ? " checked" : ""}>Use dashboard period</label>
    <label class="tl-simple-choice"><input type="radio" name="training-load-simple-period-mode" ${action("period-mode")} value="replacePageRuntime"${fixed ? " checked" : ""}>Choose fixed dates for the whole dashboard after save</label>
    <p id="tl-simple-period-help">Fixed dates change your personal page period for the whole dashboard only after a successful save. Preview does not change the dashboard.</p>
    <div class="tl-simple-dates"><label class="tl-simple-field">From<input type="date" ${action("date-from")} value="${escapeAttr(period.dateFrom ?? model.context?.period?.dateFrom ?? "")}" aria-describedby="tl-simple-period-help"${disabled(!fixed)}></label>
    <label class="tl-simple-field">To<input type="date" ${action("date-to")} value="${escapeAttr(period.dateTo ?? model.context?.period?.dateTo ?? "")}" aria-describedby="tl-simple-period-help"${disabled(!fixed)}></label></div>
    <p>Time zone: ${escapeHtml(period.timeZone ?? model.context?.period?.timeZone ?? "Not specified")}</p>
    </fieldset>`;
}

function selectField(name, label, choices, selected, locked, placeholder = "Choose an option") {
  const available = choices.some(([value]) => value === selected);
  return `<label class="tl-simple-field">${escapeHtml(label)}<select ${action(name)}${disabled(locked)}>${!available ? `<option value="${escapeAttr(selected ?? "")}" selected disabled>${escapeHtml(selected ? `Unavailable choice: ${selected}` : placeholder)}</option>` : ""}${choices.map(([value, title]) => option(value, title, selected)).join("")}</select></label>`;
}

function displayChoices(model, locked) {
  const view = model.draft?.view ?? {};
  const metric = model.selectedMetric ?? {};
  const types = model.capabilities?.widgetTypes ?? [];
  const views = [["table", "Table"], ["line_chart", "Line chart"], ["bar_chart", "Bar chart"], ["kpi", "KPI"]];
  const custom = model.draft?.metricRef?.kind === "metric";
  const scopes = metric.scope_capabilities?.length ? metric.scope_capabilities.map((scope) => typeof scope === "string" ? scope : scope.scope_level) : ["day", "session", "component"];
  return `<label class="tl-simple-field">Title<input type="text" ${action("title")} maxlength="200" value="${escapeAttr(model.draft?.title ?? "")}"${disabled(locked)}></label>
    <fieldset class="tl-simple-view-options"${disabled(locked)}><legend>Display</legend>${views.map(([value, label]) => {
      const supported = types.some((type) => (typeof type === "string" ? type : type.key) === value && type.is_active !== false);
      return `<label class="tl-simple-choice"><input type="radio" name="training-load-simple-view" ${action("view")} value="${value}"${(view.type ?? "table") === value ? " checked" : ""}${disabled(!supported)}>${label}${!supported ? " (unavailable)" : ""}</label>`;
    }).join("")}</fieldset>
    ${selectField("group", "Group results by", [["day", "Day"], ["week", "Week"], ["athlete", "Athlete"], ["session", "Session"], ["component", "Component"], ["cohort", "Whole group"]], view.groupBy ?? "day", locked)}
    ${custom ? selectField("aggregation", "How to combine measurements", (metric.allowed_aggregations ?? []).map((value) => [value, ({ sum: "Total (sum)", avg: "Average", max: "Maximum", last: "Latest value", none: "Raw values (no aggregation)" })[value] ?? value]), view.analyticalAggregation, locked, "Choose how to combine measurements") : ""}
    ${custom && scopes.length > 1 ? selectField("scope", "Use measurements from", scopes.map((value) => [value, ({ day: "Day", session: "Session", component: "Component" })[value] ?? value]), view.dataScopeLevel, locked, "Choose which measurements to use") : ""}
    ${model.canUpgradeChart && ['line_chart','bar_chart'].includes(view.type) ? `<label class="tl-simple-choice"><input type="checkbox" ${action('chart-enhanced')}${model.draft.presentation?.mode==='replace'?' checked':''}${disabled(locked)}>Interaktivni prikaz za ovaj grafikon (novi pregled pre čuvanja)</label>` : ''}
    <p>Pregled prikazuje sve vraćene podatke. Postojeći grafikon se ne menja bez potvrđenog izbora.</p>`;
}

function resultTable(rows, caption, athletes) {
  const records = rows.map((row) => row !== null && typeof row === "object" && !Array.isArray(row) ? row : { value: row });
  const keys = [...new Set(records.flatMap(Object.keys))];
  if (!records.length) return message(`${caption}: no returned rows.`);
  if (!keys.length) keys.push("value");
  function cell(key, value) {
    if (key === "athleteId") return athleteName(value, athletes);
    if (key === "unit" && value == null) return "no unit specified";
    if (["conflict", "unitConflict", "missing"].includes(key) && typeof value === "boolean") return value ? "Yes" : "No";
    if (["status", "coverageStatus", "missingKind", "missing_kind"].includes(key) && typeof value === "string") return friendlyStatus(value);
    return text(value);
  }
  return `<div class="tl-simple-table-scroll" role="region" aria-label="${escapeAttr(caption)}" tabindex="0"><table><caption>${escapeHtml(caption)}</caption><thead><tr>${keys.map((key) => `<th scope="col">${escapeHtml(lookup(fieldLabels, key))}</th>`).join("")}</tr></thead><tbody>${records.map((row) => `<tr>${keys.map((key) => `<td${typeof row[key] === "number" ? ' class="tl-simple-number"' : ""}>${Object.hasOwn(row, key) ? escapeHtml(cell(key, row[key])) : "—"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function previewHtml(model) {
  const preview = model.preview;
  if (!preview) return message(model.previewLoading ? "Loading preview…" : "Preview your choices before saving.");
  const result = preview.widgetResult;
  const widget=preview.normalizedWidget;
  const chart=preview.status==='valid' && widget && ['line_chart','bar_chart'].includes(widget.widget_type)
    ? renderDashboardChartPlots(buildDashboardWidgetDisplayModel(widget,result,{period:preview.resolvedPeriod}),series=>series.display_label || model.selectedMetric?.label || model.draft?.title || 'Metrika',row=>row.identity.athleteId ?? '',{presentation:widget.presentation_config,queryId:preview.queryId,resolvedPeriod:preview.resolvedPeriod,contextId:`preview:${model.draft?.draftId}:${model.draft?.draftVersion}`,allowApplyPeriod:false,athletes:model.athletes}) : '';
  const tables = [];
  function visit(value, path) {
    if (Array.isArray(value)) tables.push(resultTable(value, path, model.athletes ?? []));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => visit(child, `${path} / ${lookup(fieldLabels, key)}`));
  }
  for (const [index, series] of (result?.series ?? []).entries()) {
    const label = series.label ?? series.displayLabel ?? `Series ${index + 1}`;
    tables.push(message(`${label}: ${friendlyStatus(series.status ?? "status not specified")}`));
    visit(series.data, label);
  }
  if (result && !result.series?.length) visit(result, "Result");
  return `${model.previewLoading ? message("Loading preview… Previous results are shown below.") : ""}
    ${message(`Preview status: ${friendlyStatus(preview.status ?? "not specified")}`)}
    ${result?.status ? message(`Result status: ${friendlyStatus(result.status)}`) : ""}
    ${preview.resolvedPeriod ? message(`Resolved period: ${preview.resolvedPeriod.dateFrom ?? "not specified"} to ${preview.resolvedPeriod.dateTo ?? "not specified"}${preview.resolvedPeriod.timeZone ? ` (${preview.resolvedPeriod.timeZone})` : ""}`) : ""}
    ${(preview.issues ?? []).map((issue) => message(issueText(issue), "alert")).join("")}
    ${(preview.warnings ?? []).map((warning) => message(issueText(warning))).join("")}
    ${chart}${tables.join("")}
    ${!result ? message("No preview results returned.") : ""}
    <details class="tl-simple-raw"><summary>Complete preview result and problem details</summary><pre>${escapeHtml(JSON.stringify(preview, null, 2))}</pre></details>`;
}

function saveFeedback(model) {
  return `${model.saveState === "unknown" ? `${message("Save outcome unknown. Your draft is retained and editing is locked. Retry sends the same request; check status to find out whether it was recorded.", "alert")}${button("retry", "Retry same request")}${button("status", "Check status")}` : ""}
    ${model.saveState === "saving" ? message("Saving… Your draft is retained while saving.") : ""}
    ${model.saveState === "recorded" ? message("Save recorded.") : ""}
    ${model.saveError ? message(model.saveError, "alert") : ""}`;
}

export function renderSimpleEditorHtml(model = {}) {
  if (!model?.open) return "";
  const step = [1, 2, 3].includes(model.step) ? model.step : 1;
  const locked = ["unknown", "saving", "recorded"].includes(model.saveState);
  const supported = model.capabilities?.capabilities ?? {};
  const advanced = Boolean(model.advancedRequired || model.preview?.status === "advancedRequired");
  return `<div class="tl-simple-panel"><section class="tl-simple-editor" role="region" aria-labelledby="tl-simple-heading" aria-describedby="tl-simple-step tl-simple-context-help" tabindex="-1">
    <header><h2 id="tl-simple-heading">${model.widgetId ? "Edit widget" : "Add widget"}</h2>${button("close", "Close editor", ["saving", "unknown"].includes(model.saveState))}</header>
    <p id="tl-simple-step">Step ${step} of 3: ${["Metric", "Athletes and period", "Display"][step - 1]}</p>
    <p id="tl-simple-context-help" class="tl-simple-context-help">Podešavanja su nacrt. Dashboard ostaje vidljiv; sačuvaj ili zatvori podešavanja pre promene njegovih filtera i kartica.</p>
    <ol class="tl-simple-steps" aria-label="Editor steps">${["Metric", "Athletes and period", "Display"].map((label, index) => `<li${index + 1 === step ? ' aria-current="step"' : ""}>${label}</li>`).join("")}</ol>
    ${saveFeedback(model)}
    ${model.error ? message(model.error, "alert") : ""}
    ${advanced ? message("These settings require the advanced editor. Opening advanced will ask before discarding these unsaved changes.") : ""}
    <div class="tl-simple-content"><fieldset class="tl-simple-editable"${disabled(locked)}><legend class="tl-simple-sr-only">Step ${step} settings</legend>${step === 1 ? metricCards(model, locked) : step === 2 ? athletesAndPeriod(model, locked) : displayChoices(model, locked)}</fieldset>
    ${step === 3 ? `<section class="tl-simple-preview" aria-label="Result preview" aria-busy="${Boolean(model.previewLoading)}"><h3>Pregled rezultata</h3>${button("preview", "Preview", locked || model.previewLoading || !supported.preview || advanced)}${!supported.preview ? message("Live preview is temporarily unavailable.") : ""}${previewHtml(model)}</section>` : ""}</div>
    <footer><details class="tl-simple-advanced"><summary>Napredne opcije</summary>${button("advanced", "Open advanced editor", locked, 'aria-describedby="tl-simple-advanced-help"')}<p id="tl-simple-advanced-help">Opening advanced will ask before discarding these unsaved changes.</p></details>
    <div class="tl-simple-navigation">${step > 1 ? button("back", "Back", locked) : ""}${step < 3 ? button("next", "Next", locked || (step === 1 && !model.draft?.metricRef) || advanced) : button("save", "Save", locked || !model.canSave || !supported.atomicSave || advanced || model.previewLoading)}${step === 3 && !supported.atomicSave ? message("Saving is temporarily unavailable.") : ""}</div></footer>
  </section></div>`;
}
