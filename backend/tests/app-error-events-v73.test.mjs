// App health, AH-2b (migration v73): which request failed (a method and a route pattern made of the server's own
// words), how long the server had been up, whether the page was older than the server, a report delivered late; the
// groups read; and the rehearsed rollback. Disposable database only; invented data only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const V70 = "migrations_v2/202611131400_app_error_events_v70_device_and_keyed_hash.sql";
const V73_FILE = "202611151500_app_error_events_v73_request_and_restart.sql";
const V73 = `migrations_v2/${V73_FILE}`;
const RUNBOOKS = new URL("../../docs/runbooks/", import.meta.url);
const SERVER_COMMIT = "0123456789abcdef0123456789abcdef01234567";
let db, k, server, base, T, M;
const uid = () => crypto.randomBytes(4).toString("hex");

async function user(label, { platform = false } = {}) {
  const id = (await k.query(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${uid()}@example.invalid`, label])).rows[0].id;
  await k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,$2,true)`, [id, platform ? "platform_admin" : "independent_coach"]);
  return { id, cookie: `optimove_session=${await T.createSession(id)}` };
}
async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, body: json, text };
}
const rows = async () => (await k.query(`select * from public.app_error_events order by id`)).rows;
const clear = async () => { await k.query(`delete from public.app_error_events`); M.resetRateLimitForTests(); M.resetNoKeyReportsForTests(); M.resetServerDedupeForTests(); };
const FAILED = { screen: "weekly", action: "open-media", code: "no_response" };
const blocks = (sql) => sql.split(/^-- \d+\./m).slice(1).map((b) => b.split("\n").slice(1).filter((l) => !l.startsWith("--")).join("\n").trim()).filter(Boolean);
const guardMd5 = async () => (await k.query(`select md5(prosrc) as m from pg_proc where pronamespace = 'public'::regnamespace and proname = 'app_error_events_guard_update'`)).rows[0].m;
const rawInsert = (over = {}) => {
  const v = { fingerprint: crypto.randomBytes(32).toString("hex"), source: "client", screen: "home", route_template: null, error_code: "no_response", role: "coach", ...over };
  const keys = Object.keys(v);
  return k.query(`insert into public.app_error_events (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(v));
};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "ah2bv73",
    migrations: [...GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("app_error_events")) + 1), V70.split("/")[1], V73_FILE] });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  process.env.DATABASE_URL = db.url;
  process.env.APP_ERROR_USER_HASH_KEYS = `2:${crypto.randomBytes(32).toString("base64")}`;
  process.env.RENDER_GIT_COMMIT = SERVER_COMMIT;
  M = await import("../src/appErrorTracking.js");
  T = await import("../src/auth.js");
  const { app } = await import("../src/server.js");
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  M?.setUptimeForTests();
  server?.closeAllConnections?.();
  await new Promise((r) => server?.close(r));
  const { pool } = await import("../src/db.js");
  await pool.end().catch(() => {});
  await k?.end().catch(() => {});
  await db?.drop();
});

test("1. the request of a report: a method of five and a route normalized again by the server and made of the server's own words; anything else refuses the report", async () => {
  const ok = (route, method = "GET") => M.sanitizeRequest({ method, route });
  assert.deepEqual(ok("/api/media/access", "POST"), { method: "POST", route: "/api/media/access" });
  assert.deepEqual(ok("/api/athletes/3f2b8c1e-1111-4222-8333-444455556666/plans?token=abc#x"), { method: "GET", route: "/api/athletes/:id/plans" });
  assert.deepEqual(ok("/api/exercises/12"), { method: "GET", route: "/api/exercises/:id" });
  assert.deepEqual(M.sanitizeRequest(undefined), {});
  assert.deepEqual(M.sanitizeRequest(null), {});
  // The server's own words only: a name, a search word or an e-mail that ended up in a path is ":x".
  const { app } = await import("../src/server.js");
  const words = M.collectRouteWords(app);
  for (const w of ["api", "app-errors", "athletes", "media", "access", "groups"]) assert.ok(words.has(w), w);
  for (const w of ["id", ":id", "athleteId", "ana-example", ""]) assert.equal(words.has(w), false, w);
  assert.ok(words.size > 100 && [...words].every((w) => /^[A-Za-z0-9_.-]{1,40}$/.test(w)));
  assert.deepEqual(ok("/api/athletes/ana-example/plans"), { method: "GET", route: "/api/athletes/:x/plans" });
  assert.equal(/ana|example/i.test(ok("/api/exercises/search/Ana.Example").route), false);
  assert.equal(ok("/api/users/ana.example@example.invalid/x").route.includes("ana"), false);
  assert.equal(ok("/api/athletes/Ana%20Example").route, "/api/athletes/:x");
  for (const hostile of ["/api/athletes/ana-example", "/api/x/Secret.Word/y", "/secret-word", "/api/athletes/ana_example_2001"]) {
    assert.equal(/ana|secret|2001/i.test(ok(hostile).route), false, hostile);
  }
  // Without the words (the app never set them) nothing of the path is kept: closed, never the path.
  M.setRouteWords(null);
  assert.equal(ok("/api/athletes/ana-example/plans").route, "/:x/:x/:x/:x");
  assert.equal(ok("/api/athletes/12").route, "/:x/:x/:id");
  M.setRouteWords(words);
  // A route that grows past the table's 120 characters once its segments are ":x" is refused, not stored and not a failed insert.
  const long = `/api${"/a".repeat(58)}`;
  assert.equal(long.length, 120);
  assert.equal(M.sanitizeRequest({ method: "GET", route: long }), null);
  assert.equal(M.sanitizeRequest({ method: "GET", route: `/${"a/".repeat(199)}` }), null);
  assert.equal(ok(`/api${"/a".repeat(38)}`).route.length, 4 + 38 * 3);
  // Refused whole.
  for (const bad of ["GET /api/x", ["GET", "/api/x"], 1, true, { method: "GET" }, { route: "/api/x" }, { method: "get", route: "/api/x" }, { method: "HEAD", route: "/api/x" }, { method: "GET", route: "api/x" },
    { method: "GET", route: "https://app.example/api/x" }, { method: "GET", route: 12 }, { method: "GET", route: `/${"a/".repeat(250)}` }, { method: "GET", route: "/api/x", url: "/api/x?token=1" },
    { method: "GET", route: "/api/x", query: "a=1" }, { method: ["GET"], route: "/api/x" }]) {
    assert.equal(M.sanitizeRequest(bad), null, JSON.stringify(bad).slice(0, 50));
    assert.equal(M.sanitizeClientReport({ ...FAILED, request: bad }), null);
  }
  for (const late of ["soon", "LT_1M", 5, true, ["lt_1m"], { a: 1 }]) assert.equal(M.sanitizeClientReport({ ...FAILED, late }), null, String(late));
  for (const late of M.LATE_BUCKETS) assert.equal(M.sanitizeClientReport({ ...FAILED, late }).late, late);
  assert.deepEqual([M.REQUEST_METHODS, M.LATE_BUCKETS, M.UPTIME_BUCKETS].map((l) => l.length), [5, 4, 3]);
});

test("2. the server's uptime as a word, and whether the page is older than the server", () => {
  for (const [s, word] of [[0, "lt_2m"], [119.9, "lt_2m"], [120, "lt_10m"], [599, "lt_10m"], [600, "ge_10m"], [86400 * 30, "ge_10m"], [-1, null], [NaN, null], ["x", null]]) {
    M.setUptimeForTests(() => s);
    assert.equal(M.serverUptimeBucket(), word, String(s));
  }
  M.setUptimeForTests();
  assert.ok(M.UPTIME_BUCKETS.includes(M.serverUptimeBucket()), "the real process has one");
  assert.equal(M.pageBehindServer(SERVER_COMMIT), false);
  assert.equal(M.pageBehindServer(SERVER_COMMIT.slice(0, 7)), false, "a short build word of the same commit");
  assert.equal(M.pageBehindServer("f".repeat(40)), true);
  assert.equal(M.pageBehindServer("fffffff"), true);
  for (const unknown of [null, undefined, "", "not-a-commit", 12, "ABC"]) assert.equal(M.pageBehindServer(unknown), null, String(unknown));
  const saved = process.env.RENDER_GIT_COMMIT;
  delete process.env.RENDER_GIT_COMMIT;
  try { assert.equal(M.pageBehindServer("f".repeat(40)), null, "the server's own build unknown"); } finally { process.env.RENDER_GIT_COMMIT = saved; }
});

test("3. the table: the lists, a route that is a pattern, both or neither, browser rows only, the five columns final", async () => {
  await clear();
  assert.equal(await guardMd5(), "05cd59a40237bf6b443d268961409d93");
  const plain = (await k.query(`select * from public.app_error_events where id = $1`, [(await rawInsert()).rows[0].id])).rows[0];
  assert.deepEqual([plain.request_method, plain.request_route, plain.server_uptime, plain.page_behind_server, plain.delivered_late], [null, null, null, null, null], "a writer that does not know v73");
  for (const m of M.REQUEST_METHODS) await rawInsert({ request_method: m, request_route: "/api/x/:id" });
  for (const u of M.UPTIME_BUCKETS) await rawInsert({ server_uptime: u });
  for (const l of M.LATE_BUCKETS) await rawInsert({ delivered_late: l });
  await assert.rejects(rawInsert({ request_method: "HEAD", request_route: "/api/x" }), /request_method_known/);
  await assert.rejects(rawInsert({ request_method: "get", request_route: "/api/x" }), /request_method_known/);
  for (const route of ["/api/x?token=1", "/api/x#y", "api/x", "/api/ana example", "/api/a@b", `/${"a".repeat(121)}`]) {
    await assert.rejects(rawInsert({ request_method: "GET", request_route: route }), /request_route_shape/, route);
  }
  await assert.rejects(rawInsert({ request_method: "GET" }), /request_whole/);
  await assert.rejects(rawInsert({ request_route: "/api/x" }), /request_whole/);
  await assert.rejects(rawInsert({ server_uptime: "5 minutes" }), /server_uptime_known/);
  await assert.rejects(rawInsert({ delivered_late: "late" }), /delivered_late_known/);
  const serverRow = { source: "server", screen: null, route_template: "/api/x", error_code: "internal_error" };
  for (const over of [{ request_method: "GET", request_route: "/api/x" }, { page_behind_server: true }, { page_behind_server: false }, { delivered_late: "lt_1m" }]) {
    await assert.rejects(rawInsert({ ...serverRow, ...over }), /request_client_only/, JSON.stringify(over));
  }
  await rawInsert({ ...serverRow, server_uptime: "lt_2m" }); // the uptime is every row's
  const full = (await rawInsert({ request_method: "POST", request_route: "/api/media/access", server_uptime: "lt_2m", page_behind_server: true, delivered_late: "lt_10m" })).rows[0].id;
  for (const set of ["request_method = 'GET'", "request_route = '/api/y'", "server_uptime = 'ge_10m'", "page_behind_server = false", "delivered_late = 'ge_1h'", "delivered_late = null", "page_behind_server = null",
    "device_class = 'phone'", "user_hash_version = 3", "role = 'athlete'"]) {
    await assert.rejects(k.query(`update public.app_error_events set ${set} where id = $1`, [full]), /only repeat_count and last_seen_at may change/, set);
  }
  await k.query(`update public.app_error_events set repeat_count = repeat_count + 1 where id = $1`, [full]);
});

test("4. ingest: the request is stored as a pattern and makes the kind; a repeat counts; the uptime, the page's build and a late delivery are recorded; a bad request stores nothing", async () => {
  await clear();
  M.setUptimeForTests(() => 30);
  const coach = await user("Coach Example");
  const post = (body) => call("/api/app-errors", { method: "POST", body, cookie: coach.cookie });
  const ID = "3f2b8c1e-1111-4222-8333-444455556666";
  assert.equal((await post({ ...FAILED, request: { method: "POST", route: `/api/athletes/${ID}/plans?token=abc` }, release: SERVER_COMMIT })).status, 204);
  assert.equal((await post({ ...FAILED, request: { method: "POST", route: "/api/athletes/:id/plans" }, release: SERVER_COMMIT })).status, 204, "the same request, already a pattern");
  assert.equal((await post({ ...FAILED, request: { method: "GET", route: "/api/media/access" }, release: "f".repeat(40) })).status, 204);
  assert.equal((await post(FAILED)).status, 204, "an older page: no request, no build");
  let all = await rows();
  assert.deepEqual(all.map((r) => [r.request_method, r.request_route, r.repeat_count, r.server_uptime, r.page_behind_server, r.delivered_late]), [
    ["POST", "/api/athletes/:id/plans", 2, "lt_2m", false, null],
    ["GET", "/api/media/access", 1, "lt_2m", true, null],
    [null, null, 1, "lt_2m", null, null],
  ]);
  assert.equal(new Set(all.map((r) => r.fingerprint)).size, 3, "two requests are two kinds, and neither is the kind without a request");
  assert.ok(!JSON.stringify(all).includes(ID) && !JSON.stringify(all).includes("token"));
  // A row without a request has the fingerprint it had before v73.
  assert.equal(all[2].fingerprint, crypto.createHash("sha256").update(["client", "weekly", "open-media", "no_response", "", ""].join("|")).digest("hex"));
  assert.equal(all[0].fingerprint, M.fingerprintOf({ source: "client", where: "weekly", action: "open-media", code: "no_response", status: null, stackSignature: null, request: "POST /api/athletes/:id/plans" }));
  // A name in the path never reaches the table.
  assert.equal((await post({ ...FAILED, request: { method: "GET", route: "/api/athletes/ana-example/plans" } })).status, 204);
  assert.equal((await rows()).at(-1).request_route, "/api/athletes/:x/plans");
  // Later, the same failure is another row: the server's uptime is part of the match, so "around a restart" stays true to its rows.
  M.setUptimeForTests(() => 4000);
  assert.equal((await post({ ...FAILED, request: { method: "GET", route: "/api/media/access" }, release: "f".repeat(40) })).status, 204);
  // A report that could not be delivered at the time, sent late.
  assert.equal((await post({ ...FAILED, request: { method: "GET", route: "/api/media/access" }, release: "f".repeat(40), late: "lt_10m" })).status, 204);
  all = await rows();
  assert.deepEqual(all.slice(-2).map((r) => [r.request_route, r.server_uptime, r.delivered_late, r.repeat_count]), [["/api/media/access", "ge_10m", null, 1], ["/api/media/access", "ge_10m", "lt_10m", 1]]);
  // Refused: nothing stored, and the answer repeats nothing.
  const before = all.length;
  for (const body of [{ ...FAILED, request: { method: "GET", route: `/api${"/a".repeat(58)}` } }, { ...FAILED, request: { method: "GET", route: "/api/x", url: "/api/x?secret=1" } }, { ...FAILED, request: { method: "TRACE", route: "/api/x" } }, { ...FAILED, request: "GET /api/x?secret=1" },
    { ...FAILED, late: "yesterday" }, { ...FAILED, request: { method: "GET", route: "x" } }]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.ok(!res.text.includes("secret"));
  }
  assert.equal((await rows()).length, before);
  // A server error: its own route, the uptime, and none of the browser's facts even when the event carries them.
  M.setUptimeForTests(() => 10);
  assert.equal(await M.writeEvent({ source: "server", routeTemplate: "/api/y", code: "internal_error", status: 500, role: "coach", userHash: null, userHashVersion: 2,
    request: { method: "GET", route: "/api/z" }, late: "lt_1m", pageBehind: true }), "stored");
  const srv = (await rows()).at(-1);
  assert.deepEqual([srv.source, srv.request_method, srv.request_route, srv.server_uptime, srv.page_behind_server, srv.delivered_late], ["server", null, null, "lt_2m", null, null]);
  M.setUptimeForTests();
});

test("5. the groups read: which request, how many around a server restart, how many delivered late, how many from an older page", async () => {
  await clear();
  const admin = await user("Admin Example", { platform: true });
  const coach = await user("Coach Example");
  const ev = async (n, over = {}) => { for (let i = 0; i < n; i += 1) await M.writeEvent({ ...M.sanitizeClientReport({ ...FAILED, request: { method: "POST", route: "/api/media/access" }, ...over }), role: "coach", userHash: M.keyedUserHash(coach.id, 2), userHashVersion: 2 }); };
  M.setUptimeForTests(() => 20);
  await ev(2, { release: SERVER_COMMIT });                 // just after a start
  M.setUptimeForTests(() => 9000);
  await ev(3, { release: "f".repeat(40) });                // long after, from an older page
  await ev(1, { release: SERVER_COMMIT, late: "lt_1m" });  // delivered late, long after a start: not a restart
  await ev(1, { request: { method: "GET", route: "/api/media/access" } }); // another request: another kind
  M.setUptimeForTests();
  const res = await call("/api/app-errors/groups?days=1", { cookie: admin.cookie });
  assert.equal(res.status, 200);
  const main = res.body.groups.find((g) => g.request?.method === "POST");
  assert.deepEqual(main.request, { method: "POST", route: "/api/media/access" });
  assert.deepEqual([main.occurrences, main.timedOccurrences, main.aroundRestart, main.deliveredLate, main.pageBehindServer], [6, 6, 2, 1, 3]);
  const other = res.body.groups.find((g) => g.request?.method === "GET");
  assert.deepEqual([other.occurrences, other.aroundRestart, other.deliveredLate, other.pageBehindServer], [1, 0, 0, 0]);
  // A kind without a request says so with null, and zeros; rows from before v73 are not among the timed ones.
  await clear();
  M.setUptimeForTests(() => 5);
  await M.writeEvent({ ...M.sanitizeClientReport({ screen: "weekly", code: "js_error" }), role: "coach", userHash: null, userHashVersion: 2 });
  M.setUptimeForTests();
  const fp = (await rows())[0].fingerprint;
  await rawInsert({ fingerprint: fp, screen: "weekly", error_code: "js_error", repeat_count: 4 });
  const plain = (await call("/api/app-errors/groups?days=1", { cookie: admin.cookie })).body.groups[0];
  assert.deepEqual([plain.request, plain.occurrences, plain.timedOccurrences, plain.aroundRestart, plain.deliveredLate, plain.pageBehindServer], [null, 5, 1, 1, 0, 0]);
  assert.equal((await call("/api/app-errors/groups?days=1", { cookie: coach.cookie })).status, 404, "still a platform admin's read only");
});

test("6. the preflight and the post-check read what they claim; the rollback refuses and then restores v70; v73 applies again and its gate holds", async () => {
  const sql = async (name) => fs.readFile(new URL(name, RUNBOOKS), "utf8");
  const migration = await fs.readFile(new URL(`../../${V73}`, import.meta.url), "utf8");
  const post = blocks(await sql("app-error-events-v73-postcheck.sql"));
  const pre = blocks(await sql("app-error-events-v73-preflight.sql"));
  const rollback = await sql("app-error-events-v73-rollback.sql");
  assert.deepEqual([pre.length, post.length], [4, 5]);
  assert.ok((await sql("app-error-events-v73-postcheck.sql")).includes(crypto.createHash("sha256").update(migration).digest("hex")), "the post-check names this file's checksum");
  await clear();
  await rawInsert({ request_method: "POST", request_route: "/api/media/access", server_uptime: "lt_2m", page_behind_server: true, delivered_late: "lt_1m" });
  await rawInsert({ source: "server", screen: null, route_template: "/api/x", error_code: "internal_error", server_uptime: "ge_10m" });
  assert.deepEqual(Object.values((await k.query(post[0])).rows[0]), [true, true]);
  assert.deepEqual(Object.values((await k.query(post[1])).rows[0]), [true, true, true, true]);
  const p3 = (await k.query(post[2])).rows[0];
  assert.deepEqual([p3.rows_total, p3.with_request, p3.with_uptime, p3.within_2m_of_start, p3.delivered_late, p3.page_behind_server].map(Number), [2, 1, 2, 1, 1, 1]);
  assert.deepEqual(Object.values((await k.query(post[3])).rows[0]), [true, true]);
  assert.equal((await k.query(post[4])).rows[0].no_idle_tx, true);
  const pre1 = (await k.query(pre[0])).rows[0];
  assert.deepEqual([pre1.v70_recorded, pre1.v73_absent, pre1.nothing_later, pre1.last_migration], [true, false, true, V73]);
  const pre2 = (await k.query(pre[1])).rows[0];
  assert.deepEqual([pre2.guard_is_v70, pre2.no_v73_column], [false, false]);

  // The rollback refuses under a later migration, changing nothing.
  const refused = async (pattern) => { await assert.rejects(k.query(rollback), pattern); await k.query("rollback"); };
  const LATER = "migrations_v2/209901010000_later.sql";
  await k.query(`create temp table later_row as select * from public.schema_migrations where migration_name = $1`, [V73]);
  await k.query(`update later_row set migration_name = $1`, [LATER]);
  await k.query(`insert into public.schema_migrations select * from later_row`);
  await refused(/later migrations are applied/);
  assert.equal((await k.query(pre[0])).rows[0].nothing_later, false);
  await k.query(`delete from public.schema_migrations where migration_name = $1`, [LATER]);
  // v71 and v72 (other slices, recorded before v73 with earlier file names) block nothing: not the rollback, not the preflight.
  const V72 = "migrations_v2/202611151200_training_load_v72_source_field_observations.sql";
  for (const earlier of ["migrations_v2/202611151000_training_load_v71_dashboard_simple_atomic_save.sql", V72]) {
    await k.query(`update later_row set migration_name = $1`, [earlier]);
    await k.query(`insert into public.schema_migrations select * from later_row`);
  }
  assert.equal((await k.query(pre[0])).rows[0].nothing_later, true);
  assert.equal(await guardMd5(), "05cd59a40237bf6b443d268961409d93", "nothing was changed by a refused rollback");
  // The migrator's lock held by another session.
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("select pg_advisory_lock(822026)");
    await refused(/the migrator is running/);
  } finally { await holder.query("select pg_advisory_unlock(822026)"); await holder.end(); }

  // The rollback: v70's schema and guard body; the rows stay.
  await k.query(rollback);
  assert.equal(await guardMd5(), "13009f97dbedc04be84380baa037ce88", "v70's body by md5");
  const cols = (await k.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'app_error_events'`)).rows.map((r) => r.column_name);
  for (const c of ["request_method", "request_route", "server_uptime", "page_behind_server", "delivered_late"]) assert.ok(!cols.includes(c), c);
  for (const c of ["device_class", "user_hash_version"]) assert.ok(cols.includes(c), `${c} (v70's) stays`);
  assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V73])).rows[0].n, 0);
  assert.equal((await k.query(`select count(*)::int as n from pg_constraint where conrelid = 'public.app_error_events'::regclass and contype = 'c'`)).rows[0].n, 22);
  assert.equal((await rows()).length, 2, "the rows stay");
  const v70Post = blocks(await sql("app-error-events-v70-postcheck.sql"));
  assert.deepEqual(Object.values((await k.query(v70Post[1])).rows[0]), [true, true, true, true], "v70's own post-check is true again");
  await k.query(`update public.app_error_events set repeat_count = repeat_count + 1`);
  await assert.rejects(k.query(`update public.app_error_events set device_class = 'tablet'`), /only repeat_count and last_seen_at may change/, "v70's columns are final under the restored guard");
  await refused(/v73 is not recorded/);
  const preAfter = [(await k.query(pre[0])).rows[0], (await k.query(pre[1])).rows[0]];
  assert.deepEqual([preAfter[0].v70_recorded, preAfter[0].v73_absent, preAfter[0].nothing_later, preAfter[0].last_migration], [true, true, true, V72], "clean on a database whose last migration is v72");
  const me = (await k.query("select current_user as u")).rows[0].u;
  assert.deepEqual([preAfter[1].guard_is_v70, preAfter[1].no_v73_column, preAfter[1].table_owner, preAfter[1].guard_owner], [true, true, me, me], "the preflight is clean on a v70 database");

  // The gate: another guard body is refused; v73 applies again on v70; a second apply is refused twice over.
  const v70Body = (await k.query(`select pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'app_error_events_guard_update'`)).rows[0].def;
  await k.query(`create or replace function public.app_error_events_guard_update() returns trigger language plpgsql as $f$ begin return new; end $f$`);
  await assert.rejects(k.query(migration), /not the one this migration replaces \(v70\)/);
  await k.query("rollback").catch(() => {});
  await k.query(v70Body);
  assert.equal(await guardMd5(), "13009f97dbedc04be84380baa037ce88");
  await k.query(migration);
  assert.deepEqual(Object.values((await k.query(post[1])).rows[0]), [true, true, true, true]);
  assert.deepEqual((await rows()).map((r) => [r.request_route, r.server_uptime]), [[null, null], [null, null]], "the rows that were there carry none of the new facts");
  await assert.rejects(k.query(migration), /not the one this migration replaces/);
  await k.query("rollback").catch(() => {});
  await k.query(v70Body);
  await assert.rejects(k.query(migration), /a column of this migration already exists/);
  await k.query("rollback").catch(() => {});
});
