// Phase 5a2: roster decisions, Complete / Reopen and the automatic
// complete -> needs_review (migration v26, backend/src/activityRosterCommands.js).
// Contract: docs/ai/phase5a-discovery-and-contract.md (sections 3.3, 3.4, 3.6,
// 4 and 11).
//
// Everything runs on disposable databases (optimove_tests_gpexe_roster5a2_*
// and, for the migration test, optimove_tests_gpexe_v26mig_*) created and
// dropped here. Nothing touches OPTIMOVE or any persistent database. Every
// module that reaches src/db.js (the app's pool) is imported only AFTER
// DATABASE_URL points at the disposable database, and before() checks the
// pool's own current_database().
//
// Concurrency tests use controlled connections and the command's test hooks
// (setRosterCommandTestHooks) to hold a real request inside its transaction,
// and prove the wait in pg_stat_activity (wait_event_type = 'Lock') — never
// a bare Promise.all.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  applyGpexeTestMigrations, createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS,
} from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes, TZ } from "./_gpexe-fixtures.mjs";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { importGpexePlan, importGpexePlanLocked, lockTeamForImport } from "../src/gpexeImportWriter.js";
import { recordImportObservations } from "../src/activitySourceObservations.js";
import * as runner from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const V25 = "202609251000_training_load_v25_activity_roster_foundation.sql";
const V26 = "202609252000_training_load_v26_activity_roster_decisions.sql";
const ROLLBACK_SQL = path.resolve(__dirname, "../../docs/runbooks/activity-roster-v26-rollback.sql");

let db;
let admin;
let server;
let apiBase;
let createSession;
let appPool;
let commands;

const TABLES = [
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
const key = () => crypto.randomUUID();

async function q(sql, params = []) {
  return (await admin.query(sql, params)).rows;
}

async function newClient() {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  return client;
}

async function makeTeam(label = "Team") {
  const clubId = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} club ${uid()}`]))[0].id;
  const teamId = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} ${uid()}`]))[0].id;
  return { clubId, teamId };
}

async function makeAthlete(name) {
  return (await q(`insert into public.athletes (full_name, display_name, device_timezone) values ($1,$1,$2) returning id`, [name, TZ]))[0].id;
}

async function addMembership({ athleteId, clubId, teamId = null, type = "team", startsAt = "2026-01-01T00:00:00Z" }) {
  return (await q(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at)
     values ($1,$2,$3,$4,'active',$5) returning id`,
    [athleteId, clubId, teamId, type, startsAt],
  ))[0].id;
}

async function makeUser(label) {
  return (await q(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label.replace(/\W/g, "")}-${uid()}@test.local`, label]))[0].id;
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

async function coachOf(teamId, label = "Coach") {
  const id = await makeUser(label);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return withCookie(id);
}

async function clubAdminOf(clubId, label = "Club admin") {
  const id = await makeUser(label);
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return withCookie(id);
}

async function platformAdmin(label = "Platform admin") {
  const id = await makeUser(label);
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return withCookie(id);
}

async function makeActivity({ teamId, startedAt = "2026-09-14T16:00:00Z", name = "Training", ownerScope = "team", clubId = null }) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(startedAt));
  return (await q(
    `insert into training.activities (name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_team_id, owner_club_id, origin)
     values ($1,$2,$3,$4,$5,$6,$7,'manual') returning id`,
    [name, date, startedAt, TZ, ownerScope, ownerScope === "team" ? teamId : null, ownerScope === "club" ? clubId : null],
  ))[0].id;
}

// A plain team session with `n` members and a coach.
async function plainSession(label, n = 3) {
  const { clubId, teamId } = await makeTeam(label);
  const coach = await coachOf(teamId, `${label} coach`);
  const athletes = [];
  for (let i = 0; i < n; i += 1) {
    const id = await makeAthlete(`${label} ${String.fromCharCode(65 + i)}`);
    await addMembership({ athleteId: id, clubId, type: "club" });
    await addMembership({ athleteId: id, clubId, teamId });
    athletes.push(id);
  }
  const activityId = await makeActivity({ teamId, name: `${label} session` });
  return { clubId, teamId, coach, athletes, activityId };
}

// A team with GPEXE athletes 101-103 as OptiMove athletes (members since
// 2026-01-01); an import of bundleFor() measures 101 and 102 (103 has two
// tracks and is not imported unless oneTrack103).
async function gpexeTeam(label) {
  const { clubId, teamId } = await makeTeam(label);
  const names = { 101: `A101 ${label}`, 102: `B102 ${label}`, 103: `C103 ${label}` };
  const ids = {};
  for (const [g, name] of Object.entries(names)) {
    ids[g] = await makeAthlete(name);
    await addMembership({ athleteId: ids[g], clubId, type: "club" });
    await addMembership({ athleteId: ids[g], clubId, teamId });
  }
  const userId = await makeUser(`${label} importer`);
  const coach = await coachOf(teamId, `${label} coach`);
  return { clubId, teamId, ids, names, userId, coach };
}

function bundleFor(sessionId, { oneTrack103 = false, updatedOn = "2026-09-14T20:18:09.337" } = {}) {
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
  return makeBundle({ sessionId, gpexeTeamId: 77, start: "2026-09-14T18:08:12", updatedOn, athletes });
}

async function importDirect(team, bundle) {
  const client = await newClient();
  try {
    return await importGpexePlan(client, buildGpexeImportPlan(bundle), {
      ownerTeamId: team.teamId, performedByUserId: team.userId, athleteIdByGpexeId: team.ids, batchFilename: "roster 5a2 test",
    });
  } finally {
    await client.end();
  }
}

let sessionSeq = 7000;
// A measured GPEXE session: 101 and 102 Measured, 103 Unknown.
async function measuredSession(label) {
  const team = await gpexeTeam(label);
  sessionSeq += 1;
  const summary = await importDirect(team, bundleFor(sessionSeq));
  return { ...team, sessionId: sessionSeq, summary, activityId: summary.activityId };
}

async function api(pathname, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${pathname}`, {
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
const put = (activityId, athleteId, cookie, body) => api(`/api/training-activity/${activityId}/roster/${athleteId}/decision`, { method: "PUT", cookie, body });
const del = (activityId, athleteId, cookie, body) => api(`/api/training-activity/${activityId}/roster/${athleteId}/decision`, { method: "DELETE", cookie, body });
const bulk = (activityId, cookie, body) => api(`/api/training-activity/${activityId}/roster/decisions`, { method: "POST", cookie, body });
const complete = (activityId, cookie, body) => api(`/api/training-activity/${activityId}/roster/complete`, { method: "POST", cookie, body });
const reopen = (activityId, cookie, body) => api(`/api/training-activity/${activityId}/roster/reopen`, { method: "POST", cookie, body });

const dnp = (extra = {}) => ({ kind: "did_not_participate", reasonKey: "illness", expectedDecisionId: null, requestKey: key(), ...extra });
const pnv = (extra = {}) => ({ kind: "participated_no_values", expectedDecisionId: null, requestKey: key(), ...extra });

async function completeNow(activityId, cookie) {
  const r = await roster(activityId, cookie);
  assert.equal(r.status, 200, r.text);
  return complete(activityId, cookie, { expectedRevision: r.body.completion.revision, expectedFingerprint: r.body.rosterFingerprint, requestKey: key() });
}

// Every athlete who needs a state gets Participated · no device data, then
// the session is completed; returns the roster after completion.
async function resolveAndComplete(activityId, cookie) {
  const r = await roster(activityId, cookie);
  for (const a of r.body.athletes.filter((x) => x.group === "needs_state")) {
    const res = await put(activityId, a.athleteId, cookie, pnv({ expectedDecisionId: a.decision?.id ?? null }));
    assert.equal(res.status, 200, res.text);
  }
  const done = await completeNow(activityId, cookie);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.completion.status, "complete");
  return done.body;
}

// A measured session that is complete: 101/102 Measured, 103 Participated.
async function completedMeasured(label) {
  const s = await measuredSession(label);
  await resolveAndComplete(s.activityId, s.coach.cookie);
  return s;
}

async function completionOf(activityId) {
  return (await q(`select status, revision, needs_review_causes, completed_by_user_id, completed_by_basis, completed_at, input_fingerprint
                     from training.activity_completions where activity_id = $1`, [activityId]))[0] ?? null;
}

async function logOf(activityId) {
  return q(`select revision, from_status, to_status, cause, performed_by_user_id, request_id, detail
              from training.activity_completion_log where activity_id = $1 order by revision`, [activityId]);
}

async function rowCounts(tables = TABLES) {
  const counts = {};
  for (const t of tables) {
    const r = (await q(`select count(*)::int as n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as d from ${t} x`))[0];
    counts[t] = `${r.n}:${r.d}`;
  }
  return counts;
}

// Runs fn(client) in one transaction on a new connection, optionally with
// one trigger switched off inside it (and on again before COMMIT) — the
// mutation proof that this trigger is what does the work.
async function inTx(fn, { disable = null } = {}) {
  const client = await newClient();
  try {
    await client.query("begin");
    if (disable) await client.query(`alter table ${disable[0]} disable trigger ${disable[1]}`);
    const out = await fn(client);
    if (disable) {
      // Deferred checks first: a table with pending trigger events cannot
      // be altered.
      await client.query("set constraints all immediate");
      await client.query(`alter table ${disable[0]} enable trigger ${disable[1]}`);
    }
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

// Waits until `count` backends of the disposable database wait on a lock
// with a query matching `pattern`; returns them. Proof of an actual wait.
async function waitForLockWaiters(pattern, count = 1, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const rows = (await q(
      `select pid, query, wait_event_type, wait_event from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`,
    )).filter((r) => pattern.test(r.query));
    if (rows.length >= count) return rows;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`expected ${count} backend(s) waiting on a lock for ${pattern}, saw ${rows.length}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "roster5a2" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  assert.ok((await q(`select to_regprocedure('training.roster_record_change(uuid[],uuid[],varchar,uuid,uuid,boolean,text)') as f`))[0].f, "v26 applied");

  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  commands = await import("../src/activityRosterCommands.js");
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is on the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  commands?.setRosterCommandTestHooks(null);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

// ---------------------------------------------------------------------------
// 0. Safety
// ---------------------------------------------------------------------------
test("0. the app pool and the test connections are on the disposable database, never the developer's", async () => {
  const baseName = new URL(ORIGINAL_DATABASE_URL).pathname.slice(1);
  assert.match(db.name, /^optimove_tests_gpexe_roster5a2_[0-9a-f]+$/);
  assert.notEqual(db.name.toLowerCase(), baseName.toLowerCase());
  assert.notEqual(db.name.toLowerCase(), "optimove");
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name);
  assert.equal(new URL(process.env.DATABASE_URL).pathname.slice(1), db.name);
  assert.equal((await q(`select count(*)::int as n from public.optimove_disposable_test_database`))[0].n, 1, "the disposable marker exists");
});

