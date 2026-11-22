// ST-1 (docs/ai/session-type-plan.md, migration v85): the editable list of session types and its database guards.
// The real app over HTTP on a disposable database migrated by the calendar fixture (v85 included); invented people
// only. Nothing touches OPTIMOVE or any persistent database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { calendarRoleMatrix, newKey, startCalendarApp } from "./support/calendar-fixture.mjs";

let env;
let q;
let api;
let fx;
let m;
const R = "/api/training-activity/session-types";
const NOT_FOUND = { error: "notFound", message: "Not found." };

before(async () => {
  env = await startCalendarApp({ label: "st1" });
  ({ q, api, fx } = env);
  m = await calendarRoleMatrix(env, "st1");
});
after(async () => {
  if (env) await env.stop();
});

const role = (name) => m.roles[name];
const post = (who, path, body) => api(`${R}${path}`, { method: "POST", cookie: role(who).cookie, body });

// A raw client on the disposable database, for the guards (writes outside the routes).
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
const asActor = (c, userId) => c.query(`select set_config('optimove.session_type_actor', $1 || ':' || pg_current_xact_id()::text, true)`, [userId]);
async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    return error.code;
  }
  return "no refusal";
}
async function activityOf({ teamId = null, clubId = null, typeKey }) {
  const scope = teamId ? "team" : clubId ? "club" : "system";
  return (await q(
    `insert into training.activities (activity_type_key, occurred_local_date, timezone_snapshot, owner_scope, owner_club_id, owner_team_id, origin)
     values ($1, '2026-11-20', 'UTC', $2, $3, $4, 'manual') returning id`, [typeKey, scope, clubId, teamId],
  ))[0].id;
}

test("1. the seed: the owner's six in order, testing and recovery archived, the v1 keys kept", async () => {
  const rows = await q(`select key, label, owner_scope, is_active, archived_by_user_id from training.activity_types order by sort_order, key`);
  assert.deepEqual(rows.filter((r) => r.is_active).map((r) => [r.key, r.label]), [
    ["training_session", "Full training"], ["match", "Game"], ["friendly_match", "Friendly game"],
    ["exercise_session", "Exercise"], ["compensation_session", "Compensation"], ["rtp_session", "RTP"],
  ]);
  assert.deepEqual(rows.filter((r) => !r.is_active).map((r) => r.key).sort(), ["recovery_session", "testing_session"]);
  assert.ok(rows.every((r) => r.owner_scope === "system" && r.archived_by_user_id === null));
});

test("2. who reads: coaches see the system types and their club's; an athlete gets the identical 404", async () => {
  const platform = await api(R, { cookie: role("platformAdmin").cookie });
  assert.equal(platform.status, 200, platform.text);
  assert.equal(platform.body.canAdd, "system");
  assert.ok(platform.body.types.find((t) => t.key === "testing_session" && t.active === false), "an archived type is listed, flagged");
  const club = await api(R, { cookie: role("clubAdmin").cookie });
  assert.equal(club.body.canAdd, "club");
  assert.ok(club.body.types.every((t) => t.ownerScope !== "system" || t.editable === false));
  const coach = await api(R, { cookie: role("teamCoach").cookie });
  assert.equal(coach.status, 200);
  assert.equal(coach.body.canAdd, null);
  const athlete = await api(R, { cookie: m.athletes.athlete.cookie });
  assert.equal(athlete.status, 404);
  assert.deepEqual(athlete.body, NOT_FOUND);
  assert.equal(athlete.cacheControl, "no-store");
});

test("3. a club admin adds a club type: generated key, one log row, replay, a reused key and a taken name refused", async () => {
  const key = newKey();
  const made = await post("clubAdmin", "", { requestKey: key, label: "Gym" });
  assert.equal(made.status, 200, made.text);
  assert.match(made.body.type.key, /^c_[0-9a-f]{8}_gym$/);
  assert.deepEqual({ ...made.body.type, key: null }, { key: null, label: "Gym", ownerScope: "club", active: true, sortOrder: 100 });
  const logRows = await q(`select action, old_label, new_label, basis, performed_by_user_id from training.activity_type_changes where type_key = $1`, [made.body.type.key]);
  assert.deepEqual(logRows, [{ action: "create", old_label: null, new_label: "Gym", basis: "club_admin", performed_by_user_id: role("clubAdmin").id }]);
  const again = await post("clubAdmin", "", { requestKey: key, label: "Gym" });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.type.key, made.body.type.key);
  assert.equal((await q(`select count(*)::int as n from training.activity_types where label = 'Gym'`))[0].n, 1);
  const reused = await post("clubAdmin", "", { requestKey: key, label: "Pool" });
  assert.equal(reused.status, 409);
  assert.equal(reused.body.error, "request_key_reused");
  const taken = await post("clubAdmin", "", { requestKey: newKey(), label: "gym" });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, "label_taken");
  const visible = await api(R, { cookie: role("teamCoach").cookie });
  assert.ok(visible.body.types.find((t) => t.key === made.body.type.key), "a coach of the club's team sees it");
});

