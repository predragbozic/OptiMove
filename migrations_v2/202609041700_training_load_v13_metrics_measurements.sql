-- ============================================================
-- OPTIMOVE — Training load metrics v13: measurement occasions, values,
-- and manual-entry/group-operation idempotency.
--
-- Context: completes the 4-file Training Load metrics core migration
-- (v10 catalog, v11 provenance, v12 events, this file). All correction/
-- idempotency/locking behavior below was worked out and independently
-- proven against a disposable schema-only proof-of-concept before being
-- written as this real migration — see the feature's own PR description
-- for the full design history; only the FINAL, corrected shape is
-- reproduced here.
--
-- metric_measurement_occasions is the atomic unit that groups a set of
-- metric_values captured together for one participant (at either
-- session-level, when segment_id is null, or a specific segment). A
-- correction is NEVER an in-place UPDATE of a value — it always inserts a
-- NEW occasion (with a NEW, complete set of values) and marks the OLD
-- occasion superseded, preserving full history. metric_source_identities.
-- current_occasion_id (from v11) is the "which revision is current" slot
-- for an imported fact; a purely manual occasion (no source_identity_id)
-- uses superseded_by_occasion_id IS NULL as its own effective-marker.
-- ============================================================

create table training_load.metric_measurement_occasions (
  id uuid primary key default gen_random_uuid(),
  event_participant_id uuid not null references training_load.metric_event_participants(id) on delete restrict,
  segment_id uuid references training_load.metric_event_segments(id) on delete restrict,
  entry_method varchar(20) not null check (entry_method in ('manual', 'api_import', 'csv_import')),
  -- Server-computed over this occasion's own value set; compared on both a
  -- manual retry (idempotent no-op) and an import re-sync (unchanged vs.
  -- genuine correction).
  content_hash text,
  source_identity_id uuid references training_load.metric_source_identities(id) on delete restrict,
  source_reported_at timestamptz,
  import_batch_id uuid references training_load.metric_import_batches(id) on delete restrict,
  row_number int,
  -- NULL = accepted and (subject to the pointer/chain rules below)
  -- potentially effective; non-NULL = a recorded-for-audit row that must
  -- NEVER become effective (a stale re-sync, or an import needing human
  -- review because its timing relative to the current revision was
  -- ambiguous).
  import_conflict_status varchar(20) check (import_conflict_status in ('needs_review', 'stale_resend_ignored', 'no_reliable_identifier')),
  recorded_by_user_id uuid references public.users(id) on delete restrict,
  supersedes_occasion_id uuid references training_load.metric_measurement_occasions(id) on delete restrict,
  superseded_by_occasion_id uuid references training_load.metric_measurement_occasions(id) on delete restrict,
  created_at timestamptz not null default now()
);

-- Composite FK completing v11's metric_source_identities.current_occasion_id
-- — this table did not exist yet when that column was declared. The
-- matching unique(id, source_identity_id) below makes "this occasion
-- really belongs to THIS identity" a declarative guarantee: nothing can
-- ever point current_occasion_id at an occasion belonging to a DIFFERENT
-- identity.
alter table training_load.metric_measurement_occasions
  add constraint metric_measurement_occasions_id_source_identity_unique unique (id, source_identity_id);

alter table training_load.metric_source_identities
  add constraint metric_source_identities_current_occasion_fk
  foreign key (current_occasion_id, id) references training_load.metric_measurement_occasions (id, source_identity_id);

-- current_occasion_id must never be set/changed to point at an occasion
-- that is already superseded or import-conflict-flagged — checked
-- immediately (not deferred): this is a same-statement, single-row
-- condition on the TARGET occasion's own existing state.
create function training_load.validate_source_identity_current_occasion() returns trigger as $$
declare
  occ_superseded uuid;
  occ_conflict varchar;
begin
  if new.current_occasion_id is null or new.current_occasion_id is not distinct from old.current_occasion_id then
    return new;
  end if;
  select superseded_by_occasion_id, import_conflict_status into occ_superseded, occ_conflict
    from training_load.metric_measurement_occasions where id = new.current_occasion_id;
  if occ_superseded is not null then
    raise exception 'metric_source_identities.current_occasion_id (id=%) cannot point at an already-superseded occasion', new.current_occasion_id;
  end if;
  if occ_conflict is not null then
    raise exception 'metric_source_identities.current_occasion_id (id=%) cannot point at an import-conflict-flagged occasion (status=%)', new.current_occasion_id, occ_conflict;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_source_identities_current_occasion_valid
  before insert or update on training_load.metric_source_identities
  for each row execute function training_load.validate_source_identity_current_occasion();

