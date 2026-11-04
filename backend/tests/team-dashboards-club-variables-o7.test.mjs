// O7 (migration v55): a team's dashboards may chart the variables of the team's own club (J15 section 12;
// the Rukovodilac's plan GO of 2026-11-04). One function body is replaced,
// training_load.dashboard_widget_series_validate_metric_visibility (v16); the application's twin
// isMetricVisibleToDashboard() and the picker's listDefinitions() follow it.
// The suite runs on a disposable database built WITHOUT v55, so the first part sees v16's rule:
//   1. the matrix of dashboard data workspace x definition owner on v16's body;
//   2. v55's md5 gate;
//   3. the same matrix after v55: every old cell unchanged, the one new cell (team dashboard x own club's club
//      variable) allowed, another club's variable, an archived team and an archived club refused with the same
//      exception as every other invisible definition;
//   4. the lock order (definition, then team, then club), recorded with two real sessions;
//   5. the application twin and the picker over the real routes (team workspace sees its club's variables, never
//      another club's; a hidden OptiMove variable stays flagged; an archived club variable is not offered; a series
//      already there stays valid after its variable is archived);
//   6. the rollback, its refusals, the preflight and the post-check.
// No GPEXE request, no persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const V55 = "202611041300_training_load_v55_team_dashboards_club_variables.sql";
const V55_RECORD = `migrations_v2/${V55}`;
const FN = "dashboard_widget_series_validate_metric_visibility";
const ROLLBACK = path.resolve(here, "../../docs/runbooks/team-dashboards-club-variables-v55-rollback.sql");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const METRICS = "/api/training-load/sources/metrics";
const CATALOG = "/api/training-load/metrics";

let db, k, server, apiBase, v55Sql, rollbackSql, createSession, appPool, dbModule, access;
const F = {};
const uid = () => crypto.randomBytes(4).toString("hex");
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const originalConsole = {};

before(async () => {
  const migrations = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V55));
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "o7", migrations });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  v55Sql = await fs.readFile(path.resolve(here, "../../migrations_v2", V55), "utf8");
  rollbackSql = await fs.readFile(ROLLBACK, "utf8");
  await k.query(`alter table public.user_club_roles add column if not exists granted_by_user_id uuid,
                   add column if not exists revoked_at timestamptz, add column if not exists revoked_by_user_id uuid,
                   add column if not exists created_at timestamptz not null default now()`);
  await k.query(`alter table public.user_global_roles add column if not exists granted_by_user_id uuid,
                   add column if not exists revoked_at timestamptz, add column if not exists revoked_by_user_id uuid,
                   add column if not exists created_at timestamptz not null default now(),
                   add column if not exists updated_at timestamptz not null default now()`);
  await k.query(`alter table public.user_team_roles add column if not exists granted_by_user_id uuid,
                   add column if not exists revoked_at timestamptz, add column if not exists revoked_by_user_id uuid,
                   add column if not exists created_at timestamptz not null default now(),
                   add column if not exists updated_at timestamptz not null default now()`);
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = () => {};
  }
  const serverModule = await import("../src/server.js");
  dbModule = await import("../src/db.js");
  ({ createSession } = await import("../src/auth.js"));
  access = await import("../src/trainingLoadDashboardAccess.js");
  appPool = dbModule.pool;
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await fixtures();
});

