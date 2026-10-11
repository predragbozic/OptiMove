-- Rollback of migration v33 (a check's results become actionable only when the
-- check succeeds): migrations_v2/202610111000_training_load_v33_gpexe_check_finalization.sql
--
-- Not a migration and never run automatically. Rehearsed on a disposable
-- database (backend/tests/gpexe-check-finalization.test.mjs: apply on v32,
-- check the constraints, roll back to the identical v32 catalog, apply again).
-- Before it is run anywhere real:
--   * the application is back on a commit WITHOUT the check finalization
--     (its check run writes superseded_by_check_id / reappeared_status /
--     drill_parameter_effect and its approval relies on the v33 gate);
--   * a fresh, restore-verified backup exists;
--   * the owner approved this database specifically.
-- It is forward-safe: it refuses, changing nothing, when
--   * any migrations_v2 migration newer than v33 is recorded;
--   * any candidate is superseded by a check (superseded_by_check_id) - that
--     history has no place in the v32 rule and is never dropped silently.
-- A waiting reappearance mark (reappeared_status) is discarded with its column:
-- such a row is superseded by a candidate (one superseded by a check refuses
-- the rollback above) and stays exactly that - the reappearance simply never
-- takes effect, which is what the v32 code would do anyway.
-- drill_parameter_effect is a derived fact (never a value or a fingerprint)
-- and is dropped with the column; the v32 approval rule does not read it.
-- AFTER THIS ROLLBACK SWITCH CONDITIONS 6 AND 7 ARE OPEN AGAIN: the v32 approval
-- trigger accepts a candidate of a check that never succeeded and one whose
-- drills were never confirmed, so GPEXE_IMPORT_APPLY_ENABLED must stay off.
--
-- One transaction. Run it as
--   psql -v ON_ERROR_STOP=1 -f docs/runbooks/gpexe-check-finalization-v33-rollback.sql
begin;
set local lock_timeout = '5s';
lock table training_load.gpexe_import_candidates in access exclusive mode nowait;
lock table training_load.gpexe_import_approvals in access exclusive mode nowait;
lock table training_load.gpexe_import_checks in access exclusive mode nowait;

do $$
declare
  newer text;
  dependent integer;
begin
  select string_agg(migration_name, ', ' order by migration_name) into newer
    from public.schema_migrations
   where migration_name > 'migrations_v2/202610111000_training_load_v33_gpexe_check_finalization.sql'
     and migration_name like 'migrations_v2/%';
  if newer is not null then
    raise exception 'v33 rollback refused: later migrations are applied: %; only a forward migration is allowed', newer;
  end if;
  if not exists (select 1 from public.schema_migrations where migration_name like '%202610111000_training_load_v33_gpexe_check_finalization.sql') then
    raise exception 'v33 rollback refused: v33 is not recorded as applied on this database';
  end if;
  select count(*) into dependent from training_load.gpexe_import_candidates
   where superseded_by_check_id is not null;
  if dependent > 0 then
    raise exception 'v33 rollback refused: % candidate(s) are superseded by a check (superseded_by_check_id); only a forward migration may decide their fate', dependent;
  end if;
end $$;

create or replace function training_load.validate_gpexe_import_approval() returns trigger as $$
declare
  right_row record;
  cand record;
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
         coalesce(jsonb_array_length(preview -> 'changesToImported'), 0) as changes_to_imported
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
  return new;
end;
$$ language plpgsql;

drop trigger gpexe_import_checks_status_final on training_load.gpexe_import_checks;
drop function training_load.gpexe_check_status_final();
drop index training_load.gpexe_import_candidates_superseded_by_check_idx;
alter table training_load.gpexe_import_candidates
  drop constraint gpexe_import_candidates_superseded_by_exactly_one,
  drop constraint gpexe_import_candidates_reappeared_only_superseded,
  drop constraint gpexe_import_candidates_drill_parameter_effect_values;
alter table training_load.gpexe_import_candidates
  drop column superseded_by_check_id,
  drop column reappeared_status,
  drop column drill_parameter_effect;
-- The v22 rule, under the name PostgreSQL gave it when v22 created it unnamed.
alter table training_load.gpexe_import_candidates
  add constraint gpexe_import_candidates_check2 check ((status = 'superseded') = (superseded_by_candidate_id is not null));

delete from public.schema_migrations where migration_name like '%202610111000_training_load_v33_gpexe_check_finalization.sql';
commit;
