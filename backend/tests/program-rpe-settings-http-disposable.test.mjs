import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures, key, startServer } from "./support/permission-roles-world.mjs";
import { changeProgramRpeGrant } from "./support/program-rpe-grants.mjs";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";

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
  assert.equal((await db.query("select public.permission_word_honoured('programs.rpe_settings') as staged")).rows[0].staged, true);
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

async function setNativeRpeGrant(add) {
  for (const role of add ? ["club_admin", "team_coach"] : ["team_coach", "club_admin"]) {
    await changeProgramRpeGrant(db, role, add);
  }
}

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
  await setNativeRpeGrant(false);
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
  await setNativeRpeGrant(true);
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


test("v106 captures new plan, new session and inherited copy independently of explicit settings", async () => {
  const created = await http.api(coach.cookie, "/api/builder/plans", {
    method: "POST", body: { planType: "program", name: "New provenance program" },
  });
  assert.equal(created.status, 201, created.text);
  const planId = created.body.plan.id;
  const { rows: [opening] } = await db.query("select * from training_load.builder_rpe_plan_baselines where plan_id=$1", [planId]);
  assert.equal(opening.origin, "created");
  assert.equal(opening.owner_club_id, A);
  assert.equal(opening.source_plan_id, null);
  const { rows: [day] } = await db.query(
    "insert into plans.plan_days(plan_id,date,day_order,block_index) values($1,'2027-03-20',1,1) returning id", [planId],
  );
  const session = await http.api(coach.cookie, "/api/builder/blocks/" + day.id + "/sessions", {
    method: "POST", body: { name: "New training", bta: "T" },
  });
  assert.equal(session.status, 201, session.text);
  const getLineage = async () => (await db.query(
    "select session_id,source_session_id,source_plan_id,opening_tracking,opening_rpe from training_load.builder_rpe_session_baselines where plan_id=$1",
    [planId],
  )).rows;
  const [newSession] = await getLineage();
  assert.equal(newSession.source_session_id, null);
  const weekly = await fixturePlan(athleteId, "active", "2027-03-29");
  const sourceFlags = await flags(weekly.sessionId);
  for (let copies = 0; copies < 2; copies++) {
    const copied = await http.api(coach.cookie, "/api/builder/sessions/" + weekly.sessionId + "/copy-into/" + day.id, {
      method: "POST", body: {},
    });
    assert.equal(copied.status, 200, copied.text);
  }
  const inherited = (await getLineage()).filter(row => row.session_id !== newSession.session_id);
  assert.equal(inherited.length, 2);
  for (const row of inherited) {
    assert.equal(row.source_session_id, weekly.sessionId);
    assert.equal(row.source_plan_id, weekly.id);
    assert.deepEqual([row.opening_tracking, row.opening_rpe], [sourceFlags.training_load_enabled, sourceFlags.rpe_enabled]);
  }
  assert.equal((await db.query("select 1 from training_load.builder_rpe_session_effects where plan_id=$1", [planId])).rowCount, 0);
});

test("v106 bulk commands record unchanged inheritance separately from their actual effects", async () => {
  const source = await fixturePlan(athleteId, "active", "2027-03-22");
  await db.query("update plans.plans set track_training_load_default=true,request_rpe_default=true where id=$1", [source.id]);
  const draftId = await openEditDraft(source.id);
  const run = async (operation) => {
    const result = await http.api(coach.cookie, settings(draftId) + "/" + operation, { method: "POST", body: {} });
    assert.equal(result.status, 200, result.text);
  };
  const effects = async () => (await db.query(
    "select changed_tracking,changed_rpe,effective_tracking,effective_rpe from training_load.builder_rpe_session_effects where plan_id=$1",
    [draftId],
  )).rows;
  await run("turn-off-before-after");
  assert.deepEqual(await effects(), []);
  await run("turn-off-all-rpe");
  assert.deepEqual(await effects(), [
    { changed_tracking: false, changed_rpe: true, effective_tracking: true, effective_rpe: false },
  ]);
  await run("apply-to-training-sessions");
  assert.deepEqual(await effects(), []);
});


