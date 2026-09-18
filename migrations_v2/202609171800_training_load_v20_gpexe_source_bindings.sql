-- Training Load v20 — GPEXE source bindings.
--
-- Two narrow, opt-in guarantees for the GPEXE importer
-- (backend/src/gpexeImportWriter.js), both deliberately scoped so the
-- generic provenance contract of v11/v12 stays exactly as it was:
--
--   1. One ACTIVE GPEXE connection per team. v11 leaves
--      metric_source_connections unconstrained on purpose (a club may hold
--      several connections of the same source system — the dashboard suite
--      creates two 'test-import' connections for one club), so this index is
--      restricted to source_system = 'gpexe'.
--
--   2. One event per (GPEXE connection, GPEXE team_session), enforced in two
--      places: a guard on metric_events that refuses a second row for the same
--      gpexe connection and external id (on INSERT and on UPDATE, so the
--      duplicate cannot come into existence at all, whoever writes it), and
--      the unique key on the binding table below. The same guard freezes the
--      source identity of an event that already has a binding: the binding is
--      immutable, so an event free to move to another external id would stop
--      agreeing with the record of which session produced its values.
--      v12's generic contract is untouched: for a connection whose
--      source_system is not 'gpexe' the guard does nothing, and an event with
--      no binding stays as editable as v12 allows; every other source keeps
--      metric_events as descriptive provenance with no dedup.
--      The binding additionally carries the one fact the importer otherwise
--      loses: WHICH GPEXE threshold set produced that session's values.
--
-- A second event for the same GPEXE session must not exist, not merely fail
-- to be bound. The connection row is locked first so two concurrent inserts
-- serialize on it, which a plain existence check could not do on its own.
-- This adds no new lock: v12's own metric_events_lock_and_validate_connection
-- already takes "for update" on that same row for every event with a
-- connection, and v11 locks it on every identity insert, so the direction
-- stays connection -> identity -> ... -> event.
-- UPDATE is covered as well as INSERT: v12 deliberately leaves
-- source_external_id mutable (protect_event_identity_once_measured does not
-- list it), so an update could otherwise move a second event onto a taken
-- key. That is what the "id is distinct from new.id" clause is for.
create function training_load.enforce_gpexe_event_uniqueness() returns trigger as $$
declare
  system text;
begin
  -- A bound event's own identity is frozen. The binding is immutable and
  -- records WHICH GPEXE session produced these values; if the event could be
  -- moved to another external id — even a free one — the two would stop
  -- agreeing with nothing left to detect it. Checked before anything else,
  -- because clearing source_external_id or source_connection_id would
  -- otherwise fall through the early return below. It reads only the binding
  -- row and takes no lock of its own, leaving the connection -> identity ->
  -- event order as it was.
  --
  -- Why a plain read is enough against a concurrent binding insert: every
  -- such insert goes through validate_event_source_binding(), which locks
  -- THIS event row "for update" first, and an UPDATE of the same row blocks
  -- on that lock and re-runs its BEFORE triggers against the committed row.
  -- The shared row is what serializes the two, not the read. Do not remove
  -- that "for update" without re-examining this guard.
  if TG_OP = 'UPDATE'
     and (new.source_connection_id is distinct from old.source_connection_id
          or new.source_external_id is distinct from old.source_external_id)
     and exists (select 1 from training_load.metric_event_source_bindings b where b.event_id = old.id) then
    raise exception 'metric_events (id=%): source identity is immutable once the event is bound to a source session (recorded as %/%)',
      old.id, old.source_connection_id, old.source_external_id
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.source_connection_id is null or new.source_external_id is null then
    return new;
  end if;
  select source_system into system from training_load.metric_source_connections
    where id = new.source_connection_id for update;
  if system is distinct from 'gpexe' then
    return new;
  end if;
  if exists (
    select 1 from training_load.metric_events
    where source_connection_id = new.source_connection_id
      and source_external_id = new.source_external_id
      and id is distinct from new.id
  ) then
    raise exception 'metric_events: connection % already has an event for gpexe source_external_id %',
      new.source_connection_id, new.source_external_id
      using errcode = 'unique_violation';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_events_gpexe_unique_source
  before insert or update of source_connection_id, source_external_id on training_load.metric_events
  for each row execute function training_load.enforce_gpexe_event_uniqueness();

-- Threshold provenance is the reason a binding stores more than a key.
-- metric_definition_versions.condition_description holds the STATIC bounds of
-- a metric ("GPEXE power zone 25-60 W/kg"), which is a different fact from
-- "team 980's threshold set 1473, valid from 2025-01-01, open-ended, with
-- power [20,25,60,75] and speed [5.5,7], was in force for this session".
-- The set's own id, validity window and payload are therefore snapshotted per
-- event. reference_hash covers only what changes MEANING — a version marker,
-- the set id and the payload — and deliberately NOT the validity window:
-- GPEXE closes an open window when a successor set is created, and that alone
-- must not stop a re-import of an unchanged session. A re-import that finds a
-- different hash stops and asks, instead of silently restating what the
-- stored values mean.

