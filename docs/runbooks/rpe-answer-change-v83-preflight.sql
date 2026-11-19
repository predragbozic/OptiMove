-- Read-only PREFLIGHT for migration v83 (an athlete changes their own RPE answer while the question is open, K4b;
-- migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql). Run before the merge, on the database the deploy will migrate. Changes nothing:
-- run each block as
--   begin transaction read only; <block>; rollback;
-- Every ok column must be true. Block 5 is information only (no ok column).

-- 1. The server can run v83 (pg_current_xact_id() needs PostgreSQL 13 or later).
select current_setting('server_version_num')::int >= 130000 as ok_server_13_or_later,
       current_setting('server_version') as server_version;

-- 2. v83 is not recorded, and no recorded migrations_v2 migration sorts after it.
select not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql') as ok_v83_not_recorded,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql') as ok_nothing_later,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') as last_migration;

-- 3. The snapshot trigger is the v5 one: its function's body (md5), the trigger calls it, it is enabled.
select (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = 'protect_session_feedback_snapshot') = '1d60bc187fa149ca524ffcb0e61d8a63' as ok_v5_body,
       exists (select 1 from pg_trigger t where t.tgrelid = 'training_load.session_feedback'::regclass and not t.tgisinternal
                 and t.tgname = 'protect_session_feedback_snapshot' and t.tgfoid = 'training_load.protect_session_feedback_snapshot()'::regprocedure
                 and t.tgenabled = 'O') as ok_trigger_calls_v5_enabled;

-- 4. No object of v83 exists yet.
select to_regclass('training_load.session_feedback_changes') is null as ok_no_history_table,
       to_regprocedure('training_load.change_external_rpe(uuid,uuid,uuid,integer,integer,text,integer)') is null as ok_no_change_function,
       to_regprocedure('training_load.rpe_change_marker_ok()') is null as ok_no_marker_function,
       to_regprocedure('training_load.protect_session_feedback_snapshot_v83()') is null as ok_no_v83_trigger_function,
       not exists (select 1 from pg_trigger t where t.tgrelid = 'training_load.session_feedback'::regclass and t.tgname = 'session_feedback_change_link') as ok_no_link_trigger;

-- 5. Information: the answers v83 could let change later (it changes none of them when applied).
select count(*) filter (where source = 'scheduled_external') as external_answers,
       count(*) filter (where source = 'planned') as planned_answers
  from training_load.session_feedback;

-- 6. A quiet moment: no other session idle in a transaction, no lock waiting on the answers' table.
select not exists (select 1 from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
                     and state in ('idle in transaction', 'idle in transaction (aborted)')) as ok_no_idle_transaction,
       not exists (select 1 from pg_locks l where l.relation = 'training_load.session_feedback'::regclass and not l.granted) as ok_no_lock_wait;
