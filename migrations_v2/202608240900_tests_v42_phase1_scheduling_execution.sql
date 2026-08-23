-- ============================================================
-- OPTIMOVE — Tests modul, Phase 1: zakazivanje, sprovođenje, rezultati,
-- pristupni linkovi i notification pravila.
--
-- Ovo NE menja Tests v4.2 katalog (migrations_v2/202608220900_tests_v42_
-- schema.sql, 202608221000_tests_v42_seed_wellness_fms.sql) - samo dodaje
-- OPERATIVNI sloj iznad njega. Katalog ostaje jedini izvor istine za ŠTA
-- je test/baterija; ove tabele beleže KADA je zakazan, KO ga sprovodi, i
-- ŠTA je stvarno izmereno.
--
-- Runner je jedini vlasnik BEGIN/COMMIT granice - ovaj fajl namerno ne
-- sadrži sopstvene transaction-control naredbe.
-- ============================================================


-- ------------------------------------------------------------
-- 1. ZAKAZIVANJE
-- ------------------------------------------------------------

-- Jedan raspored = tačno JEDNA verzija testa ili baterije (nikad oboje,
-- nikad nijedno). Vezivanje za verziju (ne za "test"/"battery" stabilan
-- entitet) je namerno - kasnija nova verzija istog testa ne menja tiho
-- šta postojeći raspored sprovodi.
create table tests.test_schedules (
  id uuid primary key default gen_random_uuid(),

  test_version_id uuid references tests.test_versions(id) on delete restrict,
  test_battery_version_id uuid references tests.test_battery_versions(id) on delete restrict,

  schedule_kind varchar(10) not null check (schedule_kind in ('one_time','recurring')),

  timezone varchar(64) not null, -- IANA naziv (npr. 'Europe/Belgrade') - validacija imena je na app sloju, Postgres CHECK ne može bezbedno da čita pg_timezone_names
  start_date date not null,
  end_date date,

  -- Strukturisano, versioned pravilo ponavljanja. Namerno minimalna
  -- validacija oblika (frequency + version) - ovo NIJE pun RRULE engine,
  -- samo ispravna, testabilna osnova (occurrence generator ispod pretvara
  -- ovo + start/end_date u konkretne datume, freq='daily'/'weekly'
  -- za sada; složenije šeme se dodaju kroz recurrence_rule_version).
  recurrence_rule jsonb,
  recurrence_rule_version integer not null default 1 check (recurrence_rule_version > 0),

  opens_time time not null,
  due_time time,
  closes_time time not null,

  status varchar(10) not null check (status in ('active','paused','cancelled')),

  created_by_user_id uuid not null references public.users(id) on delete restrict,

  -- Same owner_scope/owner_*_id pattern as tests.test/tests.test_battery -
  -- an independent coach (owner_scope='user') is a first-class case, not
  -- just club/team coaches. owner_club_id NOT NULL (an earlier version of
  -- this table) would have made an independent coach's own schedule
  -- impossible to represent.
  owner_scope varchar(20) not null check (owner_scope in ('system','club','team','user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (num_nonnulls(test_version_id, test_battery_version_id) = 1),

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
  -- Structural shape only (object, has 'freq') - the unsafe ->>'version'::int
  -- cast (a JSON boolean/object there would throw an uncontrolled generic
  -- Postgres error) and the actual version-number comparison are moved into
  -- validate_schedule_timezone_and_recurrence() below, which checks
  -- jsonb_typeof() BEFORE casting, same pattern the v4.2 schema's own
  -- validate_conditional_definition_* already uses for calculation_definition.
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

create unique index test_schedules_one_target_version_idx on tests.test_schedules (id, test_version_id);
create unique index test_schedules_one_target_battery_idx on tests.test_schedules (id, test_battery_version_id);

-- Controlled validation for the two fields a bare CHECK can't safely cover:
-- timezone (must be a real IANA name - checked against pg_timezone_names,
-- a system view, which CHECK constraints cannot query) and
-- recurrence_rule.version (must type-check as a JSON number BEFORE the
-- ::int cast, or an invalid shape throws Postgres's generic, uncontrolled
-- cast error instead of a clear validation message).
create function tests.validate_schedule_timezone_and_recurrence()
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

create trigger validate_schedule_timezone_and_recurrence
  before insert or update on tests.test_schedules
  for each row execute function tests.validate_schedule_timezone_and_recurrence();

-- Ko treba da popuni raspored - sportista direktno, ili tim/klub (koji se
-- materijalizuje u pojedinačne assignments pri generisanju occurrence-a,
-- vidi tests.materialize_test_assignments_for_occurrence niže).
create table tests.test_schedule_targets (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references tests.test_schedules(id) on delete cascade,

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

  -- NULLS NOT DISTINCT is required here - two rows both targeting the same
  -- athlete both carry target_team_id=NULL/target_club_id=NULL, and under
  -- default NULL semantics two NULLs are never "equal" for uniqueness
  -- purposes, so a plain UNIQUE would silently allow the exact same athlete/
  -- team/club to be targeted twice.
  unique nulls not distinct (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id)
);

-- Konkretna realizacija rasporeda za jedan datum. snapshot_* kolone se
-- popunjavaju automatski (trigger ispod) sa schedule-a u trenutku
-- generisanja - occurrence nikad ne zavisi od kasnije izmene na schedule
-- redu (koji se u praksi i ne menja nakon kreiranja, ali snapshot čini to
-- eksplicitnim i proverljivim, ne implicitnim).
create table tests.test_schedule_occurrences (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references tests.test_schedules(id) on delete cascade,

  scheduled_date date not null,
  opens_at timestamptz not null,
  due_at timestamptz,
  closes_at timestamptz not null,

  status varchar(10) not null default 'scheduled' check (status in ('scheduled','open','closed','cancelled')),

  snapshot_test_version_id uuid references tests.test_versions(id) on delete restrict,
  snapshot_test_battery_version_id uuid references tests.test_battery_versions(id) on delete restrict,

  -- Set exactly once by tests.materialize_test_assignments_for_occurrence()
  -- below - the canonical "have we already materialized" flag. Deliberately
  -- NOT inferred from "does this occurrence have any assignment rows",
  -- which would be wrong the moment a target genuinely resolves to zero
  -- athletes (an empty team) - that materialization still happened, and
  -- must never be allowed to run again once membership changes.
  assignments_materialized_at timestamptz,

  created_at timestamptz not null default now(),

  check (num_nonnulls(snapshot_test_version_id, snapshot_test_battery_version_id) = 1),
  check (opens_at <= closes_at),
  check (due_at is null or (due_at >= opens_at and due_at <= closes_at)),

  unique (schedule_id, scheduled_date),
  unique (id, snapshot_test_version_id),        -- kompozitni FK cilj (test_assignments ispod)
  unique (id, snapshot_test_battery_version_id)  -- kompozitni FK cilj (test_assignments ispod)
);

create index test_schedule_occurrences_snapshot_test_idx on tests.test_schedule_occurrences (snapshot_test_version_id);
create index test_schedule_occurrences_snapshot_battery_idx on tests.test_schedule_occurrences (snapshot_test_battery_version_id);

-- BEFORE INSERT: popuni snapshot_* sa roditeljskog schedule reda, i odbij
-- generisanje occurrence-a za otkazan raspored. Jedini pisac ovih kolona -
-- generisanje NIKAD ne prima snapshot vrednosti od pozivaoca.
create function tests.snapshot_occurrence_test_reference()
returns trigger language plpgsql as $$
declare
  v_schedule tests.test_schedules%rowtype;
begin
  select * into v_schedule from tests.test_schedules where id = NEW.schedule_id;
  if v_schedule.id is null then
    raise exception 'test_schedule_occurrences.schedule_id % does not reference an existing schedule', NEW.schedule_id;
  end if;
  -- Only an 'active' schedule may generate new occurrences - 'paused' must
  -- block generation exactly like 'cancelled' (a paused schedule is not
  -- currently running, not merely "cancelled but softer"); an occurrence
  -- already generated before pausing is untouched.
  if v_schedule.status <> 'active' then
    raise exception 'cannot generate an occurrence for schedule % - status is %, not active', NEW.schedule_id, v_schedule.status;
  end if;

  NEW.snapshot_test_version_id := v_schedule.test_version_id;
  NEW.snapshot_test_battery_version_id := v_schedule.test_battery_version_id;
  return NEW;
end $$;

create trigger snapshot_occurrence_test_reference
  before insert on tests.test_schedule_occurrences
  for each row execute function tests.snapshot_occurrence_test_reference();

-- Identity columns (which schedule, which date, which test/battery version)
-- are immutable after creation - only status may ever change on an
-- existing occurrence. assignments_materialized_at is separately monotonic:
-- NULL -> a timestamp exactly once (set only by
-- tests.materialize_test_assignments_for_occurrence's own UPDATE), never
-- reverted to NULL nor changed again afterward.
create function tests.protect_occurrence_identity()
returns trigger language plpgsql as $$
begin
  if NEW.schedule_id is distinct from OLD.schedule_id
     or NEW.scheduled_date is distinct from OLD.scheduled_date
     or NEW.snapshot_test_version_id is distinct from OLD.snapshot_test_version_id
     or NEW.snapshot_test_battery_version_id is distinct from OLD.snapshot_test_battery_version_id
     or NEW.opens_at is distinct from OLD.opens_at
     or NEW.due_at is distinct from OLD.due_at
     or NEW.closes_at is distinct from OLD.closes_at
  then
    raise exception 'test_schedule_occurrences.% identity/snapshot columns are immutable after creation - only status/assignments_materialized_at may change', OLD.id;
  end if;

  if OLD.assignments_materialized_at is not null
     and NEW.assignments_materialized_at is distinct from OLD.assignments_materialized_at
  then
    raise exception 'test_schedule_occurrences.% assignments_materialized_at is immutable once set (was %, attempted %)', OLD.id, OLD.assignments_materialized_at, NEW.assignments_materialized_at;
  end if;

  return NEW;
end $$;

create trigger protect_occurrence_identity
  before update on tests.test_schedule_occurrences
  for each row execute function tests.protect_occurrence_identity();

-- Idempotentan generator: (scheduled_date + schedule-ovo lokalno vreme) AT
-- TIME ZONE schedule.timezone daje tačan apsolutni trenutak bez obzira na
-- DST prelaze. ON CONFLICT na (schedule_id, scheduled_date) znači da
-- ponovljen poziv za isti datum nikad ne pravi duplikat - vraća postojeći
-- red nepromenjen.
create function tests.generate_test_schedule_occurrence(p_schedule_id uuid, p_scheduled_date date)
returns uuid language plpgsql as $$
declare
  v_schedule tests.test_schedules%rowtype;
  v_occurrence_id uuid;
begin
  select * into v_schedule from tests.test_schedules where id = p_schedule_id;
  if v_schedule.id is null then
    raise exception 'schedule % does not exist', p_schedule_id;
  end if;
  if p_scheduled_date < v_schedule.start_date or (v_schedule.end_date is not null and p_scheduled_date > v_schedule.end_date) then
    raise exception 'scheduled_date % is outside schedule %''s start_date/end_date window', p_scheduled_date, p_schedule_id;
  end if;

  insert into tests.test_schedule_occurrences (schedule_id, scheduled_date, opens_at, due_at, closes_at)
  values (
    p_schedule_id,
    p_scheduled_date,
    (p_scheduled_date + v_schedule.opens_time) at time zone v_schedule.timezone,
    case when v_schedule.due_time is null then null else (p_scheduled_date + v_schedule.due_time) at time zone v_schedule.timezone end,
    (p_scheduled_date + v_schedule.closes_time) at time zone v_schedule.timezone
  )
  on conflict (schedule_id, scheduled_date) do nothing
  returning id into v_occurrence_id;

  if v_occurrence_id is null then
    select id into v_occurrence_id from tests.test_schedule_occurrences
    where schedule_id = p_schedule_id and scheduled_date = p_scheduled_date;
  end if;
  return v_occurrence_id;
end $$;

-- Jedan sportista + jedan occurrence. Tim/klub target se materijalizuje
-- OVDE u pojedinačne redove pri generisanju (vidi funkciju ispod) - kasnija
-- promena članstva u timu/klubu nikad ne menja istoriju ko je bio
-- zadužen za već generisan occurrence.
create table tests.test_assignments (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references tests.test_schedule_occurrences(id) on delete cascade,
  athlete_id uuid not null references public.athletes(id) on delete restrict,

  -- Copied from the occurrence at INSERT time (trigger below), and
  -- FK-checked against the occurrence's OWN snapshot columns - this is what
  -- lets test_assessments/test_battery_assessments below enforce "an
  -- assignment used by a test assessment must itself be a test-kind
  -- assignment, matching the exact test_version" (and the battery
  -- equivalent) via a single composite FK, without a second join hop
  -- through test_schedule_occurrences.
  snapshot_test_version_id uuid references tests.test_versions(id) on delete restrict,
  snapshot_test_battery_version_id uuid references tests.test_battery_versions(id) on delete restrict,

  status varchar(15) not null default 'pending'
    check (status in ('pending','open','in_progress','completed','missed','excused','cancelled')),
  started_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (status in ('in_progress','completed') or started_at is null),
  check (status = 'completed' or completed_at is null),
  check (status <> 'completed' or completed_at is not null),
  check (num_nonnulls(snapshot_test_version_id, snapshot_test_battery_version_id) = 1),

  unique (occurrence_id, athlete_id),
  unique (id, athlete_id),   -- kompozitni FK cilj (assessment.athlete_id mora odgovarati)
  unique (id, occurrence_id), -- kompozitni FK cilj (notification dispatch mora biti isti occurrence)
  unique (id, snapshot_test_version_id),         -- kompozitni FK cilj (test_assessments ispod)
  unique (id, snapshot_test_battery_version_id), -- kompozitni FK cilj (test_battery_assessments ispod)

  foreign key (occurrence_id, snapshot_test_version_id)
    references tests.test_schedule_occurrences (id, snapshot_test_version_id) on delete restrict,
  foreign key (occurrence_id, snapshot_test_battery_version_id)
    references tests.test_schedule_occurrences (id, snapshot_test_battery_version_id) on delete restrict
);

create index test_assignments_athlete_id_idx on tests.test_assignments (athlete_id);
create index test_assignments_snapshot_test_version_id_idx on tests.test_assignments (snapshot_test_version_id);
create index test_assignments_snapshot_battery_version_id_idx on tests.test_assignments (snapshot_test_battery_version_id);

-- BEFORE INSERT: popuni snapshot_* sa roditeljskog occurrence-a - isti
-- obrazac kao snapshot_occurrence_test_reference() iznad. Jedini pisac ovih
-- kolona.
create function tests.snapshot_assignment_test_reference()
returns trigger language plpgsql as $$
declare
  v_occurrence tests.test_schedule_occurrences%rowtype;
begin
  select * into v_occurrence from tests.test_schedule_occurrences where id = NEW.occurrence_id;
  if v_occurrence.id is null then
    raise exception 'test_assignments.occurrence_id % does not reference an existing occurrence', NEW.occurrence_id;
  end if;
  NEW.snapshot_test_version_id := v_occurrence.snapshot_test_version_id;
  NEW.snapshot_test_battery_version_id := v_occurrence.snapshot_test_battery_version_id;
  return NEW;
end $$;

create trigger snapshot_assignment_test_reference
  before insert on tests.test_assignments
  for each row execute function tests.snapshot_assignment_test_reference();

-- Nakon INSERT-a: identitet (occurrence/athlete/snapshot verzije) je
-- nepromenljiv - isti obrazac kao protect_occurrence_identity(). Status
-- sme samo napred: pending(1) -> open(2) -> in_progress(3) -> jedno od
-- completed/missed/excused/cancelled(4, terminalno) - nikad unazad, i
-- jednom u terminalnom stanju nikad više promenjen (uključujući "completed
-- ponovo postaje pending/open/in_progress"). assignments_materialized_at
-- sme preći iz NULL u vrednost TAČNO jednom (postavlja ga isključivo
-- tests.materialize_test_assignments_for_occurrence) i nikad se posle
-- toga ne menja niti vraća na NULL.
create function tests.protect_assignment_identity_and_lifecycle()
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

create trigger protect_assignment_identity_and_lifecycle
  before update on tests.test_assignments
  for each row execute function tests.protect_assignment_identity_and_lifecycle();

-- Materijalizacija: čita postojeće tests.test_schedule_targets za occurrence-ov
-- schedule i pravi po jedan pending assignment po sportisti. Tim/klub
-- članstvo se čita iz public.athlete_memberships (postojeća tabela koju
-- backend/src/routes/organization.js već koristi za "aktivan član tima/kluba" -
-- ponovo iskorišćena ovde, ne dupliran koncept članstva).
-- ON CONFLICT DO NOTHING čini poziv idempotentnim.
create function tests.materialize_test_assignments_for_occurrence(p_occurrence_id uuid)
returns integer language plpgsql as $$
declare
  v_schedule_id uuid;
  v_already_materialized timestamptz;
  v_inserted_count integer;
begin
  -- FOR UPDATE locks this occurrence row for the rest of the transaction -
  -- a second concurrent call blocks here until the first commits, then sees
  -- assignments_materialized_at already set and returns 0. This is what
  -- guarantees two parallel calls converge on the SAME final snapshot,
  -- rather than both racing to insert.
  select schedule_id, assignments_materialized_at into v_schedule_id, v_already_materialized
  from tests.test_schedule_occurrences where id = p_occurrence_id for update;
  if v_schedule_id is null then
    raise exception 'occurrence % does not exist', p_occurrence_id;
  end if;

  -- One-time snapshot, not an ongoing sync. assignments_materialized_at -
  -- not "does this occurrence already have any assignment row" - is the
  -- canonical guard: a target that genuinely resolves to zero athletes
  -- (an empty team) must still count as "materialization happened", or a
  -- team member added afterward would wrongly slip into a re-run.
  if v_already_materialized is not null then
    return 0;
  end if;

  with target_athletes as (
    select t.target_athlete_id as athlete_id
    from tests.test_schedule_targets t
    where t.schedule_id = v_schedule_id and t.target_kind = 'athlete'

    union

    select m.athlete_id
    from tests.test_schedule_targets t
    join public.athlete_memberships m
      on m.membership_type = 'team' and m.team_id = t.target_team_id and m.status = 'active'
    where t.schedule_id = v_schedule_id and t.target_kind = 'team'

    union

    select m.athlete_id
    from tests.test_schedule_targets t
    join public.athlete_memberships m
      on m.membership_type = 'club' and m.club_id = t.target_club_id and m.status = 'active'
    where t.schedule_id = v_schedule_id and t.target_kind = 'club'
  )
  insert into tests.test_assignments (occurrence_id, athlete_id)
  select p_occurrence_id, athlete_id from target_athletes
  on conflict (occurrence_id, athlete_id) do nothing;

  get diagnostics v_inserted_count = row_count;

  update tests.test_schedule_occurrences set assignments_materialized_at = now() where id = p_occurrence_id;

  return v_inserted_count;
end $$;


-- ------------------------------------------------------------
-- 2. SPROVOĐENJE I REZULTATI
-- ------------------------------------------------------------

-- Jedno kompletno sprovođenje baterije (npr. FMS) za jednog sportistu.
-- assignment_id je opciono - standalone sprovođenje (trener ručno unosi
-- rezultat mimo bilo kog rasporeda) mora raditi bez njega.
create table tests.test_battery_assessments (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.athletes(id) on delete restrict,
  battery_version_id uuid not null references tests.test_battery_versions(id) on delete restrict,
  assignment_id uuid references tests.test_assignments(id) on delete restrict,

  status varchar(15) not null default 'draft' check (status in ('draft','completed','invalidated')),
  started_at timestamptz,
  completed_at timestamptz,
  recorded_by_user_id uuid references public.users(id) on delete restrict,

  supersedes_assessment_id uuid references tests.test_battery_assessments(id) on delete restrict,
  superseded_by_assessment_id uuid references tests.test_battery_assessments(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- draft never has completed_at; completed always does. invalidated is
  -- reached ONLY from completed (via the supersede trigger below) and
  -- deliberately keeps its original completed_at as history - not
  -- constrained here.
  check (status <> 'draft' or completed_at is null),
  check (status <> 'completed' or completed_at is not null),
  check (supersedes_assessment_id is null or supersedes_assessment_id <> id),
  check (superseded_by_assessment_id is null or superseded_by_assessment_id <> id),
  check (status = 'invalidated' or superseded_by_assessment_id is null),

  unique (id, athlete_id),      -- kompozitni FK cilj (test_assessment_evaluations, itd.)
  unique (id, battery_version_id), -- kompozitni FK cilj (test_battery_assessment_derived_results)
  unique (id, assignment_id),  -- kompozitni FK cilj (test_assessments ispod - item mora naslediti IST assignment)
  unique (supersedes_assessment_id),   -- najviše jedan naslednik po originalu
  unique (superseded_by_assessment_id), -- najviše jedan original po nasledniku

  -- Assignment (ako postoji) mora biti TEST-TIPA assignment ČIJI je
  -- snapshot_test_battery_version_id TAČNO ova battery_version_id - sprečava
  -- battery assessment da koristi assignment namenjen standalone testu.
  foreign key (assignment_id, battery_version_id) references tests.test_assignments (id, snapshot_test_battery_version_id) on delete restrict
);

create index test_battery_assessments_athlete_id_idx on tests.test_battery_assessments (athlete_id);
create index test_battery_assessments_battery_version_id_idx on tests.test_battery_assessments (battery_version_id);
create index test_battery_assessments_assignment_id_idx on tests.test_battery_assessments (assignment_id);

-- Jedno pojedinačno sprovođenje jednog testa (CMJ, sprint, ili jedna
-- FMS komponenta unutar baterije) - može stajati samostalno, ili biti
-- jedna od stavki jedne baterije (battery_assessment_id+battery_item_id
-- postavljeni zajedno). attempt_number podržava više pokušaja istog dana
-- (CMJ x3, sprint x2, ...).
create table tests.test_assessments (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.athletes(id) on delete restrict,
  test_version_id uuid not null references tests.test_versions(id) on delete restrict,
  assignment_id uuid references tests.test_assignments(id) on delete restrict,

  battery_assessment_id uuid references tests.test_battery_assessments(id) on delete restrict,
  battery_version_id uuid references tests.test_battery_versions(id) on delete restrict,
  battery_item_id uuid references tests.test_battery_items(id) on delete restrict,

  -- NULL whenever this is a battery item (battery_assessment_id is set) -
  -- equals assignment_id only for a genuinely standalone assessment. Exists
  -- purely so the FK below can apply "assignment must be a TEST-kind
  -- assignment matching this test_version" ONLY to standalone assessments -
  -- a battery item's assignment is legitimately BATTERY-kind (its own
  -- snapshot_test_version_id is NULL by design), and that case is already
  -- fully covered by the battery_assessment_id-chained FKs below.
  standalone_assignment_id uuid generated always as (case when battery_assessment_id is null then assignment_id else null end) stored,

  attempt_number integer not null default 1 check (attempt_number > 0),
  source varchar(20) not null check (source in ('athlete_self','coach_manual','device_import','api')),
  status varchar(15) not null default 'draft' check (status in ('draft','completed','invalidated')),

  assessed_at timestamptz,
  completed_at timestamptz,
  recorded_by_user_id uuid references public.users(id) on delete restrict,
  idempotency_key varchar(200),

  supersedes_assessment_id uuid references tests.test_assessments(id) on delete restrict,
  superseded_by_assessment_id uuid references tests.test_assessments(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- battery_assessment_id/battery_version_id/battery_item_id se postavljaju
  -- SVA TRI zajedno (standalone test) ili SVA TRI null.
  check (num_nonnulls(battery_assessment_id, battery_version_id, battery_item_id) in (0, 3)),
  check (status <> 'draft' or completed_at is null),
  check (status <> 'completed' or completed_at is not null),
  check (supersedes_assessment_id is null or supersedes_assessment_id <> id),
  check (superseded_by_assessment_id is null or superseded_by_assessment_id <> id),
  check (status = 'invalidated' or superseded_by_assessment_id is null),

  unique (id, test_version_id), -- kompozitni FK cilj (test_assessment_values/derived_results)
  unique (id, athlete_id),
  unique (supersedes_assessment_id),    -- najviše jedan naslednik po originalu
  unique (superseded_by_assessment_id), -- najviše jedan original po nasledniku

  -- Ako je deo baterije: battery_item mora pripadati TAČNO toj
  -- battery_version_id I imati TAČNO ovaj test_version_id (garantuje "tačan
  -- battery_item"); item MORA imati istog sportistu kao roditeljski battery
  -- assessment; item assignment_id mora ili biti NULL ili TAČNO naslediti
  -- battery assessment-ov assignment_id (nikad neki drugi occurrence).
  foreign key (battery_assessment_id, battery_version_id)
    references tests.test_battery_assessments (id, battery_version_id) on delete restrict,
  foreign key (battery_version_id, battery_item_id)
    references tests.test_battery_items (battery_version_id, id) on delete restrict,
  foreign key (test_version_id, battery_item_id)
    references tests.test_battery_items (test_version_id, id) on delete restrict,
  foreign key (battery_assessment_id, athlete_id)
    references tests.test_battery_assessments (id, athlete_id) on delete restrict,
  foreign key (battery_assessment_id, assignment_id)
    references tests.test_battery_assessments (id, assignment_id) on delete restrict,

  -- Standalone (bez baterije): ako assignment postoji, mora biti TEST-TIPA
  -- assignment čiji je snapshot_test_version_id TAČNO ovaj test_version_id -
  -- sprečava test assessment da koristi assignment namenjen bateriji. Preko
  -- standalone_assignment_id (vidi gore) - trivijalno zadovoljeno (NULL) za
  -- battery item redove, koji taj slučaj već pokrivaju kroz
  -- battery_assessment_id-lančane FK-ove iznad.
  foreign key (standalone_assignment_id, test_version_id)
    references tests.test_assignments (id, snapshot_test_version_id) on delete restrict
);

create index test_assessments_athlete_id_idx on tests.test_assessments (athlete_id);
create index test_assessments_test_version_id_idx on tests.test_assessments (test_version_id);
create index test_assessments_assignment_id_idx on tests.test_assessments (assignment_id);
create index test_assessments_battery_assessment_id_idx on tests.test_assessments (battery_assessment_id);
-- Idempotency-key zaštita od duplog slanja - jedinstveno KADA je postavljen
-- (draft rezultati bez key-a, npr. ručni coach unos, nisu ovim ograničeni).
create unique index test_assessments_idempotency_key_idx on tests.test_assessments (idempotency_key) where idempotency_key is not null;

-- Assignment.athlete_id mora odgovarati assessment.athlete_id - sprečava
-- "popuni tuđi assignment" na DB nivou, ne samo na app nivou.
alter table tests.test_assessments
  add foreign key (assignment_id, athlete_id) references tests.test_assignments (id, athlete_id) on delete restrict;
alter table tests.test_battery_assessments
  add foreign key (assignment_id, athlete_id) references tests.test_assignments (id, athlete_id) on delete restrict;

-- Tipizirana vrednost jednog parametra jednog assessment-a. Tačno jedna od
-- value_numeric/value_boolean/value_text, tip određen parameter.value_type -
-- provereno trigerom ispod (ne CHECK, jer zahteva pogled u drugu tabelu).
create table tests.test_assessment_values (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null,
  test_version_id uuid not null,
  test_parameter_id uuid not null,

  value_numeric numeric,
  value_boolean boolean,
  value_text text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (num_nonnulls(value_numeric, value_boolean, value_text) = 1),
  check (value_numeric is null or value_numeric not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),

  unique (assessment_id, test_parameter_id),

  foreign key (assessment_id, test_version_id)
    references tests.test_assessments (id, test_version_id) on delete cascade,
  foreign key (test_version_id, test_parameter_id)
    references tests.test_parameters (test_version_id, id) on delete restrict
);

create index test_assessment_values_test_parameter_id_idx on tests.test_assessment_values (test_parameter_id);

-- Backend-računat rezultat izvedenog parametra na nivou testa (npr.
-- WELLNESS Total). Frontend nikad ne šalje ovu vrednost direktno - ovaj red
-- postoji samo kao rezultat servera koji čita test_assessment_values i
-- primenjuje tests.test_version_derived_parameters formulu (evaluator sam
-- nije deo ove faze, samo tabela za njegov rezultat).
create table tests.test_assessment_derived_results (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null,
  test_version_id uuid not null,
  test_version_derived_parameter_id uuid not null,

  result_numeric numeric,
  result_boolean boolean,
  result_text text,
  definition_version integer not null check (definition_version > 0),
  computed_at timestamptz not null default now(),

  created_at timestamptz not null default now(),

  check (num_nonnulls(result_numeric, result_boolean, result_text) = 1),
  check (result_numeric is null or result_numeric not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),

  unique (assessment_id, test_version_derived_parameter_id),

  foreign key (assessment_id, test_version_id)
    references tests.test_assessments (id, test_version_id) on delete cascade,
  foreign key (test_version_id, test_version_derived_parameter_id)
    references tests.test_version_derived_parameters (test_version_id, id) on delete restrict
);

-- Isto, na nivou baterije (npr. FMS Total).
create table tests.test_battery_assessment_derived_results (
  id uuid primary key default gen_random_uuid(),
  battery_assessment_id uuid not null,
  battery_version_id uuid not null,
  test_battery_derived_parameter_id uuid not null,

  result_numeric numeric,
  result_boolean boolean,
  result_text text,
  definition_version integer not null check (definition_version > 0),
  computed_at timestamptz not null default now(),

  created_at timestamptz not null default now(),

  check (num_nonnulls(result_numeric, result_boolean, result_text) = 1),
  check (result_numeric is null or result_numeric not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),

  unique (battery_assessment_id, test_battery_derived_parameter_id),

  foreign key (battery_assessment_id, battery_version_id)
    references tests.test_battery_assessments (id, battery_version_id) on delete cascade,
  foreign key (battery_version_id, test_battery_derived_parameter_id)
    references tests.test_battery_derived_parameters (battery_version_id, id) on delete restrict
);

-- Validira, za oba nivoa (test i battery), da: (a) typed result kolona
-- odgovara result_type stvarne derived definicije, (b) definition_version
-- na ovom redu odgovara TRENUTNOJ definition_version kolone definicije -
-- podmetnut/zastareo definition_version se odbija, ne tiho prihvata.
create function tests.validate_assessment_derived_result()
returns trigger language plpgsql as $$
declare
  v_result_type varchar(20);
  v_definition_version integer;
begin
  if TG_TABLE_NAME = 'test_assessment_derived_results' then
    select result_type, definition_version into v_result_type, v_definition_version
    from tests.test_version_derived_parameters
    where id = NEW.test_version_derived_parameter_id and test_version_id = NEW.test_version_id;
  else
    select result_type, definition_version into v_result_type, v_definition_version
    from tests.test_battery_derived_parameters
    where id = NEW.test_battery_derived_parameter_id and battery_version_id = NEW.battery_version_id;
  end if;

  if v_result_type is null then
    raise exception '% references a derived parameter definition that does not exist for this version', TG_TABLE_NAME;
  end if;

  if NEW.definition_version <> v_definition_version then
    raise exception '% definition_version (%) does not match the derived parameter''s current definition_version (%) - stale or forged definition_version', TG_TABLE_NAME, NEW.definition_version, v_definition_version;
  end if;

  if v_result_type in ('numeric','integer','ordinal') and NEW.result_numeric is null then
    raise exception '% derived parameter result_type % requires result_numeric', TG_TABLE_NAME, v_result_type;
  elsif v_result_type in ('integer','ordinal') and NEW.result_numeric <> trunc(NEW.result_numeric) then
    raise exception '% derived parameter result_type % requires a whole-number result_numeric (got %)', TG_TABLE_NAME, v_result_type, NEW.result_numeric;
  elsif v_result_type = 'boolean' and NEW.result_boolean is null then
    raise exception '% derived parameter result_type boolean requires result_boolean, not a numeric/text column', TG_TABLE_NAME;
  elsif v_result_type = 'text' and NEW.result_text is null then
    raise exception '% derived parameter result_type text requires result_text', TG_TABLE_NAME;
  end if;

  return NEW;
end $$;

create trigger validate_assessment_derived_result
  before insert or update on tests.test_assessment_derived_results
  for each row execute function tests.validate_assessment_derived_result();
create trigger validate_assessment_derived_result
  before insert or update on tests.test_battery_assessment_derived_results
  for each row execute function tests.validate_assessment_derived_result();

-- Pomoćni kompozitni unique da tumačenje ispod može da proveri da output
-- zaista pripada rule-u (originalna v4.2 šema ovo nije trebala, ne menja se
-- taj fajl - ovaj indeks se samo DODAJE ovde).
create unique index test_criteria_outputs_rule_id_id_idx on tests.test_criteria_outputs (rule_id, id);

-- Rezultat primene JEDNOG kriterijumskog pravila na JEDAN assessment (test
-- ili battery). Snapshot-uje label/boju/preporuku u trenutku tumačenja, i
-- kontekst sportiste (starost/pol/sport u tom trenutku) - kasnija izmena
-- kriterijuma ili sportistinog profila ne sme retroaktivno promeniti
-- istorijsko tumačenje. Sam evaluation engine (koji upisuje ove redove)
-- NIJE deo ove faze - ovo je samo ispravan tabelarni temelj za njega.
create table tests.test_assessment_evaluations (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid references tests.test_assessments(id) on delete cascade,
  battery_assessment_id uuid references tests.test_battery_assessments(id) on delete cascade,

  criteria_set_version_id uuid not null references tests.test_criteria_set_versions(id) on delete restrict,
  rule_id uuid not null,
  output_id uuid not null,

  evaluated_at timestamptz not null default now(),
  result_label text not null,
  result_color_code varchar(20),
  result_severity_level smallint check (result_severity_level between 0 and 5),
  result_recommendation_text text,
  athlete_context_snapshot jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  check (num_nonnulls(assessment_id, battery_assessment_id) = 1),

  foreign key (criteria_set_version_id, rule_id)
    references tests.test_criteria_rules (set_version_id, id) on delete restrict,
  foreign key (criteria_set_version_id, output_id)
    references tests.test_criteria_outputs (set_version_id, id) on delete restrict,
  foreign key (rule_id, output_id)
    references tests.test_criteria_outputs (rule_id, id) on delete restrict
);

create index test_assessment_evaluations_assessment_id_idx on tests.test_assessment_evaluations (assessment_id);
create index test_assessment_evaluations_battery_assessment_id_idx on tests.test_assessment_evaluations (battery_assessment_id);
create index test_assessment_evaluations_criteria_set_version_id_idx on tests.test_assessment_evaluations (criteria_set_version_id);

-- Sprečava tiho prepisivanje/brisanje jednom završenog rezultata - korekcija
-- ide isključivo kroz supersede lanac. Ispravan redosled (svaki korak sam po
-- sebi validan pod ovim trigerom):
--   1. INSERT naslednika sa supersedes_assessment_id = original.id (dok je
--      naslednik još 'draft' - slobodno izmenljivo).
--   2. UPDATE naslednika: status='completed' (draft->completed je uvek
--      dozvoljeno, ne dira ovaj trigerski put).
--   3. UPDATE originala: status='invalidated', superseded_by_assessment_id =
--      naslednik.id - OVAJ korak je ono što trigerski put ispod proverava:
--      lockuje i validira naslednika (mora već pokazivati nazad na
--      original, mora biti 'completed', mora imati identičan
--      athlete/test-ili-battery-verziju/assignment/battery kontekst/attempt).
-- invalidated je posle toga POTPUNO nepromenljiv (nema dalje tranzicije).
-- completed dozvoljava TAČNO tu jednu tranziciju i ništa drugo - upoređeno
-- kao ceo red (to_jsonb minus dozvoljene kolone), NULL-safe i bez ručne
-- liste kolona koja bi mogla zaostati iza šeme.
create function tests.protect_completed_assessment()
returns trigger language plpgsql as $$
declare
  v_successor record;
begin
  if TG_OP = 'DELETE' then
    if OLD.status <> 'draft' then
      raise exception '% % has status % - completed/invalidated assessments cannot be physically deleted, use supersede instead', TG_TABLE_NAME, OLD.id, OLD.status;
    end if;
    return OLD;
  end if;

  -- TG_OP = 'UPDATE'
  if OLD.status = 'draft' then
    -- Draft sme postati 'draft' (slobodno izmenljiv) ili 'completed' (kroz
    -- tests.completeTestAssessmentWithDerivedResults) - NIKAD direktno
    -- 'invalidated'. invalidated se dostiže isključivo iz completed, kroz
    -- validan supersede (provere ispod).
    if NEW.status = 'invalidated' then
      raise exception '% % is draft - cannot transition directly to invalidated, only a completed row can via a valid supersede', TG_TABLE_NAME, OLD.id;
    end if;
    return NEW;
  end if;

  if OLD.status = 'invalidated' then
    raise exception '% % is invalidated - fully immutable, no further changes of any kind are allowed', TG_TABLE_NAME, OLD.id;
  end if;

  -- OLD.status = 'completed' od ovde nadalje. Jedina dozvoljena tranzicija:
  -- invalidated + superseded_by_assessment_id postavljen u ISTOJ izmeni.
  if not (NEW.status = 'invalidated' and NEW.superseded_by_assessment_id is not null) then
    raise exception '% % is completed - cannot be mutated except the completed->invalidated supersede transition', TG_TABLE_NAME, OLD.id;
  end if;

  -- Ništa osim status/superseded_by_assessment_id/updated_at sme da se
  -- razlikuje - poređenje celog reda kao jsonb pokriva SVAKU kolonu bez
  -- ručnog nabrajanja, i NULL-safe je (IS DISTINCT FROM).
  if (to_jsonb(OLD) - 'status' - 'superseded_by_assessment_id' - 'updated_at')
     is distinct from
     (to_jsonb(NEW) - 'status' - 'superseded_by_assessment_id' - 'updated_at')
  then
    raise exception '% % supersede transition may only change status/superseded_by_assessment_id/updated_at - every other column must stay identical', TG_TABLE_NAME, OLD.id;
  end if;

  -- Lockuje i validira naslednika ATOMSKI, u istoj transakciji - sprečava
  -- trku između dva paralelna pokušaja korekcije istog originala.
  if TG_TABLE_NAME = 'test_assessments' then
    select * into v_successor from tests.test_assessments where id = NEW.superseded_by_assessment_id for update;
    if v_successor.id is null then
      raise exception 'superseded_by_assessment_id % does not reference an existing test_assessments row', NEW.superseded_by_assessment_id;
    end if;
    if v_successor.status <> 'completed' then
      raise exception 'successor % must itself be completed before it can supersede %', v_successor.id, OLD.id;
    end if;
    if v_successor.supersedes_assessment_id is distinct from OLD.id then
      raise exception 'successor % must already have supersedes_assessment_id = % (set at step 1, before this transition) - bidirectional link is not established', v_successor.id, OLD.id;
    end if;
    if v_successor.athlete_id is distinct from OLD.athlete_id
       or v_successor.test_version_id is distinct from OLD.test_version_id
       or v_successor.assignment_id is distinct from OLD.assignment_id
       or v_successor.battery_assessment_id is distinct from OLD.battery_assessment_id
       or v_successor.battery_version_id is distinct from OLD.battery_version_id
       or v_successor.battery_item_id is distinct from OLD.battery_item_id
       or v_successor.attempt_number is distinct from OLD.attempt_number
    then
      raise exception 'successor % must match predecessor %''s athlete/test_version/assignment/battery context/attempt exactly - a correction changes VALUES, never identity', v_successor.id, OLD.id;
    end if;
  elsif TG_TABLE_NAME = 'test_battery_assessments' then
    select * into v_successor from tests.test_battery_assessments where id = NEW.superseded_by_assessment_id for update;
    if v_successor.id is null then
      raise exception 'superseded_by_assessment_id % does not reference an existing test_battery_assessments row', NEW.superseded_by_assessment_id;
    end if;
    if v_successor.status <> 'completed' then
      raise exception 'successor % must itself be completed before it can supersede %', v_successor.id, OLD.id;
    end if;
    if v_successor.supersedes_assessment_id is distinct from OLD.id then
      raise exception 'successor % must already have supersedes_assessment_id = % (set at step 1, before this transition) - bidirectional link is not established', v_successor.id, OLD.id;
    end if;
    if v_successor.athlete_id is distinct from OLD.athlete_id
       or v_successor.battery_version_id is distinct from OLD.battery_version_id
       or v_successor.assignment_id is distinct from OLD.assignment_id
    then
      raise exception 'successor % must match predecessor %''s athlete/battery_version/assignment exactly - a correction changes VALUES, never identity', v_successor.id, OLD.id;
    end if;
  end if;

  return NEW;
end $$;

create trigger protect_completed_assessment
  before update or delete on tests.test_assessments
  for each row execute function tests.protect_completed_assessment();
create trigger protect_completed_assessment
  before update or delete on tests.test_battery_assessments
  for each row execute function tests.protect_completed_assessment();

-- protect_completed_assessment() iznad proverava svaki POJEDINAČNI UPDATE u
-- trenutku kad se desi (BEFORE, ne-deferred) - ali ispravan supersede je
-- DVA odvojena UPDATE-a (naslednik dobija supersedes_assessment_id +
-- completed; original dobija invalidated + superseded_by_assessment_id) i
-- ništa dosad nije sprečavalo da se transakcija commit-uje posle SAMO prvog
-- koraka - naslednik bi ostao completed sa supersedes_assessment_id, a
-- original bi i dalje bio obično completed, bez odgovarajućeg
-- superseded_by_assessment_id. Ovaj AFTER CONSTRAINT TRIGGER, DEFERRABLE
-- INITIALLY DEFERRED, se izvršava TAČNO PRE COMMIT-a i ponovo čita FINALNO
-- stanje reda (i njegovog partnera) - ako veza nije obostrano zatvorena do
-- tog trenutka, ceo COMMIT pada, bez obzira kojim redosledom su UPDATE-i
-- rađeni unutar transakcije. Uključuje i ograničenu proveru ciklusa u
-- supersedes_assessment_id lancu.
create function tests.enforce_supersede_consistency()
returns trigger language plpgsql as $$
declare
  v_row record;
  v_partner record;
  v_current uuid;
  v_visited uuid[];
  v_hops integer := 0;
begin
  if TG_TABLE_NAME = 'test_assessments' then
    select * into v_row from tests.test_assessments where id = NEW.id;
  else
    select * into v_row from tests.test_battery_assessments where id = NEW.id;
  end if;
  if v_row.id is null then
    return NEW; -- red je posle toga obrisan u istoj transakciji (draft delete) - nema šta da se proveri
  end if;

  if v_row.supersedes_assessment_id is not null then
    if TG_TABLE_NAME = 'test_assessments' then
      select * into v_partner from tests.test_assessments where id = v_row.supersedes_assessment_id;
    else
      select * into v_partner from tests.test_battery_assessments where id = v_row.supersedes_assessment_id;
    end if;
    if v_partner.id is null then
      raise exception '%.% supersedes a non-existent row %', TG_TABLE_NAME, v_row.id, v_row.supersedes_assessment_id;
    end if;
    if v_row.status <> 'completed' then
      raise exception '%.% supersedes % but is not itself completed (status=%)', TG_TABLE_NAME, v_row.id, v_partner.id, v_row.status;
    end if;
    if v_partner.status <> 'invalidated' or v_partner.superseded_by_assessment_id is distinct from v_row.id then
      raise exception '%.% claims to supersede % but that link is not reciprocated by commit time (predecessor status=%, superseded_by=%) - the supersede must fully commit or fully roll back', TG_TABLE_NAME, v_row.id, v_partner.id, v_partner.status, v_partner.superseded_by_assessment_id;
    end if;
    if v_partner.athlete_id is distinct from v_row.athlete_id
       or v_partner.assignment_id is distinct from v_row.assignment_id
       or (TG_TABLE_NAME = 'test_assessments' and (
             v_partner.test_version_id is distinct from v_row.test_version_id
             or v_partner.battery_assessment_id is distinct from v_row.battery_assessment_id
             or v_partner.battery_version_id is distinct from v_row.battery_version_id
             or v_partner.battery_item_id is distinct from v_row.battery_item_id
             or v_partner.attempt_number is distinct from v_row.attempt_number
           ))
       or (TG_TABLE_NAME = 'test_battery_assessments' and v_partner.battery_version_id is distinct from v_row.battery_version_id)
    then
      raise exception '%.% and predecessor % must share identical athlete/test-or-battery-version/assignment/battery-context/attempt', TG_TABLE_NAME, v_row.id, v_partner.id;
    end if;
  end if;

  if v_row.superseded_by_assessment_id is not null then
    if TG_TABLE_NAME = 'test_assessments' then
      select * into v_partner from tests.test_assessments where id = v_row.superseded_by_assessment_id;
    else
      select * into v_partner from tests.test_battery_assessments where id = v_row.superseded_by_assessment_id;
    end if;
    if v_partner.id is null then
      raise exception '%.% is superseded by a non-existent row %', TG_TABLE_NAME, v_row.id, v_row.superseded_by_assessment_id;
    end if;
    if v_row.status <> 'invalidated' then
      raise exception '%.% has superseded_by_assessment_id set but is not itself invalidated (status=%)', TG_TABLE_NAME, v_row.id, v_row.status;
    end if;
    if v_partner.status <> 'completed' or v_partner.supersedes_assessment_id is distinct from v_row.id then
      raise exception '%.% claims to be superseded by % but that link is not reciprocated by commit time (successor status=%, supersedes=%)', TG_TABLE_NAME, v_row.id, v_partner.id, v_partner.status, v_partner.supersedes_assessment_id;
    end if;
  end if;

  -- Ograničena provera ciklusa: prati supersedes_assessment_id lanac
  -- unazad, odbij ako se bilo koji id ponovi.
  v_current := v_row.id;
  v_visited := array[v_current];
  loop
    if TG_TABLE_NAME = 'test_assessments' then
      select supersedes_assessment_id into v_current from tests.test_assessments where id = v_current;
    else
      select supersedes_assessment_id into v_current from tests.test_battery_assessments where id = v_current;
    end if;
    exit when v_current is null;
    v_hops := v_hops + 1;
    if v_hops > 1000 then
      raise exception '%.% supersede chain exceeds 1000 hops - probable cycle', TG_TABLE_NAME, v_row.id;
    end if;
    if v_current = any(v_visited) then
      raise exception '%.% supersede chain contains a cycle at %', TG_TABLE_NAME, v_row.id, v_current;
    end if;
    v_visited := v_visited || v_current;
  end loop;

  return NEW;
end $$;

create constraint trigger enforce_supersede_consistency
  after insert or update on tests.test_assessments
  deferrable initially deferred
  for each row execute function tests.enforce_supersede_consistency();
create constraint trigger enforce_supersede_consistency
  after insert or update on tests.test_battery_assessments
  deferrable initially deferred
  for each row execute function tests.enforce_supersede_consistency();

-- Deca čiji roditelj mora biti 'draft' u trenutku pisanja: test_assessment_
-- values (roditelj = assessment_id) i oba nivoa derived rezultata
-- (test_assessment_derived_results roditelj = assessment_id,
-- test_battery_assessment_derived_results roditelj = battery_assessment_id) -
-- sve tri se pišu u istoj tranzakciji koja završava assessment DOK je on
-- još 'draft' (vidi tests.completeTestAssessmentWithDerivedResults u
-- backend/src/testAssessmentCalculations.js), a zamrzavaju se čim roditelj
-- napusti 'draft'. Na UPDATE-u proverava i STAROG i NOVOG roditelja - red
-- ne sme "pobeći" reparentovanjem (promenom assessment_id/battery_
-- assessment_id) ni SA completed/invalidated roditelja, ni NA njega.
create function tests.protect_draft_only_children()
returns trigger language plpgsql as $$
declare
  v_old_parent_id uuid;
  v_new_parent_id uuid;
  v_old_status varchar(15);
  v_new_status varchar(15);
  v_parent_table text;
begin
  v_parent_table := case TG_TABLE_NAME
    when 'test_battery_assessment_derived_results' then 'test_battery_assessments'
    else 'test_assessments'
  end;

  if TG_TABLE_NAME = 'test_assessment_values' then
    v_old_parent_id := OLD.assessment_id; v_new_parent_id := NEW.assessment_id;
  elsif TG_TABLE_NAME = 'test_assessment_derived_results' then
    v_old_parent_id := OLD.assessment_id; v_new_parent_id := NEW.assessment_id;
  elsif TG_TABLE_NAME = 'test_battery_assessment_derived_results' then
    v_old_parent_id := OLD.battery_assessment_id; v_new_parent_id := NEW.battery_assessment_id;
  end if;

  if TG_OP in ('UPDATE','DELETE') then
    execute format('select status from tests.%I where id = $1', v_parent_table) into v_old_status using v_old_parent_id;
    if v_old_status is distinct from 'draft' then
      raise exception '% row for parent % cannot change - parent (%) status is %, not draft', TG_TABLE_NAME, v_old_parent_id, v_parent_table, v_old_status;
    end if;
  end if;
  if TG_OP in ('INSERT','UPDATE') then
    execute format('select status from tests.%I where id = $1', v_parent_table) into v_new_status using v_new_parent_id;
    if v_new_status is distinct from 'draft' then
      raise exception '% row for parent % cannot change - parent (%) status is %, not draft', TG_TABLE_NAME, v_new_parent_id, v_parent_table, v_new_status;
    end if;
  end if;

  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end $$;

create trigger protect_draft_only_children
  before insert or update or delete on tests.test_assessment_values
  for each row execute function tests.protect_draft_only_children();
create trigger protect_draft_only_children
  before insert or update or delete on tests.test_assessment_derived_results
  for each row execute function tests.protect_draft_only_children();
create trigger protect_draft_only_children
  before insert or update or delete on tests.test_battery_assessment_derived_results
  for each row execute function tests.protect_draft_only_children();

-- test_assessment_evaluations su istorijski zapisi, ne "u toku" podaci kao
-- gore - po prirodi se pišu NAKON što je assessment već completed (tumače
-- konačan rezultat), pa se ne mogu ograničiti na "roditelj mora biti
-- draft". Umesto toga: write-once. INSERT je uvek dozvoljen; UPDATE i
-- DELETE su UVEK zabranjeni, bez izuzetka - što automatski pokriva i
-- reparenting (promena assessment_id/battery_assessment_id je samo
-- specijalan slučaj UPDATE-a, već obuhvaćen).
create function tests.protect_evaluation_immutability()
returns trigger language plpgsql as $$
begin
  raise exception 'test_assessment_evaluations rows are write-once history - % is not allowed on row %', TG_OP, OLD.id;
end $$;

create trigger protect_evaluation_immutability
  before update or delete on tests.test_assessment_evaluations
  for each row execute function tests.protect_evaluation_immutability();

-- Validacija tipa/opsega vrednosti u odnosu na tests.test_parameters -
-- zahteva pogled u drugu tabelu, pa je triger, ne CHECK.
create function tests.validate_assessment_value()
returns trigger language plpgsql as $$
declare
  v_value_type varchar(20);
  v_min numeric;
  v_max numeric;
  v_decimal_places integer;
begin
  select value_type, minimum_value, maximum_value, decimal_places
    into v_value_type, v_min, v_max, v_decimal_places
  from tests.test_parameters
  where id = NEW.test_parameter_id and test_version_id = NEW.test_version_id;

  if v_value_type is null then
    raise exception 'test_parameter % not found for test_version %', NEW.test_parameter_id, NEW.test_version_id;
  end if;

  if v_value_type in ('numeric','integer','ordinal') then
    if NEW.value_numeric is null then
      raise exception 'parameter % (type %) requires value_numeric', NEW.test_parameter_id, v_value_type;
    end if;
    if v_value_type in ('integer','ordinal') and NEW.value_numeric <> trunc(NEW.value_numeric) then
      raise exception 'parameter % (type %) requires a whole-number value_numeric (got %)', NEW.test_parameter_id, v_value_type, NEW.value_numeric;
    end if;
    if v_min is not null and NEW.value_numeric < v_min then
      raise exception 'parameter % value % is below minimum_value %', NEW.test_parameter_id, NEW.value_numeric, v_min;
    end if;
    if v_max is not null and NEW.value_numeric > v_max then
      raise exception 'parameter % value % is above maximum_value %', NEW.test_parameter_id, NEW.value_numeric, v_max;
    end if;
  elsif v_value_type = 'boolean' then
    if NEW.value_boolean is null then
      raise exception 'parameter % (type boolean) requires value_boolean', NEW.test_parameter_id;
    end if;
  elsif v_value_type = 'text' then
    if NEW.value_text is null then
      raise exception 'parameter % (type text) requires value_text', NEW.test_parameter_id;
    end if;
  end if;

  return NEW;
end $$;

create trigger validate_assessment_value
  before insert or update on tests.test_assessment_values
  for each row execute function tests.validate_assessment_value();


-- ------------------------------------------------------------
-- 3. PRISTUPNI LINKOVI
-- ------------------------------------------------------------

-- Generički pristupni link: za trajan schedule link (npr. "Daily WELLNESS"
-- grupni link), za jedan konkretan occurrence, ili (budući) za jednog
-- sportistu (assignment link). public_token je uvek prisutan i NIJE tajna -
-- to je samo ruta do ovog reda (spec: "authenticated_group link može imati
-- nasumični javni opaque ID jer sam link nije autorizacija" - prijava je
-- autorizacija, ne posedovanje URL-a). magic_token_hash je REZERVISANO za
-- budući personal_magic mod - čuva se samo heš pravog tajnog tokena, nikad
-- sam token; login-bypass logika se NE implementira u ovoj fazi.
create table tests.test_access_links (
  id uuid primary key default gen_random_uuid(),

  link_kind varchar(12) not null check (link_kind in ('schedule','occurrence','assignment')),
  schedule_id uuid references tests.test_schedules(id) on delete cascade,
  occurrence_id uuid references tests.test_schedule_occurrences(id) on delete cascade,
  assignment_id uuid references tests.test_assignments(id) on delete cascade,

  auth_mode varchar(20) not null check (auth_mode in ('authenticated_group','personal_magic')),
  public_token varchar(64) not null unique,
  magic_token_hash varchar(128),

  status varchar(10) not null default 'active' check (status in ('active','revoked','expired')),
  created_by_user_id uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid references public.users(id) on delete restrict,
  rotated_from_link_id uuid references tests.test_access_links(id) on delete set null,

  check (
    (link_kind = 'schedule'   and schedule_id is not null and occurrence_id is null and assignment_id is null) or
    (link_kind = 'occurrence' and occurrence_id is not null and schedule_id is null and assignment_id is null) or
    (link_kind = 'assignment' and assignment_id is not null and schedule_id is null and occurrence_id is null)
  ),
  -- iff: personal_magic ZAHTEVA hash, authenticated_group ga MORA imati NULL
  -- (ranija verzija je samo zabranjivala hash za authenticated_group, ali
  -- nije zahtevala da personal_magic zaista ima jedan).
  check ((auth_mode = 'personal_magic') = (magic_token_hash is not null)),
  -- personal_magic je rezervisan isključivo za assignment link (budući lični
  -- link jednog sportiste) - schedule/occurrence linkovi ostaju
  -- authenticated_group samo.
  check (auth_mode <> 'personal_magic' or link_kind = 'assignment'),
  check (rotated_from_link_id is null or rotated_from_link_id <> id),
  check (
    (status = 'revoked' and revoked_at is not null and revoked_by_user_id is not null) or
    (status <> 'revoked' and revoked_at is null and revoked_by_user_id is null)
  )
);

create index test_access_links_schedule_id_idx on tests.test_access_links (schedule_id);
create index test_access_links_occurrence_id_idx on tests.test_access_links (occurrence_id);
create index test_access_links_assignment_id_idx on tests.test_access_links (assignment_id);
-- Aktivan link po ciljnom redu - dozvoljava istoriju opozvanih/isteklih, ali
-- najviše jedan AKTIVAN u datom trenutku po (schedule/occurrence/assignment).
create unique index test_access_links_one_active_per_schedule on tests.test_access_links (schedule_id) where status = 'active' and link_kind = 'schedule';
create unique index test_access_links_one_active_per_occurrence on tests.test_access_links (occurrence_id) where status = 'active' and link_kind = 'occurrence';
create unique index test_access_links_one_active_per_assignment on tests.test_access_links (assignment_id) where status = 'active' and link_kind = 'assignment';


-- ------------------------------------------------------------
-- 4. NOTIFICATION PRAVILA (dedupe/agregacija za buduću dostavu)
-- ------------------------------------------------------------
--
-- public.app_notifications (backend/src/routes/notifications.js) je
-- postojeći generički per-recipient inbox - NIJE dupliran ovde. Ono što mu
-- nedostaje za ovaj slučaj (agregacija: JEDNA ažurirana notifikacija
-- trenera po occurrence-u, ne jedna po sportisti) rešava se OVIM dedupe
-- redom, upisanim od strane budućeg workera PRE nego što taj worker
-- upiše/ažurira samu app_notifications poruku preko dedupe_key upsert-a.
-- Stvarni worker/slanje NIJE deo ove faze.

create table tests.test_schedule_notification_rules (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references tests.test_schedules(id) on delete cascade,
  notification_kind varchar(20) not null
    check (notification_kind in ('athlete_invitation','athlete_reminder','coach_digest','final_digest')),
  enabled boolean not null default true,

  -- Samo za athlete_reminder: koliko minuta pre due_at/closes_at da
  -- podseti - i SAMO ako assignment još nije 'completed' (runtime uslov,
  -- proverava se u trenutku slanja, ne ovde).
  reminder_offset_minutes integer check (reminder_offset_minutes is null or reminder_offset_minutes > 0),
  -- Samo za coach_digest/final_digest: kad se agregat preračunava/šalje.
  digest_trigger varchar(20) check (digest_trigger is null or digest_trigger in ('on_open','on_close','periodic')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (notification_kind <> 'athlete_reminder' or reminder_offset_minutes is not null),
  check (notification_kind not in ('coach_digest','final_digest') or digest_trigger is not null),
  -- Athlete-kind pravila (invitation/reminder) nikad ne smeju imati digest
  -- polja; digest-kind pravila (coach_digest/final_digest) nikad ne smeju
  -- imati reminder_offset_minutes. Ranija verzija je ovo proveravala samo
  -- za athlete_invitation, ostavljajući athlete_reminder+digest_trigger i
  -- coach_digest/final_digest+reminder_offset_minutes nekontrolisane.
  check (notification_kind not in ('athlete_invitation','athlete_reminder') or digest_trigger is null),
  check (notification_kind not in ('coach_digest','final_digest') or reminder_offset_minutes is null),

  unique (schedule_id, notification_kind)
);

-- Dedupe/agregacija stanje po (occurrence, notification_kind, primalac).
-- dedupe_key je UNIKATAN - budući worker uvek radi
-- INSERT ... ON CONFLICT (dedupe_key) DO UPDATE, nikad plain INSERT, pa
-- trener za jedan occurrence uvek ima TAČNO jedan red koji se osvežava
-- (npr. "17/25 completed"), ne novi red po sportisti. completed_count/
-- total_count se računaju iz tests.test_assignments (izvor istine), ne
-- čuvaju se kao nezavisna promenljiva stanje.
create table tests.test_schedule_notification_dispatches (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references tests.test_schedule_occurrences(id) on delete cascade,
  assignment_id uuid references tests.test_assignments(id) on delete cascade,
  notification_kind varchar(20) not null
    check (notification_kind in ('athlete_invitation','athlete_reminder','coach_digest','final_digest')),
  recipient_user_id uuid not null references public.users(id) on delete cascade,

  dedupe_key varchar(300) not null,
  status varchar(10) not null default 'pending' check (status in ('pending','sent','skipped')),

  completed_count integer check (completed_count is null or completed_count >= 0),
  total_count integer check (total_count is null or total_count >= 0),

  last_computed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (notification_kind not in ('athlete_invitation','athlete_reminder') or assignment_id is not null),
  check (notification_kind not in ('coach_digest','final_digest') or assignment_id is null),
  check (status <> 'sent' or sent_at is not null),
  check (completed_count is null or total_count is null or completed_count <= total_count),

  unique (dedupe_key),
  -- Belt-and-suspenders na dedupe_key konvenciju: bez obzira kako worker
  -- sastavi dedupe_key, DB nivo garantuje najviše jedan digest red po
  -- (occurrence, kind, primalac) - "17/25 completed" red za jednog trenera
  -- na jednom occurrence-u fizički ne može da se udvostruči.
  unique (occurrence_id, notification_kind, recipient_user_id),

  -- Assignment (ako postoji) mora pripadati ISTOM occurrence-u kao dispatch -
  -- sprečava dispatch red da referencira assignment sa drugog occurrence-a.
  foreign key (assignment_id, occurrence_id) references tests.test_assignments (id, occurrence_id) on delete cascade
);

create index test_schedule_notification_dispatches_occurrence_id_idx on tests.test_schedule_notification_dispatches (occurrence_id);
create index test_schedule_notification_dispatches_assignment_id_idx on tests.test_schedule_notification_dispatches (assignment_id);
create index test_schedule_notification_dispatches_recipient_id_idx on tests.test_schedule_notification_dispatches (recipient_user_id);


-- ------------------------------------------------------------
-- 5. PREOSTALI FK INDEKSI
-- ------------------------------------------------------------
-- (Composite unique indexes above already cover the FK columns that lead
-- them - e.g. unique(occurrence_id, athlete_id) already indexes lookups by
-- occurrence_id alone. These cover every remaining FK column that isn't
-- already the leading column of some other index/constraint above.)

create index test_schedules_test_version_id_idx on tests.test_schedules (test_version_id);
create index test_schedules_test_battery_version_id_idx on tests.test_schedules (test_battery_version_id);
create index test_schedules_created_by_user_id_idx on tests.test_schedules (created_by_user_id);
create index test_schedules_owner_club_id_idx on tests.test_schedules (owner_club_id);
create index test_schedules_owner_team_id_idx on tests.test_schedules (owner_team_id);

create index test_schedule_targets_schedule_id_idx on tests.test_schedule_targets (schedule_id);
create index test_schedule_targets_athlete_id_idx on tests.test_schedule_targets (target_athlete_id);
create index test_schedule_targets_team_id_idx on tests.test_schedule_targets (target_team_id);
create index test_schedule_targets_club_id_idx on tests.test_schedule_targets (target_club_id);

create index test_battery_assessments_supersedes_idx on tests.test_battery_assessments (supersedes_assessment_id);
create index test_battery_assessments_recorded_by_idx on tests.test_battery_assessments (recorded_by_user_id);

create index test_assessments_battery_version_id_idx on tests.test_assessments (battery_version_id);
create index test_assessments_battery_item_id_idx on tests.test_assessments (battery_item_id);
create index test_assessments_supersedes_idx on tests.test_assessments (supersedes_assessment_id);
create index test_assessments_recorded_by_idx on tests.test_assessments (recorded_by_user_id);

create index test_assessment_derived_results_derived_param_idx on tests.test_assessment_derived_results (test_version_derived_parameter_id);
create index test_battery_assessment_derived_results_derived_param_idx on tests.test_battery_assessment_derived_results (test_battery_derived_parameter_id);

create index test_assessment_evaluations_rule_id_idx on tests.test_assessment_evaluations (rule_id);
create index test_assessment_evaluations_output_id_idx on tests.test_assessment_evaluations (output_id);

create index test_access_links_rotated_from_idx on tests.test_access_links (rotated_from_link_id);
create index test_access_links_created_by_idx on tests.test_access_links (created_by_user_id);

create index test_schedule_notification_rules_schedule_id_idx on tests.test_schedule_notification_rules (schedule_id);

create index test_assessment_values_test_version_id_idx on tests.test_assessment_values (test_version_id);
create index test_assessment_derived_results_test_version_id_idx on tests.test_assessment_derived_results (test_version_id);
create index test_battery_assessment_derived_results_battery_version_id_idx on tests.test_battery_assessment_derived_results (battery_version_id);
create index test_access_links_revoked_by_idx on tests.test_access_links (revoked_by_user_id);

create index test_schedules_owner_user_id_idx on tests.test_schedules (owner_user_id);
create index test_battery_assessments_assignment_id_battery_idx on tests.test_battery_assessments (assignment_id, battery_version_id);
create index test_assessments_standalone_assignment_id_idx on tests.test_assessments (standalone_assignment_id);
