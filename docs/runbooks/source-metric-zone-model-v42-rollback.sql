-- Rollback of migration v42 (the zone model, option A; C102, C103):
-- migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/source-metric-zone-model-v42.test.mjs: apply ->
-- rollback -> the v41 catalog and data again -> re-apply, and every refusal
-- below). Before it is run anywhere real: a fresh restore-verified backup
-- exists; the deployed commit no longer contains the v42 migration file
-- (otherwise the migrator applies v42 again at the next start) nor the F3
-- route change that sends a zone's operator; and the owner approved this
-- database specifically (.claude/rules/database-safety.md).
--
-- v42 replaces two function bodies and seeds one source field with its
-- revision 1; no table, column, constraint, index or trigger. This script
-- deletes the seed, restores v39's body of source_metric_revisions_actor_guard()
-- and v34's body of source_metric_require_seed_window() verbatim (and their
-- comments, which v41 does not have), and removes the v42 record. It refuses,
-- changing nothing, when
--   * v42 is not recorded on the database, or any later migrations_v2
--     migration is;
--   * any zone_bounds revision carries a meaning proof or an operator (only
--     v42 allows one, and the restored v39 rule forbids it; once one exists
--     v42 is forward-only and a correction is a later migration);
--   * the open top zone field is not exactly its seed: another revision, a
--     proof, a retirement, an actor, a changed label, unit, note or reference,
--     or any T3, T4, T5, T6 or T8 row naming the field or its revision;
--   * any trigger of training_load.source_metric_definitions or
--     source_metric_definition_versions is disabled when it starts;
--   * the migrator is running (it holds the advisory lock 822026 of
--     backend/src/migrate.js; this script takes the same lock for its own
--     transaction, without waiting).
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f source-metric-zone-model-v42-rollback.sql
-- (the script carries its own BEGIN and COMMIT, so no --single-transaction).
-- After a refusal the transaction is aborted and nothing is changed. Waits are
-- bounded: a transaction that holds one of the two tables makes this script
-- fail after 5 s. The two v34 guards that refuse a DELETE are disabled by name
-- for this transaction only, and every trigger of the two tables is checked
-- enabled again before the COMMIT.
begin;
set local lock_timeout = '5s';

-- The migrator's lock (MIGRATION_LOCK_KEY in backend/src/migrate.js), for this
-- transaction: no deploy can apply or record a migration while v42 is undone.
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v42 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql') then
    raise exception 'v42 rollback refused: v42 is not recorded on this database';
  end if;
end $$;

-- The checks read the tables under the lock that keeps a new field, revision
-- or proof out until the COMMIT.
lock table training_load.source_metric_definitions, training_load.source_metric_definition_versions in share row exclusive mode;

do $$
declare
  v42 constant text := 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql';
  open_top constant text := 'more.complementary_data.power.distance.open_top';
  reasons text[] := '{}';
  field record;
  disabled text;
