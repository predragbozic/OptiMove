import pg from 'pg';
import { createPostgresPreviewCoordinator } from '../../../src/dashboardSimple/postgresAdmission.js';
import { checkoutObservedClient } from '../../../src/dashboardSimple/clientLifecycle.js';
import { assertConnectedTo, assertDisposableDatabaseName, parseServerUrl } from '../../support/disposable-db.mjs';

let pool, coordinator, lastPid, queryResult, queryCheckout;
const leases = new Map();
const disconnected = new Set();
const waiters = new Map();
process.on('message', async message => {
  const reply = { seq: message.seq };
  try {
    if (message.operation === 'init') {
      const url = parseServerUrl(message.url);
      assertDisposableDatabaseName(message.name);
      if (url.pathname !== `/${message.name}`) throw new Error('Unexpected database');
      pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 500 });
      pool.on('acquire', client => {
        client.once('end', () => {
          disconnected.add(client.processID);
          waiters.get(client.processID)?.();
        });
      });
      await assertConnectedTo(pool, message.name);
      coordinator = createPostgresPreviewCoordinator({ pool, processId: 'child', maxActiveDeployment: 2 });
    } else if (message.operation === 'acquire') {
      const acquired = client => { lastPid = client.processID; };
      pool.on('acquire', acquired);
      try {
        const lease = await coordinator.tryAcquire({ userId: message.userId, processId: 'child', processLimit: 2 });
        leases.set(message.userId, lease);
        reply.pid = lastPid;
      } finally { pool.off('acquire', acquired); }
    } else if (message.operation === 'release') {
      const lease = leases.get(message.userId);
      await lease.release();
      leases.delete(message.userId);
    } else if (message.operation === 'startQuery') {
      queryCheckout = await checkoutObservedClient(leases.get(message.userId).queryPool);
      await queryCheckout.client.query('begin isolation level repeatable read read only');
      queryResult = queryCheckout.client.query('select pg_sleep(10)').then(() => 'queryFinished', () => 'queryFailed');
    } else if (message.operation === 'finishQuery') {
      const outcome = await queryResult;
      queryCheckout.lifecycle.release(true);
      reply.code = outcome;
    } else if (message.operation === 'waitDisconnect') {
      if (!disconnected.has(lastPid)) await new Promise(resolve => waiters.set(lastPid, resolve));
    } else if (message.operation === 'healthy') {
      const result = await pool.query('select 1 as healthy');
      if (result.rows[0].healthy !== 1) throw new Error('Unhealthy pool');
    } else throw new Error('Unknown command');
    if (!reply.code) reply.ok = true;
  } catch (error) { reply.code = error.code === 'previewBusy' ? error.code : 'workerFailure'; }
  process.send(reply);
});
