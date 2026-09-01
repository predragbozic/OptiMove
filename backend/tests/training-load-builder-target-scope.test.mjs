// Training load (RPE/sRPE) correction round 3, item 2: a Weekly plan's
// target athlete(s) must belong to the SAME workspace scope the plan is
// about to be stamped with (training_load.plan_workspace_ownership) -
// otherwise a coach sitting in one club's workspace could hand-name an
// athlete who only belongs to a DIFFERENT club, and that athlete's plan
// would end up owned by the WRONG club's own RPE settings. See routes/
// builder.js's own resolveWeeklyPlanOwnerScope/findAthleteOutsideScope
// for the actual fix.
//
// Deliberately NOT the disposable-DB harness (training-load-planned-rpe-
// master-toggle.test.mjs uses that) - POST /builder/plans and POST
// /builder/plans/:planId/duplicate need Builder's FULL real schema
// (dozens of plans.plans columns with real constraints/defaults) that
// only exists in an actual OPTIMOVE-shaped database. Runs against the
// real local OPTIMOVE database, the exact same established pattern as
// training-load-builder-edit-draft.test.mjs - every created row is
// tracked and deleted in after().
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import "dotenv/config";
import { app } from "../src/server.js";
import { query, pool } from "../src/db.js";
import { createSession, hashPassword } from "../src/auth.js";
import { runCleanupSteps } from "./_test-cleanup.mjs";

let server;
let baseUrl;
const cleanupUserIds = new Set();
const cleanupAthleteIds = new Set();
const cleanupClubIds = new Set();
const cleanupPlanIds = new Set();

before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await runCleanupSteps([
    ["plan trees", () => cleanupPlanIds.size && query(`delete from plans.plan_days where plan_id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["plans", () => cleanupPlanIds.size && query(`delete from plans.plans where id = any($1::uuid[])`, [[...cleanupPlanIds]])],
    ["athlete_memberships", () => cleanupAthleteIds.size && query(`delete from public.athlete_memberships where athlete_id = any($1::uuid[])`, [[...cleanupAthleteIds]])],
    ["athletes", () => cleanupAthleteIds.size && query(`delete from public.athletes where id = any($1::uuid[])`, [[...cleanupAthleteIds]])],
    ["user_club_roles", () => cleanupUserIds.size && query(`delete from public.user_club_roles where user_id = any($1::uuid[])`, [[...cleanupUserIds]])],
    ["clubs", () => cleanupClubIds.size && query(`delete from public.clubs where id = any($1::uuid[])`, [[...cleanupClubIds]])],
    ["users", () => cleanupUserIds.size && query(`delete from public.users where id = any($1::uuid[])`, [[...cleanupUserIds]])],
    ["server close", () => new Promise((resolve) => server.close(resolve))],
    ["pool end", () => pool.end()],
  ]);
});

async function api(path, { method = "GET", cookie, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

const STAMP = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function makeCoachWithClub(label) {
  const clubResult = await query(`insert into public.clubs (name) values ($1) returning id`, [`TL target-scope ${label} club ${STAMP()}`]);
  const clubId = clubResult.rows[0].id;
  cleanupClubIds.add(clubId);
  const userResult = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'TL', 'Coach', $2, 'TL Coach', 'TL Coach', 'club_admin', true) returning id`,
    [`tl-targetscope-coach-${label}-${STAMP()}@test.local`, hashPassword("irrelevant-password-123")],
  );
  const coachId = userResult.rows[0].id;
  cleanupUserIds.add(coachId);
  await query(`insert into public.user_club_roles (user_id, club_id, role, is_active) values ($1,$2,'club_admin',true)`, [coachId, clubId]);
  const token = await createSession(coachId);
  return { coachId, clubId, cookie: `optimove_session=${token}` };
}

async function makeAthleteInClub(clubId, label) {
  const externalId = `tlscope${label}${Math.floor(Math.random() * 900000 + 100000)}`;
  const userResult = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'TL', 'Athlete', $2, 'TL Athlete', 'TL Athlete', 'athlete', true) returning id`,
    [`tl-targetscope-athlete-${label}-${STAMP()}@test.local`, hashPassword("irrelevant-password-123")],
  );
  const userId = userResult.rows[0].id;
  cleanupUserIds.add(userId);
  const athleteResult = await query(
    `insert into public.athletes (user_id, athlete_id, source_external_id, first_name, last_name, full_name, display_name, device_timezone, is_active)
     values ($1,$2,$2,'TL','Athlete','TL Athlete','TL Athlete','UTC',true) returning id`,
    [userId, externalId],
  );
  const athleteId = athleteResult.rows[0].id;
  cleanupAthleteIds.add(athleteId);
  await query(`insert into public.athlete_memberships (athlete_id, club_id, membership_type, status) values ($1,$2,'club','active')`, [athleteId, clubId]);
  return { athleteId, externalId };
}

function isoDate(d) { return d.toISOString().slice(0, 10); }
const TODAY_DATE = new Date();
TODAY_DATE.setUTCHours(0, 0, 0, 0);
function mondayOf(dateIso) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return isoDate(d);
}
const WEEK_START = mondayOf(isoDate(TODAY_DATE));
// A different week than WEEK_START, so a "no plan was created" assertion
// can never be masked by ensureWeeklySlot's own dedupe-by-week behavior
// across two different test cases sharing the same target week.
function weekOffset(n) { const d = new Date(`${WEEK_START}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n * 7); return isoDate(d); }

