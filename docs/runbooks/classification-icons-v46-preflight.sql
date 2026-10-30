-- v46 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), on the day of the merge and deploy of the PR-1c pull request
-- (migrations_v2/202610301300_training_load_v46_classification_icons.sql;
-- contract docs/ai/gpexe-metric-variable-mapping-discovery.md, section J6.1).
-- PR-1b (v45) is merged, deployed and post-checked first; this preflight is
-- run after that.
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 15 or later (v41 already needs it; v46's CREATE OR REPLACE
--    TRIGGER needs 14).
--    Expected: pg15_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: v41 (whose objects v46 changes) recorded once with
--    the repository's checksum; PR-1b's v45 recorded once with its checksum;
--    v46 absent and nothing recorded at or after its name (the migrator runs
--    files in name order). The last migration is v45, or a later migration of
--    another part whose name sorts before v46's.
--    Expected: v41_rows = 1, v41_checksum_ok = true, v45_rows = 1,
--    v45_checksum_ok = true, v46_rows = 0, at_or_after_v46 = 0, and
--    last_migration either
--    migrations_v2/202610301200_training_load_v45_metric_variable_icon.sql
--    or a later migration of another part whose name sorts before v46's.
--    v45_rows = 0 means PR-1b is not deployed yet: stop, PR-1b goes first.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610281000_training_load_v41_metric_classification.sql') as v41_rows,
  (select bool_and(checksum = '600be1a964ac92cf55486f2cc4bf41bbf488539073e83e6de610778831f4d89d') from public.schema_migrations
    where migration_name = 'migrations_v2/202610281000_training_load_v41_metric_classification.sql') as v41_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301200_training_load_v45_metric_variable_icon.sql') as v45_rows,
  (select bool_and(checksum = 'e7a4d23dcd387b6f2e1474cc7b9026605d76504175e6e0ce691907c5d4bce400') from public.schema_migrations
    where migration_name = 'migrations_v2/202610301200_training_load_v45_metric_variable_icon.sql') as v45_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301300_training_load_v46_classification_icons.sql') as v46_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202610301300_training_load_v46_classification_icons.sql') as at_or_after_v46,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. What v46 replaces is exactly v41's (so the rollback, which restores v41's
--    text, gives back what was there): the bodies of the three functions; the
--    two record triggers present, enabled and without icon_url; v41's four
--    checks under their names; every trigger of the four tables enabled.
--    Expected: node_guard_v41 = true, record_body_v41 = true,
--    requests_guard_v41 = true, record_triggers_enabled = 2,
--    domain_trigger_v41 = true, category_trigger_v41 = true, v41_checks = 4,
--    disabled_triggers = 0. (v46 replaces the two triggers with CREATE OR
--    REPLACE TRIGGER, which leaves them enabled: this block is what shows that
--    none was disabled before.)
select
  (select md5(p.prosrc) = 'de795b95d52cc615673030f6bcd9840e' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'metric_classification_node_guard') as node_guard_v41,
  (select md5(p.prosrc) = '843f90e8c79a552b2e6e1aa89736e438' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'metric_classification_record_node_change') as record_body_v41,
  (select md5(p.prosrc) = 'a1d5e87775c6cd83111585a4efff683d' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'metric_classification_requests_guard') as requests_guard_v41,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load'
      and ((c.relname = 'metric_domains' and t.tgname = 'metric_domains_v41_record_change')
           or (c.relname = 'metric_categories' and t.tgname = 'metric_categories_v41_record_change'))
      and t.tgenabled = 'O') as record_triggers_enabled,
  (select pg_get_triggerdef(t.oid) not like '%icon_url%' from pg_trigger t
    where t.tgname = 'metric_domains_v41_record_change' and t.tgrelid = 'training_load.metric_domains'::regclass) as domain_trigger_v41,
  (select pg_get_triggerdef(t.oid) not like '%icon_url%' from pg_trigger t
    where t.tgname = 'metric_categories_v41_record_change' and t.tgrelid = 'training_load.metric_categories'::regclass) as category_trigger_v41,
  (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'training_load'
      and c.conname in ('metric_classification_changes_kind_check', 'metric_classification_changes_shape',
                        'metric_classification_changes_kind_shape', 'metric_classification_requests_operation_check')) as v41_checks,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load'
      and c.relname in ('metric_domains', 'metric_categories', 'metric_classification_changes', 'metric_classification_requests')
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 4. No v46 object exists yet (no name collision, nothing half applied).
--    Expected: v46_columns = 0, v46_icon_rules = 0, icon_in_checks = 0.
select
  (select count(*) from information_schema.columns
    where table_schema = 'training_load'
      and ((table_name in ('metric_domains', 'metric_categories') and column_name = 'icon_url')
           or (table_name = 'metric_classification_changes' and column_name in ('old_icon_url', 'new_icon_url')))) as v46_columns,
  (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'training_load' and c.conname in ('metric_domains_icon_rule', 'metric_categories_icon_rule')) as v46_icon_rules,
  (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'training_load'
      and c.conname in ('metric_classification_changes_kind_check', 'metric_classification_changes_shape',
                        'metric_classification_changes_kind_shape', 'metric_classification_requests_operation_check')
      and pg_get_constraintdef(c.oid) like '%icon%') as icon_in_checks;

