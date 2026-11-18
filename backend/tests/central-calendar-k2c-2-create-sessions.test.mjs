// Central calendar K2c-2-B — `sessions` on create: an event made with its
// planned sessions linked in the same transaction (plan
// docs/ai/central-calendar-k2c-plan.md, sections 2.3 and 2.4). The real app
// over HTTP on a disposable database migrated by the calendar fixture (v81
// included); invented people only. Nothing touches OPTIMOVE or any persistent
// database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { addDays, calendarRoleMatrix, newKey, startCalendarApp, uid } from "./support/calendar-fixture.mjs";

const TODAY = new Date().toISOString().slice(0, 10);
const DAY = addDays(TODAY, 3);

let env;
let q;
let api;
let fx;
let m;
let hooks;
let service;
let membershipOnDaySql;

before(async () => {
  env = await startCalendarApp({ label: "k2c2b" });
  ({ q, api, fx } = env);
  // The fixture's legacy scaffold has no in-app notifications table (the
  // questions write to it): the real one's shape, as the K2b-2a-1 suite.
  await q(`create table if not exists public.app_notifications (
             id uuid primary key default gen_random_uuid(), recipient_user_id uuid not null, actor_user_id uuid,
             type varchar(80) not null, title text not null, body text, entity_type varchar(80), entity_id uuid, href text,
             metadata jsonb not null default '{}'::jsonb, read_at timestamptz, created_at timestamptz not null default now(),
             dedupe_key varchar(300))`);
  await q(`create unique index if not exists app_notifications_dedupe_key_idx on public.app_notifications (dedupe_key) where dedupe_key is not null`);
  m = await calendarRoleMatrix(env, "k2c2");
  service = await import("../src/calendarEventService.js");
  hooks = service.testHooks;
  ({ membershipOnDaySql } = await import("../src/calendarAccess.js"));
});

after(async () => {
  if (env) await env.stop();
});

const role = (name) => m.roles[name];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function typeId({ clubId = null, kind = "training" } = {}) {
  const rows = clubId
    ? await q(`select id from calendar.event_types where owner_scope = 'club' and owner_club_id = $1 and kind = $2 and archived_at is null order by sort_order limit 1`, [clubId, kind])
    : await q(`select id from calendar.event_types where owner_scope = 'system' and kind = $1 and archived_at is null order by sort_order limit 1`, [kind]);
  return rows[0].id;
}
// One published weekly plan of one athlete with one session on `date`.
async function planSession({ athleteId, owner, coachUserId, date = DAY, name = "Morning session", amPm = "AM", bta = "T", order = 1, status = "active", editSourcePlanId = null, rpe = true }) {
  const planId = (await q(
    `insert into plans.plans (plan_type, created_by_user_id, athlete_id, name, status, week_start, is_active, is_edit_draft, edit_source_plan_id)
     values ('weekly',$1,$2,'Week',$3,$4,true,$5,$6) returning id`,
    [coachUserId, athleteId, status, date, Boolean(editSourcePlanId), editSourcePlanId],
  ))[0].id;
  await q(
    `insert into training_load.plan_workspace_ownership (plan_id, owner_scope, owner_user_id, owner_club_id, owner_team_id) values ($1,$2,$3,$4,$5)`,
    [planId, owner.scope, owner.scope === "user" ? owner.id : null, owner.scope === "club" ? owner.id : null, owner.scope === "team" ? owner.id : null],
  );
  const dayId = (await q(`insert into plans.plan_days (plan_id, date, day_order) values ($1,$2,1) returning id`, [planId, date]))[0].id;
  const logicalSessionId = crypto.randomUUID();
  const sessionId = (await q(
    `insert into plans.plan_sessions (plan_day_id, name, am_pm, bta, session_order, session_time, rpe_enabled, training_load_enabled, logical_session_id)
     values ($1,$2,$3,$4,$5,'09:30',$6,true,$7) returning id`,
    [dayId, name, amPm, bta, order, rpe, logicalSessionId],
  ))[0].id;
  return { planId, sessionId, logicalSessionId, athleteId };
}
// A fresh team of club `clubId` with its coach and `n` athletes, each with a
// published team plan session on DAY.
async function teamWorld(label, { clubId = m.clubs.c1, n = 2, date = DAY } = {}) {
  const team = await fx.makeTeam(clubId, `k2c2 ${label}`);
  const coach = await fx.coachOf(team, `k2c2 coach ${label}`);
  const athletes = [];
  for (let i = 0; i < n; i += 1) athletes.push(await fx.makeAthlete(`k2c2 ${label} athlete ${i + 1}`, { clubId, teamId: team }));
  const sessions = [];
  for (const a of athletes) sessions.push(await planSession({ athleteId: a.athleteId, owner: { scope: "team", id: team }, coachUserId: coach.id, date }));
  return { clubId, team, coach, athletes, sessions, ids: sessions.map((s) => s.logicalSessionId) };
}
function createBody(w, extra = {}) {
  return {
    requestKey: newKey(), eventTypeId: extra.eventTypeId, title: extra.title || `Morning ${uid()}`, day: extra.day || DAY, timezone: "UTC",
    targets: extra.targets || w.athletes.map((a) => ({ kind: "athlete", id: a.athleteId })),
    ...(extra.noSessions ? {} : { sessions: extra.sessions || { logicalSessionIds: w.ids } }),
    ...(extra.questions ? { questions: extra.questions } : {}),
    ...(extra.endDay ? { endDay: extra.endDay } : {}),
  };
}
async function create(w, extra = {}, cookie = w.coach.cookie) {
  const eventTypeId = extra.eventTypeId || await typeId({ clubId: w.clubId, kind: extra.kind || "training" });
  const body = createBody(w, { ...extra, eventTypeId });
  return { body, res: await api("/api/calendar/events", { method: "POST", cookie, body }) };
}
async function counts(title) {
  return (await q(
    `select (select count(*)::int from calendar.events where title = $1) as events,
            (select count(*)::int from calendar.event_targets t join calendar.events e on e.id = t.event_id where e.title = $1) as targets,
            (select count(*)::int from calendar.event_session_links l join calendar.events e on e.id = l.event_id where e.title = $1) as links,
            (select count(*)::int from calendar.event_requests r join calendar.events e on e.id = r.event_id where e.title = $1) as requests,
            (select count(*)::int from calendar.event_changes c join calendar.events e on e.id = c.event_id where e.title = $1) as changes,
            (select count(*)::int from calendar.event_questions qq join calendar.events e on e.id = qq.event_id where e.title = $1) as questions`,
    [title],
  ))[0];
}
const NOTHING = { events: 0, targets: 0, links: 0, requests: 0, changes: 0, questions: 0 };
async function liveLinks(logicalSessionIds) {
  return q(
    `select l.event_id::text, l.plan_id::text from calendar.event_session_links l
       join plans.plan_days pd on pd.plan_id = l.plan_id and pd.date = l.day
       join plans.plan_sessions ps on ps.plan_day_id = pd.id and ps.am_pm is not distinct from l.am_pm and ps.bta is not distinct from l.bta and ps.session_order = l.session_order
      where l.ended_at is null and ps.logical_session_id = any($1::uuid[]) order by 1, 2`,
    [logicalSessionIds],
  );
}
async function switchOn(clubId) {
  const admin = await fx.platformAdmin(`k2c2 switch ${uid()}`, { clubId });
  const res = await api("/api/calendar/settings/questions", { method: "PUT", cookie: admin.cookie, body: { requestKey: newKey(), enabled: true, reason: "Pilot of the athlete questions." } });
  assert.equal(res.status, 200, res.text);
}
function recordSql() {
  const calls = [];
  hooks.beforeLocks = async ({ client }) => {
    const original = client.query.bind(client);
    client.query = (...args) => {
      calls.push({ text: typeof args[0] === "string" ? args[0] : args[0]?.text || "", params: Array.isArray(args[1]) ? args[1] : args[0]?.values || [] });
      return original(...args);
    };
  };
  return calls;
}
const isWrite = (s) => /^\s*(insert|update|delete)\b/i.test(s);
const isLock = (s) => /\bfor (update|share|no key update|key share)\b/i.test(s) || /pg_advisory_xact_lock|lock_event_writer/i.test(s);

