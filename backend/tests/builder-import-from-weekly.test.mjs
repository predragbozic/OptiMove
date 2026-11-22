// Import into a program or a block template FROM a weekly plan (the Builder's
// "Copy from another plan" dialog, owner order 2026-11-22), and the section
// pictures of that dialog (GET /sessions/:id/nodes?items=1).
//
// The paste routes (POST /blocks/:id/copy-into/:dayId, /days/:id/copy-into/:dayId,
// /sessions/:id/copy-into/:dayId) used to refuse every target but a weekly plan.
// Now a program or block-template target takes content from a WEEKLY plan only;
// rights, workspace scope, the published-plan session guard (Task 5) and the
// content-only rule are unchanged.
//
// One disposable database (optimove_tests_builder_importweekly_*): the committed
// legacy-schema snapshot plus every migration of migrations_v2 through the real
// runner; the real Express app in-process over HTTP with real session cookies;
// dropped at the end. Synthetic names only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createDisposableDatabase, dropDisposableDatabase } from "./support/disposable-db.mjs";
import { bootstrapLegacySnapshot } from "./support/legacy-bootstrap.mjs";
import { runMigrations } from "../src/migrate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(__dirname, "../../migrations_v2");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (a local PostgreSQL server; a disposable database is created on it).");
const BASE_URL = process.env.DATABASE_URL;

const WEEK = "2026-11-02";

let db;
let admin;
let server;
let apiBase;
let appPool;
let createSession;

const uid = () => crypto.randomBytes(4).toString("hex");
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;

async function api(pathname, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };

async function makeUser(label) {
  const [first, ...rest] = label.split(" ");
  return (await q(`insert into public.users (email, first_name, last_name, full_name, display_name) values ($1,$2,$3,$4,$4) returning id`, [`${label.replace(/\W+/g, ".")}-${uid()}@example.invalid`, first, rest.join(" ") || "Example", label]))[0].id;
}
async function setWorkspace(userId, type, scopeId) {
  await q(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
async function cookieOf(userId) { return `optimove_session=${await createSession(userId)}`; }
async function makeAthlete(name, clubId, teamId) {
  const userId = await makeUser(name);
  const [first, last] = name.split(" ");
  const row = (await q(
    `insert into public.athletes (athlete_id, user_id, first_name, last_name, full_name, display_name, device_timezone)
     values (nextval('public.athlete_generated_id_seq')::text, $1, $2, $3, $4, $4, 'UTC') returning id, athlete_id`,
    [userId, first, last, name]))[0];
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,null,'club','active','2026-01-01T00:00:00Z')`, [row.id, clubId]);
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [row.id, clubId, teamId]);
  await setWorkspace(userId, "athlete", null);
  return { name, athleteId: row.id, externalId: row.athlete_id, userId, cookie: await cookieOf(userId) };
}

// A team of two athletes and its coach, planned RPE switched on.
async function squad(label) {
  const clubId = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} Club ${uid()}`]))[0].id;
  await q(`select calendar.seed_club_event_types($1)`, [clubId]);
  const teamId = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} Team ${uid()}`]))[0].id;
  const coachId = await makeUser(`${label} Coach`);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachId, teamId]);
  await setWorkspace(coachId, "team", teamId);
  const coach = { id: coachId, cookie: await cookieOf(coachId) };
  const athletes = [];
  for (const n of ["One", "Two"]) athletes.push(await makeAthlete(`${label} Athlete${n}`, clubId, teamId));
  await q(`insert into training_load.planned_rpe_workspace_settings (owner_scope, owner_team_id, enabled, enabled_at, updated_by_user_id)
           values ('team', $1, true, '2026-01-01T00:00:00Z', $2)`, [teamId, coach.id]);
  return { clubId, teamId, coach, athletes };
}

const sessionsOf = (draft) => (draft.blocks || []).flatMap((b) => (b.sessions || []).map((s) => ({ ...s, blockId: b.id })));
const nodesOf = (session) => session.nodes || [];

// A published weekly plan for the squad's first athlete: Monday "Main" (Training,
// tracked, RPE on) with a domain > section "Lower body" holding one exercise.
async function weeklyPlan(s) {
  const ids = [s.athletes[0].externalId];
  const created = ok(await api("/api/builder/plans", { method: "POST", cookie: s.coach.cookie, body: { planType: "weekly", weekStart: WEEK, athleteIds: ids, athleteExternalIds: ids, name: "Source week" } }), 201);
  const planId = created.plan.id;
  let draft = ok(await api(`/api/builder/plans/${planId}`, { cookie: s.coach.cookie }));
  draft = ok(await api(`/api/builder/blocks/${draft.blocks[0].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta: "T", amPm: "AM", time: "09:30", name: "Main" } }), 201);
  const session = sessionsOf(draft).find((x) => x.name === "Main");
  draft = ok(await api(`/api/builder/sessions/${session.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { trackingEnabled: true, rpeEnabled: true } }));
  draft = ok(await api(`/api/builder/sessions/${session.id}/nodes`, { method: "POST", cookie: s.coach.cookie, body: { nodeType: "domain", name: "Strength" } }), 201);
  const domain = nodesOf(sessionsOf(draft).find((x) => x.id === session.id)).find((n) => n.type === "domain");
  draft = ok(await api(`/api/builder/sessions/${session.id}/nodes`, { method: "POST", cookie: s.coach.cookie, body: { nodeType: "section", name: "Lower body", parentId: domain.id } }), 201);
  const section = nodesOf(sessionsOf(draft).find((x) => x.id === session.id)).find((n) => n.type === "section");
  const res = await api(`/api/builder/nodes/${section.id}/custom-exercise`, { method: "POST", cookie: s.coach.cookie, body: { name: "Squat import test" } });
  assert.ok(res.status < 300, res.text);
  ok(await api(`/api/builder/plans/${planId}/submit`, { method: "POST", cookie: s.coach.cookie, body: { responseMode: "summary" } }));
  const day = (await q(`select id from plans.plan_days where plan_id = $1 order by day_order limit 1`, [planId]))[0].id;
  return { planId, dayId: day, sessionId: session.id, sectionId: section.id };
}

// A program or block template of the coach with one empty block (or a block
// holding one session with a section and `items` exercises).
async function program(s, { template = false, status = "draft", items = null, name = "Target program" } = {}) {
  const planId = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, name, status, source_type, visibility, is_template)
     values ('program', $1, $2, $3, 'builder', 'private', $4) returning id`, [s.coach.id, name, status, template]))[0].id;
  const blockId = (await q(`insert into plans.plan_days (plan_id, block_index, block_order, block_name, block_type) values ($1, 1, 1, 'Block A', 'session') returning id`, [planId]))[0].id;
  let sessionId = null;
  let sectionId = null;
  if (items !== null) {
    sessionId = (await q(`insert into plans.plan_sessions (plan_day_id, am_pm, bta, session_order, name) values ($1,'AM','T',0,'Old session') returning id`, [blockId]))[0].id;
    sectionId = (await q(`insert into plans.plan_nodes (plan_session_id, node_type, name, node_order) values ($1,'section','Old section',0) returning id`, [sessionId]))[0].id;
    for (let i = 0; i < items; i += 1) {
      await q(`insert into plans.plan_items (plan_session_id, plan_node_id, item_type, title, item_order) values ($1,$2,'exercise',$3,$4)`, [sessionId, sectionId, `Old exercise ${i + 1}`, i]);
    }
  }
  return { planId, blockId, sessionId, sectionId };
}

