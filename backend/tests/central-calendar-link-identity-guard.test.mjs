// The link identity guard (central calendar): a calendar event's session link
// is keyed by its slot (plan, day, AM/PM, B/T/A, session_order) and remembers
// the session it was made for (logical_session_id_at_link, migration v49). A
// session that was removed or moved, and another session that took the slot
// (a new session reuses the day's order), must never be read, folded, timed or
// aligned as the linked one: the link reads as ORPHANED. Re-linking in the same
// event replaces the orphan; another event's orphan still holds the slot.
//
// How the orphans are made: since the Builder's source session guard (task 5,
// docs/ai/builder-batch-edit-plan.md section 12), no Builder path can remove,
// move or replace a session an event links (test 7 pins that). An orphan now
// comes only from a row written before that guard, or from the race of plan
// 12.4, and the readers must handle it however it arose. So tests 1-6 make it
// with raw SQL on the published plan's sessions, in the shape each Builder
// path used to leave behind.
//
// One disposable database (optimove_tests_calendar_linkguard_*): the committed
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

const WEEK = "2026-11-02"; // a past Monday
const SUNDAY = "2026-11-08";

let db;
let admin;
let server;
let apiBase;
let appPool;
let createSession;

const uid = () => crypto.randomBytes(4).toString("hex");
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
async function api(pathname, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${apiBase}${pathname}`, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
}
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res.body; };
const sessionsOf = (draft) => (draft.blocks || []).flatMap((b) => (b.sessions || []).map((s) => ({ ...s, blockId: b.id })));

before(async () => {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "support/legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  db = await createDisposableDatabase({ prefix: "calendar", label: "linkguard", baseDatabaseUrl: BASE_URL });
  await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
  await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the disposable database");
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  assert.equal((await appPool.query("select current_database() as d")).rows[0].d, db.name, "SAFETY: the app pool is on the disposable database");
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

async function world(label) {
  const clubId = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} Club ${uid()}`]))[0].id;
  await q(`select calendar.seed_club_event_types($1)`, [clubId]);
  const teamId = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} Team ${uid()}`]))[0].id;
  const coachId = (await q(`insert into public.users (email, first_name, last_name, full_name, display_name) values ($1,'Guard','Coach','Guard Coach','Guard Coach') returning id`, [`coach-${uid()}@example.invalid`]))[0].id;
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachId, teamId]);
  await q(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,'team',$2)`, [coachId, teamId]);
  const cookie = `optimove_session=${await createSession(coachId)}`;
  const userId = (await q(`insert into public.users (email, first_name, last_name, full_name, display_name) values ($1,'Guard','Athlete','Guard Athlete','Guard Athlete') returning id`, [`athlete-${uid()}@example.invalid`]))[0].id;
  const athlete = (await q(`insert into public.athletes (athlete_id, user_id, first_name, last_name, full_name, display_name, device_timezone)
     values (nextval('public.athlete_generated_id_seq')::text, $1, 'Guard', 'Athlete', 'Guard Athlete', 'Guard Athlete', 'UTC') returning id`, [userId]))[0];
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,null,'club','active','2026-01-01T00:00:00Z')`, [athlete.id, clubId]);
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [athlete.id, clubId, teamId]);
  const ext = (await q(`select coalesce(source_external_id, athlete_id) as x from public.athletes where id = $1`, [athlete.id]))[0].x;
  return { teamId, cookie, athleteId: athlete.id, ext };
}

// A session with one exercise (an empty plan is dropped on Save).
async function addSession(cookie, blockId, name, { bta = "T" } = {}) {
  let draft = ok(await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie, body: { bta, name } }), 201);
  const session = sessionsOf(draft).find((x) => x.name === name);
  draft = ok(await api(`/api/builder/sessions/${session.id}/nodes`, { method: "POST", cookie, body: { nodeType: "domain", name: "Strength" } }), 201);
  const domain = (sessionsOf(draft).find((x) => x.id === session.id).nodes || []).find((n) => n.type === "domain");
  draft = ok(await api(`/api/builder/sessions/${session.id}/nodes`, { method: "POST", cookie, body: { nodeType: "section", name: "Lower body", parentId: domain.id } }), 201);
  const section = (sessionsOf(draft).find((x) => x.id === session.id).nodes || []).find((n) => n.type === "section");
  const res = await api(`/api/builder/nodes/${section.id}/custom-exercise`, { method: "POST", cookie, body: { name: `${name} squat` } });
  assert.ok(res.status < 300, res.text);
  return res.body;
}

// A published weekly plan with Monday "Main" (Training), linked to a planned training event that asks RPE.
async function linkedWorld(label, { mondayBefore = [], tuesday = [] } = {}) {
  const w = await world(label);
  const created = ok(await api("/api/builder/plans", { method: "POST", cookie: w.cookie, body: { planType: "weekly", weekStart: WEEK, athleteIds: [w.ext], athleteExternalIds: [w.ext], name: "Guard week" } }), 201);
  const draft = ok(await api(`/api/builder/plans/${created.plan.id}`, { cookie: w.cookie }));
  for (const name of mondayBefore) await addSession(w.cookie, draft.blocks[0].id, name);
  await addSession(w.cookie, draft.blocks[0].id, "Main");
  for (const name of tuesday) await addSession(w.cookie, draft.blocks[1].id, name);
  ok(await api(`/api/builder/plans/${created.plan.id}/submit`, { method: "POST", cookie: w.cookie, body: { responseMode: "summary" } }));
  const planId = (await q(`select id from plans.plans where athlete_id = $1 and plan_type = 'weekly' and status = 'active' and not coalesce(is_edit_draft,false)`, [w.athleteId]))[0].id;
  const main = await sessionNamed(planId, "Main");
  const ev = await eventOf(w, "Team training");
  ok(await api(`/api/calendar/events/${ev.id}/sessions`, { method: "POST", cookie: w.cookie, body: { requestKey: crypto.randomUUID(), expectedRevision: await revisionOf(ev.id), logicalSessionIds: [String(main.logical_session_id)] } }));
  return { ...w, planId, main, ev };
}
async function eventOf(w, title) {
  const types = ok(await api("/api/calendar/events/types", { cookie: w.cookie }));
  const type = types.types.find((t) => t.kind === "training");
  return ok(await api("/api/calendar/events", { method: "POST", cookie: w.cookie, body: {
    requestKey: crypto.randomUUID(), timezone: "UTC", eventTypeId: type.id, title, day: WEEK, startTime: "10:00", endTime: "11:30",
    expects: ["rpe"], targets: [{ kind: "team", id: w.teamId }],
  } }), 201).event;
}
const revisionOf = async (eventId) => Number((await q(`select revision from calendar.events where id = $1`, [eventId]))[0].revision);
const sessionNamed = async (planId, name) => (await q(
  `select ps.id, ps.name, ps.am_pm, ps.bta, ps.session_order, ps.logical_session_id, ps.rpe_enabled, ps.training_load_enabled
     from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 and ps.name = $2`, [planId, name]))[0];

// The coach reopens the plan, applies `change(edit draft)`, and saves.
async function editAndSave(w, change) {
  const edit = ok(await api(`/api/builder/plans/${w.planId}/edit`, { method: "POST", cookie: w.cookie }));
  await change(edit);
  ok(await api(`/api/builder/plans/${edit.plan.id}/submit`, { method: "POST", cookie: w.cookie, body: { responseMode: "summary" } }));
}
// The linked Main replaced in its slot by another session (another logical id, the same order, named `name`), as a
// remove-and-add used to leave it: raw SQL on the published plan.
async function removeMainAddNew(w, name) {
  await q(`update plans.plan_sessions set logical_session_id = gen_random_uuid(), name = $2, updated_at = now() where id = $1`, [w.main.id, name]);
}
// Main deleted and `sessionId` (another day's, or another plan's) put into Main's slot, with a new logical id (a
// paste copies under a new identity) or its own (a session moved in): raw SQL on the published plan.
async function intoLinkedSlot(w, sessionId, { newIdentity }) {
  const day = (await q(`select plan_day_id from plans.plan_sessions where id = $1`, [w.main.id]))[0].plan_day_id;
  await q(`delete from plans.plan_sessions where id = $1`, [w.main.id]);
  await q(`update plans.plan_sessions set plan_day_id = $2, am_pm = $3, bta = $4, session_order = $5, updated_at = now(),
                  logical_session_id = case when $6::boolean then gen_random_uuid() else logical_session_id end
            where id = $1`, [sessionId, day, w.main.am_pm, w.main.bta, w.main.session_order, newIdentity]);
}

// Everything the four guarded reads say about the event's link and the session `name`.
async function readsOf(w, name) {
  const view = ok(await api(`/api/calendar/events/${w.ev.id}`, { cookie: w.cookie })).event;
  const cal = ok(await api(`/api/calendar?from=${WEEK}&to=${SUNDAY}&today=2026-11-20`, { cookie: w.cookie }));
  const items = cal.days.flatMap((d) => d.items);
  const card = items.find((i) => i.kind === "event" && i.links?.eventId === w.ev.id);
  const planned = items.filter((i) => i.kind === "planned").map((i) => i.title);
  const weekly = ok(await api(`/api/athletes/${encodeURIComponent(w.ext)}/program-data?program=__weekly__`, { cookie: w.cookie }));
  const rows = (weekly.rows || []).filter((r) => r.session_name === name);
  const session = await sessionNamed(w.planId, name);
  return { links: view.sessionLinks, card, planned, rows, session };
}
async function align(w) {
  return api(`/api/calendar/events/${w.ev.id}/sessions/align`, { method: "POST", cookie: w.cookie, body: { requestKey: crypto.randomUUID(), expectedRevision: await revisionOf(w.ev.id) } });
}
function assertOrphaned(r, label) {
  assert.equal(r.links.length, 1, label);
  assert.equal(r.links[0].state, "orphaned", `${label}: the link reads as orphaned`);
  assert.equal(r.links[0].sessionName, null, `${label}: no session is named as the linked one`);
  assert.deepEqual(r.card.links.logicalSessionIds, [], `${label}: nothing folds under the event`);
  assert.equal(r.card.links.orphanedSessionLinks, 1, `${label}: the orphan is counted on the card`);
  assert.equal(r.card.links.renamedSessionLinks, 0, label);
  assert.ok(r.rows.length > 0, `${label}: the weekly plan has the session`);
  assert.ok(r.rows.every((row) => row.linked_event_start_time == null && row.linked_event_end_time == null), `${label}: no event time on it`);
}

test("1. the linked session removed and a new one added in its slot (the same order): orphaned, nothing folded, no event time, align does not touch it", async () => {
  const w = await linkedWorld("replaced");
  await removeMainAddNew(w, "Gym");
  const r = await readsOf(w, "Gym");
  assert.equal(Number(r.session.session_order), Number(w.main.session_order), "the new session took the slot's order");
  assert.notEqual(String(r.session.logical_session_id), String(w.main.logical_session_id));
  assertOrphaned(r, "replaced");
  assert.ok(r.planned.includes("Gym"), "Gym is its own planned card beside the event");
  const before = await sessionNamed(w.planId, "Gym");
  const aligned = await align(w);
  assert.equal(aligned.status, 409, aligned.text);
  assert.equal(aligned.body.error, "nothing_to_align");
  const after = await sessionNamed(w.planId, "Gym");
  assert.equal(after.rpe_enabled, before.rpe_enabled, "align wrote nothing to Gym");
  assert.equal(after.training_load_enabled, before.training_load_enabled, "align wrote nothing to Gym");
});

test("2. a same-name replacement (\"Main\" again) is orphaned too, never linked", async () => {
  const w = await linkedWorld("samename");
  await removeMainAddNew(w, "Main");
  const r = await readsOf(w, "Main");
  assert.notEqual(String(r.session.logical_session_id), String(w.main.logical_session_id));
  assertOrphaned(r, "same name");
});

test("3. the linked session moved to another slot: orphaned; the moved session gets no event time", async () => {
  const w = await linkedWorld("moved");
  await q(`update plans.plan_sessions set am_pm = 'PM', updated_at = now() where id = $1`, [w.main.id]);
  const r = await readsOf(w, "Main");
  assert.equal(String(r.session.logical_session_id), String(w.main.logical_session_id), "a move keeps the logical id");
  assert.equal(r.session.am_pm, "PM");
  assertOrphaned(r, "moved");
  // Align on the event whose only link is orphaned: 409 nothing_to_align, and NO session of the plan changes - the
  // old (moved) session included.
  const before = await flagsOf(w.planId);
  const aligned = await align(w);
  assert.equal(aligned.status, 409, aligned.text);
  assert.equal(aligned.body.error, "nothing_to_align");
  assert.deepEqual(await flagsOf(w.planId), before, "align wrote nothing");
});

// Every session of the plan with its flags, for "align wrote nothing".
const flagsOf = async (planId) => q(
  `select ps.logical_session_id, ps.rpe_enabled, ps.training_load_enabled, ps.updated_at
     from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 order by ps.logical_session_id`, [planId]);

// A plan with Monday "Main" (linked) and Tuesday "Tue" (Training), both published.
async function linkedWorldWithTuesday(label) {
  const w = await linkedWorld(label);
  await editAndSave(w, async (edit) => { await addSession(w.cookie, edit.blocks[1].id, "Tue"); });
  const live = await q(`select logical_session_id_at_link from calendar.event_session_links where event_id = $1 and ended_at is null`, [w.ev.id]);
  assert.equal(String(live[0].logical_session_id_at_link), String(w.main.logical_session_id), "still linked to Main");
  // The Save rewrote the published plan's rows (the same logical ids, new row ids).
  return { ...w, main: await sessionNamed(w.planId, "Main") };
}

test("3b. a DAY paste over the linked day (Tuesday pasted onto Monday, its orders copied as they are): orphaned; align writes nothing", async () => {
  const w = await linkedWorldWithTuesday("daypaste");
  await intoLinkedSlot(w, (await sessionNamed(w.planId, "Tue")).id, { newIdentity: true });
  const pasted = (await q(`select ps.name, ps.am_pm, ps.bta, ps.session_order, ps.logical_session_id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id
                          where pd.plan_id = $1 and pd.date = $2`, [w.planId, WEEK]));
  assert.deepEqual(pasted.map((s) => s.name), ["Tue"], "Monday now holds the pasted Tue");
  assert.equal(Number(pasted[0].session_order), Number(w.main.session_order), "the pasted session took the linked slot");
  const r = await readsOf(w, "Tue");
  assert.equal(r.links[0].state, "orphaned");
  assert.deepEqual(r.card.links.logicalSessionIds, []);
  assert.ok(r.rows.filter((row) => String(row.date).slice(0, 10) === WEEK).every((row) => row.linked_event_start_time == null), "no event time on Monday's Tue");
  const before = await flagsOf(w.planId);
  assert.equal((await align(w)).status, 409);
  assert.deepEqual(await flagsOf(w.planId), before, "align wrote nothing");
});

test("3c. a day pasted from ANOTHER plan onto the linked day: orphaned", async () => {
  const w = await linkedWorld("crossplan");
  // Another published weekly plan of the athlete (the next week), whose Monday holds "Other".
  const created = ok(await api("/api/builder/plans", { method: "POST", cookie: w.cookie, body: { planType: "weekly", weekStart: "2026-11-09", athleteIds: [w.ext], athleteExternalIds: [w.ext], name: "Other week" } }), 201);
  const otherDraft = ok(await api(`/api/builder/plans/${created.plan.id}`, { cookie: w.cookie }));
  await addSession(w.cookie, otherDraft.blocks[0].id, "Other");
  ok(await api(`/api/builder/plans/${created.plan.id}/submit`, { method: "POST", cookie: w.cookie, body: { responseMode: "summary" } }));
  const otherPlanId = (await q(`select p.id from plans.plans p join plans.plan_days pd on pd.plan_id = p.id where p.athlete_id = $1 and pd.date = '2026-11-09' and p.status = 'active' and not coalesce(p.is_edit_draft,false)`, [w.athleteId]))[0].id;
  await intoLinkedSlot(w, (await sessionNamed(otherPlanId, "Other")).id, { newIdentity: true });
  const r = await readsOf(w, "Other");
  assert.equal(r.links[0].state, "orphaned");
  assert.deepEqual(r.card.links.logicalSessionIds, []);
  assert.ok(r.rows.filter((row) => String(row.date).slice(0, 10) === WEEK).every((row) => row.linked_event_start_time == null));
});

test("3d. a session moved in from another day into the linked slot (Monday holds A then the linked Main; Main deleted, Tuesday's session cut and pasted onto Monday): orphaned", async () => {
  const w = await linkedWorld("movein", { mondayBefore: ["A"], tuesday: ["Tue"] });
  await intoLinkedSlot(w, (await sessionNamed(w.planId, "Tue")).id, { newIdentity: false });
  const r = await readsOf(w, "Tue");
  assert.equal(r.session.am_pm, w.main.am_pm);
  assert.equal(r.session.bta, w.main.bta);
  assert.equal(Number(r.session.session_order), Number(w.main.session_order), "the moved-in session took the linked slot");
  assertOrphaned(r, "moved in");
  const before = await flagsOf(w.planId);
  assert.equal((await align(w)).status, 409);
  assert.deepEqual(await flagsOf(w.planId), before, "align wrote nothing");
});

test("4. an in-place change (same logical id, same slot) stays linked: folded, timed, aligned", async () => {
  const w = await linkedWorld("inplace");
  await editAndSave(w, async (edit) => {
    const mainInDraft = sessionsOf(edit).find((s) => s.name === "Main");
    ok(await api(`/api/builder/sessions/${mainInDraft.id}`, { method: "PATCH", cookie: w.cookie, body: { name: "Main renamed" } }));
  });
  const r = await readsOf(w, "Main renamed");
  assert.equal(String(r.session.logical_session_id), String(w.main.logical_session_id));
  assert.equal(r.links[0].state, "renamed");
  assert.equal(r.links[0].sessionName, "Main renamed");
  assert.deepEqual(r.card.links.logicalSessionIds, [String(w.main.logical_session_id)]);
  assert.equal(r.card.links.orphanedSessionLinks, 0);
  assert.ok(r.rows.length > 0 && r.rows.every((row) => row.linked_event_start_time === "10:00" && row.linked_event_end_time === "11:30"), "the event's time is shown");
  const aligned = ok(await align(w));
  assert.equal(aligned.alignment.changed + aligned.alignment.unchanged >= 1, true);
  const after = await sessionNamed(w.planId, "Main renamed");
  assert.equal(after.rpe_enabled, true);
  assert.equal(after.training_load_enabled, true, "align reached the linked session");
});

test("5. re-linking the new session to the same event replaces the orphan: one live link, of the new session", async () => {
  const w = await linkedWorld("relink");
  await removeMainAddNew(w, "Gym");
  const gym = await sessionNamed(w.planId, "Gym");
  const orphanId = (await q(`select id from calendar.event_session_links where event_id = $1 and ended_at is null`, [w.ev.id]))[0].id;
  ok(await api(`/api/calendar/events/${w.ev.id}/sessions`, { method: "POST", cookie: w.cookie, body: { requestKey: crypto.randomUUID(), expectedRevision: await revisionOf(w.ev.id), logicalSessionIds: [String(gym.logical_session_id)] } }));
  const live = await q(`select id, logical_session_id_at_link, session_name_at_link from calendar.event_session_links where event_id = $1 and ended_at is null`, [w.ev.id]);
  assert.equal(live.length, 1);
  assert.equal(String(live[0].logical_session_id_at_link), String(gym.logical_session_id));
  assert.equal(live[0].session_name_at_link, "Gym");
  const ended = (await q(`select ended_at, ended_by_user_id from calendar.event_session_links where id = $1`, [orphanId]))[0];
  assert.ok(ended.ended_at && ended.ended_by_user_id, "the orphan is ended, by the coach");
  const change = (await q(`select details from calendar.event_changes where event_id = $1 order by revision desc limit 1`, [w.ev.id]))[0];
  assert.equal(change.details.orphansEnded, 1, "the change record names the ended orphan");
  assert.deepEqual(change.details.endedLinkIds, [String(orphanId)]);
  const r = await readsOf(w, "Gym");
  assert.equal(r.links[0].state, "linked");
  assert.deepEqual(r.card.links.logicalSessionIds, [String(gym.logical_session_id)]);
  assert.ok(r.rows.every((row) => row.linked_event_start_time === "10:00"));
});

test("5b. a mixed attach (an orphaned slot's new session and a session already linked, in one command): one re-link, one already attached", async () => {
  const w = await linkedWorld("mixed");
  await removeMainAddNew(w, "Gym");
  await editAndSave(w, async (edit) => { await addSession(w.cookie, edit.blocks[0].id, "Second"); });
  const second = await sessionNamed(w.planId, "Second");
  ok(await api(`/api/calendar/events/${w.ev.id}/sessions`, { method: "POST", cookie: w.cookie, body: { requestKey: crypto.randomUUID(), expectedRevision: await revisionOf(w.ev.id), logicalSessionIds: [String(second.logical_session_id)] } }));
  const gym = await sessionNamed(w.planId, "Gym");
  const orphanId = (await q(`select id from calendar.event_session_links where event_id = $1 and ended_at is null and logical_session_id_at_link = $2`, [w.ev.id, w.main.logical_session_id]))[0].id;
  const res = ok(await api(`/api/calendar/events/${w.ev.id}/sessions`, { method: "POST", cookie: w.cookie, body: { requestKey: crypto.randomUUID(), expectedRevision: await revisionOf(w.ev.id), logicalSessionIds: [String(gym.logical_session_id), String(second.logical_session_id)] } }));
  assert.equal(res.attached, 1);
  assert.equal(res.alreadyAttached, 1);
  const live = await q(`select logical_session_id_at_link::text as l from calendar.event_session_links where event_id = $1 and ended_at is null order by 1`, [w.ev.id]);
  assert.deepEqual(live.map((x) => x.l), [String(gym.logical_session_id), String(second.logical_session_id)].sort());
  assert.ok((await q(`select ended_at from calendar.event_session_links where id = $1`, [orphanId]))[0].ended_at, "the orphan is ended");
});

test("6. another event's orphan still holds the slot: linking the new session there is a 409, nothing written", async () => {
  const w = await linkedWorld("otherevent");
  await removeMainAddNew(w, "Gym");
  const gym = await sessionNamed(w.planId, "Gym");
  const other = await eventOf(w, "Second training");
  const before = await q(`select id, event_id, ended_at from calendar.event_session_links order by id`);
  const res = await api(`/api/calendar/events/${other.id}/sessions`, { method: "POST", cookie: w.cookie, body: { requestKey: crypto.randomUUID(), expectedRevision: await revisionOf(other.id), logicalSessionIds: [String(gym.logical_session_id)] } });
  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.error, "session_already_attached");
  assert.deepEqual(await q(`select id, event_id, ended_at from calendar.event_session_links order by id`), before, "nothing written");
});

// The published plan's sessions with their slot and identity, for "nothing written".
const slotsOf = async (planId) => q(
  `select ps.id, ps.name, pd.date::text as date, ps.am_pm, ps.bta, ps.session_order, ps.logical_session_id
     from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 order by ps.id`, [planId]);

test("7. the new guarantee: no Builder path makes a linked session an orphan - every Save that removes, moves or replaces it, and every direct writer, is refused; the link stays linked", async () => {
  const w = await linkedWorld("guarded", { tuesday: ["Tue"] });
  const before = await slotsOf(w.planId);
  const refusedSave = async (label, change) => {
    const edit = ok(await api(`/api/builder/plans/${w.planId}/edit`, { method: "POST", cookie: w.cookie }));
    await change(edit);
    const res = await api(`/api/builder/plans/${edit.plan.id}/submit`, { method: "POST", cookie: w.cookie, body: { responseMode: "summary" } });
    assert.equal(res.status, 409, `${label}: ${res.text}`);
    assert.equal(res.body.code, "edit_sessions_locked", label);
    assert.ok(res.body.sessions.some((x) => x.name === "Main" && x.reasons.includes("linked_to_event")), `${label}: Main is named, linked_to_event`);
    ok(await api(`/api/builder/plans/${edit.plan.id}`, { method: "DELETE", cookie: w.cookie }));
  };
  const mainIn = (edit) => sessionsOf(edit).find((s) => s.name === "Main");
  await refusedSave("remove and add", async (edit) => {
    ok(await api(`/api/builder/sessions/${mainIn(edit).id}`, { method: "DELETE", cookie: w.cookie }));
    await addSession(w.cookie, edit.blocks[0].id, "Gym");
  });
  await refusedSave("move", async (edit) => {
    ok(await api(`/api/builder/sessions/${mainIn(edit).id}`, { method: "PATCH", cookie: w.cookie, body: { amPm: "PM" } }));
  });
  await refusedSave("day paste", async (edit) => {
    ok(await api(`/api/builder/days/${edit.blocks[1].id}/copy-into/${edit.blocks[0].id}`, { method: "POST", cookie: w.cookie, body: { confirmOverwrite: true } }));
  });
  await refusedSave("move in", async (edit) => {
    const tueIn = sessionsOf(edit).find((s) => s.name === "Tue");
    ok(await api(`/api/builder/sessions/${mainIn(edit).id}`, { method: "DELETE", cookie: w.cookie }));
    ok(await api(`/api/builder/sessions/${tueIn.id}/copy-into/${edit.blocks[0].id}`, { method: "POST", cookie: w.cookie, body: {} }));
    ok(await api(`/api/builder/sessions/${tueIn.id}`, { method: "DELETE", cookie: w.cookie }));
  });
  // The direct writers of the published plan.
  const days = await q(`select id, date::text as date from plans.plan_days where plan_id = $1 order by day_order`, [w.planId]);
  for (const [label, res] of [
    ["PATCH move", await api(`/api/builder/sessions/${w.main.id}`, { method: "PATCH", cookie: w.cookie, body: { amPm: "PM" } })],
    ["DELETE session", await api(`/api/builder/sessions/${w.main.id}`, { method: "DELETE", cookie: w.cookie })],
    ["day paste", await api(`/api/builder/days/${days[1].id}/copy-into/${days[0].id}`, { method: "POST", cookie: w.cookie, body: { confirmOverwrite: true } })],
  ]) {
    assert.equal(res.status, 409, `${label}: ${res.text}`);
    assert.equal(res.body.code, "edit_sessions_locked", label);
  }
  const deleted = await api(`/api/builder/plans/${w.planId}`, { method: "DELETE", cookie: w.cookie });
  assert.equal(deleted.status, 409, deleted.text);
  assert.equal(deleted.body.code, "plan_sessions_locked");
  assert.deepEqual(await slotsOf(w.planId), before, "the published plan's sessions are as they were");
  const r = await readsOf(w, "Main");
  assert.equal(r.links[0].state, "linked", "the link still reads as linked");
  assert.deepEqual(r.card.links.logicalSessionIds, [String(w.main.logical_session_id)]);
  assert.equal(r.card.links.orphanedSessionLinks, 0);
  assert.ok(r.rows.length > 0 && r.rows.every((row) => row.linked_event_start_time === "10:00"), "the event's time is still on it");
});
