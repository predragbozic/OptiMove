-- Rollback of migration v65 (the stored two-athlete confirmation of a
-- drag-and-drop mapping; J18's migration M-A):
-- migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable
-- databases (backend/tests/source-metric-confirmations-v65.test.mjs: apply ->
-- rollback -> the catalog before v65, comments included, exactly -> re-apply,
-- every refusal below, and atomicity). Before it is run anywhere real: a fresh
-- restore-verified backup exists; the deployed commit no longer contains the
-- v65 migration file (otherwise the migrator applies v65 again at the next
-- start) nor any code that reads or writes its tables; and the owner approved
-- this database specifically (.claude/rules/database-safety.md).
--
-- v65 creates three tables with their guards, one removal function, T8's
-- confirmation_id column, two CHECKs and one index, widens T8's action CHECK
-- and replaces four T8 function bodies and T8's table comment. This script
-- restores v34's action CHECK and T8 comment verbatim and the four bodies byte
-- for byte, drops everything v65 created and removes the v65 record; it
-- changes no row. It refuses, changing nothing, when
--   * the migrator is running (it holds the advisory lock 822026 of
--     backend/src/migrate.js; this script takes the same lock for its own
--     transaction, without waiting);
--   * v65 is not recorded on the database, or any later migrations_v2
--     migration is (J18's gate migration M-B included: it is rolled back
--     first);
--   * a confirmation exists, or a T8 row that names a confirmation or carries
--     one of the three new actions (once one exists the way forward is a new
--     migration, never this script: the evidence is append-only);
--   * a v65 object is missing (a table, a function, a trigger, a CHECK, the
--     index), a trigger of the three tables or of T8 is disabled, or a body in
--     force of the four T8 functions is not v65's (by md5).
--
-- One transaction: everything or nothing. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f source-metric-confirmations-v65-rollback.sql
-- (the script carries its own BEGIN and COMMIT, so no --single-transaction).
-- After a refusal the transaction is aborted and nothing is changed. Waits are
-- bounded: a transaction that holds T4 or T8 (a read of T8 included) makes
-- this script fail after 5 s.
begin;
set local lock_timeout = '5s';

-- The migrator's lock (MIGRATION_LOCK_KEY in backend/src/migrate.js), for this
-- transaction: no deploy can apply or record a migration while v65 is undone.
do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v65 rollback refused: the migrator is running';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from public.schema_migrations
                  where migration_name = 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql') then
    raise exception 'v65 rollback refused: v65 is not recorded on this database';
  end if;
end $$;

-- v65's locks, in v65's order, before the checks: no mapping write and no
-- confirmation is written until the COMMIT.
lock table training_load.source_metric_mapping_versions in share row exclusive mode;
lock table training_load.source_metric_audit in access exclusive mode;

do $$
declare
  v65 constant text := 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql';
  expected constant text[][] := array[
    ['source_metric_audit_row_ok', '0ef48fd391a5380f70c92d96f47f894a'],
    ['source_metric_audit_actor_guard', 'b1b324ff092858d677a6635893646b1c'],
    ['source_metric_audit_insert_guard', 'cbfa726d60658dbba0198ab97192219e'],
    ['source_metric_audit_revision_guard', 'c2e8814af337acb6a2355b77a0bc1b1e']];
  reasons text[] := '{}';
  i integer;
begin
  if exists (select 1 from public.schema_migrations
              where migration_name like 'migrations_v2/%' and migration_name > v65) then
    reasons := array_append(reasons, 'later migrations are applied');
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'training_load' and c.relkind = 'r'
         and c.relname in ('source_metric_confirmations', 'source_metric_confirmation_sessions', 'source_metric_confirmation_items')) <> 3 then
    -- Without its tables nothing below can be read: refuse at once.
    raise exception 'v65 rollback refused: a v65 table is missing';
  end if;
  if exists (select 1 from training_load.source_metric_confirmations) then
    reasons := array_append(reasons, 'a confirmation exists');
  end if;
  if exists (select 1 from pg_attribute
              where attrelid = 'training_load.source_metric_audit'::regclass and attname = 'confirmation_id' and not attisdropped) then
    if exists (select 1 from training_load.source_metric_audit
                where confirmation_id is not null
                   or action in ('mapping_confirmation', 'confirmation_values_expired', 'confirmation_values_erased')) then
      reasons := array_append(reasons, 'an audit row of a confirmation exists');
    end if;
  else
    reasons := array_append(reasons, 'the confirmation_id column of the audit table is missing');
  end if;
  if (select count(*) from pg_trigger t
       where t.tgrelid in ('training_load.source_metric_confirmations'::regclass,
                           'training_load.source_metric_confirmation_sessions'::regclass,
                           'training_load.source_metric_confirmation_items'::regclass)
         and not t.tgisinternal) <> 11 then
    reasons := array_append(reasons, 'a trigger of the v65 tables is missing');
  end if;
  if exists (select 1 from pg_trigger t
              where t.tgrelid in ('training_load.source_metric_confirmations'::regclass,
                                  'training_load.source_metric_confirmation_sessions'::regclass,
                                  'training_load.source_metric_confirmation_items'::regclass,
                                  'training_load.source_metric_audit'::regclass)
                and not t.tgisinternal and t.tgenabled <> 'O') then
    reasons := array_append(reasons, 'a trigger is disabled');
  end if;
  if (select count(*) from pg_constraint
       where conrelid = 'training_load.source_metric_audit'::regclass
         and conname in ('source_metric_audit_confirmation_fk', 'source_metric_audit_confirmation_iff',
                         'source_metric_audit_erased_reason_check', 'source_metric_audit_action_check')) <> 4 then
    reasons := array_append(reasons, 'a v65 constraint of the audit table is missing');
  end if;
  if to_regclass('training_load.source_metric_audit_v65_confirmation_once') is null then
    reasons := array_append(reasons, 'the v65 index of the audit table is missing');
  end if;
  if (select count(*) from pg_proc p
       where p.pronamespace = 'training_load'::regnamespace
         and p.proname in ('source_metric_confirmation_actor_or_null', 'source_metric_confirmation_purge_marker_ok',
                           'source_metric_display_unit_ok', 'source_metric_confirmation_number_ok',
                           'source_metric_confirmations_insert_guard', 'source_metric_confirmation_of_this_transaction',
                           'source_metric_confirmation_sessions_insert_guard', 'source_metric_confirmation_item_digest',
                           'source_metric_confirmation_items_insert_guard', 'source_metric_confirmation_items_update_guard',
                           'remove_expired_confirmation_values', 'source_metric_confirmations_commit_link',
                           'source_metric_confirmation_items_removal_link')) <> 13 then
    reasons := array_append(reasons, 'a v65 function is missing');
  end if;
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc) from pg_proc p
         where p.pronamespace = 'training_load'::regnamespace and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      reasons := array_append(reasons, format('the body in force of %s is not v65''s', expected[i][1]));
    end if;
  end loop;
  if array_length(reasons, 1) > 0 then
    raise exception 'v65 rollback refused: %', array_to_string(reasons, '; ');
  end if;
