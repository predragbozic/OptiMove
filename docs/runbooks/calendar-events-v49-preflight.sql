-- v49 production preflight - READ ONLY. For the owner to run in the Supabase
-- SQL Editor, as the application's DATABASE_URL role (the one the migrator
-- uses), on the day of the merge and deploy of the K2a-1a pull request
-- (migrations_v2/202610311000_calendar_v49_events.sql; plan
-- docs/ai/central-calendar-k2a-plan.md, section 10).
--
-- Run ONE numbered block at a time (select it, then Run): the editor shows only
-- the result of the last statement it ran. Every block is a plain SELECT, so
-- nothing is written and no transaction is left open. The expected values are
-- in the comments; any other value means: stop, change nothing, report the
-- block, the column and the value.

-- 1. PostgreSQL 15 or later (v49 uses UNIQUE NULLS NOT DISTINCT).
--    Expected: pg15_or_later = true (the deployed server reported 170006).
select current_setting('server_version_num')::int as server_version_num,
       current_setting('server_version_num')::int >= 150000 as pg15_or_later;

-- 2. The migration state: v48 recorded once with the repository's checksum,
--    v49 absent, nothing recorded at or after its name.
--    Expected: v48_rows = 1, v48_checksum_ok = true, v49_rows = 0,
--    at_or_after_v49 = 0, last_migration =
--    migrations_v2/202610301900_training_load_v48_mapping_activations.sql
--    (or a later migration of another part whose name sorts before v49's).
select
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql') as v48_rows,
  (select checksum from public.schema_migrations where migration_name = 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql') as v48_checksum,
  (select count(*) from public.schema_migrations where migration_name = 'migrations_v2/202610311000_calendar_v49_events.sql') as v49_rows,
  (select count(*) from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name >= 'migrations_v2/202610311000_calendar_v49_events.sql') as at_or_after_v49,
  (select migration_name from public.schema_migrations order by migration_name desc limit 1) as last_migration;
-- v48_checksum is compared by the executor with the repository's sha256 of
-- migrations_v2/202610301900_training_load_v48_mapping_activations.sql
-- (the pull request names both files' sha256).

-- 3. No calendar schema yet.
--    Expected: schema_rows = 0.
select count(*) as schema_rows from information_schema.schemata where schema_name = 'calendar';

-- 4. What v49 references exists.
--    Expected: every column true.
select to_regclass('training_load.external_schedules') is not null as external_schedules,
       to_regprocedure('training_load.source_metric_text_ok(text, integer)') is not null as text_rule,
       to_regclass('public.athlete_membership_periods') is not null as membership_periods,
       to_regclass('tests.test_schedules') is not null as test_schedules,
       to_regclass('training.activities') is not null as activities,
       to_regclass('plans.plans') is not null as plans,
       to_regclass('plans.plan_days') is not null as plan_days,
       to_regclass('plans.plan_sessions') is not null as plan_sessions,
       to_regclass('public.user_athletes') is not null as user_athletes,
       to_regclass('public.user_global_roles') is not null as global_roles;

-- 5. The migrator's role may create a schema in this database.
--    Expected: may_create_schema = true.
select has_database_privilege(current_user, current_database(), 'CREATE') as may_create_schema, current_user as role_name;

-- 6. The seed's size: active clubs (seven types each) - record the number for
--    the post-check.
select count(*) as active_clubs from public.clubs where coalesce(is_active, true);

-- 7. A quiet moment: no other migration running, no transaction holding a
--    strong lock on a table v49 references (its foreign keys take SHARE ROW
--    EXCLUSIVE on them), no idle transaction. An ordinary row write's
--    RowExclusiveLock does not count.
--    Expected: every count 0.
select
  (select count(*) from pg_stat_activity where state = 'idle in transaction' and pid <> pg_backend_pid()) as idle_in_transaction,
  (select count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_namespace n on n.oid = c.relnamespace
    where ((n.nspname = 'public' and c.relname in ('users', 'clubs', 'teams', 'athletes'))
        or (n.nspname = 'plans' and c.relname = 'plans')
        or (n.nspname = 'training' and c.relname = 'activities')
        or (n.nspname = 'training_load' and c.relname = 'external_schedules'))
      and l.pid <> pg_backend_pid()
      and l.mode in ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')) as strong_locks,
  (select count(*) from pg_stat_activity where query ilike '%schema_migrations%' and pid <> pg_backend_pid() and state <> 'idle') as other_migrators,
  (select count(*) from pg_locks where locktype = 'advisory' and objid = 822026) as migrator_lock_held;