create unique index metric_measurement_occasions_batch_row_idx on training_load.metric_measurement_occasions (import_batch_id, row_number)
  where import_batch_id is not null;

-- Order changed relative to the original PoC draft: identity -> batch ->
-- participant -> event -> segment (not participant-first). The
-- correction/import service functions all lock metric_source_identities
-- FIRST as an intrinsic part of their own design (an import-resend flow
-- must read the identity's current_occasion_id before it can even know
-- which participant is involved — there is no way for it to lock
-- participant first). With a participant-first trigger order, a real
-- service call (holding identity, then later needing participant via this
-- trigger during its own successor insert) could deadlock against a
-- concurrent direct insert referencing the same identity+participant
-- (which would hold participant first, then need identity) — each holding
-- what the other needs next. This order was proven deadlock-free against
-- that exact interleaving before being written here.
create function training_load.lock_ancestors_before_occasion_insert() returns trigger as $$
declare
  v_event_id uuid;
begin
  if new.source_identity_id is not null then
    perform 1 from training_load.metric_source_identities where id = new.source_identity_id for update;
  end if;
  if new.import_batch_id is not null then
    perform 1 from training_load.metric_import_batches where id = new.import_batch_id for update;
  end if;
  select event_id into v_event_id from training_load.metric_event_participants where id = new.event_participant_id for update;
  perform 1 from training_load.metric_events where id = v_event_id for update;
  if new.segment_id is not null then
    perform 1 from training_load.metric_event_segments where id = new.segment_id for update;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_measurement_occasions_lock_ancestors
  before insert on training_load.metric_measurement_occasions
  for each row execute function training_load.lock_ancestors_before_occasion_insert();

-- The occasion's OWN identity/content fields are immutable unconditionally
-- from the moment the row exists — unlike the ancestor tables (which are
-- only frozen once THEY have dependent occasions), an occasion's own
-- event_participant_id is what MAKES it a historical fact in the first
-- place, so there is no legitimate window where reassigning it would be
-- safe. Revision/status fields (supersedes_occasion_id,
-- superseded_by_occasion_id, import_conflict_status) are deliberately NOT
-- in this list — controlled revision/status changes remain the only
-- legitimate way to correct history.
create function training_load.protect_occasion_identity_always() returns trigger as $$
begin
  if new.event_participant_id is distinct from old.event_participant_id
     or new.segment_id is distinct from old.segment_id
     or new.source_identity_id is distinct from old.source_identity_id
     or new.import_batch_id is distinct from old.import_batch_id
     or new.entry_method is distinct from old.entry_method
     or new.content_hash is distinct from old.content_hash
     or new.source_reported_at is distinct from old.source_reported_at
  then
    raise exception 'metric_measurement_occasions (id=%) identity/content fields are immutable after insert — reparenting an existing measurement is not a valid correction, supersede with a new occasion instead', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_measurement_occasions_protect_identity
  before update on training_load.metric_measurement_occasions
  for each row execute function training_load.protect_occasion_identity_always();

create function training_load.validate_measurement_occasion_segment() returns trigger as $$
declare
  participant_event uuid;
  segment_event uuid;
begin
  if new.segment_id is null then
    return new;
  end if;
  select event_id into participant_event from training_load.metric_event_participants where id = new.event_participant_id;
  select event_id into segment_event from training_load.metric_event_segments where id = new.segment_id;
  if participant_event is distinct from segment_event then
    raise exception 'segment % does not belong to the same event as participant %', new.segment_id, new.event_participant_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_measurement_occasions_segment_matches_event
  before insert or update on training_load.metric_measurement_occasions
  for each row execute function training_load.validate_measurement_occasion_segment();

-- Every source/batch reference must belong to the SAME owner_scope as the
-- occasion's own root event.
create function training_load.validate_occasion_source_owner_scope() returns trigger as $$
declare
  event_scope varchar;
  event_club uuid;
  event_team uuid;
  event_user uuid;
  ref_scope varchar;
  ref_club uuid;
  ref_team uuid;
  ref_user uuid;
