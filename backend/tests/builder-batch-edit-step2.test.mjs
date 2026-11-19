// Builder step 2: applying an edit of a published weekly batch to every
// athlete (docs/ai/builder-batch-edit-plan.md, accepted with section 10).
//
// One disposable database (optimove_tests_builder_batchedit_*): the committed
// legacy-schema snapshot plus every migration of migrations_v2 through the
// real runner; the real Express app in-process over HTTP with real session
// cookies; dropped at the end. Nothing touches OPTIMOVE or any persistent
// database. Synthetic names only.
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
const WEEK2 = "2026-11-09";

let db;
let admin;
let server;
let apiBase;
let appPool;
let createSession;
let batchHooks;
let tree;
let calendarHooks;
const world = {};

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
async function coachOf(teamId, label) {
  const id = await makeUser(label);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return { id, cookie: await cookieOf(id) };
}
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

// A team of three athletes, two coaches of that team, planned RPE switched on.
async function squad(label) {
  const clubId = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} Club ${uid()}`]))[0].id;
  await q(`select calendar.seed_club_event_types($1)`, [clubId]);
  const teamId = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} Team ${uid()}`]))[0].id;
  const coach = await coachOf(teamId, `${label} Coach`);
  const coach2 = await coachOf(teamId, `${label} Second Coach`);
  const athletes = [];
  for (const n of ["One", "Two", "Three"]) athletes.push(await makeAthlete(`${label} Athlete${n}`, clubId, teamId));
  await q(`insert into training_load.planned_rpe_workspace_settings (owner_scope, owner_team_id, enabled, enabled_at, updated_by_user_id)
           values ('team', $1, true, '2026-01-01T00:00:00Z', $2)`, [teamId, coach.id]).catch(async () => {
    await q(`insert into training_load.planned_rpe_workspace_settings (owner_scope, owner_team_id, enabled, enabled_at)
             values ('team', $1, true, '2026-01-01T00:00:00Z')`, [teamId]);
  });
  return { clubId, teamId, coach, coach2, athletes };
}

const sessionsOf = (draft) => (draft.blocks || []).flatMap((b) => (b.sessions || []).map((s) => ({ ...s, blockId: b.id })));
const nodesOf = (session) => session.nodes || [];

// A published weekly batch: Monday "Main" (Training) with a domain, a section
// and one exercise; tracked, with RPE. Returns the three plan ids in athlete order.
async function publishedBatch(s, { weekStart = WEEK, extraSessions = [] } = {}) {
  const ids = s.athletes.map((a) => a.externalId);
  const created = ok(await api("/api/builder/plans", { method: "POST", cookie: s.coach.cookie, body: { planType: "weekly", weekStart, athleteIds: ids, athleteExternalIds: ids, name: "Group week" } }), 201);
  const planId = created.plan.id;
  let draft = ok(await api(`/api/builder/plans/${planId}`, { cookie: s.coach.cookie }));
  const addSession = async (blockIndex, name, bta = "T") => {
    draft = ok(await api(`/api/builder/blocks/${draft.blocks[blockIndex].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta, name, syncBatch: true } }), 201);
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
  for (const extra of extraSessions) await addSession(extra.day, extra.name, extra.bta || "T");
  ok(await api(`/api/builder/plans/${planId}/submit`, { method: "POST", cookie: s.coach.cookie, body: { syncBatch: true, responseMode: "summary" } }));
  const rows = await q(`select p.id, p.athlete_id, p.status from plans.plans p where p.builder_batch_id = (select builder_batch_id from plans.plans where id = $1) and not coalesce(p.is_edit_draft,false) order by p.id`, [planId]);
  assert.ok(rows.every((r) => r.status === "active"));
  return s.athletes.map((a) => rows.find((r) => String(r.athlete_id) === String(a.athleteId)).id);
}

async function reopen(cookie, planId) {
  return ok(await api(`/api/builder/plans/${planId}/edit`, { method: "POST", cookie }));
}
const save = (cookie, draftId, extra = {}) => api(`/api/builder/plans/${draftId}/submit`, { method: "POST", cookie, body: { responseMode: "summary", ...extra } });

async function treeOf(planId) {
  const c = new pg.Client({ connectionString: db.url });
  await c.connect();
  try { return await tree.loadWeeklyTree(c, planId); } finally { await c.end(); }
}
const byName = (t, name) => t.sessions.find((x) => x.name === name);

// Everything a Save could write, for "nothing written".
async function digestOf(planIds) {
  const r = await q(`
    select md5(coalesce((select string_agg(x::text, '|' order by x::text) from plans.plans x where id = any($1::uuid[]) or edit_source_plan_id = any($1::uuid[])), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from plans.plan_days x where plan_id = any($1::uuid[])), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from plans.plan_sessions x join plans.plan_days d on d.id = x.plan_day_id where d.plan_id = any($1::uuid[])), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from plans.plan_nodes x join plans.plan_sessions s on s.id = x.plan_session_id join plans.plan_days d on d.id = s.plan_day_id where d.plan_id = any($1::uuid[])), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from plans.plan_items x join plans.plan_sessions s on s.id = x.plan_session_id join plans.plan_days d on d.id = s.plan_day_id where d.plan_id = any($1::uuid[])), '')) as d`, [planIds]);
  return r[0].d;
}

async function rpeRow(athlete, sessionId) {
  // As the athlete's own submit writes it (the route is used where the race needs it).
  const s = (await q(`select ps.logical_session_id, pd.date, p.name, p.week_start from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id join plans.plans p on p.id = pd.plan_id where ps.id = $1`, [sessionId]))[0];
  await q(`insert into training_load.session_feedback (athlete_id, plan_session_id, logical_session_id, session_date, plan_name, plan_week_start, rpe, duration_minutes)
           values ($1,$2,$3,$4,$5,$6,6,60)`, [athlete.athleteId, sessionId, s.logical_session_id, s.date, s.name, s.week_start]);
}

async function waitForLockWait(predicate = () => true) {
  for (let i = 0; i < 400; i += 1) {
    const rows = await q(`select pid, query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`);
    if (rows.some(predicate)) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  const active = await q(`select state, wait_event_type, wait_event, left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'`);
  throw new Error(`no statement waited on a lock: ${JSON.stringify(active)}`);
}
function gate() {
  let release; let reached;
  const released = new Promise((r) => { release = r; });
  const arrived = new Promise((r) => { reached = r; });
  return { released, arrived, release: () => release(), reached: () => reached() };
}

