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
  owner_club_id uuid not null references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (num_nonnulls(test_version_id, test_battery_version_id) = 1),

  check (
    (schedule_kind = 'one_time' and recurrence_rule is null and (end_date is null or end_date = start_date))
    or
    (schedule_kind = 'recurring' and recurrence_rule is not null)
  ),
  check (
    recurrence_rule is null or (
      jsonb_typeof(recurrence_rule) = 'object'
      and recurrence_rule ? 'version'
      and (recurrence_rule ->> 'version')::int = recurrence_rule_version
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

  unique (schedule_id, target_kind, target_athlete_id, target_team_id, target_club_id)
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

  created_at timestamptz not null default now(),

  check (num_nonnulls(snapshot_test_version_id, snapshot_test_battery_version_id) = 1),
  check (opens_at <= closes_at),
  check (due_at is null or (due_at >= opens_at and due_at <= closes_at)),

  unique (schedule_id, scheduled_date)
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
  if v_schedule.status = 'cancelled' then
    raise exception 'cannot generate an occurrence for cancelled schedule %', NEW.schedule_id;
  end if;

  NEW.snapshot_test_version_id := v_schedule.test_version_id;
  NEW.snapshot_test_battery_version_id := v_schedule.test_battery_version_id;
  return NEW;
end $$;

create trigger snapshot_occurrence_test_reference
  before insert on tests.test_schedule_occurrences
  for each row execute function tests.snapshot_occurrence_test_reference();

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

  status varchar(15) not null default 'pending'
    check (status in ('pending','open','in_progress','completed','missed','excused','cancelled')),
  started_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (status in ('in_progress','completed') or started_at is null),
  check (status = 'completed' or completed_at is null),
  check (status <> 'completed' or completed_at is not null),

  unique (occurrence_id, athlete_id),
  unique (id, athlete_id) -- kompozitni FK cilj za test_assessments/test_battery_assessments ispod (garantuje da assignment.athlete_id odgovara assessment.athlete_id)
);

create index test_assignments_athlete_id_idx on tests.test_assignments (athlete_id);

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
  v_inserted_count integer;
begin
  select schedule_id into v_schedule_id from tests.test_schedule_occurrences where id = p_occurrence_id;
  if v_schedule_id is null then
    raise exception 'occurrence % does not exist', p_occurrence_id;
  end if;

  -- One-time snapshot, not an ongoing sync: if this occurrence already has
  -- ANY assignment (from a prior call), membership was already frozen then -
  -- a later call must be a pure no-op, even for a target/membership added
  -- since. This is what actually satisfies "kasnije promene članstva ne
  -- menjaju istoriju" - idempotency alone (ON CONFLICT DO NOTHING below)
  -- only stops DUPLICATES, it would still happily ADD a newly-qualifying
  -- athlete on a second call without this guard.
  if exists (select 1 from tests.test_assignments where occurrence_id = p_occurrence_id) then
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
  unique (superseded_by_assessment_id)
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
  unique (superseded_by_assessment_id),

  -- Ako je deo baterije: assignment (ako postoji) mora biti isti sportista;
  -- battery_item mora pripadati TAČNO toj battery_version_id I imati TAČNO
  -- ovaj test_version_id (garantuje "tačan battery_item").
  foreign key (battery_assessment_id, battery_version_id)
    references tests.test_battery_assessments (id, battery_version_id) on delete restrict,
  foreign key (battery_version_id, battery_item_id)
    references tests.test_battery_items (battery_version_id, id) on delete restrict,
  foreign key (test_version_id, battery_item_id)
    references tests.test_battery_items (test_version_id, id) on delete restrict
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

  unique (battery_assessment_id, test_battery_derived_parameter_id),

  foreign key (battery_assessment_id, battery_version_id)
    references tests.test_battery_assessments (id, battery_version_id) on delete cascade,
  foreign key (battery_version_id, test_battery_derived_parameter_id)
    references tests.test_battery_derived_parameters (battery_version_id, id) on delete restrict
);

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
-- ide isključivo kroz supersede lanac (nov red, status='invalidated' na
-- starom + superseded_by_assessment_id -> novi). Draft ostaje slobodno
-- izmenljiv.
create function tests.protect_completed_assessment()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    if OLD.status <> 'draft' then
      raise exception '% % has status % - completed/invalidated assessments cannot be physically deleted, use supersede instead', TG_TABLE_NAME, OLD.id, OLD.status;
    end if;
    return OLD;
  end if;

  -- TG_OP = 'UPDATE'
  if OLD.status = 'draft' then
    return NEW; -- draft je slobodno izmenljiv
  end if;

  -- Dozvoljena tranzicija: completed -> invalidated, isključivo uz
  -- postavljanje superseded_by_assessment_id u istoj izmeni.
  if OLD.status = 'completed' and NEW.status = 'invalidated' and NEW.superseded_by_assessment_id is not null then
    return NEW;
  end if;

  -- Sve ostalo na već-nedraft redu je zabranjeno (uključujući "tihu"
  -- izmenu vrednosti bez promene statusa).
  if OLD.status <> NEW.status
     or OLD.athlete_id is distinct from NEW.athlete_id
     or (TG_TABLE_NAME = 'test_assessments' and OLD.test_version_id is distinct from NEW.test_version_id)
     or (TG_TABLE_NAME = 'test_battery_assessments' and OLD.battery_version_id is distinct from NEW.battery_version_id)
     or OLD.completed_at is distinct from NEW.completed_at
  then
    if not (OLD.status = 'completed' and NEW.status = 'invalidated' and NEW.superseded_by_assessment_id is not null) then
      raise exception '% % is % - cannot be mutated except the completed->invalidated supersede transition', TG_TABLE_NAME, OLD.id, OLD.status;
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

-- Vrednosti (test_assessment_values) prate status svog roditeljskog
-- assessment-a: nepromenljive čim assessment nije više 'draft'.
create function tests.protect_completed_assessment_values()
returns trigger language plpgsql as $$
declare
  v_status varchar(15);
  v_assessment_id uuid;
begin
  v_assessment_id := coalesce(NEW.assessment_id, OLD.assessment_id);
  select status into v_status from tests.test_assessments where id = v_assessment_id;
  if v_status is distinct from 'draft' then
    raise exception 'test_assessment_values for assessment % cannot change - parent assessment status is %, not draft', v_assessment_id, v_status;
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end $$;

create trigger protect_completed_assessment_values
  before insert or update or delete on tests.test_assessment_values
  for each row execute function tests.protect_completed_assessment_values();

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
  check (auth_mode = 'personal_magic' or magic_token_hash is null),
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
  check (notification_kind not in ('athlete_invitation') or (reminder_offset_minutes is null and digest_trigger is null)),

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
  recipient_user_id uuid references public.users(id) on delete cascade,

  dedupe_key varchar(300) not null,
  status varchar(10) not null default 'pending' check (status in ('pending','sent','skipped')),

  completed_count integer,
  total_count integer,

  last_computed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (notification_kind not in ('athlete_invitation','athlete_reminder') or assignment_id is not null),
  check (notification_kind not in ('coach_digest','final_digest') or assignment_id is null),
  check (status <> 'sent' or sent_at is not null),

  unique (dedupe_key)
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