// ---------------------------------------------------------------------------
// 1. Bases, the fold, the identical refusals
// ---------------------------------------------------------------------------
test("1. a team coach makes the event with its training linked: 201, the counts, the links, the change and request rows, the fold on the next read", async () => {
  const w = await teamWorld("base");
  const { body, res } = await create(w);
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.attached, 2);
  assert.equal(res.body.alreadyAttached, 0);
  assert.equal(res.body.alignment, null);
  const ev = res.body.event;
  assert.equal((await liveLinks(w.ids)).length, 2);
  assert.ok((await liveLinks(w.ids)).every((l) => l.event_id === ev.id));
  assert.deepEqual(await counts(body.title), { events: 1, targets: 2, links: 2, requests: 1, changes: 1, questions: 0 });
  const change = (await q(`select kind, details from calendar.event_changes where event_id = $1`, [ev.id]))[0];
  assert.equal(change.kind, "create");
  assert.equal(change.details.sessions, 2);
  assert.deepEqual(change.details.planIds, w.sessions.map((s) => s.planId).sort());
  const request = (await q(`select operation, result from calendar.event_requests where event_id = $1`, [ev.id]))[0];
  assert.equal(request.operation, "create");
  const { attached, alreadyAttached, alignment } = request.result.counts;
  assert.deepEqual({ attached, alreadyAttached, alignment }, { attached: 2, alreadyAttached: 0, alignment: null }, "the counts are stored for the replay");
  assert.equal((await q(`select revision from calendar.events where id = $1`, [ev.id]))[0].revision, 1, "no bump: the links are part of the create");
  const read = await api(`/api/calendar?from=${DAY}&to=${DAY}`, { cookie: w.coach.cookie });
  assert.equal(read.status, 200, read.text);
  const items = (read.body.days || []).flatMap((d) => d.items);
  assert.equal(items.filter((i) => i.kind === "planned" && i.links.logicalSessionIds.some((id) => w.ids.includes(id))).length, 0, "no planned card left");
  const card = items.find((i) => i.kind === "event" && i.eventId === ev.id);
  assert.ok(card, "the event card");
  assert.deepEqual([...card.links.logicalSessionIds].sort(), [...w.ids].sort());
  const view = await api(`/api/calendar/events/${ev.id}`, { cookie: w.coach.cookie });
  assert.equal(view.status, 200, view.text);
  assert.equal(view.body.event.sessionLinks.length, 2);
});

test("1b. every writer basis: a club admin, a platform admin in the club's workspace, a private coach", async () => {
  const c1 = m.clubs.c1;
  const a = await fx.makeAthlete("k2c2 club athlete", { clubId: c1 });
  const clubPlan = await planSession({ athleteId: a.athleteId, owner: { scope: "club", id: c1 }, coachUserId: role("clubAdmin").id });
  const w = { clubId: c1, athletes: [a], ids: [clubPlan.logicalSessionId] };
  for (const who of ["clubAdmin", "platformInClub"]) {
    const extra = { title: `Club ${who} ${uid()}` };
    if (who === "platformInClub") {
      const b = await fx.makeAthlete("k2c2 club athlete 2", { clubId: c1 });
      const p = await planSession({ athleteId: b.athleteId, owner: { scope: "club", id: c1 }, coachUserId: role("clubAdmin").id });
      Object.assign(w, { athletes: [b], ids: [p.logicalSessionId] });
    }
    const { res } = await create(w, extra, role(who).cookie);
    assert.equal(res.status, 201, `${who}: ${res.text}`);
    assert.equal(res.body.attached, 1);
  }
  const own = m.athletes.ownAthlete;
  const pc = role("privateCoach");
  const p = await planSession({ athleteId: own.athleteId, owner: { scope: "user", id: pc.id }, coachUserId: pc.id });
  const res = await api("/api/calendar/events", { method: "POST", cookie: pc.cookie, body: { requestKey: newKey(), eventTypeId: await typeId(), title: `Private ${uid()}`, day: DAY, timezone: "UTC", targets: [{ kind: "athlete", id: own.athleteId }], sessions: { logicalSessionIds: [p.logicalSessionId] } } });
  assert.equal(res.status, 201, res.text);
  assert.equal(res.body.attached, 1);
});

