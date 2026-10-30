import { performance } from 'node:perf_hooks';
import { previewError } from './previewTransaction.js';

function bounded(promise, milliseconds, error) {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(error), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

export async function runSimpleSaveTransaction({ pool, requestId, write, verify, checkoutTimeoutMs = 1000, transactionTimeoutMs = 5000, statementTimeoutMs = 3000, commitTimeoutMs = 5000, recoveryTimeoutMs = 5000 }) {
  if (!pool || typeof pool.connect !== 'function' || typeof write !== 'function' || typeof verify !== 'function' ||
      ![checkoutTimeoutMs, transactionTimeoutMs, statementTimeoutMs, commitTimeoutMs, recoveryTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0) ||
      checkoutTimeoutMs > 5000 || transactionTimeoutMs > 10000 || statementTimeoutMs > 3000 || commitTimeoutMs > 5000 || recoveryTimeoutMs > 5000) throw new TypeError('Bounded save dependencies required');
  const unknown = () => Object.assign(previewError('outcomeUnknown'), { requestId });
  let client, released = false, commitStarted = false, begun = false;
  const release = destroy => {
    if (released) return;
    released = true;
    client?.release(destroy);
  };
  const pendingClient = Promise.resolve().then(() => pool.connect());
  try { client = await bounded(pendingClient, checkoutTimeoutMs, previewError('saveBusy')); }
  catch (error) { pendingClient.then(lateClient => lateClient.release(true), () => {}).catch(() => {}); throw error; }
  const deadline = performance.now() + transactionTimeoutMs;
  let stopped = false, queue = Promise.resolve();
  const queryRunner = (sql, params = []) => {
    const running = queue.then(async () => {
      if (stopped || performance.now() >= deadline) throw previewError('saveTimeout');
      if (typeof sql !== 'string' || !/^\s*select\b/i.test(sql) || /;\s*\S/.test(sql)) throw previewError('saveFailed');
      const remaining = Math.max(1, Math.min(statementTimeoutMs, Math.floor(deadline - performance.now())));
      await client.query(`set local statement_timeout = '${remaining}ms'`);
      if (stopped || performance.now() >= deadline) throw previewError('saveTimeout');
      return client.query(sql, params);
    });
    queue = running.catch(() => {});
    return running;
  };
  try {
    begun = true;
    await bounded(client.query('begin'), Math.max(1, deadline - performance.now()), previewError('saveTimeout'));
    await bounded(client.query("set local lock_timeout = '1000ms'"), Math.max(1, deadline - performance.now()), previewError('saveTimeout'));
    const result = await bounded(Promise.resolve().then(() => write(queryRunner)), Math.max(1, deadline - performance.now()), previewError('saveTimeout'));
    await queue;
    if (performance.now() >= deadline) throw previewError('saveTimeout');
    commitStarted = true;
    await bounded(client.query('commit'), commitTimeoutMs, unknown());
    begun = false;
    release(false);
    return { ...result.receipt, verification: result.replayed ? 'replayed' : 'commitAcknowledged' };
  } catch (error) {
    stopped = true;
    if (commitStarted) {
      release(true);
      try {
        const receipt = await bounded(Promise.resolve().then(verify), recoveryTimeoutMs, unknown());
        if (receipt) return { ...receipt, verification: 'verifiedAfterCommitError' };
      } catch (recoveryError) {
        if (['notFound', 'workspaceSelectionRequired'].includes(recoveryError?.code)) throw recoveryError;
      }
      throw unknown();
    }
    let rollbackConfirmed = false;
    if (begun) {
      try { await bounded(client.query('rollback'), 500, unknown()); rollbackConfirmed = true; } catch {}
    }
    release(!rollbackConfirmed);
    if (!rollbackConfirmed) throw unknown();
    if (error?.code === '55P03') throw previewError('requestInProgress', 409);
    if (error?.code === '57014') throw previewError('saveTimeout');
    throw error;
  }
}
