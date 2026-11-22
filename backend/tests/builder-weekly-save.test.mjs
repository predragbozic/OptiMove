// Weekly program templates, part WT-C (docs/ai/weekly-program-template-plan.md):
// save as template from chosen weeks.
//
// One disposable database (optimove_tests_builder_weeklytpl_*): the committed
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

let db;
let admin;
let server;
let apiBase;
let appPool;
let createSession;
let builderModule;

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
  return { name, athleteId: row.id, externalId: row.athlete_id, userId };
}
async function coachOf(label, teamId) {
  const coachId = await makeUser(`${label} Coach`);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachId, teamId]);
  await setWorkspace(coachId, "team", teamId);
  return { id: coachId, cookie: await cookieOf(coachId) };
}
async function squad(label, athleteCount = 2) {
  const clubId = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} Club ${uid()}`]))[0].id;
  await q(`select calendar.seed_club_event_types($1)`, [clubId]);
  const teamId = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} Team ${uid()}`]))[0].id;
  const coach = await coachOf(label, teamId);
  const athletes = [];
  for (let i = 1; i <= athleteCount; i += 1) athletes.push(await makeAthlete(`${label} Athlete${i}`, clubId, teamId));
  return { clubId, teamId, coach, athletes };
}

const sessionsOf = (draft) => (draft.blocks || []).flatMap((b) => (b.sessions || []).map((s) => ({ ...s, blockId: b.id, blockIndex: b.index })));
async function addSession(cookie, blockId, name, exercise = `${name} squat`) {
  let draft = ok(await api(`/api/builder/blocks/${blockId}/sessions`, { method: "POST", cookie, body: { bta: "T", name } }), 201);
  const session = sessionsOf(draft).find((x) => x.name === name && x.blockId === blockId);
  draft = ok(await api(`/api/builder/sessions/${session.id}/nodes`, { method: "POST", cookie, body: { nodeType: "domain", name: "Strength" } }), 201);
  const domain = sessionsOf(draft).find((x) => x.id === session.id).nodes.find((n) => n.type === "domain");
  draft = ok(await api(`/api/builder/sessions/${session.id}/nodes`, { method: "POST", cookie, body: { nodeType: "section", name: "Lower body", parentId: domain.id } }), 201);
  const section = sessionsOf(draft).find((x) => x.id === session.id).nodes.find((n) => n.type === "section");
  const res = await api(`/api/builder/nodes/${section.id}/custom-exercise`, { method: "POST", cookie, body: { name: exercise } });
  assert.ok(res.status < 300, res.text);
  return res.body;
}
async function weeklyTemplate(cookie, weeks = 1, name = "Base block") {
  return ok(await api("/api/builder/plans", { method: "POST", cookie, body: { planType: "program", templateKind: "weekly", weeks, name } }), 201);
}
const blockOf = (draft, week, day) => draft.blocks.find((b) => b.index === (week - 1) * 7 + day);

