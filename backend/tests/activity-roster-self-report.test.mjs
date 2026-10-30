// v44: a self-report activity has no roster (owner decision 2026-10-29,
// option A). An athlete's own RPE result for a planned session is materialized
// as ONE team-owned activity per athlete (origin planned_session, one
// participant); under v25/v26 its roster listed the whole team — the athlete
// who gave the RPE included — as "Unknown / needs a state". From v44 such an
// activity has no roster: training.activity_has_roster() is false,
// activity_roster() is empty, the read answers 409 roster_not_applicable to
// a caller who may decide on the team's sessions and the identical 404 to
// everyone else, and every write is refused the same way before anything is
// written. Every other team activity keeps its roster unchanged.
//
// Everything runs on disposable databases (optimove_tests_gpexe_selfreport_*
// and, for the migration test, optimove_tests_gpexe_v44mig_*) created and
// dropped here; nothing touches OPTIMOVE or any persistent database. The RPE
// result goes through the real POST /api/training-load/sessions/:id/rpe, the
// roster through the real routes, as the coach's screen would.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";
import { makeBundle, standardAthletes } from "./_gpexe-fixtures.mjs";
import { buildGpexeImportPlan } from "../src/gpexeImportMapper.js";
import { importGpexePlan } from "../src/gpexeImportWriter.js";
import * as runner from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const V42 = "202610282300_training_load_v42_source_metric_zone_model.sql";
const V44 = "202610301000_training_load_v44_activity_roster_self_report.sql";
const ROLLBACK_SQL = path.resolve(__dirname, "../../docs/runbooks/activity-roster-v44-rollback.sql");

// A past day in every time zone the test may run in, inside an open
// membership period (members since 2026-01-01); the submit route refuses a
// session day after the athlete's local today.
const TZ = "UTC";
const DAY = "2026-10-27";
const WEEK_START = "2026-10-26";

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
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const uid = () => crypto.randomBytes(4).toString("hex");
const key = () => crypto.randomUUID();

async function q(sql, params = []) {
  return (await admin.query(sql, params)).rows;
}

async function makeTeam(label = "Team") {
  const clubId = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} club ${uid()}`]))[0].id;
  const teamId = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} ${uid()}`]))[0].id;
  return { clubId, teamId };
}

async function makeUser(label, roleHint = "user") {
  return (await q(`insert into public.users (email, full_name, display_name, role_hint) values ($1,$2,$2,$3) returning id`, [`${label.replace(/\W/g, "")}-${uid()}@test.local`, label, roleHint]))[0].id;
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

// The disposable fixture carries only the plans.* columns the app reads;
// insert whichever of the intended columns exist there.
async function insertDyn(schema, table, values, returning = "id") {
  const cols = new Set((await q(`select column_name from information_schema.columns where table_schema=$1 and table_name=$2`, [schema, table])).map((r) => r.column_name));
  const keys = Object.keys(values).filter((k) => cols.has(k));
  return (await q(`insert into ${schema}.${table} (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning ${returning}`, keys.map((k) => values[k])))[0];
}

// An athlete with an account, an active club and team membership since
// 2026-01-01, one weekly plan owned by the team and one planned session on
// DAY at 18:00 with RPE and Training Load on — what the Builder writes for
// one member of a team batch.
async function makeAthleteWithSession(name, { clubId, teamId, coachUserId }) {
  const userId = await makeUser(name, "athlete");
  const athleteId = (await q(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,$3) returning id`, [userId, name, TZ]))[0].id;
  await q(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status, starts_at) values ($1,$2,'club','active','2026-01-01T00:00:00Z')`, [athleteId, clubId]);
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteId, clubId, teamId]);
  const planId = (await insertDyn("plans", "plans", {
    plan_type: "weekly", created_by_user_id: coachUserId, athlete_id: athleteId, name: "Team week", status: "active",
    source_type: "builder", visibility: "private", week_start: WEEK_START, is_active: true, is_edit_draft: false,
  })).id;
  await q(`insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_team_id) values ($1,'team',$2)`, [planId, teamId]);
  const dayId = (await insertDyn("plans", "plan_days", { plan_id: planId, date: DAY, day_order: 1, block_index: 1 })).id;
  // The fixture declares plan_sessions.logical_session_id itself (nullable,
  // without the real default), so v2's `add column if not exists` leaves it
  // that way: set it, as the real column's default would.
  const session = await insertDyn("plans", "plan_sessions", {
    plan_day_id: dayId, name: "Team training", rpe_enabled: true, training_load_enabled: true, session_time: "18:00", logical_session_id: crypto.randomUUID(),
  }, "id, logical_session_id");
  return { name, userId, athleteId, planId, sessionId: session.id, logicalSessionId: session.logical_session_id, ...(await withCookie(userId)) };
}

