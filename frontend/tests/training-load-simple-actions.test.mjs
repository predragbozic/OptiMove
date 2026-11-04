import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const originalGlobals = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
const dom = new JSDOM('<!doctype html><main id="root"></main>', { url: 'https://example.test' });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
window.matchMedia = () => ({ matches: false });

const { handleTrainingLoadAction, closeTrainingLoadAnalysisOverlay, confirmLeaveTrainingLoad, handleTrainingLoadBeforeUnload } = await import('../training-load-actions.js');
const { simpleEditor } = await import('../training-load-simple-actions.js');
const { renderSimpleEditorHtml } = await import('../training-load-simple-view.js');
const { analysisEditorDraftFromWidget } = await import('../training-load-analysis-data.js');
const { state, emptyTrainingLoadState } = await import('../state.js');
const { clearAllViewCache } = await import('../view-cache.js');

const dashboardId = '11111111-1111-4111-8111-111111111111';
const widgetId = '55555555-5555-4555-8555-555555555555';
const base = `/api/training-load/dashboards/${dashboardId}`;
const period = { dateFrom: '2026-10-01', dateTo: '2026-10-31', timeZone: 'Europe/Belgrade' };
const root = document.getElementById('root');
const openerHtml = `<button data-action="training-load-analysis-add-widget">Add</button><button data-action="training-load-analysis-edit-widget" data-widget-id="other-widget">Other settings</button><button data-action="training-load-analysis-open-advanced" data-widget-id="${widgetId}">Advanced</button><button data-action="training-load-analysis-edit-widget" data-widget-id="${widgetId}">Settings</button>`;
let calls, unexpected, unavailable, loseSaveResponse, confirmations, confirmAnswer, renderCount, receiptPeriod;
const analysis = () => state.trainingLoad.analysis;
const renderTrainingLoad = () => { renderCount += 1; root.innerHTML = openerHtml + renderSimpleEditorHtml(analysis().simpleEditor); };
const act = (action, dataset = {}, value = '') => handleTrainingLoadAction({ dataset: { action, ...dataset }, value }, { renderTrainingLoad });
const simple = (type, dataset = {}, value = '') => act(`training-load-simple-${type}`, dataset, value);
const control = (type, value) => {
  const selector = `[data-action="training-load-simple-${type}"]${value === undefined ? '' : `[value="${value}"]`}`;
  const element = document.querySelector(selector);
  assert.ok(element, `Missing control ${selector}`);
  return element;
};
const dispatch = element => handleTrainingLoadAction(element, { renderTrainingLoad });

function series(overrides = {}) {
  return { id: 'series-1', series_order: 1, built_in_series_key: 'rpe', metric_definition_id: null, resolution_status: 'resolved', display_label: 'Effort', axis: 'primary', color: '#123456', source_policy: 'not_applicable', source_connection_id: null, data_scope_level: 'session', analytical_aggregation: 'avg', aggregation_role_policy: 'standalone_only', coverage_policy: 'complete_only', comparison_period: null, ...overrides };
}

function widget(overrides = {}) {
  return { id: widgetId, revision: 7, title: 'Saved widget', widget_type: 'table', group_by: 'day', local_filter_override: { athleteIds: ['athlete-1'] }, display_config: { schemaVersion: 1, decimals: 3 }, presentation_config: { annotations: [{ text: 'Keep' }] }, series: [series()], ...overrides };
}