test("v106 nonweekly Submit rechecks the grant for a recorded effect under the exact stored owner", async () => {
  const { rows: [program] } = await db.query(
    "insert into plans.plans(plan_type,created_by_user_id,name,status,source_type,visibility,is_template) values('program',$1,'Submit provenance','active','builder','private',true) returning id",
    [coach.id],
  );
  await db.query("insert into training_load.plan_workspace_ownership(plan_id,owner_scope,owner_club_id) values($1,'club',$2)", [program.id, A]);
  const { rows: [day] } = await db.query("insert into plans.plan_days(plan_id,date,day_order,block_index) values($1,'2027-03-25',1,1) returning id", [program.id]);
  const { rows: [source] } = await db.query(
    "insert into plans.plan_sessions(plan_day_id,name,bta,rpe_enabled,training_load_enabled) values($1,'Training','T',true,true) returning id", [day.id],
  );
  const draftId = await openEditDraft(program.id);
  const { rows: [lineage] } = await db.query("select session_id from training_load.builder_rpe_session_baselines where plan_id=$1 and source_session_id=$2", [draftId, source.id]);
  const edit = await http.api(coach.cookie, draftSession(lineage.session_id), { method: "PATCH", body: { rpeEnabled: false } });
  assert.equal(edit.status, 200, edit.text);
  const submit = () => http.api(coach.cookie, "/api/builder/plans/" + draftId + "/submit", { method: "POST", body: {} });
  await setNativeRpeGrant(false);
  try {
    const refused = await submit();
    assert.equal(refused.status, 404, refused.text);
    assert.equal((await flags(source.id)).rpe_enabled, true);
    assert.equal((await flags(lineage.session_id)).rpe_enabled, false);
  } finally {
    await setNativeRpeGrant(true);
  }
  const saved = await submit();
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await db.query("select 1 from training_load.builder_rpe_plan_baselines where plan_id=$1", [draftId])).rowCount, 0);
  const { rows: [published] } = await db.query(
    "select ps.rpe_enabled,ps.training_load_enabled from plans.plan_sessions ps join plans.plan_days pd on pd.id=ps.plan_day_id where pd.plan_id=$1",
    [program.id],
  );
  assert.deepEqual(published, { rpe_enabled: false, training_load_enabled: true });
});

