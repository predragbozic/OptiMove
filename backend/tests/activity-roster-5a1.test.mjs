// Phase 5a1: session roster foundation (migration v25, the read-only roster
// route, source observations from the GPEXE approval, the undo rule).
// Contract: docs/ai/phase5a-discovery-and-contract.md.
//
// Everything runs on ONE disposable database (optimove_tests_gpexe_roster_*)
// that is created at v24, given pre-v25 membership rows, brought to v25 by
// the real runner, and dropped at the end. Nothing touches OPTIMOVE or any
// persistent database. GPEXE is a fake client; the import switch is turned
// on inside this process only, for the approval tests.
//
// Test names carry the owner's numbering (1-35) from the 5a1 order.
//
// Every module that reaches src/db.js (the app's pool) is imported only
// AFTER DATABASE_URL points at the disposable database, and before() checks
// the pool's own database: a static import would bind the pool to the
// developer's DATABASE_URL.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import {
  applyGpexeTestMigrations, createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS,
} from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes, TZ } from "./_gpexe-fixtures.mjs";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { importGpexePlan } from "../src/gpexeImportWriter.js";
import {
  assertTriggersEnabled, collectScope, undoImportedSession, ROSTER_DECISIONS_EXIST,
} from "../scripts/gpexe-undo-imported-session.mjs";
import { recordImportObservations } from "../src/activitySourceObservations.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_SWITCH = process.env.GPEXE_IMPORT_APPLY_ENABLED;
const V25 = "202609251000_training_load_v25_activity_roster_foundation.sql";

let db;
let admin;
let server;
let apiBase;
let service;
let createSession;
let appPool;
let deriveAthleteState;
let ROSTER_STATE_LABELS;
const pre = {};

const NEW_TABLES = [
  "public.athlete_membership_periods",
  "training.participation_reasons",
  "training.activity_roster_requests",
  "training.activity_athlete_decisions",
  "training.activity_completions",
  "training.activity_completion_log",
  "training.activity_source_observations",
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const uid = () => crypto.randomBytes(4).toString("hex");

async function q(sql, params = []) {
  return (await admin.query(sql, params)).rows;
}

async function makeTeam(label = "Team") {
  const clubId = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} club ${uid()}`]))[0].id;
  const teamId = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} ${uid()}`]))[0].id;
  return { clubId, teamId };
}

async function makeAthlete(name) {
  return (await q(`insert into public.athletes (full_name, display_name, device_timezone) values ($1,$1,$2) returning id`, [name, TZ]))[0].id;
}

async function addMembership({ athleteId, clubId, teamId = null, type = "team", status = "active", startsAt = "2026-01-01T00:00:00Z", archivedAt = null, updatedAt = null }) {
  return (await q(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at, archived_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7, coalesce($8::timestamptz, now())) returning id`,
    [athleteId, clubId, teamId, type, status, startsAt, archivedAt, updatedAt],
  ))[0].id;
}

// The same statements Settings runs (organization.js archive / restore).
async function archiveMembership(id, at = null, client = admin) {
  await client.query(
    `update public.athlete_memberships set status = 'archived', archived_at = coalesce($2::timestamptz, now()), updated_at = now() where id = $1`,
    [id, at],
  );
}
async function restoreMembership(id, client = admin) {
  await client.query(
    `update public.athlete_memberships
        set status = 'active', archived_at = null, archived_by_user_id = null, archive_reason = null, updated_at = now()
      where id = $1`,
    [id],
  );
}

async function periodsOf(membershipId) {
  return q(
    `select valid_from, valid_to from public.athlete_membership_periods where membership_id = $1 order by valid_from, valid_to nulls last`,
    [membershipId],
  );
}

async function makeUser(label) {
  return (await q(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${uid()}@test.local`, label]))[0].id;
}

async function setWorkspace(userId, type, scopeId) {
  await q(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [userId, type, scopeId],
  );
}

async function withCookie(id) {
  return { id, cookie: `optimove_session=${await createSession(id)}` };
}

async function coachOf(teamId, label = "coach") {
  const id = await makeUser(label);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return withCookie(id);
}

async function clubAdminOf(clubId, label = "club admin") {
  const id = await makeUser(label);
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return withCookie(id);
}

async function platformAdmin(label = "platform admin") {
  const id = await makeUser(label);
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return withCookie(id);
}

// A team-owned activity. startedAt null = a session with only a local date.
async function makeActivity({ teamId, startedAt = "2026-09-14T16:00:00Z", localDate = null, tz = TZ, name = "Training", ownerScope = "team", clubId = null, userId = null }) {
  const date = localDate ?? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(startedAt));
  return (await q(
    `insert into training.activities (name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_team_id, owner_club_id, owner_user_id, origin)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'manual') returning id`,
    [name, date, startedAt, tz, ownerScope, ownerScope === "team" ? teamId : null, ownerScope === "club" ? clubId : null, ownerScope === "user" ? userId : null],
  ))[0].id;
}

