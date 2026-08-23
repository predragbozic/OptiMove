-- ============================================================
-- OPTIMOVE — Tests modul, Phase 2: ispravka latentne greške u već
-- deploy-ovanom Phase 1 trigeru tests.protect_completed_assessment().
--
-- NE dira migrations_v2/202608240900_tests_v42_phase1_scheduling_execution.sql
-- (taj fajl ostaje bajt-za-bajt nepromenjen, njegov checksum u
-- schema_migrations ostaje važeći) - ovo je NOVA, aditivna migracija koja
-- samo CREATE OR REPLACE-uje funkciju čije je ponašanje u produkciji već
-- pogrešno za jedan konkretan, do sada NEISPROBAN slučaj.
--
-- ROOT CAUSE (otkriveno kroz Phase 2 stvaran end-to-end submit/correction
-- flow protiv realnog assignment_id-a - Phase 1 sopstveni M5-M9 testovi su
-- ispravku uvek testirali isključivo na standalone_assignment_id IS NULL
-- redovima - makeStandaloneWellnessAssessment() nikad ne postavlja
-- assignment_id - pa greška nikad nije bila vidljiva u Phase 1):
--
--   tests.test_assessments.standalone_assignment_id je
--   `generated always as (...) stored` kolona. PostgreSQL generisane kolone
--   se izračunavaju TEK POSLE svih BEFORE ROW trigera za taj upis - unutar
--   BEFORE trigera, NEW.<generated_column> je NEIZRAČUNATA (null), dok
--   OLD.<generated_column> pokazuje STVARNU, već upisanu vrednost. Zato
--   `to_jsonb(OLD) vs to_jsonb(NEW)` provera u
--   protect_completed_assessment() - koja treba da garantuje da ISPRAVAN
--   completed->invalidated supersede prelaz menja SAMO status/
--   superseded_by_assessment_id/updated_at - UVEK vidi
--   standalone_assignment_id kao "promenjen" (stvarna vrednost -> null) za
--   SVAKI red koji ima pravi assignment_id (tj. za svaki normalan,
--   dodeljeni test - tačno ono što Phase 2-in stvaran popunjava/ispravlja
--   tok koristi), i odbija ISPRAVAN supersede sa lažnom "every other column
--   must stay identical" greškom.
--
-- FIX: standalone_assignment_id je u potpunosti izveden iz
-- battery_assessment_id/assignment_id kolona koje se VEĆ upoređuju - njegovo
-- isključivanje iz diff provere ne gubi nikakvu stvarnu informaciju (ako se
-- assignment_id/battery_assessment_id nisu promenili, generisana vrednost se
-- - kad se konačno izračuna - garantovano poklapa; diff provera postoji da
-- uhvati baš promenu ULAZNIH kolona, koje ostaju potpuno pokrivene).
-- Identična funkcija kao u Phase 1, sa TAČNO jednim dodatim
-- `- 'standalone_assignment_id'` na oba mesta. Bezopasno i za
-- test_battery_assessments (ta tabela tu kolonu nema - jsonb `-` operator sa
-- nepostojećim ključem je no-op).
--
-- Runner je jedini vlasnik BEGIN/COMMIT granice - ovaj fajl namerno ne
-- sadrži sopstvene transaction-control naredbe.
-- ============================================================

create or replace function tests.protect_completed_assessment()
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
  --
  -- standalone_assignment_id (generated always as ... stored, samo na
  -- test_assessments) je isključena OVDE (fix - videti header komentar
  -- ovog fajla): generisane kolone nisu još izračunate unutar BEFORE
  -- trigera, pa bi NEW uvek pokazivao null bez obzira da li se stvarna
  -- vrednost promenila - potpuno pokriveno već upoređenim
  -- assignment_id/battery_assessment_id ulazima, tako da se isključivanjem
  -- ne gubi nikakva stvarna provera.
  if (to_jsonb(OLD) - 'status' - 'superseded_by_assessment_id' - 'updated_at' - 'standalone_assignment_id')
     is distinct from
     (to_jsonb(NEW) - 'status' - 'superseded_by_assessment_id' - 'updated_at' - 'standalone_assignment_id')
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
