-- Read-only PREFLIGHT for migration v54 (migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql); run before the deploy that
-- applies it (the Rukovodilac, Supabase SQL Editor). Changes nothing. Every
-- block returns one row with ok = true.

-- 1. v53 is the last applied migration and v54 is not recorded.
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%')
         = 'migrations_v2/202611041000_training_load_v53_system_variables_club.sql' as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql') as v54_absent;

-- 2. The seven bodies in force are the ones v54 replaces (md5 of prosrc).
select schema, name, expected_md5, actual_md5, actual_md5 = expected_md5 as ok
  from (select e.schema, e.name, e.md5 as expected_md5,
               (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = e.schema and p.proname = e.name) as actual_md5
          from (values
            ('training_load', 'lock_gpexe_import_approver', 'be924aae7de75db74b6cbff0658e2835'),
            ('training', 'lock_activity_decider', 'e8b36405f0e2fe3d66a5973fdfc1c0d0'),
            ('calendar', 'lock_event_writer', 'ad2250f6f9f04cecde96bed29a211a79'),
            ('training_load', 'source_metric_require_platform_admin', 'fa0e002b3f1961f1e06b54c8f0b10bd3'),
            ('training_load', 'source_metric_require_club_admin', '97e576a08323d5b2d6e11d9cdedf05cc'),
            ('training_load', 'source_metric_actor_basis', 'bff4852216ffda968b33b730cd05da47'),
            ('training_load', 'metric_variable_change_basis', '4ff0503a658dde888966e27065c430de')) as e(schema, name, md5)) x
 order by schema, name;

-- 3. A quiet moment: no idle-in-transaction session and no lock wait on the rights tables.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted) as no_lock_wait;

-- 4. The role the migrator uses owns the seven functions (CREATE OR REPLACE needs it).
select n.nspname as schema, p.proname as name, pg_get_userbyid(p.proowner) = current_user as owned_by_current_user
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where (n.nspname, p.proname) in (
   ('training_load', 'lock_gpexe_import_approver'),
   ('training', 'lock_activity_decider'),
   ('calendar', 'lock_event_writer'),
   ('training_load', 'source_metric_require_platform_admin'),
   ('training_load', 'source_metric_require_club_admin'),
   ('training_load', 'source_metric_actor_basis'),
   ('training_load', 'metric_variable_change_basis'))
 order by 1, 2;
