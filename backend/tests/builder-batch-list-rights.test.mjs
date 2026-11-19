// The Builder batch switcher lists only the members the viewer may open
// (security review of the Builder batch edit, HIGH): loadBuilderBatch filters
// by the very predicate getEditablePlan uses, and returns the rest only as
// hiddenCount, with no id, name, week or status.
//
// One disposable database (optimove_tests_builder_batchlist_*): the committed
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
const ok = (res, status = 200) => { assert.equal(res.status, status, res.text); return res; };

async function makeUser(label) {
  const [first, ...rest] = label.split(" ");
  return (await q(`insert into public.users (email, first_name, last_name, full_name, display_name) values ($1,$2,$3,$4,$4) returning id`,
    [`${label.replace(/\W+/g, ".")}-${uid()}@example.invalid`, first, rest.join(" ") || "Example", label]))[0].id;
}
async function setWorkspace(userId, type, scopeId) {
  await q(`insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
           on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`, [userId, type, scopeId]);
}
const cookieOf = async (userId) => `optimove_session=${await createSession(userId)}`;
async function makeAthlete(name, clubId, teamId) {
  const [first, last] = name.split(" ");
  const row = (await q(
    `insert into public.athletes (athlete_id, first_name, last_name, full_name, display_name, device_timezone)
     values (nextval('public.athlete_generated_id_seq')::text, $1, $2, $3, $3, 'UTC') returning id, athlete_id`, [first, last, name]))[0];
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,null,'club','active','2026-01-01T00:00:00Z')`, [row.id, clubId]);
  await q(`insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,'team','active','2026-01-01T00:00:00Z')`, [row.id, clubId, teamId]);
  return { name, athleteId: row.id, externalId: row.athlete_id };
}

// One club with two teams: the club's admin builds a weekly batch for one
// athlete of each team; each team's coach may open only its own athlete.
async function world(label) {
  const clubId = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} Club ${uid()}`]))[0].id;
  const teamA = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} Team A`]))[0].id;
  const teamB = (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} Team B`]))[0].id;
  const adminId = await makeUser(`${label} Club Admin`);
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [adminId, clubId]);
  await setWorkspace(adminId, "club", clubId);
  const coachA = await makeUser(`${label} Coach A`);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachA, teamA]);
  await setWorkspace(coachA, "team", teamA);
  const a1 = await makeAthlete(`${label}Alpha Visible`, clubId, teamA);
  const a2 = await makeAthlete(`${label}Alpha Second`, clubId, teamA);
  const b1 = await makeAthlete(`${label}Bravo Hidden`, clubId, teamB);
  const admin = await cookieOf(adminId);
  const ids = [a1.externalId, a2.externalId, b1.externalId];
  const created = ok(await api("/api/builder/plans", { method: "POST", cookie: admin, body: { planType: "weekly", weekStart: WEEK, athleteIds: ids, athleteExternalIds: ids, name: `${label} week` } }), 201);
  const plans = await q(`select p.id, p.athlete_id from plans.plans p where p.builder_batch_id = (select builder_batch_id from plans.plans where id = $1)`, [created.body.plan.id]);
  const planOf = (athlete) => plans.find((p) => String(p.athlete_id) === String(athlete.athleteId)).id;
  return { admin, coachA: await cookieOf(coachA), a1, a2, b1, planA1: planOf(a1), planA2: planOf(a2), planB1: planOf(b1), batchPlanIds: plans.map((p) => p.id) };
}

// What loadBuilderBatch returned before this change, for every member: the reference for "exactly as today".
async function unfilteredMembers(anyPlanId) {
  return (await q(
    `select p.id, p.name, p.plan_type, p.week_start, p.status,
            a.athlete_id, a.source_external_id as athlete_source_external_id,
            coalesce(a.display_name, a.full_name, concat_ws(' ', a.first_name, a.last_name), a.source_external_id, a.athlete_id::text) as athlete_name
     from plans.plans p left join public.athletes a on a.id = p.athlete_id
     where p.builder_batch_id = (select builder_batch_id from plans.plans where id = $1)
       and coalesce(p.is_active, true) and not coalesce(p.is_edit_draft, false)
     order by coalesce(a.athlete_id::text, a.source_external_id, p.name), p.created_at`, [anyPlanId]))
    .map((row) => ({ id: row.id, name: row.name || "", planType: row.plan_type, weekStart: row.week_start || "", status: row.status || "",
      athleteId: row.athlete_source_external_id || row.athlete_id || "", athleteName: row.athlete_name || "Reusable template" }));
}

