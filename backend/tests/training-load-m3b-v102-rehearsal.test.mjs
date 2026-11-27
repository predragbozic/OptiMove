import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { test } from "node:test";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";
import { asActor, buildDatabase, fixtures, migrationsWithout, ROLE_IDS } from "./support/permission-roles-world.mjs";

const v101 = "202612031000_training_load_v101_roster_manage_bridge.sql";
const file = "202612041000_training_load_v102_estimates_manage_bridge.sql";
const v102 = `migrations_v2/${file}`;
const read = (type) => fs.readFileSync(new URL(`../../docs/runbooks/training-load-m3b-v102-${type}.sql`, import.meta.url), "utf8");

async function seedLayers(url, c) {
  const fx = fixtures(c);
  const club = await fx.club("v102 rehearsal");
  const team = await fx.team(club);
  const owner = await fx.user("v99 basic");
  const coach = await fx.user("v99 custom");
  const actor = await fx.user("v99 platform");
  await fx.grantPlatform(actor);
  await fx.grantClub(owner, club);
  await fx.grantTeam(coach, team);
  const role = ROLE_IDS.team_coach;
  const versionId = await asActor(url, actor, async (tx) => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [r] } = await tx.query("select revision from public.permission_roles where id=$1", [role]);
    const { rows: [v] } = await tx.query(`insert into public.permission_club_role_versions
      (club_id,system_role_id,based_on_revision,answered_revision,created_by_user_id)
      values ($1,$2,$3,$3,$4) returning id`, [club, role, r.revision, actor]);
    await tx.query(`insert into public.permission_club_role_version_items
      select $1,permission_word from public.permission_role_items where role_id=$2`, [v.id, role]);
    await tx.query(`insert into public.permission_club_role_version_changes
      (version_id,revision_after,kind,performed_by_user_id,basis,reason,items_added)
      values ($1,1,'create',$2,'platform_admin','Rehearsal version',
        array(select permission_word from public.permission_club_role_version_items where version_id=$1))`, [v.id, actor]);
    return v.id;
  });
  const customId = await asActor(url, actor, async (tx) => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'shared')", [[club]]);
    const { rows: [v] } = await tx.query(`insert into public.permission_custom_roles
      (user_id,base_role_id,scope_type,scope_id,club_id,holding_row_table,holding_row_id,holding_row_version,
       frozen_from,frozen_from_revision,created_by_user_id)
      select $1,$2,'team',$3,$4,'user_team_roles',r.id,r.updated_at,'default',p.revision,$5
        from public.user_team_roles r join public.permission_roles p on p.id=$2
       where r.user_id=$1 and r.team_id=$3 returning id`, [coach, role, team, club, actor]);
    await tx.query(`insert into public.permission_custom_role_items
      select $1,permission_word from public.permission_role_items where role_id=$2`, [v.id, role]);
    await tx.query(`insert into public.permission_custom_role_changes
      (custom_role_id,revision_after,kind,performed_by_user_id,basis,reason,items_added)
      values ($1,1,'create',$2,'platform_admin','Rehearsal custom',
        array(select permission_word from public.permission_custom_role_items where custom_role_id=$1))`, [v.id, actor]);
    return v.id;
  });

  await asActor(url, actor, async (tx) => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [changed] } = await tx.query(
      "update public.permission_roles set description=$2, revision=revision+1, updated_at=now() where id=$1 returning revision",
      [role, "Pending roster rehearsal default"],
    );
    await tx.query(
      `insert into public.permission_role_changes
         (role_id,revision_after,kind,performed_by_user_id,basis,reason,description_changed)
       values ($1,$2,'change',$3,'platform_admin','Rehearsal pending default',true)`,
      [role, changed.revision, actor],
    );
  });
  const viewer = await fx.user("Estimate bridge viewer");
  const viewerRole = await asActor(url, actor, async (tx) => {
    const { rows: [role] } = await tx.query(
      "insert into public.permission_roles (owner_scope,name,assignable_club,created_by_user_id) values ('system','Rehearsal Viewer',true,$1) returning id",
      [actor],
    );
    await tx.query("insert into public.permission_role_items (role_id,permission_word,added_by_user_id) values ($1,'org.view',$2)", [role.id, actor]);
    await tx.query(
      `insert into public.permission_role_changes (role_id,revision_after,kind,performed_by_user_id,basis,items_added)
       values ($1,1,'create',$2,'platform_admin',array['org.view'])`,
      [role.id, actor],
    );
    return role.id;
  });
  return { versionId, customId, owner, coach, club, team, actor, viewer, viewerRole };
}

