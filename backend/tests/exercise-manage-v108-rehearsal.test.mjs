import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { previousDashboardServer } from "./support/dashboard-pages-old-server.mjs";
import { asActor, fixtures, key, ROLE_IDS, startServer } from "./support/permission-roles-world.mjs";

async function seedNativeRoleLayers(fixture) {
  const f = fixtures(fixture.client);
  const club = await f.club("Exercise staging");
  const team = await f.team(club);
  const platform = await f.user("Exercise staging admin");
  const coach = await f.user("Exercise native coach");
  await f.grantPlatform(platform);
  await f.grantTeam(coach, team);
  const versionCoach = await f.user("Exercise version coach");
  await f.grantTeam(versionCoach, team);
  const role = ROLE_IDS.team_coach;
  return asActor(fixture.url, platform, async tx => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [version] } = await tx.query(
      `insert into public.permission_club_role_versions
         (club_id,system_role_id,based_on_revision,answered_revision,created_by_user_id)
       select $1,id,revision,revision,$3 from public.permission_roles where id=$2 returning id`, [club,role,platform],
    );
    await tx.query("insert into public.permission_club_role_version_items select $1,permission_word from public.permission_role_items where role_id=$2", [version.id,role]);
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
    await tx.query("insert into public.permission_custom_role_items select $1,permission_word from public.permission_role_items where role_id=$2", [custom.id,role]);
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


const previousBuild = "d6d9f752ea2c534f923c8dd2ea82fee48eba3329";
const migration = "202612101000";
const bridgeWords = ["exercises.add", "exercises.remove"];
const read = name => readFile(new URL(`../../docs/runbooks/exercise-manage-v108-${name}.sql`, import.meta.url), "utf8");

test("Exercises Add and Remove maintain old Settings and writes, and rollback only before use", async () => {
  const fixture = await createPagesDatabase({ through: "202612091000", label: "exercise_v108" });
  const { client } = fixture;
  let current, previous;
  try {
    const { versionId, customId, club, team, platform, coach, versionCoach } = await seedNativeRoleLayers(fixture);
    await client.query("insert into public.user_workspace_preferences(user_id,workspace_type,scope_id) values($1,'platform',null),($2,'team',$4),($3,'team',$4)", [platform,coach,versionCoach,team]);
    const catalogue = async () => (await client.query("select relname,relkind from pg_class where relnamespace='library'::regnamespace order by relname,relkind")).rows;
    const beforeCatalogue = await catalogue();
    const beforeRoles = await roleData(client);
    const rollback = await read("rollback");
    const { rows: [preflight] } = await client.query(await read("preflight"));
    assert.ok(Object.values(preflight).every(check => check === true), JSON.stringify(preflight));
    await fixture.applyThrough(migration);
    const installed = await catalogue();
    assert.notDeepEqual(installed, beforeCatalogue);
    const [postcheck] = await client.query(await read("postcheck"));
    assert.ok(Object.values(postcheck.rows[0]).every(check => check === true), JSON.stringify(postcheck.rows[0]));
    const { rows: seed } = await client.query("select layer,id,words from library.exercise_manage_v108_seed order by layer,id");
    assert.deepEqual(seed.filter(row => row.layer !== "role"), [
      { layer: "custom", id: customId, words: bridgeWords },
      { layer: "version", id: versionId, words: bridgeWords },
    ]);
    await client.query(rollback);
    assert.deepEqual(await catalogue(), beforeCatalogue);
    assert.deepEqual(await roleData(client), beforeRoles);
    await fixture.applyThrough(migration);
    assert.deepEqual(await catalogue(), installed);
    await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version,applied_at) values('migrations_v2/202612101100_exercise_rehearsal.sql',repeat('0',64),'test',now()-interval '1 day')");
    await assert.rejects(client.query(rollback), /later migration/);
    await client.query("rollback");
    await client.query("delete from public.schema_migrations where migration_name='migrations_v2/202612101100_exercise_rehearsal.sql'");

    current = await startServer(fixture.url);
    previous = await previousDashboardServer(fixture.url, {}, previousBuild);
    const platformCookie = await current.cookieFor(platform);
    const customCookie = await current.cookieFor(coach);
    const versionCookie = await current.cookieFor(versionCoach);
    const previousPost = async (cookie, path, body) => {
      const response = await fetch(previous.baseUrl + path, {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: JSON.parse(text), text };
    };

    const legacy = await previousPost(versionCookie, "/api/exercises", { name: "Old binary exercise" });
    assert.equal(legacy.status, 201, legacy.text);
    const marker = () => client.query("select 1 from library.exercise_manage_v108_use").then(result => result.rowCount);
    assert.equal(await marker(), 0);
    const root = "/api/organization/roles";
    const roleId = ROLE_IDS.team_coach;
    const roleChange = root + "/" + roleId + "/change";
    const versionPath = root + "/" + roleId + "/clubs/" + club + "/version";
    const customPath = root + "/users/" + coach + "/clubs/" + club + "/custom";
    for (const send of [
      (path, body) => previousPost(platformCookie, path, body),
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
        const rejected = await send(path, { requestKey: key(), reason: "Staged Exercise words are locked", ...input });
        assert.equal(rejected.status, 409, rejected.text);
        assert.equal(rejected.body.error, "permission_not_available_yet");
      }
      const allowed = await send(roleChange, {
        requestKey: key(), reason: "Keep staged words", expectedRevision: roles.role_revision,
        items: roles.items, description: "Exercise overlap " + key(),
      });
      assert.equal(allowed.status, 200, allowed.text);
    }
    const check = (cookie, path, method, body) => current.api(cookie, path, { method, body });
    const forbidden = await check(customCookie, "/api/exercises/" + legacy.body.id, "PATCH", { name: "Other owner's exercise" });
    assert.equal(forbidden.status, 404, forbidden.text);
    assert.equal(await marker(), 0);
    const archive = await check(versionCookie, "/api/exercises/" + legacy.body.id + "/archive", "POST");
    assert.equal(archive.status, 200, archive.text);
    assert.equal(await marker(), 1);
    for (const action of ["delete from", "truncate", "update"]) {
      const command = action + " library.exercise_manage_v108_use" + (action === "update" ? " set first_used_at=now()" : "");
      await assert.rejects(client.query(command), /first-use evidence is immutable/);
    }
    assert.equal(await marker(), 1);
    const custom = await check(customCookie, "/api/exercises", "POST", { name: "Held custom Exercise writer" });
    assert.equal(custom.status, 201, custom.text);
    const owner = (await client.query("select owner_scope,owner_user_id from library.exercises where id=$1", [custom.body.id])).rows[0];
    assert.deepEqual(owner, { owner_scope: "user", owner_user_id: coach });
    await assert.rejects(client.query(rollback), /checked Exercise writer use/);
    await client.query("rollback");
  } finally {
    try { await previous?.stop(); } finally {
      try { await current?.stop(); } finally { await fixture.drop(); }
    }
  }
});
