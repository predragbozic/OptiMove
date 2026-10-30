-- Rollback of migration v47 (the database actor guard of the unit-conversion
-- writes; phase 7c, J9):
-- migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/unit-conversions-7c.test.mjs: apply -> rollback ->
-- the v46 catalog, comments included, exactly -> re-apply, every refusal below,
-- and atomicity). Before it is run anywhere real: a fresh restore-verified
-- backup exists; the deployed commit no longer contains the v47 migration file
-- (otherwise the migrator applies v47 again at the next start) nor the phase
-- 7c routes; and the owner approved this database specifically
-- (.claude/rules/database-safety.md).
--
-- v47 adds two CHECKs on training_load.unit_conversions with their function
-- source_metric_factor_pair_normal, one BEFORE trigger and two deferred
-- constraint triggers on unit_conversions with their three functions, and one
-- unique index on training_load.source_metric_audit; it replaces the body of
-- source_metric_audit_revision_guard() (v39's body with a conversion branch).
-- No table, column or data. This script drops what v47 added, restores v39's
-- body verbatim and removes the v47 record; it changes no row. It refuses,
-- changing nothing, when
--   * the migrator is running (it holds the advisory lock 822026 of
--     backend/src/migrate.js; this script takes the same lock for its own
--     transaction, without waiting);
--   * v47 is not recorded on the database, or any later migrations_v2
--     migration is;
--   * a conversion was written through the phase 7c API - a row with a
--     created_by_user_id, or a retired row - or any unit_conversion_create /
--     unit_conversion_retire audit row exists (once one exists the way forward
--     is a new migration, never this script);
--   * a v47 object is missing, a v47 trigger is disabled, or the body in force
--     of source_metric_audit_revision_guard() is not v47's (by md5).
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f unit-conversion-guards-v47-rollback.sql
-- (the script carries its own BEGIN and COMMIT, so no --single-transaction).
-- After a refusal the transaction is aborted and nothing is changed. Waits are
-- bounded: a transaction that holds one of the two tables (a read included)
-- makes this script fail after 5 s.
begin;
set local lock_timeout = '5s';

-- The migrator's lock (MIGRATION_LOCK_KEY in backend/src/migrate.js), for this
-- transaction: no deploy can apply or record a migration while v47 is undone.
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v47 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql') then
    raise exception 'v47 rollback refused: v47 is not recorded on this database';
  end if;
end $$;

-- v47's locks, in v47's order (the writers' order): unit_conversions ACCESS
-- EXCLUSIVE (the CHECKs and triggers it drops), then the audit table (the
-- index and the trigger function) - before the checks, so no conversion and no
-- audit row is written until the COMMIT.
lock table training_load.unit_conversions in access exclusive mode;
lock table training_load.source_metric_audit in access exclusive mode;

do $$
declare
  v47 constant text := 'migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql';
  reasons text[] := '{}';
begin
  if exists (select 1 from public.schema_migrations
              where migration_name like 'migrations_v2/%' and migration_name > v47) then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if exists (select 1 from training_load.unit_conversions where created_by_user_id is not null) then
    reasons := array_append(reasons, 'a conversion was created through the API');
  end if;
  if exists (select 1 from training_load.unit_conversions where state = 'retired') then
    reasons := array_append(reasons, 'a conversion is retired');
  end if;
  if exists (select 1 from training_load.source_metric_audit where action in ('unit_conversion_create', 'unit_conversion_retire')) then
    reasons := array_append(reasons, 'a unit conversion audit row exists');
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load'
         and p.proname in ('source_metric_factor_pair_normal', 'unit_conversions_actor_guard',
                           'unit_conversions_create_link', 'unit_conversions_retire_link')) <> 4 then
    reasons := array_append(reasons, 'a v47 function is missing');
  end if;
  if (select count(*) from pg_constraint c
       where c.conrelid = 'training_load.unit_conversions'::regclass
         and c.conname in ('unit_conversions_units_are_tokens', 'unit_conversions_factors_normal_form')) <> 2 then
    reasons := array_append(reasons, 'a v47 constraint is missing');
  end if;
  if to_regclass('training_load.source_metric_audit_v47_conversion_once') is null then
    reasons := array_append(reasons, 'the v47 index is missing');
  end if;
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'training_load.unit_conversions'::regclass
         and t.tgname in ('unit_conversions_v47_actor_guard', 'unit_conversions_v47_audit_link_insert', 'unit_conversions_v47_audit_link_retire')) <> 3 then
    reasons := array_append(reasons, 'a v47 trigger is missing');
  elsif exists (select 1 from pg_trigger t
                 where t.tgrelid = 'training_load.unit_conversions'::regclass
                   and t.tgname in ('unit_conversions_v47_actor_guard', 'unit_conversions_v47_audit_link_insert', 'unit_conversions_v47_audit_link_retire')
                   and t.tgenabled <> 'O') then
    reasons := array_append(reasons, 'a v47 trigger is disabled');
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'source_metric_audit_revision_guard')
     is distinct from '3bb6d69a0b1a54dda8ca0e1a9c5319be' then
    reasons := array_append(reasons, 'the audit guard in force is not v47''s');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v47 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

drop trigger unit_conversions_v47_audit_link_retire on training_load.unit_conversions;
drop trigger unit_conversions_v47_audit_link_insert on training_load.unit_conversions;
drop trigger unit_conversions_v47_actor_guard on training_load.unit_conversions;
drop function training_load.unit_conversions_retire_link();
drop function training_load.unit_conversions_create_link();
drop function training_load.unit_conversions_actor_guard();
drop index training_load.source_metric_audit_v47_conversion_once;
alter table training_load.unit_conversions
  drop constraint unit_conversions_factors_normal_form,
  drop constraint unit_conversions_units_are_tokens;
drop function training_load.source_metric_factor_pair_normal(numeric, numeric);

-- v39's body of the T8 guard, verbatim.
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

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610301700_training_load_v47_unit_conversion_guards.sql';

commit;
