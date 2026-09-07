-- ============================================================
-- OPTIMOVE — Training Activity Identity Core v1: activity/participant
-- base tables and catalogs.
--
-- Context: introduces the `training` schema — the shared, provider-neutral
-- "this actually happened" identity layer that RPE (training_load.
-- session_feedback), Metrics Core (training_load.metric_*), and Builder
-- plan sessions all resolve into, without any of those three domains
-- knowing about each other directly. A group session with 20 athletes is
-- ONE training.activities row with 20 training.activity_participants rows;
-- a solo entry is an activity with exactly one participant — no
-- special-casing either way.
--
-- This design (canonical activity/participant identity, write-once
-- identity fields with a session-local GUC bypass for the sanctioned
-- correction functions, lifecycle-state transition guards, a full
-- before/after correction audit log) was worked out and independently
-- proven against a disposable schema-only proof-of-concept across five
-- corrective review rounds before being written as this real migration —
-- only the FINAL, corrected shape is reproduced here, split across 4
-- migrations in dependency order:
--   v1 (this file)  — activities, activity_participants, catalogs, write
--                      idempotency, match suggestions.
--   v2              — activity_components, the 5 typed link tables, and
--                      their DB-level integrity triggers.
--   v3              — additive Metrics Core extensions (scope
--                      capabilities, aggregation_role/coverage,
--                      event_timezone_snapshot) with a proven-safe
--                      backfill over pre-existing metric_values.
--   v4              — canonical alias resolution, group materialization,
--                      participant merge/reparent, and the canonical
--                      read contract (training.canonical_activity_results).
-- ============================================================

create schema training;

-- Extensible catalogs (rows, not enums) — a new activity type or component
-- type is an INSERT, never a migration.
create table training.activity_types (
  key text primary key,
  label text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into training.activity_types (key, label) values
  ('training_session', 'Training session'),
  ('match', 'Match'),
  ('testing_session', 'Testing session'),
  ('recovery_session', 'Recovery session');

create table training.component_types (
  key text primary key,
  label text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into training.component_types (key, label) values
  ('block', 'Block'),
  ('exercise', 'Exercise'),
  ('drill', 'Drill'),
  ('interval', 'Interval'),
  ('game', 'Game'),
  ('warm_up', 'Warm-up'),
  ('cooldown', 'Cooldown'),
  ('match_segment', 'Match segment'),
  ('domain', 'Domain'),
  ('category', 'Category'),
  ('section', 'Section');

-- ---------------------------------------------------------------------
-- training.activities — the shared, real-world "this actually happened"
-- identity. NEVER athlete-specific (see activity_participants).
--
-- Lifecycle: provisional (created speculatively, e.g. a single-participant
-- activity that might later be merged into a team activity) -> confirmed
-- (a human, a high-confidence automatic match, or a reliable
-- shared-identity group materialization has settled it) -> superseded
-- (every participant has been moved/merged away — see
-- reparent_activity_participant()/merge_activity_participants() in v4 —
-- the row is NEVER deleted, only marked).
--
-- origin and superseded_by_activity_id are write-once/immutable, exactly
-- like owner_scope; a CONFIRMED activity additionally forbids direct
-- date/time/timezone/type edits — the only sanctioned path for a later
-- correction is correct_confirmed_activity_fields() below.
-- ---------------------------------------------------------------------
create table training.activities (
  id uuid primary key default gen_random_uuid(),
  activity_type_key text references training.activity_types(key),
  name text,
  occurred_local_date date not null,
  started_at timestamptz,
  ended_at timestamptz,
  timezone_snapshot text not null,
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id),
  owner_club_id uuid references public.clubs(id),
  owner_team_id uuid references public.teams(id),
  -- 'source_import' is the provider-neutral counterpart to 'api_import',
  -- reserved for a future non-interactive CSV/worker/import flow so it is
  -- never conflated with the interactive api_import origin.
  origin varchar(30) not null check (origin in ('planned_session', 'external_assignment', 'api_import', 'source_import', 'manual')),
  lifecycle_state varchar(20) not null default 'provisional' check (lifecycle_state in ('provisional', 'confirmed', 'superseded')),
  superseded_by_activity_id uuid references training.activities(id),
  created_by_user_id uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  ),
  check (superseded_by_activity_id is null or superseded_by_activity_id <> id),
  check (lifecycle_state <> 'superseded' or superseded_by_activity_id is not null)
);
create index activities_owner_idx on training.activities (owner_scope, owner_club_id, owner_team_id, owner_user_id);
create index activities_local_date_idx on training.activities (occurred_local_date);

