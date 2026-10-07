// A bounded pool checkout (owner order 2026-10-07): the global PostgreSQL
// pool never lets pool.connect() wait without a bound, a timeout never ends
// the process, a client that arrives late is released, nothing of the request
// is logged, and the routes with stable codes answer try_again (or their own
// busy code) instead of a stack. On a disposable optimove_tests_gpexe_*
// database only (never OPTIMOVE); no GPEXE request is ever made.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_TIMEOUT = process.env.PG_POOL_CHECKOUT_TIMEOUT_MS;
const BOUND_MS = 300;
const ZERO = "00000000-0000-0000-0000-000000000000";
const MARKER_BODY = "MARKER-request-body-pool-test";

let db, admin, server, apiBase, appPool, dbModule, createSession;
const logLines = [];
const originalConsole = {};
const unhandled = [];
const onUnhandled = (reason) => { unhandled.push(reason); };

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "pooltimeout" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  process.env.DATABASE_URL = db.url;
  process.env.PG_POOL_CHECKOUT_TIMEOUT_MS = String(BOUND_MS);
  process.on("unhandledRejection", onUnhandled);
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" "));
      if (process.env.POOL_TEST_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  dbModule = await import("../src/db.js");
  appPool = dbModule.pool;
  ({ createSession } = await import("../src/auth.js"));
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  dbModule?.setPoolCheckoutFaultForTests(null);
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  // Bounded: a client a failed test left checked out must not hold the
  // teardown (the database is dropped with its backends terminated anyway).
  if (appPool) await Promise.race([appPool.end(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (admin) await admin.end();
  if (db) await db.drop();
  for (const level of Object.keys(originalConsole)) console[level] = originalConsole[level];
  process.off("unhandledRejection", onUnhandled);
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_TIMEOUT === undefined) delete process.env.PG_POOL_CHECKOUT_TIMEOUT_MS; else process.env.PG_POOL_CHECKOUT_TIMEOUT_MS = ORIGINAL_TIMEOUT;
});

afterEach(async () => {
  dbModule.setPoolCheckoutFaultForTests(null);
  await settle();
  assert.equal(appPool.waitingCount, 0, "no checkout is left waiting");
  assert.equal(appPool.totalCount - appPool.idleCount, 0, "no pool client is left checked out");
  assert.equal(unhandled.length, 0, `no unhandled rejection: ${unhandled.map((e) => e?.message).join(" | ")}`);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
const uid = () => crypto.randomBytes(4).toString("hex");
async function makeUser(label) { return (await q(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${uid()}@test.local`, label]))[0].id; }
async function platformAdmin() {
  const id = await makeUser("platform-admin");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await q(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,'platform',null) on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [id]);
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}
async function clubAndTeam() {
  const club = (await q(`insert into public.clubs (name) values ($1) returning id`, [`Club ${uid()}`]))[0].id;
  const team = (await q(`insert into public.teams (name, club_id) values ($1, $2) returning id`, [`Team ${uid()}`, club]))[0].id;
  return { club, team };
}
async function call(path, { method = "GET", body, cookie, signal } = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(5_000),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text, headers: res.headers };
}
async function holdAll() {
  const max = appPool.options.max;
  const held = [];
  for (let i = 0; i < max; i += 1) held.push(await appPool.connect());
  return held;
}
const timeoutError = () => new Error("timeout exceeded when trying to connect");
// Only pool.connect() fails: the session lookup (pool.query) still works.
const promiseCheckoutsFail = (form) => (form === "promise" ? timeoutError() : null);
function noLeakInLogs(where) {
  for (const line of logLines) {
    assert.ok(!line.includes(MARKER_BODY), `${where}: a log line carries the request body`);
    assert.ok(!/\b(select|insert|update|delete)\b\s/i.test(line) || !line.includes("[db]"), `${where}: a [db] log line carries SQL`);
    assert.ok(!line.includes(db.url), `${where}: a log line carries the connection string`);
  }
}

test("the pool's checkout is bounded: with every client held, pool.connect() and pool.query() fail within the bound with the stable code", { timeout: 10_000 }, async () => {
  assert.equal(dbModule.POOL_CHECKOUT_TIMEOUT_MS, BOUND_MS);
  assert.equal(appPool.options.connectionTimeoutMillis, BOUND_MS);
  const held = await holdAll();
  try {
    const started = Date.now();
    await assert.rejects(appPool.connect(), (error) => error.code === dbModule.POOL_CHECKOUT_TIMEOUT && dbModule.isPoolCheckoutTimeout(error));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= BOUND_MS - 50 && elapsed < BOUND_MS + 1_500, `the checkout ended within its bound (${elapsed} ms)`);
    await assert.rejects(appPool.query("select 1"), (error) => error.code === dbModule.POOL_CHECKOUT_TIMEOUT);
    assert.equal(appPool.waitingCount, 0, "the timed-out waiters left the queue");
  } finally {
    for (const client of held) client.release();
  }
});

test("a client that becomes free after a waiter timed out is not handed to that waiter: it returns to the pool at once", { timeout: 10_000 }, async () => {
  const held = await holdAll();
  const max = held.length;
  let late = null;
  const waiter = appPool.connect().then((client) => { late = client; }, (error) => error);
  const outcome = await waiter;
  assert.equal(outcome?.code, dbModule.POOL_CHECKOUT_TIMEOUT, "the waiter timed out");
  held.pop().release();
  await settle();
  assert.equal(late, null, "the timed-out waiter never received a client");
  assert.equal(appPool.idleCount, 1, "the freed client went back to the pool");
  assert.ok(appPool.totalCount <= max);
  const next = await appPool.connect();
  next.release();
  for (const client of held) client.release();
});

test("the process stays alive and answers: with the pool exhausted, a request gets the stable 503 database_busy (no stack, nothing of the request logged); after the clients are free the server answers normally", { timeout: 10_000 }, async () => {
  const user = await platformAdmin();
  const held = await holdAll();
  let res;
  try {
    res = await call("/api/organization", { cookie: user.cookie });
  } finally {
    for (const client of held) client.release();
  }
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: "database_busy", message: "The server is busy right now. Try again in a moment." });
  assert.equal(res.headers.get("retry-after"), "5");
  assert.ok(!/at .*\.js:\d+/.test(res.text), "no stack in the answer");
  const health = await call("/api/health");
  assert.equal(health.status, 200);
  noLeakInLogs("exhausted pool");
});

test("a route that checks out before its own try (Express 4 would drop the rejection): the timeout reaches the error handler as 503, never an unhandled rejection that ends the process", { timeout: 10_000 }, async () => {
  const user = await platformAdmin();
  dbModule.setPoolCheckoutFaultForTests(promiseCheckoutsFail);
  const res = await call(`/api/tests/assignments/${ZERO}/submit`, { method: "POST", cookie: user.cookie, body: { values: {}, note: MARKER_BODY } });
  dbModule.setPoolCheckoutFaultForTests(null);
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "database_busy");
  assert.equal(unhandled.length, 0, "no unhandled rejection");
  noLeakInLogs("route before try");
});

test("the source-connection routes (create, Test, Unbind), the importer's link and the identity read answer their stable try_again; the roster command answers roster_busy", { timeout: 10_000 }, async () => {
  const user = await platformAdmin();
  const { club, team } = await clubAndTeam();
  dbModule.setPoolCheckoutFaultForTests(promiseCheckoutsFail);
  try {
    const cases = [
      ["source create", "/api/training-load/sources/gpexe/connections", "POST", { ownerScope: "club", ownerClubId: club, hostKey: "server3", accountLabel: "Club account", credentialKind: "exchanged_token" }],
      ["source Test", `/api/training-load/sources/gpexe/connections/${ZERO}/test`, "POST", {}],
      ["Unbind", `/api/training-load/sources/gpexe/connections/${ZERO}/bindings/${ZERO}/unbind`, "POST", { requestKey: crypto.randomUUID(), reason: "Pool test", expected: { teamId: team, sourceTeamId: "980" } }],
      ["importer link", `/api/training-load/gpexe/teams/${team}/athlete-links`, "POST", { athleteId: crypto.randomUUID(), gpexeAthleteId: "104" }],
      ["identity read", `/api/training-load/gpexe/teams/${team}/athlete-identities`, "GET", undefined],
    ];
    for (const [name, path, method, body] of cases) {
      const res = await call(path, { method, cookie: user.cookie, body });
      assert.equal(res.status, 409, `${name}: ${res.status} ${res.text}`);
      assert.deepEqual(res.body, { error: "try_again", message: "The server is busy right now. Your request was not carried out; try again in a moment." }, name);
      assert.equal(res.headers.get("retry-after"), "5", name);
    }
    const roster = await call(`/api/training-activity/${ZERO}/roster/${ZERO}/decision`, { method: "PUT", cookie: user.cookie, body: { requestKey: crypto.randomUUID(), kind: "participated_no_values", expectedDecisionId: null } });
    assert.equal(roster.status, 503, `roster: ${roster.text}`);
    assert.equal(roster.body.error, "roster_busy");
  } finally {
    dbModule.setPoolCheckoutFaultForTests(null);
  }
  assert.equal(unhandled.length, 0);
  noLeakInLogs("stable codes");
});

test("a lost answer (the caller gives up while the checkout waits) leaves no client checked out and no waiter behind", { timeout: 10_000 }, async () => {
  const user = await platformAdmin();
  const held = await holdAll();
  const controller = new AbortController();
  const pending = call("/api/organization", { cookie: user.cookie, signal: controller.signal }).catch((error) => error);
  setTimeout(() => controller.abort(), 50);
  const outcome = await pending;
  assert.equal(outcome?.name, "AbortError");
  await new Promise((resolve) => setTimeout(resolve, BOUND_MS + 200));
  for (const client of held) client.release();
  await settle();
  const health = await call("/api/health");
  assert.equal(health.status, 200, "the server still answers");
});

test("a new connection that opens only after its waiter timed out is released at once (never left checked out)", { timeout: 10_000 }, async () => {
  const held = await holdAll();
  const Base = appPool.Client;
  // The connection opened for the waiter is ready only after the waiter's own
  // bound, but before the new connection's bound.
  class SlowClient extends Base {
    connect(callback) {
      return super.connect((error) => setTimeout(() => callback(error), 150));
    }
  }
  let late = null;
  const started = Date.now();
  const waiter = appPool.connect().then((client) => { late = client; return null; }, (error) => error);
  await new Promise((resolve) => setTimeout(resolve, BOUND_MS - 80));
  appPool.Client = SlowClient;
  try {
    held.pop().release(true); // a slot frees: pg-pool opens a new connection for the waiter
    const outcome = await waiter;
    assert.equal(outcome?.code, dbModule.POOL_CHECKOUT_TIMEOUT, "the waiter timed out first");
    assert.ok(Date.now() - started < BOUND_MS + 1_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    appPool.Client = Base;
  }
  assert.equal(late, null, "the waiter never received the late client");
  assert.equal(appPool.totalCount - appPool.idleCount, held.length, "the late client went back to the pool; only the clients still held are checked out");
  for (const client of held) client.release();
});

// The auth routes whose answers must not tell accounts apart (security
// review of f7636e0): a checkout that runs only for a correct password, an
// active account or a pending application must not turn a busy pool into an
// oracle.
function failAfterFirst() {
  let n = 0;
  return () => { n += 1; return n > 1 ? timeoutError() : null; };
}

test("login takes ONE checkout before any decision: when every later checkout times out, a correct password still signs in and a wrong one is the usual 401; when the checkout itself times out, a correct and a wrong password get the identical 503", { timeout: 10_000 }, async () => {
  const { hashPassword } = await import("../src/auth.js");
  const email = `login-${uid()}@test.local`;
  const password = "Correct-Horse-Battery-9";
  await q(`insert into public.users (email, full_name, display_name, password_hash, is_active) values ($1, 'Login Test', 'Login Test', $2, true)`, [email, hashPassword(password)]);
  const login = (pw) => call("/api/auth/login", { method: "POST", body: { email, password: pw } });

  dbModule.setPoolCheckoutFaultForTests(failAfterFirst());
  const right = await login(password);
  dbModule.setPoolCheckoutFaultForTests(failAfterFirst());
  const wrong = await login("Wrong-password-1");
  dbModule.setPoolCheckoutFaultForTests(null);
  assert.equal(right.status, 200, `a correct password needs no second checkout: ${right.text}`);
  assert.equal(wrong.status, 401);

  dbModule.setPoolCheckoutFaultForTests(() => timeoutError());
  const rightBusy = await login(password);
  const wrongBusy = await login("Wrong-password-1");
  dbModule.setPoolCheckoutFaultForTests(null);
  assert.equal(rightBusy.status, 503);
  assert.deepEqual([rightBusy.status, rightBusy.body], [wrongBusy.status, wrongBusy.body], "a busy pool answers the same whatever the password");
  noLeakInLogs("login");
});

test("forgot password and the verification resend answer the same generic body for an existing account (or pending application) whose second checkout times out as for an unknown email", { timeout: 10_000 }, async () => {
  const active = `forgot-${uid()}@test.local`;
  await q(`insert into public.users (email, full_name, display_name, is_active) values ($1, 'Forgot Test', 'Forgot Test', true)`, [active]);
  const unknown = `nobody-${uid()}@test.local`;
  const forgot = (email) => call("/api/auth/password/forgot", { method: "POST", body: { email } });
  const unknownAnswer = await forgot(unknown);
  dbModule.setPoolCheckoutFaultForTests(failAfterFirst());
  const activeAnswer = await forgot(active);
  dbModule.setPoolCheckoutFaultForTests(null);
  assert.equal(unknownAnswer.status, 200);
  assert.deepEqual([activeAnswer.status, activeAnswer.body], [unknownAnswer.status, unknownAnswer.body], "forgot: the same generic answer");

  const pending = `pending-${uid()}@test.local`;
  // The disposable database carries the GPEXE migration set only. The
  // resend's first step reads just these columns, and its second checkout is
  // the one that fails here, so a minimal table of this disposable database
  // is enough when the real one is missing.
  if (!(await q(`select to_regclass('public.athlete_join_applications') as t`))[0].t) {
    await q(`create table public.athlete_join_applications (id uuid primary key default gen_random_uuid(), join_link_id uuid not null, email text not null, applicant_user_id uuid, status text not null default 'pending', submitted_at timestamptz not null default now())`);
  }
  await q(`insert into public.athlete_join_applications (join_link_id, email) values ($1, $2)`, [crypto.randomUUID(), pending]);
  const resend = (email) => call("/api/auth/email-verifications/resend", { method: "POST", body: { email } });
  const resendUnknown = await resend(unknown);
  dbModule.setPoolCheckoutFaultForTests(failAfterFirst());
  const resendPending = await resend(pending);
  dbModule.setPoolCheckoutFaultForTests(null);
  assert.equal(resendUnknown.status, 200);
  assert.deepEqual([resendPending.status, resendPending.body], [resendUnknown.status, resendUnknown.body], "resend: the same generic answer");
  noLeakInLogs("forgot / resend");
});
