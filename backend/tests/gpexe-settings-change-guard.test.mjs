// Changing a team's GPEXE connection, through the real server on a
// disposable database (v24). A GPEXE athlete id and a GPEXE session id mean
// something only inside their own GPEXE team, while athlete links and
// candidates are keyed by the OptiMove team alone - so the connection may be
// changed only while nothing depends on it. The change and its guard run in
// one transaction under the same team import lock a check and an import take.
//
// Nothing here touches a persistent database, the import switch stays off,
// and GPEXE itself is a fake client that makes no network call.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, createGpexePilotOrg } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;

let db;
let admin;
let server;
let apiBase;
let service;
let createSession;
let appPool;

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "setguard" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  service?.setGpexeClientFactory(null);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
  if (ORIGINAL_SWITCH === undefined) delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  else process.env.GPEXE_IMPORT_APPLY_ENABLED = ORIGINAL_SWITCH;
});

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}/api/training-load/gpexe${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function sessionCookie(userId) {
  return `optimove_session=${await createSession(userId)}`;
}

async function platformAdmin() {
  const user = (await admin.query(
    `insert into public.users (email, first_name, last_name, full_name, display_name) values ($1,'P','A','Platform Admin','Platform Admin') returning id`,
    [`padmin-${Math.random().toString(16).slice(2)}@test.local`],
  )).rows[0];
  await admin.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [user.id]);
  await admin.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,'platform',null)`, [user.id]);
  return { id: user.id, cookie: await sessionCookie(user.id) };
}

async function coachOf(teamId) {
  const user = (await admin.query(
    `insert into public.users (email, first_name, last_name, full_name, display_name) values ($1,'C','O','Coach','Coach') returning id`,
    [`coach-${Math.random().toString(16).slice(2)}@test.local`],
  )).rows[0];
  await admin.query(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [user.id, teamId]);
  await admin.query(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,'team',$2)`, [user.id, teamId]);
  return { id: user.id, cookie: await sessionCookie(user.id) };
}

let nextGpexeTeamId = 5000;
async function team({ connect = true } = {}) {
  const org = await createGpexePilotOrg(admin, { athleteNames: ["A101", "B102", "C103", "D", "E", "F105"] });
  const padmin = await platformAdmin();
  const coach = await coachOf(org.teamId);
  const first = String(nextGpexeTeamId++);
  if (connect) {
    const r = await api(`/teams/${org.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: first } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return { ...org, padmin, coach, gpexeTeamId: first, next: () => String(nextGpexeTeamId++) };
}

function fakeGpexe({ onList } = {}) {
  const bundles = [makeBundle({ sessionId: 9001, gpexeTeamId: 1, athletes: standardAthletes() })];
  service.setGpexeClientFactory(() => ({
    async listTeamSessions({ onProgress }) {
      if (onList) await onList();
      await onProgress?.();
      return bundles.map((b) => ({ id: String(b.teamSession.id) }));
    },
    async fetchSessionBundle({ sessionId }) {
      return structuredClone(bundles.find((b) => String(b.teamSession.id) === sessionId));
    },
  }));
}

// A check row of a team, as a leftover for the orphan cases.
// A check row as it was before v24: no GPEXE team recorded. The insert guard
// is off for exactly that one statement, and always back on afterwards.
async function legacyCheck(t, startedAt = null) {
  await admin.query(`alter table training_load.gpexe_import_checks disable trigger gpexe_import_checks_require_team`);
  try {
    return (await admin.query(
      `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, started_at, finished_at)
       values ($1,$2,'succeeded',current_date - 7, current_date, coalesce($3::timestamptz, now()), now()) returning id, started_at`,
      [t.teamId, t.coach.id, startedAt],
    )).rows[0];
  } finally {
    await admin.query(`alter table training_load.gpexe_import_checks enable trigger gpexe_import_checks_require_team`);
  }
}

async function leftoverCheck(t) {
  return (await admin.query(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id)
     values ($1,$2,'succeeded',current_date - 7, current_date, now(), $3) returning id`,
    [t.teamId, t.coach.id, t.gpexeTeamId],
  )).rows[0];
}

async function settingsRow(teamId) {
  return (await admin.query(`select gpexe_team_id, change_reason, configured_at from training_load.gpexe_team_settings where owner_team_id = $1`, [teamId])).rows[0];
}

async function history(teamId) {
  return (await admin.query(
    `select gpexe_team_id, change_reason from training_load.gpexe_team_settings_history where owner_team_id = $1 order by configured_at, gpexe_team_id`,
    [teamId],
  )).rows;
}

// ---------------------------------------------------------------------------

test("1. the first connection needs no reason, and is recorded in the history", async () => {
  const t = await team({ connect: false });
  const gpexeTeamId = t.next();
  const r = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.gpexeTeamId, gpexeTeamId);
  assert.equal(r.body.settings.changeReason, null);
  const row = await settingsRow(t.teamId);
  assert.equal(row.change_reason, null);
  assert.deepEqual(await history(t.teamId), [{ gpexe_team_id: gpexeTeamId, change_reason: null }]);
});