// A team with a coach and n athletes, each with an account and a planned
// session on DAY; planned RPE on for the team.
async function teamWithSessions(label, n = 3) {
  const { clubId, teamId } = await makeTeam(label);
  const coach = await coachOf(teamId, `${label} coach`);
  await q(`insert into training_load.planned_rpe_workspace_settings (owner_scope, owner_team_id, enabled, enabled_at) values ('team',$1,true,'2000-01-01T00:00:00Z')`, [teamId]);
  const athletes = [];
  for (let i = 0; i < n; i += 1) athletes.push(await makeAthleteWithSession(`${label} ${String.fromCharCode(65 + i)}`, { clubId, teamId, coachUserId: coach.id }));
  return { clubId, teamId, coach, athletes };
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

// The athlete's own RPE result through the real route; returns the activity
// it materialized.
async function submitRpe(athlete, { rpe = 7, durationMinutes = 75 } = {}) {
  const res = await api(`/api/training-load/sessions/${athlete.sessionId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe, durationMinutes } });
  assert.equal(res.status, 201, res.text);
  const act = (await q(
    `select a.id, a.owner_scope, a.owner_team_id, a.origin, a.lifecycle_state,
            (select count(*)::int from training.activity_participants p where p.activity_id = a.id and p.merge_status = 'canonical') as participants
       from training.activity_participant_session_links l
       join training.activity_participants ap on ap.id = l.activity_participant_id
       join training.activities a on a.id = ap.activity_id
      where l.logical_session_id = $1 and l.link_status = 'confirmed'`,
    [athlete.logicalSessionId],
  ))[0];
  assert.ok(act, "the submit materialized an activity");
  return act;
}

async function makeActivity({ teamId, origin, name = "Session", startedAt = `${DAY}T16:00:00Z` }) {
  return (await q(
    `insert into training.activities (name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_team_id, origin)
     values ($1,$2,$3,$4,'team',$5,$6) returning id`,
    [name, DAY, startedAt, TZ, teamId, origin],
  ))[0].id;
}

async function addParticipant(activityId, athleteId) {
  return (await q(
    `insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status)
     values ($1,$2,$3,$4,'participated') returning id`,
    [activityId, athleteId, DAY, TZ],
  ))[0].id;
}

// A real GPEXE import for the team (the 5a2 suite's fixture): GPEXE athletes
// 101 and 102 are measured, 103 has two tracks and is left out. `ids` maps
// the GPEXE ids to this team's athletes.
let sessionSeq = 9000;
function bundleFor(sessionId) {
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
  return makeBundle({ sessionId, gpexeTeamId: 77, start: "2026-09-14T18:08:12", updatedOn: "2026-09-14T20:18:09.337", athletes });
}

async function importMeasured(teamId, ids, performedByUserId) {
  sessionSeq += 1;
  const client = await newClient();
  try {
    return await importGpexePlan(client, buildGpexeImportPlan(bundleFor(sessionSeq)), {
      ownerTeamId: teamId, performedByUserId, athleteIdByGpexeId: ids, batchFilename: "self-report test",
    });
  } finally {
    await client.end();
  }
}

async function participantOf(activityId, athleteId) {
  return (await q(`select id from training.activity_participants where activity_id = $1 and athlete_id = $2 and merge_status = 'canonical'`, [activityId, athleteId]))[0].id;
}

async function hasRoster(activityId) {
  return (await q(`select training.activity_has_roster($1) as v`, [activityId]))[0].v;
}

async function rosterRows(activityId) {
  return (await q(`select athlete_id from training.activity_roster($1)`, [activityId])).length;
}

async function needsStateRows(activityId) {
  return (await q(`select athlete_id from training.activity_roster_needs_state($1)`, [activityId])).length;
}

async function rowCounts(tables = TABLES) {
  const counts = {};
  for (const t of tables) {
    const r = (await q(`select count(*)::int as n, coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as d from ${t} x`))[0];
    counts[t] = `${r.n}:${r.d}`;
  }
  return counts;
}

async function newClient(url = db.url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

// pg_get_functiondef keeps the source's line endings; the checked-out SQL
// files may carry CRLF on one workstation and LF on another, so the digest
// compares function bodies without carriage returns.
async function catalogDigest(client) {
  return (await client.query(
    `select 'f:' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')=' || md5(replace(pg_get_functiondef(p.oid), E'\\r', '')) as x
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','training','training_load') and p.prokind = 'f'
     union all
     select 't:' || c.relname || '.' || t.tgname || '=' || t.tgenabled::text || md5(pg_get_triggerdef(t.oid))
       from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where not t.tgisinternal and n.nspname in ('public','training','training_load')
     union all
     select 'i:' || schemaname || '.' || indexname || '=' || md5(indexdef) from pg_indexes where schemaname in ('public','training','training_load')
     order by 1`,
  )).rows.map((r) => r.x);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "selfreport" });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  assert.ok((await q(`select to_regprocedure('training.activity_has_roster(uuid)') as f`))[0].f, "v44 applied");
  // The GPEXE fixture carries the migrations the importer needs; the external
  // schedule routes (test 9) also need v6-v8 (event type, notification rules,
  // specific dates), applied here to this suite's database only. The runner
  // applies every file it finds unrecorded and skips the recorded ones.
  await applyGpexeTestMigrations(db.url, [...GPEXE_TEST_MIGRATIONS,
    "202609011200_training_load_v6_external_schedule_event_type.sql",
    "202609020900_training_load_v7_external_schedule_notification_rules.sql",
    "202609030900_training_load_v8_specific_dates_group.sql",
  ]);

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
  assert.match(db.name, /^optimove_tests_gpexe_selfreport_[0-9a-f]+$/);
  assert.notEqual(db.name.toLowerCase(), baseName.toLowerCase());
  assert.notEqual(db.name.toLowerCase(), "optimove");
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name);
  assert.equal((await q(`select count(*)::int as n from public.optimove_disposable_test_database`))[0].n, 1, "the disposable marker exists");
});

// ---------------------------------------------------------------------------
// 1-3. A self-report activity has no roster
// ---------------------------------------------------------------------------
test("1. one athlete's RPE result materializes a team-owned planned_session activity with one participant, and that activity has no roster: 409 for the team coach and the club admin, the identical 404 for everyone else", async () => {
  const t = await teamWithSessions("Report", 3);
  const [ana] = t.athletes;
  const act = await submitRpe(ana);
  assert.deepEqual([act.owner_scope, act.owner_team_id, act.origin, act.lifecycle_state, act.participants], ["team", t.teamId, "planned_session", "confirmed", 1]);

  assert.equal(await hasRoster(act.id), false, "activity_has_roster()");
  assert.equal(await rosterRows(act.id), 0, "activity_roster() is empty");
  assert.equal(await needsStateRows(act.id), 0, "nobody needs a state");

  const asCoach = await roster(act.id, t.coach.cookie);
  assert.deepEqual([asCoach.status, asCoach.body.error], [409, "roster_not_applicable"], asCoach.text);
  const admin2 = await clubAdminOf(t.clubId);
  const asClubAdmin = await roster(act.id, admin2.cookie);
  assert.deepEqual([asClubAdmin.status, asClubAdmin.body.error], [409, "roster_not_applicable"], asClubAdmin.text);

  const other = await teamWithSessions("Other", 1);
  assert.equal((await roster(act.id, other.coach.cookie)).status, 404, "another team's coach learns nothing");
  assert.equal((await roster(act.id, ana.cookie)).status, 404, "the athlete has no roster path");
  assert.equal((await roster(act.id)).status, 401, "no login");

  assert.equal((await q(`select count(*)::int as n from training.activity_completions where activity_id = $1`, [act.id]))[0].n, 0, "no completion row");
  const rpe = await q(`select detail ->> 'rpe' as rpe from training.canonical_activity_results($1) where fact_kind = 'rpe'`, [act.id]);
  assert.deepEqual(rpe.map((r) => r.rpe), ["7"], "the athlete's result itself is untouched");
});

test("2. every roster write on a self-report activity is refused the same way, before anything is written; the database refuses a raw decision too", async () => {
  const t = await teamWithSessions("Write", 2);
  const [ana, bojan] = t.athletes;
  const act = await submitRpe(ana);
  const before = await rowCounts();
  const answers = [
    await put(act.id, bojan.athleteId, t.coach.cookie, dnp()),
    await put(act.id, ana.athleteId, t.coach.cookie, { kind: "participated_no_values", expectedDecisionId: null, requestKey: key() }),
    // Well-formed bodies, so the body check passes and the target decides.
    await del(act.id, bojan.athleteId, t.coach.cookie, { expectedDecisionId: key(), requestKey: key() }),
    await bulk(act.id, t.coach.cookie, { kind: "participated_no_values", athletes: [{ athleteId: bojan.athleteId, expectedDecisionId: null }], requestKey: key() }),
    await complete(act.id, t.coach.cookie, { expectedRevision: 0, expectedFingerprint: "f".repeat(64), requestKey: key() }),
    await reopen(act.id, t.coach.cookie, { expectedRevision: 1, reason: "checking", requestKey: key() }),
  ];
  for (const res of answers) assert.deepEqual([res.status, res.body.error], [409, "roster_not_applicable"], res.text);
  assert.deepEqual(await rowCounts(), before, "nothing was written");

  await assert.rejects(
    q(`insert into training.activity_athlete_decisions (activity_id, athlete_id, owner_team_id, request_id, decision_kind, decided_by_user_id, decided_by_basis)
       values ($1,$2,$3,$4,'participated_no_values',$5,'team_coach')`, [act.id, bojan.athleteId, t.teamId, key(), t.coach.id]),
    /is not on the roster/,
    "v25's decision rule reads through the same roster function",
  );
});

test("3. a second athlete's result is a second self-report activity, also without a roster; the coach's calendar still shows both results", async () => {
  const t = await teamWithSessions("Second", 3);
  const [ana, bojan] = t.athletes;
  const a1 = await submitRpe(ana);
  const a2 = await submitRpe(bojan);
  assert.notEqual(a1.id, a2.id);
  for (const a of [a1, a2]) {
    assert.equal(a.participants, 1);
    assert.equal(await hasRoster(a.id), false);
    assert.equal((await roster(a.id, t.coach.cookie)).status, 409);
  }
  const cal = await api(`/api/training-load/calendar?dateFrom=${DAY}&dateTo=${DAY}`, { cookie: t.coach.cookie });
  assert.equal(cal.status, 200, cal.text);
  const items = cal.body.days?.[0]?.items ?? [];
  assert.deepEqual(items.filter((i) => i.kind === "activity").map((i) => i.activityId ?? i.id).sort(), [a1.id, a2.id].sort(), "both results are on the coach's calendar");
});

// ---------------------------------------------------------------------------
// 4-6. Every other team activity keeps its roster; the rule's boundary
// ---------------------------------------------------------------------------
test("4. the roster is unchanged for a coach-created and for an imported team activity, and a club-owned activity still answers as before; disabling the gate brings the self-report roster back (mutation evidence)", async () => {
  const t = await teamWithSessions("Keep", 3);
  const [ana] = t.athletes;
  const manual = await makeActivity({ teamId: t.teamId, origin: "manual", name: "Coach session" });
  const imported = await makeActivity({ teamId: t.teamId, origin: "source_import", name: "GPEXE session" });
  await addParticipant(imported, ana.athleteId);
  const apiImported = await makeActivity({ teamId: t.teamId, origin: "api_import", name: "API session" });
  await addParticipant(apiImported, ana.athleteId);
  for (const [id, label] of [[manual, "manual"], [imported, "source_import"], [apiImported, "api_import"]]) {
    assert.equal(await hasRoster(id), true, `${label}: activity_has_roster()`);
    const r = await roster(id, t.coach.cookie);
    assert.equal(r.status, 200, `${label}: ${r.text}`);
    assert.equal(r.body.counts.total, 3, `${label}: the whole team is the roster`);
    assert.equal(r.body.counts.needsState, 3, `${label}: everyone needs a state, as before v44`);
  }
  const clubOwned = (await q(
    `insert into training.activities (name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_club_id, origin)
     values ('Club session',$1,$2,$3,'club',$4,'manual') returning id`, [DAY, `${DAY}T16:00:00Z`, TZ, t.clubId],
  ))[0].id;
  assert.equal(await hasRoster(clubOwned), false);
  const clubAdmin = await clubAdminOf(t.clubId);
  assert.deepEqual([(await roster(clubOwned, clubAdmin.cookie)).status, (await roster(clubOwned, t.coach.cookie)).status], [409, 404], "a club-owned activity answers as before");

  // Mutation evidence: with the gate answering true, the v25 roster is back.
  const selfReport = await submitRpe(ana);
  assert.equal(await rosterRows(selfReport.id), 0);
  const c = await newClient();
  try {
    await c.query("begin");
    await c.query(`create or replace function training.activity_has_roster(p_activity_id uuid) returns boolean as $$ select true $$ language sql stable`);
    assert.equal((await c.query(`select athlete_id from training.activity_roster($1)`, [selfReport.id])).rowCount, 3, "the gate alone keeps the team off this roster");
    assert.equal((await c.query(`select athlete_id from training.activity_roster_needs_state($1)`, [selfReport.id])).rowCount, 3);
    await c.query("rollback");
  } finally {
    await c.end();
  }
  assert.equal(await rosterRows(selfReport.id), 0, "the real gate is in force again");
});

test("5. the boundary: a self-report activity that holds a second canonical participant has a roster again, and both RPE athletes read Unknown as before (the team-session model is a later phase)", async () => {
  const t = await teamWithSessions("Boundary", 3);
  const [ana, bojan] = t.athletes;
  const act = await submitRpe(ana);
  await addParticipant(act.id, bojan.athleteId);
  assert.equal(await hasRoster(act.id), true);
  const r = await roster(act.id, t.coach.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.counts.total, 3);
  assert.equal(r.body.counts.needsState, 3, "an RPE is not a measured value: Unknown, as before v44");
});

test("6. a self-report activity superseded into a measured team activity is addressed through the canonical one, which has the roster", async () => {
  const t = await teamWithSessions("Merged", 3);
  const [ana] = t.athletes;
  const selfReport = await submitRpe(ana);
  const imported = await makeActivity({ teamId: t.teamId, origin: "api_import", name: "GPEXE session" });
  await addParticipant(imported, ana.athleteId);
  const c = await newClient();
  try {
    await c.query("begin");
    await c.query(`select set_config('training.allow_supersede_write', 'on', true)`);
    await c.query(`update training.activities set superseded_by_activity_id = $2, lifecycle_state = 'superseded' where id = $1`, [selfReport.id, imported]);
    await c.query("commit");
  } finally {
    await c.end();
  }
  const r = await roster(selfReport.id, t.coach.cookie);
  assert.equal(r.status, 200, r.text);
  // The answer keeps the addressed id and carries the canonical activity's facts.
  assert.equal(r.body.activity.id, selfReport.id);
  assert.equal(r.body.activity.name, "GPEXE session", "the canonical activity answers");
  assert.equal(r.body.counts.total, 3);
});

test("7. the other merge direction: a measured GPEXE participant merged into a self-report participant gives that activity measured values, and so a roster", async () => {
  const t = await teamWithSessions("Reverse", 3);
  const [ana, bojan, ceca] = t.athletes;
  const selfReport = await submitRpe(ana);
  assert.equal(await hasRoster(selfReport.id), false);
  const summary = await importMeasured(t.teamId, { 101: ana.athleteId, 102: bojan.athleteId, 103: ceca.athleteId }, t.coach.id);
  const imported = summary.activityId;
  assert.ok(imported, "the import materialized its activity");
  assert.equal(await hasRoster(imported), true, "the imported session has the team's roster");
  const importedRoster = await roster(imported, t.coach.cookie);
  assert.equal(importedRoster.status, 200, importedRoster.text);
  assert.equal(importedRoster.body.athletes.find((a) => a.athleteId === ana.athleteId).state, "measured", "Ana is measured on the imported session");

  // The deliberate manual merge in the other direction: Ana's measured
  // participant INTO her self-report participant. The self-report activity
  // stays canonical, with one canonical participant, but now carries her
  // measured values through the alias chain.
  await q(`select training.merge_activity_participants($1, $2, $3, 'self-report test: reverse merge')`,
    [await participantOf(imported, ana.athleteId), await participantOf(selfReport.id, ana.athleteId), t.coach.id]);
  assert.equal((await q(`select lifecycle_state from training.activities where id = $1`, [selfReport.id]))[0].lifecycle_state, "confirmed", "still canonical");
  assert.equal((await q(`select count(*)::int as n from training.activity_participants where activity_id = $1 and merge_status = 'canonical'`, [selfReport.id]))[0].n, 1);
  assert.equal(await hasRoster(selfReport.id), true, "measured values give the activity a roster");
  const r = await roster(selfReport.id, t.coach.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.counts.total, 3);
  assert.equal(r.body.athletes.find((a) => a.athleteId === ana.athleteId).state, "measured", "Ana's measured values are on the roster");
  assert.equal(r.body.counts.needsState, 2, "the other two still need a state");
  assert.equal(await hasRoster(imported), true, "the imported session (102 measured, 103 unknown) keeps its roster");
});

test("8. a reparent between the unlocked resolve and the locks leaves a self-report activity: the command answers the same 409, never the trigger's error, and writes nothing", async () => {
  const t = await teamWithSessions("Race", 3);
  const [ana, bojan] = t.athletes;
  const act = await submitRpe(ana);
  const second = await addParticipant(act.id, bojan.athleteId);
  assert.equal(await hasRoster(act.id), true, "with two participants the roster is offered");
  const elsewhere = await makeActivity({ teamId: t.teamId, origin: "manual", name: "Other session" });
  const before = await rowCounts();
  commands.setRosterCommandTestHooks({
    beforeLocks: async () => {
      // Another transaction moves the second participant away and commits.
      const c = await newClient();
      try {
        await c.query(`select training.reparent_activity_participant($1, $2, $3, 'self-report test: race')`, [second, elsewhere, t.coach.id]);
      } finally {
        await c.end();
      }
    },
  });
  let res;
  try {
    res = await put(act.id, ana.athleteId, t.coach.cookie, { kind: "participated_no_values", expectedDecisionId: null, requestKey: key() });
  } finally {
    commands.setRosterCommandTestHooks(null);
  }
  assert.deepEqual([res.status, res.body.error], [409, "roster_not_applicable"], res.text);
  assert.deepEqual(await rowCounts(), before, "nothing was written");
  assert.equal(await hasRoster(act.id), false);
});

// ---------------------------------------------------------------------------
// 9. External schedules: one activity per occurrence, every assignee on it
// ---------------------------------------------------------------------------
const TODAY_ISO = new Date().toISOString().slice(0, 10);

// The coach creates a one-day external schedule for `targets` through the
// real route; the athlete's own read generates the occurrence and the
// assignments; returns the schedule id.
async function externalScheduleFor(coachCookie, targets, eventName) {
  const res = await api("/api/training-load/external-schedules", {
    method: "POST", cookie: coachCookie,
    body: { eventName, scheduleKind: "one_time", timezone: TZ, startDate: TODAY_ISO, opensTime: "00:00", closesTime: "23:59", targets },
  });
  assert.equal(res.status, 201, res.text);
  return res.body.schedule?.id ?? res.body.schedules?.[0]?.id ?? res.body.id;
}

async function externalAssignmentOf(scheduleId, athlete) {
  const today = await api("/api/training-load/athlete/today", { cookie: athlete.cookie });
  assert.equal(today.status, 200, today.text);
  const row = (await q(
    `select ea.id, ea.occurrence_id from training_load.external_assignments ea
       join training_load.external_schedule_occurrences o on o.id = ea.occurrence_id
      where o.schedule_id = $1 and ea.athlete_id = $2`, [scheduleId, athlete.athleteId],
  ))[0];
  assert.ok(row, "the athlete's assignment exists");
  return row;
}

async function submitExternalRpe(athlete, assignmentId) {
  const res = await api(`/api/training-load/external-assignments/${assignmentId}/rpe`, { method: "POST", cookie: athlete.cookie, body: { rpe: 6, durationMinutes: 90 } });
  assert.equal(res.status, 201, res.text);
}

async function activityOfOccurrence(occurrenceId) {
  return (await q(
    `select a.id, a.origin, a.owner_scope,
            (select count(*)::int from training.activity_participants p where p.activity_id = a.id and p.merge_status = 'canonical') as participants
       from training.activity_external_occurrence_links l join training.activities a on a.id = l.activity_id
      where l.external_occurrence_id = $1 and l.link_status = 'confirmed'`, [occurrenceId],
  ))[0];
}

test("9. an external schedule: an occurrence with one assignee is a self-report activity without a roster; an occurrence for the whole team is one activity with every assignee and keeps its roster", async () => {
  const t = await teamWithSessions("External", 3);
  const [ana, bojan] = t.athletes;

  // One assignee: the athlete's own result, no roster.
  const single = await externalScheduleFor(t.coach.cookie, [{ kind: "athlete", id: ana.athleteId }], "Physio appointment");
  const anaOnly = await externalAssignmentOf(single, ana);
  await submitExternalRpe(ana, anaOnly.id);
  const soloAct = await activityOfOccurrence(anaOnly.occurrence_id);
  assert.deepEqual([soloAct.origin, soloAct.owner_scope, soloAct.participants], ["external_assignment", "team", 1]);
  assert.equal(await hasRoster(soloAct.id), false);
  assert.equal((await roster(soloAct.id, t.coach.cookie)).status, 409);

  // The whole team: one activity per occurrence with every assignee on it —
  // the team's event keeps its roster (and its RPE athletes still read
  // Unknown, as before v44: a result is not a state yet).
  const team = await externalScheduleFor(t.coach.cookie, [{ kind: "team", id: t.teamId }], "Away match");
  const anaTeam = await externalAssignmentOf(team, ana);
  await submitExternalRpe(ana, anaTeam.id);
  const teamAct = await activityOfOccurrence(anaTeam.occurrence_id);
  assert.deepEqual([teamAct.origin, teamAct.owner_scope, teamAct.participants], ["external_assignment", "team", 3], "every assignee is a participant");
  assert.equal(await hasRoster(teamAct.id), true);
  const r = await roster(teamAct.id, t.coach.cookie);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.counts.total, 3);
  assert.equal(r.body.counts.needsState, 3, "as before v44");
  await submitExternalRpe(bojan, (await externalAssignmentOf(team, bojan)).id);
  assert.equal((await activityOfOccurrence(anaTeam.occurrence_id)).id, teamAct.id, "a second result lands on the same activity");
});

// ---------------------------------------------------------------------------
// 10-11. The rule's edges, and the database rules that read through it
// ---------------------------------------------------------------------------
test("10. the edges of activity_has_roster(): NULL for a missing id, and the alias set is counted (a constructed state: a superseded self-report alias that still holds a canonical participant — the sanctioned merge supersedes only at zero, so this is the rule's defensive branch)", async () => {
  assert.equal((await q(`select training.activity_has_roster($1) as v`, [crypto.randomUUID()]))[0].v, null);
  const t = await teamWithSessions("Edges", 3);
  const [ana, bojan] = t.athletes;
  const s1 = await submitRpe(ana);
  const s2 = await submitRpe(bojan);
  // Bojan's self-report activity superseded into Ana's: the alias set holds
  // two canonical participants, so the activity has a roster again.
  const c = await newClient();
  try {
    await c.query("begin");
    await c.query(`select set_config('training.allow_supersede_write', 'on', true)`);
    await c.query(`update training.activities set superseded_by_activity_id = $2, lifecycle_state = 'superseded' where id = $1`, [s2.id, s1.id]);
    await c.query("commit");
  } finally {
    await c.end();
  }
  assert.equal(await hasRoster(s1.id), true, "the alias set, not the row alone, is counted");
  assert.equal((await roster(s1.id, t.coach.cookie)).status, 200);
  // Mutation evidence for the alias-set part: counting the row alone would
  // still say "no roster".
  assert.equal((await q(`select count(*)::int as n from training.activity_participants where activity_id = $1 and merge_status = 'canonical'`, [s1.id]))[0].n, 1);
});

test("11. the v25 and v26 database rules read through the same roster: a raw source observation and a raw complete completion on a self-report activity are refused", async () => {
  const t = await teamWithSessions("Rules", 2);
  const [ana] = t.athletes;
  const act = await submitRpe(ana);
  const connection = (await q(`insert into training_load.metric_source_connections (source_system, owner_scope, owner_team_id) values ('gpexe','team',$1) returning id`, [t.teamId]))[0].id;
  await assert.rejects(
    q(`insert into training.activity_source_observations (activity_id, athlete_id, source_connection_id, kind, reason_code) values ($1,$2,$3,'record_unusable','two_tracks')`, [act.id, ana.athleteId, connection]),
    /is not on the roster/,
    "v25's observation rule",
  );
  await assert.rejects(
    q(`insert into training.activity_completions (activity_id, owner_team_id, status, revision, completed_by_user_id, completed_by_basis, completed_at, input_fingerprint)
       values ($1,$2,'complete',1,$3,'team_coach',now(),$4)`, [act.id, t.teamId, t.coach.id, "a".repeat(64)]),
    /has nobody on its roster/,
    "v26's completion rule",
  );
  assert.equal((await q(`select count(*)::int as n from training.activity_completions where activity_id = $1`, [act.id]))[0].n, 0);
});

// ---------------------------------------------------------------------------
// 12. Migration v44: apply, roll back, apply again
// ---------------------------------------------------------------------------
test("12. migration v44: applied by the runner on v42, the rollback returns the schema to v42 exactly, refuses under a later migration, v44 applies again, and a v44 that fails at its end leaves nothing", async () => {
  const upToV42 = GPEXE_TEST_MIGRATIONS.slice(0, GPEXE_TEST_MIGRATIONS.indexOf(V42) + 1);
  assert.ok(GPEXE_TEST_MIGRATIONS.indexOf(V44) > GPEXE_TEST_MIGRATIONS.indexOf(V42), "v44 is listed after v42");
  const m = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v44mig", migrations: upToV42 });
  const c = await newClient(m.url);
  try {
    assert.equal((await c.query("select current_database() as db")).rows[0].db, m.name);
    const v42 = await catalogDigest(c);
    assert.equal((await c.query(`select to_regprocedure('training.activity_has_roster(uuid)') as f`)).rows[0].f, null);

    await applyGpexeTestMigrations(m.url, [...upToV42, V44]);
    const v44 = await catalogDigest(c);
    assert.notDeepEqual(v44, v42);
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name like '%v44_activity_roster_self_report.sql'`)).rows[0].n, 1);
    const changed = v44.filter((x) => !v42.includes(x)).concat(v42.filter((x) => !v44.includes(x)));
    assert.deepEqual(
      changed.map((x) => x.split("=")[0]).sort(),
      ["f:training.activity_has_roster(p_activity_id uuid)", "f:training.activity_roster(p_activity_id uuid)", "f:training.activity_roster(p_activity_id uuid)"],
      "v44 adds one function and redefines one; nothing else in the catalog moves",
    );

    // Under a later recorded migration the rollback refuses and changes nothing.
    const later = "migrations_v2/202612311200_training_load_v99_later.sql";
    await c.query(`insert into public.schema_migrations (migration_name, checksum, execution_time_ms, runner_version) values ($1,$2,0,'test')`, [later, "0".repeat(64)]);
    await assert.rejects(c.query(await fsp.readFile(ROLLBACK_SQL, "utf8")), /later migrations are applied/, "refused under a later migration");
    await c.query("rollback");
    assert.deepEqual(await catalogDigest(c), v44, "nothing changed");
    await c.query(`delete from public.schema_migrations where migration_name = $1`, [later]);
    // While the migrator holds its session lock the rollback refuses too.
    const holder = await newClient(m.url);
    try {
      await holder.query(`select pg_advisory_lock(822026)`);
      await assert.rejects(c.query(await fsp.readFile(ROLLBACK_SQL, "utf8")), /the migrator is running/, "refused while the migrator runs");
      await c.query("rollback");
      await holder.query(`select pg_advisory_unlock(822026)`);
    } finally {
      await holder.end();
    }
    assert.deepEqual(await catalogDigest(c), v44, "nothing changed");

    await c.query(await fsp.readFile(ROLLBACK_SQL, "utf8"));
    assert.deepEqual(await catalogDigest(c), v42, "the rollback leaves exactly the v42 functions, triggers and indexes");
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name like '%v44_activity_roster_self_report.sql'`)).rows[0].n, 0);
    await assert.rejects(c.query(await fsp.readFile(ROLLBACK_SQL, "utf8")), /v44 is not recorded/, "a second rollback refuses");
    // The refused script opened its transaction and stopped inside it (as
    // psql -v ON_ERROR_STOP=1 would); end it on this connection.
    await c.query("rollback");

    await applyGpexeTestMigrations(m.url, [...upToV42, V44]);
    assert.deepEqual(await catalogDigest(c), v44, "v44 applies again, identically");

    // A v44 that fails at its very end leaves nothing and is not recorded.
    await c.query(await fsp.readFile(ROLLBACK_SQL, "utf8"));
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "optimove-v44-fail-"));
    const dir = path.join(tempRoot, "migrations_v2");
    await fsp.mkdir(dir);
    try {
      for (const f of upToV42) await fsp.copyFile(path.resolve(__dirname, "../../migrations_v2", f), path.join(dir, f));
      const broken = `${await fsp.readFile(path.resolve(__dirname, "../../migrations_v2", V44), "utf8")}\nselect 1 / 0;\n`;
      await fsp.writeFile(path.join(dir, V44), broken, "utf8");
      await assert.rejects(runner.runMigrations({ databaseUrl: m.url, migrationsRoot: dir }), /ABORT while applying .*v44_activity_roster_self_report.sql.*22012/);
    } finally {
      await fsp.rm(tempRoot, { recursive: true, force: true });
    }
    assert.deepEqual(await catalogDigest(c), v42, "a failed v44 leaves nothing behind");
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name like '%v44_activity_roster_self_report.sql'`)).rows[0].n, 0);
  } finally {
    await c.end();
    await m.drop();
  }
});

