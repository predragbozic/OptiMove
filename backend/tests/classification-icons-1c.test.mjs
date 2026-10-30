// PR-1c (V4) - the icons of canonical domains and categories
// (backend/src/canonicalClassificationService.js changeNodeIcon, the routes
// POST /api/training-load/sources/metrics/classification/{domains|categories}/:id/icon,
// an optional iconKey on a create, the icon in every read of a node and of a
// variable's classification) and migration v46 (the icon columns, the icon in
// v41's change record, the kind 'icon', the operations domain_icon and
// category_icon). Through the real HTTP stack, on disposable
// optimove_tests_gpexe_* databases only (never OPTIMOVE): one migrated through
// the migration before v46 (PR-1b's v45) that rehearses v46's preflight /
// apply / post-check / rollback / re-apply, one migrated through v46 for the
// behaviour. Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md,
// section J6.1.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import pg from "pg";
import * as runner from "../src/migrate.js";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { createDisposableDatabase } from "./support/disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const V46 = "202610301300_training_load_v46_classification_icons.sql";
const V46_NAME = `migrations_v2/${V46}`;
const PREV_NAME = "migrations_v2/202610301200_training_load_v45_metric_variable_icon.sql";
const UP_TO_PREV = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V46));
const MIGRATION_PATH = path.resolve(ROOT, "migrations_v2", V46);
const ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/classification-icons-v46-rollback.sql");
const PREV_ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/metric-variable-icon-v45-rollback.sql");
const PREFLIGHT_PATH = path.resolve(ROOT, "docs/runbooks/classification-icons-v46-preflight.sql");
const POSTCHECK_PATH = path.resolve(ROOT, "docs/runbooks/classification-icons-v46-postcheck.sql");
const PREFIX = "/api/training-load/sources/metrics";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const NOT_FOUND = '{"error":"notFound"}';
// The database's fixed messages (v41, and v46's two).
const NO_ACTOR = /no acting user is set for this transaction/;
const ICON_OWN = /^metric classification: an icon change is a change of its own$/;
const ICON_RESTORE_FIRST = /^metric classification: an archived domain or category is restored before its icon changes$/;
const IDENTITY = /^metric classification: only the name, the description and the state of a canonical domain or category change$/;
const MAY_NOT = /^metric classification: the acting user may not write this owner scope$/;
const REQUEST_LINK = /^metric_classification_changes: a change is written with its own request row$/;
const BASIS = /^metric classification request: the basis is not the acting user's own$/;
const FOLLOW = /^metric_classification_requests: the request must follow its own change in the same transaction$/;
const APPEND = /^metric classification: change and request records are append-only$/;
const ICON_FUNCTIONS = ["metric_classification_node_guard", "metric_classification_record_node_change", "metric_classification_requests_guard"];
const ICON_TRIGGERS = [["metric_domains", "metric_domains_v41_record_change"], ["metric_categories", "metric_categories_v41_record_change"]];
const ALL_TRIGGERS = [...ICON_TRIGGERS, ["metric_domains", "metric_domains_v41_guard"], ["metric_categories", "metric_categories_v41_guard"],
  ["metric_classification_requests", "metric_classification_requests_guard"]];
const CHANGED_CHECKS = ["metric_classification_changes_kind_check", "metric_classification_changes_kind_shape", "metric_classification_changes_shape",
  "metric_classification_requests_operation_check"];
const NODE_KEYS = ["actions", "description", "editable", "icon", "id", "key", "name", "namesToken", "ownerScope", "state", "truncated"];

let rdb, db, r, r2, k, k2, server, apiBase, service, classification, appPool, createSession, ICON_KEYS;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};

// The files before v46 and v46, through the real runner (its checksum and lock rules).
async function applyV46(url) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v46-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of UP_TO_PREV) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await fsp.copyFile(MIGRATION_PATH, path.join(dir, V46));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

before(async () => {
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V46), "v46 is a test migration");
  assert.equal(UP_TO_PREV.at(-1), PREV_NAME.slice("migrations_v2/".length), "v46 follows PR-1b's v45 in the test set");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v46rb", migrations: UP_TO_PREV }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "icon1c" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  r2 = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  k2 = new pg.Client({ connectionString: db.url });
  for (const c of [r, r2, k, k2]) await c.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  assert.equal((await k.query(`select 1 from public.schema_migrations where migration_name = $1`, [V46_NAME])).rowCount, 1, "the behaviour database carries v46");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.ICON1C_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  classification = await import("../src/canonicalClassificationService.js");
  ({ ICON_KEYS } = await import("../src/iconKeys.js"));
  const dbModule = await import("../src/db.js");
  ({ createSession } = await import("../src/auth.js"));
  appPool = dbModule.pool;
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  await world();
});

function resetSeams() {
  service?.setMappingCommitForTests();
  service?.setMappingRightsHoldForTests(null);
  service?.setMappingRereadFaultForTests(null);
  classification?.setClassificationWriteHoldForTests(null);
}
after(async () => {
  resetSeams();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (appPool) {
    let timer;
    await Promise.race([appPool.end(), new Promise((res) => { timer = setTimeout(res, 5_000); })]);
    clearTimeout(timer);
  }
  for (const c of [r, r2, k, k2]) await c?.end().catch(() => {});
  await rdb?.drop();
  await db?.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});
afterEach(resetSeams);

// ---------------------------------------------------------------------------
// helpers
const uid = () => crypto.randomBytes(4).toString("hex");
const rows = async (c, sql, params = []) => (await c.query(sql, params)).rows;
const one = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
const key = () => crypto.randomUUID();
const table = (kind) => (kind === "domains" ? "metric_domains" : "metric_categories");
const singular = (kind) => (kind === "domains" ? "domain" : "category");

