// Phase 12b - the domains and categories of canonical variables
// (backend/src/canonicalClassificationService.js, the routes
// GET /api/training-load/sources/metrics/classification and its writes, the C6
// filter and detail of the variable reads), and migration v41 (the key and
// description columns, the change and request records, the actor guards, the
// one-domain-per-category index). Through the real HTTP stack, on disposable
// optimove_tests_gpexe_* databases only (never OPTIMOVE): one migrated through
// v40 that rehearses v41's apply / rollback / re-apply, one migrated through
// v41 for the behaviour. Contract: docs/ai/phase12-domains-categories-contract.md
// (J6, accepted as C101 of docs/ai/gpexe-metric-variable-mapping-discovery.md).
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
const V41 = "202610281000_training_load_v41_metric_classification.sql";
const V41_NAME = `migrations_v2/${V41}`;
const V40_NAME = "migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql";
const UP_TO_V40 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V41));
const MIGRATION_PATH = path.resolve(ROOT, "migrations_v2", V41);
const ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/metric-classification-v41-rollback.sql");
const PREFLIGHT_PATH = path.resolve(ROOT, "docs/runbooks/metric-classification-v41-preflight.sql");
const POSTCHECK_PATH = path.resolve(ROOT, "docs/runbooks/metric-classification-v41-postcheck.sql");
const V40_ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/source-metric-text-rules-v40-rollback.sql");
const V39_ROLLBACK_PATH = path.resolve(ROOT, "docs/runbooks/source-metric-revision-lifecycle-v39-rollback.sql");
const PREFIX = "/api/training-load/sources/metrics";
const OLD = "/api/training-load/metrics";
const CTX = `select set_config('optimove.source_metric_actor', $1 || ':' || pg_current_xact_id()::text, true)`;
const NOT_FOUND = '{"error":"notFound"}';
const ch = (cp) => String.fromCodePoint(cp);
// The database's fixed messages (v41).
const NO_ACTOR = /no acting user is set for this transaction/;
const OTHER_USER = /^metric classification: the row names another user than the acting user$/;
const MAY_NOT = /^metric classification: the acting user may not write this owner scope$/;
const CREATED_ACTIVE = /^metric classification: a canonical domain or category is created active, with its key$/;
const NODE_TEXT = /^metric classification: a name or description is not bounded text$/;
const IDENTITY = /^metric classification: only the name, the description and the state of a canonical domain or category change$/;
const SEPARATE = /^metric classification: a rename, an archive and a restore are separate changes$/;
const NOTHING = /^metric classification: the change changes nothing$/;
const RESTORE_FIRST = /^metric classification: an archived domain or category is restored before it is renamed$/;
const NEVER_DELETED = /^metric classification: a canonical domain or category is archived, never deleted$/;
const LINK_UNCHANGED = /^metric classification: a canonical link is created or removed, never changed$/;
const LINK_TWO = /^metric classification: a canonical link names exactly two of a variable, a category and a domain$/;
const OUTSIDE = /^metric classification: a link reaches outside its owner$/;
const ARCHIVED_NODE = /^metric classification: a link never points at an archived domain or category$/;
const ARCHIVED_VARIABLE = /^metric classification: a link never points at an archived variable$/;
const CHANGE_ONLY = /^metric_classification_changes: a change row is written only by its own change$/;
const REQUEST_LINK = /^metric_classification_changes: a change is written with its own request row$/;
const REQUEST_USER = /^metric classification request: the row names another user than the acting user$/;
const REQUEST_MAY_NOT = /^metric classification request: the acting user may not write this owner scope$/;
const BASIS = /^metric classification request: the basis is not the acting user's own$/;
const FOLLOW = /^metric_classification_requests: the request must follow its own change in the same transaction$/;
const APPEND = /^metric classification: change and request records are append-only$/;
const NO_TRUNCATE = /^metric classification: a canonical link is removed one at a time, never truncated$/;
const READ_ONLY = { error: "System and club domains, categories and links can only be changed in Training Load > Data configuration.", code: "canonical_classification_read_only" };

let rdb, db, r, k, k2, server, apiBase, service, classification, appPool, createSession;
const W = {};
const logLines = [];
const responses = [];
const originalConsole = {};
const openGates = [];

