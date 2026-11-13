-- Rollback of migration v68 (the scale on a track choice, MT-D part 1):
-- migrations_v2/202611131300_training_load_v68_track_choice_scale.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases (backend/tests/scale-recording-mt-d.test.mjs:
-- v69 then v68 rolled back -> the catalog before v68 exactly -> both re-applied, and the refusals below). Before it is run
-- anywhere real: a fresh restore-verified backup exists; the deployed commit contains neither v68's file (otherwise the migrator
-- applies it again at the next start) nor MT-D's code (the preview reads scale_target_minutes on every check, recompute and
-- approval, and fails without it); the owner approved this database specifically (.claude/rules/database-safety.md).
--
-- It restores v67's fingerprint CHECK, drops the scale column and its CHECKs, and removes the v68 record. It refuses, changing
-- nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v68 is not recorded, or any later migrations_v2 migration is (roll v69 back first);
--   * a choice row with a scale or with one track exists.
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f scale-recording-v68-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v68 rollback refused: the migrator is running';
  end if;
end $$;

lock table training_load.gpexe_track_choices in access exclusive mode;

do $$
declare
  v68 constant text := 'migrations_v2/202611131300_training_load_v68_track_choice_scale.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v68) then
    raise exception 'v68 rollback refused: v68 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v68) then
    raise exception 'v68 rollback refused: later migrations are applied';
  end if;
  if exists (select 1 from training_load.gpexe_track_choices where scale_target_minutes is not null or position(';' in track_set_fingerprint) = 0) then
    raise exception 'v68 rollback refused: a scaled or one-track choice exists';
  end if;
end $$;

alter table training_load.gpexe_track_choices drop constraint gpexe_track_choices_one_track_scale;
alter table training_load.gpexe_track_choices drop constraint gpexe_track_choices_track_set_fingerprint_check;
alter table training_load.gpexe_track_choices add constraint gpexe_track_choices_track_set_fingerprint_check check (
  char_length(track_set_fingerprint) <= 4000
  and track_set_fingerprint ~ '^(0|[1-9][0-9]{0,11}):(0|[1-9][0-9]{0,11})(,(0|[1-9][0-9]{0,11}))*(;(0|[1-9][0-9]{0,11}):(0|[1-9][0-9]{0,11})(,(0|[1-9][0-9]{0,11}))*)+$'
);
alter table training_load.gpexe_track_choices drop constraint gpexe_track_choices_scale_on_track;
alter table training_load.gpexe_track_choices drop column scale_target_minutes;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611131300_training_load_v68_track_choice_scale.sql';

commit;
