-- v52: a club's admin activates, replaces and disables its club's mapping
-- versions (phase 7h, C108, C126).
--
-- Contract: docs/ai/phase7h-club-admin-mappings-contract.md (J14), section 6,
-- accepted by the owner on 2026-11-02 (C126-C131). Before v52 a club's admin
-- created, versioned and submitted its club's mappings and started and ended
-- activations (C106), but only a platform admin could make a version active or
-- disable it. v52 opens those two steps, and the activation ends they write,
-- to club X's active admin on club X's own mapping versions; a system mapping,
-- a source field's unit and meaning, the revision lifecycle, the conversions
-- and D9 stay the platform admin's. It changes:
--
--   * A check, before anything changes, that the four bodies v52 replaces are
--     the ones in force (their md5: v34's T4 update guard, v48's
--     source_metric_audit_row_ok, v48's T8 actor guard and v48's T5 update
--     guard) and that T4's two basis CHECKs are v34's.
--   * T4's activated_basis and disabled_basis CHECKs admit 'club_admin'.
--   * T4's update guard: the activation and the disable split by basis, as
--     the submit already does - platform_admin needs an active platform admin,
--     club_admin a club mapping and its club's active admin of an active
--     club, anything else is refused (42501). The activation keeps its T3
--     share lock at the same place and now reads the mapping's owner; the
--     disable reads it under the same lock after its two existing checks.
--   * T8's row shape (source_metric_audit_row_ok): mapping_status
--     needs_review -> active, mapping_status -> disabled and
--     mapping_version_replaced admit the club_admin basis (a reason still
--     required where it was).
--   * The version-driven activation end (a version's replacement or disable):
--     T5's update guard and T8's actor guard derive the basis as the
--     version's own transition did - an active platform admin whatever the
--     club's state, else, for a club mapping's version, the club's active
--     admin of an active club - and refuse a club version's activation on a
--     binding of another club or of no club (23514, R3).
--   * T4's table comment names the new rule.
--
-- Every other line of the four bodies stays byte for byte. No table, column,
-- trigger, index or data changes. v35's actor guards, v43's G1 and G2, v48's
-- T8 insert guard and links and v50's revision guard already handle the
-- club_admin basis and are not touched. Fixed messages: no id, name or value.
--
-- Locks: T4 ACCESS EXCLUSIVE with NOWAIT (the CHECK swap scans T4; a queued
-- request would make every reader of T4 wait behind it, so a busy T4 fails
-- the migration at once, nothing applied - R10), then T5 and T8 SHARE ROW
-- EXCLUSIVE within the runner's lock_timeout, as v48 and v50. The order
-- T4 -> T5 -> T8 forms no cycle with any writer (J14 section 6.3). The
-- deploy window needs the import switch off, no running check and no open
-- approval (the importer reads T4 FOR SHARE).
--
-- Rollback: docs/runbooks/club-mapping-transitions-v52-rollback.sql (it
-- refuses once a row only 7h can write exists, and under a later migration;
-- it restores v34's CHECKs and T4 comment and the four bodies byte for byte).
--
-- Known limits (as v35, C74): this proves that the row, the acting user and
-- the user's right agree, not that the code which set the acting user was
-- entitled to; it is no defence against whoever controls the shared owner
-- credentials or runs SQL through the application's pool.

-- ---------------------------------------------------------------------------
-- 0. The locks, in the writers' order: T4 without waiting (a busy T4 fails
--    the migration at once, nothing applied, the old instance serving; R10),
--    then T5 and T8 within the runner's lock_timeout, as v48 and v50.
-- ---------------------------------------------------------------------------
lock table training_load.source_metric_mapping_versions in access exclusive mode nowait;
lock table training_load.source_metric_mapping_activations in share row exclusive mode;
lock table training_load.source_metric_audit in share row exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. v52 is written on the bodies and CHECKs in force: refuse any other.
-- ---------------------------------------------------------------------------
do $$
declare
  expected constant text[][] := array[
    ['source_metric_mapping_versions_update_guard', '4b64be0b9bed0368cb9bae9fc6d53b17', 'v34'],
    ['source_metric_audit_row_ok', '764f4ad70de273a443be84bc9bebd87a', 'v48'],
    ['source_metric_audit_actor_guard', '3622725a1b0d454767704b2021db731c', 'v48'],
    ['source_metric_activations_update_guard', 'f4ce8781c0f1797663064cd4e5c63929', 'v48']];
  i int;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v52 refused: the body in force of training_load.% is not %''s', expected[i][1], expected[i][3] using errcode = '23514';
    end if;
  end loop;
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conrelid = 'training_load.source_metric_mapping_versions'::regclass
         and conname = 'source_metric_mapping_versions_activated_basis_check')
     is distinct from 'CHECK (((activated_basis IS NULL) OR (activated_basis = ''platform_admin''::text)))'
     or (select pg_get_constraintdef(oid) from pg_constraint
          where conrelid = 'training_load.source_metric_mapping_versions'::regclass
            and conname = 'source_metric_mapping_versions_disabled_basis_check')
     is distinct from 'CHECK (((disabled_basis IS NULL) OR (disabled_basis = ''platform_admin''::text)))' then
    raise exception 'v52 refused: the basis CHECKs of training_load.source_metric_mapping_versions are not v34''s' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. T4's two basis CHECKs admit the club's admin.
