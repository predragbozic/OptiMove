import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';
import { createPostgresPreviewCoordinator } from '../src/dashboardSimple/postgresAdmission.js';
import { createPreviewAdmission } from '../src/dashboardSimple/previewAdmission.js';
import { checkoutObservedClient } from '../src/dashboardSimple/clientLifecycle.js';
import { withPreviewTransaction } from '../src/dashboardSimple/previewTransaction.js';
import { createDisposableDatabase } from './support/disposable-db.mjs';

const id = n => `abcdef00-0000-0000-0000-${String(n).padStart(12, '0')}`;
const busy = error => error.message === 'previewBusy' && error.code === 'previewBusy' && error.status === 429 && error.retryAfter === 1;
const tick = () => new Promise(resolve => setImmediate(resolve));
const begin = 'begin isolation level repeatable read read only';
function fakeClient(handler) {
  const client = new EventEmitter();
  client.calls = [];
  client.releases = [];
  client.release = destroy => client.releases.push(destroy);
  client.query = async query => {
    client.calls.push(query);
    if (handler) {
      const result = await handler(query, client);
      if (result) return result;
    }
    const sql = typeof query === 'string' ? query : query.text;
    if (sql === begin) return { command: 'BEGIN', rows: [] };
    if (sql === 'rollback') return { command: 'ROLLBACK', rows: [] };
    return { rows: [{ locked: true, mismatch: false, pid: 123, started: 'owned-transaction', isolation: 'repeatable read', read_only: 'on' }] };
  };
  return client;
}
let sequence = 0;
function setup(options = {}) {
  const clients = [];
  const pool = { connect(callback) {
    const client = fakeClient(options.handler);
    clients.push(client);
    callback(null, client);
    options.onCheckout?.(client);
  } };
  const processId = `pure-${++sequence}`;
  const config = { pool, processId, maxActiveDeployment: 2, checkoutTimeoutMs: 30, queryTimeoutMs: 30, ...options };
  return { coordinator: createPostgresPreviewCoordinator(config), clients, config,
    acquire: (n = 1, processLimit = 2) => ({ userId: id(n), processId, processLimit }) };
}

test('pure: validates configuration and trusted identity before checking out', async () => {
  for (const change of [{ pool: {} }, { processId: '' }, { maxActiveDeployment: 0 },
    { maxActiveDeployment: 17 }, { checkoutTimeoutMs: 0 }, { queryTimeoutMs: 1001 }]) {
    assert.throws(() => createPostgresPreviewCoordinator({ pool: { connect() {} }, processId: 'p', maxActiveDeployment: 2, ...change }), TypeError);
  }
  const s = setup();
  for (const request of [null, {}, { ...s.acquire(), processId: 'forged' }, { ...s.acquire(), userId: ' actor ' },
    { ...s.acquire(), userId: ` ${id(1)}` }, ...[0, 3, 1.5, '2'].map(processLimit => ({ ...s.acquire(), processLimit }))]) {
    await assert.rejects(s.coordinator.tryAcquire(request), busy);
  }
  assert.equal(s.clients.length, 0);
});

