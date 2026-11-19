// Central calendar K4b — an athlete changes their own external RPE answer while
// the question is open (contract docs/ai/central-calendar-k4b-contract.md,
// migration v83, the OptiMove manager's GO of 2026-11-19 with its conditions).
// The real app over HTTP on a disposable database migrated by the calendar
// fixture (v83 included); invented people only. Nothing touches OPTIMOVE or any
// persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { addDays, calendarMigrations, newKey, startCalendarApp, uid, calendarRoleMatrix } from "./support/calendar-fixture.mjs";
import { applyGpexeTestMigrations, createGpexeDisposableDb } from "./_gpexe-disposable-db.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const V83 = "202611201200_training_load_v83_rpe_answer_change.sql";
const V83_NAME = `migrations_v2/${V83}`;
const RUNBOOK = (f) => path.join(REPO_ROOT, "docs/runbooks", f);
const TODAY = new Date().toISOString().slice(0, 10);
const ALL_DAY = { kind: "custom", date: TODAY, from: "00:00", to: "23:59" };
const NOT_FOUND = { error: "not_found", message: "Training session not found." };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let env;
let q;
let api;
let fx;
let m;
let athleteTwo;
let hooks;
const emitted = [];
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

before(async () => {
  env = await startCalendarApp({ label: "k4b" });
  ({ q, api, fx } = env);
  await q(`create table if not exists public.app_notifications (
             id uuid primary key default gen_random_uuid(), recipient_user_id uuid not null, actor_user_id uuid,
             type varchar(80) not null, title text not null, body text, entity_type varchar(80), entity_id uuid, href text,
             metadata jsonb not null default '{}'::jsonb, read_at timestamptz, created_at timestamptz not null default now(),
             dedupe_key varchar(300))`);
  await q(`create unique index if not exists app_notifications_dedupe_key_idx on public.app_notifications (dedupe_key) where dedupe_key is not null`);
  m = await calendarRoleMatrix(env, "k4b");
  athleteTwo = await fx.makeAthlete("k4b athlete T1 two", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  const on = await api("/api/calendar/settings/questions", { method: "PUT", cookie: m.roles.platformInClub.cookie, body: { requestKey: newKey(), enabled: true, reason: "Pilot of the athlete questions." } });
  assert.equal(on.status, 200, on.text);
  hooks = (await import("../src/rpeAnswerChangeService.js")).testHooks;
  hooks.emit = (userId, event, payload) => emitted.push({ userId: String(userId), event, payload });
});

after(async () => {
  if (env) await env.stop();
});

const role = (name) => m.roles[name];
const athlete = () => m.athletes.athlete;

async function typeId(clubId, kind) {
  return (await q(`select id from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 and kind = $2 and archived_at is null order by sort_order limit 1`, [clubId, kind]))[0].id;
}
// A team event of today with an RPE question open all day; both T1 athletes are asked.
async function rpeEvent() {
  const res = await api("/api/calendar/events", {
    method: "POST", cookie: role("teamCoach").cookie,
    body: { requestKey: newKey(), eventTypeId: await typeId(m.clubs.c1, "training"), title: `Training ${uid()}`, day: TODAY, timezone: "UTC",
      targets: [{ kind: "team", id: m.teams.t1 }], questions: [{ kind: "rpe", window: ALL_DAY }] },
  });
  assert.equal(res.status, 201, res.text);
  const question = (await q(`select * from calendar.event_questions where event_id = $1 and kind = 'rpe' and ended_at is null`, [res.body.event.id]))[0];
  return { eventId: res.body.event.id, question };
}
async function assignmentOf(who, question) {
  const mine = await api("/api/calendar/questions/mine", { cookie: who.cookie });
  const item = mine.body.questions.find((x) => x.questionId === question.id);
  assert.ok(item, mine.text);
  return item.form.externalAssignmentId;
}
async function submit(who, assignmentId, body = { rpe: 7, durationMinutes: 60, note: "first" }) {
  const res = await api(`/api/training-load/external-assignments/${assignmentId}/rpe`, { method: "POST", cookie: who.cookie, body });
  assert.ok([200, 201].includes(res.status), res.text);
  return res;
}
// An answered assignment of `who` on a fresh event (the real submit route).
async function answered(who = athlete(), body) {
  const ev = await rpeEvent();
  const assignmentId = await assignmentOf(who, ev.question);
  await submit(who, assignmentId, body);
  const feedback = (await q(`select * from training_load.session_feedback where external_assignment_id = $1`, [assignmentId]))[0];
  return { ...ev, assignmentId, feedback };
}
function change(cookie, assignmentId, body) {
  return api(`/api/training-load/external-assignments/${assignmentId}/rpe/change`, { method: "POST", cookie, body: { requestKey: newKey(), ...body } });
}
async function historyOf(feedbackId) {
  return q(`select * from training_load.session_feedback_changes where session_feedback_id = $1 order by revision`, [feedbackId]);
}
async function feedbackRow(id) {
  return (await q(`select *, xmin::text as xmin_text from training_load.session_feedback where id = $1`, [id]))[0];
}
// A fresh athlete with an assignment on an existing occurrence and a window of our choosing (the window is frozen at
// insert, v4). Returns { who, id }.
async function customAssignment(occurrenceId, { opensIn = "-1 hour", closesIn = "1 hour" } = {}) {
  const who = await fx.makeAthlete(`k4b extra ${uid()}`, { clubId: m.clubs.c1, teamId: m.teams.t1 });
  return { who, id: (await q(
    `insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at)
     values ($1, $2, 'UTC', current_date, now() + $3::interval, now() + $4::interval) returning id`,
    [occurrenceId, who.athleteId, opensIn, closesIn],
  ))[0].id };
}
async function occurrenceOf(assignmentId) {
  return (await q(`select a.occurrence_id, o.schedule_id from training_load.external_assignments a join training_load.external_schedule_occurrences o on o.id = a.occurrence_id where a.id = $1`, [assignmentId]))[0];
}
async function client() {
  const c = new pg.Client({ connectionString: env.db.url });
  await c.connect();
  return c;
}
function blocks(text) {
  const out = {};
  for (const part of text.split(/\n(?=-- \d+a?\. )/)) {
    const mm = part.match(/^-- (\d+a?)\. /);
    if (!mm) continue;
    const sql = part.split("\n").filter((l) => !l.startsWith("--")).join("\n").trim();
    if (sql) out[mm[1]] = sql;
  }
  return out;
}
const falseOk = (row) => Object.entries(row).filter(([k, v]) => k.startsWith("ok_") && v !== true).map(([k]) => k);
async function readOnly(c, sql) {
  await c.query("begin transaction read only");
  try { return (await c.query(sql)).rows[0]; } finally { await c.query("rollback"); }
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------
test("1. migration v83: preflight clean before it; applied by the runner; post-check clean; the rollback restores the catalog exactly; v83 applies again; a changed v5 body refuses v83; the rollback is refused once a history row exists", async () => {
  // By NAME, never "every migration but v83": a migration named after v83 (a future one) would make the rollback refuse
  // ("later migrations are applied"), so this test applies only what sorts up to v83.
  const before = calendarMigrations().filter((x) => x < V83);
  const upToV83 = calendarMigrations().filter((x) => x <= V83);
  const db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "k4bmig", migrations: before });
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try {
    const { CATALOG_SQL } = await import("../scripts/rpe-answer-change-v83-rehearsal.mjs");
    const pre = blocks(fs.readFileSync(RUNBOOK("rpe-answer-change-v83-preflight.sql"), "utf8"));
    for (const [b, sql] of Object.entries(pre)) assert.deepEqual(falseOk(await readOnly(c, sql)), [], `preflight block ${b}`);
    const catalogBefore = (await c.query(CATALOG_SQL)).rows[0];

    await applyGpexeTestMigrations(db.url, upToV83);
    const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(REPO_ROOT, "migrations_v2", V83))).digest("hex");
    assert.deepEqual((await c.query(`select checksum from public.schema_migrations where migration_name = $1`, [V83_NAME])).rows, [{ checksum: sha }]);
    const post = blocks(fs.readFileSync(RUNBOOK("rpe-answer-change-v83-postcheck.sql"), "utf8"));
    const postCheck = async () => { for (const [b, sql] of Object.entries(post)) assert.deepEqual(falseOk(await readOnly(c, sql)), [], `post-check block ${b}`); };
    await postCheck();
    for (const [b, sql] of Object.entries(pre)) {
      if (b === "5" || b === "6" || b === "1") continue;
      assert.ok(falseOk(await readOnly(c, sql)).length > 0, `preflight block ${b} is not clean once v83 is applied`);
    }

    await c.query(fs.readFileSync(RUNBOOK("rpe-answer-change-v83-rollback.sql"), "utf8"));
    assert.deepEqual((await c.query(CATALOG_SQL)).rows[0], catalogBefore, "the catalog is the one before v83");
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V83_NAME])).rows[0].n, 0);
    // The rollback refuses without v83 (nothing to roll back), changing nothing.
    await assert.rejects(c.query(fs.readFileSync(RUNBOOK("rpe-answer-change-v83-rollback.sql"), "utf8")), /v83 is not recorded/);
    await c.query("rollback");

    // A changed v5 body: v83 refuses before it creates anything.
    const body = (await c.query(`select pg_get_functiondef('training_load.protect_session_feedback_snapshot()'::regprocedure) as d`)).rows[0].d;
    await c.query(body.replace("begin\n", "begin\n  -- changed\n"));
    // The runner reports the refusal by its SQLSTATE (23514, the precondition's).
    await assert.rejects(applyGpexeTestMigrations(db.url, upToV83), /v83_rpe_answer_change\.sql" \(SQLSTATE 23514\)/);
    assert.equal((await c.query(`select to_regclass('training_load.session_feedback_changes') is null as gone`)).rows[0].gone, true);
    await c.query(body);

    await applyGpexeTestMigrations(db.url, upToV83);
    await postCheck();
    // One history row: the rollback refuses and changes nothing.
    const u = (await c.query(`insert into public.users (email, full_name) values ($1, 'mig athlete') returning id`, [`mig-${uid()}@test.local`])).rows[0].id;
    const a = (await c.query(`insert into public.athletes (user_id, full_name) values ($1, 'mig athlete') returning id`, [u])).rows[0].id;
    const s = (await c.query(`insert into training_load.external_schedules (schedule_kind, timezone, start_date, opens_time, closes_time, event_name, created_by_user_id, owner_scope, owner_user_id)
                               values ('one_time','UTC',current_date,'00:00','23:59','Mig',$1,'user',$1) returning id`, [u])).rows[0].id;
    const o = (await c.query(`insert into training_load.external_schedule_occurrences (schedule_id, scheduled_date, opens_at, closes_at, status) values ($1,current_date,now()-interval '1 hour',now()+interval '1 hour','open') returning id`, [s])).rows[0].id;
    const asg = (await c.query(`insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at, status, completed_at)
                                 values ($1,$2,'UTC',current_date,now()-interval '1 hour',now()+interval '1 hour','completed',now()) returning id`, [o, a])).rows[0].id;
    await c.query(`insert into training_load.session_feedback (athlete_id, external_assignment_id, source, event_name, session_date, rpe, duration_minutes) values ($1,$2,'scheduled_external','Mig',current_date,6,60)`, [a, asg]);
    await c.query("begin");
    assert.equal((await c.query(`select training_load.change_external_rpe($1,$2,$3,7,60,null,0) as r`, [u, asg, newKey()])).rows[0].r.outcome, "changed");
    await c.query("commit");
    await assert.rejects(c.query(fs.readFileSync(RUNBOOK("rpe-answer-change-v83-rollback.sql"), "utf8")), /an answer was changed/);
    await c.query("rollback");
    assert.equal((await c.query(`select count(*)::int as n from public.schema_migrations where migration_name = $1`, [V83_NAME])).rows[0].n, 1, "v83 stays");
    assert.equal((await c.query(`select to_regclass('training_load.session_feedback_changes') is not null as there`)).rows[0].there, true);
  } finally {
    await c.end().catch(() => {});
    await db.drop();
  }
});

