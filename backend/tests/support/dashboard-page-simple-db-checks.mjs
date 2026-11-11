// Portable acceptance harness: NO connect, env, pool, migration or server imports.
// Caller supplies an already OPEN, IDLE client to a local disposable database
// with v58 applied, a synthetic active actor/workspace, and an active synthetic
// dashboard with two EMPTY Pages. compiledWidget must be a valid Simple compiler
// output (one resolved series), resolvedPeriod the server-validated date snapshot.
// Every write, including archive and ledger entries, is rolled back.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

const pageSaveSql = `select training_load.save_simple_page_widget(
  $1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::uuid,$6::uuid,$7::integer,
  $8::jsonb,$9::jsonb,$10::jsonb,$11::uuid,$12::integer,$13::jsonb) as receipt`;
const legacySaveSql = `select training_load.save_simple_widget(
  $1::uuid,$2::uuid,$3::text,$4::timestamptz,$5::uuid,$6::uuid,$7::integer,
  $8::jsonb,$9::jsonb,$10::jsonb) as receipt`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));

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

export async function runDashboardPageSimpleDbChecks({
  client, databaseName, actorId, workspace, dashboardId, pageIds, compiledWidget, resolvedPeriod,
}) {
  assert.equal(typeof client?.query, 'function');
  assert.equal(typeof databaseName, 'string');
  assert.match(databaseName, /(?:test|tmp|temp|disposable|fixture|s4b)/i);
  assert.doesNotMatch(databaseName, /^(?:optimove|postgres|template[01])$|monitoring2|prod/i);
  assert.equal(pageIds?.length, 2);
  assert.notEqual(pageIds[0], pageIds[1]);
  for (const id of [actorId, dashboardId, ...pageIds]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  }
  assert.equal(compiledWidget?.series?.length, 1);
  const query = (sql, args) => engineQuery(client, sql, args);
  const db = (await query('select current_database() as name, host(inet_server_addr()) as address')).rows[0];
  assert.equal(db.name, databaseName);
  assert.ok(db.address == null || ['127.0.0.1', '::1'].includes(db.address), 'local disposable PG only');
  const passed = [];
  await query('begin');
  try {
    const expectCode = async (sql, args, code) => {
      await query('savepoint page_simple_expected_failure');
      try { await assert.rejects(query(sql, args), error => error.code === code); }
      finally {
        await query('rollback to savepoint page_simple_expected_failure');
        await query('release savepoint page_simple_expected_failure');
      }
    };
    const snapshot = async () => (await query(`select jsonb_build_object(
      'dashboard',(select to_jsonb(d) from training_load.dashboards d where id=$1),
      'pages',(select jsonb_agg(to_jsonb(p) order by id) from training_load.dashboard_pages p where dashboard_id=$1),
      'widgets',(select jsonb_agg(to_jsonb(w) order by id) from training_load.dashboard_widgets w where dashboard_id=$1),
      'series',(select jsonb_agg(to_jsonb(s) order by s.id) from training_load.dashboard_widget_series s
        join training_load.dashboard_widgets w on w.id=s.widget_id where w.dashboard_id=$1),
      'requests',(select jsonb_agg(to_jsonb(r) order by initiator_user_id,request_id)
        from training_load.dashboard_simple_requests r where dashboard_id=$1)) as value`, [dashboardId])).rows[0].value;
    const page = async id => (await query('select * from training_load.dashboard_pages where id=$1', [id])).rows[0];
    const widget = async id => (await query('select * from training_load.dashboard_widgets where id=$1', [id])).rows[0];
    assert.deepEqual((await query('select training_load.dashboard_page_actor_workspace($1) as ws', [actorId])).rows[0].ws, workspace);
    for (const id of pageIds) assert.equal((await page(id)).dashboard_id, dashboardId);
    assert.equal((await query('select count(*)::int as n from training_load.dashboard_widgets where page_id=any($1::uuid[])', [pageIds])).rows[0].n, 0);
    assert.equal((await query('select status from training_load.dashboards where id=$1', [dashboardId])).rows[0].status, 'active');
    const request = (pageId, { widgetId = null, revision = null, widget: body = compiledWidget,
      defaultsRevision = null, periodConfig = null } = {}) => {
      const requestId = randomUUID();
      const args = [actorId, requestId, hash({ requestId, pageId, widgetId, revision, body, resolvedPeriod,
        workspace, defaultsRevision, periodConfig }), new Date().toISOString(), dashboardId,
      widgetId, revision, JSON.stringify(body), JSON.stringify(resolvedPeriod), JSON.stringify(workspace),
      pageId, defaultsRevision, periodConfig == null ? null : JSON.stringify(periodConfig)];
      return args;
    };
    const save = async args => (await query(pageSaveSql, args)).rows[0].receipt;
    const assertReceipt = async (receipt, pageId) => {
      assert.equal(receipt.pageId, pageId);
      const p = await page(pageId);
      assert.equal(receipt.defaultsRevision, p.defaults_revision);
      assert.equal(receipt.pageRevision, p.revision);
      assert.equal((await widget(receipt.widgetId)).page_id, pageId);
      assert.equal((await query(`select page_id from training_load.dashboard_simple_requests
        where initiator_user_id=$1 and request_id=$2`, [actorId, receipt.requestId])).rows[0].page_id, pageId);
    };
    const argsA = request(pageIds[0]), a = await save(argsA);
    await assertReceipt(a, pageIds[0]);
    const argsB = request(pageIds[1]), b = await save(argsB);
    await assertReceipt(b, pageIds[1]);
    const wa = await widget(a.widgetId), wb = await widget(b.widgetId);
    assert.deepEqual([wa.widget_order, wa.mobile_order, wa.x, wa.y], [0, 0, 0, 0]);
    assert.deepEqual([wb.widget_order, wb.mobile_order, wb.x, wb.y], [0, 0, 0, 0]);
    const c = await save(request(pageIds[0]));
    const wc = await widget(c.widgetId);
    assert.equal(wc.widget_order, 1); assert.equal(wc.mobile_order, 1);
    assert.ok(wc.x >= wa.x + wa.width || wa.x >= wc.x + wc.width ||
      wc.y >= wa.y + wa.height || wa.y >= wc.y + wc.height);
    passed.push('create: explicit parent, independent Page order/mobile/placement and no overlap');

    let before = await snapshot();
    await expectCode(pageSaveSql, request(pageIds[1], { widgetId: a.widgetId, revision: wa.revision }), 'S2C07');
    assert.deepEqual(await snapshot(), before);
    passed.push('foreign Page widget update rejected without side effects');
    assert.deepEqual(await save(argsA), a);
    const conflict = [...argsA]; conflict[10] = pageIds[1];
    await expectCode(pageSaveSql, conflict, 'S2C01');
    const changedHash = [...argsA]; changedHash[2] = 'f'.repeat(64) === argsA[2] ? 'e'.repeat(64) : 'f'.repeat(64);
    await expectCode(pageSaveSql, changedHash, 'S2C01');
    passed.push('receipt replay and cross-Page/hash request conflicts');

    const p0 = await page(pageIds[0]);
    const fixed = { schemaVersion: 1, mode: 'fixed', dateFrom: resolvedPeriod.dateFrom,
      dateTo: resolvedPeriod.dateTo, timeZone: resolvedPeriod.timeZone };
    const relative = { schemaVersion: 1, mode: 'relative', preset: 'last_7_days', timeZone: resolvedPeriod.timeZone };
    // Ensure the late-failure path would really change shared period fields.
    const rollbackPeriod = p0.period_config?.mode === 'fixed' ? relative : fixed;
    before = await snapshot();
    await expectCode(pageSaveSql, request(pageIds[0], { defaultsRevision: p0.defaults_revision + 1, periodConfig: fixed }), 'P4P04');
    assert.deepEqual(await snapshot(), before);
    // Force failure AFTER the shared-period update; verify rollback of defaults,
    // Page revisions, widget/series and request ledger, not just an early CAS error.
    const bad = copy(compiledWidget); bad.series = [];
    await expectCode(pageSaveSql, request(pageIds[0], { widget: bad,
      defaultsRevision: p0.defaults_revision, periodConfig: rollbackPeriod }), 'S2C04');
    assert.deepEqual(await snapshot(), before);
    await expectCode(pageSaveSql, request(pageIds[0], { defaultsRevision: p0.defaults_revision, periodConfig: {} }), 'P4P09');
    const fixedArgs = request(pageIds[0], { defaultsRevision: p0.defaults_revision, periodConfig: fixed });
    const fixedReceipt = await save(fixedArgs);
    await assertReceipt(fixedReceipt, pageIds[0]);
    assert.deepEqual((await page(pageIds[0])).period_config, fixed);
    const afterFixed = await page(pageIds[0]);
    await save(request(pageIds[0], { defaultsRevision: afterFixed.defaults_revision, periodConfig: relative }));
    const afterRelative = await page(pageIds[0]);
    assert.deepEqual(afterRelative.period_config, relative);
    assert.equal(afterRelative.defaults_revision, afterFixed.defaults_revision + 1);
    assert.ok(afterRelative.revision > afterFixed.revision);
    assert.deepEqual((await page(pageIds[0])).default_filter, p0.default_filter);
    assert.deepEqual(await page(pageIds[1]), before.pages.find(p => p.id === pageIds[1]));
    assert.deepEqual(await save(fixedArgs), fixedReceipt, 'replay precedes stale defaults CAS');
    const unchangedDefaults = await page(pageIds[0]);
    await save(request(pageIds[0], { defaultsRevision: -1 }));
    const ordinary = await page(pageIds[0]);
    assert.equal(ordinary.defaults_revision, unchangedDefaults.defaults_revision);
    assert.deepEqual(ordinary.period_config, unchangedDefaults.period_config);
    assert.deepEqual(ordinary.default_filter, unchangedDefaults.default_filter);
    passed.push('fixed/relative defaults CAS, failure rollback, filter preservation, ordinary save ignores defaults revision');

    // Produce a real stale widget revision, then replay the prior update.
    const editBody = copy(compiledWidget); editBody.id = a.widgetId;
    editBody.series[0].id = a.seriesId; editBody.title += ' page-simple-check';
    const editArgs = request(pageIds[0], { widgetId: a.widgetId, revision: (await widget(a.widgetId)).revision, widget: editBody });
    const editReceipt = await save(editArgs);
    const nextBody = copy(editBody); nextBody.title += ' 2';
    await save(request(pageIds[0], { widgetId: a.widgetId, revision: editReceipt.widgetRevision, widget: nextBody }));
    assert.deepEqual(await save(editArgs), editReceipt);
    passed.push('update parent retained; replay precedes stale widget revision');

    // Marker cannot open either legacy entry point on a multipage dashboard.
    await query("select set_config('training_load.page_mutation',$1,true)",
      [JSON.stringify({ dashboardId, pageId: pageIds[0], operation: 'simpleSave' })]);
    await expectCode(legacySaveSql, request(pageIds[0]).slice(0, 10), 'P4P01');
    await expectCode('select training_load.dashboard_legacy_page_guard($1)', [dashboardId], 'P4P01');
    await expectCode(legacySaveSql, argsA.slice(0, 10), 'S2C01');
    await query("select set_config('training_load.page_mutation','',true)");
    // Separate statements avoid depending on SELECT expression evaluation order.
    await query("select set_config('training_load.page_mutation',$1,true)",
      [JSON.stringify({ dashboardId: randomUUID(), pageId: pageIds[0], operation: 'simpleSave' })]);
    assert.equal((await query('select training_load.dashboard_page_internal($1,$2) as allowed',
      [dashboardId, pageIds[0]])).rows[0].allowed, false);
    await query("select set_config('training_load.page_mutation','',true)");
    passed.push('legacy save/guard stay closed even with simpleSave marker');

    // Model an already recorded pre-v58 receipt; do not add Page fields to it.
    const historicalArgs = request(pageIds[0]);
    const historicalReceipt = { ...a, requestId: historicalArgs[1] };
    delete historicalReceipt.pageId; delete historicalReceipt.defaultsRevision; delete historicalReceipt.pageRevision;
    await query(`insert into training_load.dashboard_simple_requests(initiator_user_id,request_id,dashboard_id,
      widget_id,workspace,payload_hash,request_issued_at,resolved_period,receipt,retain_until)
      values($1,$2,$3,null,$4::jsonb,$5,$6::timestamptz,$7::jsonb,$8::jsonb,$6::timestamptz+interval '168 hours 10 minutes')`,
    [actorId, historicalArgs[1], dashboardId, JSON.stringify(workspace), historicalArgs[2], historicalArgs[3],
      JSON.stringify(resolvedPeriod), JSON.stringify(historicalReceipt)]);
    const historicalReplay = (await query(legacySaveSql, historicalArgs.slice(0, 10))).rows[0].receipt;
    assert.deepEqual(historicalReplay, historicalReceipt);
    assert.equal(Object.hasOwn(historicalReplay, 'pageId'), false);
    await expectCode(pageSaveSql, historicalArgs, 'S2C01');
    passed.push('legacy receipt retains its original shape and cannot cross into Page save');

    // Ledger evidence alone cannot replay a widget from a different actual Page.
    await query('savepoint page_simple_parent_proof');
    try {
      await query(`update training_load.dashboard_simple_requests set receipt=jsonb_set(receipt,'{widgetId}',to_jsonb($3::text))
        where initiator_user_id=$1 and request_id=$2`, [actorId, argsA[1], b.widgetId]);
      await expectCode(pageSaveSql, argsA, 'S2C07');
    } finally {
      await query('rollback to savepoint page_simple_parent_proof');
      await query('release savepoint page_simple_parent_proof');
    }
    const wrongWorkspace = [...argsA]; wrongWorkspace[9] = JSON.stringify({ type: 'forged' });
    await expectCode(pageSaveSql, wrongWorkspace, 'P4P10');
    passed.push('replay requires fresh workspace authority and actual widget Page parent');


    await query("update training_load.dashboards set status='archived' where id=$1", [dashboardId]);
    assert.deepEqual(await save(argsA), a);
    assert.deepEqual(await save(fixedArgs), fixedReceipt);
    await expectCode(pageSaveSql, request(pageIds[0]), '40002');
    passed.push('archived replay succeeds; new archived save rejected');
    return { passed };
  } finally {
    await query('rollback');
  }
}

