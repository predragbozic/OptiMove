// Task 5: the athlete on screen (docs/ai/builder-batch-edit-plan.md section 12).
// The Save of a weekly edit draft never removes or moves a session of the plan
// itself that has results or a live event link made for it; its content can
// still change.
//
// One disposable database (optimove_tests_builder_sourceguard_*): the committed
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

// A past Monday, so an athlete may rate its sessions (the RPE route refuses a future day).
const WEEK = "2026-11-02";
const WEDNESDAY = "2026-11-04";

let db;
let admin;
let server;
let apiBase;
let appPool;
let createSession;
let batchHooks;
let tree;

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

// A published weekly batch of the two athletes: Monday "Main" and Wednesday
// "Wednesday" (Training), each with one exercise, tracked, with RPE. Returns
// the plan ids in athlete order; the first athlete's plan is the one on screen.
async function publishedBatch(s) {
  const ids = s.athletes.map((a) => a.externalId);
  const created = ok(await api("/api/builder/plans", { method: "POST", cookie: s.coach.cookie, body: { planType: "weekly", weekStart: WEEK, athleteIds: ids, athleteExternalIds: ids, name: "Group week" } }), 201);
  const planId = created.plan.id;
  let draft = ok(await api(`/api/builder/plans/${planId}`, { cookie: s.coach.cookie }));
  const addSession = async (blockIndex, name) => {
    draft = ok(await api(`/api/builder/blocks/${draft.blocks[blockIndex].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta: "T", name, syncBatch: true } }), 201);
    const session = sessionsOf(draft).find((x) => x.name === name);
    draft = ok(await api(`/api/builder/sessions/${session.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { trackingEnabled: true, rpeEnabled: true, syncBatch: true } }));
    draft = ok(await api(`/api/builder/sessions/${session.id}/nodes`, { method: "POST", cookie: s.coach.cookie, body: { nodeType: "domain", name: "Strength", syncBatch: true } }), 201);
    const domain = nodesOf(sessionsOf(draft).find((x) => x.id === session.id)).find((n) => n.type === "domain");
    draft = ok(await api(`/api/builder/sessions/${session.id}/nodes`, { method: "POST", cookie: s.coach.cookie, body: { nodeType: "section", name: "Lower body", parentId: domain.id, syncBatch: true } }), 201);
    const section = nodesOf(sessionsOf(draft).find((x) => x.id === session.id)).find((n) => n.type === "section");
    const res = await api(`/api/builder/nodes/${section.id}/custom-exercise`, { method: "POST", cookie: s.coach.cookie, body: { name: `${name} squat`, syncBatch: true } });
    assert.ok(res.status < 300, res.text);
    draft = res.body;
  };
  await addSession(0, "Main");
  await addSession(2, "Wednesday");
  ok(await api(`/api/builder/plans/${planId}/submit`, { method: "POST", cookie: s.coach.cookie, body: { syncBatch: true, responseMode: "summary" } }));
  const rows = await q(`select p.id, p.athlete_id, p.status from plans.plans p where p.builder_batch_id = (select builder_batch_id from plans.plans where id = $1) and not coalesce(p.is_edit_draft,false) order by p.id`, [planId]);
  assert.ok(rows.every((r) => r.status === "active"));
  return s.athletes.map((a) => rows.find((r) => String(r.athlete_id) === String(a.athleteId)).id);
}

const reopen = async (cookie, planId) => ok(await api(`/api/builder/plans/${planId}/edit`, { method: "POST", cookie }));
const save = (cookie, draftId, extra = {}) => api(`/api/builder/plans/${draftId}/submit`, { method: "POST", cookie, body: { responseMode: "summary", ...extra } });
const removeIn = async (cookie, draft, name) => ok(await api(`/api/builder/sessions/${sessionsOf(draft).find((x) => x.name === name).id}`, { method: "DELETE", cookie }));
const moveToPm = async (cookie, draft, name) => ok(await api(`/api/builder/sessions/${sessionsOf(draft).find((x) => x.name === name).id}`, { method: "PATCH", cookie, body: { amPm: "PM" } }));
const renameIn = async (cookie, draft, name, to) => ok(await api(`/api/builder/sessions/${sessionsOf(draft).find((x) => x.name === name).id}`, { method: "PATCH", cookie, body: { name: to } }));

async function treeOf(planId) {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try { return await tree.loadWeeklyTree(c, planId); } finally { await c.end(); }
}
const byName = (t, name) => t.sessions.find((x) => x.name === name);

