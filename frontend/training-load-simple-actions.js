import { api } from './api.js';
import { state } from './state.js';
import { currentUserWorkspaceContextParts } from './access.js';
import { analysisRuntimeFilterPayload, loadDashboardDetail, queryAnalysisDashboard, openAnalysisWidgetEditor } from './training-load-analysis-data.js';
import { createSimpleEditorController } from './training-load-simple-controller.js';
import { interactiveChartPresentation } from './training-load-chart-composer.js';
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
export const simpleEditor = createSimpleEditorController({ request: api, paint,
  getContext: () => ({ identity: currentUserWorkspaceContextParts(), dashboardId: analysis().dashboard?.id,
    period: { ...analysis().period, timeZone: analysis().period.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' },
    runtimeFilter: analysisRuntimeFilterPayload(), inheritedAthleteIds: analysisRuntimeFilterPayload().athleteIds ?? analysis().dashboard?.default_filter?.athleteIds ?? null,
    athletes: state.trainingLoad.orgPickerData?.athletes ?? [] }),
  saved: async (receipt, target) => {
    const a = analysis();
    const periodKey = period => JSON.stringify([period.dateFrom, period.dateTo, period.timeZone || target.context.period.timeZone]);
    const newerPeriod = periodKey(a.period) !== periodKey(target.context.period);
    if (target.draft.periodIntent.mode === 'replacePageRuntime' && !newerPeriod) a.period = { ...receipt.resolvedPeriod ?? target.preview.resolvedPeriod };
    await loadDashboardDetail(target.context.dashboardId, render, { force: true });
    await queryAnalysisDashboard(render, { force: true });
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
  if (type === 'advanced') {
    const widget = analysis().widgets.find(row => row.id === model.widgetId);
    if (model.widgetId && leaveSimpleEditor()) { openAnalysisWidgetEditor(widget); render(); }
    else if (!model.widgetId && leaveSimpleEditor()) {
      analysis().simpleAdvancedCreate = true;
      return false;
    }
  } else if (type === 'next') simpleEditor.next();
  else if (type === 'back') simpleEditor.back();
  else if (type === 'preview') { if (!model.stale) await simpleEditor.preview(); }
  else if (type === 'save') { if (!model.stale) await simpleEditor.save(); }
  else if (type === 'metric') simpleEditor.selectMetric(action.dataset.kind, action.dataset.id);
  else if (type === 'search') simpleEditor.search(action.value ?? '');
  else if (type === 'more' || type === 'reload') await simpleEditor.metrics(type === 'more');
  else if (type === 'title') simpleEditor.change(draft => { draft.title = action.value ?? ''; });
  else if (type === 'view') simpleEditor.change(draft => { draft.view.type = action.value || action.dataset.value; if(model.canUpgradeChart && !['line_chart','bar_chart'].includes(draft.view.type))draft.presentation={mode:'preserve'}; });
  else if (type === 'group') simpleEditor.change(draft => { draft.view.groupBy = action.value; if(model.canUpgradeChart && draft.presentation?.mode==='replace')draft.presentation=interactiveChartPresentation(draft.view.groupBy); });
  else if (type === 'chart-enhanced' && model.canUpgradeChart) simpleEditor.change(draft=>{draft.presentation=action.checked?interactiveChartPresentation(draft.view.groupBy):{mode:'preserve'};});
  else if (type === 'scope') simpleEditor.change(draft => { if (action.value) draft.view.dataScopeLevel = action.value; else delete draft.view.dataScopeLevel; });
  else if (type === 'aggregation') simpleEditor.change(draft => { if (action.value) draft.view.analyticalAggregation = action.value; else delete draft.view.analyticalAggregation; });
  else if (type === 'athlete-mode') simpleEditor.change(draft => { draft.athleteSelection = action.value === 'selected' ? { mode: 'selected', athleteIds: [] } : { mode: action.value }; });
  else if (type === 'athlete') simpleEditor.change(draft => { const selected = new Set(draft.athleteSelection.athleteIds ?? []); if (action.checked) selected.add(action.dataset.id); else selected.delete(action.dataset.id); draft.athleteSelection = { mode: 'selected', athleteIds: [...selected] }; });
  else if (type === 'period-mode') simpleEditor.change((draft, target) => { draft.periodIntent = action.value === 'inherit' ? { mode: 'inherit' } : { mode: 'replacePageRuntime', periodConfig: { schemaVersion: 1, mode: 'fixed', ...target.periodDraft }, savePageDefaults: false }; });
  else if (type === 'date-from' || type === 'date-to') simpleEditor.change((draft, target) => { target.periodDraft[type === 'date-from' ? 'dateFrom' : 'dateTo'] = action.value; if (draft.periodIntent.mode === 'replacePageRuntime') draft.periodIntent.periodConfig = { schemaVersion: 1, mode: 'fixed', ...target.periodDraft }; });
  return true;
}