test("v106 uses exact inserted IDs for whole-plan duplicates and dated assignments", async () => {
  const template = await http.api(coach.cookie, "/api/builder/plans", {
    method: "POST", body: { planType: "program", templateKind: "weekly", weeks: 1, name: "Provenance template" },
  });
  assert.equal(template.status, 201, template.text);
  const source = template.body.plan.id;
  const days = (await db.query("select id from plans.plan_days where plan_id=$1 order by block_index limit 2", [source])).rows;
  const sessionIds = (await db.query(
    `insert into plans.plan_sessions(plan_day_id,name,bta,training_load_enabled,rpe_enabled)
     values ($1,'Training', 'T', true, true),($2,'Training','T', false, false) returning id`,
    days.map(day => day.id),
  )).rows.map(row => row.id);
  const copy = await http.api(coach.cookie, "/api/builder/plans/" + source + "/duplicate", { method: "POST", body: {} });
  assert.equal(copy.status, 201, copy.text);
  const { rows: [athlete] } = await db.query("select athlete_id from public.athletes where id=$1", [athleteId]);
  const assignmentPath = "/api/builder/plans/" + source + "/assign-weekly";
  const request = { method: "POST", body: { athleteIds: [athlete.athlete_id], startDate: "2027-05-03", assignmentRequestId: randomUUID() } };
  const assigned = await http.api(coach.cookie, assignmentPath, request);
  assert.equal(assigned.status, 201, assigned.text);
  const retry = await http.api(coach.cookie, assignmentPath, request);
  assert.deepEqual(retry.body, assigned.body);
  for (const id of [copy.body.plan.id, assigned.body.created[0].planId]) {
    const opening = (await db.query("select origin,source_plan_id,owner_club_id from training_load.builder_rpe_plan_baselines where plan_id=$1", [id])).rows[0];
    assert.deepEqual(opening, { origin: "copy", source_plan_id: source, owner_club_id: A });
    const rows = (await db.query(
      `select b.*, src.logical_session_id as source_logical_session_id, dst.id as actual_session_id, dd.plan_id as actual_plan_id
       from training_load.builder_rpe_session_baselines b
       join plans.plan_sessions src on src.id=b.source_session_id
       join plans.plan_sessions dst on dst.id=b.session_id
       join plans.plan_days dd on dd.id=dst.plan_day_id
       where b.plan_id=$1 order by b.opening_tracking desc`, [id],
    )).rows;
    assert.deepEqual(rows.map(row => [row.source_session_id, row.opening_tracking, row.opening_rpe]), [
      [sessionIds[0], true, true], [sessionIds[1], false, false],
    ]);
    for (const row of rows) {
      assert.equal(row.source_plan_id, source);
      assert.equal(row.actual_plan_id, id);
      assert.equal(row.actual_session_id, row.session_id);
      assert.equal(row.retained_from_opening, false);
      assert.notEqual(row.session_id, row.source_session_id);
      assert.notEqual(row.logical_session_id, row.source_logical_session_id);
    }
  }
  const replaceWeek = async (startDate) => {
    const body = { athleteIds: [athlete.athlete_id], startDate, assignmentRequestId: randomUUID() };
    const conflict = await http.api(coach.cookie, assignmentPath, { method: "POST", body });
    assert.equal(conflict.status, 409, conflict.text);
    const replaced = await http.api(coach.cookie, assignmentPath, {
      method: "POST", body: { ...body, choice: "replace", choiceToken: conflict.body.choiceToken },
    });
    assert.equal(replaced.status, 201, replaced.text);
    return replaced.body.replaced[0].planId;
  };
  const target = assigned.body.created[0].planId;
  const lineageBefore = (await db.query(
    "select session_id from training_load.builder_rpe_session_baselines where plan_id=$1 order by session_id", [target],
  )).rows;
  assert.equal(await replaceWeek("2027-05-03"), target);
  const currentLineage = (await db.query(
    `select b.session_id,b.source_session_id
     from training_load.builder_rpe_session_baselines b join plans.plan_sessions s on s.id=b.session_id
     where b.plan_id=$1 order by b.source_session_id`, [target],
  )).rows;
  assert.deepEqual(currentLineage.map(row => row.source_session_id).sort(), [...sessionIds].sort());
  assert.ok(currentLineage.every(row => !lineageBefore.some(old => old.session_id === row.session_id)));

  const legacy = await fixturePlan(athleteId, "active", "2027-05-10");
  assert.equal(await replaceWeek("2027-05-10"), legacy.id);
  assert.equal((await db.query("select 1 from training_load.builder_rpe_plan_baselines where plan_id=$1", [legacy.id])).rowCount, 0);
});

