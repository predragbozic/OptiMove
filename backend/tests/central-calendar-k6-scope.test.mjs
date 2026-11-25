// K6 (docs/ai/central-calendar-k6-contract.md 5.2, H1-H5): the reads the calendar's team and athlete switcher
// relies on, pinned through the real routes on ONE disposable database. K6 adds no route: these tests pin what the
// switcher may show. A club C with teams A and B; a1 in A, b1 in B, x1 in A AND in another club's team E; d1 only in E.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "./_gpexe-disposable-db.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;

const TESTS_MIGRATIONS = [
  "202608220900_tests_v42_schema.sql",
  "202608221000_tests_v42_seed_wellness_fms.sql",
  "202608240900_tests_v42_phase1_scheduling_execution.sql",
  "202608250900_tests_v42_presentation_metadata.sql",
  "202608250901_tests_v42_supersede_generated_column_fix.sql",
  "202608260900_tests_v42_occurrence_generation_lock_fix.sql",
  "202608300900_tests_v42_phase4_assignment_timezone_window.sql",
];
const EXTRA_TRAINING_LOAD_MIGRATIONS = [
  "202609011200_training_load_v6_external_schedule_event_type.sql",
  "202609030900_training_load_v8_specific_dates_group.sql",
];
const MIGRATIONS = [...TESTS_MIGRATIONS, ...GPEXE_TEST_MIGRATIONS, ...EXTRA_TRAINING_LOAD_MIGRATIONS].sort();

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const TODAY = new Date().toISOString().slice(0, 10);
const PAST = addDays(TODAY, -2);
const FROM = addDays(TODAY, -7);
const TO = addDays(TODAY, 7);

let db;
let admin;
let server;
let apiBase;
let appPool;
let createSession;
let W;

const uid = () => crypto.randomBytes(4).toString("hex");
const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
const makeClub = async (label) => (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} ${uid()}`]))[0].id;
const makeTeam = async (clubId, label) => (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} ${uid()}`]))[0].id;
const makeUser = async (label) => (await q(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label}-${uid()}@test.local`, label]))[0].id;
async function setWorkspace(userId, type, scopeId) {
  await q(
    `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
     on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
    [userId, type, scopeId],
  );
}
const withCookie = async (id) => ({ id, cookie: `optimove_session=${await createSession(id)}` });
async function coachOf(teamId, label) {
  const id = await makeUser(label);
  await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
  await setWorkspace(id, "team", teamId);
  return withCookie(id);
}
async function clubAdminOf(clubId, label) {
  const id = await makeUser(label);
  await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [id, clubId]);
  await setWorkspace(id, "club", clubId);
  return withCookie(id);
}
async function platformAdmin(label) {
  const id = await makeUser(label);
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
  await setWorkspace(id, "platform", null);
  return withCookie(id);
}
async function privateCoach(label) {
  const id = await makeUser(label);
  await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [id]);
  await setWorkspace(id, "private_coach", null);
  return withCookie(id);
}
async function addMembership({ athleteId, clubId, teamId = null }) {
  await q(
    `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,$4,'active','2026-01-01T00:00:00Z')`,
    [athleteId, clubId, teamId, teamId ? "team" : "club"],
  );
}
async function makeAthlete(name) {
  const userId = await makeUser(name);
  const athleteId = (await q(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,'UTC') returning id`, [userId, name]))[0].id;
  await setWorkspace(userId, "athlete", null);
  return { name, userId, athleteId };
}
async function makePlanSession({ athleteId, coachUserId, teamId, sessionName }) {
  const planId = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, week_start, is_active, is_edit_draft, builder_batch_id)
     values ('weekly',$1,$2,'Week','active',$3,true,false,$4) returning id`,
    [coachUserId, athleteId, FROM, crypto.randomUUID()],
  ))[0].id;
  await q(
    `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_user_id, owner_club_id, owner_team_id) values ($1,'team',null,null,$2)`,
    [planId, teamId],
  );
  const dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [planId, PAST]))[0].id;
  await q(
    `insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order, session_time, rpe_enabled, training_load_enabled, logical_session_id)
     values ($1,$2,'PM','T',1,'18:00',false,false,$3)`,
    [dayId, sessionName, crypto.randomUUID()],
  );
}
async function api(pathname, cookie) {
  const res = await fetch(`${apiBase}${pathname}`, { headers: cookie ? { Cookie: cookie } : {} });
  let body = {};
  try { body = JSON.parse(await res.text()); } catch { body = {}; }
  return { status: res.status, body };
}
const calendar = (cookie, extra = "") => api(`/api/calendar?from=${FROM}&to=${TO}${extra}`, cookie);
const cards = (res) => (res.body.days || []).flatMap((day) => day.items);
const roster = async (cookie) => {
  const res = await api("/api/admin/athletes", cookie);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.adminRows || [];
};
const titles = (res) => cards(res).map((card) => card.title);

