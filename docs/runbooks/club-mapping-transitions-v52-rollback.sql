-- Rollback of migration v52 (a club's admin activates, replaces and disables
-- its club's mapping versions; phase 7h, J14):
-- migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/source-metric-mapping-club-admin-7h.test.mjs:
-- apply -> rollback -> the v51 catalog, comments included, exactly ->
-- re-apply, every refusal below, and atomicity). Before it is run anywhere
-- real: a fresh restore-verified backup exists; the deployed commit no longer
-- contains the v52 migration file (otherwise the migrator applies v52 again at
-- the next start) nor phase 7h's code; and the owner approved this database
-- specifically (.claude/rules/database-safety.md).
--
-- v52 widens T4's two basis CHECKs, replaces four function bodies (v34's
-- source_metric_mapping_versions_update_guard, v48's
-- source_metric_audit_row_ok, v48's source_metric_activations_update_guard
-- and v48's source_metric_audit_actor_guard) and T4's table comment. No
-- table, column, trigger, index or data. This script restores v34's two
-- CHECKs, v34's T4 comment verbatim and the four bodies byte for byte, and
-- removes the v52 record; it changes no row. It refuses, changing nothing,
-- when
--   * the migrator is running (it holds the advisory lock 822026 of
--     backend/src/migrate.js; this script takes the same lock for its own
--     transaction, without waiting);
--   * v52 is not recorded on the database, or any later migrations_v2
--     migration is;
--   * a row only phase 7h can write exists (once one exists the way forward
--     is a new migration, never this script): a T4 version activated or
--     disabled on the club_admin basis; a T8 mapping_status row to active or
--     disabled, or a mapping_version_replaced row, on the club_admin basis; a
--     T5 activation ended on the club_admin basis by a version's replacement
--     or disable; a T8 activation_end row on the club_admin basis whose
--     activation ended so. The club_admin rows phase 7d and M2 already write
--     (mapping_create, mapping_version_create, draft -> needs_review,
--     activation_start, activation_end with admin_ended) do not refuse;
--   * a v52 object is missing (a CHECK, a function, a trigger), a trigger is
--     disabled, or a body in force of the four functions is not v52's (by
--     md5).
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f club-mapping-transitions-v52-rollback.sql
-- (the script carries its own BEGIN and COMMIT, so no --single-transaction).
-- After a refusal the transaction is aborted and nothing is changed. Waits are
-- bounded: a transaction that holds one of the three tables (a read included)
-- makes this script fail after 5 s.
begin;
set local lock_timeout = '5s';

-- The migrator's lock (MIGRATION_LOCK_KEY in backend/src/migrate.js), for this
-- transaction: no deploy can apply or record a migration while v52 is undone.
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v52 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql') then
    raise exception 'v52 rollback refused: v52 is not recorded on this database';
  end if;
end $$;

-- v52's locks, in v52's order, before the checks: no transition or end is
-- written until the COMMIT.
lock table training_load.source_metric_mapping_versions in access exclusive mode;
lock table training_load.source_metric_mapping_activations in share row exclusive mode;
lock table training_load.source_metric_audit in share row exclusive mode;

do $$
declare
  v52 constant text := 'migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql';
  reasons text[] := '{}';
begin
  if exists (select 1 from public.schema_migrations
              where migration_name like 'migrations_v2/%' and migration_name > v52) then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if exists (select 1 from training_load.source_metric_mapping_versions
              where activated_basis = 'club_admin' or disabled_basis = 'club_admin') then
    reasons := array_append(reasons, 'a mapping version was activated or disabled by a club admin');
  end if;
  if exists (select 1 from training_load.source_metric_audit
              where basis = 'club_admin'
                and ((action = 'mapping_status' and to_status in ('active', 'disabled')) or action = 'mapping_version_replaced')) then
    reasons := array_append(reasons, 'a club admin''s activation, disable or replacement audit row exists');
  end if;
  if exists (select 1 from training_load.source_metric_mapping_activations
              where ended_basis = 'club_admin' and end_reason in ('mapping_version_replaced', 'mapping_version_disabled')) then
    reasons := array_append(reasons, 'an activation was ended by a club admin''s replacement or disable');
  end if;
  if exists (select 1 from training_load.source_metric_audit a
               join training_load.source_metric_mapping_activations m on m.id = a.activation_id
              where a.action = 'activation_end' and a.basis = 'club_admin'
                and m.end_reason in ('mapping_version_replaced', 'mapping_version_disabled')) then
    reasons := array_append(reasons, 'a club admin''s version-driven activation_end audit row exists');
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'training_load.source_metric_mapping_versions'::regclass
         and conname in ('source_metric_mapping_versions_activated_basis_check', 'source_metric_mapping_versions_disabled_basis_check')) <> 2
     or not exists (select 1 from pg_constraint
                     where conrelid = 'training_load.source_metric_audit'::regclass and conname = 'source_metric_audit_action_shape') then
    reasons := array_append(reasons, 'a v52 constraint is missing');
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load'
         and p.proname in ('source_metric_mapping_versions_update_guard', 'source_metric_audit_row_ok',
                           'source_metric_activations_update_guard', 'source_metric_audit_actor_guard')) <> 4 then
    reasons := array_append(reasons, 'a v52 function is missing');
  end if;
  if (select count(*) from pg_trigger t
       where (t.tgrelid, t.tgname) in (('training_load.source_metric_mapping_versions'::regclass, 'source_metric_mapping_versions_update_guard'),
                                       ('training_load.source_metric_mapping_activations'::regclass, 'source_metric_activations_update_guard'),
                                       ('training_load.source_metric_audit'::regclass, 'source_metric_audit_v35_actor_guard'))) <> 3 then
    reasons := array_append(reasons, 'a trigger of a v52 function is missing');
  elsif exists (select 1 from pg_trigger t
                 where t.tgrelid in ('training_load.source_metric_mapping_versions'::regclass,
                                     'training_load.source_metric_mapping_activations'::regclass,
                                     'training_load.source_metric_audit'::regclass)
                   and not t.tgisinternal and t.tgenabled <> 'O') then
    reasons := array_append(reasons, 'a trigger on T4, T5 or T8 is disabled');
  end if;
  if exists (select 1 from (values
               ('source_metric_mapping_versions_update_guard', '42fb55a2dd043328079fa9b6f4a2c43e'),
               ('source_metric_audit_row_ok', 'a43a63c2d248cbaf71302468429acb85'),
               ('source_metric_activations_update_guard', 'c99759084f7be3febe084bf421aa7002'),
               ('source_metric_audit_actor_guard', '94cf466bfa765a1a03f7d290a3ce154a')) as want(name, digest)
              where (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'training_load' and p.proname = want.name) is distinct from want.digest) then
    reasons := array_append(reasons, 'a body in force is not v52''s');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v52 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