beforeEach(() => {
  clearAllViewCache();
  state.currentUser = { id: 'coach-1', activeWorkspace: { type: 'private_coach', scopeId: 'coach-1' } };
  state.activeTab = 'training-load';
  state.trainingLoad = emptyTrainingLoadState();
  state.trainingLoad.section = 'analysis';
  Object.assign(analysis(), { dashboard: { id: dashboardId, revision: 3, name: 'Load board', status: 'active', owner_scope: 'user' }, activeDashboardId: dashboardId, selectedDashboardId: dashboardId, widgets: [widget()], period: structuredClone(period) });
  calls = []; unexpected = []; confirmations = []; unavailable = false; loseSaveResponse = false; confirmAnswer = true; renderCount = 0; receiptPeriod = null;
  window.confirm = message => { confirmations.push(message); return confirmAnswer; };
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    let body, status = 200;
    if (call.url === `${base}/simple/capabilities`) {
      if (unavailable) { status = 404; body = { error: 'notFound' }; }
      else body = { capabilities: { preview: true, atomicSave: true }, widgetTypes: ['table', 'line_chart', 'bar_chart', 'kpi'], builtins: [{ key: 'rpe', label: 'RPE', unit: null, fixed_data_scope_level: 'session', default_analytical_aggregation: 'avg' }] };
    } else if (call.url.startsWith(`${base}/simple/metrics?`)) body = { metrics: [], nextCursor: null };
    else if (call.url === '/api/organization') body = { athletes: [{ id: 'athlete-1', name: 'First athlete' }, { id: 'athlete-2', name: 'Second athlete' }] };
    else if (call.url === `${base}/simple/preview` && call.method === 'POST') {
      const intent = call.body.draft.periodIntent;
      const resolvedPeriod = intent.mode === 'replacePageRuntime' ? { dateFrom: intent.periodConfig.dateFrom, dateTo: intent.periodConfig.dateTo, timeZone: intent.periodConfig.timeZone } : period;
      body = { status: 'valid', previewToken: 'preview-token', requestIssuedAt: '2026-11-03T12:00:00.000Z', resolvedPeriod: structuredClone(resolvedPeriod) };
    }
    else if (call.url === `${base}/simple/widgets` && call.method === 'POST' && loseSaveResponse) throw new TypeError('Committed response lost');
    else if (call.url === `${base}/simple/widgets` && call.method === 'POST' && receiptPeriod) body = { requestId: call.body.requestId, widgetId, widgetRevision: 8, resolvedPeriod: structuredClone(receiptPeriod) };
    else if (call.url === `${base}/simple/requests/status` && call.method === 'POST' && receiptPeriod) body = { status: 'recorded', receipt: { requestId: call.body.requestId, widgetId, widgetRevision: 8, resolvedPeriod: structuredClone(receiptPeriod) } };
    else if (call.url === base && call.method === 'GET' && receiptPeriod) body = { dashboard: structuredClone(analysis().dashboard), widgets: [widget({ revision: 8 })] };
    else if (call.url === `${base}/query` && call.method === 'POST' && receiptPeriod) body = { dashboardRevision: 3, widgets: [] };
    else if (call.url.startsWith('/api/training-load/metrics/')) body = { rows: [], nextCursor: null };
    else { unexpected.push(call); throw new Error(`Unexpected ${call.method} ${call.url}`); }
    return { ok: status < 300, status, statusText: '', json: async () => structuredClone(body) };
  };
  renderTrainingLoad();
});

afterEach(() => {
  if (simpleEditor.model) simpleEditor.model.saveState = 'idle';
  simpleEditor.close();
  assert.deepEqual(unexpected, []);
});

after(() => {
  dom.window.close();
  Object.assign(globalThis, originalGlobals);
});

test('postojeći grafikon bez sidecara dobija interakcije samo eksplicitnim izborom i novim preview-om',async()=>{
  analysis().widgets=[widget({widget_type:'line_chart',presentation_config:null})];
  await act('training-load-analysis-edit-widget',{widgetId});await simple('next');await simple('next');await simple('preview');
  assert.deepEqual(simpleEditor.model.draft.presentation,{mode:'preserve'});
  const toggle=document.querySelector('[data-action="training-load-simple-chart-enhanced"]');assert.ok(toggle);assert.equal(toggle.checked,false);
  toggle.checked=true;await dispatch(toggle);assert.equal(simpleEditor.model.preview,null);assert.equal(simpleEditor.model.canSave,false);
  assert.equal(simpleEditor.model.draft.presentation.value.chartComposition,'athletes-v1');
  await simple('preview');assert.equal(simpleEditor.model.canSave,true);
  await simple('view',{},'table');assert.deepEqual(simpleEditor.model.draft.presentation,{mode:'preserve'});
});

