import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures, key, startServer } from "./support/permission-roles-world.mjs";
import { changeProgramRpeGrant } from "./support/program-rpe-grants.mjs";

let project, db, http, A, B, coach, viewer, plan, live, athleteId;

async function fixturePlan(athleteId, status, weekStart, ownerClub = A) {
  const { id } = (await db.query(
    "insert into plans.plans(plan_type,created_by_user_id,athlete_id,name,status,source_type,visibility,week_start) values ('weekly',$1,$2,'Test plan',$3,'builder','private',$4) returning id",
    [coach.id, athleteId, status, weekStart],
  )).rows[0];
  if (ownerClub) await db.query("insert into training_load.plan_workspace_ownership(plan_id,owner_scope,owner_club_id) values($1,'club',$2)", [id, ownerClub]);
  else await db.query("insert into training_load.plan_workspace_ownership(plan_id,owner_scope,owner_user_id) values($1,'user',$2)", [id, coach.id]);
  const dayId = (await db.query("insert into plans.plan_days(plan_id,date,day_order,block_index) values($1,$2,1,1) returning id", [id, weekStart])).rows[0].id;
  const sessionId = (await db.query("insert into plans.plan_sessions(plan_day_id,name,bta,rpe_enabled,training_load_enabled) values($1,'Test session','T',true,true) returning id", [dayId])).rows[0].id;
  return { id, sessionId };
}

before(async () => {
  project = await createPagesDatabase({ through: "999999999999", label: "programs_rpe" });
  db = project.client;
  await changeProgramRpeGrant(db, "club_admin", true);
  const f = fixtures(db);
  A = await f.club();
  B = await f.club();
  const coachId = await f.user("RPE coach");
  const viewerId = await f.user("RPE viewer");
  await f.grantClub(coachId, A);
  await f.grantClub(coachId, B);
  const athleteUser = await f.user("Athlete");
  await f.makeAthlete(athleteUser);
  athleteId = (await db.query("select id from public.athletes where user_id=$1", [athleteUser])).rows[0].id;
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
  await changeProgramRpeGrant(db, "club_admin", false);
  await assertRefused(coach);
  assert.equal((await http.api(coach.cookie, "/api/builder/plans/" + plan.id)).status, 200);
  const renamed = await http.api(coach.cookie, "/api/builder/plans/" + plan.id, { method: "PATCH", body: { name: "Ordinary Builder rename" } });
  assert.equal(renamed.status, 200, renamed.text);
  const renameSession = await http.api(coach.cookie, draftSession(plan.sessionId), { method: "PATCH", body: { name: "Ordinary session rename" } });
  assert.equal(renameSession.status, 200, renameSession.text);
});

async function openEditDraft(targetId) {
  const result = await http.api(coach.cookie, "/api/builder/plans/" + targetId + "/edit", { method: "POST", body: {} });
  assert.equal(result.status, 200, result.text);
  return result.body.plan.id;
}

async function flags(sessionId) {
  return (await db.query("select logical_session_id,training_load_enabled,rpe_enabled from plans.plan_sessions where id=$1", [sessionId])).rows[0];
}

test("unchanged retained sessions save without Manage; a real retained flag delta is refused", async () => {
  const before = await flags(live.sessionId);
  const unchanged = await openEditDraft(live.id);
  const first = await http.api(coach.cookie, "/api/builder/plans/" + unchanged + "/submit", { method: "POST", body: {} });
  assert.equal(first.status, 200, first.text);
  const stored = (await db.query(
    "select ps.id from plans.plan_sessions ps join plans.plan_days pd on pd.id=ps.plan_day_id where pd.plan_id=$1 and ps.logical_session_id=$2",
    [live.id, before.logical_session_id],
  )).rows[0];
  assert.deepEqual(await flags(stored.id), before);
  const draft = await openEditDraft(live.id);
  const pending = await db.query(
    "update plans.plan_sessions ps set training_load_enabled=true,rpe_enabled=true from plans.plan_days pd where pd.id=ps.plan_day_id and pd.plan_id=$1 and ps.logical_session_id=$2 returning ps.id",
    [draft, before.logical_session_id],
  );
  assert.equal(pending.rowCount, 1, "the draft retained precisely the live logical session");
  const denied = await http.api(coach.cookie, "/api/builder/plans/" + draft + "/submit", { method: "POST", body: {} });
  assert.deepEqual([denied.status, denied.body], [404, { error: "Draft program not found" }]);
  assert.deepEqual(await flags(stored.id), before);
  assert.equal((await flags(pending.rows[0].id)).rpe_enabled, true, "refusal preserves the open edit draft");
});