-- Identity fields that must never change once set, other than through the
-- sanctioned functions in v4: owner scope, origin, and
-- superseded_by_activity_id (write-once — this is what makes an
-- A->B->A supersede cycle structurally impossible, since B's own
-- superseded_by_activity_id can never later be changed to point back at
-- A). A session-local GUC flag lets the sanctioned correction functions
-- (reparent_activity_participant, merge_activity_participants,
-- correct_confirmed_activity_fields — v4 and below) bypass just the piece
-- they own.
create function training.protect_activity_identity_fields() returns trigger as $$
begin
  if new.owner_scope is distinct from old.owner_scope
     or new.owner_user_id is distinct from old.owner_user_id
     or new.owner_club_id is distinct from old.owner_club_id
     or new.owner_team_id is distinct from old.owner_team_id then
    raise exception 'training.activities (id=%): owner scope is immutable — no silent reparenting', old.id;
  end if;
  if new.origin is distinct from old.origin then
    raise exception 'training.activities (id=%): origin is immutable', old.id;
  end if;
  if old.superseded_by_activity_id is not null and new.superseded_by_activity_id is distinct from old.superseded_by_activity_id then
    raise exception 'training.activities (id=%): superseded_by_activity_id is write-once — an existing supersede chain can never be altered', old.id;
  end if;
  if new.superseded_by_activity_id is not null and old.superseded_by_activity_id is null
     and current_setting('training.allow_supersede_write', true) is distinct from 'on' then
    raise exception 'training.activities (id=%): superseded_by_activity_id may only be set by a sanctioned merge/reparent function', old.id;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activities_protect_identity_fields
  before update on training.activities
  for each row execute function training.protect_activity_identity_fields();

-- A CONFIRMED, load-bearing activity forbids direct date/time/timezone/type
-- edits — a provisional activity stays freely correctable (it hasn't
-- settled yet). The only sanctioned bypass is
-- correct_confirmed_activity_fields() below, which sets the same
-- session-local GUC the identity trigger checks.
create function training.protect_confirmed_activity_fields() returns trigger as $$
begin
  if old.lifecycle_state = 'confirmed' and (
       new.occurred_local_date is distinct from old.occurred_local_date
    or new.started_at is distinct from old.started_at
    or new.ended_at is distinct from old.ended_at
    or new.timezone_snapshot is distinct from old.timezone_snapshot
    or new.activity_type_key is distinct from old.activity_type_key
  ) and current_setting('training.allow_confirmed_field_change', true) is distinct from 'on' then
    raise exception 'training.activities (id=%): confirmed activity date/time/timezone/type fields are immutable — use correct_confirmed_activity_fields()', old.id;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activities_protect_confirmed_fields
  before update on training.activities
  for each row execute function training.protect_confirmed_activity_fields();

-- lifecycle_state must follow real edges only — provisional->confirmed,
-- either->superseded — and never confirmed->provisional (a raw UPDATE
-- trying to "unconfirm" an already-settled activity) or anything at all
-- out of 'superseded' (terminal).
create function training.protect_activity_lifecycle_transitions() returns trigger as $$
begin
  if new.lifecycle_state = old.lifecycle_state then
    return new;
  end if;
  if not (
    (old.lifecycle_state = 'provisional' and new.lifecycle_state in ('confirmed', 'superseded')) or
    (old.lifecycle_state = 'confirmed' and new.lifecycle_state = 'superseded')
  ) then
    raise exception 'training.activities (id=%): illegal lifecycle_state transition % -> %', old.id, old.lifecycle_state, new.lifecycle_state;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activities_protect_lifecycle_transitions
  before update on training.activities
  for each row execute function training.protect_activity_lifecycle_transitions();

