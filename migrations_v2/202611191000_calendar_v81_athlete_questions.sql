-- Central calendar v81 (K2b-2a-1): Ask athletes on an event (D40) and the
-- daily WELLNESS "Skip days off". Plan: docs/ai/central-calendar-k2b2-plan.md,
-- sections 2-9 and the technical contract 9.1 with the manager's GO 9.1.13;
-- runbook docs/runbooks/calendar-questions-v81.md; rollback
-- docs/runbooks/calendar-questions-v81-rollback.sql.
--
-- Depends on (never on its own position in the list): calendar v49 and v51,
-- Tests v42 phase 1 / lock fix / phase 4 (it REQUIRES the Tests schema),
-- Training Load v4 / v5 (external schedules, session_feedback), and the v54
-- body of calendar.lock_event_writer.
--
-- New:
--   calendar.club_question_settings   the club's switch (no row = off)
--   calendar.event_questions          an event's RPE / WELLNESS question,
--                                     through the existing module schedules
--   calendar.question_postponements   the athlete's *Later*
--   calendar.question_assignment_skips  a WELLNESS assignment made as
--                                     'cancelled' because a Day off or an
--                                     event's own WELLNESS covers the day
--   calendar.event_types.default_questions   (null = derived from
--                                     default_expects; no seed rewrite)
--   tests.test_schedules.skip_days_off
-- Changed (md5 preconditions below):
--   calendar.settings_changes_before_insert()   + the club switch subject
--   tests.materialize_test_assignments_for_occurrence()  + the day's skips
--   event_requests / event_changes / settings_requests / settings_changes
--   CHECKs gain the new operations.
-- No row of any table is written by this file.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Preconditions: the bodies this file replaces are the ones it was
--    written against (the OptiMove manager reads the same md5 on production).
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
  v_missing text;
begin
  -- The migrations v81 depends on, recorded by name and the repository's
  -- checksum (review round 1, db L1); never v81's position in the list.
  select string_agg(d.name, ', ' order by d.name) into v_missing
    from (values
      ('migrations_v2/202608240900_tests_v42_phase1_scheduling_execution.sql', '1f244c812e54a0cdfb4a6dbb79403044e10a604ec41beaaad86e152edb49ab48'),
      ('migrations_v2/202608260900_tests_v42_occurrence_generation_lock_fix.sql', 'cb360a58bb00ea3a8e2f0f989e7b97bc77d00d8855dcc9268c1eea26ab93b46d'),
      ('migrations_v2/202608300900_tests_v42_phase4_assignment_timezone_window.sql', 'b5902d3d27b9aed3d9b418afb6cfc45a2a4dc3b16288cc744c3e24ea227da39f'),
      ('migrations_v2/202609011000_training_load_v4_external_scheduling.sql', '14af0f717ed069f2170275e6c91a70a2c8cf3638ad5f1c93520f7c9d26499392'),
      ('migrations_v2/202609011100_training_load_v5_unified_result_source.sql', '367d5c6b3e2d2eedb02ffc760e392e2410770beff1f2a35afa2a733a812e8270'),
      ('migrations_v2/202609020900_training_load_v7_external_schedule_notification_rules.sql', '829022d6cb180838689bc42df98c5dcca5175d5105f8cbd42795c7ecdf5c44b8'),
      ('migrations_v2/202610311000_calendar_v49_events.sql', 'ed1afda69b8ee364a53816965c8561699133637f66fdbd7a37c7dceb683d6539'),
      ('migrations_v2/202611011900_calendar_v51_settings.sql', 'b727cb0f74bb8bc41ee816c33995f1ab3df721ebac7bf77b861fd9e9b9f38cff')
    ) as d(name, checksum)
   where not exists (select 1 from public.schema_migrations m where m.migration_name = d.name and m.checksum = d.checksum);
  if v_missing is not null then
    raise exception 'calendar v81: a dependency is not recorded with its checksum: %', v_missing;
  end if;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'tests' and p.proname = 'materialize_test_assignments_for_occurrence';
  if v_md5 is distinct from '2d961f5acd6c6309baa51de868773ba4' then
    raise exception 'calendar v81: tests.materialize_test_assignments_for_occurrence is not the phase-4 body (md5 %)', v_md5;
  end if;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'calendar' and p.proname = 'settings_changes_before_insert';
  if v_md5 is distinct from '75ed99731f6d61d19a8f0c2e473fedd1' then
    raise exception 'calendar v81: calendar.settings_changes_before_insert is not the v51 body (md5 %)', v_md5;
  end if;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'calendar' and p.proname = 'lock_event_writer';
  if v_md5 is distinct from '7ebf1bcf39cbb930fb913d89f25fd406' then
    raise exception 'calendar v81: calendar.lock_event_writer is not the v54 body (md5 %)', v_md5;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------
