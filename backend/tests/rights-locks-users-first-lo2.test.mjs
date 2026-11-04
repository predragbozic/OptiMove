// LO-2 (migration v54): the database's own rights locks take the users row
// first. Seven function bodies (v23, v26, v49, v34, v35, v38) are replaced; this
// suite runs on a disposable database built WITHOUT v54, so the first part sees
// the bodies in force today:
//   1. the race: a revocation of the same user (users row, then role row, as
//      routes/organization.js locks) against each function called as the first
//      rights lock of a transaction. On today's bodies the deadlock (40P01) is
//      reproduced or recorded as not reproduced; after v54 it never happens.
//   2. v54's md5 gate refuses a database whose body is not the one it replaces.
//   3. the outcome of every function over user x role states is identical before
//      and after (byte for byte: return value, SQLSTATE and message).
//   4. the rollback restores the v53 bodies (md5), its refusals, and re-applying.
//   5. recorded order: in each new body the users row is locked before any role row.
// No GPEXE request, no persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const V54 = "202611041100_training_load_v54_rights_locks_users_first.sql";
const V54_RECORD = `migrations_v2/${V54}`;
const ROLLBACK = path.resolve(here, "../../docs/runbooks/rights-locks-users-first-v54-rollback.sql");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const FUNCTIONS = [
  ["training_load", "lock_gpexe_import_approver"],
  ["training", "lock_activity_decider"],
  ["calendar", "lock_event_writer"],
  ["training_load", "source_metric_require_platform_admin"],
  ["training_load", "source_metric_require_club_admin"],
  ["training_load", "source_metric_actor_basis"],
  ["training_load", "metric_variable_change_basis"],
];

let db, k, clubId, teamId, v54Sql, rollbackSql;
const uid = () => crypto.randomBytes(4).toString("hex");
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];

before(async () => {
  const migrations = GPEXE_TEST_MIGRATIONS.filter((f) => f !== V54);
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "lo2", migrations });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  v54Sql = await fs.readFile(path.resolve(here, "../../migrations_v2", V54), "utf8");
  rollbackSql = await fs.readFile(ROLLBACK, "utf8");
  clubId = (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`Club ${uid()}`])).id;
  teamId = (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
});
after(async () => {
  await k?.end().catch(() => {});
  await db?.drop();
});

const bodiesMd5 = async () => Object.fromEntries((await k.query(
  `select n.nspname || '.' || p.proname as f, md5(p.prosrc) as m from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (${FUNCTIONS.map(([s, f]) => `('${s}','${f}')`).join(",")})`)).rows.map((r) => [r.f, r.m]));
