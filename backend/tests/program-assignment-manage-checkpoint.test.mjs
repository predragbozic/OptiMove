import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { buildDatabase, fixtures, startServer } from "./support/permission-roles-world.mjs";
import { prepareProgramAssignmentWords } from "./support/program-assignment-grants.mjs";

const assign = "programs.assign";
const publish = "programs.publish";
const edit = "programs.edit";
const v109 = "202612111000_programs_v109_edit_bridge.sql";

test("native assignments keep Assign and Publish separate and check scope before replay", async () => {
  const database = await buildDatabase({ label: "program_assign_checkpoint", upTo: v109 });
  const sql = new pg.Client({ connectionString: database.url });
  let server;
  const priorDatabase = process.env.DATABASE_URL;
  try {
    await sql.connect();
    const f = fixtures(sql);
    const club = await f.club("Club A");
    const team = await f.team(club, "Team A");
    const otherTeam = await f.team(club, "Team B");
    const coach = await f.user("Active coach");
    await f.grantTeam(coach, team);
    await f.grantTeam(coach, otherTeam);
    await sql.query(`insert into public.user_workspace_preferences(user_id,workspace_type,scope_id)
      values ($1,'team',$2)`, [coach, team]);
    const stage = await prepareProgramAssignmentWords(sql, [assign, publish, edit]);
    const athlete = async (teamId, name) => {
      const user = await f.user(name);
      const external = "pc" + randomUUID().replaceAll("-", "");
      const { id } = (await sql.query(`insert into public.athletes (user_id,athlete_id,source_external_id,first_name,last_name,full_name,display_name,is_active)
        values($1,$2,$2,$3,'Fixture',$3,$3,true) returning id`, [user, external, name])).rows[0];
      await sql.query(`insert into public.athlete_memberships(athlete_id,membership_type,club_id,team_id,status)
        values($1,'team',$2,$3,'active')`, [id, club, teamId]);
      return { id, external };
    };
    const own = await athlete(team, "Own athlete");
    const foreign = await athlete(otherTeam, "Hidden athlete");
    const source = (await sql.query(`insert into plans.plans
      (plan_type,created_by_user_id,name,is_template,status,source_type,visibility)
      values('program',$1,'Assignment source',true,'active','builder','private') returning id`, [coach])).rows[0].id;
    server = await startServer(database.url);
    const cookie = await server.cookieFor(coach);
    const post = (path, body) => server.api(cookie, path, { method: "POST", body });
    const duplicatePath = `/api/builder/plans/${source}/duplicate`;
    const assignmentPath = `/api/templates/${source}/assignments`;
    const publishRequest = { intent: "assign", athleteIds: [own.external], assignmentRequestId: randomUUID() };
    const effects = async () => (await sql.query(`select
      (select count(*)::int from plans.plans where athlete_id=$1 and status='active') active,
      (select count(*)::int from public.builder_assignment_requests where id=$2) requests,
      (select count(*)::int from public.app_notifications where type='specific_program_assigned') notifications,
      (select count(*)::int from library.program_access where plan_id=$3 and user_id<>$4) grants`,
    [own.id, publishRequest.assignmentRequestId, source, coach])).rows[0];

    await stage([publish]);
    const noAssign = await post(duplicatePath, publishRequest);
    assert.equal(noAssign.status, 403, noAssign.text);
    assert.equal((await post(assignmentPath, { athleteIds: [own.id] })).status, 403);
    assert.deepEqual(await effects(), { active: 0, requests: 0, notifications: 0, grants: 0 });

    await stage([assign]);
    const noPublish = await post(duplicatePath, publishRequest);
    assert.equal(noPublish.status, 403, noPublish.text);
    assert.equal((await post(duplicatePath, { intent: "copy" })).status, 403);
    await stage([edit]);
    const draft = await post(duplicatePath, { intent: "copy" });
    assert.equal(draft.status, 201, draft.text);
    assert.equal(draft.body.plan.status, "draft");
    await stage([assign]);
    const missing = randomUUID();
    const savedSource = async () => (await sql.query(
      "select to_jsonb(p) as snapshot from plans.plans p where p.id=$1", [source],
    )).rows[0].snapshot;
    const beforeGrant = await savedSource();
    const explicit = await post(assignmentPath, { athleteIds: [own.id, foreign.id, missing] });
    assert.equal(explicit.status, 201, explicit.text);
    assert.equal(explicit.body.assigned.length, 1);
    assert.equal(explicit.body.assigned[0].athleteId, own.id);
    assert.deepEqual(explicit.body.skipped, [foreign.id, missing].map(athleteId => ({ athleteId, reason: "Athlete not found." })));
    assert.deepEqual(await savedSource(), beforeGrant, "Granting access leaves publication and all template fields unchanged");
    assert.deepEqual(await effects(), { active: 0, requests: 0, notifications: 0, grants: 1 });

    // Revoke Assign while the request is waiting for the club ceiling.
    // Granting it from the earlier request actor would write a second entitlement.
    const queuedTarget = await athlete(team, "Queued athlete");
    await sql.query("begin");
    let waitingAssignment;
    try {
      await sql.query("select public.lock_club_ceiling($1::uuid[], 'exclusive')", [[club]]);
      waitingAssignment = post(assignmentPath, { athleteIds: [queuedTarget.id] });
      let blocked = false;
      for (let attempt = 0; attempt < 40 && !blocked; attempt++) {
        await sql.query("select pg_stat_clear_snapshot()");
        blocked = (await sql.query(`select exists(select 1 from pg_stat_activity
          where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'
          and wait_event='advisory' and query like 'select public.lock_club_ceiling(%') blocked`)).rows[0].blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 15));
      }
      assert.ok(blocked, "Template assignment waits behind the club ceiling");
      await stage([publish]);
      await sql.query("commit");
      const denied = await waitingAssignment;
      assert.equal(denied.status, 403, denied.text);
    } finally {
      await sql.query("rollback");
      await waitingAssignment;
    }
    assert.deepEqual(await savedSource(), beforeGrant);
    assert.deepEqual(await effects(), { active: 0, requests: 0, notifications: 0, grants: 1 });

    await stage([assign, publish]);
    const foreignResponse = await post(duplicatePath, { ...publishRequest, athleteIds: [foreign.external] });
    assert.equal(foreignResponse.status, 409, foreignResponse.text);
    assert.match(foreignResponse.body.error, /Your workspace changed/);
    const published = await post(duplicatePath, publishRequest);
    assert.equal(published.status, 201, published.text);
    assert.deepEqual(await effects(), { active: 1, requests: 1, notifications: 1, grants: 1 });
    await stage([assign]);
    assert.equal((await post(duplicatePath, publishRequest)).status, 403);
    await stage([assign, publish]);
    const replay = await post(duplicatePath, publishRequest);
    assert.equal(replay.status, 201, replay.text);
    assert.deepEqual(replay.body.assignments, published.body.assignments);
    assert.deepEqual(await effects(), { active: 1, requests: 1, notifications: 1, grants: 1 });

    await stage([assign, publish, edit]);
    const weeklyTemplate = await post("/api/builder/plans", { planType: "program", templateKind: "weekly", weeks: 1, name: "Weekly source" });
    assert.equal(weeklyTemplate.status, 201, weeklyTemplate.text);
    const weeklySource = weeklyTemplate.body.plan.id;
    const firstDay = weeklyTemplate.body.blocks[0].id;
    const timedSession = await post(`/api/builder/blocks/${firstDay}/sessions`, { name: "First version", bta: "T" });
    assert.equal(timedSession.status, 201, timedSession.text);
    const weeklyPath = `/api/builder/plans/${weeklySource}/assign-weekly`;
    const weeklyBody = (startDate, options = {}) => ({ athleteIds: [own.external], assignmentRequestId: randomUUID(), startDate, ...options });
    const first = weeklyBody("2027-01-04");
    const cleanup = weeklyBody("2027-01-11");
    const scratch = await post("/api/builder/plans", { planType: "weekly", weekStart: cleanup.startDate, athleteIds: [own.external] });
    assert.equal(scratch.status, 201, scratch.text);
    const scratchStatus = async () => (await sql.query("select status from plans.plans where id=$1", [scratch.body.plan.id])).rows[0]?.status;
    const weeklyReceipts = async () => (await sql.query("select count(*)::int n from public.builder_assignment_requests where source_plan_id=$1", [weeklySource])).rows[0].n;

    await stage([assign, edit]);
    assert.equal((await post(weeklyPath, first)).status, 403);
    assert.equal(await weeklyReceipts(), 0);
    await stage([assign, publish]);
    assert.equal((await post(weeklyPath, cleanup)).status, 403);
    assert.equal(await scratchStatus(), "draft");
    assert.equal(await weeklyReceipts(), 0);
    const placed = await post(weeklyPath, first);
    assert.equal(placed.status, 201, placed.text);
    assert.equal(placed.body.created.length, 1);
    const target = placed.body.created[0].planId;
    const { owner_scope, owner_team_id } = (await sql.query("select owner_scope,owner_team_id from training_load.plan_workspace_ownership where plan_id=$1", [target])).rows[0];
    assert.deepEqual([owner_scope, owner_team_id], ["team", team]);
    const stored = async () => (await sql.query(`select p.status, ps.name from plans.plans p
      join plans.plan_days pd on pd.plan_id=p.id join plans.plan_sessions ps on ps.plan_day_id=pd.id
      where p.id=$1 order by ps.id`, [target])).rows;
    assert.deepEqual(await stored(), [{ status: "active", name: "First version" }]);

    await sql.query("update plans.plan_sessions set name='Second version' where plan_day_id=$1", [firstDay]);
    const ask = await post(weeklyPath, weeklyBody(first.startDate));
    assert.equal(ask.status, 409, ask.text);
    const replacement = weeklyBody(first.startDate, { choice: "replace", choiceToken: ask.body.choiceToken });
    assert.equal((await post(weeklyPath, replacement)).status, 403);
    assert.deepEqual(await stored(), [{ status: "active", name: "First version" }]);
    assert.equal(await weeklyReceipts(), 1);
    await stage([assign, edit]);
    const replaced = await post(weeklyPath, replacement);
    assert.equal(replaced.status, 201, replaced.text);
    assert.deepEqual(replaced.body.replaced.map(result => result.planId), [target]);
    assert.deepEqual(replaced.body.created, []);
    assert.deepEqual(await stored(), [{ status: "active", name: "Second version" }]);
    assert.equal((await post(weeklyPath, first)).status, 403);

    await stage([assign, publish]);
    assert.equal((await post(weeklyPath, replacement)).status, 403);
    assert.deepEqual((await post(weeklyPath, first)).body, placed.body);
    await stage([assign, publish, edit]);
    assert.deepEqual((await post(weeklyPath, replacement)).body, replaced.body);
    const withCleanup = await post(weeklyPath, cleanup);
    assert.equal(withCleanup.status, 201, withCleanup.text);
    assert.equal(await scratchStatus(), undefined);
    assert.equal(await weeklyReceipts(), 3);

    const checkedEditEffects = async request => (await sql.query(
      "select edited_plan_ids,removed_plan_ids,scope_type,scope_id from plans.program_edit_v109_assignment_evidence where request_id=$1",
      [request.assignmentRequestId],
    )).rows[0];
    assert.deepEqual(await checkedEditEffects(first),
      { edited_plan_ids: [], removed_plan_ids: [], scope_type: "team", scope_id: team });
    assert.deepEqual(await checkedEditEffects(replacement),
      { edited_plan_ids: [target], removed_plan_ids: [], scope_type: "team", scope_id: team });
    assert.deepEqual(await checkedEditEffects(cleanup),
      { edited_plan_ids: [], removed_plan_ids: [scratch.body.plan.id], scope_type: "team", scope_id: team });
    await stage([assign, publish]);
    assert.equal((await post(weeklyPath, cleanup)).status, 403);
    await stage([assign, publish, edit]);
    assert.deepEqual((await post(weeklyPath, cleanup)).body, withCleanup.body);
    assert.equal(await weeklyReceipts(), 3);

    // A request that began with Publish must still check it after the club's role-write lock releases.
    await sql.query("begin");
    let waiting;
    try {
      await sql.query("select public.lock_club_ceiling(array[$1::uuid],'exclusive')", [club]);
      waiting = post(weeklyPath, weeklyBody("2027-01-18"));
      let blocked = false;
      for (let attempt = 0; attempt < 30 && !blocked; attempt += 1) {
        await sql.query("select pg_stat_clear_snapshot()");
        const { rows: [state] } = await sql.query(`select exists (
          select 1 from pg_stat_activity where pid<>pg_backend_pid() and datname=current_database()
            and wait_event_type='Lock' and wait_event='advisory' and query like 'select public.lock_club_ceiling(%'
        ) as blocked`);
        blocked = state.blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(blocked, "the live assignment waited behind the club's permission lock");
      await stage([assign, edit]);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      await waiting;
      throw error;
    }
    const afterRevoke = await waiting;
    assert.equal(afterRevoke.status, 403, afterRevoke.text);
    assert.equal(await weeklyReceipts(), 3);
    assert.equal((await sql.query("select count(*)::int n from plans.plans where athlete_id=$1 and week_start='2027-01-18'", [own.id])).rows[0].n, 0);

    // Stored weekly plans are never templates. The dated template uses assign-weekly.
    const weeklyDuplicate = `/api/builder/plans/${target}/duplicate`;
    const duplicateWeek = (weekStart, intent) => ({
      weekStart, intent, athleteIds: [own.external], assignmentRequestId: randomUUID(),
    });
    await stage([edit]);
    const draftWeek = await post(weeklyDuplicate, duplicateWeek("2027-01-25", "copy"));
    assert.equal(draftWeek.status, 201, draftWeek.text);
    assert.equal(draftWeek.body.plan.status, "draft");

    const freeWeek = "2027-02-01";
    const free = await post("/api/builder/plans", { planType: "weekly", weekStart: freeWeek, athleteIds: [own.external] });
    assert.equal(free.status, 201, free.text);
    const freeDraftExists = async () => (await sql.query("select status from plans.plans where id=$1", [free.body.plan.id])).rows[0]?.status;
    const copyWithCleanup = duplicateWeek(freeWeek, "copy");
    const assignWithCleanup = duplicateWeek(freeWeek, "assign");
    await stage([assign, publish]);
    assert.equal((await post(weeklyDuplicate, copyWithCleanup)).status, 403);
    const invalidAssignment = await post(weeklyDuplicate, assignWithCleanup);
    assert.equal(invalidAssignment.status, 400, invalidAssignment.text);
    assert.match(invalidAssignment.body.error, /Only a template can be assigned/);
    assert.equal(await freeDraftExists(), "draft");
    assert.equal((await sql.query("select count(*)::int n from public.builder_assignment_requests where id=$1", [assignWithCleanup.assignmentRequestId])).rows[0].n, 0);
    await stage([edit]);
    const draftOverEmpty = await post(weeklyDuplicate, copyWithCleanup);
    assert.equal(draftOverEmpty.status, 201, draftOverEmpty.text);
    assert.equal(draftOverEmpty.body.plan.status, "draft");
    assert.equal(await freeDraftExists(), undefined);

    const metadataPath = `/api/templates/${weeklySource}/metadata`;
    const metadata = (programStatus, libraryScope, description) => server.api(cookie, metadataPath, {
      method: "PATCH", body: { programStatus, libraryScope, description },
    });
    const savedMetadata = async () => (await sql.query("select status,library_scope,note from plans.plans where id=$1", [weeklySource])).rows[0];
    await stage([edit]);
    assert.equal((await metadata("published", "workspace", "Held as draft")).status, 200);
    assert.deepEqual(await savedMetadata(), { status: "draft", library_scope: "workspace", note: "Held as draft" });
    assert.equal((await metadata("published", "my", "Publication denied")).status, 403);
    assert.deepEqual(await savedMetadata(), { status: "draft", library_scope: "workspace", note: "Held as draft" });
    await stage([publish, edit]);
    const activated = await metadata("published", "my", "Now published");
    assert.equal(activated.status, 200, activated.text);
    assert.deepEqual(await savedMetadata(), { status: "active", library_scope: "my", note: "Now published" });
    await stage([edit]);
    const revised = await metadata("active", "my", "Edited after publishing");
    assert.equal(revised.status, 200, revised.text);
    assert.deepEqual(await savedMetadata(), { status: "active", library_scope: "my", note: "Edited after publishing" });

    const submit = (planId, body = {}) => post(`/api/builder/plans/${planId}/submit`, body);
    const weekDraft = async (weekStart, athleteIds = [own.external]) => {
      const created = await post("/api/builder/plans", { planType: "weekly", weekStart, athleteIds, name: "Submit test" });
      assert.equal(created.status, 201, created.text);
      return created.body;
    };
    const addContent = async (draft) => {
      const added = await post(`/api/builder/blocks/${draft.blocks[0].id}/sessions`, { name: "Submit session", bta: "T" });
      assert.equal(added.status, 201, added.text);
      const session = added.body.blocks[0].sessions[0];
      const node = await post(`/api/builder/sessions/${session.id}/nodes`, { nodeType: "domain", name: "Submit content" });
      assert.equal(node.status, 201, node.text);
    };
    const planStatus = async id => (await sql.query("select status from plans.plans where id=$1", [id])).rows[0]?.status;
    const weeklyNotifications = async () => (await sql.query("select count(*)::int n from public.app_notifications where type='weekly_plan_assigned'")).rows[0].n;
    const noContent = await weekDraft("2027-03-01");
    await stage([publish]);
    assert.equal((await submit(noContent.plan.id)).status, 403);
    assert.equal(await planStatus(noContent.plan.id), "draft");
    await stage([edit]);
    const cleaned = await submit(noContent.plan.id);
    assert.equal(cleaned.status, 200, cleaned.text);
    assert.equal(cleaned.body.deleted, true);
    assert.equal(await planStatus(noContent.plan.id), undefined);

    const ordinary = await weekDraft("2027-03-08");
    await addContent(ordinary);
    const initialNotificationCount = await weeklyNotifications();
    assert.equal((await submit(ordinary.plan.id)).status, 403);
    assert.equal(await planStatus(ordinary.plan.id), "draft");
    assert.equal(await weeklyNotifications(), initialNotificationCount);
    await stage([publish]);
    const recorded = [];
    const realQueries = new Map();
    const observe = (client) => {
      if (realQueries.has(client)) return;
      const query = client.query;
      realQueries.set(client, query);
      client.query = function (statement, ...args) {
        recorded.push({ client, sql: String(typeof statement === "string" ? statement : statement?.text).replace(/\s+/g, " "), params: args[0] });
        return query.call(client, statement, ...args);
      };
    };
    server.pool.on("acquire", observe);
    try {
      const published = await submit(ordinary.plan.id);
      assert.equal(published.status, 200, published.text);
    } finally {
      server.pool.off("acquire", observe);
      for (const [client, query] of realQueries) client.query = query;
    }
    const publishStatement = recorded.find(entry => entry.sql.includes("public.user_has_permission")
      && entry.params?.[3]?.includes("programs.publish"));
    assert.ok(publishStatement, "the recording contains the native Publish check");
    const statements = recorded.filter(entry => entry.client === publishStatement.client);
    const reuse = statements.findIndex(entry => entry.sql.includes("hashtextextended('exercise_collections'"));
    const provenance = statements.findIndex(entry => entry.params?.[0] === "builder-rpe-provenance-v106");
    const ceiling = statements.findIndex(entry => entry.sql.includes("select public.lock_club_ceiling("));
    const targetLock = statements.findIndex(entry => entry.sql.includes("from plans.plans where id=$1 for update"));
    const publishCheck = statements.indexOf(publishStatement);
    const activation = statements.findIndex(entry => entry.sql.includes("update plans.plans set status = 'active'"));
    assert.ok(reuse >= 0 && reuse < provenance && provenance < ceiling && ceiling < targetLock
      && targetLock < publishCheck && publishCheck < activation,
    JSON.stringify({ reuse, provenance, ceiling, targetLock, publishCheck, activation }));
    assert.equal(await planStatus(ordinary.plan.id), "active");
    assert.equal(await weeklyNotifications(), initialNotificationCount + 1);
    await stage([]);
    assert.equal((await submit(ordinary.plan.id)).status, 200);
    assert.equal(await weeklyNotifications(), initialNotificationCount + 1);

    await stage([edit]);
    const opened = await post(`/api/builder/plans/${ordinary.plan.id}/edit`, {});
    assert.equal(opened.status, 200, opened.text);
    const draftId = opened.body.plan.id;
    await stage([publish]);
    assert.equal((await submit(draftId)).status, 403);
    assert.equal(await planStatus(draftId), "draft");
    await stage([edit]);
    const edited = await submit(draftId);
    assert.equal(edited.status, 200, edited.text);
    assert.equal(await planStatus(draftId), undefined);
    assert.equal(await weeklyNotifications(), initialNotificationCount + 1);

    const reopening = await post(`/api/builder/plans/${ordinary.plan.id}/edit`, {});
    assert.equal(reopening.status, 200, reopening.text);
    await sql.query("update plans.plans set status='archived' where id=$1", [ordinary.plan.id]);
    assert.equal((await submit(reopening.body.plan.id)).status, 403);
    assert.equal(await planStatus(ordinary.plan.id), "archived");
    await stage([edit, publish]);
    const reactivated = await submit(reopening.body.plan.id);
    assert.equal(reactivated.status, 200, reactivated.text);
    assert.equal(await planStatus(ordinary.plan.id), "active");
    assert.equal(await weeklyNotifications(), initialNotificationCount + 1);

    const ownSecond = await athlete(team, "Second own athlete");
    const batchDraft = await weekDraft("2027-03-15", [own.external, ownSecond.external]);
    await addContent(batchDraft);
    const batchStatus = async () => (await sql.query(`select status from plans.plans
      where builder_batch_id=(select builder_batch_id from plans.plans where id=$1) order by id`, [batchDraft.plan.id])).rows.map(row => row.status);
    await stage([publish]);
    assert.equal((await submit(batchDraft.plan.id, { syncBatch: true })).status, 403);
    assert.deepEqual(await batchStatus(), ["draft", "draft"]);
    await stage([edit]);
    assert.equal((await submit(batchDraft.plan.id, { syncBatch: true })).status, 403);
    assert.deepEqual(await batchStatus(), ["draft", "draft"]);
    await stage([edit, publish]);
    await sql.query("update public.athlete_memberships set status='paused' where athlete_id=$1 and team_id=$2", [ownSecond.id, team]);
    await sql.query("insert into public.athlete_memberships(athlete_id,membership_type,club_id,team_id,status) values($1,'team',$2,$3,'active')",
      [ownSecond.id, club, otherTeam]);
    assert.equal((await submit(batchDraft.plan.id, { syncBatch: true })).status, 404);
    assert.deepEqual(await batchStatus(), ["draft", "draft"]);
    assert.equal(await weeklyNotifications(), initialNotificationCount + 1);
    await sql.query("update public.athlete_memberships set status='paused' where athlete_id=$1 and team_id=$2", [ownSecond.id, otherTeam]);
    await sql.query("update public.athlete_memberships set status='active' where athlete_id=$1 and team_id=$2", [ownSecond.id, team]);
    const publishedBatch = await submit(batchDraft.plan.id, { syncBatch: true });
    assert.equal(publishedBatch.status, 200, publishedBatch.text);
    assert.deepEqual(await batchStatus(), ["active", "active"]);
    assert.equal(await weeklyNotifications(), initialNotificationCount + 3);

    const emptyBatch = await weekDraft("2027-03-22", [own.external, ownSecond.external]);
    await stage([edit]);
    const discardedBatch = await submit(emptyBatch.plan.id, { syncBatch: true });
    assert.equal(discardedBatch.status, 200, discardedBatch.text);
    assert.equal(discardedBatch.body.deleted, true);
    assert.equal(discardedBatch.body.deletedIds.length, 2);
    assert.equal(await weeklyNotifications(), initialNotificationCount + 3);

    // A private assignment uses the existing direct athlete relationship.
    // An unrelated native role of the same person cannot extend it.
    const privateCoach = await f.user("Private coach");
    await f.grantIndependent(privateCoach);
    await f.grantTeam(privateCoach, otherTeam);
    await sql.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'private_coach',null)", [privateCoach]);
    await sql.query(`insert into public.user_athletes(user_id,athlete_id,relationship_type,is_active)
      values($1,$2,'coach',true)`, [privateCoach, own.id]);
    const privateSource = (await sql.query(`insert into plans.plans
      (plan_type,created_by_user_id,name,is_template,status,source_type,visibility)
      values('program',$1,'Private source',true,'active','builder','private') returning id`, [privateCoach])).rows[0].id;
    const privateResult = await server.api(await server.cookieFor(privateCoach), `/api/templates/${privateSource}/assignments`, {
      method: "POST", body: { athleteIds: [foreign.id, own.id] },
    });
    assert.equal(privateResult.status, 201, privateResult.text);
    assert.deepEqual(privateResult.body.assigned.map(athlete => athlete.athleteId), [own.id]);
    assert.deepEqual(privateResult.body.skipped, [{ athleteId: foreign.id, reason: "Athlete not found." }]);
  } finally {
    await server?.stop();
    if (priorDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabase;
    await sql.end().catch(() => {});
    await database.drop();
  }
});
