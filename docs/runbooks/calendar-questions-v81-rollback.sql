-- Rollback of migration v81 (migrations_v2/202611191000_calendar_v81_athlete_questions.sql):
-- Ask athletes and the daily WELLNESS "Skip days off" (K2b-2a-1). Drops v81's
-- tables, columns, constraints, triggers and functions, restores the v51 body of
-- calendar.settings_changes_before_insert, the phase-4 body of
-- tests.materialize_test_assignments_for_occurrence and the v4 body of
-- training_load.materialize_external_assignments_for_occurrence (each checked
-- by md5 after),
-- restores the four CHECKs v81 widened, and deletes v81's migration record, so
-- the migrator applies v81 again on the next start.
--
-- Runs only on an explicit owner order, never automatically, and refuses
-- (nothing dropped) when:
--   - the migrator is running (its advisory lock is held);
--   - v81 is not recorded;
--   - a migration recorded after v81 has `calendar` or `tests` in its file name
--     (a later migration of another part, e.g. training_load, does not stop it:
--     plan 9 "a narrow rollback guard"), or any body v81 replaced no longer
--     has v81's md5 (a later migration touched it);
--   - any row depends on v81: a switch row, a question, a postponement, a skip
--     row, a schedule with skip_days_off, a type with default_questions, a
--     request or change of the new operations (the data would be lost).
-- The tables are locked ACCESS EXCLUSIVE before the row checks. Run it only
-- after the previous release serves again (the K2b-2a-1 server stopped).
-- Rehearsed on a disposable database by
-- backend/tests/central-calendar-k2b2-migration.test.mjs (apply -> rollback ->
-- the calendar / tests catalog identical -> re-apply; every refusal).

begin;
set local lock_timeout = '10s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v81 rollback refused: the migrator holds its lock (a migration is running)';
  end if;
end $$;

do $$
declare
  v_recorded integer;
begin
  select count(*) into v_recorded from public.schema_migrations where migration_name = 'migrations_v2/202611191000_calendar_v81_athlete_questions.sql';
  if v_recorded <> 1 then
    raise exception 'v81 rollback refused: v81 is not recorded (% rows)', v_recorded;
  end if;
end $$;

lock table calendar.events, calendar.event_types, calendar.event_targets, calendar.event_requests, calendar.event_changes,
           calendar.settings_requests, calendar.settings_changes, calendar.club_question_settings,
           calendar.event_questions, calendar.question_postponements, calendar.question_assignment_skips,
           tests.test_schedules, tests.test_assignments in access exclusive mode;

do $$
declare
  v_later integer;
  v_rows integer;
  v_md5 text;
begin
  -- Later by name OR applied after v81 (review round 1, db L3: the runner
  -- records applied_at, and a lower-numbered file can be applied later).
  select count(*) into v_later from public.schema_migrations m
   where m.migration_name like 'migrations_v2/%'
     and m.migration_name <> 'migrations_v2/202611191000_calendar_v81_athlete_questions.sql'
     and (m.migration_name > 'migrations_v2/202611191000_calendar_v81_athlete_questions.sql'
          or m.applied_at > (select v.applied_at from public.schema_migrations v
                              where v.migration_name = 'migrations_v2/202611191000_calendar_v81_athlete_questions.sql'))
     and (m.migration_name like '%calendar%' or m.migration_name like '%tests%');
  if v_later > 0 then
    raise exception 'v81 rollback refused: % later calendar / tests migration(s) recorded', v_later;
  end if;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'tests' and p.proname = 'materialize_test_assignments_for_occurrence';
  if v_md5 is distinct from 'ef7e1093ca427ba0bf2f2bab120ba14f' then
    raise exception 'v81 rollback refused: tests.materialize_test_assignments_for_occurrence is not v81''s body (md5 %)', v_md5;
  end if;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'training_load' and p.proname = 'materialize_external_assignments_for_occurrence';
  if v_md5 is distinct from 'a700c67786e79af8c03aae0b2d4a5fc3' then
    raise exception 'v81 rollback refused: training_load.materialize_external_assignments_for_occurrence is not v81''s body (md5 %)', v_md5;
  end if;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'calendar' and p.proname = 'settings_changes_before_insert';
  if v_md5 is distinct from 'b4189ddb507e607263ee6cb89760a891' then
    raise exception 'v81 rollback refused: calendar.settings_changes_before_insert is not v81''s body (md5 %)', v_md5;
  end if;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'calendar' and p.proname = 'lock_event_writer';
  if v_md5 is distinct from '7ebf1bcf39cbb930fb913d89f25fd406' then
    raise exception 'v81 rollback refused: calendar.lock_event_writer is not the body v81 was written against (md5 %)', v_md5;
  end if;
  select (select count(*) from calendar.club_question_settings) + (select count(*) from calendar.event_questions)
       + (select count(*) from calendar.question_postponements) + (select count(*) from calendar.question_assignment_skips)
       + (select count(*) from tests.test_schedules where skip_days_off)
       + (select count(*) from calendar.event_types where default_questions is not null)
       + (select count(*) from calendar.settings_requests where operation = 'questions_switch')
       + (select count(*) from calendar.settings_changes where kind = 'questions_switch' or subject_club_id is not null)
       + (select count(*) from calendar.event_requests where operation in ('ask_question', 'remove_question', 'move_question'))
       + (select count(*) from calendar.event_changes where kind in ('ask_question', 'remove_question', 'move_question'))
    into v_rows;
  if v_rows > 0 then
    raise exception 'v81 rollback refused: % row(s) depend on v81', v_rows;
  end if;
