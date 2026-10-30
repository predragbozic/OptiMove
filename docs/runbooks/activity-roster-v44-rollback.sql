-- Rollback of migration v44 (a self-report activity has no roster):
-- migrations_v2/202610301000_training_load_v44_activity_roster_self_report.sql
--
-- Not a migration and never run automatically. Rehearsed on a disposable
-- database (backend/tests/activity-roster-self-report.test.mjs, the migration
-- test: apply on v42, roll back, apply again, a failed last statement leaves
-- nothing). Before it is run anywhere real:
--   * the application is back on a commit WITHOUT the v44 roster read (the
--     read calls training.activity_has_roster(); without the function every
--     roster request would fail);
--   * a fresh, restore-verified backup exists;
--   * the owner approved this database specifically.
-- It restores the v25 definition of training.activity_roster(uuid) and drops
-- training.activity_has_roster(uuid). No table, column, index or trigger was
-- created by v44 and no row was written by it, so nothing else changes and no
-- row is touched: a self-report activity simply lists its team's roster again,
-- exactly as before v44. It refuses, changing nothing, when any migrations_v2
-- migration newer than v44 is recorded (only a forward migration is allowed
-- then), when v44 is not recorded on this database, and when the migrator is
-- running (it holds the advisory lock 822026 of backend/src/migrate.js; this
-- script takes the same lock for its own transaction, without waiting).
--
-- The deployed commit must also be WITHOUT the v44 migration file: the
-- migrator applies every file it finds that is not recorded, so a commit that
-- still carries the file re-applies v44 at the next start. Reverting the
-- application alone is safe without this script: the pre-v44 read never calls
-- activity_has_roster(), and against a v44 database it simply reads an empty
-- roster for a self-report activity.
--
-- One transaction: everything or nothing. Run it as
--   psql -v ON_ERROR_STOP=1 -f docs/runbooks/activity-roster-v44-rollback.sql
-- so a refusal stops the script at once instead of erroring on through an
-- aborted transaction.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v44 rollback refused: the migrator is running';
  end if;
end $$;

do $$
declare
  newer text;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name > 'migrations_v2/202610301000_training_load_v44_activity_roster_self_report.sql'
     and migration_name like 'migrations_v2/%';
  if newer is not null then
    raise exception 'v44 rollback refused: later migrations are applied: %; only a forward migration is allowed', newer;
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name like '%202610301000_training_load_v44_activity_roster_self_report.sql') then
    raise exception 'v44 rollback refused: v44 is not recorded as applied on this database';
  end if;
end $$;

-- The v25 definition, verbatim
-- (migrations_v2/202609251000_training_load_v25_activity_roster_foundation.sql, section 2).
create or replace function training.activity_roster(p_activity_id uuid)
returns table (athlete_id uuid, member_from timestamptz, member_to timestamptz, left_at timestamptz) as $$
  with a as (
    select owner_team_id, started_at,
           (occurred_local_date::timestamp at time zone timezone_snapshot) as day_start,
           ((occurred_local_date + 1)::timestamp at time zone timezone_snapshot) as day_end
      from training.activities
     where id = p_activity_id and owner_scope = 'team'
  ),
  team_periods as (
    select p.athlete_id, p.valid_from, p.valid_to
      from a join public.athlete_membership_periods p
        on p.team_id = a.owner_team_id and p.membership_type = 'team'
  ),
  covering as (
    select tp.athlete_id, tp.valid_from, tp.valid_to
      from team_periods tp cross join a
     where case when a.started_at is not null
                then tp.valid_from <= a.started_at and a.started_at < coalesce(tp.valid_to, 'infinity')
                else tp.valid_from < a.day_end and coalesce(tp.valid_to, 'infinity') > a.day_start
           end
  )
  select c.athlete_id,
         min(c.valid_from),
         case when bool_or(c.valid_to is null) then null else max(c.valid_to) end,
         (select case when bool_or(tp.valid_to is null) then null else max(tp.valid_to) end
            from team_periods tp where tp.athlete_id = c.athlete_id)
    from covering c
   group by c.athlete_id;
$$ language sql stable;

drop function training.activity_has_roster(uuid);

delete from public.schema_migrations
 where migration_name like '%202610301000_training_load_v44_activity_roster_self_report.sql';

commit;