// ---------------------------------------------------------------------------
// 1-11. Decisions
// ---------------------------------------------------------------------------
test("1. Did not participate with a reason and a note: one decision, one request, the revision and one log row", async () => {
  const s = await plainSession("Decide");
  const res = await put(s.activityId, s.athletes[0], s.coach.cookie, dnp({ reasonKey: "contact_injury", note: "  hamstring  " }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.decision.kind, "did_not_participate");
  assert.equal(res.body.decision.reasonKey, "contact_injury");
  assert.equal(res.body.decision.note, "hamstring", "the note is trimmed");
  assert.equal(res.body.decision.decidedBy.basis, "team_coach");
  assert.equal(res.body.decision.activityId, s.activityId);
  assert.equal(res.body.athlete.state, "did_not_participate");
  assert.equal(res.body.athlete.group, "done");
  assert.deepEqual([res.body.completion.status, res.body.completion.revision], ["not_complete", 1]);
  const requests = await q(`select operation, performed_by_user_id from training.activity_roster_requests where activity_id = $1`, [s.activityId]);
  assert.deepEqual(requests.map((r) => [r.operation, r.performed_by_user_id]), [["decide", s.coach.id]]);
  const log = await logOf(s.activityId);
  assert.deepEqual(log.map((l) => [l.revision, l.from_status, l.to_status, l.cause, l.performed_by_user_id]), [[1, "not_complete", "not_complete", "decision_changed", s.coach.id]]);
  assert.deepEqual(log[0].detail.athleteIds, [s.athletes[0]]);
  const r = await roster(s.activityId, s.coach.cookie);
  assert.equal(r.body.athletes.find((a) => a.athleteId === s.athletes[0]).decision.id, res.body.decision.id);
  assert.equal(r.body.completion.revision, 1);
});

test("2. Participated · no device data takes no reason", async () => {
  const s = await plainSession("Participated");
  const refused = await put(s.activityId, s.athletes[0], s.coach.cookie, pnv({ reasonKey: "illness" }));
  assert.deepEqual([refused.status, refused.body.error], [400, "reason_not_allowed"]);
  const res = await put(s.activityId, s.athletes[0], s.coach.cookie, pnv({ note: "vest forgotten" }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.decision.label, "Participated · no device data");
  assert.equal(res.body.athlete.stateLabel, "Participated · no device data");
  assert.equal(res.body.decision.reasonKey, null);
});

test("3. invalid bodies are refused with stable codes and write nothing; manual values and estimates wait for 5b", async () => {
  const s = await plainSession("Validate");
  const a = s.athletes[0];
  const before = await rowCounts();
  const cases = [
    [{ ...dnp(), kind: "cleared" }, 400, "invalid_kind"],
    [{ ...dnp(), kind: "trained" }, 400, "invalid_kind"],
    [{ ...dnp(), reasonKey: undefined }, 400, "reason_required"],
    [{ ...dnp(), reasonKey: "" }, 400, "reason_required"],
    [{ ...dnp(), reasonKey: "Not-A-Key" }, 400, "unknown_reason"],
    [{ ...dnp(), reasonKey: "no_such_reason" }, 400, "unknown_reason"],
    [{ ...dnp(), note: "x".repeat(501) }, 400, "note_too_long"],
    [{ ...dnp(), note: 5 }, 400, "invalid_note"],
    [{ ...dnp(), requestKey: "not-a-uuid" }, 400, "invalid_request_key"],
    [{ ...dnp(), requestKey: undefined }, 400, "invalid_request_key"],
    [{ kind: "did_not_participate", reasonKey: "illness", requestKey: key() }, 400, "invalid_expected_decision_id"],
    [{ ...dnp(), expectedDecisionId: "x" }, 400, "invalid_expected_decision_id"],
    [{ kind: "manual_values", expectedDecisionId: null, requestKey: key() }, 409, "kind_not_available"],
    [{ kind: "estimated", expectedDecisionId: null, requestKey: key() }, 409, "kind_not_available"],
  ];
  for (const [body, status, code] of cases) {
    const res = await put(s.activityId, a, s.coach.cookie, body);
    assert.deepEqual([res.status, res.body.error], [status, code], `${JSON.stringify(body)} -> ${res.text}`);
  }
  assert.equal((await put(s.activityId, "not-a-uuid", s.coach.cookie, dnp())).status, 404, "a malformed athlete id is the 404");
  assert.deepEqual([(await del(s.activityId, a, s.coach.cookie, { requestKey: key(), expectedDecisionId: null })).body.error], ["invalid_expected_decision_id"], "DELETE names the decision it removes");
  assert.deepEqual(await rowCounts(), before, "nothing written");
});

test("4. a change supersedes the current decision, which stays as history", async () => {
  const s = await plainSession("Change");
  const first = await put(s.activityId, s.athletes[0], s.coach.cookie, dnp());
  const second = await put(s.activityId, s.athletes[0], s.coach.cookie, pnv({ expectedDecisionId: first.body.decision.id }));
  assert.equal(second.status, 200, second.text);
  const rows = await q(`select id, decision_kind, superseded_by_decision_id from training.activity_athlete_decisions where athlete_id = $1 order by decided_at, id`, [s.athletes[0]]);
  assert.equal(rows.length, 2);
  const old = rows.find((r) => r.id === first.body.decision.id);
  assert.equal(old.superseded_by_decision_id, second.body.decision.id, "the old one points at the new one");
  assert.equal(old.decision_kind, "did_not_participate", "and is otherwise unchanged");
  assert.equal(second.body.completion.revision, 2);
});

test("5. removing a state writes a new 'cleared' row; history stays; the athlete returns to the derived state", async () => {
  const s = await plainSession("Clear");
  const a = s.athletes[0];
  const d1 = (await put(s.activityId, a, s.coach.cookie, dnp())).body.decision.id;
  const cleared = await del(s.activityId, a, s.coach.cookie, { expectedDecisionId: d1, requestKey: key() });
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(cleared.body.decision.kind, "cleared");
  assert.equal(cleared.body.athlete.state, "unknown");
  assert.equal(cleared.body.athlete.decision, null);
  const rows = await q(`select decision_kind, superseded_by_decision_id is null as current from training.activity_athlete_decisions where athlete_id = $1 order by decided_at, id`, [a]);
  assert.deepEqual(rows.map((r) => [r.decision_kind, r.current]), [["did_not_participate", false], ["cleared", true]]);
  assert.equal((await q(`select count(*)::int as n from training.activity_roster_requests where activity_id = $1 and operation = 'clear'`, [s.activityId]))[0].n, 1);
  // Nothing left to remove; a stale id is a changed decision.
  const again = await del(s.activityId, a, s.coach.cookie, { expectedDecisionId: cleared.body.decision.id, requestKey: key() });
  assert.deepEqual([again.status, again.body.error], [409, "nothing_to_clear"]);
  const stale = await del(s.activityId, a, s.coach.cookie, { expectedDecisionId: d1, requestKey: key() });
  assert.deepEqual([stale.status, stale.body.error], [409, "decision_changed"]);
  // After a clear the athlete has "no decision": null matches.
  const next = await put(s.activityId, a, s.coach.cookie, pnv({ expectedDecisionId: null }));
  assert.equal(next.status, 200, next.text);
  // A measured athlete can have a decision cleared (Use the measured values).
  assert.equal((await logOf(s.activityId)).length, 3, "one log row per request");
});

test("6. an athlete who is not on the session's roster is refused", async () => {
  const s = await plainSession("Roster only");
  const outsider = await makeAthlete("Not a member");
  const late = await makeAthlete("Joined later");
  await addMembership({ athleteId: late, clubId: s.clubId, teamId: s.teamId, startsAt: "2026-09-20T00:00:00Z" });
  const before = await rowCounts();
  for (const athleteId of [outsider, late, crypto.randomUUID()]) {
    const res = await put(s.activityId, athleteId, s.coach.cookie, dnp());
    assert.deepEqual([res.status, res.body.error], [409, "not_on_roster"], res.text);
  }
  assert.deepEqual(await rowCounts(), before);
});

test("7. a measured athlete cannot get a decision: measured_record_exists, with the current state", async () => {
  const s = await measuredSession("Measured refuse");
  const before = await rowCounts();
  for (const body of [dnp(), pnv()]) {
    const res = await put(s.activityId, s.ids[101], s.coach.cookie, body);
    assert.deepEqual([res.status, res.body.error], [409, "measured_record_exists"], res.text);
    assert.equal(res.body.current.state, "measured");
    assert.ok(!/measured record in activity/.test(res.text), "no database text");
  }
  assert.deepEqual(await rowCounts(), before);
  // The database refuses it as well (decision trigger, v25).
  await assert.rejects(inTx(async (c) => {
    const req = crypto.randomUUID();
    await c.query(
      `insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis)
       values ($1,$2,$3,$4,'participated_no_values',$5,'team_coach')`, [s.activityId, s.ids[101], s.teamId, req, s.coach.id]);
  }), /measured record/);
});

test("8. expectedDecisionId guards against a lost update: a stale id is decision_changed with the current decision", async () => {
  const s = await plainSession("Stale");
  const d1 = (await put(s.activityId, s.athletes[0], s.coach.cookie, dnp())).body.decision.id;
  const d2 = (await put(s.activityId, s.athletes[0], s.coach.cookie, pnv({ expectedDecisionId: d1 }))).body.decision.id;
  const before = await rowCounts();
  const stale = await put(s.activityId, s.athletes[0], s.coach.cookie, dnp({ expectedDecisionId: d1 }));
  assert.deepEqual([stale.status, stale.body.error], [409, "decision_changed"]);
  assert.equal(stale.body.current.decision.id, d2);
  assert.equal(stale.body.current.state, "participated_no_values");
  const nullWhenDecided = await put(s.activityId, s.athletes[0], s.coach.cookie, dnp({ expectedDecisionId: null }));
  assert.deepEqual([nullWhenDecided.status, nullWhenDecided.body.error], [409, "decision_changed"]);
  assert.deepEqual(await rowCounts(), before);
});

// A team activity merged into `survivorId` (the v4 functions set this under
// training.allow_supersede_write; here the same statement, as 5a1 does).
async function supersedeInto(aliasId, survivorId) {
  await inTx(async (c) => {
    await c.query(`select set_config('training.allow_supersede_write', 'on', true)`);
    await c.query(`update training.activities set superseded_by_activity_id = $2, lifecycle_state = 'superseded' where id = $1`, [aliasId, survivorId]);
  });
}

test("9. writes go to the canonical activity only: a superseded id answers activity_superseded with the canonical id", async () => {
  const s = await plainSession("Canonical");
  const alias = await makeActivity({ teamId: s.teamId, name: "Merged away" });
  await supersedeInto(alias, s.activityId);
  const before = await rowCounts();
  for (const res of [
    await put(alias, s.athletes[0], s.coach.cookie, dnp()),
    await bulk(alias, s.coach.cookie, { kind: "participated_no_values", athletes: [{ athleteId: s.athletes[0], expectedDecisionId: null }], requestKey: key() }),
    await complete(alias, s.coach.cookie, { expectedRevision: 0, expectedFingerprint: "a".repeat(64), requestKey: key() }),
  ]) {
    assert.deepEqual([res.status, res.body.error, res.body.canonicalActivityId], [409, "activity_superseded", s.activityId], res.text);
  }
  assert.deepEqual(await rowCounts(), before);
  const ok = await put(s.activityId, s.athletes[0], s.coach.cookie, dnp());
  assert.equal(ok.status, 200);
  assert.equal(ok.body.decision.activityId, s.activityId);
});

test("10. two different current decisions brought together by a merge: either id is accepted and one decision supersedes both", async () => {
  const s = await plainSession("Conflict");
  const other = await makeActivity({ teamId: s.teamId, name: "Duplicate" });
  const a = s.athletes[0];
  const d1 = (await put(s.activityId, a, s.coach.cookie, dnp())).body.decision.id;
  const d2 = (await put(other, a, s.coach.cookie, pnv())).body.decision.id;
  await supersedeInto(other, s.activityId);
  const r = await roster(s.activityId, s.coach.cookie);
  const row = r.body.athletes.find((x) => x.athleteId === a);
  assert.ok(row.flags.includes("decisions_disagree"));
  assert.equal(row.group, "needs_state");
  const res = await put(s.activityId, a, s.coach.cookie, dnp({ reasonKey: "other", expectedDecisionId: d2 }));
  assert.equal(res.status, 200, res.text);
  const current = await q(`select id from training.activity_athlete_decisions where athlete_id = $1 and superseded_by_decision_id is null`, [a]);
  assert.deepEqual(current.map((c) => c.id), [res.body.decision.id], "one current decision in the alias set");
  const superseded = await q(`select id, superseded_by_decision_id from training.activity_athlete_decisions where id = any($1::uuid[])`, [[d1, d2]]);
  assert.ok(superseded.every((x) => x.superseded_by_decision_id === res.body.decision.id));
  assert.ok(!res.body.athlete.flags.includes("decisions_disagree"));
});

test("11. write order: superseding first, then the new row, is the only order the one-current rules accept", async () => {
  const s = await plainSession("Order");
  const d1 = (await put(s.activityId, s.athletes[0], s.coach.cookie, dnp())).body.decision.id;
  const insertNew = (c, id, req) => c.query(
    `insert into training.activity_athlete_decisions (id, activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis)
     values ($1,$2,$3,$4,$5,'participated_no_values',$6,'team_coach')`, [id, s.activityId, s.athletes[0], s.teamId, req, s.coach.id]);
  const supersede = (c, id) => c.query(`update training.activity_athlete_decisions set superseded_by_decision_id = $2, superseded_at = now() where id = $1`, [d1, id]);
  const request = (c, req) => c.query(
    `insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result)
     values ($1,$2,$3,$4,'decide',$5,'{}')`, [req, s.activityId, crypto.randomUUID(), "b".repeat(64), s.coach.id]);
  // Reverse order: the new row while the old one is still current.
  await assert.rejects(inTx(async (c) => {
    const id = crypto.randomUUID(); const req = crypto.randomUUID();
    await insertNew(c, id, req); await supersede(c, id); await request(c, req);
  }), /already has a current decision|activity_athlete_decisions_one_current/);
  // The contract's order.
  await inTx(async (c) => {
    const id = crypto.randomUUID(); const req = crypto.randomUUID();
    await supersede(c, id); await insertNew(c, id, req); await request(c, req);
  });
  assert.equal((await q(`select count(*)::int as n from training.activity_athlete_decisions where athlete_id = $1 and superseded_by_decision_id is null`, [s.athletes[0]]))[0].n, 1);
});

// ---------------------------------------------------------------------------
// 12-15. Idempotency
// ---------------------------------------------------------------------------
test("12. the same requestKey with the same body returns the stored answer and writes nothing", async () => {
  const s = await plainSession("Replay");
  const body = dnp({ note: "same" });
  const first = await put(s.activityId, s.athletes[0], s.coach.cookie, body);
  assert.equal(first.status, 200);
  const before = await rowCounts();
  const again = await put(s.activityId, s.athletes[0], s.coach.cookie, { ...body, note: "  same " });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual(again.body, first.body, "the stored answer, byte for byte (the note is compared trimmed)");
  assert.deepEqual(await rowCounts(), before, "no request, decision, completion or log row added");
});

test("13. the same requestKey with another body is request_key_reused and writes nothing", async () => {
  const s = await plainSession("Reuse");
  const body = dnp();
  await put(s.activityId, s.athletes[0], s.coach.cookie, body);
  const before = await rowCounts();
  for (const res of [
    await put(s.activityId, s.athletes[0], s.coach.cookie, { ...body, reasonKey: "other" }),
    await put(s.activityId, s.athletes[1], s.coach.cookie, body),
    await del(s.activityId, s.athletes[0], s.coach.cookie, { expectedDecisionId: crypto.randomUUID(), requestKey: body.requestKey }),
    await bulk(s.activityId, s.coach.cookie, { kind: "did_not_participate", reasonKey: "illness", athletes: [{ athleteId: s.athletes[0], expectedDecisionId: null }], requestKey: body.requestKey }),
  ]) {
    assert.deepEqual([res.status, res.body.error], [409, "request_key_reused"], res.text);
  }
  assert.deepEqual(await rowCounts(), before);
});

test("14. idempotency holds across the alias set: a retry after a merge finds its first answer, on the alias and on the survivor", async () => {
  const s = await plainSession("Alias replay");
  const survivor = await makeActivity({ teamId: s.teamId, name: "Survivor" });
  const body = pnv();
  const first = await put(s.activityId, s.athletes[0], s.coach.cookie, body);
  assert.equal(first.status, 200);
  await supersedeInto(s.activityId, survivor);
  const before = await rowCounts();
  const viaAlias = await put(s.activityId, s.athletes[0], s.coach.cookie, body);
  assert.deepEqual([viaAlias.status, viaAlias.body], [200, first.body], "found before any activity_superseded check");
  const viaSurvivor = await put(survivor, s.athletes[0], s.coach.cookie, body);
  assert.deepEqual([viaSurvivor.status, viaSurvivor.body], [200, first.body]);
  assert.deepEqual(await rowCounts(), before);
  const fresh = await put(s.activityId, s.athletes[0], s.coach.cookie, pnv());
  assert.deepEqual([fresh.status, fresh.body.error], [409, "activity_superseded"]);
});

test("15. a retry re-checks the right: a coach who lost the team gets the 404, not the stored answer", async () => {
  const s = await plainSession("Replay auth");
  const body = dnp();
  assert.equal((await put(s.activityId, s.athletes[0], s.coach.cookie, body)).status, 200);
  await q(`update public.user_team_roles set is_active = false where user_id = $1`, [s.coach.id]);
  const res = await put(s.activityId, s.athletes[0], s.coach.cookie, body);
  assert.deepEqual([res.status, res.body], [404, { error: "notFound" }]);
});

// ---------------------------------------------------------------------------
// 16-19. Bulk
// ---------------------------------------------------------------------------
test("16. bulk: one request, one decision per athlete, one revision and one log row", async () => {
  const s = await plainSession("Bulk", 4);
  const res = await bulk(s.activityId, s.coach.cookie, {
    kind: "did_not_participate", reasonKey: "illness", note: "flu",
    athletes: s.athletes.slice(0, 3).map((athleteId) => ({ athleteId, expectedDecisionId: null })), requestKey: key(),
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.decisions.length, 3);
  assert.ok(res.body.decisions.every((d) => d.kind === "did_not_participate" && d.reasonKey === "illness" && d.note === "flu"));
  assert.equal(res.body.completion.revision, 1);
  assert.deepEqual((await q(`select operation from training.activity_roster_requests where activity_id = $1`, [s.activityId])).map((r) => r.operation), ["decide_bulk"]);
  const log = await logOf(s.activityId);
  assert.equal(log.length, 1);
  assert.deepEqual([...log[0].detail.athleteIds].sort(), s.athletes.slice(0, 3).sort());
  const r = await roster(s.activityId, s.coach.cookie);
  assert.equal(r.body.counts.needsState, 1, "nobody was assumed: the fourth athlete still needs a state");
});

test("17. bulk limits: 1-60 distinct athletes", async () => {
  const s = await plainSession("Bulk limits", 2);
  const before = await rowCounts();
  const base = { kind: "participated_no_values", requestKey: key() };
  const many = Array.from({ length: 61 }, () => ({ athleteId: crypto.randomUUID(), expectedDecisionId: null }));
  const cases = [
    [{ ...base, athletes: [] }, "invalid_athletes"],
    [{ ...base }, "invalid_athletes"],
    [{ ...base, athletes: many }, "too_many_athletes"],
    [{ ...base, athletes: [{ athleteId: s.athletes[0], expectedDecisionId: null }, { athleteId: s.athletes[0].toUpperCase(), expectedDecisionId: null }] }, "duplicate_athlete"],
    [{ ...base, athletes: [{ athleteId: s.athletes[0] }] }, "invalid_athletes"],
    [{ ...base, kind: "cleared", athletes: [{ athleteId: s.athletes[0], expectedDecisionId: null }] }, "invalid_kind"],
  ];
  for (const [body, code] of cases) {
    const res = await bulk(s.activityId, s.coach.cookie, body);
    assert.deepEqual([res.status, res.body.error], [400, code], res.text);
  }
  const sixty = Array.from({ length: 60 }, (_, i) => ({ athleteId: i === 0 ? s.athletes[0] : crypto.randomUUID(), expectedDecisionId: null }));
  const refused = await bulk(s.activityId, s.coach.cookie, { ...base, athletes: sixty });
  assert.deepEqual([refused.status, refused.body.error], [409, "bulk_conflict"], "60 is accepted as a size (then refused for the unknown athletes)");
  assert.equal(refused.body.failed.length, 59);
  assert.deepEqual(await rowCounts(), before);
});

test("18. bulk is all or nothing and names every athlete that failed, with its current state", async () => {
  const s = await measuredSession("Bulk atomic");
  const extra = await makeAthlete("Bulk extra");
  await addMembership({ athleteId: extra, clubId: s.clubId, teamId: s.teamId });
  const d = (await put(s.activityId, extra, s.coach.cookie, pnv())).body.decision.id;
  const outsider = await makeAthlete("Bulk outsider");
  const before = await rowCounts();
  const res = await bulk(s.activityId, s.coach.cookie, {
    kind: "did_not_participate", reasonKey: "illness", requestKey: key(),
    athletes: [
      { athleteId: s.ids[103], expectedDecisionId: null }, // fine
      { athleteId: s.ids[101], expectedDecisionId: null }, // measured
      { athleteId: outsider, expectedDecisionId: null }, // not on the roster
      { athleteId: extra, expectedDecisionId: null }, // stale: has d
    ],
  });
  assert.deepEqual([res.status, res.body.error], [409, "bulk_conflict"], res.text);
  const byId = Object.fromEntries(res.body.failed.map((f) => [f.athleteId, f]));
  assert.equal(Object.keys(byId).length, 3);
  assert.equal(byId[s.ids[101]].error, "measured_record_exists");
  assert.equal(byId[s.ids[101]].current.state, "measured");
  assert.equal(byId[outsider].error, "not_on_roster");
  assert.equal(byId[extra].error, "decision_changed");
  assert.equal(byId[extra].current.decision.id, d);
  assert.deepEqual(await rowCounts(), before, "nothing was saved, not even for 103");
  const ok = await bulk(s.activityId, s.coach.cookie, {
    kind: "did_not_participate", reasonKey: "illness", requestKey: key(),
    athletes: [{ athleteId: s.ids[103], expectedDecisionId: null }, { athleteId: extra, expectedDecisionId: d }],
  });
  assert.equal(ok.status, 200, ok.text);
});

test("19. bulk retry and reuse", async () => {
  const s = await plainSession("Bulk retry", 2);
  const body = { kind: "participated_no_values", athletes: s.athletes.map((athleteId) => ({ athleteId, expectedDecisionId: null })), requestKey: key() };
  const first = await bulk(s.activityId, s.coach.cookie, body);
  assert.equal(first.status, 200);
  const before = await rowCounts();
  const again = await bulk(s.activityId, s.coach.cookie, { ...body, athletes: [...body.athletes].reverse() });
  assert.deepEqual([again.status, again.body], [200, first.body], "the order of the list does not change the request");
  const reused = await bulk(s.activityId, s.coach.cookie, { ...body, kind: "did_not_participate", reasonKey: "other" });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);
  assert.deepEqual(await rowCounts(), before);
});

// ---------------------------------------------------------------------------
// 20-24. Authorization
// ---------------------------------------------------------------------------
test("20. team coach, the team's club admin and a platform admin decide with the basis of their active workspace", async () => {
  const s = await plainSession("Bases", 3);
  const clubAdmin = await clubAdminOf(s.clubId);
  const padmin = await platformAdmin();
  const results = [];
  for (const [who, athleteId, basis] of [[s.coach, s.athletes[0], "team_coach"], [clubAdmin, s.athletes[1], "club_admin"], [padmin, s.athletes[2], "platform_admin"]]) {
    const res = await put(s.activityId, athleteId, who.cookie, pnv());
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.decision.decidedBy.basis, basis);
    results.push([athleteId, basis]);
  }
  const stored = await q(`select athlete_id, decided_by_basis from training.activity_athlete_decisions where activity_id = $1`, [s.activityId]);
  assert.deepEqual(stored.map((r) => [r.athlete_id, r.decided_by_basis]).sort(), results.sort());
  // A platform admin who is ALSO the team's coach, active in the team
  // workspace, decides as team_coach (the active path, not the stronger role).
  const both = await coachOf(s.teamId, "Coach and admin");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [both.id]);
  const done = await completeNow(s.activityId, both.cookie);
  assert.equal(done.status, 200, done.text);
  assert.equal((await completionOf(s.activityId)).completed_by_basis, "team_coach");
});

