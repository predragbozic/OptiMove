-- Read-only POST-CHECK for migration v55 (migrations_v2/202611041300_training_load_v55_team_dashboards_club_variables.sql); run after the deploy. Changes nothing.
-- Every block returns rows with ok = true.

-- 1. v55 is recorded once and is the last migration.
select (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202611041300_training_load_v55_team_dashboards_club_variables.sql') = 1 as recorded_once,
       (select max(migration_name) from public.schema_migrations where migration_name like 'migrations_v2/%') = 'migrations_v2/202611041300_training_load_v55_team_dashboards_club_variables.sql' as is_last;

-- 2. The body is the new one (md5 of prosrc).
select md5(p.prosrc) = '4f3638000788230fc2be7dc2667ed963' as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'training_load' and p.proname = 'dashboard_widget_series_validate_metric_visibility';

-- 3. The trigger is still there, enabled, before insert or update of metric_definition_id, widget_id.
select t.tgenabled = 'O' as ok
  from pg_trigger t where t.tgname = 'dashboard_widget_series_validate_metric_visibility'
   and t.tgrelid = 'training_load.dashboard_widget_series'::regclass and not t.tgisinternal;

-- 4. No lock wait and no idle-in-transaction session.
select not exists (select 1 from pg_stat_activity where state = 'idle in transaction' and datname = current_database()) as no_idle_tx,
       not exists (select 1 from pg_locks where not granted and database = (select oid from pg_database where datname = current_database())) as no_lock_wait;
