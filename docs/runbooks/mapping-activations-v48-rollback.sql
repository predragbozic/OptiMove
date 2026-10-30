-- Rollback of migration v48 (the database actor guard of the T5 activation
-- writes; phase 7d, J10):
-- migrations_v2/202610301900_training_load_v48_mapping_activations.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/mapping-activations-7d.test.mjs: apply -> rollback ->
-- the v47 catalog, comments included, exactly -> re-apply, every refusal below,
-- and atomicity). Before it is run anywhere real: a fresh restore-verified
-- backup exists; the deployed commit no longer contains the v48 migration file
-- (otherwise the migrator applies v48 again at the next start) nor the phase
-- 7d routes; and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- v48 adds the function source_metric_binding_club, two deferred constraint
-- triggers on training_load.source_metric_mapping_activations with their two
-- functions, and one unique index on training_load.source_metric_audit; it
-- widens T5's two basis CHECKs and its table comment, and replaces six function
-- bodies (v34's two T5 guards, v34's source_metric_audit_row_ok and
-- source_metric_audit_insert_guard, v35's source_metric_audit_actor_guard and
-- v47's source_metric_audit_revision_guard). No table, column or data. This
-- script restores those six bodies byte for byte, v34's two CHECKs and its
-- table comment, drops what v48 added and removes the v48 record; it changes no
-- row. It refuses, changing nothing, when
--   * the migrator is running (it holds the advisory lock 822026 of
--     backend/src/migrate.js; this script takes the same lock for its own
--     transaction, without waiting);
--   * v48 is not recorded on the database, or any later migrations_v2
--     migration is;
--   * any T5 activation or any activation_start / activation_end audit row
--     exists (once one exists the way forward is a new migration, never this
--     script);
--   * a v48 object is missing, a v48 trigger is disabled, or a body in force of
--     the six replaced functions is not v48's (by md5).
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f mapping-activations-v48-rollback.sql
-- (the script carries its own BEGIN and COMMIT, so no --single-transaction).
-- After a refusal the transaction is aborted and nothing is changed. Waits are
-- bounded: a transaction that holds one of the two tables (a read included)
-- makes this script fail after 5 s.
begin;
set local lock_timeout = '5s';

-- The migrator's lock (MIGRATION_LOCK_KEY in backend/src/migrate.js), for this
-- transaction: no deploy can apply or record a migration while v48 is undone.
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v48 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql') then
    raise exception 'v48 rollback refused: v48 is not recorded on this database';
  end if;
end $$;

-- v48's locks, in v48's order (the writers' order): the activations ACCESS
-- EXCLUSIVE (the CHECKs and triggers it changes), then the audit table ACCESS
-- EXCLUSIVE - stronger than v48's SHARE ROW EXCLUSIVE, because DROP INDEX needs
-- it; taken at once, never upgraded later - before the checks, so no
-- activation and no audit row is written until the COMMIT.
lock table training_load.source_metric_mapping_activations in access exclusive mode;
lock table training_load.source_metric_audit in access exclusive mode;

do $$
declare
  v48 constant text := 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql';
  reasons text[] := '{}';
begin
  if exists (select 1 from public.schema_migrations
              where migration_name like 'migrations_v2/%' and migration_name > v48) then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if exists (select 1 from training_load.source_metric_mapping_activations) then
    reasons := array_append(reasons, 'an activation exists');
  end if;
  if exists (select 1 from training_load.source_metric_audit where action in ('activation_start', 'activation_end')) then
    reasons := array_append(reasons, 'an activation audit row exists');
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load'
         and p.proname in ('source_metric_binding_club', 'source_metric_activations_start_link', 'source_metric_activations_end_link')) <> 3 then
    reasons := array_append(reasons, 'a v48 function is missing');
  end if;
  if (select count(*) from pg_constraint c
       where c.conrelid = 'training_load.source_metric_mapping_activations'::regclass
         and c.conname in ('source_metric_activations_activated_basis_check', 'source_metric_activations_ended_basis_check')
         and pg_get_constraintdef(c.oid) like '%club_admin%') <> 2 then
    reasons := array_append(reasons, 'a v48 constraint is missing');
  end if;
  if to_regclass('training_load.source_metric_audit_v48_activation_once') is null then
    reasons := array_append(reasons, 'the v48 index is missing');
  end if;
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'training_load.source_metric_mapping_activations'::regclass
         and t.tgname in ('source_metric_activations_v48_audit_link_start', 'source_metric_activations_v48_audit_link_end')) <> 2 then
    reasons := array_append(reasons, 'a v48 trigger is missing');
  elsif exists (select 1 from pg_trigger t
                 where t.tgrelid = 'training_load.source_metric_mapping_activations'::regclass
                   and t.tgname in ('source_metric_activations_v48_audit_link_start', 'source_metric_activations_v48_audit_link_end')
                   and t.tgenabled <> 'O') then
    reasons := array_append(reasons, 'a v48 trigger is disabled');
  end if;
  if exists (select 1 from (values
               ('source_metric_activations_insert_guard', 'e47f75d4a7a6c63659a19491db97d678'),
               ('source_metric_activations_update_guard', 'f4ce8781c0f1797663064cd4e5c63929'),
               ('source_metric_audit_row_ok', '764f4ad70de273a443be84bc9bebd87a'),
               ('source_metric_audit_insert_guard', '157c1ba1be40aaaa6cf5884542919c11'),
               ('source_metric_audit_actor_guard', '3622725a1b0d454767704b2021db731c'),
               ('source_metric_audit_revision_guard', '921db06f6f2833eb57c062fb61e82e25')) as want(name, digest)
              where (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'training_load' and p.proname = want.name) is distinct from want.digest) then
    reasons := array_append(reasons, 'a body in force is not v48''s');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v48 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

