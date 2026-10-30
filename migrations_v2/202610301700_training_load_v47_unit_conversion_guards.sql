-- v47: the database actor guard of the unit-conversion writes (phase 7c, C76).
--
-- Contract: docs/ai/phase7c-unit-conversions-contract.md (J9), section 6,
-- accepted on 2026-10-30 (the Rukovodilac's and the Nezavisni revizor's GO).
-- Phase 7c gives training_load.unit_conversions (v34, D5) its two writes:
-- POST /conversions creates an active conversion and
-- POST /conversions/:conversionId/retire retires one, for an active platform
-- admin in the platform workspace only (backend/src/unitConversionService.js).
-- v34 already keeps a conversion immutable, never deleted and one active row
-- per ordered pair; it does not check who writes. v47 adds:
--
--   * unit_conversions_v47_actor_guard (BEFORE INSERT OR UPDATE; it fires
--     after v34's unit_conversions_guard, by name): an INSERT with a creator
--     names the acting user of the transaction (the v35 setting
--     optimove.source_metric_actor), an active platform admin; a seed row
--     (no creator) is left to v34's seed window. A retirement names the
--     acting user, an active platform admin, as its retirer, at the time of
--     its own transaction (retired_at = now()). Otherwise 42501, or 23514 for
--     the time.
--   * T8 (v37's trigger source_metric_audit_v37_revision_guard keeps its
--     name; its function is replaced, v39's body byte for byte with one new
--     branch before the final refusal): a unit_conversion_create or
--     unit_conversion_retire row follows its own write in the same
--     transaction (the conversion's xmin), by the acting user with the
--     platform_admin basis. A create row carries the conversion's evidence and
--     no reason; a retire row carries the conversion's retired_reason,
--     from_status active and no evidence. Once per conversion and action
--     (23514; the unique index below makes it physical).
--   * At COMMIT (two deferred constraint triggers): every created conversion
--     has its unit_conversion_create row, and every retirement its
--     unit_conversion_retire row. Otherwise the transaction rolls back (23514).
--   * Two CHECKs on the row: both units are unit tokens (v40's
--     source_metric_unit_token_ok; a conversion no mapping version could use
--     cannot exist, R5), and the factor pair is in D5's full normal form
--     (source_metric_factor_pair_normal, the twin of the service's
--     isNormalFormPair; v34 checked only scale = 1 or scale_divisor = 1, R7).
--     The migration refuses, changing nothing, while an existing row fails
--     either. A CHECK is not validated again when its function is replaced: a
--     later, stricter source_metric_unit_token_ok counts
--     unit_conversions.from_unit / to_unit in its own fail-closed check.
--
-- A write inside a savepoint is refused (its rows carry the subtransaction's
-- id): fail closed, as in v35, v37 and v39. No table, column or data changes.
-- Rollback: docs/runbooks/unit-conversion-guards-v47-rollback.sql (it refuses
-- once a conversion was created through the API or retired, or once a
-- unit_conversion_* audit row exists). Fixed messages: no id, unit, value or
-- SQL.
--
-- Known limits (as v35, C74): this proves that the row, the acting user and
-- the user's right agree, not that the code which set the acting user was
-- entitled to; it is no defence against whoever controls the shared owner
-- credentials or runs SQL through the application's pool.
--
-- Locks, in the writers' order: every writer takes its conversion lock (FOR
-- SHARE, FOR NO KEY UPDATE or an INSERT) before it inserts its audit row, so
-- unit_conversions comes first - a writer that already holds a conversion
-- lock finishes before v47 goes on to the audit table, and v47 never holds the
-- audit table while it waits for unit_conversions. ACCESS EXCLUSIVE at once
-- (the two CHECKs need it; no upgrade later); SHARE ROW EXCLUSIVE on the audit
-- table (the index and the trigger function). The runner's lock_timeout bounds
-- each wait.

-- ---------------------------------------------------------------------------
-- 0. The locks, in the writers' order.
-- ---------------------------------------------------------------------------
lock table training_load.unit_conversions in access exclusive mode;
lock table training_load.source_metric_audit in share row exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. D5's full normal form, and the two CHECKs on the row.
-- ---------------------------------------------------------------------------
-- (f, 1) for every terminating f; (1, d) only when 1/d does not terminate,
-- that is when the digits of d (its decimal point removed) carry a prime
-- factor other than 2 and 5. Both factors are positive and finite.
create function training_load.source_metric_factor_pair_normal(p_scale numeric, p_divisor numeric) returns boolean
  language plpgsql immutable strict as $$
declare
  n numeric;
begin
  if not (p_scale > 0 and p_scale < 'Infinity'::numeric and p_divisor > 0 and p_divisor < 'Infinity'::numeric) then
    return false;
  end if;
  if p_divisor = 1 then
    return true;
  end if;
  if p_scale <> 1 then
    return false;
  end if;
  n := replace(trim_scale(p_divisor)::text, '.', '')::numeric;
  while mod(n, 2) = 0 loop
    n := div(n, 2);
  end loop;
  while mod(n, 5) = 0 loop
    n := div(n, 5);
  end loop;
  return n <> 1;
end;
$$;

-- Fail-closed: no existing row may be refused by the two new rules.
do $$
declare
  refused text[] := '{}';
begin
  if exists (select 1 from training_load.unit_conversions
              where not (training_load.source_metric_unit_token_ok(from_unit) and training_load.source_metric_unit_token_ok(to_unit))) then
    refused := array_append(refused, 'a unit is not a unit token');
  end if;
  if exists (select 1 from training_load.unit_conversions
              where not training_load.source_metric_factor_pair_normal(scale, scale_divisor)) then
    refused := array_append(refused, 'a factor pair is not in the normal form');
  end if;
  if array_length(refused, 1) > 0 then
    raise exception 'v47 refused: rows the new rules refuse exist (%)', array_to_string(refused, ', ') using errcode = '23514';
  end if;
end $$;

alter table training_load.unit_conversions
  add constraint unit_conversions_units_are_tokens
    check (training_load.source_metric_unit_token_ok(from_unit) and training_load.source_metric_unit_token_ok(to_unit)),
  add constraint unit_conversions_factors_normal_form
    check (training_load.source_metric_factor_pair_normal(scale, scale_divisor));

-- ---------------------------------------------------------------------------
-- 2. Before the write: the acting user on the row.
-- ---------------------------------------------------------------------------
create function training_load.unit_conversions_actor_guard() returns trigger as $$
declare
  actor uuid;
begin
  if tg_op = 'INSERT' then
    if new.created_by_user_id is null then
      -- A seed row: v34's guard decides (its seed window).
      return new;
    end if;
    actor := training_load.source_metric_context_actor();
    if new.created_by_user_id is distinct from actor
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'unit conversion: the acting user may not write this conversion' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.state = 'active' and new.state = 'retired' then
    actor := training_load.source_metric_context_actor();
    if new.retired_by_user_id is distinct from actor
       or training_load.source_metric_actor_basis(actor, null) is distinct from 'platform_admin' then
      raise exception 'unit conversion: the acting user may not write this conversion' using errcode = '42501';
    end if;
    if new.retired_at is distinct from now() then
      raise exception 'unit conversion: a retirement carries the time of its own transaction' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger unit_conversions_v47_actor_guard
  before insert or update on training_load.unit_conversions
  for each row execute function training_load.unit_conversions_actor_guard();

-- ---------------------------------------------------------------------------
-- 3. The audit row (T8): v39's guard with the conversion branch.
-- ---------------------------------------------------------------------------
-- Once per conversion and action (the guard below refuses a second one first,
-- with its own message).
create unique index source_metric_audit_v47_conversion_once
  on training_load.source_metric_audit (unit_conversion_id, action)
  where action in ('unit_conversion_create', 'unit_conversion_retire');

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

-- ---------------------------------------------------------------------------
-- 4. At COMMIT: every conversion write has its audit row (deferred).
-- ---------------------------------------------------------------------------
create function training_load.unit_conversions_create_link() returns trigger as $$
begin
  if not exists (select 1 from training_load.source_metric_audit
                  where action = 'unit_conversion_create' and unit_conversion_id = new.id) then
    raise exception 'unit_conversions: a conversion is written with its unit_conversion_create audit row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create function training_load.unit_conversions_retire_link() returns trigger as $$
begin
  if not exists (select 1 from training_load.source_metric_audit
                  where action = 'unit_conversion_retire' and unit_conversion_id = new.id
                    and from_status = 'active' and to_status = 'retired') then
    raise exception 'unit_conversions: a retirement is written with its unit_conversion_retire audit row' using errcode = '23514';
  end if;
  return null;
end;
$$ language plpgsql;

create constraint trigger unit_conversions_v47_audit_link_insert
  after insert on training_load.unit_conversions
  deferrable initially deferred
  for each row
  when (new.created_by_user_id is not null)
  execute function training_load.unit_conversions_create_link();

create constraint trigger unit_conversions_v47_audit_link_retire
  after update on training_load.unit_conversions
  deferrable initially deferred
  for each row
  when (old.state = 'active' and new.state = 'retired')
  execute function training_load.unit_conversions_retire_link();
