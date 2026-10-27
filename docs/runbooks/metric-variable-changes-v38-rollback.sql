-- Rollback of migration v38 (rename, archive and restore of a canonical
-- variable, R2):
-- migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/canonical-variables-r2.test.mjs: apply -> rollback
-- -> the v37 catalog again -> re-apply, and every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the
-- deployed commit no longer contains the v38 migration file (otherwise the
-- migrator applies v38 again at the next start) nor the R2 routes that write
-- these tables; and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- v38 adds one table (training_load.metric_variable_changes), three columns,
-- nine constraints (seven checks and uniques, two foreign keys) and one index
-- of training_load.metric_variable_requests, seven functions and seven
-- triggers; it widens two checks of the request table, makes its version
-- column nullable and gates v36's insert trigger by operation. It changes no data. This script reverses exactly that and
-- removes the v38 record. It refuses, changing nothing, when
--   * v38 is not recorded on the database;
--   * any migrations_v2 migration newer than v38 is recorded;
--   * any change row exists, or any request row of a v38 operation - they are
--     the only record of an R2 write; once one exists the way forward is a new
--     migration, never this script;
--   * the v38 objects are not exactly the ones v38 created (one is missing,
--     or a trigger is disabled).
--
-- One transaction: everything or nothing. Waits are bounded: a stalled
-- transaction that holds one of the tables makes this script fail after 5 s.
-- The triggers on training_load.metric_definitions are dropped too, which
-- locks that table briefly against every access; a request that reads
-- Metrics Core can wait behind it. Run it at a quiet moment, as one script
-- that stops at the first error (psql -v ON_ERROR_STOP=1 -f ...): after a
-- refusal the open transaction is aborted and nothing is changed.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql') then
    raise exception 'v38 rollback refused: v38 is not recorded on this database';
  end if;
  if to_regclass('training_load.metric_variable_changes') is null then
    raise exception 'v38 rollback refused: the v38 table is not present';
  end if;
end $$;

lock table training_load.metric_definitions, training_load.metric_variable_requests, training_load.metric_variable_changes
  in access exclusive mode;

do $$
declare
  v38 constant text := 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql';
  reasons text[] := '{}';
  newer text;
  missing text;
  disabled text;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name like 'migrations_v2/%' and migration_name > v38;
  if newer is not null then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if exists (select 1 from training_load.metric_variable_changes)
     or exists (select 1 from training_load.metric_variable_requests
                 where operation in ('variable_rename', 'variable_archive', 'variable_restore')) then
    reasons := array_append(reasons, 'change records exist');
  end if;
  select string_agg(f.name, ', ' order by f.name) into missing
    from unnest(array['metric_variable_change_basis', 'metric_variable_changes_insert_guard', 'metric_definitions_record_change',
                      'metric_definitions_key_freeze', 'metric_variable_requests_change_guard',
                      'metric_variable_changes_request_link', 'metric_variable_changes_append_only']) as f(name)
   where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'training_load' and p.proname = f.name);
  if missing is not null then
    reasons := array_append(reasons, 'the v38 functions are not all present');
  end if;
  select string_agg(t.rel || '.' || t.name, ', ' order by t.rel, t.name) into missing
    from (values ('metric_variable_changes', 'metric_variable_changes_insert_guard'),
                 ('metric_variable_changes', 'metric_variable_changes_request_link'),
                 ('metric_variable_changes', 'metric_variable_changes_no_update_delete'),
                 ('metric_variable_changes', 'metric_variable_changes_no_truncate'),
                 ('metric_definitions', 'metric_definitions_v38_record_change'),
                 ('metric_definitions', 'metric_definitions_v38_key_freeze'),
                 ('metric_variable_requests', 'metric_variable_requests_change_guard'),
                 ('metric_variable_requests', 'metric_variable_requests_insert_guard')) as t(rel, name)
   where not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'training_load' and c.relname = t.rel and g.tgname = t.name and not g.tgisinternal);
  if missing is not null then
    reasons := array_append(reasons, 'the v38 triggers are not all present');
  end if;
  select string_agg(c.relname || '.' || g.tgname, ', ' order by c.relname, g.tgname) into disabled
    from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'training_load' and not g.tgisinternal and g.tgenabled <> 'O'
     and (c.relname in ('metric_variable_changes', 'metric_variable_requests')
          or (c.relname = 'metric_definitions' and g.tgname like 'metric_definitions_v38_%'));
  if disabled is not null then
    reasons := array_append(reasons, 'a v38 trigger is disabled');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v38 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

-- The request table: v36's trigger without the operation gate, then v36's
-- columns and checks exactly (every row left is a v36 operation with its
-- version, so the restored checks hold).
drop trigger metric_variable_requests_change_guard on training_load.metric_variable_requests;
drop trigger metric_variable_requests_insert_guard on training_load.metric_variable_requests;
create trigger metric_variable_requests_insert_guard
  before insert on training_load.metric_variable_requests
  for each row execute function training_load.metric_variable_requests_insert_guard();
drop index training_load.metric_variable_requests_basis_team_idx;
alter table training_load.metric_variable_requests
  drop constraint metric_variable_requests_version_iff,
  drop constraint metric_variable_requests_change_iff,
  drop constraint metric_variable_requests_team_iff,
  drop constraint metric_variable_requests_team_coach_shape,
  drop constraint metric_variable_requests_reason_check,
  drop constraint metric_variable_requests_archive_reason,
  drop column reason,
  drop column metric_variable_change_id,
  drop column basis_team_id,
  alter column metric_definition_version_id set not null,
  drop constraint metric_variable_requests_basis_check,
  add constraint metric_variable_requests_basis_check check (basis in ('platform_admin', 'club_admin')),
  drop constraint metric_variable_requests_operation_check,
  add constraint metric_variable_requests_operation_check check (operation in ('variable_create', 'variable_version_create'));

-- The definition's triggers, then the change table with its constraints,
-- indexes and triggers.
drop trigger metric_definitions_v38_record_change on training_load.metric_definitions;
drop trigger metric_definitions_v38_key_freeze on training_load.metric_definitions;
drop table training_load.metric_variable_changes;

drop function training_load.metric_variable_requests_change_guard();
drop function training_load.metric_variable_changes_request_link();
drop function training_load.metric_variable_changes_append_only();
drop function training_load.metric_variable_changes_insert_guard();
drop function training_load.metric_definitions_record_change();
drop function training_load.metric_definitions_key_freeze();
drop function training_load.metric_variable_change_basis(uuid, uuid, uuid);

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql';

commit;
