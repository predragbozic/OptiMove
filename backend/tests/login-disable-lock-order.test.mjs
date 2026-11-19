// Roles R2, PR-A: the lock order of switching a login off (roles R2 contract,
// docs/ai/roles-r2-contract.md section 4.3.1; tests 28 and 29a there).
//
// setUserLoginStatus (routes/organization.js) used to lock users rows in up to
// 1 + N statements (the platform admins, then each affected club's admins),
// each in id order only inside itself, and to take each club's headcount
// advisory lock after it had already locked the platform admins' rows. It now
// takes every advisory lock first (platform, then the clubs in club id order),
// then the users rows of the whole union in ONE statement in id order, then
// only the role rows the decision counts.
//
// Every race below runs the REAL login switch-off route against either the
// REAL old revocation route or a peer transaction that sends the Roles API's
// pair statement (`where id in (actor, target) order by id for share`, 4.3
// place 2), on a disposable database built from the legacy snapshot and the
// real runner. Peers holding user rows `for update` choreograph the order of
// arrival so that the old code meets the circular wait the contract describes
// (40P01, a 500 from the route); the new code must end every race without
// one. The same file run against the code before this change fails those
// races (the pull request records the run). No persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDisposableDatabase } from "./support/disposable-db.mjs";
import { bootstrapLegacySnapshot } from "./support/legacy-bootstrap.mjs";
import { runMigrations } from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(__dirname, "..", "..", "migrations_v2");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const PLATFORM_LOCK_KEY = 726354981;
const CLUB_LOCK_NAMESPACE = 891234567;

let db, k, server, apiBase, appPool, createSession;
const W = {};
const logLines = [];
const originalConsole = {};

