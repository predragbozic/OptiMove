// Phase 7a: the context resolver of sourceMetricAccess.js, run directly with an
// explicit workspace and a fake bounded read, so no database is reached. It pins
// each decision of resolveMappingAdminWith, including the fail-closed read of an
// active club ("whatever the workspace list admitted"), which no route test can
// reach because the workspace list already drops an archived club
// (backend/src/workspace.js). T5 (phase 7d) reuses this function.
import { after, test } from "node:test";
import assert from "node:assert/strict";

assert.equal(process.env.DATABASE_URL, undefined, "Run through the unit test runner, which scrubs database targets");
// authz.js and workspace.js import db.js, which needs a URL even to construct its
// lazy pool. This unreachable loopback placeholder is never connected to.
process.env.DATABASE_URL = "postgresql://access_fixture@127.0.0.1:1/access_no_database";
const { pool } = await import("../src/db.js");
let databaseAttempts = 0;
const originalQuery = pool.query;
const originalConnect = pool.connect;
pool.query = async () => { databaseAttempts++; throw new Error("Unexpected database access in the access test"); };
pool.connect = async () => { databaseAttempts++; throw new Error("Unexpected database checkout in the access test"); };
const { resolveMappingAdminWith } = await import("../src/sourceMetricAccess.js");

after(async () => {
  try {
    assert.equal(databaseAttempts, 0, "the resolver reads only through the read it is given");
  } finally {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    await pool.end();
    delete process.env.DATABASE_URL;
  }
});

const USER = "11111111-1111-4111-8111-111111111111";
const CLUB = "22222222-2222-4222-8222-222222222222";
const OTHER_CLUB = "33333333-3333-4333-8333-333333333333";
const TEAM = "44444444-4444-4444-8444-444444444444";
const platformAdmin = { user: { id: USER }, authz: { platformRoles: [{ role: "platform_admin" }], clubRoles: [], teamRoles: [] } };
const clubAdmin = { user: { id: USER }, authz: { platformRoles: [], clubRoles: [{ clubId: CLUB, role: "club_admin" }], teamRoles: [] } };
const coach = { user: { id: USER }, authz: { platformRoles: [], clubRoles: [], teamRoles: [{ teamId: TEAM, role: "team_coach" }] } };

// A fake bounded read: records each statement and answers the given row count.
function fakeRead(rowCount) {
  const calls = [];
  const read = async (work) => work({ query: async (sql, params) => { calls.push({ sql, params }); return { rowCount, rows: [] }; } });
  return { read, calls };
}

test("1. a platform admin in the platform workspace: the system scope, no read", async () => {
  const { read, calls } = fakeRead(1);
  assert.deepEqual(await resolveMappingAdminWith(read, platformAdmin, { type: "platform", scopeId: null }),
    { userId: USER, basis: "platform_admin", owner: { scope: "system", clubId: null } });
  assert.equal(calls.length, 0);
});

test("2. a platform admin in an active club's workspace: that club's scope, after one read of the club", async () => {
  const { read, calls } = fakeRead(1);
  assert.deepEqual(await resolveMappingAdminWith(read, platformAdmin, { type: "club", scopeId: CLUB }),
    { userId: USER, basis: "platform_admin", owner: { scope: "club", clubId: CLUB } });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /from public\.clubs where id = \$1 and coalesce\(is_active, true\)/);
  assert.deepEqual(calls[0].params, [CLUB]);
});

test("3. an archived club's workspace gives no context, whoever asks (fail closed)", async () => {
  for (const req of [platformAdmin, clubAdmin]) {
    const { read, calls } = fakeRead(0);
    assert.equal(await resolveMappingAdminWith(read, req, { type: "club", scopeId: CLUB }), null);
    assert.equal(calls.length, 1);
  }
});

test("4. a club admin: its own active club's scope; another club's workspace gives nothing, without a read", async () => {
  const own = fakeRead(1);
  assert.deepEqual(await resolveMappingAdminWith(own.read, clubAdmin, { type: "club", scopeId: CLUB }),
    { userId: USER, basis: "club_admin", owner: { scope: "club", clubId: CLUB } });
  const other = fakeRead(1);
  assert.equal(await resolveMappingAdminWith(other.read, clubAdmin, { type: "club", scopeId: OTHER_CLUB }), null);
  assert.equal(other.calls.length, 0);
});

test("5. a team, athlete or private coaching workspace gives nothing, even to a platform admin; so does a coach", async () => {
  for (const req of [platformAdmin, clubAdmin, coach]) {
    for (const known of [{ type: "team", scopeId: TEAM }, { type: "athlete", scopeId: USER }, { type: "private_coach", scopeId: USER }]) {
      const { read, calls } = fakeRead(1);
      assert.equal(await resolveMappingAdminWith(read, req, known), null, `${known.type}`);
      assert.equal(calls.length, 0);
    }
  }
  const { read, calls } = fakeRead(1);
  assert.equal(await resolveMappingAdminWith(read, coach, { type: "club", scopeId: CLUB }), null);
  assert.equal(calls.length, 0);
});

test("6. no user, no authorization, no workspace or a club id that is not a uuid: nothing, without a read", async () => {
  const { read, calls } = fakeRead(1);
  assert.equal(await resolveMappingAdminWith(read, {}, { type: "platform" }), null);
  assert.equal(await resolveMappingAdminWith(read, { user: { id: USER } }, { type: "platform" }), null);
  assert.equal(await resolveMappingAdminWith(read, platformAdmin, null), null);
  assert.equal(await resolveMappingAdminWith(read, platformAdmin, { type: "club", scopeId: "not-a-uuid" }), null);
  assert.equal(await resolveMappingAdminWith(read, clubAdmin, { type: "club", scopeId: null }), null);
  assert.equal(calls.length, 0);
});
