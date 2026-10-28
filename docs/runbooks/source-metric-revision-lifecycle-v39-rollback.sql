-- Rollback of migration v39 (the database part of the source-field revision
-- lifecycle, C91):
-- migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/source-revision-lifecycle-v39.test.mjs: apply ->
-- rollback -> the v38 catalog again -> re-apply, and every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the
-- deployed commit no longer contains the v39 migration file (otherwise the
-- migrator applies v39 again at the next start) nor the lifecycle routes;
-- v40 (migrations_v2/202610271200_training_load_v40_source_metric_text_rules.sql)
-- is rolled back first, if it is recorded; and the owner approved this
-- database specifically (.claude/rules/database-safety.md).
--
-- v39 replaces v37's two guard functions and adds one function, two deferred
-- constraint triggers and one unique index; no table, column or data. This
-- script drops what v39 added, restores the two v37 function bodies verbatim
-- and removes the v39 record. It refuses, changing nothing, when
--   * v39 is not recorded on the database;
--   * any migrations_v2 migration newer than v39 is recorded (v40 first);
--   * any revision was written by the lifecycle - a revision with a
--     created_by_user_id, an activated_by_user_id or a retired_by_user_id, or
--     a source_metric_revision_create / _activate / _retire audit row (v37
--     refuses all of them and the seeds carry none; once one exists the way
--     forward is a new migration, never this script);
--   * the v39 function, triggers or index are not exactly the ones v39
--     created (one is missing, or a v39 trigger is disabled).
--
-- One transaction: everything or nothing. Waits are bounded: a transaction
-- that holds one of the two tables makes this script fail after 5 s. Dropping
-- a trigger or an index takes ACCESS EXCLUSIVE on its table until the COMMIT,
-- so reads of the two tables wait for that moment too; run it at a quiet
-- moment. Run it as one script that stops at the first error
-- (psql -v ON_ERROR_STOP=1 -f ...): after a refusal the open transaction is
-- aborted and nothing is changed.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql') then
    raise exception 'v39 rollback refused: v39 is not recorded on this database';
  end if;
end $$;

-- The checks read the two tables under the lock that keeps a new lifecycle write out.
lock table training_load.source_metric_definition_versions, training_load.source_metric_audit in share row exclusive mode;

do $$
declare
  v39 constant text := 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql';
  reasons text[] := '{}';
  newer text;
  missing text;
  disabled text;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name like 'migrations_v2/%' and migration_name > v39;
  if newer is not null then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if exists (select 1 from training_load.source_metric_definition_versions
              where created_by_user_id is not null or activated_by_user_id is not null or retired_by_user_id is not null)
     or exists (select 1 from training_load.source_metric_audit
                 where action in ('source_metric_revision_create', 'source_metric_revision_activate', 'source_metric_revision_retire')) then
    reasons := array_append(reasons, 'revisions were written by the lifecycle');
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'training_load' and p.proname = 'source_metric_revisions_lifecycle_link') then
    reasons := array_append(reasons, 'the v39 function is not present');
  end if;
  select string_agg(t.name, ', ' order by t.name) into missing
    from (values ('source_metric_revisions_v39_audit_link_insert'), ('source_metric_revisions_v39_audit_link_state')) as t(name)
   where not exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = 'training_load' and c.relname = 'source_metric_definition_versions' and g.tgname = t.name);
  if missing is not null then
    reasons := array_append(reasons, 'the v39 triggers are not all present');
  end if;
  select string_agg(g.tgname, ', ' order by g.tgname) into disabled
    from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'training_load' and g.tgname like '%\_v39\_%' and g.tgenabled <> 'O';
  if disabled is not null then
    reasons := array_append(reasons, 'a v39 trigger is disabled');
  end if;
  if to_regclass('training_load.source_metric_audit_v39_revision_once') is null then
    reasons := array_append(reasons, 'the v39 index is not present');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v39 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

drop trigger source_metric_revisions_v39_audit_link_state on training_load.source_metric_definition_versions;
drop trigger source_metric_revisions_v39_audit_link_insert on training_load.source_metric_definition_versions;
drop function training_load.source_metric_revisions_lifecycle_link();
drop index training_load.source_metric_audit_v39_revision_once;

-- v37's two function bodies, verbatim (migrations_v2/202610151000_training_load_v37_source_metric_revision_guards.sql).
create or replace function training_load.source_metric_revisions_actor_guard() returns trigger as $$
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

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql';

commit;