begin
  if new.source_identity_id is null and new.import_batch_id is null then
    return new;
  end if;
  select e.owner_scope, e.owner_club_id, e.owner_team_id, e.owner_user_id into event_scope, event_club, event_team, event_user
    from training_load.metric_event_participants p
    join training_load.metric_events e on e.id = p.event_id
    where p.id = new.event_participant_id;

  if new.source_identity_id is not null then
    select c.owner_scope, c.owner_club_id, c.owner_team_id, c.owner_user_id into ref_scope, ref_club, ref_team, ref_user
      from training_load.metric_source_identities si
      join training_load.metric_source_connections c on c.id = si.source_connection_id
      where si.id = new.source_identity_id;
    if event_scope is distinct from ref_scope or event_club is distinct from ref_club
       or event_team is distinct from ref_team or event_user is distinct from ref_user then
      raise exception 'occasion''s root event owner_scope does not match its source connection''s owner_scope (event=%/%/%/% connection=%/%/%/%)',
        event_scope, event_club, event_team, event_user, ref_scope, ref_club, ref_team, ref_user;
    end if;
  end if;

  if new.import_batch_id is not null then
    select b.owner_scope, b.owner_club_id, b.owner_team_id, b.owner_user_id into ref_scope, ref_club, ref_team, ref_user
      from training_load.metric_import_batches b where b.id = new.import_batch_id;
    if event_scope is distinct from ref_scope or event_club is distinct from ref_club
       or event_team is distinct from ref_team or event_user is distinct from ref_user then
      raise exception 'occasion''s root event owner_scope does not match its import batch''s owner_scope (event=%/%/%/% batch=%/%/%/%)',
        event_scope, event_club, event_team, event_user, ref_scope, ref_club, ref_team, ref_user;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_measurement_occasions_source_owner_scope
  before insert or update on training_load.metric_measurement_occasions
  for each row execute function training_load.validate_occasion_source_owner_scope();

-- The OTHER direction of the current_occasion_id invariant — once an
-- occasion is marked superseded, no identity may still treat it as
-- current. Deferred (checked at COMMIT, not per-statement): the normal
-- correction flow marks the old occasion superseded and THEN moves the
-- identity's pointer to the new occasion, both in one transaction — an
-- immediate check would see the (correct, transient) in-between state and
-- reject a legitimate correction.
create function training_load.validate_no_identity_points_at_superseded() returns trigger as $$
begin
  if exists (select 1 from training_load.metric_source_identities where current_occasion_id = new.id) then
    raise exception 'occasion (id=%) was marked superseded but a source identity still points at it as current', new.id;
  end if;
  return new;
end;
$$ language plpgsql;

create constraint trigger metric_measurement_occasions_no_stale_pointer
  after update on training_load.metric_measurement_occasions
  deferrable initially deferred
  for each row
  when (new.superseded_by_occasion_id is not null and old.superseded_by_occasion_id is null)
  execute function training_load.validate_no_identity_points_at_superseded();

-- The SECOND direction of the same invariant, closed separately — an
-- occasion can also stop being "accepted" via import_conflict_status being
-- set on an UPDATE, independent of superseded_by_occasion_id.
create function training_load.validate_no_identity_points_at_flagged() returns trigger as $$
begin
  if exists (select 1 from training_load.metric_source_identities where current_occasion_id = new.id) then
    raise exception 'occasion (id=%) was marked import_conflict_status=% but a source identity still points at it as current', new.id, new.import_conflict_status;
  end if;
  return new;
end;
$$ language plpgsql;

create constraint trigger metric_measurement_occasions_no_stale_pointer_conflict
  after update on training_load.metric_measurement_occasions
  deferrable initially deferred
  for each row
  when (new.import_conflict_status is not null and old.import_conflict_status is null)
  execute function training_load.validate_no_identity_points_at_flagged();

create index metric_measurement_occasions_participant_effective_idx on training_load.metric_measurement_occasions (event_participant_id)
  where superseded_by_occasion_id is null and import_conflict_status is null;

