-- v41 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), after the deploy of the phase 12b merge served /api/health with ok: true.
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. The migration record: v41 recorded exactly once with the repository's
--    checksum, and it is the last migration; v40 recorded once.
--    Expected: v41_rows = 1, v41_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202610281000_training_load_v41_metric_classification.sql,
--    v40_rows = 1.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610281000_training_load_v41_metric_classification.sql') as v41_rows,
  (select bool_and(checksum = 'accb72abce740b34ff5461071e87503343e1df2537972cae3a19a98924f8a1de') from public.schema_migrations
    where migration_name = 'migrations_v2/202610281000_training_load_v41_metric_classification.sql') as v41_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610281000_training_load_v41_metric_classification.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql') as v40_rows;

-- 2. The objects: the two tables; the key and description columns with their
--    four checks, validated; the three indexes on the v10 tables, valid; the
--    eight functions; the fifteen triggers, all enabled, one of them deferred.
--    Expected: v41_tables = 2, v41_columns = 4, v41_checks_validated = 4,
--    v41_indexes_valid = 3, v41_functions = 8, v41_triggers_enabled = 15,
--    deferred_triggers = 1.
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('metric_classification_changes', 'metric_classification_requests')) as v41_tables,
  (select count(*) from information_schema.columns
    where table_schema = 'training_load' and table_name in ('metric_domains', 'metric_categories') and column_name in ('key', 'description')) as v41_columns,
  (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'training_load' and c.convalidated
      and c.conname in ('metric_domains_key_rule', 'metric_domains_canonical_key', 'metric_categories_key_rule', 'metric_categories_canonical_key')) as v41_checks_validated,
  (select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and i.indisvalid
      and c.relname in ('metric_domains_canonical_key_unique', 'metric_categories_canonical_key_unique',
                        'metric_structure_links_one_domain_per_category')) as v41_indexes_valid,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname like 'metric\_classification\_%') as v41_functions,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and not t.tgisinternal and t.tgenabled = 'O'
      and (c.relname in ('metric_classification_changes', 'metric_classification_requests') or t.tgname like '%\_v41\_%')) as v41_triggers_enabled,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and not t.tgisinternal and t.tgdeferrable and t.tginitdeferred
      and c.relname = 'metric_classification_changes') as deferred_triggers;

-- 3. The records: until an admin uses the new Domains & categories routes, no
--    change, request or canonical row exists.
--    Expected (before the first admin write): changes = 0, requests = 0,
--    canonical_domains = 0, canonical_categories = 0, canonical_links = 0.
--    After admin writes: changes = requests, and every canonical row has a key.
select
  (select count(*) from training_load.metric_classification_changes) as changes,
  (select count(*) from training_load.metric_classification_requests) as requests,
  (select count(*) from training_load.metric_domains where owner_scope in ('system', 'club')) as canonical_domains,
  (select count(*) from training_load.metric_categories where owner_scope in ('system', 'club')) as canonical_categories,
  (select count(*) from training_load.metric_structure_links where owner_scope in ('system', 'club')) as canonical_links;

-- 4. Nothing left behind by the migration.
--    Expected: locks_on_v41_tables = 0, idle_in_transaction = 0.
select
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load'
      and c.relname in ('metric_domains', 'metric_categories', 'metric_structure_links', 'metric_classification_changes', 'metric_classification_requests')
      and l.database = (select oid from pg_database where datname = current_database())
      and l.pid <> pg_backend_pid()) as locks_on_v41_tables,
  (select count(*) from pg_stat_activity
    where state = 'idle in transaction' and datname = current_database() and pid <> pg_backend_pid()) as idle_in_transaction;
