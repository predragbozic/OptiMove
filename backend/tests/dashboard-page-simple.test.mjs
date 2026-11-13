import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { id, draft, context, snapshot } from './fixtures/dashboard-simple/contracts.mjs';
import { loadSimplePageTarget, simplePageDefaults, simplePagePeriod } from '../src/dashboardSimple/pageContext.js';
import { compileSimpleDraft } from '../src/dashboardSimple/compiler.js';
import { buildSimplePreviewBinding } from '../src/dashboardSimple/previewBinding.js';
import { createPreviewTokenService } from '../src/dashboardSimple/previewTokens.js';
import { createSimplePreviewRouter } from '../src/dashboardSimple/previewRouter.js';
import { createSimpleSaveRouter } from '../src/dashboardSimple/saveRouter.js';

const period = context().period;
const config = { schemaVersion: 1, mode: 'fixed', ...period };
const page = () => ({ id: id(20), dashboard_id: id(2), revision: 5, layout_revision: 3, defaults_revision: 2, default_filter: { athleteIds: [id(7)] }, period_config: config, period_origin: 'configured' });
const target = () => ({ req: { user: { id: id(3) } }, workspace: { dataWorkspaceType: 'private_coach' }, dashboard: { id: id(2), pages_revision: 2, default_filter: { athleteIds: [id(8)], activityId: id(9) } }, page: page() });
const envelope = () => ({ contractVersion: 1, context: { kind: 'page', pageId: id(20) }, draftRef: { draftId: id(1), draftVersion: 1 }, draft: draft(), editTarget: null });
const evaluatedAt = '2026-11-04T12:00:00.000Z';
function binding(t = target(), e = envelope()) {
  const c = { ...context(), defaultFilter: simplePageDefaults(t), runtimeFilter: {}, authorizedFilterIds: { activityId: [id(9)], componentId: [] }, period, evaluatedAt };
  const compiled = compileSimpleDraft(e.draft, snapshot(), c, null);
  assert.equal(compiled.status, 'valid');
  return buildSimplePreviewBinding({ target: t, envelope: e, existing: null, compiled, context: c, evaluatedAt });
}

test('Page target comes from the scoped route and uses the dashboard parent', async () => {
  const calls = [], t = target();
  const query = async (sql, args) => { calls.push({ sql, args }); return { rows: sql.includes('to_regprocedure') ? [{ ready: true }] : [t.page] }; };
  const result = await loadSimplePageTarget(query, t, { pageId: id(20), context: envelope().context, lock: true });
  assert.equal(result.page.id, id(20));
  assert.deepEqual(calls[0].args, [id(2), id(20)]);
  assert.match(calls[0].sql, /for update$/);
  await assert.rejects(loadSimplePageTarget(query, t, { pageId: id(21), context: envelope().context }), { code: 'notFound' });
  await assert.rejects(loadSimplePageTarget(query, t, { pageId: id(20), context: { kind: 'legacyDashboard', period } }), { code: 'notFound' });
  await assert.rejects(loadSimplePageTarget(async () => ({ rows: [] }), t, { pageId: id(20) }), { code: 'notFound' });
});

test('Page editor fails closed before v57 and tagged bodies cannot upgrade legacy routes', async () => {
  const t = target();
  await assert.rejects(loadSimplePageTarget(async sql => ({ rows: sql.includes('to_regprocedure') ? [{ ready: false }] : [page()] }), t, { pageId: id(20) }), { code: 'pagesUnavailable' });
  await assert.rejects(loadSimplePageTarget(async () => ({ rows: [{ id: id(20) }] }), t, { context: envelope().context }), { code: 'pagesClientRequired' });
});

test('Page defaults merge before runtime and preserve explicit clears', () => {
  const t = target();
  assert.deepEqual(simplePageDefaults(t), { athleteIds: [id(7)], activityId: id(9) });
  t.page.default_filter = { athleteIds: null, activityId: null };
  assert.deepEqual(simplePageDefaults(t), { athleteIds: null, activityId: null });
  assert.deepEqual(t.dashboard.default_filter, { athleteIds: [id(8)], activityId: id(9) });
});

