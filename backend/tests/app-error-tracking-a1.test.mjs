// Option A, A1: error tracking (migration v58, appErrorTracking.js, routes/appErrors.js, the global handler hook).
// Disposable database only; no GPEXE request. What it proves:
//   1. the sanitizers keep only closed shapes (no message, id, e-mail, query string, token) and the fingerprint is stable;
//   2. the table's own CHECKs refuse free text even from a raw writer, and only repeat_count / last_seen_at may change;
//   3. the ingest route: login required, closed body, size and rate limits, repeat counting, per-user rows, roles;
//   4. the read route is for a platform admin only, anyone else gets the unknown-route 404;
//   5. a server error is recorded without its message; the retention purge deletes only old rows.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const V70_FILE = "202611131400_app_error_events_v70_device_and_keyed_hash.sql";
let db, k, server, base, T, M;
const uid = () => crypto.randomBytes(4).toString("hex");
const SECRET = "ana.example@example.invalid";

async function user(label, { platform = false, coach = false } = {}) {
  const id = (await k.query(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${uid()}@example.invalid`, label])).rows[0].id;
  if (platform) await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  if (coach) await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [id]);
  const token = await T.createSession(id);
  return { id, cookie: `optimove_session=${token}` };
}
async function call(path, { method = "GET", body, cookie, raw } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json, text };
}
const rows = async () => (await k.query(`select * from public.app_error_events order by id`)).rows;
const GOOD = { screen: "training-load", action: "open-imports", code: "js_error", stackSig: "renderImports@gpexe-import-view.js > start@app.js" };

before(async () => {
  // v58 and, on top of it, v70 (the code writes v70's columns). Test 7 takes v70 off again before it rehearses v58's own rollback.
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "a1err", migrations: [...GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("app_error_events")) + 1), V70_FILE] });
  process.env.APP_ERROR_USER_HASH_KEYS = `2:${crypto.randomBytes(32).toString("base64")}`;
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  process.env.DATABASE_URL = db.url;
  M = await import("../src/appErrorTracking.js");
  T = await import("../src/auth.js");
  const { app } = await import("../src/server.js");
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  server?.closeAllConnections?.();
  await new Promise((r) => server?.close(r));
  const { pool } = await import("../src/db.js");
  await pool.end().catch(() => {});
  await k?.end().catch(() => {});
  await db?.drop();
});

test("1. sanitizers keep closed shapes only", () => {
  assert.equal(M.normalizeRoute("/api/athletes/3f2b8c1e-1111-4222-8333-444455556666/plans/12?token=abc#x"), "/api/athletes/:id/plans/:id");
  assert.equal(M.normalizeRoute("/api/training-load/gpexe/teams/:teamId/status"), "/api/training-load/gpexe/teams/:teamId/status");
  assert.equal(M.normalizeRoute("/api/x/ana@example.invalid"), "/api/x/:x");
  assert.equal(M.normalizeRoute("no-slash"), null);
  assert.ok(M.normalizeRoute(`/${"a/".repeat(100)}`).length <= 120);
  const err = new Error(`failed for ${SECRET} body={"password":"hunter2"}`);
  const sig = M.stackSignatureFromError(err);
  assert.ok(!/hunter2|example|password|\d+:\d+/.test(sig || ""), sig);
  // Windows drive-letter paths can leave the native stack without a recognized frame.
  if (process.platform === "win32" && sig === null) {
    assert.match(err.stack, /[A-Za-z]:[\\/]/);
  } else {
    assert.match(sig || "", /^[A-Za-z0-9_.$]{1,40}@[A-Za-z0-9_.-]{1,40}( > [A-Za-z0-9_.$]{1,40}@[A-Za-z0-9_.-]{1,40}){0,3}$/);
  }
  const synthetic = new Error(err.message);
  synthetic.stack = synthetic.message + "\n    at handleRequest (file:///app/backend/src/routes.js:1:1)";
  assert.equal(M.stackSignatureFromError(synthetic), "handleRequest@routes.js");
  assert.ok(!/secret/.test(M.stackSignatureFromError(new Error("x\n    at secret-ana-example (file.js:1:1)")) || ""), "a message line that looks like a frame is not read as one");
  assert.equal(M.cleanStackSignature("a b\nc'; drop table x;--"), null);
  for (const bad of ["ana.example@example.invalid reset token abc for Ana Example", "Error: boom", "a@b > ", "fn@file > fn@file > fn@file > fn@file > fn@file", "x".repeat(300)]) assert.equal(M.cleanStackSignature(bad), null, bad);
  assert.equal(M.cleanStackSignature("render@view.js > start@app.js"), "render@view.js > start@app.js");
  const long = new Error("x");
  long.stack = "Error: x\n" + ["queryBuiltInSeriesFromContext@trainingLoadDashboardQuery.js", "resolveFactsToRowsAndShiftRanges@trainingLoadDashboardQuery.js", "executeDashboardQueryForWidgets@trainingLoadDashboardWidgets.js", "handler@trainingLoadDashboard.js"].map((f) => `    at ${f.split("@")[0]} (file:///app/backend/src/${f.split("@")[1]}:1:1)`).join("\n");
  const longSig = M.stackSignatureFromError(long);
  assert.ok(longSig && longSig.length <= 200 && longSig.startsWith("queryBuiltInSeriesFromContext@"), `long real names keep the whole frames that fit (${longSig})`);
  const a = M.fingerprintOf({ source: "client", where: "home", action: "x", code: "c", status: 500, stackSignature: "f@a.js" });
  assert.equal(a, M.fingerprintOf({ source: "client", where: "home", action: "x", code: "c", status: 500, stackSignature: "f@a.js" }));
  assert.notEqual(a, M.fingerprintOf({ source: "client", where: "home", action: "x", code: "c", status: 501, stackSignature: "f@a.js" }));
  assert.match(M.userHash("u-1"), /^[0-9a-f]{12}$/);
  assert.equal(M.userHash(null), null);
  assert.ok(M.sanitizeClientReport(GOOD));
  for (const bad of [null, [], "x", { ...GOOD, extra: 1 }, { ...GOOD, screen: "Training Load" }, { ...GOOD, screen: SECRET }, { ...GOOD, code: "Error: boom" }, { ...GOOD, action: "a".repeat(61) }, { ...GOOD, status: 99 }, { ...GOOD, status: "500" }, { ...GOOD, stackSig: 5 }, { screen: "home" }, { ...GOOD, message: "boom" }, { ...GOOD, url: "/x?token=1" }, { ...GOOD, release: 7 }, { ...GOOD, stackSig: "ana.example@example.invalid reset token abc123 for Ana Example" }, { ...GOOD, stackSig: "Cannot read properties of undefined" }]) {
    assert.equal(M.sanitizeClientReport(bad), null, JSON.stringify(bad));
  }
  assert.equal(M.sanitizeClientReport({ ...GOOD, release: "not-a-commit" }).release === "not-a-commit", false, "a non-hex release is replaced, never stored");
  // What failed: one word of the closed list, only with the three codes that take one, stored as the code's second part.
  assert.equal(M.sanitizeClientReport({ ...GOOD, reason: "typeerror" }).code, "js_error.typeerror");
  assert.equal(M.sanitizeClientReport({ screen: "weekly", action: "open-media", code: "unhandled_rejection", reason: "aborterror" }).code, "unhandled_rejection.aborterror");
  assert.equal(M.sanitizeClientReport({ screen: "weekly", code: "handler_error", reason: "none" }).code, "handler_error.none");
  assert.equal(M.sanitizeClientReport(GOOD).code, "js_error", "a report without the word is stored as before (an older page still open)");
  for (const code of M.CODES_WITH_REASON) for (const reason of M.CLIENT_REASONS) {
    const out = M.sanitizeClientReport({ screen: "weekly", code, reason });
    assert.match(out.code, /^[a-z0-9_.-]{1,60}$/, `${code} with ${reason} fits the column's shape`);
  }
  for (const bad of [{ ...GOOD, reason: "AbortError" }, { ...GOOD, reason: "abort error" }, { ...GOOD, reason: SECRET }, { ...GOOD, reason: "" }, { ...GOOD, reason: 1 }, { ...GOOD, reason: ["aborterror"] },
    { ...GOOD, code: "no_response", reason: "aborterror" }, { ...GOOD, code: "http_500", reason: "typeerror" }, { ...GOOD, code: "js_error.typeerror", reason: "typeerror" }]) {
    assert.equal(M.sanitizeClientReport(bad), null, JSON.stringify(bad));
  }
  assert.notEqual(
    M.fingerprintOf({ source: "client", where: "weekly", action: "open-media", code: M.sanitizeClientReport({ screen: "weekly", code: "unhandled_rejection", reason: "aborterror" }).code, status: null, stackSignature: null }),
    M.fingerprintOf({ source: "client", where: "weekly", action: "open-media", code: M.sanitizeClientReport({ screen: "weekly", code: "unhandled_rejection", reason: "notallowederror" }).code, status: null, stackSignature: null }),
    "two reasons are two kinds of error");
});

test("2. the table refuses free text, and only the count and the last-seen time change", async () => {
  const ok = { fp: "a".repeat(64) };
  const ins = (over = {}) => {
    if (over.first_seen_at) return k.query(`insert into public.app_error_events (fingerprint, source, screen, error_code, role, first_seen_at, last_seen_at) values ($1,'client','home','js_error','coach',$2,$2)`, [ok.fp, over.first_seen_at]);
    const v = { fingerprint: ok.fp, source: "client", screen: "home", route_template: null, action: null, error_code: "js_error", http_status: null, role: "coach", release_commit: null, user_hash: null, stack_signature: null, ...over };
    return k.query(`insert into public.app_error_events (fingerprint, source, screen, route_template, action, error_code, http_status, role, release_commit, user_hash, stack_signature) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [v.fingerprint, v.source, v.screen, v.route_template, v.action, v.error_code, v.http_status, v.role, v.release_commit, v.user_hash, v.stack_signature]);
  };
  await ins();
  for (const over of [{ error_code: SECRET }, { error_code: "Error: boom" }, { screen: "Ana Example" }, { action: "x y" }, { route_template: "/x?token=1" }, { route_template: "x" }, { stack_signature: "boom\nstack" }, { stack_signature: "a'b" }, { stack_signature: 'ana.example@example.invalid reset token abc123' }, { stack_signature: 'Cannot read properties of undefined' }, { first_seen_at: new Date(Date.now() + 86400000).toISOString() }, { user_hash: "user@example" }, { user_hash: "a".repeat(13) }, { release_commit: "main" }, { role: "admin" }, { source: "browser" }, { fingerprint: "xyz" }, { http_status: 700 }, { source: "server", screen: "home", route_template: "/api/x" }, { source: "client", screen: null }]) {
    await assert.rejects(ins(over), (e) => e.code === "23514", JSON.stringify(over));
  }
  await assert.rejects(k.query(`update public.app_error_events set error_code = 'other'`), (e) => e.code === "23514");
  await assert.rejects(k.query(`update public.app_error_events set repeat_count = 0`), (e) => e.code === "23514");
  await assert.rejects(k.query(`update public.app_error_events set last_seen_at = now() + interval '1 day'`), (e) => e.code === "23514", "a future last_seen_at would defeat the purge");
  await k.query(`insert into public.app_error_events (fingerprint, source, screen, error_code, role, first_seen_at, last_seen_at) values ($1,'client','home','js_error','coach', now() - interval '2 hours', now() - interval '1 hour')`, ["d".repeat(64)]);
  await assert.rejects(k.query(`update public.app_error_events set last_seen_at = now() - interval '90 minutes' where fingerprint = $1`, ["d".repeat(64)]), (e) => e.code === "23514", "last_seen_at never moves back");
  await k.query(`update public.app_error_events set repeat_count = repeat_count + 1, last_seen_at = now()`);
  await assert.rejects(k.query(`truncate public.app_error_events`), (e) => e.code === "23514");
  await k.query(`delete from public.app_error_events`);
});

test("3. ingest: login, closed body, repeat count, per-user rows, role, size and rate limit", async () => {
  M.resetRateLimitForTests();
  const coach = await user("Coach Example", { coach: true });
  const other = await user("Other Example", { coach: true });
  const admin = await user("Admin Example", { platform: true });
  assert.equal((await call("/api/app-errors", { method: "POST", body: GOOD })).status, 401);
  assert.equal((await rows()).length, 0);
  const r1 = await call("/api/app-errors", { method: "POST", body: GOOD, cookie: coach.cookie });
  assert.equal(r1.status, 204);
  assert.equal(r1.text, "");
  await call("/api/app-errors", { method: "POST", body: GOOD, cookie: coach.cookie });
  let all = await rows();
  assert.equal(all.length, 1);
  assert.equal(all[0].repeat_count, 2);
  assert.equal(all[0].role, "coach");
  // The word of what failed travels as its own key and is stored inside the code; a word outside the list stores nothing.
  const rowsBeforeReason = (await rows()).length;
  assert.equal((await call("/api/app-errors", { method: "POST", body: { screen: "weekly", action: "open-media", code: "unhandled_rejection", reason: "aborterror" }, cookie: coach.cookie })).status, 204);
  const refusedReason = await call("/api/app-errors", { method: "POST", body: { screen: "weekly", action: "open-media", code: "unhandled_rejection", reason: SECRET }, cookie: coach.cookie });
  assert.deepEqual([refusedReason.status, refusedReason.text.includes("Secret")], [400, false]);
  const withReason = (await rows()).filter((r) => r.screen === "weekly");
  assert.deepEqual(withReason.map((r) => [r.error_code, r.action, r.stack_signature]), [["unhandled_rejection.aborterror", "open-media", null]]);
  assert.equal((await rows()).length, rowsBeforeReason + 1);
  await k.query(`delete from public.app_error_events where screen = 'weekly'`);
  assert.equal(all[0].user_hash, M.keyedUserHash(coach.id, 2));
  assert.equal(all[0].user_hash_version, 2);
  assert.ok(!JSON.stringify(all[0]).includes(coach.id));
  await call("/api/app-errors", { method: "POST", body: GOOD, cookie: other.cookie });
  await call("/api/app-errors", { method: "POST", body: { ...GOOD, code: "http_500", status: 500 }, cookie: admin.cookie });
  all = await rows();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((r) => r.role).sort(), ["coach", "coach", "platform_admin"]);
  const before = (await rows()).length;
  for (const bad of [{ ...GOOD, message: SECRET }, { ...GOOD, screen: SECRET }, { ...GOOD, code: "Error: x" }, []]) {
    const r = await call("/api/app-errors", { method: "POST", body: bad, cookie: coach.cookie });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.deepEqual(r.body, { error: "invalid_error_report" });
    assert.ok(!r.text.includes("example"));
  }
  assert.equal((await call("/api/app-errors", { method: "POST", raw: "{not json", cookie: coach.cookie })).status, 400);
  assert.equal((await rows()).length, before, "nothing stored from a refused report");
  const big = await call("/api/app-errors", { method: "POST", body: { ...GOOD, stackSig: "a".repeat(6000) }, cookie: coach.cookie });
  assert.equal(big.status, 413);
  M.resetRateLimitForTests();
  let last;
  for (let i = 0; i < 22; i += 1) last = await call("/api/app-errors", { method: "POST", body: { ...GOOD, action: `a${i}` }, cookie: other.cookie });
  assert.equal(last.status, 429);
  M.resetRateLimitForTests();
});

test("3b. a user cannot fill the table: at most 100 new rows per hour", async () => {
  M.resetRateLimitForTests();
  const u = await user("Flood Example", { coach: true });
  let stored = 0;
  for (let i = 0; i < 105; i += 1) {
    if (i % 15 === 0) M.resetRateLimitForTests();
    const out = await M.writeEvent({ source: "client", screen: "home", action: `a${i}`, code: "js_error", role: "coach", userHash: M.userHash(u.id), userHashVersion: 1 });
    if (out === "stored") stored += 1;
  }
  assert.equal(stored, 100);
  M.resetRateLimitForTests();
});

test("4. the read route: platform admin only; everyone else the unknown-route 404", async () => {
  const admin = await user("Reader Example", { platform: true });
  const coach = await user("Coach2 Example", { coach: true });
  const ok = await call("/api/app-errors/groups?days=7", { cookie: admin.cookie });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.groups) && ok.body.groups.length > 0);
  const g = ok.body.groups[0];
  assert.deepEqual(Object.keys(g).sort(), ["action", "code", "fingerprint", "firstSeenAt", "lastSeenAt", "occurrences", "release", "roles", "routeTemplate", "screen", "source", "stackSignature", "status", "users"]);
  assert.ok(!JSON.stringify(ok.body).includes("example.invalid"));
  const denied = await call("/api/app-errors/groups", { cookie: coach.cookie });
  const unknown = await call("/api/app-errors/nothing-here", { cookie: coach.cookie });
  assert.equal(denied.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(Object.keys(denied.body), Object.keys(unknown.body));
  assert.equal((await call("/api/app-errors/groups")).status, 401);
  for (const days of ["0", "31", "x", "1.5"]) assert.equal((await call(`/api/app-errors/groups?days=${days}`, { cookie: admin.cookie })).status, 400, days);
});

test("5. a server error is recorded without its message; the purge deletes only old rows", async () => {
  await k.query(`delete from public.app_error_events`);
  M.resetServerDedupeForTests();
  const err = Object.assign(new Error(`password=hunter2 for ${SECRET}`), { code: "XX000" });
  const req = { baseUrl: "", route: { path: "/:athleteId/plans" }, originalUrl: `/api/athletes/${crypto.randomUUID()}/plans?token=zzz`, user: { id: crypto.randomUUID() }, authz: null };
  M.recordServerError(req, err, 500);
  M.recordServerError(req, err, 404); // not a 5xx
  M.recordServerError({ ...req, route: undefined }, Object.assign(new Error("x"), { code: "Not A Word" }), 502);
  await new Promise((r) => setTimeout(r, 400));
  const all = await rows();
  assert.equal(all.length, 2);
  const a = all.find((r) => r.error_code === "xx000");
  assert.equal(a.source, "server");
  assert.equal(a.route_template, "/api/athletes/:athleteId/plans");
  assert.equal(a.role, "none");
  assert.equal(a.http_status, 500);
  assert.ok(!JSON.stringify(a).match(/hunter2|example|token|zzz/));
  const b = all.find((r) => r.error_code === "internal_error");
  assert.equal(b.route_template, "/unmatched", "a request that matched no route is never recorded by its URL");
  assert.ok(!all.some((r) => /athletes|token|zzz/.test(String(r.stack_signature)) && /token|zzz/.test(JSON.stringify(r))));
  M.resetServerDedupeForTests();
  const dup = { ...req, route: { path: "/dup" }, baseUrl: "", originalUrl: "/api/x/dup" };
  M.recordServerError(dup, err, 500);
  M.recordServerError(dup, err, 500);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await rows()).filter((r) => r.route_template === "/api/x/dup").length, 1, "a repeat inside the window does not reach the database again");
  await k.query(`delete from public.app_error_events where route_template = '/api/x/dup'`);
  // purge
  await k.query(`insert into public.app_error_events (fingerprint, source, screen, error_code, role, first_seen_at, last_seen_at) values ($1,'client','home','js_error','coach', now() - interval '40 days', now() - interval '35 days')`, ["b".repeat(64)]);
  await k.query(`insert into public.app_error_events (fingerprint, source, screen, error_code, role, first_seen_at, last_seen_at) values ($1,'client','home','js_error','coach', now() - interval '40 days', now() - interval '2 days')`, ["c".repeat(64)]);
  const purged = await M.purgeAppErrorEvents();
  assert.equal(purged, 1);
  assert.equal((await rows()).length, 3);
});

test("5a. a 5xx storm: the same error reaches the database once, and writes in flight are bounded", async () => {
  M.resetServerDedupeForTests();
  let connects = 0;
  const stub = { connect: async () => { connects += 1; return new Promise(() => {}); } };
  const e = Object.assign(new Error("x"), { code: "XX000" });
  const same = { baseUrl: "", route: { path: "/same" }, originalUrl: "/api/y/same", user: null, authz: null };
  for (let i = 0; i < 300; i += 1) M.recordServerError(same, e, 500, { executor: stub });
  assert.equal(connects, 1, "300 identical errors open one connection");
  for (let i = 0; i < 300; i += 1) M.recordServerError({ ...same, route: { path: `/r${i}` } }, e, 500, { executor: stub });
  assert.ok(connects <= 10, `distinct errors are bounded in flight (${connects})`);
  M.resetServerDedupeForTests();
});

test("5c. through a real route: a 5xx answers the generic body and one sanitized row is stored", async () => {
  await k.query(`delete from public.app_error_events`);
  M.resetServerDedupeForTests();
  const admin = await user("Boom Example", { platform: true });
  const { pool } = await import("../src/db.js");
  const realQuery = pool.query.bind(pool);
  pool.query = (text, ...rest) => (typeof text === "string" && text.includes("from public.app_error_events") && text.includes("array_agg")
    ? Promise.reject(new Error(`boom ${SECRET} password=hunter2`)) : realQuery(text, ...rest));
  let res;
  try { res = await call("/api/app-errors/groups", { cookie: admin.cookie }); } finally { pool.query = realQuery; }
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "Internal server error", "the answer is the handler's own, unchanged by the recording (outside production the handler has always echoed the message)");
  let stored = [];
  for (let i = 0; i < 50 && !stored.length; i += 1) { await new Promise((r) => setTimeout(r, 50)); stored = await rows(); }
  assert.equal(stored.length, 1);
  assert.equal(stored[0].source, "server");
  assert.equal(stored[0].route_template, "/api/app-errors/groups");
  assert.equal(stored[0].http_status, 500);
  assert.equal(stored[0].role, "platform_admin");
  assert.ok(!/boom|example|hunter2/.test(JSON.stringify(stored[0])));
  await k.query(`delete from public.app_error_events`);
});

test("5d. concurrent reports of the same user and fingerprint all count (the update guard never rejects a legitimate bump)", async () => {
  await k.query(`delete from public.app_error_events`);
  const ev = { source: "client", screen: "home", action: "race", code: "js_error", role: "coach", userHash: M.userHash("race-user"), userHashVersion: 1 };
  const outcomes = await Promise.all(Array.from({ length: 12 }, () => M.writeEvent(ev)));
  assert.equal(outcomes.filter((o) => o === "stored").length, 1);
  assert.equal(outcomes.filter((o) => o === "counted").length, 11);
  const r = await rows();
  assert.equal(r.length, 1);
  assert.equal(r[0].repeat_count, 12);
  await k.query(`delete from public.app_error_events`);
});

test("5b. events without a user are capped too", async () => {
  await k.query(`delete from public.app_error_events`);
  let stored = 0;
  for (let i = 0; i < 205; i += 1) if ((await M.writeEvent({ source: "client", screen: "home", action: `n${i}`, code: "js_error", role: "none", userHash: null })) === "stored") stored += 1;
  assert.equal(stored, 200);
  await k.query(`delete from public.app_error_events`);
});

test("6. the global handler records 5xx through recordServerError and a refused report never loops", async () => {
  const fs = await import("node:fs/promises");
  const src = await fs.readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const handler = src.slice(src.indexOf("app.use((error, req, res, next)"));
  assert.match(handler, /if \(!error\.skipAppErrorRecord\) recordServerError\(req, error, status\)/);
  assert.ok(handler.indexOf("recordServerError") > handler.indexOf("console.error(error)"));
  assert.ok(!/recordServerError\([^)]*error\.message/.test(src));
  assert.match(src, /"\/api\/app-errors", requireAuth, appErrorsRouter/);
  assert.match(src, /startAppErrorRetentionSchedule\(\)/);
});

test("7. the preflight and post-check read what they claim, and the rollback removes v58 and v58 applies again", async () => {
  const fs = await import("node:fs/promises");
  const dir = new URL("../../docs/runbooks/", import.meta.url);
  const MIG = "migrations_v2/202611091000_app_error_events.sql";
  const blocks = (sql) => sql.split(/^-- \d+\./m).slice(1).map((b) => b.split("\n").slice(1).filter((l) => !l.startsWith("--")).join("\n").trim()).filter(Boolean);
  // v70 comes off first (its own rehearsal is app-error-events-v70.test.mjs); its rollback refuses while a keyed hash is stored, so the rows go first.
  const v70Rollback = await fs.readFile(new URL("app-error-events-v70-rollback.sql", dir), "utf8");
  await k.query(`delete from public.app_error_events`);
  await k.query(v70Rollback);
  const post = blocks(await fs.readFile(new URL("app-error-events-v58-postcheck.sql", dir), "utf8"));
  assert.equal(post.length, 7);
  const r1 = (await k.query(post[0])).rows[0];
  assert.deepEqual([r1.recorded_once, r1.is_last], [true, true]);
  const r2 = (await k.query(post[1])).rows[0];
  assert.deepEqual(Object.values(r2), [true, true, true, true]);
  assert.equal((await k.query(post[4])).rows[0].ok, true);
  assert.deepEqual(Object.values((await k.query(post[5])).rows[0]), [true, true, true], "RLS on, nothing for PUBLIC");
  assert.equal((await k.query(post[2])).rows[0].ok, true);
  const pre = blocks(await fs.readFile(new URL("app-error-events-v58-preflight.sql", dir), "utf8"));
  assert.equal(pre.length, 5);
  const p1 = (await k.query(pre[0])).rows[0];
  assert.equal(p1.v58_absent, false, "on a database that has v58 the preflight says so");
  const rollback = await fs.readFile(new URL("app-error-events-v58-rollback.sql", dir), "utf8");
  await k.query(rollback);
  assert.equal((await k.query(`select to_regclass('public.app_error_events') as t`)).rows[0].t, null);
  assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [MIG])).rows[0].n, 0);
  assert.equal((await k.query(`select count(*)::int as n from pg_proc where proname like 'app_error_events_%'`)).rows[0].n, 0);
  assert.ok((await k.query(pre[0])).rows[0].v58_absent, "after the rollback v58 is absent again");
  assert.ok(Object.values((await k.query(pre[1])).rows[0]).every(Boolean));
  await assert.rejects(k.query(rollback), /v58 is not recorded/, "a second rollback refuses");
  await k.query("rollback");
  // Re-apply with Supabase-like roles whose default privileges would grant them the table: the migration must take everything back.
  const made = [];
  for (const role of ["anon", "authenticated"]) {
    if (!(await k.query(`select 1 from pg_roles where rolname = $1`, [role])).rowCount) { await k.query(`create role ${role} nologin`); made.push(role); }
  }
  await k.query(`alter default privileges in schema public grant all on tables to anon, authenticated, public`);
  try {
    await k.query(await fs.readFile(new URL("../../migrations_v2/202611091000_app_error_events.sql", import.meta.url), "utf8"));
    assert.ok((await k.query(`select to_regclass('public.app_error_events') as t`)).rows[0].t);
    for (const role of ["anon", "authenticated"]) {
      for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) assert.equal((await k.query(`select has_table_privilege($1, 'public.app_error_events', $2) as h`, [role, priv])).rows[0].h, false, `${role} ${priv}`);
    }
    assert.equal((await k.query(`select relrowsecurity from pg_class where oid = 'public.app_error_events'::regclass`)).rows[0].relrowsecurity, true);
    const postAgain = (await fs.readFile(new URL("app-error-events-v58-postcheck.sql", dir), "utf8")).split(/^-- \d+\./m).slice(1).map((b) => b.split("\n").slice(1).filter((l) => !l.startsWith("--")).join("\n").trim()).filter(Boolean);
    assert.deepEqual(Object.values((await k.query(postAgain[5])).rows[0]), [true, true, true], "default privileges that granted PUBLIC are taken back");
  } finally {
    await k.query(`alter default privileges in schema public revoke all on tables from anon, authenticated, public`);
    for (const role of made) { try { await k.query(`drop owned by ${role}`); await k.query(`drop role ${role}`); } catch { /* left for the cluster's owner */ } }
  }
});