async function applyV41(url) {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v41-migrations-"));
  const dir = path.join(tempRoot, "migrations_v2");
  await fsp.mkdir(dir);
  try {
    for (const f of UP_TO_V40) await fsp.copyFile(path.resolve(ROOT, "migrations_v2", f), path.join(dir, f));
    await fsp.copyFile(MIGRATION_PATH, path.join(dir, V41));
    await runner.runMigrations({ databaseUrl: url, migrationsRoot: dir });
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

before(async () => {
  assert.ok(GPEXE_TEST_MIGRATIONS.includes(V41), "v41 is a test migration");
  assert.equal(GPEXE_TEST_MIGRATIONS[GPEXE_TEST_MIGRATIONS.length - 1], V41, "v41 is the last test migration");
  [rdb, db] = await Promise.all([
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v41rb", migrations: UP_TO_V40 }),
    createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "p12b" }),
  ]);
  for (const d of [rdb, db]) assert.match(d.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  r = new pg.Client({ connectionString: rdb.url });
  k = new pg.Client({ connectionString: db.url });
  k2 = new pg.Client({ connectionString: db.url });
  await r.connect();
  await k.connect();
  await k2.connect();
  assert.equal((await r.query("select current_database() as d")).rows[0].d, rdb.name, "SAFETY");
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  assert.equal((await k.query(`select 1 from public.schema_migrations where migration_name = $1`, [V41_NAME])).rowCount, 1, "the behaviour database carries v41");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      if (process.env.P12B_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  service = await import("../src/sourceMetricMappingService.js");
  classification = await import("../src/canonicalClassificationService.js");
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
  for (const g of openGates.splice(0)) g.open();
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
  for (const c of [r, k, k2]) await c?.end().catch(() => {});
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
const tokenOf = (name, description, active) => crypto.createHash("sha256").update(JSON.stringify([name, description, active]), "utf8").digest("hex");

async function api(p, { method = "GET", body, cookie, base = PREFIX, contentType = "application/json" } = {}) {
  const res = await fetch(`${apiBase}${base}${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": contentType }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  // The hygiene test reads this API's answers (the older API's rows carry user ids by design).
  if (base === PREFIX) responses.push(text);
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, headers: res.headers, text };
}
const post = (p, cookie, body, opts = {}) => api(p, { method: "POST", cookie, body, ...opts });
const singular = (kind) => (kind === "domains" ? "domain" : "category");
const create = (who, kind, over = {}) => post(`/classification/${kind}`, who.cookie, { requestKey: key(), name: `${singular(kind)} ${uid()}`, ...over });
async function node(who, kind, over = {}) {
  const res = await create(who, kind, over);
  assert.equal(res.status, 201, res.text);
  return res.body[singular(kind)];
}
const domainOf = (who, over) => node(who, "domains", over);
const categoryOf = (who, over) => node(who, "categories", over);
const act = (who, kind, id, verb, body = {}) => post(`/classification/${kind}/${id}/${verb}`, who.cookie, { requestKey: key(), ...(verb === "archive" ? { reason: "No longer used" } : {}), ...body });
const link = (who, ids) => post("/classification/links", who.cookie, { requestKey: key(), ...ids });
async function linked(who, ids) {
  const res = await link(who, ids);
  assert.equal(res.status, 201, res.text);
  return res.body.link;
}
const unlink = (who, id, body = {}) => post(`/classification/links/${id}/remove`, who.cookie, { requestKey: key(), ...body });
async function tree(who) {
  const res = await api("/classification", { cookie: who.cookie });
  assert.equal(res.status, 200, res.text);
  return res.body;
}
async function variableDetail(who, id) {
  const res = await api(`/variables/${id}`, { cookie: who.cookie });
  assert.equal(res.status, 200, res.text);
  return res.body.variable;
}
async function variable(who, over = {}) {
  const res = await post("/variables", who.cookie, { requestKey: key(), label: `Total distance ${uid()}`, unit: "m", levels: ["session", "drill"], dailyAggregationMethod: "sum", ...over });
  assert.equal(res.status, 201, res.text);
  return res.body.variable;
}
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const changesWhere = (where, params) => rows(k, `select c.*, r.operation, r.basis, r.reason, r.requested_by_user_id, r.request_key, r.owner_scope as r_owner_scope, r.owner_club_id as r_owner_club_id
   from training_load.metric_classification_changes c left join training_load.metric_classification_requests r on r.metric_classification_change_id = c.id
  where ${where} order by c.seq`, params);
async function counts() {
  return one(k, `select (select count(*)::int from training_load.metric_classification_changes) as changes,
                        (select count(*)::int from training_load.metric_classification_requests) as requests,
                        (select count(*)::int from training_load.metric_domains) as domains,
                        (select count(*)::int from training_load.metric_categories) as categories,
                        (select count(*)::int from training_load.metric_structure_links) as links`);
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
  if (pattern) assert.match(res.error.message, pattern);
  return res.error;
}
const okTx = (res) => { assert.equal(res.ok, true, res.error ? `${res.error.code}: ${res.error.message}` : ""); return res.value; };
// Raw writes of the shape the service writes (inside tx): a node, a link, the
// change row the trigger wrote, and the request naming it.
async function rawNode(c, { kind = "domain", by, scope, clubId = null, name, description = null, nodeKey }) {
  const table = kind === "domain" ? "metric_domains" : "metric_categories";
  return (await one(c, `insert into training_load.${table} (name, description, key, owner_scope, owner_club_id, created_by_user_id) values ($1,$2,$3,$4,$5,$6) returning id`,
    [name ?? `Raw ${uid()}`, description, nodeKey === undefined ? `raw_${uid()}` : nodeKey, scope, clubId, by])).id;
}
async function rawLink(c, { by, scope, clubId = null, domainId = null, categoryId = null, variableId = null, smoothing = false }) {
  return (await one(c, `insert into training_load.metric_structure_links (domain_id, category_id, metric_definition_id, temporal_smoothing_enabled, owner_scope, owner_club_id, created_by_user_id)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`, [domainId, categoryId, variableId, smoothing, scope, clubId, by])).id;
}
const changeHere = async (c, column, id) => (await one(c, `select id from training_load.metric_classification_changes where ${column} = $1 and xact_id = pg_current_xact_id() order by seq desc limit 1`, [id]))?.id ?? null;
async function rawRequest(c, { by, operation, scope, clubId = null, basis, changeId, reason = null }) {
  await c.query(
    `insert into training_load.metric_classification_requests (request_key, requested_by_user_id, operation, request_hash, owner_scope, owner_club_id, basis, metric_classification_change_id, reason)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [key(), by, operation, "0".repeat(64), scope, clubId, basis, changeId, reason],
  );
}
// A legitimate raw create: the node, then its request.
async function rawCreate(c, { kind = "domain", by, scope, clubId = null, basis, ...rest }) {
  const id = await rawNode(c, { kind, by, scope, clubId, ...rest });
  await rawRequest(c, { by, operation: `${kind}_create`, scope, clubId, basis, changeId: await changeHere(c, `${kind}_id`, id) });
  return id;
}

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  const g = { promise, open };
  openGates.push(g);
  return g;
}
async function until(fn, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((res) => setTimeout(res, 20));
  }
  return false;
}
const someoneWaits = () => until(async () => (await one(k, `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`)).n > 0);

async function catalog(c) {
  const S = "('training_load', 'public', 'training')";
  return {
    tables: await rows(c, `select table_schema, table_name from information_schema.tables where table_schema in ${S} order by 1, 2`),
    columns: await rows(c, `select table_schema, table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema in ${S} order by 1, 2, 3`),
    constraints: await rows(c, `select n.nspname, c.conrelid::regclass::text as rel, c.conname, c.contype, c.condeferrable, c.condeferred, c.convalidated, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ${S} order by 1, 2, 3`),
    indexes: await rows(c, `select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ${S} order by 1, 2, 3`),
    triggers: await rows(c, `select n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled, t.tgdeferrable, t.tginitdeferred from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ${S} order by 1, 2, 3`),
    functions: await rows(c, `select n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) as args, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ${S} and p.prokind = 'f' order by 1, 2, 3`),
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

async function world() {
  W.clubA = await club("Club A");
  W.clubB = await club("Club B");
  W.clubC = await club("Club C");
  W.teamA1 = await team(W.clubA);
  W.teamB1 = await team(W.clubB);
  W.teamC = await team(W.clubC);
  W.teamArch = await team(W.clubA);
  W.pa = await person("platform-admin", { platform: true, ws: ["platform", null] });
  W.paA = await person("platform-admin-a", { platform: true, clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caA = await person("club-admin-a", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caA2 = await person("club-admin-a2", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  W.caB = await person("club-admin-b", { clubAdminOf: [W.clubB], ws: ["club", W.clubB] });
  W.caC = await person("club-admin-c", { clubAdminOf: [W.clubC], ws: ["club", W.clubC] });
  W.coachA1 = await person("coach-a1", { coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  W.coachB1 = await person("coach-b1", { coachOf: [W.teamB1], ws: ["team", W.teamB1] });
  W.coachC = await person("coach-c", { coachOf: [W.teamC], ws: ["team", W.teamC] });
  W.coachArch = await person("coach-archteam", { coachOf: [W.teamArch], ws: ["team", W.teamArch] });
  W.coachRevoked = await person("coach-revoked", { coachOf: [W.teamA1], roleActive: false, ws: ["team", W.teamA1] });
  W.caCoachA1 = await person("club-admin-coach", { clubAdminOf: [W.clubA], coachOf: [W.teamA1], ws: ["team", W.teamA1] });
  const athleteId = await user("athlete");
  await k.query(`insert into public.athletes (athlete_id, source_external_id, first_name, last_name, full_name, display_name, user_id, is_active) values ($1,$1,'Athlete','Only','Athlete Only','Athlete Only',$2,true)`, [`p12b${uid()}`, athleteId]);
  await workspace(athleteId, "athlete", null);
  W.athlete = { id: athleteId, cookie: await cookieFor(athleteId) };
  W.privateCoach = await person("private-coach", { platform: true, ws: ["private_coach", null] });
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [W.privateCoach.id]);
  W.sysVar = await variable(W.pa);
  W.clubVarA = await variable(W.caA);
  W.clubVarB = await variable(W.caB);
  await k.query(`update public.clubs set is_active = false where id = $1`, [W.clubC]);
  await k.query(`update public.teams set is_active = false where id = $1`, [W.teamArch]);
}

// ---------------------------------------------------------------------------
test("1. migration v41 on v40: two tables, two columns and two checks on each node table, three indexes, nine functions and sixteen triggers, nothing else changed; the read-only preflight and post-check; v41 refuses (changing nothing) while a system or club row exists, team and user rows do not stop it; the rollback refuses without v41, under a later migration, with a trigger or index missing or a trigger disabled, while a team row carries a key or description, and once a change or canonical row exists; it returns the identical v40 catalog and v41 applies again identically; the v40 and v39 rollbacks refuse while v41 is recorded", async () => {
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v41 rollback refused: v41 is not recorded on this database$/);
  const pre = await runbook(r, PREFLIGHT_PATH);
  assert.deepEqual(
    [pre.pg15_or_later, pre.v40_rows, pre.v40_checksum_ok, pre.v39_checksum_ok, pre.v41_rows, pre.at_or_after_v41, pre.last_migration,
      pre.v35_functions_needed, pre.text_rule, pre.v10_tables, pre.node_triggers, pre.link_triggers, pre.link_triggers_enabled,
      pre.v41_tables, pre.v41_columns, pre.v41_indexes, pre.v41_functions, pre.canonical_domains, pre.canonical_categories, pre.canonical_links,
      pre.schema_create, pre.owns_v10_tables, pre.coach_domains, pre.coach_categories, pre.coach_links, pre.conflicting_locks, pre.idle_in_transaction],
    [true, "1", true, true, "0", "0", V40_NAME, "3", "1", "3", "0", "1", "1", "0", "0", "0", "0", "0", "0", "0", true, "3", "0", "0", "0", "0", "0"],
  );
  const before40 = await catalog(r);
  // Fail closed (C101): a system or club row written after the count stops v41
  // with a fixed message (counts only), and nothing of v41 is applied. A team
  // row does not stop it.
  const pa = (await one(r, `insert into public.users (email, full_name, display_name, is_active) values ($1,'pa','pa',true) returning id`, [`v41rb-${uid()}@test.local`])).id;
  await r.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [pa]);
  const clubR = (await one(r, `insert into public.clubs (name) values ('Club R') returning id`)).id;
  const teamR = (await one(r, `insert into public.teams (club_id, name) values ($1,'Team R') returning id`, [clubR])).id;
  const stray = (await one(r, `insert into training_load.metric_categories (name, owner_scope, owner_club_id) values ('Stray','club',$1) returning id`, [clubR])).id;
  await assert.rejects(applyV41(rdb.url), (e) => e.cause?.code === "23514"
    && /^v41 refused: canonical classification rows exist \(domains 0, categories 1, links 0\)$/.test(e.cause.message) && !/Stray/.test(e.cause.message));
  assert.deepEqual(await catalog(r), before40, "a refused v41 applies nothing");
  await r.query(`delete from training_load.metric_categories where id = $1`, [stray]);
  const teamRow = (await one(r, `insert into training_load.metric_domains (name, owner_scope, owner_team_id) values ('Team domain','team',$1) returning id`, [teamR])).id;
  await applyV41(rdb.url);
  assert.equal((await one(r, `select key, description from training_load.metric_domains where id = $1`, [teamRow])).key, null, "a team row keeps a NULL key");
  // The read-only post-check: its checksum is the file's, every object in place.
  const checksum = crypto.createHash("sha256").update(await fsp.readFile(MIGRATION_PATH)).digest("hex");
  assert.ok((await fsp.readFile(POSTCHECK_PATH, "utf8")).includes(`checksum = '${checksum}'`), "the post-check names v41's checksum");
  const post41 = await runbook(r, POSTCHECK_PATH);
  assert.deepEqual(
    [post41.v41_rows, post41.v41_checksum_ok, post41.later_rows, post41.last_migration, post41.v40_rows, post41.v41_tables, post41.v41_columns,
      post41.v41_checks_validated, post41.v41_indexes_valid, post41.v41_functions, post41.v41_triggers_enabled, post41.deferred_triggers,
      post41.changes, post41.requests, post41.canonical_domains, post41.canonical_categories, post41.canonical_links, post41.locks_on_v41_tables, post41.idle_in_transaction],
    ["1", true, "0", V41_NAME, "1", "2", "4", "4", "3", "9", "16", "1", "0", "0", "0", "0", "0", "0", "0"],
  );
  const after41 = await catalog(r);
  const added = (list, base, keyOf) => list.filter((x) => !base.some((y) => keyOf(y) === keyOf(x)));
  const changed = (list, base, keyOf) => list.filter((x) => base.some((y) => keyOf(y) === keyOf(x) && JSON.stringify(y) !== JSON.stringify(x)));
  const NEW_TABLES = ["metric_classification_changes", "metric_classification_requests"];
  assert.deepEqual(added(after41.tables, before40.tables, (x) => x.table_name).map((x) => x.table_name), NEW_TABLES);
  const colKey = (x) => `${x.table_name}.${x.column_name}`;
  assert.deepEqual(added(after41.columns, before40.columns, colKey).filter((x) => !NEW_TABLES.includes(x.table_name)).map((x) => [colKey(x), x.data_type, x.is_nullable]), [
    ["metric_categories.description", "text", "YES"], ["metric_categories.key", "text", "YES"],
    ["metric_domains.description", "text", "YES"], ["metric_domains.key", "text", "YES"],
  ]);
  assert.deepEqual(changed(after41.columns, before40.columns, colKey), [], "no existing column changed");
  const conKey = (x) => `${x.rel}.${x.conname}`;
  assert.deepEqual(added(after41.constraints, before40.constraints, conKey).filter((x) => !NEW_TABLES.some((t) => x.rel.endsWith(t))).map(conKey).sort(), [
    "training_load.metric_categories.metric_categories_canonical_key", "training_load.metric_categories.metric_categories_key_rule",
    "training_load.metric_domains.metric_domains_canonical_key", "training_load.metric_domains.metric_domains_key_rule",
  ]);
  assert.deepEqual(changed(after41.constraints, before40.constraints, conKey), [], "no existing constraint changed");
  assert.deepEqual(added(after41.indexes, before40.indexes, (x) => x.indexname).filter((x) => !NEW_TABLES.includes(x.tablename)).map((x) => x.indexname).sort(), [
    "metric_categories_canonical_key_unique", "metric_domains_canonical_key_unique", "metric_structure_links_one_domain_per_category",
  ]);
  assert.deepEqual(changed(after41.indexes, before40.indexes, (x) => x.indexname), [], "no existing index changed");
  assert.deepEqual(added(after41.functions, before40.functions, (x) => x.proname).map((x) => x.proname).sort(), [
    "metric_classification_append_only", "metric_classification_changes_insert_guard", "metric_classification_changes_request_link",
    "metric_classification_link_guard", "metric_classification_links_no_truncate", "metric_classification_node_guard", "metric_classification_record_link",
    "metric_classification_record_node_change", "metric_classification_requests_guard",
  ]);
  assert.deepEqual(changed(after41.functions, before40.functions, (x) => `${x.proname}(${x.args})`), [], "no existing function changed (v35's and v40's included)");
  const trgKey = (x) => `${x.relname}.${x.tgname}`;
  const newTriggers = added(after41.triggers, before40.triggers, trgKey);
  assert.deepEqual(newTriggers.map(trgKey).sort(), [
    "metric_categories.metric_categories_v41_guard", "metric_categories.metric_categories_v41_record_change", "metric_categories.metric_categories_v41_record_create",
    "metric_classification_changes.metric_classification_changes_insert_guard", "metric_classification_changes.metric_classification_changes_no_truncate",
    "metric_classification_changes.metric_classification_changes_no_update_delete", "metric_classification_changes.metric_classification_changes_request_link",
    "metric_classification_requests.metric_classification_requests_guard", "metric_classification_requests.metric_classification_requests_no_truncate",
    "metric_classification_requests.metric_classification_requests_no_update_delete",
    "metric_domains.metric_domains_v41_guard", "metric_domains.metric_domains_v41_record_change", "metric_domains.metric_domains_v41_record_create",
    "metric_structure_links.metric_structure_links_v41_guard", "metric_structure_links.metric_structure_links_v41_no_truncate",
    "metric_structure_links.metric_structure_links_v41_record_link",
  ]);
  for (const t of newTriggers) assert.equal(t.tgenabled, "O", t.tgname);
  assert.deepEqual(newTriggers.filter((t) => t.tgdeferrable).map((t) => [t.tgname, t.tginitdeferred]), [["metric_classification_changes_request_link", true]]);
  assert.deepEqual(changed(after41.triggers, before40.triggers, trgKey), [], "no existing trigger changed (v10's breadth trigger included)");
  // The link guard runs after v10's breadth trigger (same timing, name order).
  assert.ok("metric_structure_links_scope_breadth" < "metric_structure_links_v41_guard");
  // v41 depends on v40's and v39's being recorded before it.
  assert.match((await runScript(r, V40_ROLLBACK_PATH))?.message ?? "", /^v40 rollback refused: later migrations are applied/);
  assert.match((await runScript(r, V39_ROLLBACK_PATH))?.message ?? "", /^v39 rollback refused: .*later migrations are applied/);
  // Refusals, each changing nothing.
  await r.query(`insert into public.schema_migrations (migration_name, checksum, runner_version) values ('migrations_v2/202610281001_training_load_v42_test_only.sql', $1, 'test')`, ["0".repeat(64)]);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v41 rollback refused: later migrations are applied$/);
  await r.query(`delete from public.schema_migrations where migration_name = 'migrations_v2/202610281001_training_load_v42_test_only.sql'`);
  for (const [rel, trigger] of [["metric_domains", "metric_domains_v41_guard"], ["metric_structure_links", "metric_structure_links_v41_record_link"], ["metric_classification_changes", "metric_classification_changes_request_link"], ["metric_classification_requests", "metric_classification_requests_no_truncate"]]) {
    await r.query(`alter table training_load.${rel} disable trigger ${trigger}`);
    assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v41 rollback refused: a v41 trigger is disabled$/, trigger);
    await r.query(`alter table training_load.${rel} enable trigger ${trigger}`);
  }
  const trigDef = (await one(r, `select pg_get_triggerdef(t.oid) as def from pg_trigger t where t.tgname = 'metric_categories_v41_record_change'`)).def;
  await r.query(`drop trigger metric_categories_v41_record_change on training_load.metric_categories`);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v41 rollback refused: the v41 triggers are not all present$/);
  await r.query(trigDef);
  const indexDef = (await one(r, `select indexdef from pg_indexes where indexname = 'metric_structure_links_one_domain_per_category'`)).indexdef;
  await r.query(`drop index training_load.metric_structure_links_one_domain_per_category`);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v41 rollback refused: the v41 indexes are not all present$/);
  await r.query(indexDef);
  await r.query(`update training_load.metric_domains set key = 'team_key' where id = $1`, [teamRow]);
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v41 rollback refused: a team or user domain or category carries a key or a description$/);
  await r.query(`update training_load.metric_domains set key = null where id = $1`, [teamRow]);
  assert.deepEqual(await catalog(r), after41, "every refusal changed nothing");
  // The rehearsal: rollback -> the identical v40 catalog -> re-apply -> identical.
  assert.equal(await runScript(r, ROLLBACK_PATH), null);
  assert.deepEqual(await catalog(r), before40, "the rollback returns the v40 catalog exactly");
  await applyV41(rdb.url);
  assert.deepEqual(await catalog(r), after41, "v41 applies again identically");
  // Once a canonical row and its records exist the rollback refuses.
  okTx(await tx(pa, (c) => rawCreate(c, { by: pa, scope: "system", basis: "platform_admin" }), r));
  assert.match((await runScript(r, ROLLBACK_PATH))?.message ?? "", /^v41 rollback refused: change or request records exist; canonical classification rows exist$/);
  assert.deepEqual(await catalog(r), after41);
});

test("2. who may do what: the platform admin (system in the platform workspace, club in a club's) and the club's own admin write; a team coach reads the club's classification and gets the byte-identical 404 on every write, before the body is looked at; another club's admin, an archived club or team, a revoked role, an athlete and a private-coaching workspace (even a platform admin's) get the identical 404 on every route; without a session 401", async () => {
  const dA = await domainOf(W.caA);
  const cA = await categoryOf(W.caA);
  const lA = await linked(W.caA, { variableId: W.clubVarA.id, categoryId: cA.id });
  const sysD = await domainOf(W.pa);
  const before = await counts();
  const writes = (target) => [
    ["POST", "/classification/domains", { requestKey: key(), name: `X ${uid()}` }],
    ["POST", "/classification/categories", { requestKey: key(), name: `X ${uid()}` }],
    ["POST", `/classification/domains/${target.d}/rename`, { requestKey: key(), namesToken: target.token, name: `Y ${uid()}` }],
    ["POST", `/classification/domains/${target.d}/archive`, { requestKey: key(), reason: "x" }],
    ["POST", `/classification/domains/${target.d}/restore`, { requestKey: key() }],
    ["POST", `/classification/categories/${target.c}/rename`, { requestKey: key(), namesToken: target.token, name: `Y ${uid()}` }],
    ["POST", `/classification/categories/${target.c}/archive`, { requestKey: key(), reason: "x" }],
    ["POST", `/classification/categories/${target.c}/restore`, { requestKey: key() }],
    ["POST", "/classification/links", { requestKey: key(), variableId: W.clubVarA.id, categoryId: target.c }],
    ["POST", `/classification/links/${target.l}/remove`, { requestKey: key() }],
  ];
  const target = { d: dA.id, c: cA.id, l: lA.id, token: dA.namesToken };
  for (const who of [W.athlete, W.privateCoach, W.coachRevoked, W.coachArch, W.coachC, W.caC]) {
    const read = await api("/classification", { cookie: who.cookie });
    assert.deepEqual([read.status, read.text], [404, NOT_FOUND], "read");
    for (const [method, p, body] of writes(target)) {
      const res = await api(p, { method, cookie: who.cookie, body });
      assert.deepEqual([res.status, res.text], [404, NOT_FOUND], `${p}`);
    }
  }
  // A team coach: the read, read-only; every write the same 404, also with a
  // body that is not JSON or not an object (404 before 415 / 400).
  for (const who of [W.coachA1, W.caCoachA1]) {
    const view = await tree(who);
    const mine = view.domains.find((x) => x.id === dA.id);
    assert.deepEqual([mine.editable, mine.actions], [false, []]);
    assert.ok(view.domains.some((x) => x.id === sysD.id));
    for (const [method, p, body] of writes(target)) {
      for (const sent of [{ body }, { body: "plain", contentType: "text/plain" }, { body: [1] }]) {
        const res = await api(p, { method, cookie: who.cookie, ...sent });
        assert.deepEqual([res.status, res.text], [404, NOT_FOUND], `${p}`);
      }
    }
  }
  // Another club's admin: the identical 404 on the club's objects, and none of
  // them in its read.
  const viewB = await tree(W.caB);
  assert.ok(![...viewB.domains, ...viewB.categories].some((x) => [dA.id, cA.id].includes(x.id)));
  for (const [method, p, body] of writes(target).slice(2)) {
    const res = await api(p, { method, cookie: W.caB.cookie, body });
    assert.deepEqual([res.status, res.text], [404, NOT_FOUND], `${p}`);
  }
  // The platform admin in the platform workspace writes system rows only: a
  // club's objects are not its workspace's (the identical 404).
  for (const [method, p, body] of writes(target).slice(2)) {
    const res = await api(p, { method, cookie: W.pa.cookie, body });
    assert.deepEqual([res.status, res.text], [404, NOT_FOUND], `platform workspace: ${p}`);
  }
  assert.deepEqual(await counts(), before, "no refused call wrote anything");
  // An admin: 415 for a body that is not JSON, 400 for one that is not an
  // object; an unknown kind or a malformed id is the identical 404.
  assert.equal((await api("/classification/domains", { method: "POST", cookie: W.caA.cookie, body: "x", contentType: "text/plain" })).status, 415);
  assert.deepEqual([(await api("/classification/domains", { method: "POST", cookie: W.caA.cookie, body: [1] })).body.error], ["invalid_body"]);
  for (const p of ["/classification/widgets", "/classification/links/rename", "/classification/domains/not-a-uuid/rename", `/classification/links/${dA.id}/archive`, "/classification/links/not-a-uuid/remove"]) {
    const res = await post(p, W.caA.cookie, { requestKey: key(), reason: "x", namesToken: "0".repeat(64), name: "n" });
    assert.deepEqual([res.status, res.text], [404, NOT_FOUND], p);
  }
  // A system node in a club's workspace is read-only there (the identical 404 on a write).
  assert.deepEqual([(await act(W.caA, "domains", sysD.id, "archive")).text], [NOT_FOUND]);
  assert.deepEqual([(await act(W.paA, "domains", sysD.id, "archive")).text], [NOT_FOUND]);
  // Without a session.
  for (const [method, p, body] of [["GET", "/classification"], ...writes(target)]) {
    assert.equal((await api(p, { method, body })).status, 401, p);
  }
  // Who writes: the club's own admin and a platform admin in that club's
  // workspace (club rows), a platform admin in the platform workspace (system rows).
  ok(await act(W.caA2, "domains", dA.id, "archive"));
  ok(await act(W.paA, "domains", dA.id, "restore"));
  ok(await act(W.pa, "domains", sysD.id, "archive"));
  assert.deepEqual((await changesWhere("c.domain_id = any($1)", [[dA.id, sysD.id]])).map((x) => [x.kind, x.basis, x.requested_by_user_id]), [
    ["create", "club_admin", W.caA.id], ["create", "platform_admin", W.pa.id], ["archive", "club_admin", W.caA2.id], ["restore", "platform_admin", W.paA.id], ["archive", "platform_admin", W.pa.id],
  ]);
});

test("3. C1, the read: the platform workspace reads the system's domains and categories; a club's workspace the system's (read-only) and its own, never another club's; a team coach the club's and the system's, read-only; every node carries its key, name, description, owner, state, actions and names token; only category -> domain links are listed; an unknown query parameter is 400", async () => {
  const sys = await domainOf(W.pa, { description: "The system's domain" });
  const own = await categoryOf(W.caA);
  const other = await categoryOf(W.caB);
  const placed = await linked(W.caA, { categoryId: own.id, domainId: sys.id });
  await linked(W.caA, { variableId: W.clubVarA.id, categoryId: own.id });
  const platform = await tree(W.pa);
  assert.ok(platform.domains.some((x) => x.id === sys.id) && !platform.categories.some((x) => [own.id, other.id].includes(x.id)));
  assert.ok(platform.domains.every((x) => x.ownerScope === "system") && platform.categories.every((x) => x.ownerScope === "system"));
  assert.ok(!platform.categoryDomains.some((x) => x.id === placed.id), "a club's link is not the platform workspace's");
  const a = await tree(W.caA);
  const sysInA = a.domains.find((x) => x.id === sys.id);
  assert.deepEqual(sysInA, {
    id: sys.id, key: sys.key, name: sys.name, description: "The system's domain", ownerScope: "system", state: "active",
    editable: false, actions: [], namesToken: tokenOf(sys.name, "The system's domain", true), truncated: false,
  });
  const ownInA = a.categories.find((x) => x.id === own.id);
  assert.deepEqual([ownInA.editable, ownInA.actions, ownInA.ownerScope, ownInA.namesToken], [true, ["rename", "archive"], "club", tokenOf(own.name, null, true)]);
  assert.ok(!a.categories.some((x) => x.id === other.id), "never another club's");
  assert.deepEqual(a.categoryDomains.filter((x) => x.id === placed.id), [{ id: placed.id, variableId: null, categoryId: own.id, domainId: sys.id, ownerScope: "club", editable: true, actions: ["remove"] }]);
  assert.ok(a.categoryDomains.every((x) => x.variableId === null), "only category -> domain links");
  assert.equal(a.truncated, false);
  const coach = await tree(W.coachA1);
  assert.ok(coach.categories.some((x) => x.id === own.id && !x.editable) && coach.domains.some((x) => x.id === sys.id));
  assert.ok(coach.categoryDomains.some((x) => x.id === placed.id && !x.editable && x.actions.length === 0));
  assert.ok(!coach.categories.some((x) => x.id === other.id));
  // An archived node is listed with its state and the restore action.
  ok(await act(W.caA, "categories", own.id, "archive"));
  const archived = (await tree(W.caA)).categories.find((x) => x.id === own.id);
  assert.deepEqual([archived.state, archived.actions], ["archived", ["restore"]]);
  ok(await act(W.caA, "categories", own.id, "restore"));
  const bad = await api("/classification?scope=own", { cookie: W.caA.cookie });
  assert.deepEqual([bad.status, bad.body.error], [400, "invalid_query"]);
  assert.deepEqual([(await api("/classification?x=1", { cookie: W.coachA1.cookie })).status], [400]);
});

test("4. C2, a create: the key suggested from the name or given (M3-0's rule), unique per owner and kind (409 key_taken), free across owners; the text rule on the name (80) and description (500); the body never names an owner, actor or basis; the change row (the database's) and the request row (basis derived) carry what was written", async () => {
  const tag = uid();
  const d = await domainOf(W.caA, { name: `High speed ${tag}` });
  assert.deepEqual([d.key, d.name, d.description, d.state, d.ownerScope, d.editable, d.actions], [`high_speed_${tag}`, `High speed ${tag}`, null, "active", "club", true, ["rename", "archive"]]);
  const given = await categoryOf(W.caA, { name: "Endurance", key: `endurance_${tag}`, description: "Aerobic work" });
  assert.deepEqual([given.key, given.description], [`endurance_${tag}`, "Aerobic work"]);
  // Unique per owner and kind; the same key is free in the other kind, another club and the system.
  const taken = await create(W.caA2, "domains", { name: `Other ${tag}`, key: d.key });
  assert.deepEqual([taken.status, taken.body.error], [409, "key_taken"]);
  await categoryOf(W.caA, { name: `Other ${tag}`, key: d.key });
  await domainOf(W.caB, { name: `High speed ${tag}` });
  await domainOf(W.pa, { name: `High speed ${tag}` });
  assert.deepEqual([(await create(W.paA, "domains", { name: `High speed ${tag}` })).body.error], ["key_taken"], "a platform admin in club A's workspace writes club A's rows");
  // 400s, nothing written.
  const before = await counts();
  for (const [body, error] of [
    [{ name: "123" }, "key_required"],
    [{ name: "Fine", key: "Bad-Key" }, "invalid_body"],
    [{ name: "Fine", key: "" }, "invalid_body"],
    [{ name: "Fine", key: `a${"b".repeat(63)}` }, "invalid_body"],
    [{ name: `Zero${ch(0x200b)}width` }, "invalid_body"],
    [{ name: `Bidi${ch(0x202e)}x` }, "invalid_body"],
    [{ name: " Padded" }, "invalid_body"],
    [{ name: "x".repeat(81) }, "invalid_body"],
    [{ name: "Fine", description: "d".repeat(501) }, "invalid_body"],
    [{ name: "Fine", description: "" }, "invalid_body"],
    [{ name: "Fine", ownerScope: "system" }, "invalid_body"],
    [{ name: "Fine", basis: "platform_admin" }, "invalid_body"],
    [{ name: 7 }, "invalid_body"],
    [{ requestKey: "not-a-uuid", name: "Fine" }, "invalid_body"],
  ]) {
    const res = await post("/classification/domains", W.caA.cookie, { requestKey: key(), ...body });
    assert.deepEqual([res.status, res.body.error], [400, error], JSON.stringify(body));
  }
  assert.deepEqual(await counts(), before, "nothing written");
  // 80 and 500 characters are fine; a description may be null.
  await domainOf(W.caA, { name: "x".repeat(80), key: `long_${tag}`, description: "d".repeat(500) });
  await domainOf(W.caA, { name: `Null description ${tag}`, description: null });
  // The records.
  const viaPlatform = await categoryOf(W.paA, { name: `Platform made ${tag}` });
  const recorded = await changesWhere("c.domain_id = $1 or c.category_id = any($2)", [d.id, [given.id, viaPlatform.id]]);
  assert.deepEqual(recorded.map((x) => [x.object_kind, x.kind, x.owner_scope, x.owner_club_id, x.old_name, x.new_name, x.new_description, x.old_active, x.new_active, x.changed_by_user_id, x.operation, x.basis, x.reason, x.r_owner_scope, x.r_owner_club_id]), [
    ["domain", "create", "club", W.clubA, null, d.name, null, null, true, W.caA.id, "domain_create", "club_admin", null, "club", W.clubA],
    ["category", "create", "club", W.clubA, null, "Endurance", "Aerobic work", null, true, W.caA.id, "category_create", "club_admin", null, "club", W.clubA],
    ["category", "create", "club", W.clubA, null, viaPlatform.name, null, null, true, W.paA.id, "category_create", "platform_admin", null, "club", W.clubA],
  ]);
  const sys = await domainOf(W.pa);
  assert.deepEqual((await changesWhere("c.domain_id = $1", [sys.id])).map((x) => [x.owner_scope, x.owner_club_id, x.basis]), [["system", null, "platform_admin"]]);
  assert.deepEqual({ ...(await one(k, `select created_by_user_id, owner_user_id, owner_team_id, is_active from training_load.metric_domains where id = $1`, [d.id])) }, { created_by_user_id: W.caA.id, owner_user_id: null, owner_team_id: null, is_active: true });
});

test("5. C3, rename, archive and restore: a rename names the token it read and changes the name, the description or both (null clears it); a stale token is 409 node_changed with the current node, an unchanged rename 409 rename_unchanged; archive takes a reason, restore an optional one; the state rules (node_not_active, node_active); the text rule applies only to a value that changes (a stored name the rule refuses stays until renamed); every act its change row with the old and new values", async () => {
  const d = await domainOf(W.caA, { description: "First" });
  const renamed = ok(await act(W.caA, "domains", d.id, "rename", { namesToken: d.namesToken, name: `Renamed ${uid()}` })).domain;
  assert.deepEqual([renamed.description, renamed.key, renamed.namesToken], [d.description, d.key, tokenOf(renamed.name, "First", true)]);
  const stale = await act(W.caA, "domains", d.id, "rename", { namesToken: d.namesToken, name: "Late" });
  assert.deepEqual([stale.status, stale.body.error, stale.body.current?.id, stale.body.current?.name], [409, "node_changed", d.id, renamed.name]);
  const described = ok(await act(W.caA, "domains", d.id, "rename", { namesToken: renamed.namesToken, description: "Second" })).domain;
  const cleared = ok(await act(W.caA, "domains", d.id, "rename", { namesToken: described.namesToken, description: null })).domain;
  assert.equal(cleared.description, null);
  const both = ok(await act(W.caA, "domains", d.id, "rename", { namesToken: cleared.namesToken, name: `Both ${uid()}`, description: "Third" })).domain;
  for (const [body, status, error] of [
    [{ namesToken: both.namesToken, name: both.name }, 409, "rename_unchanged"],
    [{ namesToken: both.namesToken, name: both.name, description: "Third" }, 409, "rename_unchanged"],
    [{ namesToken: both.namesToken }, 400, "invalid_body"],
    [{ namesToken: "nope", name: "x" }, 400, "invalid_body"],
    [{ namesToken: both.namesToken, name: null }, 400, "invalid_body"],
    [{ namesToken: both.namesToken, name: `Bad${ch(0x200b)}` }, 400, "invalid_body"],
    [{ namesToken: both.namesToken, name: "x".repeat(81) }, 400, "invalid_body"],
    [{ namesToken: both.namesToken, description: "" }, 400, "invalid_body"],
    [{ namesToken: both.namesToken, name: "x", key: "new_key" }, 400, "invalid_body"],
  ]) {
    const res = await act(W.caA, "domains", d.id, "rename", body);
    assert.deepEqual([res.status, res.body.error], [status, error], JSON.stringify(body));
  }
  // Archive and restore.
  assert.deepEqual([(await post(`/classification/domains/${d.id}/archive`, W.caA.cookie, { requestKey: key() })).body.error], ["invalid_body"], "archive takes a reason");
  for (const reason of [" padded", null, 7, ""]) {
    const res = await act(W.caA, "domains", d.id, "archive", { reason });
    assert.deepEqual([res.status, res.body.error], [400, "invalid_body"], JSON.stringify(reason));
  }
  const archived = ok(await act(W.caA, "domains", d.id, "archive", { reason: "Merged into speed" })).domain;
  assert.deepEqual([archived.state, archived.actions, archived.editable], ["archived", ["restore"], true]);
  assert.deepEqual([(await act(W.caA, "domains", d.id, "archive")).body.error], ["node_not_active"]);
  assert.deepEqual([(await act(W.caA, "domains", d.id, "rename", { namesToken: archived.namesToken, name: "While archived" })).body.error], ["node_not_active"]);
  const restored = ok(await act(W.caA, "domains", d.id, "restore", { reason: "Needed again" })).domain;
  assert.equal(restored.state, "active");
  assert.deepEqual([(await act(W.caA, "domains", d.id, "restore")).body.error], ["node_active"]);
  ok(await act(W.caA, "domains", d.id, "archive"));
  ok(await act(W.caA, "domains", d.id, "restore"));
  assert.deepEqual((await changesWhere("c.domain_id = $1", [d.id])).map((x) => [x.kind, x.old_name === x.new_name, x.old_description, x.new_description, x.old_active, x.new_active, x.operation, x.reason]), [
    ["create", false, null, "First", null, true, "domain_create", null],
    ["rename", false, "First", "First", true, true, "domain_rename", null],
    ["rename", true, "First", "Second", true, true, "domain_rename", null],
    ["rename", true, "Second", null, true, true, "domain_rename", null],
    ["rename", false, null, "Third", true, true, "domain_rename", null],
    ["archive", true, "Third", "Third", true, false, "domain_archive", "Merged into speed"],
    ["restore", true, "Third", "Third", false, true, "domain_restore", "Needed again"],
    ["archive", true, "Third", "Third", true, false, "domain_archive", "No longer used"],
    ["restore", true, "Third", "Third", false, true, "domain_restore", null],
  ]);
  // A stored name the text rule refuses (a fixture written with v41's
  // triggers off): exempt while it stays as it is.
  const legacyName = `Legacy${ch(0x200b)}name ${uid()}`;
  await k.query("begin");
  for (const t of ["metric_categories_v41_guard", "metric_categories_v41_record_create"]) await k.query(`alter table training_load.metric_categories disable trigger ${t}`);
  const legacy = (await one(k, `insert into training_load.metric_categories (name, key, owner_scope, owner_club_id, created_by_user_id) values ($1,$2,'club',$3,$4) returning id`, [legacyName, `legacy_${uid()}`, W.clubA, W.caA.id])).id;
  for (const t of ["metric_categories_v41_guard", "metric_categories_v41_record_create"]) await k.query(`alter table training_load.metric_categories enable trigger ${t}`);
  await k.query("commit");
  const token = tokenOf(legacyName, null, true);
  ok(await act(W.caA, "categories", legacy, "rename", { namesToken: token, description: "Described" }));
  const token2 = tokenOf(legacyName, "Described", true);
  ok(await act(W.caA, "categories", legacy, "rename", { namesToken: token2, name: legacyName, description: "Again" }), 200);
  assert.deepEqual([(await act(W.caA, "categories", legacy, "rename", { namesToken: tokenOf(legacyName, "Again", true), name: `Other${ch(0x200b)}` })).body.error], ["invalid_body"]);
  ok(await act(W.caA, "categories", legacy, "archive"));
  ok(await act(W.caA, "categories", legacy, "restore"));
  ok(await act(W.caA, "categories", legacy, "rename", { namesToken: tokenOf(legacyName, "Again", true), name: `Clean ${uid()}` }));
});

test("6. C4, a link: the three shapes (variable -> category, variable -> domain, category -> domain); exactly two ids (400); O4 - a club links its own and the system's variables into its own categories and domains and its own categories under a system domain, never into a system category or domain, the system only system targets, another club's targets are the identical 404; O3 - a category under one domain only, whoever owns the domain (409 category_has_domain); an archived node or variable is refused (409); the same link twice is 409 link_exists; a variable may sit under several categories and domains; the change and request rows carry the link", async () => {
  const sysD = await domainOf(W.pa);
  const sysC = await categoryOf(W.pa);
  const ownD = await domainOf(W.caA);
  const ownD2 = await domainOf(W.caA);
  const ownC = await categoryOf(W.caA);
  const ownC2 = await categoryOf(W.caA);
  const otherC = await categoryOf(W.caB);
  // The three shapes, and O4's allowed cross-owner ones.
  const varCat = await linked(W.caA, { variableId: W.clubVarA.id, categoryId: ownC.id });
  assert.deepEqual([varCat.variableId, varCat.categoryId, varCat.domainId, varCat.ownerScope, varCat.editable, varCat.actions, varCat.present], [W.clubVarA.id, ownC.id, null, "club", true, ["remove"], true]);
  await linked(W.caA, { variableId: W.sysVar.id, categoryId: ownC.id });
  await linked(W.caA, { variableId: W.clubVarA.id, domainId: ownD.id });
  await linked(W.caA, { variableId: W.sysVar.id, domainId: ownD.id });
  await linked(W.caA, { categoryId: ownC.id, domainId: sysD.id });
  await linked(W.caA, { categoryId: ownC2.id, domainId: ownD.id });
  await linked(W.caA, { variableId: W.clubVarA.id, categoryId: ownC2.id });
  await linked(W.pa, { variableId: W.sysVar.id, categoryId: sysC.id });
  await linked(W.pa, { categoryId: sysC.id, domainId: sysD.id });
  const before = await counts();
  // O4: refused shapes.
  for (const ids of [
    { variableId: W.clubVarA.id, categoryId: sysC.id },
    { variableId: W.clubVarA.id, domainId: sysD.id },
    { categoryId: sysC.id, domainId: ownD.id },
  ]) {
    const res = await link(W.caA, ids);
    assert.deepEqual([res.status, res.body.error], [409, "link_outside_owner"], JSON.stringify(ids));
  }
  // Another club's target, or a club's target in the platform workspace: the identical 404.
  for (const [who, ids] of [
    [W.caA, { variableId: W.clubVarA.id, categoryId: otherC.id }],
    [W.caA, { variableId: W.clubVarB.id, categoryId: ownC.id }],
    [W.caB, { categoryId: otherC.id, domainId: ownD.id }],
    [W.pa, { variableId: W.clubVarA.id, categoryId: sysC.id }],
    [W.pa, { categoryId: ownC.id, domainId: sysD.id }],
    [W.caA, { variableId: crypto.randomUUID(), categoryId: ownC.id }],
  ]) {
    const res = await link(who, ids);
    assert.deepEqual([res.status, res.text], [404, NOT_FOUND], JSON.stringify(ids));
  }
  // The shape: exactly two ids.
  for (const ids of [{}, { variableId: W.clubVarA.id }, { variableId: W.clubVarA.id, categoryId: ownC.id, domainId: ownD.id }, { variableId: "x", categoryId: ownC.id }, { variableId: W.clubVarA.id, categoryId: ownC.id, smoothing: true }]) {
    assert.deepEqual([(await link(W.caA, ids)).body.error], ["invalid_body"], JSON.stringify(ids));
  }
  // O3: a category under one domain, whoever owns the domain; the same link twice.
  assert.deepEqual([(await link(W.caA, { categoryId: ownC.id, domainId: ownD2.id })).body.error], ["category_has_domain"], "under a system domain already");
  assert.deepEqual([(await link(W.caA, { categoryId: ownC2.id, domainId: sysD.id })).body.error], ["category_has_domain"], "under its own domain already");
  assert.deepEqual([(await link(W.caA, { categoryId: ownC2.id, domainId: ownD.id })).body.error], ["category_has_domain"], "the same category -> domain link again");
  assert.deepEqual([(await link(W.caA, { variableId: W.clubVarA.id, categoryId: ownC.id })).body.error], ["link_exists"]);
  // Archived nodes and variables.
  const archivedC = await categoryOf(W.caA);
  ok(await act(W.caA, "categories", archivedC.id, "archive"));
  const archivedD = await domainOf(W.caA);
  ok(await act(W.caA, "domains", archivedD.id, "archive"));
  const archivedVar = await variable(W.caA);
  ok(await post(`/variables/${archivedVar.id}/archive`, W.caA.cookie, { requestKey: key(), reason: "Gone" }));
  for (const [ids, error] of [
    [{ variableId: W.clubVarA.id, categoryId: archivedC.id }, "node_archived"],
    [{ variableId: W.clubVarA.id, domainId: archivedD.id }, "node_archived"],
    [{ categoryId: ownC2.id, domainId: archivedD.id }, "node_archived"],
    [{ variableId: archivedVar.id, categoryId: ownC.id }, "variable_not_active"],
  ]) {
    assert.deepEqual([(await link(W.caA, ids)).body.error], [error], JSON.stringify(ids));
  }
  assert.deepEqual({ ...(await counts()), categories: before.categories, domains: before.domains }, { ...before, changes: before.changes + 4, requests: before.requests + 4 }, "only the fixtures' four acts were written");
  // Archiving a node keeps its links.
  ok(await act(W.caA, "categories", ownC2.id, "archive"));
  assert.ok((await variableDetail(W.caA, W.clubVarA.id)).classification.categories.some((x) => x.id === ownC2.id && x.state === "archived"));
  // The records of a link.
  assert.deepEqual((await changesWhere("c.link_id = $1", [varCat.id])).map((x) => [x.object_kind, x.kind, x.domain_id, x.category_id, x.metric_definition_id, x.owner_scope, x.owner_club_id, x.changed_by_user_id, x.operation, x.basis]), [
    ["link", "link", null, ownC.id, W.clubVarA.id, "club", W.clubA, W.caA.id, "link_create", "club_admin"],
  ]);
  assert.deepEqual({ ...(await one(k, `select temporal_smoothing_enabled, created_by_user_id, owner_user_id, owner_team_id from training_load.metric_structure_links where id = $1`, [varCat.id])) },
    { temporal_smoothing_enabled: false, created_by_user_id: W.caA.id, owner_user_id: null, owner_team_id: null });
});

test("7. C5, a removal: the own link's row goes, its change row keeps the link's full content and comes before the request (with the optional reason); a replay answers it as no longer present; a link of another owner (another club's, the system's in a club's workspace) is the identical 404; a removed link is 404; a removed category -> domain link frees the category for another domain", async () => {
  const sysD = await domainOf(W.pa);
  const ownC = await categoryOf(W.caA);
  const ownD = await domainOf(W.caA);
  const placed = await linked(W.caA, { categoryId: ownC.id, domainId: sysD.id });
  const varLink = await linked(W.caA, { variableId: W.sysVar.id, categoryId: ownC.id });
  const sysC = await categoryOf(W.pa);
  const sysLink = await linked(W.pa, { variableId: W.sysVar.id, categoryId: sysC.id });
  const bLink = await linked(W.caB, { variableId: W.clubVarB.id, categoryId: (await categoryOf(W.caB)).id });
  for (const [who, id] of [[W.caA, sysLink.id], [W.caA, bLink.id], [W.caB, varLink.id], [W.pa, varLink.id], [W.coachA1, varLink.id]]) {
    assert.deepEqual([(await unlink(who, id)).text], [NOT_FOUND]);
  }
  assert.deepEqual([(await unlink(W.caA, varLink.id, { reason: " padded" })).body.error], ["invalid_body"]);
  const body = { requestKey: key(), reason: "Wrong category" };
  const removed = ok(await post(`/classification/links/${varLink.id}/remove`, W.caA.cookie, body)).link;
  assert.deepEqual([removed.id, removed.variableId, removed.categoryId, removed.present], [varLink.id, W.sysVar.id, ownC.id, false]);
  assert.equal(await one(k, `select 1 from training_load.metric_structure_links where id = $1`, [varLink.id]), undefined);
  const replay = ok(await post(`/classification/links/${varLink.id}/remove`, W.caA.cookie, body));
  assert.deepEqual([replay.replayed, replay.link.present], [true, false]);
  assert.deepEqual([(await unlink(W.caA, varLink.id)).text], [NOT_FOUND], "a removed link is 404");
  const recorded = await changesWhere("c.link_id = $1", [varLink.id]);
  assert.deepEqual(recorded.map((x) => [x.kind, x.domain_id, x.category_id, x.metric_definition_id, x.owner_scope, x.owner_club_id, x.changed_by_user_id, x.operation, x.reason]), [
    ["link", null, ownC.id, W.sysVar.id, "club", W.clubA, W.caA.id, "link_create", null],
    ["remove", null, ownC.id, W.sysVar.id, "club", W.clubA, W.caA.id, "link_remove", "Wrong category"],
  ]);
  ok(await unlink(W.caA, placed.id));
  await linked(W.caA, { categoryId: ownC.id, domainId: ownD.id });
  ok(await unlink(W.pa, sysLink.id));
});

test("8. C6: the variable list filtered by a category, or by a domain (directly or through its categories), counting only the readable owners' links; one filter at most, a uuid; a filtered list's cursor carries its filter; a variable's detail lists its categories and domains (direct, and through a category) for the admin and the coach view, never another club's", async () => {
  const sysD = await domainOf(W.pa);
  const ownD = await domainOf(W.caA);
  const ownC = await categoryOf(W.caA);
  const a = await variable(W.caA);
  const b = await variable(W.caA);
  const c = await variable(W.caA);
  await linked(W.caA, { variableId: a.id, categoryId: ownC.id });
  await linked(W.caA, { categoryId: ownC.id, domainId: sysD.id });
  await linked(W.caA, { variableId: b.id, domainId: ownD.id });
  await linked(W.caA, { variableId: W.sysVar.id, categoryId: ownC.id });
  const bC = await categoryOf(W.caB);
  await linked(W.caB, { variableId: W.sysVar.id, categoryId: bC.id });
  const list = async (who, q) => {
    const res = await api(`/variables?${q}`, { cookie: who.cookie });
    assert.equal(res.status, 200, res.text);
    return res.body.variables.map((x) => x.id);
  };
  assert.deepEqual(await list(W.caA, `categoryId=${ownC.id}`), [a.id]);
  assert.deepEqual(await list(W.caA, `categoryId=${ownC.id}&scope=system`), [W.sysVar.id]);
  assert.deepEqual(await list(W.caA, `domainId=${ownD.id}`), [b.id]);
  assert.deepEqual(await list(W.caA, `domainId=${sysD.id}`), [a.id], "through its category");
  assert.deepEqual(await list(W.caA, `domainId=${sysD.id}&scope=system`), [W.sysVar.id]);
  assert.ok(!(await list(W.caA, `domainId=${sysD.id}`)).includes(c.id));
  // Another club's placement counts only for that club: a system variable in
  // club B's category under the system domain.
  const sysVarB = await variable(W.pa);
  const bPlaced = await categoryOf(W.caB);
  await linked(W.caB, { variableId: sysVarB.id, categoryId: bPlaced.id });
  await linked(W.caB, { categoryId: bPlaced.id, domainId: sysD.id });
  assert.ok(!(await list(W.caA, `domainId=${sysD.id}&scope=system`)).includes(sysVarB.id));
  assert.ok((await list(W.caB, `domainId=${sysD.id}&scope=system`)).includes(sysVarB.id));
  // A private coach's own (user) link of a system category under the coach's
  // domain, made through the older API: never part of a workspace's classification.
  const sysC = await categoryOf(W.pa);
  const sysVarC = await variable(W.pa);
  await linked(W.pa, { variableId: sysVarC.id, categoryId: sysC.id });
  const userD = await api("/domains", { base: OLD, method: "POST", cookie: W.privateCoach.cookie, body: { name: `Mine ${uid()}`, ownerScope: "user" } });
  assert.equal(userD.status, 201, userD.text);
  const userLink = await api("/structure-links", { base: OLD, method: "POST", cookie: W.privateCoach.cookie, body: { categoryId: sysC.id, domainId: userD.body.row.id, ownerScope: "user" } });
  assert.equal(userLink.status, 201, userLink.text);
  for (const who of [W.caA, W.pa, W.coachA1]) {
    const scoped = who === W.pa ? "" : "&scope=system";
    assert.deepEqual(await list(who, `domainId=${userD.body.row.id}${scoped}`), [], "a user link never places a variable");
    assert.deepEqual((await variableDetail(who, sysVarC.id)).classification.domains, [], "nor names its domain");
  }
  assert.deepEqual(await list(W.caB, `categoryId=${ownC.id}&scope=system`), [], "another club's link counts for nobody else");
  assert.deepEqual(await list(W.pa, `categoryId=${bC.id}`), []);
  assert.deepEqual(await list(W.coachA1, `categoryId=${ownC.id}`), [a.id], "the coach view filters too");
  for (const q of [`domainId=${ownD.id}&categoryId=${ownC.id}`, "domainId=x", `categoryId=${ownC.id}&categoryId=${ownC.id}`, "domain=1"]) {
    const res = await api(`/variables?${q}`, { cookie: W.caA.cookie });
    assert.deepEqual([res.status, res.body.error], [400, "invalid_query"], q);
  }
  // The cursor of a filtered list (a page is 100).
  const many = await categoryOf(W.caA);
  const ids = [];
  for (let i = 0; i < 101; i += 1) {
    const v = await variable(W.caA, { label: `Paged ${String(i).padStart(3, "0")} ${uid()}` });
    ids.push(v.id);
    await linked(W.caA, { variableId: v.id, categoryId: many.id });
  }
  const first = await api(`/variables?categoryId=${many.id}`, { cookie: W.caA.cookie });
  assert.equal(first.body.variables.length, 100);
  const cursor = first.body.nextCursor;
  const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  assert.equal(payload.f, `c:${many.id}`);
  const second = await api(`/variables?categoryId=${many.id}&cursor=${cursor}`, { cookie: W.caA.cookie });
  assert.deepEqual([...first.body.variables, ...second.body.variables].map((x) => x.id).sort(), [...ids].sort());
  assert.equal(second.body.nextCursor, null);
  for (const q of [`cursor=${cursor}`, `categoryId=${ownC.id}&cursor=${cursor}`, `domainId=${many.id}&cursor=${cursor}`]) {
    const res = await api(`/variables?${q}`, { cookie: W.caA.cookie });
    assert.deepEqual([res.status, res.body.error, res.body.message], [400, "invalid_query", "The cursor is not valid for this list."], q);
  }
  const unfiltered = await api("/variables", { cookie: W.caA.cookie });
  assert.ok(unfiltered.body.nextCursor, "more than a page unfiltered");
  const res = await api(`/variables?categoryId=${many.id}&cursor=${unfiltered.body.nextCursor}`, { cookie: W.caA.cookie });
  assert.deepEqual([res.status, res.body.message], [400, "The cursor is not valid for this list."], "an unfiltered cursor is not a filtered list's");
  assert.equal((await api(`/variables?cursor=${unfiltered.body.nextCursor}`, { cookie: W.caA.cookie })).status, 200, "the unfiltered cursor keeps its form");
  // More than 500: C1 and the detail say they are cut (a club of its own).
  const clubX = await club("Club X");
  const caX = await person("club-admin-x", { clubAdminOf: [clubX], ws: ["club", clubX] });
  const crowded = await variable(caX);
  okTx(await tx(caX.id, async (cx) => {
    for (let i = 0; i < 501; i += 1) {
      const cat = await rawCreate(cx, { kind: "category", by: caX.id, scope: "club", clubId: clubX, basis: "club_admin" });
      const l = await rawLink(cx, { by: caX.id, scope: "club", clubId: clubX, variableId: crowded.id, categoryId: cat });
      await rawRequest(cx, { by: caX.id, operation: "link_create", scope: "club", clubId: clubX, basis: "club_admin", changeId: await changeHere(cx, "link_id", l) });
    }
  }));
  const crowdedTree = await tree(caX);
  assert.deepEqual([crowdedTree.truncated, crowdedTree.categories.length], [true, 500]);
  const crowdedDetail = (await variableDetail(caX, crowded.id)).classification;
  assert.deepEqual([crowdedDetail.truncated, crowdedDetail.categories.length], [true, 500]);
  // The detail.
  const detailA = await variableDetail(W.caA, a.id);
  assert.deepEqual(detailA.classification.categories.map((x) => [x.id, x.key, x.name, x.state, x.ownerScope, typeof x.linkId]), [[ownC.id, ownC.key, ownC.name, "active", "club", "string"]]);
  assert.deepEqual(detailA.classification.domains.map((x) => [x.id, x.linkId, x.viaCategoryId, x.ownerScope]), [[sysD.id, null, ownC.id, "system"]]);
  assert.equal(detailA.classification.truncated, false);
  const detailB = await variableDetail(W.caA, b.id);
  assert.deepEqual(detailB.classification.domains.map((x) => [x.id, x.viaCategoryId]), [[ownD.id, null]]);
  const coachView = await variableDetail(W.coachA1, a.id);
  assert.deepEqual(coachView.classification, detailA.classification, "the coach view reads the same classification");
  const sysInA = await variableDetail(W.caA, W.sysVar.id);
  assert.ok(sysInA.classification.categories.some((x) => x.id === ownC.id) && !sysInA.classification.categories.some((x) => x.id === bC.id), "never another club's");
  const sysInPlatform = await variableDetail(W.pa, W.sysVar.id);
  assert.ok(!sysInPlatform.classification.categories.some((x) => [ownC.id, bC.id].includes(x.id)), "the platform workspace reads the system's links only");
});

test("9. idempotency and outcome through the real routes: a replay answers the current state and writes nothing; after the right is lost it is 404; a key reused for another operation or body is request_key_reused; two identical requests at once write once; a lost answer after a real COMMIT is verified; after a real rollback it is 503 outcome_unknown with exactly error, message and requestKey, and the same key then writes once; a read that fails after the COMMIT keeps 201 with readError and the id; a change without its request is refused at COMMIT (a sanitized 500, nothing written); a held row is try_again", async () => {
  const body = { requestKey: key(), name: `Replayed ${uid()}` };
  const first = await post("/classification/domains", W.caA.cookie, body);
  assert.equal(first.status, 201);
  const replay = ok(await post("/classification/domains", W.caA.cookie, body));
  assert.deepEqual([replay.replayed, replay.domain.id], [true, first.body.domain.id]);
  assert.equal((await changesWhere("c.domain_id = $1", [first.body.domain.id])).length, 1);
  assert.deepEqual([(await post("/classification/domains", W.caA.cookie, { ...body, name: "Other" })).body.error], ["request_key_reused"]);
  assert.deepEqual([(await post("/classification/categories", W.caA.cookie, body)).body.error], ["request_key_reused"]);
  assert.deepEqual([(await post(`/classification/domains/${first.body.domain.id}/archive`, W.caA.cookie, { requestKey: body.requestKey, reason: "x" })).body.error], ["request_key_reused"]);
  // The replay checks the right again itself.
  const temp = await person("club-admin-temp", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  const tempBody = { requestKey: key(), name: `Temp ${uid()}` };
  ok(await post("/classification/categories", temp.cookie, tempBody), 201);
  service.setMappingRightsHoldForTests(async () => {
    await k.query(`update public.user_club_roles set is_active = false where user_id = $1`, [temp.id]);
  });
  const lostReplay = await post("/classification/categories", temp.cookie, tempBody);
  service.setMappingRightsHoldForTests(null);
  assert.deepEqual([lostReplay.status, lostReplay.text], [404, NOT_FOUND]);
  // A replay from another workspace (an admin of two clubs): the record is
  // another owner's, so the identical 404.
  const both = await person("club-admin-both", { clubAdminOf: [W.clubA, W.clubB], ws: ["club", W.clubA] });
  const bothBody = { requestKey: key(), name: `Both ${uid()}` };
  ok(await post("/classification/domains", both.cookie, bothBody), 201);
  const bothLink = { requestKey: key(), variableId: W.clubVarA.id, categoryId: (await categoryOf(W.caA)).id };
  const bothMade = ok(await post("/classification/links", both.cookie, bothLink), 201).link;
  const bothRemove = { requestKey: key(), reason: "Moved" };
  ok(await post(`/classification/links/${bothMade.id}/remove`, both.cookie, bothRemove));
  await workspace(both.id, "club", W.clubB);
  // A create names its owner in the request hash: the same key in another
  // workspace is request_key_reused; a removal replayed there is the identical
  // 404 and never names club A's link.
  for (const [p, b] of [["/classification/domains", bothBody], ["/classification/links", bothLink]]) {
    const elsewhere = await post(p, both.cookie, b);
    assert.deepEqual([elsewhere.status, elsewhere.body.error], [409, "request_key_reused"], p);
  }
  const removedElsewhere = await post(`/classification/links/${bothMade.id}/remove`, both.cookie, bothRemove);
  assert.deepEqual([removedElsewhere.status, removedElsewhere.text], [404, NOT_FOUND]);
  // Two identical requests at once: one write, one replay.
  const twin = { requestKey: key(), name: `Twin ${uid()}` };
  const [x, y] = await Promise.all([post("/classification/domains", W.caA.cookie, twin), post("/classification/domains", W.caA.cookie, twin)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 201]);
  assert.equal(x.body.domain.id, y.body.domain.id);
  // A lost answer after a real rollback, and after a real COMMIT.
  const before = await counts();
  service.setMappingCommitForTests({ fault: (client) => client.query("rollback").then(() => { throw new Error("lost"); }) });
  const lostKey = key();
  const unknown = await post("/classification/domains", W.caA.cookie, { requestKey: lostKey, name: `Lost ${uid()}` });
  service.setMappingCommitForTests();
  assert.deepEqual([unknown.status, Object.keys(unknown.body).sort(), unknown.body.error, unknown.body.requestKey], [503, ["error", "message", "requestKey"], "outcome_unknown", lostKey]);
  assert.deepEqual(await counts(), before, "nothing written");
  const again = await post("/classification/domains", W.caA.cookie, { requestKey: lostKey, name: `Again ${uid()}` });
  assert.equal(again.status, 201, "the same key then writes once");
  service.setMappingCommitForTests({ fault: (client) => client.query("commit").then(() => { throw new Error("lost"); }) });
  const verified = await post("/classification/categories", W.caA.cookie, { requestKey: key(), name: `Verified ${uid()}` });
  service.setMappingCommitForTests();
  assert.deepEqual([verified.status, verified.body.commitConfirmation, verified.body.replayed, typeof verified.body.category?.id], [200, "verified_after_commit_error", false, "string"]);
  // A read that fails after the COMMIT.
  service.setMappingRereadFaultForTests(async () => { throw new Error("read broke"); });
  const readError = await post("/classification/domains", W.caA.cookie, { requestKey: key(), name: `Read error ${uid()}` });
  service.setMappingRereadFaultForTests(null);
  assert.deepEqual([readError.status, readError.body.readError, typeof readError.body.domainId, readError.body.domain], [201, true, "string", undefined]);
  // A change without its request row: the COMMIT refuses, everything rolls back.
  const other = await domainOf(W.caA);
  const counted = await counts();
  service.setMappingRightsHoldForTests(async (client) => {
    await client.query(`update training_load.metric_domains set name = 'Sneaked' where id = $1`, [other.id]);
  });
  const sneaked = await post("/classification/categories", W.caA.cookie, { requestKey: key(), name: `Sneak ${uid()}` });
  service.setMappingRightsHoldForTests(null);
  assert.deepEqual([sneaked.status, sneaked.text], [500, '{"error":"internal_error","message":"Something went wrong."}']);
  assert.deepEqual([await counts(), (await one(k, `select name from training_load.metric_domains where id = $1`, [other.id])).name], [counted, other.name], "nothing written");
  // A held row: try_again with Retry-After.
  await k2.query("begin");
  await k2.query(`select 1 from training_load.metric_domains where id = $1 for update`, [other.id]);
  const busy = await act(W.caA, "domains", other.id, "archive");
  await k2.query("rollback");
  assert.deepEqual([busy.status, busy.body.error, busy.headers.get("retry-after")], [409, "try_again", "5"]);
  const held = await linked(W.caA, { variableId: W.clubVarA.id, categoryId: (await categoryOf(W.caA)).id });
  await k2.query("begin");
  await k2.query(`select 1 from training_load.metric_structure_links where id = $1 for update`, [held.id]);
  const busyRemove = await unlink(W.caA, held.id);
  await k2.query("rollback");
  assert.deepEqual([busyRemove.status, busyRemove.body.error], [409, "try_again"]);
});

test("10. the database guards (C76, O7's twin): without the acting user every canonical insert, update and delete is refused, team and user rows pass; the row's user, the right and the derived basis; a canonical node is created active with its key, keeps its identity, renames, archives and restores separately and is never deleted; the text rule; a link has two ids, stays inside its owner, never points at an archived target and is never updated; O3's index whoever owns the domain; the key index per owner; a change without its request at COMMIT; a request without its own change, of another transaction, operation, owner or user; a direct change row; a savepoint; two changes of one node in a transaction; append-only", async () => {
  const sysD = await domainOf(W.pa);
  const ownC = await categoryOf(W.caA);
  const ownD = await domainOf(W.caA);
  const placed = await linked(W.caA, { variableId: W.clubVarA.id, categoryId: ownC.id });
  // No acting user (the older API's path): every canonical write refused.
  refusedWith(await tx(null, (c) => rawNode(c, { by: W.pa.id, scope: "system" })), "42501", NO_ACTOR);
  refusedWith(await tx(null, (c) => c.query(`update training_load.metric_domains set name = 'x' where id = $1`, [sysD.id])), "42501", NO_ACTOR);
  refusedWith(await tx(null, (c) => rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: W.sysVar.id, categoryId: ownC.id })), "42501", NO_ACTOR);
  refusedWith(await tx(null, (c) => c.query(`delete from training_load.metric_structure_links where id = $1`, [placed.id])), "42501", NO_ACTOR);
  refusedWith(await tx(null, (c) => c.query(`delete from training_load.metric_domains where id = $1`, [sysD.id])), "23514", NEVER_DELETED);
  // Team and user rows pass without an actor, with no record.
  const before = await counts();
  okTx(await tx(null, async (c) => {
    const teamD = (await one(c, `insert into training_load.metric_domains (name, owner_scope, owner_team_id) values ('Team','team',$1) returning id`, [W.teamA1])).id;
    const userC = (await one(c, `insert into training_load.metric_categories (name, owner_scope, owner_user_id) values ('Mine','user',$1) returning id`, [W.coachA1.id])).id;
    await c.query(`insert into training_load.metric_structure_links (domain_id, metric_definition_id, owner_scope, owner_team_id) values ($1,$2,'team',$3)`, [teamD, W.sysVar.id, W.teamA1]);
    const userLink = (await one(c, `insert into training_load.metric_structure_links (category_id, domain_id, metric_definition_id, temporal_smoothing_enabled, owner_scope, owner_user_id) values ($1,$2,$3,true,'user',$4) returning id`, [userC, sysD.id, W.sysVar.id, W.coachA1.id])).id;
    // O3's index covers only canonical links: a user's category may sit under two domains.
    await c.query(`insert into training_load.metric_structure_links (category_id, domain_id, owner_scope, owner_user_id) values ($1,$2,'user',$3), ($1,$4,'user',$3)`, [userC, sysD.id, W.coachA1.id, ownD.id]);
    await c.query(`update training_load.metric_domains set name = 'Team 2', is_active = false where id = $1`, [teamD]);
    await c.query(`delete from training_load.metric_structure_links where id = $1`, [userLink]);
  }));
  assert.deepEqual([(await counts()).changes, (await counts()).requests], [before.changes, before.requests]);
  // The user, the right.
  refusedWith(await tx(W.pa.id, (c) => rawNode(c, { by: W.caA.id, scope: "system" })), "42501", OTHER_USER);
  refusedWith(await tx(W.coachA1.id, (c) => rawNode(c, { by: W.coachA1.id, scope: "club", clubId: W.clubA })), "42501", MAY_NOT);
  refusedWith(await tx(W.caB.id, (c) => rawNode(c, { by: W.caB.id, scope: "club", clubId: W.clubA })), "42501", MAY_NOT);
  refusedWith(await tx(W.caA.id, (c) => rawNode(c, { by: W.caA.id, scope: "system" })), "42501", MAY_NOT);
  refusedWith(await tx(W.caC.id, (c) => rawNode(c, { by: W.caC.id, scope: "club", clubId: W.clubC })), "42501", MAY_NOT);
  refusedWith(await tx(W.caB.id, (c) => c.query(`update training_load.metric_categories set name = 'x' where id = $1`, [ownC.id])), "42501", MAY_NOT);
  refusedWith(await tx(W.caB.id, (c) => c.query(`delete from training_load.metric_structure_links where id = $1`, [placed.id])), "42501", MAY_NOT);
  refusedWith(await tx(W.pa.id, (c) => rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: W.sysVar.id, categoryId: ownC.id })), "42501", OTHER_USER);
  refusedWith(await tx(W.coachA1.id, (c) => rawLink(c, { by: W.coachA1.id, scope: "club", clubId: W.clubA, variableId: W.sysVar.id, categoryId: ownC.id })), "42501", MAY_NOT);
  // A canonical node: created active with its key; the text rule.
  refusedWith(await tx(W.pa.id, (c) => rawNode(c, { by: W.pa.id, scope: "system", nodeKey: null })), "23514", CREATED_ACTIVE);
  refusedWith(await tx(W.pa.id, (c) => c.query(`insert into training_load.metric_domains (name, key, is_active, owner_scope, created_by_user_id) values ('x','inactive_one',false,'system',$1)`, [W.pa.id])), "23514", CREATED_ACTIVE);
  for (const [name, description] of [[`a${ch(0x200b)}`, null], ["x".repeat(81), null], ["ok", "d".repeat(501)], ["ok", ""], [" lead", null]]) {
    refusedWith(await tx(W.pa.id, (c) => rawNode(c, { by: W.pa.id, scope: "system", name, description })), "23514", NODE_TEXT);
  }
  refusedWith(await tx(W.pa.id, (c) => rawNode(c, { by: W.pa.id, scope: "system", nodeKey: "Bad-Key" })), "23514", /metric_domains_key_rule/);
  // Identity, separate acts, nothing-changes, rename of an archived node, delete.
  for (const set of ["key = 'other_key'", "owner_scope = 'club', owner_club_id = '" + W.clubA + "'", "created_by_user_id = '" + W.caA.id + "'", "created_at = now() - interval '1 day'"]) {
    refusedWith(await tx(W.pa.id, (c) => c.query(`update training_load.metric_domains set ${set} where id = $1`, [sysD.id])), "23514", IDENTITY);
  }
  refusedWith(await tx(W.pa.id, (c) => c.query(`update training_load.metric_domains set name = 'x', is_active = false where id = $1`, [sysD.id])), "23514", SEPARATE);
  refusedWith(await tx(W.pa.id, (c) => c.query(`update training_load.metric_domains set updated_at = now() where id = $1`, [sysD.id])), "23514", NOTHING);
  refusedWith(await tx(W.pa.id, (c) => c.query(`update training_load.metric_domains set name = 'Bad${ch(0x200b)}' where id = $1`, [sysD.id])), "23514", NODE_TEXT);
  ok(await act(W.caA, "domains", ownD.id, "archive"));
  refusedWith(await tx(W.caA.id, (c) => c.query(`update training_load.metric_domains set name = 'x' where id = $1`, [ownD.id])), "23514", RESTORE_FIRST);
  refusedWith(await tx(W.caA.id, (c) => rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: W.sysVar.id, domainId: ownD.id })), "23514", ARCHIVED_NODE);
  ok(await act(W.caA, "domains", ownD.id, "restore"));
  refusedWith(await tx(W.pa.id, (c) => c.query(`delete from training_load.metric_categories where id = $1`, [ownC.id])), "23514", NEVER_DELETED);
  // Links.
  refusedWith(await tx(W.caA.id, (c) => c.query(`update training_load.metric_structure_links set temporal_smoothing_enabled = true where id = $1`, [placed.id])), "23514", LINK_UNCHANGED);
  refusedWith(await tx(W.caA.id, (c) => rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: W.sysVar.id, categoryId: ownC.id, domainId: ownD.id })), "23514", LINK_TWO);
  refusedWith(await tx(W.caA.id, (c) => rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: W.sysVar.id })), "23514", LINK_TWO);
  refusedWith(await tx(W.caA.id, (c) => rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: W.sysVar.id, domainId: ownD.id, smoothing: true })), "23514", LINK_TWO);
  const sysC = await categoryOf(W.pa);
  for (const ids of [{ variableId: W.clubVarA.id, categoryId: sysC.id }, { variableId: W.sysVar.id, domainId: sysD.id }, { categoryId: sysC.id, domainId: ownD.id }]) {
    refusedWith(await tx(W.caA.id, (c) => rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, ...ids })), "23514", OUTSIDE);
  }
  const archivedC = await categoryOf(W.caA);
  ok(await act(W.caA, "categories", archivedC.id, "archive"));
  refusedWith(await tx(W.caA.id, (c) => rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: W.sysVar.id, categoryId: archivedC.id })), "23514", ARCHIVED_NODE);
  const archivedVar = await variable(W.caA);
  ok(await post(`/variables/${archivedVar.id}/archive`, W.caA.cookie, { requestKey: key(), reason: "Gone" }));
  refusedWith(await tx(W.caA.id, (c) => rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: archivedVar.id, domainId: ownD.id })), "23514", ARCHIVED_VARIABLE);
  // O3: one domain per canonical category, whoever owns the domain; the key index per owner.
  const c3 = await categoryOf(W.caA);
  await linked(W.caA, { categoryId: c3.id, domainId: sysD.id });
  const second = refusedWith(await tx(W.caA.id, async (c) => {
    const id = await rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, categoryId: c3.id, domainId: ownD.id });
    await rawRequest(c, { by: W.caA.id, operation: "link_create", scope: "club", clubId: W.clubA, basis: "club_admin", changeId: await changeHere(c, "link_id", id) });
  }), "23505");
  assert.equal(second.constraint, "metric_structure_links_one_domain_per_category");
  const sharedKey = `shared_${uid()}`;
  okTx(await tx(W.pa.id, (c) => rawCreate(c, { by: W.pa.id, scope: "system", basis: "platform_admin", nodeKey: sharedKey })));
  okTx(await tx(W.caA.id, (c) => rawCreate(c, { by: W.caA.id, scope: "club", clubId: W.clubA, basis: "club_admin", nodeKey: sharedKey })));
  okTx(await tx(W.caB.id, (c) => rawCreate(c, { by: W.caB.id, scope: "club", clubId: W.clubB, basis: "club_admin", nodeKey: sharedKey })));
  okTx(await tx(W.caA.id, (c) => rawCreate(c, { kind: "category", by: W.caA.id, scope: "club", clubId: W.clubA, basis: "club_admin", nodeKey: sharedKey })));
  assert.equal(refusedWith(await tx(W.paA.id, (c) => rawCreate(c, { by: W.paA.id, scope: "club", clubId: W.clubA, basis: "platform_admin", nodeKey: sharedKey })), "23505").constraint, "metric_domains_canonical_key_unique");
  assert.equal(refusedWith(await tx(W.pa.id, (c) => rawCreate(c, { by: W.pa.id, scope: "system", basis: "platform_admin", nodeKey: sharedKey })), "23505").constraint, "metric_domains_canonical_key_unique");
  // The records: a change needs its request at COMMIT; a request its own change.
  refusedWith(await tx(W.pa.id, (c) => rawNode(c, { by: W.pa.id, scope: "system" })), "23514", REQUEST_LINK);
  refusedWith(await tx(W.pa.id, (c) => c.query(`update training_load.metric_domains set name = $2 where id = $1`, [sysD.id, `Unrecorded ${uid()}`])), "23514", REQUEST_LINK);
  refusedWith(await tx(W.caA.id, (c) => c.query(`delete from training_load.metric_structure_links where id = $1`, [placed.id])), "23514", REQUEST_LINK);
  const earlierChange = (await one(k, `select id from training_load.metric_classification_changes where domain_id = $1 and kind = 'create'`, [sysD.id])).id;
  refusedWith(await tx(W.pa.id, (c) => rawRequest(c, { by: W.pa.id, operation: "domain_create", scope: "system", basis: "platform_admin", changeId: earlierChange })), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, (c) => rawRequest(c, { by: W.pa.id, operation: "domain_create", scope: "system", basis: "platform_admin", changeId: crypto.randomUUID() })), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, async (c) => {
    const id = await rawNode(c, { by: W.pa.id, scope: "system" });
    await rawRequest(c, { by: W.pa.id, operation: "domain_rename", scope: "system", basis: "platform_admin", changeId: await changeHere(c, "domain_id", id) });
  }), "23514", FOLLOW);
  refusedWith(await tx(W.pa.id, async (c) => {
    const id = await rawNode(c, { by: W.pa.id, scope: "system" });
    await rawRequest(c, { by: W.pa.id, operation: "category_create", scope: "system", basis: "platform_admin", changeId: await changeHere(c, "domain_id", id) });
  }), "23514", FOLLOW);
  refusedWith(await tx(W.paA.id, async (c) => {
    const id = await rawNode(c, { by: W.paA.id, scope: "club", clubId: W.clubA });
    await rawRequest(c, { by: W.paA.id, operation: "domain_create", scope: "club", clubId: W.clubB, basis: "platform_admin", changeId: await changeHere(c, "domain_id", id) });
  }), "23514", FOLLOW);
  refusedWith(await tx(W.caA.id, async (c) => {
    const id = await rawNode(c, { by: W.caA.id, scope: "club", clubId: W.clubA });
    await rawRequest(c, { by: W.caA.id, operation: "domain_create", scope: "club", clubId: W.clubA, basis: "platform_admin", changeId: await changeHere(c, "domain_id", id) });
  }), "42501", BASIS);
  refusedWith(await tx(W.paA.id, async (c) => {
    const id = await rawNode(c, { by: W.paA.id, scope: "club", clubId: W.clubA });
    await rawRequest(c, { by: W.paA.id, operation: "domain_create", scope: "club", clubId: W.clubA, basis: "club_admin", changeId: await changeHere(c, "domain_id", id) });
  }), "42501", BASIS);
  refusedWith(await tx(W.pa.id, async (c) => {
    const id = await rawNode(c, { by: W.pa.id, scope: "system" });
    await rawRequest(c, { by: W.caA.id, operation: "domain_create", scope: "system", basis: "platform_admin", changeId: await changeHere(c, "domain_id", id) });
  }), "42501", REQUEST_USER);
  refusedWith(await tx(W.caB.id, (c) => rawRequest(c, { by: W.caB.id, operation: "domain_create", scope: "club", clubId: W.clubA, basis: "club_admin", changeId: earlierChange })), "42501", REQUEST_MAY_NOT);
  // The acting user set again within one transaction: a request never claims another user's change.
  refusedWith(await tx(W.caA.id, async (c) => {
    const id = await rawNode(c, { by: W.caA.id, scope: "club", clubId: W.clubA });
    const change = await changeHere(c, "domain_id", id);
    await c.query(CTX, [W.caA2.id]);
    await rawRequest(c, { by: W.caA2.id, operation: "domain_create", scope: "club", clubId: W.clubA, basis: "club_admin", changeId: change });
  }), "23514", FOLLOW);
  // A request names the link's own change, and the link's state.
  refusedWith(await tx(W.caA.id, async (c) => {
    const id = await rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: W.sysVar.id, domainId: ownD.id });
    await rawRequest(c, { by: W.caA.id, operation: "link_remove", scope: "club", clubId: W.clubA, basis: "club_admin", changeId: await changeHere(c, "link_id", id) });
  }), "23514", FOLLOW);
  refusedWith(await tx(W.caA.id, async (c) => {
    const id = await rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: W.sysVar.id, domainId: ownD.id });
    const change = await changeHere(c, "link_id", id);
    await c.query(`delete from training_load.metric_structure_links where id = $1`, [id]);
    await rawRequest(c, { by: W.caA.id, operation: "link_create", scope: "club", clubId: W.clubA, basis: "club_admin", changeId: change });
  }), "23514", FOLLOW);
  // A legitimate raw removal: the change from the row before it goes, then the request.
  okTx(await tx(W.caA.id, async (c) => {
    await c.query(`delete from training_load.metric_structure_links where id = $1`, [placed.id]);
    await rawRequest(c, { by: W.caA.id, operation: "link_remove", scope: "club", clubId: W.clubA, basis: "club_admin", changeId: await changeHere(c, "link_id", placed.id), reason: "Raw" });
  }));
  // A direct change row, also right after the node's own change in the same transaction.
  const forged = (c) => c.query(`insert into training_load.metric_classification_changes (object_kind, kind, domain_id, owner_scope, old_name, new_name, old_active, new_active, changed_by_user_id, xact_id) values ('domain','rename',$1,'system','a','x',true,true,$2,pg_current_xact_id())`, [sysD.id, W.pa.id]);
  refusedWith(await tx(W.pa.id, forged), "23514", CHANGE_ONLY);
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query(`update training_load.metric_domains set name = $2 where id = $1`, [sysD.id, `Forged ${uid()}`]);
    await forged(c);
  }), "23514", CHANGE_ONLY);
  // A savepoint: the rows carry the subtransaction's id (fail closed).
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query("savepoint s");
    await rawCreate(c, { by: W.pa.id, scope: "system", basis: "platform_admin" });
    await c.query("release savepoint s");
  }), "23514", CHANGE_ONLY);
  refusedWith(await tx(W.caA.id, async (c) => {
    await c.query("savepoint s");
    const id = await rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: W.sysVar.id, domainId: ownD.id });
    await rawRequest(c, { by: W.caA.id, operation: "link_create", scope: "club", clubId: W.clubA, basis: "club_admin", changeId: await changeHere(c, "link_id", id) });
    await c.query("release savepoint s");
  }), "23514", CHANGE_ONLY);
  // Two changes of one node in one transaction, then a request.
  refusedWith(await tx(W.pa.id, async (c) => {
    await c.query(`update training_load.metric_domains set name = $2 where id = $1`, [sysD.id, `One ${uid()}`]);
    await c.query(`update training_load.metric_domains set name = $2 where id = $1`, [sysD.id, `Two ${uid()}`]);
    await rawRequest(c, { by: W.pa.id, operation: "domain_rename", scope: "system", basis: "platform_admin", changeId: await changeHere(c, "domain_id", sysD.id) });
  }), "23514", FOLLOW);
  // TRUNCATE: the links refuse while a canonical one exists; the domains and
  // categories cannot go without the change table, whose TRUNCATE is refused.
  refusedWith(await tx(null, (c) => c.query(`truncate training_load.metric_structure_links`)), "23514", NO_TRUNCATE);
  refusedWith(await tx(null, (c) => c.query(`truncate training_load.metric_domains`)), "0A000");
  refusedWith(await tx(null, (c) => c.query(`truncate training_load.metric_categories cascade`)), "23514", /^metric classification: (change and request records are append-only|a canonical link is removed one at a time, never truncated)$/);
  // A change row a trigger forges with another link's content (at the depth a
  // real trigger writes), for a new link and for a removal.
  const forgedOn = await linked(W.caA, { variableId: W.sysVar.id, domainId: ownD.id });
  const forge = (timing, row) => async (c) => {
    await c.query(`create function training_load.p12b_forge() returns trigger as $f$
      begin
        insert into training_load.metric_classification_changes (object_kind, kind, domain_id, metric_definition_id, link_id, owner_scope, owner_club_id, changed_by_user_id, xact_id)
        values ('link', tg_argv[0], tg_argv[1]::uuid, ${row}.metric_definition_id, ${row}.id, ${row}.owner_scope, ${row}.owner_club_id, training_load.source_metric_context_actor(), pg_current_xact_id());
        return ${row};
      end $f$ language plpgsql`);
    await c.query(`create trigger p12b_forge ${timing} on training_load.metric_structure_links for each row execute function training_load.p12b_forge('${timing.includes("insert") ? "link" : "remove"}', '${sysD.id}')`);
    if (timing.includes("insert")) await rawLink(c, { by: W.caA.id, scope: "club", clubId: W.clubA, variableId: W.clubVarA.id, domainId: ownD.id });
    else await c.query(`delete from training_load.metric_structure_links where id = $1`, [forgedOn.id]);
  };
  refusedWith(await tx(W.caA.id, forge("after insert", "new")), "23514", CHANGE_ONLY);
  refusedWith(await tx(W.caA.id, forge("before delete", "old")), "23514", CHANGE_ONLY);
  // Append-only.
  for (const table of ["metric_classification_changes", "metric_classification_requests"]) {
    const column = table.endsWith("changes") ? "changed_at" : "created_at";
    refusedWith(await tx(W.pa.id, (c) => c.query(`update training_load.${table} set ${column} = ${column}`)), "23514", APPEND);
    refusedWith(await tx(W.pa.id, (c) => c.query(`delete from training_load.${table}`)), "23514", APPEND);
    refusedWith(await tx(W.pa.id, (c) => c.query(`truncate training_load.${table} cascade`)), "23514", APPEND);
  }
});