test("2. the same GPEXE team again changes nothing: no new history row and the reason stays", async () => {
  const t = await team();
  const second = t.next();
  assert.equal((await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: second, reason: "wrong team at first" } })).status, 200);
  const before = await settingsRow(t.teamId);
  const historyBefore = await history(t.teamId);

  // Same value, with and without a reason: both are accepted and write nothing.
  for (const body of [{ gpexeTeamId: second }, { gpexeTeamId: second, reason: "another note" }]) {
    const again = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.settings.gpexeTeamId, second);
  }
  const after = await settingsRow(t.teamId);
  assert.equal(after.change_reason, "wrong team at first", "the reason of the current value is never rewritten without a real change");
  assert.equal(after.configured_at.getTime(), before.configured_at.getTime(), "nothing was written");
  assert.deepEqual(await history(t.teamId), historyBefore, "no new history row");
});

test("3. a change with nothing depending on it needs a reason, and each history row carries the reason of ITS value", async () => {
  const t = await team();
  const second = t.next();
  const missing = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: second } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "change_reason_required");
  for (const reason of ["", "   ", "\t\n", "x".repeat(501)]) {
    const bad = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: second, reason } });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.ok(["change_reason_required", "change_reason_too_long"].includes(bad.body.error), bad.body.error);
  }
  assert.equal((await settingsRow(t.teamId)).gpexe_team_id, t.gpexeTeamId, "a refused change writes nothing");

  const ok = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: second, reason: "  connected to the club's other team by mistake  " } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.settings.changeReason, "connected to the club's other team by mistake", "trimmed");
  assert.deepEqual(await history(t.teamId), [
    { gpexe_team_id: t.gpexeTeamId, change_reason: null },
    { gpexe_team_id: second, change_reason: "connected to the club's other team by mistake" },
  ], "the old row keeps the reason ITS value was set with, not the reason it was replaced");
});

test("4. every kind of dependent data blocks the change on its own, and nothing is written", async () => {
  // `names` is the phrase the blocker that answers must use, so removing one
  // blocker cannot be hidden by another one catching the same case.
  const cases = {
    "a check": async (t) => {
      await admin.query(
        `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id)
         values ($1,$2,'succeeded',current_date - 7, current_date, now(), $3)`,
        [t.teamId, t.coach.id, t.gpexeTeamId],
      );
    },
    "a candidate": async (t) => {
      const check = (await admin.query(
        `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id)
         values ($1,$2,'succeeded',current_date - 7, current_date, now(), $3) returning id`,
        [t.teamId, t.coach.id, t.gpexeTeamId],
      )).rows[0];
      await admin.query(
        `insert into training_load.gpexe_import_candidates
           (owner_team_id, gpexe_team_session_id, bundle_hash, raw_bundle, raw_expires_at, first_seen_check_id, last_seen_check_id, preview, preview_hash, preview_computed_at, status)
         values ($1,'9001',$2,'{}'::jsonb, now() + interval '30 days', $3, $3, '{}'::jsonb, $4, now(), 'pending')`,
        [t.teamId, "a".repeat(64), check.id, "b".repeat(64)],
      );
    },
    "an athlete link": async (t) => {
      const r = await api(`/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.coach.cookie, body: { gpexeAthleteId: "104", athleteId: t.athleteIds[0] } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    },
    "an unlinked athlete link": async (t) => {
      const r = await api(`/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.coach.cookie, body: { gpexeAthleteId: "104", athleteId: t.athleteIds[0] } });
      assert.equal(r.status, 201);
      const link = (await admin.query(`select id from training_load.gpexe_athlete_links where owner_team_id = $1`, [t.teamId])).rows[0];
      assert.equal((await api(`/teams/${t.teamId}/athlete-links/${link.id}/unlink`, { method: "POST", cookie: t.coach.cookie })).status, 200);
    },
    "a source connection": async (t) => {
      await admin.query(
        `insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1)`,
        [t.teamId],
      );
    },
  };
  const names = {
    "a check": /already has a check from GPEXE team/,
    "a candidate": /already has a session found by a check from GPEXE team/,
    "an athlete link": /already has a GPEXE athlete linked to an OptiMove athlete/,
    "an unlinked athlete link": /already has a GPEXE athlete linked to an OptiMove athlete/,
    "a source connection": /already has imported GPEXE data/,
  };
  for (const [what, prepare] of Object.entries(cases)) {
    const t = await team();
    await prepare(t);
    const before = await settingsRow(t.teamId);
    const second = t.next();
    const r = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: second, reason: "team was wrong" } });
    assert.equal(r.status, 409, `${what}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "gpexe_team_change_blocked", what);
    assert.match(r.body.message, /can no longer be changed here/, what);
    assert.match(r.body.message, names[what], `${what}: the blocker for this kind of data is the one that answered`);
    const after = await settingsRow(t.teamId);
    assert.equal(after.gpexe_team_id, before.gpexe_team_id, `${what}: nothing written`);
    assert.equal(after.change_reason, before.change_reason, what);
    assert.equal(after.configured_at.getTime(), before.configured_at.getTime(), what);
    assert.equal((await history(t.teamId)).length, 1, `${what}: no audit row for a refused change`);
  }
});

test("4b. a change with no reason is answered before any blocker is, and a first connection keeps the reason it carries", async () => {
  const t = await team();
  await leftoverCheck(t);
  const noReason = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next() } });
  assert.equal(noReason.status, 400, JSON.stringify(noReason.body));
  assert.equal(noReason.body.error, "change_reason_required", "the missing reason answers before the blocker does");

  const fresh = await team({ connect: false });
  const first = await api(`/teams/${fresh.teamId}/settings`, { method: "PUT", cookie: fresh.padmin.cookie, body: { gpexeTeamId: fresh.next(), reason: "pilot team, owner approved" } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.settings.changeReason, "pilot team, owner approved", "a reason given on a first connection is kept");
  assert.deepEqual((await history(fresh.teamId)).map((r) => r.change_reason), ["pilot team, owner approved"]);
});

test("5. another team's data never blocks this team's change", async () => {
  const other = await team();
  const r = await api(`/teams/${other.teamId}/athlete-links`, { method: "POST", cookie: other.coach.cookie, body: { gpexeAthleteId: "104", athleteId: other.athleteIds[0] } });
  assert.equal(r.status, 201);
  await admin.query(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id)
     values ($1,$2,'succeeded',current_date - 7, current_date, now(), $3)`,
    [other.teamId, other.coach.id, other.gpexeTeamId],
  );

  const t = await team();
  const second = t.next();
  const ok = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: second, reason: "first number was a typo" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await settingsRow(t.teamId)).gpexe_team_id, second);
});

