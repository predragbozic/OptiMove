-- v50: ending a held source instance (phase 7g, D9, C76).
--
-- Contract: docs/ai/phase7g-source-instance-end-contract.md (J13), section 6,
-- accepted with PR #297 (OD5 decided on 2026-10-30, the narrower reading). J13
-- names this migration v49 "if none comes between": the calendar's events took
-- v49 (migrations_v2/202610311000_calendar_v49_events.sql, PR #298), so it is
-- v50, written on v48's body of the T8 revision guard as merged and deployed.
--
-- A held source instance is a Metrics Core source connection
-- (training_load.metric_source_connections, v11) owned by a team, whose
-- write-once instance (v34, T7: source_host_key, source_instance_key) is
-- active. Phase 7g gives v11's state its one writer
-- (backend/src/sourceInstanceEndService.js): an active platform admin ends one
-- instance with a reason. Until now state had no trigger: an UPDATE of it was
-- limited only by the two partial uniques. v50 changes:
--
--   * A check, before anything changes, that the body in force of
--     training_load.source_metric_audit_revision_guard() is v48's (its md5): v50
--     replaces that body in full, so it refuses to run over another one.
--   * The v11 state guard (BEFORE UPDATE OF state, WHEN the state changes):
--     inactive -> active is always refused (an ended instance is final);
--     active -> inactive only for a row that already held T7 keys and was
--     team-owned before the UPDATE, with no owner change in it; by the acting
--     user of the transaction (the v35 setting optimove.source_metric_actor),
--     an active platform admin; under the owner team's import lock (v24's
--     hold_gpexe_team_lock: re-entrant for the route, which takes it first;
--     a raw writer gets it here or is refused while another transaction holds
--     it); and refused while the owner team still has an active binding of
--     the same source system, host and source team, or while an activation is
--     open on any of the owner team's bindings of it (an ended binding's open
--     activation included, C58). An INSERT (the importer's) is untouched.
--   * At COMMIT (a deferred constraint trigger): an end has its
--     source_instance_end audit row.
--   * T8 (source_metric_audit): the revision guard gains the
--     source_instance_end branch - the connection written in this transaction
--     (xmin), now inactive, team-owned and keyed; the row names the owner team,
--     active -> inactive, a reason, no evidence; by the acting platform admin;
--     once per connection (a unique index makes it physical). Every other line
--     of v48's body stays byte for byte. v48's actor guard already admits this
--     action for an active platform admin with the platform_admin basis.
--
-- A write inside a savepoint is refused (its rows carry the subtransaction's
-- id): fail closed, as in v35, v37, v39, v47 and v48. No table, column or data
-- changes. Rollback: docs/runbooks/source-instance-end-v50-rollback.sql (it
-- refuses once any source_instance_end row or any keyed inactive connection
-- exists, and under a later migration; v49's rollback refuses while v50 is
-- recorded, so roll back newest first). Fixed messages: no id, name or value.
--
-- Known limits (as v35, C74): this proves that the row, the acting user and
-- the user's right agree, not that the code which set the acting user was
-- entitled to; it is no defence against whoever controls the shared owner
-- credentials or runs SQL through the application's pool.
--
-- Locks, in the writer's order: the 7g writer takes the connection row and
-- then inserts its audit row, so metric_source_connections comes first. SHARE
-- ROW EXCLUSIVE on both (CREATE TRIGGER and the index need no more; no CHECK
-- changes): it waits only for a transaction that holds ROW EXCLUSIVE on the
-- table (an open INSERT, UPDATE or DELETE - the importer creating a
-- connection), never for a FOR SHARE or FOR UPDATE reader. The runner's
-- lock_timeout bounds each wait.

-- ---------------------------------------------------------------------------
-- 0. The locks, in the writer's order.
-- ---------------------------------------------------------------------------
lock table training_load.metric_source_connections in share row exclusive mode;
lock table training_load.source_metric_audit in share row exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. v50 is written on v48's body of the T8 revision guard: refuse any other.
-- ---------------------------------------------------------------------------
do $$
begin
  if (select md5(p.prosrc)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'source_metric_audit_revision_guard')
     is distinct from '921db06f6f2833eb57c062fb61e82e25' then
    raise exception 'v50 refused: the body in force of training_load.source_metric_audit_revision_guard is not v48''s' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The v11 state guard.
-- ---------------------------------------------------------------------------
create function training_load.metric_source_connections_state_guard() returns trigger as $$
declare
  actor uuid;
begin
  if old.state = 'inactive' then
    raise exception 'metric_source_connections: an ended source instance is final' using errcode = '23514';
  end if;
  if old.owner_scope is distinct from 'team' or old.source_host_key is null or old.source_instance_key is null
     or new.owner_scope is distinct from old.owner_scope or new.owner_team_id is distinct from old.owner_team_id
     or new.owner_club_id is distinct from old.owner_club_id or new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'metric_source_connections: only a team''s source instance is ended' using errcode = '23514';
  end if;
  actor := training_load.source_metric_context_actor();
  if training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
    raise exception 'metric source connection: the acting user may not end this source instance' using errcode = '42501';
  end if;
  perform training_load.hold_gpexe_team_lock(old.owner_team_id, 'ending a source instance');
  if exists (select 1
               from training_load.source_team_bindings b
               join training_load.source_credential_connections cc on cc.id = b.connection_id
              where b.team_id = old.owner_team_id and b.state = 'active' and b.source_system = old.source_system
                and b.source_team_id = old.source_instance_key and cc.host_key = old.source_host_key) then
    raise exception 'metric_source_connections: the owner team still holds an active binding of this source team' using errcode = '23514';
  end if;
  if exists (select 1
               from training_load.source_metric_mapping_activations a
               join training_load.source_team_bindings b on b.id = a.source_team_binding_id
               join training_load.source_credential_connections cc on cc.id = b.connection_id
              where a.ended_at is null and b.team_id = old.owner_team_id and b.source_system = old.source_system
                and b.source_team_id = old.source_instance_key and cc.host_key = old.source_host_key) then
    raise exception 'metric_source_connections: an activation of this source team is still open' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_source_connections_v50_state_guard
  before update of state on training_load.metric_source_connections
  for each row
  when (old.state is distinct from new.state)
  execute function training_load.metric_source_connections_state_guard();

comment on function training_load.metric_source_connections_state_guard() is
  'v50 (J13, D9): an ended source instance is final; a team-owned keyed instance is ended only by an active platform admin, under the owner team''s import lock, while no active binding of that source team and no open activation on the owner team''s bindings of it exist.';

-- ---------------------------------------------------------------------------
-- 3. At COMMIT: an end has its source_instance_end audit row.
-- ---------------------------------------------------------------------------
create function training_load.metric_source_connections_end_link() returns trigger as $$
begin
  if not exists (select 1 from training_load.source_metric_audit
                  where action = 'source_instance_end' and metric_source_connection_id = new.id
                    and from_status = 'active' and to_status = 'inactive') then
    raise exception 'metric_source_connections: a source instance is ended with its audit row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger metric_source_connections_v50_audit_link_end
  after update on training_load.metric_source_connections
  deferrable initially deferred
  for each row
  when (old.state is distinct from new.state)
  execute function training_load.metric_source_connections_end_link();

-- ---------------------------------------------------------------------------
-- 4. Once per connection.
-- ---------------------------------------------------------------------------
create unique index source_metric_audit_v50_instance_end_once
  on training_load.source_metric_audit (metric_source_connection_id)
  where action = 'source_instance_end';

-- ---------------------------------------------------------------------------
-- 5. T8: v48's revision guard with the source_instance_end branch. Every
--    other line is v48's, byte for byte.
-- ---------------------------------------------------------------------------
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