-- A list of questions: distinct values of rpe / wellness.
create function calendar.questions_ok(p text[]) returns boolean
  language sql immutable as $$
    select p is null or (
      not exists (select 1 from unnest(p) e where e is null or e not in ('rpe', 'wellness'))
      and (select count(*) from unnest(p) e) = (select count(distinct e) from unnest(p) e))
  $$;

-- The club of an owner (a club, or a team's club); null for a user owner.
create function calendar.owner_club_id(p_scope varchar, p_club_id uuid, p_team_id uuid) returns uuid
  language sql stable as $$
    select case p_scope
             when 'club' then p_club_id
             when 'team' then (select t.club_id from public.teams t where t.id = p_team_id)
             else null end
  $$;

create function calendar.event_club_id(p_event_id uuid) returns uuid
  language sql stable as $$
    select calendar.owner_club_id(e.owner_scope, e.owner_club_id, e.owner_team_id) from calendar.events e where e.id = p_event_id
  $$;

-- Review round 1 (security M1): an athlete TARGET of an event counts for a
-- question or a Day off only while she is a member of the event's owner on
-- that day — the owner team for a team event, the owner club (any of its
-- memberships) for a club event — by the same membership-on-the-day rule.
create function calendar.athlete_member_of_owner_on_day(p_scope varchar, p_club_id uuid, p_team_id uuid, p_athlete_id uuid, p_day date)
returns boolean language sql stable as $$
  select p_scope in ('club', 'team') and exists (
    select 1 from public.athlete_membership_periods mp
     where mp.athlete_id = p_athlete_id
       and ((p_scope = 'team' and mp.membership_type = 'team' and mp.team_id = p_team_id)
         or (p_scope = 'club' and mp.club_id = p_club_id))
       and (((mp.valid_from at time zone 'UTC')::date <= p_day
             and p_day <= coalesce((mp.valid_to at time zone 'UTC')::date, 'infinity'::date))
            or (mp.valid_to is null
                and not exists (select 1 from public.athlete_membership_periods mp0
                                 where mp0.athlete_id = p_athlete_id and mp0.club_id = mp.club_id
                                   and (mp0.valid_from at time zone 'UTC')::date <= p_day))))
$$;

-- The calendar's audience rule (backend/src/calendarAccess.js
-- membershipOnDaySql, written once in SQL): the athlete is a target of the
-- event, or a member of a target team / club on the day — a period covers the
-- day (UTC dates), or the day lies before her first period in that club and
-- the membership is current.
create function calendar.athlete_reached_on_day(p_event_id uuid, p_athlete_id uuid, p_day date) returns boolean
  language sql stable as $$
    select exists (
      select 1 from calendar.event_targets tg
       where tg.event_id = p_event_id
         and ((tg.target_kind = 'athlete' and tg.target_athlete_id = p_athlete_id
               and exists (select 1 from calendar.events e
                            where e.id = p_event_id
                              and calendar.athlete_member_of_owner_on_day(e.owner_scope, e.owner_club_id, e.owner_team_id, p_athlete_id, p_day)))
           or (tg.target_kind in ('team', 'club') and exists (
                 select 1 from public.athlete_membership_periods mp
                  where mp.athlete_id = p_athlete_id
                    and ((tg.target_kind = 'team' and mp.membership_type = 'team' and mp.team_id = tg.target_team_id)
                      or (tg.target_kind = 'club' and mp.membership_type = 'club' and mp.club_id = tg.target_club_id))
                    and (((mp.valid_from at time zone 'UTC')::date <= p_day
                          and p_day <= coalesce((mp.valid_to at time zone 'UTC')::date, 'infinity'::date))
                         or (mp.valid_to is null
                             and not exists (select 1 from public.athlete_membership_periods mp0
                                              where mp0.athlete_id = p_athlete_id and mp0.club_id = mp.club_id
                                                and (mp0.valid_from at time zone 'UTC')::date <= p_day)))))))
  $$;

