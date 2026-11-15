-- Rollback of migration v72 (the GPEXE field inventory, I1):
-- migrations_v2/202611151200_training_load_v72_source_field_observations.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/source-field-observations-v72.test.mjs:
-- apply -> rollback -> the catalog before v72 exactly -> re-apply, and the refusals below). Before it is run anywhere real: a fresh
-- restore-verified backup exists; the deployed commit no longer contains the v72 migration file (otherwise the migrator applies it
-- again at the next start); the owner approved this database specifically (.claude/rules/database-safety.md). A deployed commit that
-- still writes the inventory needs nothing more: a check's finalization records nothing where the table is absent.
--
-- It drops the table, its triggers and the three functions, and the v72 record. It changes no other row. It refuses, changing
-- nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v72 is not recorded, or any later migrations_v2 migration is;
--     (D1's v71, 202611151000_training_load_v71_dashboard_simple_atomic_save.sql, sorts before v72: recorded or not, it never blocks this rollback);
--   * any observation row exists (the names a club may choose from would be lost).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f source-field-observations-v72-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v72 rollback refused: the migrator is running';
  end if;
end $$;

-- Nothing may be written between the check below and the drop.
lock table training_load.source_field_observations in access exclusive mode;

do $$
declare
  v72 constant text := 'migrations_v2/202611151200_training_load_v72_source_field_observations.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v72) then
    raise exception 'v72 rollback refused: v72 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v72) then
    raise exception 'v72 rollback refused: later migrations are applied';
  end if;
  if exists (select 1 from training_load.source_field_observations) then
    raise exception 'v72 rollback refused: a field observation exists';
  end if;
end $$;

drop table training_load.source_field_observations;
drop function training_load.source_field_observations_guard();
drop function training_load.source_field_observations_keep();
drop function training_load.field_inventory_context_check();
delete from public.schema_migrations where migration_name = 'migrations_v2/202611151200_training_load_v72_source_field_observations.sql';

commit;
