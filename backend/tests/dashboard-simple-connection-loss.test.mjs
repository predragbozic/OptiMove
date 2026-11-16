import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDisposableDatabase } from './support/disposable-db.mjs';

let database;
before(async () => {
  database = await createDisposableDatabase({ prefix: 'simple_disconnect', label: 'primary' });
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    await client.query(`create table connection_probe(request_id text primary key);
      create function write_probe(p_request text) returns text language sql as $$
        insert into connection_probe values(p_request) returning request_id;
      $$;`);
  } finally { await client.end(); }
});
after(async () => { await database?.drop(); });

for (const mode of ['between', 'active', 'commit', 'commit-recovery', 'preview']) {
  test(`real PostgreSQL disconnect in ${mode} is contained in a subprocess with correct receipt outcome and healthy follow-up`, () => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./support/dashboard-simple-disconnect-child.mjs', import.meta.url)), mode], {
      env: { ...process.env, DATABASE_URL: database.url }, encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event|uncaughtException/);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.survived, true);
    assert.equal(evidence.mode, mode);
  });
}
