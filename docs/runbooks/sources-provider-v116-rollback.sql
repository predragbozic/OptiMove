-- Down is limited to the unopened additive store.
begin;
set local lock_timeout = '5s';
do $registry$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'Sources provider rollback refused: migrator is running';
  end if;
  if not exists (select from public.schema_migrations
where migration_name = 'migrations_v2/202612181000_training_load_v116_sources_provider_store.sql' and checksum = 'fbb52694dcbdd31fe3e67e2d998b5a612923daff431498a65fb45286b7cf0f11') or exists (
    select from public.schema_migrations later
    where later.migration_name ~ '^migrations_v2/[0-9]{12}_'
      and later.migration_name <> 'migrations_v2/202612181000_training_load_v116_sources_provider_store.sql'
      and (later.migration_name > 'migrations_v2/202612181000_training_load_v116_sources_provider_store.sql'
        or later.applied_at >= (select applied_at from public.schema_migrations
          where migration_name = 'migrations_v2/202612181000_training_load_v116_sources_provider_store.sql'))
  ) then
    raise exception 'Sources provider rollback refused: registry changed';
  end if;
end
$registry$;

lock table training_load.source_provider_admission, training_load.source_provider_attempts,
  training_load.source_provider_attempt_teams in access exclusive mode;
do $store$
begin
  if ((select count(*) = 1 and bool_and(singleton and not enabled and epoch = 0)
from training_load.source_provider_admission)
and not exists (select from training_load.source_provider_attempts)
and not exists (select from training_load.source_provider_attempt_teams)) is distinct from true then
    raise exception 'Sources provider rollback refused: store is not closed and empty';
  end if;
  if ((select count(*) = 3 from pg_trigger t
where (t.tgrelid, t.tgname) in (
  ('training_load.source_provider_admission'::regclass, 'source_provider_admission_keep_closed'),
  ('training_load.source_provider_attempts'::regclass, 'source_provider_attempts_keep_closed'),
  ('training_load.source_provider_attempt_teams'::regclass, 'source_provider_attempt_teams_keep_closed')
) and t.tgenabled = 'O' and t.tgtype = 62
  and t.tgfoid = to_regprocedure('training_load.source_provider_store_closed()')) and ((select md5(prosrc) from pg_proc
where oid = to_regprocedure('training_load.source_provider_store_closed()')) = '952568303b4b671a17dd04ced6660840')) is distinct from true then
    raise exception 'Sources provider rollback refused: closed store guard changed';
  end if;
end
$store$;

drop table training_load.source_provider_attempt_teams,
  training_load.source_provider_attempts, training_load.source_provider_admission;
drop function training_load.source_provider_store_closed();
delete from public.schema_migrations where migration_name = 'migrations_v2/202612181000_training_load_v116_sources_provider_store.sql' and checksum = 'fbb52694dcbdd31fe3e67e2d998b5a612923daff431498a65fb45286b7cf0f11';
commit;
