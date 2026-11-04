-- Rollback of migration v56 (the import switch per team, the recorded prerequisites, and the bases club_admin /
-- team_coach; U2): migrations_v2/202611041400_training_load_v56_team_import_switch.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases
-- (backend/tests/team-import-switch-u2.test.mjs: apply -> rollback -> the v54 body exactly (md5) and the original CHECK ->
-- re-apply, every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the deployed commit no longer contains the v56
-- migration file (otherwise the migrator applies v56 again at the next start); and the owner approved this database
-- specifically (.claude/rules/database-safety.md).
--
-- It restores lock_gpexe_import_approver to v54's body byte for byte, restores the original approval_basis CHECK, drops the
-- three tables and the four functions and removes the v56 record. It changes no other row. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v56 is not recorded, or any later migrations_v2 migration is;
--   * the body in force of lock_gpexe_import_approver is not v56's (by md5);
--   * any switch row, switch history row or prerequisite record exists (the switch is a recorded decision: once one
--     exists, the way back is forward-only);
--   * any approval with the basis club_admin or team_coach exists (the original CHECK would refuse them).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f team-import-switch-v56-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v56 rollback refused: the migrator is running';
  end if;
end $$;

do $$
declare
  v56 constant text := 'migrations_v2/202611041400_training_load_v56_team_import_switch.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v56) then
    raise exception 'v56 rollback refused: v56 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v56) then
    raise exception 'v56 rollback refused: later migrations are applied';
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver') is distinct from '09b80cfea087b2c0e7aba47284010412' then
    raise exception 'v56 rollback refused: the body in force of lock_gpexe_import_approver is not v56''s';
  end if;
  if exists (select 1 from training_load.gpexe_team_import_switch)
     or exists (select 1 from training_load.gpexe_team_import_switch_history)
     or exists (select 1 from training_load.gpexe_import_prerequisite_records) then
    raise exception 'v56 rollback refused: a switch row, a history row or a prerequisite record exists';
  end if;
  if exists (select 1 from training_load.gpexe_import_approvals where approval_basis in ('club_admin', 'team_coach')) then
    raise exception 'v56 rollback refused: an approval with the basis club_admin or team_coach exists';
  end if;
end $$;

-- lock_gpexe_import_approver back to v54's body
create or replace function training_load.lock_gpexe_import_approver(p_user_id uuid, p_team_id uuid)
returns table (basis text, grant_id uuid) as $$
begin
  -- LO-2: the acting user first, then the role rows (the order of the revocations).
  perform 1 from public.users u where u.id = p_user_id and u.is_active = true for share;
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
   for share of r;
  if found then
    return query select 'platform_admin'::text, null::uuid;
    return;
  end if;
  return query
    select 'team_grant'::text, a.id
      from training_load.gpexe_import_approvers a
      join public.user_team_roles tr on tr.user_id = a.user_id and tr.team_id = a.owner_team_id
           and tr.role = 'team_coach' and tr.is_active = true
      join public.users u on u.id = a.user_id and u.is_active = true
     where a.user_id = p_user_id and a.owner_team_id = p_team_id and a.revoked_at is null
     for share of a, tr;
  if not found then
    raise exception 'user % may not approve GPEXE imports for team %', p_user_id, p_team_id
      using errcode = 'insufficient_privilege';
  end if;
end;
$$ language plpgsql;

alter table training_load.gpexe_import_approvals drop constraint gpexe_import_approvals_approval_basis_check;
alter table training_load.gpexe_import_approvals add constraint gpexe_import_approvals_approval_basis_check
  check (approval_basis in ('platform_admin', 'team_grant'));

drop function training_load.set_team_import_switch(uuid, uuid, boolean, text, text);
drop function training_load.record_import_prerequisite(uuid, text, date, text);
drop function training_load.team_import_actor_basis(uuid, uuid);
drop table training_load.gpexe_team_import_switch_history;
drop table training_load.gpexe_team_import_switch;
drop table training_load.gpexe_import_prerequisite_records;
drop function training_load.team_import_write_guard();

delete from public.schema_migrations where migration_name = 'migrations_v2/202611041400_training_load_v56_team_import_switch.sql';

-- Post-gate: v54's body is back and the v56 objects are gone.
do $$
begin
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'lock_gpexe_import_approver') is distinct from '9c3bf3edeb1dcca9c5516b77c30e86ee' then
    raise exception 'v56 rollback failed: lock_gpexe_import_approver is not v54''s body';
  end if;
  if to_regclass('training_load.gpexe_team_import_switch') is not null then
    raise exception 'v56 rollback failed: the switch table is still there';
  end if;
end $$;
commit;
