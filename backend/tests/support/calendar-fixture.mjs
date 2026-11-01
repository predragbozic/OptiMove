// The central calendar suites' shared fixture (K2b-1 onwards; plan:
// docs/ai/central-calendar-k2b-plan.md, section 12). The K1a / K2a suites keep
// their own copies of these helpers; new calendar suites import them from here.
//
// One disposable database (optimove_tests_gpexe_<label>_*) through the real
// runner: the GPEXE legacy scaffold, the Tests v42 files (test schedules), the
// training_load / training / calendar files, plus v6 / v8 — sorted, as the K2a
// suites apply them. The real Express app is driven over HTTP with real session
// cookies. Nothing touches OPTIMOVE or any persistent database: the app pool is
// asserted to be on the disposable database before the first request.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import pg from "pg";
import { createGpexeDisposableDb, GPEXE_TEST_MIGRATIONS } from "../_gpexe-disposable-db.mjs";

export const CALENDAR_TESTS_MIGRATIONS = Object.freeze([
  "202608220900_tests_v42_schema.sql",
  "202608221000_tests_v42_seed_wellness_fms.sql",
  "202608240900_tests_v42_phase1_scheduling_execution.sql",
  "202608250900_tests_v42_presentation_metadata.sql",
  "202608250901_tests_v42_supersede_generated_column_fix.sql",
  "202608260900_tests_v42_occurrence_generation_lock_fix.sql",
  "202608300900_tests_v42_phase4_assignment_timezone_window.sql",
]);
export const CALENDAR_EXTRA_TRAINING_LOAD_MIGRATIONS = Object.freeze([
  "202609011200_training_load_v6_external_schedule_event_type.sql",
  "202609030900_training_load_v8_specific_dates_group.sql",
]);

// Every migration a calendar suite applies, sorted; `upTo` (a file name) stops
// the list there, so a suite that rehearses a rollback never has a later
// migration between its rehearsal and its checks.
export function calendarMigrations({ upTo = null } = {}) {
  const all = [...CALENDAR_TESTS_MIGRATIONS, ...GPEXE_TEST_MIGRATIONS, ...CALENDAR_EXTRA_TRAINING_LOAD_MIGRATIONS].sort();
  return upTo ? all.filter((m) => m <= upTo) : all;
}

export const uid = () => crypto.randomBytes(4).toString("hex");
export const newKey = () => crypto.randomUUID();