test("ordinary single Submit with inherited flags still publishes without Manage", async () => {
  const fresh = await fixturePlan(athleteId, "draft", "2026-12-07");
  const node = await http.api(coach.cookie, draftSession(fresh.sessionId) + "/nodes", { method: "POST", body: { nodeType: "section", name: "Warm-up" } });
  assert.equal(node.status, 201, node.text);
  const submitted = await http.api(coach.cookie, "/api/builder/plans/" + fresh.id + "/submit", { method: "POST", body: {} });
  assert.equal(submitted.status, 200, submitted.text);
  assert.equal((await db.query("select status from plans.plans where id=$1", [fresh.id])).rows[0].status, "active");
});

test("exact weekly batch default differences require rights on every target before sync or Submit", async () => {
  const source = await fixturePlan(athleteId, "draft", "2026-12-14");
  const eligible = await fixturePlan(athleteId, "draft", "2026-12-21");
  const foreign = await fixturePlan(athleteId, "draft", "2026-12-28", B);
  const batch = randomUUID();
  const ids = [source.id, eligible.id, foreign.id];
  await db.query("update plans.plans set builder_batch_id=$1 where id=any($2::uuid[])", [batch, ids]);
  const sync = (path, body) => http.api(coach.cookie, "/api/builder/plans/" + source.id + path, { method: "POST", body });
  const equal = await sync("/sync-batch", {});
  assert.equal(equal.status, 200, equal.text);
  await changeProgramRpeGrant(db, "club_admin", true);
  await db.query("update plans.plans set track_training_load_default=true,request_rpe_default=true where id=$1", [source.id]);
  const snapshot = async () => (await db.query("select id,name,status,track_training_load_default,request_rpe_default,updated_at from plans.plans where id=any($1::uuid[]) order by id", [ids])).rows;
  const before = await snapshot();
  const targetSessions = async () => (await db.query("select ps.id,ps.logical_session_id,ps.rpe_enabled,ps.training_load_enabled from plans.plan_sessions ps join plans.plan_days pd on pd.id=ps.plan_day_id where pd.plan_id=any($1::uuid[]) order by ps.id", [ids])).rows;
  const sessionsBefore = await targetSessions();
  for (const [path, body] of [["/sync-batch", {}], ["/submit", { syncBatch: true }]]) {
    const denied = await sync(path, body);
    assert.deepEqual([denied.status, denied.body], [404, { error: "Draft program not found" }]);
    assert.deepEqual(await snapshot(), before, "all three plans are unchanged");
    assert.deepEqual(await targetSessions(), sessionsBefore, "no sibling session was recreated");
  }
  const primary = await http.api(coach.cookie, "/api/builder/plans/" + source.id, {
    method: "PATCH", body: { name: "Primary rename is saved", syncBatch: true },
  });
  assert.equal(primary.status, 200, primary.text);
  assert.equal(primary.body.plan.name, "Primary rename is saved");
  assert.equal(primary.body.batchSyncMessage, "The draft was saved. The other plans did not take its RPE settings.");
  const after = await snapshot();
  assert.deepEqual(after.filter(row => row.id !== source.id), before.filter(row => row.id !== source.id));
  assert.deepEqual(await targetSessions(), sessionsBefore);
});

