// Central calendar v93: deleting an event that holds nothing (docs/runbooks/calendar-event-delete-v93.md).
//
// One disposable database (optimove_tests_gpexe_v93_*) through every migration, the real Express app over HTTP with
// real session cookies, the real calendar.delete_event and its guards. A second disposable database stops before v93
// for the preflight, the apply, the post-check and the rollback rehearsal. Nothing touches OPTIMOVE or any persistent
// database; both are dropped at the end.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { applyGpexeTestMigrations, createGpexeDisposableDb } from "./_gpexe-disposable-db.mjs";
import { calendarManageMigrations, calendarMigrations } from "./support/calendar-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNBOOKS = path.resolve(__dirname, "../../docs/runbooks");
const MIGRATIONS_ROOT = path.resolve(__dirname, "../../migrations_v2");

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const V93 = "202611251000_calendar_v93_event_delete.sql";
const MIGRATIONS = calendarMigrations();
const BEFORE_V93 = MIGRATIONS.filter((m) => m !== V93);
const TZ = "Europe/Belgrade";

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const TODAY = new Date().toISOString().slice(0, 10);
const DAY = addDays(TODAY, 1);

let db;
let admin;
let server;
let apiBase;
let appPool;
let createSession;
let eventService;

const uid = () => crypto.randomBytes(4).toString("hex");
const newKey = () => crypto.randomUUID();
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;

