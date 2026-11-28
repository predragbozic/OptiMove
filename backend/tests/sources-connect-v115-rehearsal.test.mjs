import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";
import { asActor, fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

async function seedNativeRoleLayers(fixture, { teamRole = false } = {}) {
  const f = fixtures(fixture.client);
  const club = await f.club("Sources Connect staging " + key());
  const team = await f.team(club);
  const platform = await f.user("Sources Connect staging admin");
  const coach = await f.user("Sources Connect native coach");
  await f.grantPlatform(platform);
  if (teamRole) await f.grantTeam(coach, team);
  else await f.grantClub(coach, club);
  const versionCoach = await f.user("Sources Connect version coach");
  if (teamRole) await f.grantTeam(versionCoach, team);
  else await f.grantClub(versionCoach, club);
  const role = teamRole ? ROLE_IDS.team_coach : ROLE_IDS.club_admin;
  const scope = teamRole ? { type: 'team', id: team, table: 'user_team_roles', column: 'team_id' } : { type: 'club', id: club, table: 'user_club_roles', column: 'club_id' };
  return asActor(fixture.url, platform, async tx => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [version] } = await tx.query(
      `insert into public.permission_club_role_versions
         (club_id,system_role_id,based_on_revision,answered_revision,created_by_user_id)
       select $1,id,revision,revision,$3 from public.permission_roles where id=$2 returning id`, [club,role,platform],
    );
    await tx.query("insert into public.permission_club_role_version_items select $1,permission_word from public.permission_role_items where role_id=$2 and permission_word not in ('variables.view','mappings.manage')", [version.id,role]);
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
       select $1,$2,'${scope.type}',$3,$4,'${scope.table}',r.id,r.updated_at,'default',p.revision,$5
       from public.${scope.table} r join public.permission_roles p on p.id=$2
       where r.user_id=$1 and r.${scope.column}=$3 returning id`, [coach,role,scope.id,club,platform],
    );
    await tx.query("insert into public.permission_custom_role_items select $1,permission_word from public.permission_role_items where role_id=$2 and permission_word not in ('variables.view','mappings.manage')", [custom.id,role]);
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



const previousBuild = "65bbaff6f33916b535b18b169582dd1d685c3714";
const migration = "202612171000";
const word = "sources.connect";
const read = name => readFile(new URL("../../docs/runbooks/sources-connect-v115-" + name + ".sql", import.meta.url), "utf8");

test("v115 applies, rolls back and restores the audited Mappings catalogue", async () => {
  const fixture = await createPagesDatabase({ through: "202612161000", label: "sources_connect_v115" });
  const { client } = fixture;
  const check = row => assert.ok(Object.values(row).every(value => value === true), JSON.stringify(row));
  const marker = async () => (await client.query("select first_checked_write_at from training_load.sources_connect_local_bridge_use")).rows[0].first_checked_write_at;
  const catalogue = async () => (await client.query(
    "select relname,relkind,relrowsecurity from pg_class where relnamespace='training_load'::regnamespace order by relname,relkind",
  )).rows;
  try {
    const { versionId, customId, club, team, platform, coach } = await seedNativeRoleLayers(fixture);
    await seedNativeRoleLayers(fixture, { teamRole: true });
    await client.query("update public.clubs set is_active=false where id=$1", [club]);
    await client.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null)", [platform]);
    await client.query("update training_load.mappings_manage_bridge_use set first_checked_write_at=clock_timestamp()");
    const beforeCatalogue = await catalogue();
    const beforeRoles = await roleData(client);
    const rollback = await read("rollback");
    const preflight = await read("preflight");
    check((await client.query(preflight)).rows[0]);
    await fixture.applyThrough(migration);
    const installed = await catalogue();
    assert.notDeepEqual(installed, beforeCatalogue);
    check((await client.query(await read("postcheck")))[0].rows[0]);
    const { rows: seed } = await client.query("select layer,id,words from training_load.sources_connect_v115_seed order by layer,id");
    assert.deepEqual(seed.filter(row => row.layer !== "role"), [
      { layer: "custom", id: customId, words: [word] },
      { layer: "version", id: versionId, words: [word] },
    ]);
    assert.equal(seed.filter(row => row.layer === "role").length, 1);
    assert.equal((await client.query("select public.user_has_permission($1,$2,\x27club\x27,$3) as allowed", [coach,word,club])).rows[0].allowed, false);
    await client.query("update public.clubs set is_active=true where id=$1", [club]);
    assert.equal((await client.query("select public.user_has_permission($1,$2,\x27club\x27,$3) as allowed", [coach,word,club])).rows[0].allowed, true);
    assert.equal(await marker(), null);
    await assert.rejects(client.query("delete from training_load.sources_connect_local_bridge_use"), /immutable/);
    await assert.rejects(client.query("truncate training_load.sources_connect_local_bridge_use"), /immutable/);
    await assert.rejects(client.query("update training_load.sources_connect_local_bridge_use set first_checked_write_at=null"), /immutable/);
    await client.query("begin");
    try {
      await client.query("update training_load.sources_connect_local_bridge_use set first_checked_write_at=clock_timestamp()");
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
        + " select id,revision+100,'migration','migrations_v2/202612171000_training_load_v115_sources_connect_local_bridge.sql',array['sources.connect']"
        + " from public.permission_roles r where not exists("
        + "select 1 from training_load.sources_connect_v115_seed s where s.layer='role' and s.id=r.id) order by r.id limit 1",
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
    assert.equal((await client.query("select * from training_load.mappings_manage_bridge_use where first_checked_write_at is not null")).rowCount, 1);
    await fixture.applyThrough(migration);
    assert.deepEqual(await catalogue(), installed);
    check((await client.query(await read("postcheck")))[0].rows[0]);

    const later = "migrations_v2/202612171100_sources_connect_rehearsal.sql";
    await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version,applied_at)"
      + " values($1,repeat('0',64),'test',now()-interval '1 day')", [later]);
    await assert.rejects(client.query(rollback), /later migration/);
    await client.query("rollback");
    await client.query("delete from public.schema_migrations where migration_name=$1", [later]);


    await client.query("update training_load.sources_connect_local_bridge_use set first_checked_write_at=clock_timestamp()");
    const firstUsed = await marker();
    assert.ok(firstUsed);
    await assert.rejects(client.query(rollback), /refuses checked Sources Connect writer use/);
    await client.query("rollback");
    assert.deepEqual(await marker(), firstUsed);
  } finally {
    await fixture.drop();
  }
});

test("v115 old and current Settings and native mapping operations share an exact disposable cutover", async () => {
  const fixture = await createPagesDatabase({ through: "202612161000", label: "map_overlap_v115" });
  const { client } = fixture;
  let current, previous;
  try {
    const { versionId, customId, club, platform, coach, versionCoach } = await seedNativeRoleLayers(fixture);
    await fixture.applyThrough(migration);
    const f = fixtures(client);
    const clubAdmin = await f.user("Sources Connect club admin");
    await f.grantClub(clubAdmin, club);
    await client.query(
      "insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null),($2,'club',$3),($4,'club',$3),($5,'club',$3)",
      [platform, coach, club, clubAdmin, versionCoach],
    );
    const marker = async () => (await client.query("select first_checked_write_at from training_load.sources_connect_local_bridge_use")).rows[0].first_checked_write_at;
    current = await startServer(fixture.url);
    previous = await previousDashboardServer(fixture.url, {}, previousBuild);
    const cookie = await current.cookieFor(platform);
    const root = "/api/organization/roles";
    async function call(server, path, body) {
      if (server.api) return server.api(cookie, path, { method: body ? "POST" : "GET", body });
      const response = await fetch(server.baseUrl + path, {
        method: body ? "POST" : "GET",
        headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }
    const roleId = ROLE_IDS.club_admin;
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
        [root + "/users/" + coach + "/clubs/" + club + "/custom", { roleId, scopeType: "club", scopeId: club, expectedRevision: roles.custom_revision, remove: [word] }],
      ]) {
        const rejected = await call(server, path, { requestKey: key(), reason: "Sources Connect is staged", ...input });
        assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
        assert.equal(rejected.body.error, "permission_not_available_yet");
      }
      const allowed = await call(server, root + "/" + roleId + "/change", {
        requestKey: key(), reason: "Keep staged word", expectedRevision: roles.role_revision,
        items: roles.items, description: "Sources Connect overlap " + key(),
      });
      assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    }


    const mapCookie = await current.cookieFor(coach);
    const create = "/api/training-load/sources/gpexe/connections";
    const body = { ownerScope: "club", ownerClubId: club, hostKey: "server3", accountLabel: "Local account", credentialKind: "exchanged_token", requestKey: key() };
    const old = await fetch(previous.baseUrl + create, {
      method: "POST", headers: { cookie: mapCookie, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal(old.status, 201, await old.clone().text());
    const oldAnswer = await old.json();
    assert.equal(await marker(), null);
    const replay = await current.api(mapCookie, create, { method: "POST", body });
    assert.equal(replay.status, 200, replay.text);
    assert.deepEqual(replay.body, { ...oldAnswer, connection: { ...oldAnswer.connection, replayed: true }, replayed: true });
    assert.equal(await marker(), null);
    async function setLicence(closed) {
      await asActor(fixture.url, platform, async tx => {
        await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
        if (closed) {
          await tx.query("insert into public.club_permission_ceiling(club_id,module_word,closed_by_user_id,reason) values($1,'data_configuration',$2,'Sources rehearsal')", [club,platform]);
        } else {
          await tx.query("delete from public.club_permission_ceiling where club_id=$1 and module_word='data_configuration'", [club]);
        }
        await tx.query("insert into public.club_permission_ceiling_changes(club_id,module_word,action,performed_by_user_id,reason) values($1,'data_configuration',$2,$3,'Sources rehearsal')", [club,closed?"close":"open",platform]);
      });
    }
    await setLicence(true);
    const closedBody = { ...body, requestKey: key() };
    const closedLegacy = await fetch(previous.baseUrl + create, {
      method: "POST", headers: { cookie: mapCookie, "content-type": "application/json" }, body: JSON.stringify(closedBody),
    });
    assert.equal(closedLegacy.status, 201, await closedLegacy.clone().text());
    const closedChecked = await current.api(mapCookie, create, { method: "POST", body: closedBody });
    assert.equal(closedChecked.status, 404, closedChecked.text);
    assert.equal(await marker(), null);
    await setLicence(false);
    const reopened = await current.api(mapCookie, create, { method: "POST", body: closedBody });
    assert.equal(reopened.status, 200, reopened.text);
    assert.equal(await marker(), null);
    const denied = await current.api(mapCookie, create, { method: "POST", body: { ...body, ownerClubId: key(), requestKey: key() } });
    assert.equal(denied.status, 404, denied.text);
    assert.equal(await marker(), null);
    const checked = await current.api(mapCookie, create, { method: "POST", body: { ...body, requestKey: key() } });
    assert.equal(checked.status, 201, checked.text);
    const firstUsed = await marker();
    assert.ok(firstUsed);
    const catalog = await call(current, root + "/catalog?clubId=" + club);
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.permissions.find(entry => entry.word === word)?.checked, false);
    await assert.rejects(client.query(await read("rollback")), /refuses checked Sources Connect writer use/);
    await client.query("rollback");
    assert.deepEqual(await marker(), firstUsed);
  } finally {
    await previous?.stop();
    await current?.stop();
    await fixture.drop();
  }
});
