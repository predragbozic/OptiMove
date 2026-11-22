// ST-1, migration v85 itself: the seed of the team suggestions from a real active gpexe binding, the preflight and the
// post-check on a database before and after v85, the rollback round trip (the catalog and the type rows equal to the
// ones before v85) and the rollback's refusals. A disposable database only (optimove_tests_gpexe_*), invented rows.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { blocks, CATALOG_SQL } from "../scripts/session-types-v85-rehearsal.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const V85 = "202611201500_training_load_v85_session_types.sql";
// Everything before v85 (a later migration, such as v88, needs v85 and is not part of this rehearsal).
const BEFORE = GPEXE_TEST_MIGRATIONS.filter((f) => f < V85);
const RUNBOOK = (f) => fs.readFileSync(path.join(REPO, "docs/runbooks", f), "utf8");

let db;
let c;
let ids;
before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "st1mig", migrations: BEFORE });
  c = new pg.Client({ connectionString: db.url });
  await c.connect();
  assert.equal((await c.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: unexpected database");
  const one = async (sql, params = []) => (await c.query(sql, params)).rows[0];
  const user = (await one(`insert into public.users (email, full_name, display_name) values ($1, 'St1 admin', 'St1 admin') returning id`, [`st1-${crypto.randomBytes(3).toString("hex")}@test.local`])).id;
  const club = (await one(`insert into public.clubs (name) values ('St1 club') returning id`)).id;
  const team = (await one(`insert into public.teams (club_id, name) values ($1, 'St1 team') returning id`, [club])).id;
  const other = (await one(`insert into public.teams (club_id, name) values ($1, 'St1 unbound team') returning id`, [club])).id;
  const connection = (await one(
    `insert into training_load.source_credential_connections (source_system, owner_scope, owner_team_id, host_key, account_label, credential_kind, created_by_user_id, state,
                                                              credential_ciphertext, credential_nonce, credential_auth_tag, credential_key_version, last_verified_at)
     values ('gpexe','team',$1,'server3','st1 test','exchanged_token',$2,'verified',$3,$4,$5,1, now()) returning id`,
    [team, user, crypto.randomBytes(24), crypto.randomBytes(12), crypto.randomBytes(16)])).id;
  await c.query(`insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1, '985001', $2)`, [team, user]);
  await c.query(`insert into training_load.source_team_bindings (team_id, connection_id, source_system, source_team_id, bound_by_user_id, legacy_gpexe_settings_team_id)
                 values ($1, $2, 'gpexe', '985001', $3, $1)`, [team, connection, user]);
  const activity = (await one(`insert into training.activities (activity_type_key, occurred_local_date, timezone_snapshot, owner_scope, owner_team_id, origin)
                               values ('testing_session', '2026-11-20', 'UTC', 'team', $1, 'manual') returning id`, [team])).id;
  ids = { user, club, team, other, activity };
});
after(async () => {
  await c?.end().catch(() => {});
  await db?.drop();
});

const readOnly = async (sql) => {
  await c.query("begin transaction read only");
  try { return (await c.query(sql)).rows[0]; } finally { await c.query("rollback"); }
};
const falseColumns = (row) => Object.entries(row).filter(([, v]) => v === false).map(([k]) => k);
async function allBlocks(file, skip = []) {
  const bad = [];
  for (const [b, sql] of Object.entries(blocks(RUNBOOK(file)))) if (!skip.includes(b)) bad.push(...falseColumns(await readOnly(sql)).map((k) => `${b}.${k}`));
  return bad;
}

test("1. preflight, apply, seed, post-check, rollback to the same catalog, apply again", async () => {
  assert.deepEqual(await allBlocks("session-types-v85-preflight.sql"), [], "the preflight passes before v85");
  const pre3a = await readOnly(blocks(RUNBOOK("session-types-v85-preflight.sql"))["3a"]);
  assert.equal(Number(pre3a.gpexe_bound_teams), 1);
  const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];

  await applyGpexeTestMigrations(db.url, [V85]);
  assert.deepEqual(await allBlocks("session-types-v85-preflight.sql"), ["1.v85_not_recorded", "2.v1_shape", "2.v1_types_as_seeded", "2.new_keys_free", "2.no_change_log", "2.no_source_map", "2.no_functions"],
    "after v85 the preflight refuses exactly on the v85 objects");
  assert.deepEqual(await allBlocks("session-types-v85-postcheck.sql"), [], "the post-check passes after v85");
  const seed = (await c.query(`select owner_team_id, source_system, category_name, activity_type_key, set_by_user_id, seeded from training_load.source_session_types`)).rows;
  assert.deepEqual(seed, [{ owner_team_id: ids.team, source_system: "gpexe", category_name: "FULL TRAINING", activity_type_key: "training_session", set_by_user_id: null, seeded: true }],
    "one suggestion for the bound team, none for the unbound one");
  assert.equal((await c.query(`select activity_type_key from training.activities where id = $1`, [ids.activity])).rows[0].activity_type_key, "testing_session",
    "an activity keeps an archived v1 type");

  await c.query(RUNBOOK("session-types-v85-rollback.sql"));
  const catalogAfter = (await c.query(CATALOG_SQL)).rows[0];
  assert.deepEqual(catalogAfter, catalogBefore, "the rollback restores the catalog and the type rows exactly");
  assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [`migrations_v2/${V85}`])).rows[0].n, 0);

  await applyGpexeTestMigrations(db.url, [V85]);
  assert.deepEqual(await allBlocks("session-types-v85-postcheck.sql"), [], "the post-check passes after the second apply");
});

test("2. the rollback refuses once a type was changed in the app, or an activity holds a v85 type", async () => {
  const refuse = async (label) => {
    await assert.rejects(c.query(RUNBOOK("session-types-v85-rollback.sql")), (error) => error.code === "23514" && /v85 rollback refused/.test(error.message), label);
    await c.query("rollback").catch(() => {});
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [`migrations_v2/${V85}`])).rows[0].n, 1, `${label}: nothing changed`);
  };
  const activity = (await c.query(`insert into training.activities (activity_type_key, occurred_local_date, timezone_snapshot, owner_scope, owner_team_id, origin)
                                   values ('rtp_session', '2026-11-20', 'UTC', 'team', $1, 'manual') returning id`, [ids.team])).rows[0].id;
  await refuse("an activity holds rtp_session");
  await c.query(`delete from training.activities where id = $1`, [activity]);

  await c.query(`insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'club_admin')`, [ids.user, ids.club]);
  await c.query("begin");
  await c.query(`select set_config('optimove.session_type_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [ids.user]);
  await c.query(`insert into training.activity_types (key, label, owner_scope, owner_club_id, created_by_user_id) values ('c_0000abcd_gym', 'Gym', 'club', $1, $2)`, [ids.club, ids.user]);
  await c.query(`insert into training.activity_type_changes (type_key, action, new_label, performed_by_user_id, basis, request_key, request_hash)
                 values ('c_0000abcd_gym', 'create', 'Gym', $1, 'club_admin', gen_random_uuid(), $2)`, [ids.user, "c".repeat(64)]);
  await c.query("commit");
  await refuse("a club type and a change row");
});
