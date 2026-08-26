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
-- OCCURRENCE GENERATION, ROUND 2 CORRECTION: the first draft of this
-- migration (and its immediate follow-up) computed candidate dates purely
-- from the SCHEDULE's own reference timezone ("today" and one adjacent day
-- in whichever direction an athlete might diverge). That is still wrong,
-- and not just cosmetically: a schedule in Pacific/Kiritimati (UTC+14)
-- targeting an athlete in America/Adak (UTC-12, ~26h behind) needs an
-- occurrence for a date that, at the athlete's own 06:00 on that date, the
-- SCHEDULE's own reference clock has already rolled a full day PAST it -
-- checking only the schedule's own "today" and "tomorrow" can never reach a
-- date that is a full day BEHIND the schedule's own current date, so this
-- occurrence would never be generated at all. Any fixed, hardcoded
-- direction/offset guessed from the schedule's own timezone has the same
-- flaw for some pair of real target timezones - the realistic worldwide
-- spread is ~26h, wider than a single "one adjacent day" guess can ever
-- safely cover in a fixed direction.
--
-- The fix: candidate dates are derived from the schedule's REAL, currently
-- resolved target athletes and each one's own REAL current local date - not
-- guessed from the schedule's own timezone at all. tests.resolve_current_
-- target_dates(p_schedule_id) below resolves the schedule's current targets
-- (the exact same union tests.resolve_schedule_target_athletes() reuses for
-- the membership snapshot), reads each one's own effective timezone
-- (coalesce(athlete.device_timezone, schedule.timezone) - the schedule's
-- timezone stays exactly what it always was: a per-athlete FALLBACK, never
-- something that determines candidate dates on its own), computes each
-- one's own real current local date, and returns the DISTINCT dates that
-- are both currently relevant (a one_time schedule only ever has ONE valid
-- date - start_date itself, generated once at least one real target is
-- actually on it; a daily/recurring schedule returns every distinct date
-- its real targets currently occupy) and inside [start_date, end_date].
-- Both backend/src/testsOccurrenceService.js's ensureCurrentOccurrence()
-- (the on-demand Today/check-in path) and testsNotificationWorker.js's own
-- occurrence-generation phase call this SAME function for this SAME
-- decision - neither one invents its own date logic anymore, so they can
-- never disagree with each other, and neither can ever generate an
-- occurrence for a date that no real target is actually on yet.
-- tests.generate_test_schedule_occurrence() itself is unchanged (still
-- generic: any (schedule_id, scheduled_date) pair, idempotent).
-- test_schedule_occurrences.opens_at/due_at/closes_at stay exactly as
-- before - a coarse, schedule-level REFERENCE window - but readers must no
-- longer treat it as a stand-in for "the" window everyone shares (see item
-- 4/coach Today below).
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
-- SNAPSHOT TIMING, ROUND 2 CORRECTION: MEMBERSHIP (which athletes this
-- schedule targets) is still frozen exactly ONCE per occurrence, into
-- tests.test_occurrence_target_snapshot below - a team member added AFTER
-- that point must never retroactively appear under this occurrence
-- (preserves the exact guarantee Phase 1 already had). But the snapshot now
-- freezes ONLY membership (occurrence_id + athlete_id) - it no longer also
-- freezes each athlete's effective_timezone at that same moment. The first
-- draft froze both together, which meant a device-timezone change AFTER the
-- membership snapshot but BEFORE that athlete's own assignment row actually
-- got inserted (a real, reachable window - the snapshot can be taken well
-- before an ahead-of-schedule athlete's own local day actually arrives) was
-- silently ignored - the stale, already-frozen zone would be used instead
-- of the athlete's real current one. Now materialize_test_assignments_for_
-- occurrence() reads each snapshotted athlete's CURRENT public.athletes.
-- device_timezone fresh, on every call, at the moment it actually decides
-- whether to insert their row - so a timezone change after the snapshot but
-- before insertion correctly uses the NEW zone, while an assignment that
-- has ALREADY been inserted is completely unaffected either way (its own
-- row's timezone/window is already fixed, and the immutability trigger
-- below forbids changing it afterward regardless of what the athlete's
-- current device_timezone says). ELIGIBILITY - whether a snapshotted
-- athlete's row gets inserted on THIS call at all - is the SAME condition
-- for both one_time and recurring/daily now (round 2 correction: the first
-- draft let a one_time schedule insert every snapshotted athlete's row
-- unconditionally, bypassing this check entirely, which contradicts "a
-- one-time date is never reinterpreted per timezone" - a one_time
-- occurrence only ever has ONE real scheduled_date, and an athlete is only
-- ever inserted once (now() at time zone their CURRENT effective_timezone)
-- ::date actually equals it): (now() at time zone effective_timezone)::date
-- = v_occurrence.scheduled_date. For daily/recurring this is exactly what
-- lets an athlete significantly ahead of the schedule's own reference
-- timezone be correctly left out of an occurrence dated before their own
-- real day, and picked up once their own local day actually reaches it -
-- without ever re-resolving membership. Each athlete's own INSERT still
-- only ever happens once (`on conflict (occurrence_id, athlete_id) do
-- nothing`), and once inserted, a DB trigger (below) makes their timezone/
-- local_scheduled_date/opens_at/due_at/closes_at genuinely immutable - not
-- just an unenforced convention.
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
  created_at timestamptz not null default now(),
  primary key (occurrence_id, athlete_id)
);

