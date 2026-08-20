-- ============================================================
-- OPTIMOVE — Tests modul v4.2, migrations_v2 migracija (šema)
--
-- Sadržaj je finalni, izolovano potvrđeni v4.2 DDL
-- (optimove_tests_schema_review_v4.2.sql, sha256
-- ba585af1f0664bfb0ed2e3b036c923b290bf40f52659e78b090eb66c7d402820),
-- primenjen kroz Strategy B runner (backend/src/migrate.js). Runner je
-- jedini vlasnik BEGIN/COMMIT granice - ovaj fajl namerno ne sadrži
-- sopstvene transaction-control naredbe. Redosled izvršavanja je tačan
-- redosled u ovom fajlu, od vrha do dna.
--
-- PostgreSQL 17.5 — gen_random_uuid() je ugrađen (core od PG13).
--
-- v4 izmene u odnosu na potvrđen v3 (sha256 cc49a497925b91008edd0467017dd3d0b42d4ef20cd65846eec826a064e419eb):
--  1. calculation_method NEMA 'custom' — samo sum/average/weighted_sum/conditional.
--  2. test_parameters dobija value_type/minimum_value/maximum_value/decimal_places.
--  3. NOVO: tests.test_version_derived_parameters + test_version_derived_parameter_inputs
--     (derived parametar na nivou POJEDINAČNOG testa — WELLNESS Total).
--  4. PREIMENOVANO+PROŠIRENO: test_derived_parameters → test_battery_derived_parameters,
--     test_derived_parameter_inputs → test_battery_derived_parameter_inputs
--     (+ description, calculation_definition jsonb, definition_version, result_type,
--     missing_input_behavior, parameter_key, role NOT NULL, chaining na drugi
--     battery-derived parametar).
--  5. PREIMENOVANO+GENERALIZOVANO: test_battery_item_parameters → test_battery_item_parameter_selections
--     (native ili test-derived selekcija po battery item-u).
--  6. test_criteria_set_version_sources dobija source_kind (native/test_derived).
--  7. test_criteria_conditions: uklonjen denormalizovan test_parameter_id; tri izvora sada
--     source_battery_item_parameter_selection_id / source_battery_derived_parameter_id /
--     source_declaration_id; nov triger enforce_predefined_reference_native_only
--     zamenjuje staru composite-FK proveru i staru CHECK zabranu.
--  8. Nove validacione funkcije (validate_test_version_derived_parameters,
--     validate_battery_derived_parameters + pomoćne validate_conditional_definition_*)
--     pozvane iz enforce_version_row_immutability tačno na draft->active tranziciji —
--     tipovi, operatori, role reference, cikluse (uključujući indirektne, sa "visited"
--     nizom da rekurzija ne uđe u beskonačnu petlju na pravom ciklusu).
--  9. enforce_immutable_active_version sada koristi "FOR SHARE" pri čitanju statusa
--     roditeljske verzije — sprečava race condition između publish tranzakcije i
--     paralelnog upisa child reda (obrazloženo uz funkciju niže).
--
-- v4.1 izmene u odnosu na v4 (sha256 840610546e9a14286a286261e2298765b19ffc567ddc78da36eb48bb875be319):
--  1. result_type na obe derived tabele dobija 'integer' (isti skup kao value_type).
--     Publish validator za sum/average/weighted_sum sada prihvata numeric/integer/ordinal.
--  2. validate_conditional_definition_* eksplicitno odbija nepoznat ili NULL operator
--     (dozvoljeno samo eq/neq/gt/gte/lt/lte).
--  3. Potpuna provera tipske kompatibilnosti literala sa tipom role u "when" uslovima
--     (numeric/integer/ordinal → JSON number; boolean → JSON boolean; text → JSON string;
--     value ne sme biti JSON null; boolean/text dozvoljavaju samo eq/neq).
--  4. then/else grana sa role sada razrešava STVARAN tip te role i proverava kompatibilnost
--     sa result_type (numeric/integer/ordinal kao jedna grupa, boolean i text strogo).
--     Grana ne sme imati i "constant" i "role" istovremeno.
--  5. Potpunija strukturna provera calculation_definition (JSON object na svakom nivou,
--     when ima tačno jedno od any/all, any/all neprazan niz, svaki condition je objekat) +
--     definition_version kolona mora biti 1 I calculation_definition.version mora biti 1
--     (validatorima sada prosleđen i definition_version parametar).
--  6. test_criteria_conditions.static_value/static_value_upper: numeric → jsonb. Nov triger
--     enforce_criteria_condition_value_types proverava da JSON tip literala odgovara
--     razrešenom tipu izvora (native value_type ili derived result_type), da between važi
--     samo za numeric/integer/ordinal sa lower<=upper, i da individual_history/group_reference
--     zahtevaju numerički kompatibilan izvor. text-tipizirani izvori se eksplicitno odbijaju
--     u kriterijumima za v4.1 (boolean ostaje podržan zbog WELLNESS Injury).
--  7. enforce_predefined_reference_native_only dopunjen: pored native izvora, sada zahteva
--     i da je taj native parametar numerički kompatibilan (numeric/integer/ordinal) —
--     boolean/text native izvor uz predefined_reference se odbija.
-- ============================================================

create schema if not exists tests;

-- ------------------------------------------------------------
-- 0. PODRŠKA (public šema) — nepromenjeno od v3
-- ------------------------------------------------------------

create table public.sports (
  id uuid primary key default gen_random_uuid(),
  name varchar(100) not null unique,
  created_at timestamptz not null default now()
);

create table public.sport_positions (
  id uuid primary key default gen_random_uuid(),
  sport_id uuid not null references public.sports(id) on delete restrict,
  name varchar(100) not null,
  created_at timestamptz not null default now(),
  unique (id, sport_id),
  unique (sport_id, name)
);

-- public.teams may already carry this constraint (added by an earlier,
-- unrelated migration). Check first, verify the definition matches exactly,
-- and only create it if it's genuinely missing - never drop/replace an
-- existing correct constraint, and abort loudly if a same-named constraint
-- exists with a different definition rather than silently proceeding.
do $$
declare
  v_conname text;
  v_condef text;
begin
  select con.conname, pg_get_constraintdef(con.oid)
    into v_conname, v_condef
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'teams'
    and con.conname = 'teams_id_club_id_unique';

  if v_conname is null then
    alter table public.teams
      add constraint teams_id_club_id_unique unique (id, club_id);
  elsif lower(regexp_replace(v_condef, '\s+', ' ', 'g')) = lower('UNIQUE (id, club_id)') then
    -- Already exists with exactly the expected definition - nothing to do.
    null;
  else
    raise exception 'public.teams already has a constraint named teams_id_club_id_unique, but its definition (%) does not match the expected UNIQUE (id, club_id) - refusing to proceed', v_condef;
  end if;
end $$;


-- ------------------------------------------------------------
-- 1. TEST — stabilan entitet + verzije
-- ------------------------------------------------------------

