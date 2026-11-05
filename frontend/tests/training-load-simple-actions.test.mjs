import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const originalGlobals = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
const dom = new JSDOM('<!doctype html><main id="root"></main>', { url: 'https://example.test' });
globalThis.document = dom.window.document;
globalThis.window = dom.window;
window.matchMedia = () => ({ matches: false });

const { handleTrainingLoadAction, closeTrainingLoadAnalysisOverlay, confirmLeaveTrainingLoad, handleTrainingLoadBeforeUnload, handleTrainingLoadAnalysisPointerDown } = await import('../training-load-actions.js');
const { simpleEditor, leaveSimpleEditor } = await import('../training-load-simple-actions.js');
const { renderSimpleEditorHtml } = await import('../training-load-simple-view.js');
const { analysisEditorDraftFromWidget } = await import('../training-load-analysis-data.js');
const { state, emptyTrainingLoadState } = await import('../state.js');
const { clearAllViewCache } = await import('../view-cache.js');
const { interactiveChartPresentation } = await import('../training-load-chart-composer.js');

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

function enablePages() {
  const page = { id: 'page-1', dashboardId, name: 'Pregled', position: 0, revision: 1, defaultsRevision: 3, layoutRevision: 1,
    defaultFilter: { athleteIds: ['athlete-2'] }, periodConfig: { schemaVersion: 1, mode: 'fixed', ...period }, periodOrigin: 'configured' };
  const capabilities = { pages: true, pageWidgetEditing: true, pageManagement: true, pageQuery: true };
  analysis().dashboard.pages_revision = 1;
  Object.assign(analysis(), { pagesMode: true, pagesDashboardId: dashboardId, pages: [page], pagesRevision: 1,
    selectedPageId: page.id, page, pageCapabilities: capabilities });
  const fetchLegacy = globalThis.fetch, pageCalls = [];
  const response = body => ({ ok: true, status: 200, statusText: '', json: async () => structuredClone(body) });
  globalThis.fetch = async (url, options) => {
    pageCalls.push({ url: String(url), body: options?.body });
    if (String(url) === `${base}/pages` && (!options?.method || options.method === 'GET')) {
      return response({ dashboard: analysis().dashboard, pages: analysis().pages, pagesRevision: 1, capabilities });
    }
    if (String(url) === `${base}/pages/page-1` && (!options?.method || options.method === 'GET')) {
      const currentPage = structuredClone(analysis().page);
      const legacyDetail = await (await globalThis.fetch(base, options)).json();
      return response({ page: currentPage, widgets: legacyDetail.widgets });
    }
    return fetchLegacy(String(url).replace(/\/pages\/[^/]+\/simple\//, '/simple/').replace(/\/pages\/[^/]+\/query$/, '/query'), options);
  };
  return pageCalls;
}

test('Simple save čuva lični septembarski period uz configured Page defaults i šalje ga u query', async () => {
  const pageCalls = enablePages();
  analysis().pageRuntimeUsesDefaults = true;
  const sharedPage = structuredClone(analysis().page);
  const staged = { dateFrom: '2026-09-01', dateTo: '2026-09-30', timeZone: period.timeZone };
  await readyReplacement(staged);
  receiptPeriod = staged;
  await simple('save');
  const query = pageCalls.find(call => call.url === `${base}/pages/page-1/query`);
  assert.ok(query);
  assert.deepEqual(JSON.parse(query.body).period, staged);
  assert.equal(simpleEditor.model.saveState, 'recorded');
  assert.equal(simpleEditor.model.saveError, '');
  assert.equal(analysis().pagesMode, true);
  assert.equal(analysis().selectedPageId, sharedPage.id);
  assert.equal(analysis().pageRuntimeUsesDefaults, false);
  assert.deepEqual(analysis().period, staged);
  assert.deepEqual(analysis().pageRuntime[sharedPage.id].period, staged);
  assert.equal(analysis().pageRuntime[sharedPage.id].usesDefaults, false);
  assert.deepEqual(analysis().page, sharedPage);
  const saved = pageCalls.find(call => call.url.endsWith('/simple/widgets'));
  assert.equal(JSON.parse(saved.body).input.draft.periodIntent.savePageDefaults, false);
  assert.equal(pageCalls.some(call => call.url.endsWith('/defaults')), false);
});

test('Page context nasleđuje dashboard → Page → runtime, uključujući eksplicitno clear', async () => {
  enablePages();
  analysis().dashboard.default_filter = { athleteIds: ['athlete-1'] };
  for (const [pageFilter, runtime, expected] of [
    [{ athleteIds: ['athlete-2'] }, {}, ['athlete-2']],
    [{}, {}, ['athlete-1']],
    [{ athleteIds: null }, {}, null],
    [{ athleteIds: ['athlete-2'] }, { athleteIds: ['athlete-1'] }, ['athlete-1']],
  ]) {
    analysis().page.defaultFilter = pageFilter;
    analysis().runtimeFilter = runtime;
    await openNew();
    assert.equal(simpleEditor.model.context.pageId, 'page-1');
    assert.equal(simpleEditor.model.context.pageDefaultsRevision, 3);
    assert.deepEqual(simpleEditor.model.context.pageDefaultFilter, pageFilter);
    assert.deepEqual(simpleEditor.model.context.effectiveInheritedAthleteIds, expected);
    assert.deepEqual(simpleEditor.model.context.period, period);
    assert.equal(simpleEditor.close(), true);
  }
});

test('Page unknown blokira preSwitch i close; retry koristi isti Page ID i originalno telo', async () => {
  const pageCalls = enablePages();
  await unknownSave();
  const original = pageCalls.find(call => call.url.endsWith('/widgets'));
  let asked = false;
  assert.equal(leaveSimpleEditor({ discard: false, confirm: () => { asked = true; return true; } }), false);
  assert.equal(asked, false);
  assert.equal(simpleEditor.close(), false);
  analysis().page.defaultsRevision++;
  analysis().period.dateTo = '2026-10-30';
  loseSaveResponse = false; receiptPeriod = period;
  await simple('retry');
  const retries = pageCalls.filter(call => call.url.endsWith('/widgets'));
  assert.equal(retries.length, 2);
  assert.deepEqual(retries[1], original);
  assert.equal(JSON.parse(original.body).input.context.pageId, 'page-1');
  assert.equal(simpleEditor.model.saveState, 'recorded');
  assert.equal(analysis().selectedPageId, 'page-1');
});

for (const changed of ['page', 'dashboard', 'identity']) {
  test(`spor Page save ne osvežava drugi kontekst: ${changed}`, async () => {
    const pageCalls = enablePages(); await readyNew();
    const fetchPage = globalThis.fetch;
    let finish;
    globalThis.fetch = (url, options) => String(url).endsWith('/simple/widgets')
      ? new Promise(resolve => { finish = () => resolve({ ok: true, status: 200, json: async () => ({ widgetId, resolvedPeriod: period }) }); })
      : fetchPage(url, options);
    const operation = simple('save');
    if (changed === 'page') { analysis().page = { ...analysis().page, id: 'page-2' }; analysis().selectedPageId = 'page-2'; }
    else if (changed === 'dashboard') analysis().selectedDashboardId = 'other-dashboard';
    else state.currentUser = { ...state.currentUser, id: 'other-coach' };
    finish(); await operation;
    assert.equal(pageCalls.some(call => call.url === base || call.url.endsWith('/query')), false);
    assert.equal(analysis().notice || '', '');
    assert.deepEqual(analysis().period, period);
  });
}

test('promena Page tokom detail reload-a sprečava naknadni query i notice za drugu Page', async () => {
  enablePages(); await readyNew();
  receiptPeriod = period;
  const fetchPage = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    if (String(url) === base) { analysis().page = { ...analysis().page, id: 'page-2' }; analysis().selectedPageId = 'page-2'; }
    return fetchPage(url, options);
  };
  await simple('save');
  assert.equal(simpleEditor.model.saveState, 'recorded');
  assert.equal(calls.some(call => call.url.endsWith('/query')), false);
  assert.equal(analysis().notice || '', '');
  assert.equal(analysis().selectedPageId, 'page-2');
});

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
  assert.ok(calls.slice(count).every(call => call.method === 'GET'), 'Advanced may read metadata and readiness, but never writes');
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
  assert.ok(calls.slice(count).every(call => call.method === 'GET'), 'Advanced may read metadata and readiness, but never writes');
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
  assert.ok(calls.slice(count).every(call => call.method === 'GET'), 'Advanced may read metadata and readiness, but never writes');
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

test('inline editor does not trap Tab and guarded dashboard actions cannot discard the draft', async () => {
  await readyNew();
  const target = simpleEditor.model;
  const draft = structuredClone(target.draft), count = calls.length;
  control('save').focus();
  const tab = new window.KeyboardEvent('keydown', {key:'Tab',bubbles:true,cancelable:true});
  document.activeElement.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented,false);
  await act('training-load-analysis-period-from',{},'2026-09-01');
  await act('training-load-analysis-edit-widget',{'widgetId':'other-widget'});
  assert.equal(simpleEditor.model,target);
  assert.deepEqual(target.draft,draft);
  assert.deepEqual(analysis().period,period);
  assert.equal(calls.length,count);
});