async function openNew() {
  assert.equal(await act('training-load-analysis-add-widget'), true);
  assert.ok(simpleEditor.model);
  assert.equal(analysis().simpleEditor, simpleEditor.model);
  assert.equal(analysis().metricPanel, null);
}

async function readyNew() {
  await openNew();
  await simple('metric', { kind: 'builtin', id: 'rpe' });
  await simple('next'); await simple('next'); await simple('preview');
  assert.equal(simpleEditor.model.canSave, true);
}

async function unknownSave() {
  await readyNew();
  loseSaveResponse = true;
  await simple('save');
  assert.equal(simpleEditor.model.saveState, 'unknown');
  assert.equal(calls.filter(call => call.url === `${base}/simple/widgets`).length, 1);
}

async function readyReplacement(stagedPeriod) {
  await openNew();
  await simple('metric', { kind: 'builtin', id: 'rpe' });
  await simple('next');
  await simple('period-mode', {}, 'replacePageRuntime');
  await simple('date-from', {}, stagedPeriod.dateFrom);
  await simple('date-to', {}, stagedPeriod.dateTo);
  await simple('next'); await simple('preview');
  assert.equal(simpleEditor.model.canSave, true);
  assert.deepEqual(simpleEditor.model.context.period, period);
  assert.deepEqual(simpleEditor.model.preview.resolvedPeriod, stagedPeriod);
  assert.deepEqual(analysis().period, period);
}

test('status recovery keeps a newer dashboard period and filter and queries them instead of the staged period', async () => {
  const staged = { dateFrom: '2026-09-01', dateTo: '2026-09-30', timeZone: period.timeZone };
  const newer = { dateFrom: '2026-11-01', dateTo: '2026-11-15', timeZone: 'UTC' };
  const newerFilter = { athleteIds: ['athlete-2'], activityId: 'new-activity', componentId: 'new-component' };
  await readyReplacement(staged);
  loseSaveResponse = true;
  await simple('save');
  assert.equal(simpleEditor.model.saveState, 'unknown');
  const first = calls.find(call => call.url === `${base}/simple/widgets`);
  assert.deepEqual(first.body.resolvedPeriod, staged);
  assert.deepEqual(first.body.input.context.period, period);
  analysis().period = structuredClone(newer);
  analysis().runtimeFilter = structuredClone(newerFilter);
  receiptPeriod = staged;
  await simple('status');
  assert.equal(simpleEditor.model.saveState, 'recorded');
  assert.equal(simpleEditor.model.receipt.requestId, first.body.requestId);
  assert.deepEqual(simpleEditor.model.receipt.resolvedPeriod, staged);
  assert.deepEqual(analysis().period, newer);
  assert.deepEqual(analysis().runtimeFilter, newerFilter);
  assert.match(analysis().notice, /saved.*kept.*newer.*period/i);
  assert.equal(simpleEditor.model.saveError, '');
  assert.deepEqual(calls.filter(call => call.url === `${base}/query`).map(call => call.body), [{ dateFrom: newer.dateFrom, dateTo: newer.dateTo, ...newerFilter }]);
  assert.deepEqual(calls.filter(call => call.url === `${base}/simple/requests/status`).map(call => call.body), [{ requestId: first.body.requestId }]);
  assert.equal(calls.filter(call => call.url === `${base}/simple/widgets`).length, 1);
  assert.equal(calls.filter(call => call.url === base && call.method === 'GET').length, 1);
});