test("1c. the platform workspace answers 403 workspace_required, an athlete 403; nothing is written", async () => {
  const w = await teamWorld("refused");
  const tid = await typeId({ clubId: w.clubId });
  for (const [who, status, code] of [["platformAdmin", 403, "workspace_required"], ["athlete", 403, null]]) {
    const body = createBody(w, { eventTypeId: tid, title: `No ${who} ${uid()}` });
    const res = await api("/api/calendar/events", { method: "POST", cookie: role(who).cookie, body });
    assert.equal(res.status, status, `${who}: ${res.text}`);
    if (code) assert.equal(res.body.error, code);
    assert.deepEqual(await counts(body.title), NOTHING);
  }
  assert.equal((await liveLinks(w.ids)).length, 0);
});

test("1d. the event owner's tree: a sibling team's plan, a private coach's plan of a club athlete, another club's plan and an id that does not exist are one identical answer", async () => {
  const w = await teamWorld("tree", { n: 1 });
  const ath = w.athletes[0];
  const sibling = await fx.makeTeam(m.clubs.c1, "k2c2 sibling");
  await fx.addMembership({ athleteId: ath.athleteId, clubId: m.clubs.c1, teamId: sibling });
  const siblingPlan = await planSession({ athleteId: ath.athleteId, owner: { scope: "team", id: sibling }, coachUserId: w.coach.id, name: "Sibling" });
  const pc = role("privateCoach");
  await fx.coachAthlete(pc.id, ath.athleteId);
  const privatePlan = await planSession({ athleteId: ath.athleteId, owner: { scope: "user", id: pc.id }, coachUserId: pc.id, name: "Private" });
  const otherClubPlan = await planSession({ athleteId: m.athletes.athleteU1.athleteId, owner: { scope: "team", id: m.teams.u1 }, coachUserId: pc.id, name: "Other club" });
  const answers = [];
  for (const id of [siblingPlan.logicalSessionId, privatePlan.logicalSessionId, otherClubPlan.logicalSessionId, crypto.randomUUID()]) {
    const { body, res } = await create(w, { sessions: { logicalSessionIds: [id] } });
    assert.equal(res.status, 400, res.text);
    answers.push(res.text);
    assert.deepEqual(await counts(body.title), NOTHING);
  }
  assert.equal(new Set(answers).size, 1, "one byte-identical answer");
  assert.equal(JSON.parse(answers[0]).error, "session_not_available");
});

// ---------------------------------------------------------------------------
// 2. Validation and atomicity: one refusal per step, nothing written
// ---------------------------------------------------------------------------
test("2. the body: invalid_sessions and invalid_align (alignSessions true, a non-boolean, confirmDisableWithResults with any value) write nothing", async () => {
  const w = await teamWorld("body", { n: 1 });
  const tid = await typeId({ clubId: w.clubId });
  const tooMany = Array.from({ length: 201 }, () => crypto.randomUUID());
  const cases = [
    [null, "invalid_sessions"], ["x", "invalid_sessions"], [[w.ids[0]], "invalid_sessions"], [{}, "invalid_sessions"],
    [{ logicalSessionIds: [] }, "invalid_sessions"], [{ logicalSessionIds: ["nope"] }, "invalid_sessions"], [{ logicalSessionIds: tooMany }, "invalid_sessions"],
    [{ logicalSessionIds: w.ids, alignSessions: true }, "invalid_align"], [{ logicalSessionIds: w.ids, alignSessions: "yes" }, "invalid_align"],
    [{ logicalSessionIds: w.ids, confirmDisableWithResults: false }, "invalid_align"], [{ logicalSessionIds: w.ids, confirmDisableWithResults: true }, "invalid_align"],
  ];
  for (const [sessions, code] of cases) {
    const body = { ...createBody(w, { eventTypeId: tid, title: `Body ${uid()}` }), sessions };
    const res = await api("/api/calendar/events", { method: "POST", cookie: w.coach.cookie, body });
    assert.equal(res.status, 400, `${JSON.stringify(sessions)?.slice(0, 60)}: ${res.text}`);
    assert.equal(res.body.error, code);
    if (code === "invalid_align") assert.equal(res.body.message, "Create the event first, then align its trainings.");
    assert.deepEqual(await counts(body.title), NOTHING);
  }
  const ok = await api("/api/calendar/events", { method: "POST", cookie: w.coach.cookie, body: { ...createBody(w, { eventTypeId: tid }), sessions: { logicalSessionIds: w.ids, alignSessions: false } } });
  assert.equal(ok.status, 201, `alignSessions false is accepted: ${ok.text}`);
});