test("21. everyone outside the active-workspace path gets the identical 404 on every command, and nothing is written", async () => {
  const s = await plainSession("Outside", 1);
  const other = await makeTeam("Other");
  const otherCoach = await coachOf(other.teamId, "Other coach");
  const otherClubAdmin = await clubAdminOf(other.clubId, "Other club admin");
  // Multi-role users whose ACTIVE workspace is elsewhere (the resolver only
  // keeps a saved workspace the user really has, so each one also coaches
  // the other team): a role that would allow the write never stands in for
  // the active path.
  const alsoCoachOfOther = async (userId) => {
    await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [userId, other.teamId]);
    await setWorkspace(userId, "team", other.teamId);
  };
  const wrongWorkspace = await coachOf(s.teamId, "Coach active in another team");
  await alsoCoachOfOther(wrongWorkspace.id);
  const clubAdminInTeamWs = await clubAdminOf(s.clubId, "Club admin active in another team");
  await alsoCoachOfOther(clubAdminInTeamWs.id);
  const padminInTeamWs = await platformAdmin("Platform admin active in another team");
  await alsoCoachOfOther(padminInTeamWs.id);
  const nobody = await withCookie(await makeUser("Nobody"));
  const archived = await plainSession("Archived team", 1);
  await q(`update public.teams set is_active = false where id = $1`, [archived.teamId]);
  const missing = crypto.randomUUID();
  const calls = (activityId, athleteId, cookie) => [
    put(activityId, athleteId, cookie, dnp()),
    del(activityId, athleteId, cookie, { expectedDecisionId: crypto.randomUUID(), requestKey: key() }),
    bulk(activityId, cookie, { kind: "participated_no_values", athletes: [{ athleteId, expectedDecisionId: null }], requestKey: key() }),
    complete(activityId, cookie, { expectedRevision: 0, expectedFingerprint: "a".repeat(64), requestKey: key() }),
    reopen(activityId, cookie, { expectedRevision: 0, reason: "x", requestKey: key() }),
  ];
  const before = await rowCounts();
  const reference = await Promise.all(calls(missing, s.athletes[0], s.coach.cookie));
  for (const res of reference) assert.deepEqual([res.status, res.text], [404, JSON.stringify({ error: "notFound" })]);
  const malformed = await put("not-a-uuid", s.athletes[0], s.coach.cookie, dnp());
  assert.deepEqual([malformed.status, malformed.text], [404, reference[0].text]);
  for (const who of [otherCoach, otherClubAdmin, wrongWorkspace, clubAdminInTeamWs, padminInTeamWs, nobody]) {
    for (const res of await Promise.all(calls(s.activityId, s.athletes[0], who.cookie))) {
      assert.deepEqual([res.status, res.text], [404, reference[0].text], `${who.id}`);
    }
  }
  for (const res of await Promise.all(calls(archived.activityId, archived.athletes[0], archived.coach.cookie))) {
    assert.deepEqual([res.status, res.text], [404, reference[0].text], "archived team");
  }
  assert.deepEqual(await rowCounts(), before);
});

test("22. a session that is not team-owned: roster_not_applicable for its manager, the 404 for everyone else", async () => {
  const { clubId, teamId } = await makeTeam("Club session");
  const clubAdmin = await clubAdminOf(clubId);
  const coach = await coachOf(teamId);
  const activityId = await makeActivity({ ownerScope: "club", clubId });
  const athleteId = await makeAthlete("Club session athlete");
  const res = await put(activityId, athleteId, clubAdmin.cookie, dnp());
  assert.deepEqual([res.status, res.body.error], [409, "roster_not_applicable"]);
  const other = await put(activityId, athleteId, coach.cookie, dnp());
  assert.deepEqual([other.status, other.body], [404, { error: "notFound" }]);
});

test("23. a right lost between the request's start and its lock is 403 not_a_team_coach, and nothing is written", async () => {
  const s = await plainSession("Race right", 1);
  const before = await rowCounts();
  commands.setRosterCommandTestHooks({
    beforeLocks: async () => { await q(`update public.user_team_roles set is_active = false where user_id = $1`, [s.coach.id]); },
  });
  try {
    const res = await put(s.activityId, s.athletes[0], s.coach.cookie, dnp());
    assert.deepEqual([res.status, res.body.error], [403, "not_a_team_coach"], res.text);
  } finally {
    commands.setRosterCommandTestHooks(null);
  }
  assert.deepEqual(await rowCounts(), before);
});

test("24. archiving the team or the club, removing the role and deactivating the user wait for the deciding transaction", async () => {
  const cases = [
    ["team archive", (s) => [`update public.teams set is_active = false where id = $1`, [s.teamId]]],
    ["club archive (club admin)", (s) => [`update public.clubs set is_active = false where id = $1`, [s.clubId]], "club"],
    ["role removal", (s) => [`update public.user_team_roles set is_active = false where user_id = $1`, [s.coach.id]]],
    ["user deactivation", (s) => [`update public.users set is_active = false where id = $1`, [s.coach.id]]],
  ];
  for (const [label, statement, via] of cases) {
    const s = await plainSession(`Wait ${label}`, 1);
    const who = via === "club" ? await clubAdminOf(s.clubId) : s.coach;
    const paused = gate();
    const reached = gate();
    commands.setRosterCommandTestHooks({ beforeCommit: async () => { reached.open(); await paused.promise; } });
    const request = put(s.activityId, s.athletes[0], who.cookie, dnp());
    await reached.promise;
    const other = await newClient();
    const [sql, params] = statement(via === "club" ? s : s);
    const adminWrite = other.query(sql, params).then(() => Date.now());
    try {
      const waiting = await waitForLockWaiters(/^update public\./);
      assert.ok(waiting.length >= 1, `${label}: the admin write waits`);
      const releasedAt = Date.now();
      paused.open();
      const res = await request;
      assert.equal(res.status, 200, `${label}: ${res.text}`);
      const writtenAt = await adminWrite;
      assert.ok(writtenAt >= releasedAt, `${label}: the admin write finished only after the decision committed`);
    } finally {
      commands.setRosterCommandTestHooks(null);
      paused.open();
      await other.end();
    }
    assert.equal((await q(`select count(*)::int as n from training.activity_athlete_decisions where activity_id = $1`, [s.activityId]))[0].n, 1, label);
  }
});

// ---------------------------------------------------------------------------
// 25-28. Concurrency (controlled connections, observed waits)
// ---------------------------------------------------------------------------
test("25. two coaches with the same expectedDecisionId: both wait on the team lock, exactly one wins", async () => {
  const s = await plainSession("Two coaches", 1);
  const second = await coachOf(s.teamId, "Second coach");
  const d1 = (await put(s.activityId, s.athletes[0], s.coach.cookie, dnp())).body.decision.id;
  const holder = await newClient();
  await holder.query("begin");
  await lockTeamForImport(holder, s.teamId);
  const a = put(s.activityId, s.athletes[0], s.coach.cookie, pnv({ expectedDecisionId: d1 }));
  const b = put(s.activityId, s.athletes[0], second.cookie, dnp({ reasonKey: "other", expectedDecisionId: d1 }));
  try {
    await waitForLockWaiters(/pg_advisory_xact_lock/, 2);
  } finally {
    await holder.query("commit");
    await holder.end();
  }
  const results = await Promise.all([a, b]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409], results.map((r) => r.text).join(" | "));
  assert.equal(results.find((r) => r.status === 409).body.error, "decision_changed");
  const current = await q(`select id from training.activity_athlete_decisions where athlete_id = $1 and superseded_by_decision_id is null`, [s.athletes[0]]);
  assert.deepEqual(current.map((c) => c.id), [results.find((r) => r.status === 200).body.decision.id]);
  assert.equal((await completionOf(s.activityId)).revision, 2, "one more revision, not two");
});

test("26. a decision waits for an uncommitted import of the same team, then sees its measured value", async () => {
  const s = await measuredSession("Import race");
  const importer = await newClient();
  await importer.query("begin");
  await lockTeamForImport(importer, s.teamId);
  await importGpexePlanLocked(importer, buildGpexeImportPlan(bundleFor(s.sessionId, { oneTrack103: true })), {
    ownerTeamId: s.teamId, performedByUserId: s.userId, athleteIdByGpexeId: s.ids, batchFilename: "race",
  });
  const request = put(s.activityId, s.ids[103], s.coach.cookie, dnp());
  try {
    await waitForLockWaiters(/pg_advisory_xact_lock/);
    await importer.query("commit");
  } finally {
    await importer.end();
  }
  const res = await request;
  assert.deepEqual([res.status, res.body.error], [409, "measured_record_exists"], res.text);
  assert.equal((await q(`select count(*)::int as n from training.activity_athlete_decisions where athlete_id = $1`, [s.ids[103]]))[0].n, 0);
});