// A decision the way 5a2 will write one: decisions first, then the one
// request row that carries the answer, in one transaction (the request id
// is checked at commit).
async function insertDecision({ activityId, athleteId, teamId, userId, basis = "team_coach", kind = "did_not_participate", reasonKey = kind === "did_not_participate" ? "illness" : null, supersedes = null }) {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    await client.query("begin");
    const requestId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    if (supersedes) {
      await client.query(
        `update training.activity_athlete_decisions set superseded_by_decision_id = $2, superseded_at = now() where id = $1`,
        [supersedes, decisionId],
      );
    }
    await client.query(
      `insert into training.activity_athlete_decisions
         (id, activity_id, athlete_id, owner_team_id, request_id, decision_kind, reason_key, decided_by_user_id, decided_by_basis)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [decisionId, activityId, athleteId, teamId, requestId, kind, reasonKey, userId, basis],
    );
    await client.query(
      `insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result)
       values ($1,$2,$3,$4,'decide',$5,'{"ok":true}')`,
      [requestId, activityId, crypto.randomUUID(), "a".repeat(64), userId],
    );
    await client.query("commit");
    return decisionId;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}

const roster = (activityId, cookie) => api(`/api/training-activity/${activityId}/roster`, { cookie });
const byName = (body, name) => body.athletes.find((a) => a.name === name);

// A team with GPEXE athletes 101-103 as OptiMove athletes, members since
// 2026-01-01 (before the 2026-09-14 sessions), plus a coach and a platform
// admin; 104 (a GPEXE athlete) is never linked.
async function gpexeTeam(label = "GPEXE") {
  const { clubId, teamId } = await makeTeam(label);
  const names = { 101: `A101 ${label}`, 102: `B102 ${label}`, 103: `C103 ${label}` };
  const ids = {};
  for (const [g, name] of Object.entries(names)) {
    ids[g] = await makeAthlete(name);
    await addMembership({ athleteId: ids[g], clubId, type: "club" });
    await addMembership({ athleteId: ids[g], clubId, teamId });
  }
  const userId = await makeUser(`${label} importer`);
  return { clubId, teamId, ids, names, userId };
}

async function importDirect(team, bundle) {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    return await importGpexePlan(client, buildGpexeImportPlan(bundle), {
      ownerTeamId: team.teamId, performedByUserId: team.userId, athleteIdByGpexeId: team.ids, batchFilename: "roster test",
    });
  } finally {
    await client.end();
  }
}

// GPEXE bundle of standard athletes 101-103 (103 recorded on two tracks =
// needs manual review), optionally 104 (not linked, also two tracks).
function bundleFor(sessionId, { with104 = false, oneTrack103 = false, gpexeTeamId = 77, updatedOn = "2026-09-14T20:18:09.337" } = {}) {
  const athletes = standardAthletes().map((a) => {
    const copy = structuredClone(a);
    copy.tracks = copy.tracks.map((t, i) => sessionId * 10 + (copy.id - 100) * 2 + i);
    copy.parts = copy.parts.map((p) => {
      const part = { ...p };
      if (part.track !== undefined) part.track = copy.tracks[a.tracks.indexOf(p.track)];
      return part;
    });
    return copy;
  });
  if (oneTrack103) {
    const a103 = athletes.find((a) => a.id === 103);
    a103.tracks = [a103.tracks[0]];
    a103.parts = [{ drill: null, time: 1500, distance: 1700, maxV: 5, power: [1500, 100, 80, 20, 0], acc: 5, dec: 5 }];
  }
  if (with104) {
    const a104 = structuredClone(athletes.find((a) => a.id === 103));
    a104.id = 104;
    a104.tracks = [sessionId * 10 + 8, sessionId * 10 + 9];
    a104.parts = a104.parts.map((p, i) => ({ ...p, track: p.track === undefined ? undefined : a104.tracks[i] }));
    athletes.push(a104);
  }
  return makeBundle({ sessionId, gpexeTeamId, start: "2026-09-14T18:08:12", updatedOn, athletes });
}

async function newClient() {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  return client;
}

// Row count and a digest of every row's content per table: an UPDATE that
// keeps the count (superseding a decision, resolving an observation, closing
// a period) changes the digest.
async function rowCounts(tables = NEW_TABLES) {
  const counts = {};
  for (const t of tables) {
    const r = (await q(`select count(*)::int as n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as d from ${t} x`))[0];
    counts[t] = `${r.n}:${r.d}`;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Setup: v24, pre-v25 memberships, v25 through the runner, then the server.
// ---------------------------------------------------------------------------
before(async () => {
  db = await createGpexeDisposableDb({
    baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "roster", migrations: GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V25)),
  });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  assert.equal((await q(`select to_regclass('public.athlete_membership_periods') as t`))[0].t, null, "the database starts before v25");

  // Rows as they were before v25 (Settings wrote them; no history kept).
  const team = await makeTeam("Pre");
  pre.team = team;
  pre.active = await addMembership({ athleteId: await makeAthlete("Pre active"), clubId: team.clubId, teamId: team.teamId, startsAt: "2026-01-01T00:00:00Z" });
  pre.paused = await addMembership({ athleteId: await makeAthlete("Pre paused"), clubId: team.clubId, teamId: team.teamId, status: "paused", startsAt: "2026-02-01T00:00:00Z" });
  pre.archived = await addMembership({ athleteId: await makeAthlete("Pre archived"), clubId: team.clubId, teamId: team.teamId, status: "archived", startsAt: "2026-01-01T00:00:00Z", archivedAt: "2026-03-01T00:00:00Z" });
  pre.archivedNoTime = await addMembership({ athleteId: await makeAthlete("Pre archived no time"), clubId: team.clubId, teamId: team.teamId, status: "archived", startsAt: "2026-01-01T00:00:00Z", updatedAt: "2026-04-01T00:00:00Z" });
  pre.clubOnly = await addMembership({ athleteId: await makeAthlete("Pre club"), clubId: team.clubId, type: "club", startsAt: "2026-01-01T00:00:00Z" });
  // Archived on 1 Feb and restored on 1 Mar, both before v25: the restore
  // revives the same row, so the gap is lost.
  pre.restoredAthlete = await makeAthlete("Pre restored");
  pre.restored = await addMembership({ athleteId: pre.restoredAthlete, clubId: team.clubId, teamId: team.teamId, startsAt: "2026-01-01T00:00:00Z" });
  await archiveMembership(pre.restored, "2026-02-01T00:00:00Z");
  await restoreMembership(pre.restored);
  pre.membershipCount = (await q(`select count(*)::int as n from public.athlete_memberships`))[0].n;

  await applyGpexeTestMigrations(db.url);
  assert.ok((await q(`select to_regclass('public.athlete_membership_periods') as t`))[0].t, "v25 applied");

  process.env.DATABASE_URL = db.url;
  delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  const serverModule = await import("../src/server.js");
  service = await import("../src/gpexeImportService.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  ({ deriveAthleteState, ROSTER_STATE_LABELS } = await import("../src/activityRoster.js"));
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is on the disposable database");
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

// ---------------------------------------------------------------------------
// Membership history
// ---------------------------------------------------------------------------
test("1. v25 backfills one period per existing active, paused and archived membership", async () => {
  const periods = (await q(`select count(*)::int as n from public.athlete_membership_periods`))[0].n;
  assert.equal(periods, pre.membershipCount, "one period per membership that existed before v25");
  const iso = (rows) => rows.map((r) => [r.valid_from.toISOString(), r.valid_to ? r.valid_to.toISOString() : null]);
  assert.deepEqual(iso(await periodsOf(pre.active)), [["2026-01-01T00:00:00.000Z", null]]);
  assert.deepEqual(iso(await periodsOf(pre.paused)), [["2026-02-01T00:00:00.000Z", null]], "paused is still a member");
  assert.deepEqual(iso(await periodsOf(pre.archived)), [["2026-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]]);
  assert.deepEqual(iso(await periodsOf(pre.archivedNoTime)), [["2026-01-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"]], "archived without archived_at closes at updated_at");
  assert.deepEqual(iso(await periodsOf(pre.clubOnly)), [["2026-01-01T00:00:00.000Z", null]], "club memberships get periods too");
});

test("2. archiving an active membership closes its period at archived_at", async () => {
  const { clubId, teamId } = await makeTeam();
  const m = await addMembership({ athleteId: await makeAthlete("Archive me"), clubId, teamId, startsAt: "2026-05-01T00:00:00Z" });
  await archiveMembership(m, "2026-06-01T10:00:00Z");
  const periods = await periodsOf(m);
  assert.equal(periods.length, 1);
  assert.equal(periods[0].valid_from.toISOString(), "2026-05-01T00:00:00.000Z");
  assert.equal(periods[0].valid_to.toISOString(), "2026-06-01T10:00:00.000Z");
});

test("3. restoring an archived membership opens a new period and keeps the old one", async () => {
  const { clubId, teamId } = await makeTeam();
  const m = await addMembership({ athleteId: await makeAthlete("Restore me"), clubId, teamId, startsAt: "2026-05-01T00:00:00Z" });
  await archiveMembership(m, "2026-06-01T00:00:00Z");
  await restoreMembership(m);
  const periods = await periodsOf(m);
  assert.equal(periods.length, 2, "the gap stays in the history");
  assert.equal(periods[0].valid_to.toISOString(), "2026-06-01T00:00:00.000Z", "the old period is unchanged");
  assert.equal(periods[1].valid_to, null, "the new period is open");
  assert.ok(periods[1].valid_from > periods[0].valid_to, "the new period starts at the restore");
  assert.equal((await q(`select status from public.athlete_memberships where id = $1`, [m]))[0].status, "active", "Settings' own row is revived as before");
});

test("4. active <-> paused makes no false break", async () => {
  const { clubId, teamId } = await makeTeam();
  const m = await addMembership({ athleteId: await makeAthlete("Pause me"), clubId, teamId });
  await q(`update public.athlete_memberships set status = 'paused' where id = $1`, [m]);
  await q(`update public.athlete_memberships set status = 'active' where id = $1`, [m]);
  await q(`update public.athlete_memberships set status = 'active', updated_at = now() where id = $1`, [m]);
  const periods = await periodsOf(m);
  assert.equal(periods.length, 1);
  assert.equal(periods[0].valid_to, null);
});

test("5. a membership's athlete, club, team and type cannot change", async () => {
  const { clubId, teamId } = await makeTeam();
  const other = await makeTeam();
  const athleteId = await makeAthlete("Fixed identity");
  const m = await addMembership({ athleteId, clubId, teamId });
  const clubM = await addMembership({ athleteId, clubId, type: "club" });
  for (const [sql, params] of [
    [`update public.athlete_memberships set athlete_id = $2 where id = $1`, [m, await makeAthlete("Someone else")]],
    [`update public.athlete_memberships set team_id = $2, club_id = $3 where id = $1`, [m, other.teamId, other.clubId]],
    [`update public.athlete_memberships set club_id = $2 where id = $1`, [clubM, other.clubId]],
    [`update public.athlete_memberships set membership_type = 'club', team_id = null where id = $1`, [m]],
  ]) {
    await assert.rejects(q(sql, params), /never change/);
  }
  const row = (await q(`select athlete_id, team_id, membership_type from public.athlete_memberships where id = $1`, [m]))[0];
  assert.deepEqual([row.athlete_id, row.team_id, row.membership_type], [athleteId, teamId, "team"]);
});

test("6. one open period per membership", async () => {
  const { clubId, teamId } = await makeTeam();
  const athleteId = await makeAthlete("One open");
  const m = await addMembership({ athleteId, clubId, teamId });
  await restoreMembership(m); // active -> active: nothing to open
  assert.equal((await periodsOf(m)).length, 1);
  const client = await newClient();
  try {
    await client.query("begin");
    await client.query(`select set_config('optimove.membership_period_write', 'on', true)`);
    await assert.rejects(
      client.query(
        `insert into public.athlete_membership_periods (membership_id, athlete_id, club_id, team_id, membership_type, valid_from)
         values ($1,$2,$3,$4,'team',now())`,
        [m, athleteId, clubId, teamId],
      ),
      /athlete_membership_periods_one_open_idx/,
    );
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

test("7. roster boundary: valid_from <= session start < valid_to", async () => {
  const { clubId, teamId } = await makeTeam("Boundary");
  const start = "2026-09-14T16:00:00Z";
  const cases = {
    "from exactly at start": { startsAt: start },
    "left exactly at start": { startsAt: "2026-01-01T00:00:00Z", archivedAt: start },
    "joined one second later": { startsAt: "2026-09-14T16:00:01Z" },
    "left one second later": { startsAt: "2026-01-01T00:00:00Z", archivedAt: "2026-09-14T16:00:01Z" },
  };
  const ids = {};
  for (const [name, c] of Object.entries(cases)) {
    ids[name] = await makeAthlete(name);
    const m = await addMembership({ athleteId: ids[name], clubId, teamId, startsAt: c.startsAt });
    if (c.archivedAt) await archiveMembership(m, c.archivedAt);
  }
  const activityId = await makeActivity({ teamId, startedAt: start });
  const onRoster = new Set((await q(`select athlete_id from training.activity_roster($1)`, [activityId])).map((r) => r.athlete_id));
  assert.equal(onRoster.has(ids["from exactly at start"]), true);
  assert.equal(onRoster.has(ids["left exactly at start"]), false);
  assert.equal(onRoster.has(ids["joined one second later"]), false);
  assert.equal(onRoster.has(ids["left one second later"]), true);
});

test("8. without a start time the roster is the activity's local day in its own time zone", async () => {
  const { clubId, teamId } = await makeTeam("Local day");
  // 14 Sep 2026 in Europe/Sarajevo (UTC+2) = [13 Sep 22:00Z, 14 Sep 22:00Z).
  const cases = {
    "left 13 Sep 23:30Z (01:30 local on the 14th)": { startsAt: "2026-01-01T00:00:00Z", archivedAt: "2026-09-13T23:30:00Z", in: true },
    "left 13 Sep 21:30Z (the 13th local)": { startsAt: "2026-01-01T00:00:00Z", archivedAt: "2026-09-13T21:30:00Z", in: false },
    "joined 14 Sep 21:30Z (23:30 local)": { startsAt: "2026-09-14T21:30:00Z", in: true },
    "joined 14 Sep 22:30Z (the 15th local)": { startsAt: "2026-09-14T22:30:00Z", in: false },
  };
  const ids = {};
  for (const [name, c] of Object.entries(cases)) {
    ids[name] = await makeAthlete(name);
    const m = await addMembership({ athleteId: ids[name], clubId, teamId, startsAt: c.startsAt });
    if (c.archivedAt) await archiveMembership(m, c.archivedAt);
  }
  const activityId = await makeActivity({ teamId, startedAt: null, localDate: "2026-09-14" });
  const onRoster = new Set((await q(`select athlete_id from training.activity_roster($1)`, [activityId])).map((r) => r.athlete_id));
  for (const [name, c] of Object.entries(cases)) assert.equal(onRoster.has(ids[name]), c.in, name);
});

test("9. a club membership and two team memberships do not duplicate an athlete on the roster", async () => {
  const { clubId, teamId } = await makeTeam("Dup");
  const athleteId = await makeAthlete("Twice a member");
  await addMembership({ athleteId, clubId, type: "club" });
  const first = await addMembership({ athleteId, clubId, teamId, startsAt: "2026-01-01T00:00:00Z" });
  await archiveMembership(first, "2026-12-01T00:00:00Z"); // still covers the session
  await addMembership({ athleteId, clubId, teamId, startsAt: "2026-02-01T00:00:00Z" }); // a second row, active
  const activityId = await makeActivity({ teamId });
  const rows = await q(`select athlete_id, left_at from training.activity_roster($1) where athlete_id = $2`, [activityId, athleteId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].left_at, null, "still a member through the active row");
});

test("10. known limitation: a membership archived and restored before v25 is on rosters inside its lost gap", async () => {
  // Characterization, not correct history: the row was archived on 1 Feb and
  // restored before v25 (the restore revives the same row), so v25 could
  // only backfill one open period from starts_at. Over-inclusion, never
  // omission; the coach answers with "Did not participate" · Other.
  const periods = await periodsOf(pre.restored);
  assert.equal(periods.length, 1);
  assert.equal(periods[0].valid_from.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(periods[0].valid_to, null);
  const insideGap = await makeActivity({ teamId: pre.team.teamId, startedAt: "2026-02-15T10:00:00Z" });
  const ids = (await q(`select athlete_id from training.activity_roster($1)`, [insideGap])).map((r) => r.athlete_id);
  assert.ok(ids.includes(pre.restoredAthlete), "listed although archived on that date");
});

// ---------------------------------------------------------------------------
// Roster read
// ---------------------------------------------------------------------------
test("11. a team session returns the team's roster on that date", async () => {
  const { clubId, teamId } = await makeTeam("History");
  const coach = await coachOf(teamId);
  const stayed = await makeAthlete("Stayed");
  const left = await makeAthlete("Left later");
  const joined = await makeAthlete("Joined later");
  await addMembership({ athleteId: stayed, clubId, teamId });
  const leftM = await addMembership({ athleteId: left, clubId, teamId });
  await archiveMembership(leftM, "2026-09-20T09:00:00Z");
  await addMembership({ athleteId: joined, clubId, teamId, startsAt: "2026-09-18T00:00:00Z" });
  const activityId = await makeActivity({ teamId });

  const r = await roster(activityId, coach.cookie);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.athletes.map((a) => a.name).sort(), ["Left later", "Stayed"]);
  const leftRow = byName(r.body, "Left later");
  assert.equal(leftRow.membership.leftAfterSession, true);
  assert.equal(leftRow.membership.leftAt, "2026-09-20T09:00:00.000Z");
  assert.ok(leftRow.flags.includes("left_team"));
  assert.equal(leftRow.state, "unknown", "who left later still needs a state");
  assert.equal(r.body.counts.total, 2);
  assert.equal(r.body.counts.needsState, 2);
  assert.deepEqual(r.body.completion, { status: "not_complete", revision: 0, completedBy: null, completedAt: null, needsReviewCauses: [] });
  assert.equal(r.body.canonicalActivityId, activityId);
  assert.deepEqual(r.body.reasons.map((x) => x.key), ["non_contact_injury", "contact_injury", "illness", "load_management", "other_team", "other"]);
});

test("12/13. Measured comes from effective imported occasions, not participation_status ('planned' on the GPEXE path)", async () => {
  const team = await gpexeTeam("Measured");
  const coach = await coachOf(team.teamId);
  const summary = await importDirect(team, bundleFor(6101));
  const statuses = await q(`select athlete_id, participation_status from training.activity_participants where activity_id = $1`, [summary.activityId]);
  assert.ok(statuses.length >= 2 && statuses.every((s) => s.participation_status === "planned"), "the GPEXE path writes planned");

  const r = await roster(summary.activityId, coach.cookie);
  assert.equal(r.status, 200, r.text);
  const a = byName(r.body, team.names[101]);
  assert.equal(a.state, "measured");
  assert.equal(a.stateLabel, "Measured");
  assert.equal(a.group, "done");
  assert.ok(a.values.some((v) => v.entryMethod === "api_import" && v.value !== null), "session-level values carried");
  assert.equal(byName(r.body, team.names[102]).state, "measured");
  assert.equal(byName(r.body, team.names[103]).state, "unknown", "two tracks: not imported, and no approval wrote an observation");
});

test("14. a manual value is never shown as Measured", async () => {
  const team = await gpexeTeam("Manual");
  const coach = await coachOf(team.teamId);
  const summary = await importDirect(team, bundleFor(6102));
  // Every imported result of 101 (whole session and each drill) corrected
  // by hand: no effective imported value is left for that athlete.
  const identities = await q(
    `select si.id, si.current_occasion_id from training_load.metric_source_identities si
       join training_load.metric_source_connections c on c.id = si.source_connection_id
       join training_load.metric_measurement_occasions o on o.id = si.current_occasion_id
       join training_load.metric_event_participants p on p.id = o.event_participant_id
      where c.owner_team_id = $1 and p.athlete_id = $2`,
    [team.teamId, team.ids[101]],
  );
  assert.ok(identities.length >= 2, "whole session and drills");
  const { correctImportedOccasionManually } = await import("../src/trainingLoadMetricsMeasurements.js");
  const req = { user: { id: team.userId }, authz: { platformRoles: [], clubRoles: [], teamRoles: [{ role: "team_coach", teamId: team.teamId }], managedTeamIds: [] } };
  const scopeCtx = { type: "team", teamId: team.teamId, ownerContext: { ownerScope: "team", ownerTeamId: team.teamId, ownerClubId: null, ownerUserId: null } };
  for (const identity of identities) {
    const values = (await q(
      `select metric_definition_id, metric_definition_version_id, value_numeric::float8 as value from training_load.metric_values where occasion_id = $1`,
      [identity.current_occasion_id],
    )).map((v) => ({ metricDefinitionId: v.metric_definition_id, metricDefinitionVersionId: v.metric_definition_version_id, value: v.value }));
    const manual = await correctImportedOccasionManually(req, scopeCtx, { requestKey: `roster-${uid()}`, sourceIdentityId: identity.id, expectedCurrentOccasionId: identity.current_occasion_id, values });
    assert.equal(manual.error, undefined, JSON.stringify(manual));
  }

  const r = await roster(summary.activityId, coach.cookie);
  const a = byName(r.body, team.names[101]);
  assert.notEqual(a.state, "measured");
  assert.notEqual(a.state, "measured_change_waiting");
  assert.equal(a.state, "unknown");
  assert.ok(a.flags.includes("manual_values_recorded"));
  assert.ok(a.values.length > 0 && a.values.every((v) => v.entryMethod === "manual"));
  // The same rule in the pure derivation.
  assert.equal(deriveAthleteState({ decisions: [], facts: [{ entryMethod: "manual" }], needsReview: false, observations: [] }).state, "unknown");
});

test("15/16. an open record_unusable observation gives No usable device record; a resolved one no longer does", async () => {
  const team = await gpexeTeam("Unusable");
  const coach = await coachOf(team.teamId);
  const summary = await importDirect(team, bundleFor(6103));
  const client = await newClient();
  try {
    await client.query("begin");
    const result = await recordImportObservations(client, {
      activityId: summary.activityId, sourceConnectionId: summary.connectionId,
      unusable: [{ athleteId: team.ids[103], reasonCode: "needs_manual_review", adapterReason: "multiple_tracks" }], imported: [],
    });
    await client.query("commit");
    assert.deepEqual(result, { recorded: 1, resolved: 0 });
  } finally {
    await client.end();
  }
  let r = await roster(summary.activityId, coach.cookie);
  const a = byName(r.body, team.names[103]);
  assert.equal(a.state, "no_usable_device_record");
  assert.equal(a.stateLabel, "No usable device record");
  assert.equal(a.group, "needs_state");
  assert.deepEqual(a.sourceReason, { code: "needs_manual_review", sourceSystem: "gpexe", label: "flagged this record for a manual check" });

  await q(`update training.activity_source_observations set resolved_at = now() where athlete_id = $1`, [team.ids[103]]);
  r = await roster(summary.activityId, coach.cookie);
  assert.equal(byName(r.body, team.names[103]).state, "unknown");
  assert.equal(byName(r.body, team.names[103]).sourceReason, null);
});

test("17. no evidence and no decision is Unknown; a decision gives its state, O1 label included", async () => {
  const { clubId, teamId } = await makeTeam("Decided");
  const coach = await coachOf(teamId);
  const ill = await makeAthlete("Ill athlete");
  const trained = await makeAthlete("Trained no vest");
  const unknown = await makeAthlete("Nobody knows");
  for (const id of [ill, trained, unknown]) await addMembership({ athleteId: id, clubId, teamId });
  const activityId = await makeActivity({ teamId });
  await insertDecision({ activityId, athleteId: ill, teamId, userId: coach.id });
  await insertDecision({ activityId, athleteId: trained, teamId, userId: coach.id, kind: "participated_no_values" });

  const r = await roster(activityId, coach.cookie);
  assert.equal(byName(r.body, "Nobody knows").state, "unknown");
  assert.equal(byName(r.body, "Nobody knows").stateLabel, "Unknown");
  const illRow = byName(r.body, "Ill athlete");
  assert.equal(illRow.state, "did_not_participate");
  assert.equal(illRow.decision.reasonKey, "illness");
  assert.equal(illRow.decision.decidedBy.basis, "team_coach");
  const trainedRow = byName(r.body, "Trained no vest");
  assert.equal(trainedRow.state, "participated_no_values");
  assert.equal(trainedRow.stateLabel, "Participated · no device data");
  assert.equal(ROSTER_STATE_LABELS.participated_no_values, "Participated · no device data");
  assert.deepEqual([r.body.counts.needsState, r.body.canComplete], [1, false]);
});

test("18. the canonical activity and every alias give the same roster", async () => {
  const { clubId, teamId } = await makeTeam("Alias");
  const coach = await coachOf(teamId);
  const a1 = await makeAthlete("Alias one");
  const a2 = await makeAthlete("Alias two");
  const a3 = await makeAthlete("Alias three");
  for (const id of [a1, a2, a3]) await addMembership({ athleteId: id, clubId, teamId });
  const survivor = await makeActivity({ teamId, name: "Survivor" });
  const merged = await makeActivity({ teamId, name: "Merged" });
  await insertDecision({ activityId: merged, athleteId: a1, teamId, userId: coach.id }); // decided on the alias before the merge
  await insertDecision({ activityId: survivor, athleteId: a2, teamId, userId: coach.id, kind: "participated_no_values" });
  await insertDecision({ activityId: merged, athleteId: a2, teamId, userId: coach.id }); // a second, different current decision
  await insertDecision({ activityId: survivor, athleteId: a3, teamId, userId: coach.id }); // the same decision on both
  await insertDecision({ activityId: merged, athleteId: a3, teamId, userId: coach.id });
  const client = await newClient();
  try {
    await client.query("begin");
    await client.query(`select set_config('training.allow_supersede_write', 'on', true)`);
    await client.query(`update training.activities set superseded_by_activity_id = $2, lifecycle_state = 'superseded' where id = $1`, [merged, survivor]);
    await client.query("commit");
  } finally {
    await client.end();
  }
  const viaSurvivor = await roster(survivor, coach.cookie);
  const viaAlias = await roster(merged, coach.cookie);
  assert.equal(viaSurvivor.status, 200, viaSurvivor.text);
  assert.equal(viaAlias.body.canonicalActivityId, survivor);
  assert.deepEqual(viaAlias.body.athletes, viaSurvivor.body.athletes);
  assert.equal(byName(viaSurvivor.body, "Alias one").state, "did_not_participate", "a decision made on the alias is read through the alias set");
  const two = byName(viaSurvivor.body, "Alias two");
  assert.ok(two.flags.includes("decisions_disagree"));
  assert.equal(two.group, "needs_state");
  assert.equal(two.conflictingDecisions.length, 2);
  const three = byName(viaSurvivor.body, "Alias three");
  assert.deepEqual([three.state, three.flags.includes("decisions_disagree")], ["did_not_participate", false], "agreeing decisions are not a conflict");
  assert.ok(three.decision, "and the row still names a decision (who, when, its id)");
  assert.equal(three.decision.kind, "did_not_participate");
  // Writes go to the canonical activity only.
  await assert.rejects(insertDecision({ activityId: merged, athleteId: a1, teamId, userId: coach.id }), /superseded/);
});

test("19. a measured athlete who joined after the session is listed apart as recorded outside the roster and does not block", async () => {
  const team = await gpexeTeam("Joined");
  const coach = await coachOf(team.teamId);
  // 102 joined the team on 20 Sep, after the 14 Sep session; still active.
  await q(`delete from public.athlete_memberships where athlete_id = $1 and membership_type = 'team'`, [team.ids[102]]);
  await addMembership({ athleteId: team.ids[102], clubId: team.clubId, teamId: team.teamId, startsAt: "2026-09-20T00:00:00Z" });
  const summary = await importDirect(team, bundleFor(6104));
  const r = await roster(summary.activityId, coach.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(byName(r.body, team.names[102]), undefined, "not on that date's roster");
  assert.deepEqual(r.body.recordedOutsideRoster.map((a) => a.name), [team.names[102]]);
  assert.equal(r.body.recordedOutsideRoster[0].state, "measured");
  assert.equal(r.body.counts.recordedOutsideRoster, 1);
  assert.equal(r.body.joinedAfterSession, undefined, "the old, inaccurate name is gone");
  assert.equal(r.body.counts.needsState, 1, "only 103 (not imported) needs a state");
});

test("19b. a measured athlete who left the team before the session is also recorded outside the roster, with no invented reason", async () => {
  const team = await gpexeTeam("Left before");
  const coach = await coachOf(team.teamId);
  const summary = await importDirect(team, bundleFor(6106));
  // 101's team membership ended on 10 Sep, before the 14 Sep session.
  const m = (await q(`select id from public.athlete_memberships where athlete_id = $1 and team_id = $2`, [team.ids[101], team.teamId]))[0].id;
  await archiveMembership(m, "2026-09-10T00:00:00Z");
  const r = await roster(summary.activityId, coach.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(byName(r.body, team.names[101]), undefined, "not on that date's roster");
  assert.equal(r.body.recordedOutsideRoster.length, 1);
  const row = r.body.recordedOutsideRoster[0];
  assert.deepEqual(Object.keys(row).sort(), ["athleteId", "name", "state", "stateLabel", "values"], "no joined/left reason is claimed");
  assert.deepEqual([row.name, row.state], [team.names[101], "measured"]);
  assert.equal(r.body.counts.recordedOutsideRoster, 1);
});

test("20. the roster read writes nothing to any new table and never runs GPEXE", async () => {
  const team = await gpexeTeam("Read only");
  const coach = await coachOf(team.teamId);
  const padmin = await platformAdmin();
  const summary = await importDirect(team, bundleFor(6105));
  // Rows the read must leave exactly as they are: an open observation, a
  // current decision and open and closed membership periods.
  const client = await newClient();
  try {
    await client.query("begin");
    await recordImportObservations(client, {
      activityId: summary.activityId, sourceConnectionId: summary.connectionId,
      unusable: [{ athleteId: team.ids[103], reasonCode: "needs_manual_review" }],
    });
    await client.query("commit");
  } finally {
    await client.end();
  }
  await insertDecision({ activityId: summary.activityId, athleteId: team.ids[103], teamId: team.teamId, userId: coach.id, kind: "participated_no_values" });
  const leaver = await makeAthlete("Read only leaver");
  const leaverM = await addMembership({ athleteId: leaver, clubId: team.clubId, teamId: team.teamId });
  await archiveMembership(leaverM, "2026-09-20T00:00:00Z");
  let gpexeCalls = 0;
  service.setGpexeClientFactory(() => { gpexeCalls += 1; throw new Error("no GPEXE in a read"); });
  try {
    const before = await rowCounts();
    // Since v26 (5a2) the decision above created the session's completion
    // row (not_complete, revision 1); the reads must not add or change one.
    const completionsBefore = (await q(`select count(*)::int as n from training.activity_completions where activity_id = $1`, [summary.activityId]))[0].n;
    for (const cookie of [coach.cookie, padmin.cookie, coach.cookie]) {
      assert.equal((await roster(summary.activityId, cookie)).status, 200);
    }
    assert.deepEqual(await rowCounts(), before);
    assert.equal((await q(`select count(*)::int as n from training.activity_completions where activity_id = $1`, [summary.activityId]))[0].n, completionsBefore, "no completion row from a read");
    assert.equal(gpexeCalls, 0);
  } finally {
    service.setGpexeClientFactory(null);
  }
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------
async function securityFixture() {
  const { clubId, teamId } = await makeTeam("Secure");
  const athleteId = await makeAthlete("Secure athlete");
  await addMembership({ athleteId, clubId, teamId });
  const activityId = await makeActivity({ teamId });
  return { clubId, teamId, athleteId, activityId };
}

test("21. team coach, the team's club admin and a platform admin in the right workspace get 200 with their own basis", async () => {
  const f = await securityFixture();
  const cases = [
    [await coachOf(f.teamId), "team_coach"],
    [await clubAdminOf(f.clubId), "club_admin"],
    [await platformAdmin(), "platform_admin"],
  ];
  for (const [user, basis] of cases) {
    const r = await roster(f.activityId, user.cookie);
    assert.equal(r.status, 200, `${basis}: ${r.text}`);
    assert.equal(r.body.viewer.basis, basis);
    assert.equal(r.body.athletes.length, 1);
  }
});

test("22. another club or team, the wrong workspace, no role and an archived team all get the identical 404", async () => {
  const f = await securityFixture();
  const other = await makeTeam("Other");
  const otherCoach = await coachOf(other.teamId);
  const otherClubAdmin = await clubAdminOf(other.clubId);
  const noRole = await withCookie(await makeUser("no role"));
  // Coaches this team, but is working in another team's workspace.
  const wrongWorkspace = await coachOf(f.teamId, "coach elsewhere");
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [wrongWorkspace.id, other.teamId]);
  await setWorkspace(wrongWorkspace.id, "team", other.teamId);
  // A platform admin working in a club workspace of another club.
  const adminElsewhere = await platformAdmin("admin elsewhere");
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [adminElsewhere.id, other.clubId]);
  await setWorkspace(adminElsewhere.id, "club", other.clubId);

  const missing = await roster(crypto.randomUUID(), otherCoach.cookie);
  assert.equal(missing.status, 404);
  const expected = missing.text;
  for (const [label, user] of [["other team", otherCoach], ["other club", otherClubAdmin], ["no role", noRole], ["wrong workspace", wrongWorkspace], ["platform admin in another club workspace", adminElsewhere]]) {
    const r = await roster(f.activityId, user.cookie);
    assert.equal(r.status, 404, label);
    assert.equal(r.text, expected, `${label}: same body as a missing activity`);
  }
  const malformed = await roster("not-a-uuid", otherCoach.cookie);
  assert.deepEqual([malformed.status, malformed.text], [404, expected]);

  // Archived team: the same 404 for its coach, its club admin and a platform admin.
  const coach = await coachOf(f.teamId);
  const clubAdmin = await clubAdminOf(f.clubId);
  const padmin = await platformAdmin();
  await q(`update public.teams set is_active = false where id = $1`, [f.teamId]);
  try {
    for (const user of [coach, clubAdmin, padmin]) {
      const r = await roster(f.activityId, user.cookie);
      assert.deepEqual([r.status, r.text], [404, expected]);
    }
  } finally {
    await q(`update public.teams set is_active = true where id = $1`, [f.teamId]);
  }
});

test("23. only a team session has a roster: roster_not_applicable for its manager, 404 for everyone else", async () => {
  const { clubId, teamId } = await makeTeam("Club owned");
  const clubAdmin = await clubAdminOf(clubId);
  const coach = await coachOf(teamId);
  const clubActivity = await makeActivity({ ownerScope: "club", clubId });
  const r = await roster(clubActivity, clubAdmin.cookie);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "roster_not_applicable");
  const hidden = await roster(clubActivity, coach.cookie);
  assert.equal(hidden.status, 404, "a team coach of the club does not learn the club session exists");
  // And the database refuses roster rows on it.
  await assert.rejects(insertDecision({ activityId: clubActivity, athleteId: await makeAthlete("x"), teamId, userId: coach.id }), /not team-owned/);
});

test("24. lock_activity_decider returns the basis of the path actually used, never a stronger role by itself", async () => {
  const f = await securityFixture();
  const both = await coachOf(f.teamId, "coach and platform admin");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [both.id]);
  const decide = async (userId, basis) => (await q(`select training.lock_activity_decider($1,$2,$3) as b`, [userId, f.teamId, basis]))[0].b;
  assert.equal(await decide(both.id, "team_coach"), "team_coach");
  assert.equal(await decide(both.id, "platform_admin"), "platform_admin");
  await assert.rejects(decide(both.id, "club_admin"), (e) => e.code === "42501");
  const coachOnly = await coachOf(f.teamId, "coach only");
  await assert.rejects(decide(coachOnly.id, "platform_admin"), (e) => e.code === "42501");
  await assert.rejects(decide(coachOnly.id, "owner"), (e) => e.code === "22023");
  // The route records the active workspace's path, not the strongest role.
  const r = await roster(f.activityId, both.cookie);
  assert.equal(r.body.viewer.basis, "team_coach");
  // A decision row cannot claim a basis its author does not hold.
  await assert.rejects(
    insertDecision({ activityId: f.activityId, athleteId: f.athleteId, teamId: f.teamId, userId: coachOnly.id, basis: "platform_admin" }),
    (e) => e.code === "42501",
  );
  const id = await insertDecision({ activityId: f.activityId, athleteId: f.athleteId, teamId: f.teamId, userId: both.id, basis: "team_coach" });
  assert.equal((await q(`select decided_by_basis from training.activity_athlete_decisions where id = $1`, [id]))[0].decided_by_basis, "team_coach");
});

test("24b. the decider holds its team, club, role and user rows: an archive or role removal waits for the decision", async () => {
  const f = await securityFixture();
  const clubAdmin = await clubAdminOf(f.clubId);
  const coach = await coachOf(f.teamId);
  const cases = [
    ["club_admin", clubAdmin.id, `update public.clubs set is_active = false where id = '${f.clubId}'`],
    ["club_admin", clubAdmin.id, `update public.user_club_roles set is_active = false where user_id = '${clubAdmin.id}'`],
    ["team_coach", coach.id, `update public.teams set is_active = false where id = '${f.teamId}'`],
    ["team_coach", coach.id, `update public.users set is_active = false where id = '${coach.id}'`],
  ];
  for (const [basis, userId, change] of cases) {
    const decider = await newClient();
    const other = await newClient();
    try {
      await decider.query("begin");
      await decider.query(`select training.lock_activity_decider($1,$2,$3)`, [userId, f.teamId, basis]);
      await other.query("begin");
      await other.query("set local lock_timeout = '300ms'");
      await assert.rejects(other.query(change), (e) => e.code === "55P03", `${basis}: "${change}" waits for the decision`);
    } finally {
      await other.query("rollback").catch(() => {});
      await decider.query("rollback").catch(() => {});
      await other.end();
      await decider.end();
    }
  }
});

test("25. a deactivated user or a removed role is refused", async () => {
  const f = await securityFixture();
  const deactivated = await coachOf(f.teamId, "deactivated");
  const removed = await coachOf(f.teamId, "role removed");
  assert.equal((await roster(f.activityId, removed.cookie)).status, 200);
  await q(`update public.users set is_active = false where id = $1`, [deactivated.id]);
  await q(`update public.user_team_roles set is_active = false where user_id = $1`, [removed.id]);
  assert.equal((await roster(f.activityId, deactivated.cookie)).status, 401, "a deactivated user has no session");
  assert.equal((await roster(f.activityId, removed.cookie)).status, 404);
  for (const userId of [deactivated.id, removed.id]) {
    await assert.rejects(q(`select training.lock_activity_decider($1,$2,'team_coach')`, [userId, f.teamId]), (e) => e.code === "42501");
    await assert.rejects(insertDecision({ activityId: f.activityId, athleteId: f.athleteId, teamId: f.teamId, userId }), (e) => e.code === "42501");
  }
});

// ---------------------------------------------------------------------------
// Observations from the GPEXE approval, and the undo
// ---------------------------------------------------------------------------
function fakeGpexe(bundles) {
  return () => ({
    async listTeamSessions() { return bundles.map((b) => ({ id: String(b.teamSession.id) })); },
    async fetchSessionBundle({ sessionId }) { return structuredClone(bundles.find((b) => String(b.teamSession.id) === sessionId)); },
  });
}

let nextGpexeTeamId = 7000;
async function approvalTeam(label) {
  const team = await gpexeTeam(label);
  const coach = await coachOf(team.teamId);
  const padmin = await platformAdmin();
  const gpexeTeamId = nextGpexeTeamId++;
  const gx = (path, opts) => api(`/api/training-load/gpexe${path}`, opts);
  assert.equal((await gx(`/teams/${team.teamId}/settings`, { method: "PUT", cookie: padmin.cookie, body: { gpexeTeamId: String(gpexeTeamId) } })).status, 200);
  for (const g of ["101", "102", "103"]) {
    assert.equal((await gx(`/teams/${team.teamId}/athlete-links`, { method: "POST", cookie: coach.cookie, body: { gpexeAthleteId: g, athleteId: team.ids[g] } })).status, 201);
  }
  return { ...team, coach, padmin, gpexeTeamId, gx };
}

async function checkAndApprove(team, bundle) {
  service.setGpexeClientFactory(fakeGpexe([bundle]));
  const started = await team.gx(`/teams/${team.teamId}/checks`, { method: "POST", cookie: team.coach.cookie, body: {} });
  assert.equal(started.status, 202, started.text);
  for (let i = 0; i < 200; i += 1) {
    const r = await team.gx(`/teams/${team.teamId}/checks/${started.body.check.id}`, { cookie: team.coach.cookie });
    if (r.body.check?.status !== "running") {
      assert.equal(r.body.check.status, "succeeded", JSON.stringify(r.body.check));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const list = (await team.gx(`/teams/${team.teamId}/candidates`, { cookie: team.coach.cookie })).body.candidates;
  const candidate = list.find((c) => c.gpexeTeamSessionId === String(bundle.teamSession.id) && c.status === "pending");
  assert.ok(candidate, JSON.stringify(list.map((c) => [c.gpexeTeamSessionId, c.status])));
  process.env.GPEXE_IMPORT_APPLY_ENABLED = "true";
  try {
    const approved = await team.gx(`/teams/${team.teamId}/candidates/${candidate.id}/approve`, { method: "POST", cookie: team.padmin.cookie, body: { previewHash: candidate.previewHash } });
    assert.equal(approved.status, 200, approved.text);
    return { candidateId: candidate.id, ...approved.body };
  } finally {
    delete process.env.GPEXE_IMPORT_APPLY_ENABLED;
  }
}

const observationsOf = (activityId) => q(
  `select * from training.activity_source_observations where activity_id in (select activity_id from training.activity_alias_ids($1)) order by observed_at`,
  [activityId],
);

test("26/28. the GPEXE approval records an observation only for the linked roster athlete with an unusable record, with no name", async () => {
  const team = await approvalTeam("Approve");
  const bundle = bundleFor(6201, { with104: true, gpexeTeamId: team.gpexeTeamId });
  const approved = await checkAndApprove(team, bundle);
  const activityId = approved.import.activityId;
  const rows = await observationsOf(activityId);
  assert.equal(rows.length, 1, "104 (two tracks, never linked) gets nothing");
  assert.equal(rows[0].athlete_id, team.ids[103]);
  assert.equal(rows[0].kind, "record_unusable");
  assert.equal(rows[0].reason_code, "needs_manual_review");
  assert.equal(rows[0].resolved_at, null);
  assert.deepEqual(rows[0].adapter_ref, { approvalId: approved.approval.id, candidateId: approved.candidateId, adapterReason: "multiple_tracks" });
  const text = JSON.stringify(rows[0]);
  for (const name of Object.values(team.names)) assert.ok(!text.includes(name), "no athlete name stored");

  const r = await roster(activityId, team.coach.cookie);
  const a = byName(r.body, team.names[103]);
  assert.equal(a.state, "no_usable_device_record");
  assert.equal(a.sourceReason.sourceSystem, "gpexe");

  // 28: no cross-team leak and no foreign connection.
  const other = await gpexeTeam("Leak");
  const otherCoach = await coachOf(other.teamId);
  const otherActivity = await makeActivity({ teamId: other.teamId });
  const otherRoster = await roster(otherActivity, otherCoach.cookie);
  assert.equal(otherRoster.body.athletes.every((x) => x.state === "unknown" && x.sourceReason === null), true);
  assert.equal((await roster(activityId, otherCoach.cookie)).status, 404);
  await assert.rejects(
    q(`insert into training.activity_source_observations (activity_id, athlete_id, source_connection_id, kind, reason_code)
       values ($1,$2,$3,'record_unusable','needs_manual_review')`, [otherActivity, other.ids[101], rows[0].source_connection_id]),
    /does not belong to the team/,
  );
});

test("27. a later successful import of the athlete resolves the observation", async () => {
  const team = await approvalTeam("Resolve");
  const first = await checkAndApprove(team, bundleFor(6202, { gpexeTeamId: team.gpexeTeamId }));
  const activityId = first.import.activityId;
  assert.equal((await observationsOf(activityId)).filter((o) => o.resolved_at === null).length, 1);
  // GPEXE fixed 103's record (one track) - a newer version of the session.
  await checkAndApprove(team, bundleFor(6202, { gpexeTeamId: team.gpexeTeamId, oneTrack103: true, updatedOn: "2026-09-15T08:00:00.000" }));
  const rows = await observationsOf(activityId);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].resolved_at, null, "resolved by the import that wrote 103's results");
  const r = await roster(activityId, team.coach.cookie);
  assert.equal(byName(r.body, team.names[103]).state, "measured");
});

test("29. recording the same observation again is idempotent", async () => {
  const team = await gpexeTeam("Idem");
  const summary = await importDirect(team, bundleFor(6203));
  const input = {
    activityId: summary.activityId, sourceConnectionId: summary.connectionId,
    unusable: [{ athleteId: team.ids[103], reasonCode: "needs_manual_review", adapterReason: "multiple_tracks" }],
  };
  const client = await newClient();
  try {
    await client.query("begin");
    assert.deepEqual(await recordImportObservations(client, input), { recorded: 1, resolved: 0 });
    assert.deepEqual(await recordImportObservations(client, input), { recorded: 0, resolved: 0 });
    // Someone who is not on the roster on that date is skipped, never recorded.
    const outsider = await makeAthlete("Not on roster");
    assert.deepEqual(await recordImportObservations(client, { ...input, unusable: [{ athleteId: outsider, reasonCode: "needs_manual_review" }] }), { recorded: 0, resolved: 0 });
    await client.query("commit");
  } finally {
    await client.end();
  }
  assert.equal((await observationsOf(summary.activityId)).length, 1);
});

test("29b. an athlete who leaves the roster between the check and the insert is skipped, and the import's transaction goes on", async () => {
  const team = await gpexeTeam("Leaves");
  const summary = await importDirect(team, bundleFor(6204));
  // 103's membership is replaced by one that starts after the session, by
  // another connection, right after the observation writer read the roster.
  const client = await newClient();
  try {
    await client.query("begin");
    const result = await recordImportObservations(client, {
      activityId: summary.activityId, sourceConnectionId: summary.connectionId,
      unusable: [{ athleteId: team.ids[103], reasonCode: "needs_manual_review" }],
    }, {
      afterRosterCheck: async () => {
        await q(`delete from public.athlete_memberships where athlete_id = $1 and membership_type = 'team'`, [team.ids[103]]);
        await addMembership({ athleteId: team.ids[103], clubId: team.clubId, teamId: team.teamId, startsAt: "2026-09-20T00:00:00Z" });
      },
    });
    assert.deepEqual(result, { recorded: 0, resolved: 0 });
    assert.equal((await client.query("select 1 as ok")).rows[0].ok, 1, "the transaction is still usable");
    await client.query("commit");
  } finally {
    await client.end();
  }
  assert.equal((await observationsOf(summary.activityId)).length, 0);
});

async function undoFixture(label, sessionId) {
  const team = await gpexeTeam(label);
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [team.userId]);
  const summary = await importDirect(team, bundleFor(sessionId));
  const client = await newClient();
  try {
    await client.query("begin");
    await recordImportObservations(client, {
      activityId: summary.activityId, sourceConnectionId: summary.connectionId,
      unusable: [{ athleteId: team.ids[103], reasonCode: "needs_manual_review" }],
    });
    await client.query("commit");
  } finally {
    await client.end();
  }
  return { team, summary };
}

test("30. the undo removes the session's observations and counts them", async () => {
  const { team, summary } = await undoFixture("Undo", 6301);
  const client = await newClient();
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    assert.equal(scope.observationIds.length, 1);
    const log = await undoImportedSession(client, scope, { performedByUserId: team.userId, reason: "roster undo test", apply: true });
    assert.equal(log.removed.activity_source_observations, 1);
    assert.equal(log.removed.activities, 1);
    const dbLog = (await q(`select removed_counts from training_load.import_deletion_log where id = $1`, [log.databaseLogId]))[0];
    assert.equal(dbLog.removed_counts.activity_source_observations, 1);
    await assertTriggersEnabled(client);
  } finally {
    await client.end();
  }
  assert.equal((await q(`select count(*)::int as n from training.activity_source_observations where activity_id = $1`, [summary.activityId]))[0].n, 0);
});

test("31/32. coach work on the roster stops the undo with roster_decisions_exist; every trigger is back on after a refusal, a dry run and a failed verification", async () => {
  const { team, summary } = await undoFixture("Undo stop", 6302);
  const coach = await coachOf(team.teamId);
  await insertDecision({ activityId: summary.activityId, athleteId: team.ids[103], teamId: team.teamId, userId: coach.id });
  const before = await rowCounts([...NEW_TABLES, "training.activities", "training_load.metric_events"]);
  const client = await newClient();
  try {
    const scope = await collectScope(client, { eventId: summary.eventId });
    // v26 (5a2): the decision also created the completion row and its log row.
    assert.deepEqual(scope.coachRosterWork, { decisions: 1, requests: 1, completions: 1, completion_log: 1 });
    await assert.rejects(
      undoImportedSession(client, scope, { performedByUserId: team.userId, reason: "should stop", apply: true }),
      (e) => e.code === ROSTER_DECISIONS_EXIST && /roster_decisions_exist/.test(e.message),
    );
    await assertTriggersEnabled(client);
    assert.deepEqual(await rowCounts([...NEW_TABLES, "training.activities", "training_load.metric_events"]), before, "nothing removed");
  } finally {
    await client.end();
  }

  // 32: a dry run and a failed verification both leave every protection on.
  const second = await undoFixture("Undo verify", 6303);
  const c2 = await newClient();
  try {
    const scope = await collectScope(c2, { eventId: second.summary.eventId });
    const dry = await undoImportedSession(c2, scope, { performedByUserId: second.team.userId, reason: "dry", apply: false });
    assert.equal(dry.removed.activity_source_observations, 1);
    await assertTriggersEnabled(c2);
    await assert.rejects(
      undoImportedSession(c2, scope, {
        performedByUserId: second.team.userId, reason: "verify", apply: true,
        onBeforeVerify: (c) => c.query(`alter table training.activity_source_observations disable trigger activity_source_observations_append_only`),
      }),
      /activity_source_observations_append_only/,
    );
    await assertTriggersEnabled(c2);
    const enabled = (await q(`select tgenabled from pg_trigger where tgname = 'activity_source_observations_append_only'`))[0].tgenabled;
    assert.equal(enabled, "O");
  } finally {
    await c2.end();
  }
  assert.equal((await observationsOf(second.summary.activityId)).length, 1, "rolled back: the observation is still there");
});

// ---------------------------------------------------------------------------
// Concurrency and integrity
// ---------------------------------------------------------------------------
test("33. concurrent archive and restore never leave two open periods", async () => {
  const { clubId, teamId } = await makeTeam("Race");
  const memberships = [];
  for (let i = 0; i < 3; i += 1) memberships.push(await addMembership({ athleteId: await makeAthlete(`Race ${i}`), clubId, teamId }));
  const clients = [await newClient(), await newClient(), await newClient(), await newClient()];
  try {
    const worker = async (client, op) => {
      for (let i = 0; i < 15; i += 1) {
        for (const m of memberships) {
          await client.query("begin");
          await client.query(`select id from public.athlete_memberships where id = $1 for update`, [m]);
          if (op === "archive") await archiveMembership(m, null, client);
          else await restoreMembership(m, client);
          await client.query("commit");
        }
      }
    };
    // Also without the explicit row lock the Settings statements take themselves.
    const bare = async (client, op) => {
      for (let i = 0; i < 15; i += 1) {
        for (const m of memberships) {
          if (op === "archive") await client.query(`update public.athlete_memberships set status = 'archived', archived_at = now(), updated_at = now() where id = $1 and status = 'active'`, [m]);
          else await restoreMembership(m, client);
        }
      }
    };
    await Promise.all([worker(clients[0], "archive"), worker(clients[1], "restore"), bare(clients[2], "archive"), bare(clients[3], "restore")]);
  } finally {
    for (const c of clients) await c.end();
  }
  for (const m of memberships) {
    const status = (await q(`select status from public.athlete_memberships where id = $1`, [m]))[0].status;
    const open = (await q(`select count(*)::int as n from public.athlete_membership_periods where membership_id = $1 and valid_to is null`, [m]))[0].n;
    assert.equal(open, status === "archived" ? 0 : 1, `membership ${m} (${status})`);
    const overlaps = (await q(
      `select count(*)::int as n from public.athlete_membership_periods a join public.athlete_membership_periods b
         on a.membership_id = b.membership_id and a.id < b.id
        and a.valid_from < coalesce(b.valid_to, 'infinity') and b.valid_from < coalesce(a.valid_to, 'infinity')
        and not (a.valid_to = b.valid_from or b.valid_to = a.valid_from)
       where a.membership_id = $1`,
      [m],
    ))[0].n;
    assert.equal(overlaps, 0, "periods never overlap");
  }
});

test("33b. a restore whose transaction started before the archive committed never opens a period before the archive's end", async () => {
  const { clubId, teamId } = await makeTeam("Ordered race");
  const m = await addMembership({ athleteId: await makeAthlete("Ordered"), clubId, teamId });
  const restorer = await newClient();
  const archiver = await newClient();
  try {
    await restorer.query("begin");
    const restorerStart = (await restorer.query("select now() as t")).rows[0].t; // its now() is fixed from here
    await new Promise((resolve) => setTimeout(resolve, 30));
    await archiver.query("begin");
    await archiveMembership(m, null, archiver); // archived_at = the archiver's now(), later than the restorer's
    await archiver.query("commit");
    await restoreMembership(m, restorer);
    await restorer.query("commit");
    const periods = await periodsOf(m);
    assert.equal(periods.length, 2);
    assert.ok(periods[0].valid_to > restorerStart, "the archive ended after the restorer's transaction started");
    assert.ok(periods[1].valid_from >= periods[0].valid_to, "the new period starts no earlier than the previous one ended");
  } finally {
    await restorer.query("rollback").catch(() => {});
    await restorer.end();
    await archiver.end();
  }
});

// Each guard, the statement it refuses, and how to take the guard away
// (inside a rolled-back transaction) to prove the statement then passes.
async function integrityFixture() {
  const { clubId, teamId } = await makeTeam("Integrity");
  const coach = await coachOf(teamId);
  const athleteId = await makeAthlete("Integrity athlete");
  const outsider = await makeAthlete("Integrity outsider");
  const membershipId = await addMembership({ athleteId, clubId, teamId });
  const secondAthleteId = await makeAthlete("Integrity second");
  await addMembership({ athleteId: secondAthleteId, clubId, teamId });
  const activityId = await makeActivity({ teamId });
  const otherActivity = await makeActivity({ teamId, name: "Other session" });
  const decisionId = await insertDecision({ activityId, athleteId, teamId, userId: coach.id });
  const requestId = (await q(`select request_id from training.activity_athlete_decisions where id = $1`, [decisionId]))[0].request_id;
  const connectionId = (await q(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('test-src','team',$1) returning id`, [teamId]))[0].id;
  const observationId = (await q(
    `insert into training.activity_source_observations (activity_id, athlete_id, source_connection_id, kind, reason_code)
     values ($1,$2,$3,'record_unusable','needs_manual_review') returning id`, [activityId, athleteId, connectionId],
  ))[0].id;
  const periodId = (await q(`select id from public.athlete_membership_periods where membership_id = $1`, [membershipId]))[0].id;
  // Since v26 (5a2) the decisions create the completion row and its log
  // rows. The second athlete gets a decision too, so nobody on this roster
  // needs a state and v26's "complete only over a resolved roster" rule does
  // not stand in front of the v25 basis guard proved below.
  await insertDecision({ activityId, athleteId: secondAthleteId, teamId, userId: coach.id, kind: "participated_no_values" });
  const logId = (await q(`select id from training.activity_completion_log where activity_id = $1 order by revision limit 1`, [activityId]))[0].id;
  return { clubId, teamId, coach, athleteId, secondAthleteId, outsider, membershipId, activityId, otherActivity, decisionId, requestId, connectionId, observationId, periodId, logId };
}