test("2b. each attach step refuses and rolls the whole create back: unpublished, edit draft, outside the days, not targeted (athlete, team, a member who left), linked elsewhere", async () => {
  const w = await teamWorld("atomic", { n: 2 });
  const draft = await planSession({ athleteId: w.athletes[0].athleteId, owner: { scope: "team", id: w.team }, coachUserId: w.coach.id, status: "draft", name: "Draft" });
  const editDraft = await planSession({ athleteId: w.athletes[0].athleteId, owner: { scope: "team", id: w.team }, coachUserId: w.coach.id, editSourcePlanId: w.sessions[0].planId, name: "Edit draft" });
  const run = async (extra, status, code, label, cookie) => {
    const { body, res } = await create(w, extra, cookie);
    assert.equal(res.status, status, `${label}: ${res.text}`);
    assert.equal(res.body.error, code, label);
    assert.deepEqual(await counts(body.title), NOTHING, label);
    return res;
  };
  await run({ sessions: { logicalSessionIds: [draft.logicalSessionId] } }, 400, "session_not_available", "a draft plan");
  await run({ sessions: { logicalSessionIds: [editDraft.logicalSessionId] } }, 400, "session_not_available", "an edit draft only");
  await run({ day: addDays(DAY, 1) }, 409, "session_outside_event", "another day");
  const one = await run({ targets: [{ kind: "athlete", id: w.athletes[0].athleteId }] }, 409, "athlete_not_targeted", "one athlete not targeted");
  assert.equal(one.body.count, 1);
  // A team target, with one member who left the team before the day: the
  // club's admin still sees her (a club member), so the answer is the
  // targeted rule's, not the scope's.
  const left = await fx.makeAthlete("k2c2 atomic leaver", { clubId: w.clubId, teamId: w.team });
  const leaverPlan = await planSession({ athleteId: left.athleteId, owner: { scope: "team", id: w.team }, coachUserId: w.coach.id });
  const membership = (await q(`select id from public.athlete_memberships where athlete_id = $1 and team_id = $2`, [left.athleteId, w.team]))[0].id;
  await q(`update public.athlete_memberships set status = 'archived', archived_at = $2, updated_at = now() where id = $1`, [membership, `${addDays(DAY, -1)}T00:00:00Z`]);
  const teamTargets = [{ kind: "team", id: w.team }];
  const admin = await fx.clubAdminOf(w.clubId, `k2c2 atomic admin ${uid()}`);
  const leaver = await run({ targets: teamTargets, sessions: { logicalSessionIds: [...w.ids, leaverPlan.logicalSessionId] } }, 409, "athlete_not_targeted", "a member who left", admin.cookie);
  assert.equal(leaver.body.count, 1);
  // Linked elsewhere: an existing event of the team holds the first session.
  const other = await create(w, { sessions: { logicalSessionIds: [w.ids[0]] }, targets: [{ kind: "athlete", id: w.athletes[0].athleteId }] });
  assert.equal(other.res.status, 201, other.res.text);
  const sql = recordSql();
  try {
    await run({}, 409, "session_already_attached", "linked to another event");
  } finally {
    delete hooks.beforeLocks;
  }
  assert.equal(sql.filter((c) => isWrite(c.text)).length, 0, "refused before any write (not by the unique index)");
});

test("2d. a multi-day event: a session on its second day links; one after its last day is session_outside_event", async () => {
  const day2 = addDays(DAY, 1);
  const w = await teamWorld("two days", { n: 1, date: day2 });
  const ok = await create(w, { endDay: day2 });
  assert.equal(ok.res.status, 201, ok.res.text);
  assert.equal(ok.res.body.attached, 1);
  const w2 = await teamWorld("after the span", { n: 1, date: addDays(DAY, 2) });
  const late = await create(w2, { endDay: day2 });
  assert.equal(late.res.status, 409, late.res.text);
  assert.equal(late.res.body.error, "session_outside_event");
  assert.deepEqual(await counts(late.body.title), NOTHING);
});

test("2c. a fault after the first write rolls everything back", async () => {
  const w = await teamWorld("fault", { n: 1 });
  hooks.beforeRequestRow = async ({ operation }) => {
    if (operation === "create") throw new Error("injected fault");
  };
  let res;
  let body;
  try {
    ({ body, res } = await create(w));
  } finally {
    delete hooks.beforeRequestRow;
  }
  assert.equal(res.status, 500, res.text);
  assert.deepEqual(await counts(body.title), NOTHING);
  assert.equal((await liveLinks(w.ids)).length, 0);
});

// ---------------------------------------------------------------------------
// 3. Idempotency and the hash
// ---------------------------------------------------------------------------
test("3. the replay: the same key and body answer the saved event and counts; another sessions is request_key_reused; the ids in another order are the same request; a double submit makes one event", async () => {
  const w = await teamWorld("replay", { n: 2 });
  const tid = await typeId({ clubId: w.clubId });
  const body = createBody(w, { eventTypeId: tid });
  const first = await api("/api/calendar/events", { method: "POST", cookie: w.coach.cookie, body });
  assert.equal(first.status, 201, first.text);
  const again = await api("/api/calendar/events", { method: "POST", cookie: w.coach.cookie, body: { ...body, sessions: { logicalSessionIds: [...w.ids].reverse() } } });
  assert.equal(again.status, 201, again.text);
  assert.equal(again.body.event.id, first.body.event.id);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.attached, 2, "the counts are replayed");
  for (const sessions of [{ logicalSessionIds: [w.ids[0]] }, undefined]) {
    const reused = await api("/api/calendar/events", { method: "POST", cookie: w.coach.cookie, body: { ...body, sessions } });
    assert.equal(reused.status, 409, reused.text);
    assert.equal(reused.body.error, "request_key_reused");
  }
  const plain = createBody(w, { eventTypeId: tid, noSessions: true });
  const madePlain = await api("/api/calendar/events", { method: "POST", cookie: w.coach.cookie, body: plain });
  assert.equal(madePlain.status, 201, madePlain.text);
  const added = await api("/api/calendar/events", { method: "POST", cookie: w.coach.cookie, body: { ...plain, sessions: { logicalSessionIds: w.ids } } });
  assert.equal(added.status, 409, "sessions added to a used key");
  assert.equal(added.body.error, "request_key_reused");
  assert.equal((await counts(body.title)).events, 1);
  // A double submit of a new key.
  const w2 = await teamWorld("double", { n: 1 });
  const twice = createBody(w2, { eventTypeId: await typeId({ clubId: w2.clubId }) });
  const [r1, r2] = await Promise.all([1, 2].map(() => api("/api/calendar/events", { method: "POST", cookie: w2.coach.cookie, body: twice })));
  assert.deepEqual([r1.status, r2.status].sort(), [201, 201], `${r1.text} ${r2.text}`);
  assert.equal(r1.body.event.id, r2.body.event.id);
  assert.equal((await counts(twice.title)).events, 1);
  assert.equal((await liveLinks(w2.ids)).length, 1);
});

