-- v37: the database guards of the source-field evidence confirmations (M2b).
--
-- Contract: docs/ai/gpexe-metric-variable-mapping-discovery.md, decisions
-- C89-C97 and section J4 (owner's decisions of 2026-10-15). An active platform
-- admin, in the platform workspace, confirms on an existing revision of a
-- source field (T2b, training_load.source_metric_definition_versions) its unit
-- - with the bound unit of a zone or an event threshold - and its meaning -
-- with the bound operator of an event threshold -, each in its own act, once,
-- with a reference to a merged evidence document. v34 already defines these
-- proof columns, their write-once rule, the evidence_status CHECK and the T8
-- actions source_metric_unit_verified / source_metric_meaning_verified; v35
-- the transaction-local acting user. v37 adds what they leave open:
--
--   * T2b (BEFORE INSERT OR UPDATE, after v34's guard by name): the only T2b
--     writes are the two acts (C90). An INSERT (a new revision), a state change
--     (activation, retirement) and every other update are refused (23514) until
--     the revision-lifecycle pull request builds them (C91). A unit act names
--     the transaction's acting user (the v35 setting
--     optimove.source_metric_actor) as unit_verified_by_user_id, a meaning act
--     as meaning_verified_by_user_id, and that user must be an active platform
--     admin (42501). The two acts are never one update, and an act changes
--     evidence_status only to verified (which v34's CHECK then demands; C92).
--     A meaning act on a zone revision (parameter_kind zone_bounds) is refused:
--     the model of closed against open zones under one bound operator is
--     unresolved (C89).
--   * T8 (BEFORE INSERT, after v34's and v35's guards by name): a
--     source_metric_unit_verified / source_metric_meaning_verified row follows
--     its own act in the same transaction - the revision written by this
--     transaction, its verifier the acting user, the row's evidence_ref the
--     act's own reference - once per revision and act (23514). Every other
--     action whose chain is not built yet (the source metric, revision,
--     activation, unit conversion and source instance actions but these two)
--     is refused (23514, C90); the four mapping actions keep v35's chain.
--   * At COMMIT (deferred constraint trigger): every act has its T8 row, or the
--     whole transaction rolls back (23514).
-- A write inside a savepoint is refused (its rows carry the subtransaction's
-- id): fail closed. The evidence references are checked by format only (v34's
-- source_metric_evidence_ref_ok), never against a file (C95).
--
-- Known limits (as v35, C74): this proves that the row, the acting user and
-- the user's right agree, not that the code which set the acting user was
-- entitled to; it is no defence against whoever controls the shared owner
-- credentials or runs SQL through the application's pool.
--
-- No table, column or data change; the v34 and v35 objects are unchanged.
-- Depends on the v35 functions source_metric_context_actor(),
-- source_metric_actor_basis() and source_metric_current_xmin() (the v35 and
-- v36 rollbacks refuse while v37 is recorded). Lock order: the guards read the
-- T2b row and T8 plainly (an act holds the T2b row it updates, FOR UPDATE)
-- and last take the acting user's role and user rows FOR SHARE through
-- source_metric_actor_basis() - after the registry row, as v34 and v35, and
-- already held by the service's own right check. Fixed messages: no id, unit,
-- reference or value.

-- ---------------------------------------------------------------------------
-- 1. T2b: only the two acts, by the acting user.
-- ---------------------------------------------------------------------------
create function training_load.source_metric_revisions_actor_guard() returns trigger as $$
declare
  actor uuid;
  unit_act boolean;
  meaning_act boolean;
begin
  if tg_op = 'INSERT' then
    raise exception 'source_metric_definition_versions: no writer creates a revision yet' using errcode = '23514';
  end if;
  unit_act := old.unit_verified_at is null and new.unit_verified_at is not null;
  meaning_act := old.meaning_verified_at is null and new.meaning_verified_at is not null;
  if unit_act = meaning_act
     or new.state is distinct from old.state
     or (new.evidence_status is distinct from old.evidence_status and new.evidence_status <> 'verified') then
    raise exception 'source_metric_definition_versions: a revision is changed only by one unit or meaning verification' using errcode = '23514';
  end if;
  -- The acting user's own right first (a session that is no active platform
  -- admin may not name one), then the row names exactly that user (v34 has
  -- already checked the named user).
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
  return new;
end;
$$ language plpgsql;

create trigger source_metric_revisions_v37_actor_guard
  before insert or update on training_load.source_metric_definition_versions
  for each row execute function training_load.source_metric_revisions_actor_guard();

-- ---------------------------------------------------------------------------
-- 2. T8: a verification's audit row follows its own act, once; an action
-- without a built chain is refused.
-- ---------------------------------------------------------------------------
create index source_metric_audit_v37_revision_idx
  on training_load.source_metric_audit (source_metric_version_id, action) where source_metric_version_id is not null;

create function training_load.source_metric_audit_revision_guard() returns trigger as $$
declare
  actor uuid;
  here bigint;
  rev record;
begin
  if new.action in ('mapping_create', 'mapping_version_create', 'mapping_status', 'mapping_version_replaced') then
    -- v35's chain (source_metric_audit_v35_actor_guard).
    return new;
  end if;
  if new.action not in ('source_metric_unit_verified', 'source_metric_meaning_verified') then
    raise exception 'source_metric_audit: no writer of this action exists yet' using errcode = '23514';
  end if;
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

create trigger source_metric_audit_v37_revision_guard
  before insert on training_load.source_metric_audit
  for each row execute function training_load.source_metric_audit_revision_guard();

-- ---------------------------------------------------------------------------
-- 3. At COMMIT: every act has its audit row (deferred).
-- ---------------------------------------------------------------------------
create function training_load.source_metric_revisions_audit_link() returns trigger as $$
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
$$ language plpgsql;

create constraint trigger source_metric_revisions_v37_audit_link
  after update on training_load.source_metric_definition_versions
  deferrable initially deferred
  for each row
  when (old.unit_verified_at is distinct from new.unit_verified_at or old.meaning_verified_at is distinct from new.meaning_verified_at)
  execute function training_load.source_metric_revisions_audit_link();
