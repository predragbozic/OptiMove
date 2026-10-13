-- v35 production preflight - READ ONLY. For the owner to run in pgAdmin, as
-- the application's DATABASE_URL role (the one the migrator uses), before the
-- merge and deploy of the v35 pull request
-- (migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql).
--
-- Run ONE numbered block at a time (select it, then F5): pgAdmin shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, do not merge.

-- 1. PostgreSQL 13 or later (pg_current_xact_id(), used by every v35 guard).
--    Expected: pg13_or_later = true (the deployed server reported 170006 for v34).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 130000 as pg13_or_later;

-- 2. The migration state: v34 is the last applied migration, recorded once,
--    with the repository's checksum; v35 and anything later are absent.
--    Expected: v34_rows = 1, v34_checksum_ok = true, v35_rows = 0, later_rows = 0,
--    last_migration = migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') as v34_rows,
  (select bool_and(checksum = '6a6958cb64c3bba47c78affe655dc6f3d618c350f46b4f6a248e832becb8609b') from public.schema_migrations
    where migration_name = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') as v34_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as v35_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. No v35 object exists yet (no name collision).
--    Expected: v35_functions = 0, v35_triggers = 0, v35_indexes = 0.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname in (
      'source_metric_context_actor', 'source_metric_actor_basis', 'source_metric_current_xmin',
      'source_metric_mappings_actor_guard', 'source_metric_mapping_versions_actor_guard', 'source_metric_audit_actor_guard',
      'source_metric_mappings_audit_link', 'source_metric_mapping_versions_audit_link')) as v35_functions,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and t.tgname like '%\_v35\_%') as v35_triggers,
  (select count(*) from pg_indexes where schemaname = 'training_load'
    and indexname in ('source_metric_audit_v35_mapping_create_idx', 'source_metric_audit_v35_version_idx')) as v35_indexes;

-- 4. No mapping, version or audit row exists (no authenticated M2 request was made).
--    Expected: mappings = 0, versions = 0, audit_rows = 0.
select
  (select count(*) from training_load.source_metric_mappings) as mappings,
  (select count(*) from training_load.source_metric_mapping_versions) as versions,
  (select count(*) from training_load.source_metric_audit) as audit_rows;

-- 5. The v34 objects v35 builds on are in place and enabled.
--    Expected: v34_triggers_enabled = 8 and v34_triggers = 8 (the v34 guards of the three tables).
select count(*) filter (where t.tgenabled = 'O') as v34_triggers_enabled, count(*) as v34_triggers
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'training_load' and not t.tgisinternal
   and c.relname in ('source_metric_mappings', 'source_metric_mapping_versions', 'source_metric_audit');

-- 6. The role that runs the migrator owns the three tables (CREATE TRIGGER and
--    CREATE INDEX need it) and may create objects in the schema (CREATE FUNCTION).
--    Expected: owner_is_current_user = true for all three rows, and schema_create = true.
select c.relname, pg_get_userbyid(c.relowner) as owner, pg_get_userbyid(c.relowner) = current_user as owner_is_current_user,
       has_schema_privilege(current_user, 'training_load', 'CREATE') as schema_create
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'training_load' and c.relname in ('source_metric_mappings', 'source_metric_mapping_versions', 'source_metric_audit')
 order by 1;

-- 7. No database- or role-level default for the actor setting (v35 refuses one anyway; it must not exist).
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 8. A quiet moment: no lock held on the three tables, no idle-in-transaction
--    session, no running GPEXE check, no running identity load.
--    Expected: table_locks = 0, idle_in_transaction = 0, running_checks = 0, running_identity_loads = 0.
--    A role without pg_read_all_stats sees only its own sessions' state in pg_stat_activity, so
--    idle_in_transaction counts the application role's sessions (the only expected writer); pg_locks
--    is not limited that way.
select
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('source_metric_mappings', 'source_metric_mapping_versions', 'source_metric_audit')
      and l.pid <> pg_backend_pid()) as table_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction,
  (select count(*) from training_load.gpexe_import_checks where status = 'running') as running_checks,
  (select count(*) from training_load.gpexe_athlete_identity_requests where status = 'running') as running_identity_loads;