test("3b. the hash: a body without sessions has the canonical body of e98a7378 byte for byte; sessions enter it only when sent, as the sorted, deduplicated ids", async () => {
  const body = {
    requestKey: "11111111-1111-4111-8111-111111111111", eventTypeId: "22222222-2222-4222-8222-222222222222", title: "Morning session", day: "2026-11-20",
    startTime: "09:30", timezone: "Europe/Belgrade", expects: ["rpe"],
    targets: [{ kind: "athlete", id: "33333333-3333-4333-8333-333333333333" }, { kind: "athlete", id: "44444444-4444-4444-8444-444444444444" }],
  };
  // Captured on #614's head e98a7378 before this change (plan 2.3.9, test 5).
  const BEFORE = '{"operation":"create","eventTypeId":"22222222-2222-4222-8222-222222222222","title":"Morning session","day":"2026-11-20","endDay":null,"startTime":"09:30","endTime":null,"timezone":"Europe/Belgrade","location":null,"expects":["rpe"],"notes":null,"targets":[{"kind":"athlete","id":"33333333-3333-4333-8333-333333333333"},{"kind":"athlete","id":"44444444-4444-4444-8444-444444444444"}],"externalScheduleId":null,"testScheduleId":null}';
  assert.equal(JSON.stringify(service.validateCreateBody(body).canonical), BEFORE);
  assert.equal(JSON.stringify(service.validateCreateBody({ ...body, sessions: undefined }).canonical), BEFORE);
  const b = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB";
  const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const withSessions = service.validateCreateBody({ ...body, sessions: { logicalSessionIds: [b, a, a], alignSessions: false } }).canonical;
  assert.equal(JSON.stringify(withSessions), `${BEFORE.slice(0, -1)},"sessions":{"logicalSessionIds":["${a}","${b.toLowerCase()}"]}}`);
});

test("3c. a lost COMMIT: a COMMIT that went through is verified with its counts; one that did not is 503 outcome_unknown and nothing is saved", async () => {
  const w = await teamWorld("commit", { n: 1 });
  try {
    hooks.commit = async (client) => {
      await client.query("commit");
      const error = new Error("socket hang up");
      error.code = "ECONNRESET";
      throw error;
    };
    const { body, res } = await create(w);
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.verifiedAfterCommitError, true);
    assert.equal(res.body.attached, 1);
    assert.equal((await counts(body.title)).links, 1);
    const w2 = await teamWorld("commit2", { n: 1 });
    hooks.commit = async (client) => {
      await client.query("rollback");
      const error = new Error("connection terminated");
      error.code = "ECONNRESET";
      throw error;
    };
    const lost = await create(w2);
    assert.equal(lost.res.status, 503, lost.res.text);
    assert.equal(lost.res.body.error, "outcome_unknown");
    assert.deepEqual(await counts(lost.body.title), NOTHING);
    assert.equal((await liveLinks(w2.ids)).length, 0);
  } finally {
    delete hooks.commit;
  }
});

// ---------------------------------------------------------------------------
// 4. The interplay with the questions (one RPE channel, plan 2.3.7)
// ---------------------------------------------------------------------------
test("4. with the questions switch on: the type's RPE default is skipped and named; an explicit RPE question is rpe_from_sessions and nothing is saved; without sessions the RPE default is asked", async () => {
  const club = await fx.makeClub("k2c2 questions");
  await switchOn(club);
  const w = await teamWorld("questions", { clubId: club, n: 1 });
  const skipped = await create(w);
  assert.equal(skipped.res.status, 201, skipped.res.text);
  assert.ok(skipped.res.body.questionsSkipped.includes("rpe"), JSON.stringify(skipped.res.body));
  assert.equal(skipped.res.body.attached, 1);
  const ev = skipped.res.body.event;
  assert.equal((await q(`select count(*)::int as n from calendar.event_questions where event_id = $1 and kind = 'rpe'`, [ev.id]))[0].n, 0);
  assert.equal((await q(`select external_schedule_id from calendar.events where id = $1`, [ev.id]))[0].external_schedule_id, null);
  const change = (await q(`select details from calendar.event_changes where event_id = $1`, [ev.id]))[0];
  assert.ok(change.details.questionsSkipped.includes("rpe"));

  const w2 = await teamWorld("questions2", { clubId: club, n: 1 });
  const explicit = await create(w2, { questions: [{ kind: "rpe", window: { kind: "after_event" } }] });
  assert.equal(explicit.res.status, 409, explicit.res.text);
  assert.equal(explicit.res.body.error, "rpe_from_sessions");
  assert.deepEqual(await counts(explicit.body.title), NOTHING);
  assert.equal((await liveLinks(w2.ids)).length, 0);

  const none = await create(w2, { questions: [] });
  assert.equal(none.res.status, 201, none.res.text);

  const w3 = await teamWorld("questions3", { clubId: club, n: 1 });
  const plain = await create(w3, { noSessions: true });
  assert.equal(plain.res.status, 201, plain.res.text);
  assert.ok(plain.res.body.questionsAsked.length >= 1, "without sessions the RPE default is asked");
  assert.equal((await q(`select count(*)::int as n from calendar.event_questions where event_id = $1 and kind = 'rpe' and ended_at is null`, [plain.res.body.event.id]))[0].n, 1);
});

