// Engine-only acceptance harness. The caller supplies an ALREADY OPEN client
// to an explicitly named disposable local database restored by the main agent.
// No env, dotenv, production pool, server import, cloud, DB creation or connect.
// Import and call runDashboardPagesDbChecks({ client, databaseName, actorId,
// workspace }); actor must have a real active preference/role in that fixture.
// Functional checks roll back their writes, including on assertion failure.
// The optional concurrency checks commit fixtures in the disposable database.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

export const pageSqlstates = Object.freeze({
  pagesClientRequired: 'P4P01', stalePageRevision: 'P4P02', stalePagesRevision: 'P4P03',
  stalePageDefaultsRevision: 'P4P04', lastPageRequired: 'P4P05', pageNotEmpty: 'P4P06',
  pageLimitReached: 'P4P07', idempotencyConflict: 'P4P08', invalidRequest: 'P4P09', notFound: 'P4P10',
});
const period = { schemaVersion: 1, mode: 'fixed', dateFrom: '2026-10-01', dateTo: '2026-10-31', timeZone: 'Europe/Belgrade' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function engineQuery(client, sql, args = []) {
  try { return await client.query(sql, args); }
  catch (error) {
    // pg rejects a server ErrorResponse before the following ReadyForQuery.
    // Await that drain before savepoint/rollback cleanup submits another query.
    if (client.readyForQuery === false && /^[0-9A-Z]{5}$/.test(error.code ?? '')) {
      await new Promise((resolve, reject) => {
        const finish = failure => {
          clearTimeout(timer);
          client.removeListener('drain', drained); client.removeListener('end', ended); client.removeListener('error', failed);
          if (failure) reject(failure); else resolve();
        };
        const drained = () => finish();
        const ended = () => finish(error);
        const failed = failure => finish(failure);
        const timer = setTimeout(() => finish(error), 5000);
        client.once('drain', drained); client.once('end', ended); client.once('error', failed);
      });
    }
    throw error;
  }
}

async function requireDisposable(client, databaseName) {
  assert.equal(typeof databaseName, 'string');
  assert.match(databaseName, /(?:test|tmp|temp|disposable|fixture|s4b)/i);
  assert.doesNotMatch(databaseName, /^(?:optimove|postgres|template[01])$|monitoring2|prod/i);
  const { rows: [db] } = await client.query('select current_database() as name, host(inet_server_addr()) as address');
  assert.equal(db.name, databaseName);
  assert.ok(db.address == null || ['127.0.0.1', '::1'].includes(db.address), 'local disposable PG only');
}

// Capture BEFORE migration and compare AFTER migration using the same client.
// Metadata snapshot does not touch measurements or change widget identities.
export async function captureDashboardPagesBackfill(client, databaseName) {
  await requireDisposable(client, databaseName);
  return (await client.query(`select jsonb_build_object(
    'widgets',coalesce((select jsonb_agg(to_jsonb(w) order by id) from training_load.dashboard_widgets w),'[]'::jsonb),
    'series',coalesce((select jsonb_agg(to_jsonb(s) order by id) from training_load.dashboard_widget_series s),'[]'::jsonb)
  ) as snapshot`)).rows[0].snapshot;
}
export async function verifyDashboardPagesBackfill(client, databaseName, before) {
  await requireDisposable(client, databaseName);
  const after = await captureDashboardPagesBackfill(client, databaseName);
  assert.deepEqual(after.widgets.map(({ page_id, ...w }) => w), before.widgets);
  assert.deepEqual(after.series, before.series);
  assert.equal((await client.query(`select count(*)::int as n from training_load.dashboards d
    where (select count(*) from training_load.dashboard_pages p where p.dashboard_id=d.id)<>1`)).rows[0].n, 0);
  assert.equal((await client.query(`select count(*)::int as n from training_load.dashboard_pages
    where period_origin<>'legacyRuntime' or period_config is not null`)).rows[0].n, 0);
}

export async function runDashboardPagesDbChecks({ client, databaseName, actorId, workspace }) {
  await requireDisposable(client, databaseName);
  const passed = [];
  await client.query('begin');
  try {
    const query = (sql, args = []) => engineQuery(client, sql, args);
    const actualWorkspace = (await query('select training_load.dashboard_page_actor_workspace($1) as workspace', [actorId])).rows[0].workspace;
    assert.deepEqual(actualWorkspace, workspace, 'DB actor workspace must match the server descriptor exactly');
    if (['platform', 'private_coach', 'athlete'].includes(actualWorkspace.dataWorkspaceType)) {
      assert.equal(actualWorkspace.dataWorkspaceScopeId, null, 'account-wide workspaces have an explicit null scope');
    }
    passed.push('actor workspace descriptor matches JS, including explicit null account-wide scope');
    const expectCode = async (sql, args, code) => {
      await query('savepoint expected_failure');
      try { await assert.rejects(query(sql, args), error => error.code === code); }
      finally { await query('rollback to savepoint expected_failure'); await query('release savepoint expected_failure'); }
    };
    const newDashboard = async () => (await query(`insert into training_load.dashboards(name,owner_scope,owner_user_id,
      data_workspace_type,data_workspace_scope_id,created_by_user_id) values('S4b DB fixture','user',$1,$2,$3,$1) returning *`,
    [actorId, workspace.dataWorkspaceType, workspace.dataWorkspaceScopeId])).rows[0];
    const d = await newDashboard();
    const pages = async (id = d.id) => (await query('select * from training_load.dashboard_pages where dashboard_id=$1 order by position', [id])).rows;
    const dash = async () => (await query('select * from training_load.dashboards where id=$1', [d.id])).rows[0];
    const freshPage = async id => (await query('select * from training_load.dashboard_pages where id=$1', [id])).rows[0];
    const [initial] = await pages();
    assert.equal(initial.period_origin, 'legacyRuntime'); assert.equal(initial.period_config, null);
    assert.equal(initial.default_filter, null); assert.equal(initial.position, 0);
    passed.push('new dashboard gets one legacyRuntime/null Page without invented defaults');

    const call = async (operation, pageId, fields, requestId = randomUUID(), payloadHash = null, ws = workspace, dashboardId = d.id) => {
      const body = { contractVersion: 1, requestId, ...fields };
      const args = [actorId, requestId, payloadHash ?? hash({ operation, pageId, body }), dashboardId, pageId, operation, JSON.stringify(body), JSON.stringify(ws)];
      return { args, receipt: (await query('select training_load.mutate_dashboard_page($1,$2,$3,$4,$5,$6,$7,$8) as receipt', args)).rows[0].receipt };
    };
    const port = 'select training_load.mutate_dashboard_page($1,$2,$3,$4,$5,$6,$7,$8) as receipt';
    const failedCall = async (operation, pageId, fields, code) => {
      const request = randomUUID(), body = { contractVersion: 1, requestId: request, ...fields };
      await expectCode(port, [actorId, request, hash(body), d.id, pageId, operation, JSON.stringify(body), JSON.stringify(workspace)], code);
    };

    const type = (await query("select * from training_load.dashboard_widget_types where key='kpi'")).rows[0];
    assert.ok(type, 'dashboard type catalog must be seeded');
    const w = (await query(`insert into training_load.dashboard_widgets(dashboard_id,widget_type,title,widget_order,x,y,width,height,mobile_order)
      values($1,'kpi','Original',0,0,0,$2,$3,0) returning *`, [d.id, type.default_width, type.default_height])).rows[0];
    assert.equal(w.page_id, initial.id);
    const builtin = (await query("select * from training_load.dashboard_builtin_series where is_active=true and value_type='numeric' order by key limit 1")).rows[0];
    const s = (await query(`insert into training_load.dashboard_widget_series(widget_id,series_order,built_in_series_key,
      source_policy,data_scope_level,analytical_aggregation,created_by_user_id) values($1,0,$2,'not_applicable',$3,'sum',$4) returning *`,
    [w.id, builtin.key, builtin.fixed_data_scope_level, actorId])).rows[0];
    let a = await freshPage(initial.id);
    await query("update training_load.dashboard_widgets set title='Changed' where id=$1", [w.id]);
    let b = await freshPage(initial.id);
    assert.ok(b.revision > a.revision); assert.equal(b.defaults_revision, a.defaults_revision); assert.equal(b.layout_revision, a.layout_revision);
    a = b;
    await query("update training_load.dashboard_widget_series set display_label='Changed' where id=$1", [s.id]);
    b = await freshPage(initial.id); assert.ok(b.revision > a.revision); assert.equal(b.defaults_revision, a.defaults_revision); assert.equal(b.layout_revision, a.layout_revision);
    a = b;
    await query('select * from training_load.update_widget_layout($1,$2,null,4::smallint)', [w.id, (await query('select revision from training_load.dashboard_widgets where id=$1',[w.id])).rows[0].revision]);
    b = await freshPage(initial.id); assert.equal(b.revision, a.revision); assert.ok(b.layout_revision > a.layout_revision); assert.equal(b.defaults_revision, a.defaults_revision);
    passed.push('widget membership/content and series change Page revision; layout stays separate');

    const defaults = await call('defaults', initial.id, { expectedPageDefaultsRevision: b.defaults_revision, defaultFilter: { athleteIds: [] } });
    b = await freshPage(initial.id); assert.equal(b.period_config, null); assert.equal(b.period_origin, 'legacyRuntime');
    assert.equal(b.defaults_revision, a.defaults_revision + 1);
    assert.deepEqual((await query(port, defaults.args)).rows[0].receipt, defaults.receipt);
    await failedCall('defaults', initial.id, { expectedPageDefaultsRevision: b.defaults_revision - 1, defaultFilter: {} }, 'P4P04');
    await failedCall('defaults', initial.id, { expectedPageDefaultsRevision: b.defaults_revision, periodConfig: null }, 'P4P09');
    await failedCall('defaults', initial.id, { expectedPageDefaultsRevision: b.defaults_revision, periodConfig: { ...period, dateTo: '2028-01-01' } }, 'P4P09');
    await call('defaults', initial.id, { expectedPageDefaultsRevision: b.defaults_revision, periodConfig: period });
    b = await freshPage(initial.id); assert.equal(b.period_origin, 'configured'); assert.deepEqual(b.period_config, period);
    passed.push('filter-only legacy defaults, explicit configured transition, bounds, stale defaults and replay');

    const opaque = { schemaVersion: 98, opaque: { seriesId: s.id, widgetId: w.id, payload: [null, 'exact', { untouched: true }] } };
    await query('update training_load.dashboard_widgets set presentation_config=$2 where id=$1', [w.id, opaque]);
    const sourceBefore = (await query('select to_jsonb(w) as w from training_load.dashboard_widgets w where id=$1', [w.id])).rows[0].w;
    const duplicate = await call('duplicate', initial.id, { name: 'Copy', expectedPageRevision: (await freshPage(initial.id)).revision, expectedPagesRevision: (await dash()).pages_revision });
    const copyId = duplicate.receipt.pageId;
    const clonedWidgetId = duplicate.receipt.idMapping.widgets[w.id];
    const clonedSeriesId = duplicate.receipt.idMapping.series[s.id];
    assert.notEqual(clonedWidgetId, w.id); assert.notEqual(clonedSeriesId, s.id);
    const clone = (await query('select * from training_load.dashboard_widgets where id=$1', [clonedWidgetId])).rows[0];
    assert.equal(clone.page_id, copyId); assert.equal(clone.dashboard_id, d.id);
    for (const k of ['widget_type','title','widget_order','x','y','width','height','mobile_order','group_by','state','display_config','local_filter_override','presentation_config']) assert.deepEqual(clone[k], sourceBefore[k], k);
    assert.equal((await query('select widget_id from training_load.dashboard_widget_series where id=$1', [clonedSeriesId])).rows[0].widget_id, clonedWidgetId);
    assert.deepEqual((await query(port, duplicate.args)).rows[0].receipt, duplicate.receipt);
    const conflictArgs = [...duplicate.args]; conflictArgs[5] = 'rename';
    await expectCode(port, conflictArgs, 'P4P08');
    conflictArgs[5] = 'duplicate'; conflictArgs[6] = JSON.stringify({ ...JSON.parse(conflictArgs[6]), name: 'Other name' });
    await expectCode(port, conflictArgs, 'P4P08');
    passed.push('duplicate new IDs, same-layout cross-Page legality, exact opaque preservation and body/operation conflict');

    await expectCode('select * from training_load.update_widget_content($1,$2,null,$3)', [w.id, sourceBefore.revision, 'Forbidden'], 'P4P01');
    await expectCode('select * from training_load.delete_widget($1,$2)', [w.id, sourceBefore.revision], 'P4P01');
    await expectCode('select * from training_load.reorder_series($1,$2,$3)', [w.id, sourceBefore.revision, JSON.stringify([s.id])], 'P4P01');
    await expectCode("select * from training_load.replace_dashboard_layout($1,$2,'[]'::jsonb)", [d.id, (await dash()).revision], 'P4P01');
    await expectCode("select training_load.save_simple_widget($1,$2,$3,date_trunc('milliseconds',now()),$4,null,null,null,'{}'::jsonb,$5)", [actorId, randomUUID(), 'a'.repeat(64), d.id, workspace], 'P4P01');
    const simpleRequest = randomUUID(), issuedAt = new Date().toISOString();
    const simpleReceipt = { requestId: simpleRequest, dashboardId: d.id, widgetId: w.id, operation: 'created' };
    const resolved = { dateFrom: period.dateFrom, dateTo: period.dateTo, timeZone: period.timeZone };
    await query(`insert into training_load.dashboard_simple_requests(initiator_user_id,request_id,dashboard_id,widget_id,workspace,payload_hash,
      request_issued_at,resolved_period,receipt,retain_until) values($1,$2,$3,null,$4,$5,$6,$7,$8,$6::timestamptz+interval '168 hours 10 minutes')`,
    [actorId, simpleRequest, d.id, workspace, 'b'.repeat(64), issuedAt, resolved, simpleReceipt]);
    assert.deepEqual((await query('select training_load.save_simple_widget($1,$2,$3,$4,$5,null,null,null,$6,$7) as receipt',
      [actorId, simpleRequest, 'b'.repeat(64), issuedAt, d.id, resolved, workspace])).rows[0].receipt, simpleReceipt);
    await expectCode("update training_load.dashboard_widgets set title='Forbidden' where id=$1", [w.id], 'P4P01');
    await expectCode("update training_load.dashboard_widget_series set color='red' where id=$1", [s.id], 'P4P01');
    await query("select set_config('training_load.page_mutation',$1,true)", [JSON.stringify({ dashboardId: d.id, pageId: copyId, operation: 'duplicate' })]);
    await expectCode("update training_load.dashboard_widgets set title='Wrong parent scope' where id=$1", [w.id], 'P4P01');
    await query("select set_config('training_load.page_mutation','',true)");
    passed.push('new legacy widget/series/layout/Simple fail closed; recorded Simple replay survives multi-Page; wrong parent marker rejected');

    const foreign = await newDashboard();
    const foreignPage = (await pages(foreign.id))[0];
    await failedCall('rename', foreignPage.id, { name: 'Foreign', expectedPageRevision: 1 }, 'P4P10');
    const badWorkspace = [...defaults.args]; badWorkspace[7] = JSON.stringify({ ...workspace, dataWorkspaceScopeId: randomUUID() });
    await expectCode(port, badWorkspace, 'P4P10');
    await expectCode(`insert into training_load.dashboard_widgets(dashboard_id,page_id,widget_type,title,widget_order,x,y,width,height,mobile_order)
      values($1,$2,'kpi','Wrong parent',9,0,20,$3,$4,9)`, [foreign.id, initial.id, type.default_width, type.default_height], 'P4P10');
    // Authority is rechecked even for exact, completed replay.
    await query('savepoint revoke_for_replay');
    await query('update public.users set is_active=false where id=$1', [actorId]);
    await expectCode(port, defaults.args, 'P4P10');
    await query('rollback to savepoint revoke_for_replay'); await query('release savepoint revoke_for_replay');
    passed.push('cross-dashboard/workspace rejects and current-user revocation before replay');

    await failedCall('rename', initial.id, { name: 'Stale', expectedPageRevision: 1 }, 'P4P02');
    await failedCall('reorder', null, { pageIds: [copyId, initial.id], expectedPagesRevision: 1 }, 'P4P03');
    await failedCall('reorder', null, { pageIds: [initial.id, initial.id], expectedPagesRevision: (await dash()).pages_revision }, 'P4P09');
    const beforeOrder = await freshPage(initial.id);
    await call('reorder', null, { pageIds: [copyId, initial.id], expectedPagesRevision: (await dash()).pages_revision });
    assert.deepEqual((await pages()).map(p => p.id), [copyId, initial.id]);
    const afterOrder = await freshPage(initial.id);
    assert.equal(afterOrder.revision, beforeOrder.revision); assert.equal(afterOrder.defaults_revision, beforeOrder.defaults_revision);
    await failedCall('delete', copyId, { expectedPageRevision: (await freshPage(copyId)).revision, expectedPagesRevision: (await dash()).pages_revision, deleteWidgets: false }, 'P4P06');
    const deletion = await call('delete', copyId, { expectedPageRevision: (await freshPage(copyId)).revision, expectedPagesRevision: (await dash()).pages_revision, deleteWidgets: true });
    assert.equal((await pages()).length, 1); assert.equal((await pages())[0].position, 0);
    assert.equal((await query('select count(*)::int as n from training_load.dashboard_widget_series where id=$1', [clonedSeriesId])).rows[0].n, 0);
    assert.deepEqual((await query(port, deletion.args)).rows[0].receipt, deletion.receipt);
    await failedCall('delete', initial.id, { expectedPageRevision: (await freshPage(initial.id)).revision, expectedPagesRevision: (await dash()).pages_revision, deleteWidgets: true }, 'P4P05');
    passed.push('reorder permutation and revisions, nonempty confirmation, delete cascade and durable deleted-target replay, last Page');

    for (let i = 1; i < 32; i++) await call('create', null, { name: `Page ${i}`, periodConfig: period, defaultFilter: {}, expectedPagesRevision: (await dash()).pages_revision });
    await failedCall('create', null, { name: '33', periodConfig: period, defaultFilter: {}, expectedPagesRevision: (await dash()).pages_revision }, 'P4P07');
    passed.push('32 limit under dashboard lock');
    await query('update training_load.dashboards set status=\'archived\' where id=$1', [d.id]);
    await failedCall('rename', initial.id, { name: 'Archived', expectedPageRevision: (await freshPage(initial.id)).revision }, '40002');
    await query('delete from training_load.dashboards where id=$1', [d.id]);
    assert.equal((await pages()).length, 0);
    assert.equal((await query('select count(*)::int as n from training_load.dashboard_widgets where dashboard_id=$1', [d.id])).rows[0].n, 0);
    assert.ok((await query('select count(*)::int as n from training_load.dashboard_page_requests where dashboard_id=$1', [d.id])).rows[0].n > 0);
    passed.push('archive write refusal and root dashboard delete cascade with durable ledger');
    return passed;
  } finally { await client.query('rollback'); }
}

// A second optional engine harness proves dashboard-row serialization with two
// caller-owned connections. It deliberately commits fixture writes; the caller
// owns/destroys the disposable database. No clients are opened by this module.
export async function runDashboardPagesConcurrencyChecks({ clients, databaseName, actorId, workspace }) {
  const [a, b] = clients;
  await requireDisposable(a, databaseName); await requireDisposable(b, databaseName);
  const pidA = (await a.query('select pg_backend_pid() as pid')).rows[0].pid;
  const pidB = (await b.query('select pg_backend_pid() as pid')).rows[0].pid;
  assert.notEqual(pidA, pidB);
  const d = (await a.query(`insert into training_load.dashboards(name,owner_scope,owner_user_id,data_workspace_type,data_workspace_scope_id,created_by_user_id)
    values('S4b concurrency fixture','user',$1,$2,$3,$1) returning id`, [actorId, workspace.dataWorkspaceType, workspace.dataWorkspaceScopeId])).rows[0].id;
  const rows = async () => (await a.query('select * from training_load.dashboard_pages where dashboard_id=$1 order by position', [d])).rows;
  const revision = async () => (await a.query('select pages_revision from training_load.dashboards where id=$1', [d])).rows[0].pages_revision;
  const makeArgs = (operation, pageId, fields) => {
    const id = randomUUID(), body = { contractVersion: 1, requestId: id, ...fields };
    return [actorId, id, hash(body), d, pageId, operation, JSON.stringify(body), JSON.stringify(workspace)];
  };
  const sql = 'select training_load.mutate_dashboard_page($1,$2,$3,$4,$5,$6,$7,$8) as receipt';
  const race = async (left, right) => {
    await a.query('begin'); await b.query('begin');
    let waiting;
    try {
      const receipt = (await engineQuery(a, sql, left)).rows[0].receipt;
      waiting = engineQuery(b, sql, right).then(value => ({ value }), error => ({ error }));
      let blocked = false;
      for (let i = 0; i < 200; i++) {
        blocked = (await a.query('select $1::int=any(pg_blocking_pids($2)) as blocked', [pidA, pidB])).rows[0].blocked;
        if (blocked) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'second Page mutation must wait on the first dashboard lock');
      await a.query('commit');
      const second = await waiting;
      assert.equal(second.error?.code, 'P4P03');
      await b.query('rollback');
      return receipt;
    } finally {
      await a.query('rollback');
      if (waiting) await waiting;
      await b.query('rollback');
    }
  };
  try {
    let rev = await revision();
    const first = makeArgs('create', null, { name: 'A', periodConfig: period, defaultFilter: {}, expectedPagesRevision: rev });
    const receipt = await race(first, makeArgs('create', null, { name: 'B', periodConfig: period, defaultFilter: {}, expectedPagesRevision: rev }));
    assert.equal((await rows()).length, 2);
    // Commit survived; caller may have lost its acknowledgement. Same request
    // through the other connection returns the durable receipt exactly once.
    assert.deepEqual((await b.query(sql, first)).rows[0].receipt, receipt);
    const two = await rows(); rev = await revision();
    await race(makeArgs('reorder', null, { pageIds: [two[1].id, two[0].id], expectedPagesRevision: rev }),
      makeArgs('reorder', null, { pageIds: two.map(p => p.id), expectedPagesRevision: rev }));
    rev = await revision();
    await race(makeArgs('delete', two[0].id, { expectedPageRevision: two[0].revision, expectedPagesRevision: rev, deleteWidgets: false }),
      makeArgs('delete', two[1].id, { expectedPageRevision: two[1].revision, expectedPagesRevision: rev, deleteWidgets: false }));
    assert.equal((await rows()).length, 1);
    for (let i = 1; i < 31; i++) await a.query(sql, makeArgs('create', null, { name: `Limit ${i}`, periodConfig: period, defaultFilter: {}, expectedPagesRevision: await revision() }));
    rev = await revision();
    await race(makeArgs('create', null, { name: '32', periodConfig: period, defaultFilter: {}, expectedPagesRevision: rev }),
      makeArgs('create', null, { name: '33', periodConfig: period, defaultFilter: {}, expectedPagesRevision: rev }));
    assert.equal((await rows()).length, 32);
    await assert.rejects(engineQuery(b, sql, makeArgs('create', null, { name: 'Retry 33', periodConfig: period, defaultFilter: {}, expectedPagesRevision: await revision() })), error => error.code === 'P4P07');
    return ['parallel create/reorder/delete lock waits and stale revisions', 'committed same-request replay on another connection', 'concurrent 32 limit and rejected fresh retry'];
  } finally {
    await a.query('rollback'); await b.query('rollback');
    await a.query('delete from training_load.dashboards where id=$1', [d]);
  }
}
