import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSimpleEditorController, simpleDraftFromWidget, simpleSaveIsPending } from '../training-load-simple-controller.js';

const clone = value => structuredClone(value);
const period = { dateFrom: '2026-10-01', dateTo: '2026-10-31', timeZone: 'Europe/Belgrade' };
const builtin = { key: 'load', label: 'Load', unit: null, description: null, fixed_data_scope_level: 'session', default_analytical_aggregation: 'sum' };
const custom = { id: 'metric-1', label: 'Distance', unit: 'm', scope_capabilities: ['session'], allowed_aggregations: ['sum', 'avg'], daily_aggregation_method: 'sum', default_analytical_aggregation: 'avg' };
const capabilities = { capabilities: { preview: true, atomicSave: true }, builtins: [builtin] };
const validPreview = (overrides = {}) => ({ status: 'valid', previewToken: 'preview-token', requestIssuedAt: '2026-11-03T12:00:00.000Z', resolvedPeriod: clone(period), ...overrides });
const receipt = { widgetId: 'widget-1', widgetRevision: 8, requestId: 'id-2' };
const pageContext = (h, pageId = 'page/1') => { h.context = { ...h.context, pageId, pageDefaultsRevision: 3, pageDefaultFilter: { athleteIds: ['athlete-page'] } }; };
const apiError = (status, error) => Object.assign(new Error(error), { status, data: { error } });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

function harness() {
  let context = { identity: 'coach-1', dashboardId: 'dashboard/1', period: clone(period), runtimeFilter: { athleteIds: ['athlete-1'] }, athletes: [{ id: 'athlete-1', name: 'Athlete' }] };
  let now = 0, timerId = 0, uuidCount = 0, activePreviews = 0, maxPreviews = 0;
  const timers = new Map(), calls = [], paints = [], saved = [], replies = new Map();
  const controller = createSimpleEditorController({
    getContext: () => context,
    uuid: () => `id-${++uuidCount}`,
    schedule: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    cancel: id => timers.delete(id),
    paint: model => paints.push(clone(model)),
    saved: async (...args) => saved.push(args),
    request: async (url, options) => {
      const route = url.endsWith('/capabilities') ? 'capabilities' : url.includes('/metrics?') ? 'metrics' : url.endsWith('/preview') ? 'preview' : url.endsWith('/requests/status') ? 'status' : 'save';
      calls.push({ route, url, options: clone(options), body: options?.body ? JSON.parse(options.body) : undefined });
      if (route === 'preview') { activePreviews += 1; maxPreviews = Math.max(maxPreviews, activePreviews); }
      try {
        const queue = replies.get(route);
        if (queue?.length) return await queue.shift()();
        if (route === 'capabilities') return clone(capabilities);
        if (route === 'metrics') return { metrics: [clone(custom)], nextCursor: null };
        if (route === 'preview') return validPreview();
        throw new Error(`Unexpected ${route} request`);
      } finally {
        if (route === 'preview') activePreviews -= 1;
      }
    },
  });
  return {
    controller, calls, paints, saved,
    get uuidCount() { return uuidCount; },
    get maxPreviews() { return maxPreviews; },
    get context() { return context; },
    set context(value) { context = value; },
    reply(route, ...responses) { replies.set(route, [...(replies.get(route) ?? []), ...responses]); },
    of: route => calls.filter(call => call.route === route),
    async tick(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now && timers.delete(id)) timer.callback();
      }
      await flush();
    },
  };
}

async function ready(h, widget) {
  await h.controller.open(widget);
  if (!widget) {
    h.controller.selectMetric('metric', custom.id);
    h.controller.change(draft => { draft.view.analyticalAggregation = 'avg'; });
  }
  h.controller.next();
  h.controller.next();
  await h.controller.preview();
  assert.equal(h.controller.model.canSave, true);
}

async function uncertain(h) {
  await ready(h);
  h.reply('save', () => Promise.reject(new TypeError('Response lost after commit')));
  await h.controller.save();
  assert.equal(h.controller.model.saveState, 'unknown');
}

function widget(overrides = {}) {
  return { id: 'widget/1', revision: 7, title: 'Original', widget_type: 'line_chart', group_by: 'week', local_filter_override: { athleteIds: ['athlete-1'], activityId: null, componentId: 'component-1' }, series: [{ resolution_status: 'resolved', metric_definition_id: custom.id, data_scope_level: 'session', analytical_aggregation: 'avg' }], display_config: { decimals: 3, nested: { color: 'red' } }, presentation_config: { annotations: [{ text: 'Keep me' }] }, ...overrides };
}

