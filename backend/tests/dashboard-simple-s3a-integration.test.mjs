import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { id, draft, builtins, snapshot, context } from './fixtures/dashboard-simple/contracts.mjs';

if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  test('S3a routes and capabilities with an isolated database mock', () => {
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-isolation=none', fileURLToPath(import.meta.url)], { encoding: 'utf8' });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  mock.module('../src/db.js', { namedExports: { query: async () => assert.fail('Unexpected default database access') } });
  const { createSimplePreviewService } = await import('../src/dashboardSimple/previewService.js');
  const { createSimplePreviewRouter } = await import('../src/dashboardSimple/previewRouter.js');
  const { createSimpleRuntime, SIMPLE_MIGRATION_NAME, SIMPLE_MIGRATION_SHA256 } = await import('../src/dashboardSimple/runtime.js');
  const dashboard = { id: id(2), owner_scope: 'user', owner_user_id: id(3), data_workspace_type: 'private_coach', data_workspace_scope_id: null, status: 'active', is_template: false, revision: 1, default_filter: {} };
  const req = { user: { id: id(3) } };
  const metricRows = Array.from({ length: 101 }, (_, index) => ({ id: id(index + 10), key: `metric-${index}`, label: `Metric ${index}`, value_type: 'numeric', unit: null, scope_capabilities: ['session'] }));
  const envelope = () => ({ contractVersion: 1, context: { kind: 'legacyDashboard', period: context().period }, draftRef: { draftId: id(1), draftVersion: 1 }, draft: draft(), editTarget: null });
  function fixture(options = {}) {
    const calls = [], releases = [];
    let checkouts = 0;
    const pool = { connect(callback) {
      checkouts++;
      const client = new EventEmitter();
      client.query = async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('from public.schema_migrations')) return { rows: [{ migration_name: SIMPLE_MIGRATION_NAME, checksum: SIMPLE_MIGRATION_SHA256 }] };
        if (sql.includes('information_schema.columns')) return { rows: [{ presentation: true, receipts: true, writer: true }] };
        if (sql.includes('from public.users')) return { rows: options.inactiveUser ? [] : [{ id: id(3), is_active: true }] };
        if (sql.includes('from public.user_global_roles')) return { rows: [{ role: 'independent_coach' }] };
        if (sql.includes('from public.user_workspace_preferences')) return { rows: options.noWorkspace ? [] : [{ workspace_type: 'private_coach', scope_id: null }] };
        if (sql.includes('from public.user_club_roles') || sql.includes('from public.user_team_roles') || sql.includes('from public.athletes')) return { rows: [] };
        if (sql.includes('from training_load.dashboards')) return { rows: options.missing ? [] : [{ ...dashboard, ...options.dashboard }] };
        if (sql.includes('from training_load.metric_definitions')) {
          if (options.metricError) throw options.metricError;
          if (sql.includes('d.id=$5')) {
            const metric = options.exactMetric === undefined ? metricRows.at(-1) : options.exactMetric;
            return { rows: metric?.id === params[4]?.toLowerCase() ? [metric] : [] };
          }
          return { rows: metricRows.filter(row => !params[6] || row.id > params[6]).slice(0, params[7]) };
        }
        if (sql.includes('from training_load.dashboard_widget_types')) return { rows: snapshot().widgetTypes };
        if (sql.includes('from training_load.dashboard_builtin_series')) return { rows: builtins() };
        if (sql.startsWith('begin ') || sql.startsWith('set local ') || sql === 'rollback') return { rows: [] };
        assert.fail(`Unexpected fixture query: ${sql}`);
      };
      client.release = destroy => releases.push(destroy);
      callback(null, client);
    } };
    return { pool, calls, releases, get checkouts() { return checkouts; } };
  }
  const serviceFor = (f, extra = {}) => createSimplePreviewService({ pool: f.pool, queryDashboard: async () => assert.fail('Metrics must not query measurements'), ...extra });
  async function serve(t, router, authenticated = true) {
    const app = express();
    app.use((request, response, next) => { if (authenticated) request.user = req.user; next(); });
    app.use('/dashboards/:dashboardId/simple', router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
    return async (path, options) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/dashboards/${id(2)}/simple${path}`, options);
      return { status: response.status, body: await response.json() };
    };
  }

  test('GET metrics authenticates before query details or database checkout', async t => {
    const f = fixture();
    const request = await serve(t, createSimplePreviewRouter({ service: serviceFor(f) }), false);
    assert.deepEqual(await request('/metrics?limit=invalid'), { status: 401, body: { error: 'unauthorized' } });
    assert.deepEqual(await request('/metrics?metricDefinitionId=invalid'), { status: 401, body: { error: 'unauthorized' } });
    assert.equal(f.checkouts, 0);
  });

  test('target authorization and eligibility precede malformed query details', async t => {
    for (const [options, status, error] of [
      [{ missing: true }, 404, 'notFound'], [{ inactiveUser: true }, 404, 'notFound'],
      [{ dashboard: { owner_user_id: id(99) } }, 404, 'notFound'],
      [{ dashboard: { data_workspace_type: 'club', data_workspace_scope_id: id(4) } }, 404, 'notFound'],
      [{ noWorkspace: true }, 409, 'workspaceSelectionRequired'],
      [{ dashboard: { status: 'archived' } }, 409, 'dashboardArchived'],
      [{ dashboard: { is_template: true } }, 409, 'templateRequiresClone'],
    ]) {
      const f = fixture(options);
      const request = await serve(t, createSimplePreviewRouter({ service: serviceFor(f) }));
      assert.deepEqual(await request('/metrics?limit=invalid'), { status, body: { error } });
      assert.deepEqual(await request('/metrics?metricDefinitionId=invalid'), { status, body: { error } });
      assert.ok(!f.calls.some(call => call.sql.includes('from training_load.metric_definitions')));
      assert.equal(f.calls.at(-1).sql, 'rollback');
      assert.deepEqual(f.releases, [false, false]);
    }
  });

  test('GET metrics rejects unknown, repeated, nested and coercible query values after authorization', async t => {
    const f = fixture();
    const request = await serve(t, createSimplePreviewRouter({ service: serviceFor(f) }));
    for (const query of ['limit=', 'limit=0', 'limit=101', 'limit=-1', 'limit=1.0', 'limit=1e2', 'limit=01', 'limit=%201', 'limit=1x', 'limit=1&limit=2', 'limit[x]=1', 'search[x]=y', 'search=a&search=b', `search=${'x'.repeat(201)}`, 'afterId=', 'afterId=bad', `afterId=${id(10)}&afterId=${id(11)}`, 'dataScopeLevel=', 'dataScopeLevel=DAY', 'dataScopeLevel=session&dataScopeLevel=day', 'workspaceId=foreign']) {
      assert.deepEqual(await request(`/metrics?${query}`), { status: 400, body: { error: 'invalidRequest' } }, query);
    }
    assert.ok(f.calls.some(call => call.sql.includes('from training_load.dashboards')));
    assert.ok(!f.calls.some(call => call.sql.includes('from training_load.metric_definitions')));
    assert.equal(f.checkouts, f.releases.length);
  });

  test('metrics uses one bounded read-only snapshot, target-scoped SQL and stable cursor paging', async t => {
    const f = fixture();
    const request = await serve(t, createSimplePreviewRouter({ service: serviceFor(f) }));
    const first = await request('/metrics');
    assert.equal(first.status, 200);
    assert.equal(first.body.metrics.length, 100);
    assert.equal(first.body.nextCursor, id(109));
    assert.equal(first.body.metrics[0].unit, null);
    assert.deepEqual(first.body.metrics[0].allowed_aggregations, ['sum', 'avg', 'max', 'last', 'none']);
    assert.equal(f.checkouts, 1);
    assert.equal(f.calls[0].sql, 'begin isolation level repeatable read read only');
    assert.equal(f.calls.at(-1).sql, 'rollback');
    const metricCall = f.calls.find(call => call.sql.includes('from training_load.metric_definitions'));
    assert.deepEqual(metricCall.params, ['user', id(3), 'private_coach', null, ['numeric', 'boolean', 'text'], '', null, 101, null]);
    assert.ok(metricCall.sql.indexOf('d.owner_scope') < metricCall.sql.indexOf('order by d.id limit'));
    const timeouts = f.calls.filter(call => call.sql.startsWith('set local')).map(call => Number(/'(\d+)ms'/.exec(call.sql)[1]));
    assert.ok(timeouts.length > 0 && timeouts.every(value => value > 0 && value <= 3000));
    const second = await request(`/metrics?afterId=${first.body.nextCursor}&limit=1&dataScopeLevel=session&search=${encodeURIComponent("' or true --")}`);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body.metrics.map(row => row.id), [id(110)]);
    assert.equal(second.body.nextCursor, null);
    const last = f.calls.filter(call => call.sql.includes('from training_load.metric_definitions')).at(-1);
    assert.deepEqual(last.params.slice(5), ["' or true --", id(109), 2, 'session']);
    assert.ok(!last.sql.includes("' or true --"));
    assert.deepEqual(f.releases, [false, false]);
  });

  test('metrics errors are sanitized and transaction cleanup completes', async t => {
    for (const [metricError, code] of [[new Error('private SQL details'), 'previewFailed'], [Object.assign(new Error('private SQL details'), { code: '57014' }), 'previewTimeout']]) {
      const f = fixture({ metricError });
      const request = await serve(t, createSimplePreviewRouter({ service: serviceFor(f) }));
      assert.deepEqual(await request('/metrics'), { status: 503, body: { error: code } });
      assert.equal(f.calls.at(-1).sql, 'rollback');
      assert.deepEqual(f.releases, [false]);
    }
  });

  test('exact metric lookup reaches beyond the first page without paging or assuming scope and aggregation', async t => {
    for (const value_type of ['numeric', 'text', 'boolean']) {
      const exactMetric = { ...metricRows.at(-1), value_type, scope_capabilities: [], daily_aggregation_method: null };
      const f = fixture({ exactMetric });
      const request = await serve(t, createSimplePreviewRouter({ service: serviceFor(f) }));
      const result = await request(`/metrics?metricDefinitionId=${exactMetric.id.toUpperCase()}`);
      assert.deepEqual(result, { status: 200, body: { metrics: [{ ...exactMetric, allowed_aggregations: value_type === 'numeric' ? ['sum', 'avg', 'max', 'last', 'none'] : ['last', 'none'] }], nextCursor: null } });
      const metricCalls = f.calls.filter(call => call.sql.includes('from training_load.metric_definitions'));
      assert.equal(metricCalls.length, 1);
      assert.ok(metricCalls[0].sql.includes("d.state='active'"));
      assert.ok(metricCalls[0].sql.includes('d.owner_user_id = $2'));
      assert.ok(metricCalls[0].sql.includes('d.id=$5'));
      assert.ok(!metricCalls[0].sql.includes('order by d.id limit'));
      assert.deepEqual(metricCalls[0].params, ['user', id(3), 'private_coach', null, exactMetric.id.toUpperCase()]);
      assert.equal(f.checkouts, 1);
      assert.equal(f.calls[0].sql, 'begin isolation level repeatable read read only');
      assert.equal(f.calls.at(-1).sql, 'rollback');
      assert.deepEqual(f.releases, [false]);
    }
  });

  test('exact lookup rejects malformed or combined queries and hides unavailable metrics', async t => {
    const f = fixture({ exactMetric: null });
    const request = await serve(t, createSimplePreviewRouter({ service: serviceFor(f) }));
    for (const query of ['metricDefinitionId=', 'metricDefinitionId=bad', `metricDefinitionId=${id(110)}&metricDefinitionId=${id(110)}`, `metricDefinitionId[id]=${id(110)}`, ...['search=', `afterId=${id(1)}`, 'limit=1', 'dataScopeLevel=session'].map(extra => `metricDefinitionId=${id(110)}&${extra}`)]) {
      assert.deepEqual(await request(`/metrics?${query}`), { status: 400, body: { error: 'invalidRequest' } }, query);
    }
    assert.ok(!f.calls.some(call => call.sql.includes('from training_load.metric_definitions')));
    assert.deepEqual(await request(`/metrics?metricDefinitionId=${id(110)}`), { status: 404, body: { error: 'notFound' } });
    assert.equal(f.calls.filter(call => call.sql.includes('from training_load.metric_definitions')).length, 1);
    assert.equal(f.calls.at(-1).sql, 'rollback');
    assert.equal(f.checkouts, f.releases.length);
  });

  test('service metrics also enforces authentication, parsing and abort bounds', async () => {
    const f = fixture();
    const service = serviceFor(f);
    await assert.rejects(service.metrics({ req: {}, dashboardId: id(2) }), error => error.code === 'notFound');
    assert.equal(f.checkouts, 0);
    for (const query of [null, [], { limit: 2 }, { search: [] }, { afterId: {} }]) await assert.rejects(service.metrics({ req, dashboardId: id(2), query }), error => error.code === 'invalidRequest' && error.status === 400);
    const before = f.checkouts;
    await assert.rejects(service.metrics({ req, dashboardId: id(2), signal: AbortSignal.abort() }), error => error.code === 'previewAborted');
    assert.equal(f.checkouts, before);
  });

  test('runtime capabilities and validation advertise atomicSave only in verified enabled mode', async t => {
    for (const [mode, preview, atomicSave] of [['enabled', true, true], ['preview', true, false], ['drain', false, false]]) {
      const f = fixture();
      const env = { DASHBOARD_SIMPLE_MODE: mode, DASHBOARD_SIMPLE_BUDGET_VERIFIED: 'true', DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED: 'true', DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE: '2', DASHBOARD_SIMPLE_KEY_ID: 'current', DASHBOARD_SIMPLE_KEY_BASE64: Buffer.alloc(32, 44).toString('base64') };
      const runtime = await createSimpleRuntime({ env, pool: f.pool, poolMax: 5, queryDashboard: async () => assert.fail('No measurement query') });
      const request = await serve(t, runtime.router);
      const caps = await request('/capabilities');
      assert.equal(caps.status, 200);
      assert.equal(caps.body.capabilities.preview, preview);
      assert.equal(caps.body.capabilities.atomicSave, atomicSave);
      const validated = await request('/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope()) });
      assert.equal(validated.status, 200);
      assert.equal(validated.body.status, 'valid', JSON.stringify(validated.body));
      assert.equal(validated.body.capabilities.preview, preview);
      assert.equal(validated.body.capabilities.atomicSave, atomicSave);
      assert.equal((await request('/metrics?limit=1')).status, 200);
      if (!preview) assert.deepEqual(await request('/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope()) }), { status: 503, body: { error: 'previewUnavailable' } });
    }
  });

  test('atomicSave requires strict active verification and preview results keep the same truth', async () => {
    for (const [activation, active, expected] of [
      [{ atomicSaveVerified: true }, false, false],
      [{ coordinatedAdmissionVerified: true, deploymentBudgetVerified: true, atomicSaveVerified: 'true' }, true, false],
      [{ coordinatedAdmissionVerified: true, deploymentBudgetVerified: true, atomicSaveVerified: true }, true, true],
    ]) {
      const f = fixture();
      let released = 0;
      const service = serviceFor(f, { activation, admission: active ? { tryAcquire: async () => ({ release() { released++; } }) } : undefined, tokenService: active ? { issue: () => ({ previewToken: 'test-token' }) } : undefined });
      const capabilities = await service.capabilities({ req, dashboardId: id(2) });
      assert.equal(capabilities.capabilities.atomicSave, expected);
      assert.equal(capabilities.capabilities.preview, active);
      if (active) {
        const result = await service.preview({ req, dashboardId: id(2), envelope: envelope() });
        assert.equal(result.status, 'valid', JSON.stringify(result));
        assert.equal(result.capabilities.atomicSave, expected);
        assert.equal(result.capabilities.preview, true);
        assert.equal(released, 1);
      }
    }
  });
}
