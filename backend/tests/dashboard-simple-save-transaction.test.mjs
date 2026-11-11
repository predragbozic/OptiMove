import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSimpleSaveTransaction } from '../src/dashboardSimple/saveTransaction.js';

function fixture(handler = async () => ({ rows: [] })) {
  const queries = [], releases = [];
  const client = { query: async sql => { queries.push(sql); return handler(sql); }, release: destroy => releases.push(destroy) };
  return { queries, releases, pool: { connect: async () => client } };
}
const receipt = { requestId: 'request', widgetId: 'widget' };
const options = { requestId: 'request', checkoutTimeoutMs: 20, transactionTimeoutMs: 100, statementTimeoutMs: 50, commitTimeoutMs: 20, recoveryTimeoutMs: 30 };

test('acknowledged save commits once, releases a clean client and skips recovery', async () => {
  const state = fixture();
  let recoveries = 0;
  const result = await runSimpleSaveTransaction({ ...options, pool: state.pool, write: async query => {
    await query('select sanctioned_writer()');
    return { receipt };
  }, verify: async () => { recoveries++; } });
  assert.deepEqual(result, { ...receipt, verification: 'commitAcknowledged' });
  assert.equal(state.queries.filter(sql => sql === 'commit').length, 1);
  assert.deepEqual(state.releases, [false]);
  assert.equal(recoveries, 0);
});

test('completed ledger replay commits its read and preserves receipt', async () => {
  const state = fixture();
  const result = await runSimpleSaveTransaction({ ...options, pool: state.pool, write: async () => ({ receipt, replayed: true }), verify: async () => null });
  assert.deepEqual(result, { ...receipt, verification: 'replayed' });
});

test('precommit failure confirms rollback; rejected queued operations never execute', async () => {
  const state = fixture();
  await assert.rejects(runSimpleSaveTransaction({ ...options, pool: state.pool, write: async query => {
    await query('update forbidden set value=1');
    return { receipt };
  }, verify: async () => null }), error => error.code === 'saveFailed');
  assert.equal(state.queries.includes('commit'), false);
  assert.equal(state.queries.some(sql => sql.startsWith('update')), false);
  assert.equal(state.queries.at(-1), 'rollback');
  assert.deepEqual(state.releases, [false]);
});

test('lost commit acknowledgement destroys original client and verifies without rollback or second write', async () => {
  const state = fixture(async sql => { if (sql === 'commit') throw new Error('lost acknowledgement'); return { rows: [] }; });
  let writes = 0, recoveries = 0;
  const result = await runSimpleSaveTransaction({ ...options, pool: state.pool, write: async () => { writes++; return { receipt }; }, verify: async () => { recoveries++; return receipt; } });
  assert.deepEqual(result, { ...receipt, verification: 'verifiedAfterCommitError' });
  assert.equal(writes, 1);
  assert.equal(recoveries, 1);
  assert.deepEqual(state.releases, [true]);
  assert.equal(state.queries.includes('rollback'), false);
});

test('uncertain commit with absent or unavailable recovery reports only unknown outcome', async () => {
  for (const verify of [async () => null, async () => { throw new Error('unavailable'); }, async () => new Promise(() => {})]) {
    const state = fixture(async sql => { if (sql === 'commit') throw new Error('lost acknowledgement'); });
    await assert.rejects(runSimpleSaveTransaction({ ...options, pool: state.pool, write: async () => ({ receipt }), verify }), error => error.code === 'outcomeUnknown' && error.requestId === 'request');
    assert.equal(state.queries.includes('rollback'), false);
    assert.deepEqual(state.releases, [true]);
  }
});

test('recovery rechecks current authorization and refuses a revoked target', async () => {
  const state = fixture(async sql => { if (sql === 'commit') throw new Error('lost acknowledgement'); });
  await assert.rejects(runSimpleSaveTransaction({ ...options, pool: state.pool, write: async () => ({ receipt }), verify: async () => { throw Object.assign(new Error('notFound'), { code: 'notFound', status: 404 }); } }), error => error.code === 'notFound');
});

test('late pool checkout is destroyed without executing a write', async () => {
  let deliver;
  const releases = [];
  const pool = { connect: () => new Promise(resolve => { deliver = resolve; }) };
  let writes = 0;
  await assert.rejects(runSimpleSaveTransaction({ ...options, pool, write: async () => { writes++; return { receipt }; }, verify: async () => null }), error => error.code === 'saveBusy');
  deliver({ release: destroy => releases.push(destroy) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(releases, [true]);
  assert.equal(writes, 0);
});

test('unconfirmed rollback destroys client and retains unknown-outcome semantics', async () => {
  const state = fixture(async sql => { if (sql === 'rollback') throw new Error('connection lost'); });
  await assert.rejects(runSimpleSaveTransaction({ ...options, pool: state.pool, write: async () => { throw new Error('failed'); }, verify: async () => null }), error => error.code === 'outcomeUnknown');
  assert.deepEqual(state.releases, [true]);
  assert.equal(state.queries.includes('commit'), false);
});
