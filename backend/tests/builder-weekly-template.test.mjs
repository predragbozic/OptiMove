// Weekly program templates, part WT-A (docs/ai/weekly-program-template-plan.md):
// the template by whole weeks and the library mark.
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
  db = await createDisposableDatabase({ prefix: "builder", label: "weeklytpl", baseDatabaseUrl: BASE_URL });
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

test("1. a weekly template changes by whole weeks: create, add, duplicate, move, delete; block routes refused", async () => {
  const s = await squad("weeks", 0);
  const cookie = s.coach.cookie;
  let draft = await weeklyTemplate(cookie, 2);
  assert.equal(draft.plan.templateKind, "weekly");
  assert.equal(draft.plan.weekCount, 2);
  assert.equal(draft.blocks.length, 14);
  assert.deepEqual(draft.blocks.map((b) => b.index), Array.from({ length: 14 }, (_, i) => i + 1));
  assert.equal(blockOf(draft, 2, 3).name, "Week 2 - Day 3");
  const planId = draft.plan.id;

  // The block-shape routes keep it whole weeks.
  assert.equal((await api(`/api/builder/plans/${planId}/blocks`, { method: "POST", cookie, body: { name: "Extra" } })).body.code, "weekly_template_weeks_only");
  assert.equal((await api(`/api/builder/blocks/${draft.blocks[0].id}`, { method: "DELETE", cookie })).body.code, "weekly_template_weeks_only");
  assert.equal((await api(`/api/builder/blocks/${draft.blocks[0].id}/copy`, { method: "POST", cookie })).body.code, "weekly_template_weeks_only");

  draft = await addSession(cookie, blockOf(draft, 1, 2).id, "W1 Tuesday");
  draft = await addSession(cookie, blockOf(draft, 2, 5).id, "W2 Friday");
  // Duplicate week 1 -> week 3, with its content and fresh logical ids.
  draft = ok(await api(`/api/builder/plans/${planId}/weeks`, { method: "POST", cookie, body: { copyFrom: 1 } }), 201);
  assert.equal(draft.plan.weekCount, 3);
  const copied = sessionsOf(draft).filter((x) => x.name === "W1 Tuesday");
  assert.deepEqual(copied.map((x) => x.blockIndex).sort((a, b) => a - b), [2, 16]);
  assert.equal(copied.find((x) => x.blockIndex === 16).nodes.flatMap((n) => n.items).length, 1);
  const logical = await q(`select count(distinct ps.logical_session_id)::int as n from plans.plan_sessions ps join plans.plan_days pd on pd.id = ps.plan_day_id where pd.plan_id = $1 and ps.name = 'W1 Tuesday'`, [planId]);
  assert.equal(logical[0].n, 2);
  // An empty week.
  draft = ok(await api(`/api/builder/plans/${planId}/weeks`, { method: "POST", cookie, body: {} }), 201);
  assert.equal(draft.plan.weekCount, 4);
  // Move week 2 to the front: its Friday is now block 5, week 1's Tuesday block 9.
  draft = ok(await api(`/api/builder/plans/${planId}/weeks/2/move`, { method: "POST", cookie, body: { to: 1 } }));
  assert.equal(sessionsOf(draft).find((x) => x.name === "W2 Friday").blockIndex, 5);
  assert.deepEqual(sessionsOf(draft).filter((x) => x.name === "W1 Tuesday").map((x) => x.blockIndex).sort((a, b) => a - b), [9, 16]);
  assert.equal(blockOf(draft, 1, 5).name, "Week 1 - Day 5");
  assert.deepEqual(draft.blocks.map((b) => b.index), Array.from({ length: 28 }, (_, i) => i + 1));
  // Delete week 1 (the moved one): the rest move up.
  draft = ok(await api(`/api/builder/plans/${planId}/weeks/1`, { method: "DELETE", cookie }));
  assert.equal(draft.plan.weekCount, 3);
  assert.equal(sessionsOf(draft).some((x) => x.name === "W2 Friday"), false);
  assert.deepEqual(sessionsOf(draft).filter((x) => x.name === "W1 Tuesday").map((x) => x.blockIndex).sort((a, b) => a - b), [2, 9]);
  assert.equal((await api(`/api/builder/plans/${planId}/weeks/9/move`, { method: "POST", cookie, body: { to: 1 } })).body.code, "week_not_found");
  // Never the last week; a block template is not a weekly one.
  const one = await weeklyTemplate(cookie, 1);
  assert.equal((await api(`/api/builder/plans/${one.plan.id}/weeks/1`, { method: "DELETE", cookie })).body.code, "weekly_template_last_week");
  const blocks = ok(await api("/api/builder/plans", { method: "POST", cookie, body: { planType: "program", name: "Blocks" } }), 201);
  assert.equal(blocks.plan.templateKind, "blocks");
  assert.equal((await api(`/api/builder/plans/${blocks.plan.id}/weeks`, { method: "POST", cookie, body: {} })).body.code, "not_weekly_template");
  // Another coach cannot touch it: the same 404 as a missing plan.
  const other = await coachOf("weeks-other", s.teamId);
  const res = await api(`/api/builder/plans/${planId}/weeks`, { method: "POST", cookie: other.cookie, body: {} });
  assert.equal(res.status, 404);
});

test("2. the library marks weekly templates and filters by kind", async () => {
  const s = await squad("library", 0);
  const weekly = await weeklyTemplate(s.coach.cookie, 3, `Weekly ${uid()}`);
  const blocks = ok(await api("/api/builder/plans", { method: "POST", cookie: s.coach.cookie, body: { planType: "program", name: `Blocks ${uid()}` } }), 201);
  ok(await api(`/api/builder/plans/${blocks.plan.id}/blocks`, { method: "POST", cookie: s.coach.cookie, body: { name: "Block 1" } }), 201);
  const all = ok(await api("/api/templates?scope=all", { cookie: s.coach.cookie })).templates;
  const w = all.find((t) => t.plan_id === weekly.plan.id);
  const b = all.find((t) => t.plan_id === blocks.plan.id);
  assert.equal(w.template_kind, "weekly");
  assert.equal(w.week_count, 3);
  assert.equal(b.template_kind, "blocks");
  assert.equal(b.week_count, 0);
  const onlyWeekly = ok(await api("/api/templates?scope=all&kind=weekly", { cookie: s.coach.cookie })).templates;
  assert.ok(onlyWeekly.some((t) => t.plan_id === weekly.plan.id));
  assert.ok(!onlyWeekly.some((t) => t.plan_id === blocks.plan.id));
  const onlyBlocks = ok(await api("/api/templates?scope=all&kind=blocks", { cookie: s.coach.cookie })).templates;
  assert.ok(onlyBlocks.some((t) => t.plan_id === blocks.plan.id));
  assert.ok(!onlyBlocks.some((t) => t.plan_id === weekly.plan.id));
});