test("11. O7 and O8: the older API refuses canonical classification (409, nothing written) and keeps team and user rows; its reads return the new club and system rows to a club admin and a platform admin, and the system's (not the club's) to a team coach, unchanged as code (O8 stays a follow-up); the pickers' grouping reads the older links", async () => {
  const sysD = await domainOf(W.pa);
  const ownC = await categoryOf(W.caA);
  const placed = await linked(W.caA, { variableId: W.clubVarA.id, categoryId: ownC.id });
  const older = (p, who, opts = {}) => api(p, { base: OLD, cookie: who.cookie, ...opts });
  for (const [p, who] of [[`/domains/${sysD.id}/archive`, W.pa], [`/categories/${ownC.id}/archive`, W.caA]]) {
    const res = await older(p, who, { method: "POST", body: {} });
    assert.deepEqual([res.status, res.body], [409, READ_ONLY], p);
  }
  const del = await older(`/structure-links/${placed.id}`, W.caA, { method: "DELETE" });
  assert.deepEqual([del.status, del.body], [409, READ_ONLY]);
  assert.equal((await one(k, `select is_active from training_load.metric_categories where id = $1`, [ownC.id])).is_active, true);
  assert.ok(await one(k, `select 1 from training_load.metric_structure_links where id = $1`, [placed.id]));
  const domainsOf = async (who) => ok(await older("/domains", who)).rows.map((x) => x.id);
  const categoriesOf = async (who) => ok(await older("/categories", who)).rows.map((x) => x.id);
  assert.ok((await domainsOf(W.caA)).includes(sysD.id) && (await categoriesOf(W.caA)).includes(ownC.id));
  assert.ok((await categoriesOf(W.pa)).includes(ownC.id));
  assert.ok((await domainsOf(W.coachA1)).includes(sysD.id));
  assert.ok(!(await categoriesOf(W.coachA1)).includes(ownC.id), "O8: a team coach does not see the club's categories in the older reads");
  assert.ok(!(await categoriesOf(W.caB)).includes(ownC.id));
  const links = ok(await older(`/structure-links?categoryId=${ownC.id}`, W.caA)).rows;
  assert.deepEqual(links.map((x) => x.id), [placed.id]);
});

