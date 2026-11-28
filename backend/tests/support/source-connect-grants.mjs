import assert from "node:assert/strict";
import { DISPOSABLE_DATABASE_NAME_PATTERN } from "./disposable-db.mjs";
import { reviseFixtureRole, takeFixtureCeilings } from "./variables-manage-grants.mjs";

export async function setSourceConnectFixture(client, enabled) {
  const { rows: [{ name }] } = await client.query("select current_database() as name");
  assert.match(name, DISPOSABLE_DATABASE_NAME_PATTERN);
  await client.query("begin");
  try {
    await takeFixtureCeilings(client);
    const { rows: [{ ddl }] } = await client.query(
      "select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) as ddl",
    );
    if (!ddl.includes("'sources.connect'")) {
      const staged = ddl.replace("'variables.view'", "'variables.view', 'sources.connect'");
      assert.notEqual(staged, ddl);
      await client.query(staged);
    }
    await reviseFixtureRole(client, "sources.connect", enabled);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