// Everything a Save could write (the plans, their edit drafts and trees), for "nothing written".
async function digestOf(planIds) {
  const r = await q(`
    select md5(coalesce((select string_agg(x::text, '|' order by x::text) from plans.plans x where id = any($1::uuid[]) or edit_source_plan_id = any($1::uuid[])), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from plans.plan_days x join plans.plans p on p.id = x.plan_id where p.id = any($1::uuid[]) or p.edit_source_plan_id = any($1::uuid[])), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from plans.plan_sessions x join plans.plan_days d on d.id = x.plan_day_id join plans.plans p on p.id = d.plan_id where p.id = any($1::uuid[]) or p.edit_source_plan_id = any($1::uuid[])), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from plans.plan_nodes x join plans.plan_sessions s on s.id = x.plan_session_id join plans.plan_days d on d.id = s.plan_day_id join plans.plans p on p.id = d.plan_id where p.id = any($1::uuid[]) or p.edit_source_plan_id = any($1::uuid[])), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from plans.plan_items x join plans.plan_sessions s on s.id = x.plan_session_id join plans.plan_days d on d.id = s.plan_day_id join plans.plans p on p.id = d.plan_id where p.id = any($1::uuid[]) or p.edit_source_plan_id = any($1::uuid[])), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from calendar.event_session_links x where x.plan_id = any($1::uuid[])), '')) as d`, [planIds]);
  return r[0].d;
}

// An RPE row as the athlete's own submit writes it.
async function rpeRow(athlete, sessionId) {
  const s = (await q(`select ps.logical_session_id, pd.date, p.name, p.week_start from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id join plans.plans p on p.id = pd.plan_id where ps.id = $1`, [sessionId]))[0];
  await q(`insert into training_load.session_feedback (athlete_id, plan_session_id, logical_session_id, session_date, plan_name, plan_week_start, rpe, duration_minutes)
           values ($1,$2,$3,$4,$5,$6,6,60)`, [athlete.athleteId, sessionId, s.logical_session_id, s.date, s.name, s.week_start]);
}

// A metric event shaped as the GPEXE writer writes one (team-owned, session level).
async function metricEventFor(s, date, athleteId, logicalSessionId) {
  const eventId = (await q(
    `insert into training_load.metric_events (event_name, occurred_date, scope_level, owner_scope, owner_team_id, source_external_id, event_timezone_snapshot)
     values ('GPS session', $1, 'session', 'team', $2, $3, 'UTC') returning id`, [date, s.teamId, `test:${uid()}`]))[0].id;
  await q(`insert into training_load.metric_event_participants (event_id, athlete_id, athlete_timezone_snapshot, logical_session_id) values ($1,$2,'UTC',$3)`,
    [eventId, athleteId, logicalSessionId]);
}

async function teamEventFor(s, day) {
  const types = ok(await api("/api/calendar/events/types", { cookie: s.coach.cookie }));
  const type = types.types.find((t) => t.kind === "training");
  return ok(await api("/api/calendar/events", { method: "POST", cookie: s.coach.cookie, body: { requestKey: crypto.randomUUID(), timezone: "UTC", eventTypeId: type.id, title: "Team training", day, targets: [{ kind: "team", id: s.teamId }] } }), 201).event;
}
const attach = (cookie, eventId, logicalSessionIds) => api(`/api/calendar/events/${eventId}/sessions`, { method: "POST", cookie, body: { requestKey: crypto.randomUUID(), expectedRevision: 1, logicalSessionIds } });

async function waitForLockWait(predicate = () => true) {
  for (let i = 0; i < 400; i += 1) {
    const rows = await q(`select pid, query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`);
    if (rows.some(predicate)) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no statement waited on a lock");
}
function gate() {
  let release; let reached;
  const released = new Promise((r) => { release = r; });
  const arrived = new Promise((r) => { reached = r; });
  return { released, arrived, release: () => release(), reached: () => reached() };
}

// The edit draft's Save, refused for `name` with `change` and `reasons`; nothing of the plans, the draft or the links written.
async function assertLocked(s, plans, draft, { name, day, change, reasons, scope = "this" }) {
  const before = await digestOf(plans);
  const res = await save(s.coach.cookie, draft.plan.id, scope === "all" ? { batchScope: "all" } : {});
  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.code, "edit_sessions_locked");
  assert.equal(res.body.sessions.length, 1, res.text);
  const [locked] = res.body.sessions;
  assert.deepEqual({ name: locked.name, day: locked.day, change: locked.change, reasons: locked.reasons }, { name, day, change, reasons });
  assert.equal(locked.bta, "T");
  assert.ok(["AM", "PM"].includes(locked.amPm) || locked.amPm === "", locked.amPm);
  assert.deepEqual(Object.keys(locked).sort(), ["amPm", "bta", "change", "day", "name", "reasons"], "no event id, title or other plan's fact");
  assert.equal(await digestOf(plans), before, "nothing written: the plan, the draft and the links");
  return res;
}