test("2. the rehearsal script on the production schema snapshot (legacy bootstrap + the real runner): every step PASS, the pg_dump read-back included", async (t) => {
  const { rehearse } = await import("../scripts/rpe-answer-change-v83-rehearsal.mjs");
  const url = new URL(ORIGINAL_DATABASE_URL);
  const admin = new pg.Client({ connectionString: ORIGINAL_DATABASE_URL });
  await admin.connect();
  const major = Math.floor(Number((await admin.query(`select current_setting('server_version_num') as n`)).rows[0].n) / 10000);
  await admin.end();
  // pg_dump / pg_restore of the server's major version: from the usual Linux places, else PATH. Without them the
  // rehearsal cannot read back a dump, so this test says so (skipped, visibly) instead of failing on the tools.
  const pgBin = [`/usr/lib/postgresql/${major}/bin`, `/usr/local/pgsql/bin`].find((d) => fs.existsSync(path.join(d, "pg_dump"))) || null;
  if (!pgBin) {
    const { execFileSync } = await import("node:child_process");
    let onPath = null;
    try { onPath = Number((execFileSync("pg_dump", ["--version"], { encoding: "utf8" }).match(/(\d+)/) || [])[1]); } catch {}
    if (onPath !== major) {
      t.skip(`NOT RUN: no pg_dump ${major} found (put PostgreSQL ${major}'s bin on PATH); run backend/scripts/rpe-answer-change-v83-rehearsal.mjs by hand`);
      return;
    }
  }
  const lines = [];
  const original = console.log;
  console.log = (...x) => { lines.push(x.join(" ")); };
  let ok;
  try {
    ok = await rehearse({ host: url.hostname.replace(/^\[|\]$/g, ""), port: url.port || "5432", user: decodeURIComponent(url.username), pgBin }, decodeURIComponent(url.password));
  } finally {
    console.log = original;
  }
  t.diagnostic(lines.filter((l) => /^(PASS|FAIL|RESULT|server)/.test(l)).join("\n"));
  assert.equal(ok, true, lines.join("\n"));
});

