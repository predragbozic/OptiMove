// Central calendar K3, section 3.1 (docs/ai/central-calendar-k3-plan.md):
// GET /api/builder/weekly-plans?weekStart=&athleteIds= — which of an event's
// athletes already have a weekly plan of a week. The OptiMove manager's GO
// conditions: an athlete outside the workspace answers ONLY `plannable:false`,
// the same whether or not they have a plan; no id, name or author of a plan the
// caller may not open; the 200 limit and the UUID check before any query.
//
// One disposable database through the calendar fixture; the real app over
// HTTP; invented people only. Nothing touches OPTIMOVE or any persistent
// database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { addDays, calendarRoleMatrix, startCalendarApp } from "./support/calendar-fixture.mjs";

// A Monday well in the future, and a Wednesday of that week.
const MONDAY = (() => {
  const d = new Date(`${addDays(new Date().toISOString().slice(0, 10), 21)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
})();
const WEDNESDAY = addDays(MONDAY, 2);

let env;
let q;
let api;
let fx;
let m;
let weeklyPlansReadAnswer;
let WEEKLY_PLANS_READ_MAX;

before(async () => {
  env = await startCalendarApp({ label: "k3read" });
  ({ q, api, fx } = env);
  await q(`alter table plans.plans add column if not exists created_at timestamptz not null default now()`);
  await q(`alter table plans.plans add column if not exists updated_at timestamptz not null default now()`);
  // The real tables' columns the content rule reads (the fixture's stand-ins lack them).
  await q(`alter table plans.plans add column if not exists source_type text`);
  await q(`alter table plans.plan_items add column if not exists plan_session_id uuid`);
  await q(`alter table plans.plan_nodes add column if not exists plan_session_id uuid`);
  await q(`alter table plans.plan_nodes add column if not exists name text`);
  m = await calendarRoleMatrix(env, "k3r");
  ({ weeklyPlansReadAnswer, WEEKLY_PLANS_READ_MAX } = await import("../src/routes/builder.js"));
});

after(async () => {
  if (env) await env.stop();
});

const read = (cookie, query) => api(`/api/builder/weekly-plans?${query}`, { cookie });
const ids = (list) => `athleteIds=${list.map(encodeURIComponent).join(",")}`;
// A weekly plan; `content` gives it one session with a named node (a Builder
// plan without content is the one POST /plans would delete and replace).
async function weeklyPlan({ athleteId, createdBy, weekStart = MONDAY, status = "active", batchId = null, editSourcePlanId = null, isActive = true, sourceType = "builder", content = true }) {
  const id = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, week_start, is_active, is_edit_draft, edit_source_plan_id, builder_batch_id, source_type)
     values ('weekly',$1,$2,'Secret week name',$3,$4,$5,$6,$7,$8,$9) returning id`,
    [createdBy, athleteId, status, weekStart, isActive, Boolean(editSourcePlanId), editSourcePlanId, batchId, sourceType],
  ))[0].id;
  if (content) {
    const dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [id, weekStart]))[0].id;
    const sessionId = (await q(`insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order) values ($1,'Main','AM','T',1) returning id`, [dayId]))[0].id;
    await q(`insert into plans.plan_nodes (plan_session_id, name) values ($1,'Warm-up')`, [sessionId]);
  }
  return id;
}
// Wraps the app pool and records every statement's text while `run` runs.
async function statements(run) {
  const original = env.appPool.query;
  const seen = [];
  env.appPool.query = function recorded(...args) {
    seen.push(String(typeof args[0] === "string" ? args[0] : args[0]?.text || ""));
    return original.apply(this, args);
  };
  try {
    await run();
  } finally {
    env.appPool.query = original;
  }
  return seen;
}
// The sign-in itself (requireAuth) reads the account's athlete row; the
// route's own reads are the plans, the workspace and the scope.
const touchesPlansOrWorkspace = (sql) => /plans\.plans|user_workspace_preferences|athlete_memberships|user_athletes|unnest\(/.test(sql);

test("1. the query string is refused with 400 before any plan, athlete or workspace query: a bad week, no ids, 201 ids, a non-UUID", async () => {
  const coach = m.roles.teamCoach;
  const tooMany = Array.from({ length: WEEKLY_PLANS_READ_MAX + 1 }, () => crypto.randomUUID());
  const cases = [
    [`weekStart=2026-02-30&${ids([m.athletes.athlete.athleteId])}`, "invalid_week_start"],
    [`weekStart=nope&${ids([m.athletes.athlete.athleteId])}`, "invalid_week_start"],
    [`${ids([m.athletes.athlete.athleteId])}`, "invalid_week_start"],
    [`weekStart=${MONDAY}`, "invalid_athletes"],
    [`weekStart=${MONDAY}&athleteIds=`, "invalid_athletes"],
    [`weekStart=${MONDAY}&${ids(tooMany)}`, "invalid_athletes"],
    [`weekStart=${MONDAY}&${ids([m.athletes.athlete.athleteId, "17"])}`, "invalid_athletes"],
    [`weekStart=${MONDAY}&athleteIds=${encodeURIComponent("x' or 1=1 --")}`, "invalid_athletes"],
  ];
  for (const [query, code] of cases) {
    let res;
    const seen = await statements(async () => { res = await read(coach.cookie, query); });
    assert.equal(res.status, 400, `${query}: ${res.text}`);
    assert.equal(res.body.error, code, query);
    assert.deepEqual(seen.filter(touchesPlansOrWorkspace), [], `no plan, athlete or workspace query for ${query}`);
  }
  // Exactly the limit is accepted.
  const atLimit = Array.from({ length: WEEKLY_PLANS_READ_MAX }, () => crypto.randomUUID());
  const ok = await read(coach.cookie, `weekStart=${MONDAY}&${ids(atLimit)}`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.athletes.length, WEEKLY_PLANS_READ_MAX);
});

test("2. a team coach: no plan, the coach's own plan (any day of the week reads its Monday), a batch, a draft and the coach's open edit draft", async () => {
  const coach = m.roles.teamCoach;
  const a1 = await fx.makeAthlete("k3r one", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  const a2 = await fx.makeAthlete("k3r two", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  const a3 = await fx.makeAthlete("k3r three", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  const batch = crypto.randomUUID();
  const p1 = await weeklyPlan({ athleteId: a1.athleteId, createdBy: coach.id, batchId: batch });
  const p2 = await weeklyPlan({ athleteId: a2.athleteId, createdBy: coach.id, batchId: batch, status: "draft" });
  const draft = await weeklyPlan({ athleteId: a1.athleteId, createdBy: coach.id, editSourcePlanId: p1, status: "draft", isActive: false });
  // Another week's plan does not count.
  await weeklyPlan({ athleteId: a3.athleteId, createdBy: coach.id, weekStart: addDays(MONDAY, 7) });
  const res = await read(coach.cookie, `weekStart=${WEDNESDAY}&${ids([a1.athleteId, a2.athleteId, a3.athleteId])}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.cacheControl, "no-store");
  assert.equal(res.body.weekStart, MONDAY);
  assert.deepEqual(res.body.athletes, [
    { athleteId: a1.athleteId, plannable: true, plan: { planId: p1, status: "active", batchId: batch, mine: true, editable: true, openDraftId: draft } },
    { athleteId: a2.athleteId, plannable: true, plan: { planId: p2, status: "draft", batchId: batch, mine: true, editable: true, openDraftId: null } },
    { athleteId: a3.athleteId, plannable: true, plan: null },
  ]);
  assert.ok(!res.text.includes("Secret week name"), "no plan name is answered");
});

test("3. a plan made by someone else that the coach may open is answered with mine:false; another coach's edit draft is not the caller's openDraftId", async () => {
  const coach = m.roles.teamCoach;
  const a = await fx.makeAthlete("k3r other's plan", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  const p = await weeklyPlan({ athleteId: a.athleteId, createdBy: m.roles.clubAdmin.id });
  await weeklyPlan({ athleteId: a.athleteId, createdBy: m.roles.clubAdmin.id, editSourcePlanId: p, status: "draft", isActive: false });
  const res = await read(coach.cookie, `weekStart=${MONDAY}&${ids([a.athleteId])}`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.athletes[0], { athleteId: a.athleteId, plannable: true, plan: { planId: p, status: "active", batchId: null, mine: false, editable: true, openDraftId: null } });
  assert.ok(!res.text.includes(m.roles.clubAdmin.id), "no author id");
});

test("4. outside the workspace: ONLY plannable:false, byte-identical with and without a plan, for another team, another club, an archived athlete and an unknown id", async () => {
  const coach = m.roles.teamCoach;
  const otherTeamWith = await fx.makeAthlete("k3r t2 with", { clubId: m.clubs.c1, teamId: m.teams.t2 });
  const otherTeamWithout = await fx.makeAthlete("k3r t2 without", { clubId: m.clubs.c1, teamId: m.teams.t2 });
  const otherClubWith = await fx.makeAthlete("k3r c2 with", { clubId: m.clubs.c2, teamId: m.teams.u1 });
  const archived = await fx.makeAthlete("k3r archived", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  await weeklyPlan({ athleteId: otherTeamWith.athleteId, createdBy: m.roles.clubAdmin.id });
  await weeklyPlan({ athleteId: otherClubWith.athleteId, createdBy: m.roles.stranger.id });
  await weeklyPlan({ athleteId: archived.athleteId, createdBy: coach.id });
  await q(`update public.athletes set is_active = false where id = $1`, [archived.athleteId]);
  const unknown = crypto.randomUUID();
  const list = [otherTeamWith.athleteId, otherTeamWithout.athleteId, otherClubWith.athleteId, archived.athleteId, unknown];
  const res = await read(coach.cookie, `weekStart=${MONDAY}&${ids(list)}`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.athletes, list.map((athleteId) => ({ athleteId, plannable: false })));
  // The same shape, key for key, with or without a plan.
  assert.equal(JSON.stringify(Object.keys(res.body.athletes[0])), JSON.stringify(Object.keys(res.body.athletes[1])));
});

test("5. the club admin's workspace reaches every athlete of the club, not another club's; a private coach reaches only their own athletes", async () => {
  const inClub = await fx.makeAthlete("k3r club t2", { clubId: m.clubs.c1, teamId: m.teams.t2 });
  const otherClub = await fx.makeAthlete("k3r club c2", { clubId: m.clubs.c2, teamId: m.teams.u1 });
  const res = await read(m.roles.clubAdmin.cookie, `weekStart=${MONDAY}&${ids([inClub.athleteId, otherClub.athleteId])}`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.athletes.map((a) => a.plannable), [true, false]);
  const own = m.athletes.ownAthlete;
  const priv = await read(m.roles.privateCoach.cookie, `weekStart=${MONDAY}&${ids([own.athleteId, inClub.athleteId])}`);
  assert.equal(priv.status, 200, priv.text);
  assert.deepEqual(priv.body.athletes.map((a) => a.plannable), [true, false]);
});

test("6. an athlete account, and a revoked club admin, are refused; no answer names an athlete", async () => {
  const athlete = await read(m.roles.athlete.cookie, `weekStart=${MONDAY}&${ids([m.athletes.athlete.athleteId])}`);
  assert.notEqual(athlete.status, 200, athlete.text);
  const revoked = await read(m.roles.revokedAdmin.cookie, `weekStart=${MONDAY}&${ids([m.athletes.athlete.athleteId])}`);
  assert.notEqual(revoked.status, 200, revoked.text);
  assert.ok(!revoked.text.includes(m.athletes.athlete.athleteId));
});

test("7. weeklyPlansReadAnswer: a plan the caller may not open is { editable:false } only; outside the workspace drops every plan field", () => {
  const row = { athlete_id: "a", plannable: true, plan_id: "p", status: "active", builder_batch_id: "b", mine: false, editable: false, open_draft_id: "d" };
  assert.deepEqual(weeklyPlansReadAnswer(row), { athleteId: "a", plannable: true, plan: { editable: false } });
  assert.deepEqual(weeklyPlansReadAnswer({ ...row, plannable: false, editable: true }), { athleteId: "a", plannable: false });
  assert.deepEqual(weeklyPlansReadAnswer({ ...row, plannable: null }), { athleteId: "a", plannable: false });
});

test("8. the caller's own EMPTY Builder plan is skipped, as POST /plans skips it: the next plan (another creator's) is reported, or none", async () => {
  const coach = m.roles.teamCoach;
  const a = await fx.makeAthlete("k3r empty then other", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  const b = await fx.makeAthlete("k3r empty only", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  const c = await fx.makeAthlete("k3r someone else's empty", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  await weeklyPlan({ athleteId: a.athleteId, createdBy: coach.id, content: false });
  const other = await weeklyPlan({ athleteId: a.athleteId, createdBy: m.roles.clubAdmin.id });
  await weeklyPlan({ athleteId: b.athleteId, createdBy: coach.id, content: false, status: "draft" });
  const othersEmpty = await weeklyPlan({ athleteId: c.athleteId, createdBy: m.roles.clubAdmin.id, content: false });
  const res = await read(coach.cookie, `weekStart=${MONDAY}&${ids([a.athleteId, b.athleteId, c.athleteId])}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.athletes[0].plan.planId, other);
  assert.equal(res.body.athletes[0].plan.mine, false);
  assert.equal(res.body.athletes[1].plan, null, "only the caller's own empty plan: none, as the create would make a new one");
  assert.equal(res.body.athletes[2].plan.planId, othersEmpty, "another creator's empty plan still blocks the create, so it is reported");
});

test("9. ids are answered once each, in the order sent, lower-cased", async () => {
  const coach = m.roles.teamCoach;
  const a = await fx.makeAthlete("k3r order a", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  const b = await fx.makeAthlete("k3r order b", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  const res = await read(coach.cookie, `weekStart=${MONDAY}&${ids([b.athleteId, a.athleteId.toUpperCase(), a.athleteId, b.athleteId])}`);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.athletes.map((x) => x.athleteId), [b.athleteId, a.athleteId]);
});
