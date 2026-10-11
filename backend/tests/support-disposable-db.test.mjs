// The shared disposable-database support (tests/support/disposable-db.mjs,
// T1) checked on its own against the local server: the name rule, the
// loopback-only rule, create, the landing check, the audit listing, drop
// (other sessions ended first), and that nothing is left behind.
import { test } from "node:test";
import assert from "node:assert/strict";
// Like every other database test file: under plain `npm test` the target
// comes from backend/.env; under the runner DOTENV_CONFIG_PATH points at no
// file and the runner's own DATABASE_URL is the only target.
import "dotenv/config";
import pg from "pg";

import {
  DISPOSABLE_DATABASE_NAME_PATTERN,
  DROPPABLE_DATABASE_NAME_PATTERN,
  adminUrlFor,
  assertConnectedTo,
  assertDisposableDatabaseName,
  countMaintenanceObjects,
  createDisposableDatabase,
  databaseUrlFor,
  disposableDatabaseName,
  dropDisposableDatabase,
  isPrivateOrLoopbackAddress,
  listDatabases,
  parseServerUrl,
} from "./support/disposable-db.mjs";

const BASE = process.env.DATABASE_URL;
if (!BASE) throw new Error("DATABASE_URL must point at the local PostgreSQL server (the runner sets it for disposable-kind files).");

test("1. a disposable name is optimove_tests_<prefix>_<label>_<12 hex>, and only such names are accepted", () => {
  const name = disposableDatabaseName("support", "selftest");
  assert.match(name, /^optimove_tests_support_selftest_[0-9a-f]{12}$/);
  assert.match(name, DISPOSABLE_DATABASE_NAME_PATTERN);
  assert.match(name, DROPPABLE_DATABASE_NAME_PATTERN);
  assert.doesNotMatch("optimove_tests_handmade", DROPPABLE_DATABASE_NAME_PATTERN, "a hand-made name without the hex suffix is never droppable by the audit");
  assert.notEqual(disposableDatabaseName("support", "selftest"), name, "two names never collide");
  for (const bad of ["OPTIMOVE", "optimove", "monitoring2", "optimove_tests_monitoring2_x", "postgres", "optimove_tests_", "optimove_tests_Upper_x", "", undefined]) {
    assert.throws(() => assertDisposableDatabaseName(bad), /SAFETY/, `must refuse ${JSON.stringify(bad)}`);
  }
  assert.throws(() => disposableDatabaseName("bad-prefix", "x"), /prefix must match/);
  assert.throws(() => disposableDatabaseName("ok", "bad label"), /label must match/);
  assert.throws(() => disposableDatabaseName("p", "x".repeat(60)), /longer than PostgreSQL allows/);
});

test("2. the server URL must be a loopback postgres:// URL without a remote, persistent or redirecting part", () => {
  assert.equal(parseServerUrl(BASE).hostname.length > 0, true);
  for (const [label, url] of [
    ["a remote host", "postgresql://u:p@db.example.com:5432/x"],
    ["Supabase", "postgresql://u:p@localhost:5432/x?note=supabase"],
    ["Render", "postgresql://u:p@localhost:5432/x?note=onrender"],
    ["monitoring2", "postgresql://u:p@localhost:5432/monitoring2"],
    ["a libpq host override", "postgresql://u:p@localhost:5432/x?host=db.example.com"],
    ["a port override", "postgresql://u:p@localhost:5432/x?port=6543"],
    ["a user override", "postgresql://u:p@localhost:5432/x?user=postgres"],
    ["not postgres", "mysql://u:p@localhost:3306/x"],
    ["not a URL", "nonsense"],
  ]) {
    assert.throws(() => parseServerUrl(url), /SAFETY/, `must refuse ${label}`);
  }
  assert.ok(parseServerUrl("postgresql://u:p@localhost:5432/x?sslmode=disable&application_name=t"), "sslmode and application_name pass");
  assert.throws(() => parseServerUrl(""), /DATABASE_URL/);
  assert.equal(new URL(adminUrlFor(BASE)).pathname, "/postgres");
  assert.equal(new URL(databaseUrlFor("optimove_tests_support_x_000000000000", BASE)).pathname, "/optimove_tests_support_x_000000000000");
  assert.throws(() => databaseUrlFor("OPTIMOVE", BASE), /SAFETY/);
});

