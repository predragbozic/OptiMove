-- v45 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), on the day of the merge and deploy of the PR-1b pull request
-- (migrations_v2/202610301200_training_load_v45_metric_variable_icon.sql;
-- contract docs/ai/gpexe-metric-variable-mapping-discovery.md, section J3b.11).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 15 or later (v41 already needs it; v45's CREATE OR REPLACE
--    TRIGGER needs 14).
--    Expected: pg15_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: v43 recorded once with the repository's checksum;
--    v38 (whose objects v45 changes) recorded with its checksum; v45 absent and
--    nothing recorded at or after its name (the migrator runs files in name
--    order). The last migration is the roster's v44 (PR #275, deployed with
--    0592550; it touches no metric object), or a later migration of another
--    part whose name sorts before v45's.
--    Expected: v43_rows = 1, v43_checksum_ok = true, v38_checksum_ok = true,
--    roster_v44_rows = 1, roster_v44_checksum_ok = true, v45_rows = 0,
--    at_or_after_v45 = 0, and last_migration either
--    migrations_v2/202610301000_training_load_v44_activity_roster_self_report.sql
--    or a later migration of another part whose name sorts before v45's.
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql') as v43_rows,
  (select bool_and(checksum = 'b88c1662b4dd2fd0e2ff79886fd49ebe28d9f38236044ecccd5739e6f86af363') from public.schema_migrations
    where migration_name = 'migrations_v2/202610291430_training_load_v43_source_metric_mapping_transitions.sql') as v43_checksum_ok,
  (select bool_and(checksum = '30ca41f33d3aa35f4fb9e7c1a652a2f572d9475a1666cfa3a5e593e0b6cc79cc') from public.schema_migrations
    where migration_name = 'migrations_v2/202610271000_training_load_v38_metric_variable_changes.sql') as v38_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301000_training_load_v44_activity_roster_self_report.sql') as roster_v44_rows,
  (select bool_and(checksum = '2b747b2a8699ec8c8da67e768954fde298a8e9adfd44817b0a0a21d26593cf25') from public.schema_migrations
    where migration_name = 'migrations_v2/202610301000_training_load_v44_activity_roster_self_report.sql') as roster_v44_checksum_ok,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301200_training_load_v45_metric_variable_icon.sql') as v45_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%'
    and migration_name >= 'migrations_v2/202610301200_training_load_v45_metric_variable_icon.sql') as at_or_after_v45,
  (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. What v45 replaces is exactly v38's (so the rollback, which restores v38's
--    text, gives back what was there): the bodies of the two functions; the
--    two triggers present and enabled; v38's five checks under their names;
--    every trigger of the three tables enabled.
--    Expected: record_body_v38 = true, guard_body_v38 = true,
--    v38_triggers_enabled = 2, record_trigger_v38 = true, guard_trigger_v38 = true,
--    v38_checks = 5, disabled_triggers = 0. (v45 replaces the triggers with
--    CREATE OR REPLACE TRIGGER, which leaves them enabled: this block is what
--    shows that none was disabled before.)
select
  (select md5(p.prosrc) = '3c39839f4ba5a4b26e5c9e757214d555' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'metric_definitions_record_change') as record_body_v38,
  (select md5(p.prosrc) = 'fa469186a3fc127346fb4ee65d6a248b' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname = 'metric_variable_requests_change_guard') as guard_body_v38,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load'
      and ((c.relname = 'metric_definitions' and t.tgname = 'metric_definitions_v38_record_change')
           or (c.relname = 'metric_variable_requests' and t.tgname = 'metric_variable_requests_change_guard'))
      and t.tgenabled = 'O') as v38_triggers_enabled,
  (select pg_get_triggerdef(t.oid) not like '%icon_url%' from pg_trigger t
    where t.tgname = 'metric_definitions_v38_record_change' and t.tgrelid = 'training_load.metric_definitions'::regclass) as record_trigger_v38,
  (select pg_get_triggerdef(t.oid) not like '%variable_icon%' from pg_trigger t
    where t.tgname = 'metric_variable_requests_change_guard' and t.tgrelid = 'training_load.metric_variable_requests'::regclass) as guard_trigger_v38,
  (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'training_load'
      and c.conname in ('metric_variable_changes_kind_check', 'metric_variable_changes_kind_shape', 'metric_variable_requests_operation_check',
                        'metric_variable_requests_change_iff', 'metric_variable_requests_team_coach_shape')) as v38_checks,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'training_load' and c.relname in ('metric_definitions', 'metric_variable_changes', 'metric_variable_requests')
      and not t.tgisinternal and t.tgenabled <> 'O') as disabled_triggers;

