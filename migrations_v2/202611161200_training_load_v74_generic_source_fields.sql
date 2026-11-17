-- v74: generic source fields - creating a field from the GPEXE inventory and its source_stated evidence (G1).
--
-- Contract: docs/ai/gpexe-field-inventory-plan.md, section 8 (accepted, PR #564; the owner's decision (a)
-- of 2026-11-16: for generic plain fields one board tick proves the unit and the meaning). It builds the
-- shapes v65 reserved for J18's 18-P (docs/ai/c112-drag-mapping-contract.md, 5.1 note, 5.7, 15.2):
--
--   * T2a: a platform admin creates a field (route C): a BEFORE INSERT actor guard for a row with an acting
--     user (seed rows keep v34's window), only a generic gpexe / rest_v1 key (athlete_session.* or
--     details.players.*), and a deferred link to its source_metric_create row in T8 (whose chain this builds).
--   * T2b: the evidence status source_stated; unit_observation_id and meaning_observation_id (a typed link
--     to the confirmation that proves them; evidence_ref_ok stays docs-only, decision (f)); the CHECKs that
--     tie them to the proof; the observed act in the actor guard; the write-once guard and the audit link.
--   * T9 / T9i: the kind field_observation (system scope, no club, one revision) and the row kind field_unit
--     (one compared row, the two athletes' raw values in the unit GPEXE states, shown as sent; no mapping, no
--     stored value), with their guards and deferred checks (one session, one row, the revision names it).
--   * T8: the actions source_metric_unit_observed (keyed: the request record) and
--     source_metric_meaning_observed, their shapes and chains, and the chain of source_metric_create.
--   * The display registry: the generic rule as_sent (section 8.7), any unit token.
--   * The gates of v52 (activation) and v65 (T9i) accept source_stated as well as verified.
--   * GPEXE's unit words (section 8.10): the seed-only table source_unit_words, nine rows; a field_unit row names its
--     word, and its unit token, display rule and screen unit come from that word's row.
--
-- Bodies are replaced after an md5 check of the body in force; every replaced body keeps its lines and adds
-- its new ones between "-- G1 (v74) begin" and "-- G1 (v74) end". The revisions already verified by
-- documents are not changed by this migration (the post-check compares their digest with the preflight's).
--
-- Errors: 42501 for an acting user who may not; 23514 with fixed text for every other refusal; no id, name,
-- unit or value in a message.
-- Locks, in the writers' order (v65, v39, v37: T4, T2b, T9, T8), every one taken here before the first change: T4 SHARE
-- ROW EXCLUSIVE (as v65), T2a SHARE ROW EXCLUSIVE (its triggers), then T2b, T9 and T9i ACCESS EXCLUSIVE, each wait bounded
-- by lock_timeout 5 s, and T8 last, ACCESS EXCLUSIVE NOWAIT (a busy table fails the migration at once, nothing applied).
-- The order is pinned by a test of the file's statements (backend/tests/source-field-create-g1-unit.test.mjs).
-- Rollback: docs/runbooks/generic-source-fields-v74-rollback.sql.

set local lock_timeout = '5s';
lock table training_load.source_metric_mapping_versions in share row exclusive mode;
lock table training_load.source_metric_definitions in share row exclusive mode;
lock table training_load.source_metric_definition_versions in access exclusive mode;
lock table training_load.source_metric_confirmations in access exclusive mode;
lock table training_load.source_metric_confirmation_items in access exclusive mode;
lock table training_load.source_metric_audit in access exclusive mode nowait;

-- 1. Written on the bodies in force: refuse any other.
do $$
declare
  expected constant text[][] := array[
    ['source_metric_revisions_guard', 'ddd8721160d7f5efa8a456fc220532c2', 'v34'],
    ['source_metric_revisions_actor_guard', 'e9ecbc6b57ed3f2dc93a450707c9270f', 'v42'],
    ['source_metric_revisions_audit_link', '65a257caab8316ad595fa3a1351f2545', 'v37'],
    ['source_metric_require_seed_window', '7b475353e78d96e24cb4c7beeb440af4', 'v42'],
    ['source_metric_display_unit_ok', 'ce1f638445a5a9539b8f38e2dc7196b0', 'v65'],
    ['source_metric_confirmations_insert_guard', 'bbab4e588f066c01abee0cf931c4c768', 'v65'],
    ['source_metric_confirmation_items_insert_guard', 'e653a3f19a7509468035912c4af4fddc', 'v65'],
    ['source_metric_confirmation_rows_hold', 'cad0eba4b81cd3abf13e81be61879a17', 'v65'],
    ['source_metric_confirmations_commit_link', '5d424bf0457f4b94a2377b733b6b1414', 'v65'],
    ['source_metric_audit_row_ok', '0ef48fd391a5380f70c92d96f47f894a', 'v65'],
    ['source_metric_audit_revision_guard', '942b806526756311a5289b42c27e4918', 'v65'],
    ['source_metric_mapping_versions_update_guard', '42fb55a2dd043328079fa9b6f4a2c43e', 'v52'],
    ['source_metric_confirmation_items_update_guard', 'e622fb9b4b231a227446415bfa24bd8c', 'v65'],
    ['source_metric_confirmation_item_digest', 'c7b8d407b350b1a3073b56bd72bd64b4', 'v65']];
  i integer;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v74 refused: the body in force of training_load.% is not %''s', expected[i][1], expected[i][3] using errcode = '23514';
    end if;
  end loop;
end;
$$;

-- 2. T2a: a field created by an acting user (route C).
-- Scope (a known limit, as v35's C74): v37 never guarded a T2a insert, and a write without an acting user stays
-- as it was before v74 (a seed row keeps v34's window; a raw insert through the owner credentials is outside
-- every guard of this kind). A write WITH an acting user - every application write sets one first - is held to
-- route C's contract here and, at COMMIT, to its source_metric_create row.
create function training_load.source_metric_definitions_actor_guard() returns trigger as $$
declare
  actor uuid;
begin
  if new.created_by_user_id is null then
    -- A seed row: v34's guard decides (its seed window).
    return new;
  end if;
  actor := training_load.source_metric_confirmation_actor_or_null();
  if actor is null then
    return new;
  end if;
  if new.created_by_user_id is distinct from actor
     or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
    raise exception 'source metric: the acting user may not create a source metric' using errcode = '42501';
  end if;
  if new.source_system is distinct from 'gpexe' or new.api_family is distinct from 'rest_v1'
     or not (new.source_metric_key like 'athlete\_session.%' or new.source_metric_key like 'details.players.%') then
    raise exception 'source_metric_definitions: a created source metric is a generic gpexe / rest_v1 field' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_definitions_v74_actor_guard
  before insert on training_load.source_metric_definitions
  for each row execute function training_load.source_metric_definitions_actor_guard();

create function training_load.source_metric_definitions_create_link() returns trigger as $$
begin
  -- The acting user is a transaction-local setting, still set at COMMIT; a row written without one is out of
  -- scope (see the actor guard).
  if training_load.source_metric_confirmation_actor_or_null() is null then
    return null;
  end if;
  if not exists (select 1 from training_load.source_metric_audit
                  where action = 'source_metric_create' and source_metric_definition_id = new.id
                    and performed_by_user_id = new.created_by_user_id) then
    raise exception 'source_metric_definitions: a created source metric is written with its source_metric_create audit row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger source_metric_definitions_v74_create_link
  after insert on training_load.source_metric_definitions
  deferrable initially deferred
  for each row when (new.created_by_user_id is not null)
  execute function training_load.source_metric_definitions_create_link();

-- 3. T9: the field observation.
alter table training_load.source_metric_confirmations
  add column source_metric_version_id uuid
    constraint source_metric_confirmations_revision_fk
    references training_load.source_metric_definition_versions(id) on delete restrict,
  alter column owner_club_id drop not null,
  drop constraint source_metric_confirmations_kind_check,
  add constraint source_metric_confirmations_kind_check check (kind in ('team_mapping', 'field_observation')),
  drop constraint source_metric_confirmations_owner_scope_check,
  add constraint source_metric_confirmations_owner_scope_check check (owner_scope in ('club', 'system')),
  add constraint source_metric_confirmations_kind_shape check (
    (kind = 'team_mapping' and owner_scope = 'club' and owner_club_id is not null and source_metric_version_id is null)
    or (kind = 'field_observation' and owner_scope = 'system' and owner_club_id is null
        and source_metric_version_id is not null and confirmed_basis = 'platform_admin'));

create index source_metric_confirmations_revision_idx
  on training_load.source_metric_confirmations (source_metric_version_id) where source_metric_version_id is not null;

-- 4. T9i: the field_unit row.
alter table training_load.source_metric_confirmation_items
  alter column mapping_version_id drop not null,
  alter column parameter_fingerprint drop not null,
  alter column target_unit drop not null,
  alter column scale drop not null,
  alter column scale_divisor drop not null,
  alter column "offset" drop not null,
  add column source_unit_word text
    constraint source_metric_confirmation_items_unit_word_format check (source_unit_word is null or source_unit_word ~ '^[a-z][a-z0-9_]{0,39}$'),
  add constraint source_metric_confirmation_items_unit_word_iff check ((item_kind = 'field_unit') = (source_unit_word is not null)),
  drop constraint source_metric_confirmation_items_kind_check,
  add constraint source_metric_confirmation_items_kind_check check (item_kind in ('club_mapping', 'system_mapping', 'field_unit')),
  drop constraint source_metric_confirmation_items_system_unchecked,
  add constraint source_metric_confirmation_items_system_unchecked check (item_kind in ('club_mapping', 'field_unit') or not checked),
  add constraint source_metric_confirmation_items_field_unit_shape check (
    (item_kind = 'field_unit' and checked and mapping_version_id is null and parameter_fingerprint is null
       and target_unit is null and scale is null and scale_divisor is null and "offset" is null
       and stored_a is null and stored_b is null)
    or (item_kind <> 'field_unit' and mapping_version_id is not null and parameter_fingerprint is not null
       and target_unit is not null and scale is not null and scale_divisor is not null and "offset" is not null)),
  drop constraint source_metric_confirmation_items_values_together,
  add constraint source_metric_confirmation_items_values_together check (
    (item_kind <> 'field_unit' and num_nonnulls(raw_a, stored_a, raw_b, stored_b, values_salt) in (0, 5))
    or (item_kind = 'field_unit' and num_nonnulls(raw_a, raw_b, values_salt) in (0, 3))),
  drop constraint source_metric_confirmation_items_values_converted,
  add constraint source_metric_confirmation_items_values_converted check (
    raw_a is null or item_kind = 'field_unit'
    or (training_load.source_metric_value_matches(raw_a, stored_a, scale, scale_divisor, "offset")
        and training_load.source_metric_value_matches(raw_b, stored_b, scale, scale_divisor, "offset")));

-- 5. T2b: source_stated and its typed proof.
alter table training_load.source_metric_definition_versions
  add column unit_observation_id uuid
    constraint source_metric_revisions_unit_observation_fk
    references training_load.source_metric_confirmations(id) on delete restrict,
  add column meaning_observation_id uuid
    constraint source_metric_revisions_meaning_observation_fk
    references training_load.source_metric_confirmations(id) on delete restrict,
  drop constraint source_metric_revisions_evidence_status_check,
  add constraint source_metric_revisions_evidence_status_check
    check (evidence_status in ('unproven', 'documented', 'observed', 'verified', 'source_stated')),
  drop constraint source_metric_revisions_unit_proof_together,
  add constraint source_metric_revisions_unit_proof_together check (
    (unit_verified_by_user_id is null) = (unit_verified_at is null) and
    (unit_verified_at is null) = (num_nonnulls(unit_evidence_ref, unit_observation_id) = 0) and
    num_nonnulls(unit_evidence_ref, unit_observation_id) <= 1),
  drop constraint source_metric_revisions_meaning_proof_together,
  add constraint source_metric_revisions_meaning_proof_together check (
    (meaning_verified_by_user_id is null) = (meaning_verified_at is null) and
    (meaning_verified_at is null) = (num_nonnulls(meaning_evidence_ref, meaning_observation_id) = 0) and
    num_nonnulls(meaning_evidence_ref, meaning_observation_id) <= 1),
  add constraint source_metric_revisions_observation_together check (
    (unit_observation_id is null and meaning_observation_id is null)
    or (unit_observation_id = meaning_observation_id and parameter_kind = 'none')),
  drop constraint source_metric_revisions_verified_iff_proven,
  add constraint source_metric_revisions_verified_iff_proven check (
    (evidence_status in ('verified', 'source_stated')) =
    (source_unit is not null and meaning_verified_at is not null and (parameter_kind = 'none' or bound_operator is not null))
    and (evidence_status = 'source_stated') = (unit_observation_id is not null)),
  drop constraint source_metric_revisions_evidence_ref_iff_proven,
  add constraint source_metric_revisions_evidence_ref_iff_proven
    check ((evidence_status in ('unproven', 'source_stated')) = (evidence_ref is null));

create index source_metric_revisions_unit_observation_idx
  on training_load.source_metric_definition_versions (unit_observation_id) where unit_observation_id is not null;
create index source_metric_revisions_meaning_observation_idx
  on training_load.source_metric_definition_versions (meaning_observation_id) where meaning_observation_id is not null;

-- 6. The replaced bodies.
CREATE OR REPLACE FUNCTION training_load.source_metric_revisions_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  ranks constant text[] := array['unproven', 'documented', 'observed', 'source_stated', 'verified'];
  unit_act boolean;
  meaning_act boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'source_metric_definition_versions: a revision is never deleted; retire it' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    -- C42: a new revision only for an active source metric (T2a -> T2b).
    perform 1 from training_load.source_metric_definitions
     where id = new.source_metric_definition_id and state = 'active' for share;
    if not found then
      raise exception 'source_metric_definition_versions: a revision is created only for an active source metric' using errcode = '23514';
    end if;
    if not (new.state = 'draft' or (new.state = 'active' and new.seed_migration is not null)) then
      raise exception 'source_metric_definition_versions: a revision is created as draft; only a seed migration creates it active' using errcode = '23514';
    end if;
    if new.source_unit is not null or new.source_bound_unit is not null or new.unit_verified_by_user_id is not null
       or new.unit_verified_at is not null or new.unit_evidence_ref is not null or new.meaning_verified_by_user_id is not null
       or new.meaning_verified_at is not null or new.meaning_evidence_ref is not null or new.bound_operator is not null
       or new.activated_by_user_id is not null
       or new.unit_observation_id is not null or new.meaning_observation_id is not null then
      raise exception 'source_metric_definition_versions: a revision is created without proof; unit and meaning are verified afterwards' using errcode = '23514';
    end if;
    if new.seed_migration is not null then
      perform training_load.source_metric_require_seed_window(new.seed_migration);
    end if;
    return new;
  end if;

  if old.state = 'retired' then
    if new is distinct from old then
      raise exception 'source_metric_definition_versions: a retired revision is immutable' using errcode = '23514';
    end if;
    return new;
  end if;
  -- C42: identity, hypothesis, shape, parameter kind and levels are immutable.
  if new.id is distinct from old.id or new.source_metric_definition_id is distinct from old.source_metric_definition_id
     or new.revision_number is distinct from old.revision_number or new.value_shape is distinct from old.value_shape
     or new.parameter_kind is distinct from old.parameter_kind or new.supports_session is distinct from old.supports_session
     or new.supports_drill is distinct from old.supports_drill or new.expected_source_unit is distinct from old.expected_source_unit
     or new.expected_source_bound_unit is distinct from old.expected_source_bound_unit or new.unit_note is distinct from old.unit_note
     or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at
     or new.seed_migration is distinct from old.seed_migration then
    raise exception 'source_metric_definition_versions: the contract of a revision is immutable; correct it with a new revision' using errcode = '23514';
  end if;
  -- Proof is written once, from NULL, by its own act, never overwritten or cleared.
  if old.unit_verified_at is not null
     and (new.source_unit, new.source_bound_unit, new.unit_verified_by_user_id, new.unit_verified_at, new.unit_evidence_ref, new.unit_observation_id)
         is distinct from (old.source_unit, old.source_bound_unit, old.unit_verified_by_user_id, old.unit_verified_at, old.unit_evidence_ref, old.unit_observation_id) then
    raise exception 'source_metric_definition_versions: a unit proof is written once' using errcode = '23514';
  end if;
  if old.meaning_verified_at is not null
     and (new.bound_operator, new.meaning_verified_by_user_id, new.meaning_verified_at, new.meaning_evidence_ref, new.meaning_observation_id)
         is distinct from (old.bound_operator, old.meaning_verified_by_user_id, old.meaning_verified_at, old.meaning_evidence_ref, old.meaning_observation_id) then
    raise exception 'source_metric_definition_versions: a meaning proof is written once' using errcode = '23514';
  end if;
  if array_position(ranks, new.evidence_status) < array_position(ranks, old.evidence_status) then
    raise exception 'source_metric_definition_versions: the evidence status only rises' using errcode = '23514';
  end if;
  if old.evidence_ref is not null and new.evidence_ref is distinct from old.evidence_ref then
    raise exception 'source_metric_definition_versions: the evidence reference is written once' using errcode = '23514';
  end if;
  unit_act := old.unit_verified_at is null and new.unit_verified_at is not null;
  meaning_act := old.meaning_verified_at is null and new.meaning_verified_at is not null;
  if (unit_act or meaning_act) and new.state is distinct from old.state then
    raise exception 'source_metric_definition_versions: a verification is its own act, apart from a state change' using errcode = '23514';
  end if;

  if new.state is not distinct from old.state then
    if (new.activated_by_user_id, new.activated_at, new.retired_by_user_id, new.retired_at, new.retired_reason)
       is distinct from (old.activated_by_user_id, old.activated_at, old.retired_by_user_id, old.retired_at, old.retired_reason) then
      raise exception 'source_metric_definition_versions: the state facts are written by their transition' using errcode = '23514';
    end if;
  elsif old.state = 'draft' and new.state = 'active' then
    -- C42: activation needs an active source metric (a committed draft already
    -- blocks retirement, so this plain read is a backstop) and no other
    -- active revision (the partial unique index is the physical guard).
    if not exists (select 1 from training_load.source_metric_definitions
                    where id = new.source_metric_definition_id and state = 'active') then
      raise exception 'source_metric_definition_versions: a revision of a retired source metric is not activated' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_definition_versions
                where source_metric_definition_id = new.source_metric_definition_id and id <> new.id and state = 'active') then
      raise exception 'source_metric_definition_versions: another revision of this source metric is active; retire it first' using errcode = '23514';
    end if;
  elsif new.state = 'retired' then
    if (new.activated_by_user_id, new.activated_at) is distinct from (old.activated_by_user_id, old.activated_at) then
      raise exception 'source_metric_definition_versions: the state facts are written by their transition' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_mapping_versions
                where source_metric_version_id = old.id and status in ('needs_review', 'active')) then
      raise exception 'source_metric_definition_versions: a revision pinned by a submitted or active mapping version is not retired' using errcode = '23514';
    end if;
  else
    raise exception 'source_metric_definition_versions: this revision state transition is not allowed' using errcode = '23514';
  end if;

  -- The acting users the contract names (D intro), after every registry row.
  if unit_act then
    perform training_load.source_metric_require_platform_admin(new.unit_verified_by_user_id);
  end if;
  if meaning_act then
    perform training_load.source_metric_require_platform_admin(new.meaning_verified_by_user_id);
  end if;
  if old.state = 'draft' and new.state = 'active' then
    perform training_load.source_metric_require_platform_admin(new.activated_by_user_id);
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_revisions_actor_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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

  -- G1 (v74) begin: the observed act (route O, plan section 8.2) - the unit and the meaning
  -- together, both proved by one field_observation confirmation of this revision, written
  -- in this transaction by the acting user; the status rises from unproven to source_stated.
  if old.unit_observation_id is null and new.unit_observation_id is not null then
    if old.unit_verified_at is not null or old.meaning_verified_at is not null or new.unit_verified_at is null
       or new.meaning_verified_at is null or new.meaning_observation_id is distinct from new.unit_observation_id
       or old.evidence_status is distinct from 'unproven' or new.evidence_status is distinct from 'source_stated'
       or new.parameter_kind is distinct from 'none' or new.state is distinct from 'active'
       or new.bound_operator is not null or new.source_bound_unit is not null then
      raise exception 'source_metric_definition_versions: an observed act proves the unit and the meaning of an unproven active field without parameters together' using errcode = '23514';
    end if;
    actor := training_load.source_metric_context_actor();
    if training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'source metric verification: the acting user may not verify a source metric' using errcode = '42501';
    end if;
    if new.unit_verified_by_user_id is distinct from actor or new.meaning_verified_by_user_id is distinct from actor then
      raise exception 'source metric verification: the row names another user than the acting user' using errcode = '42501';
    end if;
    if not exists (select 1 from training_load.source_metric_confirmations c
                    where c.id = new.unit_observation_id and c.kind = 'field_observation'
                      and c.source_metric_version_id = new.id and c.confirmed_by_user_id = actor
                      and c.xmin::text::bigint = training_load.source_metric_current_xmin())
       or not exists (select 1 from training_load.source_metric_confirmation_items i
                       where i.confirmation_id = new.unit_observation_id and i.item_kind = 'field_unit' and i.checked
                         and i.source_unit = new.source_unit
                         and i.xmin::text::bigint = training_load.source_metric_current_xmin()) then
      raise exception 'source_metric_definition_versions: an observed act names its own confirmation of this revision, written in this transaction' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.meaning_observation_id is distinct from old.meaning_observation_id then
    raise exception 'source_metric_definition_versions: an observed act proves the unit and the meaning together' using errcode = '23514';
  end if;
  -- G1 (v74) end
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
$function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_revisions_audit_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- G1 (v74) begin: an observed act (unit_observation_id) is written with its two observed rows.
  if old.unit_observation_id is null and new.unit_observation_id is not null then
    if not exists (select 1 from training_load.source_metric_audit
                    where action = 'source_metric_unit_observed' and source_metric_version_id = new.id
                      and confirmation_id = new.unit_observation_id)
       or not exists (select 1 from training_load.source_metric_audit
                       where action = 'source_metric_meaning_observed' and source_metric_version_id = new.id
                         and confirmation_id = new.meaning_observation_id) then
      raise exception 'source_metric_definition_versions: an observed act is written with its source_metric_unit_observed and source_metric_meaning_observed audit rows' using errcode = '23514';
    end if;
    return null;
  end if;
  -- G1 (v74) end
  if old.unit_verified_at is null and new.unit_verified_at is not null
     and not exists (select 1 from training_load.source_metric_audit
                      where action = 'source_metric_unit_verified' and source_metric_version_id = new.id) then
    raise exception 'source_metric_definition_versions: a unit verification is written with its source_metric_unit_verified audit row' using errcode = '23514';
  end if;
  if old.meaning_verified_at is null and new.meaning_verified_at is not null
     and not exists (select 1 from training_load.source_metric_audit
                      where action = 'source_metric_meaning_verified' and source_metric_version_id = new.id) then
    raise exception 'source_metric_definition_versions: a meaning verification is written with its source_metric_meaning_verified audit row' using errcode = '23514';
  end if;
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_require_seed_window(p_marker text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
begin
  if p_marker is distinct from 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql'
     or exists (select 1 from public.schema_migrations where migration_name = p_marker) then
    raise exception 'source metric mapping: a seed marker is accepted only from the seeding migration' using errcode = '42501';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_display_unit_ok(p_rule text, p_unit text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
    select coalesce(case p_rule
      when 'duration_mmss' then p_unit = 'mm:ss'
      when 'distance_m' then p_unit = 'm'
      when 'speed_kmh' then p_unit = 'km/h'
      -- G1 (v74, plan section 8.7): the value as GPEXE sends it, in the field's own unit token.
      when 'as_sent' then training_load.source_metric_unit_token_ok(p_unit)
      else false end, false)
  $function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_confirmations_insert_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  actor uuid := training_load.source_metric_context_actor();
  bnd record;
  club uuid;
  basis text;
begin
  if new.confirmed_by_user_id is distinct from actor then
    raise exception 'source metric confirmation: the row names another user than the acting user' using errcode = '42501';
  end if;
  -- The time and the expiry are the database's, never the writer's.
  new.confirmed_at := clock_timestamp();
  new.values_expire_at := new.confirmed_at + interval '2160 hours';
  -- v27 rows, plain reads (an Unbind is never inverted).
  select connection_id, team_id, state into bnd
    from training_load.source_team_bindings where id = new.binding_id;
  if not found or bnd.state is distinct from 'active' then
    raise exception 'source_metric_confirmations: the team binding is not active' using errcode = '23514';
  end if;
  if bnd.team_id is distinct from new.team_id then
    raise exception 'source_metric_confirmations: the team is not the binding''s' using errcode = '23514';
  end if;
  if bnd.connection_id is distinct from new.credential_connection_id then
    raise exception 'source_metric_confirmations: the connection is not the binding''s' using errcode = '23514';
  end if;
  -- G1 (v74) begin: the platform's observation of one field (route O): system scope, no club, an active
  -- platform admin; the revision active, unproven, without parameters, of a generic gpexe / rest_v1 field.
  if new.kind = 'field_observation' then
    if new.owner_scope is distinct from 'system' or new.owner_club_id is not null or new.source_metric_version_id is null then
      raise exception 'source_metric_confirmations: a field observation is OptiMove''s, for one revision' using errcode = '23514';
    end if;
    if training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' or new.confirmed_basis is distinct from 'platform_admin' then
      raise exception 'source metric confirmation: the acting user may not write this confirmation' using errcode = '42501';
    end if;
    if not exists (select 1 from training_load.source_metric_definition_versions r
                     join training_load.source_metric_definitions d on d.id = r.source_metric_definition_id
                    where r.id = new.source_metric_version_id and r.state = 'active' and r.evidence_status = 'unproven'
                      and r.parameter_kind = 'none' and r.unit_verified_at is null and r.meaning_verified_at is null
                      and d.state = 'active' and d.source_system = 'gpexe' and d.api_family = 'rest_v1'
                      and (d.source_metric_key like 'athlete\_session.%' or d.source_metric_key like 'details.players.%')) then
      raise exception 'source_metric_confirmations: the revision is not an active, unproven generic field without parameters' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.kind is distinct from 'team_mapping' or new.source_metric_version_id is not null then
    raise exception 'source_metric_confirmations: a team''s confirmation names no revision' using errcode = '23514';
  end if;
  -- G1 (v74) end
  club := training_load.source_metric_binding_club(new.binding_id);
  if club is null or club is distinct from new.owner_club_id then
    raise exception 'source_metric_confirmations: the binding''s connection is not owned by the confirmation''s club' using errcode = '23514';
  end if;
  -- The basis the database derives for that club (v54: users first).
  basis := training_load.source_metric_actor_basis(actor, new.owner_club_id);
  if basis is null or new.confirmed_basis is distinct from basis then
    raise exception 'source metric confirmation: the acting user may not write this confirmation' using errcode = '42501';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_confirmation_items_insert_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  conf training_load.source_metric_confirmations := training_load.source_metric_confirmation_of_this_transaction(new.confirmation_id);
  ver record;
  rev record;
  word record; -- G1 (v74)
begin
  -- Before anything else that could fail on a row holding values: the three
  -- columns no other rule below reads (a NOT NULL or CHECK failure would
  -- print the row).
  if new.id is null or new.session_ordinal is null or new.item_no is null or new.item_no <= 0 then
    raise exception 'source_metric_confirmation_items: a row names its id, its session and a positive number' using errcode = '23514';
  end if;
  if new.values_removed_at is not null or new.values_removed_kind is not null or new.values_removed_by_user_id is not null then
    raise exception 'source_metric_confirmation_items: a row is created with no removal' using errcode = '23514';
  end if;
  if new.compared_level is distinct from 'session' then
    raise exception 'source_metric_confirmation_items: the two athletes are compared at the session level' using errcode = '23514';
  end if;
  -- G1 (v74) begin: a field_unit row - the platform's observation of one field: one row, the two athletes'
  -- raw values in the unit GPEXE states, shown as sent; no mapping version, no stored value.
  if new.item_kind = 'field_unit' or conf.kind = 'field_observation' then
    if new.item_kind is distinct from 'field_unit' or conf.kind is distinct from 'field_observation' then
      raise exception 'source_metric_confirmation_items: a field observation has only a field_unit row' using errcode = '23514';
    end if;
    if new.source_unit_word is null or new.item_no <> 1 or new.session_ordinal <> 1 or new.checked is distinct from true
       or new.source_metric_version_id is distinct from conf.source_metric_version_id
       or new.mapping_version_id is not null or new.parameter_fingerprint is not null or new.target_unit is not null
       or new.scale is not null or new.scale_divisor is not null or new."offset" is not null
       or new.stored_a is not null or new.stored_b is not null then
      raise exception 'source_metric_confirmation_items: a field_unit row is the one compared row of its revision, with no mapping' using errcode = '23514';
    end if;
    -- The word GPEXE sends is a kind (plan section 8.10): its unit token, display rule and screen unit come from
    -- source_unit_words only; a word without a row is never guessed.
    select w.source_unit, w.display_rule into word
      from training_load.source_unit_words w
     where w.source_system = 'gpexe' and w.api_family = 'rest_v1' and w.word = new.source_unit_word;
    if not found or new.source_unit is distinct from word.source_unit then
      raise exception 'source_metric_confirmation_items: the unit word GPEXE sends has a seeded unit, and the row''s unit is it' using errcode = '23514';
    end if;
    if new.gpexe_display_rule is distinct from word.display_rule
       or new.gpexe_display_unit is distinct from (case word.display_rule when 'as_sent' then word.source_unit when 'speed_kmh' then 'km/h'
                                                     when 'duration_mmss' then 'mm:ss' when 'distance_m' then 'm' end) then
      raise exception 'source_metric_confirmation_items: a field_unit row is compared by its word''s display rule, in that rule''s screen unit' using errcode = '23514';
    end if;
    if not training_load.source_metric_confirmation_number_ok(new.raw_a) or not training_load.source_metric_confirmation_number_ok(new.raw_b) then
      raise exception 'source_metric_confirmation_items: a compared row stores two finite values' using errcode = '23514';
    end if;
    if new.raw_a = 0 or new.raw_b = 0 or new.raw_a = new.raw_b then
      raise exception 'source_metric_confirmation_items: the two athletes'' values are non-zero and different' using errcode = '23514';
    end if;
    new.values_salt := uuid_send(gen_random_uuid());
    new.values_digest := training_load.source_metric_confirmation_item_digest(new);
    return new;
  end if;
  -- G1 (v74) end
  if new.source_unit_word is not null then -- G1 (v74)
    raise exception 'source_metric_confirmation_items: only a field_unit row names a unit word' using errcode = '23514';
  end if;
  -- The T4 version and its T2b revision: plain reads (the writer holds their
  -- locks; a guard takes none).
  select owner_key, source_metric_version_id, parameter_fingerprint, source_unit, target_unit, scale, scale_divisor, "offset" into ver
    from training_load.source_metric_mapping_versions where id = new.mapping_version_id;
  if not found then
    raise exception 'source_metric_confirmation_items: the row names no mapping version' using errcode = '23514';
  end if;
  if new.item_kind = 'club_mapping' then
    if ver.owner_key is distinct from conf.owner_club_id::text then
      raise exception 'source_metric_confirmation_items: a club row names a mapping version of the confirmation''s club' using errcode = '23514';
    end if;
  elsif new.item_kind = 'system_mapping' then
    if ver.owner_key is distinct from 'system' then
      raise exception 'source_metric_confirmation_items: a system row names a system mapping version' using errcode = '23514';
    end if;
    if new.checked then
      raise exception 'source_metric_confirmation_items: a system mapping is not compared' using errcode = '23514';
    end if;
  else
    raise exception 'source_metric_confirmation_items: the row''s kind is not one of this table''s' using errcode = '23514';
  end if;
  if new.source_metric_version_id is distinct from ver.source_metric_version_id
     or new.parameter_fingerprint is distinct from ver.parameter_fingerprint
     or new.source_unit is distinct from ver.source_unit or new.target_unit is distinct from ver.target_unit
     or new.scale::text is distinct from ver.scale::text or new.scale_divisor::text is distinct from ver.scale_divisor::text
     or new."offset"::text is distinct from ver."offset"::text then
    raise exception 'source_metric_confirmation_items: the row''s facts are not the mapping version''s' using errcode = '23514';
  end if;
  select state, evidence_status, source_unit into rev
    from training_load.source_metric_definition_versions where id = new.source_metric_version_id;
  if rev.state is distinct from 'active' or rev.evidence_status not in ('verified', 'source_stated') then -- G1 (v74): or source_stated
    raise exception 'source_metric_confirmation_items: the source revision must be active and verified' using errcode = '23514';
  end if;
  if rev.source_unit is distinct from new.source_unit then
    raise exception 'source_metric_confirmation_items: the source unit is not the revision''s proven unit' using errcode = '23514';
  end if;
  -- The salt and the digest are the database's: whatever the writer sent is
  -- overwritten below.
  new.values_salt := null;
  new.values_digest := null;
  if new.checked is distinct from true then
    if new.checked is null then
      raise exception 'source_metric_confirmation_items: a row says whether it was compared' using errcode = '23514';
    end if;
    if new.raw_a is not null or new.stored_a is not null or new.raw_b is not null or new.stored_b is not null
       or new.gpexe_display_rule is not null or new.gpexe_display_unit is not null then
      raise exception 'source_metric_confirmation_items: a row that was not compared stores no values and no display unit' using errcode = '23514';
    end if;
    return new;
  end if;
  -- A checked row. Every refusal below is fixed text: the row holds values.
  if new.gpexe_display_rule is null or new.gpexe_display_unit is null
     or new.gpexe_display_rule !~ '^[a-z_]{1,40}$'
     or not training_load.source_metric_display_unit_ok(new.gpexe_display_rule, new.gpexe_display_unit)
     or (new.gpexe_display_rule = 'as_sent' and new.gpexe_display_unit is distinct from new.source_unit) -- G1 (v74): as sent, in the row's own unit
     then
    raise exception 'source_metric_confirmation_items: a compared row names a display rule and a unit of that rule' using errcode = '23514';
  end if;
  if not training_load.source_metric_confirmation_number_ok(new.raw_a) or not training_load.source_metric_confirmation_number_ok(new.raw_b)
     or not training_load.source_metric_confirmation_number_ok(new.stored_a) or not training_load.source_metric_confirmation_number_ok(new.stored_b) then
    raise exception 'source_metric_confirmation_items: a compared row stores four finite values' using errcode = '23514';
  end if;
  if new.raw_a = 0 or new.raw_b = 0 or new.raw_a = new.raw_b then
    raise exception 'source_metric_confirmation_items: the two athletes'' values are non-zero and different' using errcode = '23514';
  end if;
  if not training_load.source_metric_value_matches(new.raw_a, new.stored_a, new.scale, new.scale_divisor, new."offset")
     or not training_load.source_metric_value_matches(new.raw_b, new.stored_b, new.scale, new.scale_divisor, new."offset") then
    raise exception 'source_metric_confirmation_items: a stored value is not the conversion of its raw value' using errcode = '23514';
  end if;
  -- 16 random bytes (gen_random_uuid is core; 122 of its bits are random).
  new.values_salt := uuid_send(gen_random_uuid());
  new.values_digest := training_load.source_metric_confirmation_item_digest(new);
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_confirmation_rows_hold(p_confirmation uuid)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  here bigint := training_load.source_metric_current_xmin();
  conf record;
begin
  select binding_id, confirmed_by_user_id, attested, kind, source_metric_version_id into conf from training_load.source_metric_confirmations where id = p_confirmation;
  -- G1 (v74) begin: a field observation holds exactly its one field_unit row, is attested, and its revision
  -- names it as the proof of both its unit and its meaning, in this transaction.
  if conf.kind = 'field_observation' then
    if (select count(*) from training_load.source_metric_confirmation_items i where i.confirmation_id = p_confirmation) <> 1
       or not exists (select 1 from training_load.source_metric_confirmation_items i
                       where i.confirmation_id = p_confirmation and i.item_kind = 'field_unit' and i.checked)
       or conf.attested is distinct from true then
      raise exception 'source_metric_confirmations: a field observation has exactly one compared field_unit row' using errcode = '23514';
    end if;
    if not exists (select 1 from training_load.source_metric_definition_versions r
                    where r.id = conf.source_metric_version_id and r.unit_observation_id = p_confirmation
                      and r.meaning_observation_id = p_confirmation and r.evidence_status = 'source_stated'
                      and r.xmin::text::bigint = here) then
      raise exception 'source_metric_confirmations: a field observation is named by its revision in the same transaction' using errcode = '23514';
    end if;
    return;
  end if;
  -- G1 (v74) end
  if exists (select 1 from training_load.source_metric_confirmation_items i
              where i.confirmation_id = p_confirmation
                and (not exists (select 1 from training_load.source_metric_mapping_versions v
                                  where v.id = i.mapping_version_id and v.status = 'active')
                     or not exists (select 1 from training_load.source_metric_mapping_activations a
                                     where a.mapping_version_id = i.mapping_version_id
                                       and a.source_team_binding_id = conf.binding_id and a.ended_at is null
                                       and a.activated_by_user_id = conf.confirmed_by_user_id
                                       and a.xmin::text::bigint = here))) then
    raise exception 'source_metric_confirmations: every row''s mapping version is active and switched on for the binding in this transaction' using errcode = '23514';
  end if;
  if conf.attested is distinct from exists (select 1 from training_load.source_metric_confirmation_items i
                                             where i.confirmation_id = p_confirmation and i.checked) then
    raise exception 'source_metric_confirmations: a confirmation is attested exactly when a row was compared' using errcode = '23514';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_confirmation_items_update_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  actor uuid;
  expires timestamptz;
begin
  if tg_op = 'DELETE' then
    raise exception 'source_metric_confirmation_items: a row is never deleted' using errcode = '23514';
  end if;
  -- The right first: the acting user, or none. A present but invalid setting
  -- raises 42501; an acting user who is not an active platform admin changes
  -- nothing here, whatever the change.
  actor := training_load.source_metric_confirmation_actor_or_null();
  if actor is not null and training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
    raise exception 'source metric confirmation: the acting user may not remove these values' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.confirmation_id is distinct from old.confirmation_id
     or new.session_ordinal is distinct from old.session_ordinal or new.item_no is distinct from old.item_no
     or new.item_kind is distinct from old.item_kind or new.checked is distinct from old.checked
     or new.source_metric_version_id is distinct from old.source_metric_version_id
     or new.mapping_version_id is distinct from old.mapping_version_id
     or new.parameter_fingerprint is distinct from old.parameter_fingerprint
     or new.source_unit is distinct from old.source_unit or new.target_unit is distinct from old.target_unit
     or new.scale::text is distinct from old.scale::text or new.scale_divisor::text is distinct from old.scale_divisor::text
     or new."offset"::text is distinct from old."offset"::text or new.compared_level is distinct from old.compared_level
     or new.gpexe_display_rule is distinct from old.gpexe_display_rule or new.gpexe_display_unit is distinct from old.gpexe_display_unit
     or new.values_digest is distinct from old.values_digest
     or new.source_unit_word is distinct from old.source_unit_word -- G1 (v74): the word GPEXE sent is evidence, final
     then
    raise exception 'source_metric_confirmation_items: only the values of a row are removed' using errcode = '23514';
  end if;
  if old.checked is distinct from true or old.values_removed_at is not null then
    raise exception 'source_metric_confirmation_items: the row holds no values to remove' using errcode = '23514';
  end if;
  if new.raw_a is not null or new.stored_a is not null or new.raw_b is not null or new.stored_b is not null
     or new.values_salt is not null then
    raise exception 'source_metric_confirmation_items: a removal nulls the four values and the salt together' using errcode = '23514';
  end if;
  if new.values_removed_kind is null or new.values_removed_kind not in ('expired', 'erased') then
    raise exception 'source_metric_confirmation_items: a removal is expired or erased' using errcode = '23514';
  end if;
  if new.values_removed_kind = 'expired' then
    select values_expire_at into expires from training_load.source_metric_confirmations where id = old.confirmation_id;
    if expires is null or expires > now() then
      raise exception 'source_metric_confirmation_items: the values are not past their date' using errcode = '23514';
    end if;
    if not training_load.source_metric_confirmation_purge_marker_ok() then
      raise exception 'source_metric_confirmation_items: expired values are removed only by the removal function' using errcode = '23514';
    end if;
  elsif actor is null then
    -- An erasure always has an acting user (a platform admin, checked above).
    raise exception 'source metric confirmation: the acting user may not remove these values' using errcode = '42501';
  end if;
  -- The record of the removal is the database's, never the writer's.
  new.values_removed_at := clock_timestamp();
  new.values_removed_by_user_id := actor;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_confirmation_item_digest(i training_load.source_metric_confirmation_items)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
    select encode(sha256(i.values_salt || convert_to(concat_ws('|',
      i.confirmation_id::text, i.item_no::text, i.item_kind, i.mapping_version_id::text, i.source_metric_version_id::text,
      i.parameter_fingerprint, i.source_unit, i.target_unit, i.scale::text, i.scale_divisor::text, i."offset"::text,
      i.gpexe_display_rule, i.gpexe_display_unit,
      i.raw_a::text, i.stored_a::text, i.raw_b::text, i.stored_b::text,
      i.source_unit_word), 'UTF8')), 'hex') -- G1 (v74): the word last; concat_ws skips its null, so a row without one keeps its digest
  $function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_confirmations_commit_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- G1 (v74) begin: a field observation is written with its keyed source_metric_unit_observed row and
  -- its source_metric_meaning_observed row, one session and its rows.
  if new.kind = 'field_observation' then
    if not exists (select 1 from training_load.source_metric_audit a
                    where a.action = 'source_metric_unit_observed' and a.confirmation_id = new.id
                      and a.operation_id = new.operation_id and a.performed_by_user_id = new.confirmed_by_user_id
                      and a.request_key is not null)
       or not exists (select 1 from training_load.source_metric_audit a
                       where a.action = 'source_metric_meaning_observed' and a.confirmation_id = new.id
                         and a.performed_by_user_id = new.confirmed_by_user_id) then
      raise exception 'source_metric_confirmations: a field observation is written with its two observed audit rows' using errcode = '23514';
    end if;
    if (select count(*) from training_load.source_metric_confirmation_sessions s where s.confirmation_id = new.id) <> 1 then
      raise exception 'source_metric_confirmations: a field observation has exactly one session' using errcode = '23514';
    end if;
    perform training_load.source_metric_confirmation_rows_hold(new.id);
    return null;
  end if;
  -- G1 (v74) end
  if not exists (select 1 from training_load.source_metric_audit a
                  where a.action = 'mapping_confirmation' and a.confirmation_id = new.id
                    and a.operation_id = new.operation_id and a.performed_by_user_id = new.confirmed_by_user_id
                    and a.request_key is not null) then
    raise exception 'source_metric_confirmations: a confirmation is written with its keyed mapping_confirmation audit row' using errcode = '23514';
  end if;
  if (select count(*) from training_load.source_metric_confirmation_sessions s where s.confirmation_id = new.id) <> 1 then
    raise exception 'source_metric_confirmations: a team''s confirmation has exactly one session' using errcode = '23514';
  end if;
  if not exists (select 1 from training_load.source_metric_confirmation_items i where i.confirmation_id = new.id) then
    raise exception 'source_metric_confirmations: a confirmation has at least one row' using errcode = '23514';
  end if;
  perform training_load.source_metric_confirmation_rows_hold(new.id);
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_mapping_versions_update_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  rev record;
  map record;
  md record;
  mdv record;
begin
  if tg_op = 'DELETE' then
    raise exception 'source_metric_mapping_versions: a mapping version is never deleted; disable it' using errcode = '23514';
  end if;
  if new.id is distinct from old.id or new.mapping_id is distinct from old.mapping_id
     or new.source_metric_definition_id is distinct from old.source_metric_definition_id
     or new.metric_definition_id is distinct from old.metric_definition_id or new.owner_key is distinct from old.owner_key
     or new.source_metric_version_id is distinct from old.source_metric_version_id or new.version_number is distinct from old.version_number
     or new.metric_definition_version_id is distinct from old.metric_definition_version_id
     or new.conversion_kind is distinct from old.conversion_kind
     or new.scale::text is distinct from old.scale::text or new.scale_divisor::text is distinct from old.scale_divisor::text
     or new."offset"::text is distinct from old."offset"::text or new.rounding_decimals is distinct from old.rounding_decimals
     or new.source_unit is distinct from old.source_unit or new.target_unit is distinct from old.target_unit
     or new.conversion_note is distinct from old.conversion_note or new.parameter_kind is distinct from old.parameter_kind
     or new.source_parameters::text is distinct from old.source_parameters::text
     or new.canonical_parameters::text is distinct from old.canonical_parameters::text
     or new.parameter_fingerprint is distinct from old.parameter_fingerprint
     or new.parameter_scale::text is distinct from old.parameter_scale::text
     or new.parameter_scale_divisor::text is distinct from old.parameter_scale_divisor::text
     or new.parameter_offset::text is distinct from old.parameter_offset::text
     or new.applies_to_session is distinct from old.applies_to_session or new.applies_to_drill is distinct from old.applies_to_drill
     or new.created_by_user_id is distinct from old.created_by_user_id or new.created_at is distinct from old.created_at then
    raise exception 'source_metric_mapping_versions: only the status of a mapping version changes' using errcode = '23514';
  end if;
  -- Status facts are written once, by their own transition.
  if (old.submitted_at is not null and (new.submitted_by_user_id, new.submitted_at, new.submitted_basis)
        is distinct from (old.submitted_by_user_id, old.submitted_at, old.submitted_basis))
     or (old.activated_at is not null and (new.activated_by_user_id, new.activated_at, new.activated_basis)
        is distinct from (old.activated_by_user_id, old.activated_at, old.activated_basis))
     or (old.disabled_at is not null and (new.disabled_by_user_id, new.disabled_at, new.disabled_basis, new.disable_reason)
        is distinct from (old.disabled_by_user_id, old.disabled_at, old.disabled_basis, old.disable_reason)) then
    raise exception 'source_metric_mapping_versions: the status facts are written once' using errcode = '23514';
  end if;
  if new.status is not distinct from old.status then
    if (new.submitted_at, new.activated_at, new.disabled_at) is distinct from (old.submitted_at, old.activated_at, old.disabled_at) then
      raise exception 'source_metric_mapping_versions: the status facts are written by their transition' using errcode = '23514';
    end if;
    return new;
  end if;

  if old.status = 'draft' and new.status = 'needs_review' then
    select state into rev from training_load.source_metric_definition_versions where id = new.source_metric_version_id for share;
    if rev.state not in ('draft', 'active') then
      raise exception 'source_metric_mapping_versions: the source revision is retired' using errcode = '23514';
    end if;
    select owner_scope, owner_club_id into map from training_load.source_metric_mappings where id = new.mapping_id for share;
    if new.submitted_basis = 'platform_admin' then
      perform training_load.source_metric_require_platform_admin(new.submitted_by_user_id);
    elsif new.submitted_basis = 'club_admin' and map.owner_scope = 'club' then
      perform training_load.source_metric_require_club_admin(new.submitted_by_user_id, map.owner_club_id);
    else
      raise exception 'source metric mapping: the acting user may not submit this mapping version' using errcode = '42501';
    end if;
  elsif old.status = 'needs_review' and new.status = 'active' then
    -- Lock order of an activation: unit_conversions -> T2b -> T3 ->
    -- metric_definitions -> its scope capabilities -> the acting user's rows.
    perform training_load.source_metric_lock_conversions(new.source_unit, new.target_unit,
      new.source_parameters ->> 'unit', new.canonical_parameters ->> 'unit');
    select state, evidence_status, bound_operator, source_bound_unit into rev
      from training_load.source_metric_definition_versions where id = new.source_metric_version_id for share;
    if rev.state is distinct from 'active' or rev.evidence_status not in ('verified', 'source_stated') then -- G1 (v74): or source_stated
      raise exception 'source_metric_mapping_versions: the source revision must be active and verified' using errcode = '23514';
    end if;
    select owner_scope, owner_club_id into map from training_load.source_metric_mappings where id = new.mapping_id for share;
    select state, current_version_id into md from training_load.metric_definitions where id = new.metric_definition_id for share;
    if md.state is distinct from 'active' or md.current_version_id is distinct from new.metric_definition_version_id then
      raise exception 'source_metric_mapping_versions: the canonical definition must be active with the pinned version current' using errcode = '23514';
    end if;
    select condition_description into mdv from training_load.metric_definition_versions where id = new.metric_definition_version_id;
    -- C52: the value and bound conversions are checked again against the rows
    -- locked above (a retired row fails the activation; equal units stay the
    -- identity without a row). Active versions and history are not touched.
    perform training_load.source_metric_check_conversion(new.source_unit, new.target_unit, new.scale, new.scale_divisor, new."offset", false);
    perform training_load.source_metric_check_parameters(new.parameter_kind, rev.bound_operator, rev.source_bound_unit,
      new.source_parameters, new.canonical_parameters, mdv.condition_description,
      new.parameter_scale, new.parameter_scale_divisor, new.parameter_offset, true);
    perform training_load.source_metric_check_levels(new.metric_definition_id, new.applies_to_session, new.applies_to_drill, true);
    -- v52 (C108, J14): a club mapping's version is also activated by its
    -- club's active admin; a system mapping's only by a platform admin.
    if new.activated_basis = 'platform_admin' then
      perform training_load.source_metric_require_platform_admin(new.activated_by_user_id);
    elsif new.activated_basis = 'club_admin' and map.owner_scope = 'club' then
      perform training_load.source_metric_require_club_admin(new.activated_by_user_id, map.owner_club_id);
    else
      raise exception 'source metric mapping: the acting user may not activate this mapping version' using errcode = '42501';
    end if;
  elsif new.status = 'disabled' and old.status in ('draft', 'needs_review', 'active') then
    -- A transition writes only its own facts: disabling never adds a
    -- submission or an activation that did not happen.
    if (new.submitted_by_user_id, new.submitted_at, new.submitted_basis, new.activated_by_user_id, new.activated_at, new.activated_basis)
       is distinct from (old.submitted_by_user_id, old.submitted_at, old.submitted_basis, old.activated_by_user_id, old.activated_at, old.activated_basis) then
      raise exception 'source_metric_mapping_versions: the status facts are written by their transition' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_mapping_activations
                where mapping_version_id = old.id and ended_at is null) then
      raise exception 'source_metric_mapping_versions: a mapping version with an open activation is not disabled' using errcode = '23514';
    end if;
    -- v52 (C108, J14): as the activation, by the disabling user's basis.
    select owner_scope, owner_club_id into map from training_load.source_metric_mappings where id = new.mapping_id for share;
    if new.disabled_basis = 'platform_admin' then
      perform training_load.source_metric_require_platform_admin(new.disabled_by_user_id);
    elsif new.disabled_basis = 'club_admin' and map.owner_scope = 'club' then
      perform training_load.source_metric_require_club_admin(new.disabled_by_user_id, map.owner_club_id);
    else
      raise exception 'source metric mapping: the acting user may not disable this mapping version' using errcode = '42501';
    end if;
  else
    raise exception 'source_metric_mapping_versions: this status transition is not allowed' using errcode = '23514';
  end if;
  return new;
end;
$function$;

-- 7. GPEXE's unit words (plan section 8.10): a word is a quantity kind, never a unit. Seed-only (a tenth word is a
--    migration, inside its own seed window); append-only; no route writes it.
create table training_load.source_unit_words (
  source_system  text not null constraint source_unit_words_system_check check (source_system ~ '^[a-z][a-z0-9_]{1,30}$'),
  api_family     text not null constraint source_unit_words_family_check check (api_family in ('api', 'rest_v1')),
  word           text not null constraint source_unit_words_word_check check (word ~ '^[a-z][a-z0-9_]{0,39}$'),
  source_unit    text not null constraint source_unit_words_unit_check check (training_load.source_metric_unit_token_ok(source_unit)),
  display_rule   text not null constraint source_unit_words_rule_check check (display_rule in ('as_sent', 'speed_kmh', 'duration_mmss', 'distance_m')),
  evidence_kind  text not null constraint source_unit_words_evidence_kind_check
                   check (evidence_kind in ('repository', 'repository_by_analogy', 'owner_statement')),
  evidence_ref   text not null constraint source_unit_words_evidence_ref_check check (training_load.source_metric_evidence_ref_ok(evidence_ref)),
  seed_migration text not null constraint source_unit_words_seed_check check (seed_migration ~ '^migrations_v2/[0-9]{12}_[a-z0-9_]+\.sql$'),
  created_at     timestamptz not null default now(),
  constraint source_unit_words_pkey primary key (source_system, api_family, word),
  -- A specific rule reads its own source unit (the registry's RULES): a word may take it only in that unit.
  constraint source_unit_words_rule_unit check (
    display_rule = 'as_sent' or (display_rule = 'speed_kmh' and source_unit = 'm/s')
    or (display_rule = 'duration_mmss' and source_unit = 's') or (display_rule = 'distance_m' and source_unit = 'm'))
);

comment on table training_load.source_unit_words is
  'v74 (G1, plan section 8.10): GPEXE''s unit words are quantity kinds; each seeded row maps one to the unit token its raw value is in, the board''s display rule and the evidence. A hypothesis per word: the two-athlete tick proves each field. Seed-only, append-only.';

create function training_load.source_unit_words_guard() returns trigger as $$
begin
  perform training_load.source_metric_require_seed_window(new.seed_migration);
  return new;
end;
$$ language plpgsql;

create trigger source_unit_words_seed_only
  before insert on training_load.source_unit_words
  for each row execute function training_load.source_unit_words_guard();
create trigger source_unit_words_append_only
  before update or delete on training_load.source_unit_words
  for each row execute function training_load.source_metric_append_only();
create trigger source_unit_words_no_truncate
  before truncate on training_load.source_unit_words
  for each statement execute function training_load.source_metric_no_truncate();

insert into training_load.source_unit_words (source_system, api_family, word, source_unit, display_rule, evidence_kind, evidence_ref, seed_migration) values
  ('gpexe', 'rest_v1', 'number',       'count', 'as_sent',       'repository',            'docs/ai/gpexe-field-inventory-plan.md#unit-word-number',       'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql'),
  ('gpexe', 'rest_v1', 'speed',        'm/s',   'speed_kmh',     'repository',            'docs/ai/gpexe-field-inventory-plan.md#unit-word-speed',        'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql'),
  ('gpexe', 'rest_v1', 'distance',     'm',     'distance_m',    'repository_by_analogy', 'docs/ai/gpexe-field-inventory-plan.md#unit-word-distance',     'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql'),
  ('gpexe', 'rest_v1', 'time',         's',     'duration_mmss', 'repository_by_analogy', 'docs/ai/gpexe-field-inventory-plan.md#unit-word-time',         'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql'),
  ('gpexe', 'rest_v1', 'duration',     's',     'duration_mmss', 'repository_by_analogy', 'docs/ai/gpexe-field-inventory-plan.md#unit-word-time',         'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql'),
  ('gpexe', 'rest_v1', 'power',        'W/kg',  'as_sent',       'owner_statement',       'docs/ai/gpexe-field-inventory-plan.md#unit-word-power',        'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql'),
  ('gpexe', 'rest_v1', 'energy',       'J/kg',  'as_sent',       'owner_statement',       'docs/ai/gpexe-field-inventory-plan.md#unit-word-energy',       'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql'),
  ('gpexe', 'rest_v1', 'energy_std',   'J/kg',  'as_sent',       'owner_statement',       'docs/ai/gpexe-field-inventory-plan.md#unit-word-energy',       'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql'),
  ('gpexe', 'rest_v1', 'acceleration', 'm/s2',  'as_sent',       'owner_statement',       'docs/ai/gpexe-field-inventory-plan.md#unit-word-acceleration', 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql');

-- 8. T8, last: the two observed actions, their typed link, their shapes and chains (its lock is taken at the top).

alter table training_load.source_metric_audit
  drop constraint source_metric_audit_action_check,
  add constraint source_metric_audit_action_check check (action in (
    'source_metric_create', 'source_metric_revision_create', 'source_metric_unit_verified',
    'source_metric_meaning_verified', 'source_metric_revision_activate', 'source_metric_revision_retire',
    'source_metric_retire', 'mapping_create', 'mapping_version_create', 'mapping_status',
    'mapping_version_replaced', 'activation_start', 'activation_end', 'unit_conversion_create',
    'unit_conversion_retire', 'source_instance_end',
    'mapping_confirmation', 'confirmation_values_expired', 'confirmation_values_erased',
    'source_metric_unit_observed', 'source_metric_meaning_observed')),
  drop constraint source_metric_audit_confirmation_iff,
  add constraint source_metric_audit_confirmation_iff check (
    (confirmation_id is not null)
    = (action in ('mapping_confirmation', 'confirmation_values_expired', 'confirmation_values_erased',
                  'source_metric_unit_observed', 'source_metric_meaning_observed')));

CREATE OR REPLACE FUNCTION training_load.source_metric_audit_row_ok(p_action text, p_targets text, p_from text, p_to text, p_reason text, p_evidence text, p_basis text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
    select coalesce(case p_action
      when 'source_metric_create' then
        p_targets = '10000000' and p_from is null and p_to = 'active' and p_basis = 'platform_admin'
      when 'source_metric_retire' then
        p_targets = '10000000' and p_from = 'active' and p_to = 'retired' and p_reason is not null and p_basis = 'platform_admin'
      when 'source_metric_revision_create' then
        p_targets = '11000000' and p_from is null and p_to = 'draft' and p_basis = 'platform_admin'
      when 'source_metric_unit_verified' then
        p_targets = '11000000' and p_from is null and p_to is null and p_evidence is not null and p_basis = 'platform_admin'
      when 'source_metric_meaning_verified' then
        p_targets = '11000000' and p_from is null and p_to is null and p_evidence is not null and p_basis = 'platform_admin'
      when 'source_metric_revision_activate' then
        p_targets = '11000000' and p_from = 'draft' and p_to = 'active' and p_basis = 'platform_admin'
      when 'source_metric_revision_retire' then
        p_targets = '11000000' and p_from in ('draft', 'active') and p_to = 'retired' and p_reason is not null and p_basis = 'platform_admin'
      when 'mapping_create' then
        p_targets = '00100000' and p_from is null and p_to is null and p_basis in ('platform_admin', 'club_admin')
      when 'mapping_version_create' then
        p_targets = '00110000' and p_from is null and p_to = 'draft' and p_basis in ('platform_admin', 'club_admin')
      when 'mapping_status' then
        p_targets = '00110000' and (
             (p_from = 'draft' and p_to = 'needs_review' and p_basis in ('platform_admin', 'club_admin'))
          or (p_from = 'needs_review' and p_to = 'active' and p_basis in ('platform_admin', 'club_admin'))
          or (p_from in ('draft', 'needs_review', 'active') and p_to = 'disabled' and p_reason is not null and p_basis in ('platform_admin', 'club_admin')))
      when 'mapping_version_replaced' then
        p_targets = '00110000' and p_from = 'needs_review' and p_to = 'active' and p_reason is not null and p_basis in ('platform_admin', 'club_admin')
      when 'activation_start' then
        p_targets = '00011001' and p_from is null and p_to is null and p_reason is not null and p_basis in ('platform_admin', 'club_admin')
      when 'activation_end' then
        p_targets = '00011001' and p_from is null and p_to is null and p_basis in ('platform_admin', 'club_admin')
      when 'unit_conversion_create' then
        p_targets = '00000100' and p_from is null and p_to = 'active' and p_evidence is not null and p_basis = 'platform_admin'
      when 'unit_conversion_retire' then
        p_targets = '00000100' and p_from = 'active' and p_to = 'retired' and p_reason is not null and p_basis = 'platform_admin'
      when 'source_instance_end' then
        p_targets in ('00000010', '00000011') and p_from = 'active' and p_to = 'inactive' and p_reason is not null and p_basis = 'platform_admin'
      -- M-A (J18) begin
      -- G1 (v74): the platform's observed acts on one revision, through its confirmation.
      when 'source_metric_unit_observed' then
        p_targets = '11000000' and p_from is null and p_to is null and p_reason is null and p_evidence is null and p_basis = 'platform_admin'
      when 'source_metric_meaning_observed' then
        p_targets = '11000000' and p_from is null and p_to is null and p_reason is null and p_evidence is null and p_basis = 'platform_admin'
      when 'mapping_confirmation' then
        p_targets = '00000001' and p_from is null and p_to is null and p_reason is null and p_evidence is null and p_basis in ('platform_admin', 'club_admin')
      when 'confirmation_values_expired' then
        p_targets = '00000000' and p_from is null and p_to is null and p_reason is null and p_evidence is null and p_basis = 'platform_admin'
      when 'confirmation_values_erased' then
        p_targets = '00000000' and p_from is null and p_to is null and p_reason is not null and p_evidence is null and p_basis = 'platform_admin'
      -- M-A (J18) end
      else false end, false)
  $function$;

CREATE OR REPLACE FUNCTION training_load.source_metric_audit_revision_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  actor uuid;
  here bigint;
  rev record;
begin
  if new.action in ('mapping_create', 'mapping_version_create', 'mapping_status', 'mapping_version_replaced') then
    -- v35's chain (source_metric_audit_v35_actor_guard).
    return new;
  end if;

  if new.action in ('source_metric_revision_create', 'source_metric_revision_activate', 'source_metric_revision_retire') then
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    if new.performed_by_user_id is distinct from actor or new.basis is distinct from 'platform_admin'
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'source metric revision: the acting user may not write this audit row' using errcode = '42501';
    end if;
    select state, created_by_user_id, activated_by_user_id, activated_at, retired_by_user_id, retired_reason, evidence_ref,
           xmin::text::bigint as written_in into rev
      from training_load.source_metric_definition_versions
     where id = new.source_metric_version_id and source_metric_definition_id = new.source_metric_definition_id;
    if not found or rev.written_in is distinct from here then
      raise exception 'source_metric_audit: the audit row must follow its own revision change in the same transaction' using errcode = '23514';
    end if;
    if (new.action = 'source_metric_revision_create'
        and (rev.created_by_user_id is distinct from actor or new.reason is not null
             or (new.evidence_ref is not null and new.evidence_ref is distinct from rev.evidence_ref)))
       or (new.action = 'source_metric_revision_activate'
           and (rev.state is distinct from 'active' or rev.activated_by_user_id is distinct from actor
                or new.reason is not null or new.evidence_ref is not null))
       or (new.action = 'source_metric_revision_retire'
           and (rev.state is distinct from 'retired' or rev.retired_by_user_id is distinct from actor
                or new.reason is distinct from rev.retired_reason or new.evidence_ref is not null
                or new.from_status is distinct from (case when rev.activated_at is null then 'draft' else 'active' end))) then
      raise exception 'source_metric_audit: the audit row must follow its own revision change in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = new.action and source_metric_version_id = new.source_metric_version_id) then
      raise exception 'source_metric_audit: the revision change already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  -- G1 (v74) begin
  if new.action = 'source_metric_create' then
    -- Route C (plan section 8.1): a field's creation row follows its own T2a insert in the same
    -- transaction, by an active platform admin, once per field.
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    if new.performed_by_user_id is distinct from actor or new.basis is distinct from 'platform_admin'
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'source metric: the acting user may not write this audit row' using errcode = '42501';
    end if;
    select state, created_by_user_id, xmin::text::bigint as written_in into rev
      from training_load.source_metric_definitions where id = new.source_metric_definition_id;
    if not found or rev.written_in is distinct from here or rev.state is distinct from 'active'
       or rev.created_by_user_id is distinct from actor or new.reason is not null or new.evidence_ref is not null
       or new.request_key is null or new.request_hash is null then
      raise exception 'source_metric_audit: the audit row must follow its own source metric creation in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = 'source_metric_create' and source_metric_definition_id = new.source_metric_definition_id) then
      raise exception 'source_metric_audit: the source metric creation already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.action in ('source_metric_unit_observed', 'source_metric_meaning_observed') then
    -- Route O (plan section 8.2): an observed act's row follows its own act in the same
    -- transaction, by an active platform admin, naming the confirmation that proves it, once.
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    if new.performed_by_user_id is distinct from actor or new.basis is distinct from 'platform_admin'
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'source metric verification: the acting user may not write this audit row' using errcode = '42501';
    end if;
    select unit_observation_id, meaning_observation_id, unit_verified_by_user_id, meaning_verified_by_user_id,
           xmin::text::bigint as written_in into rev
      from training_load.source_metric_definition_versions
     where id = new.source_metric_version_id and source_metric_definition_id = new.source_metric_definition_id;
    if not found or rev.written_in is distinct from here
       or (new.action = 'source_metric_unit_observed'
           and (rev.unit_observation_id is distinct from new.confirmation_id or rev.unit_verified_by_user_id is distinct from actor
                or new.request_key is null))
       or (new.action = 'source_metric_meaning_observed'
           and (rev.meaning_observation_id is distinct from new.confirmation_id or rev.meaning_verified_by_user_id is distinct from actor)) then
      raise exception 'source_metric_audit: the audit row must follow its own verification in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = new.action and source_metric_version_id = new.source_metric_version_id) then
      raise exception 'source_metric_audit: the verification already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;
  -- G1 (v74) end

  if new.action in ('unit_conversion_create', 'unit_conversion_retire') then
    -- v47: a conversion's audit row follows its own create or retirement, once.
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    if new.performed_by_user_id is distinct from actor or new.basis is distinct from 'platform_admin'
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'unit conversion: the acting user may not write this audit row' using errcode = '42501';
    end if;
    select state, created_by_user_id, retired_by_user_id, retired_reason, evidence_ref, xmin::text::bigint as written_in into rev
      from training_load.unit_conversions
     where id = new.unit_conversion_id;
    if not found or rev.written_in is distinct from here then
      raise exception 'source_metric_audit: the audit row must follow its own conversion change in the same transaction' using errcode = '23514';
    end if;
    if (new.action = 'unit_conversion_create'
        and (rev.state is distinct from 'active' or rev.created_by_user_id is distinct from actor
             or new.evidence_ref is distinct from rev.evidence_ref or new.reason is not null))
       or (new.action = 'unit_conversion_retire'
           and (rev.state is distinct from 'retired' or rev.retired_by_user_id is distinct from actor
                or new.reason is distinct from rev.retired_reason or new.from_status is distinct from 'active'
                or new.evidence_ref is not null)) then
      raise exception 'source_metric_audit: the audit row must follow its own conversion change in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = new.action and unit_conversion_id = new.unit_conversion_id) then
      raise exception 'source_metric_audit: the conversion change already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.action in ('activation_start', 'activation_end') then
    -- v48: an activation's audit row follows its own start or end in the same
    -- transaction, by its writer: a start carries the activation's reason; an
    -- end carries a reason, and an end written by a version's replacement or
    -- disable carries that version's disable_reason. No evidence. Once per
    -- activation and action (the unique index makes it physical).
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    select a.activated_by_user_id, a.activated_basis, a.reason, a.ended_at, a.ended_by_user_id, a.ended_basis, a.end_reason,
           a.xmin::text::bigint as written_in, v.disable_reason into rev
      from training_load.source_metric_mapping_activations a
      join training_load.source_metric_mapping_versions v on v.id = a.mapping_version_id
     where a.id = new.activation_id;
    if not found or rev.written_in is distinct from here then
      raise exception 'source_metric_audit: the audit row must follow its own activation change in the same transaction' using errcode = '23514';
    end if;
    if (new.action = 'activation_start'
        and (rev.activated_by_user_id is distinct from actor or new.basis is distinct from rev.activated_basis
             or new.reason is distinct from rev.reason or new.evidence_ref is not null))
       or (new.action = 'activation_end'
           and (rev.ended_at is null or rev.ended_by_user_id is distinct from actor or new.basis is distinct from rev.ended_basis
                or new.reason is null or new.evidence_ref is not null
                or (rev.end_reason in ('mapping_version_replaced', 'mapping_version_disabled')
                    and new.reason is distinct from rev.disable_reason))) then
      raise exception 'source_metric_audit: the audit row must follow its own activation change in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = new.action and activation_id = new.activation_id) then
      raise exception 'source_metric_audit: the activation change already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.action = 'source_instance_end' then
    -- v50: an instance's end follows its own state change in the same
    -- transaction, by a platform admin, for the owner team, with a reason and
    -- no evidence, once per connection (the unique index makes it physical).
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    if new.performed_by_user_id is distinct from actor or new.basis is distinct from 'platform_admin'
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'source instance: the acting user may not write this audit row' using errcode = '42501';
    end if;
    select state, owner_scope, owner_team_id, source_host_key, source_instance_key, xmin::text::bigint as written_in into rev
      from training_load.metric_source_connections
     where id = new.metric_source_connection_id;
    if not found or rev.written_in is distinct from here or rev.state is distinct from 'inactive'
       or rev.owner_scope is distinct from 'team' or rev.source_host_key is null or rev.source_instance_key is null
       or new.team_id is distinct from rev.owner_team_id or new.reason is null or new.evidence_ref is not null
       or new.from_status is distinct from 'active' or new.to_status is distinct from 'inactive' then
      raise exception 'source_metric_audit: the audit row must follow its own source instance end in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = 'source_instance_end' and metric_source_connection_id = new.metric_source_connection_id) then
      raise exception 'source_metric_audit: the source instance end already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  -- M-A (J18) begin
  if new.action = 'mapping_confirmation' then
    -- The keyed request record of a board save: it follows its own
    -- confirmation in the same transaction, by its writer, with the
    -- confirmation's basis, team and operation, once.
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    select confirmed_by_user_id, confirmed_basis, team_id, operation_id, xmin::text::bigint as written_in into rev
      from training_load.source_metric_confirmations where id = new.confirmation_id;
    if not found or rev.written_in is distinct from here or rev.confirmed_by_user_id is distinct from actor
       or new.performed_by_user_id is distinct from actor or new.basis is distinct from rev.confirmed_basis
       or new.team_id is distinct from rev.team_id or new.operation_id is distinct from rev.operation_id
       or new.request_key is null or new.reason is not null or new.evidence_ref is not null
       or new.performed_at is distinct from now() then
      raise exception 'source_metric_audit: the audit row must follow its own confirmation in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = 'mapping_confirmation' and confirmation_id = new.confirmation_id) then
      raise exception 'source_metric_audit: the confirmation already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.action in ('confirmation_values_expired', 'confirmation_values_erased') then
    -- A removal by an acting user: an active platform admin, after the removal
    -- of every value of that confirmation in the same transaction, by that
    -- user, of the row's kind, once per confirmation and action.
    actor := training_load.source_metric_context_actor();
    here := training_load.source_metric_current_xmin();
    if new.performed_by_user_id is distinct from actor or new.basis is distinct from 'platform_admin'
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'source metric confirmation: the acting user may not write this audit row' using errcode = '42501';
    end if;
    if new.evidence_ref is not null or new.performed_at is distinct from now()
       or not exists (select 1 from training_load.source_metric_confirmation_items i
                       where i.confirmation_id = new.confirmation_id and i.values_removed_at is not null
                         and i.xmin::text::bigint = here and i.values_removed_by_user_id = actor
                         and i.values_removed_kind = (case new.action when 'confirmation_values_expired' then 'expired' else 'erased' end))
       or exists (select 1 from training_load.source_metric_confirmation_items i
                   where i.confirmation_id = new.confirmation_id and i.checked and i.values_removed_at is null) then
      raise exception 'source_metric_audit: the audit row must follow its own removal of values in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = new.action and confirmation_id = new.confirmation_id) then
      raise exception 'source_metric_audit: the removal of values already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;

  -- M-A (J18) end
  if new.action not in ('source_metric_unit_verified', 'source_metric_meaning_verified') then
    raise exception 'source_metric_audit: no writer of this action exists yet' using errcode = '23514';
  end if;
  -- v37, unchanged: a verification row follows its own act, once.
  actor := training_load.source_metric_context_actor();
  here := training_load.source_metric_current_xmin();
  select unit_verified_by_user_id, unit_verified_at, unit_evidence_ref,
         meaning_verified_by_user_id, meaning_verified_at, meaning_evidence_ref,
         xmin::text::bigint as written_in into rev
    from training_load.source_metric_definition_versions
   where id = new.source_metric_version_id and source_metric_definition_id = new.source_metric_definition_id;
  if not found or rev.written_in is distinct from here then
    raise exception 'source_metric_audit: the audit row must follow its own verification in the same transaction' using errcode = '23514';
  end if;
  if new.action = 'source_metric_unit_verified' then
    if rev.unit_verified_at is null or rev.unit_verified_by_user_id is distinct from actor
       or rev.unit_evidence_ref is distinct from new.evidence_ref then
      raise exception 'source_metric_audit: the audit row must follow its own verification in the same transaction' using errcode = '23514';
    end if;
  elsif rev.meaning_verified_at is null or rev.meaning_verified_by_user_id is distinct from actor
        or rev.meaning_evidence_ref is distinct from new.evidence_ref then
    raise exception 'source_metric_audit: the audit row must follow its own verification in the same transaction' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.source_metric_audit
              where action = new.action and source_metric_version_id = new.source_metric_version_id) then
    raise exception 'source_metric_audit: the verification already has its audit row' using errcode = '23514';
  end if;
  return new;
end;
$function$;

comment on function training_load.source_metric_definitions_actor_guard() is
  'v74 (G1, plan section 8.1): a source metric with an acting user is created by an active platform admin, only as a generic gpexe / rest_v1 field.';
comment on column training_load.source_metric_definition_versions.unit_observation_id is
  'v74 (G1): the field observation (T9, kind field_observation) that proves this revision''s unit; set exactly for source_stated, with meaning_observation_id equal to it.';