async function blockTree(blockId) {
  return q(
    `select ps.name as session_name, ps.am_pm, ps.bta, ps.session_time::text as session_time, ps.rpe_enabled, ps.training_load_enabled, ps.logical_session_id,
            pn.node_type, pn.name as node_name, pi.title
       from plans.plan_sessions ps
       left join plans.plan_nodes pn on pn.plan_session_id = ps.id
       left join plans.plan_items pi on pi.plan_node_id = pn.id
      where ps.plan_day_id = $1
      order by ps.session_order, pn.node_order, pi.item_order`, [blockId]);
}

const paste = (cookie, sourceDayId, targetDayId, extra = {}) => api(`/api/builder/blocks/${sourceDayId}/copy-into/${targetDayId}`, { method: "POST", cookie, body: extra });
const pasteSession = (cookie, sourceSessionId, targetDayId) => api(`/api/builder/sessions/${sourceSessionId}/copy-into/${targetDayId}`, { method: "POST", cookie, body: {} });

// The four tables whose rows name a session by its logical id (RPE, activity
// link, metric event participant) or by its slot (event link).
async function resultsFootprint(logicalIds, planIds) {
  const [r] = await q(
    `select (select count(*)::int from training_load.session_feedback where logical_session_id = any($1::uuid[])) as rpe,
            (select count(*)::int from training.activity_participant_session_links where logical_session_id = any($1::uuid[])) as links,
            (select count(*)::int from training_load.metric_event_participants where logical_session_id = any($1::uuid[])) as participants,
            (select count(*)::int from calendar.event_session_links where plan_id = any($2::uuid[]) or logical_session_id_at_link = any($1::uuid[])) as events`,
    [logicalIds, planIds]);
  return r;
}
const totals = async () => (await q(
  `select (select count(*)::int from training_load.session_feedback) as rpe,
          (select count(*)::int from training.activity_participant_session_links) as links,
          (select count(*)::int from training_load.metric_event_participants) as participants,
          (select count(*)::int from calendar.event_session_links) as events,
          (select count(*)::int from training_load.metric_events) as metric_events`))[0];