// ---------------------------------------------------------------------------
// 5. "Targeted": the attach's rule, unchanged, and the create's equal to it
// ---------------------------------------------------------------------------
test("5. the attach's targeted SQL is the text it was (stored targets), and a create answers like an attach for athlete, team and club targets and for a member who left", async () => {
  // (a) The attach's SQL: the targeted part is the K2a-1b text, byte for byte.
  const w = await teamWorld("sqlpin", { n: 1 });
  const ev = (await create(w, { noSessions: true })).res.body.event;
  const sql = recordSql();
  let res;
  try {
    res = await api(`/api/calendar/events/${ev.id}/sessions`, { method: "POST", cookie: w.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, logicalSessionIds: w.ids, alignSessions: false } });
  } finally {
    delete hooks.beforeLocks;
  }
  assert.equal(res.status, 200, res.text);
  const k2a1b = (athleteExpr, dayExpr) => `exists (select 1 from calendar.event_targets tg where tg.event_id = $2::uuid and (
            (tg.target_kind = 'athlete' and tg.target_athlete_id = ${athleteExpr})
         or (tg.target_kind = 'team' and ${membershipOnDaySql(athleteExpr, (mm) => `(${mm}.membership_type = 'team' and ${mm}.team_id = tg.target_team_id)`, dayExpr)})
         or (tg.target_kind = 'club' and ${membershipOnDaySql(athleteExpr, (mm) => `(${mm}.membership_type = 'club' and ${mm}.club_id = tg.target_club_id)`, dayExpr)})))`;
  const reads = sql.filter((c) => /from plans\.plan_sessions ps/.test(c.text) && /as targeted/.test(c.text));
  assert.equal(reads.length, 2, "the unlocked read and the read under the plan locks");
  for (const r of reads) assert.ok(r.text.includes(k2a1b("ath.id", "pd.date")), "the attach's targeted SQL is unchanged");

  // (b) The same worlds through an attach and through a create.
  const scenarios = [
    { label: "athletes", targets: (x) => x.athletes.map((a) => ({ kind: "athlete", id: a.athleteId })) },
    { label: "one athlete", targets: (x) => [{ kind: "athlete", id: x.athletes[0].athleteId }] },
    { label: "the team", targets: (x) => [{ kind: "team", id: x.team }] },
    { label: "another team", targets: () => [{ kind: "team", id: m.teams.t2 }], admin: true },
    { label: "the club", targets: (x) => [{ kind: "club", id: x.clubId }], admin: true },
    { label: "the team, a member left", targets: (x) => [{ kind: "team", id: x.team }], leave: true, admin: true },
    { label: "the team, a member left, its coach", targets: (x) => [{ kind: "team", id: x.team }], leave: true },
  ];
  for (const s of scenarios) {
    const outcome = [];
    for (const via of ["attach", "create"]) {
      const x = await teamWorld(`eq ${s.label} ${via}`, { n: 2 });
      if (s.leave) {
        const id = (await q(`select id from public.athlete_memberships where athlete_id = $1 and team_id = $2`, [x.athletes[1].athleteId, x.team]))[0].id;
        await q(`update public.athlete_memberships set status = 'archived', archived_at = $2, updated_at = now() where id = $1`, [id, `${addDays(DAY, -1)}T00:00:00Z`]);
      }
      const cookie = s.admin ? (await fx.clubAdminOf(x.clubId, `k2c2 eq admin ${uid()}`)).cookie : x.coach.cookie;
      const tid = await typeId({ clubId: x.clubId });
      let r;
      if (via === "attach") {
        const made = await api("/api/calendar/events", { method: "POST", cookie, body: { ...createBody(x, { eventTypeId: tid, targets: s.targets(x), noSessions: true }) } });
        assert.equal(made.status, 201, `${s.label}: ${made.text}`);
        r = await api(`/api/calendar/events/${made.body.event.id}/sessions`, { method: "POST", cookie, body: { requestKey: newKey(), expectedRevision: 1, logicalSessionIds: x.ids, alignSessions: false } });
      } else {
        r = await api("/api/calendar/events", { method: "POST", cookie, body: createBody(x, { eventTypeId: tid, targets: s.targets(x) }) });
      }
      outcome.push({ ok: r.status < 300, error: r.body.error ?? null, count: r.body.count ?? null, attached: r.body.attached ?? null, status: r.status });
    }
    const [attach, made] = outcome;
    assert.deepEqual({ ok: made.ok, error: made.error, count: made.count, attached: made.attached }, { ok: attach.ok, error: attach.error, count: attach.count, attached: attach.attached }, `${s.label}: ${JSON.stringify(outcome)}`);
  }
});

// ---------------------------------------------------------------------------
// 6. Races
// ---------------------------------------------------------------------------
// Polls until `check()` is true, or fails after `ms` (never a fixed sleep as
// the proof of a wait: code-reviewer LOW on 7050b1cb).
async function waitFor(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}
// A backend of this test's database waits on a lock while running a statement like `pattern`.
async function lockWaitOn(pattern) {
  return (await q(
    `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike $1`,
    [pattern],
  ))[0].n > 0;
}
function within(promise, ms, onTimeout) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(new Error(`no answer within ${ms} ms`)); }, ms); })])
    .finally(() => clearTimeout(timer));
}

// Waits for the seam, or fails at once when the command ended before it (a
// mutant refused early must fail the test, never hang it).
async function reachedOrEnded(g, pending) {
  await Promise.race([g.reachedP, pending.then((r) => { throw new Error(`the command ended before the seam: ${r?.res?.text ?? r?.text ?? ""}`); })]);
}
function gate() {
  let open;
  let reached;
  const opened = new Promise((resolve) => { open = resolve; });
  const reachedP = new Promise((resolve) => { reached = resolve; });
  return { open, reached, opened, reachedP };
}

