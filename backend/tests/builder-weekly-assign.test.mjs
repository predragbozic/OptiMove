// Weekly program templates, part WT-B (docs/ai/weekly-program-template-plan.md):
// the dated assign into the athletes' weekly plans, with the conflict question
// and the #702 kept sessions.
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
  db = await createDisposableDatabase({ prefix: "builder", label: "weeklyasg", baseDatabaseUrl: BASE_URL });
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

test("1. assign from a Wednesday: 2 template weeks land in 3 calendar weeks, new active weekly plans, a copy with fresh ids", async () => {
  const s = await squad("assign");
  const cookie = s.coach.cookie;
  let draft = await weeklyTemplate(cookie, 2, "Two weeks");
  draft = await addSession(cookie, blockOf(draft, 1, 1).id, "Day one");
  draft = await addSession(cookie, blockOf(draft, 1, 6).id, "Day six");
  draft = await addSession(cookie, blockOf(draft, 2, 7).id, "Day fourteen");
  const templateId = draft.plan.id;
  const ids = s.athletes.map((a) => a.externalId);
  const result = ok(await assign(cookie, templateId, { athleteIds: ids, startDate: "2026-12-02" }), 201);
  assert.equal(result.created.length, 6);
  assert.equal(result.replaced.length, 0);
  for (const athlete of s.athletes) {
    const plans = await weekPlans(athlete.athleteId);
    assert.deepEqual(plans.map((p) => p.week_start), ["2026-11-30", "2026-12-07", "2026-12-14"]);
    assert.ok(plans.every((p) => p.status === "active"));
    const byWeek = await Promise.all(plans.map((p) => planSessions(p.id)));
    // Day 1 on Wed 2.12; day 6 on Mon 7.12; day 14 on Tue 15.12.
    assert.deepEqual(byWeek.map((list) => list.map((x) => `${x.date} ${x.name}`)), [["2026-12-02 Day one"], ["2026-12-07 Day six"], ["2026-12-15 Day fourteen"]]);
  }
  // One batch per calendar week across the athletes.
  const a = await weekPlans(s.athletes[0].athleteId);
  const b = await weekPlans(s.athletes[1].athleteId);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(a[i].builder_batch_id);
    assert.equal(a[i].builder_batch_id, b[i].builder_batch_id);
  }
  // A copy: no logical id shared with the template or between athletes.
  const shared = await q(`select logical_session_id, count(*)::int as n from plans.plan_sessions group by 1 having count(*) > 1`);
  assert.equal(shared.length, 0);
  // Ownership snapshot from the active workspace, and notifications.
  const own = await q(`select owner_scope, owner_team_id from training_load.plan_workspace_ownership where plan_id = $1`, [a[0].id]);
  assert.deepEqual(own[0], { owner_scope: "team", owner_team_id: s.teamId });
  const notes = await q(`select count(*)::int as n from public.app_notifications where recipient_user_id = $1 and type = 'weekly_plan_assigned'`, [s.athletes[0].userId]);
  assert.equal(notes[0].n, 3);
  // Later template edits never change the assigned plans.
  ok(await api(`/api/builder/plans/${templateId}/weeks/1`, { method: "DELETE", cookie }));
  assert.equal((await planSessions(a[0].id)).length, 1);
});

