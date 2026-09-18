-- Training Load v22 — GPEXE import from the app, phase F1: check, candidates
-- and preview. Nothing in this migration writes a measurement, an event or
-- an activity; approving and importing a candidate is phase F2.
--
-- Owner decisions, 2026-09-18:
--   * the GPEXE token lives only in the server environment, never here;
--   * "Check now" writes the check record and the candidates even while the
--     import switch (GPEXE_IMPORT_APPLY_ENABLED) is off; the switch only
--     blocks writing results and activities (F2);
--   * approving an import is for an active platform admin, or a coach who
--     holds an explicit per-team approver grant; only a platform admin
--     grants and revokes (the table is here, the approval itself is F2);
--   * the raw GPEXE snapshot is kept 30 days after it was last seen for a
--     candidate that was never approved, and 90 days after import; an
--     expired snapshot can no longer be approved and must be checked again.
--
-- Lock order for anything touching these tables together:
--   public.user_global_roles / public.user_team_roles (FOR SHARE) ->
--   gpexe_import_candidates -> (F2) training_load.metric_events.

-- 1. Which GPEXE team an OptiMove team reads from. Configuration, not a
--    secret. Set by a platform admin.
create table training_load.gpexe_team_settings (
  owner_team_id uuid primary key references public.teams(id) on delete restrict,
  gpexe_team_id text not null check (gpexe_team_id ~ '^[0-9]{1,12}$'),
  configured_by_user_id uuid not null references public.users(id) on delete restrict,
  configured_at timestamptz not null default now(),
  -- One GPEXE team feeds at most one OptiMove team.
  unique (gpexe_team_id)
);
create index gpexe_team_settings_configured_by_idx on training_load.gpexe_team_settings (configured_by_user_id);

-- Every value the setting ever had, and who set it: a GPEXE team that was
-- connected to the wrong OptiMove team stays traceable after the fix.
create table training_load.gpexe_team_settings_history (
  id uuid primary key default gen_random_uuid(),
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  gpexe_team_id text not null,
  configured_by_user_id uuid not null references public.users(id) on delete restrict,
  configured_at timestamptz not null
);
create index gpexe_team_settings_history_team_idx on training_load.gpexe_team_settings_history (owner_team_id, configured_at desc);
create index gpexe_team_settings_history_by_idx on training_load.gpexe_team_settings_history (configured_by_user_id);

create function training_load.record_gpexe_team_setting() returns trigger as $$
begin
  insert into training_load.gpexe_team_settings_history (owner_team_id, gpexe_team_id, configured_by_user_id, configured_at)
  values (new.owner_team_id, new.gpexe_team_id, new.configured_by_user_id, new.configured_at);
  return new;
end;
$$ language plpgsql;

create trigger gpexe_team_settings_record
  after insert or update on training_load.gpexe_team_settings
  for each row execute function training_load.record_gpexe_team_setting();

-- Shared by the tables whose rows are history: no TRUNCATE (it fires no row
-- trigger, so without this one statement would wipe the history — the v19/v21
-- lesson).
create function training_load.gpexe_history_no_truncate() returns trigger as $$
begin
  raise exception '%.% keeps history; TRUNCATE refused', tg_table_schema, tg_table_name;
end;
$$ language plpgsql;

create trigger gpexe_team_settings_history_no_truncate
  before truncate on training_load.gpexe_team_settings_history
  for each statement execute function training_load.gpexe_history_no_truncate();

create function training_load.gpexe_team_settings_history_append_only() returns trigger as $$
begin
  raise exception 'gpexe_team_settings_history is append-only (% refused)', tg_op;
end;
$$ language plpgsql;

create trigger gpexe_team_settings_history_no_update_delete
  before update or delete on training_load.gpexe_team_settings_history
  for each row execute function training_load.gpexe_team_settings_history_append_only();

