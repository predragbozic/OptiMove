-- Training Load v21 — deletion log for undone imported sessions.
--
-- Owner decisions 2026-09-18, for the procedure in
-- backend/scripts/gpexe-undo-imported-session.mjs:
--   * only a platform admin may undo an imported session, with a reason and
--     a recorded identity;
--   * the log is written in the SAME transaction as the removal, records the
--     session, the team, who ran it, why, and how many rows were removed;
--   * the log is immutable.
-- Same append-only shape as v19's training_load.dashboard_deletion_log.
--
-- What the database guarantees on its own, and what it does not:
--   * a log row can only name an ACTIVE platform admin, carry a non-empty
--     reason and non-empty counts, and describe an event that no longer
--     exists at the moment of insert — so it cannot record a removal that
--     did not happen in that transaction;
--   * a log row cannot be changed or removed;
--   * it does NOT force every removal to be logged: removing an imported
--     session already takes disabling v13/v20 protections, which only the
--     table owner can do, and the procedure is the one sanctioned way. A
--     removal done by hand outside it leaves no row here.
--
-- The three foreign keys are ON DELETE RESTRICT on purpose: a user, a team or
-- a GPEXE connection named in this log can no longer be hard-deleted, only
-- deactivated or archived (the app never hard-deletes any of them today).
--
-- Lock order: the undo transaction locks the admin's public.user_global_roles
-- row (FOR SHARE) BEFORE training_load.metric_events and training.activities,
-- and the insert trigger below takes the same row again (a no-op re-acquire).
-- Any future function that touches both must lock in the same order.

create table training_load.import_deletion_log (
  id uuid primary key default gen_random_uuid(),
  deleted_at timestamptz not null default now(),
  deleted_by_user_id uuid not null references public.users(id) on delete restrict,
  -- On what authority: the only basis accepted today.
  authorized_via varchar(20) not null check (authorized_via = 'platform_admin'),
  reason text not null check (length(btrim(reason)) > 0),
  -- The removed event itself is gone, so it is referenced by value only.
  event_id uuid not null,
  source_system text not null,
  source_connection_id uuid not null references training_load.metric_source_connections(id) on delete restrict,
  source_external_id text not null,
  owner_team_id uuid not null references public.teams(id) on delete restrict,
  occurred_date date not null,
  -- The GPEXE threshold set the removed values had been imported under, if
  -- the event carried a v20 binding.
  reference_set_external_id text,
  -- Rows removed per table, e.g. {"metric_values": 160, "metric_events": 1}.
  removed_counts jsonb not null check (jsonb_typeof(removed_counts) = 'object' and removed_counts <> '{}'::jsonb),
  removed_total integer not null check (removed_total > 0)
);

-- An event id is removed once; a re-import of the same GPEXE session
-- creates a new event and may be undone again.
create unique index import_deletion_log_event_idx on training_load.import_deletion_log (event_id);
create index import_deletion_log_team_idx on training_load.import_deletion_log (owner_team_id, deleted_at desc);
create index import_deletion_log_deleted_by_idx on training_load.import_deletion_log (deleted_by_user_id, deleted_at desc);
create index import_deletion_log_source_connection_idx on training_load.import_deletion_log (source_connection_id);

create function training_load.import_deletion_log_append_only() returns trigger as $$
begin
  raise exception 'training_load.import_deletion_log is append-only (% refused)', tg_op;
end;
$$ language plpgsql;

create trigger import_deletion_log_no_update_delete
  before update or delete on training_load.import_deletion_log
  for each row execute function training_load.import_deletion_log_append_only();

-- TRUNCATE fires no row trigger; without this the whole log could be wiped
-- in one statement (same guard as v19's dashboard_deletion_log_no_truncate).
create trigger import_deletion_log_no_truncate
  before truncate on training_load.import_deletion_log
  for each statement execute function training_load.import_deletion_log_append_only();

-- The accountability checks. The admin's role row is read FOR SHARE, so a
-- concurrent revocation (an UPDATE of that row) either commits first and is
-- seen here, or waits until this removal has committed.
create function training_load.validate_import_deletion_log() returns trigger as $$
begin
  perform 1
    from public.user_global_roles r
    join public.users u on u.id = r.user_id
   where r.user_id = new.deleted_by_user_id
     and r.role = 'platform_admin'
     and r.is_active = true
     and u.is_active = true
   for share of r;
  if not found then
    raise exception 'import_deletion_log: user % is not an active platform admin — only a platform admin may undo an imported session', new.deleted_by_user_id
      using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from training_load.metric_events where id = new.event_id) then
    raise exception 'import_deletion_log: event % still exists — a log row records a removal made in the same transaction, not a plan', new.event_id;
  end if;
  return new;
end;
$$ language plpgsql;

create trigger import_deletion_log_validate
  before insert on training_load.import_deletion_log
  for each row execute function training_load.validate_import_deletion_log();
