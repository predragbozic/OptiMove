-- Training Load v23 — GPEXE import from the app, phase F2: approving a
-- candidate and importing it.
--
-- Owner decisions, 2026-09-18:
--   * an approval covers the whole candidate exactly as its preview showed
--     it (no picking athletes), bound to the preview hash;
--   * every change to a value that was already imported has to be accepted
--     explicitly (acceptChanges), and the approval records that it was;
--   * approving is for an active platform admin, or a coach who holds an
--     active approver grant for the team and still actively coaches it;
--   * GPEXE_IMPORT_APPLY_ENABLED stays off in an environment until a fresh,
--     restore-verified backup of that environment exists (operational gate,
--     recorded in docs/runbooks/gpexe-in-app-import.md). The switch is
--     checked by the application; nothing in the database claims a backup.
--
-- The approval, the import it causes and the candidate becoming 'imported'
-- are written in ONE transaction by the application, in this lock order
-- (extends the v22 order):
--   public.user_global_roles / gpexe_import_approvers / public.user_team_roles
--   (FOR SHARE, lock_gpexe_import_approver) ->
--   gpexe_import_candidates (FOR UPDATE) ->
--   the team's import advisory lock (gpexeImportWriter.lockTeamForImport) ->
--   the importer's own order (source identities -> event -> occasions).
-- The rows below re-check what the application checked, so a direct insert
-- cannot approve on a right that is not there, or approve a candidate that
-- is not waiting for approval.

-- 1. The approver's right, read and held for the rest of the transaction.
--    A platform admin first; otherwise an active grant for this team whose
--    holder still actively coaches it. Revoking the grant, ending the role or
--    deactivating the user waits until the approval has committed (or sees
--    it rolled back): the role, grant and user rows are all held FOR SHARE.
create function training_load.lock_gpexe_import_approver(p_user_id uuid, p_team_id uuid)
returns table (basis text, grant_id uuid) as $$
begin
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
   for share of r, u;
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
     for share of a, tr, u;
  if not found then
    raise exception 'user % may not approve GPEXE imports for team %', p_user_id, p_team_id
      using errcode = 'insufficient_privilege';
  end if;
end;
$$ language plpgsql;

-- 2. One approval per candidate. The record of who approved which content,
--    on which basis, which preview, whether changes to already imported
--    values were accepted, and what the import wrote. Never changed, never
--    deleted. The event/activity/batch ids are plain values, not foreign
--    keys: undoing an import (docs/runbooks/gpexe-undo-imported-session.md)
--    removes those rows, and this record of the approval stays.
create table training_load.gpexe_import_approvals (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null unique references training_load.gpexe_import_candidates(id) on delete restrict,
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  gpexe_team_session_id text not null,
  bundle_hash text not null check (bundle_hash ~ '^[0-9a-f]{64}$'),
  preview_hash text not null check (preview_hash ~ '^[0-9a-f]{64}$'),
  approved_by_user_id uuid not null references public.users(id) on delete restrict,
  approval_basis varchar(20) not null check (approval_basis in ('platform_admin', 'team_grant')),
  approver_grant_id uuid references training_load.gpexe_import_approvers(id) on delete restrict,
  -- How many already imported results the import changes (see the preview's
  -- changesToImported), and that the approver accepted them.
  changes_to_imported integer not null check (changes_to_imported >= 0),
  changes_accepted boolean not null,
  approved_at timestamptz not null default now(),
  metric_event_id uuid not null,
  activity_id uuid,
  import_batch_id uuid,
  import_counts jsonb not null,
  check ((approval_basis = 'team_grant') = (approver_grant_id is not null)),
  check (changes_to_imported = 0 or changes_accepted)
);
create index gpexe_import_approvals_team_idx on training_load.gpexe_import_approvals (owner_team_id, approved_at desc);
create index gpexe_import_approvals_approved_by_idx on training_load.gpexe_import_approvals (approved_by_user_id);
create index gpexe_import_approvals_grant_idx on training_load.gpexe_import_approvals (approver_grant_id) where approver_grant_id is not null;
-- Which approval wrote an event (e.g. before undoing that import).
create index gpexe_import_approvals_event_idx on training_load.gpexe_import_approvals (metric_event_id);

create function training_load.validate_gpexe_import_approval() returns trigger as $$
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

create trigger gpexe_import_approvals_validate
  before insert or update or delete on training_load.gpexe_import_approvals
  for each row execute function training_load.validate_gpexe_import_approval();

create trigger gpexe_import_approvals_no_truncate
  before truncate on training_load.gpexe_import_approvals
  for each statement execute function training_load.gpexe_history_no_truncate();

-- 3. The v22 candidate guard, unchanged, plus: a candidate becomes
--    'imported' only from 'pending' and only with its approval already
--    recorded in the same transaction, and is never inserted as 'imported'
--    (no approval can exist for a row that does not exist yet).
create or replace function training_load.protect_gpexe_import_candidate() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'imported' then
      raise exception 'gpexe_import_candidates: a candidate is never inserted as imported; only its approval imports it';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'imported' then
      raise exception 'gpexe_import_candidates: candidate % was imported; its record is never deleted', old.id;
    end if;
    return old;
  end if;
  if new.owner_team_id is distinct from old.owner_team_id
     or new.gpexe_team_session_id is distinct from old.gpexe_team_session_id
     or new.bundle_hash is distinct from old.bundle_hash
     or new.first_seen_check_id is distinct from old.first_seen_check_id
     or new.first_seen_at is distinct from old.first_seen_at then
    raise exception 'gpexe_import_candidates: the team, session, content and first sighting of candidate % never change', old.id;
  end if;
  if old.status = 'imported' and (new.status is distinct from old.status or new.imported_at is distinct from old.imported_at) then
    raise exception 'gpexe_import_candidates: candidate % was imported; its status and import time are final', old.id;
  end if;
  if new.status = 'imported' and old.status is distinct from 'imported' then
    if old.status <> 'pending' then
      raise exception 'gpexe_import_candidates: candidate % is %, only a pending candidate can be imported', old.id, old.status;
    end if;
    if not exists (select 1 from training_load.gpexe_import_approvals a where a.candidate_id = new.id) then
      raise exception 'gpexe_import_candidates: candidate % has no recorded approval', old.id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_import_candidates_protect_insert
  before insert on training_load.gpexe_import_candidates
  for each row execute function training_load.protect_gpexe_import_candidate();
