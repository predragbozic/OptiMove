import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPreviewTransaction } from '../src/dashboardSimple/previewTransaction.js';

function fixture(handler = async () => ({ rows: [] })) {
  const calls = [], releases = [];
  let released = 0;
  const client = { query: async (sql, params) => { calls.push(sql); return handler(sql, params); }, release: destroy => releases.push(destroy) };
  const options = { pool: { connect: async () => client }, onReleased: () => { released++; } };
  return { calls, releases, options, get released() { return released; } };
}

test('read-only snapshot, serialized runner and rollback precede resource/admission release', async () => {
  const state = fixture();
  const result = await withPreviewTransaction(state.options, async queryRunner => {
    await Promise.all([queryRunner('select 1'), queryRunner('select 2')]);
    assert.equal(state.released, 0);
    return 'done';
  });
  assert.equal(result, 'done');
  assert.match(state.calls[0], /repeatable read read only/);
  assert.deepEqual(state.calls.filter(sql => /^select/.test(sql)), ['select 1', 'select 2']);
  assert.equal(state.calls.at(-1), 'rollback');
  assert.deepEqual(state.releases, [false]);
  assert.equal(state.released, 1);
});

test('abort waits for in-flight SQL and rollback before releasing admission', async () => {
  const controller = new AbortController();
  let finish, started;
  const inFlight = new Promise(resolve => { started = resolve; });
  const state = fixture(sql => sql === 'select delayed' ? new Promise(resolve => { finish = resolve; started(); }) : Promise.resolve({ rows: [] }));
  const running = withPreviewTransaction({ ...state.options, signal: controller.signal }, queryRunner => queryRunner('select delayed'));
  await inFlight;
  controller.abort();
  assert.equal(state.released, 0);
  assert.deepEqual(state.releases, []);
  finish({ rows: [] });
  await assert.rejects(running, error => error.code === 'previewAborted');
  assert.equal(state.calls.at(-1), 'rollback');
  assert.equal(state.released, 1);
});

test('late checkout is destroyed without SQL and only then releases admission', async () => {
  let deliver;
  const state = fixture();
  state.options.pool.connect = () => new Promise(resolve => { deliver = resolve; });
  await assert.rejects(withPreviewTransaction({ ...state.options, checkoutTimeoutMs: 10 }, () => assert.fail()), error => error.code === 'previewBusy');
  assert.equal(state.released, 0);
  deliver({ query: () => assert.fail(), release: destroy => state.releases.push(destroy) });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(state.releases, [true]);
  assert.equal(state.released, 1);
});

test('unconfirmed BEGIN and stuck cleanup destroy rather than recycle client', async () => {
  const state = fixture(() => new Promise(() => {}));
  await assert.rejects(withPreviewTransaction({ ...state.options, transactionTimeoutMs: 10 }, () => assert.fail()), error => error.code === 'previewTimeout');
  assert.deepEqual(state.releases, [true]);
  assert.equal(state.released, 1);
});

test('per-statement timeout shrinks with total budget and stable SQL errors are sanitized', async () => {
  const state = fixture(async sql => {
    if (sql === 'select slow') { await new Promise(resolve => setTimeout(resolve, 20)); return { rows: [] }; }
    if (sql === 'select fail') throw Object.assign(new Error('private SQL details'), { code: '57014' });
    return { rows: [] };
  });
  await assert.rejects(withPreviewTransaction({ ...state.options, transactionTimeoutMs: 200 }, async queryRunner => {
    await queryRunner('select slow');
    await queryRunner('select fail');
  }), error => error.code === 'previewTimeout' && error.message === 'previewTimeout');
  const budgets = state.calls.filter(sql => sql.startsWith('set local')).map(sql => Number(/'(\d+)ms'/.exec(sql)[1]));
  assert.equal(budgets.length, 2);
  assert.ok(budgets[1] < budgets[0]);
});

test('writes and multi-statements never reach client; aborted requests never check out', async () => {
  for (const sql of ['insert into secret values (1)', 'select 1; delete from secret']) {
    const state = fixture();
    await assert.rejects(withPreviewTransaction(state.options, queryRunner => queryRunner(sql)), error => error.code === 'previewReadOnlyViolation');
    assert.ok(!state.calls.includes(sql));
    assert.equal(state.released, 1);
  }
  const state = fixture();
  await assert.rejects(withPreviewTransaction({ ...state.options, signal: AbortSignal.abort() }, () => assert.fail()), error => error.code === 'previewAborted');
  assert.deepEqual(state.calls, []);
  assert.equal(state.released, 1);
});

test('abort or elapsed transaction during SET LOCAL cannot start the requested SQL', async () => {
  for (const mode of ['abort', 'deadline']) {
    const controller = new AbortController();
    const state = fixture(async sql => {
      if (sql.startsWith('set local')) {
        if (mode === 'abort') controller.abort();
        else await new Promise(resolve => setTimeout(resolve, 30));
      }
      return { rows: [] };
    });
    await assert.rejects(withPreviewTransaction({ ...state.options, signal: controller.signal, transactionTimeoutMs: 15 }, queryRunner => queryRunner('select must_not_start')),
      error => ['previewAborted', 'previewTimeout'].includes(error.code));
    assert.ok(!state.calls.includes('select must_not_start'));
    assert.equal(state.released, 1);
  }
});
