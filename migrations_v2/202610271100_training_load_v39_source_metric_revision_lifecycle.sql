-- v39: the database part of the source-field revision lifecycle (C91).
--
-- Contract: docs/ai/v39-revision-lifecycle-contract.md (J5, section J5.3),
-- decision C100 of docs/ai/gpexe-metric-variable-mapping-discovery.md (the
-- owner's answers O1-O9 and the Rukovodilac's R1-R7 of 2026-10-27). The
-- routes L1-L5 (backend/src/sourceRevisionLifecycleService.js) create a
-- revision of a source field (T2b, training_load.source_metric_definition_versions)
-- as a draft, activate it, retire it, or replace the active revision by the
-- draft in one transaction. v37 refused every T2b INSERT and every state
-- change (C90); v39 allows exactly these, by an active platform admin, each
-- with its audit row:
--
--   * T2b (v37's trigger source_metric_revisions_v37_actor_guard keeps its
--     name, so it still fires after v34's source_metric_revisions_guard; its
--     function is replaced). Besides v37's two acts it allows:
--       - an INSERT of a draft whose created_by_user_id is the acting user
--         (the v35 setting optimove.source_metric_actor);
--       - the seed exception (O9): an INSERT with a seed marker and no
--         creator reads no actor and is left to v34's seed window, which
--         refuses every marker once its seeding migration is recorded. This
--         widens v37, which refused a seed too; it restores v34's behaviour.
--         The branch is inert until a seeding migration replaces
--         source_metric_require_seed_window(), and every such migration
--         needs its own owner order (O9). A marker with a creator is refused
--         here (42501), before v34's CHECK;
--       - draft -> active with activated_by_user_id the acting user;
--       - draft | active -> retired with retired_by_user_id the acting user
--         (v34 checks no actor for a retirement);
--     for all three the acting user is an active platform admin (O1; 42501).
--     A state change writes only the state and its own facts: every other
--     column, evidence_status included, stays as it was (23514). A state
--     change and an act are never one update (v34), and every other update
--     stays refused (23514).
--   * T8 (v37's trigger source_metric_audit_v37_revision_guard keeps its
--     name; its function is replaced). A source_metric_revision_create,
--     _activate or _retire row follows its own write in the same transaction
--     (the revision's xmin): it names the revision and its field, its
--     from_status / to_status are the transition's (v34's shape check),
--     performed_by_user_id is the acting user, an active platform admin, with
--     basis platform_admin. A create row's reason is NULL and its
--     evidence_ref NULL or the revision's own; an activate row's reason and
--     evidence_ref are NULL; a retire row's reason equals the revision's
--     retired_reason, its from_status is active exactly when the revision
--     was activated, and its evidence_ref is NULL. Once per revision and
--     action (23514; the unique index below makes it physical). A seed writes
--     no T8 row. v37's two verification actions and v35's four mapping
--     actions keep their chains; every other action stays refused (23514).
--   * At COMMIT (two deferred constraint triggers, named *_v39_* so they
--     sort after v37's link): every non-seed revision INSERT has its
--     source_metric_revision_create row, and every state change its
--     _activate or _retire row with from_status = the old state and to_status
--     = the new one. Otherwise the whole transaction rolls back (23514).
-- A write inside a savepoint is refused (its rows carry the subtransaction's
-- id): fail closed, as in v35 and v37.
--
-- Known limits (as v35, C74): this proves that the row, the acting user and
-- the user's right agree, not that the code which set the acting user was
-- entitled to; it is no defence against whoever controls the shared owner
-- credentials or runs SQL through the application's pool.
--
-- No table, column or data change; the v34, v35, v36 and v38 objects are
-- unchanged. v37's two functions are replaced (their v37 bodies are restored
-- by docs/runbooks/source-metric-revision-lifecycle-v39-rollback.sql); one
-- function, two constraint triggers and one unique index are added. Depends
-- on the v35 functions source_metric_context_actor(),
-- source_metric_actor_basis() and source_metric_current_xmin(). Lock order:
-- the guards read the T2b row and T8 plainly (a lifecycle write holds the
-- field's revisions FOR UPDATE) and last take the acting user's role and user
-- rows FOR SHARE through source_metric_actor_basis() - after the registry
-- rows, as v34, v35 and v37, and already held by the service's own right
-- check. Fixed messages: no id, unit, reference or value.

-- ---------------------------------------------------------------------------
-- 1. T2b: v37's two acts, and the lifecycle by the acting user.
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
  if meaning_act and new.parameter_kind = 'zone_bounds' then
    raise exception 'source_metric_definition_versions: the verification model of a zone is unresolved' using errcode = '23514';
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
-- 2. T8: a lifecycle row follows its own write, once; v37's verification rows
-- unchanged; an action without a built chain is refused.
-- ---------------------------------------------------------------------------
-- One row per revision and lifecycle action, physically (the guard below
-- refuses a second one first, with its own message). v37's
-- source_metric_audit_v37_revision_idx serves the lookups.
create unique index source_metric_audit_v39_revision_once
  on training_load.source_metric_audit (source_metric_version_id, action)
  where action in ('source_metric_revision_create', 'source_metric_revision_activate', 'source_metric_revision_retire');

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

-- ---------------------------------------------------------------------------
-- 3. At COMMIT: every lifecycle write has its audit row (deferred).
-- ---------------------------------------------------------------------------
create function training_load.source_metric_revisions_lifecycle_link() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from training_load.source_metric_audit
                    where action = 'source_metric_revision_create' and source_metric_version_id = new.id) then
      raise exception 'source_metric_definition_versions: a revision is written with its source_metric_revision_create audit row' using errcode = '23514';
    end if;
  elsif not exists (select 1 from training_load.source_metric_audit
                     where action = case new.state when 'active' then 'source_metric_revision_activate' else 'source_metric_revision_retire' end
                       and source_metric_version_id = new.id and from_status = old.state and to_status = new.state) then
    raise exception 'source_metric_definition_versions: a state change is written with its source_metric_revision_activate or _retire audit row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger source_metric_revisions_v39_audit_link_insert
  after insert on training_load.source_metric_definition_versions
  deferrable initially deferred
  for each row
  when (new.seed_migration is null)
  execute function training_load.source_metric_revisions_lifecycle_link();

create constraint trigger source_metric_revisions_v39_audit_link_state
  after update on training_load.source_metric_definition_versions
  deferrable initially deferred
  for each row
  when (old.state is distinct from new.state)
  execute function training_load.source_metric_revisions_lifecycle_link();