before(async () => {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "support/legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  db = await createDisposableDatabase({ prefix: "builder", label: "importweekly", baseDatabaseUrl: BASE_URL });
  await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
  await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the disposable database");
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is on the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((r) => server.listen(0, r));
  apiBase = `http://localhost:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (appPool) await appPool.end().catch(() => {});
  if (admin) await admin.end().catch(() => {});
  if (db) await dropDisposableDatabase({ name: db.name, adminUrl: db.adminUrl, baseDatabaseUrl: BASE_URL }).catch(() => {});
});

test("1. a weekly day pasted into an empty program block (a program and a block template alike) brings the whole tree, as new sessions", async () => {
  const s = await squad("tree");
  const source = await weeklyPlan(s);
  for (const template of [false, true]) {
    const target = await program(s, { template });
    const dayBefore = await q(`select block_name, day_note, date from plans.plan_days where id = $1`, [target.blockId]);
    const res = await paste(s.coach.cookie, source.dayId, target.blockId);
    assert.equal(res.status, 200, res.text);
    const rows = await blockTree(target.blockId);
    assert.deepEqual([...new Set(rows.map((r) => r.node_type))].sort(), ["domain", "section"]);
    assert.ok(rows.some((r) => r.title === "Squat import test"), "the exercise came along");
    const [copy] = rows;
    // Content properties travel; the identity is new.
    assert.deepEqual({ name: copy.session_name, amPm: copy.am_pm, bta: copy.bta, time: copy.session_time, rpe: copy.rpe_enabled, tracking: copy.training_load_enabled },
      { name: "Main", amPm: "AM", bta: "T", time: "09:30:00", rpe: true, tracking: true });
    const sourceLogical = (await q(`select logical_session_id from plans.plan_sessions where id = $1`, [source.sessionId]))[0].logical_session_id;
    assert.notEqual(String(copy.logical_session_id), String(sourceLogical), "a fresh logical session id, never the source's");
    // A program block has no date: the day's own columns are untouched.
    assert.deepEqual(await q(`select block_name, day_note, date from plans.plan_days where id = $1`, [target.blockId]), dayBefore);
  }
});

test("2. content only: no RPE, activity link, metric participant or event link comes along, and the source's records stay", async () => {
  const s = await squad("content");
  const source = await weeklyPlan(s);
  const sourceLogical = String((await q(`select logical_session_id from plans.plan_sessions where id = $1`, [source.sessionId]))[0].logical_session_id);
  // RPE, an activity linked to the session, a metric event participant and a live event link.
  await q(`insert into training_load.session_feedback (athlete_id, plan_session_id, logical_session_id, session_date, plan_name, plan_week_start, rpe, duration_minutes)
           values ($1,$2,$3,$4,'Source week',$4,6,60)`, [s.athletes[0].athleteId, source.sessionId, sourceLogical, WEEK]);
  const made = await api("/api/training-activity/materialize", { method: "POST", cookie: s.coach.cookie, body: { requestKey: uid(), planLogicalSessionId: sourceLogical, athleteId: s.athletes[0].athleteId } });
  assert.equal(made.status, 201, made.text);
  const eventId = (await q(
    `insert into training_load.metric_events (event_name, occurred_date, scope_level, owner_scope, owner_team_id, source_external_id, event_timezone_snapshot)
     values ('GPS session', $1, 'session', 'team', $2, $3, 'UTC') returning id`, [WEEK, s.teamId, `test:${uid()}`]))[0].id;
  await q(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot, logical_session_id) values ($1,$2,'UTC',$3)`, [eventId, s.athletes[0].athleteId, sourceLogical]);
  const types = ok(await api("/api/calendar/events/types", { cookie: s.coach.cookie }));
  const ev = ok(await api("/api/calendar/events", { method: "POST", cookie: s.coach.cookie, body: { requestKey: crypto.randomUUID(), timezone: "UTC", eventTypeId: types.types.find((t) => t.kind === "training").id, title: "Team training", day: WEEK, targets: [{ kind: "team", id: s.teamId }] } }), 201).event;
  ok(await api(`/api/calendar/events/${ev.id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { requestKey: crypto.randomUUID(), expectedRevision: 1, logicalSessionIds: [sourceLogical] } }));

  const sourceBefore = await resultsFootprint([sourceLogical], [source.planId]);
  assert.ok(sourceBefore.rpe >= 1 && sourceBefore.links >= 1 && sourceBefore.participants >= 1 && sourceBefore.events >= 1, JSON.stringify(sourceBefore));
  const totalsBefore = await totals();

  const target = await program(s);
  ok(await paste(s.coach.cookie, source.dayId, target.blockId));
  const copies = (await blockTree(target.blockId)).map((r) => String(r.logical_session_id));
  assert.ok(copies.length >= 1);
  assert.deepEqual(await resultsFootprint(copies, [target.planId]), { rpe: 0, links: 0, participants: 0, events: 0 }, "nothing names the copy");
  assert.deepEqual(await totals(), totalsBefore, "no result, link or participant row was created or removed anywhere");
  assert.deepEqual(await resultsFootprint([sourceLogical], [source.planId]), sourceBefore, "the source's own records are untouched");

  // The single-session route is content only too.
  const target2 = await program(s);
  ok(await pasteSession(s.coach.cookie, source.sessionId, target2.blockId));
  const copy2 = (await blockTree(target2.blockId)).map((r) => String(r.logical_session_id));
  assert.deepEqual(await resultsFootprint(copy2, [target2.planId]), { rpe: 0, links: 0, participants: 0, events: 0 });
  assert.deepEqual(await totals(), totalsBefore);
});

test("3. a whole session pasted into a program block is appended after the block's own sessions", async () => {
  const s = await squad("session");
  const source = await weeklyPlan(s);
  const target = await program(s, { items: 1 });
  ok(await pasteSession(s.coach.cookie, source.sessionId, target.blockId));
  const orders = await q(`select name, session_order from plans.plan_sessions where plan_day_id = $1 order by session_order`, [target.blockId]);
  assert.deepEqual(orders.map((r) => r.name), ["Old session", "Main"]);
  assert.ok(orders[1].session_order > orders[0].session_order);
});

test("4. a block that already has sessions asks first; confirmed, its content is replaced", async () => {
  const s = await squad("overwrite");
  const source = await weeklyPlan(s);
  const target = await program(s, { items: 2 });
  const refused = await paste(s.coach.cookie, source.dayId, target.blockId);
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual((await blockTree(target.blockId)).map((r) => r.session_name), ["Old session", "Old session", "Old session"], "nothing was replaced");
  ok(await paste(s.coach.cookie, source.dayId, target.blockId, { confirmOverwrite: true }));
  const names = new Set((await blockTree(target.blockId)).map((r) => r.session_name));
  assert.deepEqual([...names], ["Main"]);
});

test("5. the published-plan session guard still protects a program target: a session a record names is not removed by a paste", async () => {
  const s = await squad("guard");
  const source = await weeklyPlan(s);
  const target = await program(s, { status: "active", items: 1 });
  const logical = String((await q(`select logical_session_id from plans.plan_sessions where id = $1`, [target.sessionId]))[0].logical_session_id);
  const eventId = (await q(
    `insert into training_load.metric_events (event_name, occurred_date, scope_level, owner_scope, owner_team_id, source_external_id, event_timezone_snapshot)
     values ('GPS session', $1, 'session', 'team', $2, $3, 'UTC') returning id`, [WEEK, s.teamId, `test:${uid()}`]))[0].id;
  await q(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot, logical_session_id) values ($1,$2,'UTC',$3)`, [eventId, s.athletes[0].athleteId, logical]);
  const before = await blockTree(target.blockId);
  const res = await paste(s.coach.cookie, source.dayId, target.blockId, { confirmOverwrite: true });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.code, "edit_sessions_locked");
  assert.deepEqual(await blockTree(target.blockId), before, "nothing was written");
  // Appending a session removes nothing, so it still works on that block.
  ok(await pasteSession(s.coach.cookie, source.sessionId, target.blockId));
});