-- 2. Which OptiMove athlete a GPEXE athlete is. Confirmed by a person, never
--    guessed. Unlinking keeps the row (unlinked_at), so the history of who
--    linked whom stays.
create table training_load.gpexe_athlete_links (
  id uuid primary key default gen_random_uuid(),
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  gpexe_athlete_id text not null check (gpexe_athlete_id ~ '^[0-9]{1,12}$'),
  athlete_id uuid not null references public.athletes(id) on delete restrict,
  linked_by_user_id uuid not null references public.users(id) on delete restrict,
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz,
  unlinked_by_user_id uuid references public.users(id) on delete restrict,
  check ((unlinked_at is null) = (unlinked_by_user_id is null))
);
create unique index gpexe_athlete_links_active_gpexe_idx
  on training_load.gpexe_athlete_links (owner_team_id, gpexe_athlete_id) where unlinked_at is null;
create unique index gpexe_athlete_links_active_athlete_idx
  on training_load.gpexe_athlete_links (owner_team_id, athlete_id) where unlinked_at is null;
create index gpexe_athlete_links_athlete_idx on training_load.gpexe_athlete_links (athlete_id);
create index gpexe_athlete_links_linked_by_idx on training_load.gpexe_athlete_links (linked_by_user_id);
create index gpexe_athlete_links_unlinked_by_idx on training_load.gpexe_athlete_links (unlinked_by_user_id) where unlinked_by_user_id is not null;

create function training_load.validate_gpexe_athlete_link() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'gpexe_athlete_links rows are never deleted; unlink instead';
  end if;
  if tg_op = 'UPDATE' then
    if old.unlinked_at is not null then
      raise exception 'gpexe_athlete_links: link % is already unlinked', old.id;
    end if;
    if new.id is distinct from old.id or new.owner_team_id is distinct from old.owner_team_id
       or new.gpexe_athlete_id is distinct from old.gpexe_athlete_id or new.athlete_id is distinct from old.athlete_id
       or new.linked_by_user_id is distinct from old.linked_by_user_id or new.linked_at is distinct from old.linked_at
       or new.unlinked_at is null then
      raise exception 'gpexe_athlete_links: only unlinking is allowed';
    end if;
    return new;
  end if;
  -- Same membership rule the importer applies (assertAthletesInTeam).
  if not exists (
    select 1 from public.athlete_memberships m
     where m.athlete_id = new.athlete_id and m.team_id = new.owner_team_id
       and m.membership_type = 'team' and m.status = 'active'
  ) then
    raise exception 'gpexe_athlete_links: athlete % has no active membership in team %', new.athlete_id, new.owner_team_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_athlete_links_validate
  before insert or update or delete on training_load.gpexe_athlete_links
  for each row execute function training_load.validate_gpexe_athlete_link();

create trigger gpexe_athlete_links_no_truncate
  before truncate on training_load.gpexe_athlete_links
  for each statement execute function training_load.gpexe_history_no_truncate();

-- 3. Approver grants: a coach may approve GPEXE imports for one team only
--    through an explicit, recorded grant. The coach role alone never does.
--    Only an active platform admin grants and revokes; rows are never
--    deleted and a revoked grant cannot be revived (grant again instead).
create table training_load.gpexe_import_approvers (
  id uuid primary key default gen_random_uuid(),
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  user_id uuid not null references public.users(id) on delete restrict,
  granted_by_user_id uuid not null references public.users(id) on delete restrict,
  granted_at timestamptz not null default now(),
  grant_reason text not null check (length(btrim(grant_reason)) > 0),
  revoked_at timestamptz,
  revoked_by_user_id uuid references public.users(id) on delete restrict,
  revoke_reason text,
  check (
    (revoked_at is null and revoked_by_user_id is null and revoke_reason is null) or
    (revoked_at is not null and revoked_by_user_id is not null and length(btrim(revoke_reason)) > 0)
  )
);
create unique index gpexe_import_approvers_active_idx
  on training_load.gpexe_import_approvers (owner_team_id, user_id) where revoked_at is null;
create index gpexe_import_approvers_user_idx on training_load.gpexe_import_approvers (user_id);
create index gpexe_import_approvers_granted_by_idx on training_load.gpexe_import_approvers (granted_by_user_id);
create index gpexe_import_approvers_revoked_by_idx on training_load.gpexe_import_approvers (revoked_by_user_id) where revoked_by_user_id is not null;