test('pure: one retained client; process cap shared across coordinator objects; idempotent release', async () => {
  const s = setup();
  const other = createPostgresPreviewCoordinator(s.config);
  const one = await s.coordinator.tryAcquire(s.acquire());
  const two = await other.tryAcquire(s.acquire(2));
  await assert.rejects(other.tryAcquire(s.acquire(3)), busy);
  await assert.rejects(other.tryAcquire(s.acquire(3, 1)), busy);
  assert.equal(s.clients.length, 2);
  assert.deepEqual(s.clients[0].releases, []);
  const releasing = one.release();
  assert.equal(one.release(), releasing);
  await releasing;
  await one.release();
  assert.deepEqual(s.clients[0].releases, [false]);
  const three = await other.tryAcquire(s.acquire(3));
  await Promise.all([two.release(), three.release()]);
  for (const client of s.clients) {
    assert.equal(client.listenerCount('error'), 0);
    assert.equal(client.listenerCount('end'), 0);
    assert.ok(client.calls.every(query => /^(?:select |begin |rollback$)/i.test(query.text) && query.query_timeout === 30 && !query.name));
    assert.ok(client.calls.every(query => !/pg_advisory_unlock|pg_try_advisory_lock\(/.test(query.text)));
  }
});

test('pure: user and slot keys are stable across budgets and UUID case', async () => {
  const a = setup();
  const b = setup({ maxActiveDeployment: 5 });
  const one = await a.coordinator.tryAcquire(a.acquire());
  const two = await b.coordinator.tryAcquire({ ...b.acquire(), userId: id(1).toUpperCase() });
  const lockKeys = s => s.clients[0].calls.filter(q => q.text === 'select pg_try_advisory_xact_lock($1::bigint) as locked').map(q => q.values[0]);
  assert.equal(lockKeys(a).length, 2);
  assert.deepEqual(lockKeys(a), lockKeys(b));
  await Promise.all([one.release(), two.release()]);
});

test('pure: late checkout is observed synchronously and destroyed; local counter recovers', async () => {
  let callback;
  const s = setup({ pool: { connect(cb) { callback = cb; } }, checkoutTimeoutMs: 10 });
  await assert.rejects(s.coordinator.tryAcquire(s.acquire(1, 1)), busy);
  const late = fakeClient();
  callback(null, late);
  late.emit('error', new Error('private late failure'));
  await tick();
  assert.deepEqual(late.releases, [true]);
  assert.equal(late.calls.length, 0);
  const next = s.coordinator.tryAcquire(s.acquire(2, 1));
  callback(null, fakeClient());
  await (await next).release();
});

test('pure: immediate checkout disconnect is caught without unhandled error', async () => {
  const s = setup({ onCheckout: client => client.emit('error', new Error('secret')) });
  await assert.rejects(s.coordinator.tryAcquire(s.acquire()), busy);
  assert.deepEqual(s.clients[0].releases, [true]);
  assert.equal(s.clients[0].calls.length, 0);
});

test('pure: checkout and all admission queries share a 400ms acquisition deadline', async () => {
  let callback, finish;
  const s = setup({ pool: { connect(cb) { callback = cb; } }, checkoutTimeoutMs: 400, queryTimeoutMs: 300 });
  const started = performance.now();
  const pending = assert.rejects(s.coordinator.tryAcquire(s.acquire(1, 1)), busy);
  await new Promise(resolve => setTimeout(resolve, 250));
  const client = fakeClient(() => new Promise(resolve => { finish = resolve; }));
  callback(null, client);
  await pending;
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 500, `combined acquisition took ${elapsed}ms`);
  assert.deepEqual(client.releases, [true]);
  finish({ rows: [{ locked: true }] });
  await tick();
  assert.equal(client.calls.length, 1);
});

test('pure: admission failure paths destroy sessions and restore the process counter', async t => {
  for (const mode of ['conflict', 'config', 'user', 'slots', 'query', 'timeout', 'disconnect']) {
    await t.test(mode, async () => {
      let failing = true, lockNumber = 0;
      const s = setup({ handler(query, client) {
        if (!failing) return;
        if (mode === 'query') throw new Error('raw SQL secret');
        if (mode === 'timeout') return new Promise(() => {});
        if (mode === 'disconnect') { client.emit('end'); return new Promise(() => {}); }
        if (mode === 'conflict' && query.text.includes('pg_locks')) return { rows: [{ mismatch: true }] };
        if (mode === 'config' && query.text.includes('pg_try_advisory_xact_lock_shared')) return { rows: [{ locked: false }] };
        if (query.text.includes('pg_try_advisory_xact_lock(')) {
          lockNumber += 1;
          if (mode === 'user' && lockNumber === 1 || mode === 'slots' && lockNumber > 1) return { rows: [{ locked: false }] };
        }
      } });
      await assert.rejects(s.coordinator.tryAcquire(s.acquire(1, 1)), busy);
      assert.deepEqual(s.clients[0].releases, [true]);
      failing = false;
      await (await s.coordinator.tryAcquire(s.acquire(2, 1))).release();
    });
  }
});