test('opening Settings closes existing popovers and blocks layout pointer paths while the draft is open', async () => {
  analysis().editMode=true;
  analysis().menu=`widget:${widgetId}`;
  analysis().picker.open=true;
  await act('training-load-analysis-edit-widget',{widgetId});
  assert.ok(simpleEditor.model);
  assert.equal(analysis().menu,'');
  assert.equal(analysis().picker.open,false);
  assert.equal(analysis().layoutDraft,null);
  for (const attributes of ['data-analysis-drag-handle="true"','data-analysis-resize-handle']) {
    const article=document.createElement('article');article.dataset.analysisWidgetId=widgetId;
    article.innerHTML=`<button ${attributes}></button>`;root.append(article);
    const event={target:article.firstChild,button:0,pointerId:1,clientX:10,clientY:10,preventDefault(){throw new Error('Blocked layout must not capture pointer');}};
    assert.equal(handleTrainingLoadAnalysisPointerDown(event,renderTrainingLoad),false);
    assert.equal(analysis().layoutDraft,null);
    article.remove();
  }
});

test('repainting the same inline draft preserves expanded advanced options and focused controls', async () => {
  await readyNew();
  document.querySelector('.tl-simple-advanced').open=true;
  const title=control('title');title.focus();title.value='New title';
  await dispatch(title);
  assert.equal(document.querySelector('.tl-simple-advanced').open,true);
  assert.equal(document.activeElement,control('title'));
  assert.equal(control('title').value,'New title');
});


