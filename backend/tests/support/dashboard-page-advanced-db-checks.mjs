// Portable, opt-in DB acceptance checks: no connect/pool/env/migration imports.
// Caller supplies one already OPEN, IDLE client on a LOCAL DISPOSABLE database,
// v59 applied, synthetic active manager/workspace, active nontemplate dashboard,
// and exactly two EMPTY Pages. No additional catalog fixture is needed: v18
// table + rpe/srpe built-ins are used. Every write is rolled back, including
// Page deletion, actor deactivation, archive, revisions and append-only receipts.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const mutationSql = `select training_load.mutate_dashboard_page_advanced(
  $1::uuid,$2::uuid,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::text,$9::jsonb,$10::jsonb) as receipt`;
const hash = body => createHash('sha256').update(JSON.stringify(body)).digest('hex');
// Drain pg's ReadyForQuery after a server error before savepoint cleanup.
async function engineQuery(client, sql, args = []) {
  try { return await client.query(sql, args); }
  catch (error) {
    if (client.readyForQuery === false && /^[0-9A-Z]{5}$/.test(error.code ?? '')) {
      await new Promise((resolve, reject) => {
        const finish = failure => {
          clearTimeout(timer);
          client.removeListener('drain', drained);
          client.removeListener('end', ended);
          client.removeListener('error', failed);
          failure ? reject(failure) : resolve();
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


export async function runDashboardPageAdvancedDbChecks({
  client, databaseName, actorId, workspace, dashboardId, pageIds,
}) {
  assert.equal(typeof client?.query, 'function');
  assert.equal(typeof databaseName, 'string');
  assert.match(databaseName, /(?:test|tmp|temp|disposable|fixture|s4b)/i);
  assert.doesNotMatch(databaseName, /^(?:optimove|postgres|template[01])$|monitoring2|prod/i);
  assert.equal(pageIds?.length, 2); assert.notEqual(pageIds[0], pageIds[1]);
  for (const id of [actorId, dashboardId, ...pageIds]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(id, id.toLowerCase());
  }
  const query = (sql, args) => engineQuery(client, sql, args);
  const database = (await query('select current_database() as name, host(inet_server_addr()) as address')).rows[0];
  assert.equal(database.name, databaseName);
  assert.ok(database.address == null || ['127.0.0.1', '::1'].includes(database.address), 'local disposable PG only');
  const passed = [];
  await query('begin');
  try {
    const page = async id => (await query('select * from training_load.dashboard_pages where id=$1', [id])).rows[0];
    const widget = async id => (await query('select * from training_load.dashboard_widgets where id=$1', [id])).rows[0];
    const snapshot = async () => (await query(`select jsonb_build_object(
      'dashboard',(select to_jsonb(d) from training_load.dashboards d where id=$1),
      'pages',(select jsonb_agg(to_jsonb(p) order by id) from training_load.dashboard_pages p where dashboard_id=$1),
      'widgets',(select jsonb_agg(to_jsonb(w) order by id) from training_load.dashboard_widgets w where dashboard_id=$1),
      'series',(select jsonb_agg(to_jsonb(s) order by s.id) from training_load.dashboard_widget_series s
        join training_load.dashboard_widgets w on w.id=s.widget_id where w.dashboard_id=$1),
      'requests',(select jsonb_agg(to_jsonb(r) order by initiator_user_id,request_id)
        from training_load.dashboard_page_advanced_requests r where dashboard_id=$1)) as value`, [dashboardId])).rows[0].value;
    const request = (pageId, operation, body, widgetId = null, seriesId = null) => {
      const requestId = randomUUID();
      const input = { ...body, contractVersion: 1, requestId };
      return [actorId, requestId, hash({ dashboardId, pageId, operation, widgetId, seriesId, input }),
        dashboardId, pageId, widgetId, seriesId, operation, JSON.stringify(input), JSON.stringify(workspace)];
    };
    const run = async args => (await query(mutationSql, args)).rows[0].receipt;
    const expectFailure = async (action, code) => {
      const before = await snapshot();
      await query('savepoint page_advanced_failure');
      try { await assert.rejects(action(), error => error.code === code); }
      finally {
        await query('rollback to savepoint page_advanced_failure');
        await query('release savepoint page_advanced_failure');
      }
      assert.deepEqual(await snapshot(), before);
    };
    const reject = (args, code) => expectFailure(() => run(args), code);
    const assertReceipt = async (receipt, args) => {
      assert.equal(receipt.requestId, args[1]); assert.equal(receipt.pageId, args[4]);
      assert.equal(receipt.operation, args[7]); assert.ok(Object.hasOwn(receipt, 'result'));
      const p = await page(args[4]);
      assert.equal(receipt.pageRevision, p.revision);
      assert.equal(receipt.defaultsRevision, p.defaults_revision);
      assert.equal(receipt.layoutRevision, p.layout_revision);
      assert.equal(receipt.dashboardRevision, (await query('select revision from training_load.dashboards where id=$1', [dashboardId])).rows[0].revision);
      const ledger = (await query(`select * from training_load.dashboard_page_advanced_requests
        where initiator_user_id=$1 and request_id=$2`, [actorId, args[1]])).rows[0];
      assert.deepEqual(ledger.receipt, receipt); assert.equal(ledger.page_id, args[4]);
      assert.deepEqual(ledger.workspace, workspace); assert.equal(ledger.payload_hash, args[2]);
    };
    assert.deepEqual((await query('select training_load.dashboard_page_actor_workspace($1) as ws', [actorId])).rows[0].ws, workspace);
    for (const id of pageIds) assert.equal((await page(id)).dashboard_id, dashboardId);
    const d = (await query('select status,is_template from training_load.dashboards where id=$1', [dashboardId])).rows[0];
    assert.equal(d.status, 'active'); assert.equal(d.is_template, false);
    assert.equal((await query('select count(*)::int as n from training_load.dashboard_widgets where page_id=any($1::uuid[])', [pageIds])).rows[0].n, 0);
    const createBody = { widgetType: 'table', title: 'Page Advanced check', widgetOrder: 0,
      x: 0, y: 0, width: 6, height: 4, mobileOrder: 0, groupBy: 'day', displayConfig: { schemaVersion: 1 } };
    // Capture Page A CAS before B changes the global dashboard revision.
    const pageABefore = await page(pageIds[0]);
    const createB = request(pageIds[1], 'widgetCreate', { ...createBody, expectedPageRevision: (await page(pageIds[1])).revision });
    const b = await run(createB); await assertReceipt(b, createB);
    const createA = request(pageIds[0], 'widgetCreate', { ...createBody, expectedPageRevision: pageABefore.revision });
    const a = await run(createA); await assertReceipt(a, createA);
    const aId = a.result.widgetId, bId = b.result.widgetId;
    assert.equal((await widget(aId)).page_id, pageIds[0]);
    assert.equal((await widget(bId)).page_id, pageIds[1]);
    for (const id of [aId, bId]) {
      const w = await widget(id); assert.deepEqual([w.widget_order,w.mobile_order,w.x,w.y], [0,0,0,0]);
    }
    await reject(request(pageIds[0], 'widgetCreate', { ...createBody, expectedPageRevision: pageABefore.revision }), 'P4P02');
    const c = await run(request(pageIds[0], 'widgetCreate', { ...createBody, widgetOrder: 1, mobileOrder: 1, x: 6,
      expectedPageRevision: (await page(pageIds[0])).revision }));
    const cId = c.result.widgetId;
    passed.push('create: explicit Page, duplicate coordinates/orders across Pages, Page CAS independent of global revision');

    const aLayoutRevision = (await page(pageIds[0])).layout_revision;
    await run(request(pageIds[1], 'widgetLayout', { expectedWidgetRevision: (await widget(bId)).revision, y: 4 }, bId));
    const unchangedB = await widget(bId);
    const layoutArgs = request(pageIds[0], 'layout', { expectedPageLayoutRevision: aLayoutRevision, layout: [{ widgetId: aId, y: 4 }] });
    const layout = await run(layoutArgs); await assertReceipt(layout, layoutArgs);
    assert.deepEqual(layout.result.widgets.map(w => w.widget_id), [aId]);
    assert.deepEqual(await widget(bId), unchangedB);
    await reject(request(pageIds[0], 'layout', { expectedPageLayoutRevision: aLayoutRevision, layout: [] }), 'P4A01');
    await reject(request(pageIds[0], 'layout', { expectedPageLayoutRevision: (await page(pageIds[0])).layout_revision,
      layout: [{ widgetId: bId, y: 8 }] }), 'P4P10');
    await reject(request(pageIds[0], 'widgetContent', { expectedWidgetRevision: (await widget(bId)).revision, title: 'foreign' }, bId), 'P4P10');
    await run(request(pageIds[0], 'widgetContent', { expectedWidgetRevision: (await widget(aId)).revision, title: 'Updated' }, aId));
    passed.push('layout Page scope, Page layout CAS, foreign layout/widget rejection and widget content');

    const addSeries = async (pageId, widgetId, seriesOrder, builtInSeriesKey = 'rpe') => {
      const args = request(pageId, 'seriesAdd', { expectedWidgetRevision: (await widget(widgetId)).revision,
        seriesOrder, builtInSeriesKey, analyticalAggregation: 'avg' }, widgetId);
      const receipt = await run(args); await assertReceipt(receipt, args); return receipt.result.seriesId;
    };
    const sa = await addSeries(pageIds[0], aId, 0);
    const sa2 = await addSeries(pageIds[0], aId, 1, 'srpe');
    const sb = await addSeries(pageIds[1], bId, 0);
    for (const operation of ['seriesUpdate','seriesDelete','seriesResolve']) {
      await reject(request(pageIds[0], operation, { expectedWidgetRevision: (await widget(aId)).revision,
        color: '#112233', metricDefinitionId: randomUUID() }, aId, sb), 'P4P10');
    }
    await reject(request(pageIds[0], 'seriesAdd', { expectedWidgetRevision: (await widget(bId)).revision,
      seriesOrder: 1, builtInSeriesKey: 'rpe' }, bId), 'P4P10');
    await reject(request(pageIds[0], 'seriesReorder', { expectedWidgetRevision: (await widget(aId)).revision,
      order: [{ seriesId: sb, seriesOrder: 0 }] }, aId), 'P4P10');
    await run(request(pageIds[0], 'seriesUpdate', { expectedWidgetRevision: (await widget(aId)).revision,
      color: '#112233', displayLabel: 'Checked' }, aId, sa));
    await run(request(pageIds[0], 'seriesReorder', { expectedWidgetRevision: (await widget(aId)).revision,
      order: [{ seriesId: sa, seriesOrder: 1 }, { seriesId: sa2, seriesOrder: 0 }] }, aId));
    const deleteSeriesArgs = request(pageIds[0], 'seriesDelete', { expectedWidgetRevision: (await widget(aId)).revision }, aId, sa);
    const deletedSeries = await run(deleteSeriesArgs);
    assert.equal((await query('select count(*)::int as n from training_load.dashboard_widget_series where id=$1', [sa])).rows[0].n, 0);
    assert.deepEqual(await run(deleteSeriesArgs), deletedSeries);
    passed.push('series add/update/reorder/delete and deleted-series replay; foreign widget/series/resolve rejected');

    // Second UPDATE causes real overlap AFTER the first UPDATE has succeeded.
    await reject(request(pageIds[0], 'layout', { expectedPageLayoutRevision: (await page(pageIds[0])).layout_revision,
      layout: [{ widgetId: aId, x: 0, y: 8 }, { widgetId: cId, x: 0, y: 8 }] }), '23514');
    passed.push('late overlap failure rolls back widgets, all revisions and ledger atomically');

    assert.deepEqual(await run(createA), a);
    const conflict = [...createA]; conflict[4] = pageIds[1]; await reject(conflict, 'P4P08');
    const wrongHash = [...createA]; wrongHash[2] = createA[2] === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
    await reject(wrongHash, 'P4P08');
    const wrongWorkspace = [...createA]; wrongWorkspace[9] = JSON.stringify({ type: 'forged' });
    await reject(wrongWorkspace, 'P4P10');
    const unknown = request(pageIds[0], 'unknown', {}); await reject(unknown, 'P4P09');
    await reject(request(pageIds[0], 'widgetDelete', { expectedWidgetRevision: 0 }, aId), 'P4P09');
    passed.push('exact durable replay; cross-Page/hash/workspace conflicts; known operation and required revision');

    await query("select set_config('training_load.page_mutation',$1,true)",
      [JSON.stringify({ dashboardId, pageId: pageIds[0], operation: 'advanced' })]);
    await expectFailure(() => query('select training_load.dashboard_legacy_page_guard($1)', [dashboardId]), 'P4P01');
    await expectFailure(() => query('select * from training_load.delete_widget($1,$2)', [aId, 1]), 'P4P01');
    await query("select set_config('training_load.page_mutation','',true)");
    await query("select set_config('training_load.page_mutation',$1,true)",
      [JSON.stringify({ dashboardId: randomUUID(), pageId: pageIds[0], operation: 'advanced' })]);
    assert.equal((await query('select training_load.dashboard_page_internal($1,$2) as allowed', [dashboardId, pageIds[0]])).rows[0].allowed, false);
    await query("select set_config('training_load.page_mutation','',true)");
    await expectFailure(() => query('update training_load.dashboard_page_advanced_requests set receipt=receipt where initiator_user_id=$1 and request_id=$2', [actorId, createA[1]]), 'P0001');
    passed.push('legacy writer/guard closed even with Advanced marker; real parent and append-only backstops');

    const deleteArgs = request(pageIds[0], 'widgetDelete', { expectedWidgetRevision: (await widget(aId)).revision }, aId);
    const deleted = await run(deleteArgs);
    assert.equal(await widget(aId), undefined);
    assert.deepEqual(await run(deleteArgs), deleted);
    assert.deepEqual(await run(deleteSeriesArgs), deletedSeries, 'series replay survives widget deletion');
    assert.deepEqual(await run(createA), a, 'create replay survives widget deletion');
    // Fresh authority must still be checked for an otherwise matching receipt.
    await query('savepoint page_advanced_authority');
    try {
      await query('update public.users set is_active=false where id=$1', [actorId]);
      await reject(createA, 'P4P10');
    } finally {
      await query('rollback to savepoint page_advanced_authority');
      await query('release savepoint page_advanced_authority');
    }
    // Use the sanctioned Page mutator while its parent is active.
    const deletePageId = randomUUID();
    const deletePageBody = { contractVersion: 1, requestId: deletePageId, deleteWidgets: true,
      expectedPageRevision: (await page(pageIds[0])).revision,
      expectedPagesRevision: (await query('select pages_revision from training_load.dashboards where id=$1', [dashboardId])).rows[0].pages_revision };
    await query(`select training_load.mutate_dashboard_page($1,$2,$3,$4,$5,'delete',$6::jsonb,$7::jsonb)`,
      [actorId, deletePageId, hash(deletePageBody), dashboardId, pageIds[0], JSON.stringify(deletePageBody), JSON.stringify(workspace)]);
    assert.equal(await page(pageIds[0]), undefined);
    assert.deepEqual(await run(createA), a);
    assert.deepEqual(await run(deleteArgs), deleted);
    await reject(request(pageIds[0], 'widgetCreate', { ...createBody, expectedPageRevision: 1 }), 'P4P10');
    await query("update training_load.dashboards set status='archived' where id=$1", [dashboardId]);
    assert.deepEqual(await run(createA), a);
    assert.deepEqual(await run(deleteArgs), deleted);
    assert.deepEqual(await run(deleteSeriesArgs), deletedSeries);
    await reject(request(pageIds[1], 'widgetCreate', { ...createBody, expectedPageRevision: (await page(pageIds[1])).revision }), '40002');
    passed.push('widget/Page deletion and archive preserve exact receipt replay; fresh actor authority remains required');
    return { passed };
  } finally { await query('rollback'); }
}