test("27. Complete and a roster writer serialize on the activity's completion lock, in both orders", async () => {
  // (a) The writer is first and uncommitted: Complete waits, then sees the
  // change and refuses (the roster it was sent for is gone).
  const s = await measuredSession("Complete race");
  await put(s.activityId, s.ids[103], s.coach.cookie, pnv());
  const view = await roster(s.activityId, s.coach.cookie);
  const writer = await newClient();
  await writer.query("begin");
  await nullCurrentOccasions(s.ids[101], s.summary.eventId)(writer);
  const req = complete(s.activityId, s.coach.cookie, { expectedRevision: view.body.completion.revision, expectedFingerprint: view.body.rosterFingerprint, requestKey: key() });
  try {
    await waitForLockWaiters(/lock_roster_completions/);
    await writer.query("commit");
  } finally {
    await writer.end();
  }
  const res = await req;
  assert.deepEqual([res.status, res.body.error], [409, "roster_changed"], res.text);

  // (b) Complete is first and holds its lock: the writer waits, then
  // downgrades the session it now sees complete.
  const s2 = await plainSession("Complete first", 1);
  await put(s2.activityId, s2.athletes[0], s2.coach.cookie, pnv());
  const conn2 = (await q(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('test-src','team',$1) returning id`, [s2.teamId]))[0].id;
  const paused = gate();
  const reached = gate();
  commands.setRosterCommandTestHooks({ beforeCommit: async ({ operation }) => { if (operation === "complete") { reached.open(); await paused.promise; } } });
  const completing = completeNow(s2.activityId, s2.coach.cookie);
  await reached.promise;
  const w2 = await newClient();
  const writing = w2.query(
    `insert into training.activity_source_observations (activity_id, athlete_id, source_connection_id, kind, reason_code) values ($1,$2,$3,'record_unusable','needs_manual_review')`,
    [s2.activityId, s2.athletes[0], conn2],
  );
  try {
    await waitForLockWaiters(/insert into training\.activity_source_observations/);
    paused.open();
    assert.equal((await completing).status, 200);
    await writing;
  } finally {
    commands.setRosterCommandTestHooks(null);
    paused.open();
    await w2.end();
  }
  const c = await completionOf(s2.activityId);
  assert.deepEqual([c.status, c.needs_review_causes], ["needs_review", ["record_unusable"]]);
});

test("28. Complete and a membership change of the team serialize on the team's roster lock", async () => {
  const s = await plainSession("Membership race", 2);
  for (const a of s.athletes) await put(s.activityId, a, s.coach.cookie, pnv());
  const paused = gate();
  const reached = gate();
  commands.setRosterCommandTestHooks({ beforeCommit: async ({ operation }) => { if (operation === "complete") { reached.open(); await paused.promise; } } });
  const completing = completeNow(s.activityId, s.coach.cookie);
  await reached.promise;
  const newcomer = await makeAthlete("Newcomer");
  const settings = await newClient();
  const adding = settings.query(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`,
    [newcomer, s.clubId, s.teamId],
  );
  try {
    await waitForLockWaiters(/insert into public\.athlete_memberships/);
    paused.open();
    assert.equal((await completing).status, 200);
    await adding;
  } finally {
    commands.setRosterCommandTestHooks(null);
    paused.open();
    await settings.end();
  }
  const c = await completionOf(s.activityId);
  assert.deepEqual([c.status, c.needs_review_causes], ["needs_review", ["roster_changed"]]);
  const r = await roster(s.activityId, s.coach.cookie);
  assert.equal(r.body.athletes.find((a) => a.athleteId === newcomer).state, "unknown", "the newcomer needs a state");
});

// ---------------------------------------------------------------------------
// 29-33. Complete and Reopen
// ---------------------------------------------------------------------------
test("29. Complete is refused while somebody needs a state, on a stale revision, on a changed roster and on an empty roster", async () => {
  const s = await measuredSession("Complete refuse");
  const view = await roster(s.activityId, s.coach.cookie);
  const before = await rowCounts();
  const bad = [
    [{ expectedRevision: -1, expectedFingerprint: view.body.rosterFingerprint, requestKey: key() }, 400, "invalid_expected_revision"],
    [{ expectedRevision: 0, expectedFingerprint: "xyz", requestKey: key() }, 400, "invalid_expected_fingerprint"],
    [{ expectedRevision: 0, expectedFingerprint: view.body.rosterFingerprint }, 400, "invalid_request_key"],
  ];
  for (const [body, status, code] of bad) {
    const res = await complete(s.activityId, s.coach.cookie, body);
    assert.deepEqual([res.status, res.body.error], [status, code]);
  }
  const incomplete = await complete(s.activityId, s.coach.cookie, { expectedRevision: 0, expectedFingerprint: view.body.rosterFingerprint, requestKey: key() });
  assert.deepEqual([incomplete.status, incomplete.body.error, incomplete.body.needsStateAthleteIds], [409, "roster_incomplete", [s.ids[103]]]);
  assert.deepEqual(await rowCounts(), before, "a refused Complete writes nothing");

  await put(s.activityId, s.ids[103], s.coach.cookie, pnv());
  const stale = await complete(s.activityId, s.coach.cookie, { expectedRevision: 0, expectedFingerprint: view.body.rosterFingerprint, requestKey: key() });
  assert.deepEqual([stale.status, stale.body.error, stale.body.revision], [409, "revision_changed", 1]);

  // The fingerprint catches a change that moved no revision: a new member
  // of the team on a session that is not complete.
  const fresh = await roster(s.activityId, s.coach.cookie);
  const extra = await makeAthlete("Late observation");
  await addMembership({ athleteId: extra, clubId: s.clubId, teamId: s.teamId });
  const changed = await complete(s.activityId, s.coach.cookie, { expectedRevision: fresh.body.completion.revision, expectedFingerprint: fresh.body.rosterFingerprint, requestKey: key() });
  assert.deepEqual([changed.status, changed.body.error], [409, "roster_changed"]);

  const empty = await makeTeam("Empty");
  const emptyCoach = await coachOf(empty.teamId);
  const emptyActivity = await makeActivity({ teamId: empty.teamId });
  const e = await completeNow(emptyActivity, emptyCoach.cookie);
  assert.deepEqual([e.status, e.body.error], [409, "roster_empty"]);
});

test("30. Complete stores who, when, the basis and the fingerprint, and logs it in the same transaction", async () => {
  const s = await measuredSession("Complete ok");
  await put(s.activityId, s.ids[103], s.coach.cookie, dnp());
  const view = await roster(s.activityId, s.coach.cookie);
  assert.equal(view.body.canComplete, true);
  const body = { expectedRevision: view.body.completion.revision, expectedFingerprint: view.body.rosterFingerprint, requestKey: key() };
  const res = await complete(s.activityId, s.coach.cookie, body);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.completion.status, "complete");
  assert.equal(res.body.completion.completedBy.userId, s.coach.id);
  assert.equal(res.body.completion.completedBy.basis, "team_coach");
  const row = await completionOf(s.activityId);
  assert.equal(row.input_fingerprint, view.body.rosterFingerprint);
  assert.equal(row.revision, 2);
  const log = await logOf(s.activityId);
  const last = log[log.length - 1];
  assert.deepEqual([last.revision, last.from_status, last.to_status, last.cause, last.performed_by_user_id], [2, "not_complete", "complete", "completed", s.coach.id]);
  assert.deepEqual(last.detail, { basis: "team_coach", fingerprint: view.body.rosterFingerprint });
  const reqRow = (await q(`select id, operation from training.activity_roster_requests where id = $1`, [last.request_id]))[0];
  assert.equal(reqRow.operation, "complete");
  const after = await roster(s.activityId, s.coach.cookie);
  assert.deepEqual([after.body.completion.status, after.body.canComplete], ["complete", false]);
  const again = await complete(s.activityId, s.coach.cookie, { ...body, requestKey: key(), expectedRevision: 2 });
  assert.deepEqual([again.status, again.body.error], [409, "already_complete"]);
  const replay = await complete(s.activityId, s.coach.cookie, body);
  assert.deepEqual([replay.status, replay.body], [200, res.body], "a lost answer is retried safely");
});

test("31. Complete on a session whose athletes are all measured creates the completion row at revision 1", async () => {
  const team = await gpexeTeam("All measured");
  sessionSeq += 1;
  const summary = await importDirect(team, bundleFor(sessionSeq, { oneTrack103: true }));
  assert.equal(await completionOf(summary.activityId), null);
  const res = await completeNow(summary.activityId, team.coach.cookie);
  assert.equal(res.status, 200, res.text);
  const row = await completionOf(summary.activityId);
  assert.deepEqual([row.status, row.revision], ["complete", 1]);
  assert.deepEqual((await logOf(summary.activityId)).map((l) => [l.revision, l.from_status, l.cause]), [[1, "not_complete", "completed"]]);
});

test("32. Reopen needs a reason and a complete or needs-review session, keeps every decision and logs who and why", async () => {
  const s = await measuredSession("Reopen");
  await put(s.activityId, s.ids[103], s.coach.cookie, dnp());
  const notYet = await reopen(s.activityId, s.coach.cookie, { expectedRevision: 1, reason: "why", requestKey: key() });
  assert.deepEqual([notYet.status, notYet.body.error], [409, "not_complete"]);
  const done = await completeNow(s.activityId, s.coach.cookie);
  const revision = done.body.completion.revision;
  for (const [body, code] of [[{ expectedRevision: revision, requestKey: key() }, "reason_required"], [{ expectedRevision: revision, reason: "   ", requestKey: key() }, "reason_required"], [{ expectedRevision: revision, reason: "x".repeat(501), requestKey: key() }, "reason_too_long"]]) {
    const res = await reopen(s.activityId, s.coach.cookie, body);
    assert.deepEqual([res.status, res.body.error], [400, code]);
  }
  const stale = await reopen(s.activityId, s.coach.cookie, { expectedRevision: revision - 1, reason: "late data", requestKey: key() });
  assert.deepEqual([stale.status, stale.body.error], [409, "revision_changed"]);
  const decisionsBefore = await q(`select id, superseded_by_decision_id from training.activity_athlete_decisions where activity_id = $1 order by id`, [s.activityId]);
  const res = await reopen(s.activityId, s.coach.cookie, { expectedRevision: revision, reason: "  GPEXE resent the file  ", requestKey: key() });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.body.completion.status, res.body.completion.revision, res.body.completion.completedBy], ["not_complete", revision + 1, null]);
  assert.deepEqual(await q(`select id, superseded_by_decision_id from training.activity_athlete_decisions where activity_id = $1 order by id`, [s.activityId]), decisionsBefore, "decisions untouched");
  const last = (await logOf(s.activityId)).at(-1);
  assert.deepEqual([last.from_status, last.to_status, last.cause, last.performed_by_user_id, last.detail], ["complete", "not_complete", "reopened", s.coach.id, { basis: "team_coach", reason: "GPEXE resent the file" }]);
  assert.equal((await completeNow(s.activityId, s.coach.cookie)).status, 200, "and it can be completed again");
});

test("33. a needs-review session can be completed again (causes cleared) or reopened", async () => {
  const s = await completedMeasured("Complete again");
  const conn = s.summary.connectionId;
  await recordObservation(s.activityId, s.ids[103], conn, "change_pending");
  const c = await completionOf(s.activityId);
  assert.equal(c.status, "needs_review");
  const res = await completeNow(s.activityId, s.coach.cookie);
  assert.equal(res.status, 200, res.text);
  const after = await completionOf(s.activityId);
  assert.deepEqual([after.status, after.needs_review_causes], ["complete", []]);
  assert.equal((await logOf(s.activityId)).at(-1).from_status, "needs_review");
});

async function recordObservation(activityId, athleteId, connectionId, kind = "record_unusable") {
  return inTx(async (c) => (await c.query(
    `insert into training.activity_source_observations (activity_id, athlete_id, source_connection_id, kind, reason_code) values ($1,$2,$3,$4,'needs_manual_review') returning id`,
    [activityId, athleteId, connectionId, kind],
  )).rows[0].id);
}

// ---------------------------------------------------------------------------
// 34-52. The automatic complete -> needs_review, one test per cause, each
// with its mutation proof (the same write with that one trigger switched
// off leaves the session complete).
// ---------------------------------------------------------------------------
async function assertDowngraded(activityId, cause, { revisionBefore, athleteIds } = {}) {
  const c = await completionOf(activityId);
  assert.equal(c.status, "needs_review", `status after ${cause}`);
  assert.ok(c.needs_review_causes.includes(cause), `${cause} in ${c.needs_review_causes}`);
  assert.equal(c.completed_by_user_id, null);
  if (revisionBefore !== undefined) assert.equal(c.revision, revisionBefore + 1, "one revision for the change");
  const last = (await logOf(activityId)).at(-1);
  assert.deepEqual([last.from_status, last.to_status, last.cause], ["complete", "needs_review", cause]);
  assert.equal(last.revision, c.revision);
  assert.ok(last.detail.completedAt, "the log keeps when it had been completed");
  if (athleteIds) assert.deepEqual([...last.detail.athleteIds].sort(), [...athleteIds].sort());
  const r = await api(`/api/training-activity/${activityId}/roster`, { cookie: (await coachCookieFor(activityId)) });
  assert.equal(r.body.completion.status, "needs_review", "GET shows it at once");
  assert.ok(r.body.completion.needsReviewCauses.includes(cause));
  assert.equal(r.body.completion.revision, c.revision);
}

const coachCookies = new Map();
async function coachCookieFor(activityId) {
  if (coachCookies.has(activityId)) return coachCookies.get(activityId);
  const teamId = (await q(`select owner_team_id from training.activities where id = training.resolve_canonical_activity_id($1)`, [activityId]))[0].owner_team_id;
  const coach = await coachOf(teamId, "Reader");
  coachCookies.set(activityId, coach.cookie);
  return coach.cookie;
}

async function assertStillComplete(activityId, label) {
  const c = await completionOf(activityId);
  assert.equal(c.status, "complete", `${label}: without its trigger the change leaves the session complete (mutation proof)`);
}

async function eventParticipantOf(eventId, athleteId) {
  return (await q(`select id from training_load.metric_event_participants where event_id = $1 and athlete_id = $2`, [eventId, athleteId]))[0]?.id;
}

test("34. decision_changed: a decision on a complete session", async () => {
  const s = await completedMeasured("Cause decision");
  const rev = (await completionOf(s.activityId)).revision;
  const d = (await q(`select id from training.activity_athlete_decisions where athlete_id = $1 and superseded_by_decision_id is null`, [s.ids[103]]))[0].id;
  const res = await put(s.activityId, s.ids[103], s.coach.cookie, dnp({ expectedDecisionId: d }));
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.completion.status, "needs_review");
  await assertDowngraded(s.activityId, "decision_changed", { revisionBefore: rev, athleteIds: [s.ids[103]] });

  const m = await completedMeasured("Cause decision mutation");
  const cur = (await q(`select id from training.activity_athlete_decisions where athlete_id = $1 and superseded_by_decision_id is null`, [m.ids[103]]))[0].id;
  await inTx(async (c) => {
    const id = crypto.randomUUID(); const req = crypto.randomUUID();
    await c.query(`update training.activity_athlete_decisions set superseded_by_decision_id = $2, superseded_at = now() where id = $1`, [cur, id]);
    await c.query(`insert into training.activity_athlete_decisions (id, activity_id, athlete_id, owner_team_id, request_id, decision_kind, reason_key, decided_by_user_id, decided_by_basis)
                   values ($1,$2,$3,$4,$5,'did_not_participate','illness',$6,'team_coach')`, [id, m.activityId, m.ids[103], m.teamId, req, m.coach.id]);
    await c.query(`insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result) values ($1,$2,$3,$4,'decide',$5,'{}')`,
      [req, m.activityId, crypto.randomUUID(), "c".repeat(64), m.coach.id]);
  }, { disable: ["training.activity_athlete_decisions", "activity_athlete_decisions_roster_change"] });
  await assertStillComplete(m.activityId, "decision");
});

