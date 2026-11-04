-- Read-only PREFLIGHT for migration v55 (migrations_v2/202611041300_training_load_v55_team_dashboards_club_variables.sql); run before the deploy that applies it. Changes nothing.
-- Every block returns rows with ok = true.

-- 1. v54 is the last applied migration and v55 is not recorded.
select (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%')
         = 'migrations_v2/202611041100_training_load_v54_rights_locks_users_first.sql' as ok,
       not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611041300_training_load_v55_team_dashboards_club_variables.sql') as v55_absent;

-- 2. The body in force is the one v55 replaces (v16's).
select md5(p.prosrc) = 'f44c88a4bc05d6241cbb70a06e575475' as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load' and p.proname = 'dashboard_widget_series_validate_metric_visibility';

-- 3. A quiet moment: no idle-in-transaction session and no lock wait in this database.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;

-- 4. The role you run this as is, or is a member of, the owner of the function (run it as the migrator's role).
select pg_has_role(current_user, p.proowner, 'USAGE') as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load' and p.proname = 'dashboard_widget_series_validate_metric_visibility';
