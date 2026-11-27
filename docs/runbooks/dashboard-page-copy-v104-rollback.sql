-- Roll back the application to a build without the copy route and drain all
-- instances using it first. This removes only the additive writer and its
-- migration record. Successfully created pages and their receipts stay intact.
begin;
set local lock_timeout = '5s';
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v104 rollback refused: the migration runner is active';
  end if;
end;
$$;
lock table public.schema_migrations in share row exclusive mode;
do $$
begin
  if not exists (select 1 from public.schema_migrations
    where migration_name = 'migrations_v2/202612061000_training_load_v104_dashboard_page_copy.sql'
      and checksum = '19c89d6c818189ce3a1146998d8ef2aec25b1f8dadb700ac183cd88cc7a461ab')
    or exists (select 1 from public.schema_migrations
      where migration_name > 'migrations_v2/202612061000_training_load_v104_dashboard_page_copy.sql')
    or (select md5(prosrc) from pg_proc
      where oid = to_regprocedure('training_load.copy_dashboard_page_contents(uuid,uuid,uuid,uuid,uuid)'))
      is distinct from 'dc35259ba1bcb357cd70383829f27307' then
    raise exception 'v104 rollback refused: missing or changed writer, checksum mismatch, or later migration';
  end if;
end;
$$;
drop function training_load.copy_dashboard_page_contents(uuid,uuid,uuid,uuid,uuid);
delete from public.schema_migrations
where migration_name = 'migrations_v2/202612061000_training_load_v104_dashboard_page_copy.sql';
commit;