before(async () => {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "support/legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  db = await createDisposableDatabase({ prefix: "roles", label: "login_lock", baseDatabaseUrl: ORIGINAL_DATABASE_URL });
  await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
  await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
  k = new pg.Client({ connectionString: db.url });
  await k.connect();
  assert.equal((await k.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the disposable database");
  process.env.DATABASE_URL = db.url;
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    originalConsole[level] = console[level];
    console[level] = (...args) => {
      logLines.push(args.map((a) => (typeof a === "string" ? a : (a instanceof Error ? `${a.code ?? ""} ${a.message}` : JSON.stringify(a)))).join(" "));
      if (process.env.LOGIN_LOCK_DEBUG) originalConsole[level](...args);
    };
  }
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  appPool = (await import("../src/db.js")).pool;
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app talks to the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
  W.pa = await person(0xf0, "actor-platform-admin");
  await grantPlatform(W.pa.id);
  W.pa.cookie = `optimove_session=${await createSession(W.pa.id)}`;
});

after(async () => {
  for (const p of openPeers.splice(0)) await release(p);
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
const hex = (n) => crypto.randomBytes(n).toString("hex");
// A UUID whose first byte is `rank`, so the id order of a race is chosen by the
// test (uuid comparison is bytewise); the rest is random, so ids never repeat.
const rankedId = (rank) => {
  const r = hex(16);
  return `${rank.toString(16).padStart(2, "0")}${r.slice(2, 8)}-${r.slice(8, 12)}-4${r.slice(13, 16)}-8${r.slice(17, 20)}-${r.slice(20, 32)}`;
};
const one = async (sql, params = []) => (await k.query(sql, params)).rows[0];

async function person(rank, label) {
  const id = rankedId(rank);
  await k.query(
    `insert into public.users (id, email, first_name, last_name, full_name, display_name, is_active)
     values ($1, $2, $3, 'Test', $3, $3, true)`,
    [id, `${label}-${hex(4)}@test.local`, label],
  );
  return { id };
}
async function club(rank) {
  const id = rankedId(rank);
  await k.query(`insert into public.clubs (id, name, is_active) values ($1, $2, true)`, [id, `Club ${hex(4)}`]);
  return id;
}
const grantPlatform = (userId) => k.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [userId]);
const grantClub = (userId, clubId) => k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [userId, clubId]);
const loginActive = async (userId) => (await one(`select is_active from public.users where id = $1`, [userId])).is_active;
const clubRoleActive = async (userId, clubId) => (await one(`select is_active from public.user_club_roles where user_id = $1 and club_id = $2 and role = 'club_admin'`, [userId, clubId])).is_active;

async function api(p, { method = "GET", body, cookie = W.pa.cookie } = {}) {
  const res = await fetch(`${apiBase}/api/organization${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}
const switchOff = (userId) => api(`/users/${userId}/login-status`, { method: "PUT", body: { active: false } });
const revokeClub = (userId, clubId) => api(`/users/${userId}/club-roles/${clubId}/club_admin`, { method: "DELETE" });

// Peers: a transaction that holds rows or locks until released.
const openPeers = [];
async function peer() {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  await c.query("begin");
  openPeers.push(c);
  return c;
}
async function holdUser(userId) {
  const c = await peer();
  await c.query(`select 1 from public.users where id = $1 for update`, [userId]);
  return c;
}
async function release(c) {
  const at = openPeers.indexOf(c);
  if (at >= 0) openPeers.splice(at, 1);
  await c.query("commit").catch(() => {});
  await c.end().catch(() => {});
}
// The Roles API's pair statement (contract 4.3 place 2), sent by a peer: both
// users rows in id order, for share, no is_active filter. Resolves with the
// SQLSTATE it ended with (null when it locked both rows and committed).
async function pairStatement(actorId, targetId) {
  const c = await peer();
  const done = c.query(`select u.id from public.users u where u.id in ($1, $2) order by u.id for share`, [actorId, targetId])
    .then(async () => { await release(c); return null; })
    .catch(async (error) => { await c.query("rollback").catch(() => {}); await release(c); return error.code ?? "error"; });
  return done;
}
// Backends of this database waiting on a lock (heavyweight or advisory), not
// counting this connection.
async function waiting() {
  return (await one(`select count(*)::int as n from pg_stat_activity
                     where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`)).n;
}
async function untilWaiting(n, label, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((await waiting()) >= n) return;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.fail(`timed out: fewer than ${n} backend(s) wait on a lock (${label})`);
}
const settle = (ms = 300) => new Promise((res) => setTimeout(res, ms));
function assertNoDeadlock(label, ...outcomes) {
  for (const o of outcomes) {
    if (o && typeof o === "object") assert.notEqual(o.status, 500, `${label}: a route answered 500 (${o.text})`);
    else assert.notEqual(o, "40P01", `${label}: the pair statement ended in 40P01`);
  }
  assert.ok(!logLines.some((l) => /deadlock|40P01/i.test(l)), `${label}: a deadlock was logged: ${logLines.filter((l) => /deadlock|40P01/i.test(l)).join(" | ")}`);
}

// ---------------------------------------------------------------------------
// 29a: the switch-off against the Roles API's pair statement and the old
// revocation. Each race is run with the ids in both orders and, where the
// arrival order matters, in both orders of arrival.
// ---------------------------------------------------------------------------

// Contract 4.3.1, first cycle: Z administers K1 < K2; T is an admin of K1 and A
// of K2. A assigns to (or revokes from) T: the pair statement locks A and T in
// id order. Before the change the switch-off of Z locked K1's admins (T) and
// then asked for K2's (A).
async function raceTwoClubsAgainstPair({ actorBelowTarget, pairFirst }) {
  logLines.length = 0;
  const k1 = await club(0x10);
  const k2 = await club(0x20);
  const A = await person(actorBelowTarget ? 0x30 : 0x50, "a-admin-k2");
  const T = await person(actorBelowTarget ? 0x50 : 0x30, "t-admin-k1");
  const Z = await person(0x70, "z-admin-k1-k2");
  await grantClub(Z.id, k1); await grantClub(Z.id, k2);
  await grantClub(T.id, k1); await grantClub(A.id, k2);
  // The lower of the pair is held by P1 and the higher by P2, so the pair
  // statement takes the lower and then waits for the higher, while the old
  // switch-off held K1's T and waited for K2's A.
  const [low, high] = [A.id, T.id].sort();
  const p1 = await holdUser(low);
  const p2 = await holdUser(high);
  let pair, off;
  if (pairFirst) {
    pair = pairStatement(A.id, T.id); await untilWaiting(1, "pair");
    off = switchOff(Z.id); await untilWaiting(2, "switch-off");
  } else {
    off = switchOff(Z.id); await untilWaiting(1, "switch-off");
    pair = pairStatement(A.id, T.id); await untilWaiting(2, "pair");
  }
  await release(p1); await settle();
  await release(p2);
  const [pairCode, offRes] = await Promise.all([pair, off]);
  assertNoDeadlock(`two clubs vs pair (actor ${actorBelowTarget ? "below" : "above"} target, ${pairFirst ? "pair" : "switch-off"} first)`, pairCode, offRes);
  assert.equal(offRes.status, 200, offRes.text);
  assert.equal(await loginActive(Z.id), false);
  assert.equal(pairCode, null);
}
for (const actorBelowTarget of [true, false]) {
  for (const pairFirst of [true, false]) {
    test(`29a-1. the switch-off of an admin of two clubs against the pair statement of an admin of K2 and an admin of K1 (actor ${actorBelowTarget ? "below" : "above"} target, ${pairFirst ? "pair" : "switch-off"} first): no 40P01`, () => raceTwoClubsAgainstPair({ actorBelowTarget, pairFirst }));
  }
}

// Second cycle: the target Z is a platform admin and a club's admin. The old
// code locked every platform admin (PA among them) and then, in another
// statement, the club's admins (C). The pair statement of C and PA locks them
// in id order.
async function racePlatformAndClubAgainstPair({ actorBelowTarget }) {
  logLines.length = 0;
  const kc = await club(0x10);
  const C = await person(actorBelowTarget ? 0x30 : 0x50, "c-admin-k");
  const PA = await person(actorBelowTarget ? 0x50 : 0x30, "pa-other-platform-admin");
  const Z = await person(0x70, "z-platform-and-club");
  await grantPlatform(Z.id); await grantPlatform(PA.id);
  await grantClub(Z.id, kc); await grantClub(C.id, kc);
  const [low, high] = [C.id, PA.id].sort();
  const p1 = await holdUser(low);
  const p2 = await holdUser(high);
  const pair = pairStatement(C.id, PA.id); await untilWaiting(1, "pair");
  const off = switchOff(Z.id); await untilWaiting(2, "switch-off");
  await release(p1); await settle();
  await release(p2);
  const [pairCode, offRes] = await Promise.all([pair, off]);
  assertNoDeadlock(`platform and club vs pair (actor ${actorBelowTarget ? "below" : "above"} target)`, pairCode, offRes);
  assert.equal(offRes.status, 200, offRes.text);
  assert.equal(await loginActive(Z.id), false);
}
for (const actorBelowTarget of [true, false]) {
  test(`29a-2. the switch-off of a platform admin who is also a club's admin against the pair statement of that club's admin and another platform admin (actor ${actorBelowTarget ? "below" : "above"} target): no 40P01`, () => racePlatformAndClubAgainstPair({ actorBelowTarget }));
}

// Against the old revocation: Z administers K1 and K2; S is an admin of K1 and
// K3, X of K2 and K3. The old club_admin revocation of X at K3 locks K3's
// admins (X, S) in one id-ordered statement; the old switch-off locked K1's
// (S) and then K2's (X).
async function raceTwoClubsAgainstOldRevocation({ sharedBelow }) {
  logLines.length = 0;
  const k1 = await club(0x10);
  const k2 = await club(0x20);
  const k3 = await club(0x30);
  const X = await person(sharedBelow ? 0x40 : 0x60, "x-admin-k2-k3");
  const S = await person(sharedBelow ? 0x60 : 0x40, "s-admin-k1-k3");
  const Z = await person(0x20, "z-admin-k1-k2");
  await grantClub(Z.id, k1); await grantClub(Z.id, k2);
  await grantClub(S.id, k1); await grantClub(S.id, k3);
  await grantClub(X.id, k2); await grantClub(X.id, k3);
  const [low, high] = [X.id, S.id].sort();
  const p1 = await holdUser(low);
  const p2 = await holdUser(high);
  const revoke = revokeClub(X.id, k3); await untilWaiting(1, "old revocation");
  const off = switchOff(Z.id); await untilWaiting(2, "switch-off");
  await release(p1); await settle();
  await release(p2);
  const [revokeRes, offRes] = await Promise.all([revoke, off]);
  assertNoDeadlock(`two clubs vs the old revocation of K3 (${sharedBelow ? "X below S" : "X above S"})`, revokeRes, offRes);
  assert.equal(revokeRes.status, 200, revokeRes.text);
  assert.equal(offRes.status, 200, offRes.text);
  assert.equal(await clubRoleActive(X.id, k3), false);
  assert.equal(await loginActive(Z.id), false);
}
for (const sharedBelow of [true, false]) {
  test(`29a-3. the switch-off of an admin of K1 and K2 against the old club_admin revocation of K3, whose admins are also admins of K1 and K2 (${sharedBelow ? "the revoked admin below the other" : "the revoked admin above the other"}): no 40P01`, () => raceTwoClubsAgainstOldRevocation({ sharedBelow }));
}

// The third cycle of 4.3.1, which exists without the Roles API: the old
// switch-off held every platform admin's row and then waited for the club's
// headcount advisory lock; the old revocation of that club held the advisory
// lock and then asked for the row of a platform admin who is also the club's
// admin.
async function raceThirdCycle({ revokedLowest }) {
  logLines.length = 0;
  const kc = await club(0x10);
  const Y = await person(revokedLowest ? 0x08 : 0x90, "y-club-admin");
  const R = await person(0x40, "r-platform-and-club");
  const Z = await person(0x60, "z-platform-and-club");
  await grantPlatform(R.id); await grantPlatform(Z.id);
  await grantClub(Y.id, kc); await grantClub(R.id, kc); await grantClub(Z.id, kc);
  const p = await holdUser(Y.id);
  const revoke = revokeClub(Y.id, kc); await untilWaiting(1, "old revocation");
  const off = switchOff(Z.id); await untilWaiting(2, "switch-off");
  await release(p);
  const [revokeRes, offRes] = await Promise.all([revoke, off]);
  assertNoDeadlock(`third cycle (${revokedLowest ? "revoked admin lowest" : "revoked admin highest"})`, revokeRes, offRes);
  assert.equal(revokeRes.status, 200, revokeRes.text);
  assert.equal(offRes.status, 200, offRes.text);
}
for (const revokedLowest of [true, false]) {
  test(`29a-4. the third cycle: the switch-off of a platform admin who is a club's admin against the old club_admin revocation of that club, where another platform admin is also its admin (${revokedLowest ? "the revoked admin's id lowest" : "the revoked admin's id highest"}): no 40P01`, () => raceThirdCycle({ revokedLowest }));
}

// ---------------------------------------------------------------------------
// 28 (the switch-off's part): the recorded SQL order
// ---------------------------------------------------------------------------
function recordPool() {
  const seen = [];
  const params = [];
  const wrapped = [];
  const original = appPool.connect;
  appPool.connect = function (callback) {
    if (callback) return original.call(this, callback);
    return original.call(this).then((c) => {
      if (!wrapped.some((w) => w.c === c)) {
        const send = c.query;
        wrapped.push({ c, send });
        c.query = function (...args) {
          const t = typeof args[0] === "string" ? args[0] : args[0]?.text;
          if (t) { seen.push(t.replace(/\s+/g, " ").trim()); params.push(Array.isArray(args[1]) ? args[1] : (args[0]?.values ?? [])); }
          return send.apply(this, args);
        };
      }
      return c;
    });
  };
  return {
    seen,
    params,
    restore() {
      appPool.connect = original;
      for (const { c, send } of wrapped) c.query = send;
    },
  };
}
const LOCKING = /\bfor (update|no key update|share|key share)\b/i;
const ADVISORY = /pg_advisory_xact_lock/i;
const WRITE = /^(update|insert|delete)\b/i;

test("28. the switch-off's recorded SQL order: every advisory lock first (platform, then each club in club id order), then ONE users statement in id order with no other table locked, then only the counted role rows, and no locking clause after the first write", async () => {
  const kA = await club(0x10);
  const kB = await club(0x20);
  const Z = await person(0x50, "z-recorded");
  const other = await person(0x30, "other-admin");
  await grantPlatform(Z.id);
  await grantClub(Z.id, kB); await grantClub(Z.id, kA);
  await grantClub(other.id, kA); await grantClub(other.id, kB);
  const rec = recordPool();
  let res;
  try { res = await switchOff(Z.id); } finally { rec.restore(); }
  assert.equal(res.status, 200, res.text);
  const s = rec.seen;
  const begin = s.findIndex((t) => /^begin$/i.test(t));
  const commit = s.findIndex((t) => /^commit$/i.test(t));
  assert.ok(begin >= 0 && commit > begin, s.join("\n"));
  const tx = s.slice(begin, commit + 1);
  const txParams = rec.params.slice(begin, commit + 1);
  const advisory = tx.map((t, i) => (ADVISORY.test(t) ? i : -1)).filter((i) => i >= 0);
  const locking = tx.map((t, i) => (LOCKING.test(t) ? i : -1)).filter((i) => i >= 0);
  const firstWrite = tx.findIndex((t) => WRITE.test(t));
  assert.equal(advisory.length, 3, `platform + two clubs:\n${tx.join("\n")}`);
  assert.ok(locking.length > 0 && locking[0] > advisory[advisory.length - 1], `no row lock before the last advisory lock:\n${tx.join("\n")}`);
  // The advisory locks: platform first, then the clubs in club id order.
  assert.match(tx[advisory[0]], /pg_advisory_xact_lock\(\$1\)/);
  assert.match(tx[advisory[1]], /hashtext/);
  assert.match(tx[advisory[2]], /hashtext/);
  assert.deepEqual([txParams[advisory[1]][1], txParams[advisory[2]][1]], [kA, kB], "the clubs' advisory locks in club id order");
  // The first locking statement is the one users statement: it locks users
  // only (`for update of u`), in id order, and is the only one that does.
  const usersStatements = locking.filter((i) => /from public\.users u\b/i.test(tx[i]) && /for update of u$/i.test(tx[i]));
  assert.equal(usersStatements.length, 1, `exactly one statement locks users rows:\n${tx.join("\n")}`);
  assert.equal(usersStatements[0], locking[0], "the users statement is the first row lock");
  assert.match(tx[locking[0]], /order by u\.id for update of u$/i);
  // Then only the role rows the decision counts, each locking its role table
  // alone: the platform_admin rows, then the club_admin rows.
  const roleLocks = locking.slice(1);
  assert.equal(roleLocks.length, 2, `two role statements:\n${tx.join("\n")}`);
  assert.match(tx[roleLocks[0]], /from public\.user_global_roles g .*role = 'platform_admin'.*order by g\.user_id for update of g$/i);
  assert.match(tx[roleLocks[1]], /from public\.user_club_roles r .*role = 'club_admin'.*for update of r$/i);
  assert.ok(!locking.some((i) => /for update of u, (g|r)|for update of (g|r), u/i.test(tx[i])), "no statement locks users and role rows together");
  // Every lock before the first write; no locking clause between the first
  // write and the COMMIT.
  assert.ok(firstWrite > locking[locking.length - 1], `every lock before the first write:\n${tx.join("\n")}`);
  assert.ok(!tx.slice(firstWrite).some((t) => LOCKING.test(t) || ADVISORY.test(t)), "no lock after the first write");
});

test("28b. the users set is read only under every advisory lock: a club admin granted after the switch-off took the club's advisory lock and before it read the set is counted and locked", async () => {
  // A peer holds K's advisory lock, so the switch-off waits there; while it
  // waits, a second admin of K is granted. The union read after the advisory
  // locks must see that admin, so the target is NOT the last admin.
  const kc = await club(0x10);
  const Z = await person(0x50, "z-only-admin");
  await grantClub(Z.id, kc);
  const lockPeer = await peer();
  await lockPeer.query(`select pg_advisory_xact_lock($1, hashtext($2::text))`, [CLUB_LOCK_NAMESPACE, kc]);
  const off = switchOff(Z.id);
  await untilWaiting(1, "switch-off on the club's advisory lock");
  const late = await person(0x30, "late-admin");
  await grantClub(late.id, kc);
  await release(lockPeer);
  const res = await off;
  assert.equal(res.status, 200, `the late admin was counted: ${res.text}`);
  assert.equal(await loginActive(Z.id), false);
});

// ---------------------------------------------------------------------------
// The decision is unchanged
// ---------------------------------------------------------------------------
test("D1. LAST_CLUB_ADMIN: the target is the last qualifying admin of the second of its two clubs (the first has another admin); nothing changes", async () => {
  const k1 = await club(0x10);
  const k2 = await club(0x20);
  const Z = await person(0x50, "z-last-of-k2");
  const other = await person(0x30, "other-k1");
  await grantClub(Z.id, k1); await grantClub(Z.id, k2); await grantClub(other.id, k1);
  const res = await switchOff(Z.id);
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: "LAST_CLUB_ADMIN" });
  assert.equal(await loginActive(Z.id), true);
});

