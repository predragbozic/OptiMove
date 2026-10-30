-- Migration v43: the audit of a mapping version's transitions (phase 7b ★★;
-- C104; contract docs/ai/phase7b-mapping-transitions-contract.md, section 7;
-- J8 of docs/ai/gpexe-metric-variable-mapping-discovery.md).
--
-- Phase 7b lets an active platform admin activate a submitted mapping version
-- (T4), replace the mapping's active version by it in one transaction (D6),
-- and disable a version. v34 already checks every condition of those
-- transitions and v35 the acting user, the basis and that each transition has
-- its audit row at COMMIT. v43 adds two checks of the audit rows themselves
-- (T8, rows of the actions mapping_status and mapping_version_replaced only):
--
--   G1 (always, R6) - a replacement's label is true. At COMMIT (deferred):
--     * a mapping_version_replaced row is accepted only when its operation
--       (the same operation_id) holds a mapping_status row active -> disabled
--       of ANOTHER version of the same mapping, by the same user, whose
--       version is disabled with disable_reason equal to the replaced row's
--       reason;
--     * a mapping_status row needs_review -> active is accepted only when its
--       operation disabled no active version of that mapping (such an
--       activation is a replacement, and says so).
--     Checked at COMMIT, so the order of the two rows does not matter.
--   G2 (Q2, C104) - a transition row agrees with its own version, which the
--     transition already wrote (BEFORE INSERT): a -> disabled row carries
--     exactly the version's disable_reason; performed_at is now(); and the
--     transition's own time (submitted_at, activated_at or disabled_at, by the
--     row's to_status) lies within [now(), clock_timestamp()], both bounds
--     included - neither before this transaction nor in the future.
--
-- Functions and triggers only: no table, column, constraint, index or data.
-- No existing function changes; source_metric_actor_basis (v35) stays byte
-- for byte. The two triggers are named source_metric_audit_v43_*, so they
-- sort after every earlier trigger of T8 (BEFORE triggers fire in name order:
-- v34's insert guard, v35's actor guard and v37's revision guard run first).
--
-- What G1 and G2 are, and are not (as J2 says of v35): a backstop against an
-- accidental or unintended write that bypasses the service. They prove that
-- the rows agree with each other and with the version, not that the writer was
-- honest: a direct-SQL writer with the owner credentials can still split one
-- operation into two operation_ids, or switch the triggers off (C74).
--
-- Fixed messages: no id, name or value (C79). Through the M2 service each is
-- a programming error answered as a sanitized 500.
-- Rollback: docs/runbooks/source-metric-mapping-transitions-v43-rollback.sql
-- (it drops the two triggers and functions and restores v42's catalog; v43
-- writes no data). One transaction (the runner's), under the runner's lock
-- timeout; creating the triggers takes SHARE ROW EXCLUSIVE on T8 until COMMIT.

-- ---------------------------------------------------------------------------
-- G1. A replacement's label is true (deferred, at COMMIT).
-- ---------------------------------------------------------------------------
create function training_load.source_metric_audit_replacement_link() returns trigger as $$
begin
  if new.action = 'mapping_version_replaced' then
    if not exists (
         select 1
           from training_load.source_metric_audit a
           join training_load.source_metric_mapping_versions v
             on v.id = a.mapping_version_id and v.mapping_id = a.mapping_id
          where a.operation_id = new.operation_id
            and a.action = 'mapping_status' and a.from_status = 'active' and a.to_status = 'disabled'
            and a.mapping_id = new.mapping_id and a.mapping_version_id <> new.mapping_version_id
            and a.performed_by_user_id = new.performed_by_user_id
            and v.status = 'disabled' and v.disable_reason = new.reason) then
      raise exception 'source_metric_audit: a replacement records the disable of the version it replaces in its own operation' using errcode = '23514';
    end if;
  elsif new.action = 'mapping_status' and new.from_status = 'needs_review' and new.to_status = 'active' then
    if exists (
         select 1 from training_load.source_metric_audit a
          where a.operation_id = new.operation_id
            and a.action = 'mapping_status' and a.from_status = 'active' and a.to_status = 'disabled'
            and a.mapping_id = new.mapping_id) then
      raise exception 'source_metric_audit: an activation that disables another version of its mapping is recorded as a replacement' using errcode = '23514';
    end if;
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger source_metric_audit_v43_replacement_link
  after insert on training_load.source_metric_audit
  deferrable initially deferred
  for each row
  when (new.action in ('mapping_status', 'mapping_version_replaced'))
  execute function training_load.source_metric_audit_replacement_link();

-- ---------------------------------------------------------------------------
-- G2. A transition row agrees with its own version (BEFORE INSERT).
-- ---------------------------------------------------------------------------
create function training_load.source_metric_audit_transition_facts() returns trigger as $$
declare
  ver record;
  fact_at timestamptz;
begin
  select submitted_at, activated_at, disabled_at, disable_reason into ver
    from training_load.source_metric_mapping_versions
   where id = new.mapping_version_id and mapping_id = new.mapping_id;
  if not found then
    raise exception 'source_metric_audit: a transition row must agree with its version' using errcode = '23514';
  end if;
  if new.to_status = 'disabled' and new.reason is distinct from ver.disable_reason then
    raise exception 'source_metric_audit: a disable row carries its version''s disable reason' using errcode = '23514';
  end if;
  if new.performed_at is distinct from now() then
    raise exception 'source_metric_audit: a transition row carries its transaction''s time' using errcode = '23514';
  end if;
  fact_at := case new.to_status
               when 'needs_review' then ver.submitted_at
               when 'active' then ver.activated_at
               when 'disabled' then ver.disabled_at
             end;
  if fact_at is null or fact_at < now() or fact_at > clock_timestamp() then
    raise exception 'source_metric_audit: a transition''s time lies within its own transaction' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger source_metric_audit_v43_transition_facts
  before insert on training_load.source_metric_audit
  for each row
  when (new.action in ('mapping_status', 'mapping_version_replaced'))
  execute function training_load.source_metric_audit_transition_facts();

comment on function training_load.source_metric_audit_replacement_link() is
  'v43 (J8, G1): at COMMIT, a mapping_version_replaced row needs the active -> disabled mapping_status row of another version of the same mapping in its operation, by the same user, with that version''s disable_reason as its reason; a needs_review -> active mapping_status row needs an operation that disabled no active version of its mapping.';
comment on function training_load.source_metric_audit_transition_facts() is
  'v43 (J8, G2): a mapping_status or mapping_version_replaced row agrees with its version: a -> disabled row carries the version''s disable_reason, performed_at is now(), and the transition''s own time lies within [now(), clock_timestamp()].';
