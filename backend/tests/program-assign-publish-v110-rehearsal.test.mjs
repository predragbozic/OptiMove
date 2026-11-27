import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";
import { asActor, fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

async function seedNativeRoleLayers(fixture) {
  const f = fixtures(fixture.client);
  const club = await f.club("Programs Assign/Publish staging");
  const team = await f.team(club);
  const platform = await f.user("Programs Assign/Publish staging admin");
  const coach = await f.user("Programs Assign/Publish native coach");
  await f.grantPlatform(platform);
  await f.grantTeam(coach, team);
  const versionCoach = await f.user("Programs Assign/Publish version coach");
  await f.grantTeam(versionCoach, team);
  const role = ROLE_IDS.team_coach;
  return asActor(fixture.url, platform, async tx => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [version] } = await tx.query(
      `insert into public.permission_club_role_versions
         (club_id,system_role_id,based_on_revision,answered_revision,created_by_user_id)
       select $1,id,revision,revision,$3 from public.permission_roles where id=$2 returning id`, [club,role,platform],
    );
    await tx.query("insert into public.permission_club_role_version_items select $1,permission_word from public.permission_role_items where role_id=$2 and permission_word<>'programs.edit'", [version.id,role]);
    await tx.query(
      `insert into public.permission_club_role_version_changes
         (version_id,revision_after,kind,performed_by_user_id,basis,reason,items_added)
       values($1,1,'create',$2,'platform_admin','Rehearsal version',
         array(select permission_word from public.permission_club_role_version_items where version_id=$1))`, [version.id,platform],
    );
    const { rows: [custom] } = await tx.query(
      `insert into public.permission_custom_roles
        (user_id,base_role_id,scope_type,scope_id,club_id,holding_row_table,holding_row_id,holding_row_version,
        frozen_from,frozen_from_revision,created_by_user_id)
       select $1,$2,'team',$3,$4,'user_team_roles',r.id,r.updated_at,'default',p.revision,$5
       from public.user_team_roles r join public.permission_roles p on p.id=$2
       where r.user_id=$1 and r.team_id=$3 returning id`, [coach,role,team,club,platform],
    );
    await tx.query("insert into public.permission_custom_role_items select $1,permission_word from public.permission_role_items where role_id=$2 and permission_word<>'programs.edit'", [custom.id,role]);
    await tx.query(
      `insert into public.permission_custom_role_changes
         (custom_role_id,revision_after,kind,performed_by_user_id,basis,reason,items_added)
       values($1,1,'create',$2,'platform_admin','Rehearsal custom',
         array(select permission_word from public.permission_custom_role_items where custom_role_id=$1))`, [custom.id,platform],
    );
    return { versionId: version.id, customId: custom.id, club, team, platform, coach, versionCoach };
  });
}

function roleData(client) {
  return client.query(
    `select
      (select jsonb_agg(r order by id) from public.permission_roles r) as roles,
      (select jsonb_agg(i order by role_id,permission_word) from public.permission_role_items i) as role_items,
      (select jsonb_agg(a order by role_id,revision_after) from public.permission_role_changes a) as role_audit,
      (select jsonb_agg(r order by id) from public.permission_club_role_versions r) as versions,
      (select jsonb_agg(i order by version_id,permission_word) from public.permission_club_role_version_items i) as version_items,
      (select jsonb_agg(a order by version_id,revision_after) from public.permission_club_role_version_changes a) as version_audit,
      (select jsonb_agg(r order by id) from public.permission_custom_roles r) as custom,
      (select jsonb_agg(i order by custom_role_id,permission_word) from public.permission_custom_role_items i) as custom_items,
      (select jsonb_agg(a order by custom_role_id,revision_after) from public.permission_custom_role_changes a) as custom_audit`,
  ).then(({ rows }) => rows[0]);
}