test("2. existing weeks: one question per athlete; Replace keeps a session with results, Skip leaves the week alone; idempotent", async () => {
  const s = await squad("conflict");
  const cookie = s.coach.cookie;
  let draft = await weeklyTemplate(cookie, 1, "One week");
  draft = await addSession(cookie, blockOf(draft, 1, 1).id, "T Monday");
  draft = await addSession(cookie, blockOf(draft, 1, 3).id, "T Wednesday");
  const templateId = draft.plan.id;
  const [one, two] = s.athletes;
  // Athlete one has a published week 7.12 with Monday "Before start" and
  // Wednesday "Rated" (RPE) and "Free". The template starts on Wed 9.12: its
  // week covers Wed 9.12 - Tue 15.12, so Monday 7.12 is not the template's.
  const planId = await publishedWeek(s, one, "2026-12-07", [[1, "Before start"], [3, "Rated"], [3, "Free"]]);
  const rated = (await planSessions(planId)).find((x) => x.name === "Rated");
  await rpeRow(one.athleteId, rated.id);
  const before = await planSessions(planId);

  const first = await assign(cookie, templateId, { athleteIds: [one.externalId, two.externalId], startDate: "2026-12-09" });
  assert.equal(first.status, 409, first.text);
  assert.equal(first.body.code, "weekly_assign_conflicts");
  assert.equal(first.body.newWeeks, 3);
  assert.equal(first.body.athletes.length, 1);
  const week = first.body.athletes[0].weeks[0];
  assert.equal(first.body.athletes[0].name, one.name);
  assert.equal(week.weekStart, "2026-12-07");
  assert.deepEqual(week.days, ["2026-12-09", "2026-12-10", "2026-12-11", "2026-12-12", "2026-12-13"]);
  assert.deepEqual(week.contentDays, ["2026-12-09"]);
  assert.deepEqual(week.kept.map((k) => [k.name, k.day, k.reasons]), [["Rated", "2026-12-09", ["has_results"]]]);
  // Nothing written by the question.
  assert.deepEqual(await planSessions(planId), before);
  assert.equal((await weekPlans(two.athleteId)).length, 0);

  // A choice without the token, or with a stale one, is asked again.
  assert.equal((await assign(cookie, templateId, { athleteIds: [one.externalId, two.externalId], startDate: "2026-12-09", choice: "replace" })).status, 409);
  assert.equal((await assign(cookie, templateId, { athleteIds: [one.externalId, two.externalId], startDate: "2026-12-09", choice: "replace", choiceToken: "stale" })).status, 409);

  // Skip: athlete two gets the week, athlete one's week is untouched.
  const skipId = crypto.randomUUID();
  const skip = ok(await api(`/api/builder/plans/${templateId}/assign-weekly`, { method: "POST", cookie, body: { assignmentRequestId: skipId, athleteIds: [one.externalId, two.externalId], startDate: "2026-12-09", choice: "skip", choiceToken: first.body.choiceToken } }), 201);
  assert.deepEqual(skip.skipped, [{ athleteId: one.externalId, weekStart: "2026-12-07", reason: "has_plan" }]);
  assert.equal(skip.created.length, 3);
  assert.deepEqual(await planSessions(planId), before);
  // The same request again replays; the same id with another payload is refused.
  const replay = ok(await api(`/api/builder/plans/${templateId}/assign-weekly`, { method: "POST", cookie, body: { assignmentRequestId: skipId, athleteIds: [one.externalId, two.externalId], startDate: "2026-12-09", choice: "skip", choiceToken: "anything" } }), 201);
  assert.deepEqual(replay, skip);
  assert.equal((await weekPlans(two.athleteId)).length, 2);
  const reused = await api(`/api/builder/plans/${templateId}/assign-weekly`, { method: "POST", cookie, body: { assignmentRequestId: skipId, athleteIds: [one.externalId], startDate: "2026-12-09", choice: "skip" } });
  assert.equal(reused.status, 409);

  // Replace for athlete one alone: "Free" goes, "Rated" stays first, the
  // template's day 1 follows it, Monday (before the start) is not touched.
  const ask = await assign(cookie, templateId, { athleteIds: [one.externalId], startDate: "2026-12-09" });
  assert.equal(ask.status, 409);
  const replace = ok(await assign(cookie, templateId, { athleteIds: [one.externalId], startDate: "2026-12-09", choice: "replace", choiceToken: ask.body.choiceToken }), 201);
  // Its week of 14.12 (created by the Skip above, the template's empty days 6
  // and 7) is a published week now: asked and replaced as well, never deleted.
  assert.equal(replace.replaced.length, 2);
  assert.equal(replace.kept, 1);
  const afterReplace = await planSessions(planId);
  assert.deepEqual(afterReplace.map((x) => `${x.date} ${x.name}`), ["2026-12-07 Before start", "2026-12-09 Rated", "2026-12-09 T Monday", "2026-12-11 T Wednesday"]);
  assert.equal(afterReplace.find((x) => x.name === "Rated").id, rated.id);
  assert.ok(afterReplace.find((x) => x.name === "T Monday").session_order > afterReplace.find((x) => x.name === "Rated").session_order);
  assert.equal((await q(`select count(*)::int as n from training_load.session_feedback where plan_session_id = $1`, [rated.id]))[0].n, 1);
});