test("12. concurrency: a link waits for an archive of its category and is then refused (node_archived); an archive waits for a link and then archives it with the link kept; two category -> domain links of one category at once write one; two removals of one link at once remove it once", async () => {
  // An archive holds the category; the link waits, then sees it archived.
  const c1 = await categoryOf(W.caA);
  let g = gate();
  let held = false;
  service.setMappingRightsHoldForTests(async () => { if (!held) { held = true; await g.promise; } });
  const archiving = act(W.caA, "categories", c1.id, "archive");
  assert.ok(await until(() => held));
  const linking = link(W.caA2, { variableId: W.clubVarA.id, categoryId: c1.id });
  assert.ok(await someoneWaits(), "the link waits for the category");
  g.open();
  const [archived, refused] = await Promise.all([archiving, linking]);
  assert.deepEqual([archived.status, refused.status, refused.body.error], [200, 409, "node_archived"]);
  // A link holds the category; the archive waits, then archives, keeping the link.
  const c2 = await categoryOf(W.caA);
  g = gate();
  held = false;
  service.setMappingRightsHoldForTests(async () => { if (!held) { held = true; await g.promise; } });
  const linking2 = link(W.caA, { variableId: W.clubVarA.id, categoryId: c2.id });
  assert.ok(await until(() => held));
  const archiving2 = act(W.caA2, "categories", c2.id, "archive");
  assert.ok(await someoneWaits(), "the archive waits for the link");
  g.open();
  const [made, archived2] = await Promise.all([linking2, archiving2]);
  assert.deepEqual([made.status, archived2.status], [201, 200]);
  assert.ok(await one(k, `select 1 from training_load.metric_structure_links where id = $1`, [made.body.link.id]));
  // Two category -> domain links of one category at once: one is written.
  const c3 = await categoryOf(W.caA);
  const d1 = await domainOf(W.caA);
  const d2 = await domainOf(W.pa);
  g = gate();
  let arrived = 0;
  service.setMappingRightsHoldForTests(async () => { arrived += 1; await g.promise; });
  const both = [link(W.caA, { categoryId: c3.id, domainId: d1.id }), link(W.caA2, { categoryId: c3.id, domainId: d2.id })];
  assert.ok(await until(() => arrived === 2));
  g.open();
  const answers = await Promise.all(both);
  assert.deepEqual(answers.map((x) => x.status).sort(), [201, 409]);
  assert.equal(answers.find((x) => x.status === 409).body.error, "category_has_domain");
  assert.equal((await one(k, `select count(*)::int as n from training_load.metric_structure_links where category_id = $1 and metric_definition_id is null`, [c3.id])).n, 1);
  // Two removals of one link at once (two admins): one removes it, the other is 404.
  service.setMappingRightsHoldForTests(null);
  const l = await linked(W.caA, { variableId: W.sysVar.id, categoryId: (await categoryOf(W.caA)).id });
  const removals = await Promise.all([unlink(W.caA, l.id), unlink(W.caA2, l.id)]);
  assert.deepEqual(removals.map((x) => x.status).sort(), [200, 404]);
  assert.equal((await changesWhere("c.link_id = $1 and c.kind = 'remove'", [l.id])).length, 1);
});