test("4. another club never sees, renames or archives a club's type: the identical 404", async () => {
  const made = await post("clubAdmin", "", { requestKey: newKey(), label: `Hidden ${crypto.randomBytes(2).toString("hex")}` });
  const other = await api(R, { cookie: role("stranger").cookie });
  assert.ok(!other.body.types.find((t) => t.key === made.body.type.key));
  for (const path of ["rename", "archive"]) {
    const body = path === "rename" ? { requestKey: newKey(), label: "Taken over", expectedLabel: made.body.type.label } : { requestKey: newKey() };
    const foreign = await post("stranger", `/${made.body.type.key}/${path}`, body);
    const unknown = await post("stranger", `/c_00000000_nothing/${path}`, body);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.text, unknown.text, "a foreign type and an unknown one answer the same");
  }
  for (const who of ["teamCoach", "revokedAdmin", "archivedAdmin", "privateCoach"]) {
    const res = await post(who, "", { requestKey: newKey(), label: "Not mine" });
    assert.equal(res.status, 404, `${who}: ${res.text}`);
  }
});

test("5. the platform admin keeps the system list; a club admin cannot touch a system type", async () => {
  const made = await post("platformAdmin", "", { requestKey: newKey(), label: "Video session" });
  assert.equal(made.status, 200, made.text);
  assert.match(made.body.type.key, /^s_[0-9a-f]{8}_video_session$/);
  assert.equal(made.body.type.ownerScope, "system");
  const club = await post("clubAdmin", `/${made.body.type.key}/archive`, { requestKey: newKey() });
  assert.equal(club.status, 404);
  const inClub = await post("platformInClub", "", { requestKey: newKey(), label: "Club only" });
  assert.equal(inClub.body.type.ownerScope, "club", "in a club's workspace a platform admin writes as the club's admin");
});

test("6. rename (stale name refused), archive, restore: each with its log row; an archived type stays listed", async () => {
  const made = (await post("clubAdmin", "", { requestKey: newKey(), label: "Recovery run" })).body.type;
  const stale = await post("clubAdmin", `/${made.key}/rename`, { requestKey: newKey(), label: "Run", expectedLabel: "Something else" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "label_changed");
  assert.equal(stale.body.current.label, "Recovery run");
  const renamed = await post("clubAdmin", `/${made.key}/rename`, { requestKey: newKey(), label: "Easy run", expectedLabel: "Recovery run" });
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.body.type.key, made.key, "the key is the identity");
  const archived = await post("clubAdmin", `/${made.key}/archive`, { requestKey: newKey() });
  assert.equal(archived.body.type.active, false);
  const again = await post("clubAdmin", `/${made.key}/archive`, { requestKey: newKey() });
  assert.equal(again.body.error, "type_archived");
  const listed = (await api(R, { cookie: role("clubAdmin").cookie })).body.types.find((t) => t.key === made.key);
  assert.equal(listed.active, false);
  const restored = await post("clubAdmin", `/${made.key}/restore`, { requestKey: newKey() });
  assert.equal(restored.body.type.active, true);
  const log = await q(`select action, old_label, new_label from training.activity_type_changes where type_key = $1 order by created_at`, [made.key]);
  assert.deepEqual(log.map((r) => r.action), ["create", "rename", "archive", "restore"]);
  assert.deepEqual(log[1], { action: "rename", old_label: "Recovery run", new_label: "Easy run" });
  const row = (await q(`select archived_at, archived_by_user_id from training.activity_types where key = $1`, [made.key]))[0];
  assert.deepEqual(row, { archived_at: null, archived_by_user_id: null });
});

