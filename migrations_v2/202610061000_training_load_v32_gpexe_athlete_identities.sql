-- Training Load v32 — the GPEXE athlete identity snapshot (owner order
-- 2026-10-06; discovery docs/ai/gpexe-athlete-identity-discovery.md; the
-- source and the field rules: docs/ai/gpexe-rest-v1-compatibility.md section
-- 4b). An administrator's explicit, read-only load of rest/v1/athlete/<id>/
-- keeps, for at most 14 days, the sanitized display name and the normalized
-- date of birth of the GPEXE athletes of a team's active binding, so that
-- Link athletes can name them. Nothing else of the answer is stored.
--
-- What it adds (no existing table, row or constraint changes):
--   1. training_load.gpexe_athlete_identities — one row per (binding, GPEXE
--      athlete): the provenance (team, binding, connection, source team), the
--      canonical GPEXE athlete id, display_name (NULL = "Name not provided"),
--      birth_date (NULL = "Date of birth not provided"), observed_at and
--      expires_at = observed_at + 336 hours exactly (CHECK: 14 days
--      of elapsed time, independent of the session time zone). Never the raw
--      answer, first / last name apart, short_name, a track's athlete_name,
--      A GPEXE 404 is never stored here (no negative cache).
--      an unrecognised date form or a reason that carries a value.
--      * BEFORE INSERT (gpexe_athlete_identities_check): the binding is
--        ACTIVE, gpexe, of this team, this connection and this source team;
--        the team and its club are active and the connection is the team's
--        club's; observed_at is the reading time (not in the future, not
--        older than the longest load); birth_date is not in the future. The
--        team and the binding are read FOR SHARE, so an archive or an Unbind
--        running meanwhile is ordered against the insert.
--      * BEFORE UPDATE (gpexe_athlete_identities_no_update): refused. A row is
--        never refreshed or extended: an expired row is deleted and a new one
--        is written by a new read.
--      * DELETE is allowed: the purge, an Unbind, an archive.
--   2. training_load.gpexe_athlete_identity_requests — the request record of
--      one load (requestKey idempotency, one running load per team, counts
--      and a stable code only; no name, date or athlete id).
--      * BEFORE INSERT: the binding is ACTIVE and of this team.
--      * BEFORE UPDATE: only running -> completed / failed, once, with its
--        finish time and counts; identity columns never change.
--   3. The delete paths, enforced by the database whoever writes:
--      * AFTER UPDATE on source_team_bindings: a binding that ends loses its
--        identity rows in the same transaction (an Unbind, or a raw UPDATE
--        the v27 trigger allows);
--      * AFTER UPDATE OF is_active on public.teams: an archived team loses
--        its identity rows in the same transaction;
--      * AFTER UPDATE OF is_active on public.clubs: an archived club loses
--        the identity rows of all its teams in the same transaction.
--   3b. training_load.gpexe_athlete_identity_suppressions: a GPEXE 404 left
--      out of the next loads' choice for exactly 24 hours (no identity, no
--      name, no date), deleted by the same paths and its own purge.
--   4. training_load.purge_expired_gpexe_athlete_identities(p_limit): plain
--      SQL any runner calls (the retention run at start, every 6 hours, every
--      check, the CLI, and every identity load). Readers never show or use
--      an expired row, whether or not the purge has run yet.
--
-- No index on the display name or the date: there is no search by either.
-- Personal columns are stored in plaintext (decision recorded in the
-- discovery document and the security review): public.athletes already holds
-- names and birth_date in plaintext; this table holds one sanitized name and
-- one date for at most 14 days.
--
-- Rollback (forward-safe, refuses under a later migration):
-- docs/runbooks/gpexe-athlete-identities-v32-rollback.sql