test("6. rights first: an unreadable source and a missing one are the same 404, and so are a target the caller may not edit and a missing one", async () => {
  const s = await squad("rights");
  const other = await squad("stranger");
  const source = await weeklyPlan(s);
  const target = await program(s);
  const strangersProgram = await program(other);
  const missing = crypto.randomUUID();

  // The stranger cannot read the source plan, nor edit the target program.
  const unreadable = await paste(other.coach.cookie, source.dayId, strangersProgram.blockId);
  const absent = await paste(other.coach.cookie, missing, strangersProgram.blockId);
  assert.equal(unreadable.status, 404, unreadable.text);
  assert.deepEqual(unreadable.body, absent.body, "unreadable = missing source");
  const notMine = await paste(other.coach.cookie, source.dayId, target.blockId);
  const noTarget = await paste(other.coach.cookie, source.dayId, missing);
  assert.equal(notMine.status, 404, notMine.text);
  assert.deepEqual(notMine.body, noTarget.body, "not editable = missing target");
  const sessionUnreadable = await pasteSession(other.coach.cookie, source.sessionId, strangersProgram.blockId);
  const sessionAbsent = await pasteSession(other.coach.cookie, missing, strangersProgram.blockId);
  assert.equal(sessionUnreadable.status, 404, sessionUnreadable.text);
  assert.deepEqual(sessionUnreadable.body, sessionAbsent.body);
  // Nothing of the source reached the stranger's program or the coach's.
  assert.deepEqual(await blockTree(strangersProgram.blockId), []);
  assert.deepEqual(await blockTree(target.blockId), []);
  // An unreadable source never gets a kind answer: a missing source into a program is 404, not 400.
  assert.equal((await paste(s.coach.cookie, missing, target.blockId)).status, 404);
});