// --- Fixtures (the K2a suite's) ----------------------------------------------------------
async function makeClub(label = "Club") {
  const id = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} ${uid()}`]))[0].id;
  await q(`select calendar.seed_club_event_types($1)`, [id]);
  return id;
}
const makeTeam = async (clubId, label = "Team") => (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} ${uid()}`]))[0].id;
const makeUser = async (label) => (await q(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${uid()}@test.local`, label]))[0].id;
async function setWorkspace(userId, type, scopeId) {
  await q(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const withCookie = async (id) => ({ id, cookie: `optimove_session=${await createSession(id)}` });
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
async function makeAthlete(name, { clubId, teamId }) {
  const userId = await makeUser(name);
  const athleteId = (await q(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,'UTC') returning id`, [userId, name]))[0].id;
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,null,'club','active','2026-01-01T00:00:00Z')`, [athleteId, clubId]);
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athleteId, clubId, teamId]);
  await setWorkspace(userId, "athlete", null);
  return { userId, athleteId, ...(await withCookie(userId)) };
}
async function api(pathname, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${pathname}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch { parsed = {}; }
  return { status: res.status, body: parsed, text };
}
async function typeOf(cookie, kind) {
  const res = await api("/api/calendar/events/types", { cookie });
  assert.equal(res.status, 200, res.text);
  return res.body.types.find((t) => t.kind === kind);
}
async function createEvent(cookie, body) {
  const res = await api("/api/calendar/events", { method: "POST", cookie, body: { requestKey: newKey(), timezone: TZ, day: DAY, ...body } });
  assert.equal(res.status, 201, res.text);
  return res.body.event;
}
const deleteEvent = (cookie, id, body) => api(`/api/calendar/events/${id}/delete`, { method: "POST", cookie, body: { requestKey: newKey(), ...body } });
const exists = async (id) => (await q(`select count(*)::int as n from calendar.events where id = $1`, [id]))[0].n === 1;
const logRows = async (id) => q(`select * from calendar.event_deletion_log where event_id = $1`, [id]);
// A fixture row written past the guards (the session's replication role turns user triggers and foreign keys off for
// this one statement): the database's state as another module would have left it.
async function raw(sql, params = []) {
  const c = await admin.query("begin");
  void c;
  await admin.query("set local session_replication_role = replica");
  try {
    const r = await admin.query(sql, params);
    await admin.query("commit");
    return r.rows;
  } catch (error) {
    await admin.query("rollback");
    throw error;
  }
}

async function world(label) {
  const clubId = await makeClub(`${label} club`);
  const team1 = await makeTeam(clubId, `${label} T1`);
  const team2 = await makeTeam(clubId, `${label} T2`);
  const clubAdmin = await clubAdminOf(clubId, `${label} admin`);
  const coach1 = await coachOf(team1, `${label} coach 1`);
  const coach2 = await coachOf(team2, `${label} coach 2`);
  const a1 = await makeAthlete(`${label} A1`, { clubId, teamId: team1 });
  const training = await typeOf(coach1.cookie, "training");
  return { clubId, team1, team2, clubAdmin, coach1, coach2, a1, training };
}
const teamEvent = (w, extra = {}) => createEvent(w.coach1.cookie, { eventTypeId: w.training.id, title: `Training ${uid()}`, targets: [{ kind: "team", id: w.team1 }], ...extra });

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v93", migrations: calendarManageMigrations(MIGRATIONS) });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  await admin.query(`alter table plans.plans add column if not exists builder_batch_id uuid`);
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  eventService = await import("../src/calendarEventService.js");
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is on the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (appPool) await appPool.end().catch(() => {});
  if (admin) await admin.end().catch(() => {});
  if (db) await db.drop();
});

// --- 1. The route ------------------------------------------------------------------------
test("1. the team's coach deletes an empty event: 200, the event and its own rows gone, one log row with the facts", async () => {
  const w = await world("ok");
  const ev = await teamEvent(w);
  const view = await api(`/api/calendar/events/${ev.id}`, { cookie: w.coach1.cookie });
  assert.equal(view.body.event.deletable, true, "the manager view offers Delete");
  const key = newKey();
  const res = await api(`/api/calendar/events/${ev.id}/delete`, { method: "POST", cookie: w.coach1.cookie, body: { requestKey: key, expectedRevision: ev.revision } });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body, { deleted: true, eventId: ev.id });
  assert.equal(await exists(ev.id), false);
  for (const t of ["event_targets", "event_requests", "event_changes", "event_selected_fields"]) {
    assert.equal((await q(`select count(*)::int as n from calendar.${t} where event_id = $1`, [ev.id]))[0].n, 0, t);
  }
  const [log] = await logRows(ev.id);
  assert.equal(log.performed_by_user_id, w.coach1.id);
  assert.equal(log.basis, "team_coach");
  assert.equal(log.request_key, key);
  assert.equal(log.owner_scope, "team");
  assert.equal(log.owner_team_id, w.team1);
  assert.equal(log.title, ev.title);
  assert.equal(log.event_kind, "training");
  assert.equal(log.event_status, "planned");
  assert.deepEqual(Object.keys(log.result).sort(), ["eventId", "httpStatus"], "the request record holds ids only");
  assert.equal((await api(`/api/calendar/events/${ev.id}`, { cookie: w.coach1.cookie })).status, 404);
  const cal = await api(`/api/calendar?from=${TODAY}&to=${addDays(TODAY, 3)}`, { cookie: w.coach1.cookie });
  assert.equal(cal.body.days.flatMap((d) => d.items).some((i) => i.eventId === ev.id), false, "gone from the calendar");
});

test("2. a cancelled event is deleted on the same terms (B3); a Day off too (its day keys taken)", async () => {
  const w = await world("cancelled");
  const ev = await createEvent(w.clubAdmin.cookie, { eventTypeId: w.training.id, title: "Club day", targets: [{ kind: "club", id: w.clubId }] });
  const cancelled = await api(`/api/calendar/events/${ev.id}/cancel`, { method: "POST", cookie: w.clubAdmin.cookie, body: { requestKey: newKey(), expectedRevision: ev.revision } });
  assert.equal(cancelled.status, 200, cancelled.text);
  const res = await deleteEvent(w.clubAdmin.cookie, ev.id, { expectedRevision: cancelled.body.event.revision });
  assert.equal(res.status, 200, res.text);
  assert.equal((await logRows(ev.id))[0].event_status, "cancelled");
  assert.equal((await logRows(ev.id))[0].basis, "club_admin");
  const dayOff = await typeOf(w.clubAdmin.cookie, "day_off");
  const off = await createEvent(w.clubAdmin.cookie, { eventTypeId: dayOff.id, title: "Rest", endDay: addDays(DAY, 2), targets: [{ kind: "club", id: w.clubId }] });
  const res2 = await deleteEvent(w.clubAdmin.cookie, off.id, { expectedRevision: off.revision });
  assert.equal(res2.status, 200, res2.text);
});

test("3. replay: the same key answers deleted again (replayed); the same key with another body is request_key_reused; a stale revision deletes nothing", async () => {
  const w = await world("replay");
  const ev = await teamEvent(w);
  const stale = await deleteEvent(w.coach1.cookie, ev.id, { expectedRevision: ev.revision + 1 });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.body.error, "event_changed");
  assert.equal(await exists(ev.id), true);
  const body = { requestKey: newKey(), expectedRevision: ev.revision };
  const first = await api(`/api/calendar/events/${ev.id}/delete`, { method: "POST", cookie: w.coach1.cookie, body });
  assert.equal(first.status, 200, first.text);
  const again = await api(`/api/calendar/events/${ev.id}/delete`, { method: "POST", cookie: w.coach1.cookie, body });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.deleted, true);
  assert.equal(again.body.replayed, true);
  const other = await api(`/api/calendar/events/${ev.id}/delete`, { method: "POST", cookie: w.coach1.cookie, body: { ...body, expectedRevision: ev.revision + 5 } });
  assert.equal(other.status, 409, other.text);
  assert.equal(other.body.error, "request_key_reused");
  // Another user with the same key learns nothing: the event is gone for them.
  const stranger = await api(`/api/calendar/events/${ev.id}/delete`, { method: "POST", cookie: w.clubAdmin.cookie, body });
  assert.equal(stranger.status, 404, stranger.text);
  assert.equal((await logRows(ev.id)).length, 1);
});

test("4. info-hiding: another team's coach, the team's athlete, a club event for a team coach, an unknown id and a bad id are the one 404; nothing deleted", async () => {
  const w = await world("hide");
  const ev = await teamEvent(w);
  const clubEvent = await createEvent(w.clubAdmin.cookie, { eventTypeId: w.training.id, title: "Club only", targets: [{ kind: "club", id: w.clubId }] });
  const unknown = await deleteEvent(w.coach1.cookie, crypto.randomUUID(), { expectedRevision: 1 });
  assert.equal(unknown.status, 404);
  const tries = [
    await deleteEvent(w.coach2.cookie, ev.id, { expectedRevision: ev.revision }),
    await deleteEvent(w.a1.cookie, ev.id, { expectedRevision: ev.revision }),
    await deleteEvent(w.coach1.cookie, clubEvent.id, { expectedRevision: clubEvent.revision }),
    await deleteEvent(w.coach1.cookie, "not-a-uuid", { expectedRevision: 1 }),
  ];
  for (const t of tries) {
    assert.equal(t.status, 404, t.text);
    assert.deepEqual(t.body, unknown.body, "the identical body");
  }
  assert.equal(await exists(ev.id), true);
  assert.equal(await exists(clubEvent.id), true);
  // The reader's GET carries no deletable (only a manager's view does).
  const read = await api(`/api/calendar/events/${clubEvent.id}`, { cookie: w.coach1.cookie });
  assert.equal(read.status, 200, read.text);
  assert.equal("deletable" in read.body.event, false);
});

// --- 2. What is attached -----------------------------------------------------------------
const ATTACH = {
  async trainings(w, ev) {
    await raw(`insert into calendar.event_session_links (event_id, day, linked_by_user_id, ended_at, ended_by_user_id) values ($1,$2,$3,now(),$3)`, [ev.id, DAY, w.coach1.id]);
    return "event_has_trainings";
  },
  async activities(w, ev) {
    await raw(`insert into calendar.event_activity_links (event_id, activity_id, linked_by_user_id) values ($1,$2,$3)`, [ev.id, crypto.randomUUID(), w.coach1.id]);
    return "event_has_activities";
  },
  async questions(w, ev) {
    await raw(`insert into calendar.event_questions (event_id, kind, external_schedule_id, window_kind, window_date, opens_time, closes_time, created_by_user_id)
               values ($1,'rpe',$2,'after_event',$3,'10:00','12:00',$4)`, [ev.id, crypto.randomUUID(), DAY, w.coach1.id]);
    return "event_has_questions";
  },
  async assignments(w, ev) {
    await raw(`insert into calendar.question_assignment_skips (assignment_id, athlete_id, event_id, reason) values ($1,$2,$3,'day_off')`, [crypto.randomUUID(), w.a1.athleteId, ev.id]);
    return "event_has_assignments";
  },
  async details(w, ev) {
    await raw(`insert into calendar.event_field_values (event_id, field_id, text_value, updated_by_user_id) values ($1,$2,'x',$3)`, [ev.id, crypto.randomUUID(), w.coach1.id]);
    return "event_has_details";
  },
  async schedule(w, ev) {
    await raw(`update calendar.events set external_schedule_id = $2 where id = $1`, [ev.id, crypto.randomUUID()]);
    return "event_has_schedule";
  },
};

test("5. each class of what is attached refuses with its own 409 and deletes nothing; the manager view says not deletable", async () => {
  const w = await world("attached");
  for (const [name, attach] of Object.entries(ATTACH)) {
    const ev = await teamEvent(w);
    const code = await attach(w, ev);
    const view = await api(`/api/calendar/events/${ev.id}`, { cookie: w.coach1.cookie });
    assert.equal(view.body.event.deletable, false, `${name}: not deletable`);
    const res = await deleteEvent(w.coach1.cookie, ev.id, { expectedRevision: ev.revision });
    assert.equal(res.status, 409, `${name}: ${res.text}`);
    assert.equal(res.body.error, code, name);
    assert.doesNotMatch(res.text, /[0-9a-f]{8}-[0-9a-f]{4}-/, `${name}: no id in the refusal`);
    assert.equal(await exists(ev.id), true, `${name}: still there`);
    assert.equal((await logRows(ev.id)).length, 0, `${name}: no log row`);
    // The refusal saved nothing: the same key is free for the next try.
  }
});

// --- 3. The database guards --------------------------------------------------------------
test("6. the guards: a raw delete of an event, its requests, its changes or its targets is refused; a log row needs the right, the facts and the delete", async () => {
  const w = await world("guards");
  const ev = await teamEvent(w);
  for (const sql of [
    `delete from calendar.events where id = $1`,
    `delete from calendar.event_changes where event_id = $1`,
    `delete from calendar.event_requests where event_id = $1`,
  ]) {
    await assert.rejects(admin.query(sql, [ev.id]), (e) => e.code === "23514" || e.code === "23503", sql);
  }
  const insertLog = (userId, basis, overrides = {}) => admin.query(
    `insert into calendar.event_deletion_log (request_key, request_hash, performed_by_user_id, basis, event_id, owner_scope, owner_team_id, event_kind, title, day, end_day, event_status, event_revision, result)
     select gen_random_uuid(), repeat('a', 64), $2, $3, e.id, e.owner_scope, e.owner_team_id, 'training', coalesce($4, e.title), e.day, e.end_day, e.status, e.revision, '{}'::jsonb
       from calendar.events e where e.id = $1`, [ev.id, userId, basis, overrides.title ?? null]);
  const tx = async (fn) => { await admin.query("begin"); try { return await fn(); } finally { await admin.query("rollback"); } };
  // Another team's coach naming team_coach: lock_event_writer refuses (42501).
  await tx(() => assert.rejects(insertLog(w.coach2.id, "team_coach"), (e) => e.code === "42501"));
  // The facts must be the event's.
  await tx(() => assert.rejects(insertLog(w.coach1.id, "team_coach", { title: "Other" }), (e) => e.code === "23514" && e.constraint === "event_delete_facts"));
  // A log row whose event stays: refused at COMMIT.
  await admin.query("begin");
  await insertLog(w.coach1.id, "team_coach");
  await assert.rejects(admin.query("commit"), (e) => e.code === "23514");
  assert.equal(await exists(ev.id), true);
  assert.equal((await logRows(ev.id)).length, 0);
  // With the log row of the same transaction, the sanctioned function deletes; a raw delete after a log row of
  // ANOTHER event is still refused.
  const other = await teamEvent(w);
  // A raw call with a stale revision is refused by the function itself (the route checks first, the function again).
  await tx(() => assert.rejects(
    admin.query(`select calendar.delete_event($1, $2, $3, 'team_coach', gen_random_uuid(), repeat('b', 64), '{}'::jsonb)`, [other.id, other.revision + 1, w.coach1.id]),
    (e) => e.code === "23514" && e.constraint === "event_delete_revision"));
  await admin.query("begin");
  try {
    await admin.query(`select calendar.delete_event($1, $2, $3, 'team_coach', gen_random_uuid(), repeat('b', 64), '{}'::jsonb)`, [other.id, other.revision, w.coach1.id]);
    await assert.rejects(admin.query(`delete from calendar.events where id = $1`, [ev.id]), (e) => e.code === "23514");
  } finally {
    await admin.query("rollback");
  }
  assert.equal(await exists(other.id), true, "rolled back");
  // The log is append-only.
  const done = await teamEvent(w);
  assert.equal((await deleteEvent(w.coach1.cookie, done.id, { expectedRevision: done.revision })).status, 200);
  await assert.rejects(admin.query(`update calendar.event_deletion_log set title = 'x' where event_id = $1`, [done.id]), (e) => e.code === "23514");
  await assert.rejects(admin.query(`delete from calendar.event_deletion_log where event_id = $1`, [done.id]), (e) => e.code === "23514");
  await assert.rejects(admin.query(`truncate calendar.event_deletion_log`), (e) => e.code === "23514");
});

// --- 4. Races ----------------------------------------------------------------------------
function gate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  let reached;
  const arrived = new Promise((resolve) => { reached = resolve; });
  return { opened, open, arrived, reached };
}

test("7a. an attach that holds the event first wins: the delete waits, then answers 409 event_changed and deletes nothing", async () => {
  const w = await world("raceA");
  const ev = await teamEvent(w);
  const activity = (await q(
    `insert into training.activities (name, occurred_local_date, started_at, timezone_snapshot, owner_scope, owner_team_id, origin, lifecycle_state)
     values ('Run', $1, $2, 'UTC', 'team', $3, 'manual', 'confirmed') returning id`, [DAY, `${DAY}T10:00:00Z`, w.team1]))[0].id;
  await q(`insert into training.activity_participants (activity_id, athlete_id, local_date, timezone_snapshot, participation_status) values ($1,$2,$3,'UTC','participated')`, [activity, w.a1.athleteId, DAY]);
  const hooks = eventService.testHooks;
  const g = gate();
  hooks.afterEventLock = async ({ operation }) => {
    if (operation !== "attach_activity") return;
    g.reached();
    await g.opened;
  };
  try {
    const attaching = api(`/api/calendar/events/${ev.id}/activities`, { method: "POST", cookie: w.coach1.cookie, body: { requestKey: newKey(), expectedRevision: ev.revision, activityId: activity } });
    await g.arrived;
    const deleting = deleteEvent(w.coach1.cookie, ev.id, { expectedRevision: ev.revision });
    await new Promise((r) => setTimeout(r, 300));
    g.open();
    const [att, del] = await Promise.all([attaching, deleting]);
    assert.equal(att.status, 200, att.text);
    assert.equal(del.status, 409, del.text);
    assert.equal(del.body.error, "event_changed");
  } finally {
    delete hooks.afterEventLock;
  }
  assert.equal(await exists(ev.id), true);
  // At the new revision the guard itself refuses: the link (an activity is attached).
  const now = (await q(`select revision from calendar.events where id = $1`, [ev.id]))[0].revision;
  const again = await deleteEvent(w.coach1.cookie, ev.id, { expectedRevision: now });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.body.error, "event_has_activities");
});

test("7b. a delete that holds the event first wins: the attach waits, then answers the one 404", async () => {
  const w = await world("raceB");
  const ev = await teamEvent(w);
  const hooks = eventService.testHooks;
  const g = gate();
  hooks.beforeCommit = async ({ operation }) => {
    if (operation !== "delete") return;
    g.reached();
    await g.opened;
  };
  try {
    const deleting = deleteEvent(w.coach1.cookie, ev.id, { expectedRevision: ev.revision });
    await g.arrived;
    const editing = api(`/api/calendar/events/${ev.id}`, { method: "PATCH", cookie: w.coach1.cookie, body: { requestKey: newKey(), expectedRevision: ev.revision, title: "Renamed" } });
    await new Promise((r) => setTimeout(r, 300));
    g.open();
    const [del, edit] = await Promise.all([deleting, editing]);
    assert.equal(del.status, 200, del.text);
    assert.equal(edit.status, 404, edit.text);
  } finally {
    delete hooks.beforeCommit;
  }
  assert.equal(await exists(ev.id), false);
});

// --- 5. The COMMIT -----------------------------------------------------------------------
test("8. a lost answer after a real COMMIT is verified from the log; after a rollback it is outcome_unknown, never 'not deleted', and the key is free", async () => {
  const w = await world("commit");
  const hooks = eventService.testHooks;
  const ev = await teamEvent(w);
  const ev2 = await teamEvent(w);
  try {
    hooks.commit = async (client) => {
      await client.query("commit");
      const error = new Error("socket hang up");
      error.code = "ECONNRESET";
      throw error;
    };
    const body = { requestKey: newKey(), expectedRevision: ev.revision };
    const verified = await api(`/api/calendar/events/${ev.id}/delete`, { method: "POST", cookie: w.coach1.cookie, body });
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.body.verifiedAfterCommitError, true);
    assert.equal(verified.body.deleted, true);
    assert.equal(await exists(ev.id), false);
    delete hooks.commit;
    // Check result: the same request again answers deleted.
    const check = await api(`/api/calendar/events/${ev.id}/delete`, { method: "POST", cookie: w.coach1.cookie, body });
    assert.equal(check.status, 200, check.text);
    assert.equal(check.body.replayed, true);

    hooks.commit = async (client) => {
      await client.query("rollback");
      const error = new Error("connection terminated");
      error.code = "ECONNRESET";
      throw error;
    };
    const body2 = { requestKey: newKey(), expectedRevision: ev2.revision };
    const lost = await api(`/api/calendar/events/${ev2.id}/delete`, { method: "POST", cookie: w.coach1.cookie, body: body2 });
    assert.equal(lost.status, 503, lost.text);
    assert.equal(lost.body.error, "outcome_unknown");
    assert.equal(await exists(ev2.id), true);
    delete hooks.commit;
    const retry = await api(`/api/calendar/events/${ev2.id}/delete`, { method: "POST", cookie: w.coach1.cookie, body: body2 });
    assert.equal(retry.status, 200, retry.text);
    assert.equal(await exists(ev2.id), false);
  } finally {
    delete hooks.commit;
  }
});

// --- 6. The migration, its runbook SQL and its rollback --------------------------------------
test("9. v93 on a database that stops before it: preflight true, applied once, post-check true, rollback to the same catalog, applied again; the rollback refuses once a log row exists", async () => {
  const before93 = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "v93rb", migrations: BEFORE_V93 });
  const c = new pg.Client({ connectionString: before93.url });
  await c.connect();
  const CATALOG = `select
    (select string_agg(x, E'\\n' order by x) from (select g.tgrelid::regclass::text || '.' || g.tgname || ':' || g.tgfoid::regproc::text || ':' || g.tgtype::text || g.tgenabled::text || g.tgdeferrable::text || g.tginitdeferred::text as x
       from pg_trigger g where not g.tgisinternal and g.tgrelid::regclass::text like 'calendar.%') t) as triggers,
    (select string_agg(x, E'\\n' order by x) from (select p.oid::regprocedure::text || '=' || md5(p.prosrc) as x from pg_proc p where p.pronamespace = 'calendar'::regnamespace) f) as functions,
    (select string_agg(x, ',' order by x) from (select c.oid::regclass::text as x from pg_class c where c.relnamespace = 'calendar'::regnamespace) r) as relations`;
  const blocks = (file) => fs.readFileSync(path.join(RUNBOOKS, file), "utf8").split(/\n(?=-- \d+\. )/)
    .map((part) => part.split("\n").filter((l) => !l.startsWith("--")).join("\n").trim()).filter(Boolean);
  const allTrue = async (file) => {
    const bad = [];
    for (const sql of blocks(file)) {
      await c.query("begin transaction read only");
      try {
        const row = (await c.query(sql)).rows[0];
        for (const [k, v] of Object.entries(row)) if (v === false) bad.push(k);
      } finally {
        await c.query("rollback");
      }
    }
    return bad;
  };
  try {
    assert.deepEqual(await allTrue("calendar-event-delete-v93-preflight.sql"), [], "preflight");
    const catalogBefore = (await c.query(CATALOG)).rows[0];
    await applyGpexeTestMigrations(before93.url, MIGRATIONS);
    const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(MIGRATIONS_ROOT, V93))).digest("hex");
    assert.deepEqual((await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [`migrations_v2/${V93}`])).rows.map((r) => r.checksum), [sha]);
    assert.deepEqual(await allTrue("calendar-event-delete-v93-postcheck.sql"), [], "post-check");
    const rollback = fs.readFileSync(path.join(RUNBOOKS, "calendar-event-delete-v93-rollback.sql"), "utf8");
    await c.query(rollback);
    assert.deepEqual((await c.query(CATALOG)).rows[0], catalogBefore, "the catalog equals the one before v93");
    await applyGpexeTestMigrations(before93.url, MIGRATIONS);
    assert.deepEqual(await allTrue("calendar-event-delete-v93-postcheck.sql"), [], "post-check again");
    // A log row: the rollback refuses and changes nothing.
    const user = (await c.query(`insert into public.users (email, full_name, display_name) values ($1,'u','u') returning id`, [`v93-${uid()}@test.local`])).rows[0].id;
    await c.query(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [user]);
    // A committed log row (written past the guards: here only the rollback's refusal matters; the suite's own database
    // proves the route).
    await c.query(`set session_replication_role = replica`);
    await c.query(`insert into calendar.event_deletion_log (request_key, request_hash, performed_by_user_id, basis, event_id, owner_scope, owner_user_id, event_kind, title, day, event_status, event_revision, result)
                   values (gen_random_uuid(), repeat('c', 64), $1, 'private_coach', gen_random_uuid(), 'user', $1, 'meeting', 'Gone', $2, 'planned', 1, '{}'::jsonb)`, [user, DAY]);
    await c.query(`set session_replication_role = origin`);
    const catalogV93 = (await c.query(CATALOG)).rows[0];
    await assert.rejects(c.query(rollback), (e) => e.code === "23514");
    await c.query("rollback").catch(() => {});
    assert.deepEqual((await c.query(CATALOG)).rows[0], catalogV93, "the refused rollback changed nothing");
  } finally {
    await c.end().catch(() => {});
    await before93.drop();
  }
});

// --- 7. The deleted event's request keys stay spent (code review of PR B, HIGH) --------------
test("10. a create replayed after its event was deleted never writes again: the same request is the one 404, another body request_key_reused", async () => {
  const w = await world("spent");
  const body = { requestKey: newKey(), timezone: TZ, day: DAY, eventTypeId: w.training.id, title: `Replayed ${uid()}`, targets: [{ kind: "team", id: w.team1 }] };
  const created = await api("/api/calendar/events", { method: "POST", cookie: w.coach1.cookie, body });
  assert.equal(created.status, 201, created.text);
  const ev = created.body.event;
  const edit = await api(`/api/calendar/events/${ev.id}`, { method: "PATCH", cookie: w.coach1.cookie, body: { requestKey: newKey(), expectedRevision: ev.revision, title: `${ev.title} 2` } });
  assert.equal(edit.status, 200, edit.text);
  assert.equal((await deleteEvent(w.coach1.cookie, ev.id, { expectedRevision: edit.body.event.revision })).status, 200);
  assert.equal((await q(`select count(*)::int as n from calendar.event_deleted_request_keys where event_id = $1`, [ev.id]))[0].n, 2, "the create's and the edit's keys kept");
  const replay = await api("/api/calendar/events", { method: "POST", cookie: w.coach1.cookie, body });
  assert.equal(replay.status, 404, replay.text);
  assert.equal(replay.body.error, "notFound");
  const other = await api("/api/calendar/events", { method: "POST", cookie: w.coach1.cookie, body: { ...body, title: "Something else" } });
  assert.equal(other.status, 409, other.text);
  assert.equal(other.body.error, "request_key_reused");
  assert.equal((await q(`select count(*)::int as n from calendar.events where title = $1 or title = 'Something else'`, [body.title]))[0].n, 0, "nothing written again");
  // Another user's same key is free (keys are per user).
  const fresh = await api("/api/calendar/events", { method: "POST", cookie: w.clubAdmin.cookie, body: { ...body, targets: [{ kind: "club", id: w.clubId }] } });
  assert.equal(fresh.status, 201, fresh.text);
  // Only the sanctioned delete writes a spent key; the table is append-only.
  await assert.rejects(admin.query(`insert into calendar.event_deleted_request_keys (performed_by_user_id, request_key, request_hash, operation, event_id) values ($1, gen_random_uuid(), repeat('f', 64), 'create', gen_random_uuid())`, [w.coach1.id]), (e) => e.code === "23514");
  await assert.rejects(admin.query(`delete from calendar.event_deleted_request_keys where event_id = $1`, [ev.id]), (e) => e.code === "23514");
});

test("11. a direct calendar.delete_event takes the writer's rights before the event (db review): against a holder of the user row that then wants the event, no deadlock", async () => {
  const w = await world("order");
  const ev = await teamEvent(w);
  const a = new pg.Client({ connectionString: db.url });
  const b = new pg.Client({ connectionString: db.url });
  await a.connect();
  await b.connect();
  try {
    // A: a revocation's first lock (the user row, FOR UPDATE).
    await a.query("begin");
    await a.query(`select 1 from public.users where id = $1 for update`, [w.coach1.id]);
    // B: a direct call; it must wait on the rights before it touches the event.
    await b.query("begin");
    await b.query(`set local lock_timeout = '5s'`);
    const deleting = b.query(`select calendar.delete_event($1, $2, $3, 'team_coach', gen_random_uuid(), repeat('a', 64), '{}'::jsonb)`, [ev.id, ev.revision, w.coach1.id])
      .then(() => "deleted", (e) => e.code);
    await new Promise((r) => setTimeout(r, 300));
    // A now wants the event (as a revocation's follow-up write would): it must not wait on B.
    await a.query(`set local lock_timeout = '3s'`);
    const aGot = await a.query(`select id from calendar.events where id = $1 for update`, [ev.id]).then(() => "locked", (e) => e.code);
    await a.query("commit");
    const bResult = await deleting;
    await b.query(bResult === "deleted" ? "commit" : "rollback").catch(() => {});
    assert.equal(aGot, "locked", "the holder of the user row got the event: the direct call had not locked it first");
    assert.equal(bResult, "deleted");
    assert.equal(await exists(ev.id), false);
  } finally {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
  }
});