test("live batch Submit checks the exact sibling chosen for a retained-session update", async () => {
  const source = await fixturePlan(athleteId, "active", "2027-01-04");
  const other = await fixturePlan(athleteId, "active", "2027-01-11", B);
  const batch = randomUUID();
  await db.query("update plans.plans set builder_batch_id=$1 where id=any($2::uuid[])", [batch, [source.id, other.id]]);
  const draft = await openEditDraft(source.id);
  const pending = await db.query(
    "update plans.plan_sessions ps set rpe_enabled=false from plans.plan_days pd where pd.plan_id=$1 and pd.id=ps.plan_day_id returning ps.id",
    [draft],
  );
  assert.equal(pending.rowCount, 1);
  const sourceBefore = await flags(source.sessionId);
  const siblingBefore = await flags(other.sessionId);
  assert.equal(sourceBefore.rpe_enabled, true);
  assert.equal(siblingBefore.rpe_enabled, true);
  const denied = await http.api(coach.cookie, "/api/builder/plans/" + draft + "/submit", { method: "POST", body: { batchScope: "all" } });
  assert.deepEqual([denied.status, denied.body], [404, { error: "Draft program not found" }]);
  assert.deepEqual(await flags(source.sessionId), sourceBefore);
  assert.deepEqual(await flags(other.sessionId), siblingBefore);
  assert.equal((await flags(pending.rows[0].id)).rpe_enabled, false);
});

test("private coaching rejects native-owned RPE effects even when the actor created the plan", async () => {
  await fixtures(db).grantIndependent(coach.id);
  const nativeDraft = await fixturePlan(athleteId, "draft", "2027-01-18");
  const nativeLive = await fixturePlan(athleteId, "active", "2027-01-25");
  const ownPrivate = await fixturePlan(athleteId, "draft", "2027-02-01", null);
  const sibling = await fixturePlan(athleteId, "draft", "2027-02-08");
  const { id: program } = (await db.query(
    "insert into plans.plans(plan_type,created_by_user_id,name,status,source_type,visibility,is_template) values('program',$1,'Private program','draft','builder','private',true) returning id",
    [coach.id],
  )).rows[0];
  const { id: day } = (await db.query("insert into plans.plan_days(plan_id,date,day_order,block_index) values($1,'2027-02-15',1,0) returning id", [program])).rows[0];
  const { id: programSession } = (await db.query("insert into plans.plan_sessions(plan_day_id,name,bta,rpe_enabled,training_load_enabled) values($1,'Private session','T',true,true) returning id", [day])).rows[0];
  const edit = await openEditDraft(nativeLive.id);
  const edited = (await db.query(
    "update plans.plan_sessions ps set rpe_enabled=false from plans.plan_days pd where pd.plan_id=$1 and pd.id=ps.plan_day_id returning ps.id", [edit],
  )).rows[0];
  const batch = randomUUID();
  await db.query("update plans.plans set builder_batch_id=$1 where id=any($2::uuid[])", [batch, [nativeDraft.id, sibling.id]]);
  await db.query("update plans.plans set track_training_load_default=true,request_rpe_default=true where id=$1", [nativeDraft.id]);

  await db.query("update public.user_workspace_preferences set workspace_type='private_coach',scope_id=null where user_id=$1", [coach.id]);
  try {
    const snapshot = async () => (await db.query(
      "select id,name,status,track_training_load_default,request_rpe_default,updated_at from plans.plans where id=any($1::uuid[]) order by id",
      [[nativeDraft.id, nativeLive.id, sibling.id, edit]],
    )).rows;
    const before = await snapshot();
    const liveBefore = await flags(nativeLive.sessionId);
    for (const [method, path, body] of [
      ["PATCH", settings(nativeDraft.id), { requestRpeDefault: false }],
      ["PATCH", draftSession(nativeDraft.sessionId), { rpeEnabled: false }],
      ["POST", "/api/builder/plans/" + edit + "/submit", {}],
      ["POST", "/api/builder/plans/" + nativeDraft.id + "/sync-batch", {}],
      ["POST", "/api/builder/plans/" + nativeDraft.id + "/submit", { syncBatch: true }],
    ]) {
      const denied = await http.api(coach.cookie, path, { method, body });
      assert.equal(denied.status, 404, path + " " + denied.text);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await flags(nativeLive.sessionId), liveBefore);
      assert.equal((await flags(edited.id)).rpe_enabled, false);
    }
    const own = await http.api(coach.cookie, settings(ownPrivate.id), { method: "PATCH", body: { trackTrainingLoadDefault: true, requestRpeDefault: true } });
    assert.equal(own.status, 200, own.text);
    assert.equal((await db.query("select 1 from training_load.plan_workspace_ownership where plan_id=$1", [program])).rowCount, 0);
    const legacy = await http.api(coach.cookie, draftSession(programSession), { method: "PATCH", body: { rpeEnabled: false } });
    assert.equal(legacy.status, 200, legacy.text);
    assert.equal((await flags(programSession)).rpe_enabled, false);
    const normal = await http.api(coach.cookie, "/api/builder/plans/" + nativeDraft.id, { method: "PATCH", body: { name: "Ordinary private edit" } });
    assert.equal(normal.status, 200, normal.text);
    assert.equal(normal.body.plan.name, "Ordinary private edit");
  } finally {
    await db.query("update public.user_workspace_preferences set workspace_type='club',scope_id=$1 where user_id=$2", [A, coach.id]);
  }
});


