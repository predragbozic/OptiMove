-- Rollback of migration v62 (a team's session time zone, mixed_timezones (b)): migrations_v2/202611111200_training_load_v62_team_session_timezone.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/team-session-timezone-v62.test.mjs:
-- apply -> rollback -> the v61 catalog exactly -> re-apply, and the refusal below). Before it is run anywhere real: a fresh
-- restore-verified backup exists; the deployed commit no longer contains the v62 migration file (otherwise the migrator
-- applies it again at the next start) and no longer reads the table; the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- It drops v62's two tables and four functions and removes the v62 record. It changes no other row. It refuses, changing
-- nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v62 is not recorded, or any later migrations_v2 migration is;
--   * any zone or history row exists (a team's zone, and who set it and why, would be lost; a session imported through
--     the team's zone keeps that zone on its event either way).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f team-session-timezone-v62-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v62 rollback refused: the migrator is running';
  end if;
end $$;

-- Nothing may be written between the checks below and the drops.
lock table training_load.gpexe_team_session_timezones, training_load.gpexe_team_session_timezone_history in access exclusive mode;

do $$
declare
  v62 constant text := 'migrations_v2/202611111200_training_load_v62_team_session_timezone.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v62) then
    raise exception 'v62 rollback refused: v62 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v62) then
    raise exception 'v62 rollback refused: later migrations are applied';
  end if;
  if exists (select 1 from training_load.gpexe_team_session_timezones) or exists (select 1 from training_load.gpexe_team_session_timezone_history) then
    raise exception 'v62 rollback refused: a team session time zone has been set';
  end if;
end $$;

drop table training_load.gpexe_team_session_timezone_history;
drop table training_load.gpexe_team_session_timezones;
drop function training_load.gpexe_team_session_timezone_history_append_only();
drop function training_load.refuse_gpexe_team_session_timezone_delete();
drop function training_load.record_gpexe_team_session_timezone();
drop function training_load.guard_gpexe_team_session_timezone();
delete from public.schema_migrations where migration_name = 'migrations_v2/202611111200_training_load_v62_team_session_timezone.sql';

-- Post-gate: every v62 object gone.
do $$
begin
  if to_regclass('training_load.gpexe_team_session_timezones') is not null
     or to_regclass('training_load.gpexe_team_session_timezone_history') is not null
     or to_regprocedure('training_load.guard_gpexe_team_session_timezone()') is not null then
    raise exception 'v62 rollback failed: a v62 object is still there';
  end if;
end $$;
commit;
