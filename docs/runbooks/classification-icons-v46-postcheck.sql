-- v46 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor after the deploy of the PR-1c pull request has started the
-- server (`npm start` runs the migrator first)
-- (migrations_v2/202610301300_training_load_v46_classification_icons.sql).
--
-- Run ONE numbered block at a time. Every block is a plain SELECT. Any value
-- other than the expected one means: stop, report the block, the column and
-- the value; the rollback (docs/runbooks/classification-icons-v46-rollback.sql)
-- is the owner's decision.

-- 1. v46 recorded once with the repository's checksum, the last migration.
--    Expected: v46_rows = 1, v46_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202610301300_training_load_v46_classification_icons.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301300_training_load_v46_classification_icons.sql') as v46_rows,
  (select bool_and(checksum = 'e279bd6cbb01f39c6ab39fb1963b855431806a2c1ab7483e718eabe7e4f7c1d2') from public.schema_migrations
    where migration_name = 'migrations_v2/202610301300_training_load_v46_classification_icons.sql') as v46_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610301300_training_load_v46_classification_icons.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 2. The four icon columns, nullable text; the two node tables' icon rules,
--    validated.
--    Expected: icon_columns = 4, icon_columns_text_nullable = 4,
--    icon_rules_validated = 2.
select
  (select count(*) from information_schema.columns
    where table_schema = 'training_load'
      and ((table_name in ('metric_domains', 'metric_categories') and column_name = 'icon_url')
           or (table_name = 'metric_classification_changes' and column_name in ('old_icon_url', 'new_icon_url')))) as icon_columns,
  (select count(*) from information_schema.columns
    where table_schema = 'training_load'
      and ((table_name in ('metric_domains', 'metric_categories') and column_name = 'icon_url')
           or (table_name = 'metric_classification_changes' and column_name in ('old_icon_url', 'new_icon_url')))
      and data_type = 'text' and is_nullable = 'YES') as icon_columns_text_nullable,
  (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'training_load' and c.convalidated
      and c.conname in ('metric_domains_icon_rule', 'metric_categories_icon_rule')) as icon_rules_validated;

-- 3. The three functions are v46's, with their comments; the two record
--    triggers are enabled and fire on icon_url.
--    Expected: node_guard_v46 = true, record_body_v46 = true,
--    requests_guard_v46 = true, comments = 3, record_triggers_enabled = 2,
--    domain_trigger_on_icon = true, category_trigger_on_icon = true.
select
  (select md5(p.prosrc) = '0ddafa507ded0b3066feb0d8263b2e93' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'metric_classification_node_guard') as node_guard_v46,
  (select md5(p.prosrc) = '19d027eb817f1aa67b9642253fc89bdf' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'metric_classification_record_node_change') as record_body_v46,
  (select md5(p.prosrc) = '801a183648a2210a16e6b3ff95e7244e' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'metric_classification_requests_guard') as requests_guard_v46,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('metric_classification_node_guard', 'metric_classification_record_node_change', 'metric_classification_requests_guard')
      and obj_description(p.oid, 'pg_proc') like 'v46 (J6.1):%') as comments,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load'
      and ((c.relname = 'metric_domains' and t.tgname = 'metric_domains_v41_record_change')
           or (c.relname = 'metric_categories' and t.tgname = 'metric_categories_v41_record_change'))
      and t.tgenabled = 'O') as record_triggers_enabled,
  (select pg_get_triggerdef(t.oid) like '%UPDATE OF name, description, is_active, icon_url ON%'
          and pg_get_triggerdef(t.oid) like '%old.icon_url IS DISTINCT FROM new.icon_url%'
     from pg_trigger t where t.tgname = 'metric_domains_v41_record_change'
      and t.tgrelid = 'training_load.metric_domains'::regclass) as domain_trigger_on_icon,
  (select pg_get_triggerdef(t.oid) like '%UPDATE OF name, description, is_active, icon_url ON%'
          and pg_get_triggerdef(t.oid) like '%old.icon_url IS DISTINCT FROM new.icon_url%'
     from pg_trigger t where t.tgname = 'metric_categories_v41_record_change'
      and t.tgrelid = 'training_load.metric_categories'::regclass) as category_trigger_on_icon;

-- 4. The four widened checks carry the icon kind and operations.
--    Expected: checks_with_icon = 4.
select count(*) as checks_with_icon
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace
 where n.nspname = 'training_load'
   and c.conname in ('metric_classification_changes_kind_check', 'metric_classification_changes_shape',
                     'metric_classification_changes_kind_shape', 'metric_classification_requests_operation_check')
   and pg_get_constraintdef(c.oid) like '%icon%';

-- 5. No row was changed: the change and request rows are at least preflight
--    block 6's (nothing removes one), and every icon change has its icon
--    request (and the reverse). Informational: the icons set since the deploy.
--    Expected: change_rows >= preflight change_rows, request_rows >= preflight
--    request_rows, unpaired_icon_rows = 0; icon_changes = icon_requests,
--    nodes_with_icon and created_with_icon any value (all 0 right after the
--    deploy).
select
  (select count(*) from training_load.metric_classification_changes) as change_rows,
  (select count(*) from training_load.metric_classification_requests) as request_rows,
  (select count(*) from training_load.metric_classification_changes where kind = 'icon') as icon_changes,
  (select count(*) from training_load.metric_classification_requests where operation in ('domain_icon', 'category_icon')) as icon_requests,
  (select count(*) from training_load.metric_classification_changes c
    where (c.kind = 'icon') <> exists (select 1 from training_load.metric_classification_requests r
                                        where r.metric_classification_change_id = c.id
                                          and r.operation in ('domain_icon', 'category_icon'))) as unpaired_icon_rows,
  (select count(*) from training_load.metric_domains where icon_url is not null)
    + (select count(*) from training_load.metric_categories where icon_url is not null) as nodes_with_icon,
  (select count(*) from training_load.metric_classification_changes where kind = 'create' and new_icon_url is not null) as created_with_icon;

-- 6. No database- or role-level default for the actor setting, and every
--    trigger of the four tables enabled.
--    Expected: actor_defaults = 0, disabled_triggers = 0.
select
  (select count(*) from pg_db_role_setting s, unnest(s.setconfig) as cfg
    where cfg like 'optimove.source_metric_actor=%') as actor_defaults,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load'
      and c.relname in ('metric_domains', 'metric_categories', 'metric_classification_changes', 'metric_classification_requests')
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;
