import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DISPOSABLE_DATABASE_NAME_PATTERN } from "./disposable-db.mjs";

const one = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];

export async function varyRenameGrant(client, basicKey, add) {
  const word = "variables.rename_archive";
  const migrationName = "fixtures/test-only-variable-rename-" + randomUUID() + ".sql";
  assert.match((await one(client, "select current_database() as name")).name, DISPOSABLE_DATABASE_NAME_PATTERN);
  await client.query("begin");
  try {
    await client.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
    if (!(await one(client, "select public.permission_word_honoured($1) as ready", [word])).ready) {
      const { definition } = await one(client, "select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) as definition");
      const staged = definition.replace("'variables.view'", "'variables.view', 'variables.rename_archive'");
      assert.notEqual(staged, definition);
      await client.query(staged);
    }
    const role = await one(client, "update public.permission_roles set revision=revision+1,updated_at=now() where basic_key=$1 returning id,revision", [basicKey]);
    const items = add ? "items_added" : "items_removed";
    await client.query(
      `insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,${items})
       values($1,$2,'migration',$3,array[$4]::text[])`, [role.id, role.revision, migrationName, word],
    );
    await client.query(add
      ? "insert into public.permission_role_items(role_id,permission_word) values($1,$2)"
      : "delete from public.permission_role_items where role_id=$1 and permission_word=$2", [role.id, word]);
    await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('0',64),'test')", [migrationName]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function seedVariableRenameGrants(client) {
  await varyRenameGrant(client, "club_admin", true);
  await varyRenameGrant(client, "team_coach", true);
}