async function api(p, { method = "GET", body, cookie, base = PREFIX, contentType = "application/json" } = {}) {
  const res = await fetch(`${apiBase}${base}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": contentType }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  responses.push(text);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, headers: res.headers, text };
}
const post = (p, cookie, body, opts = {}) => api(p, { method: "POST", cookie, body, ...opts });
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const create = (who, kind, over = {}) => post(`/classification/${kind}`, who.cookie, { requestKey: key(), name: `${singular(kind)} ${uid()}`, ...over });
async function node(who, kind, over = {}) {
  return ok(await create(who, kind, over), 201)[singular(kind)];
}
const setIcon = (who, kind, id, expectedIconKey, iconKey, extra = {}) =>
  post(`/classification/${kind}/${id}/icon`, who?.cookie ?? null, { requestKey: key(), expectedIconKey, iconKey, ...extra });
const act = (who, kind, id, verb, body = {}) => post(`/classification/${kind}/${id}/${verb}`, who.cookie, { requestKey: key(), ...(verb === "archive" ? { reason: "No longer used" } : {}), ...body });
async function tree(who) {
  return ok(await api("/classification", { cookie: who.cookie }));
}
const nodeIn = async (who, kind, id) => (await tree(who))[kind].find((x) => x.id === id);
async function variable(who) {
  const res = await post("/variables", who.cookie, { requestKey: key(), label: `Total distance ${uid()}`, unit: "m", levels: ["session", "drill"], dailyAggregationMethod: "sum" });
  return ok(res, 201).variable;
}
const linkOf = async (who, ids) => ok(await post("/classification/links", who.cookie, { requestKey: key(), ...ids }), 201).link;
const nodeRow = (kind, id) => one(k, `select name, description, is_active, icon_url from training_load.${table(kind)} where id = $1`, [id]);
const changesOf = (kind, id) => rows(k, `select c.*, r.operation, r.basis, r.reason, r.requested_by_user_id from training_load.metric_classification_changes c
  left join training_load.metric_classification_requests r on r.metric_classification_change_id = c.id where c.${singular(kind)}_id = $1 and c.object_kind = $2 order by c.seq`, [id, singular(kind)]);
async function counts() {
  return one(k, `select (select count(*)::int from training_load.metric_classification_changes) as changes,
                        (select count(*)::int from training_load.metric_classification_requests) as requests`);
}

async function user(label, { active = true } = {}) {
  return (await one(k, `insert into public.users (email, full_name, display_name, is_active) values ($1,$2,$2,$3) returning id`, [`${label}-${uid()}@test.local`, label, active])).id;
}
async function workspace(userId, type, scopeId) {
  await k.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieFor = async (userId) => `optimove_session=${await createSession(userId)}`;
const club = async (name) => (await one(k, `insert into public.clubs (name) values ($1) returning id`, [`${name} ${uid()}`])).id;
const team = async (clubId) => (await one(k, `insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `Team ${uid()}`])).id;
async function person(label, { platform = false, clubAdminOf = [], coachOf = [], roleActive = true, ws }) {
  const id = await user(label);
  if (platform) await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  for (const c of clubAdminOf) await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, c]);
  for (const t of coachOf) await k.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',$3)`, [id, t, roleActive]);
  if (ws) await workspace(id, ws[0], ws[1]);
  return { id, cookie: await cookieFor(id) };
}