test('a successful save applies the staged period when the opening dashboard period is unchanged', async () => {
  const staged = { dateFrom: '2026-09-01', dateTo: '2026-09-30', timeZone: period.timeZone };
  const initialFilter = structuredClone(analysis().runtimeFilter);
  await readyReplacement(staged);
  receiptPeriod = staged;
  await simple('save');
  assert.equal(simpleEditor.model.saveState, 'recorded');
  assert.deepEqual(analysis().period, staged);
  assert.deepEqual(analysis().runtimeFilter, initialFilter);
  assert.equal(analysis().notice, 'Widget saved.');
  assert.equal(simpleEditor.model.saveError, '');
  assert.deepEqual(calls.filter(call => call.url === `${base}/query`).map(call => call.body), [{ dateFrom: staged.dateFrom, dateTo: staged.dateTo, activityId: null, componentId: null }]);
  assert.equal(calls.filter(call => call.url === `${base}/simple/widgets`).length, 1);
  assert.equal(calls.filter(call => call.url === `${base}/simple/requests/status`).length, 0);
  assert.equal(calls.filter(call => call.url === base && call.method === 'GET').length, 1);
});

test('missing Simple API falls back once to the existing new-widget panel', async () => {
  unavailable = true;
  assert.equal(await act('training-load-analysis-add-widget'), true);
  assert.equal(simpleEditor.model, null);
  assert.equal(analysis().simpleEditor, null);
  assert.ok(analysis().metricPanel);
  assert.equal(analysis().metricPanel.widgetId, '');
  assert.equal(analysis().editor.open, false);
  assert.deepEqual(calls.filter(call => call.url.includes('/simple/')).map(call => [call.method, call.url]), [['GET', `${base}/simple/capabilities`]]);
  assert.equal(calls.filter(call => call.url.startsWith('/api/training-load/metrics/definitions')).length, 1);
  assert.equal(calls.some(call => call.method !== 'GET'), false);
});

test('missing Simple API preserves the existing-widget fallback and explicit Advanced entry', async () => {
  unavailable = true;
  const source = structuredClone(analysis().widgets[0]);
  await act('training-load-analysis-edit-widget', { widgetId });
  assert.equal(simpleEditor.model, null);
  assert.equal(analysis().metricPanel.widgetId, widgetId);
  assert.equal(analysis().metricPanel.title, source.title);
  const count = calls.length;
  await act('training-load-analysis-open-advanced', { widgetId });
  assert.equal(analysis().editor.open, true);
  assert.deepEqual(analysis().editor.draft, analysisEditorDraftFromWidget(source));
  assert.equal(analysis().metricPanel, null);
  assert.equal(calls.length, count);
  assert.deepEqual(analysis().widgets[0], source);
});

test('unknown saves survive close, Escape, navigation, Advanced and beforeunload without repeated requests', async () => {
  await unknownSave();
  const target = simpleEditor.model, snapshot = structuredClone(target), count = calls.length;
  await simple('close');
  assert.equal(closeTrainingLoadAnalysisOverlay(), false);
  assert.equal(confirmLeaveTrainingLoad('home'), false);
  assert.equal(confirmLeaveTrainingLoad(null, { discard: false }), false);
  await act('training-load-section', { section: 'today' });
  await act('training-load-analysis-add-widget');
  await simple('advanced');
  let prevented = 0;
  const event = { preventDefault() { prevented += 1; }, returnValue: undefined };
  assert.equal(handleTrainingLoadBeforeUnload(event), true);
  assert.equal(prevented, 1);
  assert.equal(typeof event.returnValue, 'string');
  assert.ok(event.returnValue.length);
  assert.equal(simpleEditor.model, target);
  assert.equal(analysis().simpleEditor, target);
  assert.deepEqual(target, snapshot);
  assert.equal(state.trainingLoad.section, 'analysis');
  assert.equal(analysis().editor.open, false);
  assert.equal(analysis().metricPanel, null);
  assert.deepEqual(confirmations, []);
  assert.equal(calls.length, count);
});