test('Page rute i envelope koriste stvarni ID; običan save ne upisuje shared defaults', async () => {
  const h = harness(); pageContext(h);
  await ready(h, widget());
  h.reply('save', () => receipt);
  await h.controller.save();
  assert.ok(h.calls.every(call => call.url.startsWith('/api/training-load/dashboards/dashboard%2F1/pages/page%2F1/simple/')));
  assert.deepEqual(h.of('preview')[0].body.context, { kind: 'page', pageId: 'page/1', period, runtimeFilter: h.context.runtimeFilter });
  assert.equal(Object.hasOwn(h.of('save')[0].body.input.context, 'expectedPageDefaultsRevision'), false);
  assert.equal(h.of('save')[0].url.endsWith('/widgets/widget%2F1'), true);
  assert.equal(h.of('save')[0].options.method, 'PUT');
});

for (const route of ['capabilities', 'metrics', 'preview', 'save']) {
  test(`spor ${route} odgovor sa druge Page ne menja aktivni editor`, async () => {
    const h = harness(), pending = deferred(); pageContext(h);
    let operation;
    if (route === 'capabilities') { h.reply(route, () => pending.promise); operation = h.controller.open(); }
    else {
      await ready(h);
      h.reply(route, () => pending.promise);
      operation = route === 'metrics' ? h.controller.metrics() : route === 'preview' ? h.controller.preview() : h.controller.save();
    }
    pageContext(h, 'page/2');
    pending.resolve(route === 'capabilities' ? capabilities : route === 'metrics' ? { metrics: [{ ...custom, label: 'Wrong page' }] } : route === 'preview' ? validPreview({ previewToken: 'wrong-page-token' }) : receipt);
    await operation;
    assert.equal(h.saved.length, 0);
    assert.equal(h.controller.model.receipt, undefined);
    assert.notEqual(h.controller.model.preview?.previewToken, 'wrong-page-token');
    assert.notEqual(h.controller.model.metrics[0]?.label, 'Wrong page');
    if (route === 'capabilities') assert.equal(h.controller.model.capabilities, undefined);
  });
}

test('isti draft ne prenosi preview token između Page ID-jeva', async () => {
  const h = harness(); pageContext(h); await ready(h);
  const draft = clone(h.controller.model.draft), ids = h.uuidCount;
  pageContext(h, 'page/2');
  await h.controller.save();
  assert.deepEqual(h.controller.model.draft, draft);
  assert.equal(h.of('save').length, 0);
  assert.equal(h.uuidCount, ids);
  assert.equal(h.controller.model.canSave, false);
});

for (const key of ['pageDefaultsRevision', 'pageDefaultFilter']) {
  test(`${key} poništava preview čak i kada runtime maskira defaults`, async () => {
    const h = harness(); pageContext(h); await ready(h);
    h.context[key] = key === 'pageDefaultsRevision' ? 4 : { athleteIds: ['changed'] };
    await h.controller.save();
    assert.equal(h.of('save').length, 0);
    assert.equal(h.controller.model.canSave, false);
  });
}

test('unknown retry i status ostaju na originalnoj Page i telu posle promene defaults revizije', async () => {
  const h = harness(); pageContext(h); await uncertain(h);
  const original = h.of('save')[0], target = h.controller.model;
  h.context.pageDefaultsRevision++;
  h.context.period.dateTo = '2026-10-30';
  assert.equal(h.controller.close(), false);
  await h.controller.open();
  assert.equal(h.controller.model, target);
  pageContext(h, 'page/2');
  await h.controller.save(true);
  assert.equal(h.of('save').length, 1);
  h.reply('status', () => ({ status: 'notRecorded' }));
  await h.controller.status();
  assert.equal(h.of('status')[0].url, original.url.replace('/widgets', '/requests/status'));
  assert.equal(h.controller.model.saveState, 'unknown');
  pageContext(h);
  h.reply('save', () => receipt);
  await h.controller.save(true);
  assert.equal(h.of('save')[1].url, original.url);
  assert.equal(h.of('save')[1].options.body, original.options.body);
  assert.equal(h.controller.model.saveState, 'recorded');
});

test('legacy kontekst zadržava postojeću rutu i envelope', async () => {
  const h = harness(); await ready(h);
  assert.equal(h.of('preview')[0].url, '/api/training-load/dashboards/dashboard%2F1/simple/preview');
  assert.deepEqual(h.of('preview')[0].body.context, { kind: 'legacyDashboard', period, runtimeFilter: h.context.runtimeFilter });
});

test('opening a new draft selects no default metric and cannot advance, preview, or save', async () => {
  const h = harness(), c = h.controller;
  await c.open();
  assert.equal(Object.hasOwn(c.model.draft, 'metricRef'), false);
  assert.equal(c.model.selectedMetric, undefined);
  assert.equal(c.model.canSave, false);
  assert.deepEqual(c.model.draft.view, { type: 'table', groupBy: 'day' });
  c.next();
  await c.preview();
  await c.save();
  assert.equal(c.model.step, 1);
  assert.equal(h.of('preview').length, 0);
  assert.equal(h.of('save').length, 0);
  assert.equal(h.uuidCount, 1);
});