for (const [id, type, variant] of [['table','table'], ['kpi','kpi'], ['line_chart','line_chart'], ['bar_chart','bar_chart'], ['area','line_chart','area'], ['horizontal-bar','bar_chart','horizontal-bar']]) {
  test(`gallery ${id} updates only the draft and requires a fresh preview after a change`, async () => {
    await readyNew();
    const m = simpleEditor.model;
    m.capabilities.capabilities.chartVariants = ['area','horizontal-bar'];
    const count = calls.length, version = m.draft.draftVersion;
    const unchanged = id === 'table';
    await simple('view', {}, id);
    assert.equal(m.draft.view.type, type);
    assert.equal(m.draft.presentation?.value?.chartVariant, variant);
    assert.equal(calls.length, count);
    assert.equal(m.draft.draftVersion, version + (unchanged ? 0 : 1));
    if (!unchanged) { assert.equal(m.preview, null); assert.equal(m.canSave, false); }
    await simple('preview');
    assert.equal(calls.at(-1).url, `${base}/simple/preview`);
    assert.equal(calls.at(-1).body.draft.view.type, type);
    assert.equal(calls.at(-1).body.draft.presentation?.value?.chartVariant, variant);
    assert.equal(calls.filter(call => /simple\/widgets/.test(call.url)).length, 0);
  });
}

