// Roles R2, v84's runbook SQL (contract test 7): every block of the read-only
// preflight and post-check runs in `begin transaction read only; ... rollback;`
// and returns its expected values - the preflight before v84, the post-check
// after it - and each hard value, flipped once on the disposable database,
// shows the refusal. The rollback's own rehearsal is test 1 of
// permission-roles-v84.test.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";
import { buildDatabase, MIGRATIONS, ROLE_IDS, RUNBOOKS } from "./support/permission-roles-world.mjs";

const PREFLIGHT = fs.readFileSync(path.join(RUNBOOKS, "permission-roles-v84-preflight.sql"), "utf8");
const POSTCHECK = fs.readFileSync(path.join(RUNBOOKS, "permission-roles-v84-postcheck.sql"), "utf8");
let db, c;
before(async () => {
  db = await buildDatabase({ label: "v84_runbook", withoutV84: true });
  c = new pg.Client({ connectionString: db.url });
  await c.connect();
  // Old role rows, so the fingerprints have something to digest.
  const u = (await c.query(`insert into public.users (email, first_name, last_name, full_name) values ('rb@t','a','b','a b') returning id`)).rows[0].id;
  const club = (await c.query(`insert into public.clubs (name) values ('RB') returning id`)).rows[0].id;
  const team = (await c.query(`insert into public.teams (club_id, name) values ($1,'T') returning id`, [club])).rows[0].id;
  await c.query(`insert into public.user_club_roles (user_id, club_id, role) values ($1,$2,'club_admin')`, [u, club]);
  await c.query(`insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'team_coach')`, [u, team]);
  await c.query(`insert into public.user_global_roles (user_id, role) values ($1,'platform_admin')`, [u]);
});
after(async () => {
  await c?.end().catch(() => {});
  await db?.drop();
});

// The blocks of a runbook file, by their "-- N." headers.
function blocks(text) {
  const out = {};
  for (const part of text.split(/\n(?=-- \d+a?\. )/)) {
    const m = part.match(/^-- (\d+a?)\. /);
    if (!m) continue;
    const sql = part.split("\n").filter((l) => !l.startsWith("--")).join("\n").trim();
    if (sql) out[m[1]] = sql;
  }
  return out;
}
async function run(sql) {
  await c.query("begin transaction read only");
  try { return (await c.query(sql)).rows[0]; } finally { await c.query("rollback"); }
}
const oks = (row) => Object.entries(row).filter(([, v]) => typeof v === "boolean");
function allTrue(name, row) {
  for (const [k, v] of oks(row)) assert.equal(v, true, `block ${name}: ${k}`);
}
const PRE = blocks(PREFLIGHT);
const POST = blocks(POSTCHECK);
let fingerprintBefore;

test("7a. the preflight before v84: every block's ok columns true, block 3a's fingerprint kept; flips: a row of another word (3), an object of v84 present (2, 6), an idle transaction (7)", async () => {
  assert.deepEqual(Object.keys(PRE).sort(), ["1", "2", "3", "3a", "4", "5", "6", "7"]);
  for (const [name, sql] of Object.entries(PRE)) if (name !== "5") allTrue(name, await run(sql));
  // Block 5 is for the reader; can_create_in_public is still a requirement.
  assert.equal((await run(PRE["5"])).can_create_in_public, true);
  fingerprintBefore = await run(PRE["3a"]);
  // 3: a row of another word.
  await c.query(`set session_replication_role = replica`);
  const planted = (await c.query(`insert into public.user_club_roles (user_id, club_id, role) select user_id, club_id, 'club_manager' from public.user_club_roles limit 1 returning id`)).rows[0].id;
  await c.query(`reset session_replication_role`);
  assert.equal((await run(PRE["3"])).ok, false);
  await c.query(`delete from public.user_club_roles where id = $1`, [planted]);
  // 2 and 6: an object of v84 already there.
  await c.query(`create function public.user_has_permission() returns boolean language sql as 'select true'`);
  assert.equal((await run(PRE["2"])).no_functions, false);
  assert.equal((await run(PRE["6"])).no_twin, false);
  await c.query(`drop function public.user_has_permission()`);
  // 7: an idle transaction.
  const idle = new pg.Client({ connectionString: db.url });
  await idle.connect();
  await idle.query("begin");
  await idle.query("select 1");
  try {
    assert.equal((await run(PRE["7"])).no_idle_tx, false);
  } finally {
    await idle.query("rollback"); await idle.end();
  }
  allTrue("3 again", await run(PRE["3"]));
});

