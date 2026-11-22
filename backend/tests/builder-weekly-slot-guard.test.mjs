// The weekly slot (ensureWeeklySlot, backend/src/routes/builder.js): creating
// or copying a weekly plan into a week removes the caller's own plan of that
// athlete and week ONLY when it is a draft with no session at all. A published
// plan, a draft with a session, and any plan with a session that has results or
// a live event link (docs/ai/builder-batch-edit-plan.md section 12) are never
// removed: the create is refused and nothing is written.
//
// One disposable database (optimove_tests_builder_slotguard_*): the committed
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

// A past Monday, so an athlete may have rated its sessions.
const WEEK = "2026-11-02";
const OTHER_WEEK = "2026-11-09";
const REFUSAL = /already has a weekly plan for that week\./;

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
async function makeCoach(label, teamId) {
  const id = await makeUser(label);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return { id, cookie: await cookieOf(id) };
}

// A team with one athlete and two coaches.
async function squad(label) {
  const clubId = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} Club ${uid()}`]))[0].id;
  await q(`select calendar.seed_club_event_types($1)`, [clubId]);
  const teamId = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} Team ${uid()}`]))[0].id;
  const coach = await makeCoach(`${label} Coach`, teamId);
  const second = await makeCoach(`${label} Second`, teamId);
  const makeAthlete = async (last) => {
    const name = `${label} ${last}`;
    const userId = await makeUser(name);
    const row = (await q(
      `insert into public.athletes (athlete_id, user_id, first_name, last_name, full_name, display_name, device_timezone)
       values (nextval('public.athlete_generated_id_seq')::text, $1, $2, $3, $4, $4, 'UTC') returning id, athlete_id`,
      [userId, label, last, name]))[0];
    await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,null,'club','active','2026-01-01T00:00:00Z')`, [row.id, clubId]);
    await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [row.id, clubId, teamId]);
    return { athleteId: row.id, externalId: row.athlete_id };
  };
  return { clubId, teamId, coach, second, athlete: await makeAthlete("Athlete"), athlete2: await makeAthlete("AthleteTwo") };
}

const sessionsOf = (draft) => (draft.blocks || []).flatMap((b) => (b.sessions || []).map((s) => ({ ...s, blockId: b.id })));

const createWeekly = (cookie, athlete, weekStart = WEEK) => api("/api/builder/plans", {
  method: "POST", cookie, body: { planType: "weekly", weekStart, athleteIds: [athlete.externalId], name: "Week" },
});
const copyInto = (cookie, sourcePlanId, athlete, weekStart = WEEK) => api(`/api/builder/plans/${sourcePlanId}/duplicate`, {
  method: "POST", cookie, body: { athleteIds: [athlete.externalId], weekStart },
});

// A weekly draft of `athlete`; `sessions` names the sessions added on Monday,
// each with one named node when `content`.
async function weeklyDraft(s, { cookie = s.coach.cookie, athlete = s.athlete, weekStart = WEEK, sessions = [], content = true } = {}) {
  const created = ok(await createWeekly(cookie, athlete, weekStart), 201);
  const planId = created.plan.id;
  let draft = created;
  for (const name of sessions) {
    draft = ok(await api(`/api/builder/blocks/${draft.blocks[0].id}/sessions`, { method: "POST", cookie, body: { bta: "T", name } }), 201);
    const session = sessionsOf(draft).find((x) => x.name === name);
    if (content) draft = ok(await api(`/api/builder/sessions/${session.id}/nodes`, { method: "POST", cookie, body: { nodeType: "domain", name: "Strength" } }), 201);
  }
  return planId;
}

// A PUBLISHED weekly plan of the athlete with one Monday session "Main" that
// has no item and no named node (a bare session): published with content, then
// its nodes removed, as an edit of a published plan leaves it.
async function publishedBarePlan(s) {
  const planId = await weeklyDraft(s, { sessions: ["Main"] });
  ok(await api(`/api/builder/plans/${planId}/submit`, { method: "POST", cookie: s.coach.cookie, body: { responseMode: "summary" } }));
  assert.equal((await q(`select status from plans.plans where id = $1`, [planId]))[0].status, "active");
  return planId;
}
async function strip(planId) {
  await q(`delete from plans.plan_items where plan_session_id in (select ps.id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1)`, [planId]);
  await q(`delete from plans.plan_nodes where plan_session_id in (select ps.id from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1)`, [planId]);
}
const mainOf = async (planId) => (await q(
  `select ps.id, ps.logical_session_id, pd.date, p.name, p.week_start from plans.plan_sessions ps
     join plans.plan_days pd on pd.id = ps.plan_day_id join plans.plans p on p.id = pd.plan_id where pd.plan_id = $1 and ps.name = 'Main'`, [planId]))[0];

// A source to copy from: the coach's own weekly draft of another week, with content.
const copySource = (s) => weeklyDraft(s, { weekStart: OTHER_WEEK, sessions: ["Source"] });

// The plan, its days, sessions, nodes, items and links, for "nothing written".
async function digestOf(planId) {
  const r = await q(`
    select md5(coalesce((select string_agg(x::text, '|' order by x::text) from plans.plans x where id = $1), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from plans.plan_days x where x.plan_id = $1), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from plans.plan_sessions x join plans.plan_days d on d.id = x.plan_day_id where d.plan_id = $1), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from plans.plan_nodes x join plans.plan_sessions s on s.id = x.plan_session_id join plans.plan_days d on d.id = s.plan_day_id where d.plan_id = $1), '')
      || coalesce((select string_agg(x::text, '|' order by x::text) from calendar.event_session_links x where x.plan_id = $1), '')) as d`, [planId]);
  return r[0].d;
}
const weeklyPlansOf = async (s, weekStart = WEEK) => (await q(
  `select id from plans.plans where plan_type = 'weekly' and athlete_id = $1 and week_start = $2 and not coalesce(is_edit_draft, false) order by created_at`,
  [s.athlete.athleteId, weekStart])).map((r) => String(r.id));

// Both routes refuse, and the plan in the slot is exactly as it was.
async function assertBothRefused(s, planId, { cookie = s.coach.cookie, source } = {}) {
  const before = await digestOf(planId);
  const plansBefore = await weeklyPlansOf(s);
  assert.ok(plansBefore.includes(String(planId)));
  const created = await createWeekly(cookie, s.athlete);
  assert.equal(created.status, 409, `POST /plans: ${created.text}`);
  assert.match(created.body.error, REFUSAL);
  const copied = await copyInto(cookie, source, s.athlete);
  assert.equal(copied.status, 409, `POST /plans/:id/duplicate: ${copied.text}`);
  assert.match(copied.body.error, REFUSAL);
  assert.equal(await digestOf(planId), before, "the plan, its days, sessions and links are unchanged");
  assert.deepEqual(await weeklyPlansOf(s), plansBefore, "no plan removed, none created");
}

before(async () => {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "support/legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  db = await createDisposableDatabase({ prefix: "builder", label: "slotguard", baseDatabaseUrl: BASE_URL });
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

test("1. a published week whose bare session has an RPE result: a create and a copy into that week are refused; the plan, the session and the RPE stay", async () => {
  const s = await squad("rpe");
  const planId = await publishedBarePlan(s);
  const main = await mainOf(planId);
  await q(`insert into training_load.session_feedback (athlete_id, plan_session_id, logical_session_id, session_date, plan_name, plan_week_start, rpe, duration_minutes)
           values ($1,$2,$3,$4,$5,$6,6,60)`, [s.athlete.athleteId, main.id, main.logical_session_id, main.date, main.name, main.week_start]);
  await strip(planId);
  const source = await copySource(s);
  await assertBothRefused(s, planId, { source });
  const rows = await q(
    `select sf.id from training_load.session_feedback sf join plans.plan_sessions ps on ps.logical_session_id = sf.logical_session_id
      where sf.logical_session_id = $1 and ps.id = $2`, [main.logical_session_id, main.id]);
  assert.equal(rows.length, 1, "the RPE still names a live session");
});

test("2. a published week whose bare session has a live event link: refused on both routes; the link stays on its session", async () => {
  const s = await squad("link");
  const planId = await publishedBarePlan(s);
  const main = await mainOf(planId);
  const types = ok(await api("/api/calendar/events/types", { cookie: s.coach.cookie }));
  const type = types.types.find((t) => t.kind === "training");
  const ev = ok(await api("/api/calendar/events", { method: "POST", cookie: s.coach.cookie, body: { requestKey: crypto.randomUUID(), timezone: "UTC", eventTypeId: type.id, title: "Team training", day: WEEK, targets: [{ kind: "team", id: s.teamId }] } }), 201).event;
  ok(await api(`/api/calendar/events/${ev.id}/sessions`, { method: "POST", cookie: s.coach.cookie, body: { requestKey: crypto.randomUUID(), expectedRevision: 1, logicalSessionIds: [String(main.logical_session_id)] } }));
  await strip(planId);
  const source = await copySource(s);
  await assertBothRefused(s, planId, { source });
  const live = await q(`select logical_session_id_at_link from calendar.event_session_links where event_id = $1 and plan_id = $2 and ended_at is null`, [ev.id, planId]);
  assert.equal(live.length, 1);
  assert.equal(String(live[0].logical_session_id_at_link), String((await mainOf(planId)).logical_session_id), "the link still names a live session");
});

test("3. a published week with a bare session and no results: refused too (a published plan is never free)", async () => {
  const s = await squad("published");
  const planId = await publishedBarePlan(s);
  await strip(planId);
  await assertBothRefused(s, planId, { source: await copySource(s) });
});

test("4. a published week with no session at all: refused (the status alone keeps it)", async () => {
  const s = await squad("publishedempty");
  const planId = await publishedBarePlan(s);
  await strip(planId);
  await q(`delete from plans.plan_sessions where plan_day_id in (select id from plans.plan_days where plan_id = $1)`, [planId]);
  await assertBothRefused(s, planId, { source: await copySource(s) });
});

test("5. a draft with a session but no item or node: refused (a session is content)", async () => {
  const s = await squad("draftsession");
  const planId = await weeklyDraft(s, { sessions: ["Main"], content: false });
  assert.equal((await q(`select status from plans.plans where id = $1`, [planId]))[0].status, "draft");
  await assertBothRefused(s, planId, { source: await copySource(s) });
});

test("6. the caller's own empty draft (no session) is still replaced, on both routes", async () => {
  const s = await squad("emptydraft");
  const first = await weeklyDraft(s);
  const created = ok(await createWeekly(s.coach.cookie, s.athlete), 201);
  assert.notEqual(String(created.plan.id), String(first));
  assert.deepEqual(await weeklyPlansOf(s), [String(created.plan.id)], "the empty draft is gone, the new plan is the week's only one");
  const source = await copySource(s);
  const copied = await copyInto(s.coach.cookie, source, s.athlete);
  assert.ok(copied.status === 200 || copied.status === 201, copied.text);
  const now = await weeklyPlansOf(s);
  assert.equal(now.length, 1, "one plan of the week");
  assert.ok(!now.includes(String(created.plan.id)), "the second empty draft is gone too");
  const sessions = await q(`select ps.name from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1`, [now[0]]);
  assert.deepEqual(sessions.map((r) => r.name), ["Source"], "the copy is in the slot");
});

test("7. another coach's empty draft, and the caller's own plan that is not a Builder plan: refused as before", async () => {
  const s = await squad("others");
  const theirs = await weeklyDraft(s, { cookie: s.second.cookie });
  const source = await copySource(s);
  await assertBothRefused(s, theirs, { source });
  await q(`delete from plans.plan_days where plan_id = $1`, [theirs]);
  await q(`delete from plans.plans where id = $1`, [theirs]);
  const own = await weeklyDraft(s);
  await q(`update plans.plans set source_type = 'import' where id = $1`, [own]);
  await assertBothRefused(s, own, { source });
});

// The locked half of weeklySlotPlanIsFree: a change that commits after the
// unlocked reads and before the removal. `change` runs in a second client's
// open transaction; the request is sent while it is open; the transaction
// commits once the request waits on one of its locks (or after 1.5 s if it
// never waits). No timing decides the outcome: the request cannot finish its
// removal before the commit, in either order of its own statements.
async function raceAgainstOpenChange(change, send) {
  const other = new pg.Client({ connectionString: db.url });
  await other.connect();
  try {
    await other.query("begin");
    await change(other);
    const pending = send();
    for (let i = 0; i < 60; i += 1) {
      const waiting = await q(`select 1 from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock'`);
      if (waiting.length) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await other.query("commit");
    return await pending;
  } finally {
    await other.query("rollback").catch(() => {});
    await other.end().catch(() => {});
  }
}
// The copy's source is made before the race, so only the slot check runs in it.
const slotRoutes = [
  ["POST /plans", async (s) => () => createWeekly(s.coach.cookie, s.athlete)],
  ["POST /plans/:id/duplicate", async (s) => { const source = await copySource(s); return () => copyInto(s.coach.cookie, source, s.athlete); }],
];