test('builtin selection tolerates null metadata and uses its explicit scope and aggregation', async () => {
  const h = harness(), c = h.controller;
  await c.open();
  c.selectMetric('builtin', builtin.key);
  assert.deepEqual(c.model.draft.metricRef, { kind: 'builtin', key: builtin.key });
  assert.equal(c.model.selectedMetric.unit, null);
  assert.equal(c.model.selectedMetric.description, null);
  assert.equal(c.model.draft.title, 'Load');
  assert.deepEqual(c.model.draft.view, { type: 'table', groupBy: 'day', dataScopeLevel: 'session', analyticalAggregation: 'sum' });
  await c.preview();
  assert.deepEqual(h.of('preview')[0].body.draft.metricRef, { kind: 'builtin', key: builtin.key });
});

test('custom selection never infers analytical aggregation from daily, default, or allowed metadata', async () => {
  const h = harness(), c = h.controller;
  await c.open();
  c.selectMetric('builtin', builtin.key);
  c.selectMetric('metric', custom.id);
  assert.deepEqual(c.model.draft.metricRef, { kind: 'metric', metricDefinitionId: custom.id });
  assert.deepEqual(c.model.draft.view, { type: 'table', groupBy: 'day', dataScopeLevel: 'session' });
  assert.equal(Object.hasOwn(c.model.draft.view, 'analyticalAggregation'), false);
  c.change(draft => { draft.view.analyticalAggregation = 'avg'; });
  await c.preview();
  assert.equal(h.of('preview')[0].body.draft.view.analyticalAggregation, 'avg');
});

test('custom metrics with multiple scopes require an explicit scope choice', async () => {
  const h = harness();
  h.reply('metrics', () => ({ metrics: [{ ...custom, scope_capabilities: ['day', 'session'] }] }));
  await h.controller.open();
  h.controller.selectMetric('metric', custom.id);
  assert.deepEqual(h.controller.model.draft.view, { type: 'table', groupBy: 'day' });
});

test('editing a custom metric outside the first catalog page fetches its exact ID and retains metadata and pagination', async () => {
  const h = harness(), c = h.controller, lookup = deferred();
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ ...clone(custom), id: `other-metric-${index}`, label: `Other metric ${index}` }));
  const exact = { ...clone(custom), label: 'Exact saved metric', description: null, unit: null, scope_capabilities: ['day', 'session'], allowed_aggregations: ['avg', 'last'] };
  h.reply('metrics', () => ({ metrics: clone(firstPage), nextCursor: 'page-2' }), () => lookup.promise);
  const operation = c.open(widget());
  await flush();
  const requests = h.of('metrics');
  assert.equal(requests.length, 2);
  assert.deepEqual([...new URL(requests[0].url, 'https://example.test').searchParams], [['search', ''], ['limit', '100']]);
  assert.equal(requests[1].options?.method ?? 'GET', 'GET');
  assert.equal(requests[1].options?.body, undefined);
  assert.equal(requests[1].url, `/api/training-load/dashboards/dashboard%2F1/simple/metrics?metricDefinitionId=${custom.id}`);
  assert.deepEqual([...new URL(requests[1].url, 'https://example.test').searchParams], [['metricDefinitionId', custom.id]]);
  assert.equal(c.model.selectedMetric, undefined);
  lookup.resolve({ metrics: [clone(exact)], nextCursor: null });
  await operation;
  assert.deepEqual(c.model.selectedMetric, exact);
  assert.deepEqual(c.model.metrics, [...firstPage, exact]);
  assert.equal(c.model.nextCursor, 'page-2');
  assert.equal(c.model.loading, false);
  assert.equal(c.model.error, '');
  assert.deepEqual(c.model.draft.metricRef, { kind: 'metric', metricDefinitionId: custom.id });
  assert.equal(c.model.draft.view.analyticalAggregation, 'avg');
  await c.preview();
  assert.deepEqual(c.model.selectedMetric, exact);
  assert.equal(h.of('preview')[0].body.draft.metricRef.metricDefinitionId, exact.id);
  assert.equal(h.of('metrics').length, 2);
});

test('editing a custom metric already present on the first page needs no exact lookup', async () => {
  const h = harness(), c = h.controller;
  await c.open(widget());
  assert.equal(h.of('metrics').length, 1);
  assert.equal(new URL(h.of('metrics')[0].url, 'https://example.test').searchParams.has('metricDefinitionId'), false);
  assert.deepEqual(c.model.selectedMetric, custom);
});

for (const key of ['period', 'runtimeFilter']) {
  test(`${key} changes after a valid preview prevent save POST before allocating a request ID`, async () => {
    const h = harness(), c = h.controller;
    await ready(h);
    const preview = clone(c.model.preview), input = clone(c.model.previewInput), count = h.calls.length, ids = h.uuidCount;
    if (key === 'period') h.context.period.dateTo = '2026-10-30';
    else h.context.runtimeFilter.athleteIds.push('athlete-2');
    assert.equal(c.model.canSave, true);
    await c.save();
    assert.equal(h.of('save').length, 0);
    assert.equal(h.calls.length, count);
    assert.equal(h.uuidCount, ids);
    assert.equal(c.model.pending, null);
    assert.equal(c.model.pendingBody, undefined);
    assert.equal(c.model.saveState, 'idle');
    assert.equal(c.model.canSave, false);
    assert.match(c.model.saveError, /filters changed.*Reopen/i);
    assert.deepEqual(c.model.preview, preview);
    assert.deepEqual(c.model.previewInput, input);
    assert.equal(h.saved.length, 0);
    await c.save();
    assert.equal(h.calls.length, count);
    assert.equal(h.uuidCount, ids);
  });
}