test('gallery blocks unavailable variants and nonnumeric displays even through a forwarded action', async () => {
  await readyNew();
  const m = simpleEditor.model, before = structuredClone(m.draft), preview = m.preview;
  for (const id of ['area','horizontal-bar','heatmap']) await simple('view', {}, id);
  assert.deepEqual(m.draft, before);
  assert.equal(m.preview, preview);
  m.capabilities.capabilities.chartVariants = ['area','horizontal-bar'];
  m.selectedMetric = { value_type: 'text' };
  for (const id of ['kpi','line_chart','bar_chart','area','horizontal-bar','heatmap']) await simple('view', {}, id);
  assert.deepEqual(m.draft, before);
  m.selectedMetric = { value_type: 'numeric' };
  m.capabilities.widgetTypes = ['table'];
  await simple('view', {}, 'line_chart');
  assert.deepEqual(m.draft, before);
});

for (const [variant, type] of [['area','line_chart'], ['horizontal-bar','bar_chart']]) {
  test(`saved ${variant} restores selection, preserves same selection and survives grouping`, async () => {
    const presentation = { schemaVersion: 1, chartVariant: variant, chartComposition: 'athletes-v1', chartInteractions: { tooltip: { mode: 'formatted' }, yAxis: { mode: 'fixed', min: 0, max: 100 } } };
    analysis().widgets = [widget({ widget_type: type, presentation_config: presentation })];
    await act('training-load-analysis-edit-widget', { widgetId });
    simpleEditor.model.capabilities.capabilities.chartVariants = ['area','horizontal-bar'];
    await simple('next'); await simple('next'); await simple('preview');
    assert.equal(control('view', variant).checked, true);
    const m = simpleEditor.model, version = m.draft.draftVersion, preview = m.preview;
    await simple('view', {}, variant);
    assert.equal(m.draft.draftVersion, version);
    assert.equal(m.preview, preview);
    assert.deepEqual(m.draft.presentation, { mode: 'preserve' });
    await simple('group', {}, 'athlete');
    assert.deepEqual(m.draft.presentation, { mode: 'replace', value: { ...presentation, chartInteractions: { ...presentation.chartInteractions, zoom: { mode: 'disabled', applyPeriodAction: false } } } });
    assert.equal(control('view', variant).checked, true);
    await simple('view', {}, type);
    assert.equal(m.draft.presentation.mode, 'replace');
    assert.equal(m.draft.presentation.value.chartVariant, undefined);
    assert.deepEqual(m.draft.presentation.value.chartInteractions, { ...presentation.chartInteractions, zoom: { mode: 'disabled', applyPeriodAction: false } });
    assert.equal(m.preview, null);
  });
}

test('opaque presentation requires Advanced for a changed display and retains the preserve emitter', async () => {
  await act('training-load-analysis-edit-widget', { widgetId });
  await simple('next'); await simple('next'); await simple('preview');
  const m = simpleEditor.model, draft = structuredClone(m.draft), preview = m.preview;
  m.capabilities.capabilities.chartVariants = ['area','horizontal-bar'];
  for (const id of ['line_chart','bar_chart','area','horizontal-bar','kpi']) await simple('view', {}, id);
  assert.deepEqual(m.draft, draft);
  assert.equal(m.preview, preview);
  assert.match(root.textContent, /Advanced editor to change/);
  assert.deepEqual(m.savedPresentation, { annotations: [{ text: 'Keep' }] });
});

