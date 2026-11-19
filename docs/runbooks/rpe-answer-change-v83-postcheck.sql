-- Read-only POST-CHECK for migration v83 (an athlete changes their own RPE answer while the question is open, K4b;
-- migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql). Run after the deploy the merge triggers. Changes nothing: run each block as
--   begin transaction read only; <block>; rollback;
-- Every ok column must be true. The digests are the rehearsal's (PostgreSQL 16); on another major version a digest that
-- differs is read block by block, never "fixed" here.

-- 1. v83 is recorded once, with a checksum, and nothing later is.
select count(*) = 1 as ok_recorded_once,
       bool_and(checksum = 'e044a4ef3d91e4e66fa8531e05a41da5d56ae372663a348a3ce35ebf8ba94b82') as ok_checksum_is_the_file,
       not exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql') as ok_nothing_later
  from public.schema_migrations where migration_name = 'migrations_v2/202611201200_training_load_v83_rpe_answer_change.sql';

-- 2. The history table: row-level security on, no privilege of PUBLIC, anon or authenticated; its constraints and indexes as written.
with t as (select c.oid, c.relrowsecurity, c.relacl, c.relowner from pg_class c where c.oid = 'training_load.session_feedback_changes'::regclass),
     grantees as (select oid from pg_roles where rolname in ('anon', 'authenticated') union all select 0::oid)
select (select relrowsecurity from t) as ok_rls_on,
       not exists (select 1 from t, aclexplode(coalesce(t.relacl, acldefault('r', t.relowner))) a where a.grantee in (select oid from grantees)) as ok_table_not_granted,
       (select md5(string_agg(k.conname || '=' || pg_get_constraintdef(k.oid), ',' order by k.conname))
          from pg_constraint k where k.conrelid = 'training_load.session_feedback_changes'::regclass) = '8b681a13aa6d39077eab97a6371488e4' as ok_constraints_as_written,
       (select md5(string_agg(pg_get_indexdef(i.indexrelid), ',' order by pg_get_indexdef(i.indexrelid)))
          from pg_index i where i.indrelid = 'training_load.session_feedback_changes'::regclass) = 'b3adad0e91cf6441b1ab01e701051e40' as ok_indexes_as_written;

-- 3. The functions (body md5, not security definer, volatility, settings) and that none is executable by PUBLIC, anon or authenticated
--    but the two marker helpers (rpe_change_marker_ok, rpe_change_current_xmin; they read no table).
with f as (select p.oid, p.proname, p.prosrc, p.prosecdef, p.provolatile, p.proconfig, p.proacl, p.proowner from pg_proc p
            where p.pronamespace = 'training_load'::regnamespace
              and p.proname in ('rpe_change_marker_ok', 'rpe_change_current_xmin', 'session_feedback_changes_append_only', 'session_feedback_changes_guard',
                                'protect_session_feedback_snapshot_v83', 'session_feedback_change_link_check', 'rpe_change_state', 'change_external_rpe')),
     grantees as (select oid from pg_roles where rolname in ('anon', 'authenticated') union all select 0::oid)
select (select count(*) from f) = 8 as ok_eight_functions,
       (select md5(string_agg(f.oid::regprocedure::text || '=' || md5(f.prosrc) || ':' || f.prosecdef::text || ':' || f.provolatile::text || ':' || coalesce(array_to_string(f.proconfig, ';'), ''), ',' order by f.oid::regprocedure::text))
          from f) = 'af662f9b9299e9671b8ec29f3ab4eb21' as ok_functions_as_written,
       not exists (select 1 from f where f.prosecdef) as ok_no_security_definer,
       not exists (select 1 from f, aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
                    where a.grantee in (select oid from grantees)
                      and f.proname not in ('rpe_change_marker_ok', 'rpe_change_current_xmin')) as ok_only_marker_helpers_granted;

-- 4. The triggers: the snapshot trigger now calls the v83 function, the deferred link is deferrable initially deferred, the
--    history's three guards are there; every one enabled. The v5 function is still in place, unchanged.
select exists (select 1 from pg_trigger t where t.tgrelid = 'training_load.session_feedback'::regclass and t.tgname = 'protect_session_feedback_snapshot'
                 and t.tgfoid = 'training_load.protect_session_feedback_snapshot_v83()'::regprocedure and t.tgenabled = 'O') as ok_snapshot_trigger_v83,
       exists (select 1 from pg_trigger t where t.tgrelid = 'training_load.session_feedback'::regclass and t.tgname = 'session_feedback_change_link'
                 and t.tgdeferrable and t.tginitdeferred and t.tgenabled = 'O') as ok_link_deferred,
       (select count(*) from pg_trigger t where t.tgrelid = 'training_load.session_feedback_changes'::regclass and not t.tgisinternal and t.tgenabled = 'O') = 3 as ok_three_history_triggers,
       (select md5(p.prosrc) from pg_proc p where p.pronamespace = 'training_load'::regnamespace and p.proname = 'protect_session_feedback_snapshot')
         = '1d60bc187fa149ca524ffcb0e61d8a63' as ok_v5_function_unchanged;

-- 5. Nothing changed by the deploy: no history row, the marker not set in this session.
select not exists (select 1 from training_load.session_feedback_changes) as ok_no_change_yet,
       coalesce(current_setting('optimove.rpe_change_tx', true), '') = '' as ok_marker_not_set;

-- 6. A quiet moment after the deploy: no session idle in a transaction, no lock waiting on the answers' table.
select not exists (select 1 from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()
                     and state in ('idle in transaction', 'idle in transaction (aborted)')) as ok_no_idle_transaction,
       not exists (select 1 from pg_locks l where l.relation = 'training_load.session_feedback'::regclass and not l.granted) as ok_no_lock_wait;
