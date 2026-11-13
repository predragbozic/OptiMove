import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

export async function createSimpleV50Database(base) {
  const url = new URL(base);
  if (url.hostname !== '127.0.0.1' || !['5432', '55432'].includes(url.port) || url.pathname !== '/postgres') {
    throw new Error('Expected the local PostgreSQL server');
  }
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  const name = 'optimove_s7b_probe_' + randomUUID().replaceAll('-', '');
  const drop = async () => {
    try { await admin.query('DROP DATABASE ' + name + ' WITH (FORCE)'); }
    finally { await admin.end(); }
  };
  try { await admin.query('CREATE DATABASE ' + name); }
  catch (error) { await admin.end(); throw error; }
  url.pathname = '/' + name;
  const client = new pg.Client({ connectionString: url.href });
  try {
    await client.connect();
    await client.query('DROP SCHEMA public');
    execFileSync('C:/Program Files/PostgreSQL/17/bin/pg_restore.exe', [
      '-h', '127.0.0.1', '-p', url.port, '-U', 'postgres', '-d', name, '-w',
      '--schema-only', '--no-owner', '--no-privileges', '--exit-on-error',
      'D:/OptiMove-backups/optimove-production-2026-11-02.dump'
    ], { env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) }, stdio: 'inherit' });
    const root = new URL('../../../migrations_v2/', import.meta.url);
    const names = await fs.readdir(root);
    for (const file of names.filter(name => name.startsWith('202611')).sort()) {
      await client.query(await fs.readFile(new URL(file, root), 'utf8'));
    }
    await client.query(await fs.readFile(new URL('202609101200_training_load_v18_dashboard_catalog_seed.sql', root), 'utf8'));
    const activity = await fs.readFile(new URL('202609071000_training_activity_v1_core_tables.sql', root), 'utf8');
    await client.query(activity.match(/insert into training\.activity_types \(key, label\) values[\s\S]*?;/)[0]);
    return { name, url: url.href, drop };
  } catch (error) {
    await drop();
    throw error;
  } finally {
    await client.end();
  }
}
