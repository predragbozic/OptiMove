-- v35 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), after the deploy of the v35 merge (PR #161, merge commit ed13f8a)
-- served /api/health with ok: true.
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. The migration record: v35 recorded exactly once with the repository's
--    checksum, and it is the last migration; v34 is still recorded once with its
--    checksum.
--    Expected: v35_rows = 1, v35_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql,
--    v34_rows = 1, v34_checksum_ok = true.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as v35_rows,
  (select bool_and(checksum = '86c96952e891ce1f0e33e1f1dfdb162f26a091647161a23fe296d50c7930158c') from public.schema_migrations
    where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as v35_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') as v34_rows,
  (select bool_and(checksum = '6a6958cb64c3bba47c78affe655dc6f3d618c350f46b4f6a248e832becb8609b') from public.schema_migrations
    where migration_name = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') as v34_checksum_ok;

-- 2. All eight v35 functions exist in training_load.
--    Expected: v35_functions = 8, missing_functions = {} (empty).
with expected(name) as (values
  ('source_metric_context_actor'), ('source_metric_actor_basis'), ('source_metric_current_xmin'),
  ('source_metric_mappings_actor_guard'), ('source_metric_mapping_versions_actor_guard'), ('source_metric_audit_actor_guard'),
  ('source_metric_mappings_audit_link'), ('source_metric_mapping_versions_audit_link'))
select
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname in (select name from expected)) as v35_functions,
  array(select e.name from expected e where not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'training_load' and p.proname = e.name) order by 1) as missing_functions;

-- 3. All six v35 triggers exist on their own tables and are enabled; the three
--    audit links are deferrable and initially deferred.
--    Expected: v35_triggers = 6, v35_triggers_enabled = 6, v35_deferred_links = 3,
--    missing_triggers = {} (empty).
with expected(tbl, name, deferred) as (values
  ('source_metric_mappings', 'source_metric_mappings_v35_actor_guard', false),
  ('source_metric_mappings', 'source_metric_mappings_v35_audit_link', true),
  ('source_metric_mapping_versions', 'source_metric_mapping_versions_v35_actor_guard', false),
  ('source_metric_mapping_versions', 'source_metric_mapping_versions_v35_audit_link_insert', true),
  ('source_metric_mapping_versions', 'source_metric_mapping_versions_v35_audit_link_update', true),
  ('source_metric_audit', 'source_metric_audit_v35_actor_guard', false)),
found as (
  select e.name, e.deferred, t.tgenabled, t.tgdeferrable, t.tginitdeferred
    from expected e
    join pg_class c on c.relname = e.tbl
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'training_load'
    join pg_trigger t on t.tgrelid = c.oid and t.tgname = e.name)
select
  (select count(*) from found) as v35_triggers,
  (select count(*) from found where tgenabled = 'O') as v35_triggers_enabled,
  (select count(*) from found where deferred and tgdeferrable and tginitdeferred) as v35_deferred_links,
  array(select e.name from expected e where e.name not in (select name from found) order by 1) as missing_triggers;

-- 4. Both v35 indexes exist and are valid.
--    Expected: v35_indexes = 2, v35_indexes_valid = 2.
select count(*) as v35_indexes,
       count(*) filter (where i.indisvalid and i.indisready) as v35_indexes_valid
  from pg_class ic
  join pg_namespace n on n.oid = ic.relnamespace and n.nspname = 'training_load'
  join pg_index i on i.indexrelid = ic.oid
 where ic.relname in ('source_metric_audit_v35_mapping_create_idx', 'source_metric_audit_v35_version_idx');

-- 5. The eight v34 triggers of the three tables are still there and enabled
--    (every non-internal trigger of the three tables that is not a v35 one).
--    Expected: v34_triggers = 8, v34_triggers_enabled = 8, all_triggers = 14.
select count(*) filter (where t.tgname not like '%\_v35\_%') as v34_triggers,
       count(*) filter (where t.tgname not like '%\_v35\_%' and t.tgenabled = 'O') as v34_triggers_enabled,
       count(*) as all_triggers
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'training_load' and not t.tgisinternal
   and c.relname in ('source_metric_mappings', 'source_metric_mapping_versions', 'source_metric_audit');

-- 6. T3 / T4 / T8 are still empty (no authenticated M2 write was made).
--    Expected: mappings = 0, versions = 0, audit_rows = 0.
select
  (select count(*) from training_load.source_metric_mappings) as mappings,
  (select count(*) from training_load.source_metric_mapping_versions) as versions,
  (select count(*) from training_load.source_metric_audit) as audit_rows;

-- 7. No database- or role-level default for the actor setting, and no actor set
--    in this session.
--    Expected: actor_defaults = 0, no_session_actor = true.
select
  (select count(*) from pg_db_role_setting s, unnest(s.setconfig) as cfg
    where cfg like 'optimove.source_metric_actor=%') as actor_defaults,
  coalesce(current_setting('optimove.source_metric_actor', true), '') = '' as no_session_actor;

-- 8. No M2 write in flight: no lock on the three tables held by another session,
--    no other session working on them, no session idle in a transaction.
--    Expected: table_locks = 0, m2_sessions = 0, idle_in_transaction = 0.
--    A role without pg_read_all_stats sees only its own role's sessions' state and
--    query in pg_stat_activity, so m2_sessions and idle_in_transaction count the
--    application role's sessions (the only expected writer); pg_locks is not
--    limited that way.
select
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('source_metric_mappings', 'source_metric_mapping_versions', 'source_metric_audit')
      and l.pid <> pg_backend_pid()) as table_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
      and state is distinct from 'idle' and query ilike '%source_metric_%') as m2_sessions,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;
