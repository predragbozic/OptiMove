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
-- OCCURRENCE GENERATION ALSO HAD TO CHANGE (correction after this
-- migration's first draft): generating only "today's" occurrence, in the
-- SCHEDULE's own timezone, is not just a cosmetic gap - it means an athlete
-- significantly AHEAD of the schedule's own timezone (e.g. a Europe/
-- Belgrade schedule, an athlete on Pacific/Kiritimati, UTC+14) can already
-- be on their own correct calendar date while the schedule's own reference
-- clock is still on the PREVIOUS day - no occurrence row (and therefore no
-- assignment row) exists for them yet AT ALL, not just one with the wrong
-- window. tests.generate_test_schedule_occurrence() itself is unchanged
-- (still generic: any (schedule_id, scheduled_date) pair, idempotent) -
-- what changed is WHICH dates backend/src/testsOccurrenceService.js's
-- ensureCurrentOccurrence() and the worker's Phase 1 SQL now consider
-- "current": both the schedule's own local TODAY (gated on opens_time
-- reached, exactly as before) AND the adjacent day that could already/
-- still be relevant to an athlete whose own timezone diverges from the
-- schedule's (one_time: the day BEFORE start_date, ungated - the fixed
-- start_date can already be "now" for an ahead athlete before the
-- schedule's own clock even reaches it; daily: TOMORROW relative to the
-- schedule's own today, ungated, for the same reason). The realistic
-- worldwide timezone spread (UTC-12..UTC+14, ~26h) never needs more than
-- one adjacent day of lookahead. test_schedule_occurrences.opens_at/
-- due_at/closes_at stay exactly as before - a coarse, schedule-level
-- REFERENCE window - but readers must no longer treat it as a stand-in for
-- "the" window everyone shares (see item 4/coach Today below).
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
-- SNAPSHOT TIMING (corrected): MEMBERSHIP (which athletes this schedule
-- targets, resolved via test_schedule_targets/athlete_memberships) is still
-- frozen exactly ONCE per occurrence, into the new
-- tests.test_occurrence_target_snapshot table below - a team member added
-- AFTER that point must never retroactively appear under this occurrence
-- (preserves the exact guarantee Phase 1 already had). ELIGIBILITY,
-- though, is evaluated on EVERY call to materialize_test_assignments_for_
-- occurrence(): a snapshotted athlete's own test_assignments row is only
-- actually inserted once (now() at time zone their effective_timezone)::
-- date matches this occurrence's own scheduled_date - for a one_time
-- schedule this is trivially true for everyone immediately (there is only
-- ever one date), but for a daily/recurring schedule it means an athlete
-- significantly ahead of the schedule's own timezone is correctly left
-- out of TODAY's (schedule-zone) occurrence and picked up on a LATER call,
-- once their own local day actually reaches this occurrence's date -
-- without ever re-resolving membership. Each athlete's own INSERT still
-- only ever happens once (`on conflict (occurrence_id, athlete_id) do
-- nothing`), and once inserted, a DB trigger (below) makes their timezone/
-- local_scheduled_date/opens_at/due_at/closes_at genuinely immutable - not
-- just an unenforced convention. A device-timezone change after an
-- athlete's OWN assignment row has been inserted therefore can only ever
-- affect FUTURE, not-yet-materialized assignments - exactly the "travel
-- doesn't retroactively change today's already-open window" rule.
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