test("R1. a session inserted into the caller's empty draft, committed while the create is in flight: 409, the plan and the session stay (both routes)", async () => {
  for (const [route, prepare] of slotRoutes) {
    const s = await squad("racesession");
    const planId = await weeklyDraft(s);
    const dayId = (await q(`select id from plans.plan_days where plan_id = $1 order by day_order limit 1`, [planId]))[0].id;
    const request = await prepare(s);
    const res = await raceAgainstOpenChange(
      (other) => other.query(`insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order) values ($1,'Late','AM','T',1)`, [dayId]),
      request,
    );
    assert.equal(res.status, 409, `${route}: ${res.text}`);
    assert.match(res.body.error, REFUSAL);
    assert.deepEqual(await weeklyPlansOf(s), [String(planId)], `${route}: the draft is still the week's only plan`);
    const sessions = await q(`select ps.name from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1`, [planId]);
    assert.deepEqual(sessions.map((r) => r.name), ["Late"], `${route}: the session is still there`);
  }
});

test("R2. the caller's empty draft published, committed while the create is in flight: 409, the plan stays and is active (both routes)", async () => {
  for (const [route, prepare] of slotRoutes) {
    const s = await squad("racepublish");
    const planId = await weeklyDraft(s);
    const request = await prepare(s);
    const res = await raceAgainstOpenChange(
      (other) => other.query(`update plans.plans set status = 'active' where id = $1`, [planId]),
      request,
    );
    assert.equal(res.status, 409, `${route}: ${res.text}`);
    assert.match(res.body.error, REFUSAL);
    assert.deepEqual(await weeklyPlansOf(s), [String(planId)], `${route}: the plan is still the week's only plan`);
    assert.equal((await q(`select status from plans.plans where id = $1`, [planId]))[0].status, "active");
    assert.equal((await q(`select count(*)::int as n from plans.plan_days where plan_id = $1`, [planId]))[0].n, 7, `${route}: its days are still there`);
  }
});

