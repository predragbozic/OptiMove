import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures } from "./support/permission-roles-world.mjs";

const prefix = "202612191000";
const hosts = "training_load.source_host_catalog";
const connections = "training_load.source_credential_connections";
const read = name => readFile(new URL("../../docs/runbooks/sources-provider-v117-" + name + ".sql", import.meta.url), "utf8");
const all = row => assert.ok(Object.values(row).every(value => value === true), JSON.stringify(row));

async function catalogue(client) {
  return (await client.query(`select
    (select jsonb_agg(jsonb_build_array(c.relname, pg_relation_filenode(c.oid), c.relacl, c.relrowsecurity) order by c.relname)
       from pg_class c where c.oid in ('${hosts}'::regclass,'${connections}'::regclass)) as relations,
    (select jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attacl,pg_get_expr(d.adbin,d.adrelid))
       order by c.relname,a.attname)
       from pg_class c join pg_attribute a on c.oid=a.attrelid
       left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
       where c.oid in ('${hosts}'::regclass,'${connections}'::regclass) and a.attnum>0 and not a.attisdropped) as columns,
    (select jsonb_agg(jsonb_build_array(c.relname, t.tgname,t.tgenabled,pg_get_triggerdef(t.oid),md5(p.prosrc)) order by c.relname,t.tgname)
       from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_proc p on p.oid=t.tgfoid
       where not t.tgisinternal and c.oid in ('${hosts}'::regclass,'${connections}'::regclass)) as triggers,
    (select jsonb_agg(to_jsonb(h) order by h.source_system,h.host_key) from ${hosts} h) as host_rows,
    (select jsonb_agg(to_jsonb(c) order by id) from ${connections} c) as connection_rows,
    (select jsonb_agg(to_jsonb(m) order by migration_name) from public.schema_migrations m) as registry`)).rows[0];
}

test("audited v117 host and connection generation installation is private, NOWAIT and reversible before first capture", async () => {
  const db = await createPagesDatabase({ through: "202612181000", label: "sources_v117" });
  const { client } = db;
  const apiRoles = ["anon", "authenticated", "service_role"];
  const created = [];
  const inheritedRole = "v117_fixture_reader";
  let hasInheritedRole = false;
  let defaults = false;
  let holder;
  const sourceCheck = async (sql) => (await client.query(sql)).rows;
  try {
    const f = fixtures(client);
    const club = await f.club("Legacy local connection club");
    const user = await f.user("Legacy local connection owner");
    const { rows: [seed] } = await client.query(`insert into ${connections}(source_system,owner_scope,owner_club_id,host_key,account_label,credential_kind,created_by_user_id)
      values('gpexe','club',$1,'server3','Legacy local account','exchanged_token',$2) returning id`, [club,user]);
    for (const role of apiRoles) {
      if (!(await client.query("select from pg_roles where rolname=$1", [role])).rowCount) {
        await client.query("create role " + role + " nologin");
        created.push(role);
      }
    }
    await client.query("create role " + inheritedRole + " nologin");
    hasInheritedRole = true;
    await client.query("grant " + inheritedRole + " to service_role");
    await client.query("alter default privileges in schema training_load grant execute on functions to anon,authenticated,service_role");
    defaults = true;
    await client.query(`grant select(account_label) on ${connections} to authenticated`);
    const preflight = await read("preflight");
    const postcheck = await read("postcheck");
    const rollback = await read("rollback");
    const pre = async () => (await client.query(preflight)).rows[0];
    const post = async () => (await client.query(postcheck))[0].rows[0];
    const noColumns = async () => {
      assert.equal((await pre()).generation_objects_absent, true);
      assert.equal((await pre()).registry_matches, true);
    };
    all(await pre());

    await client.query(`grant select on ${hosts} to ${inheritedRole}`);
    assert.equal((await pre()).new_fields_can_remain_private, false, "inherited API table privilege is visible");
    await assert.rejects(db.applyThrough(prefix), error => error.cause?.code === "P0001"
      && /source relations already grant API or PUBLIC access/.test(error.cause.message));
    await noColumns();
    await client.query(`revoke select on ${hosts} from ${inheritedRole}`);
    await client.query(`grant select on ${connections} to public`);
    assert.equal((await pre()).new_fields_can_remain_private, false);
    await client.query(`revoke select on ${connections} from public`);
    all(await pre());

    holder = new client.constructor({ connectionString: db.url });
    await holder.connect();
    for (const table of [hosts, connections]) {
      await holder.query("begin");
      try {
        await holder.query(`select 1 from ${table} for share`);
        await assert.rejects(db.applyThrough(prefix), error => error.cause?.code === "55P03"
          && /could not obtain lock on relation/.test(error.cause.message));
        await noColumns();
      } finally {
        await holder.query("rollback");
      }
    }

    const before = await catalogue(client);
    await db.applyThrough(prefix);
    all(await post());
    const first = await catalogue(client);
    assert.deepEqual(first.relations, before.relations, "existing relation files, ACLs and RLS are unchanged");
    assert.equal((await sourceCheck(`select has_column_privilege('authenticated','${connections}','account_label','SELECT') as kept`))[0].kept, true);
    assert.ok(first.columns.some(row => row[1] === "provider_generation"));
    assert.equal(first.connection_rows[0].id, seed.id);
    assert.equal(first.connection_rows[0].provider_generation, 0);

    const later = "migrations_v2/202612191005_sources_v117_fixture_later.sql";
    await client.query("insert into public.schema_migrations(migration_name,checksum,runner_version,applied_at) values($1,repeat('0',64),'test',now()-interval '1 day')", [later]);
    await assert.rejects(client.query(rollback), /registry changed/);
    await client.query("rollback");
    await client.query("delete from public.schema_migrations where migration_name=$1", [later]);
    await client.query(`grant select(provider_generation) on ${hosts} to public`);
    assert.equal((await post()).generation_acl_private, false);
    await assert.rejects(client.query(rollback), /columns or ACL changed/);
    await client.query("rollback");
    await client.query(`revoke select(provider_generation) on ${hosts} from public`);
    all(await post());

    await client.query(rollback);
    assert.deepEqual(await catalogue(client), before);
    await db.applyThrough(prefix);
    all(await post());
    const second = await catalogue(client);
    for (const property of ["relations","columns","triggers","host_rows","connection_rows"]) {
      assert.deepEqual(second[property], first[property], property);
    }

    await client.query(`update ${hosts} set label='Legacy label update' where host_key='server3'`);
    assert.equal((await sourceCheck(`select provider_generation from ${hosts} where host_key='server3'`))[0].provider_generation, "0");
    await client.query(`update ${hosts} set state='retired' where host_key='server3'`);
    await client.query(`update ${hosts} set state='approved' where host_key='server3'`);
    assert.equal((await sourceCheck(`select provider_generation from ${hosts} where host_key='server3'`))[0].provider_generation, "2");
    await assert.rejects(client.query(rollback), /generation already captured/);
    await client.query("rollback");
    all(await post());
  } finally {
    await holder?.end();
    await client.query(`revoke select(account_label) on ${connections} from authenticated`).catch(() => {});
    if (defaults) await client.query("alter default privileges in schema training_load revoke execute on functions from anon,authenticated,service_role");
    if (hasInheritedRole) {
      await client.query(`revoke select on ${hosts} from ${inheritedRole}`);
      await client.query("revoke " + inheritedRole + " from service_role");
      await client.query("drop role " + inheritedRole);
    }
    for (const role of created) await client.query("drop role " + role);
    await db.drop();
  }
});
