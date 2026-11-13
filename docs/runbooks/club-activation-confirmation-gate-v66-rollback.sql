-- Rollback of migration v66 (the gate on a club admin's activation of a
-- mapping version of a field without parameters; J18's migration M-B):
-- migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql
--
-- Not a migration and never run automatically. Rehearsed on a disposable
-- database (backend/tests/club-activation-confirmation-gate-v66.test.mjs:
-- apply -> rollback -> the catalog before v66 exactly -> re-apply, and every
-- refusal below). Before it is run anywhere real: a fresh restore-verified
-- backup exists; the deployed commit no longer contains the v66 migration file
-- (otherwise the migrator applies v66 again at the next start); and the owner
-- approved this database specifically (.claude/rules/database-safety.md).
--
-- v66 creates one function and one trigger on T4 and changes no row and no
-- other object. This script drops exactly those two and removes the v66
-- record. Without the gate a club admin's A1 activates such a version with no
-- confirmation again (7h's behaviour); the board's save keeps working, since
-- it never depended on the gate. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026 of backend/src/migrate.js);
--   * v66 is not recorded on the database, or a later migrations_v2
--     migration other than v67 is. v67 (MT-A, another track) touches another
--     table, does not read the gate and reaches production before v66, so it
--     sits "after" v66 by file name only; removing the gate leaves it
--     untouched and it is not rolled back first;
--   * the gate's function or trigger is missing, the trigger is disabled, or
--     the function's body is not v66's (by md5).
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f club-activation-confirmation-gate-v66-rollback.sql
-- (the script carries its own BEGIN and COMMIT). Waits are bounded: a
-- transaction that holds T4 makes this script fail after 5 s.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v66 rollback refused: the migrator is running';
  end if;
end $$;

lock table training_load.source_metric_mapping_versions in share row exclusive mode;

do $$
declare
  v66 constant text := 'migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql';
  -- MT-A's migration: later by file name, independent of the gate (another table), on production before v66.
  v67 constant text := 'migrations_v2/202611131200_training_load_v67_gpexe_track_choices.sql';
  reasons text[] := '{}';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v66) then
    raise exception 'v66 rollback refused: v66 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v66
               and migration_name <> v67) then
    reasons := reasons || 'a later migration is recorded'::text;
  end if;
  if not exists (select 1 from pg_proc p where p.pronamespace = 'training_load'::regnamespace
                    and p.proname = 'source_metric_mapping_versions_confirmation_gate') then
    reasons := reasons || 'the gate''s function is missing'::text;
  elsif (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'training_load'::regnamespace
            and p.proname = 'source_metric_mapping_versions_confirmation_gate') is distinct from '0c5ccf731449b49d3988075828f90672' then
    reasons := reasons || 'the gate''s body is not v66''s'::text;
  end if;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'training_load.source_metric_mapping_versions'::regclass
                    and t.tgname = 'source_metric_mapping_versions_v66_confirmation_gate') then
    reasons := reasons || 'the gate''s trigger is missing'::text;
  elsif (select t.tgenabled from pg_trigger t where t.tgrelid = 'training_load.source_metric_mapping_versions'::regclass
            and t.tgname = 'source_metric_mapping_versions_v66_confirmation_gate') <> 'O' then
    reasons := reasons || 'the gate''s trigger is disabled'::text;
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v66 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

drop trigger source_metric_mapping_versions_v66_confirmation_gate on training_load.source_metric_mapping_versions;
drop function training_load.source_metric_mapping_versions_confirmation_gate();
delete from public.schema_migrations where migration_name = 'migrations_v2/202611131000_training_load_v66_club_activation_confirmation_gate.sql';

commit;