async function manualOccasion(client, eventParticipantId, userId) {
  return (await client.query(
    `insert into training_load.metric_measurement_occasions (event_participant_id, entry_method, recorded_by_user_id) values ($1,'manual',$2) returning id`,
    [eventParticipantId, userId],
  )).rows[0].id;
}

test("35. measurement_changed: a new occasion for a participant of a complete session", async () => {
  const s = await completedMeasured("Cause occasion");
  const rev = (await completionOf(s.activityId)).revision;
  const ep = await eventParticipantOf(s.summary.eventId, s.ids[101]);
  await inTx((c) => manualOccasion(c, ep, s.coach.id));
  await assertDowngraded(s.activityId, "measurement_changed", { revisionBefore: rev, athleteIds: [s.ids[101]] });

  const m = await completedMeasured("Cause occasion mutation");
  const ep2 = await eventParticipantOf(m.summary.eventId, m.ids[101]);
  await inTx((c) => manualOccasion(c, ep2, m.coach.id), { disable: ["training_load.metric_measurement_occasions", "metric_measurement_occasions_roster_insert"] });
  await assertStillComplete(m.activityId, "occasion insert");
});

test("36. measurement_changed: an occasion stops (or starts) being effective", async () => {
  const setup = async (label) => {
    const s = await measuredSession(label);
    const ep = await eventParticipantOf(s.summary.eventId, s.ids[101]);
    const occ = await inTx((c) => manualOccasion(c, ep, s.coach.id));
    await resolveAndComplete(s.activityId, s.coach.cookie);
    return { ...s, occ };
  };
  const s = await setup("Cause occasion update");
  const rev = (await completionOf(s.activityId)).revision;
  await inTx((c) => c.query(`update training_load.metric_measurement_occasions set import_conflict_status = 'needs_review' where id = $1`, [s.occ]));
  await assertDowngraded(s.activityId, "measurement_changed", { revisionBefore: rev, athleteIds: [s.ids[101]] });

  const m = await setup("Cause occasion update mutation");
  await inTx((c) => c.query(`update training_load.metric_measurement_occasions set import_conflict_status = 'needs_review' where id = $1`, [m.occ]),
    { disable: ["training_load.metric_measurement_occasions", "metric_measurement_occasions_roster_update"] });
  await assertStillComplete(m.activityId, "occasion update");
});

const nullCurrentOccasions = (athleteId, eventId) => (c) => c.query(
  `update training_load.metric_source_identities si set current_occasion_id = null
     from training_load.metric_measurement_occasions o join training_load.metric_event_participants p on p.id = o.event_participant_id
    where si.current_occasion_id = o.id and p.athlete_id = $1 and p.event_id = $2`, [athleteId, eventId]);

test("37. measurement_changed: a source identity's current occasion changes", async () => {
  const s = await completedMeasured("Cause current");
  const rev = (await completionOf(s.activityId)).revision;
  await inTx(nullCurrentOccasions(s.ids[101], s.summary.eventId));
  await assertDowngraded(s.activityId, "measurement_changed", { revisionBefore: rev, athleteIds: [s.ids[101]] });

  const m = await completedMeasured("Cause current mutation");
  await inTx(nullCurrentOccasions(m.ids[101], m.summary.eventId), { disable: ["training_load.metric_source_identities", "metric_source_identities_roster_update"] });
  await assertStillComplete(m.activityId, "current occasion");
});

// A metric participant for 103 in the session's event, an activity
// participant for 103, and a link between them with the given status.
async function linkAthlete103(c, s, status) {
  const ep = (await c.query(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot) values ($1,$2,$3) returning id`, [s.summary.eventId, s.ids[103], TZ])).rows[0].id;
  const ap = (await c.query(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot) values ($1,$2,'2026-09-14',$3) returning id`, [s.activityId, s.ids[103], TZ])).rows[0].id;
  const link = (await c.query(
    `insert into training.activity_participant_metric_participant_links (activity_participant_id, metric_event_participant_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
     values ($1,$2,'manual',$3::varchar,$4,case when $3::varchar = 'confirmed' then now() end,$4) returning id`,
    [ap, ep, status, s.coach.id],
  )).rows[0].id;
  return link;
}

test("38. link_changed: a confirmed participant link is added", async () => {
  const s = await completedMeasured("Cause plink");
  const rev = (await completionOf(s.activityId)).revision;
  await inTx((c) => linkAthlete103(c, s, "confirmed"));
  await assertDowngraded(s.activityId, "link_changed", { revisionBefore: rev, athleteIds: [s.ids[103]] });

  const m = await completedMeasured("Cause plink mutation");
  await inTx((c) => linkAthlete103(c, m, "confirmed"), { disable: ["training.activity_participant_metric_participant_links", "activity_participant_metric_links_roster_insert"] });
  await assertStillComplete(m.activityId, "participant link insert");
});

test("39. link_changed: a participant link's status changes (suggested -> confirmed)", async () => {
  const setup = async (label) => {
    const s = await measuredSession(label);
    const link = await inTx((c) => linkAthlete103(c, s, "suggested"));
    await resolveAndComplete(s.activityId, s.coach.cookie);
    return { ...s, link };
  };
  const confirm = (s) => (c) => c.query(`update training.activity_participant_metric_participant_links set link_status = 'confirmed', confirmed_by_user_id = $2, confirmed_at = now() where id = $1`, [s.link, s.coach.id]);
  const s = await setup("Cause plink status");
  const rev = (await completionOf(s.activityId)).revision;
  await inTx(confirm(s));
  await assertDowngraded(s.activityId, "link_changed", { revisionBefore: rev, athleteIds: [s.ids[103]] });

  const m = await setup("Cause plink status mutation");
  await inTx(confirm(m), { disable: ["training.activity_participant_metric_participant_links", "activity_participant_metric_links_roster_update"] });
  await assertStillComplete(m.activityId, "participant link update");
});

async function bareEvent(c, teamId) {
  return (await c.query(`insert into training_load.metric_events (occurred_date, scope_level, owner_scope, owner_team_id) values ('2026-09-14','session','team',$1) returning id`, [teamId])).rows[0].id;
}
const eventLink = (s, status) => async (c) => {
  const eventId = await bareEvent(c, s.teamId);
  return (await c.query(
    `insert into training.activity_metric_event_links (activity_id, metric_event_id, link_method, link_status, confirmed_by_user_id, confirmed_at, created_by_user_id)
     values ($1,$2,'manual',$3::varchar,$4,case when $3::varchar = 'confirmed' then now() end,$4) returning id`, [s.activityId, eventId, status, s.coach.id],
  )).rows[0].id;
};

test("40. link_changed: a confirmed metric event link is added to the session", async () => {
  const s = await completedMeasured("Cause elink");
  const rev = (await completionOf(s.activityId)).revision;
  await inTx(eventLink(s, "confirmed"));
  await assertDowngraded(s.activityId, "link_changed", { revisionBefore: rev, athleteIds: [] });

  const m = await completedMeasured("Cause elink mutation");
  await inTx(eventLink(m, "confirmed"), { disable: ["training.activity_metric_event_links", "activity_metric_event_links_roster_insert"] });
  await assertStillComplete(m.activityId, "event link insert");
});

test("41. link_changed: a metric event link's status changes (suggested -> confirmed)", async () => {
  const setup = async (label) => {
    const s = await measuredSession(label);
    const link = await inTx(eventLink(s, "suggested"));
    await resolveAndComplete(s.activityId, s.coach.cookie);
    return { ...s, link };
  };
  const confirm = (s) => (c) => c.query(`update training.activity_metric_event_links set link_status = 'confirmed', confirmed_by_user_id = $2, confirmed_at = now() where id = $1`, [s.link, s.coach.id]);
  const s = await setup("Cause elink status");
  const rev = (await completionOf(s.activityId)).revision;
  await inTx(confirm(s));
  await assertDowngraded(s.activityId, "link_changed", { revisionBefore: rev });

  const m = await setup("Cause elink status mutation");
  await inTx(confirm(m), { disable: ["training.activity_metric_event_links", "activity_metric_event_links_roster_update"] });
  await assertStillComplete(m.activityId, "event link update");
});

// A second session of the same team with plain participants (no metric
// links): `athleteIds` each get a participant there.
async function sideSession(s, athleteIds) {
  const other = await makeActivity({ teamId: s.teamId, name: "Side session" });
  const participants = {};
  for (const athleteId of athleteIds) {
    participants[athleteId] = (await q(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot) values ($1,$2,'2026-09-14',$3) returning id`, [other, athleteId, TZ]))[0].id;
  }
  return { other, participants };
}

test("42. roster_changed: a participant is reparented into (and out of) complete sessions", async () => {
  const s = await completedMeasured("Cause reparent");
  const side = await sideSession(s, [s.ids[103], s.ids[102]]);
  await resolveAndComplete(side.other, s.coach.cookie);
  const revA = (await completionOf(s.activityId)).revision;
  const revB = (await completionOf(side.other)).revision;
  await inTx((c) => c.query(`select training.reparent_activity_participant($1, $2, $3, 'test')`, [side.participants[s.ids[103]], s.activityId, s.coach.id]));
  await assertDowngraded(s.activityId, "roster_changed", { revisionBefore: revA, athleteIds: [s.ids[103]] });
  await assertDowngraded(side.other, "roster_changed", { revisionBefore: revB, athleteIds: [s.ids[103]] });

  const m = await completedMeasured("Cause reparent mutation");
  const side2 = await sideSession(m, [m.ids[103], m.ids[102]]);
  await inTx((c) => c.query(`select training.reparent_activity_participant($1, $2, $3, 'test')`, [side2.participants[m.ids[103]], m.activityId, m.coach.id]),
    { disable: ["training.activity_participants", "activity_participants_roster_update"] });
  await assertStillComplete(m.activityId, "reparent");
});

test("43. activity_merged: two participants of the same athlete are merged", async () => {
  const s = await completedMeasured("Cause pmerge");
  const side = await sideSession(s, [s.ids[101], s.ids[102]]);
  const target = (await q(`select id from training.activity_participants where activity_id = $1 and athlete_id = $2`, [s.activityId, s.ids[101]]))[0].id;
  const rev = (await completionOf(s.activityId)).revision;
  await inTx((c) => c.query(`select training.merge_activity_participants($1, $2, $3, 'test')`, [side.participants[s.ids[101]], target, s.coach.id]));
  await assertDowngraded(s.activityId, "activity_merged", { revisionBefore: rev, athleteIds: [s.ids[101]] });

  const m = await completedMeasured("Cause pmerge mutation");
  const side2 = await sideSession(m, [m.ids[101], m.ids[102]]);
  const target2 = (await q(`select id from training.activity_participants where activity_id = $1 and athlete_id = $2`, [m.activityId, m.ids[101]]))[0].id;
  await inTx((c) => c.query(`select training.merge_activity_participants($1, $2, $3, 'test')`, [side2.participants[m.ids[101]], target2, m.coach.id]),
    { disable: ["training.activity_participants", "activity_participants_roster_update"] });
  await assertStillComplete(m.activityId, "participant merge");
});

test("44. activity_merged: another session is merged into a complete one (the survivor is downgraded; the alias keeps its history)", async () => {
  const s = await completedMeasured("Cause supersede");
  const alias = await makeActivity({ teamId: s.teamId, name: "Duplicate session" });
  const rev = (await completionOf(s.activityId)).revision;
  await supersedeInto(alias, s.activityId);
  await assertDowngraded(s.activityId, "activity_merged", { revisionBefore: rev });

  const m = await completedMeasured("Cause supersede mutation");
  const alias2 = await makeActivity({ teamId: m.teamId, name: "Duplicate session" });
  await inTx(async (c) => {
    await c.query(`select set_config('training.allow_supersede_write', 'on', true)`);
    await c.query(`update training.activities set superseded_by_activity_id = $2, lifecycle_state = 'superseded' where id = $1`, [alias2, m.activityId]);
  }, { disable: ["training.activities", "activities_roster_update"] });
  await assertStillComplete(m.activityId, "activity supersede");
});

test("45. record_unusable: an observation is opened or resolved on a complete session", async () => {
  const s = await completedMeasured("Cause unusable");
  const rev = (await completionOf(s.activityId)).revision;
  const client = await newClient();
  try {
    await client.query("begin");
    await recordImportObservations(client, { activityId: s.activityId, sourceConnectionId: s.summary.connectionId, unusable: [{ athleteId: s.ids[103], reasonCode: "needs_manual_review" }] });
    await client.query("commit");
  } finally {
    await client.end();
  }
  await assertDowngraded(s.activityId, "record_unusable", { revisionBefore: rev, athleteIds: [s.ids[103]] });

  // Resolved on another complete session.
  const r = await measuredSession("Cause resolve");
  const obs = await recordObservation(r.activityId, r.ids[103], r.summary.connectionId);
  await resolveAndComplete(r.activityId, r.coach.cookie);
  const rev2 = (await completionOf(r.activityId)).revision;
  await inTx((c) => c.query(`update training.activity_source_observations set resolved_at = now() where id = $1`, [obs]));
  await assertDowngraded(r.activityId, "record_unusable", { revisionBefore: rev2, athleteIds: [r.ids[103]] });

  const m = await completedMeasured("Cause unusable mutation");
  await inTx((c) => c.query(`insert into training.activity_source_observations (activity_id, athlete_id, source_connection_id, kind, reason_code) values ($1,$2,$3,'record_unusable','needs_manual_review')`,
    [m.activityId, m.ids[103], m.summary.connectionId]), { disable: ["training.activity_source_observations", "activity_source_observations_roster_insert"] });
  await assertStillComplete(m.activityId, "observation insert");
  const m2 = await measuredSession("Cause resolve mutation");
  const obs2 = await recordObservation(m2.activityId, m2.ids[103], m2.summary.connectionId);
  await resolveAndComplete(m2.activityId, m2.coach.cookie);
  await inTx((c) => c.query(`update training.activity_source_observations set resolved_at = now() where id = $1`, [obs2]),
    { disable: ["training.activity_source_observations", "activity_source_observations_roster_update"] });
  await assertStillComplete(m2.activityId, "observation resolve");
});

test("46. change_pending: a newer version of the session is waiting", async () => {
  const s = await completedMeasured("Cause pending");
  const rev = (await completionOf(s.activityId)).revision;
  await recordObservation(s.activityId, s.ids[101], s.summary.connectionId, "change_pending");
  await assertDowngraded(s.activityId, "change_pending", { revisionBefore: rev, athleteIds: [s.ids[101]] });
  const r = await roster(s.activityId, s.coach.cookie);
  assert.equal(r.body.athletes.find((a) => a.athleteId === s.ids[101]).state, "measured_change_waiting");
});

test("47. roster_changed: a membership period opened or closed over a complete session's date", async () => {
  // Closed: the athlete's membership is archived as of before the session.
  const s = await completedMeasured("Cause membership close");
  const rev = (await completionOf(s.activityId)).revision;
  const archive = (athleteId, teamId) => (c) => c.query(
    `update public.athlete_memberships set status = 'archived', archived_at = '2026-09-10T00:00:00Z', updated_at = now() where athlete_id = $1 and team_id = $2`, [athleteId, teamId]);
  await inTx(archive(s.ids[103], s.teamId));
  await assertDowngraded(s.activityId, "roster_changed", { revisionBefore: rev, athleteIds: [s.ids[103]] });

  // Opened: a new member whose period covers the session.
  const o = await completedMeasured("Cause membership open");
  const rev2 = (await completionOf(o.activityId)).revision;
  const newcomer = await makeAthlete("Cause newcomer");
  await inTx((c) => c.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [newcomer, o.clubId, o.teamId]));
  await assertDowngraded(o.activityId, "roster_changed", { revisionBefore: rev2, athleteIds: [newcomer] });

  // A change outside the session's date leaves it complete.
  const n = await completedMeasured("Cause membership outside");
  const latecomer = await makeAthlete("Joins later still");
  await inTx((c) => c.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-10-01T00:00:00Z')`, [latecomer, n.clubId, n.teamId]));
  await assertStillComplete(n.activityId, "membership outside the date (not a mutation, a scope check)");

  const m = await completedMeasured("Cause membership mutation");
  await inTx(archive(m.ids[103], m.teamId), { disable: ["public.athlete_membership_periods", "athlete_membership_periods_roster_update"] });
  await assertStillComplete(m.activityId, "membership close");
  const m2 = await completedMeasured("Cause membership open mutation");
  const nc2 = await makeAthlete("Cause newcomer 2");
  await inTx((c) => c.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [nc2, m2.clubId, m2.teamId]),
    { disable: ["public.athlete_membership_periods", "athlete_membership_periods_roster_insert"] });
  await assertStillComplete(m2.activityId, "membership open");
});