test('draft edits debounce preview and serialize requests while discarding the stale version', async () => {
  const h = harness(), c = h.controller, first = deferred(), second = deferred();
  await c.open();
  c.selectMetric('metric', custom.id);
  h.reply('preview', () => first.promise, () => second.promise);
  c.next(); c.next();
  await h.tick(349);
  assert.equal(h.of('preview').length, 0);
  await h.tick(1);
  assert.equal(h.of('preview').length, 1);
  const oldVersion = h.of('preview')[0].body.draftRef.draftVersion;
  c.change(draft => { draft.title = 'Intermediate'; });
  await h.tick(200);
  c.change(draft => { draft.title = 'Latest'; });
  await h.tick(349);
  assert.equal(h.of('preview').length, 1);
  await h.tick(1);
  await c.preview();
  assert.equal(h.of('preview').length, 1);
  assert.equal(c.model.previewLoading, true);
  first.resolve(validPreview({ previewToken: 'stale-token' }));
  await flush();
  assert.equal(c.model.preview, null);
  assert.equal(c.model.canSave, false);
  await h.tick(349);
  assert.equal(h.of('preview').length, 1);
  await h.tick(1);
  assert.equal(h.of('preview').length, 2);
  const latest = h.of('preview')[1].body;
  assert.equal(latest.draft.title, 'Latest');
  assert.equal(latest.draftRef.draftVersion, oldVersion + 2);
  second.resolve(validPreview({ previewToken: 'latest-token' }));
  await flush();
  assert.equal(c.model.preview.previewToken, 'latest-token');
  assert.equal(c.model.canSave, true);
  assert.equal(h.maxPreviews, 1);
  await h.tick(1000);
  assert.equal(h.of('preview').length, 2);
});

test('stale preview failures cannot erase a newer draft or show an obsolete error', async () => {
  const h = harness(), pending = deferred(), c = h.controller;
  await c.open(); c.selectMetric('metric', custom.id);
  h.reply('preview', () => pending.promise);
  const operation = c.preview();
  c.change(draft => { draft.title = 'New title'; });
  pending.reject(apiError(409, 'catalogChanged'));
  await operation;
  assert.equal(c.model.error, '');
  assert.equal(c.model.preview, null);
  assert.equal(c.model.draft.title, 'New title');
});

for (const key of ['identity', 'dashboardId', 'period', 'runtimeFilter']) {
  test(`preview results are ignored after ${key} changes in the surrounding context`, async () => {
    const h = harness(), pending = deferred(), c = h.controller;
    await c.open(); c.selectMetric('metric', custom.id);
    h.reply('preview', () => pending.promise);
    const operation = c.preview();
    h.context = { ...h.context, [key]: key === 'period' ? { ...period, dateTo: '2026-10-30' } : key === 'runtimeFilter' ? { athleteIds: ['athlete-2'] } : 'changed' };
    pending.resolve(validPreview());
    await operation;
    assert.equal(c.model.preview, null);
    assert.equal(c.model.previewInput, null);
    assert.equal(c.model.canSave, false);
  });
}

test('a preview from a closed editor cannot populate a reopened editor', async () => {
  const h = harness(), pending = deferred(), c = h.controller;
  await c.open(); c.selectMetric('metric', custom.id);
  h.reply('preview', () => pending.promise);
  const operation = c.preview();
  assert.equal(c.close(), true);
  await c.open();
  const reopened = c.model;
  pending.resolve(validPreview());
  await operation;
  assert.equal(c.model, reopened);
  assert.equal(c.model.preview, undefined);
  assert.equal(c.model.canSave, false);
  assert.equal(c.model.draft.draftId, 'id-2');
});

test('catalog responses from an obsolete search cannot replace the latest search', async () => {
  const h = harness(), old = deferred(), latest = deferred(), c = h.controller;
  await c.open();
  h.reply('metrics', () => old.promise, () => latest.promise);
  c.search('old'); await h.tick(350);
  c.search('latest'); await h.tick(350);
  latest.resolve({ metrics: [{ ...custom, label: 'Latest' }], nextCursor: 'next' });
  await flush();
  old.resolve({ metrics: [{ ...custom, label: 'Obsolete' }], nextCursor: 'old-next' });
  await flush();
  assert.equal(c.model.metrics[0].label, 'Latest');
  assert.equal(c.model.nextCursor, 'next');
  assert.equal(c.model.loading, false);
  assert.match(h.of('metrics').at(-1).url, /search=latest/);
});

