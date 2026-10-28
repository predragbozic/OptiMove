-- Migration v42: the zone model, option A (phase 5b ★★; C102, C103; contract
-- docs/ai/phase5-zone-model-contract.md, section J7 of
-- docs/ai/gpexe-metric-variable-mapping-discovery.md).
--
-- A zone source field carries one shape of zone, and its meaning act confirms
-- the operator of that shape: `between` for the closed zones (an upper extreme
-- set), `>=` for the open top zone (no upper extreme). The seeded power field
-- keeps the closed zones; a new field, `.open_top`, carries the open top zone
-- of the same list; the seeded speed field carries its one open zone.
--   1. Fail closed: T2a and T2b SHARE ROW EXCLUSIVE, so no field or revision is
--      written between the checks and the seed; refused (23514) when the new
--      field already exists or a zone revision already carries a meaning proof
--      or an operator.
--   2. The seed window: source_metric_require_seed_window() takes v42's own
--      marker while v42 is not recorded, and every other marker is refused
--      (42501), as v34's body did for v34. Once v42 is recorded every marker
--      is refused again.
--   3. The seed (Z2): the T2a row of the open top zone and its revision 1, as
--      v34 seeded the parent (observed, active, no proof; no T8 row).
--   4. The zone rule (Z3): source_metric_revisions_actor_guard() is v39's body
--      with one branch changed - a zone's meaning act needs the operator
--      `between` or `>=` (23514). Every other branch is v39's, byte for byte.
--   5. Comments on the two functions.
--
-- No table, column, constraint, index or trigger is added or dropped; the
-- trigger names stay and only the two function bodies change. v34's guards,
-- v35, v36, v37's and v39's T8 guard and deferred links, v38, v40 and v41
-- stay as they are. No field is bound to its operator in the database (P4):
-- the mapping version's operator equality (v34) keeps a `>=` revision away
-- from a closed zone and a `between` revision away from the open one; the
-- rule "key -> zone shape" belongs to the extractor registry (7f).
-- Rollback: docs/runbooks/source-metric-zone-model-v42-rollback.sql (it
-- restores v41's catalog and refuses once any zone revision carries a meaning
-- proof). One transaction (the runner's), under the runner's lock timeout.

-- ---------------------------------------------------------------------------
-- 1. Fail closed.
-- ---------------------------------------------------------------------------
lock table training_load.source_metric_definitions, training_load.source_metric_definition_versions in share row exclusive mode;

do $$
begin
  if exists (select 1 from training_load.source_metric_definitions
              where source_system = 'gpexe' and api_family = 'rest_v1'
                and source_metric_key = 'more.complementary_data.power.distance.open_top') then
    raise exception 'source metric zone model: the open top zone field already exists' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.source_metric_definition_versions
              where parameter_kind = 'zone_bounds'
                and (meaning_verified_at is not null or bound_operator is not null)) then
    raise exception 'source metric zone model: a zone revision already carries a meaning proof or an operator' using errcode = '23514';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The seed window: v42's own marker, only inside v42's own transaction
-- (the runner records a migration after running its file, in the same
-- transaction). Any later row with a marker has no acting user and is refused.
-- ---------------------------------------------------------------------------
create or replace function training_load.source_metric_require_seed_window(p_marker text) returns void as $$
begin
  if p_marker is distinct from 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql'
     or exists (select 1 from public.schema_migrations where migration_name = p_marker) then
    raise exception 'source metric mapping: a seed marker is accepted only from the seeding migration' using errcode = '42501';
  end if;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 3. The seed (Z2): the open top zone of the power zone list, observed, with
-- no unit and no operator proven (P2, P3).
-- ---------------------------------------------------------------------------
insert into training_load.source_metric_definitions (source_system, api_family, source_metric_key, source_label, seed_migration)
values ('gpexe', 'rest_v1', 'more.complementary_data.power.distance.open_top', 'Power zone distance (open top zone)',
        'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql');

insert into training_load.source_metric_definition_versions
  (source_metric_definition_id, revision_number, value_shape, parameter_kind, supports_session, supports_drill,
   expected_source_unit, expected_source_bound_unit, unit_note, evidence_status, evidence_ref, state, activated_at, seed_migration)
select d.id, 1, 'zone_distance', 'zone_bounds', true, true, 'm', 'W/kg',
       'Expected unit is a hypothesis from the e03 pilot; not proven on server3. The open top zone of the power zone list: the zone whose upper extreme is null.',
       'observed', 'docs/ai/gpexe-rest-v1-compatibility.md#2-the-table', 'active', now(),
       'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql'
  from training_load.source_metric_definitions d
 where d.source_system = 'gpexe' and d.api_family = 'rest_v1'
   and d.source_metric_key = 'more.complementary_data.power.distance.open_top';

