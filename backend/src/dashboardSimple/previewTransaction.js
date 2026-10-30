import { performance } from 'node:perf_hooks';

export function previewError(code, status = 503, reason) {
  return Object.assign(new Error(code), { code, status, ...(reason ? { reason } : {}) });
}

function bounded(promise, milliseconds, error) {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(error), milliseconds); })])
    .finally(() => clearTimeout(timer));
}

export async function withPreviewTransaction({ pool, signal, onReleased = () => {}, checkoutTimeoutMs = 1000, transactionTimeoutMs = 5000, statementTimeoutMs = 3000 }, operation) {
  if (!pool || typeof pool.connect !== 'function' || typeof operation !== 'function' ||
      ![checkoutTimeoutMs, transactionTimeoutMs, statementTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0) ||
      checkoutTimeoutMs > 5000 || transactionTimeoutMs > 5000 || statementTimeoutMs > 3000) throw new TypeError('Bounded preview transaction required');
  let client, closed = false, begun = false, stopping = false;
  const release = async destroy => {
    if (closed) return;
    closed = true;
    if (client) client.release(destroy);
    await onReleased();
  };
  if (signal?.aborted) { await release(false); throw previewError('previewAborted', 499); }
  const pendingClient = Promise.resolve().then(() => pool.connect());
  try {
    client = await bounded(pendingClient, checkoutTimeoutMs, previewError('previewBusy', 429));
  } catch (error) {
    pendingClient.then(async lateClient => { client = lateClient; await release(true); }, () => release(false)).catch(() => {});
    throw error;
  }
  const deadline = performance.now() + transactionTimeoutMs;
  let queue = Promise.resolve();
  const check = () => {
    if (closed || stopping || signal?.aborted) throw previewError('previewAborted', 499);
    if (performance.now() >= deadline) throw previewError('previewTimeout');
  };
  const queryRunner = (sql, params = []) => {
    const pending = queue.then(async () => {
      check();
      if (typeof sql !== 'string' || !/^\s*select\b/i.test(sql) || /;\s*\S/.test(sql)) throw previewError('previewReadOnlyViolation');
      const remaining = Math.max(1, Math.min(statementTimeoutMs, Math.floor(deadline - performance.now())));
      await client.query(`set local statement_timeout = '${remaining}ms'`);
      check();
      const result = await client.query(sql, params);
      check();
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  };
  try {
    check();
    begun = true;
    await bounded(client.query('begin isolation level repeatable read read only'), Math.max(1, deadline - performance.now()), previewError('previewTimeout'));
    const result = await bounded(Promise.resolve().then(() => operation(queryRunner)), Math.max(1, deadline - performance.now()), previewError('previewTimeout'));
    await queue;
    check();
    await bounded(client.query('rollback'), Math.max(1, Math.min(500, deadline - performance.now())), previewError('previewCleanupFailed'));
    begun = false;
    await release(false);
    return result;
  } catch (error) {
    stopping = true;
    const cleanupDeadline = performance.now() + 500;
    let destroy = false;
    try { await bounded(queue, 500, previewError('previewCleanupFailed')); } catch { destroy = true; }
    if (begun) {
      try { await bounded(client.query('rollback'), Math.max(1, cleanupDeadline - performance.now()), previewError('previewCleanupFailed')); begun = false; } catch { destroy = true; }
    }
    await release(destroy || begun);
    if (error?.code === '57014') throw previewError('previewTimeout');
    if (error?.code === '25006') throw previewError('previewReadOnlyViolation');
    throw error;
  }
}
