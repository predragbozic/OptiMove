-- ============================================================
-- OPTIMOVE — Tests modul, Phase 2: version-specific presentation metadata
-- za test_parameters (redosled prikaza, required, control type, direction,
-- min/max labele, pomoćni tekst) + backfill za postojeću aktivnu WELLNESS
-- verziju.
--
-- Ovo NE menja Tests v4.2 katalog (migrations_v2/202608220900_tests_v42_
-- schema.sql, 202608221000_tests_v42_seed_wellness_fms.sql) niti Phase 1
-- (migrations_v2/202608240900_tests_v42_phase1_scheduling_execution.sql) -
-- samo dodaje NOVU, aditivnu tabelu. Frontend nikad ne sme hardkodovati UI
-- pravila po parameter_key - ova tabela je jedini izvor istine za to kako se
-- jedan test_parameters red prikazuje.
--
-- Redosled u ovom fajlu je namerno: (1) tabela, bez ijednog trigera; (2)
-- eksplicitan WELLNESS backfill, kao običan INSERT dok još ne postoji
-- nijedno ograničenje; (3) tek ONDA strog trigger koji od tog trenutka
-- nadalje važi za SVAKI upis, uključujući WELLNESS-ovu sopstvenu (već
-- aktivnu) verziju - nema privremenog "dozvoli tačno jedan naknadni INSERT"
-- izuzetka nigde. WELLNESS-ov backfill uspeva isključivo zato što se dešava
-- PRE nego što trigger uopšte postoji, ne zato što ga trigger posebno
-- propušta.
--
-- Runner je jedini vlasnik BEGIN/COMMIT granice - ovaj fajl namerno ne
-- sadrži sopstvene transaction-control naredbe.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tabela (bez trigera)
-- ------------------------------------------------------------

create table tests.test_parameter_presentation (
  id uuid primary key default gen_random_uuid(),
  test_version_id uuid not null,
  test_parameter_id uuid not null,

  display_order integer not null check (display_order >= 0),
  is_required boolean not null default true,
  control_type varchar(20) not null check (control_type in ('slider','yes_no','number','text')),
  direction varchar(20) not null check (direction in ('lower_better','higher_better','neutral')),
  min_value_label varchar(100),
  max_value_label varchar(100),
  help_text text,

  created_at timestamptz not null default now(),

  unique (test_version_id, test_parameter_id),
  unique (test_version_id, display_order),

  foreign key (test_version_id, test_parameter_id)
    references tests.test_parameters (test_version_id, id) on delete cascade
);

create index test_parameter_presentation_test_parameter_id_idx on tests.test_parameter_presentation (test_parameter_id);

-- ------------------------------------------------------------
-- 2. Eksplicitan backfill: postojeća aktivna WELLNESS verzija
-- (7a386bd1-d25e-4651-9012-e76d9dc32559, migrations_v2/202608221000_tests_
-- v42_seed_wellness_fms.sql, odeljak A). Običan INSERT - u ovom trenutku
-- migracije još ne postoji nijedan trigger na ovoj tabeli, pa ništa posebno
-- ne propušta ovaj upis; on je samo poslednji put da se ova tabela ikad
-- upiše mimo strogog pravila ispod.
-- ------------------------------------------------------------

insert into tests.test_parameter_presentation
  (test_version_id, test_parameter_id, display_order, is_required, control_type, direction, min_value_label, max_value_label, help_text)
values
  ('7a386bd1-d25e-4651-9012-e76d9dc32559', 'f33abe4e-f2c2-48f7-89b0-e4c96ca0f6ea', 0, true, 'slider', 'lower_better', 'Fresh', 'Exhausted', null),
  ('7a386bd1-d25e-4651-9012-e76d9dc32559', 'bde22df8-ecaa-41db-878f-e377b236772e', 1, true, 'slider', 'lower_better', 'Excellent', 'Very poor', null),
  ('7a386bd1-d25e-4651-9012-e76d9dc32559', '82793b38-757b-48c5-a2ae-b677bf2bb653', 2, true, 'slider', 'lower_better', 'None', 'Severe', null),
  ('7a386bd1-d25e-4651-9012-e76d9dc32559', '4d71286c-911e-4a86-9541-0fd189c41e59', 3, true, 'slider', 'lower_better', 'Relaxed', 'Extremely stressed', null),
  ('7a386bd1-d25e-4651-9012-e76d9dc32559', '08144417-8f16-4fd5-b35f-a2c983e0f180', 4, true, 'slider', 'lower_better', 'Very good', 'Very poor', null),
  ('7a386bd1-d25e-4651-9012-e76d9dc32559', 'a98f2afb-b458-40ff-98a7-c6b5108bba9e', 5, true, 'yes_no', 'neutral', null, null, 'Reported presence of pain or injury today.');

-- ------------------------------------------------------------
-- 3. Strog trigger, kreiran POSLE backfill-a. Od ovog trenutka nadalje, za
-- SVAKI test_version (uključujući WELLNESS, koji je već aktivan):
--   - identitet reda (test_version_id/test_parameter_id) je nepromenljiv -
--     nema reparenting-a ni dok je roditelj draft;
--   - INSERT/UPDATE/DELETE su dozvoljeni isključivo dok je roditeljski
--     test_version status = 'draft'. Nema izuzetka za "prvi upis u aktivnu
--     verziju" - to je upravo rupa koju ovaj trigger zatvara.
-- "FOR SHARE" nad test_versions redom je isti obrazac kao v4.2 sopstveni
-- tests.enforce_immutable_active_version (schema.sql, NETAKNUT ovde): child
-- upis i publish tranzicija (draft->active, UPDATE na test_versions) se
-- serijalizuju preko zaključavanja istog roditeljskog reda - ili child upis
-- čeka da se publish transakcija završi (i onda ispravno vidi 'active'), ili
-- publish čeka da child transakcija otpusti FOR SHARE - nikad race condition
-- gde jedno "pobedi" a drugo ostavi nekonzistentno stanje.
-- ------------------------------------------------------------

create function tests.protect_presentation_lifecycle()
returns trigger language plpgsql as $$
declare
  v_version_id uuid;
  v_status varchar(10);
begin
  if TG_OP = 'UPDATE' then
    if NEW.test_version_id is distinct from OLD.test_version_id
       or NEW.test_parameter_id is distinct from OLD.test_parameter_id then
      raise exception 'test_parameter_presentation.% identity (test_version_id/test_parameter_id) is immutable - reparenting is never allowed, insert a new row for the new draft version instead', OLD.id;
    end if;
  end if;

  v_version_id := case when TG_OP = 'DELETE' then OLD.test_version_id else NEW.test_version_id end;
  select status into v_status from tests.test_versions where id = v_version_id for share;
  if v_status is distinct from 'draft' then
    raise exception 'test_parameter_presentation rows can only be inserted, updated or deleted while their test_version is draft (test_version % is %)', v_version_id, coalesce(v_status, 'unknown');
  end if;

  return case when TG_OP = 'DELETE' then OLD else NEW end;
end $$;

create trigger protect_presentation_lifecycle
  before insert or update or delete on tests.test_parameter_presentation
  for each row execute function tests.protect_presentation_lifecycle();