-- ---------------------------------------------------------------------------
-- 4. T2b's actor guard: v39's body; only the zone branch changes (Z3).
-- ---------------------------------------------------------------------------
create or replace function training_load.source_metric_revisions_actor_guard() returns trigger as $$
declare
  actor uuid;
  unit_act boolean;
  meaning_act boolean;
  state_facts constant text[] := array['state', 'activated_by_user_id', 'activated_at', 'retired_by_user_id', 'retired_at', 'retired_reason'];
begin
  if tg_op = 'INSERT' then
    -- O9: a seeding migration's own row, inside v34's seed window (v34's
    -- guard ran first and checked the marker against that window).
    if new.seed_migration is not null and new.created_by_user_id is null then
      return new;
    end if;
    actor := training_load.source_metric_context_actor();
    if training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'source metric revision: the acting user may not change a source revision' using errcode = '42501';
    end if;
    if new.seed_migration is not null then
      raise exception 'source metric revision: a seed marker is written only by a seeding migration, without an acting user' using errcode = '42501';
    end if;
    if new.created_by_user_id is distinct from actor then
      raise exception 'source metric revision: the row names another user than the acting user' using errcode = '42501';
    end if;
    if new.state is distinct from 'draft' then
      raise exception 'source_metric_definition_versions: a revision is created as draft' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.state is distinct from old.state then
    -- A state change writes only the state and its own facts.
    if (to_jsonb(new) - state_facts) is distinct from (to_jsonb(old) - state_facts) then
      raise exception 'source_metric_definition_versions: a state change writes only the state and its own facts' using errcode = '23514';
    end if;
    if not ((old.state = 'draft' and new.state = 'active')
            or (old.state in ('draft', 'active') and new.state = 'retired')) then
      raise exception 'source_metric_definition_versions: this revision state transition is not allowed' using errcode = '23514';
    end if;
    actor := training_load.source_metric_context_actor();
    if training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'source metric revision: the acting user may not change a source revision' using errcode = '42501';
    end if;
    if (new.state = 'active' and new.activated_by_user_id is distinct from actor)
       or (new.state = 'retired' and new.retired_by_user_id is distinct from actor) then
      raise exception 'source metric revision: the row names another user than the acting user' using errcode = '42501';
    end if;
    return new;
  end if;

  -- v37, unchanged: no state change, so exactly one verification act.
  unit_act := old.unit_verified_at is null and new.unit_verified_at is not null;
  meaning_act := old.meaning_verified_at is null and new.meaning_verified_at is not null;
  if unit_act = meaning_act
     or (new.evidence_status is distinct from old.evidence_status and new.evidence_status <> 'verified') then
    raise exception 'source_metric_definition_versions: a revision is changed only by one unit or meaning verification' using errcode = '23514';
  end if;
  actor := training_load.source_metric_context_actor();
  if training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
    raise exception 'source metric verification: the acting user may not verify a source metric' using errcode = '42501';
  end if;
  if (unit_act and new.unit_verified_by_user_id is distinct from actor)
     or (meaning_act and new.meaning_verified_by_user_id is distinct from actor) then
    raise exception 'source metric verification: the row names another user than the acting user' using errcode = '42501';
  end if;
  -- v42 (Z3): a zone's meaning act confirms the operator of its shape -
  -- between for the closed zones, >= for the open top zone.
  if meaning_act and new.parameter_kind = 'zone_bounds'
     and (new.bound_operator is null or new.bound_operator not in ('between', '>=')) then
    raise exception 'source_metric_definition_versions: a zone takes the operator between or >=' using errcode = '23514';
  end if;
  if meaning_act and new.parameter_kind = 'event_threshold'
     and (new.bound_operator is null or new.bound_operator not in ('>=', '>', '<=', '<')) then
    raise exception 'source_metric_definition_versions: an event threshold takes a one-sided operator' using errcode = '23514';
  end if;
  if old.evidence_ref is null and new.evidence_ref is not null
     and new.evidence_ref is distinct from (case when unit_act then new.unit_evidence_ref else new.meaning_evidence_ref end) then
    raise exception 'source_metric_definition_versions: the first evidence reference is the completing act''s own' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 5. Comments.
-- ---------------------------------------------------------------------------
comment on function training_load.source_metric_require_seed_window(text) is
  'v42 (C102, C103): accepts only v42''s own seed marker, and only inside v42''s own transaction; every marker is refused once v42 is recorded.';
comment on function training_load.source_metric_revisions_actor_guard() is
  'v42 (C102, C103): v39''s guard; a zone''s meaning act needs the operator between (closed zones) or >= (the open top zone).';
