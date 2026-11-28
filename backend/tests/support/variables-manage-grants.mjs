import assert from "node:assert/strict";
import { DISPOSABLE_DATABASE_NAME_PATTERN } from "./disposable-db.mjs";
import { key, ROLE_IDS } from "./permission-roles-world.mjs";

export const VARIABLE_MANAGE = "variables.manage";
async function assertDisposable(client) {
  const { rows: [{ name }] } = await client.query("select current_database() as name");
  assert.match(name, DISPOSABLE_DATABASE_NAME_PATTERN);
}

export async function stageVariablesManageForTest(client) {
  await assertDisposable(client);
  const { rows: [{ evaluator }] } = await client.query(
    "select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) as evaluator",
  );
  const { rows: [{ present }] } = await client.query(
    "select to_regclass('training_load.variables_manage_v113_use') is not null as present",
  );
  if (!present) {
    await client.query("create table training_load.variables_manage_v113_use (singleton boolean primary key check (singleton), first_checked_write_at timestamptz)");
    await client.query("insert into training_load.variables_manage_v113_use(singleton) values (true)");
  }
  if (evaluator.includes("'variables.manage'")) return;
  const staged = evaluator.replace("'variables.view'", "'variables.view', 'variables.manage'");
  assert.notEqual(staged, evaluator);
  await client.query(staged);
}

export async function editVariablesManageTestRole(client, word, add, roleId) {
  await assertDisposable(client);
  await client.query("begin");
  try {
    await takeFixtureCeilings(client);
    await reviseFixtureRole(client, word, add, roleId);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function reviseFixtureRole(client, word, add, roleId = ROLE_IDS.club_admin) {
  const migration = "fixtures/variables-manage-" + key() + ".sql";
  const { rows: [{ revision }] } = await client.query(
    "update public.permission_roles set revision=revision+1, updated_at=now() where id=$1 returning revision", [roleId],
  );
  const column = add ? "items_added" : "items_removed";
  await client.query(
    "insert into public.permission_role_changes(role_id,revision_after,kind,migration_name," + column + ")"
    + " values($1,$2,'migration',$3,array[$4]::text[])", [roleId, revision, migration, word],
  );
  await client.query(add
    ? "insert into public.permission_role_items (role_id,permission_word) values($1,$2)"
    : "delete from public.permission_role_items where role_id=$1 and permission_word=$2", [roleId, word]);
  await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('0',64),'test')", [migration]);
}

export async function takeFixtureCeilings(client) {
  await client.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
}