-- The event's audience on a day (the rule above), as a set: its athlete
-- targets and the members of its team / club targets who are reached that
-- day. The notification's recipients (9.1.6, A2), the panel, the WELLNESS
-- check.
create function calendar.event_audience_on_day(p_event_id uuid, p_day date) returns table(athlete_id uuid)
  language sql stable as $$
    select c.id from (
      select tg.target_athlete_id as id from calendar.event_targets tg
       where tg.event_id = p_event_id and tg.target_kind = 'athlete'
      union
      select mp.athlete_id from calendar.event_targets tg
        join public.athlete_membership_periods mp
          on (tg.target_kind = 'team' and mp.membership_type = 'team' and mp.team_id = tg.target_team_id)
          or (tg.target_kind = 'club' and mp.membership_type = 'club' and mp.club_id = tg.target_club_id)
       where tg.event_id = p_event_id
    ) c
    where calendar.athlete_reached_on_day(p_event_id, c.id, p_day)
  $$;

-- The one advisory key per club and day (9.1.13): the Day off commands and an
-- event WELLNESS ask / move take it exclusive, the Tests materialization
-- shared, so the day's decision and the rows that follow from it serialize.
create function calendar.wellness_day_key(p_club_id uuid, p_day date) returns bigint
  language sql immutable as $$
    select hashtextextended('calendar.wellness_day:' || p_club_id::text || ':' || p_day::text, 0)
  $$;

-- The WELLNESS test (its seeded identity, migrations_v2/202608221000_...).
create function calendar.is_wellness_version(p_test_version_id uuid) returns boolean
  language sql stable as $$
    select exists (select 1 from tests.test_versions v
                    where v.id = p_test_version_id and v.test_id = '5975d3ba-3578-49e1-9cd3-326df5e21f06')
  $$;

-- ---------------------------------------------------------------------------
-- 2. The club switch (plan 3.1, Q7) and its change log (v51's pair)
-- ---------------------------------------------------------------------------
create table calendar.club_question_settings (
  club_id            uuid primary key references public.clubs(id) on delete restrict,
  enabled            boolean not null,
  reason             text not null
                     constraint club_question_settings_reason_check check (calendar.multiline_text_ok(reason, 500)),
  revision           integer not null default 1
                     constraint club_question_settings_revision_check check (revision >= 1),
  updated_by_user_id uuid not null references public.users(id) on delete restrict,
  updated_at         timestamptz not null default now()
);

-- The one definition of "the club's switch is on" (no row = off).
create function calendar.questions_enabled(p_club_id uuid) returns boolean
  language sql stable as $$
    select coalesce((select s.enabled from calendar.club_question_settings s where s.club_id = p_club_id), false)
  $$;

create function calendar.club_question_settings_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.revision <> 1 then
      raise exception 'calendar.club_question_settings: a new row has revision 1' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.club_id is distinct from old.club_id then
    raise exception 'calendar.club_question_settings: club_id is write-once' using errcode = '23514';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'calendar.club_question_settings: revision must increase by exactly one on every write' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger club_question_settings_guard
  before insert or update on calendar.club_question_settings
  for each row execute function calendar.club_question_settings_guard();
create trigger club_question_settings_no_delete
  before delete on calendar.club_question_settings
  for each row execute function calendar.refuse_delete();
create trigger club_question_settings_no_truncate
  before truncate on calendar.club_question_settings
  for each statement execute function calendar.refuse_truncate();

alter table calendar.settings_requests drop constraint settings_requests_operation_check;
alter table calendar.settings_requests add constraint settings_requests_operation_check check (operation in (
  'type_create', 'type_update', 'type_archive', 'type_restore', 'type_order',
  'field_create', 'field_update', 'field_archive', 'field_restore',
  'location_create', 'location_update', 'location_archive', 'location_restore',
  'team_update', 'questions_switch'));

alter table calendar.settings_changes add column subject_club_id uuid references public.clubs(id) on delete restrict;
alter table calendar.settings_changes drop constraint settings_changes_subject_kind_check;
alter table calendar.settings_changes add constraint settings_changes_subject_kind_check
  check (subject_kind in ('type', 'field', 'location', 'team', 'club'));
alter table calendar.settings_changes drop constraint settings_changes_kind_check;
alter table calendar.settings_changes add constraint settings_changes_kind_check check (kind in (
  'type_create', 'type_update', 'type_archive', 'type_restore', 'type_order',
  'field_create', 'field_update', 'field_archive', 'field_restore',
  'location_create', 'location_update', 'location_archive', 'location_restore',
  'team_update', 'questions_switch'));
alter table calendar.settings_changes drop constraint settings_changes_subject_shape;
alter table calendar.settings_changes add constraint settings_changes_subject_shape check (
  (subject_kind = 'type'     and event_type_id is not null and field_id is null and location_id is null and team_id is null and subject_club_id is null) or
  (subject_kind = 'field'    and field_id is not null and event_type_id is null and location_id is null and team_id is null and subject_club_id is null) or
  (subject_kind = 'location' and location_id is not null and event_type_id is null and field_id is null and team_id is null and subject_club_id is null) or
  (subject_kind = 'team'     and team_id is not null and event_type_id is null and field_id is null and location_id is null and subject_club_id is null) or
  (subject_kind = 'club'     and subject_club_id is not null and event_type_id is null and field_id is null and location_id is null and team_id is null));
create unique index settings_changes_club_revision_key on calendar.settings_changes (subject_club_id, revision) where subject_club_id is not null;

-- v51's body plus the `club` branch (the switch row's club and revision).
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
  elsif new.subject_kind = 'club' then
    if new.kind <> 'questions_switch' or new.basis <> 'platform_admin' then
      raise exception 'calendar.settings_changes: the club switch is changed by a platform admin only' using errcode = '23514';
    end if;
    select s.club_id, s.revision into v_club, v_revision from calendar.club_question_settings s where s.club_id = new.subject_club_id;
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