async function waitForRpeBlock(pid) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const { rows: [state] } = await db.query("select cardinality(pg_blocking_pids($1)) > 0 as waiting", [pid]);
    if (state.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("The workspace switch and RPE actor check did not serialize.");
}

test("private RPE rechecks a queued switch and holds the preference against a later switch", async () => {
  const { lockProgramRpeActor } = await import("../src/programRpeSettingsAccess.js");
  const hasHolding = await db.query("select 1 from public.user_global_roles where user_id=$1 and role='independent_coach' and is_active", [coach.id]);
  if (!hasHolding.rowCount) await fixtures(db).grantIndependent(coach.id);
  const actorClient = await http.pool.connect();
  const workspaceClient = await http.pool.connect();
  const req = { user: { id: coach.id }, sessionToken: coach.cookie.split("=")[1] };
  const scope = { type: "private_coach", userId: coach.id };
  const selectWorkspace = (client, type, id) => client.query(
    "update public.user_workspace_preferences set workspace_type=$2,scope_id=$3 where user_id=$1",
    [coach.id, type, id],
  );
  const pending = [];
  try {
    await selectWorkspace(db, "private_coach", null);
    await workspaceClient.query("begin");
    await selectWorkspace(workspaceClient, "club", A);
    await actorClient.query("begin");
    const afterSwitch = lockProgramRpeActor(actorClient, req, scope);
    pending.push(afterSwitch);
    await waitForRpeBlock(actorClient.processID);
    await workspaceClient.query("commit");
    assert.equal(await afterSwitch, null);
    await actorClient.query("rollback");

    await selectWorkspace(db, "private_coach", null);
    await actorClient.query("begin");
    assert.equal((await lockProgramRpeActor(actorClient, req, scope)).user.id, coach.id);
    await workspaceClient.query("begin");
    const laterSwitch = selectWorkspace(workspaceClient, "club", A);
    pending.push(laterSwitch);
    await waitForRpeBlock(workspaceClient.processID);
    await actorClient.query("commit");
    await laterSwitch;
    await workspaceClient.query("commit");
  } finally {
    await Promise.allSettled([actorClient.query("rollback"), workspaceClient.query("rollback")]);
    await Promise.allSettled(pending);
    actorClient.release();
    workspaceClient.release();
    await selectWorkspace(db, "club", A);
  }
});