async function grantIndependentAccess(url, admin, data) {
  const { actor, viewer, viewerRole, club, owner } = data;
  const newAdmin = await fixtures(admin).user("Estimate bridge new club admin");
  await asActor(url, actor, async (tx) => {
    await tx.query("select public.lock_club_ceiling($1::uuid[],'exclusive')", [[club]]);
    const { rows: [assignment] } = await tx.query(
      `insert into public.user_role_assignments (user_id,role_id,scope_type,scope_id,granted_by_user_id,grant_basis,grant_reason)
       values ($1,$2,'club',$3,$4,'platform_admin','Independent grant after v102') returning id`,
      [viewer, viewerRole, club, actor],
    );
    await tx.query(
      `insert into public.permission_requests (request_key,requested_by_user_id,operation,request_hash,owner_scope,owner_club_id,basis,assignment_id)
       values ($1,$2,'assignment_grant',$3,'club',$4,'platform_admin',$5)`,
      [randomUUID(), actor, "a".repeat(64), club, assignment.id],
    );
    await tx.query("delete from public.user_club_roles where user_id=$1 and club_id=$2 and role='club_admin'", [owner, club]);
    await fixtures(tx).grantClub(newAdmin, club);
  });
  return newAdmin;
}

async function accessSnapshot(client, clubId) {
  return (await client.query(
    `select (select jsonb_agg(to_jsonb(r) order by r.id) from public.user_club_roles r where r.club_id=$1) native_roles,
       (select jsonb_agg(to_jsonb(a) order by a.id) from public.user_role_assignments a where a.scope_club_id=$1) assignments,
       (select jsonb_agg(to_jsonb(p) order by p.id) from public.permission_requests p where p.owner_club_id=$1) receipts`,
    [clubId],
  )).rows[0];
}

async function snapshot(c) {
  const { rows } = await c.query(`select
    (select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,pg_get_functiondef(p.oid),p.proacl) order by p.oid::regprocedure::text)
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('calendar','training_load') or n.nspname='public' and p.proname='permission_word_honoured') as bodies,
    (select jsonb_agg(to_jsonb(x) order by table_name,ordinal_position) from information_schema.columns x where table_schema in ('calendar','training_load')) as columns,
    (select jsonb_agg(jsonb_build_array(t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid))
       order by t.tgrelid::regclass::text,t.tgname)
       from pg_trigger t where not t.tgisinternal and (t.tgrelid::regclass::text like 'calendar.%' or t.tgrelid::regclass::text like 'training_load.%' or t.tgname like 'permission_%')) as triggers,
    (select jsonb_agg(to_jsonb(r) order by r.id) from public.permission_roles r) as roles,
    (select jsonb_agg(to_jsonb(v) order by v.id) from public.permission_club_role_versions v) as versions,
    (select jsonb_agg(to_jsonb(c) order by c.id) from public.permission_custom_roles c) as customs,
    (select jsonb_agg(to_jsonb(i) order by i.role_id,i.permission_word) from public.permission_role_items i) as role_items,
    (select jsonb_agg(to_jsonb(i) order by i.version_id,i.permission_word) from public.permission_club_role_version_items i) as version_items,
    (select jsonb_agg(to_jsonb(i) order by i.custom_role_id,i.permission_word) from public.permission_custom_role_items i) as custom_items,
    (select jsonb_agg(to_jsonb(a) order by a.id) from public.permission_role_changes a) as role_changes,
    (select jsonb_agg(to_jsonb(a) order by a.id) from public.permission_club_role_version_changes a) as version_changes,
    (select jsonb_agg(to_jsonb(a) order by a.id) from public.permission_custom_role_changes a) as custom_changes`);
  // Dropping new columns preserves their discarded attnums; only live user columns make up this catalogue.
  return rows[0];
}