create table training_load.gpexe_athlete_identities (
  id uuid primary key default gen_random_uuid(),
  owner_team_id uuid not null references public.teams(id) on delete cascade,
  binding_id uuid not null references training_load.source_team_bindings(id) on delete cascade,
  connection_id uuid not null references training_load.source_credential_connections(id) on delete cascade,
  source_team_id text not null
    constraint gpexe_athlete_identities_source_team_format check (source_team_id ~ '^(0|[1-9][0-9]{0,11})$'),
  gpexe_athlete_id text not null
    constraint gpexe_athlete_identities_athlete_format check (gpexe_athlete_id ~ '^(0|[1-9][0-9]{0,11})$'),
  -- A backstop (a subset) of the application's rule (backend/src/gpexeAthleteIdentity.js):
  -- 1 to 120 characters, trimmed, single spaces, no control or invisible
  -- format character. The application refuses the whole value on any of
  -- these; the database never sees a partially cleaned one.
  display_name text
    constraint gpexe_athlete_identities_display_name check (
      display_name is null or (
        char_length(display_name) between 1 and 120
        and display_name = btrim(display_name)
        and display_name !~ '  '
        and display_name !~ '[[:cntrl:]]'
        and display_name !~ '[\u00AD\u0600-\u0605\u061C\u06DD\u070F\u115F\u1160\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]'
      )
    ),
  birth_date date
    constraint gpexe_athlete_identities_birth_date check (birth_date is null or birth_date >= date '1900-01-01'),
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  constraint gpexe_athlete_identities_ttl check (expires_at = observed_at + interval '336 hours'),
  constraint gpexe_athlete_identities_one_per_athlete unique (binding_id, gpexe_athlete_id)
);
create index gpexe_athlete_identities_team_idx on training_load.gpexe_athlete_identities (owner_team_id);
create index gpexe_athlete_identities_expiry_idx on training_load.gpexe_athlete_identities (expires_at);
create index gpexe_athlete_identities_connection_idx on training_load.gpexe_athlete_identities (connection_id);

comment on table training_load.gpexe_athlete_identities is
  'GPEXE athlete name and date of birth, read by an administrator''s explicit load (v32): sanitized display name or NULL, normalized date or NULL, kept for exactly 14 days, deleted on Unbind, team or club archive, and by the purge. Never shown to a coach.';

create function training_load.gpexe_athlete_identity_check() returns trigger as $$
declare
  b record;
  team_row record;
  club_active boolean;
  conn_club uuid;
begin
  select id, team_id, connection_id, source_system, source_team_id, state
    into b from training_load.source_team_bindings where id = new.binding_id for share;
  if not found or b.state <> 'active' or b.source_system <> 'gpexe' then
    raise exception 'gpexe_athlete_identities: binding % is not an active gpexe binding', new.binding_id
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identities_active_binding';
  end if;
  if b.team_id is distinct from new.owner_team_id or b.connection_id is distinct from new.connection_id or b.source_team_id is distinct from new.source_team_id then
    raise exception 'gpexe_athlete_identities: the row does not name its binding''s team, connection and source team'
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identities_active_binding';
  end if;
  select id, club_id, coalesce(is_active, true) as active into team_row from public.teams where id = new.owner_team_id for share;
  if not found or team_row.active is not true then
    raise exception 'gpexe_athlete_identities: team % is not active', new.owner_team_id
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identities_active_team';
  end if;
  select coalesce(is_active, true) into club_active from public.clubs where id = team_row.club_id for share;
  select owner_club_id into conn_club from training_load.source_credential_connections where id = new.connection_id;
  if club_active is not true or conn_club is distinct from team_row.club_id then
    raise exception 'gpexe_athlete_identities: the team''s club is not active or does not own the connection'
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identities_active_team';
  end if;
  -- observed_at is when the answer arrived: never in the future, and never
  -- older than the longest load (the application's whole action is bounded
  -- well below this).
  if new.observed_at > clock_timestamp() + interval '1 minute' or new.observed_at < clock_timestamp() - interval '10 minutes' then
    raise exception 'gpexe_athlete_identities: observed_at is not the reading time'
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identities_observed_at';
  end if;
  if new.birth_date is not null and new.birth_date > (clock_timestamp() at time zone 'UTC')::date + 1 then
    raise exception 'gpexe_athlete_identities: a date of birth in the future'
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identities_birth_date';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_athlete_identities_check
  before insert on training_load.gpexe_athlete_identities
  for each row execute function training_load.gpexe_athlete_identity_check();

create function training_load.gpexe_athlete_identity_no_update() returns trigger as $$
begin
  raise exception 'gpexe_athlete_identities: a row is never changed or extended; delete it and read again'
    using errcode = 'check_violation', constraint = 'gpexe_athlete_identities_no_update';
end;
$$ language plpgsql;

create trigger gpexe_athlete_identities_no_update
  before update on training_load.gpexe_athlete_identities
  for each row execute function training_load.gpexe_athlete_identity_no_update();