test('variant grouping keeps custom settings and interactive toggle cannot silently remove Area', async () => {
  analysis().widgets = [widget({ widget_type: 'line_chart', presentation_config: null })];
  await act('training-load-analysis-edit-widget', { widgetId });
  await simple('next'); await simple('next');
  const m = simpleEditor.model;
  m.capabilities.capabilities.chartVariants = ['area','horizontal-bar'];
  await simple('view', {}, 'area');
  m.draft.presentation.value.chartInteractions.tooltip.mode = 'formatted';
  await simple('group', {}, 'athlete');
  assert.equal(m.draft.presentation.value.chartVariant, 'area');
  assert.equal(m.draft.presentation.value.chartInteractions.tooltip.mode, 'formatted');
  assert.equal(m.draft.presentation.value.chartInteractions.zoom.mode, 'disabled');
  const toggle = control('chart-enhanced');
  assert.equal(toggle.checked, true); assert.equal(toggle.disabled, true);
  toggle.checked = false; await dispatch(toggle);
  assert.equal(m.draft.presentation.value.chartVariant, 'area');
  await simple('view', {}, 'line_chart');
  assert.equal(control('chart-enhanced').disabled, false);
  const off = control('chart-enhanced'); off.checked = false; await dispatch(off);
  assert.deepEqual(m.draft.presentation, { mode: 'preserve' });
});

test('selecting another metric removes draft-only chart variant without changing saved presentation', async () => {
  await readyNew();
  const m = simpleEditor.model;
  m.capabilities.capabilities.chartVariants = ['area'];
  await simple('view', {}, 'area');
  await simple('metric', { kind: 'builtin', id: 'other' });
  assert.equal(m.draft.view.type, 'table');
  assert.equal(m.draft.presentation, undefined);
});


for (const [variant, type] of [['area','line_chart'], ['horizontal-bar','bar_chart']]) {
  test(`reopened ${variant} adapts preserve day to athlete to week without losing other settings`, async () => {
    const presentation = {
      schemaVersion: 1, chartVariant: variant, chartComposition: 'athletes-v1',
      chartInteractions: { tooltip: { mode: 'formatted' }, legend: { toggle: false },
        zoom: { mode: 'local', applyPeriodAction: true }, pointSelection: { mode: 'details' },
        yAxis: { mode: 'fixed', min: -20, max: 100 } },
    };
    const savedWidget = widget({ widget_type: type, group_by: 'day', presentation_config: presentation });
    analysis().widgets = [savedWidget];
    await act('training-load-analysis-edit-widget', { widgetId });
    const m = simpleEditor.model;
    m.capabilities.capabilities.chartVariants = ['area','horizontal-bar'];
    await simple('next'); await simple('next'); await simple('preview');
    assert.deepEqual(m.draft.presentation, { mode: 'preserve' });
    const originalPreview = m.preview, originalVersion = m.draft.draftVersion;
    await simple('group', {}, 'day');
    assert.equal(m.preview, originalPreview);
    assert.equal(m.draft.draftVersion, originalVersion);
    assert.deepEqual(m.draft.presentation, { mode: 'preserve' });
    for (const [group, zoom] of [['athlete', { mode: 'disabled', applyPeriodAction: false }], ['week', { mode: 'local', applyPeriodAction: true }]]) {
      const version = m.draft.draftVersion, count = calls.length;
      await simple('group', {}, group);
      assert.equal(calls.length, count);
      assert.equal(m.draft.draftVersion, version + 1);
      assert.equal(m.preview, null);
      assert.equal(m.previewInput, null);
      assert.equal(m.canSave, false);
      assert.equal(control('save').disabled, true);
      const expected = { ...presentation, chartInteractions: { ...presentation.chartInteractions, zoom } };
      assert.deepEqual(m.draft.presentation, { mode: 'replace', value: expected });
      assert.notEqual(m.draft.presentation.value, m.savedPresentation);
      assert.notEqual(m.draft.presentation.value.chartInteractions, m.savedPresentation.chartInteractions);
      assert.deepEqual(m.savedPresentation, presentation);
      assert.deepEqual(savedWidget.presentation_config, presentation);
      assert.equal(control('view', variant).checked, true);
      await simple('save');
      assert.equal(calls.length, count);
      await simple('preview');
      assert.equal(m.canSave, true);
      const input = calls.at(-1).body.draft;
      assert.equal(input.view.groupBy, group);
      assert.deepEqual(input.presentation, { mode: 'replace', value: expected });
    }
    assert.equal(calls.filter(call => /simple\/widgets/.test(call.url)).length, 0);
  });
}

