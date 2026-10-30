import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { checkoutObservedClient } from '../src/dashboardSimple/clientLifecycle.js';
import { runSimpleSaveTransaction } from '../src/dashboardSimple/saveTransaction.js';
import { withPreviewTransaction } from '../src/dashboardSimple/previewTransaction.js';

function boundaryFixture({ deferred = false } = {}) {
  const evidence = { listeners: [], escaped: [], queries: [], releases: [], poolErrors: [] };
  let deliver;
  class NoSocketClient extends pg.Client {
    connect(callback) {
      this._connecting = true;
      this._connectionCallback = callback;
      deliver = () => {
        this._handleReadyForQuery({ status: 'I' });
        evidence.listeners.push(this.listenerCount('error'));
        try {
          this._handleErrorMessage(Object.assign(new Error('boundary disconnect'), { code: '57P01' }));
        } catch (error) {
          evidence.escaped.push(error.code);
        }
      };
      if (!deferred) queueMicrotask(deliver);
    }
    query(sql) {
      evidence.queries.push(sql);
      return Promise.resolve({ rows: [] });
    }
    end(callback) {
      this._ending = true;
      callback?.();
    }
  }
  const pool = new pg.Pool({ Client: NoSocketClient, max: 1 });
  pool.on('error', error => evidence.poolErrors.push(error));
  pool.on('release', destroy => evidence.releases.push(Boolean(destroy)));
  return { pool, evidence, deliver: () => deliver() };
}

function assertContained({ pool, evidence }) {
  assert.deepEqual(evidence.listeners, [1], 'observer must already own the checked-out client');
  assert.deepEqual(evidence.escaped, [], 'FATAL must not escape before Promise continuations');
  assert.deepEqual(evidence.poolErrors, [], 'checked-out failure belongs to its lifecycle');
  assert.deepEqual(evidence.queries, [], 'a failed checkout must not issue SQL');
  assert.deepEqual(evidence.releases, [true]);
  assert.equal(pool.totalCount, 0, 'failed client must be removed from the pool');
}

test('callback checkout observes FATAL synchronously before resolving to its caller', async () => {
  const state = boundaryFixture();
  try {
    const { lifecycle } = await checkoutObservedClient(state.pool);
    assert.throws(() => lifecycle.check(), error => error.code === 'connectionLost');
    await assert.rejects(lifecycle.run(() => assert.fail('must not start')), error => error.code === 'connectionLost');
    lifecycle.release(false);
    assertContained(state);
  } finally { await state.pool.end(); }
});

for (const mode of ['save', 'preview']) {
  const invoke = (pool, checkoutTimeoutMs, operation) => mode === 'save'
    ? runSimpleSaveTransaction({ pool, checkoutTimeoutMs, requestId: 'boundary', write: operation,
      verify: () => assert.fail('precommit disconnect must not start recovery') })
    : withPreviewTransaction({ pool, checkoutTimeoutMs }, operation);

  test(`${mode} contains a checkout-boundary FATAL without starting transaction work`, async () => {
    const state = boundaryFixture();
    try {
      await assert.rejects(invoke(state.pool, 1000, () => assert.fail('must not start')),
        error => error.code === (mode === 'save' ? 'outcomeUnknown' : 'connectionLost'));
      assertContained(state);
    } finally { await state.pool.end(); }
  });

  test(`${mode} observes and destroys a late checkout that fails before Promise continuations`, async () => {
    const state = boundaryFixture({ deferred: true });
    try {
      await assert.rejects(invoke(state.pool, 10, () => assert.fail('must not start')),
        error => error.code === (mode === 'save' ? 'saveBusy' : 'previewBusy'));
      state.deliver();
      await new Promise(resolve => setImmediate(resolve));
      assertContained(state);
    } finally { await state.pool.end(); }
  });
}