-- v34's two basis CHECKs.
alter table training_load.source_metric_mapping_versions
  drop constraint source_metric_mapping_versions_activated_basis_check,
  add constraint source_metric_mapping_versions_activated_basis_check
    check (activated_basis is null or activated_basis = 'platform_admin'),
  drop constraint source_metric_mapping_versions_disabled_basis_check,
  add constraint source_metric_mapping_versions_disabled_basis_check
    check (disabled_basis is null or disabled_basis = 'platform_admin');

-- v34's T4 comment, verbatim.
comment on table training_load.source_metric_mapping_versions is
  'v34 (D6, T4): one approved, immutable way to turn one source revision into one canonical version. Created as draft only after the unit is proven; draft -> needs_review -> active -> disabled; only a platform admin activates or disables. parameter_fingerprint is computed by the database.';

-- v34's T4 update guard, verbatim.
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
    perform 1 from training_load.source_metric_mappings where id = new.mapping_id for share;
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
    perform training_load.source_metric_require_platform_admin(new.activated_by_user_id);
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
    perform training_load.source_metric_require_platform_admin(new.disabled_by_user_id);
  else
    raise exception 'source_metric_mapping_versions: this status transition is not allowed' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

-- v48's row shape, verbatim.
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
          or (p_from = 'needs_review' and p_to = 'active' and p_basis = 'platform_admin')
          or (p_from in ('draft', 'needs_review', 'active') and p_to = 'disabled' and p_reason is not null and p_basis = 'platform_admin'))
      when 'mapping_version_replaced' then
        p_targets = '00110000' and p_from = 'needs_review' and p_to = 'active' and p_reason is not null and p_basis = 'platform_admin'
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

-- v48's T5 update guard, verbatim.
create or replace function training_load.source_metric_activations_update_guard() returns trigger as $$
declare
  actor uuid;
  club uuid;
  basis text;
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
    -- derives - for the binding's club on an admin_ended end; without the club
    -- gate on an end written by a version's replacement or disable (section
    -- 2.3: an active platform admin whatever the club's state, no one else) -
    -- at the time of its own transaction (replaces v34's
    -- source_metric_require_platform_admin).
    actor := training_load.source_metric_context_actor();
    if new.ended_by_user_id is distinct from actor then
      raise exception 'source metric activation: the acting user may not write this activation' using errcode = '42501';
    end if;
    if new.end_reason = 'admin_ended' then
      club := training_load.source_metric_binding_club(new.source_team_binding_id);
      basis := case when club is null then null else training_load.source_metric_actor_basis(actor, club) end;
    else
      basis := training_load.source_metric_actor_basis(actor, null);
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

-- v48's T8 actor guard, verbatim.
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
    -- for the binding's club on a start and an admin_ended end; without the
    -- club gate on an end written by a version's replacement or disable.
    select source_team_binding_id, end_reason into activation
      from training_load.source_metric_mapping_activations where id = new.activation_id;
    if not found then
      raise exception 'source metric activation: the acting user may not write this audit row' using errcode = '42501';
    end if;
    if new.action = 'activation_end' and activation.end_reason in ('mapping_version_replaced', 'mapping_version_disabled') then
      basis := training_load.source_metric_actor_basis(actor, null);
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

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202611022200_training_load_v52_club_mapping_transitions.sql';

commit;
