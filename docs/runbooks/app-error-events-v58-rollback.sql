-- Rollback of migration v58 (app error tracking; migrations_v2/202611091000_app_error_events.sql).
--
-- Not a migration and never run automatically. Rehearsed on a disposable database
-- (backend/tests/app-error-tracking-a1.test.mjs: apply -> rollback -> table and functions gone, v58 record removed -> re-apply).
-- Before it is run anywhere real: the deployed commit no longer contains the v58 migration file (otherwise the migrator
-- applies v58 again at the next start) and no longer imports appErrorTracking.js (the server would write to a missing
-- table: the writes fail quietly, but the code must go first); and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- It drops the table (with every sanitized error row: they are telemetry, not a decision), its three functions and removes the
-- v58 record. It changes no other row. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v58 is not recorded, or any later migrations_v2 migration is.
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f app-error-events-v58-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v58 rollback refused: the migrator is running';
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611091000_app_error_events.sql') then
    raise exception 'v58 rollback refused: v58 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611091000_app_error_events.sql') then
    raise exception 'v58 rollback refused: later migrations are applied';
  end if;
end $$;

drop table public.app_error_events;
drop function public.app_error_events_guard_insert();
drop function public.app_error_events_guard_update();
drop function public.app_error_events_refuse_truncate();
delete from public.schema_migrations where migration_name = 'migrations_v2/202611091000_app_error_events.sql';
commit;
