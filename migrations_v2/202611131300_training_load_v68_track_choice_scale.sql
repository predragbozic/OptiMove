-- Training Load v68 - the scale on a track choice (MT-D, scaling a short recording; part 1 of 2).
--
-- Plan: docs/ai/mt-multiple-tracks-plan.md sections 10 and 13, decided by the Rukovodilac on 2026-11-13. Runbook:
-- docs/runbooks/scale-recording-v68-v69.md. Part 2, v69, lets an estimate be a scaled one (the method and its basis).
--
-- What this migration changes (no existing row changes; nothing is written to a table): training_load.gpexe_track_choices
--   - scale_target_minutes: null, or 0 < x <= 600;
--   - a scale only on a 'track' choice;
--   - the fingerprint also takes ONE track (a short recording usually has one); a one-track row is either a 'track' choice
--     with a scale, or the 'cleared' row that removes it. v67's guard (validate_gpexe_track_choice) is unchanged: the chosen
--     track must be in the fingerprint, and the chain rules hold for one track as for several.
--
-- Order: after v67. Refuses to run without v67's table and its fingerprint CHECK, or once the column exists.
-- Rollback: docs/runbooks/scale-recording-v68-rollback.sql (refuses once a one-track or scaled choice exists, or a later
-- migration is recorded).

do $$
begin
  if to_regclass('training_load.gpexe_track_choices') is null then
    raise exception 'v68 refused: v67 (the track choices) is not applied' using errcode = '23514';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'training_load.gpexe_track_choices'::regclass
                  and conname = 'gpexe_track_choices_track_set_fingerprint_check') then
    raise exception 'v68 refused: the fingerprint CHECK of gpexe_track_choices is not v67''s' using errcode = '23514';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_track_choices'
              and column_name = 'scale_target_minutes') then
    raise exception 'v68 refused: gpexe_track_choices.scale_target_minutes already exists' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The scale on a track choice
-- ---------------------------------------------------------------------------
alter table training_load.gpexe_track_choices add column scale_target_minutes numeric
  constraint gpexe_track_choices_scale_range check (scale_target_minutes is null or (scale_target_minutes > 0 and scale_target_minutes <= 600));
alter table training_load.gpexe_track_choices add constraint gpexe_track_choices_scale_on_track
  check (scale_target_minutes is null or choice = 'track');
alter table training_load.gpexe_track_choices drop constraint gpexe_track_choices_track_set_fingerprint_check;
alter table training_load.gpexe_track_choices add constraint gpexe_track_choices_track_set_fingerprint_check check (
  char_length(track_set_fingerprint) <= 4000
  and track_set_fingerprint ~ '^(0|[1-9][0-9]{0,11}):(0|[1-9][0-9]{0,11})(,(0|[1-9][0-9]{0,11}))*(;(0|[1-9][0-9]{0,11}):(0|[1-9][0-9]{0,11})(,(0|[1-9][0-9]{0,11}))*)*$'
);
-- One track: only a scale (a 'track' choice with scale_target_minutes) or the 'cleared' row that removes it.
alter table training_load.gpexe_track_choices add constraint gpexe_track_choices_one_track_scale check (
  position(';' in track_set_fingerprint) > 0
  or (choice = 'track' and scale_target_minutes is not null)
  or choice = 'cleared'
);