test('catalog responses are ignored after context changes', async () => {
  const h = harness(), pending = deferred(), c = h.controller;
  await c.open();
  const original = clone(c.model.metrics);
  h.reply('metrics', () => pending.promise);
  const operation = c.metrics();
  h.context = { ...h.context, identity: 'another-coach' };
  pending.resolve({ metrics: [{ ...custom, label: 'Wrong context' }], nextCursor: 'wrong' });
  await operation;
  assert.deepEqual(c.model.metrics, original);
  assert.equal(c.model.nextCursor, null);
});

test('capability responses are ignored after context changes', async () => {
  const h = harness(), pending = deferred();
  h.reply('capabilities', () => pending.promise);
  const operation = h.controller.open();
  h.context = { ...h.context, dashboardId: 'another-dashboard' };
  pending.resolve(clone(capabilities));
  await operation;
  assert.equal(h.controller.model.capabilities, undefined);
  assert.equal(h.of('metrics').length, 0);
});

test('transport response loss retries the original frozen JSON, request ID, issued time and preview input', async () => {
  const h = harness(), c = h.controller;
  await uncertain(h);
  const first = h.of('save')[0], original = clone(first.body);
  assert.equal(first.url, '/api/training-load/dashboards/dashboard%2F1/simple/widgets');
  assert.equal(first.options.method, 'POST');
  assert.equal(original.requestId, 'id-2');
  assert.equal(original.requestIssuedAt, '2026-11-03T12:00:00.000Z');
  assert.equal(original.previewToken, 'preview-token');
  assert.deepEqual(original.resolvedPeriod, period);
  assert.deepEqual(original.input, h.of('preview')[0].body);
  c.model.preview.requestIssuedAt = '2099-01-01T00:00:00.000Z';
  c.model.preview.previewToken = 'replacement';
  c.model.preview.resolvedPeriod.dateFrom = '2099-01-01';
  c.model.previewInput.draft.title = 'Changed live input';
  assert.deepEqual(c.model.pending, original);
  h.reply('save', () => clone(receipt));
  await c.save(true);
  assert.equal(h.of('save')[1].options.body, first.options.body);
  assert.equal(h.of('save')[1].url, first.url);
  assert.equal(h.of('save')[1].options.method, first.options.method);
  assert.equal(h.uuidCount, 2);
  assert.equal(c.model.saveState, 'recorded');
  assert.deepEqual(c.model.receipt, receipt);
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.saved[0][0], receipt);
});

for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'notFound']]) {
  test(`a first ${status} save response retains an unknown outcome and the exact recovery envelope`, async () => {
    const h = harness(), c = h.controller;
    await ready(h);
    h.reply('save', () => Promise.reject(apiError(status, code)));
    await c.save();
    const original = h.of('save')[0];
    assert.equal(c.model.saveState, 'unknown');
    assert.equal(c.pending, true);
    assert.equal(c.model.canSave, false);
    assert.equal(c.model.pendingBody, original.options.body);
    assert.deepEqual(c.model.pending, original.body);
    assert.equal(c.close(), false);
    const draft = clone(c.model.draft);
    c.change(value => { value.title = 'Forbidden new intent'; });
    await c.save();
    assert.deepEqual(c.model.draft, draft);
    assert.equal(h.of('save').length, 1);
    h.reply('status', () => Promise.reject(apiError(status, code)));
    await c.status();
    assert.equal(c.model.saveState, 'unknown');
    assert.equal(c.model.checkingStatus, false);
    assert.equal(c.model.pendingBody, original.options.body);
    assert.deepEqual(h.of('status')[0].body, { requestId: original.body.requestId });
    h.reply('save', () => Promise.reject(apiError(status, code)));
    await c.save(true);
    assert.equal(c.model.saveState, 'unknown');
    assert.equal(h.of('save')[1].options.body, original.options.body);
    assert.equal(c.model.pendingBody, original.options.body);
    assert.equal(h.uuidCount, 2);
    assert.equal(h.saved.length, 0);
    assert.equal(c.close(), false);
  });
}

test('unchanged title and view mutations retain the valid preview without scheduling another request', async () => {
  const h = harness(), c = h.controller;
  await ready(h);
  const draft = clone(c.model.draft), preview = c.model.preview, input = c.model.previewInput, count = h.calls.length;
  c.change(value => { value.title = draft.title; });
  c.change(value => { value.view = clone(draft.view); });
  assert.deepEqual(c.model.draft, draft);
  assert.equal(c.model.preview, preview);
  assert.equal(c.model.previewInput, input);
  assert.equal(c.model.canSave, true);
  await h.tick(1000);
  assert.equal(h.calls.length, count);
});

test('selecting the same metric preserves explicit view choices, version and valid preview', async () => {
  const h = harness(), c = h.controller;
  await ready(h);
  c.change(draft => { draft.view.type = 'line_chart'; draft.view.groupBy = 'week'; });
  await c.preview();
  const draft = clone(c.model.draft), preview = c.model.preview, input = c.model.previewInput, count = h.calls.length;
  c.selectMetric('metric', custom.id);
  assert.deepEqual(c.model.draft, draft);
  assert.equal(c.model.preview, preview);
  assert.equal(c.model.previewInput, input);
  assert.equal(c.model.canSave, true);
  await h.tick(1000);
  assert.equal(h.calls.length, count);
});