create index test_occurrence_target_snapshot_athlete_id_idx on tests.test_occurrence_target_snapshot (athlete_id);

-- The single source of truth for "which athletes does this schedule
-- currently target" - the exact same union-of-rules resolution Phase 1
-- always used (test_schedule_targets, resolved against currently-active
-- athlete_memberships for team/club targets), now factored into its own
-- function so both the membership-snapshot step below AND tests.resolve_
-- current_target_dates() (which needs the same set, to know whose local
-- dates actually matter) can never drift apart from each other.
create function tests.resolve_schedule_target_athletes(p_schedule_id uuid)
returns table(athlete_id uuid) language sql stable as $$
  select t.target_athlete_id as athlete_id
  from tests.test_schedule_targets t
  where t.schedule_id = p_schedule_id and t.target_kind = 'athlete'

  union

  select m.athlete_id
  from tests.test_schedule_targets t
  join public.athlete_memberships m
    on m.membership_type = 'team' and m.team_id = t.target_team_id and m.status = 'active'
  where t.schedule_id = p_schedule_id and t.target_kind = 'team'

  union

  select m.athlete_id
  from tests.test_schedule_targets t
  join public.athlete_memberships m
    on m.membership_type = 'club' and m.club_id = t.target_club_id and m.status = 'active'
  where t.schedule_id = p_schedule_id and t.target_kind = 'club'
$$;

-- Round 2 correction (item 1): the ONLY thing that decides which occurrence
-- date(s) a schedule currently needs - see this file's header for the full
-- reasoning and the counter-example that ruled out guessing from the
-- schedule's own timezone. Called identically by backend/src/
-- testsOccurrenceService.js's ensureCurrentOccurrence() (on-demand Today/
-- check-in path) and testsNotificationWorker.js's occurrence-generation
-- phase (item 3) - there is exactly one place this logic lives.
create function tests.resolve_current_target_dates(p_schedule_id uuid)
returns table(local_date date) language sql stable as $$
  with sch as (
    select * from tests.test_schedules where id = p_schedule_id
  ),
  per_athlete as (
    select
      (now() at time zone coalesce(a.device_timezone, sch.timezone))::date as local_date,
      sch.schedule_kind, sch.start_date, sch.end_date
    from tests.resolve_schedule_target_athletes(p_schedule_id) ta
    join public.athletes a on a.id = ta.athlete_id
    cross join sch
  )
  select distinct local_date
  from per_athlete
  where local_date >= start_date
    and (end_date is null or local_date <= end_date)
    and (schedule_kind <> 'one_time' or local_date = start_date)
$$;

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