create function calendar.club_question_settings_need_change() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from calendar.settings_changes c where c.subject_club_id = new.club_id and c.revision = new.revision) then
    raise exception 'calendar.club_question_settings: a write needs its change row (club, revision) in the same transaction' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger club_question_settings_need_change
  after insert or update on calendar.club_question_settings
  deferrable initially deferred
  for each row execute function calendar.club_question_settings_need_change();

-- ---------------------------------------------------------------------------
-- 3. A type's default questions (plan 3.2). Null = derived from
--    default_expects ('rpe' in it -> {rpe}, else {}); written only by a club's
--    type_update. Not frozen by use (as the label).
-- ---------------------------------------------------------------------------
alter table calendar.event_types
  add column default_questions text[]
      constraint event_types_default_questions_check check (calendar.questions_ok(default_questions));

-- ---------------------------------------------------------------------------
-- 4. An event's questions (plan 2, 3.3, 3.5; ⚑1 of 9.1)
-- ---------------------------------------------------------------------------
create table calendar.event_questions (
  id                   uuid primary key default gen_random_uuid(),
  event_id             uuid not null references calendar.events(id) on delete restrict,
  kind                 varchar(10) not null
                       constraint event_questions_kind_check check (kind in ('rpe', 'wellness')),
  external_schedule_id uuid references training_load.external_schedules(id) on delete restrict,
  test_schedule_id     uuid references tests.test_schedules(id) on delete restrict,
  window_kind          varchar(15) not null
                       constraint event_questions_window_kind_check check (window_kind in ('after_event', 'next_morning', 'custom')),
  window_date          date not null,
  opens_time           time not null,
  closes_time          time not null,
  replaces_question_id uuid references calendar.event_questions(id) on delete restrict,
  created_by_user_id   uuid not null references public.users(id) on delete restrict,
  created_at           timestamptz not null default now(),
  ended_at             timestamptz,
  ended_by_user_id     uuid references public.users(id) on delete restrict,
  end_reason           varchar(25)
                       constraint event_questions_end_reason_check check (end_reason is null or end_reason in (
                         'removed', 'closed_early', 'event_cancelled', 'moved', 'replaced_by_sessions')),
  constraint event_questions_schedule_shape check (
    (kind = 'rpe'      and external_schedule_id is not null and test_schedule_id is null) or
    (kind = 'wellness' and test_schedule_id is not null and external_schedule_id is null)),
  constraint event_questions_window_one_day check (opens_time < closes_time),
  constraint event_questions_end_shape check (
    (ended_at is null and ended_by_user_id is null and end_reason is null) or
    (ended_at is not null and ended_by_user_id is not null and end_reason is not null))
);
create unique index event_questions_one_live_per_kind on calendar.event_questions (event_id, kind) where ended_at is null;
create unique index event_questions_external_schedule_key on calendar.event_questions (external_schedule_id) where external_schedule_id is not null;
create unique index event_questions_test_schedule_key on calendar.event_questions (test_schedule_id) where test_schedule_id is not null;
create unique index event_questions_replaces_key on calendar.event_questions (replaces_question_id) where replaces_question_id is not null;
create index event_questions_event_idx on calendar.event_questions (event_id);
create index event_questions_wellness_day_idx on calendar.event_questions (window_date) where kind = 'wellness' and ended_at is null;