test('notRecorded keeps the save unknown and retries reuse its ID instead of starting a new save', async () => {
  const h = harness(), c = h.controller;
  await uncertain(h);
  const body = h.of('save')[0].options.body;
  h.reply('status', () => ({ status: 'notRecorded' }), () => ({ status: 'notRecorded' }));
  await c.status(); await c.status();
  assert.equal(c.model.saveState, 'unknown');
  assert.equal(c.model.canSave, false);
  assert.equal(c.pending, true);
  assert.equal(simpleSaveIsPending(c.model), true);
  assert.match(c.model.saveError, /does not confirm rollback/);
  assert.deepEqual(h.of('status').map(call => call.body), [{ requestId: 'id-2' }, { requestId: 'id-2' }]);
  await c.save();
  assert.equal(h.of('save').length, 1);
  h.reply('save', () => Promise.reject(apiError(409, 'catalogChanged')));
  await c.save(true);
  assert.equal(c.model.saveState, 'unknown');
  assert.equal(h.of('save')[1].options.body, body);
  assert.equal(h.uuidCount, 2);
  assert.equal(h.saved.length, 0);
});

test('unknown saves block every edit, navigation, close and replacement open', async () => {
  const h = harness(), c = h.controller;
  await uncertain(h);
  const target = c.model, draft = clone(target.draft), count = h.calls.length, paints = h.paints.length;
  let mutated = false;
  c.change(() => { mutated = true; });
  c.selectMetric('builtin', builtin.key);
  c.search('replacement'); c.back(); c.next();
  await c.metrics(); await c.preview(); await c.save();
  assert.equal(c.close(), false);
  await c.open(widget());
  await h.tick(1000);
  assert.equal(mutated, false);
  assert.equal(c.model, target);
  assert.deepEqual(target.draft, draft);
  assert.equal(target.step, 3);
  assert.equal(target.search, '');
  assert.equal(h.calls.length, count);
  assert.equal(h.paints.length, paints);
  assert.equal(h.uuidCount, 2);
});

test('status receipt completes an uncertain save exactly once and releases the close lock', async () => {
  const h = harness(), c = h.controller, pending = deferred();
  await uncertain(h);
  h.reply('status', () => pending.promise);
  const operation = c.status();
  await c.status(); await c.save(true);
  assert.equal(h.of('status').length, 1);
  assert.equal(h.of('save').length, 1);
  assert.equal(c.model.checkingStatus, true);
  pending.resolve({ status: 'recorded', receipt: clone(receipt) });
  await operation;
  assert.equal(c.model.saveState, 'recorded');
  assert.equal(c.model.checkingStatus, false);
  assert.equal(c.pending, false);
  assert.equal(c.model.saveError, '');
  assert.deepEqual(c.model.receipt, receipt);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0][1], c.model);
  await c.status(); await c.save(true); await c.save();
  assert.equal(h.saved.length, 1);
  assert.equal(c.close(), true);
  assert.equal(c.model, null);
  assert.equal(h.paints.at(-1), null);
});

test('recorded receipts leave the save action disabled', async () => {
  const h = harness(), c = h.controller;
  await uncertain(h);
  h.reply('status', () => ({ status: 'recorded', receipt }));
  await c.status();
  assert.equal(c.model.saveState, 'recorded');
  assert.equal(c.model.canSave, false);
});

test('queued previews survive reopening without overlapping or applying the closed editor result', async () => {
  const h = harness(), c = h.controller, old = deferred(), latest = deferred();
  await c.open(); c.selectMetric('metric', custom.id);
  h.reply('preview', () => old.promise, () => latest.promise);
  const operation = c.preview();
  c.close();
  await c.open(); c.selectMetric('metric', custom.id);
  c.next(); c.next();
  await h.tick(350);
  assert.equal(h.of('preview').length, 1);
  old.resolve(validPreview({ previewToken: 'closed-editor' }));
  await operation;
  assert.equal(c.model.preview, null);
  await h.tick(350);
  assert.equal(h.of('preview').length, 2);
  assert.equal(h.of('preview')[1].body.draftRef.draftId, c.model.draft.draftId);
  latest.resolve(validPreview({ previewToken: 'reopened-editor' }));
  await flush();
  assert.equal(c.model.preview.previewToken, 'reopened-editor');
  assert.equal(h.maxPreviews, 1);
});