-- The FROZEN membership snapshot for one occurrence - separate from
-- test_assignments itself specifically so "who could ever be assigned
-- here" (decided once, see materialize_test_assignments_for_occurrence
-- below) can be tracked independently of "who HAS been assigned so far"
-- (grows over multiple calls as each snapshotted athlete's own local date
-- catches up to this occurrence's scheduled_date). Without this
-- separation, re-resolving membership on every call (needed to pick up a
-- newly-eligible-by-timezone athlete) would also re-catch a genuinely NEW
-- team member added after the fact - exactly what Phase 1's own
-- "membership snapshot" guarantee forbids.
create table tests.test_occurrence_target_snapshot (
  occurrence_id uuid not null references tests.test_schedule_occurrences(id) on delete cascade,
  athlete_id uuid not null references public.athletes(id) on delete restrict,
  effective_timezone varchar(64) not null,
  created_at timestamptz not null default now(),
  primary key (occurrence_id, athlete_id)
);

create index test_occurrence_target_snapshot_athlete_id_idx on tests.test_occurrence_target_snapshot (athlete_id);

-- Replaces the Phase 1 function - see this file's header for why this
-- replacement is safe/additive. Locking behavior (FOR UPDATE on the
-- occurrence row) is preserved, still serializing concurrent calls for the
-- SAME occurrence - but assignments_materialized_at now means "the
-- membership snapshot has been taken" (still set exactly once), not "every
-- assignment that will ever exist here has been inserted": this function
-- is now safe, and expected, to be called AGAIN on a later cycle for the
-- same occurrence, to pick up athletes whose own local date has since
-- caught up to it.
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
    -- Freeze the target-athlete membership snapshot exactly ONCE, using the
    -- exact same union-of-targets resolution Phase 1 always used. A team/
    -- club member added AFTER this point must never appear here later -
    -- this INSERT (into the snapshot table, not test_assignments itself)
    -- never runs again for this occurrence.
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
    )
    insert into tests.test_occurrence_target_snapshot (occurrence_id, athlete_id, effective_timezone)
    select
      p_occurrence_id,
      ta.athlete_id,
      -- "Poslednja poznata timezone sportiste ... ili test_schedules.
      -- timezone kao fallback" - read fresh at snapshot time (the athlete's
      -- effective timezone is itself frozen here too, alongside membership -
      -- a device-timezone change after THIS point only ever affects a
      -- DIFFERENT, later occurrence, never this one).
      coalesce(a.device_timezone, v_schedule.timezone)
    from target_athletes ta
    join public.athletes a on a.id = ta.athlete_id
    on conflict (occurrence_id, athlete_id) do nothing;

    update tests.test_schedule_occurrences set assignments_materialized_at = now() where id = p_occurrence_id;
  end if;

  -- Every call (first or repeated) inserts real assignment rows for
  -- whichever snapshotted athletes are ELIGIBLE right now: a one_time
  -- schedule's occurrence has only ever one true date, so every
  -- snapshotted athlete is always eligible immediately; a daily/recurring
  -- occurrence only includes an athlete once THEIR OWN current local date
  -- (their snapshotted effective_timezone) reaches this occurrence's own
  -- scheduled_date - this is what lets an athlete significantly ahead of
  -- the schedule's own reference timezone still get assigned, on a LATER
  -- cycle, once their own day catches up, without ever re-resolving
  -- membership. Each athlete's own row is still only ever inserted once
  -- (on conflict do nothing) - once eligible and inserted, its window is
  -- immutable (see the trigger below).
  insert into tests.test_assignments (occurrence_id, athlete_id, timezone, local_scheduled_date, opens_at, due_at, closes_at)
  select
    p_occurrence_id,
    s.athlete_id,
    s.effective_timezone,
    v_occurrence.scheduled_date,
    (v_occurrence.scheduled_date + v_schedule.opens_time) at time zone s.effective_timezone,
    case when v_schedule.due_time is null then null else (v_occurrence.scheduled_date + v_schedule.due_time) at time zone s.effective_timezone end,
    (v_occurrence.scheduled_date + v_schedule.closes_time) at time zone s.effective_timezone
  from tests.test_occurrence_target_snapshot s
  where s.occurrence_id = p_occurrence_id
    and (
      v_schedule.schedule_kind <> 'recurring'
      or (now() at time zone s.effective_timezone)::date = v_occurrence.scheduled_date
    )
  on conflict (occurrence_id, athlete_id) do nothing;

  get diagnostics v_inserted_count = row_count;

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

-- No backfill into tests.test_occurrence_target_snapshot: every pre-
-- migration occurrence already has assignments_materialized_at set (from
-- the OLD version of materialize_test_assignments_for_occurrence, which
-- unconditionally assigned every resolved target athlete, with no
-- eligibility filtering at all) - so every athlete who should ever have
-- been assigned to an old occurrence already was, and the NEW function's
-- "snapshot already taken" check correctly skips re-snapshotting them (no
-- gap - see this file's header for why old data needs no reinterpretation).

-- Item 3 correction: DB-ENFORCED snapshot immutability. Extends the
-- already-deployed tests.protect_assignment_identity_and_lifecycle()
-- (migrations_v2/202608240900_..., byte-for-byte untouched - only this
-- CREATE OR REPLACE, the same pattern already used above for
-- materialize_test_assignments_for_occurrence) so timezone/
-- local_scheduled_date/opens_at/due_at/closes_at are genuinely immutable
-- after INSERT, not just an unenforced convention in a comment. Its
-- existing trigger (created in that file) automatically picks up this new
-- body - a trigger dispatches to its function by name, so no new `create
-- trigger` statement is needed here. status/completed_at/started_at/
-- updated_at (the real lifecycle columns) are completely unaffected -
-- their own transition rules stay exactly as they already were below.
create or replace function tests.protect_assignment_identity_and_lifecycle()
returns trigger language plpgsql as $$
declare
  v_old_rank integer;
  v_new_rank integer;
begin
  if NEW.occurrence_id is distinct from OLD.occurrence_id
     or NEW.athlete_id is distinct from OLD.athlete_id
     or NEW.snapshot_test_version_id is distinct from OLD.snapshot_test_version_id
     or NEW.snapshot_test_battery_version_id is distinct from OLD.snapshot_test_battery_version_id
  then
    raise exception 'test_assignments.% identity/snapshot columns (occurrence_id/athlete_id/snapshot_test_version_id/snapshot_test_battery_version_id) are immutable after creation', OLD.id;
  end if;

  if NEW.timezone is distinct from OLD.timezone
     or NEW.local_scheduled_date is distinct from OLD.local_scheduled_date
     or NEW.opens_at is distinct from OLD.opens_at
     or NEW.due_at is distinct from OLD.due_at
     or NEW.closes_at is distinct from OLD.closes_at
  then
    raise exception 'test_assignments.% timezone/local_scheduled_date/opens_at/due_at/closes_at are an immutable snapshot, taken once at materialization - they can never be changed afterward, including by a device-timezone change (which only ever affects a LATER, not-yet-materialized assignment)', OLD.id;
  end if;

  v_old_rank := case OLD.status when 'pending' then 1 when 'open' then 2 when 'in_progress' then 3 else 4 end;
  v_new_rank := case NEW.status when 'pending' then 1 when 'open' then 2 when 'in_progress' then 3 else 4 end;
  if v_old_rank = 4 and NEW.status <> OLD.status then
    raise exception 'test_assignments.% status % is terminal - cannot transition to %', OLD.id, OLD.status, NEW.status;
  end if;
  if v_new_rank < v_old_rank then
    raise exception 'test_assignments.% status cannot move backward from % to %', OLD.id, OLD.status, NEW.status;
  end if;

  return NEW;
end $$;