test("6. only a platform admin may connect or change; a team coach is refused and nothing is written", async () => {
  const t = await team();
  const second = t.next();
  const r = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.coach.cookie, body: { gpexeTeamId: second, reason: "let me" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "forbidden");
  assert.equal((await settingsRow(t.teamId)).gpexe_team_id, t.gpexeTeamId);
  assert.equal((await history(t.teamId)).length, 1);
});

test("7a. a check that holds the team lock makes a concurrent change wait, then refuses it; nothing is half written", async () => {
  const t = await team();
  const lock = new pg.Client({ connectionString: db.url });
  await lock.connect();
  try {
    // Exactly what startCheck and an approval take.
    await lock.query("begin");
    await lock.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${t.teamId}`]);
    const started = Date.now();
    const r = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next(), reason: "while busy" } });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "gpexe_change_busy");
    assert.ok(Date.now() - started >= 1_000, "it waited for the lock instead of failing at once");
    assert.ok(Date.now() - started < 30_000, "and it did not wait without a limit");
  } finally {
    await lock.query("rollback").catch(() => {});
    await lock.end();
  }
  assert.equal((await settingsRow(t.teamId)).gpexe_team_id, t.gpexeTeamId, "nothing was written");
  assert.equal((await history(t.teamId)).length, 1);
  // The lock is released with the transaction, so the same change works now
  // (this team still has nothing depending on its connection).
  const after = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next(), reason: "after the lock" } });
  assert.equal(after.status, 200, JSON.stringify(after.body));
});

test("7b. a check and a change never interleave: the check records the GPEXE team it locked, and a change after it is refused", async () => {
  const t = await team();
  let duringFetch;
  fakeGpexe({
    onList: async () => {
      // While GPEXE is being read, no database transaction and no team lock
      // may be held: a change asked for now gets the data answer (fast),
      // never a lock timeout.
      duringFetch = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next(), reason: "mid-check" } });
    },
  });
  const started = await api(`/teams/${t.teamId}/checks`, { method: "POST", cookie: t.coach.cookie, body: {} });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 200 && (await api(`/teams/${t.teamId}/checks/${started.body.check.id}`, { cookie: t.coach.cookie })).body.check.status === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(duringFetch, "the change was attempted while GPEXE was being read");
  assert.equal(duringFetch.status, 409, JSON.stringify(duringFetch.body));
  assert.equal(duringFetch.body.error, "gpexe_team_change_blocked", "the check row already depends on the connection; the lock was not held during the network read");

  const row = (await admin.query(`select gpexe_team_id from training_load.gpexe_import_checks where owner_team_id = $1`, [t.teamId])).rows[0];
  assert.equal(row.gpexe_team_id, t.gpexeTeamId, "the check records the GPEXE team it read, taken under the lock");
  assert.equal((await settingsRow(t.teamId)).gpexe_team_id, t.gpexeTeamId);
  assert.equal((await history(t.teamId)).length, 1, "no audit row for the refused change");
  service.setGpexeClientFactory(null);
});

test("7c. a change that wins the lock first is the one the next check reads", async () => {
  const t = await team();
  const second = t.next();
  assert.equal((await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: second, reason: "moved to the other GPEXE team" } })).status, 200);
  fakeGpexe();
  const started = await api(`/teams/${t.teamId}/checks`, { method: "POST", cookie: t.coach.cookie, body: {} });
  assert.equal(started.status, 202);
  for (let i = 0; i < 200 && (await api(`/teams/${t.teamId}/checks/${started.body.check.id}`, { cookie: t.coach.cookie })).body.check.status === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const rows = (await admin.query(`select gpexe_team_id from training_load.gpexe_import_checks where owner_team_id = $1`, [t.teamId])).rows;
  assert.deepEqual(rows.map((r) => r.gpexe_team_id), [second], "the check read the new connection, and there is no check row from the old one");
  service.setGpexeClientFactory(null);
});

test("7d. a check does not start while the team lock is held, and writes no check row", async () => {
  const t = await team();
  const lock = new pg.Client({ connectionString: db.url });
  await lock.connect();
  fakeGpexe();
  try {
    await lock.query("begin");
    await lock.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${t.teamId}`]);
    const r = await api(`/teams/${t.teamId}/checks`, { method: "POST", cookie: t.coach.cookie, body: {} });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "gpexe_change_busy", "the check waits for the same lock a settings change takes");
    assert.match(r.body.message, /import/i, "the lock is usually held by an import, so the message says so");
    assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [t.teamId])).rows[0].n, 0, "no half-written check row");
  } finally {
    await lock.query("rollback").catch(() => {});
    await lock.end();
    service.setGpexeClientFactory(null);
  }
});