// One transaction on `client` with the acting user set the way the service sets
// it (no actor: none set). Committed when fn succeeds; a refusal is returned.
async function tx(actor, fn, client = k) {
  await client.query("begin");
  try {
    if (actor) await client.query(CTX, [actor]);
    const value = await fn(client);
    await client.query("commit");
    return { ok: true, value };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    return { ok: false, error };
  }
}
function refusedWith(res, code, pattern) {
  assert.equal(res.ok, false, `expected a refusal (${pattern})`);
  assert.equal(res.error.code, code, res.error.message);
  if (pattern instanceof RegExp) assert.match(res.error.message, pattern);
  else if (typeof pattern === "string") assert.equal(res.error.constraint, pattern, res.error.message);
  return res.error;
}
const okTx = (res) => { assert.equal(res.ok, true, res.error ? `${res.error.code}: ${res.error.message}` : ""); return res.value; };
// A stored icon_url planted as a fixture, with every trigger of the transaction off.
async function plantIcon(kind, id, stored) {
  await k.query("begin");
  try {
    await k.query("set local session_replication_role = replica");
    await k.query(`update training_load.${table(kind)} set icon_url = $2 where id = $1`, [id, stored]);
    await k.query("commit");
  } catch (error) {
    await k.query("rollback").catch(() => {});
    throw error;
  }
}
// A raw node write inside a tx (what the service writes): the UPDATE, then the
// request naming the change row the trigger wrote.
async function rawChange(c, { kind = "domains", id, by, operation, set, basis = "club_admin", scope = "club", clubId = null, reason = null }) {
  await c.query(`update training_load.${table(kind)} set ${set} where id = $1`, [id]);
  const change = (await one(c, `select id from training_load.metric_classification_changes where ${singular(kind)}_id = $1 and xact_id = pg_current_xact_id() order by seq desc limit 1`, [id]))?.id ?? null;
  await c.query(
    `insert into training_load.metric_classification_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_classification_change_id, reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [key(), by, operation, "0".repeat(64), scope, clubId, basis, change, reason],
  );
  return change;
}

async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    tables: await rows(c, `select table_schema, table_name from information_schema.tables where table_schema in ${S} order by 1, 2`),
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, c.contype, c.condeferrable, c.condeferred, c.convalidated, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    indexes: await rows(c, `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ${S} order by 1, 2, 3`),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled, t.tgdeferrable, t.tginitdeferred, obj_description(t.oid, 'pg_trigger') as comment from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
    migrations: (await rows(c, `select migration_name from public.schema_migrations order by 1`)).map((x) => x.migration_name),
  };
}
// The read-only runbook blocks: each statement's one row, merged.
async function runbook(c, file) {
  const text = (await fsp.readFile(file, "utf8")).split("\n").filter((line) => !line.startsWith("--")).join("\n");
  const out = {};
  for (const statement of text.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) Object.assign(out, (await c.query(statement)).rows[0]);
  return out;
}
async function runScript(c, file) {
  const sql = await fsp.readFile(file, "utf8");
  try {
    await c.query(sql);
    return null;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    return e;
  }
}
// The rollback run after `plant` wrote, all of it in one transaction that is
// rolled back: what the script refused with (or null when it did not refuse,
// in which case its COMMIT committed everything - never used that way here).
async function rollbackAfter(plant) {
  const sql = await fsp.readFile(ROLLBACK_PATH, "utf8");
  await r.query("begin");
  let error = null;
  try {
    await plant(r);
    await r.query(sql);
  } catch (e) {
    error = e;
  }
  await r.query("rollback").catch(() => {});
  return error;
}

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.clubC = await club("Club C");
  W.teamA1 = await team(W.clubA);
  W.teamArch = await team(W.clubA);
  W.pa = await person("platform-admin", { platform: true, ws: ["platform", null] });
  W.paA = await person("platform-admin-a", { platform: true, clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caA = await person("club-admin-a", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caB = await person("club-admin-b", { clubAdminOf: [W.clubB], ws: ["club", W.clubB] });
  W.caC = await person("club-admin-c", { clubAdminOf: [W.clubC], ws: ["club", W.clubC] });
  W.coachA1 = await person("coach-a1", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.coachArch = await person("coach-archteam", { coachOf: [W.teamArch], ws: ["team", W.teamArch] });
  W.coachRevoked = await person("coach-revoked", { coachOf: [W.teamA1], roleActive: false, ws: ["team", W.teamA1] });
  W.caCoachA1 = await person("club-admin-coach", { clubAdminOf: [W.clubA], coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.caRevoked = await person("club-admin-revoked", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  await k.query(`update public.user_club_roles set is_active = false where user_id = $1`, [W.caRevoked.id]);
  const athleteId = await user("athlete");
  await k.query(`insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active) values ($1,$1,'Athlete','Only','Athlete Only','Athlete Only',$2,true)`, [`i1c${uid()}`, athleteId]);
  await workspace(athleteId, "athlete", null);
  W.athlete = { id: athleteId, cookie: await cookieFor(athleteId) };
  W.privateCoach = await person("private-coach", { platform: true, ws: ["private_coach", null] });
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [W.privateCoach.id]);
  W.sysDomain = await node(W.pa, "domains");
  W.sysCategory = await node(W.pa, "categories");
  W.clubCDomain = await node(W.caC, "domains");
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubC]);
  await k.query(`update public.teams set is_active = false where id = $1`, [W.teamArch]);
}

// ---------------------------------------------------------------------------
test("1. migration v46 on PR-1b's v45: the read-only preflight; through the real runner four columns, two icon rules, four checks (v41's names), three functions and two triggers change and nothing else; the read-only post-check; the rollback refuses without v46, under a later migration, while the migrator runs, with an icon on a domain or a category, an icon in a change row, an icon request, a column missing or a trigger disabled; it returns the identical catalog before it (comments included) and v46 applies again identically; v45's rollback refuses while v46 is recorded", async () => {
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v46 rollback refused: v46 is not recorded on this database$/);
  const pre = await runbook(r, PREFLIGHT_PATH);
  assert.deepEqual(
    [pre.pg15_or_later, pre.v41_rows, pre.v41_checksum_ok, pre.v45_rows, pre.v45_checksum_ok, pre.v46_rows, pre.at_or_after_v46, pre.last_migration,
      pre.node_guard_v41, pre.record_body_v41, pre.requests_guard_v41, pre.record_triggers_enabled, pre.domain_trigger_v41, pre.category_trigger_v41, pre.v41_checks,
      pre.disabled_triggers, pre.v46_columns, pre.v46_icon_rules, pre.icon_in_checks, pre.owns_domains, pre.owns_categories, pre.owns_changes, pre.owns_requests,
      pre.owns_functions, pre.rows_outside_v41, pre.actor_defaults, pre.locks_on_v46_tables, pre.idle_in_transaction],
    [true, "1", true, "1", true, "0", "0", PREV_NAME, true, true, true, "2", true, true, "4", "0", "0", "0", "0", true, true, true, true, "3", "0", "0", "0", "0"],
  );
  const beforeV46 = await catalog(r);
  await applyV46(rdb.url);
  const post46 = await runbook(r, POSTCHECK_PATH);
  assert.deepEqual(
    [post46.v46_rows, post46.v46_checksum_ok, post46.later_rows, post46.last_migration, post46.icon_columns, post46.icon_columns_text_nullable, post46.icon_rules_validated,
      post46.node_guard_v46, post46.record_body_v46, post46.requests_guard_v46, post46.comments, post46.record_triggers_enabled, post46.domain_trigger_on_icon,
      post46.category_trigger_on_icon, post46.checks_with_icon, post46.change_rows, post46.request_rows, post46.icon_changes, post46.icon_requests,
      post46.unpaired_icon_rows, post46.nodes_with_icon, post46.created_with_icon, post46.actor_defaults, post46.disabled_triggers],
    ["1", true, "0", V46_NAME, "4", "4", "2", true, true, true, "3", "2", true, true, "4", pre.change_rows, pre.request_rows, "0", "0", "0", "0", "0", "0", "0"],
  );
  const after46 = await catalog(r);
  const added = (list, base, keyOf) => list.filter((x) => !base.some((y) => keyOf(y) === keyOf(x)));
  const removed = (list, base, keyOf) => added(base, list, keyOf);
  const changed = (list, base, keyOf) => list.filter((x) => base.some((y) => keyOf(y) === keyOf(x) && JSON.stringify(y) !== JSON.stringify(x)));
  const keys = {
    tables: (x) => `${x.table_schema}.${x.table_name}`, columns: (x) => `${x.table_schema}.${x.table_name}.${x.column_name}`,
    constraints: (x) => `${x.rel}.${x.conname}`, indexes: (x) => x.indexname, triggers: (x) => `${x.relname}.${x.tgname}`, functions: (x) => `${x.proname}(${x.args})`,
  };
  const diff = Object.fromEntries(Object.entries(keys).map(([part, keyOf]) => [part, {
    added: added(after46[part], beforeV46[part], keyOf).map(keyOf).sort(),
    removed: removed(after46[part], beforeV46[part], keyOf).map(keyOf).sort(),
    changed: changed(after46[part], beforeV46[part], keyOf).map(keyOf).sort(),
  }]));
  assert.deepEqual(diff, {
    tables: { added: [], removed: [], changed: [] },
    columns: {
      added: ["training_load.metric_categories.icon_url", "training_load.metric_classification_changes.new_icon_url",
        "training_load.metric_classification_changes.old_icon_url", "training_load.metric_domains.icon_url"],
      removed: [], changed: [],
    },
    constraints: {
      added: ["training_load.metric_categories.metric_categories_icon_rule", "training_load.metric_domains.metric_domains_icon_rule"],
      removed: [],
      changed: CHANGED_CHECKS.map((n) => `training_load.${n.startsWith("metric_classification_changes") ? "metric_classification_changes" : "metric_classification_requests"}.${n}`).sort(),
    },
    indexes: { added: [], removed: [], changed: [] },
    triggers: { added: [], removed: [], changed: ICON_TRIGGERS.map(([t, n]) => `${t}.${n}`).sort() },
    functions: { added: [], removed: [], changed: ICON_FUNCTIONS.map((n) => `${n}()`) },
  });
  assert.deepEqual(after46.migrations, [...beforeV46.migrations, V46_NAME].sort());
  for (const f of after46.functions.filter((x) => ICON_FUNCTIONS.includes(x.proname))) assert.match(f.comment, /^v46 \(J6\.1\): /);
  // The rollback's refusals, each in a transaction that is rolled back.
  const refusal = (e) => e?.message ?? "";
  assert.match(refusal(await rollbackAfter((c) => c.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/209912312359_training_load_v99_test_only.sql', $1, 'test')`, ["0".repeat(64)]))),
    /^v46 rollback refused: later migrations are applied$/);
  const replica = (sql, params = []) => async (c) => {
    await c.query("set local session_replication_role = replica");
    await c.query(sql, params);
    await c.query("set local session_replication_role = origin");
  };
  const ICON_RECORDED = /^v46 rollback refused: an icon is set or recorded$/;
  for (const [kindTable, label] of [["metric_domains", "a domain"], ["metric_categories", "a category"]]) {
    const plant = replica(`insert into training_load.${kindTable} (name, owner_scope, key, icon_url) values ('Planted', 'system', $1, 'icon:run')`, [`p_${uid()}`]);
    assert.match(refusal(await rollbackAfter(plant)), ICON_RECORDED, label);
  }
  const changeRow = (kind, oldIcon, newIcon) => replica(
    `insert into training_load.metric_classification_changes (object_kind, kind, domain_id, owner_scope, old_name, new_name, old_active, new_active, old_icon_url, new_icon_url, changed_by_user_id, xact_id)
     values ('domain', $1, $2, 'system', $3, 'x', $4, true, $5, $6, $7, pg_current_xact_id())`,
    [kind, crypto.randomUUID(), kind === "create" ? null : "x", kind === "create" ? null : true, oldIcon, newIcon, crypto.randomUUID()]);
  assert.match(refusal(await rollbackAfter(changeRow("icon", null, "icon:run"))), ICON_RECORDED, "an icon change row");
  assert.match(refusal(await rollbackAfter(changeRow("create", null, "icon:run"))), ICON_RECORDED, "a create row with an icon");
  for (const operation of ["domain_icon", "category_icon"]) {
    assert.match(refusal(await rollbackAfter(replica(
      `insert into training_load.metric_classification_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, basis, metric_classification_change_id)
       values ($1,$2,$3,$4,'system','platform_admin',$5)`, [key(), crypto.randomUUID(), operation, "0".repeat(64), crypto.randomUUID()]))), ICON_RECORDED, operation);
  }
  for (const [kindTable, column] of [["metric_domains", "icon_url"], ["metric_categories", "icon_url"], ["metric_classification_changes", "old_icon_url"], ["metric_classification_changes", "new_icon_url"]]) {
    // A node table's column takes its record trigger with it (the trigger fires on it).
    assert.match(refusal(await rollbackAfter((c) => c.query(`alter table training_load.${kindTable} drop column ${column} cascade`))),
      /^v46 rollback refused: a v46 column is missing$/, `${kindTable}.${column}`);
  }
  for (const [kindTable, trigger] of ALL_TRIGGERS) {
    assert.match(refusal(await rollbackAfter((c) => c.query(`alter table training_load.${kindTable} disable trigger ${trigger}`))),
      /^v46 rollback refused: a v46 trigger is disabled$/, trigger);
  }
  await r2.query("select pg_advisory_lock(822026)");
  try {
    assert.match(refusal(await runScript(r, ROLLBACK_PATH)), /^v46 rollback refused: the migrator is running$/);
  } finally {
    await r2.query("select pg_advisory_unlock(822026)");
  }
  assert.deepEqual(await catalog(r), after46, "every refusal changed nothing");
  // v45's rollback refuses while v46 is recorded.
  assert.match(refusal(await runScript(r, PREV_ROLLBACK_PATH)), /^v45 rollback refused: later migrations are applied/);
  // The rollback, then the catalog before v46 exactly; the preflight reads as before; v46 again.
  assert.equal(await runScript(r, ROLLBACK_PATH), null);
  assert.deepEqual(await catalog(r), beforeV46, "the identical catalog before v46, comments included");
  assert.deepEqual(await runbook(r, PREFLIGHT_PATH), pre);
  await applyV46(rdb.url);
  assert.deepEqual(await catalog(r), after46, "v46 applies again identically");
});