end $$;

-- The bodies v81 replaced, exactly as their own files wrote them.
create or replace function tests.materialize_test_assignments_for_occurrence(p_occurrence_id uuid)
returns integer language plpgsql as $$
declare
  v_occurrence tests.test_schedule_occurrences%rowtype;
  v_schedule tests.test_schedules%rowtype;
  v_inserted_count integer;
begin
  -- FOR UPDATE locks this occurrence row for the rest of the transaction -
  -- unchanged from Phase 1: a second concurrent call for the SAME
  -- occurrence blocks here until the first commits, then re-reads fresh
  -- state (including whether the snapshot was just taken by the call that
  -- won the race).
  select * into v_occurrence from tests.test_schedule_occurrences where id = p_occurrence_id for update;
  if v_occurrence.id is null then
    raise exception 'occurrence % does not exist', p_occurrence_id;
  end if;

  select * into v_schedule from tests.test_schedules where id = v_occurrence.schedule_id;
  -- v_schedule.id cannot be null here: test_schedule_occurrences.schedule_id
  -- is a NOT NULL FK to tests.test_schedules with no ON DELETE that could
  -- orphan it while the occurrence itself still exists.

  if v_occurrence.assignments_materialized_at is null then
    -- Freeze ONLY membership, exactly ONCE, using the same target
    -- resolution the rest of this migration shares (tests.resolve_
    -- schedule_target_athletes). A team/club member added AFTER this point
    -- must never appear here later - this INSERT never runs again for this
    -- occurrence. Effective_timezone is deliberately NOT frozen here
    -- anymore (round 2 correction) - see this file's header for why: it is
    -- read fresh, per athlete, below, at the moment their row actually gets
    -- inserted, not at snapshot time.
    insert into tests.test_occurrence_target_snapshot (occurrence_id, athlete_id)
    select p_occurrence_id, ta.athlete_id
    from tests.resolve_schedule_target_athletes(v_schedule.id) ta
    on conflict (occurrence_id, athlete_id) do nothing;

    update tests.test_schedule_occurrences set assignments_materialized_at = now() where id = p_occurrence_id;
  end if;

  -- Every call (first or repeated) inserts real assignment rows for
  -- whichever snapshotted athletes are ELIGIBLE right now, reading each
  -- one's CURRENT device_timezone fresh (round 2 correction - never the
  -- stale value from whenever the membership snapshot happened to be
  -- taken): eligible means (now() at time zone their CURRENT effective_
  -- timezone)::date equals this occurrence's own scheduled_date - the SAME
  -- condition for one_time and daily/recurring alike (round 2 correction:
  -- the old one_time bypass let every snapshotted athlete's row insert
  -- unconditionally, which contradicted "a one-time date is never
  -- reinterpreted per timezone" - a one_time occurrence has exactly one
  -- real scheduled_date, and an athlete is only ever inserted once their
  -- own real local date actually reaches it). This is what lets an athlete
  -- significantly ahead of (or behind) the schedule's own reference
  -- timezone still get assigned, on a LATER cycle, once their own day
  -- actually reaches this occurrence's date - without ever re-resolving
  -- membership. Each athlete's own row is still only ever inserted once
  -- (on conflict do nothing) - once inserted, its window is immutable (see
  -- the trigger below), so a device-timezone change afterward can only ever
  -- affect a DIFFERENT, not-yet-inserted assignment.
  insert into tests.test_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, due_at, closes_at)
  select
    p_occurrence_id,
    e.athlete_id,
    e.effective_timezone,
    v_occurrence.scheduled_date,
    (v_occurrence.scheduled_date + v_schedule.opens_time) at time zone e.effective_timezone,
    case when v_schedule.due_time is null then null else (v_occurrence.scheduled_date + v_schedule.due_time) at time zone e.effective_timezone end,
    (v_occurrence.scheduled_date + v_schedule.closes_time) at time zone e.effective_timezone
  from (
    select s.athlete_id, coalesce(a.device_timezone, v_schedule.timezone) as effective_timezone
    from tests.test_occurrence_target_snapshot s
    join public.athletes a on a.id = s.athlete_id
    where s.occurrence_id = p_occurrence_id
  ) e
  where (now() at time zone e.effective_timezone)::date = v_occurrence.scheduled_date
  on conflict (occurrence_id, athlete_id) do nothing;

  get diagnostics v_inserted_count = row_count;

  return v_inserted_count;
