import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { asActor, fixtures, ROLE_IDS } from "./support/permission-roles-world.mjs";

async function seedNativeRoleLayers(fixture) {
  const f = fixtures(fixture.client);
  const club = await f.club("Builder staging");
  const team = await f.team(club);
  const platform = await f.user("Builder staging admin");
  const coach = await f.user("Builder native coach");
  await f.grantPlatform(platform);
  await f.grantTeam(coach, team);
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
    return { versionId: version.id, customId: custom.id };
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

test("v106 apply, unused rollback restores the catalogue, then reapply", async () => {
  const fixture = await createPagesDatabase({ through: "202612071000", label: "rpe_v106" });
  const { client } = fixture;
  const read = (name) => readFile(new URL(`../../docs/runbooks/builder-rpe-v106-${name}.sql`, import.meta.url), "utf8");
  const catalogue = async () => (await client.query(
    "select relname, relkind from pg_class where relnamespace='training_load'::regnamespace order by relname, relkind",
  )).rows;
  const wordState = async () => (await client.query(
    `select public.permission_word_honoured('programs.rpe_settings') as honoured,
       (select count(*)::integer from public.permission_role_items where permission_word='programs.rpe_settings') as grants`,
  )).rows[0];
  try {
    const { versionId, customId } = await seedNativeRoleLayers(fixture);
    const original = await catalogue();
    const rolesBefore = await roleData(client);
    assert.deepEqual(await wordState(), { honoured: false, grants: 0 });
    const rollback = await read("rollback");
    const [preflight] = await client.query(await read("preflight"));
    assert.ok(Object.values(preflight.rows[0]).every(check => check === true), JSON.stringify(preflight.rows[0]));
    await fixture.applyThrough("202612081000");
    const installed = await catalogue();
    const { rows: seed } = await client.query("select layer,id,words from training_load.builder_rpe_v106_seed order by layer,id");
    assert.deepEqual(seed.filter(row => row.layer !== "role"), [
      { layer: "custom", id: customId, words: ["programs.rpe_settings"] },
      { layer: "version", id: versionId, words: ["programs.rpe_settings"] },
    ]);
    assert.deepEqual(await wordState(), { honoured: true, grants: 2 });
    assert.notDeepEqual(installed, original);
    const [postcheck, use, opening, nativeSeed] = await client.query(await read("postcheck"));
    assert.equal(postcheck.rows[0].exact_v106, true);
    assert.equal(Number(use.rows[0].first_use_rows), 0);
    assert.equal(Number(opening.rows[0].opening_plans), 0);
    assert.deepEqual(nativeSeed.rows[0], { native_word_staged: true, permission_body_exact: true });
    assert.equal((await client.query("select * from training_load.builder_rpe_provenance_use")).rowCount, 0);
    await client.query(rollback);
    assert.deepEqual(await catalogue(), original);
    assert.deepEqual(await roleData(client), rolesBefore);
    assert.deepEqual(await wordState(), { honoured: false, grants: 0 });
    await fixture.applyThrough("202612081000");
    assert.deepEqual(await catalogue(), installed);
    await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values('migrations_v2/202612081100_rehearsal_later.sql',repeat('0',64),'test')");
    await assert.rejects(client.query(rollback), /later migration/);
    await client.query("rollback");
    assert.deepEqual(await catalogue(), installed);
    assert.deepEqual(await wordState(), { honoured: true, grants: 2 });
    assert.equal((await client.query("select * from training_load.builder_rpe_provenance_use")).rowCount, 0);
  } finally {
    await fixture.drop();
  }
});