end $$;

-- 1. T8 back to its shape before v65: v34's action CHECK and comment, no
--    confirmation_id, its two CHECKs and its index gone with the column.
drop index training_load.source_metric_audit_v65_confirmation_once;
alter table training_load.source_metric_audit
  drop constraint source_metric_audit_erased_reason_check,
  drop constraint source_metric_audit_confirmation_iff,
  drop constraint source_metric_audit_action_check,
  drop column confirmation_id,
  add constraint source_metric_audit_action_check check (action in (
    'source_metric_create', 'source_metric_revision_create', 'source_metric_unit_verified',
    'source_metric_meaning_verified', 'source_metric_revision_activate', 'source_metric_revision_retire',
    'source_metric_retire', 'mapping_create', 'mapping_version_create', 'mapping_status',
    'mapping_version_replaced', 'activation_start', 'activation_end', 'unit_conversion_create',
    'unit_conversion_retire', 'source_instance_end'));

comment on table training_load.source_metric_audit is
  'v34 (D10, T8): append-only record of every source metric, mapping, activation, unit conversion and source instance operation. No metadata column; reason and evidence_ref are bounded, format-checked and never name an athlete or carry a value.';

-- 2. The four bodies in force before v65, byte for byte (v52's row shape and
--    actor guard, v48's insert guard, v50's revision guard).
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
          or (p_from = 'needs_review' and p_to = 'active' and p_basis in ('platform_admin', 'club_admin'))
          or (p_from in ('draft', 'needs_review', 'active') and p_to = 'disabled' and p_reason is not null and p_basis in ('platform_admin', 'club_admin')))
      when 'mapping_version_replaced' then
        p_targets = '00110000' and p_from = 'needs_review' and p_to = 'active' and p_reason is not null and p_basis in ('platform_admin', 'club_admin')
      when 'activation_start' then
        p_targets = '00011001' and p_from is null and p_to is null and p_reason is not null and p_basis in ('platform_admin', 'club_admin')
      when 'activation_end' then
        p_targets = '00011001' and p_from is null and p_to is null and p_basis in ('platform_admin', 'club_admin')
      when 'unit_conversion_create' then
        p_targets = '00000100' and p_from is null and p_to = 'active' and p_evidence is not null and p_basis = 'platform_admin'
      when 'unit_conversion_retire' then
        p_targets = '00000100' and p_from = 'active' and p_to = 'retired' and p_reason is not null and p_basis = 'platform_admin'
      when 'source_instance_end' then
        p_targets in ('00000010', '00000011') and p_from = 'active' and p_to = 'inactive' and p_reason is not null and p_basis = 'platform_admin'
      else false end, false)
  $$;