// ---------------------------------------------------------------------------
// The change
// ---------------------------------------------------------------------------
test("3. a change inside the window: RPE, duration and note change in place, srpe follows, identity and submit times stay; one history row (old values, the actor, athlete_self, revision 1); the realtime event after the COMMIT, to the athlete's user", async () => {
  const a = await answered();
  const beforeRow = await feedbackRow(a.feedback.id);
  emitted.length = 0;
  // The order is recorded through the seams, never by a race of two connections: the COMMIT hook sets the flag, the
  // emit hook reads it.
  let committed = false;
  let committedAtEmit = null;
  hooks.commit = async (cl) => { await cl.query("commit"); committed = true; };
  hooks.emit = (userId, event, payload) => {
    emitted.push({ userId: String(userId), event, payload });
    committedAtEmit = committed;
  };
  const res = await change(athlete().cookie, a.assignmentId, { rpe: 5, durationMinutes: 75, note: "  legs heavy  ", expectedRevision: 0 });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.cacheControl, "no-store");
  assert.equal(res.body.outcome, "changed");
  assert.deepEqual({ ...res.body.feedback, submittedAt: null, lastChangedAt: null, closesAt: null },
    { rpe: 5, durationMinutes: 75, srpe: 375, note: "legs heavy", submittedAt: null, revision: 1, lastChangedAt: null, closesAt: null });
  const row = await feedbackRow(a.feedback.id);
  assert.deepEqual([row.rpe, row.duration_minutes, row.srpe, row.athlete_note], [5, 75, 375, "legs heavy"]);
  for (const col of ["id", "athlete_id", "external_assignment_id", "source", "event_name", "session_date", "submitted_at", "created_at"]) {
    assert.deepEqual(row[col], beforeRow[col], `${col} unchanged`);
  }
  const [h] = await historyOf(a.feedback.id);
  assert.deepEqual([h.revision, h.basis, h.changed_by_user_id, h.athlete_id, h.old_rpe, h.old_duration_minutes, h.old_athlete_note, h.new_rpe, h.new_duration_minutes, h.new_athlete_note],
    [1, "athlete_self", athlete().id, athlete().athleteId, 7, 60, "first", 5, 75, "legs heavy"]);
  assert.match(h.request_hash, /^[0-9a-f]{64}$/);
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0], { userId: String(athlete().id), event: "training_load_changed", payload: { externalAssignmentId: a.assignmentId } });
  assert.equal(committedAtEmit, true, "the event goes out only once the COMMIT answered");
  hooks.commit = null;
  hooks.emit = (userId, event, payload) => emitted.push({ userId: String(userId), event, payload });
});

test("4. the same values write nothing: 200 unchanged, no history row, the row untouched (its xmin), the key not recorded, no realtime event", async () => {
  const a = await answered(athlete(), { rpe: 6, durationMinutes: 45 });
  const before = await feedbackRow(a.feedback.id);
  emitted.length = 0;
  const key = newKey();
  const res = await change(athlete().cookie, a.assignmentId, { requestKey: key, rpe: 6, durationMinutes: 45, note: "   " });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.outcome, "unchanged");
  assert.equal((await historyOf(a.feedback.id)).length, 0);
  assert.equal((await feedbackRow(a.feedback.id)).xmin_text, before.xmin_text);
  assert.equal(emitted.length, 0);
  // The key is free: a real change with it later is a change, not a replay.
  const later = await change(athlete().cookie, a.assignmentId, { requestKey: key, rpe: 8, durationMinutes: 45 });
  assert.equal(later.body.outcome, "changed");
});