after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) {
    let timer;
    await Promise.race([appPool.end(), new Promise((res) => { timer = setTimeout(res, 5_000); })]);
    clearTimeout(timer);
  }
  await k?.end().catch(() => {});
  await db?.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function api(p, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
async function user(label) {
  return (await one(k, `insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,true) returning id`, [`${label}-${uid()}@test.local`, label])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
const club = async () => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`Club ${uid()}`])).id;
const team = async (clubId) => (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;

async function platformAdmin() {
  const id = await user("platform-admin");
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await workspace(id, "platform", null);
  return { id, cookie: await cookieFor(id) };
}
async function clubAdmin(clubId) {
  const id = await user("club-admin");
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await workspace(id, "club", clubId);
  return { id, cookie: await cookieFor(id) };
}
async function teamCoach(teamId) {
  const id = await user("coach");
  await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await workspace(id, "team", teamId);
  return { id, cookie: await cookieFor(id) };
}
async function variable(owner, label) {
  const res = await api(`${METRICS}/variables`, { method: "POST", cookie: owner.cookie, body: { requestKey: crypto.randomUUID(), label, unit: "s", levels: ["session", "drill"], dailyAggregationMethod: "sum" } });
  assert.equal(res.status, 201, res.text);
  return res.body.variable.id;
}

async function fixtures() {
  F.pa = await platformAdmin();
  F.clubA = await club(); F.clubB = await club();
  F.teamA = await team(F.clubA); F.teamA2 = await team(F.clubA); F.teamB = await team(F.clubB);
  F.adminA = await clubAdmin(F.clubA); F.adminB = await clubAdmin(F.clubB);
  F.coachA = await teamCoach(F.teamA);
  F.coachB = await teamCoach(F.teamB);
  F.sysVar = await variable(F.pa, `O7 system ${uid()}`);
  F.varA = await variable(F.adminA, `O7 club A ${uid()}`);
  F.varB = await variable(F.adminB, `O7 club B ${uid()}`);
  F.varA2 = await variable(F.adminA, `O7 club A second ${uid()}`);
  F.widgetType = (await one(k, `select key from training_load.dashboard_widget_types limit 1`)).key;
  // The series table's other validators are not under test: only the visibility rule is left on.
  const triggers = (await k.query(
    `select tgname from pg_trigger where tgrelid = 'training_load.dashboard_widget_series'::regclass and not tgisinternal and tgname <> $1`, ["dashboard_widget_series_validate_metric_visibility"])).rows.map((r) => r.tgname);
  for (const t of triggers) await k.query(`alter table training_load.dashboard_widget_series disable trigger "${t}"`);
}

let dashSeq = 0;
async function dashboard(kind, scopeId, ownerUser = F.pa.id) {
  // kind: club | team | user (the owner of a user dashboard bound to a club data workspace)
  const base = { club: ["club", "club", scopeId, null, null], team: ["team", "team", null, scopeId, null], user: ["user", "club", null, null, ownerUser], userTeam: ["user", "team", null, null, ownerUser] }[kind];
  const [ownerScope, dwType, ownerClub, ownerTeam, ownerUserId] = base;
  const dwScope = scopeId;
  dashSeq += 1;
  const d = await one(k, `insert into training_load.dashboards (name, owner_scope, owner_user_id, owner_club_id, owner_team_id, data_workspace_type, data_workspace_scope_id, created_by_user_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [`O7 dash ${dashSeq}`, ownerScope, ownerUserId, ownerClub, ownerTeam, dwType, dwScope, F.pa.id]);
  const w = await one(k, `insert into training_load.dashboard_widgets (dashboard_id, widget_type, title, widget_order, x, y, width, height, mobile_order)
        values ($1,$2,'w',1,0,0,3,2,1) returning id`, [d.id, F.widgetType]);
  return { dashboardId: d.id, widgetId: w.id };
}
let order = 0;
// Insert one series of `defId` on the widget; returns { ok } or { code, message }.
async function addSeries(widgetId, defId, { inTx = false } = {}) {
  order += 1;
  const client = k;
  if (inTx) await client.query("savepoint s");
  try {
    await client.query(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, resolution_status) values ($1,$2,$3,'resolved')`, [widgetId, order, defId]);
    if (inTx) await client.query("release savepoint s");
    return { ok: true };
  } catch (e) {
    if (inTx) await client.query("rollback to savepoint s");
    return { ok: false, code: e.code, message: String(e.message).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>") };
  }
}
const bodyMd5 = async () => (await one(k, `select md5(p.prosrc) as m from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = $1`, [FN])).m;

// The matrix: dashboards by data workspace x definitions by owner.
async function matrix() {
  const out = {};
  await k.query("begin");
  try {
  const dash = {
    "club A dashboard": await dashboard("club", F.clubA),
    "club B dashboard": await dashboard("club", F.clubB),
    "team A dashboard": await dashboard("team", F.teamA),
    "team B dashboard": await dashboard("team", F.teamB),
    "private dashboard in club A": await dashboard("user", F.clubA, F.pa.id),
    "private dashboard in team A": await dashboard("userTeam", F.teamA, F.pa.id),
  };
  const teamDef = (await one(k, `select id from training_load.metric_definitions where id = $1`, [F.varA])).id;
  const defs = { "system": F.sysVar, "club A": F.varA, "club B": F.varB };
  for (const [dl, d] of Object.entries(dash)) {
    for (const [fl, defId] of Object.entries(defs)) out[`${dl} x ${fl} variable`] = await addSeries(d.widgetId, defId, { inTx: true });
  }
  void teamDef;
  } finally {
    await k.query("rollback");
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1-3. the rule before and after
// ---------------------------------------------------------------------------
let before55, md5V16;
test("1. on v16's body: a club variable is visible to a club dashboard of its club only; a team dashboard never sees one", async () => {
  md5V16 = await bodyMd5();
  before55 = await matrix();
  assert.equal(before55["club A dashboard x club A variable"].ok, true);
  assert.equal(before55["club A dashboard x club B variable"].ok, false);
  assert.equal(before55["team A dashboard x club A variable"].ok, false, "the gap O7 closes");
  assert.equal(before55["team A dashboard x system variable"].ok, true);
  assert.equal(before55["team B dashboard x club B variable"].ok, false);
  for (const cell of Object.values(before55)) if (!cell.ok) assert.equal(cell.code, "P0001");
});

test("2. v55's md5 gate refuses a body that is not v16's, and changes nothing", async () => {
  await k.query("begin");
  await k.query(`create or replace function training_load.${FN}() returns trigger as $$ begin return new; end; $$ language plpgsql`);
  await assert.rejects(k.query(v55Sql), (e) => e.code === "23514" && /v55 refused: the body in force of training_load\.dashboard_widget_series_validate_metric_visibility is not v16's/.test(e.message));
  await k.query("rollback");
  assert.equal(await bodyMd5(), md5V16);
});

let after55, md5V55;
test("3. after v55: every old cell is unchanged; the one new cell is allowed; the refusals keep the same exception", async () => {
  await k.query(v55Sql);
  await k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ($1, repeat('0', 64), 0, 'test') on conflict do nothing`, [V55_RECORD]);
  md5V55 = await bodyMd5();
  assert.notEqual(md5V55, md5V16);
  after55 = await matrix();
  for (const [cell, was] of Object.entries(before55)) {
    if (cell === "team A dashboard x club A variable" || cell === "team B dashboard x club B variable" || cell === "private dashboard in team A x club A variable") continue;
    assert.deepEqual(after55[cell], was, `${cell}: unchanged`);
  }
  assert.equal(after55["team A dashboard x club A variable"].ok, true, "a team's dashboard charts its own club's variable");
  assert.equal(before55["private dashboard in team A x club A variable"].ok, false);
  assert.equal(after55["private dashboard in team A x club A variable"].ok, true, "a coach's private dashboard in the team workspace too");
  assert.equal(after55["private dashboard in team A x club B variable"].ok, false, "...but not another club's variable");
  assert.equal(after55["private dashboard in team A x club B variable"].code, "P0001");
  assert.equal(after55["team B dashboard x club A variable"].ok, false, "another club's variable");
  assert.deepEqual(after55["team B dashboard x club B variable"].ok, true);
  assert.deepEqual(after55["team A dashboard x club B variable"], before55["team A dashboard x club B variable"], "another club's variable: the very same exception");
});

test("3b. an archived team or an archived club is refused with the same exception as another club's variable", async () => {
  const foreign = after55["team A dashboard x club B variable"];
  assert.equal(foreign.ok, false);
  const d = await dashboard("team", F.teamA2);
  for (const [label, off, on] of [
    ["archived team", `update public.teams set is_active = false where id = '${F.teamA2}'`, `update public.teams set is_active = true where id = '${F.teamA2}'`],
    ["archived club", `update public.clubs set is_active = false where id = '${F.clubA}'`, `update public.clubs set is_active = true where id = '${F.clubA}'`],
  ]) {
    assert.equal((await addSeries(d.widgetId, F.varA)).ok, true, `${label}: visible before`);
    await k.query(`delete from training_load.dashboard_widget_series where widget_id = $1`, [d.widgetId]);
    await k.query(off);
    try {
      const r = await addSeries(d.widgetId, F.varA);
      assert.equal(r.ok, false, label);
      assert.equal(r.code, foreign.code, `${label}: same errcode`);
      assert.equal(r.message.replace(/club=<id>|\(owner_scope=club\/<id>\/[^)]*\)/g, "#"), foreign.message.replace(/\(owner_scope=club\/<id>\/[^)]*\)/g, "#").replace(/club=<id>/g, "#"), `${label}: same message form`);
    } finally {
      await k.query(on);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. the lock order: definition, then team, then club
// ---------------------------------------------------------------------------
async function client() {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  await c.query("set lock_timeout = '20s'");
  return c;
}
async function waitBlocked(pid, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await one(k, `select wait_event_type as w from pg_stat_activity where pid = $1`, [pid]);
    if (r?.w === "Lock") return true;
    await new Promise((res) => setTimeout(res, 25));
  }
  return false;
}
test("4. recorded lock order: the series insert holds the definition and the team before it waits for the club", async () => {
  const d = await dashboard("team", F.teamA);
  const holder = await client(), writer = await client(), probeDef = await client(), probeTeam = await client();
  try {
    // A peer holds the club row: the writer must stop at the club, the LAST lock it takes.
    await holder.query("begin");
    await holder.query("select 1 from public.clubs where id = $1 for update", [F.clubA]);
    await writer.query("begin");
    const wPid = (await one(writer, "select pg_backend_pid() as p")).p;
    order += 1;
    const insert = writer.query(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, resolution_status) values ($1,$2,$3,'resolved')`, [d.widgetId, order, F.varA]).then(() => "done", (e) => e.code);
    assert.ok(await waitBlocked(wPid), "the insert waits for the club");
    // It holds the definition and the team (FOR SHARE): an exclusive lock on either must queue behind it.
    for (const [probe, label, sql, params] of [
      [probeDef, "definition", "select 1 from training_load.metric_definitions where id = $1 for update", [F.varA]],
      [probeTeam, "team", "select 1 from public.teams where id = $1 for update", [F.teamA]],
    ]) {
      await probe.query("begin");
      const pPid = (await one(probe, "select pg_backend_pid() as p")).p;
      const waiting = probe.query(sql, params).then(() => "got", (e) => e.code);
      const blocked = await waitBlocked(pPid);
      assert.ok(blocked, `${label} is held by the insert before the club`);
      await k.query("select pg_cancel_backend($1)", [pPid]);
      assert.equal(await waiting, "57014", `${label}: the probe was waiting (cancelled)`);
      await probe.query("rollback").catch(() => {});
    }
    await holder.query("commit");
    assert.equal(await insert, "done", "released club: the insert completes");
    await writer.query("rollback");
  } finally {
    for (const x of [holder, writer, probeDef, probeTeam]) { await x.query("rollback").catch(() => {}); await x.end().catch(() => {}); }
    await k.query(`delete from training_load.dashboard_widget_series where widget_id = $1`, [d.widgetId]);
  }
});

test("4b. recorded order in the body: the definition, then the team, then the club", async () => {
  const src = (await one(k, `select p.prosrc as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = $1`, [FN])).s;
  const def = src.indexOf("from training_load.metric_definitions where id = new.metric_definition_id for share");
  const team = src.indexOf("from public.teams t where t.id = v_data_scope");
  const clubPos = src.indexOf("from public.clubs c where c.id = v_def_club");
  assert.ok(def > 0 && team > def && clubPos > team, `order ${def} < ${team} < ${clubPos}`);
});

// ---------------------------------------------------------------------------
// 5. the application twin and the picker
// ---------------------------------------------------------------------------
test("5a. isMetricVisibleToDashboard: the same rule; another club, an archived team, an archived club and a missing variable are not visible", async () => {
  const rowOf = async (teamId) => ({ owner_scope: "team", owner_team_id: teamId, owner_user_id: null, owner_club_id: null, data_workspace_type: "team", data_workspace_scope_id: teamId });
  const own = await access.isMetricVisibleToDashboard(await rowOf(F.teamA), F.varA);
  assert.equal(own.visible, true);
  assert.equal((await access.isMetricVisibleToDashboard(await rowOf(F.teamA), F.varB)).visible, false);
  assert.equal((await access.isMetricVisibleToDashboard(await rowOf(F.teamA), F.sysVar)).visible, true);
  const missing = await access.isMetricVisibleToDashboard(await rowOf(F.teamA), crypto.randomUUID());
  assert.deepEqual([missing.visible, missing.def], [false, null]);
  try {
    await k.query(`update public.teams set is_active = false where id = $1`, [F.teamA2]);
    assert.equal((await access.isMetricVisibleToDashboard(await rowOf(F.teamA2), F.varA)).visible, false, "archived team");
  } finally {
    await k.query(`update public.teams set is_active = true where id = $1`, [F.teamA2]);
  }
  try {
    await k.query(`update public.clubs set is_active = false where id = $1`, [F.clubA]);
    assert.equal((await access.isMetricVisibleToDashboard(await rowOf(F.teamA), F.varA)).visible, false, "archived club");
  } finally {
    await k.query(`update public.clubs set is_active = true where id = $1`, [F.clubA]);
  }
});

test("5b. the picker: a team's workspace is offered its club's variables, never another club's; other workspaces are unchanged", async () => {
  const names = async (cookie, q = "&purpose=dashboardSeries") => (await api(`${CATALOG}/definitions?limit=100${q}`, { cookie })).body.rows.map((r) => r.id);
  // Opt-in: no purpose, no change (the calendar's result columns and every other caller keep what they had).
  assert.ok(!(await names(F.coachA.cookie, "")).includes(F.varA), "without purpose=dashboardSeries the list is unchanged");
  assert.equal((await api(`${CATALOG}/definitions?limit=100&purpose=other`, { cookie: F.coachA.cookie })).status, 400);
  const coachA = await names(F.coachA.cookie);
  assert.ok(coachA.includes(F.varA) && coachA.includes(F.varA2), "own club's variables");
  assert.ok(!coachA.includes(F.varB), "another club's variable");
  assert.ok(coachA.includes(F.sysVar), "OptiMove's variable");
  const coachB = await names(F.coachB.cookie);
  assert.ok(coachB.includes(F.varB) && !coachB.includes(F.varA));
  const owned = (await api(`${CATALOG}/definitions?limit=100&purpose=dashboardSeries&ownerScope=club`, { cookie: F.coachA.cookie })).body.rows;
  assert.ok(owned.every((r) => r.ownerScope === "club") && owned.some((r) => r.id === F.varA));
  // The club admin and the platform admin see what they saw before.
  assert.ok((await names(F.adminA.cookie)).includes(F.varA));
  assert.ok(!(await names(F.adminA.cookie)).includes(F.varB));
  // A coach whose active workspace is NOT the team (a private coach with no team) gets no club variable.
  const loner = await user("loner");
  await workspace(loner, "private_coach", null);
  assert.ok(!(await names(await cookieFor(loner))).includes(F.varA));
  // The club comes from the ACTIVE workspace, never from the caller's roles: a coach of a team in club A and a team
  // in club B sees one club's variables - the active workspace's.
  const both = await user("both");
  for (const t of [F.teamA, F.teamB]) await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [both, t]);
  await workspace(both, "team", F.teamA);
  const asA = await names(await cookieFor(both));
  assert.ok(asA.includes(F.varA) && !asA.includes(F.varB), "active workspace team A: club A only");
  await workspace(both, "team", F.teamB);
  const asB = await names(await cookieFor(both));
  assert.ok(asB.includes(F.varB) && !asB.includes(F.varA), "active workspace team B: club B only");
  // An archived club's variables are not offered (the write is refused for it as well).
  await k.query(`update public.clubs set is_active = false where id = $1`, [F.clubA]);
  try {
    assert.ok(!(await names(F.coachA.cookie)).includes(F.varA), "archived club: not offered");
  } finally {
    await k.query(`update public.clubs set is_active = true where id = $1`, [F.clubA]);
  }
});

test("5c. a variable the club archives is not offered; a hidden OptiMove variable stays flagged; a series already there stays valid", async () => {
  const d = await dashboard("team", F.teamA);
  assert.equal((await addSeries(d.widgetId, F.varA2)).ok, true);
  const seriesId = (await one(k, `select id from training_load.dashboard_widget_series where widget_id = $1`, [d.widgetId])).id;
  const archive = await api(`${METRICS}/variables/${F.varA2}/archive`, { method: "POST", cookie: F.adminA.cookie, body: { requestKey: crypto.randomUUID(), reason: "O7 test" } });
  assert.ok([200, 201].includes(archive.status), archive.text);
  const offered = (await api(`${CATALOG}/definitions?limit=100`, { cookie: F.coachA.cookie })).body.rows.map((r) => r.id);
  assert.ok(!offered.includes(F.varA2), "archived: not offered");
  const stays = await k.query(`update training_load.dashboard_widget_series set analytical_aggregation = 'avg' where id = $1`, [seriesId]);
  assert.equal(stays.rowCount, 1, "the series is still valid and editable");
  // The limit, stated: an UPDATE that NAMES metric_definition_id fires the rule again (as resolve_series_binding does),
  // against the CURRENT team and club - so once the club is archived such a re-bind is refused.
  await k.query(`update public.clubs set is_active = false where id = $1`, [F.clubA]);
  try {
    await k.query("begin");
    await assert.rejects(k.query(`update training_load.dashboard_widget_series set metric_definition_id = metric_definition_id where id = $1`, [seriesId]), (e) => e.code === "P0001");
    await k.query("rollback");
  } finally {
    await k.query(`update public.clubs set is_active = true where id = $1`, [F.clubA]);
  }
  // A club hides OptiMove's variable: the rows still list it, flagged for the picker.
  const hide = await api(`${METRICS}/variables/${F.sysVar}/hide`, { method: "POST", cookie: F.adminA.cookie, body: { requestKey: crypto.randomUUID() } });
  assert.ok([200, 201].includes(hide.status), hide.text);
  const row = (await api(`${CATALOG}/definitions?limit=100`, { cookie: F.coachA.cookie })).body.rows.find((r) => r.id === F.sysVar);
  assert.equal(row?.hiddenInClub, true);
  assert.equal((await addSeries((await dashboard("team", F.teamA)).widgetId, F.sysVar)).ok, true, "hiding is not an access boundary: a series already possible stays possible");
});

// ---------------------------------------------------------------------------
// 6. rollback, preflight, post-check
// ---------------------------------------------------------------------------
async function blocks(file) {
  const text = await fs.readFile(path.resolve(here, `../../docs/runbooks/${file}`), "utf8");
  const parts = text.split(/^-- \d\. /m).slice(1);
  const out = [];
  for (const block of parts) {
    const sql = block.split("\n").slice(1).join("\n").trim().replace(/;\s*$/, "");
    out.push((await k.query(sql)).rows);
  }
  return out;
}
const allTrue = (rows, label) => { for (const row of rows) for (const [col, v] of Object.entries(row)) if (typeof v === "boolean" || /^(ok|recorded_once|is_last|no_idle_tx|no_lock_wait|v55_absent)$/.test(col)) assert.equal(v, true, `${label}: ${col} in ${JSON.stringify(row)}`); };

test("6a. the post-check passes on the migrated database", async () => {
  const b = await blocks("team-dashboards-club-variables-v55-postcheck.sql");
  assert.equal(b.length, 4);
  b.forEach((rows, i) => { assert.ok(rows.length >= 1); allTrue(rows, `post-check block ${i + 1}`); });
});

test("6b. the rollback refuses while a team dashboard uses a club variable, then restores v16's body exactly, and v55 applies again", async () => {
  // A series of a club variable on a team dashboard (its own, not left over from another test): refused.
  const own = await dashboard("team", F.teamA);
  assert.equal((await addSeries(own.widgetId, F.varA)).ok, true);
  await assert.rejects(k.query(rollbackSql), (e) => /a team dashboard series already uses a club variable/.test(e.message));
  await k.query("rollback").catch(() => {});
  await k.query(`delete from training_load.dashboard_widget_series s using training_load.dashboard_widgets w, training_load.dashboards d, training_load.metric_definitions md
                  where w.id = s.widget_id and d.id = w.dashboard_id and md.id = s.metric_definition_id and d.data_workspace_type = 'team' and md.owner_scope = 'club'`);
  // The rollback holds the series table while it decides: a writer that is mid-insert makes it wait (and, with its 5 s
  // lock timeout, fail) instead of racing the check - the lock is the script's, not a hope.
  const writer = await client();
  try {
    await writer.query("begin");
    const w2 = await dashboard("team", F.teamA2);
    await writer.query(`insert into training_load.dashboard_widget_series (widget_id, series_order, metric_definition_id, resolution_status) values ($1, 1, $2, 'resolved')`, [w2.widgetId, F.sysVar]);
    await assert.rejects(k.query(rollbackSql), (e) => e.code === "55P03");
    await k.query("rollback").catch(() => {});
  } finally {
    await writer.query("rollback").catch(() => {});
    await writer.end().catch(() => {});
  }
  assert.match(rollbackSql, /lock table training_load\.dashboard_widget_series in share row exclusive mode;[\s\S]*raise exception 'v55 rollback refused: a team dashboard series already uses a club variable'/, "locked before the check");
  // other refusals
  await k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ('migrations_v2/202699999999_later.sql', repeat('0', 64), 0, 'test')`);
  await assert.rejects(k.query(rollbackSql), (e) => /later migrations are applied/.test(e.message));
  await k.query("rollback").catch(() => {});
  await k.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/202699999999_later.sql'`);
  await k.query("begin");
  await k.query(`create or replace function training_load.${FN}() returns trigger as $$ begin return new; end; $$ language plpgsql`);
  await assert.rejects(k.query(rollbackSql), (e) => /is not v55's/.test(e.message));
  await k.query("rollback");
  assert.equal(await bodyMd5(), md5V55);
  const holder = await client();
  await holder.query("select pg_advisory_lock(822026)");
  await assert.rejects(k.query(rollbackSql), (e) => /the migrator is running/.test(e.message));
  await k.query("rollback").catch(() => {});
  await holder.query("select pg_advisory_unlock(822026)");
  await holder.end();
  await k.query(`delete from public.schema_migrations where migration_name = $1`, [V55_RECORD]);
  await assert.rejects(k.query(rollbackSql), (e) => /v55 is not recorded/.test(e.message));
  await k.query("rollback").catch(() => {});
  await k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ($1, repeat('0', 64), 0, 'test')`, [V55_RECORD]);
  // the rollback itself
  await k.query(rollbackSql);
  assert.equal(await bodyMd5(), md5V16, "v16's body, byte for byte");
  assert.equal((await k.query(`select 1 from public.schema_migrations where migration_name = $1`, [V55_RECORD])).rowCount, 0);
  const again = await matrix();
  assert.deepEqual(again, before55, "the rule is v16's again, cell for cell");
  // the preflight reads as expected on the v16 database
  const pre = await blocks("team-dashboards-club-variables-v55-preflight.sql");
  assert.equal(pre.length, 4);
  pre.forEach((rows, i) => { assert.ok(rows.length >= 1); allTrue(rows, `preflight block ${i + 1}`); });
  // and v55 applies again
  await k.query(v55Sql);
  await k.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ($1, repeat('0', 64), 0, 'test') on conflict do nothing`, [V55_RECORD]);
  assert.equal(await bodyMd5(), md5V55);
});