// ---------------------------------------------------------------------------
// 13. A saved answer wins over the gate
// ---------------------------------------------------------------------------
test("13. a decision saved while the roster was offered is replayed by its requestKey after a reparent left the activity a self-report one (a saved write is never 'nothing was saved'); a new key gets the 409", async () => {
  const t = await teamWithSessions("Replay", 3);
  const [ana, bojan] = t.athletes;
  const act = await submitRpe(ana);
  const second = await addParticipant(act.id, bojan.athleteId);
  const body = dnp();
  const first = await put(act.id, bojan.athleteId, t.coach.cookie, body);
  assert.equal(first.status, 200, first.text);
  const saved = await rowCounts();

  const elsewhere = await makeActivity({ teamId: t.teamId, origin: "manual", name: "Other session" });
  await q(`select training.reparent_activity_participant($1, $2, $3, 'self-report test: replay')`, [second, elsewhere, t.coach.id]);
  assert.equal(await hasRoster(act.id), false, "a self-report activity again");

  const replay = await put(act.id, bojan.athleteId, t.coach.cookie, body);
  assert.equal(replay.status, 200, replay.text);
  assert.deepEqual(replay.body, first.body, "the saved answer, unchanged");
  assert.deepEqual(await rowCounts(), saved, "the replay writes nothing");

  const fresh = await put(act.id, bojan.athleteId, t.coach.cookie, dnp());
  assert.deepEqual([fresh.status, fresh.body.error], [409, "roster_not_applicable"], fresh.text);
  assert.equal((await roster(act.id, t.coach.cookie)).status, 409);
  assert.deepEqual(await rowCounts(), saved, "the refused command writes nothing");
});
