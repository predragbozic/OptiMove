import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createPreviewTokenService, PREVIEW_TOKEN_TTL_MS, PREVIEW_TOKEN_MAX_LENGTH, PREVIEW_TOKEN_BINDING_FIELDS } from '../src/dashboardSimple/previewTokens.js';
import { createPreviewAdmissionCoordinator, createPreviewAdmission } from '../src/dashboardSimple/previewAdmission.js';

const initialTime = Date.parse('2026-10-30T10:00:00.000Z');
const signingKey = Buffer.alloc(32, 71);
const iso = time => new Date(time).toISOString();
const busy = error => error.code === 'previewBusy' && error.status === 429 && error.retryAfter === 1;
const required = reason => error => error.code === 'previewRequired' && error.status === 409 && error.reason === reason;
function binding(overrides = {}) {
  return {
    userId: 'user-1', workspace: { type: 'club', scopeId: 'club-1' },
    target: { dashboardId: 'dashboard-1', widgetId: null, widgetRevision: null },
    draftHash: 'draft-sha256', catalogToken: 'catalog-sha256', semanticFingerprint: 'semantic-sha256',
    contextFingerprint: 'context-sha256', periodIntent: { mode: 'inherit' },
    resolvedPeriod: { dateFrom: '2026-10-30', dateTo: '2026-10-30', timeZone: 'Europe/Belgrade' },
    evaluatedAt: iso(initialTime), ...overrides,
  };
}
function setupTokens() {
  let currentTime = initialTime;
  const service = createPreviewTokenService({ keyId: 'preview-2026', key: signingKey, now: () => currentTime });
  return { service, setTime(time) { currentTime = time; } };
}
const expected = source => structuredClone(source);
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function resign(previewToken, update, key = signingKey) {
  const envelope = JSON.parse(Buffer.from(previewToken.split('.')[0], 'base64url').toString('utf8'));
  update(envelope);
  const payload = Buffer.from(canonicalJson(envelope)).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

test('explicit dedicated key required, copied key material and no configuration fallback', () => {
  for (const options of [{}, { keyId: 'x' }, { keyId: 'x', key: 'auth-secret' }, { keyId: 'x', key: Buffer.alloc(31) }, { keyId: '../x', key: signingKey }, { keyId: 'x', key: signingKey, now: 1 }]) {
    assert.throws(() => createPreviewTokenService(options), TypeError);
  }
  const mutableKey = Buffer.from(signingKey);
  const service = createPreviewTokenService({ keyId: 'x', key: mutableKey, now: () => initialTime });
  mutableKey.fill(0);
  const issued = service.issue(binding());
  const independent = createPreviewTokenService({ keyId: 'x', key: signingKey, now: () => initialTime });
  assert.deepEqual(independent.verify(issued.previewToken, expected(binding(), issued)), expected(binding(), issued));
});

test('canonical round trip signs every required binding, returns detached data and server ISO timestamps', () => {
  const { service } = setupTokens();
  const source = binding();
  const original = structuredClone(source);
  const issued = service.issue(source);
  assert.deepEqual(source, original);
  assert.equal(issued.requestIssuedAt, iso(initialTime));
  assert.equal(issued.serverNow, iso(initialTime));
  assert.equal(issued.expiresAt, iso(initialTime + PREVIEW_TOKEN_TTL_MS));
  const current = expected(original, issued);
  const reordered = Object.fromEntries(Object.entries(current).reverse());
  reordered.workspace = { scopeId: 'club-1', type: 'club' };
  const verified = service.verify(issued.previewToken, reordered);
  assert.deepEqual(Object.keys(verified).sort(), [...PREVIEW_TOKEN_BINDING_FIELDS].sort());
  assert.deepEqual(verified, current);
  verified.workspace.scopeId = 'changed';
  source.target.dashboardId = 'changed';
  assert.deepEqual(service.verify(issued.previewToken, current), current);
});

test('generated timestamps are separate from binding and never accepted from device clock', () => {
  const { service, setTime } = setupTokens();
  const original = service.issue(binding());
  setTime(initialTime + 1000);
  const renewed = service.issue(binding());
  assert.equal(original.requestIssuedAt, iso(initialTime));
  assert.equal(renewed.requestIssuedAt, iso(initialTime + 1000));
  assert.equal(renewed.serverNow, iso(initialTime + 1000));
  for (const field of ['requestIssuedAt', 'issuedAt', 'serverNow', 'evaluatedAt']) assert.throws(() => service.issue(binding({ [field]: iso(initialTime + 86400000) })), TypeError);
});

for (const field of PREVIEW_TOKEN_BINDING_FIELDS) test(`exact canonical binding rejects changed ${field}`, () => {
  const { service } = setupTokens();
  const issued = service.issue(binding());
  const current = expected(binding(), issued);
  if (field === 'workspace') current[field].scopeId = 'foreign';
  else if (field === 'target') current[field].dashboardId = 'foreign';
  else if (field === 'periodIntent') current[field] = { mode: 'replacePageRuntime' };
  else if (field === 'resolvedPeriod') current[field].dateTo = '2026-10-31';
  else if (field === 'evaluatedAt') current[field] = iso(initialTime - 1);
  else current[field] += '-different';
  assert.throws(() => service.verify(issued.previewToken, current), required(field === 'resolvedPeriod' ? 'effectivePeriodChanged' : 'bindingChanged'));
});

test('effective period change has stable reason when context/semantic fingerprints also change', () => {
  const { service } = setupTokens();
  const issued = service.issue(binding());
  const current = expected(binding({ contextFingerprint: 'next-context', semanticFingerprint: 'next-semantic' }), issued);
  current.resolvedPeriod.dateTo = '2026-10-31';
  assert.throws(() => service.verify(issued.previewToken, current), required('effectivePeriodChanged'));
});

test('target widget and revision changes require a new preview; no top-level revision accepted', () => {
  const { service } = setupTokens();
  const source = binding({ target: { dashboardId: 'd', widgetId: 'widget-1', widgetRevision: 3 } });
  const issued = service.issue(source);
  for (const target of [{ dashboardId: 'd', widgetId: 'widget-2', widgetRevision: 3 }, { dashboardId: 'd', widgetId: 'widget-1', widgetRevision: 4 }]) {
    assert.throws(() => service.verify(issued.previewToken, { ...source, target }), required('bindingChanged'));
  }
  assert.throws(() => service.issue({ ...source, widgetRevision: 3 }), TypeError);
});

test('expires exactly at ten minutes without sliding refresh', () => {
  const { service, setTime } = setupTokens();
  const issued = service.issue(binding());
  setTime(initialTime + PREVIEW_TOKEN_TTL_MS - 1);
  service.verify(issued.previewToken, expected(binding(), issued));
  setTime(initialTime + PREVIEW_TOKEN_TTL_MS);
  assert.throws(() => service.verify(issued.previewToken, expected(binding(), issued)), required('tokenExpired'));
});

test('server clock rollback, invalid clocks and future token issuance fail closed', () => {
  const { service, setTime } = setupTokens();
  const issued = service.issue(binding());
  setTime(initialTime - 1);
  assert.throws(() => service.verify(issued.previewToken, expected(binding(), issued)), required('clockChanged'));
  for (const time of [NaN, Infinity, -1, '123', 1.5]) {
    setTime(time);
    assert.throws(() => service.verify(issued.previewToken, expected(binding(), issued)), required('invalidClock'));
  }
  const earlierVerifier = createPreviewTokenService({ keyId: 'preview-2026', key: signingKey, now: () => initialTime - 1 });
  assert.throws(() => earlierVerifier.verify(issued.previewToken, expected(binding(), issued)), required('tokenNotYetValid'));
});

test('tampering, unknown key IDs, signed unsupported version and signed altered TTL are refused', () => {
  const { service } = setupTokens();
  const issued = service.issue(binding());
  const [payload, signature] = issued.previewToken.split('.');
  const changedEnvelope = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  changedEnvelope.binding.userId = 'attacker';
  const tampered = `${Buffer.from(JSON.stringify(changedEnvelope)).toString('base64url')}.${signature}`;
  assert.throws(() => service.verify(tampered, expected(binding(), issued)), required('invalidToken'));
  assert.throws(() => service.verify(resign(issued.previewToken, value => { value.keyId = 'unknown'; }), expected(binding(), issued)), required('invalidToken'));
  assert.throws(() => service.verify(resign(issued.previewToken, value => { value.version = 2; }), expected(binding(), issued)), required('unsupportedTokenVersion'));
  assert.throws(() => service.verify(resign(issued.previewToken, value => { value.expiresAt = iso(initialTime + PREVIEW_TOKEN_TTL_MS + 1); }), expected(binding(), issued)), required('invalidToken'));
  assert.throws(() => service.verify(resign(issued.previewToken, value => { value.binding.evaluatedAt = iso(initialTime + 1); }), expected(binding(), issued)), required('invalidToken'));
  assert.throws(() => service.verify(resign(issued.previewToken, value => { value.requestIssuedAt = iso(initialTime + 1); }), expected(binding(), issued)), required('invalidToken'));
  const wrongKey = createPreviewTokenService({ keyId: 'preview-2026', key: Buffer.alloc(32, 55), now: () => initialTime });
  assert.throws(() => wrongKey.verify(issued.previewToken, expected(binding(), issued)), required('invalidToken'));
});

test('old verification-only keys have a hard retirement window and cannot sign after retirement', () => {
  const original = createPreviewTokenService({ keyId: 'old', key: signingKey, now: () => initialTime });
  const issued = original.issue(binding());
  let currentTime = initialTime + 1;
  const oldKey = Buffer.from(signingKey);
  const rotated = createPreviewTokenService({ keyId: 'new', key: Buffer.alloc(32, 33), verificationKeys: { old: { key: oldKey, retiredAt: iso(initialTime + 1) } }, now: () => currentTime });
  oldKey.fill(0);
  rotated.verify(issued.previewToken, expected(binding(), issued));
  assert.equal(JSON.parse(Buffer.from(rotated.issue(binding()).previewToken.split('.')[0], 'base64url').toString('utf8')).keyId, 'new');
  const lateSigner = createPreviewTokenService({ keyId: 'old', key: signingKey, now: () => initialTime + 2 });
  const lateIssued = lateSigner.issue(binding());
  currentTime = initialTime + 2;
  assert.throws(() => rotated.verify(lateIssued.previewToken, expected(binding(), lateIssued)), required('tokenExpired'));
  currentTime = initialTime + PREVIEW_TOKEN_TTL_MS + 1;
  assert.throws(() => rotated.verify(issued.previewToken, expected(binding(), issued)), required('tokenExpired'));
  for (const verificationKeys of [{ old: signingKey }, { old: { key: signingKey } }, { old: { key: signingKey, retiredAt: 'yesterday' } }, { new: { key: signingKey, retiredAt: iso(initialTime) } }]) {
    assert.throws(() => createPreviewTokenService({ keyId: 'new', key: signingKey, verificationKeys }), TypeError);
  }
  assert.throws(() => createPreviewTokenService({ keyId: 'new', key: signingKey, verificationKeys: { old: { key: signingKey, retiredAt: iso(initialTime + 1) } }, now: () => initialTime }), TypeError);
  const tooManyKeys = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`old-${index}`, { key: signingKey, retiredAt: iso(initialTime) }]));
  assert.throws(() => createPreviewTokenService({ keyId: 'new', key: signingKey, verificationKeys: tooManyKeys, now: () => initialTime }), TypeError);
});

