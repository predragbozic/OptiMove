import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";

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
    const original = await catalogue();
    assert.deepEqual(await wordState(), { honoured: false, grants: 0 });
    const rollback = await read("rollback");
    await fixture.applyThrough("202612081000");
    const installed = await catalogue();
    assert.deepEqual(await wordState(), { honoured: false, grants: 0 });
    assert.notDeepEqual(installed, original);
    assert.equal((await client.query("select * from training_load.builder_rpe_provenance_use")).rowCount, 0);
    await client.query(rollback);
    assert.deepEqual(await catalogue(), original);
    await fixture.applyThrough("202612081000");
    assert.deepEqual(await catalogue(), installed);
    assert.deepEqual(await wordState(), { honoured: false, grants: 0 });
    assert.equal((await client.query("select * from training_load.builder_rpe_provenance_use")).rowCount, 0);
  } finally {
    await fixture.drop();
  }
});
