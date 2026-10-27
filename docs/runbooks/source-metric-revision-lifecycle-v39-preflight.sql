-- v39 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), before the merge and deploy of the phase 4 pull request
-- (migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql,
-- deployed together with v40, whose own preflight is
-- docs/runbooks/source-metric-text-rules-v40-preflight.sql).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 13 or later (pg_current_xact_id(), used by the v35 functions v39 calls).
--    Expected: pg13_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 130000 as pg13_or_later;

-- 2. The migration state: v38, v37, v36 and v35 recorded once each with the
--    repository's checksums; v39 absent and nothing recorded at or after its
--    name (the migrator runs files in name order, so v39 must sort after v38).
--    Expected: v38_rows = 1, v38_checksum_ok = true, v37_checksum_ok = true,
--    v36_checksum_ok = true, v35_checksum_ok = true, v39_rows = 0,
--    at_or_after_v39 = 0,
--    last_migration = migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql') as v38_rows,
  (select bool_and(checksum = '30ca41f33d3aa35f4fb9e7c1a652a2f572d9475a1666cfa3a5e593e0b6cc79cc') from public.schema_migrations
    where migration_name = 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql') as v38_checksum_ok,
  (select bool_and(checksum = 'e9be4c20c4cd996836a4a83fbdf900427be2cd015ad6b8667c597054be2944ca') from public.schema_migrations
    where migration_name = 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql') as v37_checksum_ok,
  (select bool_and(checksum = '33d6e165c052c9b77335358a4f1d10ebd16858454c2621a2b55c77a1b1b3be04') from public.schema_migrations
    where migration_name = 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') as v36_checksum_ok,
  (select bool_and(checksum = '86c96952e891ce1f0e33e1f1dfdb162f26a091647161a23fe296d50c7930158c') from public.schema_migrations
    where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as v35_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') as v39_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') as at_or_after_v39,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. What v39 builds on: the three v35 functions it calls; v37's two guard
--    functions (v39 replaces them) and v37's three triggers; every trigger of
--    the two tables it guards enabled (on the revisions v34's guard and
--    no-truncate and v37's actor guard and audit link; on the audit table
--    v34's three triggers, v35's actor guard and v37's revision guard).
--    Expected: v35_functions_needed = 3, v37_functions = 2, v37_triggers = 3,
--    revision_triggers_enabled = 4, audit_triggers_enabled = 5, disabled_triggers = 0.
select
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('source_metric_context_actor', 'source_metric_actor_basis', 'source_metric_current_xmin')) as v35_functions_needed,
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('source_metric_revisions_actor_guard', 'source_metric_audit_revision_guard')) as v37_functions,
  (select count(*) from pg_trigger t
    where t.tgname in ('source_metric_revisions_v37_actor_guard', 'source_metric_revisions_v37_audit_link', 'source_metric_audit_v37_revision_guard')) as v37_triggers,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'source_metric_definition_versions' and not t.tgisinternal and t.tgenabled = 'O') as revision_triggers_enabled,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'source_metric_audit' and not t.tgisinternal and t.tgenabled = 'O') as audit_triggers_enabled,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('source_metric_definition_versions', 'source_metric_audit')
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 4. No v39 object exists yet (no name collision).
--    Expected: v39_functions = 0, v39_triggers = 0, v39_indexes = 0.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'source_metric_revisions_lifecycle_link') as v39_functions,
  (select count(*) from pg_trigger t where t.tgname like '%\_v39\_%') as v39_triggers,
  (case when to_regclass('training_load.source_metric_audit_v39_revision_once') is null then 0 else 1 end) as v39_indexes;

-- 5. The migrator's role may do it: CREATE on the schema; it owns the two
--    tables (a trigger and an index need it) and v37's two functions (a
--    `create or replace` needs it).
--    Expected: schema_create = true, owns_revisions = true, owns_audit = true,
--    owns_v37_functions = true.
select
  has_schema_privilege(current_user, 'training_load', 'CREATE') as schema_create,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_definition_versions'::regclass)) = current_user as owns_revisions,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_audit'::regclass)) = current_user as owns_audit,
  (select bool_and(pg_get_userbyid(p.proowner) = current_user) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname in ('source_metric_revisions_actor_guard', 'source_metric_audit_revision_guard')) as owns_v37_functions;

-- 6. The source fields are exactly the v34 seed, and the lifecycle has never
--    written: nine fields, nine revisions, each active, observed and without any
--    proof; no revision names a creator, an activator or a retirer; no
--    verification or lifecycle audit row.
--    Expected: fields = 9, revisions = 9, seeded_unproven = 9, lifecycle_revisions = 0,
--    verification_rows = 0, lifecycle_rows = 0.
select
  (select count(*) from training_load.source_metric_definitions) as fields,
  (select count(*) from training_load.source_metric_definition_versions) as revisions,
  (select count(*) from training_load.source_metric_definition_versions
    where seed_migration is not null and state = 'active' and evidence_status = 'observed'
      and source_unit is null and source_bound_unit is null and bound_operator is null
      and unit_verified_at is null and meaning_verified_at is null) as seeded_unproven,
  (select count(*) from training_load.source_metric_definition_versions
    where created_by_user_id is not null or activated_by_user_id is not null or retired_by_user_id is not null) as lifecycle_revisions,
  (select count(*) from training_load.source_metric_audit
    where action in ('source_metric_unit_verified', 'source_metric_meaning_verified')) as verification_rows,
  (select count(*) from training_load.source_metric_audit
    where action in ('source_metric_revision_create', 'source_metric_revision_activate', 'source_metric_revision_retire')) as lifecycle_rows;

-- 7. Informational - record the numbers (J5.1: T3, T4 and T8 were empty at the
--    v36 preflight and the v35 post-check of 2026-10-14). A mapping version
--    pinned to a seeded revision would be disabled by a replacement or a
--    retirement of that revision once it is `needs_review` (O4).
--    Expected: any value; versions_active = 0 and activations_open = 0 (no route
--    writes them before phase 7).
select
  (select count(*) from training_load.source_metric_mappings) as mappings,
  (select count(*) from training_load.source_metric_mapping_versions) as versions,
  (select count(*) from training_load.source_metric_mapping_versions where status = 'needs_review') as versions_needs_review,
  (select count(*) from training_load.source_metric_mapping_versions where status = 'active') as versions_active,
  (select count(*) from training_load.source_metric_mapping_activations where ended_at is null) as activations_open,
  (select count(*) from training_load.source_metric_audit) as audit_rows;

-- 8. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 9. A quiet moment: creating the two triggers takes SHARE ROW EXCLUSIVE on the
--    revisions table and the index SHARE on the audit table until the migration
--    commits, so no other session holds or waits for a lock mode that conflicts
--    with them (plain reads - ACCESS SHARE, ROW SHARE - do not), and none is idle
--    in a transaction.
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