test('signed noncanonical, duplicate-field and oversized/deep JSON token bodies are refused', () => {
  const { service } = setupTokens();
  const issued = service.issue(binding());
  const envelope = JSON.parse(Buffer.from(issued.previewToken.split('.')[0], 'base64url').toString('utf8'));
  let nested = {};
  for (let index = 0; index < 15; index++) nested = { next: nested };
  for (const body of [JSON.stringify(envelope, null, 2), canonicalJson(envelope).replace('"version":1', '"version":1,"version":1'), JSON.stringify({ ...envelope, binding: { ...envelope.binding, workspace: nested } }), JSON.stringify({ ...envelope, binding: { ...envelope.binding, workspace: { large: 'x'.repeat(9000) } } })]) {
    const payload = Buffer.from(body).toString('base64url');
    const token = `${payload}.${createHmac('sha256', signingKey).update(payload).digest('base64url')}`;
    assert.throws(() => service.verify(token, binding()), required('invalidToken'));
  }
});

test('malformed tokens have bounded input and stable errors without parser detail', () => {
  const { service } = setupTokens();
  const issued = service.issue(binding());
  const malformed = [null, {}, 42, '', '.', 'a.b.c', 'a'.repeat(PREVIEW_TOKEN_MAX_LENGTH + 1), '💥.x', issued.previewToken + '=', issued.previewToken.slice(0, -1), `e30.${'A'.repeat(43)}`, `${Buffer.from('not-json').toString('base64url')}.${'A'.repeat(43)}`];
  for (const previewToken of malformed) assert.throws(() => service.verify(previewToken, expected(binding(), issued)), required('invalidToken'));
  for (const update of [value => { value.binding.facts = [123]; }, value => { delete value.binding.userId; }, value => { value.extra = true; }]) {
    assert.throws(() => service.verify(resign(issued.previewToken, update), expected(binding(), issued)), required('invalidToken'));
  }
});

