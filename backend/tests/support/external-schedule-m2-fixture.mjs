import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { runMigrations } from "../../src/migrate.js";

export const EXTERNAL_SCHEDULE_BRIDGE_MIGRATION = "202612011000_training_load_v99_schedule_manage_bridge.sql";
const ROSTER_BRIDGE_MIGRATION = "202612031000_training_load_v101_roster_manage_bridge.sql";
const ESTIMATE_BRIDGE_MIGRATION = "202612041000_training_load_v102_estimates_manage_bridge.sql";
const v98 = new URL("../../../migrations_v2/202611301000_calendar_v98_manage_permissions.sql", import.meta.url);

// Curated schedule HTTP fixtures have the Roles v96 dependencies but no
// Calendar writers. Carry the exact v98 permission body into those fixtures,
// and run the real v99 file. Full-stack M-2 tests rehearse the complete chain.
export async function applyExternalScheduleBridgeForCuratedFixture(databaseUrl) {
  await applyTrainingLoadBridgeMigrations(databaseUrl, [EXTERNAL_SCHEDULE_BRIDGE_MIGRATION]);
}

export async function applyRosterBridgeForCuratedFixture(databaseUrl, { historicalRollback = false } = {}) {
  await applyTrainingLoadBridgeMigrations(databaseUrl, [EXTERNAL_SCHEDULE_BRIDGE_MIGRATION, ROSTER_BRIDGE_MIGRATION], historicalRollback);
}

export async function applyEstimateBridgeForCuratedFixture(databaseUrl) {
  await applyTrainingLoadBridgeMigrations(databaseUrl, [EXTERNAL_SCHEDULE_BRIDGE_MIGRATION, ROSTER_BRIDGE_MIGRATION, ESTIMATE_BRIDGE_MIGRATION]);
}

async function applyTrainingLoadBridgeMigrations(databaseUrl, files, historicalRollback = false) {
  const url = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  assert.match(url.pathname, /^\/optimove_tests_[a-z0-9_]+$/);
  const client = new pg.Client({ connectionString: databaseUrl });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "optimove-m2-fixture-"));
  const dir = path.join(root, "migrations_v2");
  try {
    await client.connect();
    const sql = await fs.readFile(v98, "utf8");
    const body = sql.match(/create or replace function public\.permission_word_honoured\(p_word text\)[\s\S]*?\$\$;/)?.[0];
    assert.ok(body, "the curated schedule fixture copies v98's permission body");
    await client.query(body);
    await fs.mkdir(dir);
    for (const file of files) await fs.copyFile(new URL(`../../../migrations_v2/${file}`, import.meta.url), path.join(dir, file));
    await runMigrations({ databaseUrl, migrationsRoot: dir });
    // The shared test server needs current attendance checks. Historical rollback cases on its database still
    // need the original registry cutoff, like the existing roleRead fixture.
    if (historicalRollback) {
      await client.query("delete from public.schema_migrations where migration_name = any($1)",
        [files.map((file) => `migrations_v2/${file}`)]);
    }
  } finally {
    await client.end().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
}
