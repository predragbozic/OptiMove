// v87 (docs/ai/athlete-positions-plan.md): the list of positions, an athlete's position, and their database guards.
// The real app over HTTP on a disposable database migrated by the calendar fixture plus v87; invented people only.
// Nothing touches OPTIMOVE or any persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { calendarMigrations, calendarRoleMatrix, newKey, startCalendarApp } from "./support/calendar-fixture.mjs";

export const V87 = "202611221200_athletes_v87_positions.sql";
let env;
let q;
let api;
let fx;
let m;
const R = "/api/positions";
const NOT_FOUND = { error: "notFound", message: "Not found." };

before(async () => {
  env = await startCalendarApp({ label: "pos87", migrations: [...calendarMigrations(), V87] });
  ({ q, api, fx } = env);
  m = await calendarRoleMatrix(env, "pos87");
});
after(async () => {
  if (env) await env.stop();
});

const role = (name) => m.roles[name];
const post = (who, path, body) => api(`${R}${path}`, { method: "POST", cookie: role(who).cookie, body });
const put = (who, athleteId, body) => api(`${R}/athletes/${athleteId}`, { method: "PUT", cookie: (typeof who === "string" ? role(who) : who).cookie, body });

async function raw(fn) {
  const c = new pg.Client({ connectionString: env.db.url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.query("rollback").catch(() => {});
    await c.end();
  }
}
const asActor = (c, userId) => c.query(`select set_config('optimove.position_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [userId]);
async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return "no refusal";
}
const systemId = async (name) => (await q(`select id from public.sport_positions where owner_scope = 'system' and name = $1`, [name]))[0].id;

test("1. the seed: Football and its six system positions in order, no log row, nothing else", async () => {
  const rows = await q(`select p.name, p.owner_scope, p.archived_at, s.name as sport from public.sport_positions p join public.sports s on s.id = p.sport_id order by p.sort_order`);
  assert.deepEqual(rows.map((r) => r.name), ["Goalkeeper", "Centre back", "Full back", "Midfielder", "Winger", "Forward"]);
  assert.ok(rows.every((r) => r.owner_scope === "system" && r.archived_at === null && r.sport === "Football"));
  assert.equal((await q(`select count(*)::int as n from public.athlete_positions`))[0].n, 0);
});

test("2. who reads the list: coaches of a club or team see the system positions and their club's; the platform the system's; an athlete gets the identical 404", async () => {
  const platform = await api(R, { cookie: role("platformAdmin").cookie });
  assert.equal(platform.status, 200, platform.text);
  assert.equal(platform.body.canAdd, "system");
  assert.equal(platform.body.positions.length, 6);
  const club = await api(R, { cookie: role("clubAdmin").cookie });
  assert.equal(club.body.canAdd, "club");
  // A club's admin renames or hides a default for the club only; never archives it.
  assert.ok(club.body.positions.filter((p) => p.ownerScope === "system").every((p) => JSON.stringify(p.actions) === JSON.stringify(["rename", "hide"])));
  assert.ok(platform.body.positions.every((p) => p.actions.includes("archive")));
  const coach = await api(R, { cookie: role("teamCoach").cookie });
  assert.equal(coach.status, 200);
  assert.equal(coach.body.canAdd, null);
  const athlete = await api(R, { cookie: m.athletes.athlete.cookie });
  assert.deepEqual([athlete.status, athlete.body], [404, NOT_FOUND]);
  assert.match(athlete.cacheControl ?? "", /no-store/);
});

test("3. a club adds, renames, archives and restores its own position; another club never sees it; the log holds each change", async () => {
  const created = await post("clubAdmin", "", { requestKey: newKey(), name: "  Pivot  " });
  assert.equal(created.status, 200, created.text);
  const id = created.body.position.id;
  assert.deepEqual([created.body.position.name, created.body.position.ownerScope, created.body.position.active], ["Pivot", "club", true]);
  const other = await api(R, { cookie: role("stranger").cookie });
  assert.ok(!other.body.positions.some((p) => p.id === id), "another club never sees it");
  assert.equal((await post("stranger", `/${id}/rename`, { requestKey: newKey(), name: "X", expectedName: "Pivot" })).status, 404);
  const renamed = await post("clubAdmin", `/${id}/rename`, { requestKey: newKey(), name: "Holding mid", expectedName: "Pivot" });
  assert.equal(renamed.body.position.name, "Holding mid");
  const stale = await post("clubAdmin", `/${id}/rename`, { requestKey: newKey(), name: "Y", expectedName: "Pivot" });
  assert.deepEqual([stale.status, stale.body.error], [409, "name_changed"]);
  assert.equal((await post("clubAdmin", `/${id}/archive`, { requestKey: newKey() })).body.position.active, false);
  assert.equal((await post("clubAdmin", `/${id}/archive`, { requestKey: newKey() })).body.error, "position_archived");
  assert.equal((await post("clubAdmin", `/${id}/restore`, { requestKey: newKey() })).body.position.active, true);
  const log = await q(`select action, old_name, new_name, basis from public.sport_position_changes where position_id = $1 order by created_at`, [id]);
  assert.deepEqual(log.map((r) => r.action), ["create", "rename", "archive", "restore"]);
  assert.ok(log.every((r) => r.basis === "club_admin"));
});

test("4. names: one live name per owner (case-insensitive), an archived one frees it; a club may not archive a default; a coach writes nothing", async () => {
  const a = await post("clubAdmin", "", { requestKey: newKey(), name: "Sweeper" });
  assert.equal(a.status, 200);
  const dup = await post("clubAdmin", "", { requestKey: newKey(), name: "sweeper" });
  assert.deepEqual([dup.status, dup.body.error], [409, "name_taken"]);
  // Another club may use the same name.
  assert.equal((await post("stranger", "", { requestKey: newKey(), name: "Sweeper" })).status, 200);
  await post("clubAdmin", `/${a.body.position.id}/archive`, { requestKey: newKey() });
  assert.equal((await post("clubAdmin", "", { requestKey: newKey(), name: "Sweeper" })).status, 200);
  const gk = await systemId("Goalkeeper");
  assert.equal((await post("clubAdmin", `/${gk}/archive`, { requestKey: newKey() })).status, 404);
  assert.equal((await post("platformAdmin", `/${gk}/hide`, { requestKey: newKey() })).status, 404, "hide is a club's own view");
  assert.equal((await post("teamCoach", "", { requestKey: newKey(), name: "Libero" })).status, 404);
  assert.equal((await post("teamCoach", `/${gk}/hide`, { requestKey: newKey() })).status, 404);
  for (const [body, code] of [[{ requestKey: "x", name: "A" }, "invalid_request_key"], [{ requestKey: newKey(), name: "" }, "invalid_name"],
    [{ requestKey: newKey(), name: "x".repeat(61) }, "invalid_name"], [{ requestKey: newKey(), name: "A", ownerScope: "system" }, "invalid_body"]]) {
    const r = await post("clubAdmin", "", body);
    assert.deepEqual([r.status, r.body.error], [400, code]);
  }
});

test("5. the request key: the same key and body is the saved answer (nothing written twice); another body is request_key_reused", async () => {
  const key = newKey();
  const first = await post("platformAdmin", "", { requestKey: key, name: "Second striker" });
  const again = await post("platformAdmin", "", { requestKey: key, name: "Second striker" });
  assert.equal(again.status, 200);
  assert.equal(again.body.position.id, first.body.position.id);
  assert.equal(again.body.replayed, true);
  assert.equal((await q(`select count(*)::int as n from public.sport_positions where name = 'Second striker'`))[0].n, 1);
  const reused = await post("platformAdmin", "", { requestKey: key, name: "Other" });
  assert.deepEqual([reused.status, reused.body.error], [409, "request_key_reused"]);
});

test("6. an athlete's position: the club's admin and the team's coach set it; the athletes list shows it; stale and unchanged answers; another club and an athlete outside the team get the 404", async () => {
  const athleteId = m.athletes.athlete.athleteId;
  const mid = await systemId("Midfielder");
  const fw = await systemId("Forward");
  const set = await put("clubAdmin", athleteId, { requestKey: newKey(), positionId: mid, expectedPositionId: null });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.body.positionId, mid);
  const list = await api(`${R}/athletes`, { cookie: role("teamCoach").cookie });
  assert.deepEqual(list.body.assignments.find((a) => a.athleteId === athleteId), { athleteId, positionId: mid });
  const stale = await put("teamCoach", athleteId, { requestKey: newKey(), positionId: fw, expectedPositionId: null });
  assert.deepEqual([stale.status, stale.body.error, stale.body.current], [409, "position_changed", { positionId: mid }]);
  const byCoach = await put("teamCoach", athleteId, { requestKey: newKey(), positionId: fw, expectedPositionId: mid });
  assert.equal(byCoach.body.positionId, fw);
  const same = await put("teamCoach", athleteId, { requestKey: newKey(), positionId: fw, expectedPositionId: fw });
  assert.equal(same.body.unchanged, true);
  const rows = await q(`select position_id, basis, via_team_id from public.athlete_positions where athlete_id = $1 order by seq`, [athleteId]);
  assert.deepEqual(rows.map((r) => [r.position_id, r.basis, r.via_team_id]), [[mid, "club_admin", null], [fw, "team_coach", m.teams.t1]]);
  // Another club's admin, a coach of another team of the club, an athlete, the platform workspace: the identical 404.
  const otherTeamCoach = await fx.coachOf(m.teams.t2, "pos87 coach T2");
  for (const who of [role("stranger"), otherTeamCoach, m.athletes.athlete, role("platformAdmin"), role("revokedAdmin")]) {
    const r = await put(who, athleteId, { requestKey: newKey(), positionId: mid, expectedPositionId: fw });
    assert.deepEqual([r.status, r.body], [404, NOT_FOUND], JSON.stringify(r.body));
  }
  // A missing athlete is the same 404.
  assert.deepEqual((await put("clubAdmin", crypto.randomUUID(), { requestKey: newKey(), positionId: mid, expectedPositionId: null })).body, NOT_FOUND);
  // Clearing: a row with no position.
  const cleared = await put("clubAdmin", athleteId, { requestKey: newKey(), positionId: null, expectedPositionId: fw });
  assert.equal(cleared.body.positionId, null);
  assert.equal((await q(`select public.athlete_position_in_force($1, $2) as p`, [athleteId, m.clubs.c1]))[0].p, null);
});

test("7. only a position offered to the club: another club's own position and an archived one are refused, nothing written", async () => {
  const athleteId = m.athletes.athlete.athleteId;
  const foreign = (await post("stranger", "", { requestKey: newKey(), name: "Foreign role" })).body.position.id;
  const archived = (await post("clubAdmin", "", { requestKey: newKey(), name: "Old role" })).body.position.id;
  await post("clubAdmin", `/${archived}/archive`, { requestKey: newKey() });
  const before = (await q(`select count(*)::int as n from public.athlete_positions`))[0].n;
  for (const positionId of [foreign, archived, crypto.randomUUID()]) {
    const r = await put("clubAdmin", athleteId, { requestKey: newKey(), positionId, expectedPositionId: null });
    assert.deepEqual([r.status, r.body.error], [409, "position_not_offered"]);
  }
  assert.equal((await q(`select count(*)::int as n from public.athlete_positions`))[0].n, before);
});

test("8. the database guards: no write without the acting user, a wrong basis or right, a forged creator; never a delete, an update of history, or a change without its log row", async () => {
  const admin = role("clubAdmin");
  const gk = await systemId("Goalkeeper");
  const athleteId = m.athletes.athlete.athleteId;
  // No acting user.
  assert.equal(await raw(async (c) => { await c.query("begin"); return refusal(c.query(`update public.sport_positions set name = 'X' where id = $1`, [gk])); }), "42501");
  // A club admin may not write a system position, even with its log row.
  assert.equal(await raw(async (c) => {
    await c.query("begin");
    await asActor(c, admin.id);
    return refusal(c.query(`update public.sport_positions set name = 'X' where id = $1`, [gk]));
  }), "42501");
  // A change without its log row is refused at COMMIT.
  assert.equal(await raw(async (c) => {
    await c.query("begin");
    await asActor(c, role("platformAdmin").id);
    await c.query(`update public.sport_positions set sort_order = 11 where id = $1`, [gk]);
    return refusal(c.query("commit"));
  }), "23514");
  // Never deleted.
  assert.equal(await raw(async (c) => { await c.query("begin"); return refusal(c.query(`delete from public.sport_positions where id = $1`, [gk])); }), "23514");
  // An athlete's position: the row names the actor, the basis must be the actor's right, history is append-only.
  const insert = (c, { by, basis = "club_admin", team = null, club = m.clubs.c1 }) => c.query(
    `insert into public.athlete_positions (athlete_id, club_id, position_id, set_by_user_id, basis, via_team_id, request_key, request_hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`, [athleteId, club, gk, by, basis, team, newKey(), "a".repeat(64)]);
  assert.equal(await raw(async (c) => { await c.query("begin"); await asActor(c, admin.id); return refusal(insert(c, { by: role("teamCoach").id })); }), "42501");
  assert.equal(await raw(async (c) => { await c.query("begin"); await asActor(c, role("teamCoach").id); return refusal(insert(c, { by: role("teamCoach").id })); }), "42501");
  assert.equal(await raw(async (c) => { await c.query("begin"); await asActor(c, role("stranger").id); return refusal(insert(c, { by: role("stranger").id, club: m.clubs.c2 })); }), "42501");
  assert.equal(await raw(async (c) => { await c.query("begin"); await asActor(c, role("teamCoach").id); return refusal(insert(c, { by: role("teamCoach").id, basis: "team_coach", team: m.teams.t1 })); }), "no refusal");
  assert.equal(await raw(async (c) => { await c.query("begin"); return refusal(c.query(`update public.athlete_positions set position_id = null`)); }), "23514");
  assert.equal(await raw(async (c) => { await c.query("begin"); return refusal(c.query(`delete from public.athlete_positions`)); }), "23514");
  assert.equal(await raw(async (c) => { await c.query("begin"); return refusal(c.query(`truncate public.athlete_positions`)); }), "23514");
  assert.equal(await raw(async (c) => { await c.query("begin"); return refusal(c.query(`delete from public.sport_position_changes`)); }), "23514");
});

const names = async (who) => Object.fromEntries((await api(R, { cookie: role(who).cookie })).body.positions.map((p) => [p.id, p]));

test("9. a club's own view of the defaults: it renames and hides a default for itself only; the platform's later rename reaches only clubs without a name of their own; a hidden default is not offered, an athlete who holds it keeps it", async () => {
  const wing = await systemId("Winger");
  const cb = await systemId("Centre back");
  // The club renames Centre back; another club and the platform still see the default name.
  const renamed = await post("clubAdmin", `/${cb}/rename`, { requestKey: newKey(), name: "Stopper", expectedName: "Centre back" });
  assert.equal(renamed.status, 200, renamed.text);
  assert.deepEqual([renamed.body.position.name, renamed.body.position.defaultName], ["Stopper", "Centre back"]);
  assert.equal((await names("stranger"))[cb].name, "Centre back");
  assert.equal((await names("platformAdmin"))[cb].name, "Centre back");
  // The platform renames both defaults: the club keeps its own name for Centre back and takes the new Winger name.
  assert.equal((await post("platformAdmin", `/${cb}/rename`, { requestKey: newKey(), name: "Central defender", expectedName: "Centre back" })).status, 200);
  assert.equal((await post("platformAdmin", `/${wing}/rename`, { requestKey: newKey(), name: "Wide forward", expectedName: "Winger" })).status, 200);
  const club = await names("clubAdmin");
  assert.deepEqual([club[cb].name, club[cb].defaultName, club[wing].name], ["Stopper", "Central defender", "Wide forward"]);
  assert.equal((await names("stranger"))[cb].name, "Central defender");
  // Renaming back to the default name clears the club's own name.
  await post("clubAdmin", `/${cb}/rename`, { requestKey: newKey(), name: "Central defender", expectedName: "Stopper" });
  assert.equal((await names("clubAdmin"))[cb].defaultName, null);
  // An athlete holds Winger; the club hides it: not offered to anyone new, the athlete keeps it, another club unaffected.
  const athleteId = m.athletes.athlete.athleteId;
  const current = (await q(`select public.athlete_position_in_force($1, $2) as p`, [athleteId, m.clubs.c1]))[0].p;
  assert.equal((await put("clubAdmin", athleteId, { requestKey: newKey(), positionId: wing, expectedPositionId: current })).status, 200);
  const hidden = await post("clubAdmin", `/${wing}/hide`, { requestKey: newKey() });
  assert.deepEqual([hidden.status, hidden.body.position.hidden, hidden.body.position.active, hidden.body.position.actions], [200, true, false, ["show"]]);
  assert.equal((await q(`select public.athlete_position_in_force($1, $2) as p`, [athleteId, m.clubs.c1]))[0].p, wing, "the athlete keeps it");
  assert.equal((await names("stranger"))[wing].hidden, false);
  const fk = await fx.makeAthlete("pos87 second athlete", { clubId: m.clubs.c1, teamId: m.teams.t1 });
  const refused = await put("clubAdmin", fk.athleteId, { requestKey: newKey(), positionId: wing, expectedPositionId: null });
  assert.deepEqual([refused.status, refused.body.error], [409, "position_not_offered"]);
  // A club name may not repeat a live one: a default it shows, or its own.
  assert.equal((await post("clubAdmin", "", { requestKey: newKey(), name: "forward" })).body.error, "name_taken");
  assert.equal((await post("clubAdmin", "", { requestKey: newKey(), name: "Wide forward" })).status, 200, "the hidden default frees its name");
  assert.equal((await post("clubAdmin", `/${wing}/show`, { requestKey: newKey() })).body.error, "name_taken", "showing it again would repeat a name");
  const log = await q(`select action, club_id from public.sport_position_changes where club_id is not null order by created_at`);
  assert.deepEqual(log.map((r) => r.action), ["club_rename", "club_rename", "club_hide"]);
  assert.ok(log.every((r) => r.club_id === m.clubs.c1));
});

test("10. the override's database guards: no change without its log row, never another club's admin, never a club's own position, never deleted", async () => {
  const gk = await systemId("Goalkeeper");
  const own = (await q(`select id from public.sport_positions where owner_scope = 'club' and owner_club_id = $1 limit 1`, [m.clubs.c1]))[0].id;
  const write = (c, by, club, position) => c.query(
    `insert into public.club_position_overrides (club_id, position_id, name, updated_by_user_id) values ($1, $2, 'X', $3)
     on conflict (club_id, position_id) do update set name = 'X', updated_by_user_id = excluded.updated_by_user_id`, [club, position, by]);
  assert.equal(await raw(async (c) => { await c.query("begin"); await asActor(c, role("clubAdmin").id); await write(c, role("clubAdmin").id, m.clubs.c1, gk); return refusal(c.query("commit")); }), "23514");
  assert.equal(await raw(async (c) => { await c.query("begin"); await asActor(c, role("stranger").id); return refusal(write(c, role("stranger").id, m.clubs.c1, gk)); }), "42501");
  assert.equal(await raw(async (c) => { await c.query("begin"); await asActor(c, role("clubAdmin").id); return refusal(write(c, role("clubAdmin").id, m.clubs.c1, own)); }), "23514");
  assert.equal(await raw(async (c) => { await c.query("begin"); return refusal(c.query(`delete from public.club_position_overrides`)); }), "23514");
  // A club_* log row that does not match the override is refused.
  assert.equal(await raw(async (c) => {
    await c.query("begin");
    await asActor(c, role("clubAdmin").id);
    return refusal(c.query(`insert into public.sport_position_changes (position_id, action, old_name, new_name, performed_by_user_id, basis, request_key, request_hash, club_id)
                            values ($1, 'club_hide', 'Goalkeeper', 'Goalkeeper', $2, 'club_admin', gen_random_uuid(), $3, $4)`, [gk, role("clubAdmin").id, "d".repeat(64), m.clubs.c1]));
  }), "23514");
});

test("12. one club's list is changed one write at a time: two admins renaming a default for the first time at once - one saves, the other is name_changed; a create and a rename to the same name at once - one is name_taken", async () => {
  const svc = await import("../src/positionService.js");
  const fb = await systemId("Full back");
  const second = await fx.clubAdminOf(m.clubs.c1, "pos87 second admin C1");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered;
  const inside = new Promise((resolve) => { entered = resolve; });
  svc.testHooks.beforeCommit = async () => { entered(); await held; };
  const a = post("clubAdmin", `/${fb}/rename`, { requestKey: newKey(), name: "Wing back", expectedName: "Full back" });
  await inside;
  delete svc.testHooks.beforeCommit;
  const b = api(`${R}/${fb}/rename`, { method: "POST", cookie: second.cookie, body: { requestKey: newKey(), name: "Side back", expectedName: "Full back" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200, ra.text);
  assert.deepEqual([rb.status, rb.body.error], [409, "name_changed"]);
  assert.equal((await names("clubAdmin"))[fb].name, "Wing back");
  // A create and a rename to one name at once.
  const md = await systemId("Midfielder");
  let release2;
  const held2 = new Promise((resolve) => { release2 = resolve; });
  let entered2;
  const inside2 = new Promise((resolve) => { entered2 = resolve; });
  svc.testHooks.beforeCommit = async () => { entered2(); await held2; };
  const c = post("clubAdmin", "", { requestKey: newKey(), name: "Regista" });
  await inside2;
  delete svc.testHooks.beforeCommit;
  const d = api(`${R}/${md}/rename`, { method: "POST", cookie: second.cookie, body: { requestKey: newKey(), name: "Regista", expectedName: "Midfielder" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  release2();
  const [rc, rd] = await Promise.all([c, d]);
  assert.deepEqual([rc.status, rd.status, rd.body.error], [200, 409, "name_taken"]);
});

test("13. each layer on its own (the Nezavisni revizor's MEDIUM-1): the database refuses a coach for an athlete outside the coach's team; the service refuses an athlete outside the workspace's team; a replay answers only the owner it was made for", async () => {
  const gk = await systemId("Goalkeeper");
  // (a) The database: an active coach of t1, an athlete of the club with no membership in t1 -> 42501.
  const clubOnly = await fx.makeAthlete("pos87 club-only athlete", { clubId: m.clubs.c1 });
  const coach = role("teamCoach");
  const rawSet = (athleteId) => raw(async (c) => {
    await c.query("begin");
    await asActor(c, coach.id);
    return refusal(c.query(
      `insert into public.athlete_positions (athlete_id, club_id, position_id, set_by_user_id, basis, via_team_id, request_key, request_hash)
       values ($1, $2, $3, $4, 'team_coach', $5, $6, $7)`, [athleteId, m.clubs.c1, gk, coach.id, m.teams.t1, newKey(), "e".repeat(64)]));
  });
  assert.equal(await rawSet(clubOnly.athleteId), "42501", "no team membership: refused");
  assert.equal(await rawSet(m.athletes.athlete.athleteId), "no refusal", "a member of t1: allowed");
  // (b) The service's own check of the workspace's athletes is defence in depth: in every reachable state it asks what the
  // database asks (a team workspace exists only for the team's coach, whose basis needs a membership in that team), and
  // (a) proves the database on its own. Through the route, the coach of t2 is refused an athlete of t1 alone.
  const coachT2 = await fx.coachOf(m.teams.t2, "pos87 coach T2 layers");
  const outside = await put(coachT2, m.athletes.athlete.athleteId, { requestKey: newKey(), positionId: gk, expectedPositionId: null });
  assert.deepEqual([outside.status, outside.body], [404, NOT_FOUND]);
  // (c) A replay answers only the owner the change was made for: the admin of two clubs, the same key from c2's workspace.
  const two = role("twoClubAdmin");
  const key = newKey();
  assert.equal((await post("twoClubAdmin", "", { requestKey: key, name: "Two club pivot" })).status, 200);
  await fx.setWorkspace(two.id, "club", m.clubs.c2);
  try {
    const other = await post("twoClubAdmin", "", { requestKey: key, name: "Two club pivot" });
    assert.deepEqual([other.status, other.body], [404, NOT_FOUND]);
  } finally {
    await fx.setWorkspace(two.id, "club", m.clubs.c1);
  }
});

test("11. the bounded COMMIT: a COMMIT that never answers is 503 outcome_unknown with nothing saved; the same key then saves once. A revoked admin's replay is the 404", async () => {
  const svc = await import("../src/positionService.js");
  const key = newKey();
  svc.testHooks.commit = () => new Promise(() => {});
  svc.testHooks.commitTimeoutMs = 200;
  let lost;
  try {
    lost = await post("clubAdmin", "", { requestKey: key, name: "Lost answer" });
  } finally {
    delete svc.testHooks.commit;
    delete svc.testHooks.commitTimeoutMs;
  }
  assert.deepEqual([lost.status, lost.body.error], [503, "outcome_unknown"]);
  const again = await post("clubAdmin", "", { requestKey: key, name: "Lost answer" });
  assert.equal(again.status, 200, again.text);
  const replay = await post("clubAdmin", "", { requestKey: key, name: "Lost answer" });
  assert.equal(replay.body.replayed, true);
  assert.equal((await q(`select count(*)::int as n from public.sport_positions where name = 'Lost answer'`))[0].n, 1);
  // The right is gone: the same key is the 404, never the saved answer.
  const admin2 = await fx.clubAdminOf(m.clubs.c1, "pos87 admin later revoked");
  const k2 = newKey();
  assert.equal((await api(R, { method: "POST", cookie: admin2.cookie, body: { requestKey: k2, name: "Before revoke" } })).status, 200);
  await q(`update public.user_club_roles set is_active = false where user_id = $1`, [admin2.id]);
  const revoked = await api(R, { method: "POST", cookie: admin2.cookie, body: { requestKey: k2, name: "Before revoke" } });
  assert.deepEqual([revoked.status, revoked.body], [404, NOT_FOUND]);
});