test("v102 seeds current layers and rolls back to the identical catalog before any bridge writes", async () => {
  const db = await buildDatabase({ label: "estimates_m3b_rehearsal", upTo: v101 });
  const admin = new pg.Client({ connectionString: db.url });
  const staged = migrationsWithout([], file);
  try {
    await admin.connect();
    const data = await seedLayers(db.url, admin);
    const before = await snapshot(admin);
    const precheck = await admin.query(read("preflight"));
    assert.deepEqual(precheck.map((x) => Object.values(x.rows[0])[0]), [true, true, true, true]);
    await runMigrations({ databaseUrl: db.url, migrationsRoot: staged.dir });
    const postcheck = await admin.query(read("postcheck"));
    assert.equal(postcheck[0].rows[0].migration_name, v102);
    assert.deepEqual(postcheck[2].rows[0], { first_checked_write_at: null });
    assert.deepEqual(postcheck[3].rows.map(({layer,seeded}) => [layer, Number(seeded)]), [["custom",1],["role",2],["version",1]]);
    assert.deepEqual(postcheck[4].rows[0], { v102_permission_body_matches: true, word_storable: true });
    assert.deepEqual((await admin.query(`select v.revision, v.based_on_revision=r.revision as based,
      v.answered_revision=r.revision as answered from public.permission_club_role_versions v
      join public.permission_roles r on r.id=v.system_role_id where v.id=$1`, [data.versionId])).rows,
    [{ revision: 2, based: false, answered: false }]);
    assert.deepEqual((await admin.query("select revision from public.permission_custom_roles where id=$1", [data.customId])).rows, [{ revision: 2 }]);
    const future = "migrations_v2/209912311000_later_schedule_rehearsal.sql";
    await admin.query("insert into public.schema_migrations (migration_name,checksum,runner_version) values ($1,$2,'test')", [future, "b".repeat(64)]);
    await assert.rejects(admin.query(read("rollback")), /later migration/);
    await admin.query("rollback");
    await admin.query("delete from public.schema_migrations where migration_name=$1", [future]);

    await admin.query("begin");
    await admin.query(`create or replace function public.permission_word_honoured(text) returns boolean
       language sql immutable as 'select false'`.replace('honoured(text)', 'honoured(p_word text)'));
    await assert.rejects(admin.query(read("rollback")), /permission body changed/);
    await admin.query("rollback");

    await admin.query("begin");
    await admin.query("select set_config('optimove.permission_actor',$1||':'||pg_current_xact_id()::text,true)", [data.actor]);
    await admin.query("update public.permission_roles set description='Changed during the bridge',revision=revision+1,updated_at=now() where id=$1", [ROLE_IDS.team_coach]);
    await assert.rejects(admin.query(read("rollback")), /seeded layer changed/);
    await admin.query("rollback");

    await admin.query("begin");
    await admin.query("alter table public.permission_role_items disable trigger permission_role_items_guard");
    await admin.query("set constraints all immediate");
    await admin.query("delete from public.permission_role_items where role_id=$1 and permission_word='load.estimates.manage'", [ROLE_IDS.team_coach]);
    await admin.query("alter table public.permission_role_items enable trigger permission_role_items_guard");
    await assert.rejects(admin.query(read("rollback")), /Estimates permission grants changed/);
    await admin.query("rollback");

    const newAdmin = await grantIndependentAccess(db.url, admin, data);
    const access = await accessSnapshot(admin, data.club);
    assert.deepEqual(access.native_roles.map(row => row.user_id), [newAdmin]);
    assert.deepEqual(access.assignments.map(row => row.user_id), [data.viewer]);
    assert.equal(access.receipts.length, 1);
    await admin.query(read("rollback"));
    assert.deepEqual(await snapshot(admin), before);
    assert.deepEqual(await accessSnapshot(admin, data.club), access);
    assert.deepEqual((await admin.query(
      `select public.user_has_permission($1,'org.view','club',$2) as viewer_allowed,
         public.permission_word_honoured('load.estimates.manage') as estimate_storable`,
      [data.viewer, data.club],
    )).rows, [{ viewer_allowed: true, estimate_storable: false }]);
    await runMigrations({ databaseUrl: db.url, migrationsRoot: staged.dir });
    assert.deepEqual((await admin.query(read("postcheck")))[4].rows[0],
      { v102_permission_body_matches: true, word_storable: true });
    await admin.query("update training_load.metric_estimate_m3b_use set first_checked_write_at=now() where singleton");
    await assert.rejects(admin.query(read("rollback")), /bridge writer was used/);
    await admin.query("rollback");
  } finally {
    await admin.end().catch(() => {});
    staged.cleanup();
    await db.drop();
  }
});
