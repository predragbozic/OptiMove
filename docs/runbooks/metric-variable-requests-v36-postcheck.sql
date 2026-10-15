-- v36 production post-check - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), after the deploy of the M3-0 merge (PR #163) served /api/health with
-- ok: true.
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. The migration record: v36 recorded exactly once with the repository's
--    checksum, and it is the last migration; v35 is still recorded once with its
--    checksum.
--    Expected: v36_rows = 1, v36_checksum_ok = true, later_rows = 0,
--    last_migration = migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql,
--    v35_rows = 1, v35_checksum_ok = true.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') as v36_rows,
  (select bool_and(checksum = '33d6e165c052c9b77335358a4f1d10ebd16858454c2621a2b55c77a1b1b3be04') from public.schema_migrations
    where migration_name = 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') as v36_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as v35_rows,
  (select bool_and(checksum = '86c96952e891ce1f0e33e1f1dfdb162f26a091647161a23fe296d50c7930158c') from public.schema_migrations
    where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as v35_checksum_ok;

-- 2. The table and its eleven columns, in order.
--    Expected: v36_table = true, columns = 11,
--    column_list = id,request_key,requested_by_user_id,operation,request_hash,owner_scope,owner_club_id,basis,metric_definition_id,metric_definition_version_id,created_at.
select
  to_regclass('training_load.metric_variable_requests') is not null as v36_table,
  (select count(*) from information_schema.columns
    where table_schema = 'training_load' and table_name = 'metric_variable_requests') as columns,
  (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
    where table_schema = 'training_load' and table_name = 'metric_variable_requests') as column_list;

-- 3. The constraints: the primary key, the six named checks, the two named
--    uniques and four foreign keys (user, club, definition, and the composite
--    one to the definition's version).
--    Expected: primary_keys = 1, checks = 6, uniques = 2, foreign_keys = 4,
--    missing_named = {} (empty).
with expected(name) as (values
  ('metric_variable_requests_operation_check'), ('metric_variable_requests_hash_check'),
  ('metric_variable_requests_owner_scope_check'), ('metric_variable_requests_basis_check'),
  ('metric_variable_requests_owner_shape'), ('metric_variable_requests_basis_shape'),
  ('metric_variable_requests_version_fk'), ('metric_variable_requests_one_per_key'),
  ('metric_variable_requests_one_per_version')),
found as (
  select con.conname, con.contype from pg_constraint con
   where con.conrelid = 'training_load.metric_variable_requests'::regclass)
select
  (select count(*) from found where contype = 'p') as primary_keys,
  (select count(*) from found where contype = 'c') as checks,
  (select count(*) from found where contype = 'u') as uniques,
  (select count(*) from found where contype = 'f') as foreign_keys,
  array(select e.name from expected e where e.name not in (select conname from found) order by 1) as missing_named;

-- 4. The partial unique index (one variable_create per definition) exists, is
--    valid and unique.
--    Expected: create_index = 1, create_index_valid = 1.
select count(*) as create_index,
       count(*) filter (where i.indisvalid and i.indisready and i.indisunique and i.indpred is not null) as create_index_valid
  from pg_class ic
  join pg_namespace n on n.oid = ic.relnamespace and n.nspname = 'training_load'
  join pg_index i on i.indexrelid = ic.oid
 where ic.relname = 'metric_variable_requests_one_create_per_definition';

-- 5. The two v36 functions and the three v36 triggers exist and are enabled
--    (the insert guard BEFORE INSERT per row, the append-only guard BEFORE
--    UPDATE OR DELETE per row and BEFORE TRUNCATE per statement).
--    Expected: v36_functions = 2, v36_triggers = 3, v36_triggers_enabled = 3,
--    missing_triggers = {} (empty).
with expected(name) as (values
  ('metric_variable_requests_insert_guard'), ('metric_variable_requests_no_update_delete'), ('metric_variable_requests_no_truncate')),
found as (
  select t.tgname, t.tgenabled from pg_trigger t
   where t.tgrelid = 'training_load.metric_variable_requests'::regclass and not t.tgisinternal)
select
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('metric_variable_requests_insert_guard', 'metric_variable_requests_append_only')) as v36_functions,
  (select count(*) from found where tgname in (select name from expected)) as v36_triggers,
  (select count(*) from found where tgname in (select name from expected) and tgenabled = 'O') as v36_triggers_enabled,
  array(select e.name from expected e where e.name not in (select tgname from found) order by 1) as missing_triggers;

-- 6. What v36 depends on is still in place: the three v35 functions it calls,
--    and the six v35 triggers enabled.
--    Expected: v35_functions_needed = 3, v35_triggers_enabled = 6.
select
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('source_metric_context_actor', 'source_metric_actor_basis', 'source_metric_current_xmin')) as v35_functions_needed,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and t.tgname like '%\_v35\_%' and t.tgenabled = 'O') as v35_triggers_enabled;

-- 7. No admin write has been made yet, and no actor setting is in force.
--    Expected: request_rows = 0, actor_defaults = 0, no_session_actor = true.
select
  (select count(*) from training_load.metric_variable_requests) as request_rows,
  (select count(*) from pg_db_role_setting s, unnest(s.setconfig) as cfg
    where cfg like 'optimove.source_metric_actor=%') as actor_defaults,
  coalesce(current_setting('optimove.source_metric_actor', true), '') = '' as no_session_actor;

-- 8. No write in flight on the new table: no lock on it held by another session
--    of this database, no session idle in a transaction.
--    Expected: table_locks = 0, idle_in_transaction = 0.
--    A role without pg_read_all_stats sees only its own role's sessions' state in
--    pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only (a relation id is unique per database).
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation = 'training_load.metric_variable_requests'::regclass) as table_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;
