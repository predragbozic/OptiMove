export async function stageBoardManageFixture(k) {
  const { rows: [{ name }] } = await k.query("select current_database() as name");
  if (!/^optimove_tests_[a-z0-9_]+$/.test(name)) throw new Error("Board Manage fixture requires a disposable database");
  // The historical Board fixture has the storage contract but no post-v92
  // Roles migrations. Stage the three words only on this disposable database.
  const words = ["variables.view", "variables.manage", "mappings.manage"];
  const { rows: [{ prosrc }] } = await k.query("select prosrc from pg_proc where oid='public.permission_word_honoured(text)'::regprocedure");
  const added = words.map(word => "'" + word + "'").join(",");
  await k.query("begin");
  try {
    await k.query("create or replace function public.permission_word_honoured(p_word text) returns boolean language sql immutable set search_path=pg_catalog, public as $fixture$ "
      + prosrc.trim() + " or p_word in (" + added + ") $fixture$");
    await k.query("alter table public.permission_role_items disable trigger user");
    await k.query("insert into public.permission_role_items(role_id,permission_word)"
      + " select id,unnest($1::text[]) from public.permission_roles where basic_key='club_admin' on conflict do nothing", [words]);
    await k.query("alter table public.permission_role_items enable trigger user");
    await k.query("create table training_load.variables_manage_v113_use (singleton boolean primary key, first_checked_write_at timestamptz)");
    await k.query("insert into training_load.variables_manage_v113_use(singleton) values(true)");
    await k.query("commit");
  } catch (error) {
    await k.query("rollback");
    throw error;
  }
}