test("7e. an athlete link is written under the same lock, so it can never slip past the guard", async () => {
  const t = await team();
  const lock = new pg.Client({ connectionString: db.url });
  await lock.connect();
  try {
    await lock.query("begin");
    await lock.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${t.teamId}`]);
    const linked = await api(`/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.coach.cookie, body: { gpexeAthleteId: "104", athleteId: t.athleteIds[0] } });
    assert.equal(linked.status, 409, JSON.stringify(linked.body));
    assert.equal(linked.body.error, "gpexe_change_busy");
    assert.match(linked.body.message, /check/i, "a running check's preview holds the same lock, so the message names it too");
    assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_athlete_links where owner_team_id = $1`, [t.teamId])).rows[0].n, 0, "nothing was written");
  } finally {
    await lock.query("rollback").catch(() => {});
    await lock.end();
  }
  // With the lock free, the same link is made and then blocks a change.
  const ok = await api(`/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.coach.cookie, body: { gpexeAthleteId: "104", athleteId: t.athleteIds[0] } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const link = (await admin.query(`select id from training_load.gpexe_athlete_links where owner_team_id = $1`, [t.teamId])).rows[0];
  const change = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next(), reason: "after a link" } });
  assert.equal(change.body.error, "gpexe_team_change_blocked", JSON.stringify(change.body));
  // Unlinking takes the same lock (and still blocks a change afterwards).
  assert.equal((await api(`/teams/${t.teamId}/athlete-links/${link.id}/unlink`, { method: "POST", cookie: t.coach.cookie })).status, 200);
});

test("10. the change reason is an admin's note: a coach reads the GPEXE team but not the reason", async () => {
  const t = await team();
  assert.equal((await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next(), reason: "internal note about another club" } })).status, 200);
  const asCoach = await api(`/teams/${t.teamId}/status`, { cookie: t.coach.cookie });
  assert.equal(asCoach.status, 200);
  assert.equal(asCoach.body.settings.changeReason, undefined, "the note is not sent to a coach");
  assert.ok(asCoach.body.settings.gpexeTeamId, "the GPEXE team itself is still shown");
  const asAdmin = await api(`/teams/${t.teamId}/status`, { cookie: t.padmin.cookie });
  assert.equal(asAdmin.body.settings.changeReason, "internal note about another club");
});

test("11. the database refuses a re-point on its own, whoever writes it", async () => {
  const t = await team();
  await admin.query(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id)
     values ($1,$2,'succeeded',current_date - 7, current_date, now(), $3)`,
    [t.teamId, t.coach.id, t.gpexeTeamId],
  );
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_team_settings set gpexe_team_id = '777777', change_reason = 'raw sql' where owner_team_id = $1`, [t.teamId]),
    /can no longer be changed/,
    "a raw UPDATE past the service is refused too",
  );
  // And a change without a reason, on a team nothing depends on yet.
  const clean = await team();
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_team_settings set gpexe_team_id = '777778' where owner_team_id = $1`, [clean.teamId]),
    /needs a reason/,
  );
  assert.equal((await settingsRow(t.teamId)).gpexe_team_id, t.gpexeTeamId);
  assert.equal((await history(t.teamId)).length, 1, "a refused raw update appends no history row");
});

test("12. an approval can never exist without its candidate, which is why its blocker can't answer alone", async () => {
  const t = await team();
  const check = (await admin.query(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id)
     values ($1,$2,'succeeded',current_date - 7, current_date, now(), $3) returning id`,
    [t.teamId, t.coach.id, t.gpexeTeamId],
  )).rows[0];
  const candidate = (await admin.query(
    `insert into training_load.gpexe_import_candidates
       (owner_team_id, gpexe_team_session_id, bundle_hash, raw_bundle, raw_expires_at, first_seen_check_id, last_seen_check_id, preview, preview_hash, preview_computed_at, status)
     values ($1,'9002',$2,'{}'::jsonb, now() + interval '30 days', $3, $3, '{}'::jsonb, $4, now(), 'pending') returning id`,
    [t.teamId, "c".repeat(64), check.id, "d".repeat(64)],
  )).rows[0];
  const fk = (await admin.query(
    `select confdeltype from pg_constraint
      where conrelid = 'training_load.gpexe_import_approvals'::regclass and confrelid = 'training_load.gpexe_import_candidates'::regclass`,
  )).rows[0];
  assert.equal(fk.confdeltype, "r", "an approval's candidate is on delete restrict: an approval never outlives it");
  // The limit of that invariant, stated rather than assumed: a candidate that
  // was never approved CAN be removed, and an imported one cannot (the v22
  // guard, covered by gpexe-in-app-import.test.mjs). So the approvals blocker
  // only matters the day a candidate may be purged - it is kept for that.
  await admin.query(`delete from training_load.gpexe_import_candidates where id = $1`, [candidate.id]);
  assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_import_candidates where id = $1`, [candidate.id])).rows[0].n, 0);
});

test("13. the row itself cannot be deleted and re-inserted past the guard", async () => {
  const t = await team();
  await admin.query(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id)
     values ($1,$2,'succeeded',current_date - 7, current_date, now(), $3)`,
    [t.teamId, t.coach.id, t.gpexeTeamId],
  );
  await assert.rejects(
    () => admin.query(`delete from training_load.gpexe_team_settings where owner_team_id = $1`, [t.teamId]),
    /never deleted/,
    "deleting the row would let a fresh insert re-point the team",
  );
  assert.equal((await settingsRow(t.teamId)).gpexe_team_id, t.gpexeTeamId);
  assert.equal((await history(t.teamId)).length, 1);
});