// Optional concurrency-only checks. Both clients must already be OPEN and IDLE
// on the SAME disposable local database, with v58 applied. Uses the same synthetic
// fixture arguments as runDashboardPageSimpleDbChecks, except clients: [a,b].
// COMMITS successful synthetic saves to prove visibility/replay across sessions;
// caller owns fixture/database disposal. Opens no clients and reads no env.
export async function runDashboardPageSimpleConcurrencyChecks({
  clients, databaseName, actorId, workspace, dashboardId, pageIds, compiledWidget, resolvedPeriod,
}) {
  assert.equal(clients?.length, 2);
  const [a, b] = clients;
  assert.notEqual(a, b);
  assert.equal(typeof databaseName, 'string');
  assert.match(databaseName, /(?:test|tmp|temp|disposable|fixture|s4b)/i);
  assert.doesNotMatch(databaseName, /^(?:optimove|postgres|template[01])$|monitoring2|prod/i);
  assert.equal(pageIds?.length, 2); assert.notEqual(pageIds[0], pageIds[1]);
  for (const id of [actorId, dashboardId, ...pageIds]) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  }
  assert.equal(compiledWidget?.series?.length, 1);
  const qa = (sql, args) => engineQuery(a, sql, args);
  const qb = (sql, args) => engineQuery(b, sql, args);
  const sessions = await Promise.all([qa, qb].map(query => query(`select current_database() as name,
    host(inet_server_addr()) as address, pg_backend_pid() as pid`)));
  for (const result of sessions) {
    assert.equal(result.rows[0].name, databaseName);
    assert.ok(result.rows[0].address == null || ['127.0.0.1', '::1'].includes(result.rows[0].address), 'local disposable PG only');
  }
  const [pidA, pidB] = sessions.map(result => result.rows[0].pid);
  assert.notEqual(pidA, pidB);
  assert.deepEqual((await qa('select training_load.dashboard_page_actor_workspace($1) as ws', [actorId])).rows[0].ws, workspace);
  for (const pageId of pageIds) {
    assert.equal((await qa('select dashboard_id from training_load.dashboard_pages where id=$1', [pageId])).rows[0]?.dashboard_id, dashboardId);
  }
  assert.equal((await qa('select status from training_load.dashboards where id=$1', [dashboardId])).rows[0]?.status, 'active');
  const makeArgs = (pageId, defaultsRevision = null, periodConfig = null) => {
    const requestId = randomUUID();
    return [actorId, requestId, hash({ requestId, dashboardId, pageId, defaultsRevision, periodConfig,
      compiledWidget, resolvedPeriod, workspace }), new Date().toISOString(), dashboardId, null, null,
    JSON.stringify(compiledWidget), JSON.stringify(resolvedPeriod), JSON.stringify(workspace),
    pageId, defaultsRevision, periodConfig == null ? null : JSON.stringify(periodConfig)];
  };
  const passed = [];
  const race = async (left, right, { replay = false, expectedError = null } = {}) => {
    let waiting;
    try {
      await qa('begin isolation level read committed');
      await qb('begin isolation level read committed');
      for (const query of [qa, qb]) {
        await query("set local lock_timeout='5s'");
        await query("set local statement_timeout='8s'");
      }
      // Model JS's request lock before entering SQL. The SQL function reacquires
      // exactly this key and must not acquire actor locks ahead of it on client B.
      await qa('select pg_advisory_xact_lock(hashtextextended($1,0))',
        [`dashboard-simple:${actorId.toLowerCase()}:${left[1].toLowerCase()}`]);
      const first = (await qa(pageSaveSql, left)).rows[0].receipt;
      let finished = false;
      waiting = qb(pageSaveSql, right).then(
        value => { finished = true; return { value }; },
        error => { finished = true; return { error }; },
      );
      let blocked = false;
      for (let i = 0; i < 200; i++) {
        const state = (await qa('select $1::int=any(pg_blocking_pids($2::int)) as blocked', [pidA, pidB])).rows[0];
        if (state.blocked) { blocked = true; break; }
        if (finished) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(blocked, true, 'B must wait on A before its commit');
      if (replay) {
        const locks = (await qa(`select
          exists(select 1 from pg_locks l where l.pid=$1 and l.locktype='advisory' and not l.granted) as request_wait,
          exists(select 1 from pg_locks l where l.pid=$1 and l.relation='public.users'::regclass
            and l.mode='RowShareLock' and l.granted) as actor_relation_locked`, [pidB])).rows[0];
        assert.equal(locks.request_wait, true, 'same request waits on advisory key');
        assert.equal(locks.actor_relation_locked, false, 'SQL must not enter actor FOR SHARE before the request lock');
      }
      await qa('commit');
      const second = await waiting;
      if (expectedError) {
        assert.equal(second.error?.code, expectedError, second.error?.message);
        await qb('rollback');
        return { first };
      }
      assert.ifError(second.error);
      const receipt = second.value.rows[0].receipt;
      await qb('commit');
      return { first, second: receipt };
    } finally {
      // Release blocker before draining B; server-side timeouts bound failures.
      try { await qa('rollback'); }
      finally { if (waiting) await waiting; await qb('rollback'); }
    }
  };

  const replayArgs = makeArgs(pageIds[0]);
  const replay = await race(replayArgs, [...replayArgs], { replay: true });
  assert.deepEqual(replay.second, replay.first);
  assert.equal((await qa(`select count(*)::int as n from training_load.dashboard_simple_requests
    where initiator_user_id=$1 and request_id=$2`, [actorId, replayArgs[1]])).rows[0].n, 1);
  assert.equal((await qa('select count(*)::int as n from training_load.dashboard_widgets where id=$1',
    [replay.first.widgetId])).rows[0].n, 1);
  passed.push('same actor/request: advisory wait before actor locks, then exact committed replay');

  const page = (await qa('select * from training_load.dashboard_pages where id=$1', [pageIds[0]])).rows[0];
  const fixed = { schemaVersion: 1, mode: 'fixed', dateFrom: resolvedPeriod.dateFrom,
    dateTo: resolvedPeriod.dateTo, timeZone: resolvedPeriod.timeZone };
  const relative = { schemaVersion: 1, mode: 'relative', preset: 'last_7_days', timeZone: resolvedPeriod.timeZone };
  const chosen = page.period_config?.mode === 'fixed' ? relative : fixed;
  const left = makeArgs(pageIds[0], page.defaults_revision, chosen);
  const right = makeArgs(pageIds[0], page.defaults_revision, chosen.mode === 'fixed' ? relative : fixed);
  const cas = await race(left, right, { expectedError: 'P4P04' });
  const afterCas = (await qa('select * from training_load.dashboard_pages where id=$1', [pageIds[0]])).rows[0];
  assert.equal(afterCas.defaults_revision, page.defaults_revision + 1);
  assert.equal(cas.first.defaultsRevision, afterCas.defaults_revision);
  assert.deepEqual(afterCas.period_config, chosen);
  assert.deepEqual(afterCas.default_filter, page.default_filter);
  assert.equal((await qa(`select count(*)::int as n from training_load.dashboard_simple_requests
    where initiator_user_id=$1 and request_id=any($2::uuid[])`, [actorId, [left[1], right[1]]])).rows[0].n, 1);
  passed.push('shared defaults CAS: dashboard wait, one committed success and one stale defaults rejection');

  // Minimal cross-Page serialization check; no Page deletion or unrelated writer.
  const across = await race(makeArgs(pageIds[0]), makeArgs(pageIds[1]));
  assert.equal(across.first.pageId, pageIds[0]);
  assert.equal(across.second.pageId, pageIds[1]);
  assert.notEqual(across.first.widgetId, across.second.widgetId);
  const actual = (await qa(`select id,page_id from training_load.dashboard_widgets where id=any($1::uuid[])`,
    [[across.first.widgetId, across.second.widgetId]])).rows;
  assert.equal(actual.find(w => w.id === across.first.widgetId)?.page_id, pageIds[0]);
  assert.equal(actual.find(w => w.id === across.second.widgetId)?.page_id, pageIds[1]);
  passed.push('different Page saves serialize on dashboard and both commit with their actual parents');
  return { passed };
}