test("7. only a weekly plan may feed a program or template: a program or template source into a program target is refused, nothing written", async () => {
  const s = await squad("kinds");
  const sourceProgram = await program(s, { items: 1, name: "Source program" });
  const sourceTemplate = await program(s, { items: 1, template: true, name: "Source template" });
  const target = await program(s);
  const sessionOfTemplate = (await q(`select id from plans.plan_sessions where plan_day_id = $1`, [sourceTemplate.blockId]))[0].id;
  for (const res of [
    await paste(s.coach.cookie, sourceProgram.blockId, target.blockId),
    await paste(s.coach.cookie, sourceTemplate.blockId, target.blockId),
    await pasteSession(s.coach.cookie, sessionOfTemplate, target.blockId),
    // the same-plan day route: both days are program blocks
    await api(`/api/builder/days/${sourceProgram.blockId}/copy-into/${target.blockId}`, { method: "POST", cookie: s.coach.cookie, body: {} }),
  ]) {
    assert.equal(res.status, 400, res.text);
    assert.match(res.body.error, /only available from a weekly plan/);
  }
  assert.deepEqual(await blockTree(target.blockId), []);
  // The old direction is as before: a program block into a weekly day still works.
  const weekly = await weeklyPlan(s);
  const emptyDay = (await q(`select id from plans.plan_days where plan_id = $1 order by day_order offset 1 limit 1`, [weekly.planId]))[0].id;
  ok(await paste(s.coach.cookie, sourceProgram.blockId, emptyDay));
});

test("8. GET /sessions/:id/nodes?items=1 adds each section's first exercises (capped), only when asked, with the same access as the nodes", async () => {
  const s = await squad("thumbs");
  const other = await squad("thumbsstranger");
  const source = await program(s, { items: 14, template: true });
  const plain = ok(await api(`/api/builder/sessions/${source.sessionId}/nodes`, { cookie: s.coach.cookie }));
  assert.ok(plain.nodes.every((n) => n.items === undefined), "no items unless asked");
  const asked = ok(await api(`/api/builder/sessions/${source.sessionId}/nodes?items=1`, { cookie: s.coach.cookie }));
  const section = asked.nodes.find((n) => n.type === "section");
  assert.equal(section.itemCount, 14);
  assert.equal(section.items.length, 12, "capped");
  assert.deepEqual(section.items.slice(0, 2).map((i) => i.title), ["Old exercise 1", "Old exercise 2"], "in item order");
  for (const key of ["id", "title", "titleEn", "imageUrl", "videoUrl"]) assert.ok(key in section.items[0], key);
  assert.ok(!("description" in section.items[0]) && !("exerciseId" in section.items[0]), "title and media only");
  // A weekly source's section works the same, and a stranger gets the plain 404 for both.
  const weekly = await weeklyPlan(s);
  const weeklyNodes = ok(await api(`/api/builder/sessions/${weekly.sessionId}/nodes?items=1`, { cookie: s.coach.cookie }));
  assert.deepEqual(weeklyNodes.nodes.find((n) => n.type === "section").items.map((i) => i.title), ["Squat import test"]);
  const hidden = await api(`/api/builder/sessions/${source.sessionId}/nodes?items=1`, { cookie: other.coach.cookie });
  const absent = await api(`/api/builder/sessions/${crypto.randomUUID()}/nodes?items=1`, { cookie: other.coach.cookie });
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.body, absent.body);
});
