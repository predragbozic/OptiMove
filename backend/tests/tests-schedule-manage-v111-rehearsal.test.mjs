import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";
import { asActor, fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

async function seedNativeRoleLayers(fixture) {
  const f = fixtures(fixture.client);
  const club = await f.club("Tests Schedule Manage staging");
  const team = await f.team(club);
  const platform = await f.user("Tests Schedule Manage staging admin");
  const coach = await f.user("Tests Schedule Manage native coach");
  await f.grantPlatform(platform);
  await f.grantTeam(coach, team);
  const versionCoach = await f.user("Tests Schedule Manage version coach");
  await f.grantTeam(versionCoach, team);
  const role = ROLE_IDS.team_coach;
  return asActor(fixture.url, platform, async tx => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [version] } = await tx.query(
      `insert into public.permission_club_role_versions
         (club_id,system_role_id,based_on_revision,answered_revision,created_by_user_id)
       select $1,id,revision,revision,$3 from public.permission_roles where id=$2 returning id`, [club,role,platform],
    );
    await tx.query("insert into public.permission_club_role_version_items select $1,permission_word from public.permission_role_items where role_id=$2 and permission_word<>'tests.results.view'", [version.id,role]);
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
    await tx.query("insert into public.permission_custom_role_items select $1,permission_word from public.permission_role_items where role_id=$2 and permission_word<>'tests.results.view'", [custom.id,role]);
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



const previousBuild = "a715b1641b7afa8e683a0b2ea0ccaa9cf8851d36";
const migration = "202612131000";
const word = "tests.schedule.manage";
const read = name => readFile(new URL("../../docs/runbooks/tests-schedule-manage-v111-" + name + ".sql", import.meta.url), "utf8");

test("v111 stages schedule management, preserves old Settings and guards rollback", async () => {
  const fixture = await createPagesDatabase({ through: "202612121000", label: "tests_manage_v111" });
  const { client } = fixture;
  let current, previous;
  const check = row => assert.ok(Object.values(row).every(value => value === true), JSON.stringify(row));
  const marker = async () => (await client.query("select first_checked_write_at from tests.schedule_manage_bridge_use")).rows[0].first_checked_write_at;
  const catalogue = async () => (await client.query(
    "select relname,relkind,relrowsecurity from pg_class where relnamespace='tests'::regnamespace order by relname,relkind",
  )).rows;
  try {
    const { versionId, customId, club, team, platform, coach } = await seedNativeRoleLayers(fixture);
    await client.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null)", [platform]);
    await client.query("insert into plans.program_assign_publish_v110_use (singleton) values (true)");
    const beforeCatalogue = await catalogue();
    const beforeRoles = await roleData(client);
    const rollback = await read("rollback");
    const preflight = await read("preflight");
    check((await client.query(preflight)).rows[0]);
    await client.query("begin");
    try {
      await client.query("alter table public.permission_role_items disable trigger permission_role_items_guard");
      await client.query("delete from public.permission_role_items where role_id=$1 and permission_word='tests.view'", [ROLE_IDS.team_coach]);
      assert.equal((await client.query(preflight)).rows[0].exact_native_seed_roles, false);
    } finally {
      await client.query("rollback");
    }

    await fixture.applyThrough(migration);
    const installed = await catalogue();
    assert.notDeepEqual(installed, beforeCatalogue);
    check((await client.query(await read("postcheck")))[0].rows[0]);
    const { rows: seed } = await client.query("select layer,id,words from tests.schedule_manage_v111_seed order by layer,id");
    assert.deepEqual(seed.filter(row => row.layer !== "role"), [
      { layer: "custom", id: customId, words: [word] },
      { layer: "version", id: versionId, words: [word] },
    ]);
    assert.equal(seed.filter(row => row.layer === "role").length, 2);
    assert.equal(await marker(), null);
    await assert.rejects(client.query("delete from tests.schedule_manage_bridge_use"), /immutable/);
    await assert.rejects(client.query("truncate tests.schedule_manage_bridge_use"), /immutable/);
    await assert.rejects(client.query("update tests.schedule_manage_bridge_use set first_checked_write_at=null"), /immutable/);
    await client.query("begin");
    try {
      await client.query("update tests.schedule_manage_bridge_use set first_checked_write_at=clock_timestamp()");
      assert.ok(await marker());
    } finally {
      await client.query("rollback");
    }
    assert.equal(await marker(), null);

    await client.query("begin");
    try {
      await client.query("alter table public.permission_role_changes disable trigger permission_role_changes_guard; alter table public.permission_role_changes disable trigger permission_role_changes_complete");
      const extra = await client.query(
        "insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,items_added)"
        + " select id,revision+100,'migration','migrations_v2/202612131000_tests_v111_schedule_manage_bridge.sql',array['tests.schedule.manage']"
        + " from public.permission_roles r where not exists("
        + "select 1 from tests.schedule_manage_v111_seed s where s.layer='role' and s.id=r.id) order by r.id limit 1",
      );
      assert.equal(extra.rowCount, 1);
      await client.query("alter table public.permission_role_changes enable trigger permission_role_changes_guard; alter table public.permission_role_changes enable trigger permission_role_changes_complete");
      await assert.rejects(client.query(rollback), /staged audit entry changed/);
    } finally {
      await client.query("rollback");
    }
    await client.query(rollback);
    assert.deepEqual(await catalogue(), beforeCatalogue);
    assert.deepEqual(await roleData(client), beforeRoles);
    assert.equal((await client.query("select * from plans.program_assign_publish_v110_use")).rowCount, 1);
    await fixture.applyThrough(migration);
    assert.deepEqual(await catalogue(), installed);
    check((await client.query(await read("postcheck")))[0].rows[0]);

    const later = "migrations_v2/202612131100_tests_schedule_manage_rehearsal.sql";
    await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version,applied_at)"
      + " values($1,repeat('0',64),'test',now()-interval '1 day')", [later]);
    await assert.rejects(client.query(rollback), /later migration/);
    await client.query("rollback");
    await client.query("delete from public.schema_migrations where migration_name=$1", [later]);

    current = await startServer(fixture.url);
    previous = await previousDashboardServer(fixture.url, {}, previousBuild);
    const cookie = await current.cookieFor(platform);
    const root = "/api/organization/roles";
    async function call(server, path, body) {
      const response = await fetch(server.baseUrl + path, {
        method: body ? "POST" : "GET",
        headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }
    const roleId = ROLE_IDS.team_coach;
    for (const server of [previous, current]) {
      const { rows: [roles] } = await client.query(
        "select (select revision from public.permission_roles where id=$1) as role_revision,"
        + " (select revision from public.permission_club_role_versions where id=$2) as version_revision,"
        + " (select revision from public.permission_custom_roles where id=$3) as custom_revision,"
        + " array(select permission_word from public.permission_role_items where role_id=$1 order by 1) as items",
        [roleId, versionId, customId],
      );
      const catalog = await call(server, root + "/catalog?clubId=" + club);
      assert.equal(catalog.status, 200);
      assert.equal(catalog.body.permissions.find(entry => entry.word === word)?.checked, false);
      for (const [path, input] of [
        [root + "/" + roleId + "/change", { expectedRevision: roles.role_revision, items: roles.items.filter(item => item !== word) }],
        [root + "/" + roleId + "/clubs/" + club + "/version", { expectedRevision: roles.version_revision, remove: [word] }],
        [root + "/users/" + coach + "/clubs/" + club + "/custom", { roleId, scopeType: "team", scopeId: team, expectedRevision: roles.custom_revision, remove: [word] }],
      ]) {
        const rejected = await call(server, path, { requestKey: key(), reason: "Tests Schedule Manage is staged", ...input });
        assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
        assert.equal(rejected.body.error, "permission_not_available_yet");
      }
      const allowed = await call(server, root + "/" + roleId + "/change", {
        requestKey: key(), reason: "Keep staged word", expectedRevision: roles.role_revision,
        items: roles.items, description: "Tests Schedule Manage overlap " + key(),
      });
      assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    }
    assert.equal(await marker(), null);
    const coachCookie = await current.cookieFor(coach);
    const f = fixtures(client);
    const otherClub = await f.club("Tests Schedule Manage second club");
    const otherTeam = await f.team(otherClub);
    await f.grantTeam(coach, otherTeam);
    const write = async (server, path, method, body) => {
      if (server === current) {
        const { status, body: responseBody } = await current.api(coachCookie, path, { method, body });
        return { status, body: responseBody };
      }
      const response = await fetch(server.baseUrl + path, {
        method,
        headers: { Cookie: coachCookie, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const oldWorkspace = await write(previous, "/api/auth/workspace", "PUT", { type: "team", scopeId: team });
    assert.equal(oldWorkspace.status, 200, JSON.stringify(oldWorkspace.body));
    const path = "/api/tests/schedules";
    const input = {
      testVersionId: "7a386bd1-d25e-4651-9012-e76d9dc32559", scheduleKind: "one_time",
      timezone: "UTC", startDate: "2027-10-04", opensTime: "00:00", closesTime: "23:59",
      targets: [{ kind: "team", id: team }],
    };
    const old = await write(previous, path, "POST", input);
    assert.equal(old.status, 201, JSON.stringify(old.body));
    assert.equal(old.body.schedule.ownerScope, "team");
    const oldPath = path + "/" + old.body.schedule.id;
    const link = await write(previous, oldPath + "/link", "POST", {});
    assert.equal(link.status, 201, JSON.stringify(link.body));
    assert.equal(await marker(), null, "old server writes are compatible and do not stamp v111");

    const currentWorkspace = await write(current, "/api/auth/workspace", "PUT", { type: "team", scopeId: otherTeam });
    assert.equal(currentWorkspace.status, 200, JSON.stringify(currentWorkspace.body));
    const wrongOwnerTarget = await write(current, oldPath, "PATCH", { ...input, targets: [{ kind: "team", id: otherTeam }] });
    assert.deepEqual(wrongOwnerTarget, { status: 403, body: { error: "One of the chosen targets is outside your access." } });
    assert.equal(await marker(), null);
    const pause = await write(current, oldPath, "PATCH", { status: "paused" });
    assert.equal(pause.status, 200, JSON.stringify(pause.body));
    assert.equal(pause.body.status, "paused");
    const firstUsed = await marker();
    assert.ok(firstUsed);
    const rotated = await write(current, oldPath + "/link", "POST", {});
    assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
    assert.notEqual(rotated.body.link.id, link.body.link.id);
    const revoked = await write(previous, "/api/tests/links/" + rotated.body.link.id + "/revoke", "POST", {});
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const linkStatuses = (await client.query(
      "select status from tests.test_access_links where schedule_id=$1 order by id", [old.body.schedule.id],
    )).rows;
    assert.deepEqual(linkStatuses, [{ status: "revoked" }, { status: "revoked" }]);
    assert.deepEqual(await marker(), firstUsed);
    await assert.rejects(client.query("update tests.schedule_manage_bridge_use set first_checked_write_at=clock_timestamp()"), /immutable/);
    await assert.rejects(client.query(rollback), /refuses checked Schedule Manage writer use/);
    await client.query("rollback");
    assert.deepEqual(await marker(), firstUsed);
  } finally {
    try {
      await previous?.stop();
    } finally {
      try { await current?.stop(); } finally { await fixture.drop(); }
    }
  }
});