-- Expected writer: ensureSourceBinding() in backend/src/gpexeImportWriter.js,
-- inside the importer's own transaction. reference_hash is computed there from
-- the other reference_* columns; the database does not recompute it, so a row
-- inserted by any other path must keep that pairing itself.
create table training_load.metric_event_source_bindings (
  -- One binding per event: the event itself is the primary key.
  event_id uuid primary key references training_load.metric_events(id) on delete restrict,
  source_connection_id uuid not null references training_load.metric_source_connections(id) on delete restrict,
  source_external_id text not null,
  -- The external reference set (GPEXE team thresholds) in force for this
  -- event. All four columns are written together or not at all.
  reference_set_external_id text,
  reference_valid_from timestamptz,
  reference_valid_to timestamptz,
  reference_payload jsonb,
  reference_hash text,
  -- The hash rule's own version, stored rather than mixed into the digest:
  -- when the rule changes, a row written under the old one must be
  -- recognizable as such instead of reading as "the source changed".
  reference_hash_version integer,
  created_by_user_id uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  -- The actual uniqueness guarantee this table exists for.
  unique (source_connection_id, source_external_id),
  constraint metric_event_source_bindings_reference_complete check (
    (reference_set_external_id is null and reference_valid_from is null
      and reference_payload is null and reference_hash is null and reference_hash_version is null)
    or (reference_set_external_id is not null and reference_valid_from is not null
      and reference_payload is not null and reference_hash is not null and reference_hash_version is not null)
  ),
  constraint metric_event_source_bindings_reference_window check (
    reference_valid_to is null or reference_valid_from is null or reference_valid_to > reference_valid_from
  )
);

-- One ACTIVE GPEXE connection per team (see §1 above). Inactive ones and
-- every other source system are untouched.
create unique index metric_source_connections_one_active_gpexe_per_team_idx
  on training_load.metric_source_connections (owner_team_id)
  where source_system = 'gpexe' and owner_scope = 'team' and state = 'active';

-- A binding must describe its own event: same connection, same external id.
-- It locks the event row, which is EARLIER than v13's ancestor order reaches
-- the event (identity -> batch -> participant -> event -> segment), so the two
-- orders would differ if a binding could be written for an arbitrary event.
-- ensureSourceBinding() therefore only ever writes a binding for an event
-- created in the same transaction, which already holds that row exclusively;
-- an existing event without a binding is refused (binding_missing) instead of
-- being back-filled.
create function training_load.validate_event_source_binding() returns trigger as $$
declare
  ev record;
begin
  select source_connection_id, source_external_id into ev
    from training_load.metric_events where id = new.event_id for update;
  if not found then
    raise exception 'metric_event_source_bindings: event (id=%) does not exist', new.event_id;
  end if;
  if ev.source_connection_id is distinct from new.source_connection_id
     or ev.source_external_id is distinct from new.source_external_id then
    raise exception 'metric_event_source_bindings: binding (connection=%, external_id=%) does not match event (id=%, connection=%, external_id=%)',
      new.source_connection_id, new.source_external_id, new.event_id, ev.source_connection_id, ev.source_external_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger metric_event_source_bindings_validate
  before insert on training_load.metric_event_source_bindings
  for each row execute function training_load.validate_event_source_binding();

-- A binding is a statement about what the source reported at import time, so
-- it is immutable: a changed threshold set is a new decision (the importer
-- stops and reports it), never a rewrite of the recorded provenance.
-- Deliberately unconditional, unlike the v11–v13 "protect once used" triggers
-- that compare old and new first: here even a no-op UPDATE is refused, because
-- no legitimate caller updates a binding at all.
create function training_load.forbid_event_source_binding_update() returns trigger as $$
begin
  raise exception 'metric_event_source_bindings rows are immutable (event_id=%)', old.event_id;
end;
$$ language plpgsql;

create trigger metric_event_source_bindings_immutable
  before update on training_load.metric_event_source_bindings
  for each row execute function training_load.forbid_event_source_binding_update();

-- DELETE is refused for the same reason UPDATE is: dropping a binding would
-- silently re-arm the stop-and-ask guard and let a later import record a
-- different threshold set for values that were produced under the old one.
-- Removing an imported session is a separate, reviewed operation.
create function training_load.forbid_event_source_binding_delete() returns trigger as $$
begin
  raise exception 'metric_event_source_bindings rows are immutable and cannot be deleted (event_id=%)', old.event_id;
end;
$$ language plpgsql;

create trigger metric_event_source_bindings_no_delete
  before delete on training_load.metric_event_source_bindings
  for each row execute function training_load.forbid_event_source_binding_delete();