function guards(f) {
  const t = (table, ...triggers) => triggers.map((trigger) => `alter table ${table} disable trigger ${trigger}`).join("; ");
  const dropCheck = (table, fragment) => async (client) => {
    const name = (await client.query(
      `select conname from pg_constraint where conrelid = $1::regclass and contype = 'c' and pg_get_constraintdef(oid) like $2`,
      [table, `%${fragment}%`],
    )).rows[0]?.conname;
    assert.ok(name, `constraint on ${table} with ${fragment}`);
    await client.query(`alter table ${table} drop constraint ${name}`);
  };
  const decisionInsert = (extra = {}) => ({
    sql: `insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, reason_key, decided_by_user_id, decided_by_basis)
          values ($1,$2,$3,$4,$5,$6,$7,'team_coach')`,
    // A fresh request id (checked only at commit) unless a test needs the
    // existing request of another activity.
    params: [extra.activityId ?? f.otherActivity, extra.athleteId ?? f.athleteId, f.teamId, extra.requestId ?? crypto.randomUUID(), "did_not_participate",
      extra.reason === undefined ? "illness" : extra.reason, f.coach.id],
    ...(extra.commit ? { commit: true } : {}),
  });
  const periods = "public.athlete_membership_periods";
  const decisions = "training.activity_athlete_decisions";
  const observations = "training.activity_source_observations";
  const completions = "training.activity_completions";
  const log = "training.activity_completion_log";
  const observationInsert = (activityId, athleteId, connectionId) => ({
    sql: `insert into ${observations} (activity_id, athlete_id, source_connection_id, kind, reason_code) values ($1,$2,$3,'record_unusable','needs_manual_review')`,
    params: [activityId, athleteId, connectionId],
  });
  return [
    { name: "period: no raw insert", refused: /written only by the membership trigger/, attempt: { sql: `insert into ${periods} (membership_id, athlete_id, club_id, team_id, membership_type, valid_from, valid_to) values ($1,$2,$3,$4,'team','2025-01-01','2025-02-01')`, params: [f.membershipId, f.athleteId, f.clubId, f.teamId] }, off: t(periods, "athlete_membership_periods_protect") },
    { name: "period: a period copies its membership", refused: /does not copy membership/, attempt: { sql: `insert into ${periods} (membership_id, athlete_id, club_id, team_id, membership_type, valid_from, valid_to) values ($1,$2,$3,$4,'team','2025-01-01','2025-02-01')`, params: [f.membershipId, f.outsider, f.clubId, f.teamId], guc: true }, off: t(periods, "athlete_membership_periods_protect") },
    { name: "period: no raw update", refused: /written only by the membership trigger/, attempt: { sql: `update ${periods} set valid_to = now() where id = $1`, params: [f.periodId] }, off: t(periods, "athlete_membership_periods_protect") },
    { name: "period: valid_from never changes", refused: /only gets its end once/, attempt: { sql: `update ${periods} set valid_from = '2020-01-01' where id = $1`, params: [f.periodId], guc: true }, off: t(periods, "athlete_membership_periods_protect") },
    { name: "period: no delete while the membership exists", refused: /removed only with its membership/, attempt: { sql: `delete from ${periods} where id = $1`, params: [f.periodId] }, off: t(periods, "athlete_membership_periods_protect") },
    { name: "period: no truncate", refused: /athlete_membership_periods keeps history/, attempt: { sql: `truncate ${periods}` }, off: t(periods, "athlete_membership_periods_no_truncate") },
    { name: "period: one open per membership", refused: /athlete_membership_periods_one_open_idx/, attempt: { sql: `insert into ${periods} (membership_id, athlete_id, club_id, team_id, membership_type, valid_from) values ($1,$2,$3,$4,'team',now())`, params: [f.membershipId, f.athleteId, f.clubId, f.teamId], guc: true }, off: `drop index public.athlete_membership_periods_one_open_idx` },
    { name: "period: valid_to >= valid_from", refused: /violates check constraint/, attempt: { sql: `update ${periods} set valid_to = '2000-01-01' where id = $1`, params: [f.periodId], guc: true }, off: dropCheck(periods, "valid_to >= valid_from") },
    { name: "membership: identity never changes", refused: /never change/, attempt: { sql: `update public.athlete_memberships set athlete_id = $2 where id = $1`, params: [f.membershipId, f.outsider] }, off: t("public.athlete_memberships", "athlete_memberships_protect_identity") },
    { name: "decision: athlete on the roster", refused: /not on the roster/, attempt: decisionInsert({ athleteId: f.outsider }), off: t(decisions, "activity_athlete_decisions_check") },
    { name: "decision: reason required for did_not_participate", refused: /violates check constraint/, attempt: decisionInsert({ reason: null }), off: dropCheck(decisions, "did_not_participate") },
    // v26 adds a trigger that refuses the same statement first (one current
    // decision in the whole alias set); it is switched off in both steps so
    // this proves the v25 index. The v26 trigger is proved in the 5a2 suite.
    { name: "decision: one current per activity and athlete", refused: /activity_athlete_decisions_one_current/, attempt: { ...decisionInsert({ activityId: f.activityId }), pre: t(decisions, "activity_athlete_decisions_one_current_in_alias_set") }, off: `drop index training.activity_athlete_decisions_one_current` },
    { name: "decision: no update of the kind", refused: /only gets superseded/, attempt: { sql: `update ${decisions} set decision_kind = 'participated_no_values', reason_key = null where id = $1`, params: [f.decisionId] }, off: t(decisions, "activity_athlete_decisions_check") },
    { name: "decision: no delete", refused: /a decision is superseded, never deleted/, attempt: { sql: `delete from ${decisions} where id = $1`, params: [f.decisionId] }, off: t(decisions, "activity_athlete_decisions_check") },
    { name: "decision: no truncate", refused: /activity_athlete_decisions keeps history/, attempt: { sql: `truncate ${decisions}` }, off: t(decisions, "activity_athlete_decisions_no_truncate") },
    // Since v26 the decision also writes a completion log row carrying the
    // same request, whose own deferred check refuses the same commit; the
    // proof takes both link checks away.
    { name: "decision: its request belongs to its activity (at commit)", refused: /does not belong to activity/, attempt: decisionInsert({ athleteId: f.secondAthleteId, requestId: f.requestId, commit: true }), off: `${t(decisions, "activity_athlete_decisions_check_links")}; ${t(log, "activity_completion_log_check_links")}` },
    { name: "request: append-only", refused: /activity_roster_requests is append-only/, attempt: { sql: `update training.activity_roster_requests set result = '{}' where id = $1`, params: [f.requestId] }, off: t("training.activity_roster_requests", "activity_roster_requests_protect") },
    { name: "request (and the tables that point at it): no truncate", refused: /keeps history; TRUNCATE refused/, attempt: { sql: `truncate training.activity_roster_requests cascade` }, off: `${t("training.activity_roster_requests", "activity_roster_requests_no_truncate")}; ${t(decisions, "activity_athlete_decisions_no_truncate")}; ${t(log, "activity_completion_log_no_truncate")}` },
    { name: "completion: revision bumps by one", refused: /bumps the revision by one/, attempt: { sql: `update ${completions} set revision = revision + 2 where activity_id = $1`, params: [f.activityId] }, off: t(completions, "activity_completions_protect") },
    { name: "completion: team never changes", refused: /never change/, attempt: { sql: `update ${completions} set owner_team_id = $2, revision = revision + 1 where activity_id = $1`, params: [f.activityId, f.foreignTeamId] }, off: t(completions, "activity_completions_protect") },
    { name: "completion: complete only through a basis the user holds", refused: /may not decide/, attempt: { sql: `update ${completions} set status = 'complete', revision = revision + 1, completed_by_user_id = $2, completed_by_basis = 'club_admin', completed_at = now(), input_fingerprint = repeat('b', 64) where activity_id = $1`, params: [f.activityId, f.coach.id] }, off: t(completions, "activity_completions_protect") },
    { name: "completion: complete carries who, basis, when and fingerprint", refused: /violates check constraint/, attempt: { sql: `update ${completions} set status = 'complete', revision = revision + 1, completed_by_user_id = $2, completed_by_basis = 'team_coach' where activity_id = $1`, params: [f.activityId, f.coach.id] }, off: dropCheck(completions, "'complete'") },
    { name: "completion: never deleted", refused: /never deleted/, attempt: { sql: `delete from ${completions} where activity_id = $1`, params: [f.activityId] }, off: t(completions, "activity_completions_protect") },
    // revision 1: since v26 a completion row is created at revision 1.
    { name: "completion: only a canonical team session", refused: /not team-owned/, attempt: { sql: `insert into ${completions} (activity_id, owner_team_id, status, revision) values ($1,$2,'not_complete',1)`, params: [f.clubActivity, f.teamId] }, off: t(completions, "activity_completions_protect") },
    // v26's log rules (a log row describes an existing completion revision)
    // also refuse these two log rows; they are switched off in both steps so
    // the v25 guards are what is proved here (v26's rules: the 5a2 suite).
    { name: "completion log: only a canonical team session (a superseded activity id is refused)", refused: /was superseded/, attempt: { sql: `insert into ${log} (activity_id, revision, to_status, cause) values ($1,1,'not_complete','roster_changed')`, params: [f.supersededActivity], pre: t(log, "activity_completion_log_rules") }, off: t(log, "activity_completion_log_protect") },
    { name: "completion log: its request belongs to its activity or alias set (at commit)", refused: /does not belong to activity/, attempt: { sql: `insert into ${log} (activity_id, request_id, revision, to_status, cause) values ($1,$2,1,'not_complete','decision_changed')`, params: [f.otherActivity, f.requestId], commit: true, pre: t(log, "activity_completion_log_rules") }, off: t(log, "activity_completion_log_check_links") },
    { name: "completion log: append-only", refused: /activity_completion_log is append-only/, attempt: { sql: `update ${log} set cause = 'completed' where id = $1`, params: [f.logId] }, off: t(log, "activity_completion_log_protect") },
    { name: "completion log: no truncate", refused: /activity_completion_log keeps history/, attempt: { sql: `truncate ${log}` }, off: t(log, "activity_completion_log_no_truncate") },
    { name: "observation: only resolved, once", refused: /only resolved, once/, attempt: { sql: `update ${observations} set reason_code = 'other' where id = $1`, params: [f.observationId] }, off: t(observations, "activity_source_observations_append_only") },
    { name: "observation: no delete outside the undo", refused: /removed only by the undo/, attempt: { sql: `delete from ${observations} where id = $1`, params: [f.observationId] }, off: t(observations, "activity_source_observations_append_only") },
    { name: "observation: athlete on the roster", refused: /not on the roster/, attempt: observationInsert(f.otherActivity, f.outsider, f.connectionId), off: t(observations, "activity_source_observations_check_insert") },
    { name: "observation: connection of the activity's team", refused: /does not belong to the team/, attempt: observationInsert(f.otherActivity, f.athleteId, f.foreignConnectionId), off: t(observations, "activity_source_observations_check_insert") },
    { name: "observation: one open per activity, athlete, connection and kind", refused: /activity_source_observations_one_open/, attempt: observationInsert(f.activityId, f.athleteId, f.connectionId), off: `drop index training.activity_source_observations_one_open` },
    { name: "observation: no truncate", refused: /activity_source_observations keeps history/, attempt: { sql: `truncate ${observations}` }, off: t(observations, "activity_source_observations_no_truncate") },
    { name: "reason: key never changes", refused: /never changes/, attempt: { sql: `update training.participation_reasons set key = 'sick' where key = 'other_team'` }, off: t("training.participation_reasons", "participation_reasons_protect") },
    { name: "reason: never deleted", refused: /deactivated, never deleted/, attempt: { sql: `delete from training.participation_reasons where key = 'other_team'` }, off: t("training.participation_reasons", "participation_reasons_protect") },
  ];
}

