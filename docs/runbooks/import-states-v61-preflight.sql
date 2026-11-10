-- Read-only PREFLIGHT for migration v61 (migrations_v2/202611101200_training_load_v61_import_states_approval.sql); run before the
-- deploy that applies it (the Rukovodilac, Supabase SQL Editor, each block in a read-only transaction). Changes nothing. Every
-- block returns rows with ok = true (or the stated facts).

-- 1. v60 is the last applied migration and v61 is not recorded.
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%')
         = 'migrations_v2/202611101000_training_load_v60_undo_roster_work.sql' as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611101200_training_load_v61_import_states_approval.sql') as v61_absent;

-- 2. The guard v61 replaces is v60's (md5 of prosrc) and the trigger runs it; the migration refuses to run otherwise.
select md5(p.prosrc) as actual_md5, md5(p.prosrc) = 'b80d37661ee1b9dc021b6d08b8e74993' as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training' and p.proname = 'protect_activity_roster_request_v60';
select count(*) = 1 as ok
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid
 where t.tgname = 'activity_roster_requests_protect' and not t.tgisinternal and t.tgenabled = 'O'
   and p.proname = 'protect_activity_roster_request_v60';

-- 3. No v61 object exists yet, and no import-origin roster request exists (the migration refuses otherwise).
select to_regprocedure('training.protect_activity_roster_request_v61()') is null as no_guard_v61,
       to_regprocedure('training_load.import_states_window()') is null as no_window_fn,
       not exists (select 1 from information_schema.columns where table_schema = 'training' and table_name = 'activity_roster_requests'
                    and column_name = 'origin_approval_id') as no_column,
       not exists (select 1 from training.activity_roster_requests where origin = 'import') as no_import_origin_request;

-- 4. A quiet moment: no roster command, undo or check in flight (ALTER TABLE takes a short lock on the requests).
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait,
       not exists (select 1 from training_load.gpexe_import_checks where status = 'running') as no_running_check;

-- 5. The role you run this as is, or is a member of, the owner of the altered table.
select pg_has_role(current_user, (select relowner from pg_class where oid = 'training.activity_roster_requests'::regclass), 'USAGE') as owns_requests;

-- 6. Facts to read: every existing request keeps origin 'roster' and gets origin_approval_id NULL (no rewrite).
select (select count(*) from training.activity_roster_requests) as roster_requests,
       (select count(*) from training_load.gpexe_import_approvals) as approvals;
