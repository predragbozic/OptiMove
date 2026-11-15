import assert from 'node:assert/strict';
import pg from 'pg';
import { runSimpleSaveTransaction } from '../../src/dashboardSimple/saveTransaction.js';
import { withPreviewTransaction } from '../../src/dashboardSimple/previewTransaction.js';

const mode = process.argv[2];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => {});
const killer = new pg.Client({ connectionString: process.env.DATABASE_URL });
await killer.connect();
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let recoveries = 0, writes = 0;
const releases = [], events = [];
const wrappedPool = {
  connect(callback) {
    return pool.connect((error, client) => {
      if (error) { callback(error); return; }
      const originalQuery = client.query.bind(client);
      const originalRelease = client.release.bind(client);
      const pid = client.processID;
      client.release = destroy => { releases.push(Boolean(destroy)); originalRelease(destroy); };
      client.query = async (...args) => {
        if (args[0] === 'commit' && mode.startsWith('commit')) {
          await originalQuery(...args);
          events.push('durableCommit');
          await killer.query('select pg_terminate_backend($1)', [pid]);
          return new Promise(() => {});
        }
        return originalQuery(...args);
      };
      callback(null, client);
    });
  },
};
const terminate = async query => {
  const pid = (await query('select pg_backend_pid() as pid')).rows[0].pid;
  await killer.query('select pg_terminate_backend($1)', [pid]);
  await wait(100);
};
let result, code;
try {
  if (mode === 'preview') {
    try { await withPreviewTransaction({ pool: wrappedPool }, async query => { await terminate(query); return 'must not succeed'; }); }
    catch (error) { code = error.code; }
    assert.equal(code, 'connectionLost');
  } else {
    try {
      result = await runSimpleSaveTransaction({ pool: wrappedPool, requestId: mode, commitTimeoutMs: 1000, recoveryTimeoutMs: 1500,
        write: async query => {
          writes++;
          await query('select write_probe($1)', [mode]);
          if (mode === 'between') await terminate(query);
          if (mode === 'active') {
            const pid = (await query('select pg_backend_pid() as pid')).rows[0].pid;
            const pending = query('select pg_sleep(10)');
            await wait(30);
            await killer.query('select pg_terminate_backend($1)', [pid]);
            await pending;
          }
          return { receipt: { requestId: mode } };
        },
        verify: async () => {
          recoveries++;
          return withPreviewTransaction({ pool: wrappedPool, checkoutTimeoutMs: 250, transactionTimeoutMs: 750 }, async query => {
            if (mode === 'commit-recovery') await terminate(query);
            const rows = (await query('select request_id from connection_probe where request_id=$1', [mode])).rows;
            return rows.length ? { requestId: mode } : null;
          });
        },
      });
    } catch (error) { code = error.code; }
    if (mode === 'commit') {
      assert.equal(code, undefined);
      assert.deepEqual(result, { requestId: mode, verification: 'verifiedAfterCommitError' });
    } else assert.equal(code, 'outcomeUnknown');
    assert.equal(writes, 1);
    assert.equal(recoveries, mode.startsWith('commit') ? 1 : 0);
  }
  await wait(150);
  const rows = (await killer.query('select request_id from connection_probe where request_id=$1', [mode])).rows;
  assert.equal(rows.length, mode.startsWith('commit') ? 1 : 0);
  assert.equal((await pool.query('select 1 as healthy')).rows[0].healthy, 1);
  assert.equal(releases[0], true);
  if (mode === 'commit-recovery') assert.deepEqual(releases, [true, true]);
  console.log(JSON.stringify({ mode, code, result, releases, recoveries, writes, events, survived: true }));
} finally {
  await killer.end();
  await pool.end();
}