test("7b. the post-check after v84: every block's ok columns true and block 6a equal to preflight block 3a; flips: a tampered v84 checksum (1, and preflight 1b), a later migration (1), a privilege granted to PUBLIC (2), a disabled trigger (3), a changed seed (4), an assignment (5), a dropped CHECK (6)", async () => {
  await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
  assert.deepEqual(Object.keys(POST).sort(), ["1", "2", "3", "4", "5", "6", "6a", "7"]);
  for (const [name, sql] of Object.entries(POST)) allTrue(name, await run(sql));
  assert.deepEqual(await run(POST["6a"]), fingerprintBefore, "v84 rewrote no row of the old role tables");
  // 1: post-check block 1's literal is the file's sha256 (the runner's checksum); a tampered recorded checksum flips it.
  const fileSum = crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS, "202611201000_roles_v84_permission_roles.sql"))).digest("hex");
  assert.ok(POSTCHECK.includes(`checksum = '${fileSum}'`), "post-check block 1 names the file's sha256");
  await c.query(`update public.schema_migrations set checksum = $2 where migration_name = $1`, ["migrations_v2/202611201000_roles_v84_permission_roles.sql", "0".repeat(64)]);
  assert.equal((await run(POST["1"])).checksum_is_the_file, false);
  // 1b of the preflight (generated in the checkout): the same tampered row is a differing recorded checksum.
  const { checksumSql } = await import("../scripts/permission-roles-v84-checksums.mjs");
  assert.equal((await run(checksumSql())).no_recorded_checksum_differs, false);
  await c.query(`update public.schema_migrations set checksum = $2 where migration_name = $1`, ["migrations_v2/202611201000_roles_v84_permission_roles.sql", fileSum]);
  const oneB = await run(checksumSql());
  assert.equal(oneB.no_recorded_checksum_differs, true);
  assert.equal(Number(oneB.recorded_not_in_repo), 0);
  // 1: a later migration.
  await c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912310000_later.sql', $1, 'test')`, ["f".repeat(64)]);
  assert.equal((await run(POST["1"])).is_last, false);
  await c.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/209912310000_later.sql'`);
  // 2: a privilege for PUBLIC.
  await c.query(`grant select on public.permission_roles to public`);
  assert.equal((await run(POST["2"])).tables_not_granted, false);
  await c.query(`revoke select on public.permission_roles from public`);
  // 3: a disabled trigger.
  await c.query(`alter table public.permission_roles disable trigger permission_roles_guard`);
  const disabled = await run(POST["3"]);
  assert.equal(disabled.every_trigger_enabled, false);
  assert.equal(disabled.triggers_as_written, false);
  await c.query(`alter table public.permission_roles enable trigger permission_roles_guard`);
  // 4: a changed seed.
  await c.query(`set session_replication_role = replica`);
  await c.query(`update public.permission_roles set description = 'x' where id = $1`, [ROLE_IDS.team_coach]);
  assert.equal((await run(POST["4"])).seed_fingerprint, false);
  await c.query(`update public.permission_roles set description = null where id = $1`, [ROLE_IDS.team_coach]);
  // 5: an assignment.
  const u = (await c.query(`select user_id from public.user_club_roles limit 1`)).rows[0].user_id;
  const club = (await c.query(`select club_id from public.user_club_roles limit 1`)).rows[0].club_id;
  const roleId = crypto.randomUUID();
  await c.query(`insert into public.permission_roles (id, owner_scope, owner_club_id, name, assignable_club) values ($1, 'club', $2, 'Planted', true)`, [roleId, club]);
  const other = (await c.query(`insert into public.users (email, first_name, last_name, full_name) values ('rb2@t','a','b','a b') returning id`)).rows[0].id;
  await c.query(`insert into public.user_role_assignments (user_id, role_id, scope_type, scope_id, granted_by_user_id, grant_basis, grant_reason) values ($1, $2, 'club', $3, $4, 'club_admin', 'x')`, [other, roleId, club, u]);
  await c.query(`reset session_replication_role`);
  const five = await run(POST["5"]);
  assert.equal(five.no_assignments, false);
  assert.equal(five.only_the_four_roles, false);
  // 6: a dropped CHECK.
  await c.query(`alter table public.user_team_roles drop constraint user_team_roles_role_word`);
  assert.equal((await run(POST["6"])).team_check, false);
  allTrue("7", await run(POST["7"]));
});
