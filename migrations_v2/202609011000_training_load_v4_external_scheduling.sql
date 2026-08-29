-- ============================================================
-- OPTIMOVE — Training load (RPE/sRPE) v4: RPE sessions scheduled OUTSIDE
-- any Weekly plan (national-team camp, an individual gym session, rehab,
-- an extra team session never entered into the Weekly plan). Purely
-- additive - does not touch plans.* or the two already-deployed
-- training_load migrations' own statements.
--
-- ------------------------------------------------------------
-- Design: mirrors the proven WELLNESS scheduling engine (tests.* schema -
-- test_schedules/test_schedule_occurrences/test_assignments), NOT its
-- tables. Every function here reads only shared public.* tables
-- (athletes, athlete_memberships, clubs, teams, users) - training_load
-- never queries a tests.* relation. This is "reuse the PATTERN, never the
-- SCHEMA", carried through at the function level, not just the table
-- level.
--
-- Three real bugs were found and fixed across several WELLNESS migrations
-- before it reached its current, correct shape - this file starts from
-- that already-corrected end state rather than reintroducing any of them:
--
-- 1. TIMEZONE CANDIDATE-DATE BUG (the one that matters most). An early
--    WELLNESS draft computed which calendar dates need a new occurrence by
--    guessing "today, plus one adjacent day" in the SCHEDULE's own
--    reference timezone. That is provably wrong: a schedule in
--    Pacific/Kiritimati (UTC+14) targeting an athlete in America/Adak
--    (UTC-12, ~26h behind) needs an occurrence for a date that, by the
--    time it's morning for that athlete, the schedule's own clock has
--    already rolled a FULL DAY PAST - no fixed direction/offset guessed
--    from the schedule's own zone can ever safely cover the realistic
--    ~26h worldwide spread. The fix (and what this file starts with):
--    candidate dates are derived from the schedule's REAL RESOLVED TARGET
--    ATHLETES' OWN current local dates (resolve_current_external_target_
--    dates below), never from the schedule's own timezone at all - the
--    schedule's timezone is only ever a FALLBACK for an athlete with no
--    device_timezone of their own. A specific scheduled_date is the SAME
--    calendar-date value for every athlete under an occurrence (never
--    reinterpreted per timezone); only the WALL-CLOCK opens_time/
--    due_time/closes_time is evaluated in each athlete's own IANA
--    timezone to produce THAT athlete's own absolute opens_at/due_at/
--    closes_at (on external_assignments, never shared across athletes).
-- 2. LOCK-ORDER BUG. generate_test_schedule_occurrence() originally read
--    its parent schedule row UNLOCKED, so a concurrent DELETE/PATCH
--    (which DOES take FOR UPDATE) couldn't actually be blocked by it - the
--    lock was one-sided and therefore useless. Fixed here from the start:
--    generate_external_schedule_occurrence()'s own first statement takes
--    FOR SHARE on the parent schedule row.
-- 3. GENERATED-COLUMN-INSIDE-BEFORE-TRIGGER BUG (same lesson as this
--    project's own 202608250901_..._supersede_generated_column_fix.sql
--    and 202608320900's own srpe exclusion) - not directly applicable
--    here since nothing in this file has a GENERATED column, but the
--    immutability triggers below are written with the same discipline:
--    every column they guard is a real, directly-read column, never one
--    whose NEW value could read as unevaluated inside a BEFORE trigger.
--
-- Membership snapshot vs. assignment are deliberately TWO separate
-- concepts/tables (external_occurrence_target_snapshot vs.
-- external_assignments): "who was ever eligible for this occurrence" is
-- frozen once, but "who has actually been given a slot" grows over time
-- as each snapshotted athlete's own local day arrives - conflating the two
-- into one flag/table was never safe (see resolve_current_external_
-- target_dates' own from_outstanding_snapshot branch below).
-- ============================================================

-- ------------------------------------------------------------
-- 1. external_schedules - the "recipe": who/when/what label, no catalog
--    concept (unlike a WELLNESS schedule, this never points at "what to
--    administer" - it's purely a labeled event).
-- ------------------------------------------------------------
create table training_load.external_schedules (
  id uuid primary key default gen_random_uuid(),

  schedule_kind varchar(10) not null check (schedule_kind in ('one_time','recurring')),

  -- IANA fallback for an athlete with no device_timezone of their own;
  -- validated by trigger below, not a CHECK (a CHECK cannot query
  -- pg_timezone_names).
  timezone varchar(64) not null,
  start_date date not null,
  end_date date,

  recurrence_rule jsonb,
  recurrence_rule_version integer not null default 1 check (recurrence_rule_version > 0),

  opens_time time not null,
  due_time time,
  closes_time time not null,

  status varchar(10) not null default 'active' check (status in ('active','paused','cancelled')),

  event_name text not null check (char_length(event_name) between 1 and 120),
  event_note text check (event_note is null or char_length(event_note) <= 500),

  created_by_user_id uuid not null references public.users(id) on delete restrict,

  owner_scope varchar(20) not null check (owner_scope in ('system','club','team','user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  ),

  check (
    (schedule_kind = 'one_time' and recurrence_rule is null and (end_date is null or end_date = start_date))
    or
    (schedule_kind = 'recurring' and recurrence_rule is not null)
  ),
  -- Structural-shape-only CHECK - the unsafe recurrence_rule->>'version'
  -- cast is done defensively in the trigger below (jsonb_typeof checked
  -- first), same pattern tests.* already established.
  check (
    recurrence_rule is null or (
      jsonb_typeof(recurrence_rule) = 'object'
      and recurrence_rule ? 'freq'
      and recurrence_rule ->> 'freq' in ('daily','weekly','monthly')
    )
  ),
  check (end_date is null or end_date >= start_date),
  check (opens_time <= closes_time),
  check (due_time is null or (due_time >= opens_time and due_time <= closes_time)),

  foreign key (owner_team_id, owner_club_id) references public.teams (id, club_id)
);

create function training_load.validate_external_schedule_timezone_and_recurrence()
returns trigger language plpgsql as $$
declare
  v_version jsonb;
begin
  if not exists (select 1 from pg_timezone_names where name = NEW.timezone) then
    raise exception 'timezone % is not a recognized IANA timezone name', NEW.timezone;
  end if;
  if NEW.recurrence_rule is not null then
    v_version := NEW.recurrence_rule -> 'version';
    if v_version is null or jsonb_typeof(v_version) is distinct from 'number' then
      raise exception 'recurrence_rule.version must be a JSON number';
    end if;
    if (v_version #>> '{}')::numeric <> NEW.recurrence_rule_version then
      raise exception 'recurrence_rule.version (%) must match recurrence_rule_version column (%)', v_version, NEW.recurrence_rule_version;
    end if;
  end if;
  return NEW;
end $$;

create trigger validate_external_schedule_timezone_and_recurrence
  before insert or update on training_load.external_schedules
  for each row execute function training_load.validate_external_schedule_timezone_and_recurrence();

-- ------------------------------------------------------------
-- 2. external_schedule_targets - who to assign (athlete/team/club),
--    resolved to individual athletes only at materialization time.
-- ------------------------------------------------------------
create table training_load.external_schedule_targets (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references training_load.external_schedules(id) on delete cascade,

  target_kind varchar(10) not null check (target_kind in ('athlete','team','club')),
  target_athlete_id uuid references public.athletes(id) on delete restrict,
  target_team_id uuid references public.teams(id) on delete restrict,
  target_club_id uuid references public.clubs(id) on delete restrict,

  created_at timestamptz not null default now(),

  check (
    (target_kind = 'athlete' and target_athlete_id is not null and target_team_id is null and target_club_id is null) or
    (target_kind = 'team'    and target_team_id is not null and target_athlete_id is null and target_club_id is null) or
    (target_kind = 'club'    and target_club_id is not null and target_athlete_id is null and target_team_id is null)
  ),

  -- NULLS NOT DISTINCT: a plain UNIQUE would never catch a duplicate
  -- athlete target - two rows both have target_team_id/target_club_id
  -- NULL, and default NULL semantics never treat two NULLs as equal.
  unique nulls not distinct (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id)
);

-- ------------------------------------------------------------
-- 3. external_schedule_occurrences - one realized calendar date for a
--    schedule. opens_at/due_at/closes_at here are a schedule-level
--    REFERENCE window only - never authoritative for a submit decision
--    (see external_assignments' own per-athlete window below).
-- ------------------------------------------------------------
create table training_load.external_schedule_occurrences (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references training_load.external_schedules(id) on delete cascade,

  scheduled_date date not null,
  opens_at timestamptz not null,
  due_at timestamptz,
  closes_at timestamptz not null,

  status varchar(10) not null default 'scheduled' check (status in ('scheduled','open','closed','cancelled')),

  -- Monotonic NULL -> timestamp exactly once. Means "the membership
  -- snapshot was taken", NOT "every assignment got inserted" - a target
  -- that resolves to zero currently-eligible athletes still counts as
  -- materialized (mirrors WELLNESS's own phase4 redefinition).
  assignments_materialized_at timestamptz,

  created_at timestamptz not null default now(),

  check (opens_at <= closes_at),
  check (due_at is null or (due_at >= opens_at and due_at <= closes_at)),

  -- The idempotency key for occurrence generation.
  unique (schedule_id, scheduled_date)
);

create function training_load.protect_external_occurrence_identity()
returns trigger language plpgsql as $$
begin
  if NEW.schedule_id is distinct from OLD.schedule_id
     or NEW.scheduled_date is distinct from OLD.scheduled_date
     or NEW.opens_at is distinct from OLD.opens_at
     or NEW.due_at is distinct from OLD.due_at
     or NEW.closes_at is distinct from OLD.closes_at
  then
    raise exception 'training_load.external_schedule_occurrences.% identity/window columns are immutable after creation - only status/assignments_materialized_at may change', OLD.id;
  end if;
  if OLD.assignments_materialized_at is not null
     and NEW.assignments_materialized_at is distinct from OLD.assignments_materialized_at
  then
    raise exception 'training_load.external_schedule_occurrences.% assignments_materialized_at is immutable once set', OLD.id;
  end if;
  return NEW;
end $$;

create trigger protect_external_occurrence_identity
  before update on training_load.external_schedule_occurrences
  for each row execute function training_load.protect_external_occurrence_identity();

-- Idempotent occurrence generator. FOR SHARE on the parent schedule as its
-- own FIRST statement - see this file's header, bug #2.
create function training_load.generate_external_schedule_occurrence(p_schedule_id uuid, p_scheduled_date date)
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
  if p_scheduled_date < v_schedule.start_date or (v_schedule.end_date is not null and p_scheduled_date > v_schedule.end_date) then
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

-- ------------------------------------------------------------
-- 4. Membership snapshot - deliberately separate from assignments (see
--    this file's header). A late joiner (added to a targeted team/club
--    AFTER this snapshot is taken) is correctly never in it - they're
--    picked up by the next occurrence generated after they joined.
-- ------------------------------------------------------------
create table training_load.external_occurrence_target_snapshot (
  occurrence_id uuid not null references training_load.external_schedule_occurrences(id) on delete cascade,
  athlete_id uuid not null references public.athletes(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (occurrence_id, athlete_id)
);

create index external_occurrence_target_snapshot_athlete_id_idx on training_load.external_occurrence_target_snapshot (athlete_id);

-- Shared by both snapshot insertion (below) and date resolution (below) -
-- so the two can never resolve a different athlete set for the same
-- schedule.
create function training_load.resolve_external_schedule_target_athletes(p_schedule_id uuid)
returns table(athlete_id uuid) language sql stable as $$
  select t.target_athlete_id as athlete_id
  from training_load.external_schedule_targets t
  where t.schedule_id = p_schedule_id and t.target_kind = 'athlete'
  union
  select m.athlete_id
  from training_load.external_schedule_targets t
  join public.athlete_memberships m on m.membership_type = 'team' and m.team_id = t.target_team_id and m.status = 'active'
  where t.schedule_id = p_schedule_id and t.target_kind = 'team'
  union
  select m.athlete_id
  from training_load.external_schedule_targets t
  join public.athlete_memberships m on m.membership_type = 'club' and m.club_id = t.target_club_id and m.status = 'active'
  where t.schedule_id = p_schedule_id and t.target_kind = 'club'
$$;

-- ------------------------------------------------------------
-- 5. external_assignments - one athlete + one occurrence, with its OWN
--    frozen-at-insert timezone/local_scheduled_date/opens_at/due_at/
--    closes_at (never re-derived, never shared across athletes under the
--    same occurrence). Defined BEFORE resolve_current_external_target_
--    dates below, which references it.
-- ------------------------------------------------------------
create table training_load.external_assignments (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references training_load.external_schedule_occurrences(id) on delete cascade,
  athlete_id uuid not null references public.athletes(id) on delete restrict,

  status varchar(15) not null default 'pending'
    check (status in ('pending','open','in_progress','completed','missed','excused','cancelled')),
  started_at timestamptz,
  completed_at timestamptz,

  timezone varchar(64) not null,
  local_scheduled_date date not null,
  opens_at timestamptz not null,
  due_at timestamptz,
  closes_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (status in ('in_progress','completed') or started_at is null),
  check (status = 'completed' or completed_at is null),
  check (status <> 'completed' or completed_at is not null),
  check (opens_at <= closes_at),
  check (due_at is null or (due_at >= opens_at and due_at <= closes_at)),

  -- The per-athlete idempotency key for materialization.
  unique (occurrence_id, athlete_id)
);

create index external_assignments_athlete_id_idx on training_load.external_assignments (athlete_id);

create function training_load.protect_external_assignment_identity_and_lifecycle()
returns trigger language plpgsql as $$
declare v_old_rank integer; v_new_rank integer;
begin
  if NEW.occurrence_id is distinct from OLD.occurrence_id or NEW.athlete_id is distinct from OLD.athlete_id then
    raise exception 'training_load.external_assignments.% identity columns are immutable after creation', OLD.id;
  end if;
  if NEW.timezone is distinct from OLD.timezone
     or NEW.local_scheduled_date is distinct from OLD.local_scheduled_date
     or NEW.opens_at is distinct from OLD.opens_at
     or NEW.due_at is distinct from OLD.due_at
     or NEW.closes_at is distinct from OLD.closes_at
  then
    raise exception 'training_load.external_assignments.% timezone/window is an immutable snapshot taken once at materialization', OLD.id;
  end if;
  v_old_rank := case OLD.status when 'pending' then 1 when 'open' then 2 when 'in_progress' then 3 else 4 end;
  v_new_rank := case NEW.status when 'pending' then 1 when 'open' then 2 when 'in_progress' then 3 else 4 end;
  if v_old_rank = 4 and NEW.status <> OLD.status then
    raise exception 'training_load.external_assignments.% status % is terminal', OLD.id, OLD.status;
  end if;
  if v_new_rank < v_old_rank then
    raise exception 'training_load.external_assignments.% status cannot move backward from % to %', OLD.id, OLD.status, NEW.status;
  end if;
  return NEW;
end $$;

create trigger protect_external_assignment_identity_and_lifecycle
  before update on training_load.external_assignments
  for each row execute function training_load.protect_external_assignment_identity_and_lifecycle();

-- ------------------------------------------------------------
-- 6. Candidate-date resolution - THE fix for this file's header bug #1.
--    Candidate dates come from resolved targets' OWN current local date
--    (device_timezone, falling back to the schedule's timezone), never
--    guessed from the schedule's own timezone. Also includes any
--    "outstanding snapshot" date - an athlete already snapshotted into an
--    occurrence but not yet actually materialized (their local date
--    hasn't caught up to it yet, or it did and this call simply hasn't
--    run since) - so a later membership change can never cause them to
--    be silently skipped once their local day does arrive.
-- ------------------------------------------------------------
create function training_load.resolve_current_external_target_dates(p_schedule_id uuid)
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
    where local_date >= start_date and (end_date is null or local_date <= end_date)
      and (schedule_kind <> 'one_time' or local_date = start_date)
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

-- ------------------------------------------------------------
-- 7. Materialization - snapshot membership once (guarded by
--    assignments_materialized_at IS NULL), then insert an assignment for
--    every snapshotted athlete whose FRESHLY RE-READ device_timezone
--    makes them eligible RIGHT NOW. Re-reading device_timezone fresh
--    (rather than freezing it at snapshot time) means a timezone change
--    between snapshot and actual insertion is never silently ignored;
--    once a row IS inserted, its own window becomes fully immutable via
--    the trigger above and is never re-read again.
-- ------------------------------------------------------------
create function training_load.materialize_external_assignments_for_occurrence(p_occurrence_id uuid)
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

-- No external_assessments/values table like WELLNESS's per-parameter
-- design - an RPE "result" is three scalars (rpe, durationMinutes, note),
-- nothing to normalize. It lives directly on training_load.
-- session_feedback (widened in the next migration), with
-- external_assignment_id as the FK back to this table.