create table tests.test (
  id uuid primary key default gen_random_uuid(),

  owner_scope varchar(20) not null check (owner_scope in ('system','club','team','user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  created_by_user_id uuid references public.users(id) on delete set null,

  forked_from_test_id uuid references tests.test(id) on delete restrict,

  visibility varchar(10) not null default 'private' check (visibility in ('private','team','club','system')),
  allow_copy boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, owner_scope),
  unique (id, forked_from_test_id),

  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

create table tests.test_versions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references tests.test(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  status varchar(10) not null check (status in ('draft','active','archived')),

  previous_version_id uuid,
  previous_version_test_id uuid,
  forked_from_version_id uuid,
  forked_from_test_id uuid,

  name varchar(200) not null,
  description text,
  long_description text,
  instructions text,
  measures_multiple_sides boolean not null default false,

  published_at timestamptz,
  archived_at timestamptz,
  archived_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (test_id, version_number),
  unique (test_id, id),

  check ((previous_version_id is null) = (previous_version_test_id is null)),
  check ((version_number = 1) = (previous_version_id is null)),

  check (
    (version_number > 1 and forked_from_version_id is null and forked_from_test_id is null) or
    (version_number = 1 and forked_from_test_id is null and forked_from_version_id is null) or
    (version_number = 1 and forked_from_test_id is not null and forked_from_version_id is not null)
  ),

  check (
    (status = 'draft' and published_at is null and archived_at is null and archived_by is null) or
    (status = 'active' and published_at is not null and archived_at is null and archived_by is null) or
    (status = 'archived' and published_at is not null and archived_at is not null)
  ),

  foreign key (previous_version_test_id, previous_version_id)
    references tests.test_versions (test_id, id),
  foreign key (test_id, forked_from_test_id)
    references tests.test (id, forked_from_test_id),
  foreign key (forked_from_test_id, forked_from_version_id)
    references tests.test_versions (test_id, id)
);

create unique index test_versions_one_active
  on tests.test_versions (test_id) where status = 'active';
create unique index test_versions_one_draft
  on tests.test_versions (test_id) where status = 'draft';

-- v4: value_type/minimum_value/maximum_value/decimal_places dodati.
create table tests.test_parameters (
  id uuid primary key default gen_random_uuid(),
  test_version_id uuid not null references tests.test_versions(id) on delete cascade,
  parameter_key varchar(100),
  test_component varchar(200),
  test_specification varchar(200),
  side varchar(20),
  parameter varchar(200) not null,
  unit varchar(50),
  description text,

  value_type varchar(20) not null default 'numeric'
    check (value_type in ('numeric','integer','boolean','ordinal','text')),
  minimum_value numeric,
  maximum_value numeric,
  decimal_places integer check (decimal_places is null or decimal_places >= 0),

  created_at timestamptz not null default now(),

  unique (test_version_id, id),
  unique (test_version_id, parameter_key),

  check (minimum_value is null or maximum_value is null or minimum_value <= maximum_value),
  check (value_type not in ('boolean','text') or (minimum_value is null and maximum_value is null)),
  check (
    value_type = 'numeric' or
    (value_type in ('integer','ordinal') and (decimal_places is null or decimal_places = 0)) or
    (value_type in ('boolean','text') and decimal_places is null)
  )
);

create table tests.test_parameter_reference_values (
  id uuid primary key default gen_random_uuid(),
  test_version_id uuid not null,
  test_parameter_id uuid not null,
  reference_type varchar(10) not null check (reference_type in ('cv','sem','swc','mdc')),
  value numeric not null check (value >= 0),

  sport_id uuid references public.sports(id) on delete restrict,
  gender varchar(20) check (gender in ('male','female','any')),
  min_age_years numeric check (min_age_years is null or min_age_years >= 0),
  max_age_years numeric check (max_age_years is null or max_age_years >= 0),
  sport_position_id uuid,
  computed_from_attempts_count integer check (computed_from_attempts_count is null or computed_from_attempts_count > 0),
  protocol_note text,
  source_type varchar(20) not null check (source_type in ('literature','club_measured','vendor_provided','expert_estimate')),
  source_citation text,
  created_at timestamptz not null default now(),

  check (min_age_years is null or max_age_years is null or min_age_years <= max_age_years),
  check (sport_position_id is null or sport_id is not null),

  unique (id, test_parameter_id),

  foreign key (test_version_id, test_parameter_id)
    references tests.test_parameters (test_version_id, id) on delete cascade,
  foreign key (sport_position_id, sport_id)
    references public.sport_positions (id, sport_id)
);

-- v4 NOVO: derived parametar na nivou pojedinačnog testa (npr. WELLNESS Total).
create table tests.test_version_derived_parameters (
  id uuid primary key default gen_random_uuid(),
  test_version_id uuid not null references tests.test_versions(id) on delete cascade,
  parameter_key varchar(100) not null,
  name varchar(200) not null,
  unit varchar(50),
  description text,

  calculation_method varchar(20) not null
    check (calculation_method in ('sum','average','weighted_sum','conditional')),
  calculation_definition jsonb,
  definition_version integer not null default 1 check (definition_version > 0),
  result_type varchar(20) not null check (result_type in ('numeric','integer','boolean','ordinal','text')),
  missing_input_behavior varchar(20) not null check (missing_input_behavior in ('error','null_result')),

  created_at timestamptz not null default now(),

  check (
    (calculation_method in ('sum','average','weighted_sum') and calculation_definition is null) or
    (calculation_method = 'conditional' and calculation_definition is not null)
  ),
  check (calculation_method <> 'conditional' or (calculation_definition ? 'version')),

  unique (test_version_id, id),
  unique (test_version_id, parameter_key)
);

create table tests.test_version_derived_parameter_inputs (
  id uuid primary key default gen_random_uuid(),
  test_version_id uuid not null,
  derived_parameter_id uuid not null,
  input_source_kind varchar(20) not null check (input_source_kind in ('native','test_derived')),
  source_test_parameter_id uuid,
  source_derived_parameter_id uuid,
  role varchar(50) not null,
  -- v4.2 (tačka 6): PG17.5 dozvoljava numeric NaN/Infinity/-Infinity. Napomena:
  -- za numeric tip, PostgreSQL definiše NaN = NaN kao TRUE (radi sortiranja/
  -- indeksiranja), pa se NaN ne može odbiti sa "weight = weight"; mora se
  -- eksplicitno porediti sa NaN/Infinity/-Infinity literalima. weight=0 i
  -- negativne vrednosti ostaju dozvoljene.
  weight numeric not null default 1
    check (weight not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  sign smallint check (sign in (-1,1)) default 1,
  order_index integer check (order_index is null or order_index >= 0),
  created_at timestamptz not null default now(),

  check (
    (input_source_kind='native' and source_test_parameter_id is not null and source_derived_parameter_id is null) or
    (input_source_kind='test_derived' and source_derived_parameter_id is not null and source_test_parameter_id is null)
  ),
  check (source_derived_parameter_id is null or source_derived_parameter_id <> derived_parameter_id),
  unique (derived_parameter_id, role),

  foreign key (test_version_id, derived_parameter_id)
    references tests.test_version_derived_parameters (test_version_id, id) on delete cascade,
  foreign key (test_version_id, source_test_parameter_id)
    references tests.test_parameters (test_version_id, id) on delete restrict,
  foreign key (test_version_id, source_derived_parameter_id)
    references tests.test_version_derived_parameters (test_version_id, id) on delete restrict
);


-- ------------------------------------------------------------
-- 2. TEST_BATTERY — stabilan entitet + verzije
-- ------------------------------------------------------------

create table tests.test_battery (
  id uuid primary key default gen_random_uuid(),

  owner_scope varchar(20) not null check (owner_scope in ('system','club','team','user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  created_by_user_id uuid references public.users(id) on delete set null,

  forked_from_battery_id uuid references tests.test_battery(id) on delete restrict,

  visibility varchar(10) not null default 'private' check (visibility in ('private','team','club','system')),
  allow_copy boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, forked_from_battery_id),

  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

create table tests.test_battery_versions (
  id uuid primary key default gen_random_uuid(),
  test_battery_id uuid not null references tests.test_battery(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  status varchar(10) not null check (status in ('draft','active','archived')),

  previous_version_id uuid,
  previous_version_test_battery_id uuid,
  forked_from_version_id uuid,
  forked_from_battery_id uuid,

  name varchar(200) not null,
  description text,
  overall_instructions text,

  published_at timestamptz,
  archived_at timestamptz,
  archived_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (test_battery_id, version_number),
  unique (test_battery_id, id),

  check ((previous_version_id is null) = (previous_version_test_battery_id is null)),
  check ((version_number = 1) = (previous_version_id is null)),

  check (
    (version_number > 1 and forked_from_version_id is null and forked_from_battery_id is null) or
    (version_number = 1 and forked_from_battery_id is null and forked_from_version_id is null) or
    (version_number = 1 and forked_from_battery_id is not null and forked_from_version_id is not null)
  ),

  check (
    (status = 'draft' and published_at is null and archived_at is null and archived_by is null) or
    (status = 'active' and published_at is not null and archived_at is null and archived_by is null) or
    (status = 'archived' and published_at is not null and archived_at is not null)
  ),

  foreign key (previous_version_test_battery_id, previous_version_id)
    references tests.test_battery_versions (test_battery_id, id),
  foreign key (test_battery_id, forked_from_battery_id)
    references tests.test_battery (id, forked_from_battery_id),
  foreign key (forked_from_battery_id, forked_from_version_id)
    references tests.test_battery_versions (test_battery_id, id)
);

create unique index test_battery_versions_one_active
  on tests.test_battery_versions (test_battery_id) where status = 'active';
create unique index test_battery_versions_one_draft
  on tests.test_battery_versions (test_battery_id) where status = 'draft';

create table tests.test_battery_items (
  id uuid primary key default gen_random_uuid(),
  battery_version_id uuid not null references tests.test_battery_versions(id) on delete cascade,
  test_version_id uuid not null references tests.test_versions(id) on delete restrict,
  order_index integer not null check (order_index >= 0),
  attempts_count integer check (attempts_count is null or attempts_count > 0),
  aggregation_method varchar(30) check (aggregation_method is null or aggregation_method in ('best','average','single','sum','last','worst')),
  instructions_override text,
  created_at timestamptz not null default now(),

  unique (battery_version_id, id),
  unique (test_version_id, id),
  unique (battery_version_id, order_index)
);

-- v4: preimenovano sa test_battery_item_parameters, generalizovano (native ili test_derived).
create table tests.test_battery_item_parameter_selections (
  id uuid primary key default gen_random_uuid(),
  battery_version_id uuid not null,
  test_version_id uuid not null,
  battery_item_id uuid not null,
  source_kind varchar(20) not null check (source_kind in ('native','test_derived')),
  test_parameter_id uuid,
  test_version_derived_parameter_id uuid,
  created_at timestamptz not null default now(),

  check (
    (source_kind='native' and test_parameter_id is not null and test_version_derived_parameter_id is null) or
    (source_kind='test_derived' and test_version_derived_parameter_id is not null and test_parameter_id is null)
  ),

  unique (battery_version_id, id),
  unique (id, test_parameter_id),
  unique (id, test_version_derived_parameter_id),
  unique (battery_item_id, test_parameter_id),
  unique (battery_item_id, test_version_derived_parameter_id),

  foreign key (battery_version_id, battery_item_id)
    references tests.test_battery_items (battery_version_id, id) on delete cascade,
  foreign key (test_version_id, battery_item_id)
    references tests.test_battery_items (test_version_id, id) on delete cascade,
  foreign key (test_version_id, test_parameter_id)
    references tests.test_parameters (test_version_id, id) on delete restrict,
  foreign key (test_version_id, test_version_derived_parameter_id)
    references tests.test_version_derived_parameters (test_version_id, id) on delete restrict
);

-- v4: preimenovano sa test_derived_parameters, prošireno.
create table tests.test_battery_derived_parameters (
  id uuid primary key default gen_random_uuid(),
  battery_version_id uuid not null references tests.test_battery_versions(id) on delete cascade,
  parameter_key varchar(100) not null,
  name varchar(200) not null,
  unit varchar(50),
  description text,

  calculation_method varchar(20) not null
    check (calculation_method in ('sum','average','weighted_sum','conditional')),
  calculation_definition jsonb,
  definition_version integer not null default 1 check (definition_version > 0),
  result_type varchar(20) not null check (result_type in ('numeric','integer','boolean','ordinal','text')),
  missing_input_behavior varchar(20) not null check (missing_input_behavior in ('error','null_result')),

  created_at timestamptz not null default now(),

  check (
    (calculation_method in ('sum','average','weighted_sum') and calculation_definition is null) or
    (calculation_method = 'conditional' and calculation_definition is not null)
  ),
  check (calculation_method <> 'conditional' or (calculation_definition ? 'version')),

  unique (battery_version_id, id),
  unique (battery_version_id, parameter_key)
);

-- v4: preimenovano sa test_derived_parameter_inputs, prošireno (role NOT NULL, chaining).
create table tests.test_battery_derived_parameter_inputs (
  id uuid primary key default gen_random_uuid(),
  battery_version_id uuid not null,
  derived_parameter_id uuid not null,
  input_source_kind varchar(40) not null
    check (input_source_kind in ('battery_item_parameter_selection','battery_derived')),
  source_battery_item_parameter_selection_id uuid,
  source_derived_parameter_id uuid,
  role varchar(50) not null,
  -- v4.2 (tačka 6): isto obrazloženje kao kod test_version_derived_parameter_inputs.weight
  -- (NaN = NaN je TRUE za numeric u PostgreSQL-u, pa se mora porediti eksplicitno).
  weight numeric not null default 1
    check (weight not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  sign smallint check (sign in (-1,1)) default 1,
  order_index integer check (order_index is null or order_index >= 0),
  created_at timestamptz not null default now(),

  check (
    (input_source_kind='battery_item_parameter_selection' and source_battery_item_parameter_selection_id is not null
       and source_derived_parameter_id is null) or
    (input_source_kind='battery_derived' and source_derived_parameter_id is not null
       and source_battery_item_parameter_selection_id is null)
  ),
  check (source_derived_parameter_id is null or source_derived_parameter_id <> derived_parameter_id),
  unique (derived_parameter_id, role),

  foreign key (battery_version_id, derived_parameter_id)
    references tests.test_battery_derived_parameters (battery_version_id, id) on delete cascade,
  foreign key (battery_version_id, source_battery_item_parameter_selection_id)
    references tests.test_battery_item_parameter_selections (battery_version_id, id) on delete restrict,
  foreign key (battery_version_id, source_derived_parameter_id)
    references tests.test_battery_derived_parameters (battery_version_id, id) on delete restrict
);


-- ------------------------------------------------------------
-- 3. TAKSONOMIJA (bez verzija) — nepromenjeno od v3
-- ------------------------------------------------------------

create table tests.test_domain (
  id uuid primary key default gen_random_uuid(),
  owner_scope varchar(20) not null check (owner_scope in ('system','club','team','user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  created_by_user_id uuid references public.users(id) on delete set null,
  name varchar(200) not null,
  description text,
  created_at timestamptz not null default now(),

  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

create table tests.test_category (
  id uuid primary key default gen_random_uuid(),
  owner_scope varchar(20) not null check (owner_scope in ('system','club','team','user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  created_by_user_id uuid references public.users(id) on delete set null,
  name varchar(200) not null,
  description text,
  created_at timestamptz not null default now(),

  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

create table tests.test_structure_links (
  id uuid primary key default gen_random_uuid(),
  owner_scope varchar(20) not null check (owner_scope in ('system','club','team','user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  created_by_user_id uuid references public.users(id) on delete set null,
  test_id uuid not null references tests.test(id) on delete cascade,
  test_domain_id uuid references tests.test_domain(id) on delete cascade,
  test_category_id uuid references tests.test_category(id) on delete cascade,
  created_at timestamptz not null default now(),

  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  ),
  check (test_domain_id is not null or test_category_id is not null)
);

create unique index test_structure_links_unique on tests.test_structure_links
  (test_id, test_domain_id, test_category_id, owner_scope, owner_user_id, owner_club_id, owner_team_id)
  nulls not distinct;


-- ------------------------------------------------------------
-- 4. KRITERIJUMI
-- ------------------------------------------------------------

create table tests.test_criteria_sets (
  id uuid primary key default gen_random_uuid(),

  owner_scope varchar(20) not null check (owner_scope in ('system','club','team','user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  created_by_user_id uuid references public.users(id) on delete set null,

  forked_from_criteria_set_id uuid references tests.test_criteria_sets(id) on delete restrict,

  visibility varchar(10) not null default 'private' check (visibility in ('private','team','club','system')),
  allow_copy boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (id, forked_from_criteria_set_id),

  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

create table tests.test_criteria_set_versions (
  id uuid primary key default gen_random_uuid(),
  criteria_set_id uuid not null references tests.test_criteria_sets(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  status varchar(10) not null check (status in ('draft','active','archived')),

  previous_version_id uuid,
  previous_version_criteria_set_id uuid,
  forked_from_version_id uuid,
  forked_from_criteria_set_id uuid,

  name varchar(200) not null,
  description text,

  battery_version_id uuid references tests.test_battery_versions(id) on delete restrict,
  minimum_age_years numeric check (minimum_age_years is null or minimum_age_years >= 0),
  maximum_age_years numeric check (maximum_age_years is null or maximum_age_years >= 0),
  gender varchar(20) check (gender is null or gender in ('male','female','any')),
  sport_id uuid references public.sports(id) on delete restrict,
  sport_position_id uuid,
  athlete_id uuid references public.athletes(id) on delete restrict,

  published_at timestamptz,
  archived_at timestamptz,
  archived_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (criteria_set_id, version_number),
  unique (criteria_set_id, id),

  check ((previous_version_id is null) = (previous_version_criteria_set_id is null)),
  check ((version_number = 1) = (previous_version_id is null)),

  check (
    (version_number > 1 and forked_from_version_id is null and forked_from_criteria_set_id is null) or
    (version_number = 1 and forked_from_criteria_set_id is null and forked_from_version_id is null) or
    (version_number = 1 and forked_from_criteria_set_id is not null and forked_from_version_id is not null)
  ),

  check (
    (status = 'draft' and published_at is null and archived_at is null and archived_by is null) or
    (status = 'active' and published_at is not null and archived_at is null and archived_by is null) or
    (status = 'archived' and published_at is not null and archived_at is not null)
  ),

  check (minimum_age_years is null or maximum_age_years is null or minimum_age_years <= maximum_age_years),
  check (sport_position_id is null or sport_id is not null),

  foreign key (previous_version_criteria_set_id, previous_version_id)
    references tests.test_criteria_set_versions (criteria_set_id, id),
  foreign key (criteria_set_id, forked_from_criteria_set_id)
    references tests.test_criteria_sets (id, forked_from_criteria_set_id),
  foreign key (forked_from_criteria_set_id, forked_from_version_id)
    references tests.test_criteria_set_versions (criteria_set_id, id),
  foreign key (sport_position_id, sport_id)
    references public.sport_positions (id, sport_id)
);

create unique index test_criteria_set_versions_one_active
  on tests.test_criteria_set_versions (criteria_set_id) where status = 'active';
create unique index test_criteria_set_versions_one_draft
  on tests.test_criteria_set_versions (criteria_set_id) where status = 'draft';

-- v4: dodat source_kind (native/test_derived) + test_derived_parameter_id.
create table tests.test_criteria_set_version_sources (
  id uuid primary key default gen_random_uuid(),
  set_version_id uuid not null references tests.test_criteria_set_versions(id) on delete cascade,
  test_version_id uuid not null,
  source_kind varchar(20) not null check (source_kind in ('native','test_derived')),
  test_parameter_id uuid,
  test_derived_parameter_id uuid,
  created_at timestamptz not null default now(),

  check (
    (source_kind='native' and test_parameter_id is not null and test_derived_parameter_id is null) or
    (source_kind='test_derived' and test_derived_parameter_id is not null and test_parameter_id is null)
  ),

  unique (set_version_id, id),
  unique (id, test_parameter_id),
  unique (id, test_derived_parameter_id),
  unique (set_version_id, test_parameter_id),
  unique (set_version_id, test_derived_parameter_id),

  foreign key (test_version_id, test_parameter_id)
    references tests.test_parameters (test_version_id, id) on delete restrict,
  foreign key (test_version_id, test_derived_parameter_id)
    references tests.test_version_derived_parameters (test_version_id, id) on delete restrict
);

create table tests.test_criteria_rules (
  id uuid primary key default gen_random_uuid(),
  set_version_id uuid not null references tests.test_criteria_set_versions(id) on delete cascade,
  name varchar(200) not null,
  created_at timestamptz not null default now(),

  unique (set_version_id, id)
);

create table tests.test_criteria_outputs (
  id uuid primary key default gen_random_uuid(),
  set_version_id uuid not null,
  rule_id uuid not null,
  evaluation_order integer not null check (evaluation_order > 0),
  label text not null,
  label_short varchar(50),
  color_code varchar(20),
  severity_level smallint not null default 0 check (severity_level between 0 and 5),
  alert_required boolean not null default false,
  recommendation_text text,
  created_at timestamptz not null default now(),

  unique (set_version_id, id),
  unique (rule_id, evaluation_order),

  foreign key (set_version_id, rule_id)
    references tests.test_criteria_rules (set_version_id, id) on delete cascade
);

-- v4: uklonjen test_parameter_id; tri source kolone (battery_item_parameter_selection/
-- battery_derived/declared_source) umesto ranijih; predefined_reference se sad
-- validira isključivo trigerom enforce_predefined_reference_native_only.
create table tests.test_criteria_conditions (
  id uuid primary key default gen_random_uuid(),
  output_id uuid not null,
  set_version_id uuid not null,
  battery_version_id uuid,

  condition_group integer not null default 1 check (condition_group > 0),

  parameter_source_kind varchar(40) not null
    check (parameter_source_kind in ('battery_item_parameter_selection','battery_derived','declared_source')),
  source_battery_item_parameter_selection_id uuid,
  source_battery_derived_parameter_id uuid,
  source_declaration_id uuid,

  operator varchar(10) not null check (operator in ('lt','lte','gt','gte','eq','neq','between')),
  reference_type varchar(20) not null
    check (reference_type in ('static','predefined_reference','individual_history','group_reference','session_reference')),
  static_value jsonb,
  static_value_upper jsonb,
  reference_value_id uuid references tests.test_parameter_reference_values(id) on delete restrict,
  baseline_window_days integer check (baseline_window_days is null or baseline_window_days > 0),
  threshold_percent numeric,

  created_at timestamptz not null default now(),

  check (
    (parameter_source_kind = 'battery_item_parameter_selection' and battery_version_id is not null
       and source_battery_item_parameter_selection_id is not null
       and source_battery_derived_parameter_id is null and source_declaration_id is null) or
    (parameter_source_kind = 'battery_derived' and battery_version_id is not null
       and source_battery_derived_parameter_id is not null
       and source_battery_item_parameter_selection_id is null and source_declaration_id is null) or
    (parameter_source_kind = 'declared_source' and battery_version_id is null
       and source_declaration_id is not null
       and source_battery_item_parameter_selection_id is null and source_battery_derived_parameter_id is null)
  ),

  check (
    (reference_type = 'static' and static_value is not null and reference_value_id is null
        and baseline_window_days is null and threshold_percent is null
        and (operator <> 'between' or static_value_upper is not null)
        and (operator = 'between' or static_value_upper is null))
    or
    (reference_type = 'predefined_reference' and reference_value_id is not null and static_value is null
        and static_value_upper is null and baseline_window_days is null and threshold_percent is null)
    or
    (reference_type in ('individual_history', 'group_reference')
        and baseline_window_days is not null and threshold_percent is not null
        and static_value is null and static_value_upper is null and reference_value_id is null)
    or
    (reference_type = 'session_reference'
        and static_value is null and static_value_upper is null
        and reference_value_id is null and baseline_window_days is null and threshold_percent is null)
  ),

  -- v4.2 (tačka 3): 'between' ima smisla samo uz statične granice; bez ovoga bi
  -- reference_type in ('predefined_reference','individual_history','group_reference',
  -- 'session_reference') mogao imati operator='between' a da to ništa ne prijavi,
  -- pošto te grane u CHECK-u iznad ne ispituju operator uopšte.
  check (operator <> 'between' or reference_type = 'static'),

  foreign key (set_version_id, output_id)
    references tests.test_criteria_outputs (set_version_id, id) on delete cascade,
  foreign key (battery_version_id, source_battery_item_parameter_selection_id)
    references tests.test_battery_item_parameter_selections (battery_version_id, id) on delete restrict,
  foreign key (battery_version_id, source_battery_derived_parameter_id)
    references tests.test_battery_derived_parameters (battery_version_id, id) on delete restrict,
  foreign key (set_version_id, source_declaration_id)
    references tests.test_criteria_set_version_sources (set_version_id, id) on delete restrict
);


-- ------------------------------------------------------------
-- 5. ODOBRAVANJE BATERIJA — nepromenjeno od v3
-- ------------------------------------------------------------

create table tests.test_battery_version_approvals (
  id uuid primary key default gen_random_uuid(),
  test_battery_version_id uuid not null references tests.test_battery_versions(id) on delete restrict,
  club_id uuid not null references public.clubs(id) on delete restrict,
  team_id uuid references public.teams(id) on delete restrict,

  status varchar(12) not null check (status in ('pending','approved','rejected','revoked','cancelled')),

  requested_by_user_id uuid not null references public.users(id) on delete restrict,
  requested_at timestamptz not null default now(),
  decided_by_user_id uuid references public.users(id) on delete restrict,
  decided_at timestamptz,
  revoked_by_user_id uuid references public.users(id) on delete restrict,
  revoked_at timestamptz,
  cancelled_by_user_id uuid references public.users(id) on delete restrict,
  cancelled_at timestamptz,
  note text,

  foreign key (team_id, club_id) references public.teams (id, club_id),

  check (
    (status = 'pending' and decided_by_user_id is null and decided_at is null
                          and revoked_by_user_id is null and revoked_at is null
                          and cancelled_by_user_id is null and cancelled_at is null)
    or
    (status in ('approved','rejected') and decided_by_user_id is not null and decided_at is not null
                          and revoked_by_user_id is null and revoked_at is null
                          and cancelled_by_user_id is null and cancelled_at is null)
    or
    (status = 'revoked' and decided_by_user_id is not null and decided_at is not null
                          and revoked_by_user_id is not null and revoked_at is not null
                          and cancelled_by_user_id is null and cancelled_at is null)
    or
    (status = 'cancelled' and cancelled_by_user_id is not null and cancelled_at is not null
                          and decided_by_user_id is null and decided_at is null
                          and revoked_by_user_id is null and revoked_at is null)
  )
);

create unique index approvals_one_pending on tests.test_battery_version_approvals
  (test_battery_version_id, club_id, team_id) nulls not distinct where status = 'pending';
create unique index approvals_one_approved on tests.test_battery_version_approvals
  (test_battery_version_id, club_id, team_id) nulls not distinct where status = 'approved';


-- ------------------------------------------------------------
-- 6. INDEKSI NA FK KOLONAMA
-- ------------------------------------------------------------

create index test_owner_user_id_idx on tests.test (owner_user_id);
create index test_owner_club_id_idx on tests.test (owner_club_id);
create index test_owner_team_id_idx on tests.test (owner_team_id);
create index test_forked_from_test_id_idx on tests.test (forked_from_test_id);

create index test_version_derived_parameter_inputs_src_test_param_idx on tests.test_version_derived_parameter_inputs (source_test_parameter_id);
create index test_version_derived_parameter_inputs_src_derived_idx on tests.test_version_derived_parameter_inputs (source_derived_parameter_id);

create index test_battery_owner_user_id_idx on tests.test_battery (owner_user_id);
create index test_battery_owner_club_id_idx on tests.test_battery (owner_club_id);
create index test_battery_owner_team_id_idx on tests.test_battery (owner_team_id);
create index test_battery_forked_from_battery_id_idx on tests.test_battery (forked_from_battery_id);

create index test_battery_item_parameter_selections_test_param_idx on tests.test_battery_item_parameter_selections (test_parameter_id);
create index test_battery_item_parameter_selections_test_derived_idx on tests.test_battery_item_parameter_selections (test_version_derived_parameter_id);

create index test_battery_derived_parameter_inputs_src_selection_idx on tests.test_battery_derived_parameter_inputs (source_battery_item_parameter_selection_id);
create index test_battery_derived_parameter_inputs_src_derived_idx on tests.test_battery_derived_parameter_inputs (source_derived_parameter_id);

create index test_domain_owner_user_id_idx on tests.test_domain (owner_user_id);
create index test_domain_owner_club_id_idx on tests.test_domain (owner_club_id);
create index test_domain_owner_team_id_idx on tests.test_domain (owner_team_id);

create index test_category_owner_user_id_idx on tests.test_category (owner_user_id);
create index test_category_owner_club_id_idx on tests.test_category (owner_club_id);
create index test_category_owner_team_id_idx on tests.test_category (owner_team_id);

create index test_structure_links_domain_id_idx on tests.test_structure_links (test_domain_id);
create index test_structure_links_category_id_idx on tests.test_structure_links (test_category_id);

create index test_criteria_sets_owner_user_id_idx on tests.test_criteria_sets (owner_user_id);
create index test_criteria_sets_owner_club_id_idx on tests.test_criteria_sets (owner_club_id);
create index test_criteria_sets_owner_team_id_idx on tests.test_criteria_sets (owner_team_id);
create index test_criteria_sets_forked_from_id_idx on tests.test_criteria_sets (forked_from_criteria_set_id);

create index test_criteria_set_versions_battery_version_id_idx on tests.test_criteria_set_versions (battery_version_id);
create index test_criteria_set_versions_sport_id_idx on tests.test_criteria_set_versions (sport_id);
create index test_criteria_set_versions_athlete_id_idx on tests.test_criteria_set_versions (athlete_id);

create index test_criteria_set_version_sources_test_param_idx on tests.test_criteria_set_version_sources (test_parameter_id);
create index test_criteria_set_version_sources_test_derived_idx on tests.test_criteria_set_version_sources (test_derived_parameter_id);

create index test_criteria_conditions_output_id_idx on tests.test_criteria_conditions (output_id);
create index test_criteria_conditions_reference_value_id_idx on tests.test_criteria_conditions (reference_value_id);
create index test_criteria_conditions_src_selection_idx on tests.test_criteria_conditions (source_battery_item_parameter_selection_id);
create index test_criteria_conditions_src_battery_derived_idx on tests.test_criteria_conditions (source_battery_derived_parameter_id);
create index test_criteria_conditions_src_declaration_idx on tests.test_criteria_conditions (source_declaration_id);

create index test_battery_version_approvals_club_id_idx on tests.test_battery_version_approvals (club_id);
create index test_battery_version_approvals_team_id_idx on tests.test_battery_version_approvals (team_id);
create index test_battery_version_approvals_requested_by_idx on tests.test_battery_version_approvals (requested_by_user_id);


-- ============================================================
-- 7. FUNKCIJE I TRIGERI
-- ============================================================

-- (A) Nepromenjeno od v3.
create function tests.enforce_condition_battery_scope()
returns trigger language plpgsql as $$
declare
  v_set_battery_version_id uuid;
begin
  select battery_version_id into v_set_battery_version_id
  from tests.test_criteria_set_versions where id = NEW.set_version_id;

  if NEW.battery_version_id is distinct from v_set_battery_version_id then
    raise exception 'test_criteria_conditions.battery_version_id (%) must match its set version''s battery_version_id (%)',
      NEW.battery_version_id, v_set_battery_version_id;
  end if;
  return NEW;
end $$;

create trigger enforce_condition_battery_scope
  before insert or update on tests.test_criteria_conditions
  for each row execute function tests.enforce_condition_battery_scope();


-- ------------------------------------------------------------
-- (B1) v4 NOVO: pomoćne validacione funkcije za conditional formule.
-- Resolve-uju tip svake role reference (native test_parameters.value_type,
-- ili result_type odgovarajuće derived tabele) i proveravaju operator/tip
-- kompatibilnost, kao i da su then/else grane ili konstante kompatibilnog
-- tipa sa rezultatom, ili validne role reference.
-- ------------------------------------------------------------

create function tests.validate_conditional_definition_test_level(
  p_derived_id uuid, p_definition jsonb, p_result_type text, p_definition_version integer
) returns void language plpgsql as $$
declare
  v_cond jsonb;
  v_role text;
  v_operator text;
  v_value jsonb;
  v_role_type text;
  v_branch jsonb;
  v_branch_type text;
  v_when_obj jsonb;
  v_when_list jsonb;
begin
  if p_definition is null or jsonb_typeof(p_definition) is distinct from 'object' then
    raise exception 'conditional calculation_definition must be a JSON object';
  end if;

  if p_definition_version <> 1 then
    raise exception 'unsupported definition_version % (only 1 is supported)', p_definition_version;
  end if;
  -- v4.2 (tačka 5): proveri JSON tip PRE cast-a, inače string/object/boolean "version"
  -- baca generičku cast grešku umesto kontrolisane validacione poruke.
  if p_definition -> 'version' is null or jsonb_typeof(p_definition -> 'version') is distinct from 'number' then
    raise exception 'calculation_definition.version must be a JSON number';
  end if;
  if (p_definition ->> 'version')::numeric <> 1 then
    raise exception 'calculation_definition.version must be 1 (and match definition_version column)';
  end if;

  v_when_obj := p_definition -> 'when';
  if v_when_obj is null or jsonb_typeof(v_when_obj) is distinct from 'object' then
    raise exception 'calculation_definition.when must be a JSON object';
  end if;
  if (v_when_obj ? 'any') and (v_when_obj ? 'all') then
    raise exception 'calculation_definition.when must not contain both any and all';
  end if;
  if not (v_when_obj ? 'any') and not (v_when_obj ? 'all') then
    raise exception 'calculation_definition.when must contain exactly one of any or all';
  end if;

  v_when_list := coalesce(v_when_obj -> 'any', v_when_obj -> 'all');
  if jsonb_typeof(v_when_list) is distinct from 'array' or jsonb_array_length(v_when_list) = 0 then
    raise exception 'calculation_definition.when.any/all must be a non-empty JSON array';
  end if;

  for v_cond in select * from jsonb_array_elements(v_when_list)
  loop
    if jsonb_typeof(v_cond) is distinct from 'object' then
      raise exception 'each when condition must be a JSON object';
    end if;

    v_role := v_cond ->> 'role';
    v_operator := v_cond ->> 'operator';
    v_value := v_cond -> 'value';

    if v_role is null then
      raise exception 'when condition is missing role';
    end if;
    if v_operator is null then
      raise exception 'when condition is missing operator for role %', v_role;
    end if;
    if v_operator not in ('eq','neq','gt','gte','lt','lte') then
      raise exception 'unsupported operator % for role %', v_operator, v_role;
    end if;
    if v_value is null or jsonb_typeof(v_value) = 'null' then
      raise exception 'when condition is missing value for role %', v_role;
    end if;

    v_role_type := null;

    select tp.value_type into v_role_type
    from tests.test_version_derived_parameter_inputs i
    join tests.test_parameters tp on tp.id = i.source_test_parameter_id
    where i.derived_parameter_id = p_derived_id and i.role = v_role and i.input_source_kind = 'native';

    if v_role_type is null then
      select dp.result_type into v_role_type
      from tests.test_version_derived_parameter_inputs i
      join tests.test_version_derived_parameters dp on dp.id = i.source_derived_parameter_id
      where i.derived_parameter_id = p_derived_id and i.role = v_role and i.input_source_kind = 'test_derived';
    end if;

    if v_role_type is null then
      raise exception 'conditional definition references undeclared role %', v_role;
    end if;

    if v_role_type in ('numeric','integer','ordinal') then
      if jsonb_typeof(v_value) is distinct from 'number' then
        raise exception 'numeric-compatible role % (type %) requires a JSON number value', v_role, v_role_type;
      end if;
      -- v4.2 (tačka 4): integer/ordinal ne sme imati decimalni deo. Bezbedna Postgres
      -- provera preko trunc(), ne string parsiranje.
      if v_role_type in ('integer','ordinal')
         and (v_value)::text::numeric <> trunc((v_value)::text::numeric) then
        raise exception 'integer/ordinal role % (type %) requires a whole-number JSON value (got %)', v_role, v_role_type, v_value;
      end if;
    elsif v_role_type = 'boolean' then
      if jsonb_typeof(v_value) is distinct from 'boolean' then
        raise exception 'boolean role % requires a JSON boolean value', v_role;
      end if;
      if v_operator not in ('eq','neq') then
        raise exception 'boolean role % only supports eq/neq (got %)', v_role, v_operator;
      end if;
    elsif v_role_type = 'text' then
      if jsonb_typeof(v_value) is distinct from 'string' then
        raise exception 'text role % requires a JSON string value', v_role;
      end if;
      if v_operator not in ('eq','neq') then
        raise exception 'text role % only supports eq/neq (got %)', v_role, v_operator;
      end if;
    end if;
  end loop;

  for v_branch in select unnest(array[p_definition -> 'then', p_definition -> 'else'])
  loop
    if v_branch is null or jsonb_typeof(v_branch) is distinct from 'object' then
      raise exception 'conditional then/else must be a JSON object';
    end if;

    if (v_branch ? 'constant') and (v_branch ? 'role') then
      raise exception 'conditional then/else must have exactly one of constant or role, not both';
    end if;

    if v_branch ? 'constant' then
      v_branch_type := jsonb_typeof(v_branch -> 'constant');
      if p_result_type in ('numeric','integer','ordinal') and v_branch_type is distinct from 'number' then
        raise exception 'conditional branch constant type mismatch with result_type %', p_result_type;
      end if;
      -- v4.2 (tačka 4): integer/ordinal constant ne sme imati decimalni deo.
      if p_result_type in ('integer','ordinal') and v_branch_type = 'number'
         and (v_branch -> 'constant')::text::numeric <> trunc((v_branch -> 'constant')::text::numeric) then
        raise exception 'conditional branch constant must be a whole number for result_type %', p_result_type;
      end if;
      if p_result_type = 'boolean' and v_branch_type is distinct from 'boolean' then
        raise exception 'conditional branch constant type mismatch with result_type boolean';
      end if;
      if p_result_type = 'text' and v_branch_type is distinct from 'string' then
        raise exception 'conditional branch constant type mismatch with result_type text';
      end if;

    elsif v_branch ? 'role' then
      v_role := v_branch ->> 'role';
      v_role_type := null;

      select tp.value_type into v_role_type
      from tests.test_version_derived_parameter_inputs i
      join tests.test_parameters tp on tp.id = i.source_test_parameter_id
      where i.derived_parameter_id = p_derived_id and i.role = v_role and i.input_source_kind = 'native';

      if v_role_type is null then
        select dp.result_type into v_role_type
        from tests.test_version_derived_parameter_inputs i
        join tests.test_version_derived_parameters dp on dp.id = i.source_derived_parameter_id
        where i.derived_parameter_id = p_derived_id and i.role = v_role and i.input_source_kind = 'test_derived';
      end if;

      if v_role_type is null then
        raise exception 'conditional then/else references undeclared role %', v_role;
      end if;

      if p_result_type in ('numeric','integer','ordinal') then
        if v_role_type not in ('numeric','integer','ordinal') then
          raise exception 'conditional then/else role % (type %) incompatible with result_type %', v_role, v_role_type, p_result_type;
        end if;
      elsif p_result_type = 'boolean' then
        if v_role_type is distinct from 'boolean' then
          raise exception 'conditional then/else role % (type %) incompatible with result_type boolean', v_role, v_role_type;
        end if;
      elsif p_result_type = 'text' then
        if v_role_type is distinct from 'text' then
          raise exception 'conditional then/else role % (type %) incompatible with result_type text', v_role, v_role_type;
        end if;
      end if;

    else
      raise exception 'conditional then/else must have constant or role';
    end if;
  end loop;
end $$;

create function tests.validate_conditional_definition_battery_level(
  p_derived_id uuid, p_definition jsonb, p_result_type text, p_definition_version integer
) returns void language plpgsql as $$
declare
  v_cond jsonb;
  v_role text;
  v_operator text;
  v_value jsonb;
  v_role_type text;
  v_sel_source_kind text;
  v_sel_native_id uuid;
  v_sel_derived_id uuid;
  v_selection_id uuid;
  v_input_kind text;
  v_source_derived_id uuid;
  v_branch jsonb;
  v_branch_type text;
  v_when_obj jsonb;
  v_when_list jsonb;
begin
  if p_definition is null or jsonb_typeof(p_definition) is distinct from 'object' then
    raise exception 'conditional calculation_definition must be a JSON object';
  end if;

  if p_definition_version <> 1 then
    raise exception 'unsupported definition_version % (only 1 is supported)', p_definition_version;
  end if;
  -- v4.2 (tačka 5): proveri JSON tip PRE cast-a, inače string/object/boolean "version"
  -- baca generičku cast grešku umesto kontrolisane validacione poruke.
  if p_definition -> 'version' is null or jsonb_typeof(p_definition -> 'version') is distinct from 'number' then
    raise exception 'calculation_definition.version must be a JSON number';
  end if;
  if (p_definition ->> 'version')::numeric <> 1 then
    raise exception 'calculation_definition.version must be 1 (and match definition_version column)';
  end if;

  v_when_obj := p_definition -> 'when';
  if v_when_obj is null or jsonb_typeof(v_when_obj) is distinct from 'object' then
    raise exception 'calculation_definition.when must be a JSON object';
  end if;
  if (v_when_obj ? 'any') and (v_when_obj ? 'all') then
    raise exception 'calculation_definition.when must not contain both any and all';
  end if;
  if not (v_when_obj ? 'any') and not (v_when_obj ? 'all') then
    raise exception 'calculation_definition.when must contain exactly one of any or all';
  end if;

  v_when_list := coalesce(v_when_obj -> 'any', v_when_obj -> 'all');
  if jsonb_typeof(v_when_list) is distinct from 'array' or jsonb_array_length(v_when_list) = 0 then
    raise exception 'calculation_definition.when.any/all must be a non-empty JSON array';
  end if;

  for v_cond in select * from jsonb_array_elements(v_when_list)
  loop
    if jsonb_typeof(v_cond) is distinct from 'object' then
      raise exception 'each when condition must be a JSON object';
    end if;

    v_role := v_cond ->> 'role';
    v_operator := v_cond ->> 'operator';
    v_value := v_cond -> 'value';

    if v_role is null then
      raise exception 'when condition is missing role';
    end if;
    if v_operator is null then
      raise exception 'when condition is missing operator for role %', v_role;
    end if;
    if v_operator not in ('eq','neq','gt','gte','lt','lte') then
      raise exception 'unsupported operator % for role %', v_operator, v_role;
    end if;
    if v_value is null or jsonb_typeof(v_value) = 'null' then
      raise exception 'when condition is missing value for role %', v_role;
    end if;

    select input_source_kind, source_battery_item_parameter_selection_id, source_derived_parameter_id
      into v_input_kind, v_selection_id, v_source_derived_id
    from tests.test_battery_derived_parameter_inputs
    where derived_parameter_id = p_derived_id and role = v_role;

    if v_input_kind is null then
      raise exception 'conditional definition references undeclared role %', v_role;
    end if;

    v_role_type := null;

    if v_input_kind = 'battery_item_parameter_selection' then
      select source_kind, test_parameter_id, test_version_derived_parameter_id
        into v_sel_source_kind, v_sel_native_id, v_sel_derived_id
      from tests.test_battery_item_parameter_selections where id = v_selection_id;

      if v_sel_source_kind = 'native' then
        select value_type into v_role_type from tests.test_parameters where id = v_sel_native_id;
      else
        select result_type into v_role_type from tests.test_version_derived_parameters where id = v_sel_derived_id;
      end if;
    else
      select result_type into v_role_type from tests.test_battery_derived_parameters where id = v_source_derived_id;
    end if;

    if v_role_type is null then
      raise exception 'conditional definition role % could not be resolved to a type', v_role;
    end if;

    if v_role_type in ('numeric','integer','ordinal') then
      if jsonb_typeof(v_value) is distinct from 'number' then
        raise exception 'numeric-compatible role % (type %) requires a JSON number value', v_role, v_role_type;
      end if;
      -- v4.2 (tačka 4): integer/ordinal ne sme imati decimalni deo. Bezbedna Postgres
      -- provera preko trunc(), ne string parsiranje.
      if v_role_type in ('integer','ordinal')
         and (v_value)::text::numeric <> trunc((v_value)::text::numeric) then
        raise exception 'integer/ordinal role % (type %) requires a whole-number JSON value (got %)', v_role, v_role_type, v_value;
      end if;
    elsif v_role_type = 'boolean' then
      if jsonb_typeof(v_value) is distinct from 'boolean' then
        raise exception 'boolean role % requires a JSON boolean value', v_role;
      end if;
      if v_operator not in ('eq','neq') then
        raise exception 'boolean role % only supports eq/neq (got %)', v_role, v_operator;
      end if;
    elsif v_role_type = 'text' then
      if jsonb_typeof(v_value) is distinct from 'string' then
        raise exception 'text role % requires a JSON string value', v_role;
      end if;
      if v_operator not in ('eq','neq') then
        raise exception 'text role % only supports eq/neq (got %)', v_role, v_operator;
      end if;
    end if;
  end loop;

  for v_branch in select unnest(array[p_definition -> 'then', p_definition -> 'else'])
  loop
    if v_branch is null or jsonb_typeof(v_branch) is distinct from 'object' then
      raise exception 'conditional then/else must be a JSON object';
    end if;

    if (v_branch ? 'constant') and (v_branch ? 'role') then
      raise exception 'conditional then/else must have exactly one of constant or role, not both';
    end if;

    if v_branch ? 'constant' then
      v_branch_type := jsonb_typeof(v_branch -> 'constant');
      if p_result_type in ('numeric','integer','ordinal') and v_branch_type is distinct from 'number' then
        raise exception 'conditional branch constant type mismatch with result_type %', p_result_type;
      end if;
      -- v4.2 (tačka 4): integer/ordinal constant ne sme imati decimalni deo.
      if p_result_type in ('integer','ordinal') and v_branch_type = 'number'
         and (v_branch -> 'constant')::text::numeric <> trunc((v_branch -> 'constant')::text::numeric) then
        raise exception 'conditional branch constant must be a whole number for result_type %', p_result_type;
      end if;
      if p_result_type = 'boolean' and v_branch_type is distinct from 'boolean' then
        raise exception 'conditional branch constant type mismatch with result_type boolean';
      end if;
      if p_result_type = 'text' and v_branch_type is distinct from 'string' then
        raise exception 'conditional branch constant type mismatch with result_type text';
      end if;

    elsif v_branch ? 'role' then
      v_role := v_branch ->> 'role';

      select input_source_kind, source_battery_item_parameter_selection_id, source_derived_parameter_id
        into v_input_kind, v_selection_id, v_source_derived_id
      from tests.test_battery_derived_parameter_inputs
      where derived_parameter_id = p_derived_id and role = v_role;

      if v_input_kind is null then
        raise exception 'conditional then/else references undeclared role %', v_role;
      end if;

      v_role_type := null;

      if v_input_kind = 'battery_item_parameter_selection' then
        select source_kind, test_parameter_id, test_version_derived_parameter_id
          into v_sel_source_kind, v_sel_native_id, v_sel_derived_id
        from tests.test_battery_item_parameter_selections where id = v_selection_id;

        if v_sel_source_kind = 'native' then
          select value_type into v_role_type from tests.test_parameters where id = v_sel_native_id;
        else
          select result_type into v_role_type from tests.test_version_derived_parameters where id = v_sel_derived_id;
        end if;
      else
        select result_type into v_role_type from tests.test_battery_derived_parameters where id = v_source_derived_id;
      end if;

      if v_role_type is null then
        raise exception 'conditional then/else role % could not be resolved to a type', v_role;
      end if;

      if p_result_type in ('numeric','integer','ordinal') then
        if v_role_type not in ('numeric','integer','ordinal') then
          raise exception 'conditional then/else role % (type %) incompatible with result_type %', v_role, v_role_type, p_result_type;
        end if;
      elsif p_result_type = 'boolean' then
        if v_role_type is distinct from 'boolean' then
          raise exception 'conditional then/else role % (type %) incompatible with result_type boolean', v_role, v_role_type;
        end if;
      elsif p_result_type = 'text' then
        if v_role_type is distinct from 'text' then
          raise exception 'conditional then/else role % (type %) incompatible with result_type text', v_role, v_role_type;
        end if;
      end if;

    else
      raise exception 'conditional then/else must have constant or role';
    end if;
  end loop;
end $$;


-- ------------------------------------------------------------
-- (B2) v4 NOVO: glavne validacione funkcije, pozvane iz enforce_version_row_immutability
-- na draft->active tranziciji. Proveravaju: postoji bar jedan input; tipsku
-- kompatibilnost za sum/average/weighted_sum; conditional definiciju (preko
-- pomoćnih funkcija iznad); da role u definition postoje u input redovima;
-- i cikluse (uključujući indirektne — rekurzija prati "visited" niz posećenih
-- čvorova i STAJE čim se čvor ponovi, čime se izbegava beskonačna rekurzija
-- na grafu koji stvarno ima ciklus, jer UNION ALL sam po sebi ne bi stao).
-- ------------------------------------------------------------

create function tests.validate_test_version_derived_parameters(p_test_version_id uuid)
returns void language plpgsql as $$
declare
  r record;
  v_input record;
  v_input_type text;
  v_role_set text[];
begin
  for r in
    select * from tests.test_version_derived_parameters where test_version_id = p_test_version_id
  loop
    if not exists (select 1 from tests.test_version_derived_parameter_inputs where derived_parameter_id = r.id) then
      raise exception 'Derived parameter % (%) has no inputs', r.parameter_key, r.id;
    end if;

    if r.calculation_method in ('sum','average','weighted_sum') then
      for v_input in
        select * from tests.test_version_derived_parameter_inputs where derived_parameter_id = r.id
      loop
        v_input_type := null;
        if v_input.input_source_kind = 'native' then
          select value_type into v_input_type from tests.test_parameters where id = v_input.source_test_parameter_id;
        else
          select result_type into v_input_type from tests.test_version_derived_parameters where id = v_input.source_derived_parameter_id;
        end if;

        if v_input_type not in ('numeric','integer','ordinal') then
          raise exception 'Derived parameter % has non-numeric input (role %, type %) for method %',
            r.parameter_key, v_input.role, v_input_type, r.calculation_method;
        end if;
      end loop;

      if r.result_type not in ('numeric','integer','ordinal') then
        raise exception 'Derived parameter % has result_type % incompatible with method %',
          r.parameter_key, r.result_type, r.calculation_method;
      end if;
    end if;

    if r.calculation_method = 'conditional' then
      perform tests.validate_conditional_definition_test_level(r.id, r.calculation_definition, r.result_type, r.definition_version);
    end if;

    if r.calculation_definition is not null then
      select array_agg(distinct role_ref) into v_role_set
      from (
        select jsonb_array_elements(coalesce(r.calculation_definition #> '{when,any}', r.calculation_definition #> '{when,all}', '[]'::jsonb)) ->> 'role' as role_ref
        union all
        select r.calculation_definition #>> '{then,role}'
        union all
        select r.calculation_definition #>> '{else,role}'
      ) x where role_ref is not null;

      if v_role_set is not null and array_length(v_role_set, 1) > 0 then
        if exists (
          select 1 from unnest(v_role_set) as needed_role
          where not exists (
            select 1 from tests.test_version_derived_parameter_inputs
            where derived_parameter_id = r.id and role = needed_role
          )
        ) then
          raise exception 'Derived parameter % calculation_definition references a role not present in its inputs', r.parameter_key;
        end if;
      end if;
    end if;
  end loop;

  if exists (
    with recursive dep as (
      select derived_parameter_id as start_id, source_derived_parameter_id as dep_id,
             array[derived_parameter_id] as visited
      from tests.test_version_derived_parameter_inputs
      where test_version_id = p_test_version_id and input_source_kind = 'test_derived'
      union all
      select d.start_id, i.source_derived_parameter_id, d.visited || d.dep_id
      from dep d
      join tests.test_version_derived_parameter_inputs i
        on i.derived_parameter_id = d.dep_id and i.input_source_kind = 'test_derived'
      where not (d.dep_id = any(d.visited))
    )
    select 1 from dep where dep_id = start_id
  ) then
    raise exception 'Cycle detected in test-level derived parameter graph for test_version %', p_test_version_id;
  end if;
end $$;

create function tests.validate_battery_derived_parameters(p_battery_version_id uuid)
returns void language plpgsql as $$
declare
  r record;
  v_input record;
  v_input_type text;
  v_sel_source_kind text;
  v_sel_native_id uuid;
  v_sel_derived_id uuid;
  v_role_set text[];
begin
  for r in
    select * from tests.test_battery_derived_parameters where battery_version_id = p_battery_version_id
  loop
    if not exists (select 1 from tests.test_battery_derived_parameter_inputs where derived_parameter_id = r.id) then
      raise exception 'Battery derived parameter % (%) has no inputs', r.parameter_key, r.id;
    end if;

    if r.calculation_method in ('sum','average','weighted_sum') then
      for v_input in
        select * from tests.test_battery_derived_parameter_inputs where derived_parameter_id = r.id
      loop
        v_input_type := null;
        if v_input.input_source_kind = 'battery_item_parameter_selection' then
          select source_kind, test_parameter_id, test_version_derived_parameter_id
            into v_sel_source_kind, v_sel_native_id, v_sel_derived_id
          from tests.test_battery_item_parameter_selections
          where id = v_input.source_battery_item_parameter_selection_id;

          if v_sel_source_kind = 'native' then
            select value_type into v_input_type from tests.test_parameters where id = v_sel_native_id;
          else
            select result_type into v_input_type from tests.test_version_derived_parameters where id = v_sel_derived_id;
          end if;
        else
          select result_type into v_input_type from tests.test_battery_derived_parameters where id = v_input.source_derived_parameter_id;
        end if;

        if v_input_type not in ('numeric','integer','ordinal') then
          raise exception 'Battery derived parameter % has non-numeric input (role %, type %) for method %',
            r.parameter_key, v_input.role, v_input_type, r.calculation_method;
        end if;
      end loop;

      if r.result_type not in ('numeric','integer','ordinal') then
        raise exception 'Battery derived parameter % has result_type % incompatible with method %',
          r.parameter_key, r.result_type, r.calculation_method;
      end if;
    end if;

    if r.calculation_method = 'conditional' then
      perform tests.validate_conditional_definition_battery_level(r.id, r.calculation_definition, r.result_type, r.definition_version);
    end if;

    if r.calculation_definition is not null then
      select array_agg(distinct role_ref) into v_role_set
      from (
        select jsonb_array_elements(coalesce(r.calculation_definition #> '{when,any}', r.calculation_definition #> '{when,all}', '[]'::jsonb)) ->> 'role' as role_ref
        union all
        select r.calculation_definition #>> '{then,role}'
        union all
        select r.calculation_definition #>> '{else,role}'
      ) x where role_ref is not null;

      if v_role_set is not null and array_length(v_role_set, 1) > 0 then
        if exists (
          select 1 from unnest(v_role_set) as needed_role
          where not exists (
            select 1 from tests.test_battery_derived_parameter_inputs
            where derived_parameter_id = r.id and role = needed_role
          )
        ) then
          raise exception 'Battery derived parameter % calculation_definition references a role not present in its inputs', r.parameter_key;
        end if;
      end if;
    end if;
  end loop;

  if exists (
    with recursive dep as (
      select derived_parameter_id as start_id, source_derived_parameter_id as dep_id,
             array[derived_parameter_id] as visited
      from tests.test_battery_derived_parameter_inputs
      where battery_version_id = p_battery_version_id and input_source_kind = 'battery_derived'
      union all
      select d.start_id, i.source_derived_parameter_id, d.visited || d.dep_id
      from dep d
      join tests.test_battery_derived_parameter_inputs i
        on i.derived_parameter_id = d.dep_id and i.input_source_kind = 'battery_derived'
      where not (d.dep_id = any(d.visited))
    )
    select 1 from dep where dep_id = start_id
  ) then
    raise exception 'Cycle detected in battery-level derived parameter graph for battery_version %', p_battery_version_id;
  end if;
end $$;


-- (C) v4 IZMENJENO: sada poziva validacione funkcije iznad tačno na draft->active
-- tranziciji, po tabeli (TG_TABLE_NAME). Sve ostalo nepromenjeno od v3.
create function tests.enforce_version_row_immutability()
returns trigger language plpgsql as $$
declare
  v_excluded text[] := array['status','updated_at','archived_at','archived_by'];
begin
  if TG_OP = 'DELETE' then
    if OLD.status in ('active','archived') then
      raise exception 'Cannot delete a % version row', OLD.status;
    end if;
    return OLD;
  end if;

  if OLD.status = 'draft' then
    if NEW.status not in ('draft','active') then
      raise exception 'Invalid version status transition: % -> %', OLD.status, NEW.status;
    end if;
    if NEW.status = 'active' then
      if TG_TABLE_NAME = 'test_versions' then
        perform tests.validate_test_version_derived_parameters(NEW.id);
      elsif TG_TABLE_NAME = 'test_battery_versions' then
        perform tests.validate_battery_derived_parameters(NEW.id);
      end if;
      if NEW.published_at is null then
        NEW.published_at := now();
      end if;
    end if;
    return NEW;

  elsif OLD.status = 'active' then
    if NEW.status is distinct from 'archived' then
      raise exception 'Invalid version status transition: % -> %', OLD.status, NEW.status;
    end if;
    if NEW.archived_at is null then
      NEW.archived_at := now();
    end if;
    if (to_jsonb(OLD) - v_excluded) is distinct from (to_jsonb(NEW) - v_excluded) then
      raise exception 'Only status/archived_at/archived_by/updated_at may change when archiving an active version';
    end if;
    return NEW;

  elsif OLD.status = 'archived' then
    raise exception 'Archived version rows are fully immutable';

  else
    raise exception 'Unexpected status %', OLD.status;
  end if;
end $$;

create trigger freeze_test_versions
  before update or delete on tests.test_versions
  for each row execute function tests.enforce_version_row_immutability();

create trigger freeze_test_battery_versions
  before update or delete on tests.test_battery_versions
  for each row execute function tests.enforce_version_row_immutability();

create trigger freeze_test_criteria_set_versions
  before update or delete on tests.test_criteria_set_versions
  for each row execute function tests.enforce_version_row_immutability();


-- (D) v4 IZMENJENO: dodato "FOR SHARE" na oba statusna upita — ovo je concurrency
-- zaštita iz tačke 7. Objašnjenje mehanizma: UPDATE koji objavljuje verziju
-- (deo publish toka, WHERE id=$1) već sam po sebi drži red-lock na taj tačan
-- red do kraja transakcije. Dodavanjem "FOR SHARE" ovde, SVAKI upis child reda
-- (INSERT/UPDATE/DELETE nad bilo kojom od tabela na koje je ovaj triger
-- prikačen) takođe pokušava da zaključa isti roditeljski red — pa ili čeka
-- publish transakciju da završi (i onda ispravno vidi novo stanje), ili
-- publish transakcija čeka njega. Bez obzira ko prvi stigne, gubitnik čeka
-- pobednika i vidi potpuno konzistentno stanje — nema race condition-a,
-- nema oslanjanja na disciplinu aplikativnog koda.
create function tests.enforce_immutable_active_version()
returns trigger language plpgsql as $$
declare
  v_column text := TG_ARGV[0];
  v_version_table text := TG_ARGV[1];
  v_old_version_id uuid;
  v_new_version_id uuid;
  v_old_status text;
  v_new_status text;
begin
  if TG_OP in ('UPDATE','DELETE') then
    execute format('select ($1).%I', v_column) using OLD into v_old_version_id;
    execute format('select status from %s where id = $1 for share', v_version_table) using v_old_version_id into v_old_status;
    if v_old_status in ('active','archived') then
      raise exception 'Cannot modify or delete a row belonging to a % version', v_old_status;
    end if;
  end if;

  if TG_OP in ('UPDATE','INSERT') then
    execute format('select ($1).%I', v_column) using NEW into v_new_version_id;
    execute format('select status from %s where id = $1 for share', v_version_table) using v_new_version_id into v_new_status;
    if v_new_status in ('active','archived') then
      raise exception 'Cannot insert or reparent a row into a % version', v_new_status;
    end if;
  end if;

  return case when TG_OP = 'DELETE' then OLD else NEW end;
end $$;

create trigger freeze_test_parameters
  before insert or update or delete on tests.test_parameters
  for each row execute function tests.enforce_immutable_active_version('test_version_id', 'tests.test_versions');

create trigger freeze_test_parameter_reference_values
  before insert or update or delete on tests.test_parameter_reference_values
  for each row execute function tests.enforce_immutable_active_version('test_version_id', 'tests.test_versions');

-- v4 NOVO: immutable zaštita za nove test-level derived tabele.
create trigger freeze_test_version_derived_parameters
  before insert or update or delete on tests.test_version_derived_parameters
  for each row execute function tests.enforce_immutable_active_version('test_version_id', 'tests.test_versions');

create trigger freeze_test_version_derived_parameter_inputs
  before insert or update or delete on tests.test_version_derived_parameter_inputs
  for each row execute function tests.enforce_immutable_active_version('test_version_id', 'tests.test_versions');

create trigger freeze_test_battery_items
  before insert or update or delete on tests.test_battery_items
  for each row execute function tests.enforce_immutable_active_version('battery_version_id', 'tests.test_battery_versions');

-- v4: preimenovano sa freeze_test_battery_item_parameters.
create trigger freeze_test_battery_item_parameter_selections
  before insert or update or delete on tests.test_battery_item_parameter_selections
  for each row execute function tests.enforce_immutable_active_version('battery_version_id', 'tests.test_battery_versions');

create trigger freeze_test_battery_derived_parameters
  before insert or update or delete on tests.test_battery_derived_parameters
  for each row execute function tests.enforce_immutable_active_version('battery_version_id', 'tests.test_battery_versions');

create trigger freeze_test_battery_derived_parameter_inputs
  before insert or update or delete on tests.test_battery_derived_parameter_inputs
  for each row execute function tests.enforce_immutable_active_version('battery_version_id', 'tests.test_battery_versions');

create trigger freeze_test_criteria_rules
  before insert or update or delete on tests.test_criteria_rules
  for each row execute function tests.enforce_immutable_active_version('set_version_id', 'tests.test_criteria_set_versions');

create trigger freeze_test_criteria_outputs
  before insert or update or delete on tests.test_criteria_outputs
  for each row execute function tests.enforce_immutable_active_version('set_version_id', 'tests.test_criteria_set_versions');

create trigger freeze_test_criteria_conditions
  before insert or update or delete on tests.test_criteria_conditions
  for each row execute function tests.enforce_immutable_active_version('set_version_id', 'tests.test_criteria_set_versions');

create trigger freeze_test_criteria_set_version_sources
  before insert or update or delete on tests.test_criteria_set_version_sources
  for each row execute function tests.enforce_immutable_active_version('set_version_id', 'tests.test_criteria_set_versions');


-- (E) Nepromenjeno od v3.
create function tests.enforce_criteria_set_version_battery_lock()
returns trigger language plpgsql as $$
declare
  v_has_children boolean;
begin
  if NEW.battery_version_id is distinct from OLD.battery_version_id then
    select exists (
      select 1 from tests.test_criteria_set_version_sources where set_version_id = OLD.id
      union all
      select 1 from tests.test_criteria_rules where set_version_id = OLD.id
      union all
      select 1 from tests.test_criteria_outputs where set_version_id = OLD.id
      union all
      select 1 from tests.test_criteria_conditions where set_version_id = OLD.id
    ) into v_has_children;

    if v_has_children then
      raise exception 'Cannot change battery_version_id on a criteria set version that already has sources/rules/outputs/conditions';
    end if;
  end if;
  return NEW;
end $$;

create trigger enforce_criteria_set_version_battery_lock
  before update on tests.test_criteria_set_versions
  for each row execute function tests.enforce_criteria_set_version_battery_lock();


-- (F) Nepromenjeno od v3.
create function tests.enforce_fork_lineage_matches_parent()
returns trigger language plpgsql as $$
declare
  v_stable_table text := TG_ARGV[0];
  v_stable_id_column text := TG_ARGV[1];
  v_fork_column text := TG_ARGV[2];
  v_stable_id uuid;
  v_local_fork_value uuid;
  v_parent_fork_value uuid;
begin
  if NEW.version_number <> 1 then
    return NEW;
  end if;

  execute format('select ($1).%I', v_stable_id_column) using NEW into v_stable_id;
  execute format('select ($1).%I', v_fork_column) using NEW into v_local_fork_value;
  execute format('select %I from %s where id = $1', v_fork_column, v_stable_table)
    using v_stable_id into v_parent_fork_value;

  if v_local_fork_value is distinct from v_parent_fork_value then
    raise exception 'version 1''s % (%) must match its stable parent''s % (%)',
      v_fork_column, v_local_fork_value, v_fork_column, v_parent_fork_value;
  end if;
  return NEW;
end $$;

create trigger enforce_test_versions_fork_matches_parent
  before insert or update on tests.test_versions
  for each row execute function tests.enforce_fork_lineage_matches_parent('tests.test', 'test_id', 'forked_from_test_id');

create trigger enforce_test_battery_versions_fork_matches_parent
  before insert or update on tests.test_battery_versions
  for each row execute function tests.enforce_fork_lineage_matches_parent('tests.test_battery', 'test_battery_id', 'forked_from_battery_id');

create trigger enforce_test_criteria_set_versions_fork_matches_parent
  before insert or update on tests.test_criteria_set_versions
  for each row execute function tests.enforce_fork_lineage_matches_parent('tests.test_criteria_sets', 'criteria_set_id', 'forked_from_criteria_set_id');


-- (G) Nepromenjeno od v3.
create function tests.enforce_standalone_set_sources()
returns trigger language plpgsql as $$
declare
  v_battery_version_id uuid;
begin
  select battery_version_id into v_battery_version_id
  from tests.test_criteria_set_versions where id = NEW.set_version_id;

  if v_battery_version_id is not null then
    raise exception 'test_criteria_set_version_sources may only reference a standalone (battery_version_id IS NULL) criteria set version';
  end if;
  return NEW;
end $$;

create trigger enforce_standalone_set_sources
  before insert or update on tests.test_criteria_set_version_sources
  for each row execute function tests.enforce_standalone_set_sources();


-- (H) v4 NOVO: zamenjuje staru composite-FK proveru (koja se oslanjala na sada
-- uklonjeni test_criteria_conditions.test_parameter_id). Razrešava stvarni izvor
-- kroz sve tri moguće putanje i zahteva da bude native pre nego što dozvoli
-- predefined_reference; proverava i da reference_value_id pripada baš tom
-- native parametru. Sve provere su NULL-bezbedne (IS DISTINCT FROM), ne
-- oslanjaju se na MATCH SIMPLE ponašanje bilo koje FK kolone.
create function tests.enforce_predefined_reference_native_only()
returns trigger language plpgsql as $$
declare
  v_source_kind text;
  v_native_param_id uuid;
  v_native_value_type text;
  v_ref_param_id uuid;
begin
  if NEW.reference_type <> 'predefined_reference' then
    return NEW;
  end if;

  v_source_kind := null;
  v_native_param_id := null;

  if NEW.parameter_source_kind = 'battery_item_parameter_selection' then
    select source_kind, test_parameter_id into v_source_kind, v_native_param_id
    from tests.test_battery_item_parameter_selections
    where id = NEW.source_battery_item_parameter_selection_id;
  elsif NEW.parameter_source_kind = 'declared_source' then
    select source_kind, test_parameter_id into v_source_kind, v_native_param_id
    from tests.test_criteria_set_version_sources
    where id = NEW.source_declaration_id;
  else
    v_source_kind := 'derived';
  end if;

  if v_source_kind is distinct from 'native' then
    raise exception 'predefined_reference is only allowed for native parameter sources (got %)', v_source_kind;
  end if;

  -- v4.1: native izvor mora dodatno biti numerički kompatibilan (tačka 7).
  select value_type into v_native_value_type from tests.test_parameters where id = v_native_param_id;
  if v_native_value_type not in ('numeric','integer','ordinal') then
    raise exception 'predefined_reference requires a numeric-compatible native parameter (got %)', v_native_value_type;
  end if;

  select test_parameter_id into v_ref_param_id
  from tests.test_parameter_reference_values where id = NEW.reference_value_id;

  if v_ref_param_id is distinct from v_native_param_id then
    raise exception 'reference_value_id must belong to the same native test parameter as the condition source';
  end if;

  return NEW;
end $$;

create trigger enforce_predefined_reference_native_only
  before insert or update on tests.test_criteria_conditions
  for each row execute function tests.enforce_predefined_reference_native_only();


-- v4.1 NOVO (tačka 6): static_value/static_value_upper su sada jsonb (bili numeric).
-- Ovaj triger razrešava stvarni tip izvora (native value_type ili derived result_type,
-- kroz istu tro-putanjsku logiku kao gornji triger) i proverava da JSON tip literala
-- odgovara tom tipu: numeric/integer/ordinal -> JSON number, boolean -> JSON boolean.
-- text-tipizirani izvori se u v4.1 eksplicitno odbijaju u kriterijumima (boolean ostaje
-- podržan zbog WELLNESS Injury). between je dozvoljen samo za numerički kompatibilne
-- tipove, uz proveru lower<=upper. individual_history/group_reference zahtevaju
-- numerički kompatibilan izvor.
create function tests.enforce_criteria_condition_value_types()
returns trigger language plpgsql as $$
declare
  v_resolved_type text;
  v_sel_source_kind text;
  v_sel_native_id uuid;
  v_sel_derived_id uuid;
  v_decl_source_kind text;
  v_decl_native_id uuid;
  v_decl_derived_id uuid;
begin
  v_resolved_type := null;

  if NEW.parameter_source_kind = 'battery_item_parameter_selection' then
    select source_kind, test_parameter_id, test_version_derived_parameter_id
      into v_sel_source_kind, v_sel_native_id, v_sel_derived_id
    from tests.test_battery_item_parameter_selections
    where id = NEW.source_battery_item_parameter_selection_id;

    if v_sel_source_kind = 'native' then
      select value_type into v_resolved_type from tests.test_parameters where id = v_sel_native_id;
    else
      select result_type into v_resolved_type from tests.test_version_derived_parameters where id = v_sel_derived_id;
    end if;

  elsif NEW.parameter_source_kind = 'battery_derived' then
    select result_type into v_resolved_type
    from tests.test_battery_derived_parameters where id = NEW.source_battery_derived_parameter_id;

  elsif NEW.parameter_source_kind = 'declared_source' then
    select source_kind, test_parameter_id, test_derived_parameter_id
      into v_decl_source_kind, v_decl_native_id, v_decl_derived_id
    from tests.test_criteria_set_version_sources
    where id = NEW.source_declaration_id;

    if v_decl_source_kind = 'native' then
      select value_type into v_resolved_type from tests.test_parameters where id = v_decl_native_id;
    else
      select result_type into v_resolved_type from tests.test_version_derived_parameters where id = v_decl_derived_id;
    end if;
  end if;

  if v_resolved_type is null then
    raise exception 'could not resolve source type for criteria condition';
  end if;

  if v_resolved_type = 'text' then
    raise exception 'text-typed sources are not supported in criteria conditions (v4.1)';
  end if;

  -- v4.2 (tačka 2): operator kompatibilnost sa tipom izvora važi nezavisno od
  -- reference_type. Bez ovoga bi boolean izvor sa session_reference/
  -- individual_history/group_reference i operatorom gt/gte/lt/lte prošao,
  -- jer se ranija provera nalazila samo unutar "reference_type = 'static'" grane.
  -- 'between' takođe nije eq/neq, pa je time automatski pokriveno i "between
  -- nije dozvoljen za boolean izvor" bez posebne provere za to.
  if v_resolved_type = 'boolean' and NEW.operator not in ('eq','neq') then
    raise exception 'boolean source only supports eq/neq (got %)', NEW.operator;
  end if;

  if NEW.reference_type = 'static' then
    if v_resolved_type in ('numeric','integer','ordinal') then
      if jsonb_typeof(NEW.static_value) is distinct from 'number' then
        raise exception 'static_value must be a JSON number for numeric-compatible source (type %)', v_resolved_type;
      end if;
      -- v4.2 (tačka 4): integer/ordinal static_value ne sme imati decimalni deo.
      if v_resolved_type in ('integer','ordinal')
         and (NEW.static_value)::text::numeric <> trunc((NEW.static_value)::text::numeric) then
        raise exception 'static_value must be a whole number for source type %', v_resolved_type;
      end if;
      if NEW.operator = 'between' then
        if jsonb_typeof(NEW.static_value_upper) is distinct from 'number' then
          raise exception 'static_value_upper must be a JSON number for between';
        end if;
        if v_resolved_type in ('integer','ordinal')
           and (NEW.static_value_upper)::text::numeric <> trunc((NEW.static_value_upper)::text::numeric) then
          raise exception 'static_value_upper must be a whole number for source type %', v_resolved_type;
        end if;
        if (NEW.static_value)::text::numeric > (NEW.static_value_upper)::text::numeric then
          raise exception 'static_value must be <= static_value_upper';
        end if;
      end if;
    elsif v_resolved_type = 'boolean' then
      if jsonb_typeof(NEW.static_value) is distinct from 'boolean' then
        raise exception 'static_value must be a JSON boolean for boolean source';
      end if;
    end if;
  end if;

  if NEW.reference_type in ('individual_history','group_reference') and v_resolved_type not in ('numeric','integer','ordinal') then
    raise exception 'individual_history/group_reference require a numeric-compatible source (got %)', v_resolved_type;
  end if;

  return NEW;
end $$;

create trigger enforce_criteria_condition_value_types
  before insert or update on tests.test_criteria_conditions
  for each row execute function tests.enforce_criteria_condition_value_types();


-- (I) Nepromenjeno od v3.
create function tests.enforce_approval_lifecycle()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    raise exception 'Approval audit rows cannot be deleted';
  end if;

  if NEW.decided_at is not null and NEW.decided_at < NEW.requested_at then
    raise exception 'decided_at cannot be before requested_at';
  end if;
  if NEW.revoked_at is not null and NEW.decided_at is not null and NEW.revoked_at < NEW.decided_at then
    raise exception 'revoked_at cannot be before decided_at';
  end if;
  if NEW.cancelled_at is not null and NEW.cancelled_at < NEW.requested_at then
    raise exception 'cancelled_at cannot be before requested_at';
  end if;

  if TG_OP = 'INSERT' then
    return NEW;
  end if;

  if NEW.id is distinct from OLD.id
     or NEW.test_battery_version_id is distinct from OLD.test_battery_version_id
     or NEW.club_id is distinct from OLD.club_id
     or NEW.team_id is distinct from OLD.team_id
     or NEW.requested_by_user_id is distinct from OLD.requested_by_user_id
     or NEW.requested_at is distinct from OLD.requested_at
  then
    raise exception 'test_battery_version_id, club/team scope, requester and requested_at are immutable after insert';
  end if;

  if OLD.status = 'pending' and NEW.status = 'pending' then
    return NEW;

  elsif OLD.status = 'pending' and NEW.status in ('approved','rejected') then
    if NEW.revoked_by_user_id is not null or NEW.revoked_at is not null
       or NEW.cancelled_by_user_id is not null or NEW.cancelled_at is not null then
      raise exception 'Only decision fields may be set when moving pending -> %', NEW.status;
    end if;
    return NEW;

  elsif OLD.status = 'pending' and NEW.status = 'cancelled' then
    if NEW.decided_by_user_id is not null or NEW.decided_at is not null
       or NEW.revoked_by_user_id is not null or NEW.revoked_at is not null then
      raise exception 'Only cancellation fields may be set when moving pending -> cancelled';
    end if;
    return NEW;

  elsif OLD.status = 'approved' and NEW.status = 'revoked' then
    if NEW.decided_by_user_id is distinct from OLD.decided_by_user_id
       or NEW.decided_at is distinct from OLD.decided_at
       or NEW.cancelled_by_user_id is not null or NEW.cancelled_at is not null then
      raise exception 'Only revocation fields may change when moving approved -> revoked';
    end if;
    return NEW;

  elsif OLD.status in ('approved','rejected','revoked','cancelled') then
    raise exception 'Approval rows in % status cannot be modified (approved may only move to revoked)', OLD.status;

  else
    raise exception 'Invalid approval status transition: % -> %', OLD.status, NEW.status;
  end if;
end $$;

create trigger enforce_approval_lifecycle
  before insert or update or delete on tests.test_battery_version_approvals
  for each row execute function tests.enforce_approval_lifecycle();


-- ============================================================
-- 8. TOK OBJAVLJIVANJA — jedna transakcija (dokumentacija, ne izvršeno)
-- ============================================================
--
-- begin;
--
-- update tests.test_versions
--    set status = 'archived'
--  where test_id = $test_id and status = 'active';
-- -- Ovaj UPDATE (ako pogodi red) uzima red-lock na tu tačnu active verziju.
-- -- Bilo koji paralelan child-write (test_parameters, test_version_derived_parameters, ...)
-- -- koji bi pokušao da čita njen status kroz FOR SHARE u enforce_immutable_active_version
-- -- ceka ovu transakciju. 0 pogodjenih redova je OK (prvo objavljivanje).
--
-- update tests.test_versions
--    set status = 'active'
--  where id = $draft_version_id and test_id = $test_id and status = 'draft';
-- -- Servis MORA proveriti da je row count TACNO 1. Isti UPDATE uzima red-lock
-- -- na draft red koji postaje active -- svaki paralelan pokusaj upisa deteta
-- -- (koji bi FOR SHARE citao njen status) ceka ovu transakciju, i obrnuto.
-- -- Triger (C) automatski poziva validate_test_version_derived_parameters(...)
-- -- upravo ovde, pre nego sto dozvoli tranziciju -- ako ijedna formula nije
-- -- validna (ciklus, nekompatibilan tip, nedeklarisana role...), CEO UPDATE
-- -- puca i cela transakcija se rollbackuje, ukljucujuci prvi UPDATE.
--
-- commit;
--
-- Isti obrazac (arhiviraj staru active sa stabilnim parent ID-jem u WHERE, pa
-- aktiviraj draft sa istim stabilnim parent ID-jem u WHERE, proveri row count=1
-- na oba koraka, u istoj transakciji) važi identično za test_battery_versions
-- (WHERE test_battery_id = $test_battery_id, poziva validate_battery_derived_parameters)
-- i test_criteria_set_versions (WHERE criteria_set_id = $criteria_set_id, bez
-- derived-parameter validacije jer criteria setovi sami nemaju derived parametre).


-- ============================================================
-- 9. tests.legacy_import_map — audit/provenijencija za statički import
-- ============================================================
-- Finalna DDL, prenesena iz v42_migration_plan_v3.md, odeljak 4 (tamo
-- označena "ilustrativno" jer je pisana pre nego što je ova migracija
-- odobrena za pisanje - ovde je stvarna, izvršna definicija). Dva UNIQUE
-- ograničenja su namerno realizovana kao PARTIAL UNIQUE INDEX (WHERE ...),
-- ne kao plain table-level UNIQUE, jer plain UNIQUE ne bi ograničio redove
-- čiji je source_id odn. target_id NULL (Postgres tretira NULL kao različit
-- od svega u UNIQUE) - cilj je ograničiti duplikate samo tamo gde stvarno
-- postoji source/target vrednost.

create table tests.legacy_import_map (
  id               uuid primary key default gen_random_uuid(),

  import_batch_key text not null,

  source_system    varchar(30) not null,
      -- 'monitoring2' za direct/transformed/skipped redove koji stvarno
      -- potiču iz monitoring2. 'optimove_seed' za generated redove - nikad
      -- 'monitoring2' kad ne postoji konkretan monitoring2 izvorni red.

  source_schema    varchar(100),
  source_table     varchar(200),
  source_id        uuid,

  target_schema    varchar(100),
  target_table     varchar(200),
  target_id        uuid,

  mapping_kind     varchar(20) not null
    check (mapping_kind in ('direct','transformed','generated','skipped')),

  imported_at      timestamptz not null default now(),
  note             text,

  check (
    (mapping_kind in ('direct','transformed')
       and source_system is not null and source_schema is not null
       and source_table is not null and source_id is not null
       and target_schema is not null and target_table is not null
       and target_id is not null)
    or
    (mapping_kind = 'generated'
       and source_system is not null
       and source_schema is null and source_table is null and source_id is null
       and target_schema is not null and target_table is not null
       and target_id is not null)
    or
    (mapping_kind = 'skipped'
       and source_system is not null and source_schema is not null
       and source_table is not null and source_id is not null
       and target_schema is null and target_table is null and target_id is null)
  )
);

-- (1) source→target mapping bez duplikata kad source_id postoji:
create unique index legacy_import_map_source_target_uidx
  on tests.legacy_import_map
  (source_system, source_schema, source_table, source_id, target_schema, target_table)
  where source_id is not null;

-- (2) jedan target red ne mapira se više puta unutar istog import batch-a:
create unique index legacy_import_map_target_uidx
  on tests.legacy_import_map (import_batch_key, target_schema, target_table, target_id)
  where target_id is not null;

create index legacy_import_map_batch_idx on tests.legacy_import_map (import_batch_key);
create index legacy_import_map_target_id_idx on tests.legacy_import_map (target_id) where target_id is not null;