test("48. input_changed: a change no trigger saw is reported by the read and written down by the next command", async () => {
  const s = await completedMeasured("Cause input");
  await inTx(nullCurrentOccasions(s.ids[101], s.summary.eventId), { disable: ["training_load.metric_source_identities", "metric_source_identities_roster_update"] });
  assert.equal((await completionOf(s.activityId)).status, "complete", "no trigger ran");
  const r = await roster(s.activityId, s.coach.cookie);
  assert.deepEqual([r.body.completion.status, r.body.completion.needsReviewCauses], ["needs_review", ["input_changed"]]);
  const rev = (await completionOf(s.activityId)).revision;
  const res = await put(s.activityId, s.ids[101], s.coach.cookie, pnv());
  assert.equal(res.status, 200, res.text);
  const c = await completionOf(s.activityId);
  assert.deepEqual([c.status, c.needs_review_causes, c.revision], ["needs_review", ["input_changed", "decision_changed"], rev + 2]);
  const log = (await logOf(s.activityId)).slice(-2);
  assert.deepEqual(log.map((l) => [l.from_status, l.to_status, l.cause]), [["complete", "needs_review", "input_changed"], ["needs_review", "needs_review", "decision_changed"]]);
});

test("49. no duplicate log rows for the same kind of change; a new kind adds one; nothing ever returns to complete by itself", async () => {
  const s = await completedMeasured("Dedupe");
  const rev = (await completionOf(s.activityId)).revision;
  const ep = await eventParticipantOf(s.summary.eventId, s.ids[101]);
  const ep2 = await eventParticipantOf(s.summary.eventId, s.ids[102]);
  await inTx(async (c) => { await manualOccasion(c, ep, s.coach.id); await manualOccasion(c, ep2, s.coach.id); });
  await inTx((c) => manualOccasion(c, ep, s.coach.id));
  let c1 = await completionOf(s.activityId);
  assert.deepEqual([c1.revision, c1.needs_review_causes], [rev + 1, ["measurement_changed"]], "three occasions, two transactions, one change recorded");
  await recordObservation(s.activityId, s.ids[103], s.summary.connectionId, "change_pending");
  c1 = await completionOf(s.activityId);
  assert.deepEqual([c1.revision, c1.needs_review_causes], [rev + 2, ["measurement_changed", "change_pending"]]);
  assert.equal((await logOf(s.activityId)).filter((l) => l.revision > rev).length, 2);
  // Undoing the change does not complete the session again.
  await inTx((c) => c.query(`update training.activity_source_observations set resolved_at = now() where activity_id = $1 and kind = 'change_pending'`, [s.activityId]));
  assert.equal((await completionOf(s.activityId)).status, "needs_review");
});

test("50. real writers are never blocked: a GPEXE re-import and a Settings archive on complete sessions succeed and downgrade", async () => {
  const s = await completedMeasured("Writer import");
  const summary = await importDirect(s, bundleFor(s.sessionId, { oneTrack103: true }));
  assert.equal(summary.activityId, s.activityId);
  const c = await completionOf(s.activityId);
  assert.equal(c.status, "needs_review");
  assert.ok(c.needs_review_causes.some((x) => ["measurement_changed", "link_changed"].includes(x)), c.needs_review_causes.join());
  const r = await roster(s.activityId, s.coach.cookie);
  const a103 = r.body.athletes.find((a) => a.athleteId === s.ids[103]);
  assert.ok(a103.flags.includes("measured_after_decision"), "the decision and the late measurement are both shown");

  const t = await completedMeasured("Writer archive");
  await q(`update public.athlete_memberships set status = 'archived', archived_at = '2026-09-01T00:00:00Z', updated_at = now() where athlete_id = $1 and team_id = $2`, [t.ids[102], t.teamId]);
  assert.equal((await completionOf(t.activityId)).status, "needs_review");
});

test("51. the downgrade is all or nothing with its writer: if its log cannot be written, the writer's transaction rolls back whole", async () => {
  const s = await completedMeasured("Safe pattern");
  const before = await rowCounts();
  const beforeCompletion = await completionOf(s.activityId);
  await q(`create function pg_temp_fail_log() returns trigger as $$ begin if new.cause <> 'completed' and new.cause <> 'decision_changed' then raise exception 'injected log failure'; end if; return new; end $$ language plpgsql`);
  await q(`create trigger zz_injected_log_failure before insert on training.activity_completion_log for each row execute function pg_temp_fail_log()`);
  try {
    await assert.rejects(recordObservation(s.activityId, s.ids[103], s.summary.connectionId), /injected log failure/);
    assert.deepEqual(await rowCounts(), before, "no observation, no completion change, no log row");
    assert.deepEqual(await completionOf(s.activityId), beforeCompletion, "still complete, as before the failed write");
    // A session that is not complete needs no log row: its writer is unaffected.
    const n = await measuredSession("Safe pattern not complete");
    await recordObservation(n.activityId, n.ids[103], n.summary.connectionId);
  } finally {
    await q(`drop trigger zz_injected_log_failure on training.activity_completion_log`);
    await q(`drop function pg_temp_fail_log()`);
  }
  await recordObservation(s.activityId, s.ids[103], s.summary.connectionId);
  await assertDowngraded(s.activityId, "record_unusable");
});

// ---------------------------------------------------------------------------
// 52. Raw SQL cannot bypass audit, basis, canonical identity or append-only
// (v26 guards), each with its mutation proof.
// ---------------------------------------------------------------------------
test("52. raw SQL cannot bypass the v26 rules, and each rule is what refuses it", async () => {
  const s = await measuredSession("Raw");
  const other = await makeActivity({ teamId: s.teamId, name: "Raw alias" });
  await put(s.activityId, s.ids[103], s.coach.cookie, pnv());
  const d103other = (await put(other, s.ids[103], s.coach.cookie, dnp())).body.decision.id;
  await supersedeInto(other, s.activityId);
  const outsiderUser = await makeUser("No right");
  const rev = (await completionOf(s.activityId)).revision;
  const reqRow = (await q(`select id from training.activity_roster_requests where activity_id = $1 limit 1`, [s.activityId]))[0].id;
  const completions = "training.activity_completions";
  const log = "training.activity_completion_log";
  const guards = [
    { name: "a completion change without its log row (at commit)", refused: /has no completion log row/, commit: true,
      run: (c) => c.query(`update ${completions} set revision = revision + 1 where activity_id = $1`, [s.activityId]), off: [completions, "activity_completions_audited"] },
    { name: "a completion row created at another revision than 1", refused: /created at revision 1/,
      run: async (c) => { const a = await makeActivity({ teamId: s.teamId }); await c.query(`insert into ${completions} (activity_id, owner_team_id, status, revision) values ($1,$2,'not_complete',0)`, [a, s.teamId]); }, off: [completions, "activity_completions_rules"] },
    { name: "complete while somebody needs a state", refused: /still needs a state/,
      // 103 holds two disagreeing decisions (a merge brought them together).
      run: async (c) => {
        await c.query(`update ${completions} set status = 'complete', revision = revision + 1, completed_by_user_id = $2, completed_by_basis = 'team_coach', completed_at = now(), input_fingerprint = repeat('d', 64) where activity_id = $1`, [s.activityId, s.coach.id]);
      }, off: [completions, "activity_completions_rules"] },
    { name: "a log row that describes no completion revision", refused: /does not describe completion revision/,
      run: (c) => c.query(`insert into ${log} (activity_id, request_id, revision, from_status, to_status, cause, performed_by_user_id) values ($1,$2,$3,'not_complete','not_complete','decision_changed',$4)`, [s.activityId, reqRow, rev + 5, s.coach.id]), off: [log, "activity_completion_log_rules"] },
    { name: "a status change the cause does not allow (roster_changed from not_complete)", refused: /only turns complete or needs_review into needs_review/,
      run: async (c) => {
        await c.query(`update ${completions} set status = 'needs_review', needs_review_causes = '{roster_changed}', revision = revision + 1 where activity_id = $1`, [s.activityId]);
        await c.query(`insert into ${log} (activity_id, revision, from_status, to_status, cause) values ($1,$2,'not_complete','needs_review','roster_changed')`, [s.activityId, rev + 1]);
      }, off: [log, "activity_completion_log_rules"] },
    { name: "one current decision per athlete in the whole alias set", refused: /already has a current decision in the alias set/,
      run: (c) => c.query(`insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis)
                           values ($1,$2,$3,$4,'participated_no_values',$5,'team_coach')`, [s.activityId, s.ids[103], s.teamId, crypto.randomUUID(), s.coach.id]),
      pre: `drop index training.activity_athlete_decisions_one_current`, off: ["training.activity_athlete_decisions", "activity_athlete_decisions_one_current_in_alias_set"] },
  ];
  // The alias set holds two current decisions for 103 (a merge brought them
  // together): the partial index cannot see across activities; v26 can.
  assert.ok(d103other);
  for (const g of guards) {
    const client = await newClient();
    try {
      await client.query("begin");
      if (g.pre) await client.query(g.pre);
      await assert.rejects((async () => { await g.run(client); if (g.commit) await client.query("set constraints all immediate"); })(), g.refused, `${g.name}: refused`);
      await client.query("rollback");
      await client.query("begin");
      if (g.pre) await client.query(g.pre);
      await client.query(`alter table ${g.off[0]} disable trigger ${g.off[1]}`);
      await assert.doesNotReject((async () => { await g.run(client); if (g.commit) await client.query("set constraints all immediate"); })(), `${g.name}: passes without its rule`);
      await client.query("rollback");
    } finally {
      await client.query("rollback").catch(() => {});
      await client.end();
    }
  }
  // Reopen / complete through raw SQL need a request, the user and a basis
  // the user holds (log rules + lock_activity_decider).
  const raw = async (cause, performedBy, detail, requestId) => inTx(async (c) => {
    const cur = (await c.query(`select revision, status from ${completions} where activity_id = $1`, [s.activityId])).rows[0];
    await c.query(`update ${completions} set status = 'not_complete', needs_review_causes = '{}', revision = revision + 1, completed_by_user_id = null, completed_by_basis = null, completed_at = null, input_fingerprint = null where activity_id = $1`, [s.activityId]);
    await c.query(`insert into ${log} (activity_id, request_id, revision, from_status, to_status, cause, performed_by_user_id, detail) values ($1,$2,$3,$4,'not_complete',$5,$6,$7)`,
      [s.activityId, requestId, cur.revision + 1, cur.status, cause, performedBy, JSON.stringify(detail)]);
  });
  await completeNow(s.activityId, s.coach.cookie).then((r) => assert.equal(r.status, 409, "103 has two disagreeing decisions: Complete refuses"));
  const cur = (await q(`select id from training.activity_athlete_decisions where athlete_id = $1 and superseded_by_decision_id is null and activity_id = $2`, [s.ids[103], s.activityId]))[0].id;
  await put(s.activityId, s.ids[103], s.coach.cookie, pnv({ expectedDecisionId: cur }));
  assert.equal((await completeNow(s.activityId, s.coach.cookie)).status, 200);
  await assert.rejects(raw("reopened", outsiderUser, { basis: "team_coach", reason: "x" }, reqRow), /may not decide/);
  await assert.rejects(raw("reopened", s.coach.id, { reason: "x" }, reqRow), /carries the basis/);
  await assert.rejects(raw("reopened", s.coach.id, { basis: "team_coach", reason: "x" }, null), /carries its request and user/);
  await assert.rejects(raw("reopened", s.coach.id, { basis: "team_coach" }, reqRow), /carries its reason/);
  await assert.rejects(raw("decision_changed", s.coach.id, {}, reqRow), /decision_changed is not complete -> not_complete/);
  assert.equal((await completionOf(s.activityId)).status, "complete", "every raw attempt rolled back");
  // A raw decision can never skip the revision and the log: the trigger writes them.
  const beforeLog = (await logOf(s.activityId)).length;
  await inTx(async (c) => {
    const d = (await c.query(`select id from training.activity_athlete_decisions where athlete_id = $1 and superseded_by_decision_id is null`, [s.ids[103]])).rows[0].id;
    const id = crypto.randomUUID(); const req = crypto.randomUUID();
    await c.query(`update training.activity_athlete_decisions set superseded_by_decision_id = $2, superseded_at = now() where id = $1`, [d, id]);
    await c.query(`insert into training.activity_athlete_decisions (id, activity_id, athlete_id, owner_team_id, request_id, decision_kind, reason_key, decided_by_user_id, decided_by_basis) values ($1,$2,$3,$4,$5,'did_not_participate','other',$6,'club_admin')`,
      [id, s.activityId, s.ids[103], s.teamId, req, s.coach.id]).catch((e) => { throw e; });
    await c.query(`insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result) values ($1,$2,$3,$4,'decide',$5,'{}')`, [req, s.activityId, crypto.randomUUID(), "e".repeat(64), s.coach.id]);
  }).then(() => assert.fail("a basis the coach does not hold is refused"), (e) => assert.match(e.message, /may not decide/));
  assert.equal((await logOf(s.activityId)).length, beforeLog);
});