test('pure: failed or stalled rollback destroys once, rejects safely, and restores capacity', async t => {
  for (const mode of ['false', 'throw', 'timeout', 'disconnect']) {
    await t.test(mode, async () => {
      const s = setup({ handler(query, client) {
        if (query.text !== 'rollback') return;
        if (mode === 'false') return { command: 'SELECT', rows: [] };
        if (mode === 'throw') throw new Error('private rollback failure');
        if (mode === 'disconnect') client.emit('error', new Error('private connection failure'));
        return new Promise(() => {});
      } });
      const lease = await s.coordinator.tryAcquire(s.acquire(1, 1));
      await assert.rejects(lease.release(), busy);
      await assert.rejects(lease.release(), busy);
      assert.deepEqual(s.clients[0].releases, [true]);
      const next = await s.coordinator.tryAcquire(s.acquire(2, 1));
      s.clients[1].emit('end');
      await assert.rejects(next.release(), busy);
    });
  }
});

test('pure: adapter lease stays held until createPreviewAdmission release after SQL cleanup', async () => {
  const s = setup();
  const admission = createPreviewAdmission({ coordinator: s.coordinator, processId: s.config.processId, poolMax: 5 });
  const lease = await admission.tryAcquire({ userId: id(1) });
  assert.deepEqual(s.clients[0].releases, []);
  let finishCleanup;
  const cleanup = new Promise(resolve => { finishCleanup = resolve; });
  const completion = cleanup.then(() => lease.release());
  await tick();
  assert.deepEqual(s.clients[0].releases, []);
  finishCleanup();
  await completion;
  assert.deepEqual(s.clients[0].releases, [false]);
});

test('pure: queryPool is one-shot and shares the lock session through rollback and onReleased', async () => {
  const s = setup();
  const lease = await s.coordinator.tryAcquire(s.acquire(1, 1));
  await withPreviewTransaction({ pool: lease.queryPool, onReleased: () => lease.release() }, async query => {
    await query('select 42');
    assert.deepEqual(s.clients[0].releases, []);
    await assert.rejects(checkoutObservedClient(lease.queryPool), busy);
  });
  assert.equal(s.clients.length, 1);
  const sql = s.clients[0].calls.map(call => typeof call === 'string' ? call : call.text);
  assert.equal(sql.filter(text => text === begin).length, 1);
  assert.equal(sql.filter(text => text === 'rollback').length, 1);
  assert.equal(sql.at(-1), 'rollback');
  assert.ok(sql.every(text => !text.includes('pg_advisory_unlock')));
  assert.deepEqual(s.clients[0].releases, [false]);
});

test('pure: queryPool exposes immutable finite transaction start captured immediately before real BEGIN', async () => {
  let beginObservedAt, finishBegin;
  const s = setup({ handler(query) {
    if (query.text === begin) {
      beginObservedAt = performance.now();
      return new Promise(resolve => { finishBegin = () => resolve({ command: 'BEGIN', rows: [] }); });
    }
  } });
  const beforeAcquire = performance.now();
  const pending = s.coordinator.tryAcquire(s.acquire());
  await tick();
  assert.equal(typeof finishBegin, 'function');
  await new Promise(resolve => setTimeout(resolve, 5));
  const beforeBeginCompleted = performance.now();
  finishBegin();
  const lease = await pending;
  const { transactionStartedAt } = lease.queryPool;
  assert.ok(Number.isFinite(transactionStartedAt));
  assert.ok(transactionStartedAt >= beforeAcquire);
  assert.ok(transactionStartedAt <= beginObservedAt);
  assert.ok(transactionStartedAt < beforeBeginCompleted);
  assert.ok(Object.isFrozen(lease.queryPool));
  assert.throws(() => { lease.queryPool.transactionStartedAt = 0; }, TypeError);
  assert.equal(lease.queryPool.transactionStartedAt, transactionStartedAt);
  await lease.release();
});