end $$;

create or replace function calendar.settings_changes_before_insert() returns trigger language plpgsql as $$
declare
  v_request record;
  v_club uuid;
  v_revision integer;
begin
  select r.operation, r.performed_by_user_id, r.club_id into v_request from calendar.settings_requests r where r.id = new.request_id;
  if not found then
    raise exception 'calendar.settings_changes: request_id names no request' using errcode = '23514';
  end if;
  if v_request.operation <> new.kind or v_request.performed_by_user_id <> new.performed_by_user_id then
    raise exception 'calendar.settings_changes: the change does not match its request' using errcode = '23514';
  end if;
  if new.subject_kind = 'type' then
    select t.owner_club_id, t.revision into v_club, v_revision from calendar.event_types t where t.id = new.event_type_id and t.owner_scope = 'club';
  elsif new.subject_kind = 'field' then
    select f.owner_club_id, f.revision into v_club, v_revision from calendar.event_fields f where f.id = new.field_id and f.owner_scope = 'club';
  elsif new.subject_kind = 'location' then
    select l.owner_club_id, l.revision into v_club, v_revision from calendar.locations l where l.id = new.location_id;
  else
    select t.club_id, s.revision into v_club, v_revision
      from public.teams t join calendar.team_settings s on s.team_id = t.id where t.id = new.team_id;
  end if;
  if v_club is null or v_club <> v_request.club_id then
    raise exception 'calendar.settings_changes: the subject belongs to the request''s club only' using errcode = '23514';
  end if;
  if v_revision is distinct from new.revision then
    raise exception 'calendar.settings_changes: revision must be the subject''s current revision' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function training_load.materialize_external_assignments_for_occurrence(p_occurrence_id uuid)
returns integer language plpgsql as $$
declare
  v_occurrence training_load.external_schedule_occurrences%rowtype;
  v_schedule training_load.external_schedules%rowtype;
  v_inserted_count integer;
begin
  select * into v_occurrence from training_load.external_schedule_occurrences where id = p_occurrence_id for update;
  if v_occurrence.id is null then raise exception 'occurrence % does not exist', p_occurrence_id; end if;
  select * into v_schedule from training_load.external_schedules where id = v_occurrence.schedule_id;

  if v_occurrence.assignments_materialized_at is null then
    insert into training_load.external_occurrence_target_snapshot (occurrence_id, athlete_id)
    select p_occurrence_id, ta.athlete_id
    from training_load.resolve_external_schedule_target_athletes(v_schedule.id) ta
    on conflict (occurrence_id, athlete_id) do nothing;
    update training_load.external_schedule_occurrences set assignments_materialized_at = now() where id = p_occurrence_id;
  end if;

  insert into training_load.external_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, due_at, closes_at)
  select p_occurrence_id, e.athlete_id, e.effective_timezone, v_occurrence.scheduled_date,
         (v_occurrence.scheduled_date + v_schedule.opens_time) at time zone e.effective_timezone,
         case when v_schedule.due_time is null then null else (v_occurrence.scheduled_date + v_schedule.due_time) at time zone e.effective_timezone end,
         (v_occurrence.scheduled_date + v_schedule.closes_time) at time zone e.effective_timezone
  from (
    select s.athlete_id, coalesce(a.device_timezone, v_schedule.timezone) as effective_timezone
    from training_load.external_occurrence_target_snapshot s
    join public.athletes a on a.id = s.athlete_id
    where s.occurrence_id = p_occurrence_id
  ) e
  where (now() at time zone e.effective_timezone)::date = v_occurrence.scheduled_date
  on conflict (occurrence_id, athlete_id) do nothing;

  get diagnostics v_inserted_count = row_count;
  return v_inserted_count;