test('period drift during an in-flight save permits exact-envelope retry and status receipt recovery', async () => {
  const h = harness(), c = h.controller, pending = deferred(), status = deferred();
  await ready(h);
  h.reply('save', () => pending.promise);
  const operation = c.save(), original = clone(h.of('save')[0]);
  assert.equal(c.model.saveState, 'saving');
  h.context.period.dateTo = '2026-10-30';
  pending.reject(new TypeError('Committed response lost after period changed'));
  await operation;
  assert.equal(c.model.saveState, 'unknown');
  assert.equal(c.pending, true);
  assert.equal(c.model.canSave, false);
  assert.equal(c.model.pendingBody, original.options.body);
  assert.equal(c.close(), false);
  await c.save();
  assert.equal(h.of('save').length, 1);
  h.reply('save', () => Promise.reject(new TypeError('Retry response also lost')));
  await c.save(true);
  const retry = h.of('save')[1];
  assert.ok(retry);
  assert.equal(retry.options.body, original.options.body);
  assert.equal(retry.options.method, original.options.method);
  assert.equal(retry.url, original.url);
  assert.deepEqual(retry.body, original.body);
  assert.deepEqual(retry.body.input.context.period, period);
  assert.deepEqual(retry.body.resolvedPeriod, period);
  assert.equal(h.uuidCount, 2);
  assert.equal(c.model.saveState, 'unknown');
  assert.equal(h.saved.length, 0);
  h.reply('status', () => status.promise);
  const recovery = c.status();
  assert.deepEqual(h.of('status')[0].body, { requestId: original.body.requestId });
  h.context.period.dateFrom = '2026-10-02';
  status.resolve({ status: 'recorded', receipt: clone(receipt) });
  await recovery;
  assert.equal(c.model.saveState, 'recorded');
  assert.deepEqual(c.model.receipt, receipt);
  assert.equal(c.model.checkingStatus, false);
  assert.equal(c.model.canSave, false);
  assert.equal(c.pending, false);
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.saved[0][0], receipt);
  assert.equal(h.saved[0][1], c.model);
  assert.equal(h.of('preview').length, 1);
  assert.equal(h.of('save').length, 2);
  assert.equal(h.of('status').length, 1);
  assert.equal(h.uuidCount, 2);
  assert.equal(c.close(), true);
});

test('save receipts from a changed identity do not complete or notify the current editor', async () => {
  const h = harness(), c = h.controller, pending = deferred();
  await ready(h);
  h.reply('save', () => pending.promise);
  const operation = c.save();
  h.context = { ...h.context, identity: 'another-coach' };
  pending.resolve(receipt);
  await operation;
  assert.equal(c.model.receipt, undefined);
  assert.equal(h.saved.length, 0);
  assert.equal(h.paints.some(model => model?.saveState === 'recorded'), false);
});

for (const [status, code] of [[503, 'saveUnavailable'], [409, 'requestInProgress']]) {
  test(`${status} ${code} is an uncertain save and retains the same request for retry`, async () => {
    const h = harness(), c = h.controller;
    await ready(h);
    h.reply('save', () => Promise.reject(apiError(status, code)));
    await c.save();
    assert.equal(c.model.saveState, 'unknown');
    assert.equal(c.model.canSave, false);
    const body = h.of('save')[0].options.body;
    h.reply('save', () => receipt);
    await c.save(true);
    assert.equal(h.of('save')[1].options.body, body);
    assert.equal(h.uuidCount, 2);
    assert.equal(c.model.saveState, 'recorded');
  });
}

test('status transport failures retain the unknown request and permit another status check', async () => {
  const h = harness(), c = h.controller;
  await uncertain(h);
  const body = c.model.pendingBody;
  h.reply('status', () => Promise.reject(new TypeError('Offline')), () => ({ status: 'recorded', receipt }));
  await c.status();
  assert.equal(c.model.saveState, 'unknown');
  assert.equal(c.model.checkingStatus, false);
  assert.equal(c.model.pendingBody, body);
  assert.match(c.model.saveError, /Status could not be confirmed/);
  await c.status();
  assert.equal(c.model.saveState, 'recorded');
  assert.equal(h.uuidCount, 2);
});

test('an in-flight save blocks duplicate submits, edits and close', async () => {
  const h = harness(), c = h.controller, pending = deferred();
  await ready(h);
  h.reply('save', () => pending.promise);
  const operation = c.save(), draft = clone(c.model.draft);
  assert.equal(c.model.saveState, 'saving');
  assert.equal(c.pending, true);
  c.change(value => { value.title = 'Forbidden'; });
  await c.save(); await c.save(true); await c.status();
  assert.equal(c.close(), false);
  assert.deepEqual(c.model.draft, draft);
  assert.equal(h.of('save').length, 1);
  pending.resolve(receipt);
  await operation;
  assert.equal(c.model.saveState, 'recorded');
});