const previousBuild = "58762744039fa00577d50926c50b1cacfcf3b6ea";
const migration = "202612121000";
const bridgeWords = ["programs.assign", "programs.publish"];
const read = name => readFile(new URL(`../../docs/runbooks/program-assign-publish-v110-${name}.sql`, import.meta.url), "utf8");

test("Programs Assign and Publish stage independently of Edit and preserve previous Settings and receipts", async () => {
  const fixture = await createPagesDatabase({ through: "202612111000", label: "program_ap_v110" });
  const { client } = fixture;
  let current, previous;
  try {
    const { versionId, customId, club, team, platform, coach, versionCoach } = await seedNativeRoleLayers(fixture);
    await client.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null),($2,'team',$4),($3,'team',$4)", [platform,coach,versionCoach,team]);
    const catalogue = async () => (await client.query("select relname,relkind from pg_class where relnamespace='plans'::regnamespace order by relname,relkind")).rows;
    await client.query("insert into plans.program_manage_v109_use (singleton) values (true)");
    const beforeCatalogue = await catalogue();
    const beforeRoles = await roleData(client);
    const rollback = await read("rollback");
    const { rows: [preflight] } = await client.query(await read("preflight"));
    assert.ok(Object.values(preflight).every(check => check === true), JSON.stringify(preflight));
    await client.query("begin");
    try {
      await client.query("alter table public.permission_role_items disable trigger permission_role_items_guard");
      await client.query("delete from public.permission_role_items where role_id=$1 and permission_word='programs.view'", [ROLE_IDS.team_coach]);
      const { rows: [ineligible] } = await client.query(await read("preflight"));
      assert.equal(ineligible.exact_native_seed_roles, false);
    } finally {
      await client.query("rollback");
    }
    await fixture.applyThrough(migration);
    const installed = await catalogue();
    assert.notDeepEqual(installed, beforeCatalogue);
    const [postcheck] = await client.query(await read("postcheck"));
    assert.ok(Object.values(postcheck.rows[0]).every(check => check === true), JSON.stringify(postcheck.rows[0]));
    const { rows: seed } = await client.query("select layer,id,words from plans.program_assign_publish_v110_seed order by layer,id");
    assert.deepEqual(seed.filter(row => row.layer !== "role"), [
      { layer: "custom", id: customId, words: bridgeWords },
      { layer: "version", id: versionId, words: bridgeWords },
    ]);
    await client.query("begin");
    try {
      await client.query("alter table public.permission_role_changes disable trigger permission_role_changes_guard; alter table public.permission_role_changes disable trigger permission_role_changes_complete");
      const extra = await client.query(`insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,items_added)
        select id,revision+100,'migration','migrations_v2/202612121000_programs_v110_assign_publish_bridge.sql',array['programs.assign']
        from public.permission_roles r where not exists(
          select 1 from plans.program_assign_publish_v110_seed s where s.layer='role' and s.id=r.id
        ) order by r.id limit 1`);
      assert.equal(extra.rowCount, 1);
      await client.query("alter table public.permission_role_changes enable trigger permission_role_changes_guard; alter table public.permission_role_changes enable trigger permission_role_changes_complete");
      await assert.rejects(client.query(rollback), /staged audit entry changed/);
    } finally {
      await client.query("rollback");
    }
    await client.query(rollback);
    assert.deepEqual(await catalogue(), beforeCatalogue);
    assert.equal((await client.query("select * from plans.program_manage_v109_use")).rowCount, 1);
    assert.deepEqual(await roleData(client), beforeRoles);
    await fixture.applyThrough(migration);
    assert.deepEqual(await catalogue(), installed);
    await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version,applied_at) values('migrations_v2/202612121100_program_assign_publish_rehearsal.sql',repeat('0',64),'test',now()-interval '1 day')");
    await assert.rejects(client.query(rollback), /later migration/);
    await client.query("rollback");
    await client.query("delete from public.schema_migrations where migration_name='migrations_v2/202612121100_program_assign_publish_rehearsal.sql'");

    current = await startServer(fixture.url);
    previous = await previousDashboardServer(fixture.url, {}, previousBuild);
    const platformCookie = await current.cookieFor(platform);
    const versionCookie = await current.cookieFor(versionCoach);
    const post = async (server, cookie, path, body) => {
      const response = await fetch(server.baseUrl + path, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: JSON.parse(text), text };
    };

    const { rows: [template] } = await client.query(`insert into plans.plans
      (plan_type,created_by_user_id,name,is_template,status,source_type,visibility)
      values('program',$1,'Pre-existing template',true,'active','builder','private') returning id`, [versionCoach]);
    const marker = () => client.query("select 1 from plans.program_assign_publish_v110_use").then(result => result.rowCount);
    assert.equal(await marker(), 0);
    const root = "/api/organization/roles";
    const roleId = ROLE_IDS.team_coach;
    const roleChange = root + "/" + roleId + "/change";
    const versionPath = root + "/" + roleId + "/clubs/" + club + "/version";
    const customPath = root + "/users/" + coach + "/clubs/" + club + "/custom";
    for (const send of [
      (path, body) => post(previous, platformCookie, path, body),
      (path, body) => current.api(platformCookie, path, { method: "POST", body }),
    ]) {
      const { rows: [roles] } = await client.query(`select
        (select revision from public.permission_roles where id=$1) as role_revision,
        (select revision from public.permission_club_role_versions where id=$2) as version_revision,
        (select revision from public.permission_custom_roles where id=$3) as custom_revision,
        array(select permission_word from public.permission_role_items where role_id=$1 order by 1) as items`,
      [roleId,versionId,customId]);
      for (const [path, input] of [
        [roleChange, { expectedRevision: roles.role_revision, items: roles.items.filter(item => !bridgeWords.includes(item)) }],
        [versionPath, { expectedRevision: roles.version_revision, remove: bridgeWords }],
        [customPath, { roleId, scopeType: "team", scopeId: team, expectedRevision: roles.custom_revision, remove: bridgeWords }],
      ]) {
        const rejected = await send(path, { requestKey: key(), reason: "Programs Assign and Publish are staged", ...input });
        assert.equal(rejected.status, 409, rejected.text);
        assert.equal(rejected.body.error, "permission_not_available_yet");
      }
      const allowed = await send(roleChange, {
        requestKey: key(), reason: "Keep staged words", expectedRevision: roles.role_revision,
        items: roles.items, description: "Programs Assign and Publish overlap " + key(),
      });
      assert.equal(allowed.status, 200, allowed.text);
    }
    const roleCatalog = await current.api(platformCookie, root + "/catalog?clubId=" + club, { method: "GET" });
    assert.equal(roleCatalog.status, 200, roleCatalog.text);
    for (const word of bridgeWords) {
      assert.equal(roleCatalog.body.permissions.find(entry => entry.word === word)?.checked, false);
    }
    for (const user of [coach, versionCoach]) {
      const cookie = await current.cookieFor(user);
      const me = await current.api(cookie, "/api/auth/me", { method: "GET" });
      assert.equal(me.status, 200, me.text);
      for (const word of bridgeWords) assert.equal(me.body.user.permissions.includes(word), false);
    }
    const athleteLogin = await fixtures(client).user("Program assignment recipient");
    const { rows: [athlete] } = await client.query(`insert into public.athletes
      (user_id,athlete_id,source_external_id,first_name,last_name,full_name,is_active)
      values($1,'v110-rehearsal','v110-rehearsal','Old','Athlete','Old Athlete',true) returning id,athlete_id`, [athleteLogin]);
    await client.query(`insert into public.athlete_memberships(athlete_id,membership_type,club_id,team_id,status)
      values($1,'team',$2,$3,'active')`, [athlete.id,club,team]);
    const duplicatePath = `/api/builder/plans/${template.id}/duplicate`;
    const request = { assignmentRequestId: key(), intent: "assign", athleteIds: [athlete.athlete_id] };
    const first = await post(previous, versionCookie, duplicatePath, request);
    assert.equal(first.status, 201, first.text);
    assert.equal(first.body.assignments.length, 1);
    const replay = await post(previous, versionCookie, duplicatePath, request);
    assert.equal(replay.status, 201, replay.text);
    assert.deepEqual(replay.body.assignments, first.body.assignments);
    const { rows: [typed] } = await client.query(
      "select edited_plan_ids,removed_plan_ids,scope_type,scope_id from plans.program_edit_v109_assignment_evidence where request_id=$1",
      [request.assignmentRequestId],
    );
    assert.deepEqual(typed, { edited_plan_ids: [], removed_plan_ids: [], scope_type: "team", scope_id: team });
    assert.equal(await marker(), 0);
    const currentReplay = await current.api(versionCookie, duplicatePath, { method: "POST", body: request });
    assert.equal(currentReplay.status, 201, currentReplay.text);
    assert.deepEqual(currentReplay.body.assignments, first.body.assignments);
    assert.equal(await marker(), 0, "replay of an older successful assignment does not claim new use");
    const skip = await current.api(versionCookie, `/api/templates/${template.id}/assignments`, {
      method: "POST", body: { athleteIds: [key()] },
    });
    assert.equal(skip.status, 201, skip.text);
    assert.deepEqual(skip.body.assigned, []);
    assert.equal(await marker(), 0, "all targets skipped does not claim a grant");

    const explicitPlatform = await current.api(platformCookie, duplicatePath, {
      method: "POST", body: { ...request, assignmentRequestId: key() },
    });
    assert.equal(explicitPlatform.status, 201, explicitPlatform.text);
    assert.equal(await marker(), 0, "a genuine platform assignment does not count as native use");
    const guardedRequest = { ...request, assignmentRequestId: key() };
    const state = async () => (await client.query(`select
      (select count(*)::int from plans.plans where athlete_id=$1) as plans,
      (select count(*)::int from public.builder_assignment_requests where id=$2) as receipts,
      (select count(*)::int from plans.program_edit_v109_assignment_evidence where request_id=$2) as edit_evidence,
      (select count(*)::int from public.app_notifications) as notifications`,
    [athlete.id,guardedRequest.assignmentRequestId])).rows[0];
    const beforeMarkedWrite = await state();
    await client.query("alter table plans.program_assign_publish_v110_use add constraint fixture_abort_marker check(false) not valid");
    try {
      const rejected = await current.api(versionCookie, duplicatePath, { method: "POST", body: guardedRequest });
      assert.equal(rejected.status, 500, rejected.text);
      assert.deepEqual(await state(), beforeMarkedWrite, "marker failure rolls back the native assignment and effects");
      assert.equal(await marker(), 0);
    } finally {
      await client.query("alter table plans.program_assign_publish_v110_use drop constraint fixture_abort_marker");
    }
    const guarded = await current.api(versionCookie, duplicatePath, { method: "POST", body: guardedRequest });
    assert.equal(guarded.status, 201, guarded.text);
    assert.equal(await marker(), 1);
    assert.deepEqual(await state(), { ...beforeMarkedWrite, plans: beforeMarkedWrite.plans + 1, receipts: 1, edit_evidence: 1, notifications: beforeMarkedWrite.notifications + 1 });
    for (const action of ["delete from", "truncate", "update"]) {
      const command = action + " plans.program_assign_publish_v110_use" + (action === "update" ? " set first_used_at=now()" : "");
      await assert.rejects(client.query(command), /first-use evidence is immutable/);
    }
    assert.equal(await marker(), 1);
    await assert.rejects(client.query(rollback), /checked Assign or Publish writer use/);
    await client.query("rollback");
  } finally {
    try { await previous?.stop(); } finally {
      try { await current?.stop(); } finally { await fixture.drop(); }
    }
  }
});