create table training.activity_field_correction_log (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references training.activities(id),
  old_values jsonb not null,
  new_values jsonb not null,
  reason text,
  performed_by_user_id uuid references public.users(id),
  changed_at timestamptz not null default now()
);

-- The only sanctioned way to correct date/time/timezone/type on an
-- already-confirmed activity. Locks the row, flips the GUC for the
-- duration of this transaction's write, records a full before/after audit
-- row.
create function training.correct_confirmed_activity_fields(
  p_activity_id uuid, p_occurred_local_date date, p_started_at timestamptz, p_ended_at timestamptz,
  p_timezone_snapshot text, p_activity_type_key text, p_performed_by uuid, p_reason text default null
) returns void as $$
declare
  v_before training.activities%rowtype;
  v_after training.activities%rowtype;
begin
  select * into v_before from training.activities where id = p_activity_id for update;
  if not found then
    raise exception 'correct_confirmed_activity_fields: activity % not found', p_activity_id;
  end if;
  perform set_config('training.allow_confirmed_field_change', 'on', true);
  update training.activities
    set occurred_local_date = p_occurred_local_date, started_at = p_started_at, ended_at = p_ended_at,
        timezone_snapshot = p_timezone_snapshot, activity_type_key = p_activity_type_key, updated_at = now()
    where id = p_activity_id
    returning * into v_after;
  perform set_config('training.allow_confirmed_field_change', 'off', true);

  insert into training.activity_field_correction_log (activity_id, old_values, new_values, reason, performed_by_user_id)
    values (
      p_activity_id,
      jsonb_build_object('occurred_local_date', v_before.occurred_local_date, 'started_at', v_before.started_at, 'ended_at', v_before.ended_at, 'timezone_snapshot', v_before.timezone_snapshot, 'activity_type_key', v_before.activity_type_key),
      jsonb_build_object('occurred_local_date', v_after.occurred_local_date, 'started_at', v_after.started_at, 'ended_at', v_after.ended_at, 'timezone_snapshot', v_after.timezone_snapshot, 'activity_type_key', v_after.activity_type_key),
      p_reason, p_performed_by
    );
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------
-- training.activity_participants — the stable individual-participation
-- identity every RPE/metric/manual link ultimately resolves to.
-- activity_id IS mutable (a controlled REPARENT — see
-- reparent_activity_participant() in v4 — moves a participant to a
-- replacement activity while its own id, athlete_id, and full history
-- stay intact). merge_status/superseded_by_participant_id are a separate,
-- lighter-weight mechanism: merge_activity_participants() (v4) declares
-- one of two same-athlete participants (in what may be two different
-- activities) an alias of the other WITHOUT moving either row's
-- activity_id — see resolve_canonical_participant_id() below for how
-- future lookups follow it.
-- ---------------------------------------------------------------------
create table training.activity_participants (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references training.activities(id),
  athlete_id uuid not null references public.athletes(id),
  local_date date not null,
  timezone_snapshot text not null,
  participation_status varchar(20) not null default 'planned' check (participation_status in ('planned', 'participated', 'partial', 'skipped', 'modified', 'stopped')),
  actual_start_instant timestamptz,
  actual_end_instant timestamptz,
  note text,
  merge_status varchar(20) not null default 'canonical' check (merge_status in ('canonical', 'superseded')),
  superseded_by_participant_id uuid references training.activity_participants(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (activity_id, athlete_id),
  unique (id, athlete_id),
  unique (id, activity_id),
  check (superseded_by_participant_id is null or superseded_by_participant_id <> id),
  -- Both directions of the invariant, not just one: 'superseded' requires
  -- a non-null pointer, AND a raw UPDATE that only touches merge_status
  -- (leaving an existing superseded_by_participant_id untouched) can never
  -- flip a row back to 'canonical' while still carrying a stale pointer
  -- ("alias resurrection") — a declarative CHECK closes this regardless of
  -- which column an UPDATE statement touches.
  check (
    (merge_status = 'canonical' and superseded_by_participant_id is null) or
    (merge_status = 'superseded' and superseded_by_participant_id is not null)
  )
);
create index activity_participants_athlete_idx on training.activity_participants (athlete_id, local_date);

create function training.protect_participant_identity_once_linked() returns trigger as $$
declare
  has_links boolean;
begin
  if new.athlete_id is not distinct from old.athlete_id
     and new.timezone_snapshot is not distinct from old.timezone_snapshot then
    -- fall through to the merge-status write-once check below
    null;
  else
    select
      exists (select 1 from training.activity_participant_session_links where activity_participant_id = old.id)
      or exists (select 1 from training.activity_participant_metric_participant_links where activity_participant_id = old.id)
      or exists (select 1 from training.activity_participant_components where activity_participant_id = old.id)
      into has_links;
    if has_links then
      raise exception 'training.activity_participants (id=%): athlete_id/timezone_snapshot are immutable once linked — reparent the ACTIVITY instead, never the athlete identity', old.id;
    end if;
  end if;

  -- activity_id may only be changed by reparent_activity_participant()
  -- (v4), gated behind the same session-local GUC every other
  -- sanctioned-function-only field in this schema uses.
  if new.activity_id is distinct from old.activity_id
     and current_setting('training.allow_reparent_write', true) is distinct from 'on' then
    raise exception 'training.activity_participants (id=%): activity_id may only be changed by reparent_activity_participant()', old.id;
  end if;

  if old.superseded_by_participant_id is not null and new.superseded_by_participant_id is distinct from old.superseded_by_participant_id then
    raise exception 'training.activity_participants (id=%): superseded_by_participant_id is write-once', old.id;
  end if;
  if new.superseded_by_participant_id is not null and old.superseded_by_participant_id is null
     and current_setting('training.allow_participant_merge_write', true) is distinct from 'on' then
    raise exception 'training.activity_participants (id=%): superseded_by_participant_id may only be set by merge_activity_participants()', old.id;
  end if;
  if new.merge_status is distinct from old.merge_status
     and current_setting('training.allow_participant_merge_write', true) is distinct from 'on' then
    raise exception 'training.activity_participants (id=%): merge_status may only be changed by merge_activity_participants()', old.id;
  end if;
  return new;
end;
$$ language plpgsql;
create trigger activity_participants_protect_identity
  before update on training.activity_participants
  for each row execute function training.protect_participant_identity_once_linked();

-- Follows the merge-alias chain to its end. Used by services/queries that
-- want the "unified" view of an athlete's participation — never by the
-- schema itself (no FK depends on this).
create function training.resolve_canonical_participant_id(p_participant_id uuid) returns uuid as $$
declare
  v_current uuid := p_participant_id;
  v_next uuid;
  v_hops int := 0;
begin
  loop
    select superseded_by_participant_id into v_next from training.activity_participants where id = v_current;
    exit when v_next is null;
    v_current := v_next;
    v_hops := v_hops + 1;
    if v_hops > 50 then
      raise exception 'resolve_canonical_participant_id: chain too long starting at % — possible cycle', p_participant_id;
    end if;
  end loop;
  return v_current;
end;
$$ language plpgsql stable;

-- Reverse of the above (part of the canonical read contract): every
-- participant id whose own alias chain terminates at
-- p_canonical_participant_id, including p_canonical_participant_id
-- itself. A single recursive CTE, not N+1 per row — safe to use in a
-- periodic/results query.
create function training.participant_alias_ids(p_canonical_participant_id uuid) returns table(participant_id uuid) as $$
  with recursive chain as (
    select p_canonical_participant_id as participant_id
    union all
    select ap.id from training.activity_participants ap join chain c on ap.superseded_by_participant_id = c.participant_id
  )
  select participant_id from chain;
$$ language sql stable;

-- Activity-level counterpart to resolve_canonical_participant_id — follows
-- activities.superseded_by_activity_id to its end. Used by the canonical
-- read contract so a superseded activity is never surfaced as if it were
-- its own separate training.
create function training.resolve_canonical_activity_id(p_activity_id uuid) returns uuid as $$
declare
  v_current uuid := p_activity_id;
  v_next uuid;
  v_hops int := 0;
begin
  loop
    select superseded_by_activity_id into v_next from training.activities where id = v_current;
    exit when v_next is null;
    v_current := v_next;
    v_hops := v_hops + 1;
    if v_hops > 50 then
      raise exception 'resolve_canonical_activity_id: chain too long starting at % — possible cycle', p_activity_id;
    end if;
  end loop;
  return v_current;
end;
$$ language plpgsql stable;

-- Reverse of the above: every activity id whose own chain terminates at
-- p_canonical_activity_id, including itself. Single recursive CTE.
create function training.activity_alias_ids(p_canonical_activity_id uuid) returns table(activity_id uuid) as $$
  with recursive chain as (
    select p_canonical_activity_id as activity_id
    union all
    select a.id from training.activities a join chain c on a.superseded_by_activity_id = c.activity_id
  )
  select activity_id from chain;
$$ language sql stable;

-- ---------------------------------------------------------------------
-- training.activity_match_suggestions — an ambiguous same-day/same-athlete
-- candidate recorded for human review when materialization could not
-- auto-confirm a single strong match (see the matching service, v4's own
-- design note). source_participant_id records which participant the
-- suggestion was actually raised FOR at creation time, permanently — a
-- re-derived "the participant of this activity" lookup is only safe while
-- an activity has exactly one participant, which does not always hold.
-- ---------------------------------------------------------------------
create table training.activity_match_suggestions (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references training.activities(id),
  source_participant_id uuid not null references training.activity_participants(id),
  candidate_activity_id uuid not null references training.activities(id),
  candidate_participant_id uuid not null references training.activity_participants(id),
  confidence numeric,
  score_breakdown jsonb,
  policy_version smallint,
  reason text,
  status varchar(20) not null default 'open' check (status in ('open', 'accepted', 'dismissed')),
  resolved_by_user_id uuid references public.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  check (activity_id <> candidate_activity_id)
);
create index activity_match_suggestions_activity_idx on training.activity_match_suggestions (activity_id) where status = 'open';

-- ---------------------------------------------------------------------
-- Idempotency for user-initiated (and future non-interactive-import)
-- materialization/merge writes. requester_key is a generated
-- discriminated union over EITHER a user OR a future source connection,
-- so both identity kinds share one clean unique constraint. owner_scope/*
-- is snapshotted at request time so a replay can be checked against the
-- CURRENT caller's own claimed scope — required so a workspace change can
-- never return another workspace's activity on the same request_key.
-- ---------------------------------------------------------------------
create table training.activity_write_requests (
  id uuid primary key default gen_random_uuid(),
  request_key text not null,
  requested_by_user_id uuid references public.users(id),
  requested_by_source_connection_id uuid references training_load.metric_source_connections(id),
  requester_key text generated always as (
    coalesce('user:' || requested_by_user_id::text, 'source:' || requested_by_source_connection_id::text)
  ) stored,
  operation_kind varchar(30) not null check (operation_kind in (
    'materialize_from_rpe', 'materialize_from_external', 'materialize_from_api', 'materialize_manual',
    'materialize_group_api', 'materialize_group_external', 'merge_participants'
  )),
  request_content_hash text not null,
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id),
  owner_club_id uuid references public.clubs(id),
  owner_team_id uuid references public.teams(id),
  result_activity_id uuid references training.activities(id),
  result_participant_id uuid references training.activity_participants(id),
  created_at timestamptz not null default now(),
  check ((requested_by_user_id is not null) <> (requested_by_source_connection_id is not null)),
  unique (requester_key, request_key)
);