create function training_load.assert_active_platform_admin(p_user_id uuid, p_what text) returns void as $$
begin
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = p_user_id and r.role = 'platform_admin' and r.is_active = true and u.is_active = true
   for share of r;
  if not found then
    raise exception '%: user % is not an active platform admin', p_what, p_user_id
      using errcode = 'insufficient_privilege';
  end if;
end;
$$ language plpgsql;

create function training_load.validate_gpexe_import_approver() returns trigger as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'gpexe_import_approvers rows are never deleted; revoke instead';
  end if;
  if tg_op = 'UPDATE' then
    if old.revoked_at is not null then
      raise exception 'gpexe_import_approvers: grant % is already revoked', old.id;
    end if;
    if new.id is distinct from old.id or new.owner_team_id is distinct from old.owner_team_id
       or new.user_id is distinct from old.user_id or new.granted_by_user_id is distinct from old.granted_by_user_id
       or new.granted_at is distinct from old.granted_at or new.grant_reason is distinct from old.grant_reason
       or new.revoked_at is null then
      raise exception 'gpexe_import_approvers: only revoking is allowed';
    end if;
    perform training_load.assert_active_platform_admin(new.revoked_by_user_id, 'gpexe_import_approvers revoke');
    return new;
  end if;
  perform training_load.assert_active_platform_admin(new.granted_by_user_id, 'gpexe_import_approvers grant');
  -- The grantee must be an active user who coaches this team right now.
  perform 1
    from public.user_team_roles tr
    join public.users u on u.id = tr.user_id
   where tr.user_id = new.user_id and tr.team_id = new.owner_team_id
     and tr.role = 'team_coach' and tr.is_active = true and u.is_active = true
   for share of tr;
  if not found then
    raise exception 'gpexe_import_approvers: user % is not an active coach of team %', new.user_id, new.owner_team_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_import_approvers_validate
  before insert or update or delete on training_load.gpexe_import_approvers
  for each row execute function training_load.validate_gpexe_import_approver();

create trigger gpexe_import_approvers_no_truncate
  before truncate on training_load.gpexe_import_approvers
  for each statement execute function training_load.gpexe_history_no_truncate();

-- 4. One "Check now" run.
create table training_load.gpexe_import_checks (
  id uuid primary key default gen_random_uuid(),
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  requested_by_user_id uuid not null references public.users(id) on delete restrict,
  status varchar(20) not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  window_from date not null,
  window_to date not null check (window_to >= window_from),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  finished_at timestamptz,
  sessions_seen integer not null default 0,
  candidates_new integer not null default 0,
  candidates_changed integer not null default 0,
  candidates_unchanged integer not null default 0,
  -- A stable code and a message with no token and no raw response body.
  error_code text,
  error_message text,
  check ((status = 'running') = (finished_at is null)),
  check (status <> 'failed' or error_code is not null)
);
-- One running check per team at a time.
create unique index gpexe_import_checks_one_running_idx
  on training_load.gpexe_import_checks (owner_team_id) where status = 'running';
create index gpexe_import_checks_team_idx on training_load.gpexe_import_checks (owner_team_id, started_at desc);
create index gpexe_import_checks_requested_by_idx on training_load.gpexe_import_checks (requested_by_user_id);