test("6. a create and an attach of the same slot to another event, in both orders: one wins, the other is session_already_attached, never two live links", async () => {
  // (a) The create holds after its locks and checks; the attach commits; the create's INSERT meets the unique index.
  const w = await teamWorld("race a", { n: 1 });
  const other = (await create(w, { noSessions: true })).res.body.event;
  const g = gate();
  hooks.afterSessionLocks = async () => { g.reached(); await g.opened; };
  let pending;
  try {
    pending = create(w);
    await reachedOrEnded(g, pending);
    const attach = await api(`/api/calendar/events/${other.id}/sessions`, { method: "POST", cookie: w.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, logicalSessionIds: w.ids, alignSessions: false } });
    assert.equal(attach.status, 200, attach.text);
  } finally {
    delete hooks.afterSessionLocks;
    g.open();
  }
  const { body, res } = await pending;
  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.error, "session_already_attached");
  assert.deepEqual(await counts(body.title), NOTHING);
  assert.deepEqual((await liveLinks(w.ids)).map((l) => l.event_id), [other.id]);

  // (b) The attach holds after its INSERT (uncommitted); the create waits on the unique index, then refuses.
  const w2 = await teamWorld("race b", { n: 1 });
  const other2 = (await create(w2, { noSessions: true })).res.body.event;
  const g2 = gate();
  hooks.beforeRequestRow = async ({ operation }) => {
    if (operation === "attach_sessions") { g2.reached(); await g2.opened; }
  };
  let attachPending;
  let created;
  try {
    attachPending = api(`/api/calendar/events/${other2.id}/sessions`, { method: "POST", cookie: w2.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, logicalSessionIds: w2.ids, alignSessions: false } });
    await reachedOrEnded(g2, attachPending);
    const createPending = create(w2);
    // The create must really wait on the unique index behind the attach's uncommitted link.
    await waitFor(() => lockWaitOn("%insert into calendar.event_session_links%"), 5000, "the create waiting on the slot's unique index");
    g2.open();
    created = await createPending;
  } finally {
    delete hooks.beforeRequestRow;
    g2.open();
  }
  assert.equal((await attachPending).status, 200);
  assert.equal(created.res.status, 409, created.res.text);
  assert.equal(created.res.body.error, "session_already_attached");
  assert.deepEqual(await counts(created.body.title), NOTHING);
  assert.deepEqual((await liveLinks(w2.ids)).map((l) => l.event_id), [other2.id]);
});

test("6b. a detach of the slot from another event: before its COMMIT the create is session_already_attached, after it the create links", async () => {
  const w = await teamWorld("race detach", { n: 1 });
  const other = (await create(w)).res.body.event;
  const linkIds = (await api(`/api/calendar/events/${other.id}`, { cookie: w.coach.cookie })).body.event.sessionLinks.map((l) => l.id);
  const g = gate();
  hooks.beforeRequestRow = async ({ operation }) => {
    if (operation === "detach_sessions") { g.reached(); await g.opened; }
  };
  let detaching;
  let during;
  try {
    detaching = api(`/api/calendar/events/${other.id}/sessions/detach`, { method: "POST", cookie: w.coach.cookie, body: { requestKey: newKey(), expectedRevision: 1, linkIds } });
    await reachedOrEnded(g, detaching);
    during = await create(w);
  } finally {
    delete hooks.beforeRequestRow;
    g.open();
  }
  assert.equal((await detaching).status, 200);
  assert.equal(during.res.status, 409, during.res.text);
  assert.equal(during.res.body.error, "session_already_attached");
  const afterwards = await create(w);
  assert.equal(afterwards.res.status, 201, afterwards.res.text);
  assert.deepEqual((await liveLinks(w.ids)).map((l) => l.event_id), [afterwards.res.body.event.id]);
});