test("D2. an admin whose login is off, or whose club role is inactive, does not count; an archived club is exempt", async () => {
  const k1 = await club(0x10);
  const archived = await club(0x20);
  const Z = await person(0x50, "z");
  const off = await person(0x30, "login-off");
  const inactive = await person(0x40, "role-inactive");
  await grantClub(Z.id, k1); await grantClub(off.id, k1);
  await k.query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',false)`, [inactive.id, k1]);
  await k.query(`update public.users set is_active = false where id = $1`, [off.id]);
  assert.deepEqual((await switchOff(Z.id)).body, { error: "LAST_CLUB_ADMIN" });
  // The archived club, where Z is the only admin, does not block.
  const Z2 = await person(0x60, "z2");
  const helper = await person(0x70, "helper");
  await grantClub(Z2.id, archived); await grantClub(Z2.id, k1); await grantClub(helper.id, k1);
  await k.query(`update public.clubs set is_active = false where id = $1`, [archived]);
  const res = await switchOff(Z2.id);
  assert.equal(res.status, 200, res.text);
  assert.equal(await loginActive(Z2.id), false);
});

test("D3. the order of the answers stays: a platform admin target that is also the last admin of a club gets LAST_CLUB_ADMIN when other platform admins remain; a non-platform actor cannot switch off a platform admin (403); the actor cannot switch itself off (400)", async () => {
  const kc = await club(0x10);
  const Z = await person(0x50, "z-pa-last-club");
  await grantPlatform(Z.id); await grantClub(Z.id, kc);
  assert.deepEqual((await switchOff(Z.id)).body, { error: "LAST_CLUB_ADMIN" });
  assert.equal(await loginActive(Z.id), true);
  // A club admin who created a platform admin account still gets 403.
  const creatorClub = await club(0x20);
  const creator = await person(0x30, "creator");
  await grantClub(creator.id, creatorClub);
  const target = await person(0x60, "created-pa");
  await k.query(`update public.users set created_by_user_id = $1 where id = $2`, [creator.id, target.id]);
  await grantPlatform(target.id);
  const creatorCookie = `optimove_session=${await createSession(creator.id)}`;
  const forbidden = await api(`/users/${target.id}/login-status`, { method: "PUT", body: { active: false }, cookie: creatorCookie });
  assert.equal(forbidden.status, 403, forbidden.text);
  assert.equal(await loginActive(target.id), true);
  const self = await switchOff(W.pa.id);
  assert.equal(self.status, 400, self.text);
  assert.equal(await loginActive(W.pa.id), true);
});

