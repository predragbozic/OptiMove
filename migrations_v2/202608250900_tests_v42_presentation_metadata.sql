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
-- Runner je jedini vlasnik BEGIN/COMMIT granice - ovaj fajl namerno ne
-- sadrži sopstvene transaction-control naredbe.
-- ============================================================

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

-- Version immutability, mirroring the v4.2 catalog's own established
-- freeze-once-published convention (tests.enforce_version_row_immutability /
-- tests.enforce_immutable_active_version, both UNTOUCHED here) - but this
-- table has one extra wrinkle those don't: WELLNESS's test_version was
-- ALREADY 'active' before this table existed, so a plain reuse of
-- enforce_immutable_active_version('test_version_id','tests.test_versions')
-- would reject even this migration's own one-time backfill INSERT below.
-- Two separate, narrow triggers instead:
--
-- (1) protect_presentation_after_publish - ROW-level, BEFORE UPDATE OR
--     DELETE: once the parent test_version is active/archived, a
--     presentation row is fully immutable - no correction, no deletion.
--     ("for share" locks the parent version row for the same
--     publish-transaction-race reason enforce_immutable_active_version
--     documents at its own definition above.)
create function tests.protect_presentation_after_publish()
returns trigger language plpgsql as $$
declare
  v_status varchar(10);
begin
  select status into v_status from tests.test_versions where id = OLD.test_version_id for share;
  if v_status in ('active','archived') then
    raise exception 'test_parameter_presentation row % belongs to a % test_version - immutable, correct it via a new draft test version instead', OLD.id, v_status;
  end if;
  return case when TG_OP = 'DELETE' then OLD else NEW end;
end $$;

create trigger protect_presentation_after_publish
  before update or delete on tests.test_parameter_presentation
  for each row execute function tests.protect_presentation_after_publish();

-- (2) enforce_presentation_backfill_once - STATEMENT-level (with a
--     transition table), AFTER INSERT: allows exactly ONE INSERT statement
--     to populate an already-active/archived version's presentation rows
--     (this migration's own backfill below, issued as a single multi-row
--     INSERT) - any LATER insert statement targeting a version that already
--     has presentation rows from a prior statement is rejected. Deliberately
--     a statement-level trigger, not row-level: a row-level "count existing
--     rows" check would see EARLIER ROWS OF THE SAME multi-row INSERT
--     statement as already present (BEFORE ROW triggers run per-row, and
--     Postgres makes each already-inserted row of the same statement visible
--     to a later row's own trigger query), which would wrongly reject rows
--     2..N of the very backfill statement this is meant to allow. A
--     draft-status version is never touched by this trigger (normal
--     draft-time editing stays exactly as free as tests.test_parameters'
--     own is) - it only ever fires for insert attempts against an
--     already-published version.
create function tests.enforce_presentation_backfill_once()
returns trigger language plpgsql as $$
declare
  v_conflict record;
begin
  for v_conflict in
    select p.test_version_id, v.status
    from tests.test_parameter_presentation p
    join tests.test_versions v on v.id = p.test_version_id
    where v.status in ('active','archived')
      and p.test_version_id in (select test_version_id from new_rows)
      and p.id not in (select id from new_rows)
    group by p.test_version_id, v.status
  loop
    raise exception 'test_parameter_presentation for % test_version % already has presentation rows from a prior statement - further inserts are blocked, use a new draft test version', v_conflict.status, v_conflict.test_version_id;
  end loop;
  return null;
end $$;

create trigger enforce_presentation_backfill_once
  after insert on tests.test_parameter_presentation
  referencing new table as new_rows
  for each statement execute function tests.enforce_presentation_backfill_once();

-- ------------------------------------------------------------
-- Backfill: postojeća aktivna WELLNESS verzija
-- (7a386bd1-d25e-4651-9012-e76d9dc32559, migrations_v2/202608221000_tests_
-- v42_seed_wellness_fms.sql, odeljak A) - jedan INSERT sa svih 6 redova, tako
-- da enforce_presentation_backfill_once iznad vidi ceo skup kao JEDNU
-- dozvoljenu backfill operaciju.
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