create function calendar.event_questions_guard() returns trigger language plpgsql as $$
declare
  v_event record;
  v_club uuid;
  v_ext record;
  v_test record;
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.event_id is distinct from old.event_id or new.kind is distinct from old.kind
       or new.external_schedule_id is distinct from old.external_schedule_id or new.test_schedule_id is distinct from old.test_schedule_id
       or new.window_kind is distinct from old.window_kind or new.window_date is distinct from old.window_date
       or new.opens_time is distinct from old.opens_time or new.closes_time is distinct from old.closes_time
       or new.replaces_question_id is distinct from old.replaces_question_id
       or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at then
      raise exception 'calendar.event_questions: a question only ends' using errcode = '23514';
    end if;
    if old.ended_at is not null then
      raise exception 'calendar.event_questions: an ended question is final' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.ended_at is not null then
    raise exception 'calendar.event_questions: a new question is live' using errcode = '23514';
  end if;
  select e.status, e.owner_scope, e.owner_user_id, e.owner_club_id, e.owner_team_id into v_event
    from calendar.events e where e.id = new.event_id;
  if not found or v_event.status <> 'planned' then
    raise exception 'calendar.event_questions: only a planned event is asked' using errcode = '23514';
  end if;
  v_club := calendar.owner_club_id(v_event.owner_scope, v_event.owner_club_id, v_event.owner_team_id);
  if v_club is null or not calendar.questions_enabled(v_club) then
    raise exception 'calendar.event_questions: questions are not turned on for the event''s club' using errcode = '23514', constraint = 'event_questions_switch';
  end if;
  if new.kind = 'rpe' then
    select s.owner_scope, s.owner_user_id, s.owner_club_id, s.owner_team_id, s.schedule_kind, s.start_date, s.end_date,
           s.opens_time, s.closes_time, s.status
      into v_ext from training_load.external_schedules s where s.id = new.external_schedule_id;
    if not found or v_ext.owner_scope <> v_event.owner_scope or v_ext.owner_user_id is distinct from v_event.owner_user_id
       or v_ext.owner_club_id is distinct from v_event.owner_club_id or v_ext.owner_team_id is distinct from v_event.owner_team_id then
      raise exception 'calendar.event_questions: the schedule belongs to the event''s owner' using errcode = '23514', constraint = 'event_questions_owner';
    end if;
    if v_ext.schedule_kind <> 'one_time' or v_ext.start_date <> new.window_date or v_ext.end_date <> new.window_date
       or v_ext.opens_time <> new.opens_time or v_ext.closes_time <> new.closes_time or v_ext.status <> 'active' then
      raise exception 'calendar.event_questions: the schedule is the question''s window' using errcode = '23514';
    end if;
  else
    select s.owner_scope, s.owner_user_id, s.owner_club_id, s.owner_team_id, s.schedule_kind, s.start_date, s.end_date,
           s.opens_time, s.closes_time, s.status, s.test_version_id
      into v_test from tests.test_schedules s where s.id = new.test_schedule_id;
    if not found or v_test.owner_scope <> v_event.owner_scope or v_test.owner_user_id is distinct from v_event.owner_user_id
       or v_test.owner_club_id is distinct from v_event.owner_club_id or v_test.owner_team_id is distinct from v_event.owner_team_id then
      raise exception 'calendar.event_questions: the schedule belongs to the event''s owner' using errcode = '23514', constraint = 'event_questions_owner';
    end if;
    if v_test.schedule_kind <> 'one_time' or v_test.start_date <> new.window_date or v_test.end_date is distinct from new.window_date
       or v_test.opens_time <> new.opens_time or v_test.closes_time <> new.closes_time or v_test.status <> 'active' then
      raise exception 'calendar.event_questions: the schedule is the question''s window' using errcode = '23514';
    end if;
    if not calendar.is_wellness_version(v_test.test_version_id) then
      raise exception 'calendar.event_questions: an event asks the WELLNESS questionnaire only' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger event_questions_guard
  before insert or update on calendar.event_questions
  for each row execute function calendar.event_questions_guard();
create trigger event_questions_no_delete
  before delete on calendar.event_questions
  for each row execute function calendar.refuse_delete();
create trigger event_questions_no_truncate
  before truncate on calendar.event_questions
  for each statement execute function calendar.refuse_truncate();

-- Written with its event (whose revision rule then needs the audit pair).
create function calendar.event_questions_need_parent() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from calendar.events e where e.id = new.event_id and calendar.written_in_this_transaction(e.xmin)) then
    raise exception 'calendar.event_questions: a question is written with its event' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger event_questions_need_parent
  after insert or update on calendar.event_questions
  deferrable initially deferred
  for each row execute function calendar.event_questions_need_parent();