for (const reopened of [false, true]) test(`${reopened ? 'reopened' : 'new'} heatmap refuses athlete/session and copies day/week sidecars without losing custom interactions`, async () => {
  const presentation = interactiveChartPresentation('day', 'heatmap').value;
  Object.assign(presentation.chartInteractions, { tooltip: { mode: 'formatted' }, legend: { toggle: false }, pointSelection: { mode: 'disabled' }, zoom: { mode: 'disabled', applyPeriodAction: false } });
  if (reopened) {
    analysis().widgets = [widget({ widget_type: 'bar_chart', presentation_config: presentation })];
    await act('training-load-analysis-edit-widget', { widgetId });
    await simple('next'); await simple('next');
  } else {
    await readyNew();
    simpleEditor.model.capabilities.capabilities.chartVariants = ['heatmap'];
    await simple('view', {}, 'heatmap');
    simpleEditor.model.draft.presentation.value = structuredClone(presentation);
  }
  const m = simpleEditor.model;
  m.capabilities.capabilities.chartVariants = ['heatmap'];
  await simple('preview');
  assert.equal(control('view', 'heatmap').checked, true);
  const version = m.draft.draftVersion, preview = m.preview, before = structuredClone(m.draft);
  await simple('view', {}, 'heatmap'); await simple('group', {}, 'day');
  assert.equal(m.draft.draftVersion, version); assert.equal(m.preview, preview);
  for (const group of ['athlete', 'session']) {
    const count = calls.length;
    await simple('group', {}, group);
    assert.deepEqual(m.draft, before); assert.equal(m.preview, preview);
    assert.equal(calls.length, count);
    assert.match(root.textContent, /Heatmap supports day or week only/);
    assert.equal(control('view', 'heatmap').checked, true);
  }
  for (const group of ['week', 'day']) {
    await simple('group', {}, group);
    assert.equal(m.error, ''); assert.equal(m.preview, null); assert.equal(m.canSave, false);
    assert.equal(m.draft.presentation.mode, 'replace');
    assert.equal(m.draft.presentation.value.chartComposition, 'matrix-v1');
    assert.deepEqual(m.draft.presentation.value.chartInteractions, { ...presentation.chartInteractions, zoom: { mode: 'local', applyPeriodAction: true } });
    assert.deepEqual(m.savedPresentation, reopened ? presentation : null);
    await simple('preview');
    assert.deepEqual(calls.at(-1).body.draft.presentation, m.draft.presentation);
    assert.equal(calls.at(-1).body.draft.view.groupBy, group); assert.equal(m.canSave, true);
  }
});

