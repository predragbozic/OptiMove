import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createPagesDatabase } from "./support/dashboard-pages-db.mjs";
import { fixtures } from "./support/permission-roles-world.mjs";

const prefix = "202612091000";
const baseline = "training_load.builder_rpe_plan_baselines";
const marker = "training_load.builder_rpe_copy_attestation_use";
const read = (name) => readFile(new URL(`../../docs/runbooks/builder-rpe-v107-${name}.sql`, import.meta.url), "utf8");

async function catalogue(db) {
  return (await db.query(
    `select 'field' as kind, r.relname || '.' || a.attname as name, format_type(a.atttypid,a.atttypmod) as body
     from pg_class r join pg_attribute a on a.attrelid=r.oid
     where r.relnamespace='training_load'::regnamespace and r.relname like 'builder_rpe_%' and a.attnum>0 and not a.attisdropped
     union all
     select 'trigger',t.tgname,pg_get_triggerdef(t.oid)
     from pg_trigger t join pg_class r on r.oid=t.tgrelid
     where r.relnamespace='training_load'::regnamespace and r.relname like 'builder_rpe_%' and not t.tgisinternal
     union all
     select 'function',p.proname,pg_get_functiondef(p.oid)
     from pg_proc p where p.pronamespace='training_load'::regnamespace and p.proname like 'guard_builder_rpe_%'
     order by 1,2`,
  )).rows;
}

test("v107 is additive for legacy writers and restores the catalogue on an unused rollback", async () => {
  const fixture = await createPagesDatabase({ through: "202612081000", label: "builder_rpe_v107" });
  const db = fixture.client;
  const checks = async (name) => {
    const result = await db.query(await read(name));
    assert.ok(Object.values(result.rows[0]).every(value => value === true), JSON.stringify(result.rows[0]));
  };
  const refuseRollback = async (pattern) => {
    await assert.rejects(db.query(await read("rollback")), pattern);
    await db.query("rollback");
  };
  const insertPlan = async (actor) => (await db.query(
    `insert into plans.plans(plan_type,created_by_user_id,name,status,source_type,visibility,is_template)
     values ('program',$1,'Disposable v107 plan','draft','builder','private',true) returning id`, [actor],
  )).rows[0].id;
  try {
    const actor = await fixtures(db).user("Builder v107 fixture");
    const source = await insertPlan(actor);
    const legacy = await insertPlan(actor);
    const original = await catalogue(db);
    await checks("preflight");
    await db.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values('migrations_v2/202612091000_fixture_collision.sql','collision','fixture')");
    const collision = await db.query(await read("preflight"));
    assert.equal(collision.rows[0].v107_pending, false);
    await db.query("delete from public.schema_migrations where migration_name='migrations_v2/202612091000_fixture_collision.sql'");
    await fixture.applyThrough(prefix);
    await checks("postcheck");
    // Exact v106 INSERT column list shape: the new marker is never supplied.
    await db.query(
      `insert into ${baseline}(plan_id,origin,source_plan_id,source_updated_at,opening_tracking,opening_rpe)
       values ($1,'copy',$2,now(),true,true)`, [legacy,source],
    );
    assert.equal((await db.query(`select opening_verified from ${baseline} where plan_id=$1`, [legacy])).rows[0].opening_verified, false);
    await assert.rejects(db.query(`update ${baseline} set opening_verified=true where plan_id=$1`, [legacy]), /attestation is immutable/);
    await db.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values('migrations_v2/202612101000_fixture_later.sql','later','fixture')");
    await refuseRollback(/later migration/);
    await db.query("delete from public.schema_migrations where migration_name='migrations_v2/202612101000_fixture_later.sql'");
    await db.query(await read("rollback"));
    assert.deepEqual(await catalogue(db), original);
    assert.equal((await db.query(`select opening_tracking from ${baseline} where plan_id=$1`, [legacy])).rows[0].opening_tracking, true);
    await fixture.applyThrough(prefix);
    await checks("postcheck");
    const destination = await insertPlan(actor);
    await db.query("begin");
    try {
      await db.query("create role builder_rpe_v107_owner nosuperuser");
      await db.query("grant usage on schema training_load to builder_rpe_v107_owner");
      await db.query(`alter table ${baseline} owner to builder_rpe_v107_owner`);
      await db.query(`alter table ${marker} owner to builder_rpe_v107_owner`);
      await db.query("set local role builder_rpe_v107_owner");
      const { rows: [owner] } = await db.query("select current_user as name, rolsuper from pg_roles where rolname=current_user");
      assert.deepEqual(owner, { name: "builder_rpe_v107_owner", rolsuper: false });
      await db.query(
        `insert into ${baseline}(plan_id,origin,source_plan_id,source_updated_at,opening_tracking,opening_rpe,opening_verified)
         values ($1,'copy',$2,now(),true,true,true)`, [destination,source],
      );
      assert.equal((await db.query(`select 1 from ${marker}`)).rowCount, 1);
    } finally {
      await db.query("rollback");
    }
    assert.equal((await db.query(`select 1 from ${marker}`)).rowCount, 0);
        await db.query(
      `insert into ${baseline}(plan_id,origin,source_plan_id,source_updated_at,opening_tracking,opening_rpe,opening_verified)
       values ($1,'copy',$2,now(),true,true,true)`, [destination,source],
    );
    assert.equal((await db.query(`select 1 from ${marker}`)).rowCount, 1);
    await assert.rejects(db.query(`update ${baseline} set opening_rpe=false where plan_id=$1`, [destination]), /attestation is immutable/);
    for (const query of [`delete from ${marker}`, `truncate ${marker}`]) {
      await assert.rejects(db.query(query), /attestation use is append-only/);
    }
    await db.query("delete from plans.plans where id=$1", [destination]);
    await refuseRollback(/recorded copy attestation use/);
  } finally {
    await fixture.drop();
  }
});