-- 5. Candidates: one row per (team, GPEXE session, content). A check that
--    sees the same content again only refreshes it, so repeated checks never
--    create duplicates; new content for the same session supersedes the
--    older, not-imported candidates.
create table training_load.gpexe_import_candidates (
  id uuid primary key default gen_random_uuid(),
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  gpexe_team_session_id text not null check (gpexe_team_session_id ~ '^[0-9]{1,12}$'),
  session_started_at timestamptz,
  session_label text,
  -- sha256 of the canonical JSON of the raw snapshot as fetched (after the
  -- personal fields the importer does not need were removed).
  bundle_hash text not null check (bundle_hash ~ '^[0-9a-f]{64}$'),
  raw_bundle jsonb,
  raw_expires_at timestamptz not null,
  raw_purged_at timestamptz,
  status varchar(20) not null check (status in ('pending', 'blocked', 'superseded', 'imported')),
  superseded_by_candidate_id uuid references training_load.gpexe_import_candidates(id) on delete restrict,
  preview jsonb,
  preview_hash text check (preview_hash is null or preview_hash ~ '^[0-9a-f]{64}$'),
  preview_computed_at timestamptz,
  first_seen_check_id uuid not null references training_load.gpexe_import_checks(id) on delete restrict,
  last_seen_check_id uuid not null references training_load.gpexe_import_checks(id) on delete restrict,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  imported_at timestamptz,
  unique (owner_team_id, gpexe_team_session_id, bundle_hash),
  -- A snapshot is either there or purged, never both, never neither.
  check ((raw_bundle is null) = (raw_purged_at is not null)),
  -- A purged candidate carries no preview either: the preview holds the same
  -- athletes' values.
  check (raw_purged_at is null or preview is null),
  check ((status = 'superseded') = (superseded_by_candidate_id is not null)),
  check ((status = 'imported') = (imported_at is not null))
);
create index gpexe_import_candidates_team_idx on training_load.gpexe_import_candidates (owner_team_id, session_started_at desc);
create index gpexe_import_candidates_session_idx on training_load.gpexe_import_candidates (owner_team_id, gpexe_team_session_id);
create index gpexe_import_candidates_expiry_idx on training_load.gpexe_import_candidates (raw_expires_at) where raw_bundle is not null;
create index gpexe_import_candidates_superseded_by_idx on training_load.gpexe_import_candidates (superseded_by_candidate_id);
create index gpexe_import_candidates_first_check_idx on training_load.gpexe_import_candidates (first_seen_check_id);
create index gpexe_import_candidates_last_check_idx on training_load.gpexe_import_candidates (last_seen_check_id);

-- A candidate row is the record of what was seen, decided and imported. A
-- purge clears its snapshot, never the row; an imported one may never be
-- deleted, and the table cannot be truncated (checks cannot either: they are
-- referenced from here, so TRUNCATE ... CASCADE reaches this guard).
-- Updates are guarded too, or "set status = 'pending'" followed by a delete
-- would get around the rule: which team, which session and which content a
-- row describes never change, and once imported, its status and import time
-- are final (the purge may still clear its snapshot).
create function training_load.protect_gpexe_import_candidate() returns trigger as $$
begin
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
  return new;
end;
$$ language plpgsql;

create trigger gpexe_import_candidates_protect
  before update or delete on training_load.gpexe_import_candidates
  for each row execute function training_load.protect_gpexe_import_candidate();

create trigger gpexe_import_candidates_no_truncate
  before truncate on training_load.gpexe_import_candidates
  for each statement execute function training_load.gpexe_history_no_truncate();

-- 6. Retention. The purge is plain SQL so any runner can call it: the check
--    itself, the server on start and on an interval, and the CLI for an
--    external scheduler. Expiry does not depend on the purge having run: the
--    application treats a snapshot whose raw_expires_at has passed as gone
--    (not approvable, not shown), and the approval (F2) refuses it too.
create table training_load.gpexe_retention_runs (
  id uuid primary key default gen_random_uuid(),
  trigger_source varchar(20) not null check (trigger_source in ('check', 'startup', 'interval', 'cli')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  purged_count integer,
  error_message text
);
create index gpexe_retention_runs_started_idx on training_load.gpexe_retention_runs (started_at desc);

-- One batch per call (oldest expiry first, rows another session holds are
-- skipped and taken by the next call), so a backlog after a long pause is
-- cleared in short statements instead of one long one. The caller repeats
-- until a batch comes back smaller than the limit.
create function training_load.purge_expired_gpexe_raw(p_limit integer default 200) returns integer as $$
declare
  purged integer;
begin
  update training_load.gpexe_import_candidates c
     set raw_bundle = null, preview = null, raw_purged_at = now()
   where c.id in (
     select id from training_load.gpexe_import_candidates
      where raw_bundle is not null and raw_expires_at <= now()
      order by raw_expires_at
      limit greatest(p_limit, 1)
      for update skip locked
   );
  get diagnostics purged = row_count;
  return purged;
end;
$$ language plpgsql;