test("14. the database's refusal is a real concurrency backstop: a raw update that races a holder of the team lock is refused", async () => {
  const t = await team();
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${t.teamId}`]);
    // Nothing depends on this team yet, so only the lock can refuse it.
    await assert.rejects(
      () => admin.query(`update training_load.gpexe_team_settings set gpexe_team_id = '654321', change_reason = 'raw sql while busy' where owner_team_id = $1`, [t.teamId]),
      /try again when it has finished/,
      "the trigger takes the same lock instead of reading rows another transaction may still be writing",
    );
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  assert.equal((await settingsRow(t.teamId)).gpexe_team_id, t.gpexeTeamId);
  assert.equal((await history(t.teamId)).length, 1);
  // The application's own change takes that lock first and is not refused by it.
  const ok = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next(), reason: "the lock is free again" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("15. the GPEXE team recorded on a check row is final, and the check itself reads no other", async () => {
  const t = await team();
  fakeGpexe();
  const started = await api(`/teams/${t.teamId}/checks`, { method: "POST", cookie: t.coach.cookie, body: {} });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  for (let i = 0; i < 200 && (await api(`/teams/${t.teamId}/checks/${started.body.check.id}`, { cookie: t.coach.cookie })).body.check.status === "running"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const row = (await admin.query(`select id, gpexe_team_id from training_load.gpexe_import_checks where owner_team_id = $1`, [t.teamId])).rows[0];
  assert.equal(row.gpexe_team_id, t.gpexeTeamId);
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_import_checks set gpexe_team_id = '999999' where id = $1`, [row.id]),
    /is final/,
  );
  service.setGpexeClientFactory(null);
});

test("16. an unexpected database error leaves the settings, the history and the connection as they were", async () => {
  const t = await team();
  // A guard the service does not know about: its error is not one of the
  // mapped codes, so it takes the unexpected-error path.
  await admin.query(`create function pg_temp_boom() returns trigger as $$ begin raise exception 'boom' using errcode = '22000'; end; $$ language plpgsql`);
  await admin.query(`create trigger gpexe_settings_boom before update on training_load.gpexe_team_settings for each row execute function pg_temp_boom()`);
  try {
    const r = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next(), reason: "while a guard misbehaves" } });
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.error, "internal_error");
    assert.ok(!/boom|22000/.test(JSON.stringify(r.body)), "the database's own text never reaches the caller");
  } finally {
    await admin.query(`drop trigger gpexe_settings_boom on training_load.gpexe_team_settings`);
    await admin.query(`drop function pg_temp_boom()`);
  }
  assert.equal((await settingsRow(t.teamId)).gpexe_team_id, t.gpexeTeamId, "nothing was written");
  assert.equal((await history(t.teamId)).length, 1);
  // The pooled connection was returned: the next change still works.
  const ok = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next(), reason: "after the failure" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("17. a database rule that refuses an unlink is answered with a stable code, not with the database's text", async () => {
  const t = await team();
  assert.equal((await api(`/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.coach.cookie, body: { gpexeAthleteId: "104", athleteId: t.athleteIds[0] } })).status, 201);
  const link = (await admin.query(`select id from training_load.gpexe_athlete_links where owner_team_id = $1`, [t.teamId])).rows[0];
  await admin.query(`create function pg_temp_link_boom() returns trigger as $$ begin raise exception 'gpexe_athlete_links: link % is already unlinked', old.id; end; $$ language plpgsql`);
  // The same holds for a code nobody mapped: a stable answer, no database text.
  await admin.query(`create function pg_temp_link_odd() returns trigger as $$ begin raise exception 'gpexe_athlete_links: odd failure on %', old.id using errcode = '22000'; end; $$ language plpgsql`);
  await admin.query(`create trigger gpexe_links_boom before update on training_load.gpexe_athlete_links for each row execute function pg_temp_link_boom()`);
  try {
    const r = await api(`/teams/${t.teamId}/athlete-links/${link.id}/unlink`, { method: "POST", cookie: t.coach.cookie });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.ok(!/already unlinked|gpexe_athlete_links:/.test(JSON.stringify(r.body)), "the database's own message stays on the server");
    await admin.query(`drop trigger gpexe_links_boom on training_load.gpexe_athlete_links`);
    await admin.query(`create trigger gpexe_links_odd before update on training_load.gpexe_athlete_links for each row execute function pg_temp_link_odd()`);
    const odd = await api(`/teams/${t.teamId}/athlete-links/${link.id}/unlink`, { method: "POST", cookie: t.coach.cookie });
    assert.equal(odd.status, 500, JSON.stringify(odd.body));
    assert.equal(odd.body.error, "internal_error");
    assert.ok(!/odd failure|22000/.test(JSON.stringify(odd.body)), "an unmapped database code leaks no text either");
    await admin.query(`drop trigger gpexe_links_odd on training_load.gpexe_athlete_links`);
  } finally {
    await admin.query(`drop trigger if exists gpexe_links_boom on training_load.gpexe_athlete_links`);
    await admin.query(`drop trigger if exists gpexe_links_odd on training_load.gpexe_athlete_links`);
    await admin.query(`drop function if exists pg_temp_link_boom()`);
    await admin.query(`drop function if exists pg_temp_link_odd()`);
  }
  assert.equal((await admin.query(`select unlinked_at from training_load.gpexe_athlete_links where id = $1`, [link.id])).rows[0].unlinked_at, null, "nothing was written");
  assert.equal((await api(`/teams/${t.teamId}/athlete-links/${link.id}/unlink`, { method: "POST", cookie: t.coach.cookie })).status, 200, "and the real unlink still works");
});

test("25. an old empty check row is never filled and never moved, whatever the value", async () => {
  const t = await team();
  const other = await team();
  const legacy = await legacyCheck(t);
  const unchanged = async (what) => {
    const row = (await admin.query(`select owner_team_id, gpexe_team_id from training_load.gpexe_import_checks where id = $1`, [legacy.id])).rows[0];
    assert.equal(row.owner_team_id, t.teamId, what);
    assert.equal(row.gpexe_team_id, null, what);
  };

  // (1) a GPEXE team the row's own team is not connected to
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_import_checks set gpexe_team_id = '888888' where id = $1`, [legacy.id]),
    /is final \(an empty one from before v24 stays empty\)/,
  );
  await unchanged("a foreign GPEXE team");

  // (2) its own team's GPEXE team: refused as well - the row is not
  // reconstructed after the fact
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_import_checks set gpexe_team_id = $2 where id = $1`, [legacy.id, t.gpexeTeamId]),
    /is final \(an empty one from before v24 stays empty\)/,
  );
  await unchanged("its own team's GPEXE team");

  // (3) moving the row to another team, keeping its own GPEXE team
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_import_checks set owner_team_id = $2 where id = $1`, [legacy.id, other.teamId]),
    /OptiMove team of check .* is final/,
  );
  await unchanged("moving the row");
  assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [other.teamId])).rows[0].n, 0, "and nothing appeared on the other team");

});