begin
  if exists (select 1 from public.schema_migrations
              where migration_name like 'migrations_v2/%' and migration_name > v42) then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if exists (select 1 from training_load.source_metric_definition_versions
              where parameter_kind = 'zone_bounds'
                and (meaning_verified_at is not null or bound_operator is not null)) then
    reasons := array_append(reasons, 'a zone revision carries a meaning proof or an operator');
  end if;
  select d.id, d.source_label, d.state, d.retired_by_user_id, d.retired_at, d.retired_reason, d.created_by_user_id, d.seed_migration
    into field
    from training_load.source_metric_definitions d
   where d.source_system = 'gpexe' and d.api_family = 'rest_v1' and d.source_metric_key = open_top;
  if not found then
    reasons := array_append(reasons, 'the open top zone field is not present');
  else
    if field.source_label is distinct from 'Power zone distance (open top zone)' or field.state is distinct from 'active'
       or field.retired_by_user_id is not null or field.retired_at is not null or field.retired_reason is not null
       or field.created_by_user_id is not null or field.seed_migration is distinct from v42 then
      reasons := array_append(reasons, 'the open top zone field is not its seed');
    end if;
    if (select count(*) from training_load.source_metric_definition_versions where source_metric_definition_id = field.id) <> 1
       or not exists (
         select 1 from training_load.source_metric_definition_versions r
          where r.source_metric_definition_id = field.id
            and r.revision_number = 1 and r.value_shape = 'zone_distance' and r.parameter_kind = 'zone_bounds'
            and r.supports_session and r.supports_drill
            and r.expected_source_unit = 'm' and r.expected_source_bound_unit = 'W/kg'
            and r.unit_note = 'Expected unit is a hypothesis from the e03 pilot; not proven on server3. The open top zone of the power zone list: the zone whose upper extreme is null.'
            and r.source_unit is null and r.source_bound_unit is null and r.bound_operator is null
            and r.unit_verified_by_user_id is null and r.unit_verified_at is null and r.unit_evidence_ref is null
            and r.meaning_verified_by_user_id is null and r.meaning_verified_at is null and r.meaning_evidence_ref is null
            and r.evidence_status = 'observed' and r.evidence_ref = 'docs/ai/gpexe-rest-v1-compatibility.md#2-the-table'
            and r.state = 'active' and r.activated_by_user_id is null
            and r.retired_by_user_id is null and r.retired_at is null and r.retired_reason is null
            and r.created_by_user_id is null and r.seed_migration = v42) then
      reasons := array_append(reasons, 'the open top zone revision is not its seed');
    end if;
    if exists (select 1 from training_load.source_metric_mappings where source_metric_definition_id = field.id)
       or exists (select 1 from training_load.source_metric_mapping_versions where source_metric_definition_id = field.id)
       or exists (select 1 from training_load.source_metric_mapping_activations where source_metric_definition_id = field.id)
       or exists (select 1 from training_load.metric_value_source_provenance p
                    join training_load.source_metric_definition_versions r on r.id = p.source_metric_version_id
                   where r.source_metric_definition_id = field.id)
       or exists (select 1 from training_load.source_metric_audit a
                   where a.source_metric_definition_id = field.id
                      or a.source_metric_version_id in (select r.id from training_load.source_metric_definition_versions r
                                                         where r.source_metric_definition_id = field.id)) then
      reasons := array_append(reasons, 'a mapping, an activation, a value or an audit row names the open top zone field');
    end if;
  end if;
  select string_agg(g.tgname, ', ' order by g.tgname) into disabled
    from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'training_load' and c.relname in ('source_metric_definitions', 'source_metric_definition_versions')
     and not g.tgisinternal and g.tgenabled <> 'O';
  if disabled is not null then
    reasons := array_append(reasons, 'a trigger of the two tables is disabled');
  end if;
  if array_length(reasons, 1) > 0 then
    raise exception 'v42 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

-- The seed: the two v34 guards refuse a DELETE, so exactly they are disabled,
-- for this transaction only, around the two deletes.
alter table training_load.source_metric_definition_versions disable trigger source_metric_revisions_guard;
alter table training_load.source_metric_definitions disable trigger source_metric_definitions_guard;
delete from training_load.source_metric_definition_versions
 where seed_migration = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql';
delete from training_load.source_metric_definitions
 where seed_migration = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql';
alter table training_load.source_metric_definitions enable trigger source_metric_definitions_guard;
alter table training_load.source_metric_definition_versions enable trigger source_metric_revisions_guard;

do $$
begin
  if exists (select 1 from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'training_load' and c.relname in ('source_metric_definitions', 'source_metric_definition_versions')
                and not g.tgisinternal and g.tgenabled <> 'O') then
    raise exception 'v42 rollback refused: a trigger of the two tables is not enabled again';
  end if;
end $$;

-- v34's seed window, verbatim
-- (migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql).
create or replace function training_load.source_metric_require_seed_window(p_marker text) returns void as $$
begin
  if p_marker is distinct from 'migrations_v2/202610121000_training_load_v34_source_metric_mapping.sql'
     or exists (select 1 from public.schema_migrations where migration_name = p_marker) then
    raise exception 'source metric mapping: a seed marker is accepted only from the seeding migration' using errcode = '42501';
  end if;
end;
$$ language plpgsql;

-- v39's actor guard of T2b, verbatim
-- (migrations_v2/202610271100_training_load_v39_source_metric_revision_lifecycle.sql).
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

-- v41 has no comment on either function; create or replace keeps one.
comment on function training_load.source_metric_require_seed_window(text) is null;
comment on function training_load.source_metric_revisions_actor_guard() is null;

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202610282300_training_load_v42_source_metric_zone_model.sql';

commit;