test('rejects unknown facts, missing binding fields, non-JSON, cycles, getters, sparse arrays and oversized/deep inputs', () => {
  const { service } = setupTokens();
  for (const field of PREVIEW_TOKEN_BINDING_FIELDS) {
    const incomplete = binding();
    delete incomplete[field];
    assert.throws(() => service.issue(incomplete), TypeError);
  }
  const cycle = {}; cycle.self = cycle;
  let deep = {};
  for (let index = 0; index < 15; index++) deep = { nested: deep };
  let accessed = false;
  const getter = Object.defineProperty({}, 'fact', { enumerable: true, get() { accessed = true; return 3; } });
  const invalid = [binding({ facts: [{ value: 4 }] }), binding({ target: { dashboardId: 'd', widgetId: null, widgetRevision: 0 } }), binding({ workspace: null }), binding({ workspace: {} }), binding({ target: new Date() }), binding({ workspace: { cycle } }), binding({ workspace: getter }), binding({ workspace: { sparse: new Array(2) } }), binding({ workspace: { deep } }), binding({ workspace: { big: 'x'.repeat(2049) } }), binding({ workspace: { big: Array.from({ length: 10 }, () => 'x'.repeat(1000)) } })];
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, Symbol('x')]) invalid.push(binding({ workspace: { value } }));
  for (const value of invalid) assert.throws(() => service.issue(value), TypeError);
  assert.equal(accessed, false);
  const issued = service.issue(binding());
  assert.throws(() => service.verify(issued.previewToken, { ...binding(), extra: true }), required('invalidToken'));
});