export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Starts the database and the app. `env.stop()` closes the server and the
// pools and drops the database; call it from after().
export async function startCalendarApp({ label, migrations = calendarMigrations() }) {
  const baseDatabaseUrl = process.env.DATABASE_URL;
  if (!baseDatabaseUrl) throw new Error("DATABASE_URL must be set (see backend/.env.example) to run this test.");
  const db = await createGpexeDisposableDb({ baseDatabaseUrl, label, migrations });
  const admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  assert.equal((await admin.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: unexpected database");
  // The scaffold's public.clubs carries only the columns the calendar reads;
  // POST /api/organization/clubs writes the real table's columns.
  await admin.query(`alter table public.clubs
    add column if not exists short_name text, add column if not exists logo_url text, add column if not exists city text,
    add column if not exists country text, add column if not exists updated_at timestamptz not null default now()`);
  await admin.query(`alter table plans.plans add column if not exists builder_batch_id uuid`);

  process.env.DATABASE_URL = db.url;
  const serverModule = await import("../../src/server.js");
  const { createSession } = await import("../../src/auth.js");
  const { pool: appPool } = await import("../../src/db.js");
  assert.equal((await appPool.query("select current_database() as db")).rows[0].db, db.name, "SAFETY: the app pool is on the disposable database");
  const server = http.createServer(serverModule.app);
  await new Promise((resolve) => server.listen(0, resolve));
  const apiBase = `http://localhost:${server.address().port}`;

  async function q(sql, params = []) {
    return (await admin.query(sql, params)).rows;
  }
  async function api(pathname, { method = "GET", body, cookie } = {}) {
    const res = await fetch(`${apiBase}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch { parsed = {}; }
    return { status: res.status, body: parsed, text, cacheControl: res.headers.get("cache-control") };
  }
  async function stop() {
    await new Promise((resolve) => server.close(resolve));
    await appPool.end().catch(() => {});
    await admin.end().catch(() => {});
    await db.drop();
  }
  const env = { db, admin, q, api, appPool, createSession, stop };
  env.fx = calendarFixtures(env);
  return env;
}

// The builders (the K2a suites' helpers, unchanged in meaning).
export function calendarFixtures({ q, createSession }) {
  async function makeUser(label) {
    return (await q(`insert into public.users (email, full_name, display_name) values ($1,$2,$2) returning id`, [`${label.replace(/\s+/g, "-")}-${uid()}@test.local`, label]))[0].id;
  }
  async function setWorkspace(userId, type, scopeId) {
    await q(
      `insert into public.user_workspace_preferences (user_id, workspace_type, scope_id) values ($1,$2,$3)
       on conflict (user_id) do update set workspace_type = excluded.workspace_type, scope_id = excluded.scope_id`,
      [userId, type, scopeId],
    );
  }
  async function withCookie(id) {
    return { id, cookie: `optimove_session=${await createSession(id)}` };
  }
  async function makeClub(label = "Club") {
    const id = (await q(`insert into public.clubs (name) values ($1) returning id`, [`${label} ${uid()}`]))[0].id;
    await q(`select calendar.seed_club_event_types($1)`, [id]);
    return id;
  }
  async function makeTeam(clubId, label = "Team") {
    return (await q(`insert into public.teams (club_id, name) values ($1,$2) returning id`, [clubId, `${label} ${uid()}`]))[0].id;
  }
  async function grantClubAdmin(userId, clubId) {
    await q(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [userId, clubId]);
  }
  async function clubAdminOf(clubId, label = "club admin") {
    const id = await makeUser(label);
    await grantClubAdmin(id, clubId);
    await setWorkspace(id, "club", clubId);
    return withCookie(id);
  }
  async function coachOf(teamId, label = "coach") {
    const id = await makeUser(label);
    await q(`insert into public.user_team_roles (user_id, team_id, role, is_active) values ($1,$2,'team_coach',true)`, [id, teamId]);
    await setWorkspace(id, "team", teamId);
    return withCookie(id);
  }
  // A club workspace is offered only for a club the account administers
  // (loadAvailableWorkspaces, backend/src/workspace.js): a platform admin
  // in a club's workspace therefore also holds that club's club_admin role,
  // and writes there on the club_admin basis (eventWriteBasis).
  async function platformAdmin(label = "platform admin", { clubId = null } = {}) {
    const id = await makeUser(label);
    await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'platform_admin',true)`, [id]);
    if (clubId) await grantClubAdmin(id, clubId);
    await setWorkspace(id, clubId ? "club" : "platform", clubId);
    return withCookie(id);
  }
  async function privateCoach(label = "private coach") {
    const id = await makeUser(label);
    await q(`insert into public.user_global_roles (user_id, role, is_active) values ($1,'independent_coach',true)`, [id]);
    await setWorkspace(id, "private_coach", null);
    return withCookie(id);
  }
  async function addMembership({ athleteId, clubId, teamId = null, type = teamId ? "team" : "club", startsAt = "2026-01-01T00:00:00Z" }) {
    return (await q(
      `insert into public.athlete_memberships (athlete_id, club_id, team_id, membership_type, status, starts_at) values ($1,$2,$3,$4,'active',$5) returning id`,
      [athleteId, clubId, teamId, type, startsAt],
    ))[0].id;
  }
  async function makeAthlete(name, { clubId = null, teamId = null, tz = "UTC" } = {}) {
    const userId = await makeUser(name);
    const athleteId = (await q(`insert into public.athletes (user_id, full_name, display_name, device_timezone) values ($1,$2,$2,$3) returning id`, [userId, name, tz]))[0].id;
    if (clubId) await addMembership({ athleteId, clubId, type: "club" });
    if (clubId && teamId) await addMembership({ athleteId, clubId, teamId });
    await setWorkspace(userId, "athlete", null);
    return { name, userId, athleteId, ...(await withCookie(userId)) };
  }
  async function coachAthlete(coachUserId, athleteId) {
    await q(`insert into public.user_athletes (user_id, athlete_id) values ($1, $2)`, [coachUserId, athleteId]);
  }
  return {
    makeUser, setWorkspace, withCookie, makeClub, makeTeam, grantClubAdmin, clubAdminOf, coachOf, platformAdmin, privateCoach,
    addMembership, makeAthlete, coachAthlete,
  };
}

// The roles of the K2b-1 black-box scenarios (plan section 12), on two clubs:
//   c1 with teams t1 and t2, c2 with team u1; c3 archived (its admin still
//   holds the role); one archived team of c1 (t3).
//   clubAdmin      the admin of c1, workspace c1
//   twoClubAdmin   the admin of c1 AND c2, workspace c1
//   teamCoach      the coach of t1, workspace t1
//   privateCoach   an independent coach with one athlete of their own
//   athlete        a member of c1 / t1, athlete workspace
//   platformAdmin  workspace platform; platformInClub: a platform admin who
//                  also administers c1, workspace c1 (the only way a platform
//                  admin reaches a club's workspace)
//   stranger       the admin of c2, workspace c2
//   revokedAdmin   a former admin of c1 (the role row inactive), workspace c1
//   archivedAdmin  the admin of the archived club c3, workspace c3
export async function calendarRoleMatrix({ q, fx }, label = "k2b") {
  const c1 = await fx.makeClub(`${label} C1`);
  const c2 = await fx.makeClub(`${label} C2`);
  const c3 = await fx.makeClub(`${label} C3`);
  const t1 = await fx.makeTeam(c1, `${label} T1`);
  const t2 = await fx.makeTeam(c1, `${label} T2`);
  const t3 = await fx.makeTeam(c1, `${label} T3`);
  const u1 = await fx.makeTeam(c2, `${label} U1`);

  const clubAdmin = await fx.clubAdminOf(c1, `${label} admin C1`);
  const twoClubAdmin = await fx.clubAdminOf(c1, `${label} admin C1+C2`);
  await fx.grantClubAdmin(twoClubAdmin.id, c2);
  const teamCoach = await fx.coachOf(t1, `${label} coach T1`);
  const privateCoach = await fx.privateCoach(`${label} private coach`);
  const ownAthlete = await fx.makeAthlete(`${label} own athlete`);
  await fx.coachAthlete(privateCoach.id, ownAthlete.athleteId);
  const athlete = await fx.makeAthlete(`${label} athlete T1`, { clubId: c1, teamId: t1 });
  const athleteU1 = await fx.makeAthlete(`${label} athlete U1`, { clubId: c2, teamId: u1 });
  const platformAdmin = await fx.platformAdmin(`${label} platform admin`);
  const platformInClub = await fx.platformAdmin(`${label} platform admin in C1`, { clubId: c1 });
  const stranger = await fx.clubAdminOf(c2, `${label} admin C2`);
  const revokedAdmin = await fx.clubAdminOf(c1, `${label} revoked admin C1`);
  await q(`update public.user_club_roles set is_active = false where user_id = $1`, [revokedAdmin.id]);
  const archivedAdmin = await fx.clubAdminOf(c3, `${label} admin C3`);

  await q(`update public.teams set is_active = false where id = $1`, [t3]);
  await q(`update public.clubs set is_active = false where id = $1`, [c3]);

  return {
    clubs: { c1, c2, c3 }, teams: { t1, t2, t3, u1 },
    roles: { clubAdmin, twoClubAdmin, teamCoach, privateCoach, athlete, platformAdmin, platformInClub, stranger, revokedAdmin, archivedAdmin },
    athletes: { athlete, athleteU1, ownAthlete },
  };
}