before(async () => {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "support/legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  db = await createDisposableDatabase({ prefix: "builder", label: "sourceguard", baseDatabaseUrl: BASE_URL });
  await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
  await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the disposable database");
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  tree = await import("../src/builderBatchEdit.js");
  batchHooks = tree.batchEditTestHooks;
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

test("1. the athlete's own RPE: removing or moving the session is refused (has_results), nothing written; a change in place saves and the RPE stays on it", async () => {
  const s = await squad("rpe");
  const plans = await publishedBatch(s);
  const [a] = plans;
  await rpeRow(s.athletes[0], byName(await treeOf(a), "Wednesday").id);
  const draft = await reopen(s.coach.cookie, a);
  await removeIn(s.coach.cookie, draft, "Wednesday");
  await assertLocked(s, plans, draft, { name: "Wednesday", day: WEDNESDAY, change: "removed", reasons: ["has_results"] });
  ok(await api(`/api/builder/plans/${draft.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  const draft2 = await reopen(s.coach.cookie, a);
  await moveToPm(s.coach.cookie, draft2, "Wednesday");
  await assertLocked(s, plans, draft2, { name: "Wednesday", day: WEDNESDAY, change: "moved", reasons: ["has_results"] });
  ok(await api(`/api/builder/plans/${draft2.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  const was = byName(await treeOf(a), "Wednesday");
  const draft3 = await reopen(s.coach.cookie, a);
  await renameIn(s.coach.cookie, draft3, "Wednesday", "Wednesday easy");
  ok(await save(s.coach.cookie, draft3.plan.id));
  const now = byName(await treeOf(a), "Wednesday easy");
  assert.equal(String(now.logical_session_id), String(was.logical_session_id), "the same session, changed in place");
  assert.equal((await q(`select count(*)::int as n from training_load.session_feedback where logical_session_id = $1`, [now.logical_session_id]))[0].n, 1);
  // Plan 12.5: the RPE's stale `session_date` snapshot still names the day the live plan shows the session on, since
  // the session could not be moved off it.
  const [{ snapshot, live }] = await q(
    `select sf.session_date::text as snapshot, pd.date::text as live from training_load.session_feedback sf
       join plans.plan_sessions ps on ps.logical_session_id = sf.logical_session_id join plans.plan_days pd on pd.id = ps.plan_day_id
      where sf.logical_session_id = $1 and ps.id = $2`, [now.logical_session_id, now.id]);
  assert.equal(snapshot, WEDNESDAY);
  assert.equal(live, snapshot, "the snapshot day and the live day agree");
});

test("2. an activity linked to the session (no RPE): removing and moving are refused (has_results)", async () => {
  const s = await squad("activity");
  const plans = await publishedBatch(s);
  const [a] = plans;
  const main = byName(await treeOf(a), "Main");
  const made = await api("/api/training-activity/materialize", { method: "POST", cookie: s.coach.cookie, body: { requestKey: uid(), planLogicalSessionId: String(main.logical_session_id), athleteId: s.athletes[0].athleteId } });
  assert.equal(made.status, 201, made.text);
  const draft = await reopen(s.coach.cookie, a);
  await removeIn(s.coach.cookie, draft, "Main");
  await assertLocked(s, plans, draft, { name: "Main", day: WEEK, change: "removed", reasons: ["has_results"] });
  ok(await api(`/api/builder/plans/${draft.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  const draft2 = await reopen(s.coach.cookie, a);
  await moveToPm(s.coach.cookie, draft2, "Main");
  await assertLocked(s, plans, draft2, { name: "Main", day: WEEK, change: "moved", reasons: ["has_results"] });
  // Plan 12.5: the activity is dated by the day it was made for, which is still the day the live plan shows.
  const [{ occurred }] = await q(
    `select a.occurred_local_date::text as occurred from training.activities a join training.activity_participants p on p.activity_id = a.id
       join training.activity_participant_session_links l on l.activity_participant_id = p.id where l.logical_session_id = $1`, [main.logical_session_id]);
  assert.equal(occurred, WEEK);
  assert.equal((await q(`select pd.date::text as d from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where ps.logical_session_id = $1 and pd.plan_id = $2`, [main.logical_session_id, a]))[0].d, occurred, "the activity's day and the live day agree");
});

test("3. a metric event naming the session (no RPE): removing it is refused (has_results)", async () => {
  const s = await squad("metric");
  const plans = await publishedBatch(s);
  const [a] = plans;
  await metricEventFor(s, WEDNESDAY, s.athletes[0].athleteId, String(byName(await treeOf(a), "Wednesday").logical_session_id));
  const draft = await reopen(s.coach.cookie, a);
  await removeIn(s.coach.cookie, draft, "Wednesday");
  await assertLocked(s, plans, draft, { name: "Wednesday", day: WEDNESDAY, change: "removed", reasons: ["has_results"] });
});

test("4. a live event link made for the session: removing and moving are refused (linked_to_event); a change in place saves and keeps the link", async () => {
  const s = await squad("link");
  const plans = await publishedBatch(s);
  const [a] = plans;
  const ev = await teamEventFor(s, WEEK);
  ok(await attach(s.coach.cookie, ev.id, [String(byName(await treeOf(a), "Main").logical_session_id)]));
  const draft = await reopen(s.coach.cookie, a);
  await moveToPm(s.coach.cookie, draft, "Main");
  await assertLocked(s, plans, draft, { name: "Main", day: WEEK, change: "moved", reasons: ["linked_to_event"] });
  ok(await api(`/api/builder/plans/${draft.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  const draft2 = await reopen(s.coach.cookie, a);
  await removeIn(s.coach.cookie, draft2, "Main");
  await assertLocked(s, plans, draft2, { name: "Main", day: WEEK, change: "removed", reasons: ["linked_to_event"] });
  ok(await api(`/api/builder/plans/${draft2.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  const draft3 = await reopen(s.coach.cookie, a);
  await renameIn(s.coach.cookie, draft3, "Main", "Main renamed");
  ok(await save(s.coach.cookie, draft3.plan.id));
  const live = await q(`select logical_session_id_at_link from calendar.event_session_links where event_id = $1 and ended_at is null`, [ev.id]);
  assert.equal(live.length, 1);
  assert.equal(String(live[0].logical_session_id_at_link), String(byName(await treeOf(a), "Main renamed").logical_session_id), "the link stays on the session");
});

test("5. both reasons on one session, and the RPE with the link: the answer names both", async () => {
  const s = await squad("both");
  const plans = await publishedBatch(s);
  const [a] = plans;
  const main = byName(await treeOf(a), "Main");
  await rpeRow(s.athletes[0], main.id);
  const ev = await teamEventFor(s, WEEK);
  ok(await attach(s.coach.cookie, ev.id, [String(main.logical_session_id)]));
  const draft = await reopen(s.coach.cookie, a);
  await removeIn(s.coach.cookie, draft, "Main");
  await assertLocked(s, plans, draft, { name: "Main", day: WEEK, change: "removed", reasons: ["has_results", "linked_to_event"] });
});

test("6. an orphaned link in the slot (made for another session) blocks nothing; a session without results or a link is removed and moved as before", async () => {
  const s = await squad("free");
  const plans = await publishedBatch(s);
  const [a] = plans;
  const ev = await teamEventFor(s, WEEK);
  const main = byName(await treeOf(a), "Main");
  const day = (await q(`select date from plans.plan_days where id = $1`, [main.plan_day_id]))[0].date;
  // A link left on Main's slot by an earlier session (an orphan): its logical id is another session's.
  await q(`insert into calendar.event_session_links (event_id, plan_id, day, am_pm, bta, session_order, logical_session_id_at_link, session_name_at_link, linked_by_user_id)
           values ($1,$2,$3,$4,$5,$6,$7,'Earlier',$8)`, [ev.id, a, day, main.am_pm, main.bta, main.session_order, crypto.randomUUID(), s.coach.id]);
  const draft = await reopen(s.coach.cookie, a);
  await removeIn(s.coach.cookie, draft, "Main");
  await moveToPm(s.coach.cookie, draft, "Wednesday");
  ok(await save(s.coach.cookie, draft.plan.id));
  const t = await treeOf(a);
  assert.equal(byName(t, "Main"), undefined, "removed");
  assert.equal(byName(t, "Wednesday").am_pm, "PM", "moved");
});

test("7. the group Save: a blocked session of the athlete on screen stops it before any sibling is classified or written", async () => {
  const s = await squad("group");
  const plans = await publishedBatch(s);
  const [a] = plans;
  await rpeRow(s.athletes[0], byName(await treeOf(a), "Wednesday").id);
  const draft = await reopen(s.coach.cookie, a);
  await removeIn(s.coach.cookie, draft, "Wednesday");
  let classified = false;
  batchHooks.afterLocks = async () => { classified = true; };
  try {
    await assertLocked(s, plans, draft, { name: "Wednesday", day: WEDNESDAY, change: "removed", reasons: ["has_results"], scope: "all" });
  } finally {
    batchHooks.afterLocks = null;
  }
  assert.equal(classified, false, "no sibling was classified");
  // The sibling's own Wednesday (no results) stays too.
  assert.ok(byName(await treeOf(plans[1]), "Wednesday"));
});

test("8. a Save racing the athlete's RPE submit on the session the edit removes, both orders", async () => {
  // Submit first: it holds the session row; the Save waits on it, then sees the result: refused, nothing written.
  {
    const s = await squad("raceA");
    const plans = await publishedBatch(s);
    const [a] = plans;
    const wed = byName(await treeOf(a), "Wednesday");
    const draft = await reopen(s.coach.cookie, a);
    await removeIn(s.coach.cookie, draft, "Wednesday");
    const holder = new pg.Client({ connectionString: db.url });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query(`select id from training_load.planned_rpe_workspace_settings where owner_scope = 'team' and owner_team_id = $1 for update`, [s.teamId]);
      const rating = api(`/api/training-load/sessions/${wed.id}/rpe`, { method: "POST", cookie: s.athletes[0].cookie, body: { rpe: 7, durationMinutes: 45 } });
      await waitForLockWait((r) => /training_load\.plan_workspace_ownership/.test(r.query));
      const before = await digestOf(plans);
      const saving = save(s.coach.cookie, draft.plan.id);
      await waitForLockWait((r) => /plan_sessions where id = any/.test(r.query));
      await holder.query("commit");
      const rated = await rating;
      assert.ok(rated.status < 300, rated.text);
      const refused = await saving;
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body.code, "edit_sessions_locked");
      assert.deepEqual(refused.body.sessions.map((x) => x.reasons), [["has_results"]]);
      assert.equal(await digestOf(plans), before, "nothing written");
    } finally {
      await holder.end();
    }
  }
  // Save first, paused under its session lock: the submit waits on the row, the Save removes the session, the submit answers 404.
  {
    const s = await squad("raceB");
    const plans = await publishedBatch(s);
    const [a] = plans;
    const wed = byName(await treeOf(a), "Wednesday");
    const draft = await reopen(s.coach.cookie, a);
    await removeIn(s.coach.cookie, draft, "Wednesday");
    const g = gate();
    batchHooks.afterSourceLocks = async () => { g.reached(); await g.released; };
    try {
      const saving = save(s.coach.cookie, draft.plan.id);
      await g.arrived;
      const rating = api(`/api/training-load/sessions/${wed.id}/rpe`, { method: "POST", cookie: s.athletes[0].cookie, body: { rpe: 6, durationMinutes: 50 } });
      const early = await Promise.race([rating.then((r) => r), waitForLockWait((r) => /select ps.id as session_id/.test(r.query)).then(() => null)]);
      assert.equal(early, null, `the submit answered before waiting: ${early?.status} ${early?.text}`);
      g.release();
      ok(await saving);
      const rated = await rating;
      assert.equal(rated.status, 404, rated.text);
      assert.equal(byName(await treeOf(a), "Wednesday"), undefined);
      assert.equal((await q(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [s.athletes[0].athleteId]))[0].n, 0);
    } finally {
      batchHooks.afterSourceLocks = null;
      g.release();
    }
  }
});

test("9. a live link on the session's slot that names no session (logical_session_id_at_link null) blocks it, fail-closed", async () => {
  const s = await squad("unnamed");
  const plans = await publishedBatch(s);
  const [a] = plans;
  const ev = await teamEventFor(s, WEEK);
  const main = byName(await treeOf(a), "Main");
  const day = (await q(`select date from plans.plan_days where id = $1`, [main.plan_day_id]))[0].date;
  await q(`insert into calendar.event_session_links (event_id, plan_id, day, am_pm, bta, session_order, logical_session_id_at_link, session_name_at_link, linked_by_user_id)
           values ($1,$2,$3,$4,$5,$6,null,null,$7)`, [ev.id, a, day, main.am_pm, main.bta, main.session_order, s.coach.id]);
  const draft = await reopen(s.coach.cookie, a);
  await removeIn(s.coach.cookie, draft, "Main");
  await assertLocked(s, plans, draft, { name: "Main", day: WEEK, change: "removed", reasons: ["linked_to_event"] });
  // The same link stops deleting the plan.
  ok(await api(`/api/builder/plans/${draft.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  const refused = await api(`/api/builder/plans/${a}`, { method: "DELETE", cookie: s.coach.cookie });
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(refused.body.sessions.map((x) => [x.name, x.reasons]), [["Main", ["linked_to_event"]]]);
});

// A coach of another team, who may not edit these plans.
async function outsider(label) {
  const clubId = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} Other Club ${uid()}`]))[0].id;
  const teamId = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} Other Team ${uid()}`]))[0].id;
  const id = await makeUser(`${label} Outsider`);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return { id, cookie: await cookieOf(id) };
}

// A direct route's refusal: 409 edit_sessions_locked naming `name` with `change` and `reasons`, nothing written.
async function assertDirectLocked(res, plans, before, { name, change, reasons }) {
  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.code, "edit_sessions_locked");
  assert.deepEqual(res.body.sessions.map((x) => ({ name: x.name, change: x.change, reasons: x.reasons })), [{ name, change, reasons }]);
  assert.deepEqual(Object.keys(res.body.sessions[0]).sort(), ["amPm", "bta", "change", "day", "name", "reasons"]);
  assert.equal(await digestOf(plans), before, "nothing written");
}

test("10. the session routes on a published plan: a session with results or a live event link is never moved (half-day or phase) or removed (409, nothing written); a rename and a time change stay free; a session without either moves and goes as before; rights first", async () => {
  const s = await squad("direct");
  const plans = await publishedBatch(s);
  const [a] = plans;
  const other = await outsider("direct");
  const wed = byName(await treeOf(a), "Wednesday");
  await rpeRow(s.athletes[0], wed.id);
  const ev = await teamEventFor(s, WEEK);
  const main = byName(await treeOf(a), "Main");
  ok(await attach(s.coach.cookie, ev.id, [String(main.logical_session_id)]));
  // Rights first: the plain 404 for someone who may not edit the plan, the same body as a missing session.
  const missing = await api(`/api/builder/sessions/${crypto.randomUUID()}`, { method: "PATCH", cookie: s.coach.cookie, body: { amPm: "PM" } });
  for (const [method, body] of [["PATCH", { amPm: "PM" }], ["DELETE", undefined]]) {
    const res = await api(`/api/builder/sessions/${wed.id}`, { method, cookie: other.cookie, body });
    assert.equal(res.status, 404, res.text);
    assert.equal(res.text, missing.text, `${method}: not yours = missing`);
  }
  let before = await digestOf(plans);
  await assertDirectLocked(await api(`/api/builder/sessions/${wed.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { amPm: "PM" } }), plans, before, { name: "Wednesday", change: "moved", reasons: ["has_results"] });
  await assertDirectLocked(await api(`/api/builder/sessions/${wed.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { bta: "A" } }), plans, before, { name: "Wednesday", change: "moved", reasons: ["has_results"] });
  await assertDirectLocked(await api(`/api/builder/sessions/${wed.id}`, { method: "DELETE", cookie: s.coach.cookie }), plans, before, { name: "Wednesday", change: "removed", reasons: ["has_results"] });
  await assertDirectLocked(await api(`/api/builder/sessions/${main.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { amPm: "PM" } }), plans, before, { name: "Main", change: "moved", reasons: ["linked_to_event"] });
  await assertDirectLocked(await api(`/api/builder/sessions/${main.id}`, { method: "DELETE", cookie: s.coach.cookie }), plans, before, { name: "Main", change: "removed", reasons: ["linked_to_event"] });
  // A rename and a time change of the same sessions stay free (content changes in place), and so does sending the same half-day.
  ok(await api(`/api/builder/sessions/${wed.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { name: "Wednesday renamed", time: "18:00", amPm: wed.am_pm || "" } }));
  assert.equal(byName(await treeOf(a), "Wednesday renamed").am_pm, wed.am_pm);
  // A published session without results or a link moves and goes as before (the sibling's).
  const sibWed = byName(await treeOf(plans[1]), "Wednesday");
  ok(await api(`/api/builder/sessions/${sibWed.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { amPm: "PM" } }));
  assert.equal(byName(await treeOf(plans[1]), "Wednesday").am_pm, "PM");
  ok(await api(`/api/builder/sessions/${sibWed.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  assert.equal(byName(await treeOf(plans[1]), "Wednesday"), undefined);
});

test("10b. a rename that read the session before a concurrent move (and a result after it) never moves the session back", async () => {
  const s = await squad("stale");
  const plans = await publishedBatch(s);
  const [a] = plans;
  const wed = byName(await treeOf(a), "Wednesday");
  assert.notEqual(wed.am_pm, "PM");
  const g = gate();
  let held = false;
  batchHooks.afterSessionRead = async () => {
    if (held) return;
    held = true;
    g.reached();
    await g.released;
  };
  try {
    // B: a rename, held right after its unlocked read (it saw the old half-day).
    const renaming = api(`/api/builder/sessions/${wed.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { name: "Wednesday renamed" } });
    await g.arrived;
    // A: the session moves (no result yet), then the athlete rates it.
    ok(await api(`/api/builder/sessions/${wed.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { amPm: "PM" } }));
    await rpeRow(s.athletes[0], wed.id);
    g.release();
    ok(await renaming);
  } finally {
    batchHooks.afterSessionRead = null;
    g.release();
  }
  const now = byName(await treeOf(a), "Wednesday renamed");
  assert.equal(now.am_pm, "PM", "the rename kept the half-day the session has now");
});

test("13. pasting a day over a published plan's day (same plan and another plan, confirmOverwrite): refused when a session there has results; a day without one is pasted as before", async () => {
  const s = await squad("dayoverwrite");
  const plans = await publishedBatch(s);
  const [a, b] = plans;
  await rpeRow(s.athletes[0], byName(await treeOf(a), "Wednesday").id);
  const days = await q(`select id, date::text as date from plans.plan_days where plan_id = $1 order by day_order`, [a]);
  const dayOf = (date) => days.find((d) => d.date === date).id;
  const before = await digestOf(plans);
  await assertDirectLocked(await api(`/api/builder/days/${dayOf(WEEK)}/copy-into/${dayOf(WEDNESDAY)}`, { method: "POST", cookie: s.coach.cookie, body: { confirmOverwrite: true } }),
    plans, before, { name: "Wednesday", change: "removed", reasons: ["has_results"] });
  const bMonday = (await q(`select id from plans.plan_days where plan_id = $1 and date = $2`, [b, WEEK]))[0].id;
  await assertDirectLocked(await api(`/api/builder/blocks/${bMonday}/copy-into/${dayOf(WEDNESDAY)}`, { method: "POST", cookie: s.coach.cookie, body: { confirmOverwrite: true } }),
    plans, before, { name: "Wednesday", change: "removed", reasons: ["has_results"] });
  // The sibling's Wednesday has no results: pasted over as before.
  const bDays = await q(`select id, date::text as date from plans.plan_days where plan_id = $1`, [b]);
  ok(await api(`/api/builder/days/${bDays.find((d) => d.date === WEEK).id}/copy-into/${bDays.find((d) => d.date === WEDNESDAY).id}`, { method: "POST", cookie: s.coach.cookie, body: { confirmOverwrite: true } }));
  assert.equal(byName(await treeOf(b), "Wednesday"), undefined, "replaced by Monday's copy");
});

test("14. no branch on plan kind: a published program whose session a record names keeps that session (block delete, session delete, plan delete refused); a program without one is unchanged", async () => {
  const s = await squad("program");
  const created = ok(await api("/api/builder/plans", { method: "POST", cookie: s.coach.cookie, body: { planType: "program", athleteIds: [s.athletes[0].externalId], athleteExternalIds: [s.athletes[0].externalId], name: "Program" } }), 201);
  const planId = created.plan.id;
  let draft = ok(await api(`/api/builder/plans/${planId}`, { cookie: s.coach.cookie }));
  if (!draft.blocks?.length) draft = ok(await api(`/api/builder/plans/${planId}/blocks`, { method: "POST", cookie: s.coach.cookie, body: { name: "Block 1" } }), 201);
  draft = ok(await api(`/api/builder/blocks/${draft.blocks[0].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta: "T", name: "Program session" } }), 201);
  const session = sessionsOf(draft).find((x) => x.name === "Program session");
  const node = await api(`/api/builder/sessions/${session.id}/nodes`, { method: "POST", cookie: s.coach.cookie, body: { nodeType: "domain", name: "Strength" } });
  assert.ok(node.status < 300, node.text);
  ok(await api(`/api/builder/plans/${planId}/submit`, { method: "POST", cookie: s.coach.cookie, body: { responseMode: "summary" } }));
  const live = (await q(`select p.id as plan_id, p.status, ps.id, ps.logical_session_id, ps.plan_day_id from plans.plans p join plans.plan_days pd on pd.plan_id = p.id
                         join plans.plan_sessions ps on ps.plan_day_id = pd.id where p.athlete_id = $1 and p.plan_type = 'program' and not coalesce(p.is_edit_draft,false)`, [s.athletes[0].athleteId]))[0];
  assert.notEqual(live.status, "draft", "published");
  // A record names the program session (a metric event participant; no plan kind is assumed).
  await metricEventFor(s, WEEK, s.athletes[0].athleteId, String(live.logical_session_id));
  const before = await digestOf([live.plan_id]);
  await assertDirectLocked(await api(`/api/builder/sessions/${live.id}`, { method: "DELETE", cookie: s.coach.cookie }), [live.plan_id], before, { name: "Program session", change: "removed", reasons: ["has_results"] });
  await assertDirectLocked(await api(`/api/builder/blocks/${live.plan_day_id}`, { method: "DELETE", cookie: s.coach.cookie }), [live.plan_id], before, { name: "Program session", change: "removed", reasons: ["has_results"] });
  const refused = await api(`/api/builder/plans/${live.plan_id}`, { method: "DELETE", cookie: s.coach.cookie });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.code, "plan_sessions_locked");
  assert.equal(await digestOf([live.plan_id]), before, "nothing deleted");
  // The program's Save: copyProgramTree does not keep logical ids, so every session would leave its record behind -
  // the Save is refused even for a rename in the draft (no branch on plan kind).
  const edit = await reopen(s.coach.cookie, live.plan_id);
  const editSession = sessionsOf(edit).find((x) => x.name === "Program session");
  ok(await api(`/api/builder/sessions/${editSession.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { name: "Program session renamed in the draft" } }));
  const saved = await save(s.coach.cookie, edit.plan.id);
  assert.equal(saved.status, 409, saved.text);
  assert.equal(saved.body.code, "edit_sessions_locked");
  assert.deepEqual(saved.body.sessions.map((x) => [x.name, x.change, x.reasons]), [["Program session", "removed", ["has_results"]]]);
  ok(await api(`/api/builder/plans/${edit.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  // A rename of the published session itself stays free.
  ok(await api(`/api/builder/sessions/${live.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { name: "Program session renamed" } }));
});

test("11. deleting a published plan with a session that has results or a live event link: 409 plan_sessions_locked naming them, nothing deleted; rights first", async () => {
  const s = await squad("plandelete");
  const plans = await publishedBatch(s);
  const [a, b] = plans;
  await rpeRow(s.athletes[0], byName(await treeOf(a), "Wednesday").id);
  const ev = await teamEventFor(s, WEEK);
  ok(await attach(s.coach.cookie, ev.id, [String(byName(await treeOf(a), "Main").logical_session_id)]));
  const other = await outsider("plandelete");
  const before = await digestOf(plans);
  // Rights first: someone who may not edit the plan gets the plain 404, never the 409.
  const notYours = await api(`/api/builder/plans/${a}`, { method: "DELETE", cookie: other.cookie });
  const missing = await api(`/api/builder/plans/${crypto.randomUUID()}`, { method: "DELETE", cookie: other.cookie });
  assert.equal(notYours.status, 404, notYours.text);
  assert.equal(notYours.text, missing.text, "the same body as a plan that does not exist");
  const refused = await api(`/api/builder/plans/${a}`, { method: "DELETE", cookie: s.coach.cookie });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.code, "plan_sessions_locked");
  assert.deepEqual(refused.body.sessions.map((x) => [x.name, x.day, x.change, x.reasons]).sort(),
    [["Main", WEEK, "removed", ["linked_to_event"]], ["Wednesday", WEDNESDAY, "removed", ["has_results"]]]);
  assert.equal(await digestOf(plans), before, "nothing deleted");
  // A published plan with no such session deletes as before.
  const deleted = await api(`/api/builder/plans/${b}`, { method: "DELETE", cookie: s.coach.cookie });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal((await q(`select count(*)::int as n from plans.plans where id = $1`, [b]))[0].n, 0);
  // A draft deletes as before (the edit draft of the locked plan: a discard).
  const draft = await reopen(s.coach.cookie, a);
  ok(await api(`/api/builder/plans/${draft.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  assert.equal((await q(`select count(*)::int as n from plans.plans where id = $1`, [draft.plan.id]))[0].n, 0);
  assert.equal((await q(`select count(*)::int as n from plans.plans where id = $1`, [a]))[0].n, 1, "the published plan stays");
});

test("12. a session whose only record is a SUGGESTED activity link counts as having results: the Save refuses removing and moving it, and the plan is not deleted", async () => {
  const s = await squad("suggested");
  const plans = await publishedBatch(s);
  const [a] = plans;
  const main = byName(await treeOf(a), "Main");
  // An activity recorded for Wednesday (its participant's confirmed link names Wednesday), and an automatic SUGGESTED
  // link of that participant to Main: nothing confirmed names Main.
  const wed = byName(await treeOf(a), "Wednesday");
  const made = await api("/api/training-activity/materialize", { method: "POST", cookie: s.coach.cookie, body: { requestKey: uid(), planLogicalSessionId: String(wed.logical_session_id), athleteId: s.athletes[0].athleteId } });
  assert.equal(made.status, 201, made.text);
  await q(`insert into training.activity_participant_session_links (activity_participant_id, athlete_id, logical_session_id, link_method, link_status, confidence)
           values ($1, $2, $3, 'automatic', 'suggested', 0.5)`, [made.body.participantId, s.athletes[0].athleteId, main.logical_session_id]);
  const links = await q(`select link_status from training.activity_participant_session_links where logical_session_id = $1 and link_status in ('confirmed', 'suggested')`, [main.logical_session_id]);
  assert.deepEqual(links.map((l) => l.link_status), ["suggested"], "the only record is a suggested link");
  assert.equal((await q(`select count(*)::int as n from training_load.session_feedback where logical_session_id = $1`, [main.logical_session_id]))[0].n, 0, "no RPE");
  const draft = await reopen(s.coach.cookie, a);
  await removeIn(s.coach.cookie, draft, "Main");
  await assertLocked(s, plans, draft, { name: "Main", day: WEEK, change: "removed", reasons: ["has_results"] });
  ok(await api(`/api/builder/plans/${draft.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  const draft2 = await reopen(s.coach.cookie, a);
  await moveToPm(s.coach.cookie, draft2, "Main");
  await assertLocked(s, plans, draft2, { name: "Main", day: WEEK, change: "moved", reasons: ["has_results"] });
  ok(await api(`/api/builder/plans/${draft2.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  const before = await digestOf(plans);
  const refused = await api(`/api/builder/plans/${a}`, { method: "DELETE", cookie: s.coach.cookie });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.code, "plan_sessions_locked");
  assert.deepEqual(refused.body.sessions.map((x) => [x.name, x.reasons]).sort(), [["Main", ["has_results"]], ["Wednesday", ["has_results"]]]);
  assert.equal(await digestOf(plans), before, "nothing deleted");
});