test('pure: early admission release cannot unlock while same-session preview query is active', async () => {
  let finish;
  const s = setup({ handler(query) {
    if (query === 'select active_preview') return new Promise(resolve => { finish = resolve; });
  } });
  const lease = await s.coordinator.tryAcquire(s.acquire(1, 1));
  const { client, lifecycle } = await checkoutObservedClient(lease.queryPool);
  await client.query(begin);
  const running = client.query('select active_preview');
  await tick();
  await assert.rejects(lease.release(), busy);
  await assert.rejects(s.coordinator.tryAcquire(s.acquire(2, 1)), busy);
  assert.equal(s.clients[0].calls.some(query => query.text === 'rollback' || query === 'rollback'), false);
  assert.deepEqual(s.clients[0].releases, []);
  finish({ rows: [] });
  await running;
  await client.query('rollback');
  lifecycle.release(false);
  assert.deepEqual(s.clients[0].releases, []);
  await lease.release();
  assert.deepEqual(s.clients[0].releases, [false]);
});

test('pure: shared session disconnect rejects active preview SQL and destroys without unlocking', async () => {
  const s = setup({ handler(query) { if (query === 'select active_preview') return new Promise(() => {}); } });
  const lease = await s.coordinator.tryAcquire(s.acquire(1, 1));
  const { client, lifecycle } = await checkoutObservedClient(lease.queryPool);
  await client.query(begin);
  const running = client.query('select active_preview');
  const rejected = assert.rejects(running, { code: 'connectionLost' });
  await tick();
  s.clients[0].emit('error', new Error('private session fault'));
  await rejected;
  lifecycle.release(true);
  await assert.rejects(lease.release(), busy);
  assert.deepEqual(s.clients[0].releases, [true]);
  assert.equal(s.clients[0].calls.some(query => query.text === 'rollback' || query === 'rollback'), false);
  await (await s.coordinator.tryAcquire(s.acquire(2, 1))).release();
});

test('pure: destroying query checkout destroys shared session without an unlock query', async () => {
  const s = setup();
  const lease = await s.coordinator.tryAcquire(s.acquire(1, 1));
  const { lifecycle } = await checkoutObservedClient(lease.queryPool);
  lifecycle.release(true);
  await lease.release();
  await lease.release();
  assert.deepEqual(s.clients[0].releases, [true]);
  assert.equal(s.clients[0].calls.some(query => query.text === 'rollback' || query === 'rollback'), false);
  await (await s.coordinator.tryAcquire(s.acquire(2, 1))).release();
});