test("13. a right lost during a write: a revoked club role, an archived club or a deactivated user answer the identical 404 and write nothing; a club admin made platform admin meanwhile is try_again", async () => {
  const run = async (who, mutate, expect) => {
    const before = await counts();
    service.setMappingRightsHoldForTests(async () => { await k.query(mutate.sql, mutate.params); });
    const res = await create(who, "domains");
    service.setMappingRightsHoldForTests(null);
    assert.deepEqual(await counts(), before, "nothing written");
    return expect(res);
  };
  const revoked = await person("club-admin-revoked", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  await run(revoked, { sql: `update public.user_club_roles set is_active = false where user_id = $1`, params: [revoked.id] }, (res) => assert.deepEqual([res.status, res.text], [404, NOT_FOUND]));
  const clubD = await club("Club D");
  const caD = await person("club-admin-d", { clubAdminOf: [clubD], ws: ["club", clubD] });
  await run(caD, { sql: `update public.clubs set is_active = false where id = $1`, params: [clubD] }, (res) => assert.deepEqual([res.status, res.text], [404, NOT_FOUND]));
  const gone = await person("club-admin-gone", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  await run(gone, { sql: `update public.users set is_active = false where id = $1`, params: [gone.id] }, (res) => assert.deepEqual([res.status, res.text], [404, NOT_FOUND]));
  const promoted = await person("club-admin-promoted", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  await run(promoted, { sql: `insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, params: [promoted.id] }, (res) => assert.deepEqual([res.status, res.body.error], [409, "try_again"]));
  // Made platform admin after the service's rights check, before the request
  // row: the database derives another basis, so the request is repeated.
  const late = await person("club-admin-late", { clubAdminOf: [W.clubA], ws: ["club", W.clubA] });
  const beforeLate = await counts();
  classification.setClassificationWriteHoldForTests(async () => {
    await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [late.id]);
  });
  const lateRes = await create(late, "domains");
  classification.setClassificationWriteHoldForTests(null);
  assert.deepEqual([lateRes.status, lateRes.body.error, lateRes.headers.get("retry-after")], [409, "try_again", "5"]);
  assert.deepEqual(await counts(), beforeLate, "nothing written");
  const pa = await person("platform-admin-revoked", { platform: true, ws: ["platform", null] });
  await run(pa, { sql: `update public.user_global_roles set is_active = false where user_id = $1`, params: [pa.id] }, (res) => assert.deepEqual([res.status, res.text], [404, NOT_FOUND]));
});

test("14. no answer and no log line carries SQL, a trigger's or the database's text, a body's name, description or reason, or an acting user's id; a reason is never answered", async () => {
  const secretName = `Secret name ${uid()}`;
  const secretDescription = `Secret description ${uid()}`;
  const secretReason = `Secret reason ${uid()}`;
  const d = await domainOf(W.caA, { name: secretName, description: secretDescription });
  ok(await act(W.caA, "domains", d.id, "archive", { reason: secretReason }));
  const c = await categoryOf(W.caA);
  const l = await linked(W.caA, { variableId: W.clubVarA.id, categoryId: c.id });
  ok(await unlink(W.caA, l.id, { reason: secretReason }));
  await link(W.caA, { variableId: W.clubVarA.id, categoryId: d.id });
  await link(W.caA, { categoryId: c.id, domainId: d.id });
  const everything = [...responses, ...logLines].join("\n");
  for (const forbidden of [/select |insert into|update training_load|delete from/i, /metric_classification_requests:|metric_classification_changes:|metric classification:/, /acting user/, /violates/i]) {
    assert.doesNotMatch(everything, forbidden);
  }
  for (const id of [W.caA.id, W.caA2.id, W.pa.id, W.paA.id]) assert.ok(!everything.includes(id), "no acting user's id");
  const logs = logLines.join("\n");
  for (const secret of [secretName, secretDescription, secretReason]) assert.ok(!logs.includes(secret), "no body text in the logs");
  assert.ok(!responses.some((t) => t.includes(secretReason)), "a reason is never answered");
});

test("15. v41 reads back the same after pg_dump and pg_restore (what gpexe-backup-verify compares): every trigger, constraint, index and function v41 adds", async () => {
  const target = await createDisposableDatabase({ prefix: "gpexe", label: "p12brt", baseDatabaseUrl: ORIGINAL_DATABASE_URL });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-p12b-roundtrip-"));
  const restored = new pg.Client({ connectionString: target.url });
  try {
    assert.match(target.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
    const u = new URL(db.url);
    const conn = ["-h", u.hostname, "-p", u.port || "5432", "-U", decodeURIComponent(u.username)];
    const env = { PATH: process.env.PATH, PGPASSWORD: decodeURIComponent(u.password) };
    const file = path.join(dir, "p12b.dump");
    execFileSync("pg_dump", [...conn, "-d", db.name, "-Fc", "-f", file], { env, stdio: "pipe" });
    execFileSync("pg_restore", [...conn, "--no-owner", "--no-privileges", "-d", target.name, file], { env, stdio: "pipe" });
    await restored.connect();
    const objects = async (c) => ({
      triggers: await rows(c, `select c.relname, t.tgname, pg_get_triggerdef(t.oid) as def, t.tgenabled from pg_trigger t join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'training_load' and not t.tgisinternal
         and (c.relname in ('metric_classification_changes', 'metric_classification_requests') or t.tgname like '%\\_v41\\_%') order by 1, 2`),
      constraints: await rows(c, `select conrelid::regclass::text as rel, conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid in ('training_load.metric_classification_changes'::regclass, 'training_load.metric_classification_requests'::regclass)
           or conname in ('metric_domains_key_rule', 'metric_domains_canonical_key', 'metric_categories_key_rule', 'metric_categories_canonical_key') order by 1, 2`),
      indexes: await rows(c, `select indexname, indexdef from pg_indexes where schemaname = 'training_load'
        and (tablename in ('metric_classification_changes', 'metric_classification_requests')
             or indexname in ('metric_domains_canonical_key_unique', 'metric_categories_canonical_key_unique', 'metric_structure_links_one_domain_per_category')) order by 1`),
      functions: await rows(c, `select p.proname, md5(pg_get_functiondef(p.oid)) as digest from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'training_load' and p.proname like 'metric\\_classification\\_%' order by 1`),
    });
    const source = await objects(k);
    assert.deepEqual([source.triggers.length, source.functions.length, source.indexes.length], [16, 9, 15]);
    assert.deepEqual(await objects(restored), source);
  } finally {
    await restored.end().catch(() => {});
    await target.drop();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
