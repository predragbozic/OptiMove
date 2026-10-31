-- Rollback of migration v50 (ending a held source instance; phase 7g, J13):
-- migrations_v2/202610311200_training_load_v50_source_instance_end.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/source-instance-end-7g.test.mjs: apply -> rollback ->
-- the v49 catalog, comments included, exactly -> re-apply, every refusal below,
-- and atomicity). Before it is run anywhere real: a fresh restore-verified
-- backup exists; the deployed commit no longer contains the v50 migration file
-- (otherwise the migrator applies v50 again at the next start) nor the phase
-- 7g routes; and the owner approved this database specifically
-- (.claude/rules/database-safety.md). Roll back newest first: v49's rollback
-- (docs/runbooks/calendar-events-v49-rollback.sql) refuses while v50 is
-- recorded.
--
-- v50 adds two functions with their two triggers on
-- training_load.metric_source_connections (the state guard and the deferred
-- audit link) and one unique index on training_load.source_metric_audit, and
-- replaces one function body (v48's source_metric_audit_revision_guard). No
-- table, column or data. This script restores that body byte for byte, drops
-- what v50 added and removes the v50 record; it changes no row. It refuses,
-- changing nothing, when
--   * the migrator is running (it holds the advisory lock 822026 of
--     backend/src/migrate.js; this script takes the same lock for its own
--     transaction, without waiting);
--   * v50 is not recorded on the database, or any later migrations_v2
--     migration is;
--   * any source_instance_end audit row or any keyed inactive connection
--     exists (once one exists the way forward is a new migration, never this
--     script);
--   * a v50 object is missing, a v50 trigger is disabled, or a body in force
--     of the three v50 functions is not v50's (by md5).
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f source-instance-end-v50-rollback.sql
-- (the script carries its own BEGIN and COMMIT, so no --single-transaction).
-- After a refusal the transaction is aborted and nothing is changed. Waits are
-- bounded: a transaction that holds one of the two tables (a read included)
-- makes this script fail after 5 s.
begin;
set local lock_timeout = '5s';

-- The migrator's lock (MIGRATION_LOCK_KEY in backend/src/migrate.js), for this
-- transaction: no deploy can apply or record a migration while v50 is undone.
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v50 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610311200_training_load_v50_source_instance_end.sql') then
    raise exception 'v50 rollback refused: v50 is not recorded on this database';
  end if;
end $$;

-- v50's locks, in v50's order (the writer's order): the connections, then the
-- audit table, both ACCESS EXCLUSIVE - stronger than v50's SHARE ROW
-- EXCLUSIVE, because DROP TRIGGER and DROP INDEX need it; taken at once, never
-- upgraded later - before the checks, so no end and no audit row is written
-- until the COMMIT.
lock table training_load.metric_source_connections in access exclusive mode;
lock table training_load.source_metric_audit in access exclusive mode;

do $$
declare
  v50 constant text := 'migrations_v2/202610311200_training_load_v50_source_instance_end.sql';
  reasons text[] := '{}';
begin
  if exists (select 1 from public.schema_migrations
              where migration_name like 'migrations_v2/%' and migration_name > v50) then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if exists (select 1 from training_load.source_metric_audit where action = 'source_instance_end') then
    reasons := array_append(reasons, 'a source_instance_end audit row exists');
  end if;
  if exists (select 1 from training_load.metric_source_connections where source_host_key is not null and state = 'inactive') then
    reasons := array_append(reasons, 'a keyed inactive connection exists');
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load'
         and p.proname in ('metric_source_connections_state_guard', 'metric_source_connections_end_link')) <> 2 then
    reasons := array_append(reasons, 'a v50 function is missing');
  end if;
  if to_regclass('training_load.source_metric_audit_v50_instance_end_once') is null then
    reasons := array_append(reasons, 'the v50 index is missing');
  end if;
  if (select count(*) from pg_trigger t
       where t.tgrelid = 'training_load.metric_source_connections'::regclass
         and t.tgname in ('metric_source_connections_v50_state_guard', 'metric_source_connections_v50_audit_link_end')) <> 2 then
    reasons := array_append(reasons, 'a v50 trigger is missing');
  elsif exists (select 1 from pg_trigger t
                 where t.tgrelid = 'training_load.metric_source_connections'::regclass
                   and t.tgname in ('metric_source_connections_v50_state_guard', 'metric_source_connections_v50_audit_link_end')
                   and t.tgenabled <> 'O') then
    reasons := array_append(reasons, 'a v50 trigger is disabled');
  end if;
  if exists (select 1 from (values
               ('source_metric_audit_revision_guard', '16c87e61856986987a4794412c9e6dc2'),
               ('metric_source_connections_state_guard', 'dc5df075b4836478bb8005acec15f212'),
               ('metric_source_connections_end_link', '587a3aab90a9d7109a503bb7d0e5c8b5')) as want(name, digest)
              where (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'training_load' and p.proname = want.name) is distinct from want.digest) then
    reasons := array_append(reasons, 'a body in force is not v50''s');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v50 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

drop trigger metric_source_connections_v50_audit_link_end on training_load.metric_source_connections;
drop trigger metric_source_connections_v50_state_guard on training_load.metric_source_connections;
drop function training_load.metric_source_connections_end_link();
drop function training_load.metric_source_connections_state_guard();
drop index training_load.source_metric_audit_v50_instance_end_once;

-- v48's revision guard, verbatim.
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

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610311200_training_load_v50_source_instance_end.sql';

commit;
