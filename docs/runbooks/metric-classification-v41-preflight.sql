-- v41 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), on the day of the merge and deploy of the phase 12b pull request
-- (migrations_v2/202610281000_training_load_v41_metric_classification.sql).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 15 or later (v41's unique indexes use NULLS NOT DISTINCT; the
--    v35 functions it calls use pg_current_xact_id()).
--    Expected: pg15_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: v40 and v39 recorded once each with the repository's
--    checksums; v41 absent and nothing recorded at or after its name (the
--    migrator runs files in name order, so v41 must sort after v40).
--    Expected: v40_rows = 1, v40_checksum_ok = true, v39_checksum_ok = true,
--    v41_rows = 0, at_or_after_v41 = 0,
--    last_migration = migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql') as v40_rows,
  (select bool_and(checksum = 'd684fce90ff11f0e8e834b96241cb32d6be8fe039e17fedf3e9a3d4dfc396332') from public.schema_migrations
    where migration_name = 'migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql') as v40_checksum_ok,
  (select bool_and(checksum = '3e77aa69c91d9558cd3983a3fdb2279b39367aa4800c6c029cca6bbeec8b3196') from public.schema_migrations
    where migration_name = 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') as v39_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610281000_training_load_v41_metric_classification.sql') as v41_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202610281000_training_load_v41_metric_classification.sql') as at_or_after_v41,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. What v41 builds on: the three v35 functions and v40's text rule; the
--    three v10 tables, with no trigger on the domains and categories and only
--    v10's breadth trigger, enabled, on the links.
--    Expected: v35_functions_needed = 3, text_rule = 1, v10_tables = 3,
--    node_triggers = 0, link_triggers = 1, link_triggers_enabled = 1.
select
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('source_metric_context_actor', 'source_metric_actor_basis', 'source_metric_current_xmin')) as v35_functions_needed,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_text_ok') as text_rule,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('metric_domains', 'metric_categories', 'metric_structure_links')) as v10_tables,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('metric_domains', 'metric_categories') and not t.tgisinternal) as node_triggers,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'metric_structure_links' and not t.tgisinternal) as link_triggers,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'metric_structure_links' and not t.tgisinternal and t.tgenabled = 'O') as link_triggers_enabled;

-- 4. No v41 object exists yet (no name collision).
--    Expected: v41_tables = 0, v41_columns = 0, v41_indexes = 0, v41_functions = 0.
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('metric_classification_changes', 'metric_classification_requests')) as v41_tables,
  (select count(*) from information_schema.columns
    where table_schema = 'training_load' and table_name in ('metric_domains', 'metric_categories') and column_name in ('key', 'description')) as v41_columns,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('metric_domains_canonical_key_unique', 'metric_categories_canonical_key_unique',
                                                          'metric_structure_links_one_domain_per_category')) as v41_indexes,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname like 'metric\_classification\_%') as v41_functions;

-- 5. The fail-closed condition of v41 (C101): no system or club domain,
--    category or link exists (the owner's count of 2026-10-28 found none).
--    Expected: canonical_domains = 0, canonical_categories = 0, canonical_links = 0.
select
  (select count(*) from training_load.metric_domains where owner_scope in ('system', 'club')) as canonical_domains,
  (select count(*) from training_load.metric_categories where owner_scope in ('system', 'club')) as canonical_categories,
  (select count(*) from training_load.metric_structure_links where owner_scope in ('system', 'club')) as canonical_links;

-- 6. The migrator's role may do it: CREATE on the schema; it owns the three
--    v10 tables (adding columns, indexes and triggers needs ownership).
--    Expected: schema_create = true, owns_v10_tables = 3.
select
  has_schema_privilege(current_user, 'training_load', 'CREATE') as schema_create,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('metric_domains', 'metric_categories', 'metric_structure_links')
      and pg_get_userbyid(c.relowner) = current_user) as owns_v10_tables;

-- 7. Informational - record the numbers: team and user rows of the three
--    tables (the older API's coach classification, which v41 leaves as it is).
--    Expected: any value (the owner's count of 2026-10-28 found no row at all).
select
  (select count(*) from training_load.metric_domains where owner_scope in ('team', 'user')) as coach_domains,
  (select count(*) from training_load.metric_categories where owner_scope in ('team', 'user')) as coach_categories,
  (select count(*) from training_load.metric_structure_links where owner_scope in ('team', 'user')) as coach_links;

-- 8. A quiet moment: adding the columns, indexes and triggers takes a short
--    exclusive lock on each of the three v10 tables; no session should hold
--    one of them, and no transaction should sit idle.
--    Expected: conflicting_locks = 0, idle_in_transaction = 0. A non-zero
--    value: wait a minute and run the block again.
select
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('metric_domains', 'metric_categories', 'metric_structure_links')
      and l.database = (select oid from pg_database where datname = current_database())
      and l.pid <> pg_backend_pid()) as conflicting_locks,
  (select count(*) from pg_stat_activity
    where state = 'idle in transaction' and datname = current_database() and pid <> pg_backend_pid()) as idle_in_transaction;