test("5. idempotency: the same key and body replays (one history row, no second event); the same key with another body is request_key_reused; a replay after the window closed still answers replayed", async () => {
  const a = await answered();
  const key = newKey();
  const body = { requestKey: key, rpe: 4, durationMinutes: 60, note: "first" };
  emitted.length = 0;
  assert.equal((await change(athlete().cookie, a.assignmentId, body)).body.outcome, "changed");
  const again = await change(athlete().cookie, a.assignmentId, body);
  assert.equal(again.status, 200);
  assert.equal(again.body.outcome, "replayed");
  assert.equal(again.body.feedback.rpe, 4);
  assert.equal((await historyOf(a.feedback.id)).length, 1);
  assert.equal(emitted.length, 1, "a replay sends no event");
  const reused = await change(athlete().cookie, a.assignmentId, { ...body, rpe: 3 });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, "request_key_reused");
  assert.equal((await historyOf(a.feedback.id)).length, 1);

  // Closed window, then the same key: replayed (answered before the window).
  const { occurrence_id: occ } = await occurrenceOf(a.assignmentId);
  const { who, id: short } = await customAssignment(occ, { closesIn: "2 seconds" });
  await submit(who, short);
  const shortKey = newKey();
  assert.equal((await change(who.cookie, short, { requestKey: shortKey, rpe: 2, durationMinutes: 60 })).body.outcome, "changed");
  await sleep(2500);
  const late = await change(who.cookie, short, { requestKey: shortKey, rpe: 2, durationMinutes: 60 });
  assert.equal(late.status, 200, late.text);
  assert.equal(late.body.outcome, "replayed");
  const closed = await change(who.cookie, short, { rpe: 3, durationMinutes: 60 });
  assert.equal(closed.status, 409);
  assert.deepEqual([closed.body.error, closed.body.message], ["answer_locked", "This answer can no longer be changed. The question is closed."]);
});

