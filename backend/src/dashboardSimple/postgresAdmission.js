import { createHash } from 'node:crypto';
import { checkoutObservedClient } from './clientLifecycle.js';

const prefix = 'dashboard-simple-preview-v1';
const digest = value => createHash('sha256').update(`${prefix}:${value}`).digest();
const key = value => digest(value).readBigInt64BE().toString();
const configNamespace = digest('config').readInt32BE();
const begin = 'begin isolation level repeatable read read only';
const transactionStateSql = `select pg_backend_pid() as pid, transaction_timestamp()::text as started,
  current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const positive = value => Number.isSafeInteger(value) && value > 0;
const processes = new Map();
const busy = () => Object.assign(new Error('previewBusy'), { code: 'previewBusy', status: 429, retryAfter: 1 });

async function bounded(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(busy()), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function createPostgresPreviewCoordinator({ pool, processId, maxActiveDeployment,
  checkoutTimeoutMs = 400, queryTimeoutMs = 300 } = {}) {
  if (typeof pool?.connect !== 'function' || typeof processId !== 'string' || !processId.length || processId.length > 256
    || !positive(maxActiveDeployment) || maxActiveDeployment > 16
    || !positive(checkoutTimeoutMs) || checkoutTimeoutMs > 1000
    || !positive(queryTimeoutMs) || queryTimeoutMs > 1000) throw new TypeError('Trusted bounded PostgreSQL preview configuration required');
  async function tryAcquire(request = {}) {
    const deadline = performance.now() + 400;
    const { userId, processId: requestedProcess, processLimit } = request ?? {};
    const state = processes.get(processId) ?? { active: 0, limit: processLimit };
    if (requestedProcess !== processId || typeof userId !== 'string' || !uuid.test(userId)
      || !positive(processLimit) || processLimit > 2 || state.active >= processLimit
      || state.active && state.limit !== processLimit) throw busy();
    state.active += 1;
    processes.set(processId, state);
    let observed, disposed = false, counted = true, disconnected = false, releasePromise;
    let borrowed = false, returned = false, inFlight = 0, transactionOpen = false, previewStarted = false, transaction, transactionStartedAt;
    const restore = () => {
      if (counted) {
        counted = false;
        state.active -= 1;
        if (!state.active) processes.delete(processId);
      }
    };
    function dispose(destroy) {
      if (disposed) return;
      disposed = true;
      try { observed?.lifecycle.release(destroy); }
      finally {
        observed?.client.removeListener('error', lost);
        observed?.client.removeListener('end', lost);
        restore();
      }
    }
    function lost() {
      disconnected = true;
      try { dispose(true); } catch { restore(); }
    }
    function query(text, values) {
      if (disposed) return Promise.reject(busy());
      return observed.lifecycle.run(() => {
        if (disposed) throw busy();
        if (text === begin) transactionStartedAt = performance.now();
        return observed.client.query({ text, values, query_timeout: queryTimeoutMs });
      });
    }
    async function lock(lockKey) {
      const result = await query('select pg_try_advisory_xact_lock($1::bigint) as locked', [lockKey]);
      if (result.rows[0]?.locked !== true) throw busy();
    }
    async function validateTransaction() {
      const row = (await query(transactionStateSql)).rows[0];
      if (!Number.isInteger(row?.pid) || row.pid < 1 || typeof row.started !== 'string' || !row.started.length
        || row.isolation !== 'repeatable read' || row.read_only !== 'on'
        || transaction && (row.pid !== transaction.pid || row.started !== transaction.started)) throw busy();
      transaction = row;
    }
    const userKey = key(`user:${userId.toLowerCase()}`);
    try {
      const pending = checkoutObservedClient(pool);
      pending.then(value => { if (disposed) value.lifecycle.release(true); }).catch(() => {});
      observed = await bounded(pending, Math.min(checkoutTimeoutMs, Math.max(1, deadline - performance.now())));
      observed.client.on('error', lost);
      observed.client.on('end', lost);
      await bounded(observed.lifecycle.run(async () => {
        if ((await query(begin)).command !== 'BEGIN') throw busy();
        transactionOpen = true;
        await validateTransaction();
        const config = await query('select pg_try_advisory_xact_lock_shared($1::int, $2::int) as locked', [configNamespace, maxActiveDeployment]);
        if (config.rows[0]?.locked !== true) throw busy();
        const conflict = await query(`select exists (
          select 1 from pg_locks where locktype = 'advisory' and granted
          and database = (select oid from pg_database where datname = current_database())
          and classid = $1::oid and objsubid = 2 and objid <> $2::oid
        ) as mismatch`, [configNamespace >>> 0, maxActiveDeployment]);
        if (conflict.rows[0]?.mismatch !== false) throw busy();
        await lock(userKey);
        for (let slot = 1; slot <= maxActiveDeployment; slot += 1) {
          observed.lifecycle.check();
          if (disposed) throw busy();
          const candidate = key(`slot:${slot}`);
          const result = await query('select pg_try_advisory_xact_lock($1::bigint) as locked', [candidate]);
          if (result.rows[0]?.locked === true) return;
        }
        throw busy();
      }), Math.max(1, Math.min(queryTimeoutMs, deadline - performance.now())));
      observed.lifecycle.check();
      if (disposed) throw busy();
    } catch {
      try { dispose(true); } catch { restore(); }
      throw busy();
    }
    const queryClient = {
      on(event, listener) { observed.client.on(event, listener); return queryClient; },
      removeListener(event, listener) { observed.client.removeListener(event, listener); return queryClient; },
      async query(...args) {
        if (returned || disposed || !transactionOpen) throw busy();
        inFlight += 1;
        try {
          const [sql, params] = args;
          if (typeof sql !== 'string' || args.length > 2 || params !== undefined && !Array.isArray(params)) throw busy();
          if (sql === begin && args.length === 1 && !previewStarted) {
            await bounded(validateTransaction(), queryTimeoutMs);
            previewStarted = true;
            return { command: 'BEGIN', rows: [], rowCount: null };
          }
          if (!previewStarted || sql !== 'rollback' && !/^set local statement_timeout = '[1-9][0-9]*ms'$/.test(sql)
            && (!/^\s*select\b/i.test(sql) || /;\s*\S/.test(sql))) throw busy();
          const result = await observed.lifecycle.run(() => observed.client.query(...args));
          if (sql === 'rollback') {
            if (result.command !== 'ROLLBACK') throw busy();
            transactionOpen = false;
          }
          return result;
        } catch (error) {
          if (!previewStarted || error?.code === 'previewBusy') {
            try { dispose(true); } catch {}
            throw busy();
          }
          throw error;
        }
        finally { inFlight -= 1; }
      },
      release(destroy = false) {
        if (returned) return;
        returned = true;
        if (destroy || inFlight || transactionOpen) dispose(true);
      },
    };
    const queryPool = Object.freeze({
      transactionStartedAt,
      connect(callback) {
        try {
          observed.lifecycle.check();
          if (borrowed || disposed) throw busy();
          borrowed = true;
        } catch {
          if (typeof callback === 'function') { callback(busy()); return; }
          return Promise.reject(busy());
        }
        if (typeof callback === 'function') { callback(null, queryClient); return; }
        return Promise.resolve(queryClient);
      },
    });
    function release() {
      if (releasePromise) return releasePromise;
      if (borrowed && !returned && !disposed) return Promise.reject(busy());
      releasePromise = (async () => {
        try {
          if (disconnected) throw busy();
          if (disposed) return;
          if (transactionOpen) {
            const result = await bounded(query('rollback'), queryTimeoutMs);
            if (result.command !== 'ROLLBACK') throw busy();
            transactionOpen = false;
          }
          dispose(false);
        } catch {
          try { dispose(true); } catch { restore(); }
          throw busy();
        }
      })();
      return releasePromise;
    }
    return Object.freeze({ release, queryPool });
  }
  return Object.freeze({ tryAcquire });
}
