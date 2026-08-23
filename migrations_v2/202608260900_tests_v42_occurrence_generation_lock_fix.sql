-- ============================================================
-- OPTIMOVE — Tests modul, Phase 2 follow-up: zatvaranje occurrence-generation
-- vs schedule PATCH/DELETE trke.
--
-- NE dira migrations_v2/202608240900_tests_v42_phase1_scheduling_execution.sql
-- (taj fajl ostaje bajt-za-bajt nepromenjen, njegov checksum u
-- schema_migrations ostaje važeći) - ovo je NOVA, aditivna migracija koja
-- samo CREATE OR REPLACE-uje jednu već deploy-ovanu funkciju.
--
-- ROOT CAUSE: tests.generate_test_schedule_occurrence() je čitala roditeljski
-- test_schedules red običnim `select * into v_schedule ... where id = ...`,
-- bez ikakvog row lock-a. backend/src/routes/tests.js-ove PATCH/DELETE rute
-- uzimaju `for update` na tom istom redu, ali pošto generator sam nije
-- uzimao NIKAKAV lock, taj `for update` ga nije mogao blokirati - DELETE je
-- mogao fizički obrisati schedule red u tačno istom trenutku kad je
-- generator, koji je već pročitao (sada zastarelu) verziju tog reda, upravo
-- pravio novi occurrence ispod njega.
--
-- FIX: dodat `for share` na to čitanje. `for share` dozvoljava proizvoljno
-- mnogo PARALELNIH poziva generate_test_schedule_occurrence() (različiti
-- pozivi Today-a za različite atlete/schedule-e i dalje rade paralelno, bez
-- međusobnog blokiranja - ON CONFLICT DO NOTHING na (schedule_id,
-- scheduled_date) već garantuje da paralelni pozivi za ISTI datum ne prave
-- duplikat), ali svaki takav `for share` blokira i biva blokiran od
-- PATCH/DELETE-ovog `for update` nad istim redom - dva moguća ishoda su sada
-- oba bezbedna:
--   1) generisanje prvo uzme `for share` i commituje (occurrence red
--      postoji) -> PATCH/DELETE-ov `for update` čeka, pa vidi taj occurrence
--      i DELETE ispravno radi cancel (ne fizičko brisanje).
--   2) DELETE prvo uzme `for update` i fizički obriše schedule red (nije
--      imao occurrence) -> generisanje koje čeka na `for share` se, kad se
--      DELETE-ova transakcija commituje, budi i vidi NULA redova (MVCC: red
--      koji je upravo obrisan više nije vidljiv) - postojeća provera
--      `if v_schedule.id is null then raise exception 'schedule % does not
--      exist'` se aktivira potpuno prirodno, bez ikakve dodatne izmene ove
--      funkcije. Ostaje na pozivaocu (backend/src/testsOccurrenceService.js)
--      da tu tačno tu grešku tretira kao "nema šta da se prikaže", ne kao
--      500 - videto tamo.
--
-- Runner je jedini vlasnik BEGIN/COMMIT granice - ovaj fajl namerno ne
-- sadrži sopstvene transaction-control naredbe.
-- ============================================================

create or replace function tests.generate_test_schedule_occurrence(p_schedule_id uuid, p_scheduled_date date)
returns uuid language plpgsql as $$
declare
  v_schedule tests.test_schedules%rowtype;
  v_occurrence_id uuid;
begin
  select * into v_schedule from tests.test_schedules where id = p_schedule_id for share;
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
