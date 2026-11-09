-- v58: an approval may leave athletes out (J20-B, docs/ai/j20-session-review-contract.md section 5.1).
--
-- What it changes (Trigger 1, a migration; Trigger 3, a record of who was left out):
--   * gpexe_import_approvals gains `excluded_athlete_ids` (GPEXE athlete ids the coach left out of this import; ids only,
--     no names; NOT NULL DEFAULT '{}', so every existing approval reads as "nobody left out" and no row is rewritten) and
--     `subset_hash` (the hash of the preview recomputed WITH that set; NULL exactly when the set is empty).
--   * the approval's `preview_hash` keeps meaning what it meant: the hash of the whole candidate's stored preview, which
--     the v33 trigger still compares with the candidate. A subset approval therefore passes the same check as a full one.
--   * the trigger body (CREATE OR REPLACE of v33's validate_gpexe_import_approval, nothing else about it changes) also
--     checks the new columns: the set is canonical ids, sorted numerically, unique, at most 60, no NULL element, one
--     dimension; subset_hash is present exactly when the set is not empty. Both columns are write-once because the table is
--     append-only (the same trigger refuses UPDATE, DELETE and TRUNCATE).
--
-- What it does NOT do (stated, as for v35's guards): a trigger cannot recompute a preview, so that `subset_hash` and the set
-- agree with a preview computed under the locks is verified by approveCandidate step 12, in the same transaction, and by its
-- tests. A raw writer that supplies a well-formed set and a well-formed but wrong hash is outside that guarantee.
--
-- Before it changes anything it checks that the trigger function in force is v33's (md5 of pg_proc.prosrc); after, that it is
-- the new one. Rollback: docs/runbooks/import-approval-subset-v58-rollback.sql (refuses once any approval has a non-empty set).

do $$
begin
  if (select md5(p.prosrc)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'validate_gpexe_import_approval')
     is distinct from '1b4cc435b11a5b8e462dee4b296bf068' then
    raise exception 'v58 refused: the body in force of training_load.validate_gpexe_import_approval is not v33''s' using errcode = '23514';
  end if;
end;
$$;

alter table training_load.gpexe_import_approvals
  add column excluded_athlete_ids text[] not null default '{}',
  add column subset_hash text;

alter table training_load.gpexe_import_approvals
  add constraint gpexe_import_approvals_excluded_size check (cardinality(excluded_athlete_ids) <= 60),
  add constraint gpexe_import_approvals_subset_hash_pair check ((cardinality(excluded_athlete_ids) = 0) = (subset_hash is null)),
  add constraint gpexe_import_approvals_subset_hash_format check (subset_hash is null or subset_hash ~ '^[0-9a-f]{64}$');

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
  -- v58: the set of athletes left out is a canonical, sorted, unique list of GPEXE ids. (The size and the pairing with
  -- subset_hash are the table's own CHECKs.) That the set and the hash match a preview is the application's step 12.
  if cardinality(new.excluded_athlete_ids) > 0 then
    if array_ndims(new.excluded_athlete_ids) is distinct from 1
       or exists (select 1 from unnest(new.excluded_athlete_ids) as x where x is null or x !~ '^(0|[1-9][0-9]{0,11})$') then
      raise exception 'gpexe_import_approvals: excluded_athlete_ids must be canonical GPEXE athlete ids' using errcode = '23514';
    end if;
    if new.excluded_athlete_ids is distinct from (select array_agg(x order by x::bigint) from unnest(new.excluded_athlete_ids) as x)
       or (select count(distinct x) from unnest(new.excluded_athlete_ids) as x) <> cardinality(new.excluded_athlete_ids) then
      raise exception 'gpexe_import_approvals: excluded_athlete_ids must be sorted numerically and unique' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

do $$
begin
  if (select md5(p.prosrc)
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'training_load' and p.proname = 'validate_gpexe_import_approval')
     = '1b4cc435b11a5b8e462dee4b296bf068' then
    raise exception 'v58 failed: the trigger function still has v33''s body' using errcode = '23514';
  end if;
end;
$$;