test("7. raw writes: no acting user (42501), no log row (refused at COMMIT), a delete and a key change refused", async () => {
  const admin = role("clubAdmin");
  assert.equal(await raw(async (c) => {
    await c.query("begin");
    return refusal(c.query(`insert into training.activity_types (key, label, owner_scope, owner_club_id, created_by_user_id) values ('c_0000000a_raw', 'Raw', 'club', $1, $2)`, [m.clubs.c1, admin.id]));
  }), "42501");
  assert.equal(await raw(async (c) => {
    await c.query("begin");
    await asActor(c, admin.id);
    await c.query(`insert into training.activity_types (key, label, owner_scope, owner_club_id, created_by_user_id) values ('c_0000000b_raw', 'Raw', 'club', $1, $2)`, [m.clubs.c1, admin.id]);
    return refusal(c.query("commit"));
  }), "23514");
  assert.equal(await raw(async (c) => {
    await c.query("begin");
    await asActor(c, admin.id);
    return refusal(c.query(`insert into training.activity_types (key, label, owner_scope, owner_club_id, created_by_user_id) values ('c_0000000c_raw', 'Raw', 'club', $1, $2)`, [m.clubs.c2, admin.id]));
  }), "42501", "a club admin of C1 cannot add a type to C2");
  assert.equal(await raw(async (c) => {
    await c.query("begin");
    await asActor(c, role("platformAdmin").id);
    return refusal(c.query(`delete from training.activity_types where key = 'rtp_session'`));
  }), "23514");
  assert.equal(await raw(async (c) => {
    await c.query("begin");
    await asActor(c, role("platformAdmin").id);
    return refusal(c.query(`update training.activity_types set key = 'rtp_renamed' where key = 'rtp_session'`));
  }), "23514");
  assert.equal(await raw(async (c) => {
    await c.query("begin");
    await asActor(c, role("platformAdmin").id);
    return refusal(c.query(`update training.activity_type_changes set new_label = 'x'`));
  }), "23514");
});

test("8. the owner guard (MEDIUM-2): a club's type only on its own club's activities; an archived type never newly set", async () => {
  const c1Type = (await post("clubAdmin", "", { requestKey: newKey(), label: "C1 only" })).body.type.key;
  const c2Type = (await post("stranger", "", { requestKey: newKey(), label: "C2 only" })).body.type.key;
  const ok = await activityOf({ teamId: m.teams.t1, typeKey: c1Type });
  assert.ok(ok, "a C1 type on a C1 team's activity");
  assert.equal(await refusal(activityOf({ teamId: m.teams.t1, typeKey: c2Type })), "23514", "a C2 type on a C1 team's activity");
  assert.equal(await refusal(activityOf({ clubId: m.clubs.c1, typeKey: c2Type })), "23514", "a C2 type on a C1 club activity");
  assert.equal(await refusal(activityOf({ typeKey: c1Type })), "23514", "a club type on a system activity");
  assert.equal(await refusal(q(`update training.activities set activity_type_key = $2 where id = $1`, [ok, c2Type])), "23514", "a raw UPDATE");
  assert.equal(await refusal(activityOf({ teamId: m.teams.t1, typeKey: "testing_session" })), "23514", "an archived type is never newly set");
  const kept = await activityOf({ teamId: m.teams.t1, typeKey: "training_session" });
  await post("clubAdmin", `/${c1Type}/archive`, { requestKey: newKey() });
  await q(`update training.activities set activity_type_key = activity_type_key, name = 'touched' where id = $1`, [ok]);
  assert.equal((await q(`select activity_type_key from training.activities where id = $1`, [ok]))[0].activity_type_key, c1Type,
    "a row that keeps its key keeps an archived type");
  assert.ok(kept);
});

