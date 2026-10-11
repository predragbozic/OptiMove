-- Training Load v33 — a check's results become actionable only when the check
-- itself is atomically succeeded (owner order 2026-10-11, condition 6 and the
-- server3 drill-parameter guard).
--
-- Before v33 a check stored its candidates session by session, each in its own
-- transaction, and nothing in the approval path asked whether that check ever
-- finished: only the import switch kept a running or failed check's candidate
-- from being imported. v33 makes the check's success the publication of its
-- results, in the database:
--
--   1. superseded_by_check_id — a candidate that a complete, successful check
--      of its team and period no longer confirms is superseded BY THAT CHECK
--      (not by a newer candidate). Exactly one of superseded_by_candidate_id /
--      superseded_by_check_id is set on a superseded row, and neither on any
--      other status (gpexe_import_candidates_superseded_by_exactly_one). The
--      check is referenced ON DELETE RESTRICT (checks are never deleted, v24).
--   2. gpexe_import_check_observations — what a RUNNING check saw, staged
--      per check and session (the snapshot, its hash, the preview, the status
--      it would have, the drill effect), insert-only, accepted only for a
--      running check of the same team. A candidate row is never written while
--      a check runs: the published candidates stay byte for byte as the last
--      successful check left them, a new session or new content is not
--      visible or approvable, and nothing is withdrawn. The finalization
--      applies the observations and deletes them in its one transaction; the
--      observations of a check that did not succeed are discarded (the failed
--      run, then the retention run).
--   3. drill_parameter_effect — the one derived fact of the drill-parameter
--      guard: not_required (fewer than two drills), confirmed (at least two
--      non-empty drill answers, pairwise distinct), not_observed (fewer than
--      two non-empty answers). Never a fingerprint or a value. NULL on rows
--      from before v33.
--   4. The approval validation (training_load.validate_gpexe_import_approval,
--      replacing v23's) additionally refuses an approval unless the
--      candidate's last_seen check is a 'succeeded' check OF THE SAME TEAM and
--      its drill_parameter_effect is not_required or confirmed. Since v33
--      last_seen_check_id is written only by the finalization, in the
--      transaction that marks that check succeeded, so it always names the
--      last SUCCESSFULLY FINALIZED check, never a running or failed attempt;
--      the trigger still verifies it (rows from before v33, raw writers). The
--      check row is read without a lock: a check that is still running is
--      refused, and a finished check never changes (5.); the finalization
--      takes the check row before the candidates, the approval takes the
--      candidate before reading the check, so no lock cycle exists.
--   5. A check's status moves only from 'running' to 'succeeded' or 'failed';
--      once finished, its status and finished_at are final
--      (gpexe_import_checks_status_final, whoever writes) - the unlocked read
--      above relies on it, and a late conditional 'failed' write can never
--      overwrite a published check.
--
-- No data is rewritten: existing rows keep their status; rows from before v33
-- (drill_parameter_effect NULL) are not actionable until a successful check
-- sees them again. Rollback: docs/runbooks/gpexe-check-finalization-v33-rollback.sql
-- (refuses while any row depends on superseded_by_check_id).

alter table training_load.gpexe_import_candidates
  add column superseded_by_check_id uuid references training_load.gpexe_import_checks(id) on delete restrict,
  add column drill_parameter_effect varchar(20);

-- The v22 rule "superseded <=> superseded_by_candidate_id" is replaced by the
-- exactly-one rule. It was created unnamed, so it is found as the one CHECK of
-- the table over exactly the columns status and superseded_by_candidate_id
-- (independent of how a server version prints the definition), and refused
-- unless exactly one such constraint exists.
do $$
declare
  found_names text[];
  status_att smallint;
  by_att smallint;
begin
  select attnum into status_att from pg_attribute
   where attrelid = 'training_load.gpexe_import_candidates'::regclass and attname = 'status' and not attisdropped;
  select attnum into by_att from pg_attribute
   where attrelid = 'training_load.gpexe_import_candidates'::regclass and attname = 'superseded_by_candidate_id' and not attisdropped;
  select array_agg(c.conname) into found_names
    from pg_constraint c
   where c.conrelid = 'training_load.gpexe_import_candidates'::regclass
     and c.contype = 'c'
     and c.conkey @> array[status_att, by_att]
     and array_length(c.conkey, 1) = 2;
  if coalesce(array_length(found_names, 1), 0) <> 1 then
    raise exception 'v33: expected exactly one v22 superseded rule, found %; refusing to guess', coalesce(array_length(found_names, 1), 0);
  end if;
  execute format('alter table training_load.gpexe_import_candidates drop constraint %I', found_names[1]);
end $$;

alter table training_load.gpexe_import_candidates
  add constraint gpexe_import_candidates_superseded_by_exactly_one check (
    case when status = 'superseded'
      then (superseded_by_candidate_id is null) <> (superseded_by_check_id is null)
      else superseded_by_candidate_id is null and superseded_by_check_id is null
    end
  ),
  add constraint gpexe_import_candidates_drill_parameter_effect_values check (
    drill_parameter_effect is null or drill_parameter_effect in ('not_required', 'confirmed', 'not_observed')
  );

create index gpexe_import_candidates_superseded_by_check_idx
  on training_load.gpexe_import_candidates (superseded_by_check_id) where superseded_by_check_id is not null;

comment on column training_load.gpexe_import_candidates.superseded_by_check_id is
  'v33: the successful, complete check (binding path) of the team and window that no longer confirmed this candidate; exactly one of superseded_by_candidate_id / superseded_by_check_id on a superseded row.';
comment on column training_load.gpexe_import_candidates.drill_parameter_effect is
  'v33: the drill-parameter guard''s derived word (not_required / confirmed / not_observed); never a fingerprint or a value. An approval needs not_required or confirmed.';

-- 5. A check's status is final once it has finished.
create function training_load.gpexe_check_status_final() returns trigger as $$
begin
  if old.status = 'running' then
    if new.status not in ('running', 'succeeded', 'failed') then
      raise exception 'gpexe_import_checks: check % may only move from running to succeeded or failed', old.id using errcode = '23514';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status or new.finished_at is distinct from old.finished_at then
    raise exception 'gpexe_import_checks: check % has finished (%); its status and finished_at are final', old.id, old.status using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger gpexe_import_checks_status_final
  before update on training_load.gpexe_import_checks
  for each row execute function training_load.gpexe_check_status_final();

-- 2. The staging of a running check. One row per check and session; what the
--    finalization publishes. Insert-only, for a running check of the same
--    team; never changed; deleted by the finalization, by the failed run or
--    by the retention run (a check that is no longer running). No route reads
--    it: the list, the detail, the source athletes and the approvals read
--    gpexe_import_candidates only.
create table training_load.gpexe_import_check_observations (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references training_load.gpexe_import_checks(id) on delete restrict,
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  gpexe_team_session_id text not null check (gpexe_team_session_id ~ '^[0-9]{1,12}$'),
  session_started_at timestamptz,
  session_label text,
  bundle_hash text not null check (bundle_hash ~ '^[0-9a-f]{64}$'),
  raw_bundle jsonb not null,
  status varchar(20) not null check (status in ('pending', 'blocked')),
  preview jsonb not null,
  preview_hash text not null check (preview_hash ~ '^[0-9a-f]{64}$'),
  drill_parameter_effect varchar(20) check (drill_parameter_effect is null or drill_parameter_effect in ('not_required', 'confirmed', 'not_observed')),
  observed_at timestamptz not null default now(),
  unique (check_id, gpexe_team_session_id)
);
create index gpexe_import_check_observations_team_idx on training_load.gpexe_import_check_observations (owner_team_id);
comment on table training_load.gpexe_import_check_observations is
  'v33: what a running check saw, staged per check and session until its finalization publishes it; never read by a route.';

create function training_load.gpexe_import_check_observation_guard() returns trigger as $$
declare
  k record;
begin
  if tg_op = 'UPDATE' then
    raise exception 'gpexe_import_check_observations: an observation is never changed' using errcode = '23514';
  end if;
  -- FOR SHARE: an insert waits for a finalization or an abandon sweep that
  -- holds the check row, and then sees the status it committed.
  select status, owner_team_id into k from training_load.gpexe_import_checks where id = new.check_id for share;
  if not found or k.status <> 'running' then
    raise exception 'gpexe_import_check_observations: check % is not running; an observation belongs to a running check', new.check_id using errcode = '23514';
  end if;
  if k.owner_team_id is distinct from new.owner_team_id then
    raise exception 'gpexe_import_check_observations: check % belongs to another team', new.check_id using errcode = '23514';
  end if;
  return new;
end;
$$ language plpgsql;
create trigger gpexe_import_check_observations_guard
  before insert or update on training_load.gpexe_import_check_observations
  for each row execute function training_load.gpexe_import_check_observation_guard();

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
