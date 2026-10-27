-- v38 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), after the deploy of the R2 merge served /api/health with ok: true.
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. The migration record: v38 recorded exactly once with the repository's
--    checksum, and it is the last migration; v37 is still recorded once with
--    its checksum.
--    Expected: v38_rows = 1, v38_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql,
--    v37_rows = 1, v37_checksum_ok = true.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql') as v38_rows,
  (select bool_and(checksum = '30ca41f33d3aa35f4fb9e7c1a652a2f572d9475a1666cfa3a5e593e0b6cc79cc') from public.schema_migrations
    where migration_name = 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql') as v38_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql') as v37_rows,
  (select bool_and(checksum = 'e9be4c20c4cd996836a4a83fbdf900427be2cd015ad6b8667c597054be2944ca') from public.schema_migrations
    where migration_name = 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql') as v37_checksum_ok;

-- 2. The change table and the widened request table: the three new columns,
--    the version column nullable.
--    Expected: changes_table = 1, new_request_columns = 3, version_nullable = YES.
select
  (case when to_regclass('training_load.metric_variable_changes') is null then 0 else 1 end) as changes_table,
  (select count(*) from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_variable_requests'
    and column_name in ('basis_team_id', 'metric_variable_change_id', 'reason')) as new_request_columns,
  (select is_nullable from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_variable_requests'
    and column_name = 'metric_definition_version_id') as version_nullable;

-- 3. The seven v38 functions exist in training_load.
--    Expected: v38_functions = 7, missing_functions = {} (empty).
with expected(name) as (values
  ('metric_variable_change_basis'), ('metric_variable_changes_insert_guard'), ('metric_definitions_record_change'),
  ('metric_definitions_key_freeze'), ('metric_variable_requests_change_guard'), ('metric_variable_changes_request_link'),
  ('metric_variable_changes_append_only'))
select
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname in (select name from expected)) as v38_functions,
  array(select e.name from expected e where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'training_load' and p.proname = e.name) order by 1) as missing_functions;

-- 4. The eight triggers v38 creates or recreates exist on their own tables and
--    are enabled; the request link is deferrable and initially deferred; v36's
--    insert guard is gated by operation and the R2 guard by the three new ones.
--    Expected: v38_triggers = 8, v38_triggers_enabled = 8, deferred_links = 1,
--    v36_guard_gated = true, r2_guard_gated = true, missing_triggers = {} (empty).
with expected(tbl, name, deferred) as (values
  ('metric_variable_changes', 'metric_variable_changes_insert_guard', false),
  ('metric_variable_changes', 'metric_variable_changes_request_link', true),
  ('metric_variable_changes', 'metric_variable_changes_no_update_delete', false),
  ('metric_variable_changes', 'metric_variable_changes_no_truncate', false),
  ('metric_definitions', 'metric_definitions_v38_record_change', false),
  ('metric_definitions', 'metric_definitions_v38_key_freeze', false),
  ('metric_variable_requests', 'metric_variable_requests_change_guard', false),
  ('metric_variable_requests', 'metric_variable_requests_insert_guard', false)),
found as (
  select e.name, e.deferred, t.oid, t.tgenabled, t.tgdeferrable, t.tginitdeferred
    from expected e
    join pg_class c on c.relname = e.tbl
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'training_load'
    join pg_trigger t on t.tgrelid = c.oid and t.tgname = e.name)
select
  (select count(*) from found) as v38_triggers,
  (select count(*) from found where tgenabled = 'O') as v38_triggers_enabled,
  (select count(*) from found where deferred and tgdeferrable and tginitdeferred) as deferred_links,
  (select pg_get_triggerdef(oid) like '%WHEN ((new.operation = ANY (ARRAY[''variable_create''::text, ''variable_version_create''::text])))%'
     from found where name = 'metric_variable_requests_insert_guard') as v36_guard_gated,
  (select pg_get_triggerdef(oid) like '%WHEN ((new.operation = ANY (ARRAY[''variable_rename''::text, ''variable_archive''::text, ''variable_restore''::text])))%'
     from found where name = 'metric_variable_requests_change_guard') as r2_guard_gated,
  array(select e.name from expected e where e.name not in (select name from found) order by 1) as missing_triggers;

-- 5. The v38 indexes exist and are valid.
--    Expected: v38_indexes = 6, v38_indexes_valid = 6.
with expected(name) as (values
  ('metric_variable_changes_pkey'), ('metric_variable_changes_one_seq'), ('metric_variable_changes_definition_idx'),
  ('metric_variable_changes_user_idx'), ('metric_variable_requests_one_per_change'), ('metric_variable_requests_basis_team_idx'))
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in (select name from expected)) as v38_indexes,
  (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in (select name from expected) and i.indisvalid) as v38_indexes_valid;

-- 6. The request table's constraints: v36's names kept (the operation and basis
--    checks widened), the nine v38 ones added.
--    Expected: v36_names = 13, v38_names = 9, operation_widened = true, basis_widened = true.
select
  (select count(*) from pg_constraint where conrelid = 'training_load.metric_variable_requests'::regclass and conname in (
    'metric_variable_requests_basis_check', 'metric_variable_requests_basis_shape', 'metric_variable_requests_hash_check',
    'metric_variable_requests_metric_definition_id_fkey', 'metric_variable_requests_one_per_key', 'metric_variable_requests_one_per_version',
    'metric_variable_requests_operation_check', 'metric_variable_requests_owner_club_id_fkey', 'metric_variable_requests_owner_scope_check',
    'metric_variable_requests_owner_shape', 'metric_variable_requests_pkey', 'metric_variable_requests_requested_by_user_id_fkey',
    'metric_variable_requests_version_fk')) as v36_names,
  (select count(*) from pg_constraint where conrelid = 'training_load.metric_variable_requests'::regclass and conname in (
    'metric_variable_requests_basis_team_id_fkey', 'metric_variable_requests_metric_variable_change_id_fkey',
    'metric_variable_requests_one_per_change', 'metric_variable_requests_version_iff', 'metric_variable_requests_change_iff',
    'metric_variable_requests_team_iff', 'metric_variable_requests_team_coach_shape', 'metric_variable_requests_reason_check',
    'metric_variable_requests_archive_reason')) as v38_names,
  (select pg_get_constraintdef(oid) like '%variable_rename%variable_archive%variable_restore%' from pg_constraint
    where conrelid = 'training_load.metric_variable_requests'::regclass and conname = 'metric_variable_requests_operation_check') as operation_widened,
  (select pg_get_constraintdef(oid) like '%team_coach%' from pg_constraint
    where conrelid = 'training_load.metric_variable_requests'::regclass and conname = 'metric_variable_requests_basis_check') as basis_widened;

-- 7. Nothing written yet by R2, and no row of a v38 shape.
--    Expected: change_rows = 0, r2_request_rows = 0, coach_rows = 0.
select
  (select count(*) from training_load.metric_variable_changes) as change_rows,
  (select count(*) from training_load.metric_variable_requests
    where operation in ('variable_rename', 'variable_archive', 'variable_restore')) as r2_request_rows,
  (select count(*) from training_load.metric_variable_requests where basis = 'team_coach') as coach_rows;

-- 8. No actor default, and none left on this session.
--    Expected: actor_defaults = 0, session_actor = null (or an empty string).
select
  (select count(*) from pg_db_role_setting s, unnest(s.setconfig) as cfg where cfg like 'optimove.source_metric_actor=%') as actor_defaults,
  current_setting('optimove.source_metric_actor', true) as session_actor;
