-- Rollback of migration v74 (generic source fields: route C's field creation and the source_stated evidence, G1):
-- migrations_v2/202611161200_training_load_v74_generic_source_fields.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases
-- (backend/tests/source-field-create-g1.test.mjs: apply -> rollback -> the catalog before v74 exactly -> re-apply,
-- every refusal below). Before it is run anywhere real: a fresh restore-verified backup exists; the deployed commit no
-- longer contains the v74 file (otherwise the migrator applies v74 again at the next start) nor any code that writes
-- what v74 allows; and the owner approved this database specifically (.claude/rules/database-safety.md).
--
-- v74 adds two T2a functions and their triggers, T2b's two observation columns, T9's revision column, five CHECKs and
-- three indexes; it widens CHECKs of T2b, T9, T9i and T8, relaxes NOT NULLs of T9 and T9i, replaces twelve bodies and
-- seeds one unit conversion. This script restores every body byte for byte (by its pre-v74 text) and every CHECK and
-- NOT NULL, drops what v74 created, removes the seed and the v74 record; it changes no other row. It refuses, changing
-- nothing, when
--   * the migrator is running (advisory lock 822026, as backend/src/migrate.js);
--   * v74 is not recorded, or a later migrations_v2 migration is (v73 may be recorded or not, in either order: its
--     name sorts before v74's);
--   * any row v74 made possible exists: a source_metric_create row (a field created by route C), a field observation,
--     a field_unit or as_sent row of T9i, a source_stated revision or an observation id, an observed T8 row (once one
--     exists the way forward is a new migration: the evidence is append-only);
--   * the seeded conversion number -> count was changed, retired or is used by a mapping version;
--   * a v74 body in force is not v74's (by md5).
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f generic-source-fields-v74-rollback.sql
-- Waits are bounded: a transaction that holds one of these tables makes this script fail after 5 s.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v74 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations where migration_name = 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql') then
    raise exception 'v74 rollback refused: v74 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql') then
    raise exception 'v74 rollback refused: a later migration is recorded; roll it back first';
  end if;
end $$;

-- v74's locks, in v74's order, before the checks.
lock table training_load.source_metric_mapping_versions in share row exclusive mode;
lock table training_load.source_metric_definitions in share row exclusive mode;
lock table training_load.source_metric_definition_versions in access exclusive mode;
lock table training_load.source_metric_confirmations in access exclusive mode;
lock table training_load.source_metric_confirmation_items in access exclusive mode;
lock table training_load.unit_conversions in access exclusive mode;
lock table training_load.source_metric_audit in access exclusive mode;

do $$
declare
  expected constant text[][] := array[
    ['source_metric_revisions_guard', '00d89ea1daededdc1591646f30e5f5c5'],
    ['source_metric_revisions_actor_guard', 'ef8659d274a09a25c50a8485a0ce6562'],
    ['source_metric_revisions_audit_link', '1b2a0a55036e3688d0cf3cb457f4c324'],
    ['source_metric_require_seed_window', '0152cdbdd79f8c40151ee40efe1aab21'],
    ['source_metric_display_unit_ok', '0f9faa060c4d3a98d7a665af0885a95d'],
    ['source_metric_confirmations_insert_guard', '54db1047da56c6848acc21bfe68d6685'],
    ['source_metric_confirmation_items_insert_guard', 'c58290ee93f6c0251b6d20104b402392'],
    ['source_metric_confirmation_rows_hold', '54d39cb464774bcba838b046e236b682'],
    ['source_metric_confirmations_commit_link', 'f55ef973de6a49ead59359c87a8279fa'],
    ['source_metric_audit_row_ok', 'd4f6fa07d21bcd54a21d7789b67c38ae'],
    ['source_metric_audit_revision_guard', '833800203ddc21ef2c9758d6393a554a'],
    ['source_metric_mapping_versions_update_guard', '1a5652ad19625a1d7e57333984dc1ad8'],
    ['source_metric_definitions_actor_guard', 'eaf6ebc56de03c7413e843da4dc77644'],
    ['source_metric_definitions_create_link', 'ee8dbd5650fbcad096bb3f0e146a95c4']];
  i integer;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = expected[i][1]) is distinct from expected[i][2] then
      raise exception 'v74 rollback refused: the body in force of training_load.% is not v74''s', expected[i][1];
    end if;
  end loop;
  if exists (select 1 from training_load.source_metric_audit
              where action in ('source_metric_create', 'source_metric_unit_observed', 'source_metric_meaning_observed')) then
    raise exception 'v74 rollback refused: a field was created or observed; the evidence is append-only';
  end if;
  if exists (select 1 from training_load.source_metric_confirmations where kind = 'field_observation')
     or exists (select 1 from training_load.source_metric_confirmation_items where item_kind = 'field_unit' or gpexe_display_rule = 'as_sent')
     or exists (select 1 from training_load.source_metric_definition_versions
                 where evidence_status = 'source_stated' or unit_observation_id is not null or meaning_observation_id is not null) then
    raise exception 'v74 rollback refused: a row v74 allows exists';
  end if;
  if not exists (select 1 from training_load.unit_conversions
                  where from_unit = 'number' and to_unit = 'count' and seed_migration = 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql'
                    and scale = 1 and scale_divisor = 1 and "offset" = 0 and state = 'active' and created_by_user_id is null
                    and evidence_ref = 'docs/ai/gpexe-field-inventory-plan.md#number-count')
     or (select count(*) from training_load.unit_conversions where seed_migration = 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql') <> 1
     or exists (select 1 from training_load.source_metric_mapping_versions where source_unit = 'number' and target_unit = 'count')
     or exists (select 1 from training_load.source_metric_audit a join training_load.unit_conversions u on u.id = a.unit_conversion_id
                 where u.seed_migration = 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql') then
    raise exception 'v74 rollback refused: the seeded conversion number -> count was changed or is used';
  end if;
end $$;

-- T2a.
drop trigger source_metric_definitions_v74_create_link on training_load.source_metric_definitions;
drop trigger source_metric_definitions_v74_actor_guard on training_load.source_metric_definitions;
drop function training_load.source_metric_definitions_create_link();
drop function training_load.source_metric_definitions_actor_guard();

-- T8.
alter table training_load.source_metric_audit
  drop constraint source_metric_audit_action_check,
  add constraint source_metric_audit_action_check check (action in (
    'source_metric_create', 'source_metric_revision_create', 'source_metric_unit_verified',
    'source_metric_meaning_verified', 'source_metric_revision_activate', 'source_metric_revision_retire',
    'source_metric_retire', 'mapping_create', 'mapping_version_create', 'mapping_status',
    'mapping_version_replaced', 'activation_start', 'activation_end', 'unit_conversion_create',
    'unit_conversion_retire', 'source_instance_end',
    'mapping_confirmation', 'confirmation_values_expired', 'confirmation_values_erased')),
  drop constraint source_metric_audit_confirmation_iff,
  add constraint source_metric_audit_confirmation_iff check (
    (confirmation_id is not null)
    = (action in ('mapping_confirmation', 'confirmation_values_expired', 'confirmation_values_erased')));

-- T2b.
drop index training_load.source_metric_revisions_unit_observation_idx;
drop index training_load.source_metric_revisions_meaning_observation_idx;
alter table training_load.source_metric_definition_versions
  drop constraint source_metric_revisions_observation_together,
  drop constraint source_metric_revisions_evidence_status_check,
  add constraint source_metric_revisions_evidence_status_check
    check (evidence_status in ('unproven', 'documented', 'observed', 'verified')),
  drop constraint source_metric_revisions_unit_proof_together,
  add constraint source_metric_revisions_unit_proof_together check (
    (unit_verified_by_user_id is null) = (unit_verified_at is null) and
    (unit_verified_at is null) = (unit_evidence_ref is null)),
  drop constraint source_metric_revisions_meaning_proof_together,
  add constraint source_metric_revisions_meaning_proof_together check (
    (meaning_verified_by_user_id is null) = (meaning_verified_at is null) and
    (meaning_verified_at is null) = (meaning_evidence_ref is null)),
  drop constraint source_metric_revisions_verified_iff_proven,
  add constraint source_metric_revisions_verified_iff_proven check (
    (evidence_status = 'verified') =
    (source_unit is not null and meaning_verified_at is not null and (parameter_kind = 'none' or bound_operator is not null))),
  drop constraint source_metric_revisions_evidence_ref_iff_proven,
  add constraint source_metric_revisions_evidence_ref_iff_proven
    check ((evidence_status = 'unproven') = (evidence_ref is null)),
  drop column unit_observation_id,
  drop column meaning_observation_id;

-- T9i.
alter table training_load.source_metric_confirmation_items
  drop constraint source_metric_confirmation_items_field_unit_shape,
  drop constraint source_metric_confirmation_items_kind_check,
  add constraint source_metric_confirmation_items_kind_check check (item_kind in ('club_mapping', 'system_mapping')),
  drop constraint source_metric_confirmation_items_system_unchecked,
  add constraint source_metric_confirmation_items_system_unchecked check (item_kind = 'club_mapping' or not checked),
  drop constraint source_metric_confirmation_items_values_together,
  add constraint source_metric_confirmation_items_values_together check (
    num_nonnulls(raw_a, stored_a, raw_b, stored_b, values_salt) in (0, 5)),
  drop constraint source_metric_confirmation_items_values_converted,
  add constraint source_metric_confirmation_items_values_converted check (
    raw_a is null or (training_load.source_metric_value_matches(raw_a, stored_a, scale, scale_divisor, "offset")
                      and training_load.source_metric_value_matches(raw_b, stored_b, scale, scale_divisor, "offset"))),
  alter column mapping_version_id set not null,
  alter column parameter_fingerprint set not null,
  alter column target_unit set not null,
  alter column scale set not null,
  alter column scale_divisor set not null,
  alter column "offset" set not null;

-- T9.
drop index training_load.source_metric_confirmations_revision_idx;
alter table training_load.source_metric_confirmations
  drop constraint source_metric_confirmations_kind_shape,
  drop constraint source_metric_confirmations_kind_check,
  add constraint source_metric_confirmations_kind_check check (kind = 'team_mapping'),
  drop constraint source_metric_confirmations_owner_scope_check,
  add constraint source_metric_confirmations_owner_scope_check check (owner_scope = 'club'),
  alter column owner_club_id set not null,
  drop column source_metric_version_id;

-- The bodies in force before v74, byte for byte.
CREATE OR REPLACE FUNCTION training_load.source_metric_revisions_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  ranks constant text[] := array['unproven', 'documented', 'observed', 'verified'];
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
       or new.activated_by_user_id is not null then
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
     and (new.source_unit, new.source_bound_unit, new.unit_verified_by_user_id, new.unit_verified_at, new.unit_evidence_ref)
         is distinct from (old.source_unit, old.source_bound_unit, old.unit_verified_by_user_id, old.unit_verified_at, old.unit_evidence_ref) then
    raise exception 'source_metric_definition_versions: a unit proof is written once' using errcode = '23514';
  end if;
  if old.meaning_verified_at is not null
     and (new.bound_operator, new.meaning_verified_by_user_id, new.meaning_verified_at, new.meaning_evidence_ref)
         is distinct from (old.bound_operator, old.meaning_verified_by_user_id, old.meaning_verified_at, old.meaning_evidence_ref) then
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
  if p_marker is distinct from 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql'
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
  if rev.state is distinct from 'active' or rev.evidence_status is distinct from 'verified' then
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
     or not training_load.source_metric_display_unit_ok(new.gpexe_display_rule, new.gpexe_display_unit) then
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
  select binding_id, confirmed_by_user_id, attested into conf from training_load.source_metric_confirmations where id = p_confirmation;
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

CREATE OR REPLACE FUNCTION training_load.source_metric_confirmations_commit_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
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
    if rev.state is distinct from 'active' or rev.evidence_status is distinct from 'verified' then
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

-- The seed and the record.
-- v34's guard refuses every DELETE of a conversion; for this one seed row only, inside this transaction.
alter table training_load.unit_conversions disable trigger unit_conversions_guard;
delete from training_load.unit_conversions where seed_migration = 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql';
alter table training_load.unit_conversions enable trigger unit_conversions_guard;
delete from public.schema_migrations where migration_name = 'migrations_v2/202611161200_training_load_v74_generic_source_fields.sql';

commit;