// ---------------------------------------------------------------------------
// 53-55. Errors
// ---------------------------------------------------------------------------
test("53. an unexpected database error is internal_error without database text, and leaves nothing behind", async () => {
  const s = await plainSession("Internal", 1);
  await put(s.activityId, s.athletes[0], s.coach.cookie, pnv());
  const before = await rowCounts();
  await q(`create function pg_temp_secret() returns trigger as $$ begin raise exception 'SECRET_DB_TEXT_5a2 relation users password_hash'; end $$ language plpgsql`);
  await q(`create trigger zz_secret before insert on training.activity_roster_requests for each row execute function pg_temp_secret()`);
  try {
    const d = (await q(`select id from training.activity_athlete_decisions where activity_id = $1 and superseded_by_decision_id is null`, [s.activityId]))[0].id;
    for (const res of [
      await put(s.activityId, s.athletes[0], s.coach.cookie, dnp({ expectedDecisionId: d })),
      await bulk(s.activityId, s.coach.cookie, { kind: "participated_no_values", athletes: [{ athleteId: s.athletes[0], expectedDecisionId: d }], requestKey: key() }),
      await completeNow(s.activityId, s.coach.cookie),
    ]) {
      assert.equal(res.status, 500, res.text);
      assert.equal(res.body.error, "internal_error");
      assert.ok(!/SECRET_DB_TEXT|password_hash|relation/.test(res.text), res.text);
    }
  } finally {
    await q(`drop trigger zz_secret on training.activity_roster_requests`);
    await q(`drop function pg_temp_secret()`);
  }
  assert.deepEqual(await rowCounts(), before, "no request, decision, completion or log row from the failed requests");
});

test("54. a COMMIT whose outcome is unknown answers outcome_unknown; the retry with the same key saves it exactly once", async () => {
  const s = await plainSession("Commit lost", 1);
  const body = dnp();
  commands.setRosterCommandTestHooks({
    beforeCommit: async ({ client }) => {
      const pid = (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
      await q(`select pg_terminate_backend($1)`, [pid]);
      for (let i = 0; i < 200 && (await q(`select 1 from pg_stat_activity where pid = $1`, [pid])).length; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  });
  let res;
  try {
    res = await put(s.activityId, s.athletes[0], s.coach.cookie, body);
  } finally {
    commands.setRosterCommandTestHooks(null);
  }
  assert.deepEqual([res.status, res.body.error], [503, "outcome_unknown"], res.text);
  assert.equal((await q(`select count(*)::int as n from training.activity_athlete_decisions where activity_id = $1`, [s.activityId]))[0].n, 0, "the terminated transaction wrote nothing");
  const retry = await put(s.activityId, s.athletes[0], s.coach.cookie, body);
  assert.equal(retry.status, 200, retry.text);
  const again = await put(s.activityId, s.athletes[0], s.coach.cookie, body);
  assert.deepEqual(again.body, retry.body);
  assert.equal((await q(`select count(*)::int as n from training.activity_athlete_decisions where activity_id = $1`, [s.activityId]))[0].n, 1);
});

test("55. the SQL needs-state rule and the roster read agree", async () => {
  const s = await measuredSession("Agree");
  const extra = [];
  for (const label of ["Agree unknown", "Agree unusable", "Agree dnp", "Agree cleared", "Agree disagree"]) {
    const id = await makeAthlete(label);
    await addMembership({ athleteId: id, clubId: s.clubId, teamId: s.teamId });
    extra.push(id);
  }
  await recordObservation(s.activityId, extra[1], s.summary.connectionId);
  await put(s.activityId, extra[2], s.coach.cookie, dnp());
  const d = (await put(s.activityId, extra[3], s.coach.cookie, dnp())).body.decision.id;
  await del(s.activityId, extra[3], s.coach.cookie, { expectedDecisionId: d, requestKey: key() });
  const alias = await makeActivity({ teamId: s.teamId, name: "Agree alias" });
  await put(s.activityId, extra[4], s.coach.cookie, dnp());
  await put(alias, extra[4], s.coach.cookie, pnv());
  await supersedeInto(alias, s.activityId);
  const r = await roster(s.activityId, s.coach.cookie);
  const fromRead = r.body.athletes.filter((a) => a.group === "needs_state").map((a) => a.athleteId).sort();
  const fromSql = (await q(`select athlete_id from training.activity_roster_needs_state($1)`, [s.activityId])).map((x) => x.athlete_id).sort();
  assert.deepEqual(fromSql, fromRead);
  assert.deepEqual(fromRead, [s.ids[103], extra[0], extra[1], extra[3], extra[4]].sort());
});

// ---------------------------------------------------------------------------
// 56. Migration v26: apply, rollback, apply again (disposable copy of the
// schema at v25), and a v26 that fails at its last statement.
// ---------------------------------------------------------------------------
async function catalogDigest(client) {
  const rows = (await client.query(
    `select 'f:' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(pg_get_functiondef(p.oid)) as x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','training','training_load') and p.prokind = 'f'
     union all
     select 't:' || c.relname || '.' || t.tgname || '=' || t.tgenabled::text || md5(pg_get_triggerdef(t.oid))
       from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname in ('public','training','training_load')
     union all
     select 'i:' || schemaname || '.' || indexname || '=' || md5(indexdef) from pg_indexes where schemaname in ('public','training','training_load')
     order by 1`,
  )).rows.map((r) => r.x);
  return rows;
}

test("56. migration v26: applied by the runner on v25, the rollback returns the schema to v25 exactly and keeps every row, and v26 applies again", async () => {
  const upToV25 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V25) + 1);
  const m = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v26mig", migrations: upToV25 });
  const c = new pg.Client({ connectionString: m.url });
  await c.connect();
  try {
    assert.equal((await c.query("select current_database() as db")).rows[0].db, m.name);
    const v25 = await catalogDigest(c);
    await applyGpexeTestMigrations(m.url, [...upToV25, V26]);
    const v26 = await catalogDigest(c);
    assert.notDeepEqual(v26, v25);
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name like '%v26_activity_roster_decisions.sql'`)).rows[0].n, 1);
    // A row written under v26 survives the rollback (coach work is kept).
    const club = (await c.query(`insert into public.clubs (name) values ('Mig club') returning id`)).rows[0].id;
    const team = (await c.query(`insert into public.teams (club_id, name) values ($1,'Mig team') returning id`, [club])).rows[0].id;
    const athlete = (await c.query(`insert into public.athletes (full_name) values ('Mig athlete') returning id`)).rows[0].id;
    await c.query(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, starts_at) values ($1,$2,$3,'team','2026-01-01')`, [athlete, club, team]);
    const user = (await c.query(`insert into public.users (email) values ('mig@test.local') returning id`)).rows[0].id;
    await c.query(`insert into public.user_team_roles (user_id, team_id, role) values ($1,$2,'team_coach')`, [user, team]);
    const act = (await c.query(`insert into training.activities (name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_team_id, origin) values ('m','2026-09-14','2026-09-14T16:00:00Z','Europe/Sarajevo','team',$1,'manual') returning id`, [team])).rows[0].id;
    await c.query("begin");
    const req = crypto.randomUUID();
    await c.query(`insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis) values ($1,$2,$3,$4,'participated_no_values',$5,'team_coach')`, [act, athlete, team, req, user]);
    await c.query(`insert into training.activity_roster_requests (id, activity_id, request_key, request_hash, operation, performed_by_user_id, result) values ($1,$2,$3,$4,'decide',$5,'{}')`, [req, act, crypto.randomUUID(), "f".repeat(64), user]);
    await c.query("commit");
    const dataBefore = (await c.query(`select (select count(*) from training.activity_athlete_decisions) || '/' || (select count(*) from training.activity_completions) || '/' || (select count(*) from training.activity_completion_log) as n`)).rows[0].n;
    assert.equal(dataBefore, "1/1/1");

    await c.query(await fsp.readFile(ROLLBACK_SQL, "utf8"));
    assert.deepEqual(await catalogDigest(c), v25, "the rollback leaves exactly the v25 functions, triggers and indexes");
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name like '%v26_activity_roster_decisions.sql'`)).rows[0].n, 0);
    assert.equal((await c.query(`select (select count(*) from training.activity_athlete_decisions) || '/' || (select count(*) from training.activity_completions) || '/' || (select count(*) from training.activity_completion_log) as n`)).rows[0].n, dataBefore, "every row kept");

    await applyGpexeTestMigrations(m.url, [...upToV25, V26]);
    assert.deepEqual(await catalogDigest(c), v26, "v26 applies again, identically");

    // A v26 that fails at its very end leaves nothing and is not recorded.
    await c.query(await fsp.readFile(ROLLBACK_SQL, "utf8"));
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v26-fail-"));
    const dir = path.join(tempRoot, "migrations_v2");
    await fsp.mkdir(dir);
    try {
      for (const f of upToV25) await fsp.copyFile(path.resolve(__dirname, "../../migrations_v2", f), path.join(dir, f));
      const broken = `${await fsp.readFile(path.resolve(__dirname, "../../migrations_v2", V26), "utf8")}\nselect 1 / 0;\n`;
      await fsp.writeFile(path.join(dir, V26), broken, "utf8");
      await assert.rejects(runner.runMigrations({ databaseUrl: m.url, migrationsRoot: dir }), /ABORT while applying .*v26_activity_roster_decisions.sql.*22012/);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
    assert.deepEqual(await catalogDigest(c), v25, "a failed v26 leaves nothing behind");
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name like '%v26_activity_roster_decisions.sql'`)).rows[0].n, 0);
  } finally {
    await c.end();
    await m.drop();
  }
});

// ---------------------------------------------------------------------------
// 57-61. Regression tests for the code-reviewer's findings.
// ---------------------------------------------------------------------------
test("57. a merge into ANOTHER team's session between the unlocked resolve and the lock answers the identical 404, revealing nothing", async () => {
  const s = await plainSession("Race merge", 1);
  const other = await plainSession("Race other team", 1);
  const body = dnp();
  assert.equal((await put(s.activityId, s.athletes[0], s.coach.cookie, body)).status, 200, "a stored answer exists on the session");
  commands.setRosterCommandTestHooks({ beforeLocks: async () => { await supersedeInto(s.activityId, other.activityId); } });
  let fresh;
  let replay;
  try {
    fresh = await put(s.activityId, s.athletes[0], s.coach.cookie, pnv());
  } finally {
    commands.setRosterCommandTestHooks(null);
  }
  replay = await put(s.activityId, s.athletes[0], s.coach.cookie, body);
  for (const res of [fresh, replay]) {
    assert.deepEqual([res.status, res.text], [404, JSON.stringify({ error: "notFound" })], res.text);
    assert.ok(!res.text.includes(other.activityId));
  }
});

test("58. another user's requestKey is request_key_reused, never their stored answer", async () => {
  const s = await plainSession("Key owner", 1);
  const second = await coachOf(s.teamId, "Second coach key");
  const body = dnp();
  assert.equal((await put(s.activityId, s.athletes[0], s.coach.cookie, body)).status, 200);
  const before = await rowCounts();
  const res = await put(s.activityId, s.athletes[0], second.cookie, body);
  assert.deepEqual([res.status, res.body.error], [409, "request_key_reused"], res.text);
  assert.deepEqual(await rowCounts(), before);
});

test("59. a COMMIT that was applied but whose answer was lost is answered from the stored result, written once", async () => {
  const s = await plainSession("Commit applied", 1);
  const body = pnv();
  commands.setRosterCommandTestHooks({ afterCommit: async () => { throw new Error("answer lost after COMMIT"); } });
  let res;
  try {
    res = await put(s.activityId, s.athletes[0], s.coach.cookie, body);
  } finally {
    commands.setRosterCommandTestHooks(null);
  }
  assert.equal(res.status, 200, res.text);
  const stored = (await q(`select result from training.activity_roster_requests where activity_id = $1`, [s.activityId]))[0].result;
  assert.deepEqual(res.body, stored);
  assert.deepEqual((await put(s.activityId, s.athletes[0], s.coach.cookie, body)).body, stored);
  assert.equal((await q(`select count(*)::int as n from training.activity_athlete_decisions where activity_id = $1`, [s.activityId]))[0].n, 1);
});

test("60. a COMMIT refused by the database (a deferred check) is a certain rollback: internal_error, not outcome_unknown, nothing written", async () => {
  const s = await plainSession("Commit refused", 1);
  const before = await rowCounts();
  await q(`create function pg_temp_refuse_at_commit() returns trigger as $$ begin raise exception 'refused at commit'; end $$ language plpgsql`);
  await q(`create constraint trigger zz_refuse_at_commit after insert on training.activity_roster_requests deferrable initially deferred for each row execute function pg_temp_refuse_at_commit()`);
  let res;
  try {
    res = await put(s.activityId, s.athletes[0], s.coach.cookie, dnp());
  } finally {
    await q(`drop trigger zz_refuse_at_commit on training.activity_roster_requests`);
    await q(`drop function pg_temp_refuse_at_commit()`);
  }
  assert.deepEqual([res.status, res.body.error], [500, "internal_error"], res.text);
  assert.ok(!/refused at commit/.test(res.text));
  assert.deepEqual(await rowCounts(), before);
});

// The sanctioned correction of a confirmed session's time (v1).
const moveStart = (c, s) => c.query(
  `select training.correct_confirmed_activity_fields(a.id, a.occurred_local_date, '2026-09-14T17:00:00Z', a.ended_at, a.timezone_snapshot, a.activity_type_key, $2, 'test')
     from training.activities a where a.id = $1`, [s.activityId, s.coach.id]);

test("61. roster_changed: the session's start time moves (another set of memberships covers it)", async () => {
  const s = await completedMeasured("Cause time");
  const rev = (await completionOf(s.activityId)).revision;
  await inTx((c) => moveStart(c, s));
  await assertDowngraded(s.activityId, "roster_changed", { revisionBefore: rev });

  const m = await completedMeasured("Cause time mutation");
  await inTx((c) => moveStart(c, m),
    { disable: ["training.activities", "activities_roster_update"] });
  await assertStillComplete(m.activityId, "activity time");
});

// A socket error (a string code like ECONNRESET, no server answer) on the
// COMMIT, after (62) or instead of (62b) actually sending it.
function socketErrorOnCommit({ applied }) {
  return async ({ client }) => {
    const original = client.query.bind(client);
    client.query = async (sql, ...rest) => {
      if (sql === "commit") {
        if (applied) await original(sql, ...rest);
        const e = new Error("read ECONNRESET");
        e.code = "ECONNRESET";
        throw e;
      }
      return original(sql, ...rest);
    };
  };
}

test("62. a socket error on a COMMIT that was applied is verified on another connection: 200 with the stored result, one row", async () => {
  const s = await plainSession("Socket applied", 1);
  commands.setRosterCommandTestHooks({ beforeCommit: socketErrorOnCommit({ applied: true }) });
  let res;
  try {
    res = await put(s.activityId, s.athletes[0], s.coach.cookie, dnp());
  } finally {
    commands.setRosterCommandTestHooks(null);
  }
  assert.equal(res.status, 200, res.text);
  const stored = (await q(`select result from training.activity_roster_requests where activity_id = $1`, [s.activityId]))[0].result;
  assert.deepEqual(res.body, stored);
  assert.equal((await q(`select count(*)::int as n from training.activity_athlete_decisions where activity_id = $1`, [s.activityId]))[0].n, 1);
});

