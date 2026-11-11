-- Rollback of migration v61 (the attendance states of an import are bound to its approval, J20-C):
-- migrations_v2/202611101200_training_load_v61_import_states_approval.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/import-states-j20c.test.mjs:
-- apply -> rollback -> the v60 catalog exactly -> re-apply, and every refusal below). Before it is run anywhere real: a fresh
-- restore-verified backup exists; the deployed commit no longer contains the v61 migration file (otherwise the migrator
-- applies it again at the next start); the deployed backend no longer writes origin_approval_id (the commit before J20-C does
-- not); and the owner approved this database specifically (.claude/rules/database-safety.md).
--
-- It re-points the request trigger at v60's guard (which v61 left in place), drops the CHECK, the column, the window function
-- and v61's guard, and removes the v61 record. It changes no other row. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v61 is not recorded, or any later migrations_v2 migration is;
--   * the body in force of a v61 function is not v61's (by md5);
--   * an import-origin roster request exists (the column that binds it to its approval would be lost).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f import-states-v61-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v61 rollback refused: the migrator is running';
  end if;
end $$;

-- Nothing may be written between the checks below and the drops.
lock table training.activity_roster_requests in access exclusive mode;

do $$
declare
  v61 constant text := 'migrations_v2/202611101200_training_load_v61_import_states_approval.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v61) then
    raise exception 'v61 rollback refused: v61 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v61) then
    raise exception 'v61 rollback refused: later migrations are applied';
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training' and p.proname = 'protect_activity_roster_request_v61') is distinct from 'd5de0d3419ff4f78bf194418351ad21b'
     or (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'training_load' and p.proname = 'import_states_window') is distinct from '66c9abcdc147d7e2adbccd413377f21c'
     or (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'training' and p.proname = 'protect_activity_roster_request_v60') is distinct from 'b80d37661ee1b9dc021b6d08b8e74993' then
    raise exception 'v61 rollback refused: a body in force is not the one v61 left';
  end if;
  if exists (select 1 from training.activity_roster_requests where origin = 'import') then
    raise exception 'v61 rollback refused: an import-origin roster request exists';
  end if;
end $$;

drop trigger activity_roster_requests_protect on training.activity_roster_requests;
create trigger activity_roster_requests_protect
  before insert or update or delete on training.activity_roster_requests
  for each row execute function training.protect_activity_roster_request_v60();
alter table training.activity_roster_requests drop constraint activity_roster_requests_origin_approval_check;
alter table training.activity_roster_requests drop column origin_approval_id;
drop function training.protect_activity_roster_request_v61();
drop function training_load.import_states_window();
delete from public.schema_migrations where migration_name = 'migrations_v2/202611101200_training_load_v61_import_states_approval.sql';

-- Post-gate: v60's guard in force on the trigger, every v61 object gone.
do $$
begin
  if (select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid
       where t.tgname = 'activity_roster_requests_protect' and not t.tgisinternal and t.tgenabled = 'O'
         and p.proname = 'protect_activity_roster_request_v60') <> 1 then
    raise exception 'v61 rollback failed: the request trigger does not run v60''s guard';
  end if;
  if to_regprocedure('training.protect_activity_roster_request_v61()') is not null
     or to_regprocedure('training_load.import_states_window()') is not null
     or exists (select 1 from information_schema.columns where table_schema = 'training' and table_name = 'activity_roster_requests' and column_name = 'origin_approval_id') then
    raise exception 'v61 rollback failed: a v61 object is still there';
  end if;
end $$;
commit;