-- 5. The migrator's role may do it: it owns the four tables v46 alters or
--    whose trigger it replaces, and the three functions it replaces.
--    Expected: owns_domains = true, owns_categories = true, owns_changes = true,
--    owns_requests = true, owns_functions = 3.
select
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.metric_domains'::regclass)) = current_user as owns_domains,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.metric_categories'::regclass)) = current_user as owns_categories,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.metric_classification_changes'::regclass)) = current_user as owns_changes,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.metric_classification_requests'::regclass)) = current_user as owns_requests,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('metric_classification_node_guard', 'metric_classification_record_node_change', 'metric_classification_requests_guard')
      and pg_get_userbyid(p.proowner) = current_user) as owns_functions;

-- 6. Every existing row satisfies the checks v46 writes (its four new columns
--    start empty, which every v41 kind accepts). Informational: the number of
--    change and request rows (the baseline of post-check block 5) and of
--    canonical domains and categories.
--    Expected: rows_outside_v41 = 0; change_rows, request_rows,
--    canonical_domains, canonical_categories = any value (record them).
select
  (select count(*) from training_load.metric_classification_changes
    where kind not in ('create', 'rename', 'archive', 'restore', 'link', 'remove')) as rows_outside_v41,
  (select count(*) from training_load.metric_classification_changes) as change_rows,
  (select count(*) from training_load.metric_classification_requests) as request_rows,
  (select count(*) from training_load.metric_domains where owner_scope in ('system', 'club')) as canonical_domains,
  (select count(*) from training_load.metric_categories where owner_scope in ('system', 'club')) as canonical_categories;

-- 7. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 8. A quiet moment. Until the migration commits it holds ACCESS EXCLUSIVE on
--    the four tables (reads of domains and categories wait too: for the
--    migration's few milliseconds, or up to the runner's 30 s lock timeout
--    while it waits for a lock); so no other session holds or waits for any
--    lock on them, and none is idle in a transaction.
--    Expected: locks_on_v46_tables = 0, idle_in_transaction = 0. A non-zero
--    locks_on_v46_tables that is gone when the block is run again a few
--    seconds later was an ordinary short read or write, not a blocker.
--    A role without pg_read_all_stats sees only its own role's sessions' state in
--    pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only.
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation in ('training_load.metric_domains'::regclass, 'training_load.metric_categories'::regclass,
                         'training_load.metric_classification_changes'::regclass,
                         'training_load.metric_classification_requests'::regclass)) as locks_on_v46_tables,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;