-- ---------------------------------------------------------------------------
-- The request record of one load.
-- ---------------------------------------------------------------------------
create table training_load.gpexe_athlete_identity_requests (
  id uuid primary key default gen_random_uuid(),
  owner_team_id uuid not null references public.teams(id) on delete cascade,
  binding_id uuid not null references training_load.source_team_bindings(id) on delete cascade,
  requested_by_user_id uuid not null references public.users(id) on delete restrict,
  request_key uuid not null,
  status varchar(20) not null default 'running'
    constraint gpexe_athlete_identity_requests_status check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- Counts only. targets: athletes chosen to be read (at most 50).
  targets integer not null constraint gpexe_athlete_identity_requests_targets check (targets between 0 and 50),
  loaded integer constraint gpexe_athlete_identity_requests_loaded check (loaded is null or loaded between 0 and 50),
  not_found integer constraint gpexe_athlete_identity_requests_not_found check (not_found is null or not_found between 0 and 50),
  not_read integer constraint gpexe_athlete_identity_requests_not_read check (not_read is null or not_read >= 0),
  error_code text constraint gpexe_athlete_identity_requests_error_code check (error_code is null or error_code ~ '^[a-z_]{1,64}$'),
  constraint gpexe_athlete_identity_requests_finished check ((status = 'running') = (finished_at is null)),
  constraint gpexe_athlete_identity_requests_failed_code check (status <> 'failed' or error_code is not null),
  constraint gpexe_athlete_identity_requests_key unique (requested_by_user_id, request_key)
);
-- One load at a time per team.
create unique index gpexe_athlete_identity_requests_one_running
  on training_load.gpexe_athlete_identity_requests (owner_team_id) where status = 'running';
create index gpexe_athlete_identity_requests_binding_idx on training_load.gpexe_athlete_identity_requests (binding_id);

create function training_load.gpexe_athlete_identity_request_guard() returns trigger as $$
declare
  b record;
begin
  if tg_op = 'INSERT' then
    select team_id, state, source_system into b from training_load.source_team_bindings where id = new.binding_id for share;
    if not found or b.state <> 'active' or b.source_system <> 'gpexe' or b.team_id is distinct from new.owner_team_id then
      raise exception 'gpexe_athlete_identity_requests: binding % is not an active gpexe binding of team %', new.binding_id, new.owner_team_id
        using errcode = 'check_violation', constraint = 'gpexe_athlete_identity_requests_active_binding';
    end if;
    return new;
  end if;
  if old.status <> 'running' then
    raise exception 'gpexe_athlete_identity_requests: request % is finished and final', old.id
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identity_requests_final';
  end if;
  if new.id is distinct from old.id or new.owner_team_id is distinct from old.owner_team_id or new.binding_id is distinct from old.binding_id
     or new.requested_by_user_id is distinct from old.requested_by_user_id or new.request_key is distinct from old.request_key
     or new.started_at is distinct from old.started_at or new.targets is distinct from old.targets or new.status = 'running' then
    raise exception 'gpexe_athlete_identity_requests: only finishing request % is allowed', old.id
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identity_requests_final';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_athlete_identity_requests_guard
  before insert or update on training_load.gpexe_athlete_identity_requests
  for each row execute function training_load.gpexe_athlete_identity_request_guard();

-- ---------------------------------------------------------------------------
-- Retry suppression of a GPEXE 404 (owner decision 2026-10-07, after the
-- external review of 94ec914): GPEXE's "no such athlete" is never an
-- identity, but an athlete it answered 404 for is left out of the next
-- loads' choice for exactly 24 hours, so a run of 404s at the front of the
-- newest-first order cannot starve the athletes behind it. Only the
-- binding, the team, the canonical id, observed_at and retry_after =
-- observed_at + 24 hours are kept: no name, no date, nothing of the answer.
-- Never updated or extended; a new 404 after the expiry is a new row. Deleted
-- with the identities by an Unbind, a team or club archive and the purge.
-- Nothing is ever sent to GPEXE because of a row here.
-- ---------------------------------------------------------------------------
create table training_load.gpexe_athlete_identity_suppressions (
  id uuid primary key default gen_random_uuid(),
  owner_team_id uuid not null references public.teams(id) on delete cascade,
  binding_id uuid not null references training_load.source_team_bindings(id) on delete cascade,
  gpexe_athlete_id text not null
    constraint gpexe_athlete_identity_suppressions_athlete_format check (gpexe_athlete_id ~ '^(0|[1-9][0-9]{0,11})$'),
  observed_at timestamptz not null,
  retry_after timestamptz not null,
  constraint gpexe_athlete_identity_suppressions_ttl check (retry_after = observed_at + interval '24 hours'),
  constraint gpexe_athlete_identity_suppressions_one_per_athlete unique (binding_id, gpexe_athlete_id)
);
create index gpexe_athlete_identity_suppressions_team_idx on training_load.gpexe_athlete_identity_suppressions (owner_team_id);
create index gpexe_athlete_identity_suppressions_retry_idx on training_load.gpexe_athlete_identity_suppressions (retry_after);

create function training_load.gpexe_athlete_identity_suppression_guard() returns trigger as $$
declare
  b record;
  team_active boolean;