test('Page period uses server defaults, explicit runtime, or explicit replacement without inventing legacy dates', () => {
  const t = target(), e = envelope();
  assert.deepEqual(simplePagePeriod(t, e, evaluatedAt), period);
  t.page.period_config = { schemaVersion: 1, mode: 'relative', preset: 'today', timeZone: 'Europe/Belgrade' };
  assert.deepEqual(simplePagePeriod(t, e, evaluatedAt), { dateFrom: '2026-11-04', dateTo: '2026-11-04', timeZone: 'Europe/Belgrade' });
  e.context.period = period;
  assert.deepEqual(simplePagePeriod(t, e, evaluatedAt), period);
  delete e.context.period;
  t.page.period_config = null;
  assert.throws(() => simplePagePeriod(t, e, evaluatedAt), { code: 'pagePeriodRequired' });
  e.draft.periodIntent = { mode: 'replacePageRuntime', periodConfig: config };
  assert.equal(simplePagePeriod(t, e, evaluatedAt), undefined);
});

test('Page token binds identity and defaults, including defaults masked by runtime', () => {
  const token = createPreviewTokenService({ keyId: 'test', key: Buffer.alloc(32, 1), now: () => Date.parse(evaluatedAt) });
  const original = binding(), proof = token.issue(original).previewToken;
  assert.equal(original.target.pageId, id(20));
  for (const change of [t => { t.page.id = id(21); }, t => { t.page.defaults_revision++; }, t => { t.page.default_filter = {}; }, t => { t.page.period_origin = 'legacyRuntime'; }]) {
    const t = target(); change(t);
    assert.throws(() => token.verify(proof, binding(t)), { code: 'previewRequired', reason: 'bindingChanged' });
  }
});

test('Unrelated Page aggregate/layout revisions do not invalidate a widget preview', () => {
  const a = binding(), t = target();
  t.page.revision += 10; t.page.layout_revision += 20; t.dashboard.pages_revision++;
  assert.deepEqual(binding(t), a);
});

test('Legacy tokens keep their exact previous target shape', () => {
  const t = target(); delete t.page;
  const b = binding(t), token = createPreviewTokenService({ keyId: 'test', key: Buffer.alloc(32, 1), now: () => Date.parse(evaluatedAt) });
  assert.deepEqual(Object.keys(b.target), ['dashboardId', 'widgetId', 'widgetRevision']);
  token.verify(token.issue(b).previewToken, b);
});

test('Explicit Page defaults save has a narrow compiler capability without enabling all Pages', () => {
  const d = draft(); d.periodIntent = { mode: 'replacePageRuntime', periodConfig: config, savePageDefaults: true };
  const s = snapshot(), c = context();
  assert.equal(compileSimpleDraft(d, s, c).status, 'invalid');
  s.capabilities.pageDefaultsSave = true;
  assert.equal(s.capabilities.pages, false);
  assert.equal(compileSimpleDraft(d, s, c).status, 'valid');
});

test('Page HTTP adapters forward route identity for preview, save and status', async t => {
  const calls = [], service = Object.fromEntries(['capabilities', 'metrics', 'validate', 'preview', 'save', 'status'].map(action => [action, async args => { calls.push({ action, args }); return { ok: true }; }]));
  const app = express(); app.use((req, res, next) => { req.user = { id: id(3) }; next(); });
  app.use('/dashboards/:dashboardId/pages/:pageId/simple', createSimplePreviewRouter({ service }), createSimpleSaveRouter({ service }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const root = `http://127.0.0.1:${server.address().port}/dashboards/${id(2)}/pages/${id(20)}/simple`;
  for (const [path, body] of [['/preview', envelope()], ['/widgets', {}], ['/requests/status', { requestId: id(30) }]]) {
    const r = await fetch(root + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.status, 200);
  }
  assert.deepEqual(calls.map(c => [c.action, c.args.dashboardId, c.args.pageId]), [['preview', id(2), id(20)], ['save', id(2), id(20)], ['status', id(2), id(20)]]);
});
