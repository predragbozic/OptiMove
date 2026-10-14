-- Rollback of migration v36 (the request record of the canonical-variable
-- admin API, M3-0):
-- migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/metric-variables-m3-0.test.mjs: apply -> rollback
-- -> the v35 catalog again -> re-apply, and every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the
-- deployed commit no longer contains the v36 migration file (otherwise the
-- migrator applies v36 again at the next start) nor the M3-0 admin routes that
-- write this table; and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- v36 adds one table (its constraints and indexes), two functions and three
-- triggers; no column of an existing table and no data. It removes them and
-- the v36 record. It refuses, changing nothing, when
--   * v36 is not recorded on the database;
--   * any migrations_v2 migration newer than v36 is recorded;
--   * the table holds any row - a request record is the only proof of an
--     admin write's request key; once one exists the way forward is a new
--     migration, never this script;
--   * the v36 table, functions or triggers are not exactly the ones v36
--     created (one is missing, or a trigger is disabled).
-- The canonical variables the admin API created stay: they are ordinary
-- Metrics Core rows (the existing catalog API reads and writes them as before).
--
-- One transaction: everything or nothing. Waits are bounded: a stalled
-- transaction that holds the table makes this script fail after 5 s. Dropping
-- the table also removes its foreign keys' triggers on the four tables it
-- references (public.users, public.clubs, training_load.metric_definitions and
-- metric_definition_versions), which locks them briefly against every access
-- (expected PostgreSQL behaviour, not observed here); a request that reads
-- public.users (a sign-in, a session check) can wait behind that. Run it at a quiet moment. Block 8 of
-- docs/runbooks/metric-variable-requests-v36-preflight.sql is the closest check, but it leaves plain
-- reads out on purpose (they do not conflict with the migration's lock), while the drop also waits for
-- them; the 5 s lock_timeout keeps that wait short. Run it as
-- one script that stops at the first error (psql -v ON_ERROR_STOP=1 -f ...):
-- after a refusal the open transaction is aborted and nothing is changed.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql') then
    raise exception 'v36 rollback refused: v36 is not recorded on this database';
  end if;
  if to_regclass('training_load.metric_variable_requests') is null then
    raise exception 'v36 rollback refused: the v36 table is not present';
  end if;
end $$;

lock table training_load.metric_variable_requests in access exclusive mode;

do $$
declare
  v36 constant text := 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql';
  reasons text[] := '{}';
  newer text;
  missing text;
  disabled text;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name like 'migrations_v2/%' and migration_name > v36;
  if newer is not null then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if exists (select 1 from training_load.metric_variable_requests) then
    reasons := array_append(reasons, 'request records exist');
  end if;
  select string_agg(f.name, ', ' order by f.name) into missing
    from unnest(array['metric_variable_requests_insert_guard', 'metric_variable_requests_append_only']) as f(name)
   where not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'training_load' and p.proname = f.name);
  if missing is not null then
    reasons := array_append(reasons, 'the v36 functions are not all present');
  end if;
  select string_agg(t.name, ', ' order by t.name) into missing
    from unnest(array['metric_variable_requests_insert_guard', 'metric_variable_requests_no_update_delete',
                      'metric_variable_requests_no_truncate']) as t(name)
   where not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'training_load' and c.relname = 'metric_variable_requests'
                        and g.tgname = t.name and not g.tgisinternal);
  if missing is not null then
    reasons := array_append(reasons, 'the v36 triggers are not all present');
  end if;
  select string_agg(g.tgname, ', ' order by g.tgname) into disabled
    from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'training_load' and c.relname = 'metric_variable_requests' and not g.tgisinternal and g.tgenabled <> 'O';
  if disabled is not null then
    reasons := array_append(reasons, 'a v36 trigger is disabled');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v36 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

-- The table goes with its constraints, indexes and triggers.
drop table training_load.metric_variable_requests;
drop function training_load.metric_variable_requests_append_only();
drop function training_load.metric_variable_requests_insert_guard();

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610141000_training_load_v36_metric_variable_requests.sql';

commit;