-- ---------------------------------------------------------------------------
alter table training_load.source_metric_mapping_versions
  drop constraint source_metric_mapping_versions_activated_basis_check,
  add constraint source_metric_mapping_versions_activated_basis_check
    check (activated_basis is null or activated_basis in ('platform_admin', 'club_admin')),
  drop constraint source_metric_mapping_versions_disabled_basis_check,
  add constraint source_metric_mapping_versions_disabled_basis_check
    check (disabled_basis is null or disabled_basis in ('platform_admin', 'club_admin'));

comment on table training_load.source_metric_mapping_versions is
  'v34 (D6, T4): one approved, immutable way to turn one source revision into one canonical version. Created as draft only after the unit is proven; draft -> needs_review -> active -> disabled; activated or disabled by a platform admin and, for a club mapping''s version, also by its club''s active admin (v52, C108, J14). parameter_fingerprint is computed by the database.';

-- ---------------------------------------------------------------------------
-- 3. T4's update guard (v34's body; the activation and disable branches).
-- ---------------------------------------------------------------------------
create or replace function training_load.source_metric_mapping_versions_update_guard() returns trigger as $$
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
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 4. T8's row shape (v48's body; three branches admit the club's admin).
-- ---------------------------------------------------------------------------
create or replace function training_load.source_metric_audit_row_ok(
  p_action text, p_targets text, p_from text, p_to text, p_reason text, p_evidence text, p_basis text) returns boolean
  language sql immutable as $$
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
      else false end, false)
  $$;

-- ---------------------------------------------------------------------------
-- 5. T5's update guard (v48's body; the version-driven end).
-- ---------------------------------------------------------------------------
create or replace function training_load.source_metric_activations_update_guard() returns trigger as $$
declare
  actor uuid;
  club uuid;
  basis text;
  map record;