function assertNothingOf(text, hidden, where) {
  for (const [what, value] of [["name", hidden.athlete.name], ["first name", hidden.athlete.name.split(" ")[0]], ["external id", `"${hidden.athlete.externalId}"`], ["plan id", hidden.planId]]) {
    assert.ok(!text.includes(value), `${where}: the hidden member's ${what} is in the answer`);
  }
}

before(async () => {
  const snapshotSql = fs.readFileSync(path.join(__dirname, "support/legacy-schema.sql"), "utf8");
  const last = snapshotSql.match(/^-- Last migration contained in the dump: (\S+)\.$/m)[1];
  db = await createDisposableDatabase({ prefix: "builder", label: "batchlist", baseDatabaseUrl: BASE_URL });
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

test("1. a coach who may open only their own team's members: the switcher lists those, the other team's member is a number only; the whole answer text holds nothing of it", async () => {
  const w = await world("rights");
  const hidden = { athlete: w.b1, planId: String(w.planB1) };
  const expectVisible = (await unfilteredMembers(w.planA1)).filter((m) => [String(w.planA1), String(w.planA2)].includes(String(m.id)));
  // The draft (GET).
  const draft = ok(await api(`/api/builder/plans/${w.planA1}`, { cookie: w.coachA }));
  assert.deepEqual(draft.body.batch.plans, expectVisible);
  assert.equal(draft.body.batch.hiddenCount, 1);
  assertNothingOf(draft.text, hidden, "GET /plans/:id");
  // A write that answers with the draft (sync-batch), and a new session.
  const sync = ok(await api(`/api/builder/plans/${w.planA1}/sync-batch`, { method: "POST", cookie: w.coachA, body: {} }));
  assertNothingOf(sync.text, hidden, "POST /sync-batch");
  const session = ok(await api(`/api/builder/blocks/${draft.body.blocks[0].id}/sessions`, { method: "POST", cookie: w.coachA, body: { bta: "T", name: "Main" } }), 201);
  assertNothingOf(session.text, hidden, "POST /blocks/:id/sessions");
  // The drafts list holds only the viewer's own plans.
  const drafts = ok(await api("/api/builder/drafts", { cookie: w.coachA }));
  assertNothingOf(drafts.text, hidden, "GET /drafts");
  // The admin gives the group content (an empty draft is deleted on Save), publishes it; the coach reopens
  // it (/edit) and saves it (/submit, full answer).
  const sessionId = session.body.blocks[0].sessions[0].id;
  ok(await api(`/api/builder/sessions/${sessionId}/nodes`, { method: "POST", cookie: w.admin, body: { nodeType: "domain", name: "Strength", syncBatch: true } }), 201);
  ok(await api(`/api/builder/plans/${w.planA1}/submit`, { method: "POST", cookie: w.admin, body: { syncBatch: true, responseMode: "summary" } }));
  const edit = ok(await api(`/api/builder/plans/${w.planA1}/edit`, { method: "POST", cookie: w.coachA }));
  assert.equal(edit.body.batch.hiddenCount, 1);
  assert.deepEqual(edit.body.batch.plans.map((p) => String(p.id)).sort(), [String(w.planA1), String(w.planA2)].sort());
  assertNothingOf(edit.text, hidden, "POST /plans/:id/edit");
  const submitted = ok(await api(`/api/builder/plans/${edit.body.plan.id}/submit`, { method: "POST", cookie: w.coachA, body: {} }));
  assertNothingOf(submitted.text, hidden, "POST /plans/:id/submit (full answer)");
  // The hidden member itself stays the same 404 for this coach.
  const foreign = await api(`/api/builder/plans/${w.planB1}`, { cookie: w.coachA });
  assert.equal(foreign.status, 404);
});

test("2. a viewer who may open every member gets exactly today's list, with hiddenCount 0", async () => {
  const w = await world("all");
  const today = await unfilteredMembers(w.planA1);
  for (const planId of [w.planA1, w.planB1]) {
    const draft = ok(await api(`/api/builder/plans/${planId}`, { cookie: w.admin }));
    assert.deepEqual(draft.body.batch.plans, today, "the same rows, fields and order as before");
    assert.equal(draft.body.batch.hiddenCount, 0);
  }
  const created = ok(await api("/api/builder/plans", { method: "POST", cookie: w.admin, body: { planType: "weekly", weekStart: "2026-11-09", athleteIds: [w.a1.externalId, w.b1.externalId], athleteExternalIds: [w.a1.externalId, w.b1.externalId] } }), 201);
  assert.deepEqual(created.body.batch.plans, await unfilteredMembers(created.body.plan.id));
  assert.equal(created.body.batch.hiddenCount, 0);
});

test("4. two coaches, the whole answer: each coach's answer equals the same answer once the other team's members are taken out of the batch, except hiddenCount (code review MEDIUM)", async () => {
  const w = await world("whole");
  const teamB = (await q(`select team_id from public.athlete_memberships where athlete_id = $1 and membership_type = 'team'`, [w.b1.athleteId]))[0].team_id;
  const coachBId = await makeUser("whole Coach B");
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [coachBId, teamB]);
  await setWorkspace(coachBId, "team", teamB);
  const coachB = await cookieOf(coachBId);
  const viewers = [
    { label: "coach A", cookie: w.coachA, own: w.planA1, others: [w.planB1], hidden: 1 },
    { label: "coach B", cookie: coachB, own: w.planB1, others: [w.planA1, w.planA2], hidden: 2 },
  ];
  for (const v of viewers) {
    const withOthers = ok(await api(`/api/builder/plans/${v.own}`, { cookie: v.cookie })).text;
    // Take the other team's plans out of the batch (as a deleted plan is), then read again.
    await q(`update plans.plans set is_active = false where id = any($1::uuid[])`, [v.others]);
    const without = ok(await api(`/api/builder/plans/${v.own}`, { cookie: v.cookie })).text;
    await q(`update plans.plans set is_active = true where id = any($1::uuid[])`, [v.others]);
    assert.ok(withOthers.includes(`"hiddenCount":${v.hidden}`), `${v.label}: ${withOthers.slice(0, 200)}`);
    assert.equal(withOthers.replace(`"hiddenCount":${v.hidden}`, `"hiddenCount":0`), without, `${v.label}: nothing but the count differs`);
  }
});

test("5. a platform admin who did not create the batch sees every member, exactly as today", async () => {
  const w = await world("platform");
  const id = await makeUser("platform Admin");
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  const draft = ok(await api(`/api/builder/plans/${w.planB1}`, { cookie: await cookieOf(id) }));
  assert.deepEqual(draft.body.batch.plans, await unfilteredMembers(w.planB1));
  assert.equal(draft.body.batch.hiddenCount, 0);
});

test("3. one source of truth: the switcher's rows are exactly the plans getEditablePlan opens for that viewer", async () => {
  const w = await world("same");
  const draft = ok(await api(`/api/builder/plans/${w.planA1}`, { cookie: w.coachA }));
  const listed = new Set(draft.body.batch.plans.map((p) => String(p.id)));
  for (const planId of w.batchPlanIds) {
    const opened = (await api(`/api/builder/plans/${planId}`, { cookie: w.coachA })).status === 200;
    assert.equal(listed.has(String(planId)), opened, `plan ${planId}: listed iff it opens`);
  }
  assert.equal(listed.size + draft.body.batch.hiddenCount, w.batchPlanIds.length);
});
