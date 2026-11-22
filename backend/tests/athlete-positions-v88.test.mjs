// v88 (docs/ai/athlete-positions-plan.md): the list of positions, an athlete's position, and their database guards.
// The real app over HTTP on a disposable database migrated by the calendar fixture plus v88; invented people only.
// Nothing touches OPTIMOVE or any persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { calendarMigrations, calendarRoleMatrix, newKey, startCalendarApp } from "./support/calendar-fixture.mjs";

export const V88 = "202611221000_athletes_v88_positions.sql";
let env;
let q;
let api;
let fx;
let m;
const R = "/api/positions";
const NOT_FOUND = { error: "notFound", message: "Not found." };

before(async () => {
  env = await startCalendarApp({ label: "pos88", migrations: [...calendarMigrations(), V88] });
  ({ q, api, fx } = env);
  m = await calendarRoleMatrix(env, "pos88");
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
  assert.ok(club.body.positions.every((p) => p.ownerScope !== "system" || p.editable === false));
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

test("4. names: one live name per owner (case-insensitive), an archived one frees it; a club may not edit a system position; a coach writes nothing", async () => {
  const a = await post("clubAdmin", "", { requestKey: newKey(), name: "Sweeper" });
  assert.equal(a.status, 200);
  const dup = await post("clubAdmin", "", { requestKey: newKey(), name: "sweeper" });
  assert.deepEqual([dup.status, dup.body.error], [409, "name_taken"]);
  // Another club may use the same name.
  assert.equal((await post("stranger", "", { requestKey: newKey(), name: "Sweeper" })).status, 200);
  await post("clubAdmin", `/${a.body.position.id}/archive`, { requestKey: newKey() });
  assert.equal((await post("clubAdmin", "", { requestKey: newKey(), name: "Sweeper" })).status, 200);
  const gk = await systemId("Goalkeeper");
  assert.equal((await post("clubAdmin", `/${gk}/rename`, { requestKey: newKey(), name: "Keeper", expectedName: "Goalkeeper" })).status, 404);
  assert.equal((await post("teamCoach", "", { requestKey: newKey(), name: "Libero" })).status, 404);
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
  const otherTeamCoach = await fx.coachOf(m.teams.t2, "pos88 coach T2");
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
