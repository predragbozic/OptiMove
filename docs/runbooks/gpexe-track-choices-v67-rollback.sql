-- Rollback of migration v67 (the track choice of an athlete GPEXE recorded on more than one track, MT-A):
-- migrations_v2/202611131200_training_load_v67_gpexe_track_choices.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/gpexe-track-choices-v67.test.mjs:
-- apply -> rollback -> the catalog before v67 exactly -> re-apply, and the refusals below). Before it is run anywhere real: a fresh
-- restore-verified backup exists; the deployed commit no longer contains the v67 migration file (otherwise the migrator applies
-- it again at the next start) and contains neither MT-A's track-choice routes nor MT-B's reads of the choices (from MT-B on, every
-- check, preview recompute and approval reads training_load.gpexe_track_choices, and fails without it); the owner approved this
-- database specifically
-- (.claude/rules/database-safety.md).
--
-- It drops the table, its guard, the acting-user function, and the v67 record. It changes no other row. It refuses, changing
-- nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v67 is not recorded, or any later migrations_v2 migration is;
--   * any choice row exists (a choice would be lost).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f gpexe-track-choices-v67-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v67 rollback refused: the migrator is running';
  end if;
end $$;

-- Nothing may be written between the check below and the drop.
lock table training_load.gpexe_track_choices in access exclusive mode;

do $$
declare
  v67 constant text := 'migrations_v2/202611131200_training_load_v67_gpexe_track_choices.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v67) then
    raise exception 'v67 rollback refused: v67 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v67) then
    raise exception 'v67 rollback refused: later migrations are applied';
  end if;
  if exists (select 1 from training_load.gpexe_track_choices) then
    raise exception 'v67 rollback refused: a track choice exists';
  end if;
end $$;

drop table training_load.gpexe_track_choices;
drop function training_load.validate_gpexe_track_choice();
drop function training_load.track_choice_context_actor();
delete from public.schema_migrations where migration_name = 'migrations_v2/202611131200_training_load_v67_gpexe_track_choices.sql';

commit;