-- Review round 1 (H2): while an RPE question is live, the event names exactly
-- its schedule (one RPE channel, plan 2.1). The commands end the question
-- before they change the link.
create function calendar.events_rpe_question_link() returns trigger language plpgsql as $$
begin
  if new.external_schedule_id is distinct from old.external_schedule_id
     and exists (select 1 from calendar.event_questions q
                  where q.event_id = new.id and q.kind = 'rpe' and q.ended_at is null
                    and q.external_schedule_id is distinct from new.external_schedule_id) then
    raise exception 'calendar.events: a live RPE question keeps the event''s RPE schedule' using errcode = '23514', constraint = 'events_rpe_question_link';
  end if;
  return new;
end $$;
create trigger events_rpe_question_link
  before update on calendar.events
  for each row execute function calendar.events_rpe_question_link();

-- ---------------------------------------------------------------------------
-- 5. The athlete's *Later* (plan 3.4). The row is its own request record.
-- ---------------------------------------------------------------------------
create table calendar.question_postponements (
  id                   uuid primary key default gen_random_uuid(),
  question_id          uuid not null references calendar.event_questions(id) on delete restrict,
  athlete_id           uuid not null references public.athletes(id) on delete restrict,
  performed_by_user_id uuid not null references public.users(id) on delete restrict,
  request_key          uuid not null,
  created_at           timestamptz not null default now(),
  constraint question_postponements_one_per_key unique (performed_by_user_id, request_key)
);
create index question_postponements_question_idx on calendar.question_postponements (question_id, athlete_id);
create index question_postponements_athlete_idx on calendar.question_postponements (athlete_id);

create function calendar.question_open_for(p_question_id uuid, p_athlete_id uuid) returns boolean
  language sql stable as $$
    select exists (
      select 1 from calendar.event_questions q
        join calendar.events e on e.id = q.event_id and e.status = 'planned'
       where q.id = p_question_id and q.ended_at is null
         and calendar.questions_enabled(calendar.event_club_id(e.id))
         and ((q.kind = 'rpe' and exists (
                select 1 from training_load.external_schedule_occurrences o
                  join training_load.external_assignments a on a.occurrence_id = o.id
                 where o.schedule_id = q.external_schedule_id and a.athlete_id = p_athlete_id
                   and a.status in ('pending', 'open') and now() between a.opens_at and a.closes_at
                   and not exists (select 1 from training_load.session_feedback f where f.external_assignment_id = a.id)))
           or (q.kind = 'wellness' and exists (
                select 1 from tests.test_schedule_occurrences o
                  join tests.test_assignments a on a.occurrence_id = o.id
                 where o.schedule_id = q.test_schedule_id and a.athlete_id = p_athlete_id
                   and a.status in ('pending', 'open') and now() between a.opens_at and a.closes_at))))
  $$;

create function calendar.question_postponements_guard() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from public.athletes a where a.id = new.athlete_id and a.user_id = new.performed_by_user_id) then
    raise exception 'calendar.question_postponements: an athlete postpones only her own question' using errcode = '23514', constraint = 'question_postponements_own';
  end if;
  if not calendar.question_open_for(new.question_id, new.athlete_id) then
    raise exception 'calendar.question_postponements: the question is not open for the athlete' using errcode = '23514', constraint = 'question_postponements_open';
  end if;
  return new;
end $$;
create trigger question_postponements_guard
  before insert on calendar.question_postponements
  for each row execute function calendar.question_postponements_guard();
create trigger question_postponements_append_only
  before update or delete on calendar.question_postponements
  for each row execute function calendar.refuse_change();
create trigger question_postponements_no_truncate
  before truncate on calendar.question_postponements
  for each statement execute function calendar.refuse_truncate();

-- ---------------------------------------------------------------------------
-- 6. The record of a WELLNESS assignment made / turned 'cancelled' because a
--    Day off or an event's own WELLNESS covers the day (9.1.13, ⚑4).
-- ---------------------------------------------------------------------------
create table calendar.question_assignment_skips (
  assignment_id uuid primary key references tests.test_assignments(id) on delete restrict,
  athlete_id    uuid not null references public.athletes(id) on delete restrict,
  event_id      uuid not null references calendar.events(id) on delete restrict,
  question_id   uuid references calendar.event_questions(id) on delete restrict,
  reason        varchar(20) not null
                constraint question_assignment_skips_reason_check check (reason in ('day_off', 'day_off_cancelled', 'covered_by_event')),
  created_at    timestamptz not null default now(),
  constraint question_assignment_skips_shape check ((reason = 'covered_by_event') = (question_id is not null))
);
create index question_assignment_skips_event_idx on calendar.question_assignment_skips (event_id);
create index question_assignment_skips_athlete_idx on calendar.question_assignment_skips (athlete_id);
create index question_assignment_skips_question_idx on calendar.question_assignment_skips (question_id) where question_id is not null;