begin
  if tg_op = 'UPDATE' then
    raise exception 'gpexe_athlete_identity_suppressions: a row is never changed or extended; delete it and record a new 404'
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identity_suppressions_no_update';
  end if;
  select team_id, state, source_system into b from training_load.source_team_bindings where id = new.binding_id for share;
  if not found or b.state <> 'active' or b.source_system <> 'gpexe' or b.team_id is distinct from new.owner_team_id then
    raise exception 'gpexe_athlete_identity_suppressions: binding % is not an active gpexe binding of team %', new.binding_id, new.owner_team_id
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identities_active_binding';
  end if;
  select coalesce(t.is_active, true) and coalesce(c.is_active, true) into team_active
    from public.teams t join public.clubs c on c.id = t.club_id where t.id = new.owner_team_id for share of t, c;
  if team_active is not true then
    raise exception 'gpexe_athlete_identity_suppressions: team % or its club is not active', new.owner_team_id
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identities_active_team';
  end if;
  if new.observed_at > clock_timestamp() + interval '1 minute' or new.observed_at < clock_timestamp() - interval '10 minutes' then
    raise exception 'gpexe_athlete_identity_suppressions: observed_at is not the reading time'
      using errcode = 'check_violation', constraint = 'gpexe_athlete_identity_suppressions_observed_at';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger gpexe_athlete_identity_suppressions_guard
  before insert or update on training_load.gpexe_athlete_identity_suppressions
  for each row execute function training_load.gpexe_athlete_identity_suppression_guard();

-- ---------------------------------------------------------------------------
-- The delete paths.
-- ---------------------------------------------------------------------------
create function training_load.gpexe_athlete_identities_drop_for_binding() returns trigger as $$
begin
  if old.state = 'active' and new.state <> 'active' then
    delete from training_load.gpexe_athlete_identities where binding_id = new.id;
    delete from training_load.gpexe_athlete_identity_suppressions where binding_id = new.id;
  end if;
  return null;
end;
$$ language plpgsql;

create trigger source_team_bindings_drop_identities
  after update on training_load.source_team_bindings
  for each row execute function training_load.gpexe_athlete_identities_drop_for_binding();

create function training_load.gpexe_athlete_identities_drop_for_team() returns trigger as $$
begin
  if coalesce(new.is_active, true) = false then
    delete from training_load.gpexe_athlete_identities where owner_team_id = new.id;
    delete from training_load.gpexe_athlete_identity_suppressions where owner_team_id = new.id;
  end if;
  return null;
end;
$$ language plpgsql;

create trigger teams_drop_gpexe_athlete_identities
  after update of is_active on public.teams
  for each row execute function training_load.gpexe_athlete_identities_drop_for_team();

create function training_load.gpexe_athlete_identities_drop_for_club() returns trigger as $$
begin
  if coalesce(new.is_active, true) = false then
    delete from training_load.gpexe_athlete_identities i
     using public.teams t
     where t.id = i.owner_team_id and t.club_id = new.id;
    delete from training_load.gpexe_athlete_identity_suppressions s
     using public.teams t
     where t.id = s.owner_team_id and t.club_id = new.id;
  end if;
  return null;
end;
$$ language plpgsql;

create trigger clubs_drop_gpexe_athlete_identities
  after update of is_active on public.clubs
  for each row execute function training_load.gpexe_athlete_identities_drop_for_club();

-- ---------------------------------------------------------------------------
-- Retention: one batch per call, oldest expiry first, rows another session
-- holds are skipped and taken by the next call.
-- ---------------------------------------------------------------------------
create function training_load.purge_expired_gpexe_athlete_identities(p_limit integer default 200) returns integer as $$
declare
  purged integer;
begin
  delete from training_load.gpexe_athlete_identities
   where id in (
     select id from training_load.gpexe_athlete_identities
      where expires_at <= now()
      order by expires_at
      limit greatest(p_limit, 1)
      for update skip locked
   );
  get diagnostics purged = row_count;
  return purged;
end;
$$ language plpgsql;

-- The same purge for the 24-hour retry suppressions.
create function training_load.purge_expired_gpexe_athlete_identity_suppressions(p_limit integer default 200) returns integer as $$
declare
  purged integer;
begin
  delete from training_load.gpexe_athlete_identity_suppressions
   where id in (
     select id from training_load.gpexe_athlete_identity_suppressions
      where retry_after <= now()
      order by retry_after
      limit greatest(p_limit, 1)
      for update skip locked
   );
  get diagnostics purged = row_count;
  return purged;
end;
$$ language plpgsql;
