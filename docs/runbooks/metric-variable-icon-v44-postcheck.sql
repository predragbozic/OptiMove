-- v44 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor after the deploy of the PR-1b pull request has started the
-- server (`npm start` runs the migrator first)
-- (migrations_v2/202610301200_training_load_v44_metric_variable_icon.sql).
--
-- Run ONE numbered block at a time. Every block is a plain SELECT. Any value
-- other than the expected one means: stop, report the block, the column and
-- the value; the rollback (docs/runbooks/metric-variable-icon-v44-rollback.sql)
-- is the owner's decision.

-- 1. v44 recorded once with the repository's checksum, the last migration.
--    Expected: v44_rows = 1, v44_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202610301200_training_load_v44_metric_variable_icon.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301200_training_load_v44_metric_variable_icon.sql') as v44_rows,
  (select bool_and(checksum = 'd245c9b8e4790340560cf68dd93d1a73d458478ab12b59ed20871db2e765d6c3') from public.schema_migrations
    where migration_name = 'migrations_v2/202610301200_training_load_v44_metric_variable_icon.sql') as v44_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610301200_training_load_v44_metric_variable_icon.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 2. The two icon columns of the change record, nullable text.
--    Expected: icon_columns = 2, icon_columns_text_nullable = 2.
select
  (select count(*) from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_variable_changes'
    and column_name in ('old_icon_url', 'new_icon_url')) as icon_columns,
  (select count(*) from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_variable_changes'
    and column_name in ('old_icon_url', 'new_icon_url') and data_type = 'text' and is_nullable = 'YES') as icon_columns_text_nullable;

-- 3. The two functions are v44's, with their comments; the two triggers are
--    enabled, the writer's fires on icon_url and the guard's on variable_icon.
--    Expected: record_body_v44 = true, guard_body_v44 = true, comments = 2,
--    triggers_enabled = 2, record_on_icon = true, guard_on_icon = true.
select
  (select md5(p.prosrc) = '3db1c1a354428ad8b2403d4dbcc0dce0' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'metric_definitions_record_change') as record_body_v44,
  (select md5(p.prosrc) = '8a75821eddcaf96dd75f280f86a92d2c' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'metric_variable_requests_change_guard') as guard_body_v44,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname in ('metric_definitions_record_change', 'metric_variable_requests_change_guard')
      and obj_description(p.oid, 'pg_proc') like 'v44 (J3b.11):%') as comments,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load'
      and ((c.relname = 'metric_definitions' and t.tgname = 'metric_definitions_v38_record_change')
           or (c.relname = 'metric_variable_requests' and t.tgname = 'metric_variable_requests_change_guard'))
      and t.tgenabled = 'O') as triggers_enabled,
  (select pg_get_triggerdef(t.oid) like '%UPDATE OF label, short_label, description, state, icon_url ON%'
          and pg_get_triggerdef(t.oid) like '%old.icon_url IS DISTINCT FROM new.icon_url%'
     from pg_trigger t where t.tgname = 'metric_definitions_v38_record_change'
      and t.tgrelid = 'training_load.metric_definitions'::regclass) as record_on_icon,
  (select pg_get_triggerdef(t.oid) like '%''variable_icon''%'
     from pg_trigger t where t.tgname = 'metric_variable_requests_change_guard'
      and t.tgrelid = 'training_load.metric_variable_requests'::regclass) as guard_on_icon;

-- 4. The five widened checks carry the icon kind and operation.
--    Expected: checks_with_icon = 5.
select count(*) as checks_with_icon
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace
 where n.nspname = 'training_load'
   and c.conname in ('metric_variable_changes_kind_check', 'metric_variable_changes_kind_shape', 'metric_variable_requests_operation_check',
                     'metric_variable_requests_change_iff', 'metric_variable_requests_team_coach_shape')
   and pg_get_constraintdef(c.oid) like '%icon%';

-- 5. No row was changed: the change and request rows are at least preflight
--    block 6's (nothing removes one), and every change row before the first
--    icon change keeps its icon columns empty. Informational: the icon
--    changes and requests made since the deploy.
--    Expected: change_rows >= preflight change_rows, request_rows >= preflight
--    request_rows, unpaired_icon_rows = 0; icon_changes = icon_requests
--    (0 right after the deploy).
select
  (select count(*) from training_load.metric_variable_changes) as change_rows,
  (select count(*) from training_load.metric_variable_requests) as request_rows,
  (select count(*) from training_load.metric_variable_changes where kind = 'icon') as icon_changes,
  (select count(*) from training_load.metric_variable_requests where operation = 'variable_icon') as icon_requests,
  (select count(*) from training_load.metric_variable_changes c
    where (c.kind = 'icon') <> exists (select 1 from training_load.metric_variable_requests r
                                        where r.metric_variable_change_id = c.id and r.operation = 'variable_icon')) as unpaired_icon_rows;

-- 6. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';