test("26. a finished check of a connected team cannot be moved to another team either", async () => {
  const t = await team();
  const other = await team();
  const check = await leftoverCheck(t);
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_import_checks set owner_team_id = $2 where id = $1`, [check.id, other.teamId]),
    /OptiMove team of check .* is final/,
    "a check carries its own team's origin; moving it would take a blocker off that team",
  );
  const row = (await admin.query(`select owner_team_id, gpexe_team_id from training_load.gpexe_import_checks where id = $1`, [check.id])).rows[0];
  assert.equal(row.owner_team_id, t.teamId);
  assert.equal(row.gpexe_team_id, t.gpexeTeamId);
  // The team it was aimed at still has nothing, and still cannot be connected
  // over leftovers of its own.
  assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [other.teamId])).rows[0].n, 0);
});

test("8. a reason can never be added or rewritten without a real change of the connection", async () => {
  const t = await team();
  const before = await settingsRow(t.teamId);
  assert.equal(before.change_reason, null);
  assert.equal((await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.gpexeTeamId, reason: "a reason for the value that is already there" } })).status, 200);
  const after = await settingsRow(t.teamId);
  assert.equal(after.change_reason, null, "the stored reason is untouched");
  assert.deepEqual(await history(t.teamId), [{ gpexe_team_id: t.gpexeTeamId, change_reason: null }]);
});

test("9. the history stays append-only and keeps rows from before v24 (reason null)", async () => {
  const t = await team();
  const second = t.next();
  assert.equal((await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: second, reason: "corrected" } })).status, 200);
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_team_settings_history set change_reason = 'rewritten' where owner_team_id = $1`, [t.teamId]),
    /append-only/,
  );
  await assert.rejects(
    () => admin.query(`delete from training_load.gpexe_team_settings_history where owner_team_id = $1`, [t.teamId]),
    /append-only/,
  );
  const rows = await history(t.teamId);
  assert.deepEqual(rows.map((r) => r.change_reason), [null, "corrected"], "a pre-v24 style row keeps a null reason");
});

// ---------------------------------------------------------------------------
// External review, 2026-09-20: three ways past the guard (an UPDATE that moves
// or rewrites the row, a DELETE/TRUNCATE, and a link made before the team has
// a GPEXE team at all) and two narrower gaps (whitespace reasons, a check row
// written with no or a foreign GPEXE team).
// ---------------------------------------------------------------------------