async function countPlansForAthlete(athleteId) {
  const r = await query(`select count(*)::int as n from plans.plans where athlete_id = $1 and plan_type = 'weekly'`, [athleteId]);
  return r.rows[0].n;
}

test("cross-workspace create: a coach in Club A's own workspace cannot create a weekly plan for an athlete who only belongs to Club B - a controlled 403, no plan created", async () => {
  const clubA = await makeCoachWithClub("crossA");
  const clubB = await makeCoachWithClub("crossB");
  const athleteB = await makeAthleteInClub(clubB.clubId, "crossB");

  const res = await api("/api/builder/plans", {
    method: "POST",
    cookie: clubA.cookie,
    body: { planType: "weekly", weekStart: weekOffset(1), athleteIds: [athleteB.externalId] },
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);

  const planCount = await countPlansForAthlete(athleteB.athleteId);
  assert.equal(planCount, 0, "no plan may be created for an athlete outside the creating coach's own current workspace");
});

test("multi-athlete atomic rejection: one athlete outside scope in a batch rejects the WHOLE request - not even the in-scope athlete gets a plan", async () => {
  const clubA = await makeCoachWithClub("batchA");
  const clubB = await makeCoachWithClub("batchB");
  const athleteA = await makeAthleteInClub(clubA.clubId, "batchA");
  const athleteB = await makeAthleteInClub(clubB.clubId, "batchB");

  const res = await api("/api/builder/plans", {
    method: "POST",
    cookie: clubA.cookie,
    body: { planType: "weekly", weekStart: weekOffset(2), athleteIds: [athleteA.externalId, athleteB.externalId] },
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);

  const planCountA = await countPlansForAthlete(athleteA.athleteId);
  const planCountB = await countPlansForAthlete(athleteB.athleteId);
  assert.equal(planCountA, 0, "the IN-scope athlete must not get a plan either - the whole batch is atomic, never a partial create");
  assert.equal(planCountB, 0);
});

test("no-workspace 403: an account with no real coach workspace active gets a controlled 403, and the plan is never created as owner_scope='unresolved'", async () => {
  const clubA = await makeCoachWithClub("noworkspaceOwner");
  const athleteA = await makeAthleteInClub(clubA.clubId, "noworkspace");

  const plainUserResult = await query(
    `insert into public.users (email, first_name, last_name, password_hash, full_name, display_name, role_hint, is_active)
     values ($1, 'TL', 'Plain', $2, 'TL Plain', 'TL Plain', 'user', true) returning id`,
    [`tl-targetscope-plainuser-${STAMP()}@test.local`, hashPassword("irrelevant-password-123")],
  );
  const plainUserId = plainUserResult.rows[0].id;
  cleanupUserIds.add(plainUserId);
  const plainToken = await createSession(plainUserId);
  const plainCookie = `optimove_session=${plainToken}`;

  const res = await api("/api/builder/plans", {
    method: "POST",
    cookie: plainCookie,
    body: { planType: "weekly", weekStart: weekOffset(3), athleteIds: [athleteA.externalId] },
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);

  const planCount = await countPlansForAthlete(athleteA.athleteId);
  assert.equal(planCount, 0, "a weekly plan must never be created as 'unresolved' just because the requester had no real workspace active");
});

test("cross-workspace duplicate/copy: copying a weekly plan for an athlete outside the current workspace is a controlled 403, no plan created", async () => {
  const clubA = await makeCoachWithClub("dupA");
  const clubB = await makeCoachWithClub("dupB");
  const athleteAOwn = await makeAthleteInClub(clubA.clubId, "dupAown");
  const athleteB = await makeAthleteInClub(clubB.clubId, "dupB");

  // A minimal real weekly plan Coach A already owns, to duplicate from.
  const sourcePlanResult = await query(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, source_type, visibility, week_start)
     values ('weekly', $1, $2, 'TL target-scope source plan', 'active', 'builder', 'private', $3)
     returning id`,
    [clubA.coachId, athleteAOwn.athleteId, WEEK_START],
  );
  const sourcePlanId = sourcePlanResult.rows[0].id;
  cleanupPlanIds.add(sourcePlanId);

  const res = await api(`/api/builder/plans/${sourcePlanId}/duplicate`, {
    method: "POST",
    cookie: clubA.cookie,
    body: { intent: "copy", weekStart: weekOffset(4), athleteIds: [athleteB.externalId] },
  });
  assert.equal(res.status, 403, `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);

  const planCount = await countPlansForAthlete(athleteB.athleteId);
  assert.equal(planCount, 0, "no copy may be created for an athlete outside the current workspace, even via duplicate/copy rather than a fresh create");
});
