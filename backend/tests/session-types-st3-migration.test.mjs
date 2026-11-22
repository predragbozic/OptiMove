// ST-3, migration v89 itself: the preflight and the post-check on a database before and after v89, the rollback round
// trip (the catalog equal to the one before v89, v4's two bodies back by md5), the rollback's refusals, and v89's own
// refusal over a changed body. A disposable database only (optimove_tests_gpexe_*), invented rows.
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
// The one place this suite names the migration.
const V89 = "202611221400_training_load_v89_participant_session_types.sql";
const BEFORE = GPEXE_TEST_MIGRATIONS.filter((f) => f < V89);
const RUNBOOK = (f) => fs.readFileSync(path.join(REPO, "docs/runbooks", `participant-session-types-v89${f}`), "utf8");
const CONSTRAINTS_SQL = `select string_agg(conname || '=' || pg_get_constraintdef(oid), ',' order by conname) as c from pg_constraint
  where conrelid = 'training.activity_field_correction_log'::regclass`;

let db;
let c;
let ids;
before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "st3mig", migrations: BEFORE });
  c = new pg.Client({ connectionString: db.url });
  await c.connect();
  assert.equal((await c.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: unexpected database");
  const one = async (sql, params = []) => (await c.query(sql, params)).rows[0];
  const user = (await one(`insert into public.users (email, full_name, display_name) values ($1, 'St3 coach', 'St3 coach') returning id`, [`st3-${crypto.randomBytes(3).toString("hex")}@test.local`])).id;
  const club = (await one(`insert into public.clubs (name) values ('St3 club') returning id`)).id;
  const team = (await one(`insert into public.teams (club_id, name) values ($1, 'St3 team') returning id`, [club])).id;
  await c.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1, $2, 'team_coach', true)`, [user, team]);
  const athlete = (await one(`insert into public.athletes (full_name, display_name, device_timezone) values ('St3 athlete', 'St3 athlete', 'UTC') returning id`)).id;
  const activity = (await one(`insert into training.activities (activity_type_key, occurred_local_date, timezone_snapshot, owner_scope, owner_team_id, origin)
                               values ('training_session', '2026-11-20', 'UTC', 'team', $1, 'manual') returning id`, [team])).id;
  const participant = (await one(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot)
                                  values ($1, $2, '2026-11-20', 'UTC') returning id`, [activity, athlete])).id;
  ids = { user, club, team, athlete, activity, participant };
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
async function allBlocks(file) {
  const bad = [];
  for (const [b, sql] of Object.entries(blocks(RUNBOOK(file)))) bad.push(...falseColumns(await readOnly(sql)).map((k) => `${b}.${k}`));
  return bad;
}
const recorded = async () => (await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [`migrations_v2/${V89}`])).rows[0].n;

test("1. preflight, apply, post-check, rollback to the same catalog, apply again", async () => {
  assert.deepEqual(await allBlocks("-preflight.sql"), [], "the preflight passes before v89");
  const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];
  const constraintsBefore = (await c.query(CONSTRAINTS_SQL)).rows[0].c;

  await applyGpexeTestMigrations(db.url, [V89]);
  assert.deepEqual(await allBlocks("-preflight.sql"),
    ["1.v89_not_recorded", "2.no_exception_table", "2.no_request_table", "2.no_functions", "2.merge_body_is_v4", "2.reparent_body_is_v4", "2.correction_log_key_is_v1"],
    "after v89 the preflight refuses exactly on the v89 objects");
  assert.deepEqual(await allBlocks("-postcheck.sql"), [], "the post-check passes after v89");
  assert.equal((await c.query(`select training.effective_activity_type($1) as t`, [ids.participant])).rows[0].t, "training_session",
    "without an exception the effective type is the session's");

  await c.query(RUNBOOK("-rollback.sql"));
  assert.deepEqual((await c.query(CATALOG_SQL)).rows[0], catalogBefore, "the rollback restores the catalog exactly (v4's bodies by md5 too)");
  assert.equal((await c.query(CONSTRAINTS_SQL)).rows[0].c, constraintsBefore, "the correction log's key is v1's again");
  assert.equal(await recorded(), 0);

  await applyGpexeTestMigrations(db.url, [V89]);
  assert.deepEqual(await allBlocks("-postcheck.sql"), [], "v89 applies again after its rollback");
});

test("2. the rollback refuses once an exception or a request row exists, and changes nothing", async () => {
  const refuse = async (label) => {
    await assert.rejects(c.query(RUNBOOK("-rollback.sql")), (error) => error.code === "23514" && /v89 rollback refused: a session type was changed in the app/.test(error.message), label);
    await c.query("rollback").catch(() => {});
    assert.equal(await recorded(), 1, `${label}: nothing changed`);
  };
  await c.query("begin");
  await c.query(`select set_config('optimove.session_type_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [ids.user]);
  await c.query(`insert into training.participant_activity_types (participant_id, activity_type_key, set_by_user_id, set_by_basis) values ($1, 'rtp_session', $2, 'team_coach')`, [ids.participant, ids.user]);
  await c.query("commit");
  assert.equal((await c.query(`select training.effective_activity_type($1) as t`, [ids.participant])).rows[0].t, "rtp_session");
  await refuse("an exception row");
});

test("3. v89 refuses to run over a body that is not v4's, or when it is already applied", async () => {
  const fresh = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "st3mig2", migrations: BEFORE });
  const f = new pg.Client({ connectionString: fresh.url });
  await f.connect();
  try {
    const sql = fs.readFileSync(path.join(REPO, "migrations_v2", V89), "utf8");
    const body = (await f.query(`select pg_get_functiondef('training.merge_activity_participants(uuid, uuid, uuid, text)'::regprocedure) as d`)).rows[0].d;
    await f.query(body.replace("source and target are the same participant", "source and target are one participant"));
    await assert.rejects(f.query(`begin; ${sql}; commit;`), (error) => error.code === "23514" && /v89 refused: the body in force of training.merge_activity_participants is not v4's/.test(error.message));
    await f.query("rollback").catch(() => {});
    assert.equal((await f.query(`select to_regclass('training.participant_activity_types') is null as none`)).rows[0].none, true, "nothing of v89 was left behind");
    await f.query(body);
    await f.query(`begin; ${sql}; commit;`);
    await assert.rejects(f.query(`begin; ${sql}; commit;`), (error) => error.code === "23514" && /v89 refused: a v89 table already exists/.test(error.message));
    await f.query("rollback").catch(() => {});
  } finally {
    await f.end().catch(() => {});
    await fresh.drop();
  }
});