const applyV54 = () => k.query(v54Sql);
// The migrator records a migration after running it; the rollback deletes the record.
const record = () => k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ($1, repeat('0', 64), 0, 'test') on conflict do nothing`, [V54_RECORD]);
const runRollback = async () => { await record(); await k.query(rollbackSql); };

// ---------------------------------------------------------------------------
// fixtures: a user in a state, with one role row in a state
// ---------------------------------------------------------------------------
const ROLE_TABLES = {
  global: { table: "public.user_global_roles", scope: null },
  club: { table: "public.user_club_roles", scope: "club_id" },
  team: { table: "public.user_team_roles", scope: "team_id" },
};
async function makeUser({ userState = "active", role = null, roleState = "active" }) {
  if (userState === "unknown") return crypto.randomUUID();
  const id = (await one(k, `insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,$3) returning id`, [`lo2-${uid()}@test.local`, "lo2", userState === "active"])).id;
  if (role && roleState !== "absent") {
    const t = ROLE_TABLES[role.kind];
    const scopeCol = t.scope ? `, ${t.scope}` : "";
    const scopeVal = role.kind === "club" ? `, '${clubId}'` : role.kind === "team" ? `, '${teamId}'` : "";
    await k.query(`insert into ${t.table} (user_id, role, is_active${scopeCol}) values ($1,$2,$3${scopeVal})`, [id, role.role, roleState === "active"]);
  }
  return id;
}

// Each case: how the function is called, the role it needs, and how the
// revocation locks that role row (the second lock of routes/organization.js).
const CASES = [
  { id: "v23 approver / platform_admin", role: { kind: "global", role: "platform_admin" }, call: (u) => [`select * from training_load.lock_gpexe_import_approver($1,$2)`, [u, teamId]] },
  { id: "v26 decider / platform_admin", role: { kind: "global", role: "platform_admin" }, call: (u) => [`select training.lock_activity_decider($1,$2,'platform_admin')`, [u, teamId]] },
  { id: "v26 decider / club_admin", role: { kind: "club", role: "club_admin" }, call: (u) => [`select training.lock_activity_decider($1,$2,'club_admin')`, [u, teamId]] },
  { id: "v26 decider / team_coach", role: { kind: "team", role: "team_coach" }, call: (u) => [`select training.lock_activity_decider($1,$2,'team_coach')`, [u, teamId]] },
  { id: "v49 event writer / platform_admin", role: { kind: "global", role: "platform_admin" }, call: (u) => [`select calendar.lock_event_writer($1,'club',$2,'platform_admin')`, [u, clubId]] },
  { id: "v49 event writer / club_admin", role: { kind: "club", role: "club_admin" }, call: (u) => [`select calendar.lock_event_writer($1,'club',$2,'club_admin')`, [u, clubId]] },
  { id: "v49 event writer / team_coach", role: { kind: "team", role: "team_coach" }, call: (u) => [`select calendar.lock_event_writer($1,'team',$2,'team_coach')`, [u, teamId]] },
  { id: "v49 event writer / private_coach", role: { kind: "global", role: "independent_coach" }, call: (u) => [`select calendar.lock_event_writer($1,'user',$1,'private_coach')`, [u]] },
  { id: "v34 require platform admin", role: { kind: "global", role: "platform_admin" }, call: (u) => [`select training_load.source_metric_require_platform_admin($1)`, [u]] },
  { id: "v34 require club admin", role: { kind: "club", role: "club_admin" }, call: (u) => [`select training_load.source_metric_require_club_admin($1,$2)`, [u, clubId]] },
  { id: "v35 actor basis / platform_admin", role: { kind: "global", role: "platform_admin" }, call: (u) => [`select training_load.source_metric_actor_basis($1,null)`, [u]] },
  { id: "v35 actor basis / club_admin", role: { kind: "club", role: "club_admin" }, call: (u) => [`select training_load.source_metric_actor_basis($1,$2)`, [u, clubId]] },
  { id: "v38 change basis / platform_admin", role: { kind: "global", role: "platform_admin" }, call: (u) => [`select training_load.metric_variable_change_basis($1,null,null)`, [u]] },
  { id: "v38 change basis / club_admin", role: { kind: "club", role: "club_admin" }, call: (u) => [`select training_load.metric_variable_change_basis($1,$2,null)`, [u, clubId]] },
  { id: "v38 change basis / team_coach", role: { kind: "team", role: "team_coach" }, call: (u) => [`select training_load.metric_variable_change_basis($1,$2,$3)`, [u, clubId, teamId]] },
];
const lockRoleSql = (c) => {
  const t = ROLE_TABLES[c.role.kind];
  return `select 1 from ${t.table} where user_id = $1 and role = '${c.role.role}' for update`;
};

// ---------------------------------------------------------------------------
// the race
// ---------------------------------------------------------------------------
async function client() {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  await c.query("set deadlock_timeout = '300ms'");
  await c.query("set lock_timeout = '8s'");
  return c;
}
const pidOf = async (c) => (await one(c, "select pg_backend_pid() as p")).p;
async function waitBlocked(pid, observer, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await one(observer, `select wait_event_type as w from pg_stat_activity where pid = $1`, [pid]);
    if (r?.w === "Lock") return true;
    await new Promise((res) => setTimeout(res, 25));
  }
  return false;
}
const settle = (promise) => promise.then((rows) => ({ ok: true, rows: rows.rows }), (e) => ({ ok: false, code: e.code, message: e.message }));

// peer holds the users row FOR UPDATE (a revocation or profile write in progress); the real revocation queues on it (FOR UPDATE);
// the function is started; the peer lets go; the revocation then wants the role
// row. Role first, the function holds the role row and waits for users behind
// the revocation: 40P01. Users first, it waits behind the revocation: no cycle.
async function race(c) {
  const userId = await makeUser({ role: c.role });
  const [peer, rev, fn] = [await client(), await client(), await client()];
  const [revPid, fnPid] = [await pidOf(rev), await pidOf(fn)];
  try {
    await peer.query("begin");
    await peer.query("select 1 from public.users where id = $1 for update", [userId]);
    await rev.query("begin");
    const revUser = settle(rev.query("select 1 from public.users where id = $1 for update", [userId]));
    assert.ok(await waitBlocked(revPid, k), "the revocation queues behind the peer");
    await fn.query("begin");
    const [sql, params] = c.call(userId);
    const fnRun = settle(fn.query(sql, params));
    // Role first: the function runs until it waits for users. Users first: it waits at once.
    const blocked = await waitBlocked(fnPid, k);
    if (!blocked) {
      const state = await Promise.race([fnRun, new Promise((res) => setTimeout(() => res("pending"), 100))]);
      assert.fail(`the function waits for the users row (${c.id}): ${JSON.stringify(state)} ${JSON.stringify(await one(k, "select state, wait_event_type, wait_event from pg_stat_activity where pid = $1", [fnPid]))}`);
    }
    await peer.query("commit");
    assert.equal((await revUser).ok, true, "the revocation gets the users row");
    const revRole = settle(rev.query(lockRoleSql(c), [userId]));
    // Whoever settles first ends its transaction (a victim rolls back; a revocation that got
    // its role row commits), which lets the other one finish.
    const tag = (promise, name) => promise.then((r) => ({ name, r }));
    const first = await Promise.race([tag(revRole, "rev"), tag(fnRun, "fn")]);
    await (first.name === "rev" ? rev : fn).query(first.r.ok ? "commit" : "rollback").catch(() => {});
    const [roleResult, fnResult] = await Promise.all([revRole, fnRun]);
    const codes = [roleResult.code, fnResult.code].filter(Boolean);
    return { deadlock: codes.includes("40P01"), roleResult, fnResult };
  } finally {
    for (const x of [peer, rev, fn]) { await x.query("rollback").catch(() => {}); await x.end().catch(() => {}); }
  }
}
const raceAll = async () => { const out = {}; for (const c of CASES) out[c.id] = await race(c); return out; }; // eslint-disable-line no-await-in-loop

let before54;
test("1. today's bodies: the deadlock is reproduced or recorded as not reproduced, per function", async () => {
  before54 = await raceAll();
  const rows = Object.entries(before54).map(([id, r]) => `${r.deadlock ? "40P01 reproduced   " : "not reproduced    "}${id}`);
  console.log(`LO-2 race on the v53 bodies:\n  ${rows.join("\n  ")}`);
  // Every first-rights-lock function (v23, v26, v49) locks the role row first today; its race must show the cycle.
  for (const id of Object.keys(before54).filter((i) => /^v(23|26|49)/.test(i))) assert.equal(before54[id].deadlock, true, `${id}: 40P01 on the body in force`);
});

let md5V53;
test("2. v54's md5 gate refuses a body that is not the one it replaces, and changes nothing", async () => {
  md5V53 = await bodiesMd5();
  await k.query("begin");
  await k.query(`create or replace function training_load.source_metric_actor_basis(p_actor uuid, p_owner_club uuid) returns text as $$ begin return null; end; $$ language plpgsql`);
  await assert.rejects(k.query("savepoint s").then(() => k.query(v54Sql)), (e) => e.code === "23514" && /v54 refused: the body in force of training_load\.source_metric_actor_basis/.test(e.message));
  await k.query("rollback");
  assert.deepEqual(await bodiesMd5(), md5V53, "the refusal and the rollback leave the v53 bodies");
});

// ---------------------------------------------------------------------------
// the outcome of every function over user x role states
// ---------------------------------------------------------------------------
async function outcomes() {
  const out = {};
  for (const c of CASES) {
    for (const userState of ["active", "inactive", "unknown"]) {
      for (const roleState of ["active", "inactive", "absent"]) {
        const userId = await makeUser({ userState, role: c.role, roleState });
        const [sql, params] = c.call(userId);
        await k.query("begin");
        let result;
        try {
          const rows = (await k.query(sql, params)).rows;
          result = { rows: JSON.stringify(rows).replaceAll(userId, "<user>") };
        } catch (e) {
          result = { code: e.code, message: String(e.message).replaceAll(userId, "<user>") };
        }
        await k.query("rollback");
        out[`${c.id} | user ${userState} | role ${roleState}`] = result;
      }
    }
  }
  return out;
}
let outcomesV53;
test("3. v54 applies; the bodies are the new ones; the outcome of every function over user x role states is identical to v53's", async () => {
  outcomesV53 = await outcomes();
  assert.equal(Object.keys(outcomesV53).length, CASES.length * 9);
  await applyV54();
  await record();
  const now = await bodiesMd5();
  for (const [f, m] of Object.entries(now)) assert.notEqual(m, md5V53[f], `${f} was replaced`);
  const outcomesV54 = await outcomes();
  assert.deepEqual(outcomesV54, outcomesV53, "byte-identical outcomes (return value, SQLSTATE, message)");
  // The matrix is not trivial: it holds returns and refusals both.
  const kinds = new Set(Object.values(outcomesV53).map((r) => (r.code ? `error ${r.code}` : "return")));
  assert.ok(kinds.has("return") && [...kinds].some((x) => x.startsWith("error")), [...kinds].join(", "));
});

test("4. after v54 the deadlock does not happen: every function waits behind the revocation and completes", async () => {
  const after54 = await raceAll();
  for (const [id, r] of Object.entries(after54)) {
    assert.equal(r.deadlock, false, `${id}: no 40P01 after v54 (${JSON.stringify([r.roleResult.code, r.fnResult.code])})`);
    assert.equal(r.roleResult.ok, true, `${id}: the revocation takes the role row`);
    assert.equal(r.fnResult.ok, true, `${id}: the function completes after the revocation commits its lock`);
  }
});

// ---------------------------------------------------------------------------
// recorded order: the users row before any role row, in every new body
// ---------------------------------------------------------------------------
test("5. recorded order: in each new body the users row is locked before any role row", async () => {
  const rows = (await k.query(`select n.nspname || '.' || p.proname as f, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where (n.nspname, p.proname) in (${FUNCTIONS.map(([sc, f]) => `('${sc}','${f}')`).join(",")})`)).rows;
  assert.equal(rows.length, FUNCTIONS.length);
  for (const { f, src } of rows) {
    const users = src.search(/from public\.users u where u\.id = p_\w+ and u\.is_active = true for share/);
    const roles = src.search(/public\.user_(global|club|team)_roles/);
    assert.ok(users >= 0 && roles >= 0 && users < roles, `${f}: users (${users}) before the role rows (${roles})`);
    assert.ok(!/for share of [a-z, ]*\bu\b/.test(src), `${f}: no later clause locks the users row again`);
  }
});

// ---------------------------------------------------------------------------
// rollback and re-apply
// ---------------------------------------------------------------------------
test("6. the rollback restores the v53 bodies exactly, refuses what it must, and v54 applies again", async () => {
  // refusal: a later migration is recorded
  await k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ('migrations_v2/202699999999_later.sql', repeat('0', 64), 0, 'test')`);
  await assert.rejects(k.query(rollbackSql), (e) => /later migrations are applied/.test(e.message));
  await k.query("rollback").catch(() => {});
  await k.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/202699999999_later.sql'`);
  // refusal: a body is not v54's
  const keep = await bodiesMd5();
  await k.query("begin");
  await k.query(`create or replace function training_load.source_metric_require_platform_admin(p_user uuid) returns void as $$ begin null; end; $$ language plpgsql`);
  await assert.rejects(k.query(rollbackSql), (e) => /is not v54's/.test(e.message));
  await k.query("rollback");
  assert.deepEqual(await bodiesMd5(), keep);
  // refusal: v54 not recorded
  await k.query(`delete from public.schema_migrations where migration_name = $1`, [V54_RECORD]);
  await assert.rejects(k.query(rollbackSql), (e) => /v54 is not recorded/.test(e.message));
  await k.query("rollback").catch(() => {});
  await record();
  // the rollback
  await k.query(rollbackSql);
  assert.deepEqual(await bodiesMd5(), md5V53, "the v53 bodies, byte for byte");
  assert.equal((await k.query(`select 1 from public.schema_migrations where migration_name = $1`, [V54_RECORD])).rowCount, 0, "the record is gone");
  // and v54 applies again
  await applyV54();
  await record();
  assert.deepEqual(Object.keys(await bodiesMd5()).sort(), Object.keys(md5V53).sort());
  for (const [f, m] of Object.entries(await bodiesMd5())) assert.notEqual(m, md5V53[f]);
  // the preflight and post-check files are read-only SELECTs
  for (const name of ["preflight", "postcheck"]) {
    const text = await fs.readFile(path.resolve(here, `../../docs/runbooks/rights-locks-users-first-v54-${name}.sql`), "utf8");
    assert.ok(!/\b(insert|update|delete|drop|alter|create|truncate)\b\s/i.test(text.replace(/--.*$/gm, "")), `${name} changes nothing`);
  }
});

test("7. the post-check passes on the migrated database", async () => {
  const text = await fs.readFile(path.resolve(here, "../../docs/runbooks/rights-locks-users-first-v54-postcheck.sql"), "utf8");
  const blocks = text.split(/^-- \d\. /m).slice(1);
  assert.equal(blocks.length, 4);
  for (const [i, block] of blocks.entries()) {
    const sql = block.split("\n").slice(1).join("\n").trim().replace(/;\s*$/, "");
    const rows = (await k.query(sql)).rows;
    assert.ok(rows.length >= 1, `block ${i + 1} returns rows`);
    for (const row of rows) for (const [col, v] of Object.entries(row)) if (typeof v === "boolean") assert.equal(v, true, `block ${i + 1}: ${col} in ${JSON.stringify(row)}`);
  }
});
