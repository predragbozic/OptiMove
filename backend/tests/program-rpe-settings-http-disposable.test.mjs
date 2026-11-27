import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures, key, startServer } from "./support/permission-roles-world.mjs";

let project, db, http, A, B, coach, viewer, plan, live;
const word = "programs.rpe_settings";

async function changeClubAdminRpeGrant(add) {
  const fixtureName = "migrations_v2/test-only-programs-rpe-" + randomUUID() + ".sql";
  assert.match(project.name, /^optimove_tests_/);
  await db.query("begin");
  try {
    await db.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
    if (add) {
      const { definition } = (await db.query("select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) as definition")).rows[0];
      const staged = definition.replace("'programs.view'", "'programs.view', 'programs.rpe_settings'");
      assert.notEqual(staged, definition);
      await db.query(staged);
    }
    const role = (await db.query("update public.permission_roles set revision=revision+1,updated_at=now() where basic_key='club_admin' returning id,revision")).rows[0];
    if (add) {
      await db.query("insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,items_added) values($1,$2,'migration',$3,array[$4]::text[])", [role.id, role.revision, fixtureName, word]);
      await db.query("insert into public.permission_role_items(role_id,permission_word) values($1,$2)", [role.id, word]);
    } else {
      await db.query("insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,items_removed) values($1,$2,'migration',$3,array[$4]::text[])", [role.id, role.revision, fixtureName, word]);
      await db.query("delete from public.permission_role_items where role_id=$1 and permission_word=$2", [role.id, word]);
    }
    await db.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('0',64),'test')", [fixtureName]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

async function fixturePlan(athleteId, status, weekStart) {
  const { id } = (await db.query(
    "insert into plans.plans(plan_type,created_by_user_id,athlete_id,name,status,source_type,visibility,week_start) values ('weekly',$1,$2,'Test plan',$3,'builder','private',$4) returning id",
    [coach.id, athleteId, status, weekStart],
  )).rows[0];
  await db.query("insert into training_load.plan_workspace_ownership(plan_id,owner_scope,owner_club_id) values($1,'club',$2)", [id, A]);
  const dayId = (await db.query("insert into plans.plan_days(plan_id,date,day_order,block_index) values($1,$2,1,1) returning id", [id, weekStart])).rows[0].id;
  const sessionId = (await db.query("insert into plans.plan_sessions(plan_day_id,name,bta,rpe_enabled,training_load_enabled) values($1,'Test session','T',true,true) returning id", [dayId])).rows[0].id;
  return { id, sessionId };
}

before(async () => {
  project = await createPagesDatabase({ through: "999999999999", label: "programs_rpe" });
  db = project.client;
  const ready = (await db.query("select public.permission_word_honoured($1) as ready", [word])).rows[0].ready;
  if (!ready) await changeClubAdminRpeGrant(true);
  const f = fixtures(db);
  A = await f.club();
  B = await f.club();
  const coachId = await f.user("RPE coach");
  const viewerId = await f.user("RPE viewer");
  await f.grantClub(coachId, A);
  await f.grantClub(coachId, B);
  const athleteUser = await f.user("Athlete");
  await f.makeAthlete(athleteUser);
  const athleteId = (await db.query("select id from public.athletes where user_id=$1", [athleteUser])).rows[0].id;
  await db.query("insert into public.athlete_memberships(athlete_id,club_id,membership_type,status) values($1,$2,'club','active'),($1,$3,'club','active')", [athleteId, A, B]);
  await db.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'club',$2),($3,'club',$2)", [coachId, A, viewerId]);
  http = await startServer(project.url);
  coach = { id: coachId, cookie: await http.cookieFor(coachId) };
  viewer = { id: viewerId, cookie: await http.cookieFor(viewerId) };
  const role = await http.api(coach.cookie, "/api/organization/roles", { method: "POST", body: {
    requestKey: key(), clubId: A, scopeTypes: ["club"], items: ["org.view", "athletes.view", "programs.view", "load.view.team"], name: "View plans",
  } });
  assert.equal(role.status, 200, role.text);
  const grant = await http.api(coach.cookie, "/api/organization/roles/assignments", { method: "POST", body: {
    requestKey: key(), reason: "View-only RPE fixture", userId: viewerId, roleId: role.body.role.id, scopeType: "club", scopeId: A,
  } });
  assert.equal(grant.status, 200, grant.text);
  plan = await fixturePlan(athleteId, "draft", "2026-11-23");
  live = await fixturePlan(athleteId, "active", "2026-11-30");
});

