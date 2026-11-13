// App health, AH-1 (migration v70): the device of a browser report as closed-list words, the keyed user hash with its
// version, what happens without the key, the "who looked" table, and the rehearsed rollback.
// Disposable database only; invented data only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, DISPOSABLE_DB_NAME_PATTERN, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const V58 = "migrations_v2/202611091000_app_error_events.sql";
const V70_FILE = "202611131400_app_error_events_v70_device_and_keyed_hash.sql";
const V70 = `migrations_v2/${V70_FILE}`;
const RUNBOOKS = new URL("../../docs/runbooks/", import.meta.url);
const KEY_A = crypto.randomBytes(32).toString("base64");
const KEY_B = crypto.randomBytes(32).toString("base64");
const ENV = "APP_ERROR_USER_HASH_KEYS";
let db, k, server, base, T, M;
const uid = () => crypto.randomBytes(4).toString("hex");
const setKeys = (spec) => { if (spec == null) delete process.env[ENV]; else process.env[ENV] = spec; M.resetUserHashWarningForTests(); };

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
const clear = async () => { await k.query(`delete from public.app_error_events`); M.resetRateLimitForTests(); };
const GOOD = { screen: "training-load", action: "open-imports", code: "js_error", stackSig: "renderImports@gpexe-import-view.js > start@app.js" };
const PHONE = { class: "phone", os: "ios", browser: "safari", major: 17, viewport: "360_479", touch: true };
const DESK = { class: "desktop", os: "windows", browser: "chrome", major: 131, viewport: "ge_1440", touch: false };
const blocks = (sql) => sql.split(/^-- \d+\./m).slice(1).map((b) => b.split("\n").slice(1).filter((l) => !l.startsWith("--")).join("\n").trim()).filter(Boolean);
const guardMd5 = async () => (await k.query(`select md5(prosrc) as m from pg_proc where pronamespace = 'public'::regnamespace and proname = 'app_error_events_guard_update'`)).rows[0].m;
const rawInsert = (over = {}) => {
  const v = { fingerprint: "a".repeat(64), source: "client", screen: "home", route_template: null, error_code: "js_error", role: "coach", ...over };
  const keys = Object.keys(v);
  return k.query(`insert into public.app_error_events (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(v));
};

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "ah1v70", migrations: [...GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.findIndex((m) => m.includes("app_error_events")) + 1), V70_FILE] });
  assert.match(db.name, DISPOSABLE_DB_NAME_PATTERN, "SAFETY: a disposable database only");
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY");
  process.env.DATABASE_URL = db.url;
  process.env[ENV] = `2:${KEY_A}`;
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

test("1. the key ring: versions from 2, at least 32 bytes, one bad part refuses the whole ring; the keyed hash is not the unkeyed one", () => {
  const ring = M.parseUserHashKeys(`2:${KEY_A};3:${KEY_B}`);
  assert.deepEqual([...ring.keys.keys()], [2, 3]);
  assert.equal(ring.current, 3);
  assert.equal(M.parseUserHashKeys(` 2:${KEY_A} ; `).current, 2, "spaces and a trailing separator are fine");
  for (const bad of [undefined, null, "", "  ", KEY_A, `1:${KEY_A}`, `0:${KEY_A}`, `1000:${KEY_A}`, `2:${crypto.randomBytes(31).toString("base64")}`, `2:${KEY_A};2:${KEY_B}`,
    `2:${KEY_A};3:short`, `2:${KEY_A};three:${KEY_B}`, `2:${KEY_A}!`, `2:${KEY_A};3:${KEY_B};x`, 42]) {
    assert.equal(M.parseUserHashKeys(bad), null, `refused: ${String(bad).slice(0, 12)}`);
  }
  setKeys(`2:${KEY_A};3:${KEY_B}`);
  const h2 = M.keyedUserHash("user-1", 2); const h3 = M.keyedUserHash("user-1", 3);
  assert.match(h2, /^[0-9a-f]{12}$/);
  assert.notEqual(h2, h3);
  assert.notEqual(h2, M.userHash("user-1"), "never the unkeyed hash");
  assert.notEqual(h3, M.userHash("user-1"));
  assert.equal(h2, crypto.createHmac("sha256", Buffer.from(KEY_A, "base64")).update("app-error-user:user-1").digest("hex").slice(0, 12));
  assert.equal(M.keyedUserHash("user-1", 4), null, "no such key");
  assert.equal(M.keyedUserHash(null, 2), null);
  assert.deepEqual(M.userHashForNewRow("user-1"), { hash: h3, version: 3 }, "a new row gets the highest version");
  assert.deepEqual(M.userHashVersions(), [3, 2]);
  assert.equal(M.userHashKeyState(), "keyed");
  setKeys(`2:${KEY_A}`);
  assert.deepEqual(M.userHashForNewRow("user-1"), { hash: h2, version: 2 });
});

test("2. the device of a report: exactly the six keys, each a word of its list; anything else refuses the whole report", () => {
  assert.deepEqual(M.sanitizeDevice(undefined), {});
  assert.deepEqual(M.sanitizeDevice(PHONE), PHONE);
  assert.deepEqual(M.sanitizeDevice({ class: "unknown", touch: false }), { class: "unknown", touch: false });
  assert.deepEqual(M.sanitizeClientReport({ ...GOOD, device: DESK }).device, DESK);
  assert.deepEqual(M.sanitizeClientReport(GOOD).device, {}, "a page from before the change sends none");
  const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15";
  for (const bad of [UA, [PHONE], 1, true, { ...PHONE, ua: UA }, { ...PHONE, userAgent: UA }, { class: UA }, { class: "Phone" }, { os: "ipados" }, { browser: "opera" }, { viewport: "375" },
    { browser: "chrome", major: 0 }, { browser: "chrome", major: 1000 }, { browser: "chrome", major: 17.5 }, { browser: "chrome", major: "17" }, { major: 17 }, { touch: "yes" }, { touch: 1 },
    { class: ["phone"] }, { os: { toString: () => "ios" } }, { model: "SM-G991B" }]) {
    assert.equal(M.sanitizeDevice(bad), null, JSON.stringify(bad).slice(0, 40));
    assert.equal(M.sanitizeClientReport({ ...GOOD, device: bad }), null);
  }
  // The lists the code accepts are the lists the table accepts.
  for (const key of ["class", "os", "browser", "viewport"]) assert.ok(M.DEVICE_LISTS[key].length >= 4);
});

test("3. the table: the lists, a server error without a device, the seven columns final, existing rows are version 1", async () => {
  await clear();
  assert.equal(await guardMd5(), "13009f97dbedc04be84380baa037ce88");
  const id = (await rawInsert()).rows[0].id;
  const row = (await k.query(`select * from public.app_error_events where id = $1`, [id])).rows[0];
  assert.equal(row.user_hash_version, 1, "a writer that does not know v70 writes version 1");
  assert.deepEqual([row.device_class, row.os_family, row.browser_family, row.browser_major, row.viewport_bucket, row.touch], [null, null, null, null, null, null]);
  for (const [col, list] of [["device_class", M.DEVICE_LISTS.class], ["os_family", M.DEVICE_LISTS.os], ["browser_family", M.DEVICE_LISTS.browser], ["viewport_bucket", M.DEVICE_LISTS.viewport]]) {
    for (const word of list) await rawInsert({ [col]: word, fingerprint: crypto.randomBytes(32).toString("hex") });
    await assert.rejects(rawInsert({ [col]: "Mozilla/5.0" }), /violates check constraint/, col);
    await assert.rejects(rawInsert({ [col]: list[0].toUpperCase() }), /violates check constraint/);
  }
  await assert.rejects(rawInsert({ browser_major: 17 }), /browser_major_with_family/);
  await assert.rejects(rawInsert({ browser_family: "chrome", browser_major: 0 }), /browser_major_range/);
  await assert.rejects(rawInsert({ browser_family: "chrome", browser_major: 1000 }), /browser_major_range/);
  await assert.rejects(rawInsert({ user_hash_version: 0 }), /user_hash_version_known/);
  for (const over of [{ device_class: "phone" }, { os_family: "ios" }, { browser_family: "safari" }, { viewport_bucket: "lt_360" }, { touch: true }]) {
    await assert.rejects(rawInsert({ source: "server", screen: null, route_template: "/api/x", ...over }), /device_client_only/, JSON.stringify(over));
  }
  const full = (await rawInsert({ device_class: "phone", os_family: "ios", browser_family: "safari", browser_major: 17, viewport_bucket: "360_479", touch: true, user_hash_version: 2, fingerprint: "b".repeat(64) })).rows[0].id;
  for (const set of ["device_class = 'tablet'", "os_family = 'android'", "browser_family = 'chrome'", "browser_major = 18", "viewport_bucket = 'lt_360'", "touch = false", "user_hash_version = 3",
    "device_class = null", "touch = null"]) {
    await assert.rejects(k.query(`update public.app_error_events set ${set} where id = $1`, [full]), /only repeat_count and last_seen_at may change/, set);
  }
  await k.query(`update public.app_error_events set repeat_count = repeat_count + 1 where id = $1`, [full]);
});

test("4. ingest: the device is stored, one error on two devices is two rows, a repeat on the same device counts, a bad device stores nothing", async () => {
  await clear();
  setKeys(`2:${KEY_A}`);
  const coach = await user("Coach Example");
  for (const device of [PHONE, PHONE, DESK]) assert.equal((await call("/api/app-errors", { method: "POST", body: { ...GOOD, device }, cookie: coach.cookie })).status, 204);
  assert.equal((await call("/api/app-errors", { method: "POST", body: GOOD, cookie: coach.cookie })).status, 204, "an older page, no device");
  let all = await rows();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((r) => r.repeat_count), [2, 1, 1]);
  assert.equal(new Set(all.map((r) => r.fingerprint)).size, 1, "the device is not part of the kind of error");
  assert.deepEqual([all[0].device_class, all[0].os_family, all[0].browser_family, all[0].browser_major, all[0].viewport_bucket, all[0].touch], ["phone", "ios", "safari", 17, "360_479", true]);
  assert.deepEqual([all[1].device_class, all[1].touch], ["desktop", false]);
  assert.deepEqual([all[2].device_class, all[2].os_family, all[2].touch], [null, null, null]);
  for (const r of all) assert.deepEqual([r.user_hash, r.user_hash_version], [M.keyedUserHash(coach.id, 2), 2]);
  const UA = "Mozilla/5.0 (Linux; Android 14; SM-G991B) AppleWebKit/537.36";
  for (const device of [{ ...PHONE, ua: UA }, { class: UA }, UA, { major: 3 }]) {
    const res = await call("/api/app-errors", { method: "POST", body: { ...GOOD, device }, cookie: coach.cookie });
    assert.equal(res.status, 400);
    assert.ok(!res.text.includes("Mozilla"), "the answer never repeats the report");
  }
  assert.equal((await rows()).length, 3);
  assert.ok(!JSON.stringify(await rows()).includes("Mozilla"));
  // The groups read still counts one person and one kind of error.
  const admin = await user("Admin Example", { platform: true });
  const groups = await call("/api/app-errors/groups?days=1", { cookie: admin.cookie });
  assert.equal(groups.body.people, "keyed");
  assert.equal(groups.body.groups.length, 1);
  assert.deepEqual([groups.body.groups[0].occurrences, groups.body.groups[0].users], [4, 1]);
  assert.ok(!groups.text.includes(KEY_A) && !groups.text.includes(ENV), "neither the key nor its variable's name");
});

test("5. a server error: the keyed hash, its version, no device", async () => {
  await clear();
  const userId = crypto.randomUUID();
  const req = { baseUrl: "", route: { path: "/:id/x" }, originalUrl: "/api/things/1/x", user: { id: userId }, authz: null, body: { device: PHONE } };
  M.recordServerError(req, new Error("boom"), 500);
  for (let i = 0; i < 50 && !(await rows()).length; i += 1) await new Promise((r) => setTimeout(r, 20));
  const [row] = await rows();
  assert.deepEqual([row.source, row.user_hash, row.user_hash_version, row.device_class, row.touch], ["server", M.keyedUserHash(userId, 2), 2, null, null]);
  // A caller that hands a device with a server event still writes none.
  assert.equal(await M.writeEvent({ source: "server", routeTemplate: "/api/y", code: "internal_error", status: 500, role: "coach", userHash: null, userHashVersion: 2, device: PHONE }), "stored");
  assert.equal((await rows())[1].device_class, null);
});

test("6. without the key: the row is stored with no hash - never the unkeyed one; one warning naming the variable only; the read says so", async () => {
  await clear();
  const coach = await user("Coach Example");
  const admin = await user("Admin Example", { platform: true });
  const warned = [];
  const original = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    for (const spec of [null, "", `1:${KEY_A}`, `2:${KEY_A};3:short`]) {
      await clear();
      setKeys(spec);
      warned.length = 0;
      assert.equal(M.userHashKeyState(), "not_configured");
      assert.equal((await call("/api/app-errors", { method: "POST", body: { ...GOOD, device: PHONE }, cookie: coach.cookie })).status, 204, "ingest still stores");
      assert.equal((await call("/api/app-errors", { method: "POST", body: { ...GOOD, device: PHONE }, cookie: admin.cookie })).status, 204);
      const all = await rows();
      assert.equal(all.length, 1, "two people are not told apart: one row, counted twice");
      assert.deepEqual([all[0].user_hash, all[0].user_hash_version, all[0].repeat_count, all[0].device_class], [null, 2, 2, "phone"]);
      assert.ok(!JSON.stringify(all).includes(M.userHash(coach.id)), "never the unkeyed hash");
      assert.equal(warned.length, 1, "said once");
      assert.match(warned[0], /APP_ERROR_USER_HASH_KEYS is not set or not readable/);
      assert.ok(!warned[0].includes(KEY_A) && !warned[0].includes("short"), "never a part of the value");
      const groups = await call("/api/app-errors/groups?days=1", { cookie: admin.cookie });
      assert.equal(groups.body.people, "not_configured");
      assert.equal(groups.body.groups[0].users, 0);
    }
  } finally {
    console.warn = original;
    setKeys(`2:${KEY_A}`);
  }
  assert.equal(M.userHashKeyState(), "keyed", "set again, it is read again without a restart of the module");
});

test("7. a rotation: new rows get the new version; a row of the old version is never raised by a report of the new one", async () => {
  await clear();
  setKeys(`2:${KEY_A}`);
  const coach = await user("Coach Example");
  await call("/api/app-errors", { method: "POST", body: { ...GOOD, device: PHONE }, cookie: coach.cookie });
  setKeys(`2:${KEY_A};3:${KEY_B}`);
  await call("/api/app-errors", { method: "POST", body: { ...GOOD, device: PHONE }, cookie: coach.cookie });
  await call("/api/app-errors", { method: "POST", body: { ...GOOD, device: PHONE }, cookie: coach.cookie });
  const all = await rows();
  assert.deepEqual(all.map((r) => [r.user_hash_version, r.repeat_count]), [[2, 1], [3, 2]]);
  assert.deepEqual(all.map((r) => r.user_hash), [M.keyedUserHash(coach.id, 2), M.keyedUserHash(coach.id, 3)], "each row resolves by its own version's key");
  // A version 1 row of the same person (written before v70) is left alone too.
  await rawInsert({ fingerprint: all[0].fingerprint, user_hash: M.userHash(coach.id), action: "open-imports", screen: "training-load", stack_signature: GOOD.stackSig });
  await call("/api/app-errors", { method: "POST", body: GOOD, cookie: coach.cookie });
  const after = await rows();
  assert.equal(after.length, 4);
  assert.equal(after.find((r) => r.user_hash_version === 1).repeat_count, 1);
  setKeys(`2:${KEY_A}`);
});

test("8. who looked: append-only, recorded at its own time, kept one year, purged after it", async () => {
  const looker = crypto.randomUUID();
  const ins = (over = {}) => {
    const v = { request_key: crypto.randomUUID(), looked_by_user_id: looker, fingerprint: "c".repeat(64), people_named: 2, outcome: "answered", ...over };
    const keys = Object.keys(v);
    return k.query(`insert into public.app_error_person_lookups (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(v));
  };
  const id = (await ins()).rows[0].id;
  const key = crypto.randomUUID();
  await ins({ request_key: key, outcome: "key_missing", people_named: 0 });
  await assert.rejects(ins({ request_key: key }), /request_key_once/);
  await assert.rejects(ins({ fingerprint: "Ana Example" }), /fingerprint_shape/);
  await assert.rejects(ins({ people_named: 21 }), /people_range/);
  await assert.rejects(ins({ people_named: -1 }), /people_range/);
  await assert.rejects(ins({ outcome: "seen", people_named: 0 }), /outcome_known/);
  await assert.rejects(ins({ outcome: "key_missing", people_named: 1 }), /named_only_when_answered/);
  await assert.rejects(ins({ looked_at: new Date(Date.now() - 400 * 86400000) }), /recorded at the time it is made/);
  await assert.rejects(ins({ looked_at: new Date(Date.now() + 3600000) }), /recorded at the time it is made/);
  await assert.rejects(k.query(`update public.app_error_person_lookups set people_named = 0 where id = $1`, [id]), /never changes/);
  await assert.rejects(k.query(`delete from public.app_error_person_lookups where id = $1`, [id]), /kept for one year/);
  await assert.rejects(k.query(`truncate public.app_error_person_lookups`), /TRUNCATE is refused/);
  assert.equal(await M.purgePersonLookups(), 0, "nothing is old enough");
  // An old row (planted with the insert guard off, as the test's own superuser): the purge deletes it and only it.
  await k.query(`alter table public.app_error_person_lookups disable trigger app_error_person_lookups_guard_insert`);
  await ins({ looked_at: new Date(Date.now() - 366 * 86400000) });
  await ins({ looked_at: new Date(Date.now() - 364 * 86400000) });
  await k.query(`alter table public.app_error_person_lookups enable trigger app_error_person_lookups_guard_insert`);
  assert.equal(await M.purgePersonLookups(), 1);
  assert.equal((await k.query(`select count(*)::int as n from public.app_error_person_lookups`)).rows[0].n, 3);
  assert.equal(M.LOOKUP_RETENTION_DAYS, 365);
  const cols = (await k.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'app_error_person_lookups' order by 1`)).rows.map((r) => r.column_name);
  assert.deepEqual(cols, ["fingerprint", "id", "looked_at", "looked_by_user_id", "outcome", "people_named", "request_key"], "no name, no hash, no device");
});

test("9. the preflight and the post-check read what they claim; the rollback refuses and then restores v58; v70 applies again and its gate holds", async () => {
  const sql = async (name) => fs.readFile(new URL(name, RUNBOOKS), "utf8");
  const migration = await fs.readFile(new URL(`../../${V70}`, import.meta.url), "utf8");
  const post = blocks(await sql("app-error-events-v70-postcheck.sql"));
  const pre = blocks(await sql("app-error-events-v70-preflight.sql"));
  const rollback = await sql("app-error-events-v70-rollback.sql");
  assert.equal(post.length, 6);
  assert.equal(pre.length, 4);
  assert.ok((await sql("app-error-events-v70-postcheck.sql")).includes(crypto.createHash("sha256").update(migration).digest("hex")), "the post-check names this file's checksum");
  // A row of each kind, and a lookup, are there from the earlier tests.
  await clear();
  setKeys(`2:${KEY_A}`);
  const coach = await user("Coach Example");
  await call("/api/app-errors", { method: "POST", body: { ...GOOD, device: PHONE }, cookie: coach.cookie });
  assert.deepEqual(Object.values((await k.query(post[0])).rows[0]), [true, true]);
  assert.deepEqual(Object.values((await k.query(post[1])).rows[0]), [true, true, true, true]);
  assert.deepEqual(Object.values((await k.query(post[2])).rows[0]), [true, true, true, true, true, true]);
  const byVersion = (await k.query(post[3])).rows;
  assert.deepEqual(byVersion.map((r) => [r.user_hash_version, Number(r.rows_total), Number(r.signed_in_without_hash), Number(r.with_device)]), [[2, 1, 0, 1]]);
  const p5 = (await k.query(post[4])).rows[0];
  assert.deepEqual([p5.server_rows_without_device, p5.no_lookup_yet], [true, false], "test 8 left lookups: the post-check sees them");
  assert.equal((await k.query(post[5])).rows[0].no_idle_tx, true);
  const pre1 = (await k.query(pre[0])).rows[0];
  assert.deepEqual([pre1.v58_recorded, pre1.v70_absent, pre1.nothing_later, pre1.last_migration], [true, false, true, V70]);
  const pre2 = (await k.query(pre[1])).rows[0];
  assert.deepEqual([pre2.guard_is_v58, pre2.no_v70_column, pre2.no_lookups_table], [false, false, false]);
  assert.equal(Number((await k.query(pre[2])).rows[0].rows_total), 1);

  // The rollback refuses, changing nothing: a keyed hash, then a lookup, then a later migration.
  const refused = async (pattern) => { await assert.rejects(k.query(rollback), pattern); await k.query("rollback"); };
  await refused(/a keyed user hash is stored/);
  await clear();
  setKeys(null);
  await call("/api/app-errors", { method: "POST", body: { ...GOOD, device: PHONE }, cookie: coach.cookie }); // a row without a hash does not hold the rollback
  setKeys(`2:${KEY_A}`);
  await refused(/a lookup is recorded/);
  await k.query(`alter table public.app_error_person_lookups disable trigger app_error_person_lookups_guard_delete`);
  await k.query(`delete from public.app_error_person_lookups`);
  await k.query(`alter table public.app_error_person_lookups enable trigger app_error_person_lookups_guard_delete`);
  const LATER = "migrations_v2/209901010000_later.sql";
  await k.query(`create temp table later_row as select * from public.schema_migrations where migration_name = $1`, [V70]);
  await k.query(`update later_row set migration_name = $1`, [LATER]);
  await k.query(`insert into public.schema_migrations select * from later_row`);
  await refused(/later migrations are applied/);
  assert.equal((await k.query(pre[0])).rows[0].nothing_later, false);
  await k.query(`delete from public.schema_migrations where migration_name = $1`, [LATER]);
  assert.equal((await rows()).length, 1);
  assert.equal(await guardMd5(), "13009f97dbedc04be84380baa037ce88", "nothing was changed by a refused rollback");

  // The rollback: v58's schema and guard body, the row kept.
  await k.query(rollback);
  assert.equal(await guardMd5(), "1737e2dd01bcdb74f02a006a65cb5389", "v58's body by md5");
  const cols = (await k.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'app_error_events'`)).rows.map((r) => r.column_name);
  for (const c of ["device_class", "os_family", "browser_family", "browser_major", "viewport_bucket", "touch", "user_hash_version"]) assert.ok(!cols.includes(c), c);
  assert.equal((await k.query(`select to_regclass('public.app_error_person_lookups') as t`)).rows[0].t, null);
  assert.equal((await k.query(`select count(*)::int as n from pg_proc where proname like 'app_error_person_lookups_%'`)).rows[0].n, 0);
  assert.equal((await k.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V70])).rows[0].n, 0);
  assert.equal((await k.query(`select count(*)::int as n from pg_constraint where conrelid = 'public.app_error_events'::regclass and contype = 'c'`)).rows[0].n, 14);
  assert.equal((await rows()).length, 1, "the rows stay");
  const v58Post = blocks(await sql("app-error-events-v58-postcheck.sql"));
  assert.deepEqual(Object.values((await k.query(v58Post[0])).rows[0]), [true, true], "v58 is the last migration again");
  assert.deepEqual(Object.values((await k.query(v58Post[1])).rows[0]), [true, true, true, true]);
  assert.deepEqual(Object.values((await k.query(v58Post[5])).rows[0]), [true, true, true]);
  await k.query(`update public.app_error_events set repeat_count = repeat_count + 1`);
  await assert.rejects(k.query(`update public.app_error_events set role = 'athlete'`), /only repeat_count and last_seen_at may change/);
  await refused(/v70 is not recorded/);
  const preAfter = [(await k.query(pre[0])).rows[0], (await k.query(pre[1])).rows[0]];
  assert.deepEqual([preAfter[0].v58_recorded, preAfter[0].v70_absent, preAfter[0].nothing_later, preAfter[0].last_migration], [true, true, true, V58]);
  assert.deepEqual(Object.values(preAfter[1]), [true, true, true, true], "the preflight is clean on a v58 database");

  // The gate: a guard body that is not v58's is refused, and v70 applies again on v58, with Supabase-like default grants taken back.
  await k.query(`create or replace function public.app_error_events_guard_update() returns trigger language plpgsql as $f$ begin return new; end $f$`);
  await assert.rejects(k.query(migration), /not the one this migration replaces/);
  await k.query("rollback").catch(() => {});
  const v58Text = await fs.readFile(new URL(`../../${V58}`, import.meta.url), "utf8");
  const body = v58Text.slice(v58Text.indexOf("create function public.app_error_events_guard_update()")).split("$$;")[0].replace("create function", "create or replace function");
  await k.query(`${body}$$;`);
  assert.equal(await guardMd5(), "1737e2dd01bcdb74f02a006a65cb5389");
  const made = [];
  for (const role of ["anon", "authenticated"]) {
    if (!(await k.query(`select 1 from pg_roles where rolname = $1`, [role])).rowCount) { await k.query(`create role ${role} nologin`); made.push(role); }
  }
  await k.query(`alter default privileges in schema public grant all on tables to anon, authenticated, public`);
  try {
    await k.query(migration);
    assert.deepEqual(Object.values((await k.query(post[1])).rows[0]), [true, true, true, true]);
    assert.deepEqual(Object.values((await k.query(post[2])).rows[0]), [true, true, true, true, true, true], "default privileges for PUBLIC, anon and authenticated are taken back");
    assert.equal((await rows())[0].user_hash_version, 1, "an existing row is version 1");
    // A second apply is refused twice over: by the guard's body, and - were the body v58's - by the objects themselves.
    await assert.rejects(k.query(migration), /not the one this migration replaces/);
    await k.query("rollback").catch(() => {});
    await k.query(`${body}$$;`);
    await assert.rejects(k.query(migration), /a column or table of this migration already exists/);
    await k.query("rollback").catch(() => {});
  } finally {
    await k.query(`alter default privileges in schema public revoke all on tables from anon, authenticated, public`);
    for (const role of made) { try { await k.query(`drop owned by ${role}`); await k.query(`drop role ${role}`); } catch { /* left for the cluster's owner */ } }
  }
});