// A published weekly plan of one athlete for `weekStart`, with sessions named
// `names` on Monday (index 0) / any weekday.
async function publishedWeek(s, athlete, weekStart, sessions) {
  const created = ok(await api("/api/builder/plans", { method: "POST", cookie: s.coach.cookie, body: { planType: "weekly", weekStart, athleteIds: [athlete.externalId], name: "Own week" } }), 201);
  let draft = created;
  for (const [weekday, name] of sessions) draft = await addSession(s.coach.cookie, draft.blocks[weekday - 1].id, name);
  ok(await api(`/api/builder/plans/${created.plan.id}/submit`, { method: "POST", cookie: s.coach.cookie, body: {} }));
  return created.plan.id;
}
async function rpeRow(athleteId, sessionId) {
  const s = (await q(`select ps.logical_session_id, pd.date, p.name, p.week_start from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id join plans.plans p on p.id = pd.plan_id where ps.id = $1`, [sessionId]))[0];
  await q(`insert into training_load.session_feedback (athlete_id, plan_session_id, logical_session_id, session_date, plan_name, plan_week_start, rpe, duration_minutes)
           values ($1,$2,$3,$4,$5,$6,6,60)`, [athleteId, sessionId, s.logical_session_id, s.date, s.name, s.week_start]);
}
async function weekPlans(athleteId) {
  return q(`select p.id, p.week_start::text as week_start, p.status, p.builder_batch_id, p.created_by_user_id
            from plans.plans p where p.athlete_id = $1 and p.plan_type = 'weekly' and not p.is_edit_draft order by p.week_start`, [athleteId]);
}
async function planSessions(planId) {
  return q(`select ps.id, ps.name, ps.session_order, ps.logical_session_id, pd.date::text as date
            from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 order by pd.date, ps.session_order, ps.name`, [planId]);
}
const assign = (cookie, templateId, body) => api(`/api/builder/plans/${templateId}/assign-weekly`, { method: "POST", cookie, body: { assignmentRequestId: crypto.randomUUID(), ...body } });

