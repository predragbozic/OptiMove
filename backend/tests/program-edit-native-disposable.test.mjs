import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { buildDatabase, fixtures, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

test("Program Edit refreshes the native grant under lock and keeps the target within the active team", async () => {
  const database = await buildDatabase({ label: "program_edit", upTo: "202612111000_programs_v109_edit_bridge.sql" });
  const sql = new pg.Client({ connectionString: database.url });
  let server;
  try {
    await sql.connect();
    const fixture = fixtures(sql);
    const club = await fixture.club();
    const team = await fixture.team(club);
    const otherClub = await fixture.club();
    const otherTeam = await fixture.team(otherClub);
    const coach = await fixture.user("Program Edit coach");
    const anotherCoach = await fixture.user("Other team author");
    await fixture.grantTeam(coach, team);
    await fixture.grantTeam(coach, otherTeam);
    await sql.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'team',$2)", [coach, team]);
    async function planFor(sourceClub, sourceTeam, creator = anotherCoach) {
      const user = await fixture.user("Assigned athlete");
      const code = "pe" + randomUUID().replaceAll("-", "");
      const { rows: [athlete] } = await sql.query(
        "insert into public.athletes(user_id,athlete_id,source_external_id,first_name,last_name,full_name,display_name,is_active) values($1,$2,$2,'Assigned','Athlete','Assigned Athlete','Assigned Athlete',true) returning id",
        [user, code],
      );
      await sql.query(
        "insert into public.athlete_memberships(athlete_id,membership_type,club_id,team_id,status) values($1,'team',$2,$3,'active')",
        [athlete.id, sourceClub, sourceTeam],
      );
      const plan = (await sql.query(
        "insert into plans.plans(plan_type,created_by_user_id,name,status,source_type,visibility,athlete_id,is_template,week_start) values('weekly',$1,'Original','draft','builder','private',$2,false,'2026-11-23') returning id",
        [creator, athlete.id],
      )).rows[0].id;
      await sql.query(
        "insert into training_load.plan_workspace_ownership(plan_id,owner_scope,owner_team_id) values($1,'team',$2)",
        [plan, sourceTeam],
      );
      return plan;
    }
    const local = await planFor(club, team);
    const foreign = await planFor(otherClub, otherTeam);
    const foreignOwned = await planFor(otherClub, otherTeam, coach);
    assert.match(database.name, /^optimove_tests_/);
    const changeGrant = async grant => {
      const migration = "fixtures/program-edit-" + randomUUID();
      await sql.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
      await sql.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('0',64),'test')", [migration]);
      const { rows: [role] } = await sql.query("update public.permission_roles set revision=revision+1,updated_at=now() where id=$1 returning revision", [ROLE_IDS.team_coach]);
      const column = grant ? "items_added" : "items_removed";
      await sql.query(`insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,${column}) values($1,$2,'migration',$3,array['programs.edit'])`, [ROLE_IDS.team_coach, role.revision, migration]);
      const change = grant
        ? "insert into public.permission_role_items(role_id,permission_word) values($1,'programs.edit')"
        : "delete from public.permission_role_items where role_id=$1 and permission_word='programs.edit'";
      await sql.query(change, [ROLE_IDS.team_coach]);
    };
    const grant = async enabled => {
      await sql.query("begin");
      try {
        await changeGrant(enabled);
        await sql.query("commit");
      } catch (error) {
        await sql.query("rollback");
        throw error;
      }
    };
    server = await startServer(database.url);
    const cookie = await server.cookieFor(coach);
    const rename = (id, name) => server.api(cookie, "/api/builder/plans/" + id, { method: "PATCH", body: { name } });
    const digest = async () => (await sql.query(
      "select (select array_agg(name order by id) from plans.plans where id=any($1::uuid[])) as names,(select count(*)::int from plans.program_manage_v109_use) as marker",
      [[local, foreign, foreignOwned]],
    )).rows[0];
    const initial = await digest();
    await grant(false);
    assert.equal((await rename(local, "Denied")).status, 403);
    assert.deepEqual(await digest(), initial);
    await grant(true);
    const other = await rename(foreign, "Foreign");
    assert.equal(other.status, 404, other.text);
    const authorInWrongTeam = await rename(foreignOwned, "Foreign even for the author");
    assert.equal(authorInWrongTeam.status, 404, authorInWrongTeam.text);
    assert.deepEqual(await digest(), initial);

    await sql.query("begin");
    let pending;
    try {
      await sql.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
      pending = rename(local, "Waiting");
      let waiting = false;
      for (let attempt = 0; attempt < 80 && !waiting; attempt++) {
        await sql.query("select pg_stat_clear_snapshot()");
        ({ rows: [{ waiting }] } = await sql.query(
          "select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%lock_club_ceiling%') as waiting",
        ));
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(waiting, true, "write must wait for the club ceiling");
      await changeGrant(false);
      await sql.query("commit");
    } catch (error) {
      await sql.query("rollback");
      await pending?.catch(() => {});
      throw error;
    }
    const revoked = await pending;
    assert.equal(revoked.status, 403, revoked.text);
    assert.deepEqual(await digest(), initial);
    await grant(true);
    await sql.query("alter table plans.plans add constraint program_edit_test_reject_check check (name <> 'Rejected within the transaction')");
    try {
      const failed = await rename(local, "Rejected within the transaction");
      assert.equal(failed.status, 500, failed.text);
      assert.deepEqual(await digest(), initial);
    } finally {
      await sql.query("alter table plans.plans drop constraint program_edit_test_reject_check");
    }
    const result = await rename(local, "Allowed");
    assert.equal(result.status, 200, result.text);
    assert.equal((await digest()).marker, 1);
    const switched = await server.api(cookie, "/api/auth/workspace", { method: "PUT", body: { type: "team", scopeId: otherTeam } });
    assert.equal(switched.status, 200, switched.text);
    const validForeignOwner = await rename(foreignOwned, "Allowed now");
    assert.equal(validForeignOwner.status, 200, validForeignOwner.text);
    const write = (path, method, body) => server.api(cookie, path, { method, body });
    const choose = teamId => write("/api/auth/workspace", "PUT", { type: "team", scopeId: teamId });
    assert.equal((await choose(team)).status, 200);
    const builder = "/api/builder";
    const created = await write(builder + "/plans", "POST", { planType: "program", name: "Program with child edits" });
    assert.equal(created.status, 201, created.text);
    const programId = created.body.plan.id;
    const createdBlock = await write(builder + "/plans/" + programId + "/blocks", "POST", { name: "Block" });
    assert.equal(createdBlock.status, 201, createdBlock.text);
    const blockId = createdBlock.body.blocks[0].id;
    const createdSession = await write(builder + "/blocks/" + blockId + "/sessions", "POST", { name: "Original session" });
    assert.equal(createdSession.status, 201, createdSession.text);
    const sessionId = createdSession.body.blocks[0].sessions[0].id;
    const createdNode = await write(builder + "/sessions/" + sessionId + "/nodes", "POST", { nodeType: "section", name: "Original section" });
    assert.equal(createdNode.status, 201, createdNode.text);
    const nodeId = createdNode.body.blocks[0].sessions[0].nodes[0].id;
    const weeklyTemplate = await write(builder + "/plans", "POST", { planType: "program", templateKind: "weekly", weeks: 1, name: "Weekly source" });
    assert.equal(weeklyTemplate.status, 201, weeklyTemplate.text);
    const templateId = weeklyTemplate.body.plan.id;
    const addSession = await write(builder + "/blocks/" + weeklyTemplate.body.blocks[0].id + "/sessions", "POST", { name: "Template session" });
    assert.equal(addSession.status, 201, addSession.text);
    const assignedAthlete = (await sql.query(
      "select a.athlete_id from public.athletes a join plans.plans p on p.athlete_id=a.id where p.id=$1",
      [local],
    )).rows[0].athlete_id;
    const assignPath = builder + "/plans/" + templateId + "/assign-weekly";
    const newWeek = { athleteIds: [assignedAthlete], startDate: "2027-03-01", assignmentRequestId: randomUUID() };
    await grant(false);
    for (const [path, method, body] of [
      [builder + "/plans", "POST", { name: "Denied create" }],
      [builder + "/blocks/" + blockId, "PATCH", { name: "Denied block rename" }],
      [builder + "/sessions/" + sessionId, "PATCH", { name: "Denied session rename" }],
      [builder + "/nodes/" + nodeId, "DELETE", undefined],
      ["/api/templates/" + programId + "/tags", "POST", { name: "Denied tag" }],
    ]) {
      const denied = await write(path, method, body);
      assert.equal(denied.status, 403, denied.text);
    }
    assert.equal((await sql.query("select name from plans.plan_sessions where id=$1", [sessionId])).rows[0].name, "Original session");
    assert.equal((await sql.query("select name from plans.plan_nodes where id=$1", [nodeId])).rows[0].name, "Original section");
    assert.equal((await sql.query("select id from library.program_tag_definitions where name='Denied tag'")).rowCount, 0);
    const pure = await write(assignPath, "POST", newWeek);
    assert.equal(pure.status, 201, pure.text);
    assert.deepEqual((await sql.query(
      "select edited_plan_ids,removed_plan_ids,scope_type,scope_id from plans.program_edit_v109_assignment_evidence where request_id=$1",
      [newWeek.assignmentRequestId],
    )).rows[0], { edited_plan_ids: [], removed_plan_ids: [], scope_type: "team", scope_id: team });
    const pureReplay = await write(assignPath, "POST", newWeek);
    assert.equal(pureReplay.status, 201, pureReplay.text);
    assert.deepEqual(pureReplay.body, pure.body);
    const occupied = { athleteIds: [assignedAthlete], startDate: newWeek.startDate, assignmentRequestId: randomUUID() };
    const conflict = await write(assignPath, "POST", occupied);
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.body.code, "weekly_assign_conflicts");
    const replace = { ...occupied, choice: "replace", choiceToken: conflict.body.choiceToken };
    const deniedReplacement = await write(assignPath, "POST", replace);
    assert.equal(deniedReplacement.status, 403, deniedReplacement.text);
    assert.equal((await sql.query("select 1 from public.builder_assignment_requests where id=$1", [replace.assignmentRequestId])).rowCount, 0);
    await grant(true);
    const replaced = await write(assignPath, "POST", replace);
    assert.equal(replaced.status, 201, replaced.text);
    assert.equal(replaced.body.replaced.length, 1);
    await grant(false);
    const deniedReplay = await write(assignPath, "POST", replace);
    assert.equal(deniedReplay.status, 403, deniedReplay.text);
    await grant(true);
    const replay = await write(assignPath, "POST", replace);
    assert.equal(replay.status, 201, replay.text);
    assert.deepEqual(replay.body, replaced.body);
  } finally {
    await server?.stop();
    await sql.end();
    await database.drop();
  }
});