test("opening an existing program copies only its stored workspace owner", async () => {
  const openProgram = async (name, owner) => {
    const { rows: [source] } = await db.query(
      "insert into plans.plans(plan_type,created_by_user_id,name,status,source_type,visibility,is_template) values('program',$1,$2,'active','builder','private',true) returning id",
      [coach.id, name],
    );
    if (owner) await db.query(
      "insert into training_load.plan_workspace_ownership(plan_id,owner_scope,owner_club_id) values($1,'club',$2)",
      [source.id, owner],
    );
    return openEditDraft(source.id);
  };
  const resolved = await openProgram("Programme with a stored owner", B);
  const unresolved = await openProgram("Programme without a stored owner", null);
  const { rows } = await db.query(
    "select plan_id,owner_scope,owner_club_id from training_load.plan_workspace_ownership where plan_id=any($1::uuid[])",
    [[resolved, unresolved]],
  );
  assert.deepEqual(rows, [{ plan_id: resolved, owner_scope: "club", owner_club_id: B }]);
});


test("v106 records a real opening, exact session lineage and effective settings changes", async () => {
  const livePlan = await fixturePlan(athleteId, "active", "2027-03-15");
  await db.query("update plans.plans set track_training_load_default=true,request_rpe_default=true where id=$1", [livePlan.id]);
  const source = await flags(livePlan.sessionId);
  const draftId = await openEditDraft(livePlan.id);
  const { rows: [opening] } = await db.query("select * from training_load.builder_rpe_plan_baselines where plan_id=$1", [draftId]);
  assert.equal(opening.source_plan_id, livePlan.id);
  assert.equal(opening.owner_club_id, A);
  assert.equal(opening.opening_rpe, true);
  assert.equal(opening.opening_tracking, true);
  const { rows: [lineage] } = await db.query("select * from training_load.builder_rpe_session_baselines where plan_id=$1", [draftId]);
  assert.equal(lineage.source_plan_id, livePlan.id);
  assert.equal(lineage.source_session_id, livePlan.sessionId);
  assert.notEqual(lineage.session_id, livePlan.sessionId);
  assert.equal(lineage.logical_session_id, source.logical_session_id);
  const stateOfEffects = async () => ({
    plan: (await db.query("select changed_tracking,changed_rpe,effective_tracking,effective_rpe from training_load.builder_rpe_plan_effects where plan_id=$1", [draftId])).rows,
    sessions: (await db.query("select changed_tracking,changed_rpe,effective_tracking,effective_rpe from training_load.builder_rpe_session_effects where plan_id=$1", [draftId])).rows,
  });
  assert.deepEqual(await stateOfEffects(), { plan: [], sessions: [] });
  const patch = async (path, body) => {
    const result = await http.api(coach.cookie, path, { method: "PATCH", body });
    assert.equal(result.status, 200, result.text);
  };
  await patch(settings(draftId), { requestRpeDefault: false });
  await patch(draftSession(lineage.session_id), { trackingEnabled: false });
  assert.deepEqual(await stateOfEffects(), {
    plan: [{ changed_tracking: false, changed_rpe: true, effective_tracking: true, effective_rpe: false }],
    sessions: [{ changed_tracking: true, changed_rpe: true, effective_tracking: false, effective_rpe: false }],
  });
  await patch(settings(draftId), { requestRpeDefault: true });
  await patch(draftSession(lineage.session_id), { trackingEnabled: true, rpeEnabled: true });
  assert.deepEqual(await stateOfEffects(), { plan: [], sessions: [] });
  assert.deepEqual(await flags(livePlan.sessionId), source);
  await db.query("delete from plans.plans where id=$1", [draftId]);
  assert.equal((await db.query("select 1 from training_load.builder_rpe_plan_baselines where plan_id=$1", [draftId])).rowCount, 0);
  const rollback = await fsp.readFile(new URL("../../docs/runbooks/builder-rpe-v106-rollback.sql", import.meta.url), "utf8");
  try {
    await assert.rejects(db.query(rollback), /v106 rollback refuses recorded Builder provenance/);
  } finally {
    await db.query("rollback");
  }
  assert.equal((await db.query("select 1 from training_load.builder_rpe_provenance_use")).rowCount, 1);
});
