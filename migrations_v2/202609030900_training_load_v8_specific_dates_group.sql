-- ============================================================
-- OPTIMOVE — Training load (RPE/sRPE) v8: "Dates" mode becomes ONE
-- logical schedule (hardening correction, item 10).
--
-- Before this migration, picking N specific dates in "Dates" mode
-- created N fully independent one_time schedules sharing nothing but
-- their own initial settings/targets - each with its own separate
-- Edit/Pause/Cancel/Schedule-again, and no shared identity at all. That
-- contradicts both the "Specific dates" model this mirrors and the UX
-- implication of "Schedule 5 dates" as a single action.
--
-- Fix: a new schedule_kind, 'dates', backed by its own child table of
-- explicit date rows (external_schedule_dates) - the schedule itself
-- stays the SAME one row whether it covers 1 date or 50; occurrence
-- generation for a 'dates' schedule is gated by membership in that
-- child table instead of the start_date/end_date range one_time/
-- recurring already use. Genuinely additive (new CHECK values, new
-- table, CREATE OR REPLACE on the two functions this touches) - does
-- not alter any one_time/recurring row's own existing behavior.
-- ============================================================

alter table training_load.external_schedules
  drop constraint external_schedules_schedule_kind_check;
alter table training_load.external_schedules
  add constraint external_schedules_schedule_kind_check
    check (schedule_kind in ('one_time', 'recurring', 'dates'));

alter table training_load.external_schedules
  drop constraint external_schedules_check1;
alter table training_load.external_schedules
  add constraint external_schedules_check1 check (
    (schedule_kind = 'one_time' and recurrence_rule is null and (end_date is null or end_date = start_date))
    or (schedule_kind = 'recurring' and recurrence_rule is not null)
    -- start_date/end_date on a 'dates' schedule are min/max of its own
    -- external_schedule_dates rows - informational/sort-order only,
    -- never authoritative (see generate_external_schedule_occurrence
    -- and resolve_current_external_target_dates below).
    or (schedule_kind = 'dates' and recurrence_rule is null)
  );

-- One row per picked date, under the one owning schedule.
create table training_load.external_schedule_dates (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references training_load.external_schedules(id) on delete cascade,
  scheduled_date date not null,
  created_at timestamptz not null default now(),
  unique (schedule_id, scheduled_date)
);

create index external_schedule_dates_schedule_id_idx on training_load.external_schedule_dates (schedule_id);

-- generate_external_schedule_occurrence: a 'dates' schedule's valid
-- window is the explicit date set above, never start_date/end_date.
create or replace function training_load.generate_external_schedule_occurrence(p_schedule_id uuid, p_scheduled_date date)
returns uuid language plpgsql as $$
declare
  v_schedule training_load.external_schedules%rowtype;
  v_occurrence_id uuid;
begin
  select * into v_schedule from training_load.external_schedules where id = p_schedule_id for share;
  if v_schedule.id is null then
    raise exception 'external schedule % does not exist', p_schedule_id;
  end if;
  if v_schedule.status <> 'active' then
    raise exception 'cannot generate an occurrence for schedule % - status is %, not active', p_schedule_id, v_schedule.status;
  end if;

  if v_schedule.schedule_kind = 'dates' then
    if not exists (select 1 from training_load.external_schedule_dates d where d.schedule_id = p_schedule_id and d.scheduled_date = p_scheduled_date) then
      raise exception 'scheduled_date % is not one of schedule %''s own picked dates', p_scheduled_date, p_schedule_id;
    end if;
  elsif p_scheduled_date < v_schedule.start_date or (v_schedule.end_date is not null and p_scheduled_date > v_schedule.end_date) then
    raise exception 'scheduled_date % is outside schedule %''s start_date/end_date window', p_scheduled_date, p_schedule_id;
  end if;

  insert into training_load.external_schedule_occurrences (schedule_id, scheduled_date, opens_at, due_at, closes_at)
  values (
    p_schedule_id, p_scheduled_date,
    (p_scheduled_date + v_schedule.opens_time) at time zone v_schedule.timezone,
    case when v_schedule.due_time is null then null else (p_scheduled_date + v_schedule.due_time) at time zone v_schedule.timezone end,
    (p_scheduled_date + v_schedule.closes_time) at time zone v_schedule.timezone
  )
  on conflict (schedule_id, scheduled_date) do nothing
  returning id into v_occurrence_id;

  if v_occurrence_id is null then
    select id into v_occurrence_id from training_load.external_schedule_occurrences
    where schedule_id = p_schedule_id and scheduled_date = p_scheduled_date;
  end if;
  return v_occurrence_id;
end $$;

-- resolve_current_external_target_dates: a 'dates' schedule's candidate
-- dates are gated by membership in external_schedule_dates instead of a
-- start/end range - still only ever a candidate when it ALSO matches
-- some currently-resolved target athlete's own real local date (the
-- same rule this file's v4 header already established for one_time/
-- recurring - never guessed from the schedule's own timezone alone).
create or replace function training_load.resolve_current_external_target_dates(p_schedule_id uuid)
returns table(local_date date) language sql stable as $$
  with sch as (select * from training_load.external_schedules where id = p_schedule_id),
  per_athlete as (
    select (now() at time zone coalesce(a.device_timezone, sch.timezone))::date as local_date,
           sch.schedule_kind, sch.start_date, sch.end_date
    from training_load.resolve_external_schedule_target_athletes(p_schedule_id) ta
    join public.athletes a on a.id = ta.athlete_id
    cross join sch
  ),
  from_current_targets as (
    select distinct local_date from per_athlete
    where (
      (schedule_kind = 'one_time' and local_date = start_date)
      or (schedule_kind = 'recurring' and local_date >= start_date and (end_date is null or local_date <= end_date))
      or (schedule_kind = 'dates' and exists (
            select 1 from training_load.external_schedule_dates d
            where d.schedule_id = p_schedule_id and d.scheduled_date = per_athlete.local_date
          ))
    )
  ),
  from_outstanding_snapshot as (
    select distinct o.scheduled_date as local_date
    from training_load.external_schedule_occurrences o
    join training_load.external_occurrence_target_snapshot s on s.occurrence_id = o.id
    where o.schedule_id = p_schedule_id
      and not exists (
        select 1 from training_load.external_assignments asg
        where asg.occurrence_id = o.id and asg.athlete_id = s.athlete_id
      )
  )
  select local_date from from_current_targets
  union
  select local_date from from_outstanding_snapshot
$$;
