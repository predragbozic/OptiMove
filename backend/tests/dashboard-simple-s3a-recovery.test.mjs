import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSimpleSaveTransaction } from '../src/dashboardSimple/saveTransaction.js';
import { withPreviewTransaction } from '../src/dashboardSimple/previewTransaction.js';
import { createSimpleEditorController } from '../../frontend/training-load-simple-controller.js';

const period = { dateFrom: '2026-11-01', dateTo: '2026-11-03', timeZone: 'Europe/Belgrade' };
const errorFor = (code, status) => Object.assign(new Error(code), { code, status });
const transactionBounds = { checkoutTimeoutMs: 100, transactionTimeoutMs: 1000, statementTimeoutMs: 500, commitTimeoutMs: 100, recoveryTimeoutMs: 500 };

function harness({ deniedCode = 'notFound', deniedStatus = 404, firstStatus = deniedStatus, staleBeforeCommit = false } = {}) {
  const ledger = new Map(), clients = [], requests = [], responses = [], recoveryDenials = [], saved = [];
  let authorized = true, persistedWrites = 0, uuidCount = 0, ledgerReads = 0, firstSave = true;
  const authorize = () => { if (!authorized) throw errorFor(deniedCode, deniedStatus); };
  const pool = { async connect() {
    const calls = [], releases = [];
    let staged = null;
    const client = {
      calls, releases,
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql === 'select receipt from recovery_ledger where request_id=$1') {
          ledgerReads++;
          const receipt = ledger.get(params[0]);
          return { rows: receipt ? [{ receipt: structuredClone(receipt) }] : [] };
        }
        if (sql === 'select sanctioned_writer($1)') {
          staged = { requestId: params[0], widgetId: 'persisted-widget', widgetRevision: 8, dashboardRevision: 12 };
          return { rows: [{ receipt: structuredClone(staged) }] };
        }
        if (sql === 'commit' && staged) {
          assert.equal(ledger.has(staged.requestId), false);
          ledger.set(staged.requestId, structuredClone(staged));
          persistedWrites++;
          authorized = false;
          throw new Error('COMMIT persisted; acknowledgement lost');
        }
        if (sql === 'rollback') staged = null;
        assert.ok(sql === 'begin' || sql === 'begin isolation level repeatable read read only' || sql === 'commit' || sql === 'rollback' || sql.startsWith('set local '), `Unexpected SQL: ${sql}`);
        return { rows: [] };
      },
      release(destroy) { releases.push(destroy); },
    };
    clients.push(client);
    return client;
  } };
  async function verify(requestId) {
    try { authorize(); }
    catch (error) { recoveryDenials.push(error); throw error; }
    return withPreviewTransaction({ pool, checkoutTimeoutMs: 100, transactionTimeoutMs: 1000, statementTimeoutMs: 500 }, async query => {
      authorize();
      return (await query('select receipt from recovery_ledger where request_id=$1', [requestId])).rows[0]?.receipt ?? null;
    });
  }
  const controller = createSimpleEditorController({
    getContext: () => ({ identity: 'same-coach', dashboardId: 'same-dashboard', period, runtimeFilter: {} }),
    uuid: () => `request-${++uuidCount}`,
    schedule: () => assert.fail('This recovery test must not schedule background work'),
    cancel: () => {},
    saved: async receipt => saved.push(structuredClone(receipt)),
    request: async (url, options) => {
      const body = options?.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, body, raw: options?.body });
      if (url.endsWith('/capabilities')) return { capabilities: { preview: true, atomicSave: true }, builtins: [{ key: 'srpe', label: 'Load', fixed_data_scope_level: 'session', default_analytical_aggregation: 'sum' }] };
      if (url.includes('/metrics?')) return { metrics: [], nextCursor: null };
      if (url.endsWith('/preview')) return { status: 'valid', previewToken: 'original-preview-proof', requestIssuedAt: '2026-11-03T12:00:00.000Z', resolvedPeriod: structuredClone(period) };
      const initialSave = url.endsWith('/widgets') && firstSave;
      if (initialSave) firstSave = false;
      try {
        authorize();
        let result;
        if (url.endsWith('/requests/status')) {
          const receipt = await verify(body.requestId);
          result = receipt ? { status: 'recorded', receipt } : { status: 'notRecorded' };
        } else {
          assert.ok(url.endsWith('/widgets'), url);
          result = await runSimpleSaveTransaction({ ...transactionBounds, pool, requestId: body.requestId,
            write: async query => {
              authorize();
              const recorded = (await query('select receipt from recovery_ledger where request_id=$1', [body.requestId])).rows[0]?.receipt;
              if (recorded) return { receipt: recorded, replayed: true };
              if (staleBeforeCommit) throw errorFor('staleRevision', 409);
              return { receipt: (await query('select sanctioned_writer($1)', [body.requestId])).rows[0].receipt };
            },
            verify: () => verify(body.requestId),
          });
        }
        responses.push({ status: 200, body: structuredClone(result) });
        return result;
      } catch (error) {
        const status = initialSave && !staleBeforeCommit ? firstStatus : error.status;
        const data = { error: status === 401 ? 'unauthorized' : error.code };
        responses.push({ status, body: data });
        throw Object.assign(new Error(data.error), { status, data });
      }
    },
  });
  return { controller, ledger, clients, requests, responses, recoveryDenials, saved,
    get persistedWrites() { return persistedWrites; }, get uuidCount() { return uuidCount; }, get ledgerReads() { return ledgerReads; },
    restoreAuthority() { authorized = true; },
    async ready() {
      await controller.open();
      controller.selectMetric('builtin', 'srpe');
      await controller.preview();
      assert.equal(controller.model.canSave, true);
    },
  };
}