test('reopened opaque schema99 with a variant never gets cloned or rewritten by grouping', async () => {
  const presentation = { schemaVersion: 99, chartVariant: 'area', chartComposition: 'opaque', chartInteractions: { zoom: { mode: 'custom' } }, other: ['keep'] };
  const savedWidget = widget({ widget_type: 'line_chart', group_by: 'day', presentation_config: presentation });
  analysis().widgets = [savedWidget];
  await act('training-load-analysis-edit-widget', { widgetId });
  const m = simpleEditor.model;
  await simple('next'); await simple('next'); await simple('preview');
  const originalPreview = m.preview, version = m.draft.draftVersion;
  await simple('group', {}, 'day');
  assert.equal(m.draft.draftVersion, version);
  assert.equal(m.preview, originalPreview);
  for (const group of ['athlete','week']) {
    await simple('group', {}, group);
    assert.deepEqual(m.draft.presentation, { mode: 'preserve' });
    assert.deepEqual(m.savedPresentation, presentation);
    assert.deepEqual(savedWidget.presentation_config, presentation);
    assert.match(root.textContent, /Open the Advanced editor to change the display/);
    await simple('preview');
    assert.deepEqual(calls.at(-1).body.draft.presentation, { mode: 'preserve' });
  }
});


test('combined gallery confirms discard and opens only a two-series Advanced draft', async () => {
  analysis().widgets = [widget({ widget_type: 'bar_chart', presentation_config: null })];
  await act('training-load-analysis-edit-widget', { widgetId });
  simpleEditor.model.capabilities.capabilities.combinedCharts = true;
  const source = structuredClone(analysis().widgets[0]);
  confirmAnswer = false;
  await simple('view', {}, 'combined');
  assert.equal(analysis().editor.open, false); assert.ok(simpleEditor.model);
  confirmAnswer = true; const count = calls.length;
  await simple('view', {}, 'combined');
  assert.equal(simpleEditor.model, null);
  const draft = analysis().editor.draft;
  assert.equal(draft.widgetType, 'line_chart'); assert.equal(draft.series.length, 2);
  assert.deepEqual(draft.series.map(entry => entry.fields.axis), ['primary', 'secondary']);
  assert.equal(draft.presentation.value.chartVariant, 'combined');
  assert.deepEqual(analysis().widgets[0], source);
  assert.ok(calls.slice(count).every(call => call.method === 'GET'));
});

for (const gate of ['capability', 'page', 'identity', 'dashboard', 'stale', 'new']) test(`combined handoff blocks ${gate} without writes`, async () => {
  analysis().widgets = [widget({ widget_type: 'line_chart', presentation_config: null })];
  await act('training-load-analysis-edit-widget', { widgetId });
  const model = simpleEditor.model; model.capabilities.capabilities.combinedCharts = true;
  if (gate === 'capability') delete model.capabilities.capabilities.combinedCharts;
  if (gate === 'page') { analysis().pagesMode = true; analysis().pageCapabilities = {}; }
  if (gate === 'identity') state.currentUser.id = 'other';
  if (gate === 'dashboard') analysis().selectedDashboardId = 'other';
  if (gate === 'stale') model.stale = true;
  if (gate === 'new') model.widgetId = null;
  const count = calls.length;
  await simple('view', {}, 'combined');
  assert.equal(analysis().editor.open, false); assert.equal(simpleEditor.model, model);
  assert.equal(calls.length, count); assert.equal(confirmations.length, 0);
});


test('saved combined retains two series and preserve intent through the existing Advanced fallback', async () => {
  const config = { schemaVersion: 1, chartVariant: 'combined', chartComposition: 'metrics-v1', chartInteractions: { yAxis: { mode: 'auto' } } };
  analysis().widgets = [widget({ widget_type: 'line_chart', presentation_config: config, series: [series(), series({ id: 'series-2', series_order: 2, built_in_series_key: 'srpe', axis: 'secondary' })] })];
  await act('training-load-analysis-edit-widget', { widgetId });
  assert.equal(simpleEditor.model.advancedRequired, true);
  const count = calls.length; await simple('advanced');
  assert.deepEqual(analysis().editor.draft.presentation, { mode: 'preserve' });
  assert.deepEqual(analysis().editor.draft.savedPresentation, config);
  assert.equal(analysis().editor.draft.series.length, 2);
  assert.ok(calls.slice(count).every(call => call.method === 'GET'));
});