begin
  if tg_op = 'DELETE' then
    raise exception 'source_metric_mapping_activations: an activation is never deleted; end it' using errcode = '23514';
  end if;
  if old.ended_at is not null then
    raise exception 'source_metric_mapping_activations: an ended activation is immutable' using errcode = '23514';
  end if;
  if new.id is distinct from old.id or new.mapping_version_id is distinct from old.mapping_version_id
     or new.mapping_id is distinct from old.mapping_id or new.source_metric_definition_id is distinct from old.source_metric_definition_id
     or new.metric_definition_id is distinct from old.metric_definition_id or new.parameter_fingerprint is distinct from old.parameter_fingerprint
     or new.source_team_binding_id is distinct from old.source_team_binding_id or new.team_id is distinct from old.team_id
     or new.applies_to_session is distinct from old.applies_to_session or new.applies_to_drill is distinct from old.applies_to_drill
     or new.requirement is distinct from old.requirement or new.activated_by_user_id is distinct from old.activated_by_user_id
     or new.activated_basis is distinct from old.activated_basis or new.activated_at is distinct from old.activated_at
     or new.reason is distinct from old.reason then
    raise exception 'source_metric_mapping_activations: only the end of an activation is written' using errcode = '23514';
  end if;
  if new.ended_at is not null then
    -- v48 (C106): the ender is the acting user, with the basis the database
    -- derives - for the binding's club on an admin_ended end; for an end
    -- written by a version's replacement or disable, the basis of that
    -- transition (v52, J14 section 2.4: an active platform admin whatever the
    -- club's state, or the club's active admin for its club's version) - at
    -- the time of its own transaction (replaces v34's
    -- source_metric_require_platform_admin).
    actor := training_load.source_metric_context_actor();
    if new.ended_by_user_id is distinct from actor then
      raise exception 'source metric activation: the acting user may not write this activation' using errcode = '42501';
    end if;
    if new.end_reason = 'admin_ended' then
      club := training_load.source_metric_binding_club(new.source_team_binding_id);
      basis := case when club is null then null else training_load.source_metric_actor_basis(actor, club) end;
    else
      -- v52 (J14 section 2.4): a version-driven end - its version's
      -- replacement or disable - by the basis of the version's own transition:
      -- an active platform admin whatever the club's state, else, for a club
      -- mapping's version, the club's active admin of an active club. The
      -- version's mapping (T3, immutable) by a plain read; a club version's
      -- activation must sit on a binding of its own club (R3), a binding
      -- with no club included.
      basis := training_load.source_metric_actor_basis(actor, null);
      if basis is null then
        select owner_scope, owner_club_id into map from training_load.source_metric_mappings where id = new.mapping_id;
        if map.owner_scope = 'club' then
          if training_load.source_metric_binding_club(new.source_team_binding_id) is distinct from map.owner_club_id then
            raise exception 'source_metric_mapping_activations: a club version''s activation is on another club''s binding' using errcode = '23514';
          end if;
          basis := training_load.source_metric_actor_basis(actor, map.owner_club_id);
        end if;
      end if;
    end if;
    if basis is null or new.ended_basis is distinct from basis then
      raise exception 'source metric activation: the acting user may not write this activation' using errcode = '42501';
    end if;
    if new.ended_at is distinct from now() then
      raise exception 'source_metric_mapping_activations: an end carries the time of its own transaction' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- 6. T8's actor guard (v48's body; the version-driven activation_end).
-- ---------------------------------------------------------------------------
create or replace function training_load.source_metric_audit_actor_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  here bigint := training_load.source_metric_current_xmin();
  map record;
  ver record;
  basis text;
  activation record;
  club uuid;
