import { applyGalleryChoice, galleryPresentation, galleryVariant, galleryUnavailable, chartGalleryChoices } from './training-load-chart-gallery.js';
import { api } from './api.js';
import { state } from './state.js';
import { currentUserWorkspaceContextParts } from './access.js';
import { analysisRuntimeFilterPayload, loadDashboardDetail, queryAnalysisDashboard, openAnalysisWidgetEditor, setEditorDisplayMode, loadAnalysisMetricDefinitions } from './training-load-analysis-data.js';
import { createSimpleEditorController } from './training-load-simple-controller.js';
import { chartPresentation, interactiveChartPresentation } from './training-load-chart-composer.js';
import { loadTrainingLoadOrgPickerData } from './training-load-data.js';

let render = () => {};
let returnFocus = null, previousModel = null, previousStep = null;
const analysis = () => state.trainingLoad.analysis;
function paint(model) {
  analysis().simpleEditor = model;
  const active = globalThis.document?.activeElement;
  const action = active?.dataset?.action;
  const id = active?.dataset?.id;
  const value = active?.value, choice = ['radio', 'checkbox'].includes(active?.type);
  const start = active?.selectionStart, end = active?.selectionEnd;
  const advancedOpen = model === previousModel && globalThis.document?.querySelector('.tl-simple-advanced')?.open;
  if (model && model !== previousModel) returnFocus = active;
  render();
  if (advancedOpen) {
    const advanced = globalThis.document?.querySelector('.tl-simple-advanced');
    if (advanced) advanced.open = true;
  }
  if (action?.startsWith('training-load-simple-')) {
    const candidates = globalThis.document?.querySelectorAll?.(`[data-action="${action}"]`) ?? [];
    const next = [...candidates].find(item => (!id || item.dataset.id === id) && (!choice || item.value === value));
    next?.focus?.();
    if (typeof start === 'number' && ['text', 'search'].includes(next?.type)) next.setSelectionRange?.(start, end);
  } else if (model && (model !== previousModel || model.step !== previousStep)) {
    globalThis.document?.querySelector?.('.tl-simple-editor')?.focus?.();
  }
  if (!model) {
    const candidates = globalThis.document?.querySelectorAll?.('[data-action]') ?? [];
    const replacement = [...candidates].find(item => returnFocus?.dataset?.action && item.dataset.action === returnFocus.dataset.action && item.dataset.widgetId === returnFocus.dataset.widgetId);
    (returnFocus?.isConnected ? returnFocus : replacement)?.focus?.();
  }
  previousModel = model; previousStep = model?.step;
}
function getContext() {
  const a = analysis(), page = a.pagesMode ? a.page : null;
  const runtimeFilter = analysisRuntimeFilterPayload();
  const defaults = { ...a.dashboard?.default_filter, ...page?.defaultFilter, ...runtimeFilter };
  return { identity: currentUserWorkspaceContextParts(), dashboardId: a.dashboard?.id,
    ...(page ? { pageId: page.id, pageDefaultsRevision: page.defaultsRevision, pageDefaultFilter: page.defaultFilter } : {}),
    period: { ...a.period, timeZone: a.period.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
    runtimeFilter, inheritedAthleteIds: defaults.athleteIds ?? null, effectiveInheritedAthleteIds: defaults.athleteIds ?? null,
    athletes: state.trainingLoad.orgPickerData?.athletes ?? [] };
}
function isActiveTarget(target) {
  const a = analysis(), context = getContext();
  return JSON.stringify(context.identity) === JSON.stringify(target.context.identity)
    && context.dashboardId === target.context.dashboardId
    && a.selectedDashboardId === target.context.dashboardId
    && (context.pageId ?? null) === (target.context.pageId ?? null)
    && (!target.context.pageId || a.selectedPageId === target.context.pageId);
}
export const simpleEditor = createSimpleEditorController({ request: api, paint, getContext,
  saved: async (receipt, target) => {
    if (!isActiveTarget(target)) return;
    const a = analysis();
    const periodKey = period => JSON.stringify([period.dateFrom, period.dateTo, period.timeZone || target.context.period.timeZone]);
    const newerPeriod = periodKey(a.period) !== periodKey(target.context.period);
    if (target.draft.periodIntent.mode === 'replacePageRuntime' && !newerPeriod) {
      a.period = { ...receipt.resolvedPeriod ?? target.preview.resolvedPeriod };
      if (target.context.pageId) a.pageRuntimeUsesDefaults = false;
    }
    await loadDashboardDetail(target.context.dashboardId, render, { force: true });
    if (!isActiveTarget(target)) return;
    await queryAnalysisDashboard(render, { force: true });
    if (!isActiveTarget(target)) return;
    a.notice = newerPeriod ? 'Widget saved. Kept your newer dashboard period.' : 'Widget saved.';
  },
});

export async function openSimpleEditor(widget, onRender) {
  render = onRender;
  analysis().menu = '';
  analysis().picker.open = false;
  await simpleEditor.open(widget);
  if (simpleEditor.model?.unavailable) { simpleEditor.close(); return false; }
  const target = simpleEditor.model;
  if (target) { target.savedGroupBy = widget?.group_by; target.pageStackedAvailable = analysis().pagesMode && analysis().pageCapabilities?.stackedCharts === true; target.pageScatterAvailable = analysis().pagesMode && analysis().pageCapabilities?.scatterCharts === true; target.savedWidgetType = widget?.widget_type; target.pageCombinedAvailable = !analysis().pagesMode || analysis().pageCapabilities?.combinedCharts === true; }
  if (target?.draft && !target.error) {
    target.rosterLoading = true; paint(target);
    try {
      const roster = await loadTrainingLoadOrgPickerData();
      if (simpleEditor.model === target) target.athletes = roster?.athletes ?? [];
    } catch { if (simpleEditor.model === target) target.rosterError = 'Athlete names could not be loaded. Reopen the editor to try again.'; }
    finally { if (simpleEditor.model === target) { target.rosterLoading = false; paint(target); } }
  }
  return true;
}

export function leaveSimpleEditor({ discard = true, confirm = message => window.confirm(message) } = {}) {
  const model = simpleEditor.model;
  if (!model) return true;
  if (simpleEditor.pending) return false;
  if (model.saveState !== 'recorded' && model.draft && !confirm('Discard your unsaved Simple editor changes?')) return false;
  return !discard || simpleEditor.close();
}

export async function handleSimpleEditorAction(action, onRender) {
  render = onRender;
  const type = action.dataset.action?.replace('training-load-simple-', '');
  const model = simpleEditor.model;
  if (!model) return true;
  if (type === 'close') { leaveSimpleEditor(); return true; }
  if (type === 'retry') { await simpleEditor.save(true); return true; }
  if (type === 'status') { await simpleEditor.status(); return true; }
  if (simpleEditor.pending || model.saveState === 'recorded') return true;
  const displayMode = action.value || action.dataset.value;
  const pairedChoice = type === 'view' && ['combined', 'scatter', 'stacked'].includes(displayMode);
  if (pairedChoice) {
    const widget = analysis().widgets.find(row => row.id === model.widgetId);
    const choice = chartGalleryChoices.find(row => row.id === displayMode);
    const available = displayMode === 'stacked' ? model.capabilities?.capabilities?.stackedCharts === true && analysis().pagesMode && analysis().pageCapabilities?.stackedCharts === true : displayMode === 'scatter' ? model.capabilities?.capabilities?.scatterCharts === true && analysis().pagesMode && analysis().pageCapabilities?.scatterCharts === true : model.capabilities?.capabilities?.combinedCharts === true && (!analysis().pagesMode || analysis().pageCapabilities?.combinedCharts === true);
    if (!widget || model.stale || !isActiveTarget(model) || !available || galleryUnavailable(model, choice) || !['line_chart', 'bar_chart'].includes(widget.widget_type) || !['day', 'week'].includes(widget.group_by)) return true;
    if (!leaveSimpleEditor()) return true;
    openAnalysisWidgetEditor(widget, { ...(displayMode === 'stacked' ? { stackedAvailable: available } : displayMode === 'scatter' ? { scatterAvailable: available } : { combinedAvailable: available }) });
    const editor = analysis().editor;
    // Catalog metadata is needed before accepting two numeric series.
    await loadAnalysisMetricDefinitions();
    if (analysis().editor !== editor || !isActiveTarget(model)) return true;
    editor.error = setEditorDisplayMode(editor.draft, displayMode, available);
    render(); return true;
  }
  if (galleryVariant(model) === 'stacked' && chartPresentation(galleryPresentation(model)).mode === 'enhanced' && type !== 'advanced') { model.error = 'Open Advanced settings to edit Stacked components and confirm their declaration.'; render(); return true; }
  if (type === 'advanced') {
    const widget = analysis().widgets.find(row => row.id === model.widgetId);
    if (model.widgetId && widget && isActiveTarget(model) && leaveSimpleEditor()) { openAnalysisWidgetEditor(widget, { stackedAvailable: model.capabilities?.capabilities?.stackedCharts === true && analysis().pagesMode && analysis().pageCapabilities?.stackedCharts === true, combinedAvailable: model.capabilities?.capabilities?.combinedCharts === true && (!analysis().pagesMode || analysis().pageCapabilities?.combinedCharts === true) }); render(); void loadAnalysisMetricDefinitions().then(render); }
    else if (!model.widgetId && leaveSimpleEditor()) {
      analysis().simpleAdvancedCreate = true;
      return false;
    }
  } else if (type === 'step') simpleEditor.goToStep(Number(action.dataset.id));
  else if (type === 'preview') { if (!model.stale) await simpleEditor.preview(); }
  else if (type === 'save') { if (!model.stale) await simpleEditor.save(); }
  else if (type === 'metric') simpleEditor.selectMetric(action.dataset.kind, action.dataset.id);
  else if (type === 'search') simpleEditor.search(action.value ?? '');
  else if (type === 'more' || type === 'reload') await simpleEditor.metrics(type === 'more');
  else if (type === 'title') simpleEditor.change(draft => { draft.title = action.value ?? ''; });
  else if (type === 'view') simpleEditor.change(draft => applyGalleryChoice(draft, model, action.value || action.dataset.value));
  else if (type === 'group' && galleryVariant(model) === 'scatter' && chartPresentation(galleryPresentation(model)).mode === 'enhanced') {
    model.error = 'Open the Advanced editor to change Scatter settings.'; paint(model);
  }
  else if (type === 'group' && ['heatmap', 'boxplot'].includes(galleryVariant(model)) && chartPresentation(galleryPresentation(model)).mode === 'enhanced' && !['day', 'week'].includes(action.value)) {
    model.error = `${galleryVariant(model) === 'boxplot' ? 'Box plot' : 'Heatmap'} supports day or week only. Switch the display before changing the grouping.`;
    paint(model);
  }
  else if (type === 'group') simpleEditor.change(draft => {
    if (draft.view.groupBy === action.value) return;
    draft.view.groupBy = action.value;
    const presentation = galleryPresentation(model);
    const knownChart = chartPresentation(presentation).mode === 'enhanced';
    if (draft.presentation?.mode === 'preserve' && knownChart && ['area', 'horizontal-bar', 'heatmap', 'boxplot'].includes(presentation.chartVariant)) {
      draft.presentation = { mode: 'replace', value: structuredClone(presentation) };
    }
    if (draft.presentation?.mode === 'replace' && knownChart) {
      const generated = interactiveChartPresentation(draft.view.groupBy, galleryVariant(model)).value;
      if (generated.chartComposition) draft.presentation.value.chartComposition = generated.chartComposition;
      else delete draft.presentation.value.chartComposition;
      if (draft.presentation.value.chartInteractions) draft.presentation.value.chartInteractions.zoom = generated.chartInteractions.zoom;
    }
  });
  else if (['reference-lower', 'reference-upper', 'reference-from', 'reference-to'].includes(type) &&
      model.capabilities?.capabilities?.chartReferenceSave && ['line_chart', 'bar_chart'].includes(model.draft.view.type)) {
    simpleEditor.change(draft => {
      if (action.validity?.badInput) return;
      const presentation = structuredClone(galleryPresentation(model) ?? interactiveChartPresentation(draft.view.groupBy).value);
      const reference = presentation.chartReference ?? { unit: model.selectedMetric?.unit ?? null };
      const key = { 'reference-lower': 'lower', 'reference-upper': 'upper', 'reference-from': 'validFrom', 'reference-to': 'validTo' }[type];
      const dateField = key === 'validFrom' || key === 'validTo';
      if (dateField && !model.capabilities.capabilities.chartReferenceDates) return;
      if (action.value === '') delete reference[key];
      else reference[key] = dateField ? action.value : Number(action.value);
      if (Number.isFinite(reference.lower)) {
        if (draft.metricRef.kind === 'metric') reference.metricVersionId = model.selectedMetric?.current_version_id;
        presentation.chartReference = reference;
      } else delete presentation.chartReference;
      draft.presentation = { mode: 'replace', value: presentation };
    });
  }
  else if (['manual-threshold', 'threshold-operator'].includes(type) && model.capabilities?.capabilities?.manualThresholdPreview &&
      model.draft.view.type === 'table' && model.draft.metricRef &&
      model.selectedMetric?.value_type === 'numeric' &&
      (!model.savedPresentation?.tableFormatting?.rules?.length || model.savedPresentation.tableFormatting.rules[0].id === 'simple-above')) {
    simpleEditor.change(draft => {
      if (action.validity?.badInput) return;
      if (type === 'manual-threshold' && action.value === '') {
        if (model.widgetId) draft.presentation = { mode: model.savedPresentation?.tableFormatting?.rules?.length ? 'clear' : 'preserve' };
        else delete draft.presentation;
        return;
      }
      const previous = galleryPresentation(model)?.tableFormatting?.rules?.[0];
      if (type === 'threshold-operator' && (!previous || !model.capabilities.capabilities.lowerThresholdSave || !['gt', 'lt'].includes(action.value))) return;
      const value = type === 'threshold-operator' ? previous.threshold.value : Number(action.value);
      if (!Number.isFinite(value)) return;
      const operator = type === 'threshold-operator' ? action.value : previous?.operator ?? 'gt';
      const isLower = operator === 'lt';
      const rule = {
        id: 'simple-above', priority: 1, enabled: true, name: isLower ? 'Lower threshold' : 'Upper threshold',
        target: { series: 'main', phase: 'current', cell: 'value', athletes: { mode: 'allReturned' } },
        operand: 'value', operator, threshold: { value, unit: model.selectedMetric.unit ?? null },
        style: { tone: 'caution', marker: isLower ? 'down' : 'up', label: isLower ? 'Below threshold' : 'Above threshold' }
      };
      draft.presentation = { mode: 'replace', value: { schemaVersion: 1, tableFormatting: {
        evaluationVersion: 1, rules: [rule],
        ...(draft.metricRef.kind === 'metric' && model.selectedMetric.current_version_id
          ? { metricVersionId: model.selectedMetric.current_version_id } : {})
      } } };
    });
  }
  else if (type === 'chart-enhanced' && model.canUpgradeChart && !galleryVariant(model)) simpleEditor.change(draft => {
    draft.presentation = action.checked ? interactiveChartPresentation(draft.view.groupBy) : { mode: 'preserve' };
  });
  else if (type === 'scope') simpleEditor.change(draft => { if (action.value) draft.view.dataScopeLevel = action.value; else delete draft.view.dataScopeLevel; });
  else if (type === 'aggregation') simpleEditor.change(draft => { if (action.value) draft.view.analyticalAggregation = action.value; else delete draft.view.analyticalAggregation; });
  else if (type === 'athlete-mode') simpleEditor.change(draft => { draft.athleteSelection = action.value === 'selected' ? { mode: 'selected', athleteIds: [] } : { mode: action.value }; });
  else if (type === 'athlete') simpleEditor.change(draft => { const selected = new Set(draft.athleteSelection.athleteIds ?? []); if (action.checked) selected.add(action.dataset.id); else selected.delete(action.dataset.id); draft.athleteSelection = { mode: 'selected', athleteIds: [...selected] }; });
  else if (type === 'period-mode') simpleEditor.change((draft, target) => { draft.periodIntent = action.value === 'inherit' ? { mode: 'inherit' } : { mode: 'replacePageRuntime', periodConfig: { schemaVersion: 1, mode: 'fixed', ...target.periodDraft }, savePageDefaults: false }; });
  else if (type === 'date-from' || type === 'date-to') simpleEditor.change((draft, target) => { target.periodDraft[type === 'date-from' ? 'dateFrom' : 'dateTo'] = action.value; if (draft.periodIntent.mode === 'replacePageRuntime') draft.periodIntent.periodConfig = { schemaVersion: 1, mode: 'fixed', ...target.periodDraft }; });
  return true;
}
