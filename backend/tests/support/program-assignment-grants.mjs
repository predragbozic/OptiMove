import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DISPOSABLE_DATABASE_NAME_PATTERN } from "./disposable-db.mjs";

// A local checkpoint has deliberately unshipped fixed words. Stage only the dedicated test database.
export async function prepareProgramAssignmentWords(sql, grantedWords) {
  assert.match((await sql.query("select current_database() name")).rows[0].name, DISPOSABLE_DATABASE_NAME_PATTERN);
  const { body: definition } = (await sql.query("select pg_get_functiondef('public.permission_word_honoured(text)'::regprocedure) body")).rows[0];
  const body = definition.replace(", 'programs.edit'", "");
  const additions = grantedWords.filter(word => word !== "programs.edit");
  const withWords = words => body.replace("'programs.view'", ["programs.view", ...words].map(word => "'" + word + "'").join(", "));
  await sql.query("begin");
  try {
    await sql.query("select public.lock_club_ceiling(array(select id from public.clubs order by id),'exclusive')");
    await sql.query(withWords(grantedWords));
    const migration = "fixtures/program-assignment-" + randomUUID();
    for (const role of ["club_admin", "team_coach"]) {
      const { id, revision } = (await sql.query(
        "update public.permission_roles set revision=revision+1,updated_at=now() where basic_key=$1 returning id,revision", [role],
      )).rows[0];
      await sql.query(`insert into public.permission_role_changes
        (role_id,revision_after,kind,migration_name,items_added) values($1,$2,'migration',$3,$4)`, [id, revision, migration, additions]);
      await sql.query("insert into public.permission_role_items(role_id,permission_word) select $1, unnest($2::text[])", [id, additions]);
    }
    await sql.query("insert into public.schema_migrations(migration_name,checksum,runner_version) values($1,repeat('0',64),'test')", [migration]);
    await sql.query("commit");
  } catch (error) {
    await sql.query("rollback");
    throw error;
  }
  return async words => sql.query(withWords(words));
}