before(async () => {
  db = await createGpexeDisposableDb({ baseDatabaseUrl: ORIGINAL_DATABASE_URL, label: "calendar_k6", roleRead: true, migrations: MIGRATIONS });
  admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  await admin.query(`alter table plans.plans add column if not exists builder_batch_id uuid`);
  // The legacy view the roster route reads (the scaffold's is a stub without the athlete column).
  await admin.query(`create or replace view plans.v_plan_summary as select p.*, p.id as plan_id, p.athlete_id as athlete_uuid, false as is_template from plans.plans p`);
  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../src/server.js");
  ({ createSession } = await import("../src/auth.js"));
  ({ pool: appPool } = await import("../src/db.js"));
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is on the disposable database");
  server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  apiBase = `http://localhost:${server.address().port}`;

  const clubC = await makeClub("Club C");
  const clubD = await makeClub("Club D");
  const teamA = await makeTeam(clubC, "A");
  const teamB = await makeTeam(clubC, "B");
  const teamE = await makeTeam(clubD, "E");
  const coachA = await coachOf(teamA, "coach A");
  const coachE = await coachOf(teamE, "coach E");
  const a1 = await makeAthlete("K6 a1");
  const b1 = await makeAthlete("K6 b1");
  const x1 = await makeAthlete("K6 x1");
  const d1 = await makeAthlete("K6 d1");
  for (const [athlete, club, teams] of [[a1, clubC, [teamA]], [b1, clubC, [teamB]], [x1, clubC, [teamA]], [d1, clubD, [teamE]]]) {
    await addMembership({ athleteId: athlete.athleteId, clubId: club });
    for (const team of teams) await addMembership({ athleteId: athlete.athleteId, clubId: club, teamId: team });
  }
  // x1 also trains with the other club's team.
  await addMembership({ athleteId: x1.athleteId, clubId: clubD });
  await addMembership({ athleteId: x1.athleteId, clubId: clubD, teamId: teamE });
  await makePlanSession({ athleteId: a1.athleteId, coachUserId: coachA.id, teamId: teamA, sessionName: "A session" });
  await makePlanSession({ athleteId: x1.athleteId, coachUserId: coachA.id, teamId: teamA, sessionName: "A session x1" });
  await makePlanSession({ athleteId: x1.athleteId, coachUserId: coachE.id, teamId: teamE, sessionName: "E session x1" });
  await makePlanSession({ athleteId: b1.athleteId, coachUserId: coachA.id, teamId: teamB, sessionName: "B session" });
  await makePlanSession({ athleteId: d1.athleteId, coachUserId: coachE.id, teamId: teamE, sessionName: "E session d1" });
  const pc = await privateCoach("K6 private coach");
  await q(`insert into public.user_athletes (user_id, athlete_id, relationship_type, is_active) values ($1,$2,'coach',true)`, [pc.id, a1.athleteId]);
  W = {
    teamA, teamB, teamE, a1, b1, x1, d1,
    coachA: coachA.cookie, clubAdmin: (await clubAdminOf(clubC, "club admin C")).cookie,
    platform: (await platformAdmin("K6 platform")).cookie, privateCoach: pc.cookie,
  };
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (appPool) await appPool.end();
  if (admin) await admin.end();
  if (db) await db.drop();
  process.env.DATABASE_URL = ORIGINAL_DATABASE_URL;
});

const uuids = (rows) => rows.map((row) => row.athlete_uuid).sort();

test("H1. a team coach of A: the roster lists a1 and x1 and not b1; another team's athlete leaves no card, with or without teamIds", async () => {
  assert.deepEqual(uuids(await roster(W.coachA)), [W.a1.athleteId, W.x1.athleteId].sort());
  const forB = await calendar(W.coachA, `&athleteIds=${W.b1.athleteId}`);
  assert.equal(forB.status, 200);
  assert.deepEqual(cards(forB), [], "no card of b1");
  const widened = await calendar(W.coachA, `&athleteIds=${W.b1.athleteId}&teamIds=${W.teamB}`);
  assert.equal(titles(widened).some((title) => /B session/.test(String(title))), false, "teamIds does not widen the scope");
  const unfiltered = await calendar(W.coachA);
  assert.equal(titles(unfiltered).some((title) => /B session|E session d1/.test(String(title))), false, "the unfiltered read has none of them either");
});

test("H2. a club admin: the roster lists a1, b1 and x1 and not the other club's athlete; the other club's id returns nothing", async () => {
  assert.deepEqual(uuids(await roster(W.clubAdmin)), [W.a1.athleteId, W.b1.athleteId, W.x1.athleteId].sort());
  assert.deepEqual(cards(await calendar(W.clubAdmin, `&athleteIds=${W.d1.athleteId}`)), []);
});

test("H3. a private coach: only their own relationship's athletes", async () => {
  assert.deepEqual(uuids(await roster(W.privateCoach)), [W.a1.athleteId]);
});

test("H4. the platform workspace: the roster has no rows (so the switcher draws no strip there)", async () => {
  assert.deepEqual(await roster(W.platform), []);
});

// H5: for any viewer, the athlete read is a subset of the unfiltered read of the same range.
for (const [label, cookieOf] of [["the team coach of A", () => W.coachA], ["the club admin", () => W.clubAdmin]]) {
  test(`H5. ${label}: athleteIds=x1 is a subset of the unfiltered read - same keys, titles, rights; no larger teams or counts`, async () => {
    const all = await calendar(cookieOf());
    const own = await calendar(cookieOf(), `&athleteIds=${W.x1.athleteId}`);
    assert.equal(own.status, 200);
    assert.ok(cards(own).length > 0, "x1 has cards in this scope");
    const byKey = new Map(cards(all).map((card) => [card.key, card]));
    // The other club's session that targets x1 (x1 trains there too): in both reads or in neither, never in one only.
    const foreign = (res) => cards(res).some((card) => /E session x1/.test(String(card.title)));
    assert.equal(foreign(own), foreign(all), "an item of another club that targets x1 is in both reads or in neither");
    for (const card of cards(own)) {
      const wide = byKey.get(card.key);
      assert.ok(wide, `the card ${card.key} is in the unfiltered read too`);
      assert.equal(card.title, wide.title);
      assert.equal(card.canManage, wide.canManage);
      for (const teamId of card.teamIds || []) assert.ok((wide.teamIds || []).includes(teamId), "teams are a subset");
      assert.ok((card.athleteCount ?? 0) <= (wide.athleteCount ?? 0), "the athlete's own numbers are never larger");
    }
  });
}
