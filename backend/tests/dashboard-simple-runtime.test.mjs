import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.execArgv.includes('--experimental-test-module-mocks')) {
  test('runtime startup and admission wiring with an isolated database mock', () => {
    const child = spawnSync(process.execPath, ['--experimental-test-module-mocks','--test','--test-isolation=none',fileURLToPath(import.meta.url)], { encoding: 'utf8' });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
} else {
  mock.module('../src/db.js', { namedExports: { query: async () => { throw new Error('Unexpected application DB query'); } } });
  const { createSimpleRuntime, SIMPLE_MIGRATION_NAME, SIMPLE_MIGRATION_SHA256 } = await import('../src/dashboardSimple/runtime.js');
  const { createPreviewAdmission } = await import('../src/dashboardSimple/previewAdmission.js');
  const { withPreviewTransaction } = await import('../src/dashboardSimple/previewTransaction.js');
  const env = () => ({ DASHBOARD_SIMPLE_MODE: 'enabled', DASHBOARD_SIMPLE_BUDGET_VERIFIED: 'true', DASHBOARD_SIMPLE_SESSION_AFFINITY_VERIFIED: 'true', DASHBOARD_SIMPLE_PREVIEW_MAX_ACTIVE: '2', DASHBOARD_SIMPLE_KEY_ID: 'current', DASHBOARD_SIMPLE_KEY_BASE64: Buffer.alloc(32,44).toString('base64') });
  function fixture({ ledger, shape } = {}) {
    const queries = [];
    const client = new EventEmitter();
    client.query = async sql => {
      queries.push(sql);
      if (sql.includes('from public.schema_migrations')) return { rows: ledger ?? [{ migration_name: SIMPLE_MIGRATION_NAME, checksum: SIMPLE_MIGRATION_SHA256 }] };
      if (sql.includes('information_schema.columns')) return { rows: [shape ?? { presentation: true, receipts: true, writer: true }] };
      return { rows: [] };
    };
    client.release = () => {};
    return { pool: { connect(callback) { callback(null,client); } }, queries };
  }
  test('off performs no database access and mounts nothing', async () => {
    assert.deepEqual(await createSimpleRuntime({ env: {}, pool: { connect() { throw new Error('No checkout allowed'); } } }), { mode: 'off', router: null });
  });
  test('active startup verifies the expected ledger and shape inside a read-only transaction', async () => {
    const f = fixture();
    const runtime = await createSimpleRuntime({ env: env(), pool: f.pool, poolMax: 5, queryDashboard: async () => [] });
    assert.equal(runtime.mode,'enabled');
    assert.equal(typeof runtime.router,'function');
    assert.ok(f.queries.includes('begin isolation level repeatable read read only'));
    assert.equal(f.queries.at(-1),'rollback');
    assert.equal(f.queries.filter(sql => sql.includes('from public.schema_migrations')).length,1);
  });
  test('missing, old, duplicate or changed migration and incomplete shape fail closed without leaking data', async () => {
    for (const input of [{ ledger: [] }, { ledger: [{ migration_name: 'old', checksum: 'secret' }] }, { ledger: [{ migration_name: SIMPLE_MIGRATION_NAME, checksum: 'secret' }] }, { ledger: Array(2).fill({ migration_name: SIMPLE_MIGRATION_NAME, checksum: SIMPLE_MIGRATION_SHA256 }) }, { shape: { presentation: false, receipts: true, writer: true } }]) {
      const f = fixture(input);
      await assert.rejects(createSimpleRuntime({ env: env(), pool: f.pool, poolMax: 5, queryDashboard: async () => [] }), error => error.code === 'simpleRuntimeConfiguration' && !error.message.includes('secret'));
      assert.equal(f.queries.at(-1),'rollback');
    }
  });
  test('drain does not require signing secrets but still verifies receipt schema', async () => {
    const f = fixture();
    const runtime = await createSimpleRuntime({ env: { DASHBOARD_SIMPLE_MODE: 'drain' }, pool: f.pool, poolMax: 5, queryDashboard: async () => [] });
    assert.equal(runtime.mode,'drain');
    assert.equal(typeof runtime.router,'function');
    assert.ok(f.queries.some(sql => sql.includes('information_schema.columns')));
  });
  test('transaction pool endpoints fail closed before checkout with sanitized errors', async () => {
    for (const connectionString of ['postgresql://u:secret@db.test:6543/app','postgresql://u:secret@db.test:5432/app?port=6543','postgresql://u:secret@db.test:5432/app?pgbouncer=true']) {
      const f=fixture();f.pool.options={connectionString};
      await assert.rejects(createSimpleRuntime({env:env(),pool:f.pool,poolMax:5,queryDashboard:async()=>[]}), error=>error.code==='simpleRuntimeConfiguration'&&!error.message.includes('secret'));
      assert.equal(f.queries.length,0);
    }
  });
  test('admission forwards the trusted one-use query pool and releases it once', async () => {
    let released = 0;
    const queryPool = { connect() {} };
    const admission = createPreviewAdmission({ coordinator: { tryAcquire: async () => ({ queryPool, release: async () => { released++; } }) }, processId: 'test', poolMax: 5 });
    const lease = await admission.tryAcquire({ userId: 'user' });
    assert.equal(lease.queryPool,queryPool);
    await lease.release(); await lease.release();
    assert.equal(released,1);
  });
  test('malformed trusted query pool cannot become a usable lease', async () => {
    let released = 0;
    const admission = createPreviewAdmission({ coordinator: { tryAcquire: async () => ({ queryPool: {}, release: async () => { released++; } }) }, processId: 'test', poolMax: 5 });
    await assert.rejects(admission.tryAcquire({ userId: 'user' }), error => error.code === 'previewBusy');
    await Promise.resolve();
    assert.equal(released,1);
  });
  test('admission time counts against the original transaction budget', async () => {
    const f=fixture();f.pool.transactionStartedAt=performance.now()-20;
    await assert.rejects(withPreviewTransaction({pool:f.pool,transactionTimeoutMs:1},async()=>assert.fail('Expired transaction must not execute work')),error=>error.code==='previewTimeout');
    assert.deepEqual(f.queries,[]);
    f.pool.transactionStartedAt=performance.now()+5000;
    await assert.rejects(withPreviewTransaction({pool:f.pool},async()=>assert.fail('Invalid start must not execute work')),error=>error.code==='previewCleanupFailed');
    assert.deepEqual(f.queries,[]);
  });
}