test("v106 single first Submit refuses an explicit edit after the grant is removed", async () => {
  const { rows: [athlete] } = await db.query("select athlete_id from public.athletes where id=$1", [athleteId]);
  const created = await http.api(coach.cookie, "/api/builder/plans", {
    method: "POST", body: { planType: "weekly", weekStart: "2027-05-17", athleteIds: [athlete.athlete_id], name: "First Submit provenance" },
  });
  assert.equal(created.status, 201, created.text);
  const id = created.body.plan.id;
  const { rows: [day] } = await db.query("select id from plans.plan_days where plan_id=$1 order by block_index limit 1", [id]);
  const session = await http.api(coach.cookie, "/api/builder/blocks/" + day.id + "/sessions", {
    method: "POST", body: { name: "Training", bta: "T" },
  });
  assert.equal(session.status, 201, session.text);
  const sessionId = (await db.query("select id from plans.plan_sessions where plan_day_id=$1", [day.id])).rows[0].id;
  const node = await http.api(coach.cookie, draftSession(sessionId) + "/nodes", {
    method: "POST", body: { nodeType: "section", name: "Warm-up" },
  });
  assert.equal(node.status, 201, node.text);
  const changed = await http.api(coach.cookie, settings(id), {
    method: "PATCH", body: { trackTrainingLoadDefault: true, requestRpeDefault: true },
  });
  assert.equal(changed.status, 200, changed.text);
  await setNativeRpeGrant(false);
  const submit = () => http.api(coach.cookie, "/api/builder/plans/" + id + "/submit", { method: "POST", body: {} });
  try {
    const refusal = await submit();
    assert.equal(refusal.status, 404, refusal.text);
    assert.equal((await db.query("select status from plans.plans where id=$1", [id])).rows[0].status, "draft");
  } finally {
    await setNativeRpeGrant(true);
  }
  const accepted = await submit();
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal((await db.query("select status from plans.plans where id=$1", [id])).rows[0].status, "active");
});
test("the first Submit platform exception requires a current workspace, holding and session", async () => {
  const f = fixtures(db);
  const userId = await f.user("RPE platform");
  await f.grantPlatform(userId);
  await f.grantClub(userId, A);
  await db.query("insert into public.user_workspace_preferences(user_id,workspace_type) values($1,'platform')", [userId]);
  const { lockProgramRpeActor } = await import("../src/programRpeSettingsAccess.js");
  const req = { user: { id: userId }, sessionToken: (await http.cookieFor(userId)).split("=")[1] };
  const actor = await http.pool.connect();
  const switcher = await http.pool.connect();
  const scope = { type: "platform" };
  let pending;
  try {
    await actor.query("begin");
    assert.equal((await lockProgramRpeActor(actor, req, scope)).user.id, userId);
    await actor.query("rollback");
    await switcher.query("begin");
    await switcher.query("update public.user_workspace_preferences set workspace_type='club',scope_id=$2 where user_id=$1", [userId, A]);
    await actor.query("begin");
    pending = lockProgramRpeActor(actor, req, scope);
    await waitForRpeBlock(actor.processID);
    await switcher.query("commit");
    assert.equal(await pending, null);
    await actor.query("rollback");

    await db.query("update public.user_workspace_preferences set workspace_type='platform',scope_id=null where user_id=$1", [userId]);
    await db.query("delete from public.auth_sessions where user_id=$1", [userId]);
    await actor.query("begin");
    assert.equal(await lockProgramRpeActor(actor, req, scope), null);
    await actor.query("rollback");

    req.sessionToken = (await http.cookieFor(userId)).split("=")[1];
    await db.query("update public.user_global_roles set is_active=false where user_id=$1 and role='platform_admin'", [userId]);
    await actor.query("begin");
    assert.equal(await lockProgramRpeActor(actor, req, scope), null);
  } finally {
    await Promise.allSettled([actor.query("rollback"), switcher.query("rollback")]);
    if (pending) await Promise.allSettled([pending]);
    actor.release();
    switcher.release();
  }
});