begin
  if new.performed_by_user_id is distinct from actor then
    raise exception 'source metric mapping: the row names another user than the acting user' using errcode = '42501';
  end if;
  if new.action in ('activation_start', 'activation_end') then
    -- v48 (C106): the basis derived as the activation's own write derived it -
    -- for the binding's club on a start and an admin_ended end; for an end
    -- written by a version's replacement or disable, as v52's T5 guard
    -- derives it (J14 section 2.4), with the same backstop.
    select source_team_binding_id, end_reason, mapping_id into activation
      from training_load.source_metric_mapping_activations where id = new.activation_id;
    if not found then
      raise exception 'source metric activation: the acting user may not write this audit row' using errcode = '42501';
    end if;
    if new.action = 'activation_end' and activation.end_reason in ('mapping_version_replaced', 'mapping_version_disabled') then
      basis := training_load.source_metric_actor_basis(actor, null);
      if basis is null then
        select owner_scope, owner_club_id into map from training_load.source_metric_mappings where id = activation.mapping_id;
        if map.owner_scope = 'club' then
          if training_load.source_metric_binding_club(activation.source_team_binding_id) is distinct from map.owner_club_id then
            raise exception 'source_metric_mapping_activations: a club version''s activation is on another club''s binding' using errcode = '23514';
          end if;
          basis := training_load.source_metric_actor_basis(actor, map.owner_club_id);
        end if;
      end if;
    else
      club := training_load.source_metric_binding_club(activation.source_team_binding_id);
      basis := case when club is null then null else training_load.source_metric_actor_basis(actor, club) end;
    end if;
    if basis is null or new.basis is distinct from basis then
      raise exception 'source metric activation: the acting user may not write this audit row' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.action not in ('mapping_create', 'mapping_version_create', 'mapping_status', 'mapping_version_replaced') then
    -- Every other action: an active platform admin; its chain comes with the
    -- PR that writes it.
    if training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' or new.basis is distinct from 'platform_admin' then
      raise exception 'source metric mapping: the acting user may not write this audit row' using errcode = '42501';
    end if;
    return new;
  end if;
  select owner_scope, owner_club_id, created_by_user_id, xmin::text::bigint as written_in into map
    from training_load.source_metric_mappings where id = new.mapping_id for share;
  if not found then
    raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  basis := training_load.source_metric_actor_basis(actor, case when map.owner_scope = 'club' then map.owner_club_id end);
  if basis is null then
    raise exception 'source metric mapping: the acting user may not write this mapping' using errcode = '42501';
  end if;
  if new.basis is distinct from basis then
    raise exception 'source metric mapping: the basis is not the acting user''s own' using errcode = '42501';
  end if;
  if new.action = 'mapping_create' then
    if map.written_in is distinct from here or map.created_by_user_id is distinct from actor then
      raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit where action = 'mapping_create' and mapping_id = new.mapping_id) then
      raise exception 'source_metric_audit: the operation already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;
  select status, created_by_user_id, submitted_by_user_id, submitted_basis, activated_by_user_id, activated_basis,
         disabled_by_user_id, disabled_basis, xmin::text::bigint as written_in into ver
    from training_load.source_metric_mapping_versions where id = new.mapping_version_id and mapping_id = new.mapping_id;
  if not found or ver.written_in is distinct from here then
    raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  if new.action = 'mapping_version_create' then
    if ver.status is distinct from 'draft' or ver.created_by_user_id is distinct from actor then
      raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
    end if;
    if exists (select 1 from training_load.source_metric_audit
                where action = 'mapping_version_create' and mapping_version_id = new.mapping_version_id) then
      raise exception 'source_metric_audit: the operation already has its audit row' using errcode = '23514';
    end if;
    return new;
  end if;
  -- mapping_status / mapping_version_replaced: the version's current status is
  -- the transition's target, written by this user with this basis.
  if ver.status is distinct from new.to_status
     or (new.to_status = 'needs_review' and (ver.submitted_by_user_id, ver.submitted_basis) is distinct from (actor, new.basis))
     or (new.to_status = 'active' and (ver.activated_by_user_id, ver.activated_basis) is distinct from (actor, new.basis))
     or (new.to_status = 'disabled' and (ver.disabled_by_user_id, ver.disabled_basis) is distinct from (actor, new.basis))
     or new.to_status not in ('needs_review', 'active', 'disabled') then
    raise exception 'source_metric_audit: the audit row must follow its own operation in the same transaction' using errcode = '23514';
  end if;
  if exists (select 1 from training_load.source_metric_audit
              where action in ('mapping_status', 'mapping_version_replaced')
                and mapping_version_id = new.mapping_version_id and to_status = new.to_status) then
    raise exception 'source_metric_audit: the operation already has its audit row' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