test("18. the settings row cannot be moved to another team, and its reason, author and time never change on their own", async () => {
  const t = await team();
  const other = await team();
  const before = await settingsRow(t.teamId);

  await assert.rejects(
    () => admin.query(`update training_load.gpexe_team_settings set owner_team_id = $2 where owner_team_id = $1`, [t.teamId, other.teamId]),
    /OptiMove team of a GPEXE connection is final/,
  );
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_team_settings set change_reason = 'rewritten later' where owner_team_id = $1`, [t.teamId]),
    /can only change together with the GPEXE team/,
  );
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_team_settings set configured_by_user_id = $2 where owner_team_id = $1`, [t.teamId, other.padmin.id]),
    /can only change together with the GPEXE team/,
  );
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_team_settings set configured_at = now() - interval '1 day' where owner_team_id = $1`, [t.teamId]),
    /can only change together with the GPEXE team/,
  );

  // A true no-op is accepted and writes nothing at all - no history row.
  await admin.query(`update training_load.gpexe_team_settings set gpexe_team_id = gpexe_team_id where owner_team_id = $1`, [t.teamId]);
  const after = await settingsRow(t.teamId);
  assert.equal(after.gpexe_team_id, before.gpexe_team_id);
  assert.equal(after.change_reason, before.change_reason);
  assert.equal(after.configured_at.getTime(), before.configured_at.getTime());
  assert.equal((await history(t.teamId)).length, 1, "a no-op appends no history row");
});

test("19. a GPEXE connection is never deleted or truncated, whoever asks", async () => {
  const t = await team();
  // Nothing depends on this team's connection at all.
  await assert.rejects(
    () => admin.query(`delete from training_load.gpexe_team_settings where owner_team_id = $1`, [t.teamId]),
    /never deleted/,
    "even a clean row stays: a delete and a fresh insert would re-point the team",
  );
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${t.teamId}`]);
    await assert.rejects(
      () => admin.query(`delete from training_load.gpexe_team_settings where owner_team_id = $1`, [t.teamId]),
      /never deleted/,
    );
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  await assert.rejects(() => admin.query(`truncate training_load.gpexe_team_settings cascade`), /TRUNCATE refused/);
  assert.equal((await settingsRow(t.teamId)).gpexe_team_id, t.gpexeTeamId, "nothing was lost");
  assert.equal((await history(t.teamId)).length, 1, "and nothing was added");
});