for (const denial of [
  { deniedCode: 'notFound', deniedStatus: 404, firstStatus: 401 },
  { deniedCode: 'notFound', deniedStatus: 404, firstStatus: 404 },
  { deniedCode: 'workspaceSelectionRequired', deniedStatus: 409, firstStatus: 409 },
]) {
  for (const recovery of ['status', 'replay']) {
    test(`persisted COMMIT with ${denial.firstStatus} response retains the original request through denied recovery, then ${recovery} records one write`, async () => {
      const h = harness(denial), c = h.controller;
      await h.ready();
      await c.save();
      const pending = c.model.pending, pendingBody = c.model.pendingBody, originalDraft = structuredClone(c.model.draft);
      const requestId = pending.requestId;
      const persistedReceipt = structuredClone(h.ledger.get(requestId));
      assert.equal(h.persistedWrites, 1);
      assert.equal(h.recoveryDenials.length, 1);
      assert.equal(h.recoveryDenials[0].code, denial.deniedCode);
      assert.equal(h.recoveryDenials[0].status, denial.deniedStatus);
      assert.equal(h.responses[0].status, denial.firstStatus);
      assert.deepEqual(h.responses[0].body, { error: denial.firstStatus === 401 ? 'unauthorized' : denial.deniedCode });
      assert.equal(c.model.saveState, 'unknown');
      assert.equal(c.pending, true);
      assert.equal(c.model.canSave, false);
      assert.equal(c.model.receipt, undefined);
      assert.deepEqual(h.clients[0].releases, [true]);
      assert.equal(h.clients[0].calls.at(-1).sql, 'commit');
      assert.equal(h.clients[0].calls.some(call => call.sql === 'rollback'), false);
      const readsBeforeDenial = h.ledgerReads;
      await c.status();
      await c.save(true);
      assert.equal(h.ledgerReads, readsBeforeDenial);
      assert.equal(h.clients.length, 1);
      assert.equal(h.saved.length, 0);
      assert.equal(c.model.saveState, 'unknown');
      assert.strictEqual(c.model.pending, pending);
      assert.equal(c.model.pendingBody, pendingBody);
      assert.equal(c.model.receipt, undefined);
      assert.equal(c.close(), false);
      c.change(draft => { draft.title = 'must remain locked'; });
      assert.deepEqual(c.model.draft, originalDraft);
      for (const response of h.responses) {
        assert.deepEqual(response.body, { error: response.status === 401 ? 'unauthorized' : denial.deniedCode });
        assert.ok(!JSON.stringify(response).includes(persistedReceipt.widgetId));
      }
      const saveRequests = h.requests.filter(request => request.url.endsWith('/widgets'));
      assert.equal(saveRequests.length, 2);
      assert.ok(saveRequests.every(request => request.raw === pendingBody && request.body.requestId === requestId));
      assert.equal(h.uuidCount, 2);
      h.restoreAuthority();
      if (recovery === 'status') await c.status();
      else await c.save(true);
      const expected = recovery === 'status' ? persistedReceipt : { ...persistedReceipt, verification: 'replayed' };
      assert.equal(c.model.saveState, 'recorded');
      assert.equal(c.pending, false);
      assert.deepEqual(c.model.receipt, expected);
      assert.deepEqual(h.saved, [expected]);
      assert.strictEqual(c.model.pending, pending);
      assert.equal(c.model.pendingBody, pendingBody);
      assert.equal(h.uuidCount, 2);
      assert.equal(h.persistedWrites, 1);
      assert.equal(h.ledger.size, 1);
      assert.deepEqual([...h.ledger.keys()], [requestId]);
      assert.deepEqual(h.clients[1].releases, [false]);
      if (recovery === 'replay') {
        assert.equal(h.clients[1].calls.at(-1).sql, 'commit');
        assert.equal(h.clients[1].calls.some(call => call.sql === 'select sanctioned_writer($1)'), false);
        assert.equal(h.requests.filter(request => request.url.endsWith('/widgets')).at(-1).raw, pendingBody);
      } else {
        assert.equal(h.clients[1].calls[0].sql, 'begin isolation level repeatable read read only');
        assert.equal(h.clients[1].calls.at(-1).sql, 'rollback');
      }
    });
  }
}

test('a definite staleRevision before COMMIT rolls back and returns the controller to idle', async () => {
  const h = harness({ staleBeforeCommit: true }), c = h.controller;
  await h.ready();
  await c.save();
  assert.deepEqual(h.responses, [{ status: 409, body: { error: 'staleRevision' } }]);
  assert.equal(c.model.saveState, 'idle');
  assert.equal(c.pending, false);
  assert.equal(c.model.pending, null);
  assert.equal(c.model.pendingBody, null);
  assert.equal(c.model.preview, null);
  assert.equal(c.model.stale, true);
  assert.equal(c.model.receipt, undefined);
  assert.equal(h.persistedWrites, 0);
  assert.equal(h.ledger.size, 0);
  assert.equal(h.recoveryDenials.length, 0);
  assert.equal(h.saved.length, 0);
  assert.equal(h.clients[0].calls.some(call => call.sql === 'commit' || call.sql === 'select sanctioned_writer($1)'), false);
  assert.equal(h.clients[0].calls.at(-1).sql, 'rollback');
  assert.deepEqual(h.clients[0].releases, [false]);
});