test('canonical equality preserves array order, scalar types and explicit null', () => {
  const { service } = setupTokens();
  const source = binding({ workspace: { scopeId: 'd', members: ['a', 'b'], flag: null } });
  const issued = service.issue(source);
  for (const workspace of [{ scopeId: 'd', members: ['b', 'a'], flag: null }, { scopeId: 'd', members: ['a', 'b'], flag: 'null' }, { scopeId: 'd', members: ['a', 'b'] }]) {
    assert.throws(() => service.verify(issued.previewToken, expected({ ...source, workspace }, issued)), required('bindingChanged'));
  }
});

test('admission requires explicit deployment budget and trusted runtime ports', () => {
  for (const maxActiveDeployment of [undefined, null, 0, -1, 1.5, '2', Infinity]) assert.throws(() => createPreviewAdmissionCoordinator({ maxActiveDeployment }), TypeError);
  for (const options of [{}, { coordinator: {}, processId: 'p', poolMax: 10 }, { coordinator: { tryAcquire() {} }, processId: '', poolMax: 10 }, { coordinator: { tryAcquire() {} }, processId: 'p', poolMax: '10' }]) assert.throws(() => createPreviewAdmission(options), TypeError);
});

test('atomic central authority enforces one user globally, process two, and deployment budget', () => {
  const coordinator = createPreviewAdmissionCoordinator({ maxActiveDeployment: 3 });
  const acquire = (userId, processId = 'p1', processLimit = 2) => coordinator.tryAcquire({ userId, processId, processLimit });
  const first = acquire('u1');
  assert.throws(() => acquire('u1', 'p2'), busy);
  const second = acquire('u2');
  assert.throws(() => acquire('u3'), busy);
  const third = acquire('u3', 'p2');
  assert.throws(() => acquire('u4', 'p3'), busy);
  first.release(); first.release();
  const replacement = acquire('u4');
  assert.throws(() => acquire('u5', 'p3'), busy);
  replacement.release(); second.release(); third.release();
  const recovered = acquire('u1', 'p3'); recovered.release();
});

