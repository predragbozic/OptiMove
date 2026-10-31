-- v50 production preflight - READ ONLY. For the *Rukovodilac*, on the day of
-- the merge of the phase 7g pull request, under the standing order for
-- migration PRs (docs/ai/metrics-core-plan.md, section 2): each numbered block
-- verbatim through the connector, in a read-only transaction that is rolled
-- back (section 2, step 5). The owner may run the same blocks in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses).
-- Migration: migrations_v2/202610311200_training_load_v50_source_instance_end.sql;
-- contract docs/ai/phase7g-source-instance-end-contract.md, section 6 (J13
-- names it v49 "if none comes between"; the calendar's events took v49).
--
-- Run ONE numbered block at a time: the editor shows only the result of the
-- last statement it ran. Every block is a plain SELECT, so nothing is written
-- and no transaction is left open. The expected values are in the comments;
-- any other value means: stop, change nothing, report the block, the column
-- and the value.

-- 1. PostgreSQL 15 or later, as v41 already needs.
--    Expected: pg15_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: v48 (Metrics Core's last) and v49 (the calendar's
--    events, the last migrations_v2 migration) recorded once each with the
--    repository's checksums; v50 absent and nothing recorded at or after its
--    name (the migrator runs files in name order).
--    Expected: v48_rows = 1, v48_checksum_ok = true, v49_rows = 1,
--    v49_checksum_ok = true, v50_rows = 0, at_or_after_v50 = 0, and
--    last_migration = migrations_v2/202610311000_calendar_v49_events.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql') as v48_rows,
  (select bool_and(checksum = '71e57c43c0820315926c9535c31b5efcd634908bfb4c7947a75fe8990193abe0') from public.schema_migrations
    where migration_name = 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql') as v48_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610311000_calendar_v49_events.sql') as v49_rows,
  (select bool_and(checksum = 'ed1afda69b8ee364a53816965c8561699133637f66fdbd7a37c7dceb683d6539') from public.schema_migrations
    where migration_name = 'migrations_v2/202610311000_calendar_v49_events.sql') as v49_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610311200_training_load_v50_source_instance_end.sql') as v50_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202610311200_training_load_v50_source_instance_end.sql') as at_or_after_v50,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. The two bodies v50 replaces are v48's revision guard and v16's dashboard
--    gate (the migration checks the same md5s and refuses otherwise; the
--    rollback restores exactly these bodies), and the two v48 bodies v50 relies
--    on unchanged are in force: source_metric_audit_row_ok (its
--    source_instance_end shape) and source_metric_audit_actor_guard (it admits
--    this action for an active platform admin).
--    Expected: every column = true.
select
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_revision_guard') as revision_guard_is_v48,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_row_ok') as row_ok_is_v48,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'source_metric_audit_actor_guard') as actor_guard_is_v48,
  bool_and(md5(p.prosrc) = want.digest) filter (where want.name = 'dashboard_widget_series_validate_source_connection_active_state') as dashboard_gate_is_v16
  from (values
          ('source_metric_audit_revision_guard', '921db06f6f2833eb57c062fb61e82e25'),
          ('source_metric_audit_row_ok', '764f4ad70de273a443be84bc9bebd87a'),
          ('source_metric_audit_actor_guard', '3622725a1b0d454767704b2021db731c'),
          ('dashboard_widget_series_validate_source_connection_active_state', 'e978eb882932c930f78876179a11b190')) as want(name, digest)
  left join pg_proc p on p.proname = want.name and p.pronamespace = 'training_load'::regnamespace;

-- 4. HARD ASSERTION: no source_instance_end audit row and no keyed inactive
--    connection exists (no writer existed before phase 7g; the rollback refuses
--    once one does). No code writes the T7 keys before M4, so keyed_connections
--    is expected to be 0 as well.
--    Expected: instance_end_rows = 0, inactive_keyed = 0, keyed_connections = 0,
--    safe_to_merge = true. Informational, expected 0 (no code sets a
--    connection inactive): series_on_inactive, the dashboard series already
--    pinned to an inactive connection - the only rows v50's early return in
--    v16's dashboard gate changes anything for on the day of the deploy.
select
  (select count(*) from training_load.source_metric_audit where action = 'source_instance_end') as instance_end_rows,
  (select count(*) from training_load.metric_source_connections where source_host_key is not null and state = 'inactive') as inactive_keyed,
  (select count(*) from training_load.metric_source_connections where source_host_key is not null) as keyed_connections,
  (select count(*) from training_load.source_metric_audit where action = 'source_instance_end') = 0
    and (select count(*) from training_load.metric_source_connections where source_host_key is not null and state = 'inactive') = 0 as safe_to_merge,
  (select count(*) from training_load.dashboard_widget_series s
     join training_load.metric_source_connections c on c.id = s.source_connection_id
    where c.state = 'inactive') as series_on_inactive;

-- 5. No v50 object exists yet (no name collision).
--    Expected: v50_functions = 0, v50_triggers = 0, v50_index = 0.
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('metric_source_connections_state_guard', 'metric_source_connections_end_link')) as v50_functions,
  (select count(*) from pg_trigger t where t.tgrelid = 'training_load.metric_source_connections'::regclass and t.tgname like '%_v50_%') as v50_triggers,
  (select count(*) from pg_class where relname = 'source_metric_audit_v50_instance_end_once') as v50_index;

-- 6. The migrator's role may do it: CREATE on the schema (two functions), and
--    ownership of both tables (the triggers and the index); every trigger of
--    the two tables is enabled.
--    Expected: schema_create = true, owns_connections = true, owns_audit = true,
--    disabled_triggers = 0.
select
  has_schema_privilege(current_user, 'training_load', 'CREATE') as schema_create,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.metric_source_connections'::regclass)) = current_user as owns_connections,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.source_metric_audit'::regclass)) = current_user as owns_audit,
  (select count(*) from pg_trigger t
    where t.tgrelid in ('training_load.metric_source_connections'::regclass, 'training_load.source_metric_audit'::regclass)
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 7. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 8. A quiet moment: v50 takes SHARE ROW EXCLUSIVE on both tables, so it waits
--    only for a session holding ROW EXCLUSIVE on one of them (an open INSERT,
--    UPDATE or DELETE - the importer creating a connection, an audit write),
--    never for a FOR SHARE or FOR UPDATE reader; no session is idle in a
--    transaction.
--    Expected: table_writers = 0, idle_in_transaction = 0. A non-zero
--    table_writers that is gone when the block is run again a few seconds
--    later was an ordinary short write, not a blocker.
--    A role without pg_read_all_stats sees only its own role's sessions' state in
--    pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only (a relation id is unique per database).
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and l.relation in ('training_load.metric_source_connections'::regclass, 'training_load.source_metric_audit'::regclass)
      and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')) as table_writers,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;