create function calendar.question_assignment_skips_guard() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from tests.test_assignments a where a.id = new.assignment_id and a.athlete_id = new.athlete_id and a.status = 'cancelled') then
    raise exception 'calendar.question_assignment_skips: the assignment is the athlete''s and cancelled' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger question_assignment_skips_guard
  before insert on calendar.question_assignment_skips
  for each row execute function calendar.question_assignment_skips_guard();
create trigger question_assignment_skips_append_only
  before update or delete on calendar.question_assignment_skips
  for each row execute function calendar.refuse_change();
create trigger question_assignment_skips_no_truncate
  before truncate on calendar.question_assignment_skips
  for each statement execute function calendar.refuse_truncate();

-- ---------------------------------------------------------------------------
-- 7. The runner's operations
-- ---------------------------------------------------------------------------
alter table calendar.event_requests drop constraint event_requests_operation_check;
alter table calendar.event_requests add constraint event_requests_operation_check check (operation in (
  'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions',
  'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule', 'set_fields', 'align_sessions',
  'ask_question', 'remove_question', 'move_question'));
alter table calendar.event_changes drop constraint event_changes_kind_check;
alter table calendar.event_changes add constraint event_changes_kind_check check (kind in (
  'create', 'update', 'cancel', 'attach_sessions', 'detach_sessions',
  'attach_activity', 'detach_activity', 'set_schedule', 'clear_schedule', 'set_fields', 'align_sessions',
  'ask_question', 'remove_question', 'move_question'));

-- ---------------------------------------------------------------------------
-- 8. Tests: Skip days off (plan 8) and the day's skips at materialization
-- ---------------------------------------------------------------------------
alter table tests.test_schedules
  add column skip_days_off boolean not null default false;
alter table tests.test_schedules
  add constraint test_schedules_skip_days_off_daily check (
    not skip_days_off or (schedule_kind = 'recurring' and recurrence_rule ->> 'freq' = 'daily'));

