-- v48: the database actor guard of the T5 activation writes (phase 7d, C76,
-- C106).
--
-- Contract: docs/ai/phase7d-mapping-activations-contract.md (J10), section 6,
-- accepted on 2026-10-30 (the Rukovodilac's and the Nezavisni revizor's GO;
-- C106's breadth confirmed by the owner's „Odobravam PR #291.").
-- Phase 7d gives training_load.source_metric_mapping_activations (v34, D7, T5)
-- its writers (backend/src/sourceMetricActivationService.js, and the D6 steps
-- of sourceMetricMappingService.js and sourceRevisionLifecycleService.js): an
-- active platform admin and, since C106, the active admin of the club that
-- owns the binding (the owner club of the binding's connection), in that
-- club's workspace. v34 already keeps an activation open at creation, its
-- copies equal to its active version's, its binding active and of the field's
-- source and API family, C35, never deleted and immutable once ended; it
-- required a platform admin and compared no row with the acting user. v48
-- changes:
--
--   * training_load.source_metric_binding_club(binding): the owner club of the
--     binding's connection when it is club-owned, NULL otherwise - never the
--     team's club, which can change after an Unbind. The one definition every
--     guard below uses.
--   * T5's two CHECKs admit club_admin as the activated and the ended basis.
--   * The T5 insert guard (v34's body, these changes): the activator is the
--     acting user of the transaction (the v35 setting
--     optimove.source_metric_actor); a binding whose connection is not
--     club-owned takes no activation (23514); the activated basis is the one
--     source_metric_actor_basis(actor, the binding's club) derives - NULL is
--     42501 (it replaces v34's source_metric_require_platform_admin).
--   * The T5 update guard (v34's body, these changes): an end names the
--     acting user as its ender, at the time of its own transaction
--     (ended_at = now()), with the derived basis: for the binding's club on an
--     admin_ended end; without the club gate on a mapping_version_replaced or
--     mapping_version_disabled end (an active platform admin whatever the
--     club's state - a system version can always be stopped; no one else).
--   * At COMMIT (two deferred constraint triggers on T5): a start has its
--     activation_start audit row, an end its activation_end row; an end
--     written by a version's replacement or disable sits in the transaction
--     that disabled that version (its xmin, never a time), and a
--     mapping_version_replaced end in the operation of a
--     mapping_version_replaced row of the same mapping (v43's G1 pattern).
--   * T8 (source_metric_audit): source_metric_audit_row_ok admits the
--     club_admin basis on activation_start and activation_end (every other
--     branch byte for byte v34's); v34's insert guard names a club-admin
--     activation row's club through source_metric_binding_club of its
--     activation's binding; v35's actor guard derives an activation row's
--     basis as its write did; v47's revision guard (its trigger
--     source_metric_audit_v37_revision_guard keeps its name) gains the
--     activation branch - the T5 row written in this transaction (xmin), by
--     the acting user, with the row's own reason on a start, a reason on an
--     end and the version's disable_reason on a version-driven end, no
--     evidence, once per activation and action (a unique index makes it
--     physical). Every other line of v47's body stays byte for byte, and
--     source_instance_end still has no writer.
--
-- A write inside a savepoint is refused (its rows carry the subtransaction's
-- id): fail closed, as in v35, v37, v39 and v47. No table, column or data
-- changes. Rollback: docs/runbooks/mapping-activations-v48-rollback.sql (it
-- refuses once any T5 row or any activation audit row exists). Fixed
-- messages: no id, name or value.
--
-- Known limits (as v35, C74): this proves that the row, the acting user and
-- the user's right agree, not that the code which set the acting user was
-- entitled to; it is no defence against whoever controls the shared owner
-- credentials or runs SQL through the application's pool.
--
-- Locks, in the writers' order: every writer takes its T5 lock (an INSERT or
-- FOR NO KEY UPDATE) before it inserts its audit row, so T5 comes first - a
-- writer that already holds a T5 lock finishes before v48 goes on to the audit
-- table, and v48 never holds the audit table while it waits for T5. ACCESS
-- EXCLUSIVE at once (two CHECKs change; no upgrade later; no T5 writer exists
-- before phase 7d, so only T5's plain readers wait for the short run); SHARE
-- ROW EXCLUSIVE on the audit table (the index; the replaced trigger
-- functions). The runner's lock_timeout bounds each wait.

-- ---------------------------------------------------------------------------
-- 0. The locks, in the writers' order.
-- ---------------------------------------------------------------------------
lock table training_load.source_metric_mapping_activations in access exclusive mode;
lock table training_load.source_metric_audit in share row exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. The binding's club (section 2.2), and T5's two basis CHECKs.
-- ---------------------------------------------------------------------------
create function training_load.source_metric_binding_club(p_binding uuid) returns uuid
  language sql stable as $$
    select c.owner_club_id
      from training_load.source_team_bindings b
      join training_load.source_credential_connections c on c.id = b.connection_id
     where b.id = p_binding and c.owner_scope = 'club'
  $$;

alter table training_load.source_metric_mapping_activations
  drop constraint source_metric_activations_activated_basis_check;
alter table training_load.source_metric_mapping_activations
  add constraint source_metric_activations_activated_basis_check check (activated_basis in ('platform_admin', 'club_admin'));
alter table training_load.source_metric_mapping_activations
  drop constraint source_metric_activations_ended_basis_check;
alter table training_load.source_metric_mapping_activations
  add constraint source_metric_activations_ended_basis_check check (ended_basis is null or ended_basis in ('platform_admin', 'club_admin'));

comment on table training_load.source_metric_mapping_activations is
  'v34 (D7, T5): this team binding may import through exactly this mapping version, as required or optional. v48 (C106): started by a platform admin or by the active admin of the club that owns the binding''s connection, and ended by them or by a version''s replacement or disable; never deleted; an Unbind never touches it.';

-- ---------------------------------------------------------------------------
-- 2. T5: the acting user, the derived basis and the binding's club.
-- ---------------------------------------------------------------------------
create or replace function training_load.source_metric_activations_insert_guard() returns trigger as $$
declare
  ver record;
  def record;
  map record;
  bnd record;
  conn record;
  actor uuid := training_load.source_metric_context_actor();
  club uuid;
  basis text;
begin
  -- v48: the row names the acting user of this transaction (v35's setting).
  if new.activated_by_user_id is distinct from actor then
    raise exception 'source metric activation: the acting user may not write this activation' using errcode = '42501';
  end if;
  if new.ended_at is not null or new.ended_by_user_id is not null or new.ended_basis is not null or new.end_reason is not null then
    raise exception 'source_metric_mapping_activations: an activation is created open' using errcode = '23514';
  end if;
  select status, applies_to_session, applies_to_drill into ver
    from training_load.source_metric_mapping_versions where id = new.mapping_version_id for share;
  if ver.status is distinct from 'active' then
    raise exception 'source_metric_mapping_activations: only an active mapping version is activated' using errcode = '23514';
  end if;
  if new.applies_to_session is distinct from ver.applies_to_session or new.applies_to_drill is distinct from ver.applies_to_drill then
    raise exception 'source_metric_mapping_activations: the levels must be the mapping version''s' using errcode = '23514';
  end if;
  -- C42: an active source field (implied by the active version's chain; a backstop).
  select source_system, api_family, state into def
    from training_load.source_metric_definitions where id = new.source_metric_definition_id;
  if def.state is distinct from 'active' then
    raise exception 'source_metric_mapping_activations: the source metric is retired' using errcode = '23514';
  end if;
  -- The owner comes from T3, never from the caller.
  select owner_scope, owner_club_id into map from training_load.source_metric_mappings where id = new.mapping_id;
  -- v27 rows, plain reads (an Unbind is never inverted).
  select connection_id, team_id, source_system, state into bnd
    from training_load.source_team_bindings where id = new.source_team_binding_id;
  if bnd.state is distinct from 'active' then
    raise exception 'source_metric_mapping_activations: the team binding is not active' using errcode = '23514';
  end if;
  if bnd.source_system is distinct from def.source_system then
    raise exception 'source_metric_mapping_activations: the binding''s source is not the source metric''s' using errcode = '23514';
  end if;
  select c.owner_scope, c.owner_club_id, c.owner_team_id, h.api_family into conn
    from training_load.source_credential_connections c
    join training_load.source_host_catalog h on h.source_system = c.source_system and h.host_key = c.host_key
   where c.id = bnd.connection_id;
  if conn.api_family is distinct from def.api_family then
    raise exception 'source_metric_mapping_activations: the API family of the binding''s host is not the source metric''s' using errcode = '23514';
  end if;
  -- v48 (C106): the binding's club is its connection's owner club
  -- (source_metric_binding_club); a connection that is not club-owned takes no
  -- activation until its rule is decided (so the team-owned branch below is
  -- never reached).
  club := training_load.source_metric_binding_club(new.source_team_binding_id);
  if club is null then
    raise exception 'source_metric_mapping_activations: the binding''s connection is not owned by a club' using errcode = '23514';
  end if;
  if map.owner_scope = 'club' then
    -- C35: a club mapping only on a connection owned by that club; never on a team-owned one.
    if conn.owner_scope is distinct from 'club' or conn.owner_club_id is distinct from map.owner_club_id then
      raise exception 'source_metric_mapping_activations: a club mapping is activated only on a binding of a connection owned by that club' using errcode = '23514';
    end if;
  elsif conn.owner_scope = 'team' and conn.owner_team_id is distinct from bnd.team_id then
    raise exception 'source_metric_mapping_activations: a team-owned connection hosts a system mapping only for its own team' using errcode = '23514';
  end if;
  -- v48 (C106): the basis the database derives for the binding's club -
  -- platform_admin for an active platform admin, club_admin for that club's
  -- active admin, both only while the club is active (replaces v34's
  -- source_metric_require_platform_admin).
  basis := training_load.source_metric_actor_basis(actor, club);
  if basis is null or new.activated_basis is distinct from basis then
    raise exception 'source metric activation: the acting user may not write this activation' using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql;

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

-- ---------------------------------------------------------------------------
-- 3. At COMMIT: every start and end has its audit row (deferred).
-- ---------------------------------------------------------------------------
create function training_load.source_metric_activations_start_link() returns trigger as $$
begin
  if not exists (select 1 from training_load.source_metric_audit
                  where action = 'activation_start' and activation_id = new.id) then
    raise exception 'source_metric_mapping_activations: an activation is started with its activation_start audit row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create function training_load.source_metric_activations_end_link() returns trigger as $$
declare
  ended record;
  ver record;
begin
  select operation_id into ended from training_load.source_metric_audit
   where action = 'activation_end' and activation_id = new.id;
  if not found then
    raise exception 'source_metric_mapping_activations: an activation is ended with its activation_end audit row' using errcode = '23514';
  end if;
  if new.end_reason in ('mapping_version_replaced', 'mapping_version_disabled') then
    select status, xmin::text::bigint as written_in into ver
      from training_load.source_metric_mapping_versions where id = new.mapping_version_id;
    if ver.status is distinct from 'disabled' or ver.written_in is distinct from training_load.source_metric_current_xmin() then
      raise exception 'source_metric_mapping_activations: a version-driven end sits in the transaction that disabled its version' using errcode = '23514';
    end if;
    if new.end_reason = 'mapping_version_replaced' and not exists (
         select 1 from training_load.source_metric_audit
          where action = 'mapping_version_replaced' and mapping_id = new.mapping_id and operation_id = ended.operation_id) then
      raise exception 'source_metric_mapping_activations: a replaced end sits in the operation of its mapping''s replacement' using errcode = '23514';
    end if;
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger source_metric_activations_v48_audit_link_start
  after insert on training_load.source_metric_mapping_activations
  deferrable initially deferred
  for each row
  execute function training_load.source_metric_activations_start_link();

create constraint trigger source_metric_activations_v48_audit_link_end
  after update on training_load.source_metric_mapping_activations
  deferrable initially deferred
  for each row
  when (old.ended_at is null and new.ended_at is not null)
  execute function training_load.source_metric_activations_end_link();

-- ---------------------------------------------------------------------------
-- 4. T8: the shape, the club of a club-admin row, the derived basis, and the
-- activation branch of the revision guard.
-- ---------------------------------------------------------------------------
-- Once per activation and action (the revision guard refuses a second one
-- first, with its own message).
create unique index source_metric_audit_v48_activation_once
  on training_load.source_metric_audit (activation_id, action)
  where action in ('activation_start', 'activation_end');

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

create or replace function training_load.source_metric_audit_insert_guard() returns trigger as $$
begin
  if new.basis = 'club_admin' then
    if new.action in ('activation_start', 'activation_end') then
      -- v48 (C106): a club-admin activation row names its club through its
      -- activation's binding (the connection's owner club), never through the
      -- team or a mapping.
      if training_load.source_metric_binding_club(
           (select source_team_binding_id from training_load.source_metric_mapping_activations where id = new.activation_id)) is null then
        raise exception 'source_metric_audit: a club-admin activation row names an activation on a club''s binding' using errcode = '23514';
      end if;
    elsif not exists (
         select 1 from training_load.source_metric_mappings where id = new.mapping_id and owner_scope = 'club') then
      raise exception 'source_metric_audit: a club-admin row names a club mapping' using errcode = '23514';
    end if;
  end if;
  if new.activation_id is not null and not exists (
       select 1 from training_load.source_metric_mapping_activations
        where id = new.activation_id and mapping_version_id = new.mapping_version_id and team_id = new.team_id) then
    raise exception 'source_metric_audit: an activation row must name its own mapping version and team' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

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

create or replace function training_load.source_metric_audit_revision_guard() returns trigger as $$
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
$$ language plpgsql;