test('invalid admission inputs and mismatched limits refuse without consuming capacity', () => {
  const coordinator = createPreviewAdmissionCoordinator({ maxActiveDeployment: 2 });
  for (const argumentsValue of [undefined, null, 1, 'request', {}, { userId: '', processId: 'p', processLimit: 2 }, { userId: 'u', processId: '', processLimit: 2 }, ...[0, -1, 3, 1.5, '2'].map(processLimit => ({ userId: 'u', processId: 'p', processLimit }))]) assert.throws(() => coordinator.tryAcquire(argumentsValue), busy);
  const first = coordinator.tryAcquire({ userId: 'u1', processId: 'p', processLimit: 1 });
  assert.throws(() => coordinator.tryAcquire({ userId: 'u2', processId: 'p', processLimit: 2 }), busy);
  first.release();
  const next = coordinator.tryAcquire({ userId: 'u2', processId: 'p', processLimit: 2 }); next.release();
});

test('pool limit reserves capacity and tiny pools refuse before contacting authority', async () => {
  for (const [poolMax, limit] of [[1, 0], [2, 0], [3, 1], [4, 1], [5, 2], [10, 2], [100, 2]]) {
    const coordinator = createPreviewAdmissionCoordinator({ maxActiveDeployment: 10 });
    let calls = 0;
    const admission = createPreviewAdmission({ coordinator: { tryAcquire(argumentsValue) { calls++; return coordinator.tryAcquire(argumentsValue); } }, processId: 'p', poolMax });
    assert.equal(admission.processLimit, limit);
    if (limit === 0) {
      await assert.rejects(admission.tryAcquire({ userId: 'u' }), busy);
      assert.equal(calls, 0);
    } else {
      const leases = [];
      for (let index = 0; index < limit; index++) leases.push(await admission.tryAcquire({ userId: `u${index}` }));
      await assert.rejects(admission.tryAcquire({ userId: 'overflow' }), busy);
      await Promise.all(leases.map(lease => lease.release()));
    }
  }
});

test('unavailable or invalid coordinator refuses; explicit release failure holds capacity until retry', async () => {
  for (const coordinator of [{ tryAcquire() { throw new Error('Authority unavailable'); } }, { async tryAcquire() { throw new Error('Transport failed'); } }, { tryAcquire() { return null; } }, { tryAcquire() { return {}; } }]) {
    const admission = createPreviewAdmission({ coordinator, processId: 'p', poolMax: 10 });
    await assert.rejects(admission.tryAcquire({ userId: 'u' }), busy);
  }
  const authority = createPreviewAdmissionCoordinator({ maxActiveDeployment: 1 });
  let failRelease = true;
  let releaseCalls = 0;
  const admission = createPreviewAdmission({ processId: 'p', poolMax: 10, coordinator: { tryAcquire(argumentsValue) {
    const lease = authority.tryAcquire(argumentsValue);
    return { async release() { releaseCalls++; if (failRelease) throw new Error('Cleanup not acknowledged'); lease.release(); } };
  } } });
  const lease = await admission.tryAcquire({ userId: 'u' });
  const releases = await Promise.allSettled([lease.release(), lease.release()]);
  assert.ok(releases.every(result => result.status === 'rejected'));
  assert.equal(releaseCalls, 1);
  await assert.rejects(admission.tryAcquire({ userId: 'other' }), busy);
  failRelease = false;
  await Promise.all([lease.release(), lease.release()]);
  await lease.release();
  assert.equal(releaseCalls, 2);
  const recovered = await admission.tryAcquire({ userId: 'other' }); await recovered.release();
});

