-- Read-only POST-CHECK for migration v61 (migrations_v2/202611101200_training_load_v61_import_states_approval.sql); run after the
-- deploy. Changes nothing. Every block returns rows with ok = true (or the stated counts).

-- 1. v61 is recorded once and is the last migration.
select count(*) = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611101200_training_load_v61_import_states_approval.sql' as is_last
  from public.schema_migrations where migration_name = 'migrations_v2/202611101200_training_load_v61_import_states_approval.sql';

-- 2. The v61 bodies are in force (md5 of prosrc); v60's guard stays in place for the rollback.
select n.nspname || '.' || p.proname as fn, md5(p.prosrc) as actual_md5, md5(p.prosrc) = e.m as ok
  from (values ('training', 'protect_activity_roster_request_v61', 'a6dbe02dc1adf558b4d4c8794878bd6d'),
               ('training_load', 'import_states_window', '66c9abcdc147d7e2adbccd413377f21c'),
               ('training', 'protect_activity_roster_request_v60', 'b80d37661ee1b9dc021b6d08b8e74993')) e(s, f, m)
  join pg_namespace n on n.nspname = e.s join pg_proc p on p.pronamespace = n.oid and p.proname = e.f
 order by 1;

-- 3. The window is 30 minutes.
select training_load.import_states_window() = interval '30 minutes' as ok;

-- 4. The request trigger runs v61's guard and is enabled.
select count(*) = 1 as ok
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid
 where t.tgname = 'activity_roster_requests_protect' and not t.tgisinternal and t.tgenabled = 'O'
   and p.proname = 'protect_activity_roster_request_v61';

-- 5. The column (nullable uuid, a foreign key to the approvals) and its CHECK.
select (select is_nullable = 'YES' and data_type = 'uuid' from information_schema.columns
         where table_schema = 'training' and table_name = 'activity_roster_requests' and column_name = 'origin_approval_id') as column_ok,
       exists (select 1 from pg_constraint where conname = 'activity_roster_requests_origin_approval_check'
                and conrelid = 'training.activity_roster_requests'::regclass) as check_ok,
       exists (select 1 from pg_constraint where contype = 'f' and conrelid = 'training.activity_roster_requests'::regclass
                and confrelid = 'training_load.gpexe_import_approvals'::regclass) as fk_ok;

-- 6. The deploy wrote nothing new: no import-origin request yet.
select count(*) filter (where origin = 'import') as import_origin_requests,
       count(*) filter (where origin_approval_id is not null) as with_approval
  from training.activity_roster_requests;

-- 7. Nothing is stuck.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;