// A team activity already merged into `survivorId` (a superseded alias).
async function supersededInto(survivorId, teamId, { beforeMerge } = {}) {
  const aliasId = await makeActivity({ teamId, name: "Merged away" });
  if (beforeMerge) await beforeMerge(aliasId);
  const client = await newClient();
  try {
    await client.query("begin");
    await client.query(`select set_config('training.allow_supersede_write', 'on', true)`);
    await client.query(`update training.activities set superseded_by_activity_id = $2, lifecycle_state = 'superseded' where id = $1`, [aliasId, survivorId]);
    await client.query("commit");
  } finally {
    await client.end();
  }
  return aliasId;
}

async function runAttempt(client, attempt) {
  if (attempt.pre) await client.query(attempt.pre);
  if (attempt.guc) await client.query(`select set_config('optimove.membership_period_write', 'on', true)`);
  await client.query(attempt.sql, attempt.params ?? []);
  if (attempt.commit) await client.query(`set constraints all immediate`);
}

test("34/35. raw SQL cannot bypass the append-only, identity and integrity rules, and each guard is what refuses it", async () => {
  const f = await integrityFixture();
  f.clubActivity = await makeActivity({ ownerScope: "club", clubId: f.clubId });
  f.supersededActivity = await supersededInto(f.otherActivity, f.teamId);
  const foreign = await makeTeam("Foreign");
  f.foreignTeamId = foreign.teamId;
  f.foreignConnectionId = (await q(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('test-src','team',$1) returning id`, [foreign.teamId]))[0].id;
  const client = await newClient();
  try {
    for (const g of guards(f)) {
      // 34: refused, by this guard, with it in place.
      await client.query("begin");
      try {
        await assert.rejects(runAttempt(client, g.attempt), g.refused, `${g.name}: refused`);
      } finally {
        await client.query("rollback");
      }
      // 35: the same statement passes once that one guard is taken away.
      await client.query("begin");
      try {
        if (typeof g.off === "function") await g.off(client);
        else await client.query(g.off);
        await assert.doesNotReject(runAttempt(client, g.attempt), `${g.name}: passes without its guard`);
      } finally {
        await client.query("rollback");
      }
    }
  } finally {
    await client.end();
  }
  const disabled = (await q(
    `select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and t.tgenabled <> 'O' and n.nspname || '.' || c.relname = any($1::text[])`,
    [[...NEW_TABLES, "public.athlete_memberships"]],
  ))[0].n;
  assert.equal(disabled, 0, "every guard is back after the rolled-back proofs");
});

test("35c. a completion log row may carry the request of an activity merged into its own (same alias set)", async () => {
  const f = await integrityFixture();
  let aliasRequestId = null;
  await supersededInto(f.otherActivity, f.teamId, {
    beforeMerge: async (aliasId) => {
      const decisionId = await insertDecision({ activityId: aliasId, athleteId: f.secondAthleteId, teamId: f.teamId, userId: f.coach.id });
      aliasRequestId = (await q(`select request_id from training.activity_athlete_decisions where id = $1`, [decisionId]))[0].request_id;
    },
  });
  const client = await newClient();
  try {
    await client.query("begin");
    // v26's log rules would refuse this hand-written row first (it describes
    // no completion revision); this test is about v25's alias-set link check.
    await client.query(`alter table training.activity_completion_log disable trigger activity_completion_log_rules`);
    await client.query(
      `insert into training.activity_completion_log (activity_id, request_id, revision, to_status, cause) values ($1,$2,1,'not_complete','decision_changed')`,
      [f.otherActivity, aliasRequestId],
    );
    await assert.doesNotReject(client.query("set constraints all immediate"), "the request's activity is in the log row's alias set");
  } finally {
    await client.query("rollback");
    await client.end();
  }
});

test("35b. manual_values and estimated decisions are refused until 5b, by the decision trigger", async () => {
  const f = await integrityFixture();
  const occasionId = (await q(`select id from training_load.metric_measurement_occasions limit 1`))[0]?.id;
  assert.ok(occasionId, "earlier tests imported occasions");
  const client = await newClient();
  try {
    for (const kind of ["manual_values", "estimated"]) {
      const attempt = {
        sql: `insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis, occasion_id)
              values ($1,$2,$3,$4,$5,$6,'team_coach',$7)`,
        params: [f.otherActivity, f.athleteId, f.teamId, crypto.randomUUID(), kind, f.coach.id, occasionId],
      };
      await client.query("begin");
      try {
        await assert.rejects(runAttempt(client, attempt), /not available yet \(Phase 5b\)/);
      } finally {
        await client.query("rollback");
      }
      await client.query("begin");
      try {
        await client.query(`alter table training.activity_athlete_decisions disable trigger activity_athlete_decisions_check`);
        await assert.doesNotReject(runAttempt(client, attempt));
      } finally {
        await client.query("rollback");
      }
    }
  } finally {
    await client.end();
  }
});