create table training_load.metric_values (
  id uuid primary key default gen_random_uuid(),
  occasion_id uuid not null references training_load.metric_measurement_occasions(id) on delete restrict,
  metric_definition_id uuid not null references training_load.metric_definitions(id) on delete restrict,
  metric_definition_version_id uuid not null,
  value_numeric numeric,
  value_boolean boolean,
  value_text text,
  unit_at_capture text,
  is_derived boolean not null default false,
  computed_by_ref jsonb,
  created_at timestamptz not null default now(),
  unique (occasion_id, metric_definition_id),
  -- Composite FK: guarantees metric_definition_version_id really belongs
  -- to metric_definition_id on THIS row, declaratively — same trick as
  -- metric_definitions.current_version_id above.
  constraint metric_values_definition_version_fk
    foreign key (metric_definition_version_id, metric_definition_id)
    references training_load.metric_definition_versions (id, metric_definition_id)
);

create index metric_values_definition_occasion_idx on training_load.metric_values (metric_definition_id, occasion_id);

create function training_load.validate_metric_value() returns trigger as $$
declare
  v_type varchar;
  v_min numeric;
  v_max numeric;
begin
  select value_type, min_value, max_value into v_type, v_min, v_max
    from training_load.metric_definition_versions where id = new.metric_definition_version_id;
  if v_type = 'numeric' then
    if new.value_numeric is null or new.value_boolean is not null or new.value_text is not null then
      raise exception 'value_type=numeric requires value_numeric only (occasion=%, definition=%)', new.occasion_id, new.metric_definition_id;
    end if;
    if (v_min is not null and new.value_numeric < v_min) or (v_max is not null and new.value_numeric > v_max) then
      raise exception 'value_numeric % out of bounds [%, %] for definition %', new.value_numeric, v_min, v_max, new.metric_definition_id;
    end if;
  elsif v_type = 'boolean' then
    if new.value_boolean is null or new.value_numeric is not null or new.value_text is not null then
      raise exception 'value_type=boolean requires value_boolean only (occasion=%, definition=%)', new.occasion_id, new.metric_definition_id;
    end if;
  elsif v_type = 'text' then
    if new.value_text is null or new.value_numeric is not null or new.value_boolean is not null then
      raise exception 'value_type=text requires value_text only (occasion=%, definition=%)', new.occasion_id, new.metric_definition_id;
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_values_validate
  before insert on training_load.metric_values
  for each row execute function training_load.validate_metric_value();

-- Append-only, same as metric_definition_versions: a correction always
-- creates a NEW occasion + NEW value rows, never edits an existing value
-- row in place.
create trigger metric_values_immutable
  before update or delete on training_load.metric_values
  for each row execute function training_load.forbid_update_delete();

-- Manual-entry / group-operation idempotency: one row per USER-INITIATED
-- write operation (a single measurement, a whole group event, or a
-- correction), gating the ENTIRE operation atomically — a retry of the
-- same request_key never creates a second event/occasion, and content
-- that genuinely differs from the original is a controlled conflict, not
-- a silent overwrite or a silent duplicate.
create table training_load.metric_write_requests (
  id uuid primary key default gen_random_uuid(),
  request_key text not null,
  requested_by_user_id uuid not null references public.users(id) on delete restrict,
  operation_kind varchar(30) not null check (operation_kind in ('create_manual_occasion', 'create_group_event', 'correct_occasion')),
  owner_scope varchar(20) not null check (owner_scope in ('system', 'club', 'team', 'user')),
  owner_user_id uuid references public.users(id) on delete restrict,
  owner_club_id uuid references public.clubs(id) on delete restrict,
  owner_team_id uuid references public.teams(id) on delete restrict,
  request_content_hash text not null,
  status varchar(20) not null default 'completed' check (status in ('completed')),
  result_event_id uuid references training_load.metric_events(id) on delete restrict,
  result_occasion_id uuid references training_load.metric_measurement_occasions(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (requested_by_user_id, request_key),
  check (
    (owner_scope = 'system' and owner_user_id is null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'user'   and owner_user_id is not null and owner_club_id is null and owner_team_id is null) or
    (owner_scope = 'club'   and owner_club_id is not null and owner_user_id is null and owner_team_id is null) or
    (owner_scope = 'team'   and owner_team_id is not null and owner_user_id is null and owner_club_id is null)
  )
);
