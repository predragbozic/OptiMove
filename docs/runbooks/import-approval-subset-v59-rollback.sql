-- Rollback of migration v59 (an approval may leave athletes out, J20-B):
-- migrations_v2/202611091100_training_load_v59_import_approval_subset.sql
--
-- Not a migration and never run automatically. Rehearsed on disposable databases
-- (backend/tests/gpexe-subset-import-j20b.test.mjs: apply -> rollback -> the v57 catalog exactly -> re-apply, every refusal below).
-- Before it is run anywhere real: a fresh restore-verified backup exists; the deployed commit no longer contains the v59
-- migration file (otherwise the migrator applies v59 again at the next start); and the owner approved this database
-- specifically (.claude/rules/database-safety.md).
--
-- It restores v33's trigger function body, drops the three CHECKs and the two columns, and removes the v59 record. It changes no other
-- row. It refuses, changing nothing, when
--   * the migrator is running (advisory lock 822026, taken without waiting);
--   * v59 is not recorded, or any later migrations_v2 migration is;
--   * the trigger function in force is not v59's (by md5);
--   * any approval has a non-empty excluded_athlete_ids or a subset_hash (a subset import happened: the record of who was left
--     out would be lost, so the way back is forward-only).
-- One transaction. Run it at a quiet moment as
--   psql -v ON_ERROR_STOP=1 -f import-approval-subset-v59-rollback.sql
begin;
set local lock_timeout = '5s';

do $$
begin
  if not pg_try_advisory_xact_lock(822026) then
    raise exception 'v59 rollback refused: the migrator is running';
  end if;
end $$;

lock table training_load.gpexe_import_approvals in access exclusive mode;

do $$
declare
  v59 constant text := 'migrations_v2/202611091100_training_load_v59_import_approval_subset.sql';
begin
  if not exists (select 1 from public.schema_migrations where migration_name = v59) then
    raise exception 'v59 rollback refused: v59 is not recorded on this database';
  end if;
  if exists (select 1 from public.schema_migrations where migration_name like 'migrations_v2/%' and migration_name > v59) then
    raise exception 'v59 rollback refused: later migrations are applied';
  end if;
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'validate_gpexe_import_approval') is distinct from 'febf8070345d1983e4c3bf1addec96c9' then
    raise exception 'v59 rollback refused: the body in force of training_load.validate_gpexe_import_approval is not v59''s';
  end if;
  if exists (select 1 from training_load.gpexe_import_approvals where cardinality(excluded_athlete_ids) > 0 or subset_hash is not null) then
    raise exception 'v59 rollback refused: a subset approval exists (the record of who was left out would be lost)';
  end if;
end $$;

-- v33's body back (the same text as migrations_v2/202610111000_training_load_v33_gpexe_check_finalization.sql).
create or replace function training_load.validate_gpexe_import_approval() returns trigger as $$
declare
  right_row record;
  cand record;
  seen_status text;
begin
  if tg_op <> 'INSERT' then
    raise exception 'gpexe_import_approvals is append-only (% refused)', tg_op;
  end if;
  -- Roles before the candidate: the lock order above.
  select * into right_row from training_load.lock_gpexe_import_approver(new.approved_by_user_id, new.owner_team_id);
  if right_row.basis is distinct from new.approval_basis or right_row.grant_id is distinct from new.approver_grant_id then
    raise exception 'gpexe_import_approvals: the recorded basis does not match the approver''s current right'
      using errcode = 'insufficient_privilege';
  end if;
  select owner_team_id, gpexe_team_session_id, bundle_hash, preview_hash, status, raw_bundle is not null as has_snapshot, raw_expires_at,
         coalesce(jsonb_array_length(preview -> 'changesToImported'), 0) as changes_to_imported,
         last_seen_check_id, drill_parameter_effect
    into cand
    from training_load.gpexe_import_candidates
   where id = new.candidate_id
   for update;
  if not found or cand.owner_team_id is distinct from new.owner_team_id then
    raise exception 'gpexe_import_approvals: candidate % does not belong to team %', new.candidate_id, new.owner_team_id;
  end if;
  if cand.status <> 'pending' then
    raise exception 'gpexe_import_approvals: candidate % is %, not pending', new.candidate_id, cand.status;
  end if;
  if not cand.has_snapshot or cand.raw_expires_at <= now() then
    raise exception 'gpexe_import_approvals: the snapshot of candidate % has expired', new.candidate_id;
  end if;
  if cand.gpexe_team_session_id is distinct from new.gpexe_team_session_id
     or cand.bundle_hash is distinct from new.bundle_hash
     or cand.preview_hash is distinct from new.preview_hash then
    raise exception 'gpexe_import_approvals: the approval does not match the candidate''s content and preview';
  end if;
  -- The accepted changes are the ones the preview lists, not a number the
  -- writer chose (the CHECK then requires them accepted when there are any).
  if new.changes_to_imported is distinct from cand.changes_to_imported then
    raise exception 'gpexe_import_approvals: changes_to_imported does not match the candidate''s preview';
  end if;
  -- v33: only a candidate whose last sighting is a check of its team that
  -- atomically succeeded is actionable, and a session with two or more drills
  -- only with a confirmed drill-parameter effect.
  select status into seen_status from training_load.gpexe_import_checks where id = cand.last_seen_check_id and owner_team_id = cand.owner_team_id;
  if seen_status is distinct from 'succeeded' then
    raise exception 'gpexe_import_approvals: candidate % is not confirmed by a succeeded check', new.candidate_id;
  end if;
  if cand.drill_parameter_effect is null or cand.drill_parameter_effect not in ('not_required', 'confirmed') then
    raise exception 'gpexe_import_approvals: candidate % has no confirmed drill-parameter effect', new.candidate_id;
  end if;
  return new;
end;
$$ language plpgsql;

alter table training_load.gpexe_import_approvals
  drop constraint gpexe_import_approvals_excluded_size,
  drop constraint gpexe_import_approvals_subset_hash_pair,
  drop constraint gpexe_import_approvals_subset_hash_format,
  drop column excluded_athlete_ids,
  drop column subset_hash;

delete from public.schema_migrations where migration_name = 'migrations_v2/202611091100_training_load_v59_import_approval_subset.sql';

-- Post-gate: v33's body is in force and no v59 object is left.
do $$
begin
  if (select md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'validate_gpexe_import_approval') is distinct from '1b4cc435b11a5b8e462dee4b296bf068' then
    raise exception 'v59 rollback failed: the trigger function is not v33''s';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'training_load' and table_name = 'gpexe_import_approvals'
              and column_name in ('excluded_athlete_ids', 'subset_hash')) then
    raise exception 'v59 rollback failed: a v59 column is still there';
  end if;
end $$;
commit;