test('pending Simple saves block cross-host leave checks even outside the Training Load tab', async () => {
  await unknownSave();
  const target = simpleEditor.model, snapshot = structuredClone(target), count = calls.length;
  state.activeTab = 'home';
  assert.equal(confirmLeaveTrainingLoad('calendar'), false);
  assert.equal(confirmLeaveTrainingLoad(null, { discard: false }), false);
  assert.equal(confirmLeaveTrainingLoad('training-load'), false);
  assert.equal(simpleEditor.model, target);
  assert.deepEqual(target, snapshot);
  assert.equal(state.activeTab, 'home');
  assert.deepEqual(confirmations, []);
  assert.equal(calls.length, count);
});

test('existing-widget Advanced bridge preserves a rejected draft then opens the original series after confirmation', async () => {
  const source = structuredClone(analysis().widgets[0]);
  await act('training-load-analysis-edit-widget', { widgetId });
  await simple('title', {}, 'Unsaved Simple title');
  const target = simpleEditor.model, draft = structuredClone(target.draft), count = calls.length;
  confirmAnswer = false;
  await simple('advanced');
  assert.equal(simpleEditor.model, target);
  assert.deepEqual(target.draft, draft);
  assert.equal(analysis().editor.open, false);
  assert.equal(analysis().metricPanel, null);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /Discard.*Simple/i);
  confirmAnswer = true;
  await simple('advanced');
  assert.equal(confirmations.length, 2);
  assert.equal(simpleEditor.model, null);
  assert.equal(analysis().simpleEditor, null);
  assert.equal(analysis().editor.open, true);
  assert.equal(analysis().editor.widgetId, widgetId);
  assert.deepEqual(analysis().editor.draft, analysisEditorDraftFromWidget(source));
  assert.deepEqual(analysis().widgets[0], source);
  assert.equal(calls.length, count);
});

test('multi-series Advanced bridge preserves every existing series and setting', async () => {
  analysis().widgets[0].series.push(series({ id: 'series-2', series_order: 2, built_in_series_key: 'duration_minutes', display_label: 'Duration', color: '#abcdef', analytical_aggregation: 'sum' }));
  const source = structuredClone(analysis().widgets[0]);
  await act('training-load-analysis-edit-widget', { widgetId });
  assert.equal(simpleEditor.model.advancedRequired, true);
  assert.equal(simpleEditor.model.draft, null);
  const count = calls.length;
  await simple('advanced');
  assert.equal(simpleEditor.model, null);
  assert.equal(analysis().editor.open, true);
  assert.deepEqual(analysis().editor.draft, analysisEditorDraftFromWidget(source));
  assert.deepEqual(analysis().editor.draft.series.map(entry => entry.id), ['series-1', 'series-2']);
  assert.deepEqual(analysis().widgets[0], source);
  assert.equal(calls.length, count);
});

test('new-widget Advanced fallback asks before discarding and does not reopen Simple', async () => {
  await openNew();
  await simple('title', {}, 'New unsaved draft');
  const target = simpleEditor.model, draft = structuredClone(target.draft);
  const simpleCalls = calls.filter(call => call.url.includes('/simple/')).length;
  confirmAnswer = false;
  await simple('advanced');
  assert.equal(simpleEditor.model, target);
  assert.deepEqual(target.draft, draft);
  assert.equal(analysis().metricPanel, null);
  confirmAnswer = true;
  await simple('advanced');
  assert.equal(simpleEditor.model, null);
  assert.equal(analysis().simpleEditor, null);
  assert.ok(analysis().metricPanel);
  assert.equal(analysis().metricPanel.widgetId, '');
  assert.equal(analysis().editor.open, false);
  assert.equal(analysis().simpleAdvancedCreate, false);
  assert.equal(confirmations.length, 2);
  assert.equal(calls.filter(call => call.url.includes('/simple/')).length, simpleCalls);
  assert.equal(calls.filter(call => call.url.startsWith('/api/training-load/metrics/definitions')).length, 1);
  assert.equal(calls.some(call => call.method !== 'GET'), false);
});