test("9. an archive waits for an activity write in flight that holds the type", async () => {
  const typeKey = (await post("clubAdmin", "", { requestKey: newKey(), label: "In flight" })).body.type.key;
  const c = new pg.Client({ connectionString: env.db.url });
  await c.connect();
  try {
    await c.query("begin");
    await c.query(`insert into training.activities (activity_type_key, occurred_local_date, timezone_snapshot, owner_scope, owner_team_id, origin)
                   values ($1, '2026-11-20', 'UTC', 'team', $2, 'manual')`, [typeKey, m.teams.t1]);
    let settled = false;
    const archive = post("clubAdmin", `/${typeKey}/archive`, { requestKey: newKey() }).then((r) => { settled = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(settled, false, "the archive waits for the write that holds the type FOR SHARE");
    await c.query("commit");
    const res = await archive;
    assert.equal(res.status, 200, res.text);
  } finally {
    await c.query("rollback").catch(() => {});
    await c.end();
  }
});

test("10. the team's suggestion per source category: a team manager only, a type offered to the team", async () => {
  const c2Type = (await post("stranger", "", { requestKey: newKey(), label: `C2 suggestion ${crypto.randomBytes(2).toString("hex")}` })).body.type.key;
  const write = (userId, typeKey, category = "MATCH") => raw(async (c) => {
    await c.query("begin");
    if (userId) await asActor(c, userId);
    await c.query(`insert into training_load.source_session_types (owner_team_id, source_system, category_name, activity_type_key, set_by_user_id)
                   values ($1, 'gpexe', $2, $3, $4)
                   on conflict (owner_team_id, source_system, category_name) do update set activity_type_key = excluded.activity_type_key, set_by_user_id = excluded.set_by_user_id`,
    [m.teams.t1, category, typeKey, userId]);
    await c.query("commit");
    return "ok";
  }).catch((error) => error.code);
  assert.equal(await write(null, "match"), "42501", "no acting user");
  assert.equal(await write(role("stranger").id, "match"), "42501", "another club's admin");
  assert.equal(await write(role("teamCoach").id, c2Type), "23514", "a type of another club");
  assert.equal(await write(role("teamCoach").id, "testing_session"), "23514", "an archived type");
  assert.equal(await write(role("teamCoach").id, "match"), "ok", "the team's coach");
  assert.equal(await write(role("clubAdmin").id, "friendly_match"), "ok", "the club's admin, replacing it");
  const row = (await q(`select activity_type_key, set_by_user_id, seeded from training_load.source_session_types where owner_team_id = $1 and category_name = 'MATCH'`, [m.teams.t1]))[0];
  assert.deepEqual(row, { activity_type_key: "friendly_match", set_by_user_id: role("clubAdmin").id, seeded: false });
  assert.equal(await raw(async (c) => {
    await c.query("begin");
    await asActor(c, role("platformAdmin").id);
    return refusal(c.query(`delete from training_load.source_session_types`));
  }), "23514");
});

test("10b. (security review) a replay re-checks the right: an admin whose role was revoked gets the identical 404 for the same key", async () => {
  const admin = await fx.clubAdminOf(m.clubs.c1, "st1 replay admin");
  const key = newKey();
  const body = { requestKey: key, label: `Replay ${crypto.randomBytes(2).toString("hex")}` };
  const made = await api(R, { method: "POST", cookie: admin.cookie, body });
  assert.equal(made.status, 200, made.text);
  const again = await api(R, { method: "POST", cookie: admin.cookie, body });
  assert.equal(again.body.replayed, true);
  const archiveBody = { requestKey: newKey() };
  const archived = await api(`${R}/${made.body.type.key}/archive`, { method: "POST", cookie: admin.cookie, body: archiveBody });
  assert.equal(archived.status, 200, archived.text);
  await q(`update public.user_club_roles set is_active = false where user_id = $1`, [admin.id]);
  for (const [path, b] of [["", body], [`/${made.body.type.key}/archive`, archiveBody]]) {
    const revoked = await api(`${R}${path}`, { method: "POST", cookie: admin.cookie, body: b });
    assert.equal(revoked.status, 404, `${path}: ${revoked.text}`);
    assert.deepEqual(revoked.body, NOT_FOUND);
    assert.equal(revoked.cacheControl, "no-store");
  }
});

test("10c. (security review) a coach of a team in an archived club cannot set the team's suggestion", async () => {
  const club = await fx.makeClub("st1 archived later");
  const team = await fx.makeTeam(club, "st1 team of an archived club");
  const coach = await fx.coachOf(team, "st1 coach of an archived club");
  await q(`update public.clubs set is_active = false where id = $1`, [club]);
  const code = await raw(async (c) => {
    await c.query("begin");
    await asActor(c, coach.id);
    return refusal(c.query(`insert into training_load.source_session_types (owner_team_id, source_system, category_name, activity_type_key, set_by_user_id)
                            values ($1, 'gpexe', 'FULL TRAINING', 'training_session', $2)`, [team, coach.id]));
  });
  assert.equal(code, "42501");
});

test("11. bad bodies: 400 before any database work; a refusal carries no-store", async () => {
  for (const [body, code] of [
    [{ label: "No key" }, "invalid_request_key"],
    [{ requestKey: "nope", label: "x" }, "invalid_request_key"],
    [{ requestKey: newKey(), label: "  " }, "invalid_label"],
    [{ requestKey: newKey(), label: "x".repeat(61) }, "invalid_label"],
    [{ requestKey: newKey(), label: "Gym", key: "c_00000000_gym" }, "invalid_body"],
    [{ requestKey: newKey(), label: "Gym", ownerScope: "system" }, "invalid_body"],
  ]) {
    const res = await post("clubAdmin", "", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error, code, JSON.stringify(body));
    assert.equal(res.cacheControl, "no-store");
  }
  // A caller who may not write gets the 404 whatever body it sends (the rights before the body).
  const coachBad = await post("teamCoach", "", { label: "No key" });
  assert.equal(coachBad.status, 404);
});