test("28c. only the rows the decision counts are locked: the switch-off of an admin of K does not wait for another club's admin row, its role row, or a platform admin's club role row, while a peer holds each of them", async () => {
  const kc = await club(0x10);
  const elsewhere = await club(0x20);
  const Z = await person(0x50, "z-admin-k");
  const other = await person(0x30, "other-admin-k");
  const stranger = await person(0x40, "admin-of-another-club");
  await grantClub(Z.id, kc); await grantClub(other.id, kc); await grantClub(stranger.id, elsewhere);
  // W.pa (a platform admin) is also an admin of the other club: the switch-off
  // of a non-platform target locks no platform row and no role row of that club.
  await grantClub(W.pa.id, elsewhere);
  const p1 = await holdUser(stranger.id);
  const p2 = await peer();
  await p2.query(`select 1 from public.user_club_roles where club_id = $1 for update`, [elsewhere]);
  const p3 = await peer();
  await p3.query(`select 1 from public.user_global_roles where role = 'platform_admin' for update`);
  try {
    let timer;
    const res = await Promise.race([switchOff(Z.id), new Promise((res) => { timer = setTimeout(() => res({ status: "waited" }), 5_000); })]);
    clearTimeout(timer);
    assert.equal(res.status, 200, `the switch-off waited for a row it does not count (${res.text ?? res.status})`);
  } finally {
    await release(p1); await release(p2); await release(p3);
  }
  assert.equal(await loginActive(Z.id), false);
});