test("a weekly batch edit requires a proven sibling for a recorded RPE change, even in the same slot", async () => {
  const origin = await fixturePlan(athleteId, "active", "2027-06-07");
  const { rows: [athlete] } = await db.query("select athlete_id from public.athletes where id=$1", [athleteId]);
  const duplicate = async (weekStart) => {
    const response = await http.api(coach.cookie, "/api/builder/plans/" + origin.id + "/duplicate", {
      method: "POST", body: { athleteIds: [athlete.athlete_id], weekStart },
    });
    assert.equal(response.status, 201, response.text);
    return response.body.plan.id;
  };
  const primary = await duplicate("2027-06-14");
  const sibling = await duplicate("2027-06-21");
  await db.query("update plans.plans set status='active',builder_batch_id=$1 where id=any($2::uuid[])", [randomUUID(), [primary,sibling]]);
  const onlySession = async (id) => (await db.query(
    "select ps.id,ps.logical_session_id from plans.plan_sessions ps join plans.plan_days pd on pd.id=ps.plan_day_id where pd.plan_id=$1", [id],
  )).rows[0];
  const draft = await openEditDraft(primary);
  const draftRow = await onlySession(draft);
  const changed = await http.api(coach.cookie, draftSession(draftRow.id), { method: "PATCH", body: { rpeEnabled: false } });
  assert.equal(changed.status, 200, changed.text);
  const siblingRow = await onlySession(sibling);
  await db.query("update plans.plan_sessions set logical_session_id=$2 where id=$1", [siblingRow.id, randomUUID()]);
  const submit = () => http.api(coach.cookie, "/api/builder/plans/" + draft + "/submit", { method: "POST", body: { batchScope: "all" } });
  const refused = await submit();
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.code, "rpe_sibling_unmatched");
  assert.equal((await flags((await onlySession(primary)).id)).rpe_enabled, true);
  assert.equal((await flags(siblingRow.id)).rpe_enabled, true);
  assert.equal((await flags(draftRow.id)).rpe_enabled, false);
  await db.query("update plans.plan_sessions set logical_session_id=$2 where id=$1", [siblingRow.id, siblingRow.logical_session_id]);
  const saved = await submit();
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await flags((await onlySession(primary)).id)).rpe_enabled, false);
  assert.equal((await flags(siblingRow.id)).rpe_enabled, false);
  const draftWithNew = await openEditDraft(primary);
  const { rows: [newDay] } = await db.query("select id from plans.plan_days where plan_id=$1 and day_order=2", [draftWithNew]);
  const made = await http.api(coach.cookie, "/api/builder/blocks/" + newDay.id + "/sessions", {
    method: "POST", body: { name: "Added later", bta: "T" },
  });
  assert.equal(made.status, 201, made.text);
  const onDayTwo = async id => (await db.query(
    "select ps.id from plans.plan_sessions ps join plans.plan_days pd on pd.id=ps.plan_day_id where pd.plan_id=$1 and pd.day_order=2", [id],
  )).rows[0].id;
  const opened = await onDayTwo(draftWithNew);
  const enabled = await http.api(coach.cookie, draftSession(opened), { method: "PATCH", body: { trackingEnabled: true, rpeEnabled: true } });
  assert.equal(enabled.status, 200, enabled.text);
  const saveAll = id => http.api(coach.cookie, "/api/builder/plans/" + id + "/submit", { method: "POST", body: { batchScope: "all" } });
  const established = await saveAll(draftWithNew);
  assert.equal(established.status, 200, established.text);
  const siblingAdded = await onDayTwo(sibling);
  assert.equal((await flags(siblingAdded)).rpe_enabled, true);
  const draftAgain = await openEditDraft(primary);
  const disabled = await http.api(coach.cookie, draftSession(await onDayTwo(draftAgain)), { method: "PATCH", body: { rpeEnabled: false } });
  assert.equal(disabled.status, 200, disabled.text);
  const appliedAgain = await saveAll(draftAgain);
  assert.equal(appliedAgain.status, 200, appliedAgain.text);
  assert.equal((await flags(siblingAdded)).rpe_enabled, false);
});
test("first weekly batch Submit checks the current grant before activating any proven destination", async () => {
  const origin = await fixturePlan(athleteId, "active", "2027-07-05");
  const { rows: [athlete] } = await db.query("select athlete_id from public.athletes where id=$1", [athleteId]);
  const duplicate = async (weekStart) => {
    const response = await http.api(coach.cookie, "/api/builder/plans/" + origin.id + "/duplicate", {
      method: "POST", body: { athleteIds: [athlete.athlete_id], weekStart },
    });
    assert.equal(response.status, 201, response.text);
    return response.body.plan.id;
  };
  const primary = await duplicate("2027-07-12");
  const sibling = await duplicate("2027-07-19");
  await db.query("update plans.plans set builder_batch_id=$1 where id=any($2::uuid[])", [randomUUID(), [primary,sibling]]);
  const onlySession = async (id) => (await db.query(
    "select ps.id from plans.plan_sessions ps join plans.plan_days pd on pd.id=ps.plan_day_id where pd.plan_id=$1", [id],
  )).rows[0].id;
  const primarySession = await onlySession(primary);
  const node = await http.api(coach.cookie, draftSession(primarySession) + "/nodes", {
    method: "POST", body: { nodeType: "section", name: "Warm-up" },
  });
  assert.equal(node.status, 201, node.text);
  const changed = await http.api(coach.cookie, draftSession(primarySession), { method: "PATCH", body: { rpeEnabled: false } });
  assert.equal(changed.status, 200, changed.text);
  const originalSiblingSession = await onlySession(sibling);
  const originalSiblingFlags = await flags(originalSiblingSession);
  await db.query("update plans.plan_sessions set logical_session_id=$2 where id=$1", [originalSiblingSession,randomUUID()]);
  const partial = await http.api(coach.cookie, "/api/builder/plans/" + primary, {
    method: "PATCH", body: { name: "Primary survives refused sync", syncBatch: true },
  });
  assert.equal(partial.status, 200, partial.text);
  assert.equal(partial.body.plan.name, "Primary survives refused sync");
  assert.match(partial.body.batchSyncMessage, /other plans did not take/);
  assert.equal((await flags(originalSiblingSession)).rpe_enabled, true);
  await db.query("update plans.plan_sessions set logical_session_id=$2 where id=$1", [originalSiblingSession,originalSiblingFlags.logical_session_id]);
  const synced = await http.api(coach.cookie, "/api/builder/plans/" + primary + "/sync-batch", { method: "POST", body: {} });
  assert.equal(synced.status, 200, synced.text);
  const draftSiblingSession = await onlySession(sibling);
  assert.notEqual(draftSiblingSession, originalSiblingSession);
  assert.equal((await flags(draftSiblingSession)).rpe_enabled, false);
  assert.equal((await db.query(
    "select changed_rpe from training_load.builder_rpe_session_effects where plan_id=$1 and session_id=$2", [sibling,draftSiblingSession],
  )).rows[0].changed_rpe, true);
  const submit = () => http.api(coach.cookie, "/api/builder/plans/" + primary + "/submit", { method: "POST", body: { syncBatch: true } });
  const statuses = async () => (await db.query("select status from plans.plans where id=any($1::uuid[])", [[primary,sibling]])).rows.map(row => row.status);
  await setNativeRpeGrant(false);
  try {
    const denied = await submit();
    assert.equal(denied.status, 404, denied.text);
    assert.deepEqual(await statuses(), ["draft","draft"]);
    assert.equal((await flags(await onlySession(sibling))).rpe_enabled, false);
  } finally {
    await setNativeRpeGrant(true);
  }
  const accepted = await submit();
  assert.equal(accepted.status, 200, accepted.text);
  assert.deepEqual(await statuses(), ["active","active"]);
  const copied = await onlySession(sibling);
  assert.equal((await flags(copied)).rpe_enabled, false);
  const lineage = (await db.query(
    "select source_plan_id,source_session_id from training_load.builder_rpe_session_baselines where plan_id=$1 and session_id=$2", [sibling,copied],
  )).rows[0];
  assert.deepEqual(lineage, { source_plan_id: primary, source_session_id: primarySession });
});
test("assembled templates, duplicate weeks and group-day copies record the true inherited session IDs", async () => {
  const recipes = [
    await fixturePlan(athleteId, "active", "2027-08-02"),
    await fixturePlan(athleteId, "active", "2027-08-09"),
  ];
  const saved = await http.api(coach.cookie, "/api/builder/weekly-templates", {
    method: "POST", body: { name: "Assembled template", planIds: recipes.map(recipe => recipe.id) },
  });
  assert.equal(saved.status, 201, saved.text);
  const templateId = saved.body.plan.id;
  const inherited = async (planId) => (await db.query(
    `select b.session_id,b.source_plan_id,b.source_session_id, d.block_index
     from training_load.builder_rpe_session_baselines b
     join plans.plan_sessions s on s.id=b.session_id
     join plans.plan_days d on d.id=s.plan_day_id and d.plan_id=b.plan_id
     where b.plan_id=$1 order by d.block_index`, [planId],
  )).rows;
  const original = await inherited(templateId);
  assert.deepEqual(original.map(row => [row.source_plan_id,row.source_session_id]), recipes.map(row => [row.id,row.sessionId]));
  const duplicated = await http.api(coach.cookie, "/api/builder/plans/" + templateId + "/weeks", {
    method: "POST", body: { copyFrom: 1 },
  });
  assert.equal(duplicated.status, 201, duplicated.text);
  const copiedTemplateWeek = (await inherited(templateId))[2];
  assert.equal(copiedTemplateWeek.source_plan_id, templateId);
  assert.equal(copiedTemplateWeek.source_session_id, original[0].session_id);

  const { rows: [athlete] } = await db.query("select athlete_id from public.athletes where id=$1", [athleteId]);
  const weekly = await http.api(coach.cookie, "/api/builder/plans/" + recipes[0].id + "/duplicate", {
    method: "POST", body: { athleteIds: [athlete.athlete_id], weekStart: "2027-08-16" },
  });
  assert.equal(weekly.status, 201, weekly.text);
  const weeklyId = weekly.body.plan.id;
  const days = (await db.query("select id from plans.plan_days where plan_id=$1 order by day_order limit 2", [weeklyId])).rows;
  const sourceWeekSession = (await inherited(weeklyId))[0];
  const paste = await http.api(coach.cookie, "/api/builder/days/" + days[0].id + "/copy-into/" + days[1].id, { method: "POST", body: {} });
  assert.equal(paste.status, 200, paste.text);
  const pastedDay = (await inherited(weeklyId))[1];
  assert.equal(pastedDay.source_plan_id, weeklyId);
  assert.equal(pastedDay.source_session_id, sourceWeekSession.session_id);
});