test('pure: transaction handoff validates ownership and refuses control or prepared-query bypasses', async t => {
  for (const mode of ['pid', 'started', 'isolation', 'read_only', 'validationError', 'missingBegin', 'secondBegin', 'alternateBegin', 'commit', 'prepared']) {
    await t.test(mode, async () => {
      let validatingHandoff = false;
      const s = setup({ handler(query) {
        if (!validatingHandoff || !query.text?.includes('transaction_timestamp()')) return;
        if (mode === 'validationError') throw new Error('private handoff error');
        const changes = { pid: { pid: 456 }, started: { started: 'different-transaction' },
          isolation: { isolation: 'read committed' }, read_only: { read_only: 'off' } };
        if (changes[mode]) return { rows: [{ pid: 123, started: 'owned-transaction', isolation: 'repeatable read', read_only: 'on', ...changes[mode] }] };
      } });
      const lease = await s.coordinator.tryAcquire(s.acquire(1, 1));
      const { client, lifecycle } = await checkoutObservedClient(lease.queryPool);
      validatingHandoff = true;
      const changesIdentity = ['pid', 'started', 'isolation', 'read_only', 'validationError'].includes(mode);
      if (changesIdentity) await assert.rejects(client.query(begin), busy);
      else {
        if (mode !== 'missingBegin' && mode !== 'alternateBegin') await client.query(begin);
        const attempted = { missingBegin: 'select 1', secondBegin: begin, alternateBegin: 'BEGIN', commit: 'commit', prepared: { name: 'preview', text: 'select 1' } }[mode];
        await assert.rejects(client.query(attempted), busy);
      }
      lifecycle.release(true);
      await lease.release();
      assert.deepEqual(s.clients[0].releases, [true]);
      const sql = s.clients[0].calls.map(query => typeof query === 'string' ? query : query.text);
      assert.equal(sql.filter(text => text === begin).length, 1);
      assert.equal(sql.some(text => /^commit$/i.test(text)), false);
      assert.ok(s.clients[0].calls.every(query => !query.name));
    });
  }
});