test("2. who may change an icon: the platform admin on a system domain and category (platform workspace) and on a club's (that club's workspace), the club's admin on its club's, each with its basis; a coach, the club's admin in a team workspace, another club's admin, a system node in a club's workspace, a club's node in the platform workspace, an archived club or team, a revoked role, an athlete, a private-coaching workspace and a missing or malformed id get the byte-identical 404; 401 without a session; actions carry icon exactly where the caller may change it", async () => {
  const [a, b, c, d] = ICON_KEYS;
  const clubDomain = await node(W.caA, "domains");
  const clubCategory = await node(W.caA, "categories");
  ok(await setIcon(W.pa, "domains", W.sysDomain.id, null, a));
  ok(await setIcon(W.pa, "categories", W.sysCategory.id, null, a));
  const answer = ok(await setIcon(W.caA, "domains", clubDomain.id, null, a));
  assert.deepEqual([Object.keys(answer.domain).sort(), answer.domain.icon, answer.replayed], [NODE_KEYS, a, false]);
  ok(await setIcon(W.paA, "domains", clubDomain.id, a, b));
  ok(await setIcon(W.caA, "categories", clubCategory.id, null, c));
  assert.deepEqual((await changesOf("domains", clubDomain.id)).map((x) => [x.kind, x.operation, x.basis, x.requested_by_user_id, x.owner_scope, x.old_icon_url, x.new_icon_url]), [
    ["create", "domain_create", "club_admin", W.caA.id, "club", null, null],
    ["icon", "domain_icon", "club_admin", W.caA.id, "club", null, `icon:${a}`],
    ["icon", "domain_icon", "platform_admin", W.paA.id, "club", `icon:${a}`, `icon:${b}`],
  ]);
  assert.deepEqual((await changesOf("categories", clubCategory.id)).map((x) => [x.kind, x.operation, x.basis]), [["create", "category_create", "club_admin"], ["icon", "category_icon", "club_admin"]]);
  assert.deepEqual((await changesOf("domains", W.sysDomain.id)).map((x) => [x.kind, x.basis, x.owner_scope]), [["create", "platform_admin", "system"], ["icon", "platform_admin", "system"]]);
  assert.deepEqual((await changesOf("categories", W.sysCategory.id)).map((x) => [x.kind, x.operation]), [["create", "category_create"], ["icon", "category_icon"]]);
  // Everyone outside the audience: the same bytes, nothing written.
  const missing = await setIcon(W.caA, "domains", crypto.randomUUID(), null, a);
  assert.deepEqual([missing.status, missing.text, missing.headers.get("cache-control")], [404, NOT_FOUND, "no-store"]);
  for (const res of [await setIcon(W.caA, "domains", "not-a-uuid", null, a), await setIcon(W.caA, "nodes", clubDomain.id, b, d),
    await setIcon(W.caA, "domains", W.sysDomain.id, a, d), await setIcon(W.caA, "categories", W.sysCategory.id, a, d),
    await setIcon(W.pa, "domains", clubDomain.id, b, d), await setIcon(W.caB, "domains", clubDomain.id, b, d),
    await setIcon(W.caC, "domains", W.clubCDomain.id, null, d), await setIcon(W.paA, "domains", W.sysDomain.id, a, d)]) {
    assert.deepEqual([res.status, res.text], [404, NOT_FOUND]);
  }
  for (const who of [W.coachA1, W.caCoachA1, W.coachArch, W.coachRevoked, W.caRevoked, W.athlete, W.privateCoach]) {
    const res = await setIcon(who, "domains", clubDomain.id, b, d);
    assert.deepEqual([res.status, res.text, res.headers.get("cache-control")], [404, NOT_FOUND, "no-store"]);
  }
  assert.deepEqual([(await nodeRow("domains", clubDomain.id)).icon_url, (await nodeRow("domains", W.sysDomain.id)).icon_url], [`icon:${b}`, `icon:${a}`], "nothing written by a refused caller");
  assert.equal((await setIcon(null, "domains", clubDomain.id, b, d)).status, 401);
  // actions: icon for the node's own writer while it is active; the coach reads
  // the icon but gets no action.
  const own = await nodeIn(W.caA, "domains", clubDomain.id);
  const sysInClub = await nodeIn(W.caA, "domains", W.sysDomain.id);
  const coachView = await nodeIn(W.coachA1, "domains", clubDomain.id);
  assert.deepEqual([own.actions, sysInClub.actions, coachView.actions, coachView.icon, sysInClub.icon], [["rename", "archive", "icon"], [], [], b, a]);
  assert.deepEqual((await nodeIn(W.pa, "categories", W.sysCategory.id)).actions, ["rename", "archive", "icon"]);
  ok(await act(W.caA, "domains", clubDomain.id, "archive"));
  assert.deepEqual([(await nodeIn(W.caA, "domains", clubDomain.id)).actions, (await nodeIn(W.caA, "domains", clubDomain.id)).icon], [["restore"], b]);
});

