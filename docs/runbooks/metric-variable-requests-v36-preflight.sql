-- v36 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), before the merge and deploy of the M3-0 pull request
-- (migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 13 or later (pg_current_xact_id(), used by the v35 functions v36 calls).
--    Expected: pg13_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 130000 as pg13_or_later;

-- 2. The migration state: v35 is the last applied migration, recorded once with
--    the repository's checksum (v34 too); v36 and anything later are absent.
--    Expected: v35_rows = 1, v35_checksum_ok = true, v34_checksum_ok = true,
--    v36_rows = 0, later_rows = 0,
--    last_migration = migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as v35_rows,
  (select bool_and(checksum = '86c96952e891ce1f0e33e1f1dfdb162f26a091647161a23fe296d50c7930158c') from public.schema_migrations
    where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as v35_checksum_ok,
  (select bool_and(checksum = '6a6958cb64c3bba47c78affe655dc6f3d618c350f46b4f6a248e832becb8609b') from public.schema_migrations
    where migration_name = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') as v34_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') as v36_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. The v35 functions v36 calls are present, and the six v35 triggers enabled.
--    Expected: v35_functions_needed = 3, v35_triggers_enabled = 6.
select
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('source_metric_context_actor', 'source_metric_actor_basis', 'source_metric_current_xmin')) as v35_functions_needed,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and t.tgname like '%\_v35\_%' and t.tgenabled = 'O') as v35_triggers_enabled;

-- 4. No v36 object exists yet (no name collision).
--    Expected: v36_table = false, v36_functions = 0.
select
  to_regclass('training_load.metric_variable_requests') is not null as v36_table,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname in ('metric_variable_requests_insert_guard', 'metric_variable_requests_append_only')) as v36_functions;

-- 5. The migrator's role may create the table and its foreign keys: CREATE on the
--    schema, REFERENCES on the four referenced tables.
--    Expected: schema_create = true and every *_references = true.
select
  has_schema_privilege(current_user, 'training_load', 'CREATE') as schema_create,
  has_table_privilege(current_user, 'training_load.metric_definitions', 'REFERENCES') as definitions_references,
  has_table_privilege(current_user, 'training_load.metric_definition_versions', 'REFERENCES') as versions_references,
  has_table_privilege(current_user, 'public.users', 'REFERENCES') as users_references,
  has_table_privilege(current_user, 'public.clubs', 'REFERENCES') as clubs_references;

-- 6. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 7. Informational only - v36 does not depend on these tables: how many M2
--    mapping rows exist (an authorized M2 write since v35 is legitimate).
--    Expected: any value; record the three numbers.
select
  (select count(*) from training_load.source_metric_mappings) as mappings,
  (select count(*) from training_load.source_metric_mapping_versions) as versions,
  (select count(*) from training_load.source_metric_audit) as audit_rows;

-- 8. A quiet moment: creating the foreign keys takes SHARE ROW EXCLUSIVE on the
--    four referenced tables until the migration commits, so no other session
--    holds or waits for a lock mode that conflicts with it (plain reads -
--    ACCESS SHARE, ROW SHARE - do not), none is idle in a transaction, and no
--    GPEXE check or identity load is running.
--    Expected: conflicting_locks = 0, idle_in_transaction = 0, running_checks = 0,
--    running_identity_loads = 0. An ordinary write to one of these tables holds
--    ROW EXCLUSIVE for a moment: a non-zero conflicting_locks that is gone when
--    the block is run again a few seconds later was such a write, not a blocker.
--    A role without pg_read_all_stats sees only its own role's sessions' state in
--    pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only (a relation id is unique per database).
select
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
      and ((n.nspname = 'training_load' and c.relname in ('metric_definitions', 'metric_definition_versions'))
        or (n.nspname = 'public' and c.relname in ('users', 'clubs')))) as conflicting_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction,
  (select count(*) from training_load.gpexe_import_checks where status = 'running') as running_checks,
  (select count(*) from training_load.gpexe_athlete_identity_requests where status = 'running') as running_identity_loads;

-- 9. The two unique constraints whose names the admin service maps to a stable
--    answer (key_taken; try_again for a concurrent version number) exist under
--    exactly these names. A different name would not break anything - the
--    write fails closed as a sanitized 500 with nothing written - but the
--    answer would lose its code.
--    Expected: key_constraint = true, version_number_constraint = true.
select
  exists (select 1 from pg_constraint
           where conrelid = 'training_load.metric_definitions'::regclass and contype = 'u'
             and conname = 'metric_definitions_owner_scope_owner_user_id_owner_club_id__key') as key_constraint,
  exists (select 1 from pg_constraint
           where conrelid = 'training_load.metric_definition_versions'::regclass and contype = 'u'
             and conname = 'metric_definition_versions_metric_definition_id_version_num_key') as version_number_constraint;
