-- v37 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), before the merge and deploy of the M2b pull request
-- (migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 13 or later (pg_current_xact_id(), used by the v35 functions v37 calls).
--    Expected: pg13_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 130000 as pg13_or_later;

-- 2. The migration state: v36 is the last applied migration, recorded once with
--    the repository's checksum (v35 and v34 too); v37 and anything later are absent.
--    Expected: v36_rows = 1, v36_checksum_ok = true, v35_checksum_ok = true,
--    v34_checksum_ok = true, v37_rows = 0, later_rows = 0,
--    last_migration = migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') as v36_rows,
  (select bool_and(checksum = '33d6e165c052c9b77335358a4f1d10ebd16858454c2621a2b55c77a1b1b3be04') from public.schema_migrations
    where migration_name = 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') as v36_checksum_ok,
  (select bool_and(checksum = '86c96952e891ce1f0e33e1f1dfdb162f26a091647161a23fe296d50c7930158c') from public.schema_migrations
    where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as v35_checksum_ok,
  (select bool_and(checksum = '6a6958cb64c3bba47c78affe655dc6f3d618c350f46b4f6a248e832becb8609b') from public.schema_migrations
    where migration_name = 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql') as v34_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql') as v37_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name > 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') as later_rows,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. What v37 builds on: the three v35 functions it calls, and every trigger of
--    the two tables it guards enabled (v34's revision guard and no-truncate,
--    v34's audit guards, v35's audit actor guard).
--    Expected: v35_functions_needed = 3, revision_triggers_enabled = 2,
--    audit_triggers_enabled = 4, disabled_triggers = 0.
select
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('source_metric_context_actor', 'source_metric_actor_basis', 'source_metric_current_xmin')) as v35_functions_needed,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'source_metric_definition_versions' and not t.tgisinternal and t.tgenabled = 'O') as revision_triggers_enabled,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'source_metric_audit' and not t.tgisinternal and t.tgenabled = 'O') as audit_triggers_enabled,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('source_metric_definition_versions', 'source_metric_audit')
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 4. No v37 object exists yet (no name collision).
--    Expected: v37_functions = 0, v37_triggers = 0, v37_indexes = 0.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('source_metric_revisions_actor_guard', 'source_metric_audit_revision_guard', 'source_metric_revisions_audit_link')) as v37_functions,
  (select count(*) from pg_trigger t where t.tgname like '%\_v37\_%') as v37_triggers,
  (case when to_regclass('training_load.source_metric_audit_v37_revision_idx') is null then 0 else 1 end
   + case when to_regclass('training_load.source_metric_audit_v37_verification_once') is null then 0 else 1 end) as v37_indexes;

-- 5. The migrator's role may create the functions, triggers and index: CREATE on
--    the schema, and it owns the two tables (a trigger and an index need it).
--    Expected: schema_create = true, owns_revisions = true, owns_audit = true.
select
  has_schema_privilege(current_user, 'training_load', 'CREATE') as schema_create,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_definition_versions'::regclass)) = current_user as owns_revisions,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_audit'::regclass)) = current_user as owns_audit;

-- 6. The source fields are exactly the v34 seed: nine fields, nine revisions,
--    each active, observed and without any proof; no verification audit row.
--    Expected: fields = 9, revisions = 9, seeded_revisions = 9, seeded_unproven = 9,
--    verification_rows = 0.
select
  (select count(*) from training_load.source_metric_definitions) as fields,
  (select count(*) from training_load.source_metric_definition_versions) as revisions,
  (select count(*) from training_load.source_metric_definition_versions where seed_migration is not null) as seeded_revisions,
  (select count(*) from training_load.source_metric_definition_versions
    where seed_migration is not null and state = 'active' and evidence_status = 'observed'
      and source_unit is null and source_bound_unit is null and bound_operator is null
      and unit_verified_at is null and meaning_verified_at is null) as seeded_unproven,
  (select count(*) from training_load.source_metric_audit
    where action in ('source_metric_unit_verified', 'source_metric_meaning_verified')) as verification_rows;

-- 7. Informational only - v37 does not depend on them: the M2 mapping rows (an
--    authorized M2 write is legitimate) and every other audit action.
--    Expected: any value; record the numbers.
select
  (select count(*) from training_load.source_metric_mappings) as mappings,
  (select count(*) from training_load.source_metric_mapping_versions) as versions,
  (select count(*) from training_load.source_metric_audit) as audit_rows;

-- 8. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 9. A quiet moment: creating the two triggers takes SHARE ROW EXCLUSIVE on both
--    tables and the index SHARE on the audit table until the migration commits,
--    so no other session holds or waits for a lock mode that conflicts with them
--    (plain reads - ACCESS SHARE, ROW SHARE - do not), and none is idle in a
--    transaction.
--    Expected: conflicting_locks = 0, idle_in_transaction = 0. A non-zero
--    conflicting_locks that is gone when the block is run again a few seconds
--    later was an ordinary short write, not a blocker.
--    A role without pg_read_all_stats sees only its own role's sessions' state in
--    pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only (a relation id is unique per database).
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
      and l.relation in ('training_load.source_metric_definition_versions'::regclass, 'training_load.source_metric_audit'::regclass)) as conflicting_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;