test("R3. the caller's empty draft stops being a Builder plan, committed while the create is in flight: 409, the plan stays", async () => {
  const s = await squad("raceowner");
  const planId = await weeklyDraft(s);
  const res = await raceAgainstOpenChange(
    (other) => other.query(`update plans.plans set source_type = 'import' where id = $1`, [planId]),
    () => createWeekly(s.coach.cookie, s.athlete),
  );
  assert.equal(res.status, 409, res.text);
  assert.match(res.body.error, REFUSAL);
  assert.deepEqual(await weeklyPlansOf(s), [String(planId)], "the plan is still the week's only plan");
});

const batchCreate = (cookie, athletes) => api("/api/builder/plans", {
  method: "POST", cookie, body: { planType: "weekly", weekStart: WEEK, athleteIds: athletes.map((a) => a.externalId), name: "Week" },
});
const planCount = async () => (await q(`select count(*)::int as n from plans.plans`))[0].n;

test("8. a batch create refused for one athlete removes no other athlete's free draft (nothing written)", async () => {
  const s = await squad("batch");
  const free = await weeklyDraft(s);
  const taken = await weeklyDraft(s, { athlete: s.athlete2, sessions: ["Main"], content: false });
  const before = [await digestOf(free), await digestOf(taken), await planCount()];
  // The free draft's athlete first: its draft is removed inside the transaction before the conflict is known.
  const res = await batchCreate(s.coach.cookie, [s.athlete, s.athlete2]);
  assert.equal(res.status, 409, res.text);
  assert.match(res.body.error, REFUSAL);
  assert.deepEqual([await digestOf(free), await digestOf(taken), await planCount()], before, "both drafts as they were, no plan created");
});

test("9. a refused create takes no lock: it answers while another transaction holds the rows of the plans it refuses on", async () => {
  const s = await squad("nolock");
  const published = await publishedBarePlan(s);
  const draft = await weeklyDraft(s, { athlete: s.athlete2, sessions: ["Main"], content: false });
  const holder = new pg.Client({ connectionString: db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select id from plans.plans where id = any($1::uuid[]) for update`, [[published, draft]]);
    await holder.query(`select id from plans.plan_days where plan_id = any($1::uuid[]) for update`, [[published, draft]]);
    const timeout = new Promise((resolve) => setTimeout(() => resolve("waited"), 5000));
    const res = await Promise.race([batchCreate(s.coach.cookie, [s.athlete2, s.athlete]), timeout]);
    assert.notEqual(res, "waited", "the refused create waited on a row lock");
    assert.equal(res.status, 409, res.text);
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end().catch(() => {});
  }
});