test("3. the order of the answers: a coach's 404 comes before the body is looked at; for an admin in the workspace, 415 for a non-JSON body, 400 for a JSON body that is not an object, 400 invalid_body for a missing or extra field, a bad requestKey and a key outside the library in iconKey or expectedIconKey (a stored-value form, an unknown key, an empty string, a wrong type, upper case); nothing written", async () => {
  const n = await node(W.caA, "categories");
  const [a] = ICON_KEYS;
  for (const body of [{ nonsense: true }, [1, 2]]) {
    const bad = await post(`/classification/categories/${n.id}/icon`, W.coachA1.cookie, body);
    assert.deepEqual([bad.status, bad.text], [404, NOT_FOUND]);
  }
  const textBody = await api(`/classification/categories/${n.id}/icon`, { method: "POST", cookie: W.caA.cookie, body: "icon=run", contentType: "text/plain" });
  assert.equal(textBody.status, 415);
  assert.equal((await post(`/classification/categories/${n.id}/icon`, W.caA.cookie, [1, 2])).status, 400);
  const base = { requestKey: key(), expectedIconKey: null, iconKey: a };
  const cases = [
    {}, { requestKey: key(), iconKey: a }, { requestKey: key(), expectedIconKey: null }, { ...base, extra: 1 }, { ...base, requestKey: "abc" },
    { ...base, requestKey: key(), iconKey: `icon:${a}` }, { ...base, requestKey: key(), iconKey: "no-such-icon" }, { ...base, requestKey: key(), iconKey: "" },
    { ...base, requestKey: key(), iconKey: 5 }, { ...base, requestKey: key(), iconKey: a.toUpperCase() }, { ...base, requestKey: key(), expectedIconKey: "/assets/x.svg" },
    { ...base, requestKey: key(), expectedIconKey: ["run"] },
  ];
  for (const body of cases) {
    const res = await post(`/classification/categories/${n.id}/icon`, W.caA.cookie, body);
    assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], JSON.stringify(body));
  }
  assert.deepEqual([(await nodeRow("categories", n.id)).icon_url, (await changesOf("categories", n.id)).length], [null, 1]);
});

test("4. the change: the answer and every read (the classification, a variable's detail for an admin and a coach) carry the new icon, and the older API's answer stays without it; the change row records the old and new stored values and keeps the name, description, state and names token; node_changed (with the current node) for a stale expectedIconKey; icon_unchanged; No icon (null); a stored value that is not a library key reads as no icon and is replaced; node_not_active after an archive; a rename, an archive and a restore keep the icon in their change rows", async () => {
  const [a, b] = ICON_KEYS;
  const n = await node(W.caA, "domains", { description: "Kept" });
  const category = await node(W.caA, "categories");
  const v = await variable(W.caA);
  await linkOf(W.caA, { variableId: v.id, domainId: n.id });
  await linkOf(W.caA, { variableId: v.id, categoryId: category.id });
  await linkOf(W.caA, { categoryId: category.id, domainId: n.id });
  const first = ok(await setIcon(W.caA, "domains", n.id, null, a));
  assert.deepEqual([first.domain.icon, first.domain.namesToken, first.domain.name, first.domain.description], [a, n.namesToken, n.name, "Kept"]);
  ok(await setIcon(W.caA, "categories", category.id, null, b));
  assert.deepEqual([(await nodeIn(W.caA, "domains", n.id)).icon, (await nodeIn(W.coachA1, "domains", n.id)).icon], [a, a]);
  // The older API's answers stay as they were before v46: no icon column.
  const older = ok(await api("/domains", { base: "/api/training-load/metrics", cookie: W.caA.cookie })).rows.find((x) => x.id === n.id);
  // Its rows name their creator by that API's own contract: test 9 scans this route's answers, not that one's.
  responses.pop();
  assert.deepEqual([Boolean(older), older && "icon_url" in older], [true, false], "the older API never names the icon");
  for (const who of [W.caA, W.coachA1]) {
    const detail = ok(await api(`/variables/${v.id}`, { cookie: who.cookie })).variable.classification;
    assert.deepEqual(
      [detail.categories.map((x) => [x.id, x.icon]), detail.domains.map((x) => [x.id, x.viaCategoryId, x.icon])],
      [[[category.id, b]], [[n.id, null, a], [n.id, category.id, a]]],
    );
  }
  const [row] = (await changesOf("domains", n.id)).slice(1);
  assert.deepEqual(
    [row.kind, row.old_icon_url, row.new_icon_url, row.old_name, row.new_name, row.old_description, row.new_description, row.old_active, row.new_active, row.reason],
    ["icon", null, `icon:${a}`, n.name, n.name, "Kept", "Kept", true, true, null],
  );
  // A stale expectation, the same icon.
  const stale = await setIcon(W.caA, "domains", n.id, null, b);
  assert.deepEqual([stale.status, stale.body.error, stale.body.current.icon, stale.body.current.id], [409, "node_changed", a, n.id]);
  assert.deepEqual([(await setIcon(W.caA, "domains", n.id, a, a)).body.error], ["icon_unchanged"]);
  // No icon.
  assert.equal(ok(await setIcon(W.caA, "domains", n.id, a, null)).domain.icon, null);
  assert.deepEqual([(await nodeRow("domains", n.id)).icon_url, (await changesOf("domains", n.id)).at(-1).new_icon_url], [null, null]);
  assert.deepEqual([(await setIcon(W.caA, "domains", n.id, null, null)).body.error], ["icon_unchanged"]);
  // A stored value that is not a library key: read as null, replaced by a key or by null.
  for (const [stored, next] of [["icon:no-such-icon", b], ["icon:other-missing", null]]) {
    await plantIcon("domains", n.id, stored);
    assert.equal((await nodeIn(W.caA, "domains", n.id)).icon, null);
    assert.equal(ok(await setIcon(W.caA, "domains", n.id, null, next)).domain.icon, next);
    const last = (await changesOf("domains", n.id)).at(-1);
    assert.deepEqual([last.kind, last.old_icon_url, last.new_icon_url], ["icon", stored, next === null ? null : `icon:${next}`]);
  }
  // A rename, an archive and a restore keep the icon.
  ok(await setIcon(W.caA, "domains", n.id, null, a));
  const before = (await changesOf("domains", n.id)).length;
  const token = (await nodeIn(W.caA, "domains", n.id)).namesToken;
  ok(await act(W.caA, "domains", n.id, "rename", { namesToken: token, name: `Renamed ${uid()}` }));
  ok(await act(W.caA, "domains", n.id, "archive"));
  const archived = await setIcon(W.caA, "domains", n.id, a, b);
  assert.deepEqual([archived.status, archived.body.error], [409, "node_not_active"]);
  ok(await act(W.caA, "domains", n.id, "restore"));
  const kept = (await changesOf("domains", n.id)).slice(before);
  assert.deepEqual(kept.map((x) => [x.kind, x.old_icon_url, x.new_icon_url]), [["rename", `icon:${a}`, `icon:${a}`], ["archive", `icon:${a}`, `icon:${a}`], ["restore", `icon:${a}`, `icon:${a}`]]);
  assert.equal((await nodeIn(W.caA, "domains", n.id)).icon, a);
});