test("20. a GPEXE athlete cannot be linked before the team has a GPEXE team, through the API or through raw SQL", async () => {
  const t = await team({ connect: false });
  const refused = await api(`/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.coach.cookie, body: { gpexeAthleteId: "104", athleteId: t.athleteIds[0] } });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "gpexe_team_not_configured");
  await assert.rejects(
    () => admin.query(
      `insert into training_load.gpexe_athlete_links (owner_team_id, gpexe_athlete_id, athlete_id, linked_by_user_id) values ($1,'104',$2,$3)`,
      [t.teamId, t.athleteIds[0], t.coach.id],
    ),
    /has no GPEXE team yet/,
    "raw SQL is refused by the database too",
  );
  assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_athlete_links where owner_team_id = $1`, [t.teamId])).rows[0].n, 0);

  // Connecting the team afterwards still works, and then the link does too.
  const connect = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next() } });
  assert.equal(connect.status, 200, JSON.stringify(connect.body));
  assert.equal((await api(`/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.coach.cookie, body: { gpexeAthleteId: "104", athleteId: t.athleteIds[0] } })).status, 201);
});

test("21. a first connection is refused while the team already carries GPEXE data nobody recorded", async () => {
  // Each kind of leftover, made with the connection in place and then removed
  // the only way the database allows: by removing the connection's guard for
  // that one statement, which is what a bad restore or a manual fix looks like.
  // One kind of leftover per case, and the answer must name that kind - so
  // removing one blocker cannot be covered by another one answering.
  const kinds = {
    "a check": { phrase: /already has a check from a GPEXE team that is not recorded/, prepare: async (t) => { await leftoverCheck(t); } },
    "a candidate": {
      phrase: /already has a session found by a check from a GPEXE team that is not recorded/,
      prepare: async (t) => {
        const check = await leftoverCheck(t);
        await admin.query(
          `insert into training_load.gpexe_import_candidates
             (owner_team_id, gpexe_team_session_id, bundle_hash, raw_bundle, raw_expires_at, first_seen_check_id, last_seen_check_id, preview, preview_hash, preview_computed_at, status)
           values ($1,'9100',$2,'{}'::jsonb, now() + interval '30 days', $3, $3, '{}'::jsonb, $4, now(), 'pending')`,
          [t.teamId, "e".repeat(64), check.id, "f".repeat(64)],
        );
        // The candidate is checked before the check row, so this case proves
        // the candidate entry itself.
      },
    },
    "an athlete link": {
      phrase: /already has a GPEXE athlete linked to an OptiMove athlete from a GPEXE team that is not recorded/,
      prepare: async (t) => {
        assert.equal((await api(`/teams/${t.teamId}/athlete-links`, { method: "POST", cookie: t.coach.cookie, body: { gpexeAthleteId: "104", athleteId: t.athleteIds[0] } })).status, 201);
      },
    },
    "a source connection": {
      phrase: /already has imported GPEXE data from a GPEXE team that is not recorded/,
      prepare: async (t) => {
        await admin.query(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1)`, [t.teamId]);
      },
    },
  };
  for (const [what, { phrase, prepare }] of Object.entries(kinds)) {
    const t = await team();
    await prepare(t);
    // Remove the connection the only way possible: with its own guard off.
    await admin.query(`alter table training_load.gpexe_team_settings disable trigger gpexe_team_settings_refuse_delete`);
    try {
      await admin.query(`delete from training_load.gpexe_team_settings where owner_team_id = $1`, [t.teamId]);
    } finally {
      await admin.query(`alter table training_load.gpexe_team_settings enable trigger gpexe_team_settings_refuse_delete`);
    }

    const again = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next() } });
    assert.equal(again.status, 409, `${what}: ${JSON.stringify(again.body)}`);
    assert.equal(again.body.error, "gpexe_orphan_data", what);
    assert.match(again.body.message, phrase, `${what}: the blocker for this kind is the one that answered`);
    await assert.rejects(
      () => admin.query(
        `insert into training_load.gpexe_team_settings (owner_team_id, gpexe_team_id, configured_by_user_id) values ($1,'987654',$2)`,
        [t.teamId, t.padmin.id],
      ),
      phrase,
      `${what}: raw SQL is refused by the same kind`,
    );
    assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_team_settings where owner_team_id = $1`, [t.teamId])).rows[0].n, 0, what);
  }

  // A team with nothing at all still connects normally.
  const clean = await team({ connect: false });
  assert.equal((await api(`/teams/${clean.teamId}/settings`, { method: "PUT", cookie: clean.padmin.cookie, body: { gpexeTeamId: clean.next() } })).status, 200);
});

test("22. raw writes that race a connection change are refused, and write nothing", async () => {
  const t = await team();
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select pg_advisory_xact_lock(hashtextextended($1, 21))`, [`gpexe-import-team:${t.teamId}`]);
    await assert.rejects(
      () => admin.query(
        `insert into training_load.gpexe_athlete_links (owner_team_id, gpexe_athlete_id, athlete_id, linked_by_user_id) values ($1,'104',$2,$3)`,
        [t.teamId, t.athleteIds[0], t.coach.id],
      ),
      /try again when it has finished/,
      "a raw link cannot slip inside a connection change's own decision",
    );
    await assert.rejects(
      () => admin.query(
        `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id)
         values ($1,$2,'succeeded',current_date - 7, current_date, now(), $3)`,
        [t.teamId, t.coach.id, t.gpexeTeamId],
      ),
      /try again when it has finished/,
      "and neither can a raw check row",
    );
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
  assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_athlete_links where owner_team_id = $1`, [t.teamId])).rows[0].n, 0);
  assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [t.teamId])).rows[0].n, 0);
});

test("23. a reason made only of whitespace is refused by the database as well", async () => {
  const t = await team();
  for (const reason of ["\t", "\n", " \t\n ", "\r\n"]) {
    await assert.rejects(
      () => admin.query(`update training_load.gpexe_team_settings set gpexe_team_id = '424242', change_reason = $2 where owner_team_id = $1`, [t.teamId, reason]),
      /gpexe_team_settings_change_reason_check|violates check constraint/,
      JSON.stringify(reason),
    );
  }
  assert.equal((await settingsRow(t.teamId)).gpexe_team_id, t.gpexeTeamId);
  assert.equal((await history(t.teamId)).length, 1);
});

test("24. a new check row carries the team's own GPEXE team, and an empty one from before v24 stays empty", async () => {
  const t = await team();
  await assert.rejects(
    () => admin.query(
      `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at)
       values ($1,$2,'succeeded',current_date - 7, current_date, now())`,
      [t.teamId, t.coach.id],
    ),
    /records the GPEXE team it reads/,
    "a new check with no GPEXE team is refused",
  );
  await assert.rejects(
    () => admin.query(
      `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id)
       values ($1,$2,'succeeded',current_date - 7, current_date, now(), '888888')`,
      [t.teamId, t.coach.id],
    ),
    /while the team is connected to/,
    "a new check naming another GPEXE team is refused",
  );
  const ok = (await admin.query(
    `insert into training_load.gpexe_import_checks (owner_team_id, requested_by_user_id, status, window_from, window_to, finished_at, gpexe_team_id)
     values ($1,$2,'succeeded',current_date - 7, current_date, now(), $3) returning id`,
    [t.teamId, t.coach.id, t.gpexeTeamId],
  )).rows[0];
  assert.ok(ok.id);

  // A row from before v24 has no GPEXE team, and it keeps none.
  const legacy = await legacyCheck(t);
  await assert.rejects(
    () => admin.query(`update training_load.gpexe_import_checks set gpexe_team_id = $2 where id = $1`, [legacy.id, t.gpexeTeamId]),
    /is final \(an empty one from before v24 stays empty\)/,
  );
  assert.equal((await admin.query(`select gpexe_team_id from training_load.gpexe_import_checks where id = $1`, [legacy.id])).rows[0].gpexe_team_id, null);
});
test("27. a check is never deleted either, so its team cannot lose the record that blocks a change", async () => {
  const t = await team();
  const check = await leftoverCheck(t);
  await assert.rejects(
    () => admin.query(`delete from training_load.gpexe_import_checks where id = $1`, [check.id]),
    /never deleted/,
  );
  await assert.rejects(() => admin.query(`truncate training_load.gpexe_import_checks cascade`), /TRUNCATE refused/);
  assert.equal((await admin.query(`select count(*)::int as n from training_load.gpexe_import_checks where owner_team_id = $1`, [t.teamId])).rows[0].n, 1);
  const change = await api(`/teams/${t.teamId}/settings`, { method: "PUT", cookie: t.padmin.cookie, body: { gpexeTeamId: t.next(), reason: "after trying to remove the check" } });
  assert.equal(change.body.error, "gpexe_team_change_blocked", JSON.stringify(change.body));
});

test("28. the guards this suite turns off for one statement are always on again afterwards", async () => {
  const names = ["gpexe_import_checks_require_team", "gpexe_team_settings_refuse_delete", "gpexe_import_checks_freeze_team", "gpexe_team_settings_refuse_repoint"];
  const rows = (await admin.query(`select tgname, tgenabled from pg_trigger where tgname = any($1)`, [names])).rows;
  assert.equal(rows.length, names.length, JSON.stringify(rows));
  for (const row of rows) assert.equal(row.tgenabled, "O", `${row.tgname} is enabled`);
});
