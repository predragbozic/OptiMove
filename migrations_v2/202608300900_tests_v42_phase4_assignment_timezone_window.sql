-- ============================================================
-- OPTIMOVE — Tests modul, Phase 4: per-athlete timezone-correct assignment
-- window (mobile scheduling redesign companion migration).
--
-- Additive only - does NOT touch migrations_v2/202608240900_tests_v42_
-- phase1_scheduling_execution.sql or 202608260900_..._occurrence_generation_
-- lock_fix.sql byte-for-byte (their checksums stay valid). This file only
-- ADDs columns/a table/a trigger, and CREATE OR REPLACEs one already-
-- deployed function (tests.materialize_test_assignments_for_occurrence) -
-- the exact same "replace a function in a new file" pattern the lock-fix
-- migration already established.
--
-- PROBLEM: today, tests.test_schedule_occurrences has exactly ONE
-- opens_at/due_at/closes_at triple per occurrence, computed once from the
-- schedule's single timezone - every athlete under that occurrence,
-- regardless of where they actually live, shares that one absolute window.
-- A coach in Belgrade scheduling "opens at 06:00" means 06:00 Europe/
-- Belgrade for EVERY athlete, including one in Asia/Dubai - not 06:00 local
-- to each of them, which is the actual business rule.
--
-- DESIGN CHOICE (minimal additive realization - columns on test_assignments,
-- not a 1:1 table): test_assignments already has one row per (occurrence,
-- athlete) and is already the join target every reader ends up at. Adding
-- five columns here means no reader needs a new join/table just to find an
-- assignment's own window - every one of the ~10 existing read call sites
-- already selects from tests.test_assignments directly. A 1:1
-- test_assignment_windows table would only add a mandatory join with zero
-- benefit (no independent lifecycle - this data is created once, at
-- materialization, together with the assignment row itself, and is never
-- absent for a real assignment).
--
-- WHERE THE ATHLETE'S TIMEZONE LIVES: public.athletes gets two new nullable
-- columns (device_timezone, device_timezone_updated_at) - NOT
-- public.users, because tests.test_assignments.athlete_id -> public.
-- athletes is the join every reader already has, and a meaningful fraction
-- of athletes have no linked user_id at all (see testsNotificationWorker.js's
-- own "noRecipient" handling) - keying this off users would make timezone
-- permanently unknowable for exactly the athletes most in need of a
-- fallback. No existing per-user/per-athlete timezone field or table exists
-- anywhere in the schema (checked: public.user_workspace_preferences is a
-- single-purpose, user_id-keyed "which workspace is active" row - not a
-- general preferences store, and reusing it here would overload an
-- unrelated concept for no benefit over two plain columns on the table this
-- feature already needs). test_schedules.timezone is NOT removed or
-- repurposed - it stays exactly as it is today: the schedule-level
-- fallback for an athlete whose own timezone is not yet known, and the
-- still-authoritative basis for occurrence GENERATION timing (see below).
--
-- WHAT STAYS ON THE SCHEDULE'S OWN TIMEZONE (deliberately unchanged):
-- occurrence GENERATION (tests.generate_test_schedule_occurrence, and the
-- notification worker's Phase 1 "is it time to generate today's occurrence
-- yet" query) still uses the schedule's own timezone as the reference clock
-- for deciding which calendar date's occurrence to create, and
-- test_schedule_occurrences.opens_at/due_at/closes_at stay exactly as they
-- were computed before - a coarse, schedule-level REFERENCE window, kept
-- for backward compatibility (existing readers that only need a rough
-- "when does this typically run" figure, e.g. the coach Today group
-- header) and because occurrence generation is fundamentally a
-- coach/schedule-level decision ("has today's date arrived"), not a
-- per-athlete one. Per-athlete precision only matters for WHEN AN
-- ASSIGNMENT ITSELF opens/is due/closes - which is exactly what the new
-- test_assignments columns below capture. A materialized assignment row can
-- (and normally will) exist some time before its own opens_at arrives -
-- readers gate on the assignment's own opens_at/closes_at, never on "has it
-- been materialized yet".
--
-- SEMANTICS (matches the spec's own worked example precisely): a specific
-- scheduled_date (e.g. 2026-08-26) is the SAME calendar-date value for every
-- athlete under an occurrence - it is never reinterpreted per timezone.
-- Only the WALL-CLOCK opens_time/due_time/closes_time is evaluated in each
-- athlete's own IANA timezone to produce that athlete's absolute
-- opens_at/due_at/closes_at - "06:00 opens" becomes a different UTC instant
-- per athlete, but everyone's assignment still carries the same
-- local_scheduled_date. This mirrors the schedule-level generator's own
-- `(scheduled_date + time) at time zone tz` formula exactly, just swapping
-- in the athlete's own effective timezone instead of the schedule's.
--
-- SNAPSHOT TIMING: computed once, at MATERIALIZATION time (same moment as
-- today, per-occurrence, per-athlete) using
-- coalesce(athlete.device_timezone, schedule.timezone) - "the last known
-- timezone at materialization time, or the schedule's fallback if never
-- known". Once materialized, an assignment's timezone/opens_at/due_at/
-- closes_at never change again (no trigger enforces this explicitly here,
-- matching test_assignments' existing pattern where only the DB FUNCTION
-- that writes these columns is trusted to set them correctly once, at
-- INSERT - there is no UPDATE path anywhere in the app that ever touches
-- these columns). A device-timezone change after materialization therefore
-- can only ever affect FUTURE, not-yet-materialized assignments - exactly
-- the "travel doesn't retroactively change today's already-open window"
-- rule.
--
-- BACKFILL: every existing test_assignments row is backfilled from its own
-- occurrence's/schedule's already-existing values (their effective
-- timezone at the time was always schedule.timezone, since no athlete
-- timezone concept existed yet) - existing behavior/history is exactly
-- preserved, not reinterpreted.
--
-- Runner is the sole owner of the BEGIN/COMMIT boundary - this file
-- intentionally holds no transaction-control statements of its own.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Athlete device timezone (public.athletes)
-- ------------------------------------------------------------

alter table public.athletes add column if not exists device_timezone varchar(64);
alter table public.athletes add column if not exists device_timezone_updated_at timestamptz;

-- Same validation approach as tests.validate_schedule_timezone_and_recurrence
-- (a bare CHECK cannot safely query pg_timezone_names) - a new, independent
-- function/trigger rather than reusing that one, since it lives on a
-- different table and this migration must not touch the already-deployed
-- file that function is defined in.
create function public.validate_athlete_device_timezone()
returns trigger language plpgsql as $$
begin
  if NEW.device_timezone is not null and not exists (select 1 from pg_timezone_names where name = NEW.device_timezone) then
    raise exception 'device_timezone % is not a recognized IANA timezone name', NEW.device_timezone;
  end if;
  return NEW;
end $$;

create trigger validate_athlete_device_timezone
  before insert or update of device_timezone on public.athletes
  for each row execute function public.validate_athlete_device_timezone();


-- ------------------------------------------------------------
-- 2. Per-assignment window (tests.test_assignments)
-- ------------------------------------------------------------

alter table tests.test_assignments add column if not exists timezone varchar(64);
alter table tests.test_assignments add column if not exists local_scheduled_date date;
alter table tests.test_assignments add column if not exists opens_at timestamptz;
alter table tests.test_assignments add column if not exists due_at timestamptz;
alter table tests.test_assignments add column if not exists closes_at timestamptz;

-- Replaces the Phase 1 function - see this file's header for why this
-- replacement is safe/additive. Locking behavior (FOR UPDATE on the
-- occurrence row, guarding assignments_materialized_at) is byte-for-byte
-- preserved; the only change is reading the parent schedule row too (for
-- opens_time/due_time/closes_time/timezone-fallback) and computing each
-- resolved athlete's own effective timezone before the INSERT.
create or replace function tests.materialize_test_assignments_for_occurrence(p_occurrence_id uuid)
returns integer language plpgsql as $$
declare
  v_occurrence tests.test_schedule_occurrences%rowtype;
  v_schedule tests.test_schedules%rowtype;
  v_inserted_count integer;
begin
  -- FOR UPDATE locks this occurrence row for the rest of the transaction -
  -- unchanged from Phase 1: a second concurrent call blocks here until the
  -- first commits, then sees assignments_materialized_at already set and
  -- returns 0.
  select * into v_occurrence from tests.test_schedule_occurrences where id = p_occurrence_id for update;
  if v_occurrence.id is null then
    raise exception 'occurrence % does not exist', p_occurrence_id;
  end if;

  if v_occurrence.assignments_materialized_at is not null then
    return 0;
  end if;

  select * into v_schedule from tests.test_schedules where id = v_occurrence.schedule_id;
  -- v_schedule.id cannot be null here: test_schedule_occurrences.schedule_id
  -- is a NOT NULL FK to tests.test_schedules with no ON DELETE that could
  -- orphan it while the occurrence itself still exists.

  with target_athletes as (
    select t.target_athlete_id as athlete_id
    from tests.test_schedule_targets t
    where t.schedule_id = v_schedule.id and t.target_kind = 'athlete'

    union

    select m.athlete_id
    from tests.test_schedule_targets t
    join public.athlete_memberships m
      on m.membership_type = 'team' and m.team_id = t.target_team_id and m.status = 'active'
    where t.schedule_id = v_schedule.id and t.target_kind = 'team'

    union

    select m.athlete_id
    from tests.test_schedule_targets t
    join public.athlete_memberships m
      on m.membership_type = 'club' and m.club_id = t.target_club_id and m.status = 'active'
    where t.schedule_id = v_schedule.id and t.target_kind = 'club'
  ),
  resolved as (
    -- "Poslednja poznata timezone sportiste ... ili test_schedules.timezone
    -- kao fallback ako sportista nikada nije otvorio aplikaciju" - read
    -- fresh at materialization time (this function's only call site,
    -- ensureCurrentOccurrence, always runs generate+materialize in the
    -- same transaction, so this is also always "as of right now").
    select ta.athlete_id, coalesce(a.device_timezone, v_schedule.timezone) as effective_timezone
    from target_athletes ta
    join public.athletes a on a.id = ta.athlete_id
  )
  insert into tests.test_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, due_at, closes_at)
  select
    p_occurrence_id,
    r.athlete_id,
    r.effective_timezone,
    v_occurrence.scheduled_date,
    (v_occurrence.scheduled_date + v_schedule.opens_time) at time zone r.effective_timezone,
    case when v_schedule.due_time is null then null else (v_occurrence.scheduled_date + v_schedule.due_time) at time zone r.effective_timezone end,
    (v_occurrence.scheduled_date + v_schedule.closes_time) at time zone r.effective_timezone
  from resolved r
  on conflict (occurrence_id, athlete_id) do nothing;

  get diagnostics v_inserted_count = row_count;

  update tests.test_schedule_occurrences set assignments_materialized_at = now() where id = p_occurrence_id;

  return v_inserted_count;
end $$;

-- Backfill: every assignment materialized before this migration was
-- (necessarily) computed using its occurrence's schedule's own timezone -
-- there was no other concept. Copying straight from the occurrence/schedule
-- row it already belongs to reproduces the exact same values, so existing
-- behavior/history is unchanged by this migration, not reinterpreted.
update tests.test_assignments asg
set timezone = sch.timezone,
    local_scheduled_date = o.scheduled_date,
    opens_at = o.opens_at,
    due_at = o.due_at,
    closes_at = o.closes_at
from tests.test_schedule_occurrences o
join tests.test_schedules sch on sch.id = o.schedule_id
where o.id = asg.occurrence_id
  and asg.opens_at is null;

-- NOT NULL only after backfill - every row (old and, from here on, new via
-- the replaced function above) always has these set from this point
-- forward. timezone/local_scheduled_date are validated only implicitly (via
-- the DB function that is the sole writer of these columns - there is no
-- app-facing write path for them, unlike public.athletes.device_timezone
-- above, which a real endpoint accepts directly from an athlete's browser
-- and therefore does need its own IANA-name trigger).
alter table tests.test_assignments alter column timezone set not null;
alter table tests.test_assignments alter column local_scheduled_date set not null;
alter table tests.test_assignments alter column opens_at set not null;
alter table tests.test_assignments alter column closes_at set not null;

alter table tests.test_assignments add constraint test_assignments_opens_before_closes check (opens_at <= closes_at);
alter table tests.test_assignments add constraint test_assignments_due_between_opens_closes check (due_at is null or (due_at >= opens_at and due_at <= closes_at));
