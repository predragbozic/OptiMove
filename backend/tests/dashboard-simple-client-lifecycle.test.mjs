import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { observeCheckedOutClient } from '../src/dashboardSimple/clientLifecycle.js';
import { runSimpleSaveTransaction } from '../src/dashboardSimple/saveTransaction.js';
import { withPreviewTransaction } from '../src/dashboardSimple/previewTransaction.js';

test('client errors interrupt idle callbacks, force destruction and remove owned listeners after pool handoff', async () => {
  const client = new EventEmitter(), releases = [];
  client.release = destroy => { assert.equal(client.listenerCount('error'), 1); releases.push(destroy); };
  const lifecycle = observeCheckedOutClient(client);
  const pending = lifecycle.run(() => new Promise(() => {}));
  client.emit('error', new Error('socket failure'));
  client.emit('error', new Error('second error'));
  await assert.rejects(pending, error => error.code === 'connectionLost');
  assert.throws(() => lifecycle.check(), error => error.code === 'connectionLost');
  lifecycle.release(false);
  lifecycle.release(true);
  assert.deepEqual(releases, [true]);
  assert.equal(client.listenerCount('error'), 0);
  assert.equal(client.listenerCount('end'), 0);
});

test('a disconnect before a scheduled operation prevents it from issuing late SQL', async () => {
  const client = new EventEmitter();
  client.release = () => {};
  const lifecycle = observeCheckedOutClient(client);
  let calls = 0;
  const pending = lifecycle.run(() => { calls++; });
  client.emit('end');
  await assert.rejects(pending, error => error.code === 'connectionLost');
  assert.equal(calls, 0);
  lifecycle.release();
});

test('healthy handoff restores listener counts and permits later checkout without accumulating listeners', async () => {
  const client = new EventEmitter(), releases = [];
  client.release = destroy => releases.push(destroy);
  for (let index = 0; index < 3; index++) {
    const lifecycle = observeCheckedOutClient(client);
    assert.equal(await lifecycle.run(async () => index), index);
    lifecycle.release();
    assert.equal(client.listenerCount('error'), 0);
    assert.equal(client.listenerCount('end'), 0);
  }
  assert.deepEqual(releases, [false, false, false]);
});

for (const kind of ['save', 'preview']) {
  test(`${kind} contains a client error during SET LOCAL without starting the requested SQL`, async () => {
    const client = new EventEmitter(), calls = [], releases = [];
    client.release = destroy => releases.push(destroy);
    client.query = async sql => {
      calls.push(sql);
      if (sql.startsWith('set local statement_timeout')) {
        queueMicrotask(() => client.emit('error', new Error('disconnected during setup')));
        return new Promise(() => {});
      }
      return { rows: [] };
    };
    const pool = { connect: callback => { callback(null, client); } };
    const operation = async query => { await query('select must_not_start()'); return { receipt: {} }; };
    const running = kind === 'save'
      ? runSimpleSaveTransaction({ pool, requestId: 'setup', write: operation, verify: async () => null })
      : withPreviewTransaction({ pool }, operation);
    await assert.rejects(running, error => error.code === (kind === 'save' ? 'outcomeUnknown' : 'connectionLost'));
    assert.equal(calls.some(sql => sql.startsWith('select')), false);
    assert.deepEqual(releases, [true]);
  });

  test(`${kind} refuses callback continuation after timeout and clean rollback`, async () => {
    const client = new EventEmitter(), calls = [], releases = [];
    client.query = async sql => { calls.push(sql); return { rows: [] }; };
    client.release = destroy => releases.push(destroy);
    const pool = { connect: callback => { callback(null, client); } };
    let finish;
    const operation = query => new Promise(resolve => { finish = async () => {
      await assert.rejects(query('select late_write_must_not_start()'));
      resolve({ receipt: {} });
    }; });
    const running = kind === 'save'
      ? runSimpleSaveTransaction({ pool, requestId: 'late', transactionTimeoutMs: 20, write: operation, verify: async () => null })
      : withPreviewTransaction({ pool, transactionTimeoutMs: 20 }, operation);
    await assert.rejects(running, error => error.code === (kind === 'save' ? 'saveTimeout' : 'previewTimeout'));
    await finish();
    assert.equal(calls.some(sql => sql.startsWith('select')), false);
    assert.deepEqual(releases, [false]);
    assert.equal(client.listenerCount('error'), 0);
  });
}
