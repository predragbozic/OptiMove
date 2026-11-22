// v87 itself: the preflight and the post-check before and after it, the rollback round trip (the catalog equal to the one
// before v87), the rollback's refusals and the migration's own refusals (the md5 gates, a sport named Football, a row in
// the registry). A disposable database only (optimove_tests_gpexe_*), invented rows.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb } from "./_gpexe-disposable-db.mjs";
import { calendarMigrations } from "./support/calendar-fixture.mjs";
import { blocks, CATALOG_SQL, V87_FILE } from "../scripts/athlete-positions-v87-rehearsal.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNBOOK = (f) => fs.readFileSync(path.join(REPO, "docs/runbooks", f), "utf8");
const MIGRATION = fs.readFileSync(path.join(REPO, "migrations_v2", V87_FILE), "utf8");
const recorded = async (c) => (await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [`migrations_v2/${V87_FILE}`])).rows[0].n;

let db;
let c;
let ids;
before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: process.env.DATABASE_URL, label: "pos87mig", migrations: calendarMigrations() });
  c = new pg.Client({ connectionString: db.url });
  await c.connect();
  assert.equal((await c.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: unexpected database");
  const one = async (sql, params = []) => (await c.query(sql, params)).rows[0];
  const user = (await one(`insert into public.users (email, full_name, display_name) values ($1, 'Pos admin', 'Pos admin') returning id`, [`pos87-${crypto.randomBytes(3).toString("hex")}@test.local`])).id;
  const club = (await one(`insert into public.clubs (name) values ('Pos club') returning id`)).id;
  const team = (await one(`insert into public.teams (club_id, name) values ($1, 'Pos team') returning id`, [club])).id;
  const athlete = (await one(`insert into public.athletes (full_name, display_name) values ('Pos athlete', 'Pos athlete') returning id`)).id;
  await c.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status) values ($1, $2, $3, 'team', 'active')`, [athlete, club, team]);
  await c.query(`insert into public.user_club_roles (user_id, club_id, role) values ($1, $2, 'club_admin')`, [user, club]);
  ids = { user, club, team, athlete };
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
// The migration's text run in a transaction that is rolled back, for its refusals.
async function refusedMigration(setup) {
  await c.query("begin");
  try {
    await setup();
    await c.query(MIGRATION);
    return "no refusal";
  } catch (error) {
    return `${error.code} ${error.message}`;
  } finally {
    await c.query("rollback");
  }
}

test("1. the migration refuses, changing nothing: another body of estimate_basis_ok or validate_metric_value_estimate, a sport named Football, a row in the registry", async () => {
  const basis = await refusedMigration(() => c.query(`create or replace function training_load.estimate_basis_ok(p_method text, p_basis jsonb) returns boolean as $$ select false $$ language sql immutable`));
  assert.match(basis, /^23514 v87 refused: the body in force of training_load.estimate_basis_ok/);
  const guard = await refusedMigration(() => c.query(`create or replace function training_load.validate_metric_value_estimate() returns trigger as $$ begin return new; end $$ language plpgsql`));
  assert.match(guard, /^23514 v87 refused: the body in force of training_load.validate_metric_value_estimate/);
  assert.match(await refusedMigration(() => c.query(`insert into public.sports (name) values ('Football')`)), /^23514 v87 refused: a sport named Football/);
  assert.match(await refusedMigration(async () => {
    const s = (await c.query(`insert into public.sports (name) values ('Other') returning id`)).rows[0].id;
    await c.query(`insert into public.sport_positions (sport_id, name) values ($1, 'Pivot')`, [s]);
  }), /^23514 v87 refused: public.sport_positions already holds a row/);
  assert.equal(await recorded(c), 0);
});

test("2. preflight, apply, post-check, rollback to the same catalog, apply again", async () => {
  assert.deepEqual(await allBlocks("athlete-positions-v87-preflight.sql"), [], "the preflight passes before v87");
  const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];
  // The Rukovodilac's condition: nothing the Tests module reads changes - its foreign keys into public.sports and
  // public.sport_positions (and the unique (id, sport_id) they rest on) are the same and valid before, after and after the
  // rollback.
  const TESTS_FKS = `select string_agg(conrelid::regclass::text || '.' || conname || '=' || pg_get_constraintdef(oid) || ':' || convalidated::text, ',' order by conname) as fks,
                            (select count(*) from pg_constraint where conrelid = 'public.sport_positions'::regclass and conname = 'sport_positions_id_sport_id_key') as id_sport_unique
                       from pg_constraint where contype = 'f' and confrelid in ('public.sports'::regclass, 'public.sport_positions'::regclass)
                        and connamespace = 'tests'::regnamespace`;
  const fksBefore = (await c.query(TESTS_FKS)).rows[0];
  assert.ok((fksBefore.fks ?? "").split(",").length >= 4, "the Tests module's foreign keys exist");
  await applyGpexeTestMigrations(db.url, [V87_FILE]);
  assert.deepEqual((await c.query(TESTS_FKS)).rows[0], fksBefore, "v87 changes none of the Tests module's foreign keys");
  assert.deepEqual(await allBlocks("athlete-positions-v87-preflight.sql"), [
    "1.v85_last", "1.v87_not_recorded", "2.v42_shape", "2.positions_empty", "2.football_free", "2.v42_unique", "2.no_assignment_table", "2.no_change_log", "2.no_override_table", "2.no_functions",
    "3.basis_body_v69", "3.guard_body_v64", "3.method_check_v69",
  ], "after v87 the preflight refuses exactly on the v87 objects");
  assert.deepEqual(await allBlocks("athlete-positions-v87-postcheck.sql"), [], "the post-check passes after v87");
  await c.query(RUNBOOK("athlete-positions-v87-rollback.sql"));
  assert.deepEqual((await c.query(CATALOG_SQL)).rows[0], catalogBefore, "the rollback restores the catalog exactly");
  assert.deepEqual((await c.query(TESTS_FKS)).rows[0], fksBefore, "and the Tests module's foreign keys");
  assert.equal(await recorded(c), 0);
  await applyGpexeTestMigrations(db.url, [V87_FILE]);
  assert.deepEqual(await allBlocks("athlete-positions-v87-postcheck.sql"), [], "the post-check passes after the second apply");
});

test("3. the rollback refuses, changing nothing, once a position was changed in the app or an athlete's position was set", async () => {
  const refuse = async (label) => {
    await assert.rejects(c.query(RUNBOOK("athlete-positions-v87-rollback.sql")), (error) => error.code === "23514" && /v87 rollback refused/.test(error.message), label);
    await c.query("rollback").catch(() => {});
    assert.equal(await recorded(c), 1, `${label}: nothing changed`);
  };
  const gk = (await c.query(`select id from public.sport_positions where name = 'Goalkeeper'`)).rows[0].id;
  await c.query("begin");
  await c.query(`select set_config('optimove.position_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [ids.user]);
  await c.query(`insert into public.athlete_positions (athlete_id, club_id, position_id, set_by_user_id, basis, request_key, request_hash)
                 values ($1, $2, $3, $4, 'club_admin', gen_random_uuid(), $5)`, [ids.athlete, ids.club, gk, ids.user, "a".repeat(64)]);
  await c.query("commit");
  await refuse("an athlete's position was set");

  await c.query("begin");
  await c.query(`select set_config('optimove.position_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [ids.user]);
  const id = (await c.query(`insert into public.sport_positions (sport_id, name, owner_scope, owner_club_id, created_by_user_id)
                             values ((select id from public.sports where name = 'Football'), 'Pivot', 'club', $1, $2) returning id`, [ids.club, ids.user])).rows[0].id;
  await c.query(`insert into public.sport_position_changes (position_id, action, new_name, performed_by_user_id, basis, request_key, request_hash)
                 values ($1, 'create', 'Pivot', $2, 'club_admin', gen_random_uuid(), $3)`, [id, ids.user, "c".repeat(64)]);
  await c.query("commit");
  await refuse("a club position and a change row");
});
