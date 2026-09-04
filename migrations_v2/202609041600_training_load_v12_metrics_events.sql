-- ============================================================
-- OPTIMOVE — Training load metrics v12: events, participants, segments.
--
-- Context: continues 202609041500_training_load_v11_metrics_provenance.sql.
--
-- metric_events is the shared, group-level object (NOT athlete-specific —
-- a group training with 20 athletes is one event with 20 participants; a
-- solo/day-level entry is simply an event with exactly one participant, no
-- special-casing needed). metric_event_participants carries each athlete's
-- own OPTIONAL link to their own planned session or external RPE
-- assignment, and their own frozen timezone snapshot.
--
-- logical_session_id is DELIBERATELY a bare uuid with NO foreign key,
-- exactly mirroring training_load.session_feedback.logical_session_id
-- (see 202608320900_training_load_v2_logical_session_identity.sql's own
-- header) — plans.plan_sessions rows are replaced/superseded by Builder's
-- edit-draft flow, and a real FK would mean editing or deleting a session
-- could delete or orphan an already-recorded historical measurement. The
-- linked_session_name_snapshot / linked_plan_name_snapshot columns exist
-- for the same reason session_feedback already snapshots plan_name/
-- session_name: a UUID alone does not preserve what a deleted/renamed
-- session was called at the time of capture.
--
-- external_assignment_id, by contrast, IS a real FK (ON DELETE RESTRICT)
-- to training_load.external_assignments — that table's own rows are
-- effectively immutable/append-only once created (see v4's own header),
-- so a real reference is safe there, matching session_feedback's own
-- external_assignment_id FK exactly.
-- ============================================================

create table training_load.metric_events (
  id uuid primary key default gen_random_uuid(),
  event_name text,
  occurred_date date not null,
  -- Nullable: never synthesized when the source only has a date. See
  -- occurred_date's own comment below for the reporting-date rule.
  occurred_instant timestamptz,
  scope_level varchar(20) not null check (scope_level in ('session', 'day')),
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  -- Descriptive provenance only — no dedup constraint at this level (the
  -- dedup anchor is metric_source_identities, referenced from individual
  -- occasions in v13). A connector that identifies at the whole-event
  -- level may still record it here for audit purposes.
  source_connection_id uuid references training_load.metric_source_connections(id) on delete restrict,
  source_external_id text,
  created_by_user_id uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);

create index metric_events_owner_idx on training_load.metric_events (owner_scope, owner_club_id, owner_team_id, owner_user_id);
create index metric_events_occurred_date_idx on training_load.metric_events (occurred_date);

-- §2 (reviewed PoC correction): this MUST be a single combined function —
-- an earlier draft used two separate triggers (a plain-SELECT ownership
-- validator, and a separate row-locker); Postgres fires same-timing
-- triggers in ALPHABETICAL ORDER BY NAME, so a validator sorting before a
-- locker trigger ran its check on a plain, UNLOCKED read BEFORE the lock
-- was taken — a concurrent connection-ownership UPDATE (still open,
-- uncommitted) could land in the gap between that read and the lock being
-- acquired, and the validation was never re-run against the now-current
-- value. Fixed by locking FIRST and reading the owner fields from that
-- SAME locked row in the SAME statement, as one function/trigger. Fires on
-- both INSERT and UPDATE (an UPDATE can set/change source_connection_id on
-- an event with no dependent measurements yet; once it does,
-- metric_events_protect_identity below freezes it separately).
create function training_load.lock_and_validate_event_connection() returns trigger as $$
declare
  ref_scope varchar;
  ref_club uuid;
  ref_team uuid;
  ref_user uuid;
begin
  if new.source_connection_id is null then
    return new;
  end if;
  select owner_scope, owner_club_id, owner_team_id, owner_user_id into ref_scope, ref_club, ref_team, ref_user
    from training_load.metric_source_connections where id = new.source_connection_id for update;
  if new.owner_scope is distinct from ref_scope or new.owner_club_id is distinct from ref_club
     or new.owner_team_id is distinct from ref_team or new.owner_user_id is distinct from ref_user then
    raise exception 'event owner_scope does not match its source connection''s owner_scope (event=%/%/%/% connection=%/%/%/%)',
      new.owner_scope, new.owner_club_id, new.owner_team_id, new.owner_user_id, ref_scope, ref_club, ref_team, ref_user;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_events_lock_and_validate_connection
  before insert or update on training_load.metric_events
  for each row execute function training_load.lock_and_validate_event_connection();

-- §4: identity/ownership/date/scope fields become immutable once
-- measurements exist underneath this event (via participants -> occasions,
-- v13) — a parent's owner_scope/connection/reporting-date cannot be
-- silently changed after the fact and reinterpret already-checked
-- historical measurements. event_name stays mutable (purely cosmetic).
create function training_load.protect_event_identity_once_measured() returns trigger as $$
declare
  has_measurements boolean;
begin
  if new.owner_scope is not distinct from old.owner_scope
     and new.owner_user_id is not distinct from old.owner_user_id
     and new.owner_club_id is not distinct from old.owner_club_id
     and new.owner_team_id is not distinct from old.owner_team_id
     and new.source_connection_id is not distinct from old.source_connection_id
     and new.occurred_date is not distinct from old.occurred_date
     and new.occurred_instant is not distinct from old.occurred_instant
     and new.scope_level is not distinct from old.scope_level then
    return new;
  end if;
  select exists (
    select 1 from training_load.metric_event_participants p
    join training_load.metric_measurement_occasions o on o.event_participant_id = p.id
    where p.event_id = old.id
  ) into has_measurements;
  if has_measurements then
    raise exception 'metric_events (id=%) has dependent measurements: identity/date/scope fields are immutable', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_events_protect_identity
  before update on training_load.metric_events
  for each row execute function training_load.protect_event_identity_once_measured();

create table training_load.metric_event_participants (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references training_load.metric_events(id) on delete restrict,
  athlete_id uuid not null references public.athletes(id) on delete restrict,
  athlete_timezone_snapshot text not null,
  -- Deliberately NO FK — see this file's own header.
  logical_session_id uuid,
  linked_session_name_snapshot text,
  linked_plan_name_snapshot text,
  external_assignment_id uuid references training_load.external_assignments(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (not (logical_session_id is not null and external_assignment_id is not null)),
  unique (event_id, athlete_id)
);

create index metric_event_participants_athlete_idx on training_load.metric_event_participants (athlete_id, event_id);

-- §4: moving a participant to a different event, reassigning which
-- athlete it represents, or rewriting any of its frozen snapshot fields
-- (timezone, linked session/plan name, session/assignment link) after
-- measurements were recorded against it would silently reassign or
-- reinterpret historical data — protect all of them once occasions exist.
create function training_load.protect_participant_identity_once_measured() returns trigger as $$
declare
  has_measurements boolean;
begin
  if new.event_id is not distinct from old.event_id
     and new.athlete_id is not distinct from old.athlete_id
     and new.athlete_timezone_snapshot is not distinct from old.athlete_timezone_snapshot
     and new.logical_session_id is not distinct from old.logical_session_id
     and new.external_assignment_id is not distinct from old.external_assignment_id
     and new.linked_session_name_snapshot is not distinct from old.linked_session_name_snapshot
     and new.linked_plan_name_snapshot is not distinct from old.linked_plan_name_snapshot then
    return new;
  end if;
  select exists (select 1 from training_load.metric_measurement_occasions where event_participant_id = old.id) into has_measurements;
  if has_measurements then
    raise exception 'metric_event_participants (id=%) has dependent measurements: identity/snapshot fields are immutable', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_event_participants_protect_identity
  before update on training_load.metric_event_participants
  for each row execute function training_load.protect_participant_identity_once_measured();

create table training_load.metric_event_segments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references training_load.metric_events(id) on delete restrict,
  label text not null,
  segment_order int not null
);

create index metric_event_segments_event_idx on training_load.metric_event_segments (event_id);

create function training_load.protect_segment_identity_once_measured() returns trigger as $$
declare
  has_measurements boolean;
begin
  if new.event_id is not distinct from old.event_id then
    return new;
  end if;
  select exists (select 1 from training_load.metric_measurement_occasions where segment_id = old.id) into has_measurements;
  if has_measurements then
    raise exception 'metric_event_segments (id=%) has dependent measurements: event_id is immutable', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_event_segments_protect_identity
  before update on training_load.metric_event_segments
  for each row execute function training_load.protect_segment_identity_once_measured();