test("5. a create may carry its icon: iconKey a library key is stored and read, null or absent is no icon; anything else is 400 invalid_body with nothing written; the create's change row carries the icon; a create without iconKey hashes exactly as before v46, so iconKey null replays it while another key is request_key_reused", async () => {
  const [a, b] = ICON_KEYS;
  const withIcon = await node(W.caA, "categories", { iconKey: a });
  assert.equal(withIcon.icon, a);
  assert.deepEqual((await changesOf("categories", withIcon.id)).map((x) => [x.kind, x.old_icon_url, x.new_icon_url]), [["create", null, `icon:${a}`]]);
  assert.equal((await nodeIn(W.caA, "categories", withIcon.id)).icon, a);
  assert.equal((await node(W.pa, "domains", { iconKey: null })).icon, null);
  const before = await counts();
  for (const iconKey of [`icon:${a}`, "no-such-icon", "", 5, a.toUpperCase(), ["run"]]) {
    const res = await create(W.caA, "domains", { iconKey });
    assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], JSON.stringify(iconKey));
  }
  assert.deepEqual(await counts(), before, "nothing written");
  // The request hash of a create without an icon is the one before v46.
  const body = { requestKey: key(), name: `Plain ${uid()}` };
  const plain = ok(await post("/classification/domains", W.caA.cookie, body), 201).domain;
  const stored = await one(k, `select request_hash from training_load.metric_classification_requests where requested_by_user_id = $1 and request_key = $2`, [W.caA.id, body.requestKey]);
  const before46 = crypto.createHash("sha256").update(JSON.stringify({
    contract: "metric-classification/v1", operation: "domain_create", owner: W.clubA, body: { name: body.name, description: null, key: plain.key },
  }), "utf8").digest("hex");
  assert.equal(stored.request_hash, before46);
  const replay = ok(await post("/classification/domains", W.caA.cookie, { ...body, iconKey: null }));
  assert.deepEqual([replay.replayed, replay.domain.id], [true, plain.id]);
  assert.deepEqual([(await post("/classification/domains", W.caA.cookie, { ...body, iconKey: b })).body.error], ["request_key_reused"]);
});

test("6. idempotency and outcome: a replay answers the current state and writes nothing; the same key with another body or for another operation is request_key_reused; two identical requests at once write once; a lost answer after a real COMMIT is verified; after a real rollback it is 503 outcome_unknown and the same key then writes once; a read that fails after the COMMIT keeps 200 with readError; a right lost during the write is the identical 404 with nothing written; a held row is try_again", async () => {
  const [a, b, c] = ICON_KEYS;
  const n = await node(W.caA, "domains");
  const body = { requestKey: key(), expectedIconKey: null, iconKey: a };
  ok(await post(`/classification/domains/${n.id}/icon`, W.caA.cookie, body));
  const replay = ok(await post(`/classification/domains/${n.id}/icon`, W.caA.cookie, body));
  assert.deepEqual([replay.replayed, replay.domain.icon, (await changesOf("domains", n.id)).length], [true, a, 2]);
  assert.deepEqual([(await post(`/classification/domains/${n.id}/icon`, W.caA.cookie, { ...body, iconKey: b })).body.error], ["request_key_reused"]);
  assert.deepEqual([(await post(`/classification/domains/${n.id}/icon`, W.caA.cookie, { ...body, expectedIconKey: c })).body.error], ["request_key_reused"], "the icon seen is part of the request");
  assert.deepEqual([(await post(`/classification/domains/${n.id}/archive`, W.caA.cookie, { requestKey: body.requestKey, reason: "x" })).body.error], ["request_key_reused"]);
  // Two identical requests at once.
  const twin = { requestKey: key(), expectedIconKey: a, iconKey: b };
  const [x, y] = await Promise.all([post(`/classification/domains/${n.id}/icon`, W.caA.cookie, twin), post(`/classification/domains/${n.id}/icon`, W.caA.cookie, twin)]);
  assert.deepEqual([[x.status, y.status], [x.body.replayed, y.body.replayed].sort()], [[200, 200], [false, true]]);
  assert.equal((await changesOf("domains", n.id)).length, 3);
  // A lost answer after a real COMMIT.
  service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw new Error("lost"); }) });
  const verified = ok(await setIcon(W.caA, "domains", n.id, b, c));
  service.setMappingCommitForTests();
  assert.deepEqual([verified.commitConfirmation, verified.domain.icon], ["verified_after_commit_error", c]);
  // After a real rollback.
  service.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw new Error("lost"); }) });
  const lostKey = key();
  const unknown = await post(`/classification/domains/${n.id}/icon`, W.caA.cookie, { requestKey: lostKey, expectedIconKey: c, iconKey: a });
  service.setMappingCommitForTests();
  assert.deepEqual([unknown.status, Object.keys(unknown.body).sort(), unknown.body.error, unknown.body.requestKey], [503, ["error", "message", "requestKey"], "outcome_unknown", lostKey]);
  assert.equal((await changesOf("domains", n.id)).length, 4, "nothing written");
  ok(await post(`/classification/domains/${n.id}/icon`, W.caA.cookie, { requestKey: lostKey, expectedIconKey: c, iconKey: a }));
  assert.equal((await changesOf("domains", n.id)).length, 5, "the same key then writes once");
  // A read that fails after the COMMIT.
  service.setMappingRereadFaultForTests(async () => { throw new Error("read broke"); });
  const readError = ok(await setIcon(W.caA, "domains", n.id, a, b));
  service.setMappingRereadFaultForTests(null);
  assert.deepEqual([readError.readError, readError.domainId, readError.domain], [true, n.id, undefined]);
  // A right lost during the write: revoked after the resolver admitted the
  // admin, right before the write checks it again under FOR SHARE.
  const admin = await person("club-admin-lost", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  let revoked = false;
  service.setMappingRightsHoldForTests(async () => {
    if (revoked) return;
    revoked = true;
    await k.query(`update public.user_club_roles set is_active = false where user_id = $1`, [admin.id]);
  });
  const lost = await setIcon(admin, "domains", n.id, b, c);
  service.setMappingRightsHoldForTests(null);
  assert.deepEqual([lost.status, lost.text], [404, NOT_FOUND]);
  assert.deepEqual([(await nodeRow("domains", n.id)).icon_url, (await changesOf("domains", n.id)).length], [`icon:${b}`, 6], "nothing written");
  // A held row.
  await k2.query("begin");
  await k2.query(`select 1 from training_load.metric_domains where id = $1 for update`, [n.id]);
  const busy = await setIcon(W.caA, "domains", n.id, b, c);
  await k2.query("rollback");
  assert.deepEqual([busy.status, busy.body.error, busy.headers.get("retry-after")], [409, "try_again", "5"]);
});

