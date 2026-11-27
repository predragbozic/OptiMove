import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { buildDatabase, fixtures, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

test("native Exercise content and lifecycle writes have independent staged permission checks", async () => {
  const database = await buildDatabase({ label: "exercise_manage", upTo: "202612091000_training_load_v107_builder_rpe_copy_attestation.sql" });
  const sql = new pg.Client({ connectionString: database.url });
  let server;
  try {
    await sql.connect();
    const fixture = fixtures(sql);
    const club = await fixture.club();
    const team = await fixture.team(club);
    const admin = await fixture.user("Club exercise author");
    const coach = await fixture.user("Team exercise author");
    const limited = await fixture.user("Team exercise reader");
    const platform = await fixture.user("Exercise platform admin");
    await fixture.grantPlatform(platform);
    await fixture.grantClub(admin, club);
    await fixture.grantTeam(coach, team);
    await fixture.grantTeam(limited, await fixture.team(club));
    await fixture.grantIndependent(coach);

    server = await startServer(database.url);
    const library = "/api/exercises";
    const write = (cookie, method, url, body) => server.api(cookie, url, { method, body });
    const adminCookie = await server.cookieFor(admin);
    const coachCookie = await server.cookieFor(coach);
    const limitedCookie = await server.cookieFor(limited);
    await write(coachCookie, "PUT", "/api/auth/workspace", { type: "team", scopeId: team }).then(result => assert.equal(result.status, 200, result.text));
    const create = (cookie, name) => write(cookie, "POST", library, { name });
    const forbiddenUnstaged = await create(adminCookie, "No exercise before staging");
    assert.equal(forbiddenUnstaged.status, 403, forbiddenUnstaged.text);

    // Deliberately limited to this disposable database and kept out of runtime/registry.
    assert.match(database.name, /^optimove_tests_/);
    const { rows: [functionRow] } = await sql.query("select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) as definition");
    const staged = functionRow.definition.replace("'exercises.use'", "'exercises.use','exercises.add','exercises.remove'");
    assert.notEqual(staged, functionRow.definition);
    const fixtureMigration = "fixtures/exercise-write-" + randomUUID();
    await sql.query("create table library.exercise_manage_v108_use(singleton boolean primary key)");
    await sql.query("begin");
    try {
      await sql.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
      await sql.query(staged);
      await sql.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('0',64),'test')", [fixtureMigration]);
      for (const [roleId, words] of [[ROLE_IDS.club_admin, ["exercises.add", "exercises.remove"]], [ROLE_IDS.team_coach, ["exercises.add"]]]) {
        const { rows: [role] } = await sql.query("update public.permission_roles set revision=revision+1,updated_at=now() where id=$1 returning revision", [roleId]);
        await sql.query("insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,items_added) values($1,$2,'migration',$3,$4)",
          [roleId, role.revision, fixtureMigration, words]);
        await sql.query("insert into public.permission_role_items(role_id,permission_word) select $1,word from unnest($2::text[]) word", [roleId, words]);
      }
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
    const plan = (await sql.query("insert into plans.plans(plan_type,created_by_user_id,name,status,source_type,visibility,is_template) values('program',$1,'Exercise test plan','draft','builder','private',true) returning id", [coach])).rows[0].id;
    const day = (await sql.query("insert into plans.plan_days(plan_id,date,day_order,block_index) values($1,'2027-01-05',1,1) returning id", [plan])).rows[0].id;
    const session = (await sql.query("insert into plans.plan_sessions(plan_day_id,name,bta) values($1,'Test session','T') returning id", [day])).rows[0].id;
    const section = (await sql.query("insert into plans.plan_nodes(plan_session_id,node_type,name,node_order) values($1,'section','Exercises',1) returning id", [session])).rows[0].id;
    const custom = (name, extra) => write(coachCookie, "POST", "/api/builder/nodes/" + section + "/custom-exercise", { name, ...extra });
    const customEffects = async name => (await sql.query("select (select count(*)::int from library.exercises where name=$1) as exercises, (select count(*)::int from plans.plan_items where plan_node_id=$2 and title=$1) as items", [name, section])).rows[0];
    const remoteClub = await fixture.club();
    const remoteTeam = await fixture.team(remoteClub);
    await fixture.grantTeam(coach, remoteTeam);
    async function otherSection(targetClub, targetTeam, visibility = "private") {
      const athleteUser = await fixture.user("Exercise target athlete");
      await fixture.makeAthlete(athleteUser);
      const athlete = (await sql.query("select id from public.athletes where user_id=$1",[athleteUser])).rows[0].id;
      await sql.query("insert into public.athlete_memberships(athlete_id,club_id,team_id,membership_type,status) values($1,$2,$3,'team','active')",[athlete,targetClub,targetTeam]);
      const planId = (await sql.query("insert into plans.plans(plan_type,created_by_user_id,athlete_id,name,status,source_type,visibility,is_template) values('program',$1,$2,'Other author plan','draft','builder',$3,false) returning id",[admin,athlete,visibility])).rows[0].id;
      const dayId = (await sql.query("insert into plans.plan_days(plan_id,date,day_order,block_index) values($1,'2027-01-12',1,1) returning id",[planId])).rows[0].id;
      const sessionId = (await sql.query("insert into plans.plan_sessions(plan_day_id,name,bta) values($1,'Target session','T') returning id",[dayId])).rows[0].id;
      return (await sql.query("insert into plans.plan_nodes(plan_session_id,node_type,name,node_order) values($1,'section','Exercises',1) returning id",[sessionId])).rows[0].id;
    }
    const nativeTarget = await otherSection(club, team);
    const remoteTarget = await otherSection(remoteClub, remoteTeam);
    const remotePublic = await otherSection(remoteClub, remoteTeam, "public");
    const targetWrite = (target, name, cookie = coachCookie) => write(cookie, "POST", "/api/builder/nodes/" + target + "/custom-exercise", {
      name, imageUrl: "https://example.test/old-exercise-image.png",
    });
    const stateDigest = async () => (await sql.query(`select
      (select jsonb_agg(e order by e.id) from library.exercises e) as exercises,
      (select jsonb_agg(i order by i.id) from plans.plan_items i) as items,
      (select jsonb_agg(a order by a.id) from media.assets a) as assets,
      (select jsonb_agg(u order by u.id) from media.uploads u) as uploads,
      (select count(*) from library.exercise_manage_v108_use) as marker`)).rows[0];
    const beforeBlocked = await stateDigest();
    const remoteOnly = await targetWrite(remoteTarget, "Other workspace exercise");
    assert.equal(remoteOnly.status, 403, remoteOnly.text);
    assert.deepEqual(await stateDigest(), beforeBlocked);

    const changeAthleteView = async (grant) => {
      const migration = "fixtures/athletes-view-" + randomUUID();
      await sql.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
      await sql.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('0',64),'test')",[migration]);
      const role = (await sql.query("update public.permission_roles set revision=revision+1,updated_at=now() where id=$1 returning revision",[ROLE_IDS.team_coach])).rows[0];
      const column = grant ? "items_added" : "items_removed";
      await sql.query(`insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,${column}) values($1,$2,'migration',$3,array['athletes.view'])`,
        [ROLE_IDS.team_coach,role.revision,migration]);
      const items = grant
        ? "insert into public.permission_role_items(role_id,permission_word) values($1,'athletes.view')"
        : "delete from public.permission_role_items where role_id=$1 and permission_word='athletes.view'";
      await sql.query(items,[ROLE_IDS.team_coach]);
    };
    const waitForWriter = async () => {
      for (let tries=0; tries<40; tries++) {
        await sql.query("select pg_stat_clear_snapshot()");
        const { rows: [probe] } = await sql.query("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%advisory_xact_lock_shared%exercise_collections%') as waiting");
        if (probe.waiting) return;
        await new Promise(resolve => setTimeout(resolve,25));
      }
      assert.fail("custom exercise must wait behind the held collection lock");
    };
    let queued;
    await sql.query("begin");
    try {
      await sql.query("select pg_advisory_xact_lock(hashtextextended('exercise_collections',0))");
      queued = targetWrite(nativeTarget, "Do not use stale Athletes View");
      await waitForWriter();
      await changeAthleteView(false);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
    const staleAthleteView = await queued;
    assert.equal(staleAthleteView.status, 403, staleAthleteView.text);
    assert.deepEqual(await stateDigest(), beforeBlocked);
    await sql.query("begin");
    try {
      await changeAthleteView(true);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }

    const privateCoach = await fixture.user("Private coach before workspace switch");
    await fixture.grantIndependent(privateCoach);
    await sql.query("insert into public.user_workspace_preferences(user_id,workspace_type) values($1,'private_coach')",[privateCoach]);
    const privateCookie = await server.cookieFor(privateCoach);
    const priorPrivate = await stateDigest();
    await sql.query("begin");
    let queuedPrivate;
    try {
      await sql.query("select pg_advisory_xact_lock(hashtextextended('exercise_collections',0))");
      queuedPrivate = create(privateCookie, "Do not use prior private workspace");
      await waitForWriter();
      await fixture.grantTeam(privateCoach, team);
      await sql.query("update public.user_workspace_preferences set workspace_type='team',scope_id=$2 where user_id=$1",[privateCoach,team]);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
    const switched = await queuedPrivate;
    assert.equal(switched.status, 403, switched.text);
    assert.deepEqual(await stateDigest(), priorPrivate);

    const publicResult = await targetWrite(remotePublic, "Public writable exception");
    assert.equal(publicResult.status, 201, publicResult.text);
    await sql.query("update public.user_team_roles set is_active=false where user_id=$1 and team_id=$2", [coach, remoteTeam]);
    const allowed = await custom("Builder Exercise Add");
    assert.equal(allowed.status, 201, allowed.text);
    assert.deepEqual(await customEffects("Builder Exercise Add"), { exercises: 1, items: 1 });
    await sql.query(staged.replace("'exercises.add',", ""));
    const noAdd = await custom("Builder Add denied");
    assert.equal(noAdd.status, 403, noAdd.text);
    assert.deepEqual(await customEffects("Builder Add denied"), { exercises: 0, items: 0 });
    await sql.query(staged.replace("'exercises.remove'", "'exercises.remove','exercises.media.upload'"));
    const noMedia = await custom("Builder media denied", { videoUrl: "https://example.test/exercise.mp4" });
    assert.equal(noMedia.status, 403, noMedia.text);
    assert.deepEqual(await customEffects("Builder media denied"), { exercises: 0, items: 0 });
    await sql.query(staged.replace("'exercises.remove'", "'exercises.remove','programs.edit'"));
    const noEdit = await custom("Builder edit denied");
    assert.equal(noEdit.status, 403, noEdit.text);
    assert.deepEqual(await customEffects("Builder edit denied"), { exercises: 0, items: 0 });
    await sql.query(staged);
    await sql.query("alter table plans.plan_items add constraint test_reject_new_item check (title <> 'Builder item rejected')");
    assert.equal((await custom("Builder item rejected")).status, 500);
    assert.deepEqual(await customEffects("Builder item rejected"), { exercises: 0, items: 0 });
    await sql.query("alter table plans.plan_items drop constraint test_reject_new_item");
    await sql.query("delete from public.user_workspace_preferences where user_id=$1", [coach]);
    const { lockExerciseWriter } = await import("../src/exerciseWriteAccess.js");
    const actorClient = new pg.Client({ connectionString: database.url });
    let racingWrite;
    await actorClient.connect();
    try {
      await sql.query("begin");
      await sql.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'private_coach',null)", [coach]);
      await actorClient.query("begin");
      racingWrite = lockExerciseWriter(actorClient, { user: { id: coach }, sessionToken: coachCookie.split("=")[1] }, { type: "team", scopeId: team }, "exercises.add");
      let waiting = false;
      for (let tries = 0; tries < 60 && !waiting; tries++) {
        await sql.query("select pg_stat_clear_snapshot()");
        waiting = (await sql.query("select cardinality(pg_blocking_pids($1)) > 0 as waiting", [actorClient.processID])).rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(waiting, "fallback waits for the competing first preference");
      await sql.query("commit");
      assert.equal(await racingWrite, false);
      assert.equal((await sql.query("select workspace_type from public.user_workspace_preferences where user_id=$1", [coach])).rows[0].workspace_type, "private_coach");
    } finally {
      await sql.query("rollback");
      if (racingWrite) await Promise.allSettled([racingWrite]);
      await actorClient.end();
    }
    await sql.query("delete from public.user_workspace_preferences where user_id=$1", [coach]);
    const added = await create(coachCookie, "Team-owned workspace personal exercise");
    assert.equal(added.status, 201, added.text);
    assert.deepEqual((await sql.query("select workspace_type,scope_id from public.user_workspace_preferences where user_id=$1", [coach])).rows[0], { workspace_type: "team", scope_id: team });
    const id = added.body.id;
    const path = library + "/" + id;
    const get = async () => (await sql.query("select name,owner_scope,owner_user_id,is_active from library.exercises where id=$1", [id])).rows[0];
    assert.deepEqual(await get(), { name: "Team-owned workspace personal exercise", owner_scope: "user", owner_user_id: coach, is_active: true });
    const changed = await write(coachCookie, "PATCH", path, { name: "Edited exercise" });
    assert.equal(changed.status, 200, changed.text);
    const foreign = await write(limitedCookie, "POST", path + "/copy", { name: "Foreign source" });
    assert.equal(foreign.status, 404, foreign.text);
    const copied = await write(coachCookie, "POST", path + "/copy", { name: "Private copy" });
    assert.equal(copied.status, 201, copied.text);
    for (const [method, suffix] of [["POST", "/archive"], ["POST", "/restore"], ["DELETE", ""]]) {
      const refused = await write(coachCookie, method, path + suffix);
      assert.equal(refused.status, 403, refused.text);
      assert.equal((await get()).is_active, true);
    }
    const classification = await write(coachCookie, "PUT", path + "/classification", { overrides: { place: "Personal place" } });
    assert.equal(classification.status, 200, classification.text);
    assert.equal((await write(coachCookie, "POST", path + "/hidden", { hidden: true })).status, 200);
    const adminExercise = await create(adminCookie, "Club admin exercise");
    assert.equal(adminExercise.status, 201, adminExercise.text);
    const adminPath = library + "/" + adminExercise.body.id;
    for (const [method, suffix, active] of [["POST", "/archive", false], ["POST", "/restore", true], ["DELETE", "", false]]) {
      const result = await write(adminCookie, method, adminPath + suffix);
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.isActive, active);
    }
    await sql.query("begin");
    let queuedCreate;
    let personalSwitch;
    try {
      await sql.query("select pg_advisory_xact_lock(hashtextextended('exercise_collections',0))");
      queuedCreate = create(coachCookie, "Do not use an obsolete workspace");
      let waiting = false;
      for (let tries = 0; tries < 40 && !waiting; tries++) {
        const { rows: [probe] } = await sql.query("select exists(select 1 from pg_stat_activity where datname=current_database() and backend_type='client backend' and wait_event_type='Lock' and query like '%advisory_xact_lock_shared%exercise_collections%') as waiting");
        waiting = probe.waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
        await sql.query("select pg_stat_clear_snapshot()");
      }
      assert.ok(waiting, "creation reached the transaction lock while native was active");
      personalSwitch = await write(coachCookie, "PUT", "/api/auth/workspace", { type: "private_coach" });
    } finally {
      await sql.query("rollback");
    }
    assert.equal((await queuedCreate).status, 403);
    assert.equal((await sql.query("select id from library.exercises where name=$1", ["Do not use an obsolete workspace"])).rowCount, 0);
    assert.equal(personalSwitch.status, 200, personalSwitch.text);
    // A closed licence still blocks a club admin with both staged words.
    await sql.query("begin");
    try {
      await sql.query("select set_config('optimove.permission_actor',$1 || ':' || pg_current_xact_id()::text,true)", [platform]);
      await sql.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
      await sql.query("insert into public.club_permission_ceiling(club_id,module_word,closed_by_user_id,reason) values($1,'exercises',$2,'test')", [club, platform]);
      await sql.query("insert into public.club_permission_ceiling_changes(club_id,module_word,action,performed_by_user_id,reason) values($1,'exercises','close',$2,'test')", [club, platform]);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      throw error;
    }
    const closed = await create(adminCookie, "Do not write through the closed licence");
    assert.equal(closed.status, 403, closed.text);
    assert.equal((await sql.query("select id from library.exercises where name=$1", ["Do not write through the closed licence"])).rowCount, 0);
    const legacyArchive = await write(coachCookie, "POST", path + "/archive");
    assert.equal(legacyArchive.status, 200, legacyArchive.text);
    assert.equal((await get()).is_active, false);
  } finally {
    await server?.stop();
    await sql.end();
    await database.drop();
  }
});