test("62b. a socket error on a COMMIT that never reached the server is outcome_unknown, not a certain rollback, and nothing is written", async () => {
  const s = await plainSession("Socket lost", 1);
  commands.setRosterCommandTestHooks({ beforeCommit: socketErrorOnCommit({ applied: false }) });
  let res;
  try {
    res = await put(s.activityId, s.athletes[0], s.coach.cookie, dnp());
  } finally {
    commands.setRosterCommandTestHooks(null);
  }
  assert.deepEqual([res.status, res.body.error], [503, "outcome_unknown"], res.text);
  // The transaction dies with its destroyed connection.
  for (let i = 0; i < 200 && (await q(`select 1 from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`)).length; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal((await q(`select count(*)::int as n from training.activity_athlete_decisions where activity_id = $1`, [s.activityId]))[0].n, 0);
});

// ---------------------------------------------------------------------------
// 63-67. External review of PR #123 (HIGH): the COMMIT and the check after an
// uncertain COMMIT are bounded; the uncertain connection is destroyed before
// the check; 40003 is an unknown outcome; a certain rollback and an unknown
// outcome say different things; nothing leaks (pool, open transaction).
// ---------------------------------------------------------------------------
const NOTHING_SAVED_TEXT = "Nothing was saved. Try again.";

// No checked-out pool client and no transaction left open on the disposable
// database (a destroyed connection's backend may need a moment to go).
async function assertNoLeak(label) {
  let open = [];
  for (let i = 0; i < 300; i += 1) {
    open = await q(`select pid, state from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state like 'idle in transaction%'`);
    if (open.length === 0 && appPool.totalCount === appPool.idleCount) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`${label}: leak — ${open.length} idle-in-transaction backend(s), pool total ${appPool.totalCount} idle ${appPool.idleCount}`);
}

const decisionsOn = async (activityId) => (await q(`select count(*)::int as n from training.activity_athlete_decisions where activity_id = $1`, [activityId]))[0].n;

async function withHooks(hooks, fn) {
  commands.setRosterCommandTestHooks(hooks);
  try {
    return await fn();
  } finally {
    commands.setRosterCommandTestHooks(null);
  }
}

function databaseError(code, message) {
  const e = new pg.DatabaseError(message, message.length, "error");
  e.code = code;
  e.severity = "ERROR";
  return e;
}

test("63. a COMMIT whose answer never comes is bounded: the connection is destroyed, the check runs, 503 outcome_unknown, nothing written, nothing leaked", async () => {
  const s = await plainSession("Commit hangs", 1);
  const started = Date.now();
  const res = await withHooks({ commit: () => new Promise(() => {}), commitTimeoutMs: 300 }, () => put(s.activityId, s.athletes[0], s.coach.cookie, dnp()));
  const elapsed = Date.now() - started;
  assert.deepEqual([res.status, res.body.error, res.body.message], [503, "outcome_unknown", commands.OUTCOME_UNKNOWN], res.text);
  assert.ok(elapsed < 300 + commands.UNCERTAIN_COMMIT_CHECK_TIMEOUT_MS, `bounded (${elapsed} ms)`);
  await assertNoLeak("hung COMMIT");
  assert.equal(await decisionsOn(s.activityId), 0, "the destroyed connection's transaction is gone");
});

test("64. a COMMIT that was applied but whose answer never comes is found by the bounded check: 200 with the stored result, one row", async () => {
  const s = await plainSession("Commit applied hangs", 1);
  const body = pnv();
  const res = await withHooks({ commit: async (c) => { await c.query("commit"); await new Promise(() => {}); }, commitTimeoutMs: 300 },
    () => put(s.activityId, s.athletes[0], s.coach.cookie, body));
  assert.equal(res.status, 200, res.text);
  const stored = (await q(`select result from training.activity_roster_requests where activity_id = $1`, [s.activityId]))[0].result;
  assert.deepEqual(res.body, stored);
  assert.equal(await decisionsOn(s.activityId), 1);
  await assertNoLeak("applied, answer lost");
  assert.deepEqual((await put(s.activityId, s.athletes[0], s.coach.cookie, body)).body, stored, "the retry is the same answer");
});

test("65. SQLSTATE 40003 statement_completion_unknown on COMMIT is an unknown outcome, never 'nothing was saved'", async () => {
  // Not applied: nothing found -> 503.
  const s = await plainSession("Commit 40003", 1);
  const lost = await withHooks({ commit: async () => { throw databaseError("40003", "statement completion unknown"); } },
    () => put(s.activityId, s.athletes[0], s.coach.cookie, dnp()));
  assert.deepEqual([lost.status, lost.body.error], [503, "outcome_unknown"], lost.text);
  assert.notEqual(lost.body.message, NOTHING_SAVED_TEXT);
  await assertNoLeak("40003 not applied");
  assert.equal(await decisionsOn(s.activityId), 0);
  // Applied: found -> 200.
  const t = await plainSession("Commit 40003 applied", 1);
  const kept = await withHooks({ commit: async (c) => { await c.query("commit"); throw databaseError("40003", "statement completion unknown"); } },
    () => put(t.activityId, t.athletes[0], t.coach.cookie, dnp()));
  assert.equal(kept.status, 200, kept.text);
  assert.equal(await decisionsOn(t.activityId), 1);
  // The classification itself.
  assert.equal(commands.commitCertainlyRefused(databaseError("40003", "x")), false);
  assert.equal(commands.commitCertainlyRefused(databaseError("08006", "x")), false);
  assert.equal(commands.commitCertainlyRefused(databaseError("57P01", "x")), false);
  assert.equal(commands.commitCertainlyRefused(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), false);
  assert.equal(commands.commitCertainlyRefused(new Error("no answer within 15000 ms")), false);
  assert.equal(commands.commitCertainlyRefused(databaseError("23514", "deferred check")), true);
  assert.equal(commands.commitCertainlyRefused(databaseError("40001", "serialization")), true);
});

test("66. the check after an uncertain COMMIT is bounded as a whole: a hanging check answers 503 in time and its connection is destroyed", async () => {
  const s = await plainSession("Check hangs", 1);
  const started = Date.now();
  const res = await withHooks({
    commit: async () => { throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }); },
    checkFault: (c) => c.query("select pg_sleep(2)"),
    checkTimeoutMs: 300,
  }, () => put(s.activityId, s.athletes[0], s.coach.cookie, dnp()));
  const elapsed = Date.now() - started;
  assert.deepEqual([res.status, res.body.error], [503, "outcome_unknown"], res.text);
  assert.ok(elapsed < 1500, `the check stopped at its bound (${elapsed} ms), not after the 2 s query`);
  await assertNoLeak("hanging check");
  assert.equal(await decisionsOn(s.activityId), 0);
});

test("67. a certain rollback says 'Nothing was saved'; an unknown outcome says it is not sure — two different answers", async () => {
  const s = await plainSession("Messages", 1);
  // (a) Failed before the COMMIT.
  await q(`create function pg_temp_fail_before() returns trigger as $$ begin raise exception 'internal detail'; end $$ language plpgsql`);
  await q(`create trigger zz_fail_before before insert on training.activity_roster_requests for each row execute function pg_temp_fail_before()`);
  let before;
  try {
    before = await put(s.activityId, s.athletes[0], s.coach.cookie, dnp());
  } finally {
    await q(`drop trigger zz_fail_before on training.activity_roster_requests`);
    await q(`drop function pg_temp_fail_before()`);
  }
  // (b) The server refused the COMMIT (a deferred check).
  await q(`create function pg_temp_fail_commit() returns trigger as $$ begin raise exception 'internal detail'; end $$ language plpgsql`);
  await q(`create constraint trigger zz_fail_commit after insert on training.activity_roster_requests deferrable initially deferred for each row execute function pg_temp_fail_commit()`);
  let refused;
  try {
    refused = await put(s.activityId, s.athletes[0], s.coach.cookie, dnp());
  } finally {
    await q(`drop trigger zz_fail_commit on training.activity_roster_requests`);
    await q(`drop function pg_temp_fail_commit()`);
  }
  // (c) The connection was lost on the COMMIT.
  const unknown = await withHooks({ commit: async () => { throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); } },
    () => put(s.activityId, s.athletes[0], s.coach.cookie, dnp()));
  for (const res of [before, refused]) {
    assert.deepEqual([res.status, res.body.error, res.body.message], [500, "internal_error", NOTHING_SAVED_TEXT], res.text);
    assert.ok(!/internal detail/.test(res.text));
  }
  assert.deepEqual([unknown.status, unknown.body.error, unknown.body.message], [503, "outcome_unknown", commands.OUTCOME_UNKNOWN]);
  assert.notEqual(unknown.body.message, NOTHING_SAVED_TEXT);
  assert.equal(await decisionsOn(s.activityId), 0);
  await assertNoLeak("messages");
});

// ---------------------------------------------------------------------------
// 68-71. External review of PR #123 (MEDIUM): archiving the parent club waits
// for a decision in flight on every basis, and refuses after the archive.
// Lock order of lock_activity_decider: team -> club -> role -> user.
// ---------------------------------------------------------------------------
test("68. archiving the parent club waits for an in-flight decision of a team coach and of a platform admin", async () => {
  for (const basis of ["team_coach", "platform_admin"]) {
    const s = await plainSession(`Club wait ${basis}`, 1);
    const who = basis === "team_coach" ? s.coach : await platformAdmin(`Admin ${basis}`);
    const paused = gate();
    const reached = gate();
    commands.setRosterCommandTestHooks({ beforeCommit: async () => { reached.open(); await paused.promise; } });
    const request = put(s.activityId, s.athletes[0], who.cookie, dnp());
    await reached.promise;
    const settings = await newClient();
    const archiving = settings.query(`update public.clubs set is_active = false where id = $1`, [s.clubId]).then(() => Date.now());
    try {
      await waitForLockWaiters(/^update public\.clubs/);
      const releasedAt = Date.now();
      paused.open();
      const res = await request;
      assert.equal(res.status, 200, `${basis}: ${res.text}`);
      assert.equal(res.body.decision.decidedBy.basis, basis);
      assert.ok((await archiving) >= releasedAt, `${basis}: the club archive finished only after the decision committed`);
    } finally {
      commands.setRosterCommandTestHooks(null);
      paused.open();
      await settings.end();
    }
    assert.equal(await decisionsOn(s.activityId), 1);
  }
});

test("69. a decision that arrives while the club archive is uncommitted waits for it, then is refused with nothing written", async () => {
  for (const basis of ["team_coach", "club_admin", "platform_admin"]) {
    const s = await plainSession(`Archive first ${basis}`, 1);
    const who = basis === "team_coach" ? s.coach : basis === "club_admin" ? await clubAdminOf(s.clubId) : await platformAdmin(`Admin first ${basis}`);
    const settings = await newClient();
    await settings.query("begin");
    await settings.query(`update public.clubs set is_active = false where id = $1`, [s.clubId]);
    const request = put(s.activityId, s.athletes[0], who.cookie, dnp());
    try {
      await waitForLockWaiters(/lock_activity_decider/);
      await settings.query("commit");
    } finally {
      await settings.end();
    }
    const res = await request;
    assert.deepEqual([res.status, res.body.error], [403, "not_a_team_coach"], `${basis}: ${res.text}`);
    assert.equal(await decisionsOn(s.activityId), 0, basis);
  }
});

test("70. after the parent club is archived: every command and the read answer the identical 404, and the database refuses every basis", async () => {
  const s = await plainSession("Club archived", 1);
  const clubAdmin = await clubAdminOf(s.clubId);
  const padmin = await platformAdmin("Admin archived club");
  await put(s.activityId, s.athletes[0], s.coach.cookie, pnv());
  await q(`update public.clubs set is_active = false where id = $1`, [s.clubId]);
  const before = await rowCounts();
  const notFoundText = JSON.stringify({ error: "notFound" });
  for (const who of [s.coach, clubAdmin, padmin]) {
    for (const res of [
      await roster(s.activityId, who.cookie),
      await put(s.activityId, s.athletes[0], who.cookie, dnp({ expectedDecisionId: crypto.randomUUID() })),
      await bulk(s.activityId, who.cookie, { kind: "participated_no_values", athletes: [{ athleteId: s.athletes[0], expectedDecisionId: null }], requestKey: key() }),
      await complete(s.activityId, who.cookie, { expectedRevision: 1, expectedFingerprint: "a".repeat(64), requestKey: key() }),
      await reopen(s.activityId, who.cookie, { expectedRevision: 1, reason: "x", requestKey: key() }),
    ]) {
      assert.deepEqual([res.status, res.text], [404, notFoundText], `${who.id}: ${res.text}`);
    }
  }
  for (const [userId, basis] of [[s.coach.id, "team_coach"], [clubAdmin.id, "club_admin"], [padmin.id, "platform_admin"]]) {
    await assert.rejects(q(`select training.lock_activity_decider($1, $2, $3)`, [userId, s.teamId, basis]), (e) => e.code === "42501" && /club is archived/.test(e.message), basis);
  }
  // And raw SQL cannot record a decision for that team any more.
  await assert.rejects(inTx(async (c) => {
    const req = crypto.randomUUID();
    const d = (await c.query(`select id from training.activity_athlete_decisions where activity_id = $1 and superseded_by_decision_id is null`, [s.activityId])).rows[0].id;
    const id = crypto.randomUUID();
    await c.query(`update training.activity_athlete_decisions set superseded_by_decision_id = $2, superseded_at = now() where id = $1`, [d, id]);
    await c.query(`insert into training.activity_athlete_decisions (id, activity_id, athlete_id, owner_team_id, request_id, decision_kind, reason_key, decided_by_user_id, decided_by_basis)
                   values ($1,$2,$3,$4,$5,'did_not_participate','illness',$6,'platform_admin')`, [id, s.activityId, s.athletes[0], s.teamId, req, padmin.id]);
  }), /club is archived/);
  assert.deepEqual(await rowCounts(), before);
});

test("71. a decision in flight, a team archive and a club archive together: both archives wait, nothing deadlocks, all finish", async () => {
  const s = await plainSession("No deadlock", 1);
  const paused = gate();
  const reached = gate();
  commands.setRosterCommandTestHooks({ beforeCommit: async () => { reached.open(); await paused.promise; } });
  const request = put(s.activityId, s.athletes[0], s.coach.cookie, dnp());
  await reached.promise;
  const a = await newClient();
  const b = await newClient();
  const teamArchive = a.query(`update public.teams set is_active = false where id = $1`, [s.teamId]);
  const clubArchive = b.query(`update public.clubs set is_active = false where id = $1`, [s.clubId]);
  try {
    await waitForLockWaiters(/^update public\.(teams|clubs)/, 2);
    paused.open();
    assert.equal((await request).status, 200);
    await Promise.all([teamArchive, clubArchive]);
  } finally {
    commands.setRosterCommandTestHooks(null);
    paused.open();
    await a.end();
    await b.end();
  }
  assert.deepEqual((await q(`select t.is_active as team, c.is_active as club from public.teams t join public.clubs c on c.id = t.club_id where t.id = $1`, [s.teamId]))[0], { team: false, club: false });
  assert.equal(await decisionsOn(s.activityId), 1);
});
