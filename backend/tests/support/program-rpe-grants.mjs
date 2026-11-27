import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DISPOSABLE_DATABASE_NAME_PATTERN } from "./disposable-db.mjs";

const word = "programs.rpe_settings";

export async function changeProgramRpeGrant(db, basicKey, add) {
  const fixtureName = "fixtures/test-only-programs-rpe-" + randomUUID() + ".sql";
  assert.match((await db.query("select current_database() as name")).rows[0].name, DISPOSABLE_DATABASE_NAME_PATTERN);
  await db.query("begin");
  try {
    await db.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
    if (add && !(await db.query("select public.permission_word_honoured($1) as ready", [word])).rows[0].ready) {
      const { definition } = (await db.query("select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) as definition")).rows[0];
      const staged = definition.replace("'programs.view'", "'programs.view', 'programs.rpe_settings'");
      assert.notEqual(staged, definition);
      await db.query(staged);
    }
    const role = (await db.query("update public.permission_roles set revision=revision+1,updated_at=now() where basic_key=$1 returning id,revision", [basicKey])).rows[0];
    if (add) {
      await db.query("insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,items_added) values($1,$2,'migration',$3,array[$4]::text[])", [role.id, role.revision, fixtureName, word]);
      await db.query("insert into public.permission_role_items(role_id,permission_word) values($1,$2)", [role.id, word]);
    } else {
      await db.query("insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,items_removed) values($1,$2,'migration',$3,array[$4]::text[])", [role.id, role.revision, fixtureName, word]);
      await db.query("delete from public.permission_role_items where role_id=$1 and permission_word=$2", [role.id, word]);
    }
    await db.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('0',64),'test')", [fixtureName]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

export async function seedProgramRpeGrants(db) {
  for (const basicKey of ["club_admin", "team_coach"]) {
    const { rows: [existing] } = await db.query(`select public.permission_word_honoured($2) and exists (
      select 1 from public.permission_role_items i join public.permission_roles r on r.id=i.role_id
       where r.basic_key=$1 and i.permission_word=$2) as ready`, [basicKey, word]);
    if (!existing.ready) await changeProgramRpeGrant(db, basicKey, true);
  }
}
