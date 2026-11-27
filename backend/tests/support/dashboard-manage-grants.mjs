import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DISPOSABLE_DATABASE_NAME_PATTERN } from "./disposable-db.mjs";

// Historical estimation fixtures need current dashboard write authorization,
// while their measurements and rollback still run on their original schema.
export async function stageDashboardManageForFixture(client) {
  const { rows: [database] } = await client.query("select current_database() as name");
  assert.match(database.name, DISPOSABLE_DATABASE_NAME_PATTERN);
  await client.query("begin");
  try {
    const { rows: [phase] } = await client.query("select public.permission_word_honoured('dashboards.manage') as ready");
    if (phase.ready) {
      await client.query("rollback");
      return;
    }
    await client.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
    const { rows: [definition] } = await client.query(
      "select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) as body",
    );
    const staged = definition.body.replace("'dashboards.view'", "'dashboards.view', 'dashboards.manage'");
    assert.notEqual(staged, definition.body);
    await client.query(staged);
    await client.query(`create table training_load.dashboards_manage_v105_use (
      singleton boolean primary key default true check (singleton),
      first_checked_write_at timestamptz
    ); insert into training_load.dashboards_manage_v105_use values (true, null)`);

    const migration = "fixtures/manage-stage-" + randomUUID();
    for (const basicKey of ["club_admin", "team_coach"]) {
      const { rows: [role] } = await client.query(
        "update public.permission_roles set revision=revision+1,updated_at=now() where basic_key=$1 returning id,revision",
        [basicKey],
      );
      await client.query(`insert into public.permission_role_changes
        (role_id,revision_after,kind,migration_name,items_added) values($1,$2,'migration',$3,array['dashboards.manage'])`,
      [role.id, role.revision, migration]);
      await client.query("insert into public.permission_role_items(role_id,permission_word) values($1,'dashboards.manage')", [role.id]);
    }
    await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('0',64),'test')", [migration]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