create or replace function training_load.source_metric_audit_insert_guard() returns trigger as $$
begin
  if new.basis = 'club_admin' then
    if new.action in ('activation_start', 'activation_end') then
      -- v48 (C106): a club-admin activation row names its club through its
      -- activation's binding (the connection's owner club), never through the
      -- team or a mapping.
      if training_load.source_metric_binding_club(
           (select source_team_binding_id from training_load.source_metric_mapping_activations where id = new.activation_id)) is null then
        raise exception 'source_metric_audit: a club-admin activation row names an activation on a club''s binding' using errcode = '23514';
      end if;
    elsif not exists (
         select 1 from training_load.source_metric_mappings where id = new.mapping_id and owner_scope = 'club') then
      raise exception 'source_metric_audit: a club-admin row names a club mapping' using errcode = '23514';
    end if;
  end if;
  if new.activation_id is not null and not exists (
       select 1 from training_load.source_metric_mapping_activations
        where id = new.activation_id and mapping_version_id = new.mapping_version_id and team_id = new.team_id) then
    raise exception 'source_metric_audit: an activation row must name its own mapping version and team' using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;

create or replace function training_load.source_metric_audit_actor_guard() returns trigger as $$
declare
  actor uuid := training_load.source_metric_context_actor();
  here bigint := training_load.source_metric_current_xmin();
  map record;
  ver record;
  basis text;
  activation record;
  club uuid;
begin
  if new.performed_by_user_id is distinct from actor then
    raise exception 'source metric mapping: the row names another user than the acting user' using errcode = '42501';
  end if;
  if new.action in ('activation_start', 'activation_end') then
    -- v48 (C106): the basis derived as the activation's own write derived it -
    -- for the binding's club on a start and an admin_ended end; for an end
    -- written by a version's replacement or disable, as v52's T5 guard
    -- derives it (J14 section 2.4), with the same backstop.
    select source_team_binding_id, end_reason, mapping_id into activation
      from training_load.source_metric_mapping_activations where id = new.activation_id;
    if not found then
      raise exception 'source metric activation: the acting user may not write this audit row' using errcode = '42501';
    end if;
    if new.action = 'activation_end' and activation.end_reason in ('mapping_version_replaced', 'mapping_version_disabled') then
      basis := training_load.source_metric_actor_basis(actor, null);
      if basis is null then
        select owner_scope, owner_club_id into map from training_load.source_metric_mappings where id = activation.mapping_id;
        if map.owner_scope = 'club' then
          if training_load.source_metric_binding_club(activation.source_team_binding_id) is distinct from map.owner_club_id then
            raise exception 'source_metric_mapping_activations: a club version''s activation is on another club''s binding' using errcode = '23514';
          end if;
          basis := training_load.source_metric_actor_basis(actor, map.owner_club_id);
        end if;
      end if;
    else
      club := training_load.source_metric_binding_club(activation.source_team_binding_id);
      basis := case when club is null then null else training_load.source_metric_actor_basis(actor, club) end;
    end if;
    if basis is null or new.basis is distinct from basis then
      raise exception 'source metric activation: the acting user may not write this audit row' using errcode = '42501';
    end if;
    return new;
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

-- 3. Everything v65 created: the functions that name a table's row type
--    first, then the tables (their triggers and indexes go with them), then
--    the trigger functions and helpers.
drop function training_load.remove_expired_confirmation_values(integer);
drop function training_load.source_metric_confirmation_item_digest(training_load.source_metric_confirmation_items);
drop table training_load.source_metric_confirmation_items;
drop table training_load.source_metric_confirmation_sessions;
drop function training_load.source_metric_confirmation_sessions_insert_guard();
drop function training_load.source_metric_confirmation_items_insert_guard();
drop function training_load.source_metric_confirmation_of_this_transaction(uuid);
drop table training_load.source_metric_confirmations;
drop function training_load.source_metric_confirmations_insert_guard();
drop function training_load.source_metric_confirmations_commit_link();
drop function training_load.source_metric_confirmation_items_update_guard();
drop function training_load.source_metric_confirmation_items_removal_link();
drop function training_load.source_metric_confirmation_actor_or_null();
drop function training_load.source_metric_confirmation_purge_marker_ok();
drop function training_load.source_metric_display_unit_ok(text, text);
drop function training_load.source_metric_confirmation_number_ok(numeric);

delete from public.schema_migrations
 where migration_name = 'migrations_v2/202611121800_training_load_v65_source_metric_confirmations.sql';

commit;
