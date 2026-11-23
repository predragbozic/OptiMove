import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDisposableDatabase } from './disposable-db.mjs';
import { bootstrapLegacySnapshot } from './legacy-bootstrap.mjs';
import { runMigrations } from '../../src/migrate.js';

// Replays the checked-in baseline into a database owned by this test only.
// A private migrations directory lets tests stop before A or B without changing files.
export async function createPagesDatabase({ through = '202611201500', label = 'pages', omit = [] } = {}) {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'optimove-pages-'));
  const migrationsRoot = path.join(temp, 'migrations_v2');
  fs.mkdirSync(migrationsRoot);
  for (const file of fs.readdirSync(path.join(root, 'migrations_v2')).sort()) {
    if (/^[0-9]{12}_.*\.sql$/.test(file) && file.slice(0, 12) <= through && !omit.includes(file)) {
      fs.copyFileSync(path.join(root, 'migrations_v2', file), path.join(migrationsRoot, file));
    }
  }
  const db = await createDisposableDatabase({ prefix: 'dashboard', label });
  let client;
  try {
    const snapshotSql = fs.readFileSync(path.join(root, 'backend/tests/support/legacy-schema.sql'), 'utf8');
    const lastMigration = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)?.[1];
    if (!lastMigration) throw new Error('Missing snapshot migration marker');
    await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot, lastMigration });
    await runMigrations({ databaseUrl: db.url, migrationsRoot });
    client = new pg.Client({ connectionString: db.url });
    await client.connect();
    return { ...db, client, async applyThrough(nextThrough) {
      if (!/^[0-9]{12}$/.test(nextThrough)) throw new Error('A 12-digit migration boundary is required');
      for (const file of fs.readdirSync(path.join(root, 'migrations_v2')).sort()) {
        if (/^[0-9]{12}_.*\.sql$/.test(file) && file.slice(0, 12) <= nextThrough) fs.copyFileSync(path.join(root, 'migrations_v2', file), path.join(migrationsRoot, file));
      }
      await runMigrations({databaseUrl: db.url, migrationsRoot});
    }, async drop() { await client.end(); await db.drop(); fs.rmSync(temp, { recursive: true, force: true }); } };
  } catch (error) {
    await client?.end().catch(() => {});
    await db.drop(); fs.rmSync(temp, { recursive: true, force: true }); throw error;
  }
}