test("6. a stale expectedRevision is answer_changed with the current answer; nothing written", async () => {
  const a = await answered();
  assert.equal((await change(athlete().cookie, a.assignmentId, { rpe: 9, durationMinutes: 60, expectedRevision: 0 })).body.outcome, "changed");
  const stale = await change(athlete().cookie, a.assignmentId, { rpe: 1, durationMinutes: 60, expectedRevision: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "answer_changed");
  assert.equal(stale.body.feedback.rpe, 9);
  assert.equal(stale.body.feedback.revision, 1);
  assert.equal((await feedbackRow(a.feedback.id)).rpe, 9);
  assert.equal((await historyOf(a.feedback.id)).length, 1);
});

test("7. info-hiding: another athlete's assignment, a missing id, a malformed id, a coach, a platform admin, an admin: the identical 404 (no-store); an unanswered own assignment is not_answered; an invalid body is 400 before anything", async () => {
  const a = await answered();
  const body = { rpe: 3, durationMinutes: 30 };
  const answers = [
    await change(athleteTwo.cookie, a.assignmentId, body),
    await change(athlete().cookie, crypto.randomUUID(), body),
    await change(athlete().cookie, "not-a-uuid", body),
    await change(role("teamCoach").cookie, a.assignmentId, body),
    await change(role("platformAdmin").cookie, a.assignmentId, body),
    await change(role("clubAdmin").cookie, a.assignmentId, body),
    await change(m.athletes.athleteU1.cookie, a.assignmentId, body),
  ];
  for (const res of answers) {
    assert.equal(res.status, 404, res.text);
    assert.deepEqual(res.body, NOT_FOUND);
    assert.equal(res.cacheControl, "no-store");
  }
  assert.equal((await historyOf(a.feedback.id)).length, 0);
  const ev = await rpeEvent();
  const open = await assignmentOf(athleteTwo, ev.question);
  const unanswered = await change(athleteTwo.cookie, open, body);
  assert.equal(unanswered.status, 409);
  assert.equal(unanswered.body.error, "not_answered");
  for (const bad of [{ rpe: 11, durationMinutes: 30 }, { rpe: 3, durationMinutes: 0 }, { rpe: 3, durationMinutes: 30, note: "x".repeat(501) }, { rpe: 3, durationMinutes: 30, expectedRevision: -1 }]) {
    const res = await change(athlete().cookie, a.assignmentId, bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  const noKey = await api(`/api/training-load/external-assignments/${a.assignmentId}/rpe/change`, { method: "POST", cookie: athlete().cookie, body });
  assert.equal(noKey.status, 400);
  const anon = await api(`/api/training-load/external-assignments/${a.assignmentId}/rpe/change`, { method: "POST", body: { requestKey: newKey(), ...body } });
  assert.equal(anon.status, 401);
});

test("8. one account, two athlete rows (possible in this scaffold; production forbids it by athletes_user_id_unique, migrations/20260802_user_global_roles.sql:59-61): the athlete is the LOCKED assignment's, never the user's first; another user's athlete stays the 404", async () => {
  const a = await answered();
  const { occurrence_id: occ } = await occurrenceOf(a.assignmentId);
  // A second athlete row of the same user, with its own answered assignment.
  const second = (await q(`insert into public.athletes (user_id, full_name, display_name) values ($1, 'second profile', 'second profile') returning id`, [athlete().id]))[0].id;
  const asg = (await q(`insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, closes_at, status, completed_at)
                        values ($1, $2, 'UTC', current_date, now() - interval '1 hour', now() + interval '1 hour', 'completed', now()) returning id`, [occ, second]))[0].id;
  const fb = (await q(`insert into training_load.session_feedback (athlete_id, external_assignment_id, source, event_name, session_date, rpe, duration_minutes)
                       values ($1, $2, 'scheduled_external', 'Second', current_date, 4, 40) returning id`, [second, asg]))[0].id;
  try {
    const own = await change(athlete().cookie, asg, { rpe: 6, durationMinutes: 40 });
    assert.equal(own.status, 200, own.text);
    const [h] = await historyOf(fb);
    assert.equal(h.athlete_id, second, "the history names the assignment's athlete");
    assert.equal(h.changed_by_user_id, athlete().id);
    // The first profile's answer is untouched.
    assert.equal((await feedbackRow(a.feedback.id)).rpe, 7);
    // athleteTwo's account owns neither row: the 404.
    assert.equal((await change(athleteTwo.cookie, asg, { rpe: 7, durationMinutes: 40 })).status, 404);
  } finally {
    // The extra profile must not leak into later tests' reads (authz takes the user's first athlete row).
    await q(`update public.athletes set user_id = null where id = $1`, [second]);
  }
});

test("9. the window by the clock: once closes_at has passed the change is answer_locked with the saved answer; nothing written", async () => {
  const a = await answered();
  const { occurrence_id: occ } = await occurrenceOf(a.assignmentId);
  const { who, id: short } = await customAssignment(occ, { closesIn: "2 seconds" });
  await submit(who, short, { rpe: 5, durationMinutes: 50 });
  await sleep(2500);
  const res = await change(who.cookie, short, { rpe: 6, durationMinutes: 50 });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "answer_locked");
  assert.equal(res.body.feedback.rpe, 5);
  const fb = (await q(`select id, rpe from training_load.session_feedback where external_assignment_id = $1`, [short]))[0];
  assert.equal(fb.rpe, 5);
  assert.equal((await historyOf(fb.id)).length, 0);
});

test("10. the race, the close first: a question stopped (its schedule cancelled) while the change waits on the schedule row → answer_locked, nothing written", async () => {
  const a = await answered();
  const { schedule_id: schedule } = await occurrenceOf(a.assignmentId);
  const closer = await client();
  try {
    await closer.query("begin");
    await closer.query(`update training_load.external_schedules set status = 'cancelled', updated_at = now() where id = $1`, [schedule]);
    const pending = change(athlete().cookie, a.assignmentId, { rpe: 2, durationMinutes: 60 });
    await sleep(400);
    const waiting = (await q(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`))[0].n;
    assert.ok(waiting >= 1, "the change waits on the schedule row");
    await closer.query("commit");
    const res = await pending;
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.error, "answer_locked");
    assert.equal((await feedbackRow(a.feedback.id)).rpe, 7);
    assert.equal((await historyOf(a.feedback.id)).length, 0);
  } finally {
    await closer.end();
  }
});

test("11. the race, the change first: the change holds the locks, the question's stop waits, the change commits, then the stop; the changed answer stays", async () => {
  const a = await answered();
  const { schedule_id: schedule } = await occurrenceOf(a.assignmentId);
  const changer = await client();
  const closer = await client();
  try {
    await changer.query("begin");
    const r = (await changer.query(`select training_load.change_external_rpe($1,$2,$3,3,60,null,0) as r`, [athlete().id, a.assignmentId, newKey()])).rows[0].r;
    assert.equal(r.outcome, "changed");
    const stop = closer.query(`update training_load.external_schedules set status = 'cancelled', updated_at = now() where id = $1`, [schedule]);
    await sleep(300);
    await changer.query("commit");
    await stop;
    assert.equal((await feedbackRow(a.feedback.id)).rpe, 3);
    assert.equal((await historyOf(a.feedback.id)).length, 1);
    assert.equal((await q(`select status from training_load.external_schedules where id = $1`, [schedule]))[0].status, "cancelled");
    // From now on the question is closed.
    assert.equal((await change(athlete().cookie, a.assignmentId, { rpe: 4, durationMinutes: 60 })).body.error, "answer_locked");
  } finally {
    await changer.end();
    await closer.end();
  }
});

test("12. the clock is read after the locks: a window that closes while the change waits on a lock is answer_locked (never the transaction's start time)", async () => {
  const a = await answered();
  const { occurrence_id: occ, schedule_id: schedule } = await occurrenceOf(a.assignmentId);
  const { who, id: short } = await customAssignment(occ, { closesIn: "1500 milliseconds" });
  await submit(who, short);
  const holder = await client();
  try {
    await holder.query("begin");
    await holder.query(`select 1 from training_load.external_schedules where id = $1 for update`, [schedule]);
    const pending = change(who.cookie, short, { rpe: 1, durationMinutes: 60 });
    await sleep(2200);
    await holder.query("commit");
    const res = await pending;
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.error, "answer_locked");
  } finally {
    await holder.end();
  }
});

test("13. a lock held past the bound: 409 try_again, nothing written", async () => {
  const a = await answered();
  const { schedule_id: schedule } = await occurrenceOf(a.assignmentId);
  const holder = await client();
  try {
    await holder.query("begin");
    await holder.query(`select 1 from training_load.external_schedules where id = $1 for update`, [schedule]);
    const res = await change(athlete().cookie, a.assignmentId, { rpe: 1, durationMinutes: 60 });
    assert.equal(res.status, 409, res.text);
    assert.deepEqual(res.body, { error: "try_again", message: "Nothing was saved. Try again." });
  } finally {
    await holder.query("rollback");
    await holder.end();
  }
  assert.equal((await historyOf(a.feedback.id)).length, 0);
});

// ---------------------------------------------------------------------------
// The database guards
// ---------------------------------------------------------------------------
test("14. raw paths are refused: no marker; a marker set by hand without the history row (refused at COMMIT by the deferred link); a history insert without the marker, by another user, outside the window, with wrong old values or revision; history update / delete / truncate; a planned answer even under the marker", async () => {
  const a = await answered();
  const c = await client();
  try {
    await assert.rejects(c.query(`update training_load.session_feedback set rpe = 1 where id = $1`, [a.feedback.id]), /immutable snapshot/);
    // The marker by hand, no history row: the update passes the BEFORE trigger, the COMMIT refuses.
    await c.query("begin");
    await c.query(`select set_config('optimove.rpe_change_tx', pg_current_xact_id()::text, true)`);
    await c.query(`update training_load.session_feedback set rpe = 1 where id = $1`, [a.feedback.id]);
    await assert.rejects(c.query("commit"), (e) => e.code === "23514" && /needs its history row/.test(e.message));
    // A session-level marker never matches a later transaction.
    await c.query(`select set_config('optimove.rpe_change_tx', pg_current_xact_id()::text, false)`);
    await assert.rejects(c.query(`update training_load.session_feedback set rpe = 1 where id = $1`, [a.feedback.id]), /immutable snapshot/);
    await c.query(`select set_config('optimove.rpe_change_tx', '', false)`);

    const insert = (over = {}) => {
      const v = { fb: a.feedback.id, asg: a.assignmentId, ath: athlete().athleteId, rev: 1, by: athlete().id, oldRpe: 7, oldDur: 60, oldNote: "first", ...over };
      return c.query(`insert into training_load.session_feedback_changes (session_feedback_id, external_assignment_id, athlete_id, revision, changed_by_user_id, basis,
                        old_rpe, old_duration_minutes, old_athlete_note, new_rpe, new_duration_minutes, new_athlete_note, request_key, request_hash)
                      values ($1,$2,$3,$4,$5,'athlete_self',$6,$7,$8,2,60,null,$9,$10)`,
      [v.fb, v.asg, v.ath, v.rev, v.by, v.oldRpe, v.oldDur, v.oldNote, newKey(), "0".repeat(64)]);
    };
    await assert.rejects(insert(), (e) => e.code === "42501");
    const withMarker = async (over, pattern, code) => {
      await c.query("begin");
      await c.query(`select set_config('optimove.rpe_change_tx', pg_current_xact_id()::text, true)`);
      await assert.rejects(insert(over), (e) => e.code === code && pattern.test(e.message), JSON.stringify(over));
      await c.query("rollback");
    };
    await withMarker({ by: athleteTwo.id }, /only the athlete/, "42501");
    await withMarker({ oldRpe: 3 }, /old values/, "23514");
    await withMarker({ rev: 2 }, /next one/, "23514");
    await withMarker({ ath: athleteTwo.athleteId, by: athleteTwo.id }, /does not belong/, "23514");
    // Outside the window: the schedule cancelled.
    const { schedule_id: schedule } = await occurrenceOf(a.assignmentId);
    await c.query("begin");
    await c.query(`update training_load.external_schedules set status = 'paused' where id = $1`, [schedule]);
    await c.query(`select set_config('optimove.rpe_change_tx', pg_current_xact_id()::text, true)`);
    await assert.rejects(insert(), (e) => e.code === "23514" && /question is closed/.test(e.message));
    await c.query("rollback");

    // The history is append-only.
    const r = (await c.query(`select training_load.change_external_rpe($1,$2,$3,2,60,null,null) as r`, [athlete().id, a.assignmentId, newKey()])).rows[0].r;
    assert.equal(r.outcome, "changed", "autocommit call");
    await assert.rejects(c.query(`update training_load.session_feedback_changes set new_rpe = 3 where session_feedback_id = $1`, [a.feedback.id]), /append-only/);
    await assert.rejects(c.query(`delete from training_load.session_feedback_changes where session_feedback_id = $1`, [a.feedback.id]), /append-only/);
    await assert.rejects(c.query(`truncate training_load.session_feedback_changes`), /append-only/);

    // A planned answer never changes, even under the marker.
    const planned = (await c.query(`insert into training_load.session_feedback (athlete_id, logical_session_id, source, session_date, rpe, duration_minutes)
                                     values ($1, gen_random_uuid(), 'planned', current_date, 5, 60) returning id`, [athlete().athleteId])).rows[0].id;
    await c.query("begin");
    await c.query(`select set_config('optimove.rpe_change_tx', pg_current_xact_id()::text, true)`);
    await assert.rejects(c.query(`update training_load.session_feedback set rpe = 1 where id = $1`, [planned]), /immutable snapshot/);
    await c.query("rollback");
  } finally {
    await c.end();
  }
});

test("15. the function called from inside a savepoint is refused (rpe_change:in_savepoint) and nothing of it stays; the marker never outlives the function's call", async () => {
  const a = await answered();
  const c = await client();
  try {
    await c.query("begin");
    await c.query("savepoint s1");
    await assert.rejects(
      c.query(`select training_load.change_external_rpe($1,$2,$3,1,60,null,0) as r`, [athlete().id, a.assignmentId, newKey()]),
      (e) => e.code === "55000" && e.message === "rpe_change:in_savepoint",
    );
    await c.query("rollback to savepoint s1");
    assert.equal((await c.query(`select coalesce(current_setting('optimove.rpe_change_tx', true), '') as v`)).rows[0].v, "", "the marker went with the savepoint");
    await c.query("commit");
    assert.equal((await feedbackRow(a.feedback.id)).rpe, 7);
    assert.equal((await historyOf(a.feedback.id)).length, 0);

    // After a successful call in the same transaction, a raw update is refused again (the marker is cleared).
    await c.query("begin");
    assert.equal((await c.query(`select training_load.change_external_rpe($1,$2,$3,2,60,null,0) as r`, [athlete().id, a.assignmentId, newKey()])).rows[0].r.outcome, "changed");
    assert.equal((await c.query(`select coalesce(current_setting('optimove.rpe_change_tx', true), '') as v`)).rows[0].v, "");
    await assert.rejects(c.query(`update training_load.session_feedback set rpe = 9 where id = $1`, [a.feedback.id]), /immutable snapshot/);
    await c.query("rollback");
  } finally {
    await c.end();
  }
});

test("16. the lock order as written: users → schedule → occurrence → assignment → the assignment's athlete → the answer → the first write; a change and a submit of the same schedule, and two changes, run side by side without 40P01", async () => {
  const def = (await q(`select pg_get_functiondef('training_load.change_external_rpe(uuid,uuid,uuid,integer,integer,text,integer)'::regprocedure) as d`))[0].d;
  const steps = [
    /from public\.users where id = p_actor and is_active = true for share/,
    /from training_load\.external_schedules where id = v_lookup\.schedule_id for update/,
    /from training_load\.external_schedule_occurrences where id = v_lookup\.occurrence_id for update/,
    /from training_load\.external_assignments where id = p_assignment for update/,
    /from public\.athletes where id = v_asg\.athlete_id for share/,
    /where external_assignment_id = p_assignment\s+for update/,
    /insert into training_load\.session_feedback_changes/,
    /update training_load\.session_feedback\s+set rpe/,
  ];
  let at = -1;
  for (const re of steps) {
    const i = def.search(re);
    assert.ok(i > at, `${re} after the previous step`);
    at = i;
  }
  assert.equal((def.match(/ for (update|share)/g) || []).length, 6, "no other lock in the function");

  // Side by side: one athlete changes while the other submits on the same schedule, and the first changes twice.
  const ev = await rpeEvent();
  const one = await assignmentOf(athlete(), ev.question);
  const two = await assignmentOf(athleteTwo, ev.question);
  await submit(athlete(), one);
  const results = await Promise.all([
    change(athlete().cookie, one, { rpe: 3, durationMinutes: 60 }),
    api(`/api/training-load/external-assignments/${two}/rpe`, { method: "POST", cookie: athleteTwo.cookie, body: { rpe: 4, durationMinutes: 60 } }),
    change(athlete().cookie, one, { rpe: 2, durationMinutes: 60 }),
  ]);
  for (const res of results) assert.ok([200, 201].includes(res.status), res.text);
  const fb = (await q(`select id from training_load.session_feedback where external_assignment_id = $1`, [one]))[0].id;
  assert.equal((await historyOf(fb)).length, 2, "both changes, serialized");
});

// ---------------------------------------------------------------------------
// The readers: no stale copy (condition 3)
// ---------------------------------------------------------------------------
test("17. readers 17 and 18: canonical_activity_results and the dashboard's built-in rpe / duration / srpe series show the changed values once, before and after (no duplicate, no stale copy); the athlete's own reads too", async () => {
  const a = await answered(athlete(), { rpe: 6, durationMinutes: 50 });
  const activityId = (await q(
    `select ap.activity_id from training.activity_participant_session_links l join training.activity_participants ap on ap.id = l.activity_participant_id
      where l.external_assignment_id = $1 and l.link_status = 'confirmed'`, [a.assignmentId]))[0].activity_id;
  const facts = async () => (await q(`select detail from training.canonical_activity_results($1) where fact_kind = 'rpe' and athlete_id = $2`, [activityId, athlete().athleteId])).map((r) => r.detail);
  const { runDashboardBatchQuery } = await import("../src/trainingLoadDashboardQuery.js");
  const series = async (key) => {
    const [result] = await runDashboardBatchQuery(
      { dataWorkspaceType: "team", dataWorkspaceScopeId: m.teams.t1, dateFrom: TODAY, dateTo: TODAY },
      [{ widgetId: "w", seriesId: "s", builtInSeriesKey: key, dataScopeLevel: "session", aggregationRolePolicy: "standalone_and_source_rollup",
        coveragePolicy: "complete_and_partial", sourcePolicy: "all_with_conflicts", groupBy: "day", analyticalAggregation: "sum" }],
      { queryRunner: (sql, params) => env.admin.query(sql, params) },
    );
    assert.equal(result.status, "ok", JSON.stringify(result));
    return result.data.current.filter((r) => r.athleteId === athlete().athleteId).map((r) => Number(r.value));
  };
  const beforeFacts = await facts();
  assert.equal(beforeFacts.length, 1);
  assert.deepEqual([beforeFacts[0].rpe, beforeFacts[0].durationMinutes, beforeFacts[0].srpe], [6, 50, 300]);
  const srpeBefore = await series("srpe");
  const durBefore = await series("duration_minutes");

  const res = await change(athlete().cookie, a.assignmentId, { rpe: 8, durationMinutes: 80 });
  assert.equal(res.body.outcome, "changed");

  const afterFacts = await facts();
  assert.equal(afterFacts.length, 1, "still one rpe fact, no duplicate");
  assert.deepEqual([afterFacts[0].rpe, afterFacts[0].durationMinutes, afterFacts[0].srpe], [8, 80, 640]);
  const srpeAfter = await series("srpe");
  const durAfter = await series("duration_minutes");
  assert.equal(srpeAfter.length, srpeBefore.length, "the same number of points");
  assert.equal(srpeAfter.reduce((x, y) => x + y, 0) - srpeBefore.reduce((x, y) => x + y, 0), 640 - 300, "the day's sRPE moved by the difference only");
  assert.equal(durAfter.reduce((x, y) => x + y, 0) - durBefore.reduce((x, y) => x + y, 0), 80 - 50, "the duration moved by the difference only");

  const today = await api("/api/training-load/athlete/today", { cookie: athlete().cookie });
  const row = today.body.sessions.find((s) => s.externalAssignmentId === a.assignmentId);
  assert.deepEqual([row.feedback.rpe, row.feedback.durationMinutes, row.feedback.srpe, row.changeable, row.revision], [8, 80, 640, true, 1]);
});

test("18. the athlete's reads carry changeable and revision on her own external rows (false once closed); a coach's /weekly rows carry neither", async () => {
  const a = await answered();
  const { occurrence_id: occ } = await occurrenceOf(a.assignmentId);
  const { who, id: short } = await customAssignment(occ, { closesIn: "2 seconds" });
  await submit(who, short);
  const weekStart = (() => { const d = new Date(`${TODAY}T00:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; return addDays(TODAY, -dow); })();
  const own = await api(`/api/training-load/weekly?weekStart=${weekStart}`, { cookie: who.cookie });
  assert.equal(own.status, 200, own.text);
  const rowOf = (body, id) => body.days.flatMap((d) => d.sessions).find((s) => s.externalAssignmentId === id);
  assert.deepEqual([rowOf(own.body, short).changeable, rowOf(own.body, short).revision], [true, 0]);
  await sleep(2500);
  const later = await api(`/api/training-load/weekly?weekStart=${weekStart}`, { cookie: who.cookie });
  assert.equal(rowOf(later.body, short).changeable, false);
  const todayRead = await api("/api/training-load/athlete/today", { cookie: who.cookie });
  assert.equal(todayRead.body.sessions.find((s) => s.externalAssignmentId === short).changeable, false);
  const coach = await api(`/api/training-load/weekly?weekStart=${weekStart}`, { cookie: role("teamCoach").cookie });
  assert.equal(coach.status, 200, coach.text);
  const coachRow = rowOf(coach.body, a.assignmentId);
  assert.ok(coachRow, "the coach sees the row");
  assert.equal("changeable" in coachRow, false);
  assert.equal("revision" in coachRow, false);
});

test("19. the coach's event panel marks the changed answer (changed, lastChangedAt) for that athlete only; another club's admin still gets the identical 404", async () => {
  const ev = await rpeEvent();
  const one = await assignmentOf(athlete(), ev.question);
  const two = await assignmentOf(athleteTwo, ev.question);
  await submit(athlete(), one);
  await submit(athleteTwo, two);
  assert.equal((await change(athlete().cookie, one, { rpe: 2, durationMinutes: 60 })).body.outcome, "changed");
  const panel = await api(`/api/calendar/events/${ev.eventId}/questions`, { cookie: role("teamCoach").cookie });
  assert.equal(panel.status, 200, panel.text);
  const rpe = panel.body.questions.find((x) => x.kind === "rpe");
  const byId = Object.fromEntries(rpe.answered.map((x) => [x.athleteId, x]));
  assert.equal(byId[athlete().athleteId].changed, true);
  assert.match(byId[athlete().athleteId].lastChangedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual([byId[athleteTwo.athleteId].changed, byId[athleteTwo.athleteId].lastChangedAt], [false, null]);
  assert.equal(rpe.counts.answered, 2, "a change is not a second answer");
  const stranger = await api(`/api/calendar/events/${ev.eventId}/questions`, { cookie: role("stranger").cookie });
  assert.equal(stranger.status, 404);
});

test("20. the submit keeps its contract: a different second answer through it is still 409, and changes nothing", async () => {
  const a = await answered();
  const res = await api(`/api/training-load/external-assignments/${a.assignmentId}/rpe`, { method: "POST", cookie: athlete().cookie, body: { rpe: 1, durationMinutes: 60 } });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "This session already has a submitted result.");
  assert.equal((await historyOf(a.feedback.id)).length, 0);
});

// ---------------------------------------------------------------------------
// The COMMIT
// ---------------------------------------------------------------------------
test("21. the COMMIT: an answer lost after a real COMMIT is verified (200, verifiedAfterCommitError, the event sent); a COMMIT never sent is 503 outcome_unknown (no event) and Check result with the same key changes once; a COMMIT the server refuses is 500 nothing saved", async () => {
  // (a) Committed, answer lost.
  const a = await answered();
  emitted.length = 0;
  hooks.commit = async (cl) => { await cl.query("commit"); throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" }); };
  const lost = await change(athlete().cookie, a.assignmentId, { rpe: 3, durationMinutes: 60 });
  assert.equal(lost.status, 200, lost.text);
  assert.equal(lost.body.verifiedAfterCommitError, true);
  assert.equal(lost.body.feedback.rpe, 3);
  assert.equal(emitted.length, 1);

  // (b) Never committed: no answer within the bound.
  const b = await answered();
  emitted.length = 0;
  hooks.commitTimeoutMs = 200;
  hooks.commit = () => new Promise(() => {});
  const key = newKey();
  const unknown = await change(athlete().cookie, b.assignmentId, { requestKey: key, rpe: 4, durationMinutes: 60 });
  assert.equal(unknown.status, 503, unknown.text);
  assert.deepEqual(unknown.body, { error: "outcome_unknown", message: "We can't tell yet whether your change was saved." });
  assert.equal(emitted.length, 0, "no event without a confirmed COMMIT");
  hooks.commit = null;
  hooks.commitTimeoutMs = null;
  await sleep(200);
  const check = await change(athlete().cookie, b.assignmentId, { requestKey: key, rpe: 4, durationMinutes: 60 });
  assert.equal(check.status, 200, check.text);
  assert.ok(["changed", "replayed"].includes(check.body.outcome));
  assert.equal((await historyOf(b.feedback.id)).length, 1, "changed once");

  // (c) The server refuses the COMMIT.
  const c = await answered();
  hooks.commit = (cl) => cl.query("select 1/0");
  const refused = await change(athlete().cookie, c.assignmentId, { rpe: 5, durationMinutes: 60 });
  hooks.commit = null;
  assert.equal(refused.status, 500, refused.text);
  assert.deepEqual(refused.body, { error: "internal_error", message: "Nothing was saved. Try again." });
  assert.equal((await historyOf(c.feedback.id)).length, 0);
  assert.equal((await feedbackRow(c.feedback.id)).rpe, 7);
});

test("22. the closing edge: the function passed but the history guard's own clock read refused (23514 'the question is closed') - the athlete gets answer_locked, not a 500; nothing written", async () => {
  const a = await answered();
  // The guard's refusal, raised where it would arrive (inside the change's transaction, before the COMMIT).
  hooks.afterFunction = (cl) => cl.query(`do $$ begin raise exception 'training_load.session_feedback_changes: the question is closed' using errcode = '23514'; end $$`);
  try {
    const res = await change(athlete().cookie, a.assignmentId, { rpe: 2, durationMinutes: 60 });
    assert.equal(res.status, 409, res.text);
    assert.deepEqual(res.body, { error: "answer_locked", message: "This answer can no longer be changed. The question is closed." });
  } finally {
    hooks.afterFunction = null;
  }
  assert.equal((await feedbackRow(a.feedback.id)).rpe, 7);
  assert.equal((await historyOf(a.feedback.id)).length, 0);
});
