import assert from "node:assert/strict";
import { DISPOSABLE_DATABASE_NAME_PATTERN } from "./disposable-db.mjs";
import { editVariablesManageTestRole, stageVariablesManageForTest, VARIABLE_MANAGE } from "./variables-manage-grants.mjs";

export const MAPPINGS_MANAGE = "mappings.manage";

export async function stageMappingsManageForTest(client, { variables = false } = {}) {
  const { rows: [{ name }] } = await client.query("select current_database() as name");
  assert.match(name, DISPOSABLE_DATABASE_NAME_PATTERN);
  if (variables) {
    await stageVariablesManageForTest(client);
    await editVariablesManageTestRole(client, VARIABLE_MANAGE, true);
  }
  const { rows: [{ evaluator }] } = await client.query(
    "select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) as evaluator",
  );
  assert.ok(!evaluator.includes("'mappings.manage'"), "Stage Mappings once on a historical runtime fixture");
  const staged = evaluator.replace("'variables.view'", "'variables.view', 'mappings.manage'");
  assert.notEqual(staged, evaluator);
  await client.query(staged);
  await client.query("create table training_load.mappings_manage_bridge_use (singleton boolean primary key check (singleton), first_checked_write_at timestamptz)");
  await client.query("insert into training_load.mappings_manage_bridge_use(singleton) values(true)");
  await editVariablesManageTestRole(client, MAPPINGS_MANAGE, true);
}