end $$;


drop trigger events_rpe_question_link on calendar.events;
drop function calendar.events_rpe_question_link();
drop table calendar.question_assignment_skips;
drop table calendar.question_postponements;
drop table calendar.event_questions;
drop table calendar.club_question_settings;
drop function calendar.question_assignment_skips_guard();
drop function calendar.question_postponements_guard();
drop function calendar.question_open_for(uuid, uuid);
drop function calendar.event_questions_need_parent();
drop function calendar.event_questions_guard();
drop function calendar.club_question_settings_need_change();
drop function calendar.club_question_settings_guard();
drop function calendar.questions_enabled(uuid);

alter table tests.test_schedules drop constraint test_schedules_skip_days_off_daily;
alter table tests.test_schedules drop column skip_days_off;
alter table calendar.event_types drop column default_questions;

drop index calendar.settings_changes_club_revision_key;
alter table calendar.settings_changes drop constraint settings_changes_subject_shape;
alter table calendar.settings_changes add constraint settings_changes_subject_shape check (
    (subject_kind = 'type'     and event_type_id is not null and field_id is null and location_id is null and team_id is null) or
    (subject_kind = 'field'    and field_id is not null and event_type_id is null and location_id is null and team_id is null) or
    (subject_kind = 'location' and location_id is not null and event_type_id is null and field_id is null and team_id is null) or
    (subject_kind = 'team'     and team_id is not null and event_type_id is null and field_id is null and location_id is null));
alter table calendar.settings_changes drop column subject_club_id;
alter table calendar.settings_changes drop constraint settings_changes_subject_kind_check;
alter table calendar.settings_changes add constraint settings_changes_subject_kind_check check (subject_kind in ('type', 'field', 'location', 'team'));
alter table calendar.settings_changes drop constraint settings_changes_kind_check;
alter table calendar.settings_changes add constraint settings_changes_kind_check check (kind in (
                          'type_create', 'type_update', 'type_archive', 'type_restore', 'type_order',
                          'field_create', 'field_update', 'field_archive', 'field_restore',
                          'location_create', 'location_update', 'location_archive', 'location_restore',
                          'team_update'));
alter table calendar.settings_requests drop constraint settings_requests_operation_check;
alter table calendar.settings_requests add constraint settings_requests_operation_check check (operation in (
                          'type_create', 'type_update', 'type_archive', 'type_restore', 'type_order',
                          'field_create', 'field_update', 'field_archive', 'field_restore',
                          'location_create', 'location_update', 'location_archive', 'location_restore',
                          'team_update'));
alter table calendar.event_requests drop constraint event_requests_operation_check;
alter table calendar.event_requests add constraint event_requests_operation_check check (operation in (
  'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions',
  'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule', 'set_fields', 'align_sessions'));
alter table calendar.event_changes drop constraint event_changes_kind_check;
alter table calendar.event_changes add constraint event_changes_kind_check check (kind in (
  'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions',
  'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule', 'set_fields', 'align_sessions'));

drop function calendar.event_audience_on_day(uuid, date);
drop function calendar.athlete_reached_on_day(uuid, uuid, date);
drop function calendar.athlete_member_of_owner_on_day(varchar, uuid, uuid, uuid, date);
drop function calendar.wellness_day_key(uuid, date);
drop function calendar.is_wellness_version(uuid);
drop function calendar.event_club_id(uuid);
drop function calendar.owner_club_id(varchar, uuid, uuid);
drop function calendar.questions_ok(text[]);

do $$
declare
  v_md5 text;
begin
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'tests' and p.proname = 'materialize_test_assignments_for_occurrence';
  if v_md5 is distinct from '2d961f5acd6c6309baa51de868773ba4' then
    raise exception 'v81 rollback: the phase-4 body was not restored (md5 %)', v_md5;
  end if;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'calendar' and p.proname = 'settings_changes_before_insert';
  if v_md5 is distinct from '75ed99731f6d61d19a8f0c2e473fedd1' then
    raise exception 'v81 rollback: the v51 body was not restored (md5 %)', v_md5;
  end if;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'training_load' and p.proname = 'materialize_external_assignments_for_occurrence';
  if v_md5 is distinct from '8410bf7298d6b3d5e4aea6dfb94e1a18' then
    raise exception 'v81 rollback: the training_load v4 body was not restored (md5 %)', v_md5;
  end if;
end $$;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611191000_calendar_v81_athlete_questions.sql';

commit;