test("3. create lands on the new database, the audit lists it, drop ends other sessions and removes it, nothing is left behind", async () => {
  const before = (await listDatabases({ baseDatabaseUrl: BASE })).map((d) => d.name);
  const maintenanceBefore = await countMaintenanceObjects({ baseDatabaseUrl: BASE });
  const db = await createDisposableDatabase({ prefix: "support", label: "selftest", baseDatabaseUrl: BASE });
  let dropped = false;
  try {
    assert.match(db.name, /^optimove_tests_support_selftest_[0-9a-f]{12}$/);
    assert.equal(new URL(db.url).pathname, `/${db.name}`);
    assert.equal(new URL(db.adminUrl).pathname, "/postgres");
    const client = new pg.Client({ connectionString: db.url });
    // The drop below ends this session on purpose; pg reports that as an
    // 'error' event on the client, which must not become an uncaught error.
    const sessionErrors = [];
    client.on("error", (error) => sessionErrors.push(error));
    await client.connect();
    await assertConnectedTo(client, db.name);
    await assert.rejects(() => assertConnectedTo(client, "optimove_tests_support_other_000000000000"), /SAFETY/);
    await client.query("create table t (id int)");
    const listed = await listDatabases({ baseDatabaseUrl: BASE });
    const row = listed.find((d) => d.name === db.name);
    assert.ok(row, "the audit lists the new database");
    assert.equal(row.disposable, true, "and marks it droppable");
    assert.equal(row.sessions, 1, "and counts the open session on it");
    assert.ok(!before.includes(db.name));

    // A second session is still open on the database: drop must end it,
    // not fail with "database is being accessed by other users".
    await db.drop();
    dropped = true;
    await assert.rejects(() => client.query("select 1"), "the open session was terminated by the drop");
    await client.end().catch(() => {});
    assert.ok(sessionErrors.length >= 1, "the client reported the termination");
    assert.match(String(sessionErrors[0].message), /terminating connection due to administrator command/);
    const after = (await listDatabases({ baseDatabaseUrl: BASE })).map((d) => d.name);
    assert.ok(!after.includes(db.name), "the database is gone");
    assert.equal(await countMaintenanceObjects({ baseDatabaseUrl: BASE }), maintenanceBefore, "nothing was written into the maintenance database");
    // Other runs may create and drop their own databases meanwhile, so only
    // this file's database is asserted on, not the whole list.
    await dropDisposableDatabase({ name: db.name, baseDatabaseUrl: BASE }); // idempotent
  } finally {
    if (!dropped) await db.drop();
  }
});

test("5. the server-address rule: loopback, private ranges, link-local and a Unix socket are local; a public address is a tunnelled remote server", () => {
  for (const local of [null, undefined, "127.0.0.1", "127.0.0.1/32", "::1", "::ffff:127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.10", "fd12:3456::1", "fe80::1", "::ffff:10.1.2.3"]) {
    assert.equal(isPrivateOrLoopbackAddress(local), true, `${local} must count as local`);
  }
  for (const remote of ["8.8.8.8", "172.15.0.1", "172.32.0.1", "100.64.0.1", "203.0.113.7", "2001:db8::1", "::ffff:203.0.113.7"]) {
    assert.equal(isPrivateOrLoopbackAddress(remote), false, `${remote} must count as remote`);
  }
});

test("4. drop refuses any name outside the disposable pattern before touching the server", async () => {
  for (const bad of ["OPTIMOVE", "postgres", "monitoring2", "template1"]) {
    await assert.rejects(() => dropDisposableDatabase({ name: bad, baseDatabaseUrl: BASE }), /SAFETY/, `must refuse ${bad}`);
  }
});