test("3. weeks the coach cannot write: another coach's plan and an open edit draft are skipped and named; workspace and old assign paths refused", async () => {
  const s = await squad("cannot", 3);
  const cookie = s.coach.cookie;
  let draft = await weeklyTemplate(cookie, 1, "Cannot");
  draft = await addSession(cookie, blockOf(draft, 1, 2).id, "T Tuesday");
  const templateId = draft.plan.id;
  const [one, two, three] = s.athletes;
  // Athlete one: a published week made by a coach outside the team. This coach
  // manages the athlete, so may open and write it (getEditablePlan's rule) -
  // Replace writes it like any other week. (A week the coach may NOT open is
  // only reachable when the workspace scope and the plan access disagree; it is
  // then skipped as not_editable, named by athlete and week only.)
  const outsider = await squad("cannot-out", 0);
  const otherPlan = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, visibility, is_template, status, source_type, week_start)
     values ('weekly', $1, $2, 'Elsewhere', 'private', false, 'active', 'builder', '2026-12-14') returning id`, [outsider.coach.id, one.athleteId]))[0].id;
  await q(`insert into plans.plan_days (plan_id, date, day_order, block_index, block_order, block_type) select $1, '2026-12-14'::date + i, i + 1, i + 1, i + 1, 'session' from generate_series(0, 6) i`, [otherPlan]);
  await q(`insert into plans.plan_sessions (plan_day_id, bta, session_order, name) select id, 'T', 1, 'Theirs' from plans.plan_days where plan_id = $1 and day_order = 2`, [otherPlan]);
  // Athlete two: a published week with an open edit draft.
  const twoPlan = await publishedWeek(s, two, "2026-12-14", [[2, "Mine"]]);
  ok(await api(`/api/builder/plans/${twoPlan}/edit`, { method: "POST", cookie, body: {} }));
  const ask = await assign(cookie, templateId, { athleteIds: [one.externalId, two.externalId, three.externalId], startDate: "2026-12-14" });
  assert.equal(ask.status, 409, ask.text);
  const byName = new Map(ask.body.athletes.map((a) => [a.name, a.weeks[0]]));
  const oneWeek = byName.get(one.name);
  assert.equal(oneWeek.cannot, undefined);
  assert.deepEqual(oneWeek.contentDays, ["2026-12-15"]);
  assert.equal(byName.get(two.name).cannot, "being_edited");
  const done = ok(await assign(cookie, templateId, { athleteIds: [one.externalId, two.externalId, three.externalId], startDate: "2026-12-14", choice: "replace", choiceToken: ask.body.choiceToken }), 201);
  assert.deepEqual(done.skipped.map((x) => x.reason), ["being_edited"]);
  assert.equal(done.created.length, 1);
  assert.equal(done.replaced.length, 1);
  assert.deepEqual((await planSessions(otherPlan)).map((x) => x.name), ["T Tuesday"]);
  assert.deepEqual((await planSessions(twoPlan)).map((x) => x.name), ["Mine"]);

  // An athlete outside the active workspace: 403, nothing written.
  const stranger = await makeAthlete("cannot Stranger", outsider.clubId, outsider.teamId);
  const res = await assign(cookie, templateId, { athleteIds: [stranger.externalId], startDate: "2026-12-21" });
  assert.equal(res.status, 403);
  // The old paths never make a specific program or a library grant of it.
  const dup = await api(`/api/builder/plans/${templateId}/duplicate`, { method: "POST", cookie, body: { intent: "assign", athleteIds: [three.externalId], assignmentRequestId: crypto.randomUUID() } });
  assert.equal(dup.body.code, "weekly_template_use_dated_assign");
  const grant = await api(`/api/templates/${templateId}/assignments`, { method: "POST", cookie, body: { athleteIds: [three.athleteId] } });
  assert.equal(grant.body.code, "weekly_template_use_dated_assign");
  // Missing / foreign template: the same 404.
  const foreign = await weeklyTemplate(outsider.coach.cookie, 1, "Private");
  await q(`update plans.plans set visibility = 'private' where id = $1`, [foreign.plan.id]);
  assert.equal((await assign(cookie, foreign.plan.id, { athleteIds: [three.externalId], startDate: "2026-12-21" })).status, 404);
  assert.equal((await assign(cookie, crypto.randomUUID(), { athleteIds: [three.externalId], startDate: "2026-12-21" })).status, 404);
});

test("4. two assigns of two templates to one athlete's week at once: one writes, the other asks (no second plan)", async () => {
  const s = await squad("race", 1);
  const cookie = s.coach.cookie;
  // Two different templates: they do not meet on a template row lock, only on
  // the (athlete, week) slot lock.
  let draft = await weeklyTemplate(cookie, 1, "Race");
  draft = await addSession(cookie, blockOf(draft, 1, 1).id, "T Monday");
  const templateId = draft.plan.id;
  let other = await weeklyTemplate(cookie, 1, "Race two");
  other = await addSession(cookie, blockOf(other, 1, 2).id, "T Tuesday");
  const athlete = s.athletes[0];
  let release;
  const held = new Promise((r) => { release = r; });
  let first = true;
  builderModule.weeklyAssignTestHooks.afterPlanLocks = async () => { if (first) { first = false; await held; } };
  try {
    const a = assign(cookie, templateId, { athleteIds: [athlete.externalId], startDate: "2026-12-21" });
    // Wait until the first holds its slot lock.
    for (let i = 0; i < 200 && first; i += 1) await new Promise((r) => setTimeout(r, 10));
    const b = assign(cookie, other.plan.id, { athleteIds: [athlete.externalId], startDate: "2026-12-21" });
    await new Promise((r) => setTimeout(r, 150));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.status, 201, ra.text);
    assert.equal(rb.status, 409, rb.text);
    assert.equal(rb.body.code, "weekly_assign_conflicts");
  } finally {
    builderModule.weeklyAssignTestHooks.afterPlanLocks = null;
  }
  assert.equal((await weekPlans(athlete.athleteId)).length, 1);
});

test("5. a published week whose session has no exercise is never taken for empty: asked, and its session with results stays", async () => {
  const s = await squad("bare", 1);
  const cookie = s.coach.cookie;
  let draft = await weeklyTemplate(cookie, 1, "Bare");
  draft = await addSession(cookie, blockOf(draft, 1, 1).id, "T Monday");
  const athlete = s.athletes[0];
  // A published week with one bare session (no exercise), rated by the athlete.
  const created = ok(await api("/api/builder/plans", { method: "POST", cookie, body: { planType: "weekly", weekStart: "2027-02-01", athleteIds: [athlete.externalId], name: "Bare week" } }), 201);
  ok(await api(`/api/builder/blocks/${created.blocks[0].id}/sessions`, { method: "POST", cookie, body: { bta: "T", name: "Bare" } }), 201);
  // (A Save of a week with no exercise at all removes it as empty, so this
  // shape comes from a published week edited down to bare sessions.)
  await q(`update plans.plans set status = 'active' where id = $1`, [created.plan.id]);
  const bare = (await planSessions(created.plan.id))[0];
  await rpeRow(athlete.athleteId, bare.id);
  const ask = await assign(cookie, draft.plan.id, { athleteIds: [athlete.externalId], startDate: "2027-02-01" });
  assert.equal(ask.status, 409, ask.text);
  assert.deepEqual(ask.body.athletes[0].weeks[0].kept.map((k) => [k.name, k.reasons]), [["Bare", ["has_results"]]]);
  assert.equal((await q(`select count(*)::int as n from plans.plans where id = $1`, [created.plan.id]))[0].n, 1);
  ok(await assign(cookie, draft.plan.id, { athleteIds: [athlete.externalId], startDate: "2027-02-01", choice: "replace", choiceToken: ask.body.choiceToken }), 201);
  assert.deepEqual((await planSessions(created.plan.id)).map((x) => x.name), ["Bare", "T Monday"]);
  // This coach's own empty DRAFT week is the one thing taken for free.
  const empty = ok(await api("/api/builder/plans", { method: "POST", cookie, body: { planType: "weekly", weekStart: "2027-02-08", athleteIds: [athlete.externalId], name: "Empty draft" } }), 201);
  const done = ok(await assign(cookie, draft.plan.id, { athleteIds: [athlete.externalId], startDate: "2027-02-08" }), 201);
  assert.equal(done.created.length, 1);
  assert.equal((await q(`select count(*)::int as n from plans.plans where id = $1`, [empty.plan.id]))[0].n, 0);
});

test("6. a session added after the question asks again; an open edit draft is assignable only by its creator", async () => {
  const s = await squad("fixes", 1);
  const cookie = s.coach.cookie;
  let draft = await weeklyTemplate(cookie, 1, "Fixes");
  draft = await addSession(cookie, blockOf(draft, 1, 1).id, "T Monday");
  const athlete = s.athletes[0];
  // A published week with a session on Tuesday only; the template's Monday lands on an empty day.
  const weekId = await publishedWeek(s, athlete, "2027-03-01", [[2, "Tuesday own"]]);
  const first = await assign(cookie, draft.plan.id, { athleteIds: [athlete.externalId], startDate: "2027-03-01" });
  assert.equal(first.status, 409);
  assert.deepEqual(first.body.athletes[0].weeks[0].contentDays, ["2027-03-02"]);
  // Another session lands on Monday after the question.
  await q(`insert into plans.plan_sessions (plan_day_id, bta, session_order, name) select id, 'T', 1, 'Added later' from plans.plan_days where plan_id = $1 and date = '2027-03-01'`, [weekId]);
  const again = await assign(cookie, draft.plan.id, { athleteIds: [athlete.externalId], startDate: "2027-03-01", choice: "replace", choiceToken: first.body.choiceToken });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.body.code, "weekly_assign_conflicts");
  assert.notEqual(again.body.choiceToken, first.body.choiceToken);
  assert.ok((await planSessions(weekId)).some((x) => x.name === "Added later"));

  // An open edit draft of a public template: another coach gets the 404 of a missing template.
  await q(`update plans.plans set status = 'active', visibility = 'public' where id = $1`, [draft.plan.id]);
  const edit = ok(await api(`/api/builder/plans/${draft.plan.id}/edit`, { method: "POST", cookie, body: {} }));
  const other = await coachOf("fixes-other", s.teamId);
  const foreign = await assign(other.cookie, edit.plan.id, { athleteIds: [athlete.externalId], startDate: "2027-04-05" });
  assert.equal(foreign.status, 404, foreign.text);
  assert.deepEqual(foreign.body, { error: "Template not found." });
  // Its creator still may (the Builder applies the edit first; the route itself accepts it).
  assert.equal((await assign(cookie, edit.plan.id, { athleteIds: [athlete.externalId], startDate: "2027-04-05" })).status, 201);
});

test("7. one request writes at most 400 athlete-weeks: more is refused before any lock on a plan, nothing written", async () => {
  const s = await squad("cap", 8);
  const draft = await weeklyTemplate(s.coach.cookie, 52, "Season");
  // 52 template weeks from a Wednesday touch 53 calendar weeks; 8 athletes = 424.
  const res = await assign(s.coach.cookie, draft.plan.id, { athleteIds: s.athletes.map((a) => a.externalId), startDate: "2027-01-06" });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.body.code, "assign_too_large");
  for (const athlete of s.athletes) assert.equal((await weekPlans(athlete.athleteId)).length, 0);
  // 7 athletes = 371: written.
  const ok7 = await assign(s.coach.cookie, draft.plan.id, { athleteIds: s.athletes.slice(0, 7).map((a) => a.externalId), startDate: "2027-01-06" });
  assert.equal(ok7.status, 201, ok7.text);
  assert.equal(ok7.body.created.length, 371);
});