test("7. the database guards, by direct SQL: an icon UPDATE without an acting user is 42501; with one but no request row it is refused at COMMIT; an icon changed with the name, the description or the state is refused, and an archived node's icon; a stored value that is not null or a library key's shape (or longer than 69 characters) is refused by the node's icon rule, at an update and at a create; the operation must match the kind both ways and the object; an icon request carries no reason, the acting user's basis, one change of the node; an icon changed again with the trigger off; a create may carry an icon; a team node's icon changes without an actor; the change rows stay append-only", async () => {
  const [a, b] = ICON_KEYS;
  const n = await node(W.caA, "domains");
  const category = await node(W.caA, "categories");
  const iconSet = (value) => (value === null ? "icon_url = null" : `icon_url = '${value}'`);
  const clubAdmin = { id: n.id, by: W.caA.id, clubId: W.clubA };
  refusedWith(await tx(null, (c) => c.query(`update training_load.metric_domains set ${iconSet(`icon:${a}`)} where id = $1`, [n.id])), "42501", NO_ACTOR);
  refusedWith(await tx(W.caA.id, (c) => c.query(`update training_load.metric_domains set ${iconSet(`icon:${a}`)} where id = $1`, [n.id])), "23514", REQUEST_LINK);
  refusedWith(await tx(W.caB.id, (c) => rawChange(c, { ...clubAdmin, by: W.caB.id, operation: "domain_icon", set: iconSet(`icon:${a}`) })), "42501", MAY_NOT);
  for (const set of [`name = 'both', ${iconSet(`icon:${a}`)}`, `description = 'both', ${iconSet(`icon:${a}`)}`, `is_active = false, ${iconSet(`icon:${a}`)}`]) {
    refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "domain_icon", set })), "23514", ICON_OWN);
  }
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "domain_icon", set: `key = 'other_key', ${iconSet(`icon:${a}`)}` })), "23514", IDENTITY);
  // Every key of the library fits the database's shape and its length bound.
  const SHAPE = /^icon:[a-z0-9]+(-[a-z0-9]+)*$/;
  assert.deepEqual(ICON_KEYS.filter((x) => !SHAPE.test(`icon:${x}`) || `icon:${x}`.length > 69), [], "every library key is storable");
  for (const value of ["/assets/x.svg", "icon:Run", "icon:", "icon:run--x", `icon:${a} `, `icon:${"a".repeat(65)}`]) {
    refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "domain_icon", set: iconSet(value) })), "23514", "metric_domains_icon_rule");
    refusedWith(await tx(W.caA.id, (c) => rawChange(c, { kind: "categories", id: category.id, by: W.caA.id, clubId: W.clubA, operation: "category_icon", set: iconSet(value) })), "23514", "metric_categories_icon_rule");
  }
  // The bound itself (69 characters) is admitted; the legitimate raw writes.
  okTx(await tx(W.caA.id, async (c) => {
    await rawChange(c, { ...clubAdmin, operation: "domain_icon", set: iconSet(`icon:${"a".repeat(64)}`) });
    throw Object.assign(new Error("roll back the probe"), { probe: true });
  }).then((res) => (res.error?.probe ? { ok: true } : res)));
  okTx(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "domain_icon", set: iconSet(`icon:${a}`) })));
  okTx(await tx(W.caA.id, (c) => rawChange(c, { kind: "categories", id: category.id, by: W.caA.id, clubId: W.clubA, operation: "category_icon", set: iconSet(`icon:${b}`) })));
  // The operation matches the kind and the object.
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "domain_rename", set: iconSet(`icon:${b}`) })), "23514", FOLLOW);
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "domain_icon", set: "name = 'renamed by icon'" })), "23514", FOLLOW);
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "category_icon", set: iconSet(`icon:${b}`) })), "23514", FOLLOW);
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "domain_icon", set: iconSet(`icon:${b}`), reason: "why" })), "23514");
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "domain_icon", set: iconSet(`icon:${b}`), basis: "platform_admin" })), "42501", BASIS);
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query(`update training_load.metric_domains set ${iconSet(`icon:${b}`)} where id = $1`, [n.id]);
    await rawChange(c, { ...clubAdmin, operation: "domain_icon", set: iconSet(null) });
  }), "23514", FOLLOW);
  // The icon changed again with the record trigger off: the request's change
  // no longer holds the node's icon.
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query(`update training_load.metric_domains set ${iconSet(`icon:${b}`)} where id = $1`, [n.id]);
    const change = (await one(c, `select id from training_load.metric_classification_changes where domain_id = $1 and xact_id = pg_current_xact_id()`, [n.id])).id;
    await c.query(`alter table training_load.metric_domains disable trigger metric_domains_v41_record_change`);
    await c.query(`update training_load.metric_domains set ${iconSet(null)} where id = $1`, [n.id]);
    await c.query(`alter table training_load.metric_domains enable trigger metric_domains_v41_record_change`);
    await c.query(
      `insert into training_load.metric_classification_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_classification_change_id)
       values ($1,$2,'domain_icon',$3,'club',$4,'club_admin',$5)`, [key(), W.caA.id, "0".repeat(64), W.clubA, change]);
  }), "23514", FOLLOW);
  // An archived node's icon (its state stays archived).
  ok(await act(W.caA, "domains", n.id, "archive"));
  refusedWith(await tx(W.caA.id, (c) => rawChange(c, { ...clubAdmin, operation: "domain_icon", set: iconSet(`icon:${b}`) })), "23514", ICON_RESTORE_FIRST);
  // A create carries its icon; a create with a bad icon is refused by the rule.
  const created = okTx(await tx(W.caA.id, async (c) => {
    const id = (await one(c, `insert into training_load.metric_categories (name, key, icon_url, owner_scope, owner_club_id, created_by_user_id) values ($1,$2,$3,'club',$4,$5) returning id`,
      [`Raw ${uid()}`, `raw_${uid()}`, `icon:${a}`, W.clubA, W.caA.id])).id;
    const change = (await one(c, `select id from training_load.metric_classification_changes where category_id = $1 and xact_id = pg_current_xact_id()`, [id])).id;
    await c.query(`insert into training_load.metric_classification_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_classification_change_id)
      values ($1,$2,'category_create',$3,'club',$4,'club_admin',$5)`, [key(), W.caA.id, "0".repeat(64), W.clubA, change]);
    return id;
  }));
  assert.deepEqual((await changesOf("categories", created)).map((x) => [x.kind, x.new_icon_url]), [["create", `icon:${a}`]]);
  refusedWith(await tx(W.caA.id, (c) => c.query(`insert into training_load.metric_categories (name, key, icon_url, owner_scope, owner_club_id, created_by_user_id) values ($1,$2,'icon:Bad','club',$3,$4)`,
    [`Raw ${uid()}`, `raw_${uid()}`, W.clubA, W.caA.id])), "23514", "metric_categories_icon_rule");
  // A team node: no actor, no change row.
  const teamDomain = (await one(k, `insert into training_load.metric_domains (name, owner_scope, owner_team_id) values ('Team domain','team',$1) returning id`, [W.teamA1])).id;
  okTx(await tx(null, (c) => c.query(`update training_load.metric_domains set icon_url = 'icon:${a}' where id = $1`, [teamDomain])));
  assert.equal((await changesOf("domains", teamDomain)).length, 0);
  // Append-only, the icon columns included.
  for (const sql of [`update training_load.metric_classification_changes set new_icon_url = null where kind = 'icon'`, `delete from training_load.metric_classification_changes where kind = 'icon'`]) {
    refusedWith(await tx(W.caA.id, (c) => c.query(sql)), "23514", APPEND);
  }
  assert.deepEqual((await changesOf("domains", n.id)).map((x) => [x.kind, x.new_icon_url]), [["create", null], ["icon", `icon:${a}`], ["archive", `icon:${a}`]]);
});

