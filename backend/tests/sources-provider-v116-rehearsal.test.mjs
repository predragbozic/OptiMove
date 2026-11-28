import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";

const prefix = "202612181000";
const read = name => readFile(new URL("../../docs/runbooks/sources-provider-v116-" + name + ".sql", import.meta.url), "utf8");
const check = (row) => assert.ok(Object.values(row).every(value => value === true), JSON.stringify(row));
const catalogue = async (client) => (await client.query(`
  select
    (select jsonb_agg(jsonb_build_array(c.relname, c.relkind, c.relrowsecurity, c.relacl) order by c.relname)
       from pg_class c where c.relnamespace = 'training_load'::regnamespace) as relations,
    (select jsonb_agg(pg_get_functiondef(p.oid) order by p.oid)
       from pg_proc p where p.pronamespace = 'training_load'::regnamespace and p.prokind = 'f') as functions,
    (select jsonb_agg(jsonb_build_array(c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid))
       order by c.relname, t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relnamespace = 'training_load'::regnamespace and not t.tgisinternal) as triggers,
    (select md5(prosrc) from pg_proc where oid = to_regprocedure('public.permission_word_honoured(text)')) as evaluator
`)).rows[0];

test("v116 is inaccessible, stays closed, rolls back exactly and reapplies", async () => {
  const fixture = await createPagesDatabase({ through: "202612171000", label: "sources_closed_v116" });
  const { client } = fixture;
  const apiRoles = ["anon", "authenticated", "service_role"];
  const createdRoles = [];
  const defaults = async (action) => {
    const parties = apiRoles.join(", ") + ", public";
    const recipient = action === "grant" ? "to" : "from";
    await client.query(`alter default privileges in schema training_load ${action} all on tables ${recipient} ${parties}`);
    await client.query(`alter default privileges in schema training_load ${action} execute on functions ${recipient} ${parties}`);
  };
  try {
    for (const role of apiRoles) {
      if (!(await client.query("select from pg_roles where rolname=$1", [role])).rowCount) {
        await client.query("create role " + role + " nologin");
        createdRoles.push(role);
      }
    }
    await defaults("grant");
    await client.query("create table training_load.v116_acl_control(id integer)");
    try {
      for (const role of apiRoles) {
        const { rows: [{ granted }] } = await client.query(
          "select has_table_privilege($1, 'training_load.v116_acl_control', 'REFERENCES') as granted", [role],
        );
        assert.equal(granted, true, role + " inherited positive default ACL control");
      }
    } finally {
      await client.query("drop table training_load.v116_acl_control");
    }
    const preflight = await read("preflight");
    const postcheck = await read("postcheck");
    const rollback = await read("rollback");
    const before = await catalogue(client);
    check((await client.query(preflight)).rows[0]);
    await fixture.applyThrough(prefix);
    const installed = await catalogue(client);
    check((await client.query(postcheck)).rows[0]);
    assert.equal(installed.evaluator, before.evaluator);
    for (const statement of [
      "update training_load.source_provider_admission set enabled=true, epoch=1",
      "delete from training_load.source_provider_admission",
      "insert into training_load.source_provider_attempts default values",
      "update training_load.source_provider_attempts set state='dispatching'",
      "insert into training_load.source_provider_attempt_teams default values",
      "truncate training_load.source_provider_attempts, training_load.source_provider_attempt_teams",
    ]) await assert.rejects(client.query(statement), /Sources provider storage is closed/);

    await client.query("alter table training_load.source_provider_attempt_teams disable trigger source_provider_attempt_teams_keep_closed");
    try {
      await assert.rejects(client.query(rollback), /closed store guard changed/);
      await client.query("rollback");
    } finally {
      await client.query("alter table training_load.source_provider_attempt_teams enable trigger source_provider_attempt_teams_keep_closed");
    }
    await client.query("create trigger fixture_extra_closure before insert on training_load.source_provider_attempts"
      + " for each statement execute function training_load.source_provider_store_closed()");
    try {
      await assert.rejects(client.query(rollback), /closed store guard changed/);
      await client.query("rollback");
    } finally {
      await client.query("drop trigger fixture_extra_closure on training_load.source_provider_attempts");
    }
    const later = "migrations_v2/202612181100_sources_rehearsal_later.sql";
    await client.query("insert into public.schema_migrations(migration_name, checksum, runner_version, applied_at) values($1, repeat('0',64), 'test', now() - interval '1 day')", [later]);
    try {
      await assert.rejects(client.query(rollback), /registry changed/);
      await client.query("rollback");
    } finally {
      await client.query("delete from public.schema_migrations where migration_name=$1", [later]);
    }
    await client.query(rollback);
    check((await client.query(preflight)).rows[0]);
    assert.deepEqual(await catalogue(client), before);
    await fixture.applyThrough(prefix);
    check((await client.query(postcheck)).rows[0]);
    assert.deepEqual(await catalogue(client), installed);
  } finally {
    try {
      await client.query("rollback");
      await defaults("revoke");
      for (const role of createdRoles) await client.query("drop role " + role);
    } finally {
      await fixture.drop();
    }
  }
});
