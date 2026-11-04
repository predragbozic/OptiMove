-- Read-only POST-CHECK for migration v54 (migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql); run after the deploy.
-- Changes nothing. Every block returns rows with ok = true.

-- 1. v54 is recorded once and is the last migration.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql') = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql' as is_last;

-- 2. The seven bodies are the new ones (md5 of prosrc).
select schema, name, expected_md5, actual_md5, actual_md5 = expected_md5 as ok
  from (select e.schema, e.name, e.md5 as expected_md5,
               (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = e.schema and p.proname = e.name) as actual_md5
          from (values
            ('training_load', 'lock_gpexe_import_approver', '9c3bf3edeb1dcca9c5516b77c30e86ee'),
            ('training', 'lock_activity_decider', '145ac6b8723af9afddb4c95f450a1ff2'),
            ('calendar', 'lock_event_writer', '7ebf1bcf39cbb930fb913d89f25fd406'),
            ('training_load', 'source_metric_require_platform_admin', '3dd0005215d31e7fc6f7047aad8ceb2f'),
            ('training_load', 'source_metric_require_club_admin', 'da1fb4ba28b807b7ac92e4a86a463af5'),
            ('training_load', 'source_metric_actor_basis', '28e53decb03f9fef28c2759bedac93f0'),
            ('training_load', 'metric_variable_change_basis', '24c47f23f90bb9c9301397c3aa90db10')) as e(schema, name, md5)) x
 order by schema, name;

-- 3. In each body the users row is locked before any role row.
select schema, name,
       position('from public.users u where u.id = p_' in src) > 0
         and position('from public.users u where u.id = p_' in src) < position('public.user_' in src) as users_first
  from (select n.nspname as schema, p.proname as name, p.prosrc as src
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where (n.nspname, p.proname) in (
           ('training_load', 'lock_gpexe_import_approver'),
           ('training', 'lock_activity_decider'),
           ('calendar', 'lock_event_writer'),
           ('training_load', 'source_metric_require_platform_admin'),
           ('training_load', 'source_metric_require_club_admin'),
           ('training_load', 'source_metric_actor_basis'),
           ('training_load', 'metric_variable_change_basis'))) x
 order by 1, 2;

-- 4. No lock wait and no idle-in-transaction session.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted) as no_lock_wait;