test("6c. a Builder transaction holding the plan FOR UPDATE: the create waits; the plan deleted under it is session_not_available; a foreign plan held is refused without waiting", async () => {
  const w = await teamWorld("race builder", { n: 1 });
  const holder = new pg.Client({ connectionString: env.db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select id from plans.plans where id = $1 for update`, [w.sessions[0].planId]);
    const pending = create(w);
    await waitFor(() => lockWaitOn("%from plans.plans where id = any%for share%"), 5000, "the create waiting on the plan lock");
    await holder.query(`delete from plans.plans where id = $1`, [w.sessions[0].planId]);
    await holder.query("commit");
    const { body, res } = await pending;
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.error, "session_not_available");
    assert.deepEqual(await counts(body.title), NOTHING);

    // A plan outside the owner's tree, held FOR UPDATE: decided on the unlocked read, no wait.
    const sibling = await fx.makeTeam(m.clubs.c1, "k2c2 foreign held");
    const w2 = await teamWorld("race foreign", { n: 1 });
    const foreign = await planSession({ athleteId: w2.athletes[0].athleteId, owner: { scope: "team", id: sibling }, coachUserId: w2.coach.id, name: "Foreign" });
    await holder.query("begin");
    await holder.query(`select id from plans.plans where id = $1 for update`, [foreign.planId]);
    const t0 = Date.now();
    const refused = await create(w2, { sessions: { logicalSessionIds: [foreign.logicalSessionId] } });
    assert.ok(Date.now() - t0 < 3000, "no wait on a plan the caller may not link");
    assert.equal(refused.res.status, 400, refused.res.text);
    assert.equal(refused.res.body.error, "session_not_available");
    await holder.query("rollback");
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
});

test("6d. a create with sessions and a Day off of the same club and day, each held while the other runs: both settle, no 40P01", async () => {
  const club = await fx.makeClub("k2c2 dayoff race");
  await switchOn(club);
  for (const first of ["sessions", "dayoff"]) {
    const w = await teamWorld(`dayoff race ${first}`, { clubId: club, n: 1 });
    const dayOff = () => create(w, { noSessions: true, kind: "day_off", title: `Rest ${uid()}`, questions: [] });
    const g = gate();
    let heldOnce = false;
    const hold = async () => {
      if (heldOnce) return;
      heldOnce = true;
      g.reached();
      await g.opened;
    };
    let a;
    let b;
    try {
      if (first === "sessions") {
        hooks.afterSessionLocks = hold;
        const pending = create(w);
        await reachedOrEnded(g, pending);
        const other = dayOff();
        // The Day off either waits on a lock the held create owns, or finishes; both are fine, a 40P01 is not.
        await within(Promise.race([other, waitFor(() => lockWaitOn("%"), 5000, "a lock wait").catch(() => {})]), 6000, () => g.open());
        g.open();
        [a, b] = await Promise.all([pending, other]);
      } else {
        hooks.beforeRequestRow = async ({ operation }) => { if (operation === "create") await hold(); };
        const pending = dayOff();
        await reachedOrEnded(g, pending);
        const other = create(w);
        await within(Promise.race([other, waitFor(() => lockWaitOn("%"), 5000, "a lock wait").catch(() => {})]), 6000, () => g.open());
        g.open();
        [a, b] = await Promise.all([pending, other]);
      }
    } finally {
      delete hooks.afterSessionLocks;
      delete hooks.beforeRequestRow;
      g.open();
    }
    for (const { res } of [a, b]) assert.equal(res.status, 201, `${first}: ${res.text}`);
  }
});

test("6e. a lock timeout on the plan lock is 409 try_again and nothing is written", async () => {
  const w = await teamWorld("lock timeout", { n: 1 });
  const holder = new pg.Client({ connectionString: env.db.url });
  await holder.connect();
  try {
    await holder.query("begin");
    await holder.query(`select id from plans.plans where id = $1 for update`, [w.sessions[0].planId]);
    hooks.beforeLocks = async ({ client }) => { await client.query(`set local lock_timeout = '200ms'`); };
    let out;
    try {
      out = await create(w);
    } finally {
      delete hooks.beforeLocks;
    }
    assert.equal(out.res.status, 409, out.res.text);
    assert.equal(out.res.body.error, "try_again");
    assert.deepEqual(await counts(out.body.title), NOTHING);
  } finally {
    await holder.query("rollback").catch(() => {});
    await holder.end();
  }
});

// ---------------------------------------------------------------------------
// 7. The recorded SQL order (.claude/rules/migrations.md)
// ---------------------------------------------------------------------------
test("7. the recorded SQL of a create with sessions: writer lock, type, the switch, the plans ascending, the sessions again, the day keys, then the first write; no locking clause after it; the links after the targets", async () => {
  const club = await fx.makeClub("k2c2 order");
  await switchOn(club);
  for (const kind of ["training", "day_off"]) {
    const w = await teamWorld(`order ${kind}`, { clubId: club, n: 3 });
    const calls = recordSql();
    let res;
    try {
      ({ res } = await create(w, { kind, questions: kind === "training" ? [{ kind: "wellness", window: { kind: "next_morning" } }] : [] }));
    } finally {
      delete hooks.beforeLocks;
    }
    assert.equal(res.status, 201, `${kind}: ${res.text}`);
    const texts = calls.map((c) => c.text);
    const firstWrite = texts.findIndex(isWrite);
    assert.ok(firstWrite > 0, kind);
    const locksAfter = texts.slice(firstWrite).filter(isLock).filter((s) => !/requests? where performed_by_user_id/.test(s));
    assert.deepEqual(locksAfter, [], `${kind}: no locking clause after the first write`);
    const planLock = texts.findIndex((s) => /from plans\.plans where id = any\(\$1::uuid\[\]\) order by id for share/.test(s));
    const sessionReads = texts.map((s, i) => (/from plans\.plan_sessions ps/.test(s) && /as targeted/.test(s) ? i : -1)).filter((i) => i >= 0);
    const order = [
      texts.findIndex((s) => /lock_event_writer/.test(s)),
      texts.findIndex((s) => /from calendar\.event_types t[\s\S]*for share of t/.test(s)),
      texts.findIndex((s) => /club_question_settings[\s\S]*for share/.test(s)),
      sessionReads[0],
      planLock,
      sessionReads[1],
      texts.findIndex((s) => /wellness_day_key/.test(s)),
      firstWrite,
    ];
    assert.ok(order.every((i) => i >= 0), `${kind}: ${JSON.stringify(order)}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${kind}: the contract's order`);
    const planIds = calls[planLock].params[0];
    assert.deepEqual(planIds, [...planIds].sort(), "the plans in ascending id");
    const eventInsert = texts.findIndex((s) => /insert into calendar\.events\b/.test(s));
    const targetsInsert = texts.findIndex((s) => /insert into calendar\.event_targets/.test(s));
    const linksInsert = texts.findIndex((s) => /insert into calendar\.event_session_links/.test(s));
    assert.ok(eventInsert < targetsInsert && targetsInsert < linksInsert, `${kind}: event, targets, then links (${eventInsert}, ${targetsInsert}, ${linksInsert})`);
  }
});

// ---------------------------------------------------------------------------
// 8. The db-reviewer's round (MEDIUM-1, MEDIUM-2)
// ---------------------------------------------------------------------------
test("8. a create with sessions and the Training Load quick toggle of the same session at once, in both orders: both settle, no 40P01", async () => {
  for (const first of ["create", "toggle"]) {
    const w = await teamWorld(`toggle ${first}`, { n: 1 });
    const holder = gate();
    const toggle = () => api(`/api/training-load/sessions/${w.sessions[0].sessionId}/rpe-enabled`, { method: "PATCH", cookie: w.coach.cookie, body: { rpeEnabled: false, confirmDisableWithResults: true } });
    let created;
    let toggled;
    if (first === "create") {
      // The create holds the plan FOR SHARE (after its session locks) while the toggle locks the session row.
      hooks.afterSessionLocks = async () => { holder.reached(); await holder.opened; };
      try {
        const pending = create(w);
        await reachedOrEnded(holder, pending);
        toggled = await within(toggle(), 5000, () => holder.open());
        holder.open();
        created = await pending;
      } finally {
        delete hooks.afterSessionLocks;
        holder.open();
      }
    } else {
      [toggled, created] = await Promise.all([toggle(), create(w)]);
    }
    assert.equal(toggled.status, 200, `${first}: ${toggled.text}`);
    assert.equal(created.res.status, 201, `${first}: ${created.res.text}`);
    assert.equal((await liveLinks(w.ids)).length, 1);
    assert.equal((await q(`select rpe_enabled from plans.plan_sessions where id = $1`, [w.sessions[0].sessionId]))[0].rpe_enabled, false);
  }
});

test("8b. sessions with no targets are refused by the body (invalid_targets) before any session is read; nothing is written", async () => {
  const w = await teamWorld("no targets", { n: 1 });
  const tid = await typeId({ clubId: w.clubId });
  const calls = recordSql();
  let res;
  const body = { ...createBody(w, { eventTypeId: tid }), targets: [] };
  try {
    res = await api("/api/calendar/events", { method: "POST", cookie: w.coach.cookie, body });
  } finally {
    delete hooks.beforeLocks;
  }
  assert.equal(res.status, 400, res.text);
  assert.equal(res.body.error, "invalid_targets");
  assert.equal(calls.length, 0, "refused before the transaction's locks");
  assert.deepEqual(await counts(body.title), NOTHING);
});