test("the exact production predecessor can create a legacy draft during the v106 overlap", async () => {
  const predecessor = "4d7d0ced4f9f2eb5f2eb8d9b726295282d7e0555";
  const previous = await previousDashboardServer(project.url, {}, predecessor);
  const oldPost = async (path, body) => {
    const result = await fetch(previous.baseUrl + path, {
      method: "POST", headers: { cookie: coach.cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const text = await result.text();
    assert.ok(result.ok, text);
    return JSON.parse(text);
  };
  try {
    assert.equal(previous.commit, predecessor);
    const { rows: [athlete] } = await db.query("select athlete_id from public.athletes where id=$1", [athleteId]);
    const legacy = await oldPost("/api/builder/plans", {
      name: "Saved by the production predecessor", planType: "weekly", weekStart: "2027-09-06", athleteIds: [athlete.athlete_id],
    });
    const legacyId = legacy.plan.id;
    const session = await oldPost("/api/builder/blocks/" + legacy.blocks[0].id + "/sessions", { name: "Old saved session", bta: "T" });
    const sessionId = session.blocks.flatMap(block => block.sessions)[0].id;
    await oldPost(draftSession(sessionId) + "/nodes", { nodeType: "section", name: "Old content" });
    const before = await flags(sessionId);
    assert.equal((await db.query("select 1 from training_load.builder_rpe_plan_baselines where plan_id=$1", [legacyId])).rowCount, 0);

    const submitted = await http.api(coach.cookie, "/api/builder/plans/" + legacyId + "/submit", { method: "POST", body: {} });
    assert.equal(submitted.status, 200, submitted.text);
    assert.equal(submitted.body.plan.status, "active");
    assert.deepEqual(await flags(sessionId), before);
    assert.equal((await db.query("select 1 from training_load.builder_rpe_plan_baselines where plan_id=$1", [legacyId])).rowCount, 0);
  } finally {
    await previous.stop();
  }
});