after(async () => {
  await http?.stop();
  await project?.drop();
});

const settings = id => "/api/builder/plans/" + id + "/training-load-settings";
const change = (session, path) => "/api/training-load/sessions/" + session + "/" + path;
const draftSession = id => "/api/builder/sessions/" + id;

function cases(draft, active) {
  return [
    ["PATCH", settings(draft.id), { trackTrainingLoadDefault: true, requestRpeDefault: true }],
    ["POST", settings(draft.id) + "/apply-to-training-sessions", {}],
    ["POST", settings(draft.id) + "/turn-off-before-after", {}],
    ["POST", settings(draft.id) + "/turn-off-all-rpe", {}],
    ["PATCH", draftSession(draft.sessionId), { trackingEnabled: true, rpeEnabled: true }],
    ["PATCH", change(active.sessionId, "rpe-enabled"), { rpeEnabled: false }],
    ["PATCH", change(active.sessionId, "training-load-enabled"), { trainingLoadEnabled: false }],
  ];
}

async function assertRefused(actor, { existingViewBoundary = false } = {}) {
  const before = await state();
  const missing = { id: randomUUID(), sessionId: randomUUID() };
  const absentRoutes = cases(missing, missing);
  for (const [index, [method, path, body]] of cases(plan, live).entries()) {
    const actual = await http.api(actor.cookie, path, { method, body });
    const absent = await http.api(actor.cookie, absentRoutes[index][1], { method, body });
    if (existingViewBoundary) assert.ok([403, 404].includes(actual.status), method + " " + path + " " + actual.text);
    else assert.equal(actual.status, 404, actual.text);
    assert.deepEqual([actual.status, actual.text], [absent.status, absent.text], method + " " + path);
  }
  assert.deepEqual(await state(), before);
}

async function state() {
  return {
    plans: (await db.query("select id,track_training_load_default,request_rpe_default,updated_at from plans.plans where id=any($1) order by id", [[plan.id, live.id]])).rows,
    sessions: (await db.query("select id,training_load_enabled,rpe_enabled,updated_at from plans.plan_sessions where id=any($1) order by id", [[plan.sessionId, live.sessionId]])).rows,
    feedback: (await db.query("select count(*)::int as count from training_load.session_feedback")).rows[0].count,
  };
}

test("the native owner can change flags through the direct draft actions and the two published toggles", async () => {
  for (const [method, path, body] of cases(plan, live)) {
    const response = await http.api(coach.cookie, path, { method, body });
    assert.equal(response.status, 200, response.text);
  }
  const { sessions } = await state();
  assert.deepEqual(sessions.filter(row => row.id === live.sessionId).map(row => [row.training_load_enabled, row.rpe_enabled]), [[false, false]]);
});

test("view-only and a coach in the other club cannot write through any direct action", async () => {
  await assertRefused(viewer, { existingViewBoundary: true });
  await db.query("update public.user_workspace_preferences set scope_id=$1 where user_id=$2", [B, coach.id]);
  try { await assertRefused(coach); }
  finally { await db.query("update public.user_workspace_preferences set scope_id=$1 where user_id=$2", [A, coach.id]); }
});

test("an exact owner without Manage gets identical missing responses while ordinary program edits still work", async () => {
  await changeClubAdminRpeGrant(false);
  await assertRefused(coach);
  assert.equal((await http.api(coach.cookie, "/api/builder/plans/" + plan.id)).status, 200);
  const renamed = await http.api(coach.cookie, "/api/builder/plans/" + plan.id, { method: "PATCH", body: { name: "Ordinary Builder rename" } });
  assert.equal(renamed.status, 200, renamed.text);
  const renameSession = await http.api(coach.cookie, draftSession(plan.sessionId), { method: "PATCH", body: { name: "Ordinary session rename" } });
  assert.equal(renameSession.status, 200, renameSession.text);
});
