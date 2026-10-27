-- v38 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), before the merge and deploy of the R2 pull request
-- (migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 13 or later (pg_current_xact_id() and xid8, used by v38 and by
--    the v35 functions it calls).
--    Expected: pg13_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 130000 as pg13_or_later;

-- 2. The migration state: v37, v36 and v35 recorded once each with the
--    repository's checksums; v38 absent and nothing recorded at or after its
--    name (the migrator runs files in name order, so v38 must sort last).
--    Expected: v37_rows = 1, v37_checksum_ok = true, v36_checksum_ok = true,
--    v35_checksum_ok = true, v38_rows = 0, at_or_after_v38 = 0,
--    last_migration = migrations_v2/202610191300_media_upload_lifecycle.sql.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql') as v37_rows,
  (select bool_and(checksum = 'e9be4c20c4cd996836a4a83fbdf900427be2cd015ad6b8667c597054be2944ca') from public.schema_migrations
    where migration_name = 'migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql') as v37_checksum_ok,
  (select bool_and(checksum = '33d6e165c052c9b77335358a4f1d10ebd16858454c2621a2b55c77a1b1b3be04') from public.schema_migrations
    where migration_name = 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') as v36_checksum_ok,
  (select bool_and(checksum = '86c96952e891ce1f0e33e1f1dfdb162f26a091647161a23fe296d50c7930158c') from public.schema_migrations
    where migration_name = 'migrations_v2/202610131000_training_load_v35_source_metric_actor_guards.sql') as v35_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql') as v38_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql') as at_or_after_v38,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. What v38 builds on: the v34 text rule and the two v35 functions it calls;
--    v36's guard function; every trigger of the two tables it changes enabled
--    (on metric_definitions v34's two guards; on metric_variable_requests v36's
--    insert guard and its two append-only triggers).
--    Expected: functions_needed = 4, definition_triggers_enabled = 2,
--    request_triggers_enabled = 3, disabled_triggers = 0.
select
  (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('source_metric_text_ok', 'source_metric_context_actor', 'source_metric_current_xmin',
                        'metric_variable_requests_insert_guard')) as functions_needed,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'metric_definitions' and not t.tgisinternal and t.tgenabled = 'O') as definition_triggers_enabled,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname = 'metric_variable_requests' and not t.tgisinternal and t.tgenabled = 'O') as request_triggers_enabled,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('metric_definitions', 'metric_variable_requests')
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 4. No v38 object exists yet (no name collision).
--    Expected: v38_table = 0, v38_columns = 0, v38_functions = 0, v38_triggers = 0, v38_indexes = 0.
select
  (case when to_regclass('training_load.metric_variable_changes') is null then 0 else 1 end) as v38_table,
  (select count(*) from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_variable_requests'
    and column_name in ('basis_team_id', 'metric_variable_change_id', 'reason')) as v38_columns,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load'
      and p.proname in ('metric_variable_change_basis', 'metric_variable_changes_insert_guard', 'metric_definitions_record_change',
                        'metric_definitions_key_freeze', 'metric_variable_requests_change_guard',
                        'metric_variable_changes_request_link', 'metric_variable_changes_append_only')) as v38_functions,
  (select count(*) from pg_trigger t
    where t.tgname in ('metric_definitions_v38_record_change', 'metric_definitions_v38_key_freeze', 'metric_variable_requests_change_guard')) as v38_triggers,
  (case when to_regclass('training_load.metric_variable_requests_basis_team_idx') is null then 0 else 1 end) as v38_indexes;

-- 5. The migrator's role may do it: CREATE on the schema; it owns the two
--    tables v38 alters or adds triggers to; it may reference the three tables
--    the new foreign keys point at.
--    Expected: schema_create = true, owns_definitions = true, owns_requests = true,
--    references_users = true, references_clubs = true, references_teams = true.
select
  has_schema_privilege(current_user, 'training_load', 'CREATE') as schema_create,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.metric_definitions'::regclass)) = current_user as owns_definitions,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.metric_variable_requests'::regclass)) = current_user as owns_requests,
  has_table_privilege(current_user, 'public.users', 'REFERENCES') as references_users,
  has_table_privilege(current_user, 'public.clubs', 'REFERENCES') as references_clubs,
  has_table_privilege(current_user, 'public.teams', 'REFERENCES') as references_teams;

-- 6. Every existing request row satisfies the checks v38 adds: a v36 operation
--    with its version, a v36 basis (the new columns start empty).
--    Expected: rows_outside_v36 = 0, rows_without_version = 0, rows_with_other_basis = 0;
--    request_rows = any value (record it).
select
  (select count(*) from training_load.metric_variable_requests) as request_rows,
  (select count(*) from training_load.metric_variable_requests where operation not in ('variable_create', 'variable_version_create')) as rows_outside_v36,
  (select count(*) from training_load.metric_variable_requests where metric_definition_version_id is null) as rows_without_version,
  (select count(*) from training_load.metric_variable_requests where basis not in ('platform_admin', 'club_admin')) as rows_with_other_basis;

-- 7. Informational only - v38 changes no data: the canonical variables and how
--    many are archived (an archive made before v38 has no change row; Q8 counts
--    it as an administrator's).
--    Expected: any value; record the numbers.
select
  (select count(*) from training_load.metric_definitions where owner_scope = 'system') as system_variables,
  (select count(*) from training_load.metric_definitions where owner_scope = 'club') as club_variables,
  (select count(*) from training_load.metric_definitions where owner_scope in ('system', 'club') and state = 'archived') as archived_canonical;

-- 8. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 9. A quiet moment. Until the migration commits it holds ACCESS EXCLUSIVE on
--    metric_variable_requests (its columns and checks), SHARE ROW EXCLUSIVE on
--    metric_definitions (two triggers and a new foreign key into it) and SHARE
--    ROW EXCLUSIVE on public.users, public.clubs and public.teams (the new
--    foreign keys); so no other session holds or waits for a lock mode that
--    conflicts with those on these tables, and none is idle in a transaction.
--    Plain reads of the three public tables (a sign-in, a session check) do not
--    conflict with SHARE ROW EXCLUSIVE; their writes wait for the migration.
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
      and ((l.relation = 'training_load.metric_variable_requests'::regclass)
           or (l.relation in ('training_load.metric_definitions'::regclass, 'public.users'::regclass, 'public.clubs'::regclass, 'public.teams'::regclass)
               and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')))) as conflicting_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;
