-- Training load v6: optional event type on an external (outside-plan) RPE
-- schedule - a label only (Team training/Individual/Gym/Rehabilitation/
-- Match/Other), never referenced by any scheduling/timezone/occurrence
-- logic. Nullable - "no type chosen" is a normal, valid state.
alter table training_load.external_schedules
  add column if not exists event_type varchar(30);

alter table training_load.external_schedules
  drop constraint if exists external_schedules_event_type_check;

alter table training_load.external_schedules
  add constraint external_schedules_event_type_check
  check (event_type is null or event_type in ('team_training', 'individual', 'gym', 'rehabilitation', 'match', 'other'));