test('staleRevision cannot overwrite the widget or retry and requires reopening with the new revision', async () => {
  const h = harness(), c = h.controller, original = widget(), snapshot = clone(original);
  await ready(h, original);
  h.reply('save', () => Promise.reject(apiError(409, 'staleRevision')));
  await c.save();
  assert.equal(c.model.stale, true);
  assert.equal(c.model.saveState, 'idle');
  assert.equal(c.model.canSave, false);
  assert.equal(c.model.pending, null);
  assert.equal(c.model.pendingBody, null);
  assert.match(c.model.saveError, /Reopen/);
  assert.deepEqual(original, snapshot);
  const draft = clone(c.model.draft);
  c.change(value => { value.title = 'Overwrite'; });
  await c.save(); await c.save(true);
  assert.deepEqual(c.model.draft, draft);
  assert.equal(h.of('save').length, 1);
  assert.equal(h.saved.length, 0);
  assert.equal(c.close(), true);
  await ready(h, widget({ revision: 8 }));
  h.reply('save', () => receipt);
  await c.save();
  assert.equal(h.of('save')[1].body.input.editTarget.expectedWidgetRevision, 8);
  assert.notEqual(h.of('save')[1].body.requestId, h.of('save')[0].body.requestId);
  assert.equal(c.model.saveState, 'recorded');
});

test('editing preserves display and presentation sidecars and sends the original widget revision', async () => {
  const h = harness(), c = h.controller, source = widget(), snapshot = clone(source);
  await ready(h, source);
  assert.deepEqual(c.model.draft.display, { mode: 'preserve' });
  assert.deepEqual(c.model.draft.presentation, { mode: 'preserve' });
  assert.deepEqual(c.model.draft.athleteSelection, { mode: 'selected', athleteIds: ['athlete-1'] });
  assert.deepEqual(c.model.draft.advancedFilter, { activity: { mode: 'clear' }, component: { mode: 'selected', id: 'component-1' } });
  c.change(draft => { draft.title = 'Edited'; draft.athleteSelection.athleteIds.push('athlete-2'); });
  await c.preview();
  h.reply('save', () => receipt);
  await c.save();
  const call = h.of('save')[0];
  assert.equal(call.options.method, 'PUT');
  assert.match(call.url, /\/widgets\/widget%2F1$/);
  assert.deepEqual(call.body.input.editTarget, { widgetId: source.id, expectedWidgetRevision: 7 });
  assert.deepEqual(call.body.input.draft.display, { mode: 'preserve' });
  assert.deepEqual(call.body.input.draft.presentation, { mode: 'preserve' });
  assert.deepEqual(source, snapshot);
});

test('multi-series widgets require advanced editing and cannot preview or save', async () => {
  const h = harness(), c = h.controller, source = widget();
  source.series.push({ ...source.series[0], metric_definition_id: 'metric-2' });
  const snapshot = clone(source);
  assert.equal(simpleDraftFromWidget(source, () => 'unused'), null);
  await c.open(source);
  assert.equal(c.model.advancedRequired, true);
  assert.equal(c.model.draft, null);
  assert.equal(c.model.canSave, false);
  c.next(); c.change(() => assert.fail('Advanced widgets cannot be mutated'));
  await c.preview(); await c.save();
  assert.equal(h.of('metrics').length, 0);
  assert.equal(h.of('preview').length, 0);
  assert.equal(h.of('save').length, 0);
  assert.deepEqual(source, snapshot);
});

test('server advancedRequired previews never enable simple saving', async () => {
  const h = harness(), c = h.controller;
  await c.open(); c.selectMetric('metric', custom.id);
  h.reply('preview', () => ({ status: 'advancedRequired', reasons: ['multiSeries'] }));
  await c.preview();
  assert.equal(c.model.advancedRequired, true);
  assert.equal(c.model.canSave, false);
  await c.save();
  assert.equal(h.of('save').length, 0);
});

test('an advancedRequired result does not survive a changed draft with a valid preview', async () => {
  const h = harness(), c = h.controller;
  await c.open(); c.selectMetric('metric', custom.id);
  h.reply('preview', () => ({ status: 'advancedRequired', issues: [{ code: 'unsupportedComposition' }] }));
  await c.preview();
  assert.equal(c.model.advancedRequired, true);
  assert.equal(c.model.canSave, false);
  const oldVersion = c.model.draft.draftVersion;
  c.change(draft => { draft.view = { type: 'table', groupBy: 'day', dataScopeLevel: 'session', analyticalAggregation: 'avg' }; });
  await c.preview();
  assert.equal(c.model.draft.draftVersion, oldVersion + 1);
  assert.equal(c.model.preview.status, 'valid');
  assert.equal(c.model.advancedRequired, false);
  assert.equal(c.model.canSave, true);
  assert.equal(h.of('preview').length, 2);
});

test('a valid preview still requires atomic-save capability and a preview token', async () => {
  const h = harness(), c = h.controller;
  h.reply('capabilities', () => ({ ...clone(capabilities), capabilities: { preview: true, atomicSave: false } }));
  await c.open(); c.selectMetric('metric', custom.id);
  await c.preview(); await c.save();
  assert.equal(c.model.canSave, false);
  assert.equal(h.of('save').length, 0);
  c.model.capabilities.capabilities.atomicSave = true;
  h.reply('preview', () => validPreview({ previewToken: null }));
  await c.preview(); await c.save();
  assert.equal(c.model.canSave, false);
  assert.equal(h.of('save').length, 0);
});