-- The phase-4 body (202608300900_..._phase4_assignment_timezone_window.sql),
-- unchanged up to the insert; the insert now decides, per eligible athlete,
-- whether the day is covered (9.1.2 item 8, 9.1.13 O3):
--   * only for a schedule of a club (or a team's club) whose switch is on,
--     and never for a schedule an event question names (its own question);
--   * after the occurrence's FOR UPDATE, the day's key is taken SHARED (the
--     Day off commands and an event WELLNESS ask take it exclusive);
--   * 'day_off': the schedule skips days off and a planned Day off event of
--     the same club reaches the athlete on the day;
--   * 'covered_by_event': the schedule is WELLNESS and a live event WELLNESS
--     question of the same club on the day reaches the athlete;
--   * a covered athlete's assignment is inserted as 'cancelled' (terminal,
--     so it closes resolve_current_target_dates' outstanding snapshot) with
--     its question_assignment_skips row; everyone else exactly as before.
create or replace function tests.materialize_test_assignments_for_occurrence(p_occurrence_id uuid)
returns integer language plpgsql as $$
declare
  v_occurrence tests.test_schedule_occurrences%rowtype;
  v_schedule tests.test_schedules%rowtype;
  v_inserted_count integer := 0;
  v_club uuid;
  v_check boolean := false;
  v_is_wellness boolean := false;
  v_athlete record;
  v_event_id uuid;
  v_question_id uuid;
  v_reason varchar(20);
  v_assignment_id uuid;
begin
  select * into v_occurrence from tests.test_schedule_occurrences where id = p_occurrence_id for update;
  if v_occurrence.id is null then
    raise exception 'occurrence % does not exist', p_occurrence_id;
  end if;

  select * into v_schedule from tests.test_schedules where id = v_occurrence.schedule_id;

  if v_occurrence.assignments_materialized_at is null then
    insert into tests.test_occurrence_target_snapshot (occurrence_id, athlete_id)
    select p_occurrence_id, ta.athlete_id
    from tests.resolve_schedule_target_athletes(v_schedule.id) ta
    on conflict (occurrence_id, athlete_id) do nothing;

    update tests.test_schedule_occurrences set assignments_materialized_at = now() where id = p_occurrence_id;
  end if;

  v_club := calendar.owner_club_id(v_schedule.owner_scope, v_schedule.owner_club_id, v_schedule.owner_team_id);
  if v_club is not null and calendar.questions_enabled(v_club)
     and not exists (select 1 from calendar.event_questions q where q.test_schedule_id = v_schedule.id) then
    v_is_wellness := v_schedule.test_version_id is not null and calendar.is_wellness_version(v_schedule.test_version_id);
    v_check := v_schedule.skip_days_off or v_is_wellness;
  end if;
  if v_check then
    perform pg_advisory_xact_lock_shared(calendar.wellness_day_key(v_club, v_occurrence.scheduled_date));
  end if;

  for v_athlete in
    select s.athlete_id, coalesce(a.device_timezone, v_schedule.timezone) as effective_timezone
      from tests.test_occurrence_target_snapshot s
      join public.athletes a on a.id = s.athlete_id
     where s.occurrence_id = p_occurrence_id
       and (now() at time zone coalesce(a.device_timezone, v_schedule.timezone))::date = v_occurrence.scheduled_date
       and not exists (select 1 from tests.test_assignments x where x.occurrence_id = p_occurrence_id and x.athlete_id = s.athlete_id)
     order by s.athlete_id
  loop
    v_reason := null;
    v_event_id := null;
    v_question_id := null;
    if v_check and v_schedule.skip_days_off then
      select e.id into v_event_id
        from calendar.events e
        join calendar.event_types t on t.id = e.event_type_id and t.kind = 'day_off'
       where e.status = 'planned'
         and e.day <= v_occurrence.scheduled_date and v_occurrence.scheduled_date <= coalesce(e.end_day, e.day)
         and calendar.owner_club_id(e.owner_scope, e.owner_club_id, e.owner_team_id) = v_club
         and calendar.athlete_reached_on_day(e.id, v_athlete.athlete_id, v_occurrence.scheduled_date)
       order by e.id
       limit 1;
      if v_event_id is not null then
        v_reason := 'day_off';
      end if;
    end if;
    if v_reason is null and v_check and v_is_wellness then
      select q.id, e.id into v_question_id, v_event_id
        from calendar.event_questions q
        join calendar.events e on e.id = q.event_id and e.status = 'planned'
       where q.kind = 'wellness' and q.ended_at is null and q.window_date = v_occurrence.scheduled_date
         and calendar.owner_club_id(e.owner_scope, e.owner_club_id, e.owner_team_id) = v_club
         and calendar.athlete_reached_on_day(e.id, v_athlete.athlete_id, v_occurrence.scheduled_date)
       order by q.id
       limit 1;
      if v_question_id is not null then
        v_reason := 'covered_by_event';
      end if;
    end if;

    insert into tests.test_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, due_at, closes_at, status)
    values (
      p_occurrence_id,
      v_athlete.athlete_id,
      v_athlete.effective_timezone,
      v_occurrence.scheduled_date,
      (v_occurrence.scheduled_date + v_schedule.opens_time) at time zone v_athlete.effective_timezone,
      case when v_schedule.due_time is null then null else (v_occurrence.scheduled_date + v_schedule.due_time) at time zone v_athlete.effective_timezone end,
      (v_occurrence.scheduled_date + v_schedule.closes_time) at time zone v_athlete.effective_timezone,
      case when v_reason is null then 'pending' else 'cancelled' end
    )
    on conflict (occurrence_id, athlete_id) do nothing
    returning id into v_assignment_id;

    if v_assignment_id is not null then
      v_inserted_count := v_inserted_count + 1;
      if v_reason is not null then
        insert into calendar.question_assignment_skips (assignment_id, athlete_id, event_id, question_id, reason)
        values (v_assignment_id, v_athlete.athlete_id, v_event_id, v_question_id, v_reason);
      end if;
    end if;
    v_assignment_id := null;
  end loop;

  return v_inserted_count;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Fail-closed self-check: nothing was written, the bodies are in place.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from calendar.club_question_settings) or exists (select 1 from calendar.event_questions)
     or exists (select 1 from calendar.question_postponements) or exists (select 1 from calendar.question_assignment_skips)
     or exists (select 1 from tests.test_schedules where skip_days_off)
     or exists (select 1 from calendar.event_types where default_questions is not null) then
    raise exception 'calendar v81: the migration must write no row';
  end if;
end $$;