const admissionDatabaseUrl = process.env.DASHBOARD_SIMPLE_POSTGRES_TEST_URL ?? process.env.DATABASE_URL;
test('real PostgreSQL: independent pools/processes enforce user, deployment, budget and disconnect admission', {
  skip: !admissionDatabaseUrl,
  timeout: 30000,
}, async t => {
  const db = await createDisposableDatabase({ prefix: 'dashboard', label: 'pg_admission', baseDatabaseUrl: admissionDatabaseUrl });
  const pools = Array.from({ length: 3 }, () => new pg.Pool({ connectionString: db.url, max: 4, connectionTimeoutMillis: 500 }));
  let child;
  const coordinator = (index, budget = 2) => createPostgresPreviewCoordinator({ pool: pools[index], processId: `db-${index}`, maxActiveDeployment: budget });
  const a = coordinator(0), b = coordinator(1);
  const request = (n, index = 0) => ({ userId: id(n), processId: `db-${index}`, processLimit: 2 });
  const leases = new Set();
  const acquire = async (owner, req) => { const lease = await owner.tryAcquire(req); leases.add(lease); return lease; };
  const release = async lease => { try { await lease.release(); } finally { leases.delete(lease); } };
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await Promise.allSettled([...leases].map(lease => lease.release()));
    try { await Promise.all(pools.map(pool => pool.end())); }
    finally { await db.drop(); }
  });
  const one = await acquire(a, request(1));
  await assert.rejects(b.tryAcquire({ ...request(1, 1), userId: id(1).toUpperCase() }), busy);
  await assert.rejects(coordinator(2, 3).tryAcquire(request(3, 2)), busy);
  const two = await acquire(b, request(2, 1));
  await assert.rejects(coordinator(2).tryAcquire(request(3, 2)), busy);
  assert.equal(pools[0].totalCount - pools[0].idleCount, 1);
  assert.equal((await pools[0].query('select 42 as healthy')).rows[0].healthy, 42);
  await release(two);

  const checkout = await checkoutObservedClient(one.queryPool);
  await checkout.client.query(begin);
  const sessionSql = "select pg_backend_pid() as pid, transaction_timestamp()::text as started, current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only";
  const owned = (await checkout.client.query(sessionSql)).rows[0];
  assert.equal(owned.isolation, 'repeatable read');
  assert.equal(owned.read_only, 'on');
  assert.equal((await pools[2].query("select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = $1", [owned.pid])).rows[0].n, 3);
  const sleeping = checkout.client.query('select pg_sleep(0.3) as protected_preview');
  let activeQuery = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const activity = await pools[2].query("select 1 from pg_stat_activity where datname = current_database() and state = 'active' and query = $1", ['select pg_sleep(0.3) as protected_preview']);
    if (activity.rowCount) { activeQuery = true; break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(activeQuery, true);
  await assert.rejects(one.release(), busy);
  await assert.rejects(b.tryAcquire(request(1, 1)), busy);
  await sleeping;
  assert.deepEqual((await checkout.client.query(sessionSql)).rows[0], owned);

  child = fork(new URL('./fixtures/dashboard-simple/postgres-admission-worker.mjs', import.meta.url), { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
  let serial = 0;
  const command = message => new Promise((resolve, reject) => {
    const seq = ++serial;
    const timer = setTimeout(() => { cleanup(); reject(new Error('Child response timed out')); }, 3000);
    const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('error', fail); child.off('exit', fail); };
    const fail = () => { cleanup(); reject(new Error('Child exited or failed')); };
    const receive = reply => { if (reply.seq === seq) { cleanup(); resolve(reply); } };
    child.on('message', receive); child.once('error', fail); child.once('exit', fail);
    child.send({ seq, ...message });
  });
  assert.equal((await command({ operation: 'init', url: db.url, name: db.name })).ok, true);
  assert.equal((await command({ operation: 'acquire', userId: id(1) })).code, 'previewBusy');
  assert.equal((await command({ operation: 'acquire', userId: id(4) })).ok, true);
  await assert.rejects(b.tryAcquire(request(5, 1)), busy);
  assert.equal((await command({ operation: 'release', userId: id(4) })).ok, true);
  const childLease = await command({ operation: 'acquire', userId: id(4) });
  assert.equal(childLease.ok, true);
  await pools[2].query('select pg_terminate_backend($1)', [childLease.pid]);
  assert.equal((await command({ operation: 'waitDisconnect' })).ok, true);
  const recovered = await acquire(b, request(4, 1));
  await release(recovered);
  assert.equal((await command({ operation: 'release', userId: id(4) })).code, 'previewBusy');
  assert.equal((await command({ operation: 'healthy' })).ok, true);

  const activeChild = await command({ operation: 'acquire', userId: id(7) });
  assert.equal(activeChild.ok, true);
  const childRunning = command({ operation: 'startQuery', userId: id(7) });
  assert.equal((await childRunning).ok, true);
  let activeChildQuery = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const activity = await pools[2].query("select 1 from pg_stat_activity where pid = $1 and state = 'active' and query = 'select pg_sleep(10)'", [activeChild.pid]);
    if (activity.rowCount) { activeChildQuery = true; break; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(activeChildQuery, true);
  assert.equal((await command({ operation: 'release', userId: id(7) })).code, 'previewBusy');
  await assert.rejects(b.tryAcquire(request(7, 1)), busy);
  await pools[2].query('select pg_terminate_backend($1)', [activeChild.pid]);
  assert.equal((await command({ operation: 'finishQuery' })).code, 'queryFailed');
  const afterKilledQuery = await acquire(b, request(7, 1));
  await release(afterKilledQuery);
  assert.equal((await command({ operation: 'healthy' })).ok, true);

  await checkout.client.query('rollback');
  assert.equal((await pools[2].query("select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = $1", [owned.pid])).rows[0].n, 0);
  await assert.rejects(checkout.client.query('select 1'), busy);
  checkout.lifecycle.release(false);
  await release(one);
  const upgraded = await acquire(coordinator(2, 3), request(6, 2));
  await release(upgraded);
  const integrated = await acquire(a, request(8));
  await withPreviewTransaction({ pool: integrated.queryPool, onReleased: () => release(integrated) }, async query => {
    const first = (await query(sessionSql)).rows[0];
    assert.deepEqual((await query(sessionSql)).rows[0], first);
    assert.equal(first.read_only, 'on');
    assert.equal(first.isolation, 'repeatable read');
  });
  assert.equal((await pools[2].query("select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())")).rows[0].n, 0);
  assert.equal((await pools[2].query("select count(*)::int as n from pg_tables where schemaname = 'public'")).rows[0].n, 0);
});