before(async () => {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "support/legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  db = await createDisposableDatabase({ prefix: "builder", label: "weeklysave", baseDatabaseUrl: BASE_URL });
  await bootstrapLegacySnapshot({ databaseUrl: db.url, snapshotSql, migrationsRoot: MIGRATIONS, lastMigration: last });
  await runMigrations({ databaseUrl: db.url, migrationsRoot: MIGRATIONS });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the disposable database");
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  builderModule = await import("../src/routes/builder.js");
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

test("1. save as template from chosen, non-consecutive weeks: content only, in date order", async () => {
  const s = await squad("save", 1);
  const cookie = s.coach.cookie;
  const athlete = s.athletes[0];
  const late = await publishedWeek(s, athlete, "2027-01-18", [[5, "Late Friday"]]);
  const early = await publishedWeek(s, athlete, "2027-01-04", [[1, "Early Monday"], [3, "Early Wednesday"]]);
  await publishedWeek(s, athlete, "2027-01-11", [[2, "Not chosen"]]);
  const rated = (await planSessions(early)).find((x) => x.name === "Early Monday");
  await rpeRow(athlete.athleteId, rated.id);
  const draft = ok(await api("/api/builder/weekly-templates", { method: "POST", cookie, body: { name: "From weeks", planIds: [late, early] } }), 201);
  assert.equal(draft.plan.templateKind, "weekly");
  assert.equal(draft.plan.isTemplate, true);
  assert.equal(draft.plan.status, "draft");
  assert.equal(draft.plan.weekCount, 2);
  assert.deepEqual(sessionsOf(draft).map((x) => [x.blockIndex, x.name]).sort((a, b) => a[0] - b[0]), [[1, "Early Monday"], [3, "Early Wednesday"], [12, "Late Friday"]]);
  assert.equal(sessionsOf(draft).find((x) => x.name === "Early Monday").nodes.flatMap((n) => n.items).length, 1);
  // No logical id carried, no result row on the template's sessions.
  const carried = await q(`select count(*)::int as n from plans.plan_sessions t join plans.plan_days d on d.id = t.plan_day_id
    where d.plan_id = $1 and t.logical_session_id in (select logical_session_id from plans.plan_sessions where id <> t.id)`, [draft.plan.id]);
  assert.equal(carried[0].n, 0);
  const results = await q(`select count(*)::int as n from training_load.session_feedback f join plans.plan_sessions t on t.logical_session_id = f.logical_session_id join plans.plan_days d on d.id = t.plan_day_id where d.plan_id = $1`, [draft.plan.id]);
  assert.equal(results[0].n, 0);
  // A plan the coach cannot open is the same 404 as a missing one.
  const outsider = await squad("save-out", 0);
  assert.equal((await api("/api/builder/weekly-templates", { method: "POST", cookie: outsider.coach.cookie, body: { name: "Steal", planIds: [early] } })).status, 404);
  assert.equal((await api("/api/builder/weekly-templates", { method: "POST", cookie, body: { name: "Missing", planIds: [crypto.randomUUID()] } })).status, 404);
});

test("2. a chosen week removed after the rights check: 404, no template", async () => {
  const s = await squad("savegone", 1);
  const cookie = s.coach.cookie;
  const athlete = s.athletes[0];
  // Save as template: a chosen week removed after the rights check -> 404, no template.
  const keep = await publishedWeek(s, athlete, "2027-05-03", [[1, "Keep"]]);
  const gone = await publishedWeek(s, athlete, "2027-05-10", [[1, "Gone"]]);
  builderModule.weeklySaveTestHooks.afterRights = async () => { await q(`delete from plans.plans where id = $1`, [gone]); };
  try {
    const res = await api("/api/builder/weekly-templates", { method: "POST", cookie, body: { name: "Raced template", planIds: [keep, gone] } });
    assert.equal(res.status, 404, res.text);
  } finally {
    builderModule.weeklySaveTestHooks.afterRights = null;
  }
  assert.equal((await q(`select count(*)::int as n from plans.plans where name = 'Raced template'`))[0].n, 0);
});

test("3. a week with two sessions in one slot ordered NULL and 1 (legacy) is saved, both sessions kept", async () => {
  const s = await squad("legacyorder", 1);
  const cookie = s.coach.cookie;
  const athlete = s.athletes[0];
  const weekId = await publishedWeek(s, athlete, "2027-06-07", [[1, "Ordered"]]);
  await q(`insert into plans.plan_sessions (plan_day_id, bta, session_order, name) select id, 'T', null, 'Unordered' from plans.plan_days where plan_id = $1 and date = '2027-06-07'`, [weekId]);
  const draft = ok(await api("/api/builder/weekly-templates", { method: "POST", cookie, body: { name: "Legacy order", planIds: [weekId] } }), 201);
  assert.deepEqual(sessionsOf(draft).map((x) => x.name).sort(), ["Ordered", "Unordered"]);
});

// ---- Nezavisni revizor (3) on 561a199: MEDIUM-1, LOW-2.

test("4. a week holding an exercise the coach may no longer use: refused after the copy, no template stays", async () => {
  const s = await squad("saverevoked", 1);
  const cookie = s.coach.cookie;
  const athlete = s.athletes[0];
  const weekId = await publishedWeek(s, athlete, "2028-02-07", [[1, "Revoked"]]);
  const exerciseId = (await q(`select pi.exercise_id from plans.plan_items pi join plans.plan_sessions ps on ps.id = pi.plan_session_id join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 limit 1`, [weekId]))[0].exercise_id;
  await q(`update library.exercises set is_active = false where id = $1`, [exerciseId]);
  const res = await api("/api/builder/weekly-templates", { method: "POST", cookie, body: { name: "Revoked template", planIds: [weekId] } });
  assert.equal(res.status, 409, res.text);
  assert.equal((await q(`select count(*)::int as n from plans.plans where name = 'Revoked template'`))[0].n, 0);
});

test("5. 1 to 52 weeks: none or 53 is a 400 before anything is read", async () => {
  const s = await squad("savelimit", 0);
  const ids = Array.from({ length: 53 }, () => crypto.randomUUID());
  for (const planIds of [[], ids]) {
    const res = await api("/api/builder/weekly-templates", { method: "POST", cookie: s.coach.cookie, body: { name: "Too many", planIds } });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.code, "weeks");
  }
  // 52 unknown ids pass the count check and are the 404 of a missing week.
  const res52 = await api("/api/builder/weekly-templates", { method: "POST", cookie: s.coach.cookie, body: { name: "Fifty-two", planIds: ids.slice(0, 52) } });
  assert.equal(res52.status, 404, res52.text);
});