test("8. the change record's own checks (with every trigger off, so only the table's checks speak): an icon row keeps the node active, its name and description, changes the icon to null or a library key's shape (at most 69 characters); a create starts with no old icon and a shaped new one; a rename, an archive and a restore keep the icon; a link's row carries none and never the kind icon", async () => {
  const insert = (fields) => tx(W.pa.id, async (c) => {
    await c.query("set local session_replication_role = replica");
    const row = { object_kind: "domain", kind: "icon", domain_id: W.sysDomain.id, category_id: null, metric_definition_id: null, link_id: null, owner_scope: "system",
      old_name: "N", new_name: "N", old_description: null, new_description: null, old_active: true, new_active: true, old_icon_url: null, new_icon_url: "icon:run", ...fields };
    const cols = Object.keys(row);
    await c.query(`insert into training_load.metric_classification_changes (${cols.join(", ")}, changed_by_user_id, xact_id)
      values (${cols.map((_, i) => `$${i + 1}`).join(", ")}, $${cols.length + 1}, pg_current_xact_id())`, [...Object.values(row), W.pa.id]);
    throw Object.assign(new Error("roll back the probe"), { probe: true });
  });
  const admitted = async (fields, label) => {
    const res = await insert(fields);
    assert.equal(res.error?.probe, true, `${label}: ${res.error?.message}`);
  };
  const refused = async (fields, constraint, label) => {
    const res = await insert(fields);
    assert.deepEqual([res.error?.code, res.error?.constraint], ["23514", constraint], label);
  };
  await admitted({}, "an icon row");
  await admitted({ old_icon_url: "icon:run", new_icon_url: null }, "an icon removed");
  await admitted({ new_icon_url: `icon:${"a".repeat(64)}` }, "69 characters");
  await admitted({ object_kind: "category", domain_id: null, category_id: W.sysCategory.id }, "a category's icon row");
  const KIND_SHAPE = "metric_classification_changes_kind_shape";
  await refused({ old_active: false, new_active: false }, KIND_SHAPE, "an archived node");
  await refused({ new_active: false }, KIND_SHAPE, "an icon with an archive");
  await refused({ old_active: false }, KIND_SHAPE, "an icon with a restore");
  await refused({ new_name: "Other" }, KIND_SHAPE, "an icon with a rename");
  await refused({ new_description: "Other" }, KIND_SHAPE, "an icon with a description");
  await refused({ old_icon_url: "icon:run" }, KIND_SHAPE, "the same icon");
  await refused({ old_name: null, new_name: null }, KIND_SHAPE, "no name");
  for (const value of ["/x.svg", "icon:Run", "icon:", "icon:run--x", `icon:${"a".repeat(65)}`]) await refused({ new_icon_url: value }, KIND_SHAPE, value);
  await admitted({ kind: "create", old_name: null, old_active: null, new_icon_url: "icon:run" }, "a create with an icon");
  await admitted({ kind: "create", old_name: null, old_active: null, new_icon_url: null }, "a create without");
  await refused({ kind: "create", old_name: null, old_active: null, old_icon_url: "icon:run" }, KIND_SHAPE, "a create with an old icon");
  await refused({ kind: "create", old_name: null, old_active: null, new_icon_url: "icon:Run" }, KIND_SHAPE, "a create with a bad icon");
  await admitted({ kind: "rename", new_name: "Other", new_icon_url: null }, "a rename");
  await refused({ kind: "rename", new_name: "Other" }, KIND_SHAPE, "a rename with an icon");
  await refused({ kind: "archive", new_active: false }, KIND_SHAPE, "an archive with an icon");
  await refused({ kind: "restore", old_active: false }, KIND_SHAPE, "a restore with an icon");
  await admitted({ kind: "archive", new_active: false, old_icon_url: "icon:run" }, "an archive keeping the icon");
  const linkRow = { object_kind: "link", kind: "link", domain_id: W.sysDomain.id, category_id: W.sysCategory.id, link_id: crypto.randomUUID(),
    old_name: null, new_name: null, old_active: null, new_active: null, new_icon_url: null };
  await admitted(linkRow, "a link's row");
  await refused({ ...linkRow, new_icon_url: "icon:run" }, "metric_classification_changes_shape", "a link's row with an icon");
  await refused({ ...linkRow, old_icon_url: "icon:run" }, "metric_classification_changes_shape", "a link's row with an old icon");
  await refused({ ...linkRow, kind: "icon" }, "metric_classification_changes_shape", "a link's row of kind icon");
  await refused({ kind: "unknown" }, "metric_classification_changes_kind_check", "an unknown kind");
});

test("9. no answer and no log line carries SQL, a trigger's or the database's text, a stored icon value or an acting user's id", async () => {
  const n = await node(W.caA, "domains");
  const [a] = ICON_KEYS;
  await plantIcon("domains", n.id, "icon:private-legacy-name");
  ok(await setIcon(W.caA, "domains", n.id, null, a));
  await setIcon(W.caA, "domains", n.id, null, a);
  // A database refusal through the route: a change without its request row.
  classification.setClassificationWriteHoldForTests(async (client, at) => {
    if (at === "domain_icon") await client.query(`update training_load.metric_domains set name = 'Sneaked' where id = $1`, [W.sysDomain.id]);
  });
  const sneaked = await setIcon(W.caA, "domains", n.id, a, ICON_KEYS[3]);
  classification.setClassificationWriteHoldForTests(null);
  assert.deepEqual([sneaked.status, sneaked.text], [500, '{"error":"internal_error","message":"Something went wrong."}']);
  assert.equal((await nodeRow("domains", n.id)).icon_url, `icon:${a}`, "nothing written");
  const everything = [...responses, ...logLines].join("\n");
  for (const forbidden of [/select |insert into|update training_load/i, /metric_classification_requests:|metric_classification_changes:|metric classification:/, /acting user/, /private-legacy-name/, /kind_shape|icon_rule/]) {
    assert.doesNotMatch(everything, forbidden);
  }
  for (const id of [W.caA.id, W.pa.id, W.paA.id]) assert.ok(!everything.includes(id), "no acting user's id");
});

test("10. v46 reads back the same after pg_dump and pg_restore (what gpexe-backup-verify compares): the two triggers, the checks of the four tables and the three functions", async () => {
  const target = await createDisposableDatabase({ prefix: "gpexe", label: "i1crt", baseDatabaseUrl: ORIGINAL_DATABASE_URL });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-i1c-roundtrip-"));
  const restored = new pg.Client({ connectionString: target.url });
  try {
    assert.match(target.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
    const u = new URL(db.url);
    const conn = ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username)];
    const env = { PATH: process.env.PATH, PGPASSWORD: decodeURIComponent(u.password) };
    const file = path.join(dir, "i1c.dump");
    execFileSync("pg_dump", [...conn, "-d", db.name, "-Fc", "-f", file], { env, stdio: "pipe" });
    execFileSync("pg_restore", [...conn, "--no-owner", "--no-privileges", "-d", target.name, file], { env, stdio: "pipe" });
    await restored.connect();
    const objects = async (c) => ({
      triggers: await rows(c, `select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'training_load' and not t.tgisinternal and t.tgname = any($1) order by 1, 2`, [ICON_TRIGGERS.map(([, n]) => n)]),
      constraints: await rows(c, `select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid in ('training_load.metric_classification_changes'::regclass, 'training_load.metric_classification_requests'::regclass)
           or conname in ('metric_domains_icon_rule', 'metric_categories_icon_rule') order by 1, 2`),
      functions: await rows(c, `select p.proname, md5(pg_get_functiondef(p.oid)) as digest, obj_description(p.oid, 'pg_proc') as comment from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'training_load' and p.proname = any($1) order by 1`, [ICON_FUNCTIONS]),
      columns: await rows(c, `select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema = 'training_load'
        and column_name like '%icon%' and table_name in ('metric_domains', 'metric_categories', 'metric_classification_changes') order by 1, 2`),
    });
    const source = await objects(k);
    assert.deepEqual([source.triggers.length, source.functions.length, source.columns.length], [2, 3, 4]);
    assert.deepEqual(await objects(restored), source);
  } finally {
    await restored.end().catch(() => {});
    await target.drop();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
