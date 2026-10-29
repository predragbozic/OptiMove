-- v43 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), on the day of the merge and deploy of the phase 7b pull request
-- (migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql;
-- contract docs/ai/phase7b-mapping-transitions-contract.md, section 7).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 15 or later, as v41 already needs.
--    Expected: pg15_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: v42 the last migration, recorded once with the
--    repository's checksum; v43 absent and nothing recorded at or after its
--    name (the migrator runs files in name order).
--    Expected: v42_rows = 1, v42_checksum_ok = true, v43_rows = 0,
--    at_or_after_v43 = 0,
--    last_migration = migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql') as v42_rows,
  (select bool_and(checksum = '042445620eade972e9940667c4777469a5e9d22f3d9b551d1d4b64bbdb610af1') from public.schema_migrations
    where migration_name = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql') as v42_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql') as v43_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql') as at_or_after_v43,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. No v43 function or trigger exists yet (no name collision), and v35's
--    source_metric_actor_basis is the body v35 wrote (v43 leaves it as it is;
--    the post-check shows the same md5).
--    Expected: v43_functions = 0, v43_triggers = 0, actor_basis_is_v35 = true.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('source_metric_audit_replacement_link', 'source_metric_audit_transition_facts')) as v43_functions,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and t.tgname like 'source_metric_audit_v43_%') as v43_triggers,
  (select md5(p.prosrc) = 'bff4852216ffda968b33b730cd05da47'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_actor_basis') as actor_basis_is_v35;

-- 4. HARD ASSERTIONS: no mapping version is active and no activation (T5)
--    exists - nothing before phase 7b could write either. If safe_to_merge is
--    not true: STOP, do not merge, report the values.
--    Expected: active_versions = 0, activations = 0, safe_to_merge = true.
select
  (select count(*) from training_load.source_metric_mapping_versions where status = 'active') as active_versions,
  (select count(*) from training_load.source_metric_mapping_activations) as activations,
  (select count(*) from training_load.source_metric_mapping_versions where status = 'active') = 0
    and (select count(*) from training_load.source_metric_mapping_activations) = 0 as safe_to_merge;

-- 5. Informational - record the numbers; the post-check (block 4) shows them
--    again, unchanged (v43 writes no row).
--    Expected: any value.
select
  (select count(*) from training_load.source_metric_mappings) as mappings,
  (select count(*) from training_load.source_metric_mapping_versions where status = 'draft') as versions_draft,
  (select count(*) from training_load.source_metric_mapping_versions where status = 'needs_review') as versions_needs_review,
  (select count(*) from training_load.source_metric_mapping_versions where status = 'active') as versions_active,
  (select count(*) from training_load.source_metric_mapping_versions where status = 'disabled') as versions_disabled,
  (select count(*) from training_load.source_metric_audit
    where action in ('mapping_create', 'mapping_version_create', 'mapping_status', 'mapping_version_replaced')) as mapping_audit_rows;

-- 6. The migrator's role may do it: CREATE on the schema (two functions) and
--    ownership of the audit table (two triggers); every trigger of T3, T4 and
--    T8 is enabled.
--    Expected: schema_create = true, owns_audit = true, disabled_triggers = 0.
select
  has_schema_privilege(current_user, 'training_load', 'CREATE') as schema_create,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_audit'::regclass)) = current_user as owns_audit,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('source_metric_mappings', 'source_metric_mapping_versions', 'source_metric_audit')
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 7. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 8. A quiet moment: creating the two triggers takes SHARE ROW EXCLUSIVE on the
--    audit table until the migration commits, so no other session holds or
--    waits for a lock on T3, T4 or T8 that a write takes (plain reads - ACCESS
--    SHARE - do not), and none is idle in a transaction.
--    Expected: table_locks = 0, idle_in_transaction = 0. A non-zero
--    table_locks that is gone when the block is run again a few seconds later
--    was an ordinary short write, not a blocker.
--    A role without pg_read_all_stats sees only its own role's sessions' state in
--    pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only (a relation id is unique per database).
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.mode in ('RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
      and l.relation in ('training_load.source_metric_mappings'::regclass, 'training_load.source_metric_mapping_versions'::regclass,
                         'training_load.source_metric_audit'::regclass)) as table_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;

-- 9. No GPEXE check and no identity load is running. advisory_locks is
--    information only: every source-metric write and many other requests hold
--    a transaction-level advisory lock for a moment, and v43 does not wait on
--    one (block 8 is the lock that matters).
--    Expected: running_checks = 0, running_identity_loads = 0; advisory_locks
--    any value (record it).
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid() and l.locktype = 'advisory'
      and l.database = (select oid from pg_database where datname = current_database())) as advisory_locks,
  (select count(*) from training_load.gpexe_import_checks where status = 'running') as running_checks,
  (select count(*) from training_load.gpexe_athlete_identity_requests where status = 'running') as running_identity_loads;
