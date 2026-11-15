-- v66: the gate on a club admin's activation of a mapping version of a field
-- without parameters (J18, C112; migration M-B of the contract).
--
-- Contract: docs/ai/c112-drag-mapping-contract.md (J18), sections 5.5, 15.3
-- and 15.9. From this migration on, a club admin moves such a version
-- needs_review -> active only
--
--   (a) inside a drag-and-drop save: a checked row of T9i
--       (training_load.source_metric_confirmation_items, v65) names exactly
--       this version, in a confirmation written in THIS transaction by the
--       activating user for the version's club; or
--   (b) as a copy of OptiMove's mapping (J15, v53): a row of
--       training_load.source_metric_mapping_version_copies links this version
--       to a system version that is still active (C125).
--
-- Everything else is refused with 23514 and one fixed message, which the
-- service maps to 409 confirmation_required. A platform admin's activation,
-- a system version, and a version of a field with parameters (zones and
-- thresholds, parameter_kind <> 'none') are not touched.
--
-- It adds ONE function and ONE trigger on T4 and replaces no body. The
-- trigger's name sorts after v34's update guard and v35's actor guard, so it
-- runs on a row both have accepted (the basis is the one v35 derived).
--
-- "This transaction" is the xmin comparison of v35 and v65
-- (training_load.source_metric_current_xmin): a confirmation written in an
-- earlier transaction, or inside a savepoint of this one (a subtransaction
-- has its own xid), does not pass. v65's guards already refuse a T9 write
-- inside a savepoint; the gate fails closed on its own as well.
--
-- Reads only: T9i and T9 of this transaction (the writer's own rows), and the
-- copy link with its system version by a plain read, never a lock (J15
-- sections 7.2 and 7.6), so no lock edge is added.
--
-- Locks: T4 SHARE ROW EXCLUSIVE (CREATE TRIGGER takes it anyway), within the
-- runner's lock_timeout. No table is altered and no row is changed.
--
-- Rollback: docs/runbooks/club-activation-confirmation-gate-v66-rollback.sql
-- (it refuses under a later migration; it drops only this trigger and this
-- function).
--
-- Known limits (as v35, C74): the gate proves that the version, the acting
-- user and a confirmation of the same transaction agree, not that the two
-- athletes were looked at. It is no defence against whoever controls the
-- shared owner credentials.

-- ---------------------------------------------------------------------------
-- 0. The lock.
-- ---------------------------------------------------------------------------
lock table training_load.source_metric_mapping_versions in share row exclusive mode;

-- ---------------------------------------------------------------------------
-- 1. Written on T4's guards in force and on v65's tables: refuse any other.
-- ---------------------------------------------------------------------------
do $$
declare
  expected constant text[][] := array[
    ['source_metric_mapping_versions_update_guard', '42fb55a2dd043328079fa9b6f4a2c43e'],
    ['source_metric_mapping_versions_actor_guard', '3fabb004253650eb5d0460da786c7883']];
  triggers text;
  i integer;
begin
  for i in 1 .. array_length(expected, 1) loop
    if (select md5(p.prosrc)
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'training_load' and p.proname = expected[i][1])
       is distinct from expected[i][2] then
      raise exception 'v66 refused: the body in force of training_load.% is not the one this gate was written on', expected[i][1] using errcode = '23514';
    end if;
  end loop;
  select string_agg(t.tgname::text || ':' || t.tgenabled::text, ',' order by t.tgname::text) into triggers
    from pg_trigger t
   where t.tgrelid = 'training_load.source_metric_mapping_versions'::regclass and not t.tgisinternal;
  if triggers is distinct from 'source_metric_mapping_versions_insert_guard:O,source_metric_mapping_versions_no_truncate:O,source_metric_mapping_versions_update_guard:O,source_metric_mapping_versions_v35_actor_guard:O,source_metric_mapping_versions_v35_audit_link_insert:O,source_metric_mapping_versions_v35_audit_link_update:O' then
    raise exception 'v66 refused: the triggers of training_load.source_metric_mapping_versions are not the six this gate was written on, all enabled' using errcode = '23514';
  end if;
  if to_regclass('training_load.source_metric_confirmation_items') is null
     or to_regclass('training_load.source_metric_confirmations') is null
     or to_regclass('training_load.source_metric_mapping_version_copies') is null
     or to_regprocedure('training_load.source_metric_current_xmin()') is null then
    raise exception 'v66 refused: the confirmation tables of v65, the copy links of v53 or v35''s transaction helper are missing' using errcode = '23514';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The gate.
-- ---------------------------------------------------------------------------
create function training_load.source_metric_mapping_versions_confirmation_gate() returns trigger as $$
declare
  here bigint;
begin
  if old.status is distinct from 'needs_review' or new.status is distinct from 'active'
     or new.activated_basis is distinct from 'club_admin' or new.parameter_kind is distinct from 'none' then
    return new;
  end if;

  -- (a) A checked row of a confirmation of this very transaction, by the
  --     activating user, for the version's club.
  here := training_load.source_metric_current_xmin();
  if exists (
    select 1
      from training_load.source_metric_confirmation_items i
      join training_load.source_metric_confirmations c on c.id = i.confirmation_id
     where i.mapping_version_id = new.id
       and i.item_kind = 'club_mapping'
       and i.checked
       and i.xmin::text::bigint = here
       and c.xmin::text::bigint = here
       and c.confirmed_by_user_id = new.activated_by_user_id
       and c.owner_scope = 'club'
       and c.owner_club_id::text = new.owner_key
  ) then
    return new;
  end if;

  -- (b) A copy of OptiMove's mapping whose system version is still active
  --     (J15, C125). A plain read: no lock.
  if exists (
    select 1
      from training_load.source_metric_mapping_version_copies k
      join training_load.source_metric_mapping_versions s on s.id = k.system_version_id
     where k.club_version_id = new.id
       and s.owner_key = 'system'
       and s.status = 'active'
  ) then
    return new;
  end if;

  raise exception 'source_metric_mapping_versions: a club admin switches a version of a field without parameters on from the drag-and-drop board'
    using errcode = '23514';
end;
$$ language plpgsql;

comment on function training_load.source_metric_mapping_versions_confirmation_gate() is
  'v66 (J18, M-B): a club admin''s needs_review -> active of a version with parameter_kind none needs a checked T9i row of this transaction by the activating user for the version''s club, or a v53 copy link to an active system version.';

create trigger source_metric_mapping_versions_v66_confirmation_gate
  before update on training_load.source_metric_mapping_versions
  for each row execute function training_load.source_metric_mapping_versions_confirmation_gate();
