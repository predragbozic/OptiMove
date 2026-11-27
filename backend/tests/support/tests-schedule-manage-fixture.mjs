// Tests-only seed for the future bridge. The marker exists only in this fixture
// and the word remains unavailable through the production Settings API.
export async function stageScheduleManageForTest(client) {
  const { rows: [{ staged }] } = await client.query("select public.permission_word_honoured('tests.schedule.manage') as staged");
  if (staged) return;
  const { rows: [previous] } = await client.query(
    "select prosrc from pg_proc where oid='public.permission_word_honoured(text)'::regprocedure",
  );
  await client.query("begin");
  try {
    await client.query(`
      create or replace function public.permission_word_honoured(p_word text)
      returns boolean language sql immutable set search_path=pg_catalog,public as $fixture$
      ${previous.prosrc.replace("select p_word in (", "select p_word in ('tests.schedule.manage', ")}
      $fixture$
    `);
    await client.query(`
      update public.permission_roles set revision=revision+1,updated_at=now()
      where basic_key in ('club_admin','team_coach')
    `);
    await client.query(`
      insert into public.permission_role_changes(role_id,revision_after,kind,migration_name,items_added)
      select id,revision,'migration','test-tests-schedule-manage',array['tests.schedule.manage']
      from public.permission_roles where basic_key in ('club_admin','team_coach')
    `);
    await client.query(`
      insert into public.permission_role_items(role_id,permission_word)
      select id,'tests.schedule.manage' from public.permission_roles where basic_key in ('club_admin','team_coach')
    `);
    await client.query(
      "insert into public.schema_migrations(migration_name,checksum,runner_version) values ('test-tests-schedule-manage',$1,'fixture')",
      ["0".repeat(64)],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