-- 4. No v45 object exists yet (no name collision, nothing half applied).
--    Expected: v45_columns = 0, icon_in_checks = 0.
select
  (select count(*) from information_schema.columns where table_schema = 'training_load' and table_name = 'metric_variable_changes'
    and column_name in ('old_icon_url', 'new_icon_url')) as v45_columns,
  (select count(*) from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'training_load'
      and c.conname in ('metric_variable_changes_kind_check', 'metric_variable_changes_kind_shape', 'metric_variable_requests_operation_check',
                        'metric_variable_requests_change_iff', 'metric_variable_requests_team_coach_shape')
      and pg_get_constraintdef(c.oid) like '%icon%') as icon_in_checks;

-- 5. The migrator's role may do it: it owns the three tables v45 alters or
--    whose trigger it replaces, and the two functions it replaces.
--    Expected: owns_definitions = true, owns_changes = true, owns_requests = true,
--    owns_functions = 2.
select
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.metric_definitions'::regclass)) = current_user as owns_definitions,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.metric_variable_changes'::regclass)) = current_user as owns_changes,
  pg_get_userbyid((select relowner from pg_class where oid = 'training_load.metric_variable_requests'::regclass)) = current_user as owns_requests,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'training_load' and p.proname in ('metric_definitions_record_change', 'metric_variable_requests_change_guard')
      and pg_get_userbyid(p.proowner) = current_user) as owns_functions;

-- 6. Every existing row satisfies the checks v45 writes (its two new columns
--    start empty, which every v38 kind accepts). Informational: the number of
--    change and request rows, and of canonical variables with an icon - a
--    stored value that is not a library key (not `icon:` and a key) is shown
--    as no icon, and a later icon change replaces it, keeping the old value in
--    its change row for good. If canonical_with_other_icon is above 0, the
--    owner may read those values (read-only) before the merge.
--    Expected: rows_outside_v38 = 0; change_rows, request_rows,
--    canonical_with_icon, canonical_with_other_icon = any value (record them;
--    change_rows and request_rows are the baseline of post-check block 5).
select
  (select count(*) from training_load.metric_variable_changes where kind not in ('rename', 'archive', 'restore')) as rows_outside_v38,
  (select count(*) from training_load.metric_variable_changes) as change_rows,
  (select count(*) from training_load.metric_variable_requests) as request_rows,
  (select count(*) from training_load.metric_definitions where owner_scope in ('system', 'club') and icon_url is not null) as canonical_with_icon,
  (select count(*) from training_load.metric_definitions where owner_scope in ('system', 'club') and icon_url is not null
    and icon_url !~ '^icon:[a-z0-9]+(-[a-z0-9]+)*$') as canonical_with_other_icon;

-- 7. No database- or role-level default for the actor setting.
--    Expected: actor_defaults = 0.
select count(*) as actor_defaults
  from pg_db_role_setting s, unnest(s.setconfig) as cfg
 where cfg like 'optimove.source_metric_actor=%';

-- 8. A quiet moment. Until the migration commits it holds SHARE ROW EXCLUSIVE
--    on metric_definitions (its plain reads go on, writes wait) and
--    ACCESS EXCLUSIVE on metric_variable_changes and metric_variable_requests;
--    so no other session holds or waits for a conflicting lock on these
--    tables, and none is idle in a transaction.
--    Expected: conflicting_locks = 0, idle_in_transaction = 0. A non-zero
--    conflicting_locks that is gone when the block is run again a few seconds
--    later was an ordinary short write, not a blocker.
--    A role without pg_read_all_stats sees only its own role's sessions' state in
--    pg_stat_activity, so idle_in_transaction counts the application role's
--    sessions (the only expected writer); pg_locks is not limited that way, and
--    is read for this database only.
select
  (select count(*) from pg_locks l
    where l.pid <> pg_backend_pid()
      and l.database = (select oid from pg_database where datname = current_database())
      and ((l.relation in ('training_load.metric_variable_changes'::regclass, 'training_load.metric_variable_requests'::regclass))
           or (l.relation = 'training_load.metric_definitions'::regclass
               and l.mode in ('RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')))) as conflicting_locks,
  (select count(*) from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()) as idle_in_transaction;