test('title input invalidates a valid preview while restoring the replacement input focus and caret', async () => {
  await readyNew();
  const old = control('title'), version = simpleEditor.model.draft.draftVersion, count = calls.length, renders = renderCount;
  old.value = 'Edited widget title';
  old.focus(); old.setSelectionRange(3, 9);
  await dispatch(old);
  const replacement = control('title');
  assert.notEqual(replacement, old);
  assert.equal(old.isConnected, false);
  assert.equal(document.activeElement, replacement);
  assert.equal(replacement.selectionStart, 3);
  assert.equal(replacement.selectionEnd, 9);
  assert.equal(replacement.value, 'Edited widget title');
  assert.equal(simpleEditor.model.draft.title, replacement.value);
  assert.equal(simpleEditor.model.draft.draftVersion, version + 1);
  assert.equal(simpleEditor.model.preview, null);
  assert.equal(simpleEditor.model.canSave, false);
  assert.equal(control('save').disabled, true);
  assert.ok(renderCount > renders);
  await simple('save');
  assert.equal(calls.length, count);
});

for (const type of ['title', 'view', 'metric']) {
  test(`forwarding an unchanged ${type} control action preserves the preview and Save eligibility`, async () => {
    await readyNew();
    const draft = structuredClone(simpleEditor.model.draft), preview = simpleEditor.model.preview, input = simpleEditor.model.previewInput, count = calls.length;
    if (type === 'metric') await simple('metric', { kind: 'builtin', id: 'rpe' });
    else {
      const element = type === 'view' ? control(type, draft.view.type) : control(type);
      element.focus();
      await dispatch(element);
    }
    assert.deepEqual(simpleEditor.model.draft, draft);
    assert.equal(simpleEditor.model.preview, preview);
    assert.equal(simpleEditor.model.previewInput, input);
    assert.equal(simpleEditor.model.canSave, true);
    assert.equal(control('save').disabled, false);
    assert.equal(calls.length, count);
  });
}

for (const [type, value] of [['athlete-mode', 'selected'], ['period-mode', 'replacePageRuntime'], ['view', 'line_chart']]) {
  test(`${type} restores focus by radio value rather than the first matching action`, async () => {
    await openNew();
    await simple('metric', { kind: 'builtin', id: 'rpe' });
    await simple('next');
    if (type === 'view') await simple('next');
    const old = control(type, value);
    old.checked = true; old.focus();
    await dispatch(old);
    const replacement = control(type, value);
    assert.notEqual(replacement, old);
    assert.equal(old.isConnected, false);
    assert.equal(document.activeElement, replacement);
    assert.equal(replacement.checked, true);
    assert.notEqual(document.activeElement, document.querySelector(`[data-action="training-load-simple-${type}"]`));
    if (type === 'athlete-mode') assert.deepEqual(simpleEditor.model.draft.athleteSelection, { mode: 'selected', athleteIds: [] });
    else if (type === 'period-mode') assert.equal(simpleEditor.model.draft.periodIntent.mode, value);
    else assert.equal(simpleEditor.model.draft.view.type, value);
  });
}

test('closing returns focus to the replacement opener matched by action and widget ID', async () => {
  const opener = document.querySelector(`[data-action="training-load-analysis-edit-widget"][data-widget-id="${widgetId}"]`);
  opener.focus();
  await dispatch(opener);
  assert.equal(opener.isConnected, false);
  assert.ok(document.querySelector('.tl-simple-editor'));
  const count = calls.length;
  const close = control('close');
  close.focus();
  await dispatch(close);
  const replacement = document.querySelector(`[data-action="training-load-analysis-edit-widget"][data-widget-id="${widgetId}"]`);
  assert.notEqual(replacement, opener);
  assert.equal(document.activeElement, replacement);
  assert.equal(simpleEditor.model, null);
  assert.equal(analysis().simpleEditor, null);
  assert.equal(confirmations.length, 1);
  assert.equal(calls.length, count);
});