drop trigger source_metric_activations_v48_audit_link_end on training_load.source_metric_mapping_activations;
drop trigger source_metric_activations_v48_audit_link_start on training_load.source_metric_mapping_activations;
drop function training_load.source_metric_activations_end_link();
drop function training_load.source_metric_activations_start_link();
drop index training_load.source_metric_audit_v48_activation_once;

-- v34's T5 insert guard, verbatim.
create or replace function training_load.source_metric_activations_insert_guard() returns trigger as $$
declare
  ver record;
  def record;
  map record;
  bnd record;
  conn record;
begin
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
  if map.owner_scope = 'club' then
    -- C35: a club mapping only on a connection owned by that club; never on a team-owned one.
    if conn.owner_scope is distinct from 'club' or conn.owner_club_id is distinct from map.owner_club_id then
      raise exception 'source_metric_mapping_activations: a club mapping is activated only on a binding of a connection owned by that club' using errcode = '23514';
    end if;
  elsif conn.owner_scope = 'team' and conn.owner_team_id is distinct from bnd.team_id then
    raise exception 'source_metric_mapping_activations: a team-owned connection hosts a system mapping only for its own team' using errcode = '23514';
  end if;
  perform training_load.source_metric_require_platform_admin(new.activated_by_user_id);
  return new;
end;
$$ language plpgsql;

-- v34's T5 update guard, verbatim.
create or replace function training_load.source_metric_activations_update_guard() returns trigger as $$
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
    perform training_load.source_metric_require_platform_admin(new.ended_by_user_id);
  end if;
  return new;
end;
$$ language plpgsql;

-- v34's T8 shape function, verbatim.
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
        p_targets = '00011001' and p_from is null and p_to is null and p_reason is not null and p_basis = 'platform_admin'
      when 'activation_end' then
        p_targets = '00011001' and p_from is null and p_to is null and p_basis = 'platform_admin'
      when 'unit_conversion_create' then
        p_targets = '00000100' and p_from is null and p_to = 'active' and p_evidence is not null and p_basis = 'platform_admin'
      when 'unit_conversion_retire' then
        p_targets = '00000100' and p_from = 'active' and p_to = 'retired' and p_reason is not null and p_basis = 'platform_admin'
      when 'source_instance_end' then
        p_targets in ('00000010', '00000011') and p_from = 'active' and p_to = 'inactive' and p_reason is not null and p_basis = 'platform_admin'
      else false end, false)
  $$;

-- v34's T8 insert guard, verbatim.
create or replace function training_load.source_metric_audit_insert_guard() returns trigger as $$
begin
  if new.basis = 'club_admin' and not exists (
       select 1 from training_load.source_metric_mappings where id = new.mapping_id and owner_scope = 'club') then
    raise exception 'source_metric_audit: a club-admin row names a club mapping' using errcode = '23514';
  end if;
  if new.activation_id is not null and not exists (
       select 1 from training_load.source_metric_mapping_activations
        where id = new.activation_id and mapping_version_id = new.mapping_version_id and team_id = new.team_id) then
    raise exception 'source_metric_audit: an activation row must name its own mapping version and team' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

-- v35's T8 actor guard, verbatim.
create or replace function training_load.source_metric_audit_actor_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  here bigint := training_load.source_metric_current_xmin();
  map record;
  ver record;
  basis text;
begin
  if new.performed_by_user_id is distinct from actor then
    raise exception 'source metric mapping: the row names another user than the acting user' using errcode = '42501';
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

-- v47's T8 revision guard, verbatim.
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

-- v34's two basis CHECKs and table comment.
alter table training_load.source_metric_mapping_activations
  drop constraint source_metric_activations_activated_basis_check;
alter table training_load.source_metric_mapping_activations
  add constraint source_metric_activations_activated_basis_check check (activated_basis = 'platform_admin');
alter table training_load.source_metric_mapping_activations
  drop constraint source_metric_activations_ended_basis_check;
alter table training_load.source_metric_mapping_activations
  add constraint source_metric_activations_ended_basis_check check (ended_basis is null or ended_basis = 'platform_admin');
comment on table training_load.source_metric_mapping_activations is
  'v34 (D7, T5): this team binding may import through exactly this mapping version, as required or optional. Written and ended only by a platform admin; never deleted; an Unbind never touches it.';

drop function training_load.source_metric_binding_club(uuid);

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610301900_training_load_v48_mapping_activations.sql';

commit;