async function teamEventFor(s, day) {
  const types = ok(await api("/api/calendar/events/types", { cookie: s.coach.cookie }));
  const type = types.types.find((t) => t.kind === "training");
  const res = await api("/api/calendar/events", { method: "POST", cookie: s.coach.cookie, body: { requestKey: crypto.randomUUID(), timezone: "UTC", eventTypeId: type.id, title: "Team training", day, targets: [{ kind: "team", id: s.teamId }] } });
  return ok(res, 201).event;
}
const attach = (cookie, eventId, body) => api(`/api/calendar/events/${eventId}/sessions`, { method: "POST", cookie, body: { requestKey: crypto.randomUUID(), ...body } });

before(async () => {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "support/legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  db = await createDisposableDatabase({ prefix: "builder", label: "batchedit", baseDatabaseUrl: BASE_URL });
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
  calendarHooks = (await import("../src/calendarEventService.js")).testHooks;
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

test("1. an added session reaches every athlete: the others get fresh logical ids, the edited one keeps its own, nothing else of theirs is rewritten", async () => {
  const s = await squad("add");
  const [a, b, c] = await publishedBatch(s);
  const beforeB = await treeOf(b); const beforeC = await treeOf(c);
  const draft = await reopen(s.coach.cookie, a);
  ok(await api(`/api/builder/blocks/${draft.blocks[1].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta: "T", name: "Added" } }), 201);
  const saved = ok(await save(s.coach.cookie, draft.plan.id, { batchScope: "all" }));
  assert.equal(saved.batchEdit.applied, 3);
  const [ta, tb, tc] = [await treeOf(a), await treeOf(b), await treeOf(c)];
  for (const t of [ta, tb, tc]) assert.ok(byName(t, "Added"), "every athlete has the session");
  const logicals = [ta, tb, tc].map((t) => String(byName(t, "Added").logical_session_id));
  assert.equal(new Set(logicals).size, 3, "three distinct logical ids");
  // The untouched Monday session of B and C: same row, same logical id, same content.
  for (const [t, was] of [[tb, beforeB], [tc, beforeC]]) {
    const now = byName(t, "Main"); const then = byName(was, "Main");
    assert.equal(String(now.id), String(then.id));
    assert.equal(String(now.logical_session_id), String(then.logical_session_id));
    assert.equal(now.fingerprint, then.fingerprint);
  }
  assert.equal((await q(`select count(*)::int as n from plans.plans where id = $1`, [draft.plan.id]))[0].n, 0, "the edit draft is gone");
});

test("2. a changed dose reaches the others in place: their row ids and logical ids stay, and an entered RPE is still found by its logical id", async () => {
  const s = await squad("dose");
  const [a, b, c] = await publishedBatch(s);
  const mainB = byName(await treeOf(b), "Main");
  await rpeRow(s.athletes[1], mainB.id);
  const draft = await reopen(s.coach.cookie, a);
  const item = nodesOf(sessionsOf(draft).find((x) => x.name === "Main")).flatMap((n) => n.items || [])[0];
  ok(await api(`/api/builder/items/${item.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { sets: "5", reps: "3", load: "80%" } }));
  ok(await save(s.coach.cookie, draft.plan.id, { batchScope: "all" }));
  const [ta, tb, tc] = [await treeOf(a), await treeOf(b), await treeOf(c)];
  assert.equal(byName(tb, "Main").fingerprint, byName(ta, "Main").fingerprint, "B has the new dose");
  assert.equal(byName(tc, "Main").fingerprint, byName(ta, "Main").fingerprint, "C has the new dose");
  assert.equal(String(byName(tb, "Main").id), String(mainB.id), "same session row");
  assert.equal(String(byName(tb, "Main").logical_session_id), String(mainB.logical_session_id), "same logical id");
  const fb = await q(`select plan_session_id from training_load.session_feedback where athlete_id = $1 and logical_session_id = $2`, [s.athletes[1].athleteId, mainB.logical_session_id]);
  assert.equal(String(fb[0].plan_session_id), String(mainB.id), "the result is still on its session");
});

test("3. fields three-way: a setting changed for one athlete alone stays; a setting the coach changed in this edit reaches the others", async () => {
  const s = await squad("three");
  const [a, b, c] = await publishedBatch(s);
  // B's RPE request turned off for B alone.
  const draftB = await reopen(s.coach.cookie, b);
  const mainBDraft = sessionsOf(draftB).find((x) => x.name === "Main");
  ok(await api(`/api/builder/sessions/${mainBDraft.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { rpeEnabled: false } }));
  ok(await save(s.coach.cookie, draftB.plan.id, { batchScope: "this" }));
  // The coach renames Main for everyone.
  const draft = await reopen(s.coach.cookie, a);
  const main = sessionsOf(draft).find((x) => x.name === "Main");
  ok(await api(`/api/builder/sessions/${main.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { name: "Main renamed" } }));
  ok(await save(s.coach.cookie, draft.plan.id, { batchScope: "all" }));
  const tb = await treeOf(b); const tc = await treeOf(c);
  assert.ok(byName(tb, "Main renamed") && byName(tc, "Main renamed"));
  assert.equal(byName(tb, "Main renamed").rpe_enabled, false, "B keeps its own setting");
  assert.equal(byName(tc, "Main renamed").rpe_enabled, true);
  // And a Track / Request RPE change made in this edit reaches C, whose value was as before.
  const draft2 = await reopen(s.coach.cookie, a);
  const main2 = sessionsOf(draft2).find((x) => x.name === "Main renamed");
  ok(await api(`/api/builder/sessions/${main2.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { rpeEnabled: false } }));
  ok(await save(s.coach.cookie, draft2.plan.id, { batchScope: "all" }));
  assert.equal(byName(await treeOf(c), "Main renamed").rpe_enabled, false);
});

test("4. removing a session an athlete rated: asked about (has_results), nothing written; Apply to the others writes the rest and leaves that athlete as it was", async () => {
  const s = await squad("rated");
  const [a, b, c] = await publishedBatch(s, { extraSessions: [{ day: 2, name: "Wednesday" }] });
  await rpeRow(s.athletes[1], byName(await treeOf(b), "Wednesday").id);
  const draft = await reopen(s.coach.cookie, a);
  const wed = sessionsOf(draft).find((x) => x.name === "Wednesday");
  ok(await api(`/api/builder/sessions/${wed.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  const before = await digestOf([a, b, c]);
  const asked = await save(s.coach.cookie, draft.plan.id, { batchScope: "all" });
  assert.equal(asked.status, 409, asked.text);
  assert.equal(asked.body.code, "batch_members_need_choice");
  assert.deepEqual(asked.body.cannot, { named: [{ name: s.athletes[1].name, reasons: ["has_results"] }], unnamedCount: 0 });
  assert.equal(asked.body.applyCount, 1);
  assert.equal(await digestOf([a, b, c]), before, "nothing written");
  const done = ok(await save(s.coach.cookie, draft.plan.id, { batchScope: "all", applyTo: asked.body.applyTo, choiceToken: asked.body.choiceToken }));
  assert.equal(done.batchEdit.applied, 2);
  assert.equal(byName(await treeOf(a), "Wednesday"), undefined);
  assert.equal(byName(await treeOf(c), "Wednesday"), undefined);
  assert.ok(byName(await treeOf(b), "Wednesday"), "the rated session stays");
});

test("5. a session linked to an event: moving it is asked about (linked_to_event); a change in place keeps the link", async () => {
  const s = await squad("link");
  const [a, b, c] = await publishedBatch(s);
  const ev = await teamEventFor(s, WEEK);
  const mainC = byName(await treeOf(c), "Main");
  ok(await attach(s.coach.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [String(mainC.logical_session_id)] }));
  // Move Main from Monday to Tuesday.
  const draft = await reopen(s.coach.cookie, a);
  const main = sessionsOf(draft).find((x) => x.name === "Main");
  // A move: copy into Tuesday, then delete Monday's - the Builder's move is a slot change; emulate with PATCH of the slot.
  ok(await api(`/api/builder/sessions/${main.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { amPm: "PM" } }));
  const asked = await save(s.coach.cookie, draft.plan.id, { batchScope: "all" });
  assert.equal(asked.status, 409, asked.text);
  assert.deepEqual(asked.body.cannot.named, [{ name: s.athletes[2].name, reasons: ["linked_to_event"] }]);
  // A change in place instead: discard and rename.
  ok(await api(`/api/builder/plans/${draft.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  const draft2 = await reopen(s.coach.cookie, a);
  const main2 = sessionsOf(draft2).find((x) => x.name === "Main");
  ok(await api(`/api/builder/sessions/${main2.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { name: "Main moved nowhere" } }));
  ok(await save(s.coach.cookie, draft2.plan.id, { batchScope: "all" }));
  const links = await q(`select count(*)::int as n from calendar.event_session_links where event_id = $1 and ended_at is null and plan_id = $2`, [ev.id, c]);
  assert.equal(links[0].n, 1, "the link stays");
  assert.ok(byName(await treeOf(c), "Main moved nowhere"));
});

test("6. diverged: a session changed for one athlete alone and changed again in the edit is asked about; a session the edit does not touch is not", async () => {
  const s = await squad("div");
  const [a, b] = await publishedBatch(s, { extraSessions: [{ day: 2, name: "Wednesday" }] });
  // B's Main and Wednesday changed for B alone.
  const draftB = await reopen(s.coach.cookie, b);
  for (const name of ["Main", "Wednesday"]) {
    const item = nodesOf(sessionsOf(draftB).find((x) => x.name === name)).flatMap((n) => n.items || [])[0];
    ok(await api(`/api/builder/items/${item.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { sets: "9", reps: "9", load: "B only" } }));
  }
  ok(await save(s.coach.cookie, draftB.plan.id, { batchScope: "this" }));
  const tailoredWed = byName(await treeOf(b), "Wednesday").fingerprint;
  // The edit changes only Main.
  const draft = await reopen(s.coach.cookie, a);
  const item = nodesOf(sessionsOf(draft).find((x) => x.name === "Main")).flatMap((n) => n.items || [])[0];
  ok(await api(`/api/builder/items/${item.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { sets: "4", reps: "4", load: "All" } }));
  const asked = await save(s.coach.cookie, draft.plan.id, { batchScope: "all" });
  assert.equal(asked.status, 409, asked.text);
  assert.deepEqual(asked.body.cannot.named, [{ name: s.athletes[1].name, reasons: ["changed_separately"] }]);
  // An edit that touches only a session B did not tailor goes through for B.
  ok(await api(`/api/builder/plans/${draft.plan.id}`, { method: "DELETE", cookie: s.coach.cookie }));
  const draft2 = await reopen(s.coach.cookie, a);
  ok(await api(`/api/builder/blocks/${draft2.blocks[4].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta: "T", name: "Friday" } }), 201);
  const saved = ok(await save(s.coach.cookie, draft2.plan.id, { batchScope: "all" }));
  assert.equal(saved.batchEdit.applied, 3);
  assert.equal(byName(await treeOf(b), "Wednesday").fingerprint, tailoredWed, "B's tailored session is untouched");
});

test("7. a member another coach has open for editing is asked about (being_edited)", async () => {
  const s = await squad("open");
  const [a, , c] = await publishedBatch(s);
  await reopen(s.coach2.cookie, c);
  const draft = await reopen(s.coach.cookie, a);
  ok(await api(`/api/builder/blocks/${draft.blocks[1].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta: "T", name: "Added" } }), 201);
  const asked = await save(s.coach.cookie, draft.plan.id, { batchScope: "all" });
  assert.equal(asked.status, 409, asked.text);
  assert.deepEqual(asked.body.cannot.named, [{ name: s.athletes[2].name, reasons: ["being_edited"] }]);
});

test("8. an archived athlete and a plan the coach may no longer change are skipped and named; with the switcher's names narrowed the member is counted without a name (condition 10.2.1)", async () => {
  const s = await squad("skip");
  const [a, b, c] = await publishedBatch(s);
  await q(`update public.athletes set is_active = false where id = $1`, [s.athletes[1].athleteId]);
  // The second coach (not the plan's creator, who always keeps its own plans) loses C: C's memberships end.
  await q(`update public.athlete_memberships set status = 'archived', archived_at = now() where athlete_id = $1`, [s.athletes[2].athleteId]);
  const draft = await reopen(s.coach2.cookie, a);
  ok(await api(`/api/builder/blocks/${draft.blocks[1].id}/sessions`, { method: "POST", cookie: s.coach2.cookie, body: { bta: "T", name: "Added" } }), 201);
  const beforeBC = await digestOf([b, c]);
  batchHooks.visibleMemberIds = [String(a), String(b)];
  let saved;
  try {
    saved = ok(await save(s.coach2.cookie, draft.plan.id, { batchScope: "all" }));
  } finally {
    batchHooks.visibleMemberIds = null;
  }
  assert.equal(saved.batchEdit.applied, 1);
  assert.deepEqual(saved.batchEdit.notChanged, { named: [{ name: s.athletes[1].name, reasons: ["archived"] }], unnamedCount: 1 });
  assert.ok(!JSON.stringify(saved).includes(s.athletes[2].name), "the hidden member's name is nowhere in the answer");
  assert.ok(!JSON.stringify(saved).includes("not_editable") || saved.batchEdit.notChanged.named.every((m) => !m.reasons.includes("not_editable")), "and its reason is not tied to a name");
  assert.equal(await digestOf([b, c]), beforeBC, "neither was written");
  // With every name visible (today's switcher), the no-rights member is named.
  const draft2 = await reopen(s.coach2.cookie, a);
  ok(await api(`/api/builder/blocks/${draft2.blocks[2].id}/sessions`, { method: "POST", cookie: s.coach2.cookie, body: { bta: "T", name: "Added 2" } }), 201);
  const saved2 = ok(await save(s.coach2.cookie, draft2.plan.id, { batchScope: "all" }));
  assert.deepEqual(saved2.batchEdit.notChanged.named.map((m) => [m.name, m.reasons]).sort(), [[s.athletes[1].name, ["archived"]], [s.athletes[2].name, ["not_editable"]]].sort());
});

test("9. the choiceToken: a new result, a new event link, another coach's edit draft, an archive, or a new reason of an asked member between the 409 and the resend answers the 409 again and writes nothing (condition 10.2.2)", async () => {
  const changes = {
    result: async (s, plans) => rpeRow(s.athletes[2], byName(await treeOf(plans[2]), "Wednesday").id),
    link: async (s, plans) => {
      const ev = await teamEventFor(s, "2026-11-04");
      ok(await attach(s.coach.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [String(byName(await treeOf(plans[2]), "Wednesday").logical_session_id)] }));
    },
    draft: async (s, plans) => { await reopen(s.coach2.cookie, plans[2]); },
    archive: async (s) => { await q(`update public.athletes set is_active = false where id = $1`, [s.athletes[2].athleteId]); },
    // The members to apply stay the same; only the asked member's reasons change: only the token can tell.
    askedReason: async (s, plans) => {
      const ev = await teamEventFor(s, "2026-11-04");
      ok(await attach(s.coach.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [String(byName(await treeOf(plans[1]), "Wednesday").logical_session_id)] }));
    },
  };
  for (const [label, change] of Object.entries(changes)) {
    const s = await squad(`tok${label}`);
    const plans = await publishedBatch(s, { extraSessions: [{ day: 2, name: "Wednesday" }] });
    await rpeRow(s.athletes[1], byName(await treeOf(plans[1]), "Wednesday").id);
    const draft = await reopen(s.coach.cookie, plans[0]);
    ok(await api(`/api/builder/sessions/${sessionsOf(draft).find((x) => x.name === "Wednesday").id}`, { method: "DELETE", cookie: s.coach.cookie }));
    const asked = await save(s.coach.cookie, draft.plan.id, { batchScope: "all" });
    assert.equal(asked.status, 409, `${label}: ${asked.text}`);
    await change(s, plans);
    const before = await digestOf(plans);
    const again = await save(s.coach.cookie, draft.plan.id, { batchScope: "all", applyTo: asked.body.applyTo, choiceToken: asked.body.choiceToken });
    assert.equal(again.status, 409, `${label}: ${again.text}`);
    assert.equal(again.body.code, "batch_members_need_choice", label);
    assert.notEqual(again.body.choiceToken, asked.body.choiceToken, label);
    assert.equal(await digestOf(plans), before, `${label}: nothing written`);
  }
});

test("10. two concurrent Saves on two members of one batch: no deadlock, each sees the other's open draft, nothing written", async () => {
  const s = await squad("two");
  const [a, b, c] = await publishedBatch(s);
  const dA = await reopen(s.coach.cookie, a);
  const dB = await reopen(s.coach2.cookie, b);
  ok(await api(`/api/builder/blocks/${dA.blocks[1].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta: "T", name: "From A" } }), 201);
  ok(await api(`/api/builder/blocks/${dB.blocks[2].id}/sessions`, { method: "POST", cookie: s.coach2.cookie, body: { bta: "T", name: "From B" } }), 201);
  const before = await digestOf([a, b, c]);
  const [ra, rb] = await Promise.all([save(s.coach.cookie, dA.plan.id, { batchScope: "all" }), save(s.coach2.cookie, dB.plan.id, { batchScope: "all" })]);
  for (const r of [ra, rb]) {
    assert.equal(r.status, 409, r.text);
    assert.ok(r.body.cannot.named.some((m) => m.reasons.includes("being_edited")));
  }
  assert.equal(await digestOf([a, b, c]), before);
  // A saves "this", then B's "all" goes through and reaches A and C.
  ok(await save(s.coach.cookie, dA.plan.id, { batchScope: "this" }));
  const rb2 = ok(await save(s.coach2.cookie, dB.plan.id, { batchScope: "all" }));
  assert.equal(rb2.batchEdit.applied, 3);
  assert.ok(byName(await treeOf(a), "From A") && byName(await treeOf(a), "From B"));
  assert.ok(byName(await treeOf(c), "From B") && !byName(await treeOf(c), "From A"));
});

test("11. the same draft saved twice at once: one write; the other answers already applied (or the draft is gone), never a 500", async () => {
  const s = await squad("twice");
  const [a, , c] = await publishedBatch(s);
  const draft = await reopen(s.coach.cookie, a);
  ok(await api(`/api/builder/blocks/${draft.blocks[1].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta: "T", name: "Once" } }), 201);
  const results = await Promise.all([save(s.coach.cookie, draft.plan.id, { batchScope: "all" }), save(s.coach.cookie, draft.plan.id, { batchScope: "all" })]);
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses[0], 200, results.map((r) => r.text).join(" / "));
  const other = results.find((r) => r.status !== 200) || results[1];
  assert.ok(other.status === 404 || (other.status === 409 && other.body.code === "edit_draft_already_applied"), other.text);
  assert.equal((await treeOf(c)).sessions.filter((x) => x.name === "Once").length, 1, "written once");
  // A retry after the fact: the draft is gone.
  const retry = await save(s.coach.cookie, draft.plan.id, { batchScope: "all" });
  assert.ok([404, 409].includes(retry.status), retry.text);
});

test("12. a Save racing an event attach, both orders: no deadlock; attach first: the Save sees the link; Save first: the attach finds the session by the same logical id", async () => {
  // Attach first, paused under its locks; the Save waits on the plan rows.
  {
    const s = await squad("raceA");
    const [a, , c] = await publishedBatch(s);
    const ev = await teamEventFor(s, WEEK);
    const draft = await reopen(s.coach.cookie, a);
    ok(await api(`/api/builder/sessions/${sessionsOf(draft).find((x) => x.name === "Main").id}`, { method: "PATCH", cookie: s.coach.cookie, body: { amPm: "PM" } }));
    const g = gate();
    calendarHooks.beforeCommit = async () => { g.reached(); await g.released; };
    let attaching;
    try {
      attaching = attach(s.coach.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [String(byName(await treeOf(c), "Main").logical_session_id)] });
      await g.arrived;
      const saving = save(s.coach.cookie, draft.plan.id, { batchScope: "all" });
      await waitForLockWait((r) => /for update/.test(r.query));
      g.release();
      ok(await attaching);
      const asked = await saving;
      assert.equal(asked.status, 409, asked.text);
      assert.deepEqual(asked.body.cannot.named, [{ name: s.athletes[2].name, reasons: ["linked_to_event"] }]);
    } finally {
      calendarHooks.beforeCommit = undefined;
      g.release();
    }
  }
  // Save first, paused after its locks; the attach waits on the plan row.
  {
    const s = await squad("raceB");
    const [a, , c] = await publishedBatch(s);
    const ev = await teamEventFor(s, WEEK);
    const logicalC = String(byName(await treeOf(c), "Main").logical_session_id);
    const draft = await reopen(s.coach.cookie, a);
    const item = nodesOf(sessionsOf(draft).find((x) => x.name === "Main")).flatMap((n) => n.items || [])[0];
    ok(await api(`/api/builder/items/${item.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { sets: "2", reps: "2", load: "x" } }));
    const g = gate();
    batchHooks.afterLocks = async () => { g.reached(); await g.released; };
    try {
      const saving = save(s.coach.cookie, draft.plan.id, { batchScope: "all" });
      await g.arrived;
      const attaching = attach(s.coach.cookie, ev.id, { expectedRevision: 1, logicalSessionIds: [logicalC] });
      await waitForLockWait((r) => /for share/.test(r.query));
      g.release();
      ok(await saving);
      ok(await attaching);
      assert.equal(String(byName(await treeOf(c), "Main").logical_session_id), logicalC);
      assert.equal((await q(`select count(*)::int as n from calendar.event_session_links where event_id = $1 and plan_id = $2 and ended_at is null`, [ev.id, c]))[0].n, 1);
    } finally {
      batchHooks.afterLocks = null;
      g.release();
    }
  }
});

test("13. a Save racing an athlete's RPE submit on a session the edit removes, both orders (condition 10.2.5)", async () => {
  // Submit first (the route's own statements, held open): the Save waits on the session row, then sees the result.
  {
    const s = await squad("rpeA");
    const [a, b] = await publishedBatch(s, { extraSessions: [{ day: 2, name: "Wednesday" }] });
    const wedB = byName(await treeOf(b), "Wednesday");
    const draft = await reopen(s.coach.cookie, a);
    ok(await api(`/api/builder/sessions/${sessionsOf(draft).find((x) => x.name === "Wednesday").id}`, { method: "DELETE", cookie: s.coach.cookie }));
    const submit = new pg.Client({ connectionString: db.url });
    await submit.connect();
    try {
      await submit.query("begin");
      await submit.query(`select ps.id from plans.plan_sessions ps where ps.id = $1 for update of ps`, [wedB.id]);
      await submit.query(`insert into training_load.session_feedback (athlete_id, plan_session_id, logical_session_id, session_date, plan_name, rpe, duration_minutes)
                          select $1, ps.id, ps.logical_session_id, pd.date, 'Group week', 7, 45 from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where ps.id = $2`, [s.athletes[1].athleteId, wedB.id]);
      const saving = save(s.coach.cookie, draft.plan.id, { batchScope: "all" });
      await waitForLockWait((r) => /for update/.test(r.query));
      await submit.query("commit");
      const asked = await saving;
      assert.equal(asked.status, 409, asked.text);
      assert.deepEqual(asked.body.cannot.named, [{ name: s.athletes[1].name, reasons: ["has_results"] }]);
      assert.ok(byName(await treeOf(b), "Wednesday"));
    } finally {
      await submit.end();
    }
  }
  // Save first, paused under its locks; the real RPE route waits on the session row and then answers 404.
  {
    const s = await squad("rpeB");
    const [a, b] = await publishedBatch(s, { extraSessions: [{ day: 2, name: "Wednesday" }] });
    const wedB = byName(await treeOf(b), "Wednesday");
    const draft = await reopen(s.coach.cookie, a);
    ok(await api(`/api/builder/sessions/${sessionsOf(draft).find((x) => x.name === "Wednesday").id}`, { method: "DELETE", cookie: s.coach.cookie }));
    const g = gate();
    batchHooks.afterLocks = async () => { g.reached(); await g.released; };
    try {
      const saving = save(s.coach.cookie, draft.plan.id, { batchScope: "all" });
      await g.arrived;
      const rating = api(`/api/training-load/sessions/${wedB.id}/rpe`, { method: "POST", cookie: s.athletes[1].cookie, body: { rpe: 6, durationMinutes: 50 } });
      // The submit must be waiting on the session row; if it answered instead, say what it answered.
      const early = await Promise.race([rating.then((r) => r), waitForLockWait((r) => /select ps.id as session_id/.test(r.query)).then(() => null)]);
      assert.equal(early, null, `the submit answered before waiting: ${early?.status} ${early?.text}`);
      g.release();
      ok(await saving);
      const rated = await rating;
      assert.equal(rated.status, 404, rated.text);
      assert.equal(byName(await treeOf(b), "Wednesday"), undefined);
      assert.equal((await q(`select count(*)::int as n from training_load.session_feedback where athlete_id = $1`, [s.athletes[1].athleteId]))[0].n, 0);
    } finally {
      batchHooks.afterLocks = null;
      g.release();
    }
  }
});

test("14. reopening a member during a Save of its batch waits and copies what the Save wrote; both orders, and the recorded lock order (condition 10.2.3)", async () => {
  const s = await squad("reopen");
  const [a, b] = await publishedBatch(s);
  const draft = await reopen(s.coach.cookie, a);
  const item = nodesOf(sessionsOf(draft).find((x) => x.name === "Main")).flatMap((n) => n.items || [])[0];
  ok(await api(`/api/builder/items/${item.id}`, { method: "PATCH", cookie: s.coach.cookie, body: { sets: "7", reps: "7", load: "new" } }));
  // Record every row lock statement the app sends, in order.
  const recorded = [];
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function recording(config, values, cb) {
    const text = typeof config === "string" ? config : config?.text;
    if (text && /\bfor (update|share|no key update)\b/i.test(text) && /plans\.plans/.test(text)) recorded.push({ text: text.replace(/\s+/g, " ").trim(), values: Array.isArray(values) ? values.map(String) : [] });
    return original.call(this, config, values, cb);
  };
  const g = gate();
  batchHooks.afterLocks = async () => { g.reached(); await g.released; };
  try {
    const saving = save(s.coach.cookie, draft.plan.id, { batchScope: "all" });
    await g.arrived;
    const reopening = api(`/api/builder/plans/${b}/edit`, { method: "POST", cookie: s.coach2.cookie });
    await waitForLockWait((r) => /for share/.test(r.query));
    g.release();
    ok(await saving);
    const draftB = ok(await reopening);
    const mainA = byName(await treeOf(a), "Main");
    assert.equal(byName(await treeOf(draftB.plan.id), "Main").fingerprint, mainA.fingerprint, "the new draft carries the Save's change");
  } finally {
    batchHooks.afterLocks = null;
    g.release();
    pg.Client.prototype.query = original;
  }
  // The Save: the draft row first, then the live rows in ascending id, never the source alone first.
  const order = recorded.filter((r) => /for update/i.test(r.text)).map((r) => r.values[0]).filter(Boolean);
  assert.equal(order[0], String(draft.plan.id), "the edit draft's row first");
  const live = order.slice(1).filter((id) => id !== String(draft.plan.id));
  const sortedLive = [...live].sort();
  assert.ok(live.length >= 3, "every live member is locked");
  assert.equal(new Set(live).size, live.length, "each live row once: the source is not locked on its own before the set");
  assert.deepEqual(live, sortedLive, "then the live members in ascending id, the source among them, never first on its own");
  // The edit route: one row FOR SHARE, nothing else locked before its copy.
  const shares = recorded.filter((r) => /for share/i.test(r.text) && r.values[0] === String(b));
  assert.equal(shares.length, 1, "the reopen takes the live row FOR SHARE once");
  // Order 2: the reopen first (its row held FOR SHARE by a held transaction), then the Save waits and proceeds.
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    const d2 = await reopen(s.coach.cookie, a);
    ok(await api(`/api/builder/blocks/${d2.blocks[3].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta: "T", name: "Thursday" } }), 201);
    await holder.query("begin");
    await holder.query(`select id from plans.plans where id = $1 for share`, [b]);
    const saving = save(s.coach.cookie, d2.plan.id, { batchScope: "all" });
    await waitForLockWait((r) => /for update/.test(r.query));
    await holder.query("commit");
    // B's own open draft (from the first half) is in the way: the Save asks.
    const asked = await saving;
    assert.equal(asked.status, 409, asked.text);
    assert.deepEqual(asked.body.cannot.named, [{ name: s.athletes[1].name, reasons: ["being_edited"] }]);
  } finally {
    await holder.end();
  }
});

test("15. Only this athlete keeps today's behaviour; a program batch and a save without batchScope never touch the others", async () => {
  const s = await squad("only");
  const [a, b, c] = await publishedBatch(s);
  const before = await digestOf([b, c]);
  const draft = await reopen(s.coach.cookie, a);
  ok(await api(`/api/builder/blocks/${draft.blocks[1].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta: "T", name: "Mine" } }), 201);
  const saved = ok(await save(s.coach.cookie, draft.plan.id, { batchScope: "this" }));
  assert.equal(saved.batchEdit, undefined);
  assert.ok(byName(await treeOf(a), "Mine"));
  assert.equal(await digestOf([b, c]), before);
  const draft2 = await reopen(s.coach.cookie, a);
  ok(await api(`/api/builder/blocks/${draft2.blocks[2].id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { bta: "T", name: "Mine too" } }), 201);
  ok(await save(s.coach.cookie, draft2.plan.id, { syncBatch: true }));
  assert.equal(await digestOf([b, c]), before, "syncBatch on an edit draft is still ignored");
});