test('request failure and abort never release a lease before actual cleanup', async () => {
  const coordinator = createPreviewAdmissionCoordinator({ maxActiveDeployment: 1 });
  const admission = createPreviewAdmission({ coordinator, processId: 'p', poolMax: 10 });
  for (const request of [undefined, null, {}, 1, 'request']) await assert.rejects(admission.tryAcquire(request), busy);
  const lease = await admission.tryAcquire({ userId: 'u1' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(async () => { throw new Error('Query failed'); }, /Query failed/);
  await assert.rejects(admission.tryAcquire({ userId: 'u2', signal: controller.signal }), busy);
  await assert.rejects(async () => { throw new Error('Rollback unconfirmed'); }, /Rollback unconfirmed/);
  await assert.rejects(admission.tryAcquire({ userId: 'u2' }), busy);
  await lease.release();
  const recovered = await admission.tryAcquire({ userId: 'u2' }); await recovered.release();
});

test('lost acquire acknowledgement refuses and retains authority allocation until explicit cleanup', async () => {
  const authority = createPreviewAdmissionCoordinator({ maxActiveDeployment: 1 });
  let retainedLease;
  const admission = createPreviewAdmission({ processId: 'p', poolMax: 10, coordinator: { async tryAcquire(argumentsValue) {
    retainedLease = authority.tryAcquire(argumentsValue);
    throw new Error('Acknowledgement lost');
  } } });
  await assert.rejects(admission.tryAcquire({ userId: 'u' }), busy);
  assert.throws(() => authority.tryAcquire({ userId: 'other', processId: 'q', processLimit: 2 }), busy);
  retainedLease.release();
  const recovered = authority.tryAcquire({ userId: 'u', processId: 'q', processLimit: 2 }); recovered.release();
});

async function startWorkers(context, authority, count, poolMax = 10) {
  const authorityLeases = new Map();
  let leaseSequence = 0;
  const workers = [];
  context.after(async () => {
    await Promise.all(workers.map(async worker => {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) return;
      const closed = once(worker.child, 'exit');
      worker.child.kill();
      await closed;
    }));
    for (const { lease } of authorityLeases.values()) lease.release();
  });
  for (let index = 0; index < count; index++) {
    const child = fork(new URL('./fixtures/dashboard-simple/preview-admission-worker.mjs', import.meta.url), [String(poolMax)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const pendingCommands = new Map();
    let commandSequence = 0;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const worker = { child, authorityLeases,
      command(operation, userId) {
        return new Promise((resolve, reject) => {
          const commandId = ++commandSequence;
          pendingCommands.set(commandId, { resolve, reject });
          child.send({ kind: 'command', commandId, operation, userId }, error => {
            if (!error) return;
            pendingCommands.delete(commandId); reject(error);
          });
        });
      },
    };
    workers.push(worker);
    child.on('error', error => { rejectReady(error); for (const pending of pendingCommands.values()) pending.reject(error); pendingCommands.clear(); });
    child.on('exit', () => { const error = new Error('Worker exited'); rejectReady(error); for (const pending of pendingCommands.values()) pending.reject(error); pendingCommands.clear(); });
    child.on('message', message => {
      if (message.kind === 'ready') { resolveReady(message); return; }
      if (message.kind === 'commandResult') {
        const pending = pendingCommands.get(message.commandId);
        if (!pending) return;
        pendingCommands.delete(message.commandId);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
        else pending.resolve(message.value);
        return;
      }
      if (message.kind !== 'rpc') return;
      try {
        let value;
        if (message.operation === 'acquire') {
          assert.equal(message.argumentsValue.processId, String(child.pid));
          const lease = authority.tryAcquire(message.argumentsValue);
          value = `lease-${++leaseSequence}`;
          authorityLeases.set(value, { lease, pid: child.pid });
        } else if (message.operation === 'release') {
          const held = authorityLeases.get(message.argumentsValue.leaseId);
          assert.equal(held?.pid, child.pid);
          held.lease.release();
          authorityLeases.delete(message.argumentsValue.leaseId);
          value = true;
        } else throw new Error('Unknown authority operation');
        child.send({ kind: 'rpcResult', rpcId: message.rpcId, value });
      } catch (error) {
        child.send({ kind: 'rpcResult', rpcId: message.rpcId, error: { code: error.code, status: error.status, retryAfter: error.retryAfter } });
      }
    });
    await ready;
  }
  return workers;
}

test('actual child processes use one IPC authority: global users, process limits and deployment budget', { timeout: 15000 }, async context => {
  const authority = createPreviewAdmissionCoordinator({ maxActiveDeployment: 3 });
  const [first, second, third] = await startWorkers(context, authority, 3);
  assert.equal(new Set([process.pid, first.child.pid, second.child.pid, third.child.pid]).size, 4);
  await first.command('acquire', 'shared-user');
  await assert.rejects(second.command('acquire', 'shared-user'), busy);
  await first.command('acquire', 'second-user');
  await assert.rejects(first.command('acquire', 'process-overflow'), busy);
  await second.command('acquire', 'third-user');
  await assert.rejects(third.command('acquire', 'deployment-overflow'), busy);
  await first.command('abort', 'shared-user');
  await assert.rejects(first.command('cleanupFailure', 'shared-user'), /Cleanup unconfirmed/);
  await assert.rejects(second.command('acquire', 'shared-user'), busy);
  await assert.rejects(third.command('acquire', 'still-full'), busy);
  await first.command('release', 'shared-user');
  await third.command('acquire', 'shared-user');
  await first.command('release', 'second-user');
  await second.command('release', 'third-user');
  await third.command('release', 'shared-user');
  assert.equal(first.authorityLeases.size, 0);
});

test('simultaneous multi-process admission never queues or exceeds deployment cap, no refusal leaks', { timeout: 15000 }, async context => {
  const authority = createPreviewAdmissionCoordinator({ maxActiveDeployment: 3 });
  const workers = await startWorkers(context, authority, 4);
  for (let round = 0; round < 4; round++) {
    const attempts = Array.from({ length: 20 }, (_, index) => ({ worker: workers[index % workers.length], userId: `round-${round}-user-${index}` }));
    const outcomes = await Promise.allSettled(attempts.map(attempt => attempt.worker.command('acquire', attempt.userId)));
    const winners = outcomes.flatMap((outcome, index) => outcome.status === 'fulfilled' ? [attempts[index]] : []);
    assert.equal(winners.length, 3);
    assert.equal(workers[0].authorityLeases.size, 3);
    for (const outcome of outcomes) if (outcome.status === 'rejected') assert.ok(busy(outcome.reason));
    for (const worker of workers) assert.ok(winners.filter(winner => winner.worker === worker).length <= 2);
    await Promise.all(winners.map(winner => winner.worker.command('release', winner.userId)));
    assert.equal(workers[0].authorityLeases.size, 0);
  }
});

test('child exit cannot auto-free unconfirmed cleanup, explicit authority release restores admission', { timeout: 15000 }, async context => {
  const authority = createPreviewAdmissionCoordinator({ maxActiveDeployment: 1 });
  const [first, second] = await startWorkers(context, authority, 2);
  await first.command('acquire', 'orphaned-user');
  const closed = once(first.child, 'exit');
  first.child.kill();
  await closed;
  await assert.rejects(second.command('acquire', 'other-user'), busy);
  await assert.rejects(second.command('acquire', 'orphaned-user'), busy);
  for (const [leaseId, held] of first.authorityLeases) {
    if (held.pid !== first.child.pid) continue;
    held.lease.release(); first.authorityLeases.delete(leaseId);
  }
  await second.command('acquire', 'orphaned-user');
  await second.command('release', 'orphaned-user');
  assert.equal(first.authorityLeases.size, 0);
});

test('small pool per-process limit is enforced across IPC clients', { timeout: 15000 }, async context => {
  const authority = createPreviewAdmissionCoordinator({ maxActiveDeployment: 4 });
  const [first, second] = await startWorkers(context, authority, 2, 3);
  assert.equal((await first.command('acquire', 'u1')).processLimit, 1);
  await assert.rejects(first.command('acquire', 'u2'), busy);
  await second.command('acquire', 'u2');
  await first.command('release', 'u1');
  await second.command('release', 'u2');
});

test('coordinator acknowledgement is bounded and a late lease is cleaned without starting work', async () => {
  let deliver, releases = 0;
  const admission = createPreviewAdmission({
    coordinator: { tryAcquire: () => new Promise(resolve => { deliver = resolve; }) },
    processId: 'bounded-process', poolMax: 10, coordinatorTimeoutMs: 10,
  });
  await assert.rejects(admission.tryAcquire({ userId: 'bounded-user' }), busy);
  assert.equal(releases, 0);
  deliver({ release: () => { releases++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases, 1);
});
